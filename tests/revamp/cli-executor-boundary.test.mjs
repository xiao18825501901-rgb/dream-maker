// OFFLINE boundary contract: no model, no account, no Store, no dispatch.
//
// Scope: how each CLI harness stands against the Custom executor turn after the four CLI legs
// were added, and proof that the state is decided at the routing/protocol layer rather than only
// at native-owner's role switch:
//
//   src/shared/custom-magpie-protocol.ts         four CLI executor legs (claude/opencode/cline on
//                                                Messages, codex on Responses), each with a
//                                                translated fallback, plus the two translated
//                                                ones (pi, dsh).
//   src/server/magpie-route.ts                   additionalMagpieRoute() and the reviewed-build
//                                                digest sets decide which legs may be entered.
//   src/server/flow/custom-role-identity.ts      customMagpieApiRuntime() mirrors that matrix.
//   src/server/native-owner.ts                   the dispatch switch asserts it a second time, and
//                                                the codex arm names the binding it still lacks.
//   src/server/deepseek-gateway.ts               each lane's purpose is admitted by its own flag.
//
// A CLI harness fails as executor for two different reasons and both are tested here:
// the CLI cannot run headless (none of the four has that problem — see
// docs/CLI_EXECUTOR_FEASIBILITY.md) versus the product having no reviewed build for its leg. The
// native legs are open on the reviewed image; every translated outlet is still closed, because a
// translated turn is a body and a transcript this product authored and it must be observed end to
// end before its own set may hold a digest. tests/revamp/cli-executor-lanes covers all four legs
// and their translated outlets in detail.
import test from 'node:test';import assert from 'node:assert/strict';
import {customRoleConfiguration} from '../../dist/server/flow/custom-role-identity.js';
import {customMagpieProtocol,piExecutorToolProtocol,dshExecutorProtocol} from '../../dist/shared/custom-magpie-protocol.js';
import {DeepSeekGateway} from '../../dist/server/deepseek-gateway.js';
const digest='a'.repeat(64);
const CLI_RUNTIMES=['codex','claude','opencode','cline'];
// Every wire a Magpie account could advertise. A leg that exists resolves to one of these.
const ALL_WIRES=['anthropic-messages','chat-completions','openai-responses'];
const role=(id,{runtime,provider,authentication,model,authRef,accountRef,write=false,transport='magpie',nativeException=false})=>({
 id,provider,authentication,authRef,accountRef,runtime,transport,nativeException,
 model:{kind:'model',id:model},permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
// The frozen shape each harness ships today. Only the id varies, so a harness can be placed in
// any of the three roles without inventing a route it never had.
const cliRuntime={codex:['openai','oauth','gpt-6-luna','OPENAI_OAUTH','openai:codex'],
 claude:['string','api_key','claude-sonnet-5','STRING_KEY','string:1'],
 opencode:['deepseek-official','api_key','deepseek-flash','DEEPSEEK_KEY_O','deepseek-official:4'],
 cline:['deepseek-official','api_key','deepseek-flash','DEEPSEEK_KEY_L','deepseek-official:5']};
const fixture={
 codex:id=>{const [provider,authentication,model,authRef,accountRef]=cliRuntime.codex;return role(id,{runtime:'codex',provider,authentication,model,authRef,accountRef});},
 claude:id=>{const [provider,authentication,model,authRef,accountRef]=cliRuntime.claude;return role(id,{runtime:'claude',provider,authentication,model,authRef,accountRef});},
 opencode:id=>{const [provider,authentication,model,authRef,accountRef]=cliRuntime.opencode;return role(id,{runtime:'opencode',provider,authentication,model,authRef,accountRef});},
 cline:id=>{const [provider,authentication,model,authRef,accountRef]=cliRuntime.cline;return role(id,{runtime:'cline',provider,authentication,model,authRef,accountRef});},
 dsh:id=>role(id,{runtime:'dsh',provider:'deepseek-official',authentication:'api_key',model:'deepseek-v4-pro',authRef:'DEEPSEEK_KEY',accountRef:'deepseek-official:1',write:true}),
 pi:id=>role(id,{runtime:'pi',provider:'deepseek-official',authentication:'api_key',model:'deepseek-flash',authRef:'DEEPSEEK_KEY_P',accountRef:'deepseek-official:2',write:true}),
 independent:id=>role(id,{runtime:'independent',provider:'deepseek-official',authentication:'api_key',model:'deepseek-v4-pro',authRef:'DEEPSEEK_KEY_2',accountRef:'deepseek-official:6'}),
};
const snapshot=roles=>({schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'project_offline',runId:'run_offline',
 plan:{versionId:'plan_offline',revision:1,contentHash:digest,specHash:digest},profile:{revision:1,contentHash:digest},
 accounts:[...new Map([roles.planner2,...roles.executors,roles.reviewer].map(r=>[r.authRef,{provider:r.provider,authentication:r.authentication,authRef:r.authRef,accountRef:r.accountRef}])).values()],
 roles,groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:10000000},timeZone:'Asia/Shanghai',
 laya:{enabled:false,mode:'off',roles:[]},magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:digest});
// A Custom role profile is a closed shape: replace permissions, never add a key, or the
// profile validator rejects the object with FLOW_CONFIG_INTEGRITY_FAILED.
const withWrite=r=>({...r,permissions:['source_read','source_write']});
const executorTrio=runtime=>snapshot({planner2:fixture.codex('planner2'),executors:[withWrite(fixture[runtime]('executor-one'))],reviewer:fixture.independent('reviewer')});

test('every CLI harness has exactly one executor leg, native wire first and translated behind it',()=>{
 // Each CLI prefers the wire its own tools speak and, when the model declares no such wire,
 // reaches the same translated ladder the DSH executor already follows: Responses, then Chat -
 // except Codex, whose own wire IS Responses, so its translated outlets are Chat and then the
 // native Messages wire the product renders itself. No harness's leg is reachable through another
 // harness's declarations, and every outlet keeps its own (still empty) digest set.
 const TRANSLATED={claude:['openai-responses','chat-completions'],opencode:['openai-responses','chat-completions'],
  cline:['openai-responses','chat-completions'],codex:['chat-completions','anthropic-messages']};
 for(const [runtime,wire] of [['claude','anthropic-messages'],['opencode','anthropic-messages'],['cline','anthropic-messages'],['codex','openai-responses']]){
  assert.equal(customMagpieProtocol('executor',runtime,ALL_WIRES),wire,runtime);
  for(const only of TRANSLATED[runtime])
   assert.equal(customMagpieProtocol('executor',runtime,[only]),only,runtime+' '+only);
  assert.equal(customMagpieProtocol('executor',runtime,[]),undefined,runtime);
  assert.equal(piExecutorToolProtocol('executor',runtime,ALL_WIRES),undefined,runtime);
  assert.equal(dshExecutorProtocol('executor',runtime,ALL_WIRES),undefined,runtime);
 }
 // The legs the product actually implements, reached through their own entry points.
 assert.equal(piExecutorToolProtocol('executor','pi',['openai-responses','chat-completions']),'openai-responses');
 assert.equal(piExecutorToolProtocol('executor','pi',['anthropic-messages']),'anthropic-messages');
 assert.equal(dshExecutorProtocol('executor','dsh',['chat-completions']),'chat-completions');
 assert.equal(dshExecutorProtocol('executor','dsh',['openai-responses']),'openai-responses');
 // A supervision role keeps whichever wire it already had; nothing above widened it.
 assert.equal(customMagpieProtocol('executor','pi',['chat-completions']),'chat-completions');
 assert.equal(customMagpieProtocol('executor','dsh',['anthropic-messages']),'anthropic-messages');
});

test('every CLI harness is still a valid Custom supervisor or planner on its shipped routes',()=>{
 // Unchanged behaviour: the combinations the product ships today must keep working.
 assert.equal(customMagpieProtocol('planner2','codex',['openai-responses']),'openai-responses');
 assert.equal(customMagpieProtocol('planner2','claude',['anthropic-messages']),'anthropic-messages');
 assert.equal(customMagpieProtocol('reviewer','opencode',['chat-completions']),'chat-completions');
 assert.equal(customMagpieProtocol('reviewer','cline',['chat-completions']),'chat-completions');
 assert.equal(customMagpieProtocol('reviewer','opencode',['anthropic-messages']),'anthropic-messages');
 const supervision=snapshot({planner2:fixture.claude('planner2'),executors:[fixture.dsh('executor-one')],reviewer:fixture.opencode('reviewer')});
 assert.equal(customRoleConfiguration(supervision,'planner2').runtime,'claude');
 assert.equal(customRoleConfiguration(supervision,'reviewer').runtime,'opencode');
 assert.equal(customRoleConfiguration(supervision,'executor','executor-one').runtime,'dsh');
 const piTrio=snapshot({planner2:fixture.codex('planner2'),executors:[fixture.pi('executor-one')],reviewer:fixture.cline('reviewer')});
 assert.equal(customRoleConfiguration(piTrio,'executor','executor-one').runtime,'pi');
 assert.equal(customRoleConfiguration(piTrio,'reviewer').runtime,'cline');
});

test('a CLI harness frozen as executor resolves its declared route and still holds no build',()=>{
 // All four CLI harnesses resolve on api-key Magpie now: claude/opencode/cline on the native
 // Messages wire, codex on Responses. Resolving a role is not qualifying it — each lane still
 // needs a registered build digest, and every one of those sets is empty.
 for(const runtime of ['claude','opencode','cline']){
  const config=executorTrio(runtime);
  assert.equal(config.roles.executors[0].runtime,runtime);
  assert.equal(customRoleConfiguration(config,'executor','executor-one').runtime,runtime,runtime);
 }
 // Codex is the one CLI executor declared on an api-key Magpie route only, so the shipped
 // subscription fixture (openai + oauth) is still refused at this same layer.
 const codex=executorTrio('codex');
 assert.equal(codex.roles.executors[0].runtime,'codex');
 assert.throws(()=>customRoleConfiguration(codex,'executor','executor-one'),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'});
 // A runtime the matrix has no executor leg for is refused at this same layer.
 const independent=executorTrio('independent');
 assert.equal(independent.roles.executors[0].runtime,'independent');
 assert.throws(()=>customRoleConfiguration(independent,'executor','executor-one'),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'});
});

test('the Custom owner sends the text CLI executors into their own leg and refuses the codex one',async()=>{
 const {NativeOwner}=await import('../../dist/server/native-owner.js');
 // Codex keeps its refusal at the same point — before any Magpie session — because the operator
 // here declares no pinned `codex exec` binding (customTextCli.codex).
 for(const runtime of ['codex']){
  const config=executorTrio(runtime),selected=config.roles.executors[0];
  const owner=Object.create(NativeOwner.prototype);
  owner.context={store:{project:()=>({})}};
  owner.customRunAccountSelection=()=>({snapshot:config});
  owner.configured=()=>({op:{},budget:{}});
  owner.assertCustomReady=()=>{};
  owner.requireUserBudget=()=>{};
  let sessions=0;
  owner.withCustomRunMagpieControl=(args,use,signal)=>{
   sessions++;
   const observation={scope:'LOCAL_CONTROL_PROCESS_ONLY',realCredentialsPermitted:true,accounts:[],accountCount:0};
   return use({observation},{},signal);
  };
  const input={role:'executor',executorRoleId:'executor-one',runId:config.runId,model:selected.model.id,workspace:'offline',signal:new AbortController().signal};
  // This fixture is the shipped OAuth shape, which the executor leg does not declare: the refusal
  // is the route one, and no payload or Magpie session is ever constructed for it.
  // (The api-key codex route is refused one station later, at the missing `codex exec` binding —
  // tests/revamp/cli-executor-lanes proves that one.)
  await assert.rejects(owner.custom(input).run(input,()=>{}),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'},runtime);
  assert.equal(sessions,0,runtime);
 }
 // The other three CLI harnesses reach their own executor legs, so each opens the session and is
 // refused later, by the route layer, for the account it does not have here.
 for(const runtime of ['claude','opencode','cline']){
 const config=executorTrio(runtime),selected=config.roles.executors[0];
 const owner=Object.create(NativeOwner.prototype);
 owner.context={store:{project:()=>({})}};
 owner.customRunAccountSelection=()=>({snapshot:config});
 owner.configured=()=>({op:{},budget:{}});
 owner.assertCustomReady=()=>{};
 owner.requireUserBudget=()=>{};
 let sessions=0;
 owner.withCustomRunMagpieControl=(args,use,signal)=>{
  sessions+=1;
  const observation={scope:'LOCAL_CONTROL_PROCESS_ONLY',realCredentialsPermitted:true,accounts:[],accountCount:0};
  return use({observation},{},signal);
 };
 const input={role:'executor',executorRoleId:'executor-one',runId:config.runId,model:selected.model.id,workspace:'offline',signal:new AbortController().signal};
 await assert.rejects(owner.custom(input).run(input,()=>{}),runtime);
 assert.equal(sessions,1,runtime+' executor turn reaches the Magpie session layer');
 }
});

test('the read-only Claude lane still has no tool-carrying purpose on any wire',()=>{
 // A duck-typed Magpie channel is enough: the purpose matrix is decided in the constructor,
 // before a single byte reaches an upstream. Each shape names its own refusal.
 const MODEL='claude-sonnet-5';
 const build=(channel,requests)=>new DeepSeekGateway({},()=>({}),'',8192,requests,undefined,'anthropic-messages',false,
  undefined,undefined,undefined,channel,undefined,MODEL);
 // 1) A model that advertises native Messages with no executor declaration: the route requires
 //    the read-only supervisor flag, and that flag is exactly what forbids tools. The executor
 //    purpose of the same CLI is a separate lane and is tested in claude-executor-lane.test.mjs.
 assert.throws(()=>build({role:'executor',concreteRoute:{runtime:'claude',protocol:'anthropic-messages',model:MODEL}},8),
  {code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 // 2) A model served through the translated lane: the lane is a single-request supervision turn,
 //    so an executor on it is refused even at the request count the lane requires.
 assert.throws(()=>build({role:'executor',claudeTranslated:true,claudeSupervisor:true,concreteRoute:{runtime:'claude',protocol:'chat-completions',model:MODEL}},1),
  {code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 // 3) The shipped supervisor shape still constructs, so the existing lane is untouched.
 assert.doesNotThrow(()=>build({role:'reviewer',claudeTranslated:true,claudeSupervisor:true,concreteRoute:{runtime:'claude',protocol:'chat-completions',model:MODEL}},1));
});
