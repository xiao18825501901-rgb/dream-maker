// OFFLINE contract only: no model, account, Store or dispatch.
import test from 'node:test';import assert from 'node:assert/strict';
import {assertCustomRoleDiversity,customRoleConfiguration} from '../../dist/server/flow/custom-role-identity.js';
const digest='a'.repeat(64);
const actor=(id,{runtime,provider,authentication,model,authRef,accountRef,write=false})=>({id,provider,authentication,authRef,accountRef,runtime,
 model:{kind:'model',id:model},transport:runtime==='dsh'?'magpie':'native',nativeException:runtime!=='dsh',
 permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
const codex=()=>actor('planner2',{runtime:'codex',provider:'openai',authentication:'oauth',model:'gpt-6-luna',authRef:'OPENAI_OAUTH',accountRef:'openai:codex'}),
 dsh=(id='executor-one')=>actor(id,{runtime:'dsh',provider:'deepseek-official',authentication:'api_key',model:'deepseek-flash',authRef:'DEEPSEEK_KEY',accountRef:'deepseek-official:1',write:true}),
 independent=()=>actor('reviewer',{runtime:'independent',provider:'deepseek-official',authentication:'api_key',model:'deepseek-v4-pro',authRef:'DEEPSEEK_KEY_2',accountRef:'deepseek-official:2'}),
 kimi=()=>actor('reviewer',{runtime:'kimi',provider:'kimi',authentication:'oauth',model:'kimi-for-coding',authRef:'KIMI_OAUTH',accountRef:'kimi:code'}),
 sameDsh=(id,model='deepseek-flash',write=false)=>({...actor(id,{runtime:'dsh',provider:'deepseek-official',authentication:'api_key',model,authRef:'DEEPSEEK_KEY',accountRef:'deepseek-official:1',write})});
const snapshot=roles=>({schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'project_offline',runId:'run_offline',
 plan:{versionId:'plan_offline',revision:1,contentHash:digest,specHash:digest},profile:{revision:1,contentHash:digest},
 accounts:[...new Map([roles.planner2,...roles.executors,roles.reviewer].map(r=>[r.authRef,{provider:r.provider,authentication:r.authentication,authRef:r.authRef,accountRef:r.accountRef}])).values()],
 roles,groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:10000000},timeZone:'Asia/Shanghai',
 laya:{enabled:false,mode:'off',roles:[]},magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:digest});
test('each Magpie harness can freeze a new API-key model but its product entry point requires an owned route',async()=>{
 const {NativeOwner}=await import('../../dist/server/native-owner.js');
 for(const [role,runtimes] of [['planner2',['claude','codex','opencode','cline','dsh','independent']],['reviewer',['claude','codex','opencode','cline','dsh','independent']],['executor',['pi','dsh']]]){
  for(const runtime of runtimes){
   const id=role==='executor'?'executor-one':role;
   const selected={...actor(id,{runtime,provider:'fixture-provider',authentication:'api_key',model:'fixture/model',authRef:'FIXTURE_AUTH',accountRef:'fixture-account',write:role==='executor'}),transport:'magpie',nativeException:false};
   const roles={planner2:codex(),executors:[dsh()],reviewer:independent()};
   if(role==='executor')roles.executors=[selected];else roles[role]=selected;
   const config=snapshot(roles);
   assert.equal(config.qualification,'NOT_VERIFIED');
   assert.deepEqual(customRoleConfiguration(config,role,role==='executor'?id:undefined),selected);
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
   const input={role,runId:config.runId,model:selected.model.id,workspace:'offline',signal:new AbortController().signal,...(role==='executor'?{executorRoleId:id}:{})};
   await assert.rejects(owner.custom(input).run(input,()=>{}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
   assert.equal(sessions,1);
  }
 }
});
test('three roles on one DSH harness are refused even with three different models',()=>{
 const s=snapshot({planner2:sameDsh('planner2'),executors:[sameDsh('worker-one','deepseek-chat',true)],reviewer:sameDsh('reviewer','deepseek-reasoner')});
 assert.throws(()=>assertCustomRoleDiversity(s),{code:'CUSTOM_ROLE_HARNESS_NOT_DIVERSIFIED'});
});
test('one model reused across different harnesses is refused',()=>{
 const s=snapshot({planner2:codex(),executors:[dsh()],reviewer:{...independent(),model:{kind:'model',id:'deepseek-flash'}}});
 assert.throws(()=>assertCustomRoleDiversity(s),{code:'CUSTOM_ROLE_MODEL_NOT_DIVERSIFIED'});
});
test('Codex planner, DSH executor and direct-API reviewer pass the owner standard',()=>{
 const s=snapshot({planner2:codex(),executors:[dsh()],reviewer:independent()});
 assert.doesNotThrow(()=>assertCustomRoleDiversity(s));
 assert.equal(customRoleConfiguration(s,'planner2').runtime,'codex');
 assert.equal(customRoleConfiguration(s,'executor','executor-one').runtime,'dsh');
 assert.equal(customRoleConfiguration(s,'reviewer').runtime,'independent');
});
test('an unsupported runtime or foreign model is refused before diversity is considered',()=>{
 const bad={...dsh(),runtime:'laya'},s1=snapshot({planner2:codex(),executors:[bad],reviewer:independent()});
 assert.throws(()=>assertCustomRoleDiversity(s1),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'});
 const foreign={...independent(),runtime:'codex'},s2=snapshot({planner2:codex(),executors:[dsh()],reviewer:foreign});
 assert.throws(()=>assertCustomRoleDiversity(s2),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'});
});

// Stage B guard: a harness may claim the Magpie transport only when a route AND a dispatch branch
// exist for it. Codex on an OpenAI subscription and the direct-API reviewer are still native-only.
test('only harnesses with a wired Magpie route may claim that transport',()=>{
  for(const [role,make] of [['planner2',codex],['reviewer',independent]]){
    const flipped={...make(),transport:'magpie'};
    const roles=role==='planner2'?{planner2:{...flipped,id:'planner2'},executors:[dsh()],reviewer:kimi()}:{planner2:codex(),executors:[dsh()],reviewer:{...flipped,id:'reviewer'}};
    assert.throws(()=>assertCustomRoleDiversity(snapshot(roles)),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'},role);
  }
  // The official CLI running on a DM-owned loopback DeepSeek account is a real route.
  const codexApi={...actor('planner2',{runtime:'codex',provider:'deepseek-official',authentication:'api_key',model:'deepseek-chat',authRef:'DEEPSEEK_KEY_3',accountRef:'deepseek-official:3'}),transport:'magpie',nativeException:false};
  const wired=snapshot({planner2:codexApi,executors:[dsh()],reviewer:kimi()});
  assert.equal(customRoleConfiguration(wired,'planner2').transport,'magpie');
});
test('Kimi is a valid third harness for the reviewer and is refused for other roles',()=>{
 const s=snapshot({planner2:codex(),executors:[dsh()],reviewer:kimi()});
 assert.doesNotThrow(()=>assertCustomRoleDiversity(s));
 assert.equal(customRoleConfiguration(s,'reviewer').runtime,'kimi');
 assert.throws(()=>customRoleConfiguration({...s,roles:{...s.roles,executors:[{...kimi(),id:'executor-two'}]}},'executor','executor-two'),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'});
});

test('retired aliases cannot qualify a new Custom route as distinct models',()=>{
 const s=snapshot({planner2:codex(),executors:[dsh()],reviewer:independent()});
 s.roles.reviewer.model.id='deepseek-reasoner';
 assert.throws(()=>assertCustomRoleDiversity(s),{code:'CUSTOM_MODEL_RETIRED'});
});
test('current Pro and Flash are distinct, compatibility Flash aliases are not',()=>{
 const current=snapshot({planner2:codex(),executors:[dsh()],reviewer:independent()});
 current.roles.reviewer.model.id='deepseek-v4-pro';
 assert.doesNotThrow(()=>assertCustomRoleDiversity(current));
 for(const alias of ['deepseek-v4-flash','deepseek-v4-flash-vision-exp']){
  current.roles.reviewer.model.id=alias;
  assert.throws(()=>assertCustomRoleDiversity(current),{code:'CUSTOM_ROLE_MODEL_NOT_DIVERSIFIED'});
 }
});

test('GPT subscription planner, DSH executor and string Claude reviewer have distinct Magpie roles',()=>{
 const planner2={...codex(),transport:'magpie',nativeException:false};
 const reviewer={...actor('reviewer',{runtime:'claude',provider:'string',authentication:'api_key',model:'claude-sonnet-5',authRef:'STRING_KEY',accountRef:'string:1'}),transport:'magpie',nativeException:false};
 const config=snapshot({planner2,executors:[dsh()],reviewer});
 assert.doesNotThrow(()=>assertCustomRoleDiversity(config));
 const wrongRole=snapshot({planner2,executors:[dsh()],reviewer:{...planner2,id:'reviewer'}});
 assert.throws(()=>customRoleConfiguration(wrongRole,'reviewer'),{code:'CUSTOM_ROLE_RUNTIME_UNSUPPORTED'});
});

test('subscription planner binds the operator account to the approved actor and dedicated home',async()=>{
 const {NativeOwner}=await import('../../dist/server/native-owner.js');
 const {hash}=await import('../../dist/server/security.js');
 const {customAccountReferences}=await import('../../dist/server/custom-account-sources.js');
 const planner2={...codex(),transport:'magpie',nativeException:false};
 const reviewer={...independent(),provider:'string',runtime:'claude',transport:'magpie',nativeException:false,model:{kind:'model',id:'claude-sonnet-5'},authRef:'STRING_KEY',accountRef:'string:1'};
 const config=snapshot({planner2,executors:[dsh()],reviewer}),input={role:'planner2',runId:config.runId};
 const references=customAccountReferences(config);
 assert.equal(references.used.has(planner2.authRef),true);
 assert.deepEqual([...references.magpie].sort(),['DEEPSEEK_KEY','STRING_KEY']);
 const home='offline-dm-home',pin={schema:'dream-maker.codex-subscription-account.v1',authRef:planner2.authRef,accountRef:planner2.accountRef,homeHash:hash(home),accountFingerprint:'c'.repeat(64)};
 const owner=Object.create(NativeOwner.prototype);
 owner.context={getConfig:()=>({codex:{home}})};owner.operator={};owner.readRef=()=>pin;
 assert.throws(()=>owner.customSubscriptionScope(config,input),{code:'CUSTOM_SUBSCRIPTION_ACCOUNT_NOT_PINNED'});
 owner.operator.codexSubscriptionAccount={path:'offline',sha256:digest};
 assert.equal(owner.customSubscriptionScope(config,input).accountFingerprint,pin.accountFingerprint);
 assert.throws(()=>owner.customSubscriptionScope(config,{...input,runId:'another'}),{code:'CUSTOM_ROLE_BINDING_CHANGED'});
 for(const field of ['accountRef','homeHash','authRef','accountFingerprint']){
  owner.readRef=()=>({...pin,[field]:'different'});
  assert.throws(()=>owner.customSubscriptionScope(config,input),{code:'CUSTOM_SUBSCRIPTION_ACCOUNT_BINDING_CHANGED'});
 }
});
const pi=(id='executor-one',{model='deepseek-flash',write=true}={})=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'DEEPSEEK_KEY',accountRef:'deepseek-official:1',runtime:'pi',
 model:{kind:'model',id:model},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
test('Pi serves any one Custom role, never two, and only its executor may write',()=>{
 const ok=snapshot({planner2:codex(),executors:[pi()],reviewer:independent()});
 assert.doesNotThrow(()=>assertCustomRoleDiversity(ok));
 assert.equal(customRoleConfiguration(ok,'executor','executor-one').runtime,'pi');
 // The same harness also serves a read role now, on its own role id and with the read-only pair,
 // so diversity is what still refuses two Pi roles at once rather than a harness ban.
 const asReviewer=snapshot({planner2:codex(),executors:[dsh()],reviewer:pi('reviewer',{model:'deepseek-v4-pro',write:false})});
 assert.doesNotThrow(()=>assertCustomRoleDiversity(asReviewer));
 assert.equal(customRoleConfiguration(asReviewer,'reviewer').runtime,'pi');
 assert.deepEqual(customRoleConfiguration(asReviewer,'reviewer').permissions,['source_read']);
 const asPlanner=snapshot({planner2:pi('planner2',{model:'deepseek-v4-pro',write:false}),executors:[dsh()],reviewer:kimi()});
 assert.doesNotThrow(()=>assertCustomRoleDiversity(asPlanner));
 assert.equal(customRoleConfiguration(asPlanner,'planner2').runtime,'pi');
 // A read Pi role may not carry source_write, and a Pi binding must name its own role id.
 // The write permission is refused by the snapshot itself (a planner2 role is read-only in the
 // frozen profile grammar), which is the earliest of the three places it is refused.
 assert.throws(()=>customRoleConfiguration(snapshot({planner2:pi('planner2'),executors:[dsh()],reviewer:independent()}),'planner2'),{code:'FLOW_CONFIG_INTEGRITY_FAILED'});
 // A role id is fixed by the profile grammar, so a Pi reviewer that names another id is refused by
 // the snapshot itself; the per-turn binding guard is exercised at the runner (pi-readonly-lane).
 assert.throws(()=>customRoleConfiguration(snapshot({planner2:codex(),executors:[dsh()],reviewer:pi('executor-one',{write:false})}),'reviewer'),{code:'FLOW_CONFIG_INTEGRITY_FAILED'});
 // Two Pi roles are one harness wearing two hats.
 assert.throws(()=>assertCustomRoleDiversity(snapshot({planner2:pi('planner2',{model:'deepseek-v4-pro',write:false}),executors:[dsh()],reviewer:pi('reviewer',{write:false})})),{code:'CUSTOM_ROLE_HARNESS_NOT_DIVERSIFIED'});
});


test('OpenCode and Cline Custom supervisors carry their own metered reviewer identity',async()=>{
 const {completedCustomReviewSource}=await import('../../dist/server/flow/role-completion.js');
 const {hash}=await import('../../dist/server/security.js');
 for(const [runtime,runner] of [['opencode','OPENCODE_CLI'],['cline','CLINE_CLI']]){
  const reviewer={...independent(),runtime,transport:'magpie',nativeException:false,model:{kind:'model',id:'deepseek-flash'}};
  const configuration=snapshot({planner2:codex(),executors:[dsh()],reviewer});
  assert.equal(customRoleConfiguration(configuration,'reviewer').runtime,runtime);
  const identity={runner,runtime,roleId:reviewer.id,provider:reviewer.provider,authentication:'API_KEY',model:reviewer.model.id,authRef:reviewer.authRef,
   accountRef:reviewer.accountRef,configurationHash:hash(configuration),routeHash:digest,sessionId:'supervisor-session',requestId:'budget-request'};
  const run={id:configuration.runId,projectId:configuration.projectId,flowName:'custom',rolePolicy:'CUSTOM_FROZEN_V1',
   specHash:configuration.plan.specHash,planVersionId:configuration.plan.versionId,planVersionHash:configuration.plan.contentHash,
   configFingerprint:configuration.configurationFingerprint,flowConfig:configuration,flowConfigHash:hash(configuration),
   sessions:{reviewer:identity.sessionId},roleIdentities:{reviewer:identity}};
  assert.equal(completedCustomReviewSource(run),runner);
  assert.throws(()=>completedCustomReviewSource({...run,roleIdentities:{reviewer:{...identity,runner:'INDEPENDENT_API'}}}),{code:'ROLE_EXECUTION_ROUTE_MISMATCH'});
 }
});

