// OFFLINE contract only: no model, no account, no Store, no dispatch, no process.
//
// Scope: the Claude Code executor leg (runtime=claude, role=executor). The CLI speaks the Messages
// wire, so a model that declares it keeps the native passthrough; a model that declares only an
// OpenAI wire is the translated outlet, which is a separate ladder step with separate evidence.
// The leg is real only when three gates are open together:
//   src/shared/custom-magpie-protocol.ts  claudeExecutorProtocol() names the wire,
//   src/server/magpie-route.ts            supportsClaudeExecutorBuild() (native) or
//                                         supportsClaudeExecutorTranslatedBuild() (translated),
//   src/server/deepseek-gateway.ts        the executor purpose admits tools on that wire.
// The digest set holds exactly one reviewed product build, registered after the physical turn
// recorded in docs/CLI_EXECUTOR_FEASIBILITY.md (scripts/accept-claude-executor.mjs). Every other
// digest is still refused, so a rebuild still has to prove itself before the lane opens for it.
import test from 'node:test';import assert from 'node:assert/strict';
import {customMagpieProtocol,claudeExecutorProtocol,claudeTranslatedProtocol} from '../../dist/shared/custom-magpie-protocol.js';
import {additionalMagpieRoute,claudeReadOnlyProtocol,claudeExecutorProtocol as claudeExecutorRoute,concreteMagpieRoute,supportsClaudeExecutorBuild} from '../../dist/server/magpie-route.js';
import {customRoleConfiguration} from '../../dist/server/flow/custom-role-identity.js';
import {DeepSeekGateway} from '../../dist/server/deepseek-gateway.js';
import {registeredCliExecutorDigests,registeredClineExecutorDigests,registeredDshExecutorDigests,registeredDshSupervisorDigests} from '../../dist/server/magpie-route.js';
import {MagpieDshRequestTransport} from '../../dist/server/magpie-model-transport.js';

const digest='a'.repeat(64);
// The registry is the only source of a product digest: a rebuild renames the build, so a pinned
// constant would turn a green lane into a false failure. A digest is used as a fail-closed negative
// only once the product proves that no lane registered it.
const registeredDigests=()=>new Set([...registeredCliExecutorDigests(),...registeredClineExecutorDigests(),
 ...registeredDshExecutorDigests(),...registeredDshSupervisorDigests()]);
const negatives=()=>{const hashes=['a'.repeat(64),'0'.repeat(64),'f'.repeat(64)].filter(hash=>!registeredDigests().has(hash));
 assert.equal(hashes.length,3,'the fail-closed fixtures are registered by no lane');return hashes;};
const MODEL='claude-sonnet-5';
const claudeRoute=(protocol='anthropic-messages')=>concreteMagpieRoute({runtime:'claude',provider:'string',protocol,model:MODEL,
 authentication:'api_key',authRef:'STRING_KEY',accountRef:'string:1',upstreamAccountRef:'string/acc_one'});
const capabilities=protocols=>protocols.map(protocol=>({model:MODEL,protocol}));

test('the executor wire keeps native Messages first and falls back to the two OpenAI outlets',()=>{
 assert.equal(claudeExecutorProtocol('executor','claude',['anthropic-messages']),'anthropic-messages');
 // The ladder matches the DSH executor's: native Messages, then Responses, then Chat.
 assert.equal(claudeExecutorProtocol('executor','claude',['anthropic-messages','openai-responses','chat-completions']),'anthropic-messages');
 assert.equal(claudeExecutorProtocol('executor','claude',['openai-responses','chat-completions']),'openai-responses');
 assert.equal(claudeExecutorProtocol('executor','claude',['chat-completions']),'chat-completions');
 assert.equal(claudeExecutorProtocol('executor','claude',[]),undefined);
 // Other harnesses and other roles are untouched by this leg.
 for(const runtime of ['pi','dsh','codex','opencode','cline','independent'])
  assert.equal(claudeExecutorProtocol('executor',runtime,['anthropic-messages']),undefined,runtime);
 for(const role of ['planner2','reviewer'])
  assert.equal(claudeExecutorProtocol(role,'claude',['anthropic-messages']),undefined,role);
 // The read-only translated leg still refuses the executor role, byte for byte.
 assert.equal(claudeTranslatedProtocol('executor','claude',['chat-completions']),undefined);
});

