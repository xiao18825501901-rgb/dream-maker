import type {Store} from '../store.js';import type {SqliteDatasets} from '../sqlite-data.js';
import type {SqliteDataView} from '../../shared/sqlite-data.js';import type {Run} from '../../shared/types.js';
import type {EngineDispatch} from './dispatch.js';import type {ProjectDataJob} from './sqlite-status.js';
import type {NativeExecutionFactory} from '../engine.js';import type {SandboxCommand} from '../wsl-sandbox.js';
import type {SqliteChannelBinding} from '../sqlite-channel.js';
import {DomainError,hash,object} from '../security.js';import {validateSqliteRuntimePlan,prepareSqliteRuntimeCommand} from '../data-runtime-plan.js';
import {currentProcessOwnership,processCleanupProven} from './process-ownership.js';
import {withSqliteRetirementPermit} from '../sqlite-retirement.js';import {dirname} from 'node:path';
export type SqliteRuntimeJob=Extract<ProjectDataJob,{kind:'SQLITE_RUNTIME'}>;
export type SqliteRuntimeBinding=Pick<SqliteRuntimeJob,'projectId'|'projectVersion'|'runVersion'|'sourceHash'|'planHash'>;
export interface NativeSqliteDataInput {runId:string;specHash:string;sourceHash:string;planHash:string;command:SandboxCommand;image:Buffer|null;binding:SqliteChannelBinding;signal:AbortSignal}
interface Context {
 store:Store;root:string;datasets:SqliteDatasets;dispatch:EngineDispatch;jobs:Map<string,ProjectDataJob>;
 pausing():boolean;activeRunIds():string[];activeJobCount():number;native():NativeExecutionFactory;
 assertCurrent(rid:string,binding:SqliteRuntimeBinding):void;assertReady(run:Run):void;read(pid:string):Promise<SqliteDataView>;
}
/** One original Engine data job. Durable request metadata never contains image bytes or runtime output. */
export async function executeSqliteRuntime(c:Context,rid:string,sourceHash:string,revision:number,confirmed:boolean,operation:string,actor:string):Promise<SqliteDataView>{
 const {store,datasets,dispatch,jobs}=c;
 if(c.pausing())throw new DomainError('APPLICATION_PAUSING',409);
 if(confirmed!==true)throw new DomainError('SQLITE_DATA_CONSENT_REQUIRED',403);
 if(!Number.isSafeInteger(revision)||revision<0||!/^[a-f0-9]{64}$/.test(operation)||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('SQLITE_DATA_INPUT_INVALID',400);
 const run=store.run(rid),p=store.project(run.projectId);
 const plan=validateSqliteRuntimePlan(object(run.plan).dataRuntime),planHash=hash(plan),binding={projectId:p.id,projectVersion:p.version,runVersion:run.version,sourceHash,planHash};
 c.assertCurrent(rid,binding);
 const request={runId:rid,projectId:p.id,specHash:run.specHash,sourceHash,planHash,revision,actor},key='sqlite-runtime:'+operation;
 const view=async(receipt:{hash:string;appliedRevision:number},replayed:boolean)=>{c.assertCurrent(rid,binding);const value=await c.read(p.id);c.assertCurrent(rid,binding);return {...value,operation:{...receipt,replayed}};};
 if(store.db.prepare('SELECT 1 FROM requests WHERE key=?').get(key))return view(await store.once(key,request,async()=>{throw new DomainError('REQUEST_RESULT_UNCERTAIN',409);}),true);
 if(c.activeRunIds().some(id=>store.run(id).projectId===p.id))throw new DomainError('WORKSPACE_BUSY',409);
 if(c.activeJobCount()>=64)throw new DomainError('GLOBAL_FLOW_QUEUE_FULL',409);
 if(dispatch.snapshot().quarantined.length)throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
 const controller=new AbortController();
 await datasets.assertStorageReady(controller.signal);
 const native=c.native();if(!native.runSqliteData)throw new DomainError('SQLITE_DATA_RUNTIME_UNAVAILABLE',409);c.assertReady(run);
 const promise=Promise.resolve().then(()=>store.once(key,request,async()=>{
  return dispatch.run({projectId:p.id,runId:rid,kind:'data-runtime',mode:run.mode,dataFormat:'SQLITE_IMAGE_V1',signal:controller.signal},async control=>{
   const timer=setTimeout(()=>controller.abort(new DomainError('SQLITE_DATA_RUNTIME_TIMEOUT',409)),90000);
   const current=()=>{if(controller.signal.aborted||c.pausing())throw new DomainError('SQLITE_DATA_RUNTIME_CANCELLED',409);c.assertCurrent(rid,binding);};
   try{
    current();c.assertReady(store.run(rid));
    const capture=await datasets.captureOwned(rid,sourceHash,revision,planHash,{signal:controller.signal});current();
    const owner=currentProcessOwnership()!;
    store.record('SqliteDataRuntimeRequested',p.id,rid,{operationHash:operation,...request,dispatchId:owner.dispatchId,generation:owner.generation,inputHash:capture.binding.inputHash,modelCalls:0});
    const command=prepareSqliteRuntimeCommand(plan,capture.binding);
    const exchange=await native.runSqliteData!({runId:rid,specHash:run.specHash,sourceHash,planHash,command,image:capture.image,binding:capture.binding,signal:controller.signal});
    current();if(!processCleanupProven(owner))throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);
    const saved=await datasets.publishOwned(capture,exchange,operation,actor,{signal:controller.signal,assertCurrent:current});current();
    store.record('SqliteDataRuntimeRetained',p.id,rid,{operationHash:operation,jobId:exchange.result.jobId,resultHash:hash(exchange.result),manifestHash:object(object(object(exchange.result).sqlite).retention).manifestHash,state:'RETAINED',guestRemoved:false,modelCalls:0});
    if(native.sqliteRetirementEnabled===true&&native.retireSqliteData){
     try{
      await withSqliteRetirementPermit(store,c.root,dirname(store.path),rid,operation,async(permit,signal)=>{
       current();const receipt=await native.retireSqliteData!({permit,signal});
       if(receipt.schema!=='dream-maker.sqlite-retirement-receipt.v1'||receipt.jobId!==exchange.result.jobId||receipt.authorityHash!==permit.authorityHash||receipt.retired!==true||receipt.reservationReleased!==true||receipt.cleanupReturned!==true||!/^retire_attempt_[a-f0-9]{32}$/.test(receipt.attemptId)||!/^[a-f0-9]{64}$/.test(receipt.outcomeHash))throw new DomainError('SQLITE_RETIREMENT_RESULT_UNCERTAIN',409);
       store.record('SqliteDataRuntimeRetired',p.id,rid,{operationHash:operation,...receipt,state:'RETIRED',guestRemoved:false,modelCalls:0});
      },{signal:controller.signal});
      current();if(!processCleanupProven(owner))throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);
     }catch(error){store.record('SqliteDataRetirementUncertain',p.id,rid,{operationHash:operation,jobId:exchange.result.jobId,committedRevision:saved.operation!.appliedRevision,reason:error instanceof DomainError?error.code:'SQLITE_RETIREMENT_RESULT_UNCERTAIN',generatedOperationMustNotRerun:true,modelCalls:0});throw error;}
    }
    return {hash:operation,appliedRevision:saved.operation!.appliedRevision};
   }finally{clearTimeout(timer);const owner=currentProcessOwnership();if(owner&&processCleanupProven(owner))control.confirmCleanup();}
  });
 })).finally(()=>jobs.delete(rid));
 jobs.set(rid,{kind:'SQLITE_RUNTIME',controller,promise,...binding});return view(await promise,false);
}
