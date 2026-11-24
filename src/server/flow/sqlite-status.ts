import type {Store} from '../store.js';import type {SqliteDatasets} from '../sqlite-data.js';
import type {SqliteDataView} from '../../shared/sqlite-data.js';import type {EngineDispatch} from './dispatch.js';
import {currentProcessOwnership,processCleanupProven} from './process-ownership.js';import {DomainError} from '../security.js';

// Both variants live only in the original Engine's dataJobs map.
export type ProjectDataJob={controller:AbortController}&(
 {kind:'JSON_RUNTIME';promise:Promise<{hash:string;appliedRevision:number}>;sourceHash:string;planHash:string}|
 {kind:'SQLITE_RUNTIME';promise:Promise<{hash:string;appliedRevision:number}>;sourceHash:string;planHash:string;projectId:string;projectVersion:number;runVersion:number}|
 {kind:'SQLITE_RECOVERY';promise:Promise<SqliteDataView>;operationHash:string;projectId:string;projectVersion:number;runVersion:number}|
 {kind:'SQLITE_READ';promise:Promise<SqliteDataView>;projectId:string;projectVersion:number;runVersion:number;joinRecorded?:boolean}
);
type ReadJob=Extract<ProjectDataJob,{kind:'SQLITE_READ'}>;
export function assertSqliteReadCurrent(store:Store,rid:string,job:Pick<ReadJob,'projectId'|'projectVersion'|'runVersion'>):void{
 const p=store.project(job.projectId),r=store.run(rid);
 if(p.mode!=='live'||r.mode!=='live'||p.activeRunId!==rid||r.projectId!==p.id||p.version!==job.projectVersion||r.version!==job.runVersion)
  throw new DomainError('SQLITE_DATA_READ_CHANGED',409);
 if(store.db.prepare('SELECT 1 FROM workspace_leases WHERE project_id=?').get(p.id))throw new DomainError('SQLITE_DATA_BUSY',409);
}
interface Context {
 store:Store;datasets:SqliteDatasets;dispatch:EngineDispatch;jobs:Map<string,ProjectDataJob>;
 pausing():boolean;activeRunIds():string[];activeJobCount():number;
}
/** A controller operation on the one Engine's queue; no independent scheduler or runtime authority. */
export async function readSqliteStatus(context:Context,pid:string):Promise<SqliteDataView>{
 const {store,datasets,dispatch,jobs}=context;
 if(context.pausing())throw new DomainError('APPLICATION_PAUSING',409);
 const p=store.project(pid);if(p.mode!=='live')throw new DomainError('SQLITE_DATA_LIVE_ONLY',409);
 if(!p.activeRunId)throw new DomainError('SQLITE_DATA_RUN_ANCHOR_REQUIRED',409);
 const r=store.run(p.activeRunId);if(r.projectId!==pid)throw new DomainError('SQLITE_DATA_READ_CHANGED',409);
 const existing=jobs.get(r.id);
 if(existing?.kind==='SQLITE_READ'){
  if(existing.projectId!==pid)throw new DomainError('SQLITE_DATA_READ_CHANGED',409);
  assertSqliteReadCurrent(store,r.id,existing);
  if(existing.controller.signal.aborted)throw new DomainError('SQLITE_DATA_READ_CANCELLED',409);
  if(!existing.joinRecorded){store.record('SqliteDataReadJoined',pid,r.id,{metadataOnly:true,modelCalls:0});existing.joinRecorded=true;}return existing.promise;
 }
 if(context.activeRunIds().some(id=>store.run(id).projectId===pid))throw new DomainError('WORKSPACE_BUSY',409);
 if(context.activeJobCount()>=64)throw new DomainError('GLOBAL_FLOW_QUEUE_FULL',409);
 if(dispatch.snapshot().quarantined.length)throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
 const controller=new AbortController(),binding={projectId:pid,projectVersion:p.version,runVersion:r.version};
 assertSqliteReadCurrent(store,r.id,binding);
 const timer=setTimeout(()=>controller.abort(new DomainError('SQLITE_DATA_READ_TIMEOUT',409)),90000);
 const promise=Promise.resolve().then(async()=>{
  const value=await dispatch.run({projectId:pid,runId:r.id,kind:'data-runtime',mode:r.mode,signal:controller.signal},async control=>{
   try{
    assertSqliteReadCurrent(store,r.id,binding);const owner=currentProcessOwnership();
    if(!owner)throw new DomainError('STORAGE_CUSTODY_OWNERSHIP_REQUIRED',409);
    store.record('SqliteDataReadRequested',pid,r.id,{dispatchId:owner.dispatchId,generation:owner.generation,metadataOnly:true,modelCalls:0});
    return await datasets.readOwned(pid,{signal:controller.signal});
   }finally{const owner=currentProcessOwnership();if(owner&&processCleanupProven(owner))control.confirmCleanup();}
  });
  if(controller.signal.aborted||context.pausing())throw new DomainError('SQLITE_DATA_READ_CANCELLED',409);
  assertSqliteReadCurrent(store,r.id,binding);
  store.record('SqliteDataReadCompleted',pid,r.id,{revision:value.revision,imageHash:value.imageHash,contentHash:value.contentHash,metadataOnly:true,modelCalls:0});return value;
 }).finally(()=>{clearTimeout(timer);jobs.delete(r.id);});
 jobs.set(r.id,{kind:'SQLITE_READ',controller,promise,...binding});return promise;
}