test('the protocol matrix resolves the Claude executor through the same ladder',()=>{
 assert.equal(customMagpieProtocol('executor','claude',['anthropic-messages']),'anthropic-messages');
 assert.equal(customMagpieProtocol('executor','claude',['anthropic-messages','chat-completions']),'anthropic-messages');
 // A model with no Messages capability resolves the translated outlet, never no leg at all.
 assert.equal(customMagpieProtocol('executor','claude',['chat-completions']),'chat-completions');
 assert.equal(customMagpieProtocol('executor','claude',['openai-responses']),'openai-responses');
 assert.equal(customMagpieProtocol('executor','claude',[]),undefined);
 // Read-only Claude roles keep their shipped resolution.
 assert.equal(customMagpieProtocol('planner2','claude',['anthropic-messages','chat-completions']),'anthropic-messages');
 // The read-only translated lane is resolved by claudeReadOnlyProtocol, not by this matrix,
 assert.equal(customMagpieProtocol('reviewer','claude',['chat-completions']),undefined);
 assert.equal(claudeReadOnlyProtocol('reviewer',claudeRoute(),capabilities(['chat-completions'])),'chat-completions');
});

test('the lane is named by the ladder and only the reviewed build digest opens it',()=>{
 const route=claudeRoute();
 const lane=additionalMagpieRoute('executor',route,capabilities(['anthropic-messages']));
 assert.ok(lane);
 assert.equal(lane.protocol,'anthropic-messages');
 // The one registered product build is the exact image the physical turn ran against. The
 // whole product lane set moved to this digest together, so every leg names the same image.
 const physical=registeredCliExecutorDigests()[0];
 assert.equal(supportsClaudeExecutorBuild(physical),true);
 assert.equal(lane.supportsBuild(physical),true);
 for(const hash of negatives())assert.equal(lane.supportsBuild(hash),false,hash);
 for(const hash of negatives())assert.equal(supportsClaudeExecutorBuild(hash),false,hash);
 assert.equal(claudeExecutorRoute('executor',route,capabilities(['anthropic-messages'])),'anthropic-messages');
 // A model with no Messages capability resolves the translated outlet, and that outlet is a
 // different lane: it is gated by its own registered set.
 assert.equal(claudeExecutorRoute('executor',claudeRoute('chat-completions'),capabilities(['chat-completions'])),'chat-completions');
 assert.equal(claudeExecutorRoute('executor',claudeRoute('openai-responses'),capabilities(['openai-responses'])),'openai-responses');
 // The read-only Claude ladder is unchanged: a Messages-capable read-only role still has none
 // here, because that lane is chosen by its own rule and digest.
 assert.equal(claudeReadOnlyProtocol('planner2',claudeRoute(),capabilities(['chat-completions'])),'chat-completions');
});

