// OFFLINE original Store/Dispatch and ledger integration. No Native qualification.
import test from 'node:test';import assert from 'node:assert/strict';import {resolve} from 'node:path';
import {harness,ready} from '../helpers.mjs';
import fs from 'node:fs';import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {EngineDispatch} from '../../dist/server/flow/dispatch.js';import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import * as context from '../../dist/server/flow/custom-budget.js';
import {hash} from '../../dist/server/security.js';
import {NativeBudget} from '../../dist/server/native-budget.js';
const actor='local-session:'+'a'.repeat(64);
function configuration(){const role=(id,write=false)=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});return{mode:'custom',laya:false,accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'}],roles:{planner2:role('planner2'),executors:[role('worker-one',true),role('worker-two',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};}
export async function customBudgetSupplementFixture(t,role='executor',supplied){
 const h=supplied??harness(t),{p,s}=await ready(h),profile=new FlowProfiles(h.store).confirm(p.id,{configuration:configuration(),expectedRevision:0,confirmed:true},actor,'OFFLINE_CAP_PROFILE');
 const prepared=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);h.engine.launch=()=>{};const classic=h.engine.create(p.id,s.hash,true);h.store.release(p.id,classic.id);
 const run=structuredClone(classic);Object.assign(run,{id:prepared.flowConfig.runId,mode:'live',flowName:'custom',rolePolicy:'CUSTOM_FROZEN_V1',flowConfig:prepared.flowConfig,flowConfigHash:prepared.flowConfigHash,configFingerprint:prepared.flowConfig.configurationFingerprint,workspace:resolve(h.dir,'workspaces',prepared.flowConfig.runId),state:role==='executor'?'IMPLEMENTING':role==='planner2'?'PLANNING':'REVIEWING',phase:role==='executor'?'IMPLEMENTING':role==='planner2'?'PLANNING':'REVIEWING'});
 h.engine.nativeExecution={assertCustomReady(){},custom(){throw Error('OFFLINE_NO_MODEL');},verify(){throw Error('OFFLINE_NO_VERIFIER');},close:async()=>{}};
 run.tasks=[{id:'T1',title:'OFFLINE',dependsOn:[],requirementIds:[],acceptance:['OFFLINE'],status:'running'}];fs.mkdirSync(run.workspace,{recursive:true});h.store.insertRun(run);h.store.acquire(p.id,run.id);const project=h.store.project(p.id);project.mode='live';project.activeRunId=run.id;h.store.saveProject(project);
 const dispatcher=new EngineDispatch(h.store,{measure:()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:9216,sampledAt:new Date().toISOString()}),isCurrent:()=>true});t.after(()=>dispatcher.close());
 const binding=()=>{const owned=currentProcessOwnership();return{schema:'dream-maker.native-request-binding.v1',projectId:p.id,runId:run.id,engineeringMode:'custom',configurationHash:run.flowConfigHash,planVersionHash:run.planVersionHash,specHash:run.specHash,dispatchId:owned?.dispatchId??'offline_dispatch',generation:owned?.generation??'offline_generation',role,roleId:role==='executor'?'worker-one':role,work:role==='executor'?{kind:'TASK',taskIdHash:hash('T1'),executorSliceId:null}:{kind:'SUPERVISION'},bodyHash:'e'.repeat(64),routeHash:'f'.repeat(64)};};
 const dispatch=action=>dispatcher.run({projectId:p.id,runId:run.id,kind:role,mode:'live',...(role==='executor'?{executorRoleId:'worker-one'}:{}),signal:new AbortController().signal},async control=>{try{return await action();}finally{control.confirmCleanup();}});
 return{h,run,actor,binding,dispatch,read:b=>context.customFlowRequestBudget(h.store,h.config,b)};
}
