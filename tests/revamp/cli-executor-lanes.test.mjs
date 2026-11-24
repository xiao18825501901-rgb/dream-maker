// OFFLINE contract only: no model, no account, no Store, no dispatch, no process.
//
// Scope: the three remaining CLI executor legs — OpenCode and Cline (Messages-native), Codex
// (Responses-native). Each keeps its own wire as the passthrough and falls back to the translated
// outlet when the model declares only an OpenAI wire. A leg is real only when three gates are open
// together:
//   src/shared/custom-magpie-protocol.ts  <runtime>ExecutorProtocol() names the wire,
//   src/server/magpie-route.ts            supports<Runtime>ExecutorBuild() holds the digest,
//   src/server/deepseek-gateway.ts        the executor purpose admits tools on that wire.
// Every set now holds the reviewed product build, so each test below asserts the open state on that
// digest and the closed state on every digest nobody registered.
import test from 'node:test';import assert from 'node:assert/strict';
import {customMagpieProtocol,clineExecutorProtocol,codexExecutorProtocol,opencodeExecutorProtocol} from '../../dist/shared/custom-magpie-protocol.js';
import {registeredCliExecutorDigests,registeredClineExecutorDigests,registeredDshExecutorDigests,registeredDshSupervisorDigests} from '../../dist/server/magpie-route.js';
import {additionalMagpieRoute,clineExecutorProtocol as clineExecutorRoute,codexExecutorProtocol as codexExecutorRoute,concreteMagpieRoute,opencodeExecutorProtocol as opencodeExecutorRoute,supportsClineExecutorBuild,supportsClineExecutorTranslatedBuild,supportsCodexExecutorBuild,supportsCodexExecutorTranslatedBuild,supportsOpencodeExecutorBuild,supportsOpencodeExecutorTranslatedBuild} from '../../dist/server/magpie-route.js';
import {customMagpieApiRuntime,customRoleConfiguration,isCustomTextCliRuntime} from '../../dist/server/flow/custom-role-identity.js';
import {DeepSeekGateway} from '../../dist/server/deepseek-gateway.js';
import {MagpieDshRequestTransport} from '../../dist/server/magpie-model-transport.js';

const digest='a'.repeat(64);
// The registry is the only source of a product digest: a rebuild renames the build, so a pinned
// constant would turn a green lane into a false failure. The fail-closed negatives are computed the
// same way - a digest is used as a negative only once the product proves no lane registered it.
const registeredDigests=()=>new Set([...registeredCliExecutorDigests(),...registeredClineExecutorDigests(),
 ...registeredDshExecutorDigests(),...registeredDshSupervisorDigests()]);
const negatives=()=>{const hashes=['a'.repeat(64),'0'.repeat(64),'f'.repeat(64)].filter(hash=>!registeredDigests().has(hash));
 assert.equal(hashes.length,3,'the fail-closed fixtures are registered by no lane');return hashes;};
const MODEL='deepseek-flash';
const LANES={opencode:{wire:'anthropic-messages'},cline:{wire:'anthropic-messages'},codex:{wire:'openai-responses'}};
// The translated outlet of each leg: the OpenAI wires it can be served on, native wire excluded.
const TRANSLATED={opencode:['chat-completions','openai-responses'],cline:['chat-completions','openai-responses'],codex:['chat-completions']};
const providerOf=runtime=>runtime==='codex'?'string':'deepseek-official';
const route=(runtime,wire)=>concreteMagpieRoute({runtime,provider:providerOf(runtime),protocol:wire,model:MODEL,
 authentication:'api_key',authRef:'STRING_KEY',accountRef:'string:1',upstreamAccountRef:providerOf(runtime)+'/acc_one'});
const capabilities=protocols=>protocols.map(protocol=>({model:MODEL,protocol}));
const wireOf=runtime=>LANES[runtime].wire;