test('a Claude executor role is a valid Custom role only on its declared api-key route',()=>{
 // Same closed profile shape the boundary suite already proves valid; only the executor differs.
 const role=(id,{runtime,provider,authentication,model,authRef,accountRef,write=false})=>({id,provider,authentication,authRef,accountRef,runtime,
  transport:'magpie',nativeException:false,model:{kind:'model',id:model},
  permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const codexPlanner=role('planner2',{runtime:'codex',provider:'openai',authentication:'oauth',model:'gpt-6-luna',authRef:'OPENAI_OAUTH',accountRef:'openai:codex'});
 const dshReviewer=role('reviewer',{runtime:'dsh',provider:'deepseek-official',authentication:'api_key',model:'deepseek-v4-pro',authRef:'DEEPSEEK_KEY',accountRef:'deepseek-official:1'});
 const executor=runtime=>runtime==='claude'
  ? role('executor-one',{runtime:'claude',provider:'string',authentication:'api_key',model:MODEL,authRef:'STRING_KEY',accountRef:'string:1',write:true})
  : role('executor-one',{runtime,provider:'deepseek-official',authentication:'api_key',model:'deepseek-flash',authRef:'DEEPSEEK_KEY_O',accountRef:'deepseek-official:4',write:true});
 const snapshot=runtime=>{const executors=[executor(runtime)];
  return {schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'project_offline',runId:'run_offline',
   plan:{versionId:'plan_offline',revision:1,contentHash:digest,specHash:digest},profile:{revision:1,contentHash:digest},
   accounts:[...new Map([codexPlanner,...executors,dshReviewer].map(r=>[r.authRef,{provider:r.provider,authentication:r.authentication,authRef:r.authRef,accountRef:r.accountRef}])).values()],
   roles:{planner2:codexPlanner,executors,reviewer:dshReviewer},
   groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:10000000},timeZone:'Asia/Shanghai',
   laya:{enabled:false,mode:'off',roles:[]},magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:digest};};
 // The role is now resolvable; qualification is still the owner's job and still absent.
 assert.equal(customRoleConfiguration(snapshot('claude'),'executor','executor-one').runtime,'claude');
 // The other three CLI harnesses are their own executor legs too (tests/revamp/cli-executor-lanes
 // locks their protocol, route, purpose and transport); resolving a role opens no digest.
 for(const runtime of ['opencode','cline','codex'])
  assert.equal(customRoleConfiguration(snapshot(runtime),'executor','executor-one').runtime,runtime,runtime);
 // A harness with no tool-carrying leg is still refused at this layer.
 assert.throws(()=>customRoleConfiguration(snapshot('independent'),'executor','executor-one'),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'});
});
test('the gateway admits the executor purpose on Messages and refuses every other shape',()=>{
 const build=(channel,requests,wire='anthropic-messages',forbidTools=false)=>new DeepSeekGateway({},()=>({}),'',8192,requests,undefined,wire,forbidTools,
  undefined,undefined,undefined,channel,undefined,MODEL);
 const channel=(extra={})=>({role:'executor',claudeExecutor:true,claudeSupervisor:false,concreteRoute:{runtime:'claude',protocol:'anthropic-messages',model:MODEL},...extra});
 // Many requests: one per tool round, bounded by the frozen per-run ceiling.
 for(const requests of [2,16,200]) assert.doesNotThrow(()=>build(channel(),requests),String(requests));
 // A translated wire, a supervisor-shaped channel, a tool-forbidding purpose, a foreign model
 // and an out-of-range ceiling are all still refused before any byte is sent.
 assert.throws(()=>build(channel({claudeExecutor:false}),16),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>build(channel(),16,'chat-completions'),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>build(channel({role:'reviewer'}),16),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>build(channel(),16,'anthropic-messages',true),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>build(channel(),201),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 // The read-only Claude lane is untouched: it still forbids tools and still needs its flag.
 assert.doesNotThrow(()=>build({role:'reviewer',claudeSupervisor:true,concreteRoute:{runtime:'claude',protocol:'anthropic-messages',model:MODEL}},1));
});

test('the transport refuses the Claude executor lane for every unregistered build and opens the reviewed one',()=>{
 const session=hash=>({observation:{address:'127.0.0.1:4567',pid:1,epoch:'dm_epoch',binaryHash:hash,accountCount:1,
  accounts:[{runtime:'claude',provider:'string',protocol:'anthropic-messages',model:MODEL,authentication:'api_key',authRef:'STRING_KEY',accountRef:'string:1',upstreamAccountRef:'string/acc_one',capabilities:capabilities(['anthropic-messages'])}],
  credentialsAccepted:true,qualification:'NOT_VERIFIED',realCredentialsPermitted:false,runtimeDirectory:'r',scope:'LOCAL_CONTROL_PROCESS_ONLY'},
  prepareModelPayload:()=>({body:'{}',bodyHash:digest,routeHash:digest,path:'/v1/messages',method:'POST',maxOutputTokens:128,route:{}}),
  control:{prepare:async()=>{},grant:async()=>({status:'ACKNOWLEDGED'})},close:async()=>{}});
 const context=hash=>({session:session(hash),budget:{pendingBoundRequest:()=>({price:{provider:'string',model:MODEL,expiresAt:new Date(Date.now()+60000).toISOString()},maxOutputTokens:128})},
  route:claudeRoute(),role:'executor',
  bindRequest:()=>({projectId:'p',runId:'r',configurationHash:digest,roleId:'executor',role:'executor',bodyHash:digest,routeHash:digest,engineeringMode:'custom',work:{}}),
  assertCurrent:()=>{}});
 for(const hash of negatives())
  assert.throws(()=>new MagpieDshRequestTransport(context(hash)),{code:'MAGPIE_MODEL_ROLE_INVALID'},hash);
 // The registered product build passes the same gate; the lane is open for exactly this image.
 assert.doesNotThrow(()=>new MagpieDshRequestTransport(context(registeredCliExecutorDigests()[0])));
 // A read-only supervisor declaration on the same route is still its own lane, not this one.
 assert.throws(()=>new MagpieDshRequestTransport({...context(negatives()[0]),role:'reviewer',supervisor:true}),{code:'MAGPIE_MODEL_ROLE_INVALID'});
});