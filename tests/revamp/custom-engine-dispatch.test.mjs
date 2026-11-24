// OFFLINE original Engine/Store/Dispatch with explicit runtime substitutes. NOT Native/Live evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {existsSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {harness,ready,bindOfflineApi} from '../helpers.mjs';import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';import {FlowProfiles} from '../../dist/server/flow-profiles.js';import {hash,DomainError} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {installOfflinePrework} from '../fixtures/offline-prework.mjs';
import {ExecutorSlices} from '../../dist/server/flow/executor-slices.js';
import * as completion from '../../dist/server/flow/role-completion.js';
import {verifiedExecutorRoleIdentities} from '../../dist/server/flow/executor-role-evidence.js';
const actor='local-session:'+'a'.repeat(64);
async function fixture(t,{denial=false,group=false,groupSelection=null,identityChange={},sameSession=false,executorCount=1}={}){
 const h=harness(t);bindOfflineApi(h.config);h.config.independent={enabled:true,baseUrl:'https://api.deepseek.com/v1',model:'GLOBAL_MODEL_MUST_NOT_RUN',keyEnv:'OFFLINE_UNUSED',maxOutputTokens:128,maxRequests:1};const {p,s}=await ready(h,'live');fixedControllerCapacity(h.engine);h.engine.launch=()=>{};
 if(executorCount>1)h.engine.dispatch.binding.measure=()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:9216,sampledAt:new Date().toISOString()});
 const a={provider:'deepseek-official',authentication:'api_key',authRef:'SYNTHETIC_AUTH',accountRef:'SYNTHETIC_ACCOUNT'},a2={...a,authRef:'SYNTHETIC_AUTH_2',accountRef:'SYNTHETIC_ACCOUNT_2'},item=(id,write=false)=>({id,...a,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}}),executors=Array.from({length:executorCount},(_,index)=>item(index===0?'worker-one':index===1?'worker-two':'worker-'+(index+1),true)),configuration={mode:'custom',laya:false,accounts:[a],roles:{planner2:item('planner2'),executors,reviewer:item('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 if(group){configuration.accounts.push(a2);configuration.roles.planner2.model={kind:'group',id:'UNSELECTED_GROUP'};if(groupSelection)configuration.roles.planner2.selectedMemberId=groupSelection;configuration.groups=[{id:'UNSELECTED_GROUP',strategy:'failure_only',members:[{id:'first',provider:a.provider,model:'deepseek-flash',authRef:a.authRef,accountRef:a.accountRef,permissions:['source_read']},{id:'second',provider:a2.provider,model:'deepseek-flash',authRef:a2.authRef,accountRef:a2.accountRef,permissions:['source_read']}]}];}
 const selectedAccount=groupSelection==='second'?a2:a;
 const profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'SYNTHETIC_ENGINE_PROFILE'),prepared=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash),calls={preflight:[],custom:[],classic:0};let reject=denial;
 const factory={assertReady(){calls.classic++;throw Error('CLASSIC_ADMISSION_MUST_NOT_RUN');},codex(){calls.classic++;throw Error('CLASSIC_CODEX_MUST_NOT_RUN');},executor(){calls.classic++;throw Error('CLASSIC_EXECUTOR_MUST_NOT_RUN');},verify:async()=>{throw Error('VERIFIER_NOT_USED_BY_THIS_FIXTURE');},close:async()=>{},assertCustomReady(snapshot){calls.preflight.push(snapshot.runId);if(reject)throw new DomainError('SYNTHETIC_CUSTOM_QUALIFICATION_DENIED',409);assert.equal(snapshot.mode,'custom');},custom(input){calls.custom.push({...input,signal:undefined});return{run:async()=>{const run=h.store.run(input.runId),roleId=input.role==='executor'?input.executorRoleId:input.role;return{text:input.role==='executor'?'OFFLINE_COMPONENT_ONLY':'{"offline":true}',sessionId:sameSession?'SYNTHETIC_SHARED_SESSION':'SYNTHETIC_'+input.role,model:'deepseek-flash',identity:{runner:'DSH',runtime:'dsh',provider:selectedAccount.provider,authentication:'API_KEY',model:'deepseek-flash',roleId,authRef:selectedAccount.authRef,accountRef:selectedAccount.accountRef,configurationHash:run.flowConfigHash,routeHash:hash('SYNTHETIC_ROUTE_'+roleId),...identityChange},usage:{role:input.role,requestId:'SYNTHETIC_REQUEST_'+input.role,inputTokens:null,outputTokens:null,costUsd:null,source:'OFFLINE_TEST_NOT_MODEL'}};}};}};
 h.engine.nativeExecution=factory;
 const create=()=>h.engine.create(p.id,s.hash,true,false,'custom'),turn=async(run,role)=>{
  let r=h.store.run(run.id);r.phase=role==='planner2'?'PLANNING':role==='executor'?'IMPLEMENTING':'REVIEWING';r.state=r.phase;
  if(role==='executor'&&!r.prework)r.tasks=[{id:'SYNTHETIC_TASK',title:'OFFLINE',dependsOn:[],requirementIds:s.requirements.map(v=>v.id),acceptance:['OFFLINE'],writePaths:['offline.txt'],status:'pending'}];
  h.store.saveRun(r);
  let assignment;
  if(role==='executor'){
   if(!r.prework)r=installOfflinePrework(h,r.id,{plannerSession:'SYNTHETIC_planner2',plannerRequest:'SYNTHETIC_REQUEST_planner2'});
   assignment=new ExecutorSlices(h.store,h.dir).prepare(r.id).assignments[0];
  }
  return h.engine.role(h.store.run(r.id),role,'OFFLINE_ROLE_PAYLOAD',new AbortController().signal,assignment?.taskId,assignment?.id);
 };
 return{h,p,s,prepared,calls,factory,create,turn,setDenied:v=>reject=v};
}
function prepareMultiExecutor(x,run){
 const r=x.h.store.run(run.id);
 r.phase=r.state='IMPLEMENTING';
 r.tasks=[
  {id:'TASK_A',title:'OFFLINE_A',dependsOn:[],requirementIds:x.s.requirements.map(v=>v.id),acceptance:['OFFLINE'],writePaths:['a.txt'],status:'pending'},
  {id:'TASK_B',title:'OFFLINE_B',dependsOn:[],requirementIds:x.s.requirements.map(v=>v.id),acceptance:['OFFLINE'],writePaths:['b.txt'],status:'pending'}
 ];
 r.treeHash=treeHash(r.workspace);
 x.h.store.saveRun(r);
 installOfflinePrework(x.h,r.id,{plannerSession:'SYNTHETIC_planner2',plannerRequest:'SYNTHETIC_REQUEST_planner2'});
 return new ExecutorSlices(x.h.store,x.h.dir).prepare(run.id);
}
async function completeTwoExecutors(x,run){
 const wave=prepareMultiExecutor(x,run),original=x.factory.custom;
 let release,timer;const both=new Promise(resolve=>{release=resolve;});let entered=0,released=false;
 const unlock=()=>{if(released)return;released=true;clearTimeout(timer);release();};timer=setTimeout(unlock,5000);
 x.factory.custom=input=>{
  const runner=original(input);
  return{run:async(...args)=>{
   if(input.role!=='executor')return runner.run(...args);
   if(++entered===2)unlock();await both;
   const out=await runner.run(...args),key=input.executorRoleId+'_'+input.taskId;
   return{...out,sessionId:'SYNTHETIC_SESSION_'+key,identity:{...out.identity,roleId:input.executorRoleId,routeHash:hash('SYNTHETIC_ROUTE_'+key)},usage:{...out.usage,requestId:'SYNTHETIC_REQUEST_'+key}};
  }};
 };
 const signal=new AbortController().signal;
 await Promise.all(wave.assignments.map(a=>x.h.engine.role(x.h.store.run(run.id),'executor','OFFLINE_MULTI',signal,a.taskId,a.id)));
 return x.h.store.run(run.id);
}
test('Custom factory qualification rejects before build approval, lease, workspace or model dispatch',async t=>{
 const x=await fixture(t,{denial:true});assert.throws(x.create,{code:'SYNTHETIC_CUSTOM_QUALIFICATION_DENIED'});assert.equal(x.h.store.runs(x.p.id).length,0);assert.equal(x.h.store.approved(x.p.id,x.s.hash,'BUILD'),false);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);assert.equal(existsSync(resolve(x.h.dir,'workspaces',x.prepared.flowConfig.runId)),false);assert.deepEqual(x.calls.custom,[]);assert.equal(x.calls.classic,0);
});
test('the original Engine creates Custom with its exact frozen plan and truthful policy, independently of global Codex',async t=>{
 const x=await fixture(t),run=x.create();assert.equal(run.rolePolicy,'CUSTOM_FROZEN_V1');assert.equal(run.id,x.prepared.flowConfig.runId);assert.deepEqual(run.flowConfig,x.prepared.flowConfig);assert.equal(run.flowConfigHash,x.prepared.flowConfigHash);assert.equal(run.flowConfig.laya.enabled,false);assert.equal(x.h.store.owns(x.p.id,run.id),true);assert.equal(x.h.store.approved(x.p.id,x.s.hash,'BUILD'),true);assert.equal(x.calls.classic,0);assert.deepEqual(x.calls.custom,[]);
});
test('an unknown Custom executor result does not inherit Classic segmented retries',async t=>{
 const x=await fixture(t),original=x.factory.custom;let attempts=0;
 x.factory.custom=input=>{const runner=original(input);return{run:async(...args)=>{attempts++;if(attempts===1)throw new DomainError('RUNNER_RPC_ERROR',502);return runner.run(...args);}};};
 const run=x.create();await assert.rejects(x.turn(run,'executor'),{code:'RUNNER_RPC_ERROR'});assert.equal(attempts,1);assert.equal(x.calls.classic,0);
});
for(const defect of ['rpc','json','plan','scope'])test('the full Custom loop stops '+defect+' planning failure without a fresh dispatch or repair',async t=>{
 const x=await fixture(t),original=x.factory.custom;let attempts=0,repairs=0;
 x.factory.reserveRepair=()=>{repairs++;};x.factory.custom=input=>{const runner=original(input);return{run:async(...args)=>{attempts++;if(defect==='rpc')throw new DomainError('RUNNER_RPC_ERROR',502);const out=await runner.run(...args);return{...out,text:defect==='json'?'OFFLINE_NOT_JSON':JSON.stringify({tasks:defect==='scope'?[{id:'T1',title:'OFFLINE_BAD_SCOPE',dependsOn:[],requirementIds:x.s.requirements.map(r=>r.id),acceptance:['OFFLINE'],writePaths:[]}]:[]})};}};};
 const run=x.create();x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);x.h.engine.launch(run.id);await x.h.engine.settled(run.id);
 const current=x.h.store.run(run.id);assert.equal(attempts,1);assert.equal(repairs,0);assert.equal(current.repairCount,0);assert.equal(current.state,'BLOCKED');assert.equal(current.phase,'PLANNING');assert.equal(x.calls.classic,0);
});
for(const role of ['planner2','executor','reviewer'])test('original Custom '+role+' dispatch uses its frozen runner/model/account without a Classic fallback',async t=>{
 const x=await fixture(t),run=x.create();await x.turn(run,role);assert.equal(x.calls.custom.length,1);const input=x.calls.custom[0];assert.equal(input.role,role);assert.equal(input.model,'deepseek-flash');assert.equal(input.laya.mode,'off');assert.equal(input.laya.adoption,'off');if(role==='executor')assert.equal(input.executorRoleId,'worker-one');
 const session=x.h.store.records(x.p.id,'AgentSession')[0].data;assert.equal(session.runner,'DSH');assert.equal(session.model,'deepseek-flash');assert.equal(session.roleId,role==='executor'?'worker-one':role);assert.equal(session.accountRef,'SYNTHETIC_ACCOUNT');assert.equal(session.configurationHash,run.flowConfigHash);assert.equal(x.calls.classic,0);assert.equal(x.h.store.records(x.p.id,'NativeProbeReceipt').length,0);assert.equal(x.h.engine.dispatch.snapshot().quarantined.length,0);
});
test('the original Engine marks Custom executor dispatches as multi-worker without weakening Classic',async t=>{
 const x=await fixture(t),run=x.create();await x.turn(run,'executor');
 const queued=x.h.store.records(x.p.id,'DispatchQueued').filter(row=>row.data.kind==='executor');
 assert.equal(queued.length,1);
 assert.equal(queued[0].data.demand.executorSlots,1);
 assert.equal(queued[0].data.executorParallelClass,'CUSTOM_MULTI');
 assert.equal(x.calls.classic,0);
});
test('two concurrent Custom executors keep independent role, session, task and slice evidence',async t=>{
 const x=await fixture(t,{executorCount:2}),run=x.create(),wave=prepareMultiExecutor(x,run),original=x.factory.custom,enter=[];
 let release,timer;const both=new Promise(resolve=>{release=resolve;});let released=false;
 const unlock=()=>{if(released)return;released=true;clearTimeout(timer);release();};
 timer=setTimeout(unlock,5000);
 x.factory.custom=input=>{
  const runner=original(input);
  return{run:async(...args)=>{
   if(input.role!=='executor')return runner.run(...args);
   enter.push(input.executorRoleId);
   if(enter.length===2)unlock();
   await both;
   const out=await runner.run(...args),key=input.executorRoleId+'_'+input.taskId;
   return{...out,sessionId:'SYNTHETIC_SESSION_'+key,identity:{...out.identity,roleId:input.executorRoleId,routeHash:hash('SYNTHETIC_ROUTE_'+key)},usage:{...out.usage,requestId:'SYNTHETIC_REQUEST_'+key}};
  }};
 };
 const signal=new AbortController().signal;
 await Promise.all(wave.assignments.map(a=>x.h.engine.role(x.h.store.run(run.id),'executor','OFFLINE_MULTI',signal,a.taskId,a.id)));
 const current=x.h.store.run(run.id);
 assert.deepEqual(enter.sort(),['worker-one','worker-two']);
 assert.equal(current.executorRoleIdentities?.length,2);
 assert.deepEqual(current.executorRoleIdentities.map(v=>v.executorRoleId).sort(),['worker-one','worker-two']);
 assert.deepEqual(current.executorRoleIdentities.map(v=>v.taskId).sort(),['TASK_A','TASK_B']);
 assert.equal(new Set(current.executorRoleIdentities.map(v=>v.sessionId)).size,2);
 assert.equal(new Set(current.executorRoleIdentities.map(v=>v.requestId)).size,2);
 assert.equal(new Set(current.executorRoleIdentities.map(v=>v.sliceId)).size,2);
 assert.equal(current.roleIdentities.executor.executorRoleId??current.roleIdentities.executor.roleId,'worker-one');
 assert.equal(x.h.store.records(x.p.id,'AgentSession').filter(v=>v.runId===run.id&&v.data.role==='executor').length,2);
 assert.equal(x.h.store.records(x.p.id,'UsageLedger').filter(v=>v.runId===run.id&&v.data.role==='executor').length,2);
 await x.turn(run,'planner2');await x.turn(run,'reviewer');
 const completed=x.h.store.run(run.id);
 assert.equal(completion.completedEngineeringRoles(completed,x.h.config,x.h.store),true);
 const tampered=structuredClone(completed);tampered.executorRoleIdentities[1].dispatchId='FOREIGN_DISPATCH';
 assert.equal(completion.completedEngineeringRoles(tampered,x.h.config,x.h.store),false);
});
test('two Custom executors cannot share one completed session or request',async t=>{
 const x=await fixture(t,{executorCount:2}),run=x.create(),wave=prepareMultiExecutor(x,run),original=x.factory.custom;
 let release,timer;const both=new Promise(resolve=>{release=resolve;});let entered=0,released=false;
 const unlock=()=>{if(released)return;released=true;clearTimeout(timer);release();};timer=setTimeout(unlock,5000);
 x.factory.custom=input=>{
  const runner=original(input);
  return{run:async(...args)=>{
   if(++entered===2)unlock();await both;
   const out=await runner.run(...args);
   return{...out,sessionId:'SYNTHETIC_SHARED_EXECUTOR',identity:{...out.identity,roleId:input.executorRoleId},usage:{...out.usage,requestId:'SYNTHETIC_SHARED_REQUEST'}};
  }};
 };
 const signal=new AbortController().signal,settled=await Promise.allSettled(wave.assignments.map(a=>x.h.engine.role(x.h.store.run(run.id),'executor','OFFLINE_DUPLICATE',signal,a.taskId,a.id)));
 assert.equal(settled.filter(value=>value.status==='fulfilled').length,1);
 assert.equal(settled.filter(value=>value.status==='rejected'&&value.reason?.code==='ROLE_SESSIONS_NOT_INDEPENDENT').length,1);
 const current=x.h.store.run(run.id);
 assert.equal(current.executorRoleIdentities.length,1);
 assert.equal(x.h.store.records(x.p.id,'AgentSession').filter(v=>v.runId===run.id&&v.data.role==='executor').length,1);
});
for(const [name,tamper] of [
 ['a missing DispatchFinished',(x,run)=>{
  const target=run.executorRoleIdentities[1];
  x.h.store.db.prepare("DELETE FROM records WHERE run_id=? AND kind='DispatchFinished' AND json_extract(data,'$.dispatchId')=?").run(run.id,target.dispatchId);
 }],
 ['cleanup that was not proven',(x,run)=>{
  const target=run.executorRoleIdentities[1];
  x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.cleanupReturned',json('false')) WHERE run_id=? AND kind='DispatchFinished' AND json_extract(data,'$.dispatchId')=?").run(run.id,target.dispatchId);
 }],
 ['a task/session mismatch',(x,run)=>{
  const target=run.executorRoleIdentities[1];
  x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.taskId','FOREIGN_TASK') WHERE run_id=? AND kind='AgentSession' AND json_extract(data,'$.sessionId')=?").run(run.id,target.sessionId);
 }],
 ['more executor evidence than actual sessions',(x,run)=>{
  const target=run.executorRoleIdentities[1];
  x.h.store.db.prepare("DELETE FROM records WHERE run_id=? AND kind='AgentSession' AND json_extract(data,'$.sessionId')=?").run(run.id,target.sessionId);
 }],
 ['a dispatch/slice mismatch',(x,run)=>{
  const target=run.executorRoleIdentities[1];
  x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.executorSliceId','FOREIGN_SLICE') WHERE run_id=? AND kind='DispatchGranted' AND json_extract(data,'$.dispatchId')=?").run(run.id,target.dispatchId);
 }],
 ['duplicate executor sessions',(x,run)=>{
  const first=run.executorRoleIdentities[0],second=run.executorRoleIdentities[1];
  x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.sessionId',?) WHERE run_id=? AND kind='AgentSession' AND json_extract(data,'$.sessionId')=?").run(first.sessionId,run.id,second.sessionId);
 }]
])test('Custom executor evidence rejects '+name,async t=>{
 const x=await fixture(t,{executorCount:2}),run=x.create(),completed=await completeTwoExecutors(x,run);
 assert.equal(verifiedExecutorRoleIdentities(completed,x.h.store).length,2);
 tamper(x,completed);
 assert.throws(()=>verifiedExecutorRoleIdentities(x.h.store.run(run.id),x.h.store),{code:'ROLE_EXECUTION_IDENTITY_UNVERIFIED'});
});
test('rejected Custom preflight at a role boundary makes no call and does not fall back',async t=>{
 const x=await fixture(t),run=x.create();x.setDenied(true);await assert.rejects(x.turn(run,'planner2'),{code:'SYNTHETIC_CUSTOM_QUALIFICATION_DENIED'});assert.equal(x.h.store.run(run.id).calls,0);assert.deepEqual(x.calls.custom,[]);assert.equal(x.calls.classic,0);
});
test('actual route/account/configuration identity drift is rejected before recording a completed Custom role',async t=>{
 for(const identityChange of [{accountRef:'FOREIGN'},{authRef:'FOREIGN'},{configurationHash:'f'.repeat(64)},{runner:'CODEX_CLI'},{roleId:'reviewer'},{runtime:'api-client'}]){const x=await fixture(t,{identityChange}),run=x.create();await assert.rejects(x.turn(run,'planner2'),{code:'ROLE_EXECUTION_ROUTE_MISMATCH'});assert.equal(x.h.store.records(x.p.id,'AgentSession').length,0);assert.equal(x.calls.classic,0);}
});
test('Custom supervisors retain the original independent-session boundary',async t=>{
 const x=await fixture(t,{sameSession:true}),run=x.create();await x.turn(run,'planner2');await assert.rejects(x.turn(run,'reviewer'),{code:'ROLE_SESSIONS_NOT_INDEPENDENT'});assert.equal(x.h.store.records(x.p.id,'AgentSession').length,1);assert.equal(x.calls.classic,0);
});
test('an unselected model group cannot silently use its first frozen member',async t=>{
 await assert.rejects(fixture(t,{group:true}),{code:'FLOW_PROFILE_GROUP_SCOPE_INVALID'});
});
test('an explicitly selected group member is the only frozen Custom actor used',async t=>{
 const x=await fixture(t,{group:true,groupSelection:'second'}),run=x.create();await x.turn(run,'planner2');assert.equal(x.calls.custom.length,1);assert.equal(x.calls.custom[0].model,'deepseek-flash');
 const session=x.h.store.records(x.p.id,'AgentSession')[0].data;assert.equal(session.authRef,x.a2?.authRef??'SYNTHETIC_AUTH_2');assert.equal(session.accountRef,x.a2?.accountRef??'SYNTHETIC_ACCOUNT_2');
});
for(const result of ['boolean','promise'])test('Custom qualification must complete synchronously, not return a '+result+' as proof',async t=>{
 const x=await fixture(t);x.factory.assertCustomReady=()=>result==='boolean'?false:Promise.resolve();assert.throws(x.create,{code:'CUSTOM_QUALIFICATION_RESULT_INVALID'});assert.equal(x.h.store.approved(x.p.id,x.s.hash,'BUILD'),false);assert.equal(x.h.store.runs(x.p.id).length,0);assert.deepEqual(x.calls.custom,[]);
});
test('resuming Custom rechecks its own qualification before changing a saved checkpoint',async t=>{
 const x=await fixture(t),run=x.create(),r=x.h.store.run(run.id);r.state='PAUSED';x.h.store.saveRun(r);const before=hash(x.h.store.run(run.id));x.setDenied(true);await assert.rejects(x.h.engine.resume(run.id),{code:'SYNTHETIC_CUSTOM_QUALIFICATION_DENIED'});assert.equal(hash(x.h.store.run(run.id)),before);assert.equal(x.calls.classic,0);assert.deepEqual(x.calls.custom,[]);x.setDenied(false);const resumed=await x.h.engine.resume(run.id);assert.equal(resumed.state,'PLANNING');assert.equal(resumed.calls,0);assert.equal(x.calls.classic,0);
});
test('Custom reports frozen actual actor identities and keeps a component-only result unaccepted',async t=>{
 const x=await fixture(t),run=x.create();for(const role of ['planner2','executor','reviewer'])await x.turn(run,role);const r=x.h.store.run(run.id);r.state='BLOCKED';r.reason='SYNTHETIC_COMPONENT_ONLY';r.treeHash=treeHash(r.workspace);x.h.store.saveRun(r);x.h.store.release(x.p.id,run.id);const report=x.h.engine.flowReport(run.id);assert.equal(report.rolePolicy,'CUSTOM_FROZEN_V1');assert.equal(report.targetRolesMet,true);assert.equal(report.technicalRequirementsMet,false);assert.equal(report.userAccepted,false);assert.equal(report.roles.executor.roleId,'worker-one');r.roleIdentities.reviewer.accountRef='FOREIGN';x.h.store.saveRun(r);assert.equal(x.h.engine.flowReport(run.id).targetRolesMet,false);
});
test('verification flags alone cannot accept Custom without its completed role identities',async t=>{
 const x=await fixture(t),run=x.create(),r=x.h.store.run(run.id);r.state=r.phase='READY_FOR_DELIVERY';r.treeHash=treeHash(r.workspace);r.verification={ok:true,treeHash:r.treeHash};r.review={verdict:'PASS',treeHash:r.treeHash};x.h.store.saveRun(r);x.h.store.release(x.p.id,run.id);assert.throws(()=>x.h.engine.accept(run.id),{code:'ACCEPTANCE_GATES_NOT_MET'});assert.equal(x.h.store.approved(x.p.id,x.s.hash,'DELIVERY'),false);
});
test('settings drift during asynchronous assistance is fenced before opening a Custom runner',async t=>{
 const x=await fixture(t),run=x.create(),decide=x.h.laya.decide.bind(x.h.laya);x.h.laya.decide=async(...args)=>{const result=await decide(...args);x.h.config.limits.maxCalls++;return result;};await assert.rejects(x.turn(run,'planner2'),{code:'RUN_CONFIG_CHANGED'});assert.deepEqual(x.calls.custom,[]);assert.equal(x.calls.classic,0);assert.equal(x.h.store.records(x.p.id,'AgentSession').length,0);
});
test('first-round source changes during assistance are fenced even before a run has its first tree hash',async t=>{
 const x=await fixture(t),run=x.create(),decide=x.h.laya.decide.bind(x.h.laya);assert.equal(run.treeHash,null);x.h.laya.decide=async(...args)=>{const result=await decide(...args);writeFileSync(resolve(run.workspace,'外部修改.txt'),'SYNTHETIC_EXTERNAL_WRITE');return result;};await assert.rejects(x.turn(run,'planner2'),{code:'EXTERNAL_WORKSPACE_CHANGE'});assert.deepEqual(x.calls.custom,[]);assert.equal(x.h.store.records(x.p.id,'AgentSession').length,0);
});
test('a cancelled late Custom reviewer cannot create a completed session or role identity',async t=>{
 const x=await fixture(t),run=x.create();await x.turn(run,'planner2');await x.turn(run,'executor');
 const r=x.h.store.run(run.id);r.state=r.phase='REVIEWING';x.h.store.saveRun(r);
 const controller=new AbortController(),custom=x.factory.custom;
 x.factory.custom=input=>{const runner=custom(input);return{run:async(...args)=>{
  const out=await runner.run(...args);controller.abort(new DomainError('RUN_CANCELLED',409));return out;
 }}};
 await assert.rejects(x.h.engine.role(x.h.store.run(run.id),'reviewer','OFFLINE_LATE_RESULT',controller.signal),{code:'RUN_CANCELLED'});
 const current=x.h.store.run(run.id);assert.equal(current.roleIdentities.reviewer,undefined);assert.equal(current.sessions.reviewer,undefined);assert.equal(x.h.store.records(x.p.id,'AgentSession').length,2);
});
test('a Custom dispatch fenced at its result gate cannot publish role completion first',async t=>{
 const x=await fixture(t),run=x.create(),isCurrent=x.h.engine.dispatch.binding.isCurrent;x.h.engine.dispatch.binding.isCurrent=(request,stage)=>stage==='RESULT'?false:isCurrent(request,stage);await assert.rejects(x.turn(run,'planner2'),{code:'DISPATCH_RESULT_FENCED'});assert.equal(x.h.store.run(run.id).roleIdentities?.planner2,undefined);assert.equal(x.h.store.records(x.p.id,'AgentSession').length,0);
});
test('VERIFYING Custom resume also checks qualification before changing the saved state',async t=>{
 const x=await fixture(t),run=x.create(),r=x.h.store.run(run.id);r.state='PAUSED';r.phase='VERIFYING';x.h.store.saveRun(r);const before=hash(x.h.store.run(run.id));x.setDenied(true);await assert.rejects(x.h.engine.resume(run.id),{code:'SYNTHETIC_CUSTOM_QUALIFICATION_DENIED'});assert.equal(hash(x.h.store.run(run.id)),before);assert.equal(x.calls.classic,0);
});
test('review provenance comes from the completed Custom adapter rather than a fixed Codex label',async t=>{
 const x=await fixture(t),run=x.create();await x.turn(run,'reviewer');assert.equal(completion.completedReviewSource(x.h.store.run(run.id),x.h.config),'DSH');
});
test('a phase change while a Custom runner finishes cannot publish the old phase result',async t=>{
 const x=await fixture(t),run=x.create(),custom=x.factory.custom;
 x.factory.custom=input=>{const runner=custom(input);return{run:async(...args)=>{const out=await runner.run(...args),r=x.h.store.run(run.id);r.state=r.phase='VERIFYING';x.h.store.saveRun(r);return out;}};};
 await assert.rejects(x.turn(run,'planner2'),{code:'DISPATCH_RESULT_FENCED'});assert.equal(x.h.store.records(x.p.id,'AgentSession').length,0);
});
test('a green Custom run on one harness and one model can never be accepted',async t=>{
 const x=await fixture(t),run=x.create();for(const role of ['planner2','executor','reviewer'])await x.turn(run,role);
 const r=x.h.store.run(run.id);r.state=r.phase='READY_FOR_DELIVERY';r.treeHash=treeHash(r.workspace);
 r.verification={ok:true,exitCode:0,command:[],stdout:'',stderr:'',treeHash:r.treeHash,at:new Date().toISOString(),evidenceId:'evidence_offline'};
 r.review={verdict:'PASS',findings:[],source:'DSH',treeHash:r.treeHash};
 x.h.store.saveRun(r);x.h.store.release(x.p.id,run.id);
 assert.throws(()=>x.h.engine.accept(run.id),{code:'CUSTOM_ROLE_HARNESS_NOT_DIVERSIFIED'});
});