test('each CLI executor keeps its native wire first and falls back to the translated ladder',()=>{
 const fns={opencode:opencodeExecutorProtocol,cline:clineExecutorProtocol,codex:codexExecutorProtocol};
 for(const [runtime,fn] of Object.entries(fns)){
  const wire=wireOf(runtime);
  assert.equal(fn('executor',runtime,[wire]),wire,runtime);
  // The native wire always wins, whatever else the model declares.
  assert.equal(fn('executor',runtime,[...TRANSLATED[runtime],wire]),wire,runtime);
  // Without it, the ladder is Responses first and Chat as the fallback - except for Codex, whose
  // own wire IS Responses, so its only translated outlet is Chat.
  assert.equal(fn('executor',runtime,['chat-completions']),'chat-completions',runtime);
  for(const other of TRANSLATED[runtime].filter(value=>value!=='chat-completions'))
   assert.equal(fn('executor',runtime,[other]),other,runtime+' '+other);
  assert.equal(fn('executor',runtime,[]),undefined,runtime);
  // A leg never answers for another harness or another role.
  for(const other of Object.keys(fns).filter(value=>value!==runtime))assert.equal(fn('executor',other,[wire]),undefined,runtime+' claims '+other);
  for(const role of ['planner2','reviewer'])assert.equal(fn(role,runtime,[wire]),undefined,runtime+' '+role);
 }
 // The matrix resolves the same wires, and only for the executor role. A Chat-only model is the
 // translated outlet of the same leg, never a different harness and never a read-only lane.
 for(const runtime of Object.keys(LANES)){
  assert.equal(customMagpieProtocol('executor',runtime,[wireOf(runtime)]),wireOf(runtime),runtime);
  assert.equal(customMagpieProtocol('executor',runtime,['chat-completions']),'chat-completions',runtime);
 }
 // The shipped read-only resolution of the same harnesses is untouched.
 assert.equal(customMagpieProtocol('reviewer','opencode',['chat-completions']),'chat-completions');
 assert.equal(customMagpieProtocol('reviewer','cline',['anthropic-messages']),'anthropic-messages');
 assert.equal(customMagpieProtocol('planner2','codex',['openai-responses']),'openai-responses');
 // The other executor legs keep their own wires.
 assert.equal(customMagpieProtocol('executor','claude',['anthropic-messages']),'anthropic-messages');
 assert.equal(customMagpieProtocol('executor','pi',['chat-completions']),'chat-completions');
});

// The product build that passed physical acceptance for every CLI executor leg, native and
// translated alike - read from the registry, never pinned.
//   OpenCode: the build its own executor turn was taken on.
//   Codex: the build whose openai-responses executor admission and multi-round reply the real
//          `codex exec` turn was taken against (scripts/accept-codex-executor.mjs).
// Both open legs were accepted on the same built image, so one digest names the build rather than
// the lane, and the remaining per-lane question is whether that lane's set holds it.
const physical=registeredCliExecutorDigests()[0];
// Cline opened after its own physical turn; every CLI executor lane is registered.
const OPEN={opencode:true,cline:true,codex:true};
const buildFor=()=>physical;

test('each outlet opens on the digest its own set holds, and on nothing else',()=>{
 const expected={opencode:{route:opencodeExecutorRoute,supports:supportsOpencodeExecutorBuild},cline:{route:clineExecutorRoute,supports:supportsClineExecutorBuild},codex:{route:codexExecutorRoute,supports:supportsCodexExecutorBuild}};
 for(const [runtime,{route:selector,supports}] of Object.entries(expected)){
  const wire=wireOf(runtime),candidate=route(runtime,wire);
  const lane=additionalMagpieRoute('executor',candidate,capabilities([wire]));
  assert.ok(lane,runtime);
  assert.equal(lane.protocol,wire,runtime);
  assert.equal(lane.supportsBuild,supports,runtime);
  // Native lanes only: the reviewed digest of a native turn opens the native outlet and nothing else.
  assert.equal(lane.supportsBuild(buildFor(runtime)),OPEN[runtime],runtime);
  assert.equal(supports(buildFor(runtime)),OPEN[runtime],runtime);

  for(const hash of negatives())assert.equal(lane.supportsBuild(hash),false,runtime+' '+hash);
  for(const hash of negatives())assert.equal(supports(hash),false,runtime+' '+hash);
  assert.equal(selector('executor',candidate,capabilities([wire])),wire,runtime);
  assert.equal(selector('executor',candidate,capabilities(['chat-completions'])),'chat-completions',runtime);
  // A role that is not the executor never resolves these legs.
  for(const role of ['planner2','reviewer'])assert.equal(selector(role,candidate,capabilities([wire])),undefined,runtime+' '+role);
  // The translated outlet is named by the same ladder and answers its OWN set, not the native one:
  // the two evidence sets stay separate even when one image earned both.
  for(const translated of TRANSLATED[runtime]){
   const translatedLane=additionalMagpieRoute('executor',route(runtime,translated),capabilities([translated]));
   assert.ok(translatedLane,runtime+' '+translated);
   assert.equal(translatedLane.protocol,translated,runtime+' '+translated);
   const translatedEvidence=runtime==='opencode'?supportsOpencodeExecutorTranslatedBuild:
    runtime==='cline'?supportsClineExecutorTranslatedBuild:supportsCodexExecutorTranslatedBuild;
   assert.equal(translatedLane.supportsBuild,translatedEvidence,runtime+' '+translated);
   assert.equal(translatedLane.supportsBuild(buildFor(runtime)),translatedEvidence(buildFor(runtime)),runtime+' '+translated);
   // Whatever the registry says, a digest nobody registered is refused by this lane too.
   for(const hash of negatives())
    assert.equal(translatedLane.supportsBuild(hash),false,runtime+' '+translated+' '+hash);
  }
 }
});

