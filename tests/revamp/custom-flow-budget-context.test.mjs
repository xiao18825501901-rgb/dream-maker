// OFFLINE original Store/Dispatch and ledger integration. No Native qualification.
import test from 'node:test';import assert from 'node:assert/strict';import {resolve} from 'node:path';
import {harness,ready} from '../helpers.mjs';import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {EngineDispatch} from '../../dist/server/flow/dispatch.js';import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import * as context from '../../dist/server/flow/custom-budget.js';
import {hash} from '../../dist/server/security.js';
import {NativeBudget} from '../../dist/server/native-budget.js';
const actor='local-session:'+'a'.repeat(64);
function configuration(){const role=(id,write=false)=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});return{mode:'custom',laya:false,accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'}],roles:{planner2:role('planner2'),executors:[role('worker-one',true),role('worker-two',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};}
async function setup(t,role='executor'){
 const h=harness(t),{p,s}=await ready(h),profile=new FlowProfiles(h.store).confirm(p.id,{configuration:configuration(),expectedRevision:0,confirmed:true},actor,'OFFLINE_CAP_PROFILE');
 const prepared=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);h.engine.launch=()=>{};const classic=h.engine.create(p.id,s.hash,true);h.store.release(p.id,classic.id);
 const run=structuredClone(classic);Object.assign(run,{id:prepared.flowConfig.runId,mode:'live',flowName:'custom',rolePolicy:'CUSTOM_FROZEN_V1',flowConfig:prepared.flowConfig,flowConfigHash:prepared.flowConfigHash,configFingerprint:prepared.flowConfig.configurationFingerprint,workspace:resolve(h.dir,'workspaces',prepared.flowConfig.runId),state:role==='executor'?'IMPLEMENTING':role==='planner2'?'PLANNING':'REVIEWING',phase:role==='executor'?'IMPLEMENTING':role==='planner2'?'PLANNING':'REVIEWING'});
 run.tasks=[{id:'T1',title:'OFFLINE',dependsOn:[],requirementIds:[],acceptance:['OFFLINE'],status:'running'}];h.store.insertRun(run);h.store.acquire(p.id,run.id);const project=h.store.project(p.id);project.mode='live';project.activeRunId=run.id;h.store.saveProject(project);
 const dispatcher=new EngineDispatch(h.store,{measure:()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:9216,sampledAt:new Date().toISOString()}),isCurrent:()=>true});t.after(()=>dispatcher.close());
 const binding=()=>{const owned=currentProcessOwnership();return{schema:'dream-maker.native-request-binding.v1',projectId:p.id,runId:run.id,engineeringMode:'custom',configurationHash:run.flowConfigHash,planVersionHash:run.planVersionHash,specHash:run.specHash,dispatchId:owned?.dispatchId??'offline_dispatch',generation:owned?.generation??'offline_generation',role,roleId:role==='executor'?'worker-one':role,work:role==='executor'?{kind:'TASK',taskIdHash:hash('T1'),executorSliceId:null}:{kind:'SUPERVISION'},bodyHash:'e'.repeat(64),routeHash:'f'.repeat(64)};};
 const dispatch=action=>dispatcher.run({projectId:p.id,runId:run.id,kind:role,mode:'live',...(role==='executor'?{executorRoleId:'worker-one'}:{}),signal:new AbortController().signal},async control=>{try{return await action();}finally{control.confirmCleanup();}});
 return{h,run,binding,dispatch,read:b=>context.customFlowRequestBudget(h.store,h.config,b)};
}
for(const role of ['planner2','executor','reviewer'])test('the original frozen Store provides only the selected '+role+' caps during its actual dispatch',async t=>{
 const x=await setup(t,role);await x.dispatch(()=>{const b=x.binding(),value=x.read(b),selected=role==='executor'?x.run.flowConfig.roles.executors[0]:x.run.flowConfig.roles[role];assert.deepEqual(value.flow,x.run.flowConfig.budget);assert.deepEqual(value.role,selected.budget);assert.equal(value.roleId,b.roleId);assert.equal(value.configurationHash,x.run.flowConfigHash);assert.equal('authRef' in value,false);value.role.maxMicros=0;assert.equal(x.read(b).role.maxMicros,1000000);});
});
test('completed, cross-actor, cross-config and cross-generation contexts cannot create another request',async t=>{
 const x=await setup(t);let old;await x.dispatch(()=>{old=x.binding();for(const change of [{roleId:'unknown-worker'},{roleId:'worker-two'},{configurationHash:'0'.repeat(64)},{generation:'different_owner'},{planVersionHash:'0'.repeat(64)}])assert.throws(()=>x.read({...old,...change}),{code:'CUSTOM_BUDGET_CONTEXT_STALE'});});assert.throws(()=>x.read(old),{code:'CUSTOM_BUDGET_CONTEXT_STALE'});
});
test('pause, settings drift and lease loss invalidate the budget source',async t=>{
 const x=await setup(t);await x.dispatch(()=>{const b=x.binding(),run=x.h.store.run(x.run.id);run.state='PAUSE_REQUESTED';x.h.store.saveRun(run);assert.throws(()=>x.read(b),{code:'CUSTOM_BUDGET_CONTEXT_STALE'});run.state=run.phase;x.h.store.saveRun(run);x.h.config.limits.maxCalls++;assert.throws(()=>x.read(b),{code:'CUSTOM_BUDGET_CONTEXT_STALE'});x.h.config.limits.maxCalls--;x.h.store.release(run.projectId,run.id);assert.throws(()=>x.read(b),{code:'CUSTOM_BUDGET_CONTEXT_STALE'});});
});
test('the original ledger reserves from actual Store caps and a stale dispatch cannot append a hold',async t=>{
 let budget;t.after(()=>budget?.close());const x=await setup(t);
 const authority={scopeId:'OFFLINE_STORE_CAPS',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
 budget=new NativeBudget(resolve(x.h.dir,'store-caps.sqlite'),authority,undefined,undefined,'FULL_DM',x.read,()=>{});
 const price={provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_NOT_QUOTE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:100,inputMissMicrosPerMillion:1000000,inputHitMicrosPerMillion:0,outputMicrosPerMillion:1000000};let prior;
 await x.dispatch(()=>{prior=x.binding();const row=budget.reserve('executor',price,100,undefined,prior);assert.equal(row.reservedMicros,200);assert.deepEqual(row.customBudget,x.read(prior));budget.settle(row.id,null,'OFFLINE_FAILED');});
 assert.throws(()=>budget.reserve('executor',price,100,undefined,prior),{code:'CUSTOM_BUDGET_CONTEXT_STALE'});assert.equal(budget.requests().length,1);
});
test('an actual repair dispatch cannot borrow a second configured executor cap',async t=>{
 const x=await setup(t),run=x.h.store.run(x.run.id);run.state=run.phase='REPAIRING';run.repairCount=1;run.reason='OFFLINE_VERIFICATION';x.h.store.saveRun(run);
 await x.dispatch(()=>{const b={...x.binding(),work:{kind:'REPAIR',round:1,inputHash:hash({round:run.repairCount,attempt:run.attempt,reason:run.reason,findings:run.findings,failedFingerprints:run.failedFingerprints,verification:run.verification,review:run.review})}};
  assert.equal(x.read(b).roleId,'worker-one');assert.throws(()=>x.read({...b,roleId:'worker-two'}),{code:'CUSTOM_BUDGET_CONTEXT_STALE'});
 });
});
