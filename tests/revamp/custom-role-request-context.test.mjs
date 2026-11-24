// OFFLINE original Store + actual EngineDispatch, synthetic run fixture. No Native qualification.
import test from 'node:test';import assert from 'node:assert/strict';import {resolve} from 'node:path';
import {harness,ready} from '../helpers.mjs';import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {EngineDispatch} from '../../dist/server/flow/dispatch.js';import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import {magpieRouteHash} from '../../dist/server/magpie-route.js';import {hash} from '../../dist/server/security.js';
import * as context from '../../dist/server/flow/native-request-context.js';
const actor='local-session:'+'a'.repeat(64);
const refuses=fn=>assert.throws(fn,{code:'NATIVE_REQUEST_BINDING_STALE'});
async function fixture(t,role='planner2',{group=false,labels=false,selectedMember=null}={}){
 const h=harness(t),{p,s}=await ready(h),a={provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'},a2={...a,authRef:'OFFLINE_AUTH_2',accountRef:'OFFLINE_ACCOUNT_2'};
 const item=(id,write=false)=>({id,...a,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}}),configuration={mode:'custom',laya:false,accounts:[a,...(group?[a2]:[])],roles:{planner2:item('planner2'),executors:[item('worker-one',true),item('worker-two',true)],reviewer:item('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:labels?['PRIVATE']:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 if(group){configuration.roles.reviewer.model={kind:'group',id:'review-pool'};if(selectedMember)configuration.roles.reviewer.selectedMemberId=selectedMember;configuration.groups=[{id:'review-pool',strategy:'failure_only',members:[{id:'first',provider:a.provider,model:'deepseek-flash',authRef:a.authRef,accountRef:a.accountRef,permissions:['source_read']},{id:'second',provider:a2.provider,model:'deepseek-flash',authRef:a2.authRef,accountRef:a2.accountRef,permissions:['source_read']}]}];}
 const profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_ROLE_REQUEST'),prepared=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);h.engine.launch=()=>{};const classic=h.engine.create(p.id,s.hash,true);h.store.release(p.id,classic.id);
 const phase=role==='planner2'?'PLANNING':role==='reviewer'?'REVIEWING':'IMPLEMENTING',run={...structuredClone(classic),id:prepared.flowConfig.runId,mode:'live',flowName:'custom',rolePolicy:'CUSTOM_FROZEN_V1',flowConfig:prepared.flowConfig,flowConfigHash:prepared.flowConfigHash,configFingerprint:prepared.flowConfig.configurationFingerprint,workspace:resolve(h.dir,'workspaces',prepared.flowConfig.runId),state:phase,phase,tasks:[{id:'中文任务',title:'OFFLINE',dependsOn:[],requirementIds:[],acceptance:['OFFLINE'],status:'running'}]};
 h.store.insertRun(run);h.store.acquire(p.id,run.id);const project=h.store.project(p.id);project.mode='live';project.activeRunId=run.id;h.store.saveProject(project);
 const input={role,workspace:run.workspace,model:'deepseek-flash',runId:run.id,specHash:run.specHash,prompt:'OFFLINE_CONTROL_PACKET',laya:{mode:'off',adoption:'off'},signal:new AbortController().signal,...(role==='executor'?{taskId:'中文任务',executorRoleId:'worker-one'}:{})},route={runtime:'dsh',provider:a.provider,protocol:'anthropic-messages',model:'deepseek-flash',authentication:'api_key',authRef:a.authRef,accountRef:a.accountRef,upstreamAccountRef:'deepseek-official/0123456789'};
 const dispatcher=new EngineDispatch(h.store,{measure:()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:9216,sampledAt:new Date().toISOString()}),isCurrent:()=>true});t.after(()=>dispatcher.close());
 const bind=(change={},selected=route,owner=currentProcessOwnership())=>context.customModelRequestBinding(h.store,h.config,{...input,...change},owner,selected,'e'.repeat(64));
 const dispatch=fn=>dispatcher.run({projectId:p.id,runId:run.id,kind:role,mode:'live',signal:input.signal,...(role==='executor'?{executorRoleId:'worker-one'}:{})},async ctl=>{try{return await fn();}finally{ctl.confirmCleanup();}});
 return{h,p,run,input,route,bind,dispatch,a2};
}
for(const role of ['planner2','executor','reviewer'])test('Custom '+role+' derives attribution from its frozen original Store during actual dispatch',async t=>{
 const x=await fixture(t,role);await x.dispatch(()=>{const b=x.bind();assert.equal(b.role,role);assert.equal(b.roleId,role==='executor'?'worker-one':role);assert.equal(b.work.kind,role==='executor'?'TASK':'SUPERVISION');assert.equal(b.routeHash,magpieRouteHash(x.route));assert.equal(b.configurationHash,x.run.flowConfigHash);assert.equal(b.bodyHash,'e'.repeat(64));assert.equal(b.dispatchId,currentProcessOwnership().dispatchId);assert.doesNotMatch(JSON.stringify(b),/OFFLINE_AUTH|OFFLINE_ACCOUNT|workspace/);});assert.equal(x.h.store.records(x.p.id,'NativeProbeReceipt').length,0);assert.equal(x.h.store.run(x.run.id).flowConfig.qualification,'NOT_VERIFIED');
});
test('Custom role binding rejects foreign role, workspace, account, model and runtime before a hold',async t=>{
 const x=await fixture(t);await x.dispatch(()=>{
  for(const change of [{role:'reviewer'},{workspace:resolve(x.h.dir,'other')},{model:'other-model'},{taskId:'中文任务'},{executorRoleId:'worker-two'}])refuses(()=>x.bind(change));
  for(const change of [{accountRef:'FOREIGN'},{authRef:'FOREIGN'},{runtime:'codex-app-server'},{provider:'other-provider'},{model:'other-model'},{authentication:'oauth'}])refuses(()=>x.bind({},{...x.route,...change}));
 });
});
test('Custom binding refuses outside/settled dispatch, cancellation, pause, lease loss and configuration drift',async t=>{
 const x=await fixture(t);refuses(()=>x.bind());let ownership;await x.dispatch(()=>{
  ownership=currentProcessOwnership();refuses(()=>x.bind({},x.route,{...ownership,generation:'FOREIGN'}));const cancel=new AbortController();cancel.abort();refuses(()=>x.bind({signal:cancel.signal}));
  const r=x.h.store.run(x.run.id);r.state='PAUSE_REQUESTED';x.h.store.saveRun(r);refuses(()=>x.bind());r.state=r.phase;x.h.store.saveRun(r);
  x.h.config.limits.maxCalls++;refuses(()=>x.bind());x.h.config.limits.maxCalls--;x.h.store.release(x.p.id,x.run.id);refuses(()=>x.bind());x.h.store.acquire(x.p.id,x.run.id);
 });refuses(()=>x.bind({},x.route,ownership));
});
test('Custom model groups accept only their explicitly frozen initial member and do not choose or retry it',async t=>{
 const x=await fixture(t,'reviewer',{group:true,selectedMember:'second'}),other={...x.route,authRef:x.a2.authRef,accountRef:x.a2.accountRef,upstreamAccountRef:'deepseek-official/9876543210'};
 await x.dispatch(()=>{assert.equal(x.bind({},other).roleId,'reviewer');refuses(()=>x.bind());refuses(()=>x.bind({}, {...other,authRef:'UNKNOWN_MEMBER'}));});
});
test('Custom prohibited data labels cannot be skipped by the unclassified runtime path',async t=>{const x=await fixture(t,'reviewer',{labels:true});await x.dispatch(()=>refuses(()=>x.bind()));});