test('the gateway purpose admits each CLI executor at many requests and refuses every other shape',()=>{
 const build=(channel,requests,wire='anthropic-messages',forbidTools=false)=>new DeepSeekGateway({},()=>({}),'',8192,requests,undefined,wire,forbidTools,
  undefined,undefined,undefined,channel,undefined,MODEL);
 const channel=(runtime,extra={})=>({role:'executor',cliExecutor:runtime,concreteRoute:{runtime,protocol:wireOf(runtime),model:MODEL},...extra});
 for(const runtime of Object.keys(LANES)){
  const gatewayWire=wireOf(runtime)==='openai-responses'?'responses':'anthropic-messages';
  // One executor turn is one request per tool round, bounded by the frozen per-run ceiling.
  for(const requests of [2,16,200])assert.doesNotThrow(()=>build(channel(runtime),requests,gatewayWire),runtime+' '+requests);
  // A foreign wire, a supervisor-shaped channel, a tool-forbidding purpose, a foreign model and an
  // out-of-range ceiling are refused before any byte is sent.
  assert.throws(()=>build(channel(runtime),16,gatewayWire==='responses'?'anthropic-messages':'responses'),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'},runtime);
  assert.throws(()=>build(channel(runtime,{role:'reviewer'}),16,gatewayWire),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'},runtime);
  assert.throws(()=>build(channel(runtime),16,gatewayWire,true),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'},runtime);
  assert.throws(()=>build(channel(runtime,{concreteRoute:{runtime,protocol:wireOf(runtime),model:'other-model'}}),16,gatewayWire),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'},runtime);
  assert.throws(()=>build(channel(runtime),201,gatewayWire),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'},runtime);
  assert.throws(()=>build(channel(runtime),0,gatewayWire),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'},runtime);
  // The lane is never reachable through another harness's declaration.
  assert.throws(()=>build(channel(runtime,{cliExecutor:runtime==='codex'?'cline':'codex'}),16,gatewayWire),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'},runtime);
 }
 // The read-only OpenCode/Cline purpose on the same wire is untouched: it still forbids tools.
 assert.doesNotThrow(()=>build({role:'reviewer',concreteRoute:{runtime:'opencode',protocol:'anthropic-messages',model:MODEL}},1));
});

test('the transport refuses each lane for every unregistered build and keeps the read-only lanes apart',()=>{
 const session=runtime=>hash=>({observation:{address:'127.0.0.1:4567',pid:1,epoch:'dm_epoch',binaryHash:hash,accountCount:1,
  accounts:[{runtime,provider:providerOf(runtime),protocol:wireOf(runtime),model:MODEL,authentication:'api_key',authRef:'STRING_KEY',accountRef:'string:1',upstreamAccountRef:providerOf(runtime)+'/acc_one',capabilities:capabilities([wireOf(runtime)])}],
  credentialsAccepted:true,qualification:'NOT_VERIFIED',realCredentialsPermitted:false,runtimeDirectory:'r',scope:'LOCAL_CONTROL_PROCESS_ONLY'},
  prepareModelPayload:()=>({body:'{}',bodyHash:digest,routeHash:digest,path:'/v1/messages',method:'POST',maxOutputTokens:128,route:{}}),
  control:{prepare:async()=>{},grant:async()=>({status:'ACKNOWLEDGED'})},close:async()=>{}});
 const context=(runtime,hash)=>({session:session(runtime)(hash),budget:{pendingBoundRequest:()=>({price:{provider:providerOf(runtime),model:MODEL,expiresAt:new Date(Date.now()+60000).toISOString()},maxOutputTokens:128})},
  route:route(runtime,wireOf(runtime)),role:'executor',
  bindRequest:()=>({projectId:'p',runId:'r',configurationHash:digest,roleId:'executor',role:'executor',bodyHash:digest,routeHash:digest,engineeringMode:'custom',work:{}}),
  assertCurrent:()=>{}});
 for(const runtime of Object.keys(LANES)){
  for(const hash of negatives())
   assert.throws(()=>new MagpieDshRequestTransport(context(runtime,hash)),{code:'MAGPIE_MODEL_ROLE_INVALID'},runtime+' '+hash);
  // The reviewed build passes the gate on its own lane and on no other.
  if(OPEN[runtime])assert.doesNotThrow(()=>new MagpieDshRequestTransport(context(runtime,buildFor(runtime))),runtime);
  else assert.throws(()=>new MagpieDshRequestTransport(context(runtime,buildFor(runtime))),{code:'MAGPIE_MODEL_ROLE_INVALID'},runtime);
  // A registered digest never lends its lane to another harness that has not registered it.
  if(OPEN[runtime])for(const other of Object.keys(LANES).filter(key=>key!==runtime&&!OPEN[key]))
   assert.throws(()=>new MagpieDshRequestTransport(context(other,buildFor(runtime))),{code:'MAGPIE_MODEL_ROLE_INVALID'},other);
 }
 // The same harness as a read-only role keeps its own lane: the transport builds it without the
 // executor declaration, so no tool-bearing purpose can be reached through a read-only route.
 for(const runtime of ['opencode','cline'])
  assert.equal(new MagpieDshRequestTransport({...context(runtime,negatives()[0]),role:'reviewer'}).cliExecutor,undefined,runtime);
});

test('a CLI executor role resolves only on its declared api-key Magpie route',()=>{
 const role=(id,{runtime,provider,authentication,model,authRef,accountRef,write=false})=>({id,provider,authentication,authRef,accountRef,runtime,
  transport:'magpie',nativeException:false,model:{kind:'model',id:model},permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const fixture={codex:['deepseek-official','api_key','deepseek-flash','DEEPSEEK_KEY_C','deepseek-official:7'],claude:['string','api_key','claude-sonnet-5','STRING_KEY','string:1'],
  opencode:['deepseek-official','api_key','deepseek-flash','DEEPSEEK_KEY_O','deepseek-official:4'],cline:['deepseek-official','api_key','deepseek-flash','DEEPSEEK_KEY_L','deepseek-official:5'],
  independent:['deepseek-official','api_key','deepseek-v4-pro','DEEPSEEK_KEY_2','deepseek-official:6']};
 const executor=runtime=>{const [provider,authentication,model,authRef,accountRef]=fixture[runtime];return role('executor-one',{runtime,provider,authentication,model,authRef,accountRef,write:true});};
 const snapshot=runtime=>{const planner=role('planner2',{runtime:'codex',provider:'openai',authentication:'oauth',model:'gpt-6-luna',authRef:'OPENAI_OAUTH',accountRef:'openai:codex'}),
  reviewer=role('reviewer',{runtime:'dsh',provider:'deepseek-official',authentication:'api_key',model:'deepseek-v4-pro',authRef:'DEEPSEEK_KEY',accountRef:'deepseek-official:1'}),exec=executor(runtime);
  return {schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'project_offline',runId:'run_offline',
   plan:{versionId:'plan_offline',revision:1,contentHash:digest,specHash:digest},profile:{revision:1,contentHash:digest},
   accounts:[...new Map([planner,exec,reviewer].map(r=>[r.authRef,{provider:r.provider,authentication:r.authentication,authRef:r.authRef,accountRef:r.accountRef}])).values()],
   roles:{planner2:planner,executors:[exec],reviewer},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:10000000},timeZone:'Asia/Shanghai',
   laya:{enabled:false,mode:'off',roles:[]},magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:digest};};
 // All four CLI harnesses are resolvable executors; resolving a role is not qualifying it.
 for(const runtime of ['claude','opencode','cline','codex'])assert.equal(customRoleConfiguration(snapshot(runtime),'executor','executor-one').runtime,runtime,runtime);
 // A harness with no executor leg keeps the refusal at the same layer as before.
 assert.throws(()=>customRoleConfiguration(snapshot('independent'),'executor','executor-one'),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'});
 // The runtime matrix states the same thing for probes and for the role table.
 for(const runtime of ['dsh','pi','claude','opencode','cline','codex'])assert.equal(customMagpieApiRuntime('executor',runtime),true,runtime);
 assert.equal(customMagpieApiRuntime('executor','independent'),false);
 assert.equal(customMagpieApiRuntime('reviewer','opencode'),true);
 assert.equal(isCustomTextCliRuntime('opencode'),true);
});

test('the owner dispatches the OpenCode and Cline executor legs and names the missing Codex binding',async()=>{
 const {NativeOwner}=await import('../../dist/server/native-owner.js');
 const role=(id,{runtime,provider,authentication,model,authRef,accountRef,write=false})=>({id,provider,authentication,authRef,accountRef,runtime,
  transport:'magpie',nativeException:false,model:{kind:'model',id:model},permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const fixture={codex:['deepseek-official','api_key','deepseek-flash','DEEPSEEK_KEY_C','deepseek-official:7'],
  opencode:['deepseek-official','api_key','deepseek-flash','DEEPSEEK_KEY_O','deepseek-official:4'],
  cline:['deepseek-official','api_key','deepseek-flash','DEEPSEEK_KEY_L','deepseek-official:5']};
 const config=runtime=>{const [provider,authentication,model,authRef,accountRef]=fixture[runtime];
  const planner=role('planner2',{runtime:'codex',provider:'openai',authentication:'oauth',model:'gpt-6-luna',authRef:'OPENAI_OAUTH',accountRef:'openai:codex'}),
   reviewer=role('reviewer',{runtime:'dsh',provider:'deepseek-official',authentication:'api_key',model:'deepseek-v4-pro',authRef:'DEEPSEEK_KEY',accountRef:'deepseek-official:1'}),
   exec=role('executor-one',{runtime,provider,authentication,model,authRef,accountRef,write:true});
  return {schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'project_offline',runId:'run_offline',
   plan:{versionId:'plan_offline',revision:1,contentHash:digest,specHash:digest},profile:{revision:1,contentHash:digest},
   accounts:[...new Map([planner,exec,reviewer].map(r=>[r.authRef,{provider:r.provider,authentication:r.authentication,authRef:r.authRef,accountRef:r.accountRef}])).values()],
   roles:{planner2:planner,executors:[exec],reviewer},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:10000000},timeZone:'Asia/Shanghai',
   laya:{enabled:false,mode:'off',roles:[]},magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:digest};};
 const owner=runtime=>{const selected=config(runtime),exec=selected.roles.executors[0];
  const instance=Object.create(NativeOwner.prototype);
  instance.context={store:{project:()=>({})}};
  instance.customRunAccountSelection=()=>({snapshot:selected});
  instance.configured=()=>({op:{},budget:{}});
  instance.assertCustomReady=()=>{};
  instance.requireUserBudget=()=>{};
  const state={sessions:0};
  instance.withCustomRunMagpieControl=(args,use,signal)=>{state.sessions+=1;
   return use({observation:{scope:'LOCAL_CONTROL_PROCESS_ONLY',realCredentialsPermitted:true,accounts:[],accountCount:0}},{},signal);};
  const input={role:'executor',executorRoleId:'executor-one',runId:selected.runId,model:exec.model.id,workspace:'offline',signal:new AbortController().signal};
  return {instance,input,state};
 };
 // Both text CLIs reach their own executor leg, so they open the Magpie session and are refused
 // later by the route layer for the account they do not have here.
 for(const runtime of ['opencode','cline']){
  const {instance,input,state}=owner(runtime);
  await assert.rejects(instance.custom(input).run(input,()=>{}),runtime);
  assert.equal(state.sessions,1,runtime+' executor turn reaches the Magpie session layer');
 }
 // Codex's product-side lane exists, but this operator declares no pinned `codex exec` binding, so
 // the refusal names the gap and no Magpie session is opened for it.
 const codex=owner('codex');
 await assert.rejects(codex.instance.custom(codex.input).run(codex.input,()=>{}),{code:'CUSTOM_CLI_COMMAND_UNVERIFIED'});
 assert.equal(codex.state.sessions,0,'no Magpie session without the codex exec binding');
});
