// OFFLINE contract only: no model, account, Store, Magpie or dispatch.
import test from 'node:test';import assert from 'node:assert/strict';
import {assertCustomProbeActor,customExecutionIdentity} from '../../dist/server/flow/custom-role-identity.js';
import {resolveCustomMagpieRoute} from '../../dist/server/flow/custom-magpie-catalog.js';
import {openCustomKimiRunner,runCustomKimiProbe} from '../../dist/server/flow/custom-kimi-probe.js';
import {hash} from '../../dist/server/security.js';
const digest='a'.repeat(64);
test('legacy Claude qualification requires an owned string Messages reviewer route',()=>{
 const actor={role:'reviewer',roleId:'reviewer',runtime:'claude',provider:'string',model:'claude-sonnet-5',authentication:'API_KEY',transport:'magpie',authRef:'STRING_KEY',accountRef:'string:reviewer'};
 assert.doesNotThrow(()=>assertCustomProbeActor(actor));
 for(const change of [{role:'executor',roleId:'worker-one'},{transport:'native'},{transport:undefined},{authentication:'MEMBER_SUBSCRIPTION'}])
  assert.throws(()=>assertCustomProbeActor({...actor,...change}),{code:'CUSTOM_PROBE_BINDING_INVALID'});

 // Owned route resolution enforces legacy eligibility after the actor shape check.
 const selected={...actor,id:actor.roleId,model:{kind:'model',id:actor.model},authentication:'api_key',nativeException:false,permissions:['source_read']};
 const account={provider:actor.provider,authentication:selected.authentication,model:actor.model,authRef:actor.authRef,accountRef:actor.accountRef,upstreamAccountRef:'string/offline_reviewer'};
 const observation={scope:'LOCAL_CONTROL_PROCESS_ONLY',binaryHash:digest,accountCount:1,accounts:[account]};
 const resolve=(role='reviewer',patch={},owned=observation)=>resolveCustomMagpieRoute(owned,role,{...selected,...patch});
 assert.deepEqual(resolve(),{runtime:'claude',protocol:'anthropic-messages',...account});
 assert.throws(()=>resolve('planner2',{id:'planner2'}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
 assert.throws(()=>resolve('reviewer',{model:{kind:'model',id:'claude-unknown'}}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
 assert.throws(()=>resolve('reviewer',{accountRef:'string:other'}),{code:'CUSTOM_ACCOUNT_SOURCE_MISMATCH'});
 assert.throws(()=>resolve('reviewer',{}, {...observation,scope:'DESKTOP_METADATA_ONLY'}),{code:'CUSTOM_MAGPIE_OBSERVATION_INVALID'});
});
const kimiActor={role:'reviewer',roleId:'reviewer',runtime:'kimi',provider:'kimi',authentication:'MEMBER_SUBSCRIPTION',model:'kimi-for-coding',authRef:'KIMI_OAUTH',accountRef:'kimi:code'};
const config={kimi:{baseUrl:'http://127.0.0.1:58713',timeoutMs:1000,pollMs:10,tokenFile:'C:/offline/token',enabled:true,workspace:'/workspace'}};

test('the probe actor table accepts a Kimi reviewer and refuses it anywhere else',()=>{
 assert.doesNotThrow(()=>assertCustomProbeActor(kimiActor));
 assert.throws(()=>assertCustomProbeActor({...kimiActor,role:'executor',roleId:'worker-one'}),{code:'CUSTOM_PROBE_BINDING_INVALID'});
 assert.throws(()=>assertCustomProbeActor({...kimiActor,role:'planner2',roleId:'planner2'}),{code:'CUSTOM_PROBE_BINDING_INVALID'});
 assert.throws(()=>assertCustomProbeActor({...kimiActor,authentication:'CHATGPT_SUBSCRIPTION'}),{code:'CUSTOM_PROBE_BINDING_INVALID'});
});

test('Custom reviewer identity must be the Kimi runner, never a relabelled DSH turn',()=>{
 const item=(id,runtime,provider,authentication,model,authRef,accountRef,write=false)=>({id,provider,authentication,authRef,accountRef,runtime,
  model:{kind:'model',id:model},transport:runtime==='dsh'?'magpie':'native',nativeException:runtime!=='dsh',
  permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const planner2=item('planner2','codex','openai','oauth','gpt-6-luna','OPENAI_OAUTH','openai:codex'),
  executor=item('worker-one','dsh','deepseek-official','api_key','deepseek-flash','DEEPSEEK_KEY','deepseek-official:1',true),
  role=item('reviewer','kimi','kimi','oauth','kimi-for-coding','KIMI_OAUTH','kimi:code');
 const accounts=[{provider:'openai',authentication:'oauth',authRef:'OPENAI_OAUTH',accountRef:'openai:codex'},
  {provider:'deepseek-official',authentication:'api_key',authRef:'DEEPSEEK_KEY',accountRef:'deepseek-official:1'},
  {provider:'kimi',authentication:'oauth',authRef:'KIMI_OAUTH',accountRef:'kimi:code'}];
 const flowConfig={schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'project_offline',runId:'run_offline',
  plan:{versionId:'plan_offline',revision:1,contentHash:digest,specHash:digest},profile:{revision:1,contentHash:digest},accounts,
  roles:{planner2,executors:[executor],reviewer:role},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},
  budget:{currency:'CNY',maxMicros:10000000},timeZone:'Asia/Shanghai',laya:{enabled:false,mode:'off',roles:[]},
  magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:digest};
 const run={id:'run_offline',projectId:'project_offline',flowName:'custom',flowConfig,rolePolicy:'CUSTOM_FROZEN_V1',
  specHash:digest,planVersionId:'plan_offline',planVersionHash:digest,flowConfigHash:hash(flowConfig),configFingerprint:digest};
 const identity={runner:'KIMI_SERVER',provider:'kimi',authentication:'MEMBER_SUBSCRIPTION',model:'kimi-for-coding',runtime:'kimi',roleId:'reviewer',authRef:'KIMI_OAUTH',accountRef:'kimi:code',configurationHash:hash(flowConfig)};
 const out={text:'',model:'kimi-for-coding',sessionId:'session_offline',identity,usage:{role:'reviewer',requestId:'prompt_1'}};
 assert.doesNotThrow(()=>customExecutionIdentity(run,'reviewer',out));
 assert.throws(()=>customExecutionIdentity(run,'reviewer',{...out,identity:{...identity,runner:'DSH'}}),{code:'ROLE_EXECUTION_ROUTE_MISMATCH'});
});

test('a Kimi reviewer turn is adapter-attributed, one-shot and carries the real session',async()=>{
 const calls=[];
 const runner=await openCustomKimiRunner({root:'C:/offline',dataRoot:'C:/offline/data',getConfig:()=>config,
  actor:{role:'reviewer',roleId:'reviewer',provider:'kimi',model:'kimi-for-coding',authRef:'KIMI_OAUTH',accountRef:'kimi:code'},configurationHash:digest,
  assertCurrent:()=>{},runner:{run:async args=>{calls.push(args);return{text:'{"verdict":"PASS","findings":[]}',model:'kimi-for-coding',sessionId:'session_offline',
   usage:{role:'planner1',requestId:'prompt_1',inputTokens:1,outputTokens:1,costUsd:null,source:'PROVIDER'}}}}});
 const out=await runner.run({role:'reviewer',workspace:'C:/offline/ws',prompt:'x',model:'kimi-for-coding',specHash:digest,runId:'run_offline',
  laya:{role:'reviewer',mode:'off',adoption:'off',label:null,reason:'OFFLINE',latencyMs:0,inputHash:'',modelRevision:null,confidence:null,cached:false},signal:new AbortController().signal},()=>{});
 assert.equal(calls.length,1);
 assert.equal(out.identity.runner,'KIMI_SERVER');
 assert.equal(out.identity.authentication,'MEMBER_SUBSCRIPTION');
 assert.equal(out.usage.role,'reviewer');
 await assert.rejects(()=>runner.run({role:'reviewer'},{},{}),{code:'CUSTOM_ROLE_TURN_ALREADY_USED'});
});

test('the Kimi minimum probe echoes its own nonce with no Native ledger row',async()=>{
 const nonce='dmcpabcdef012345',base={root:'C:/offline',dataRoot:'C:/offline/data',getConfig:()=>config,actor:kimiActor,configurationHash:digest,
  workspace:'/workspace',nonce,signal:new AbortController().signal,runId:'run_offline',specHash:digest,assertCurrent:()=>{}};
 const good=await runCustomKimiProbe({...base,runner:{run:async()=>({text:nonce,model:'kimi-for-coding',sessionId:'session_offline',
  usage:{role:'reviewer',requestId:'prompt_1',inputTokens:1,outputTokens:1,costUsd:null,source:'PROVIDER'}})}});
 assert.equal(good.runner,'KIMI_SERVER');
 assert.equal(good.reply,nonce);
 assert.deepEqual(good.ledgerRequestIds,[]);
 await assert.rejects(()=>runCustomKimiProbe({...base,runner:{run:async()=>({text:'WRONG',model:'kimi-for-coding',sessionId:'session_offline',
  usage:{role:'reviewer',requestId:'prompt_1'}})}}),{code:'CUSTOM_PROBE_RESPONSE_UNVERIFIED'});
});
