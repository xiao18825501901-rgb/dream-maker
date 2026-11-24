import type {Store} from '../store.js';
import type {SqliteDatasets} from '../sqlite-data.js';
import type {SqliteDataRecoveryPlan,SqliteDataView} from '../../shared/sqlite-data.js';
import type {EngineDispatch} from './dispatch.js';
import type {ProjectDataJob} from './sqlite-status.js';
import {assertSqliteReadCurrent} from './sqlite-status.js';
import {currentProcessOwnership,processCleanupProven} from './process-ownership.js';
import {DomainError} from '../security.js';

export type SqliteRecoveryJob=Extract<ProjectDataJob,{kind:'SQLITE_RECOVERY'}>;
export type SqliteRecoveryBinding=Pick<SqliteRecoveryJob,'projectId'|'projectVersion'|'runVersion'|'operationHash'>;
interface Context {
 store:Store;datasets:SqliteDatasets;dispatch:EngineDispatch;jobs:Map<string,ProjectDataJob>;
 pausing():boolean;activeRunIds():string[];activeJobCount():number;
 assertCurrent(rid:string,binding:SqliteRecoveryBinding):void;
}

function activeRun(context:Context,pid:string){
 const p=context.store.project(pid);
 if(p.mode!=='live')throw new DomainError('SQLITE_DATA_LIVE_ONLY',409);
 if(!p.activeRunId)throw new DomainError('SQLITE_DATA_RUN_ANCHOR_REQUIRED',409);
 const run=context.store.run(p.activeRunId);
 if(run.projectId!==pid||run.mode!=='live')throw new DomainError('SQLITE_DATA_RECOVERY_CHANGED',409);
 return {project:p,run};
}

function assertAvailable(context:Context,pid:string){
 if(context.pausing())throw new DomainError('APPLICATION_PAUSING',409);
 if(context.activeRunIds().some(id=>context.store.run(id).projectId===pid))throw new DomainError('WORKSPACE_BUSY',409);
 if(context.activeJobCount()>=64)throw new DomainError('GLOBAL_FLOW_QUEUE_FULL',409);
 if(context.dispatch.snapshot().quarantined.length)throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
}

/** Read-only metadata. Exact image bytes are checked only by the confirmed Engine job. */
export function readSqliteRecoveryPlan(context:Context,pid:string):SqliteDataRecoveryPlan{
 if(context.pausing())throw new DomainError('APPLICATION_PAUSING',409);
 const {project:p,run}=activeRun(context,pid);
 assertSqliteReadCurrent(context.store,run.id,{projectId:p.id,projectVersion:p.version,runVersion:run.version});
 assertAvailable(context,pid);
 return context.datasets.recovery(pid);
}

/** One Engine data job. It commits an already-durable exact image only; it never reruns work. */
export async function executeSqliteRecovery(
 context:Context,pid:string,operationHash:string,confirmed:boolean,operation:string,actor:string
):Promise<SqliteDataView>{
 const {store,datasets,dispatch,jobs}=context;
 if(context.pausing())throw new DomainError('APPLICATION_PAUSING',409);
 if(confirmed!==true)throw new DomainError('SQLITE_DATA_RECOVERY_CONSENT_REQUIRED',403);
 if(!/^[a-f0-9]{64}$/.test(operationHash)||!/^[a-f0-9]{64}$/.test(operation)||!/^local-session:[a-f0-9]{64}$/.test(actor))
  throw new DomainError('SQLITE_DATA_RECOVERY_INPUT_INVALID',400);
 const {project:p,run}=activeRun(context,pid);
 const binding:SqliteRecoveryBinding={projectId:p.id,projectVersion:p.version,runVersion:run.version,operationHash};
 context.assertCurrent(run.id,binding);
 const alreadyCommitted=store.db.prepare(
  'SELECT 1 FROM managed_dataset_operations WHERE operation_hash=? AND project_id=? LIMIT 1'
 ).get(operationHash,pid);
 const candidate=datasets.recovery(pid).candidates.find(value=>value.operationHash===operationHash);
 if(!alreadyCommitted&&!candidate)throw new DomainError('SQLITE_DATA_INTENT_NOT_FOUND',409);
 if(!alreadyCommitted&&!candidate!.recoverable)throw new DomainError(candidate!.blockedReason??'SQLITE_DATA_INTENT_BINDING_REQUIRED',409);
 const existing=jobs.get(run.id);
 if(existing){
  if(existing.kind==='SQLITE_RECOVERY'&&existing.operationHash===operationHash&&!existing.controller.signal.aborted){
   assertSqliteReadCurrent(store,run.id,existing);
   return existing.promise;
  }
  throw new DomainError('WORKSPACE_BUSY',409);
 }
 assertAvailable(context,pid);
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(new DomainError('SQLITE_DATA_RECOVERY_TIMEOUT',409)),90000);
 const promise=Promise.resolve().then(async()=>{
  const value=await dispatch.run({projectId:pid,runId:run.id,kind:'data-runtime',mode:run.mode,signal:controller.signal},async control=>{
   try{
    context.assertCurrent(run.id,binding);
    const owner=currentProcessOwnership();
    if(!owner)throw new DomainError('STORAGE_CUSTODY_OWNERSHIP_REQUIRED',409);
    store.record('SqliteDataRecoveryRequested',pid,run.id,{
     operationHash,requestOperation:operation,dispatchId:owner.dispatchId,generation:owner.generation,
     modelCalls:0,generatedWorkRerun:false,guestWorkRerun:false
    });
    const recovered=await datasets.recoverOwned(operationHash,actor,{
     signal:controller.signal,
     assertCurrent:()=>context.assertCurrent(run.id,binding)
    });
    if(controller.signal.aborted||context.pausing())throw new DomainError('SQLITE_DATA_RECOVERY_CANCELLED',409);
    if(!processCleanupProven(owner))throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);
    context.assertCurrent(run.id,binding);
    store.record('SqliteDataRecoveryCompleted',pid,run.id,{
     operationHash,requestOperation:operation,revision:recovered.revision,replayed:recovered.operation?.replayed===true,
     modelCalls:0,generatedWorkRerun:false,guestWorkRerun:false
    });
    return recovered;
   }finally{
    const owner=currentProcessOwnership();
    if(owner&&processCleanupProven(owner))control.confirmCleanup();
   }
  });
  return value;
 }).finally(()=>{clearTimeout(timer);if(jobs.get(run.id)?.kind==='SQLITE_RECOVERY')jobs.delete(run.id);});
 jobs.set(run.id,{kind:'SQLITE_RECOVERY',controller,promise,...binding});
 return promise;
}
