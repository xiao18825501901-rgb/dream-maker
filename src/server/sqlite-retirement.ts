import {resolve,dirname} from 'node:path';
import type {Store} from './store.js';import {decodeSqliteVersion} from './sqlite-data.js';
import {DomainError,hash,object} from './security.js';import {SQLITE_DATA_KIND} from '../shared/sqlite-data.js';
import {withWindowsStorageCustody} from './windows-storage-custody.js';
import {currentProcessOwnership,processCleanupProven,type ProcessOwnershipScope} from './flow/process-ownership.js';
export interface SqliteRetirementBasis {
 schema:'dream-maker.sqlite-retirement-basis.v1';projectId:string;runId:string;specHash:string;operationHash:string;revision:number;versionHash:string;
 jobId:string;sourceHash:string;inputHash:string;resultHash:string;manifestHash:string;workerHash:string;resourceHelperHash:string;resourceFinalHash:string;
 imageHash:string;imageBytes:number;parentOperationHash:string|null;parentImageHash:string|null;parentImageBytes:number;
 committedRecordId:string;requestedRecordId:string;closedRecordId:string;cleanupRecordId:string;grantRecordId:string;originalDispatchId:string;authorityHash:string;
}
export interface SqliteRetirementPermit {readonly schema:'dream-maker.sqlite-retirement-permit.v1';readonly authorityHash:string}
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function fail(code='SQLITE_RETIREMENT_EVIDENCE_REQUIRED'):never{throw new DomainError(code,409);}
/** Metadata only. Neither an HTTP-provided receipt nor the current head can grant cleanup. */
export function sqliteRetirementBasis(store:Store,rid:string,operation:string):SqliteRetirementBasis{
 try{
  if(!sha(operation))fail();const run=store.run(rid),p=store.project(run.projectId);if(run.mode!=='live'||p.mode!=='live')fail();
  const op=store.db.prepare('SELECT * FROM managed_dataset_operations WHERE operation_hash=?').get(operation);
  if(!op||op.project_id!==p.id||op.kind!==SQLITE_DATA_KIND)fail();
  const row=store.db.prepare('SELECT * FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(p.id,SQLITE_DATA_KIND,op.applied_revision);if(!row)fail();
  const version=decodeSqliteVersion(row);if(version.sourceRunId!==rid||version.image.operationHash!==operation)fail();
  const one=(kind:string,field:string,value:string)=>{
   if(!['operationHash','jobId','dispatchId','processId'].includes(field))fail();
   const rows=store.db.prepare("SELECT id,rowid sequence,data FROM records WHERE project_id=? AND run_id=? AND kind=? AND json_extract(data,'$."+field+"')=? ORDER BY rowid LIMIT 2").all(p.id,rid,kind,value);
   if(rows.length!==1)fail();return {id:String(rows[0].id),sequence:Number(rows[0].sequence),data:object(JSON.parse(String(rows[0].data)))};
  };
  const committed=one('SqliteDataRuntimeCommitted','operationHash',operation),c=committed.data,requested=one('SqliteDataRuntimeRequested','operationHash',operation),q=requested.data;
  if(c.sourceHash!==version.sourceTreeHash||c.revision!==version.revision||c.imageHash!==version.image.imageHash||c.imageBytes!==version.image.imageBytes||!sha(c.inputHash)||!sha(c.resultHash)||typeof c.jobId!=='string'||!/^wsl_job_[a-z0-9_-]{1,80}$/.test(c.jobId))fail();
  if(q.runId!==rid||q.projectId!==p.id||q.specHash!==run.specHash||q.sourceHash!==version.sourceTreeHash||q.revision!==version.revision-1||q.actor!==version.actor||q.inputHash!==c.inputHash||!sha(q.planHash)||typeof q.dispatchId!=='string'||typeof q.generation!=='string')fail();
  let parent=null;if(version.parentRevision!==null){const prior=store.db.prepare('SELECT * FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(p.id,SQLITE_DATA_KIND,version.parentRevision);if(!prior)fail();parent=decodeSqliteVersion(prior);if(parent.contentHash!==version.parentHash)fail();}
  const inputHash=hash({schema:'dream-maker.sqlite-runtime-input.v1',kind:SQLITE_DATA_KIND,projectId:p.id,runId:rid,specHash:run.specHash,sourceHash:version.sourceTreeHash,planHash:q.planHash,revision:q.revision,contentHash:parent?.contentHash??null,imageHash:parent?.image.imageHash??null,imageBytes:parent?.image.imageBytes??0});
  if(inputHash!==c.inputHash)fail();const publicationHash=hash({inputHash,planHash:q.planHash,actor:version.actor,imageHash:version.image.imageHash,imageBytes:version.image.imageBytes,resultHash:c.resultHash});
  const intent=store.db.prepare('SELECT * FROM business_image_intents WHERE operation_hash=?').get(operation);
  if(!intent||intent.project_id!==p.id||intent.source_run_id!==rid||intent.source_tree_hash!==version.sourceTreeHash||intent.expected_revision!==q.revision||intent.actor!==version.actor||intent.image_hash!==version.image.imageHash||intent.image_bytes!==version.image.imageBytes||intent.input_hash!==publicationHash||op.input_hash!==publicationHash)fail();
  const request={runId:rid,projectId:p.id,specHash:run.specHash,sourceHash:version.sourceTreeHash,planHash:q.planHash,revision:q.revision,actor:version.actor},cache=store.db.prepare('SELECT * FROM requests WHERE key=?').get('sqlite-runtime:'+operation);if(!cache||cache.request_hash!==hash(request))fail();
  const grant=one('DispatchGranted','dispatchId',q.dispatchId),closed=one('OwnedWslSandboxClosed','jobId',c.jobId),d=closed.data,original=one('OwnedWslSandboxIntent','jobId',c.jobId),i=original.data;
  if(grant.data.generation!==q.generation||grant.data.mode!=='live'||grant.data.kind!=='data-runtime'||d.dispatchId!==q.dispatchId||d.generation!==q.generation||d.sourceHash!==version.sourceTreeHash||d.resultSha256!==c.resultHash||!sha(d.workerHash)||!sha(d.resourceHelperHash)||!sha(d.resourceFinalHash)||i.dispatchId!==q.dispatchId||i.generation!==q.generation||i.sourceHash!==d.sourceHash||i.workerHash!==d.workerHash||i.resourceHelperHash!==d.resourceHelperHash||typeof i.processId!=='string')fail();
  const cleaned=object(d.cleanup);if(!Array.isArray(cleaned.remainingPids)||cleaned.remainingPids.length||!['groupRemoved','delegationRestored','sourceUnchanged'].every(k=>cleaned[k]===true))fail();
  const cleanup=one('OwnedProcessCleanup','processId',i.processId);if(cleanup.data.dispatchId!==q.dispatchId||cleanup.data.generation!==q.generation||cleanup.data.kind!=='TRUSTED_WSL_SANDBOX'||cleanup.data.scopeId!==c.jobId||cleanup.data.cleanupReturned!==true||!sha(cleanup.data.receiptSha256))fail();
  if(!(grant.sequence<requested.sequence&&requested.sequence<original.sequence&&original.sequence<closed.sequence&&closed.sequence<cleanup.sequence&&cleanup.sequence<committed.sequence))fail();
  const owner=currentProcessOwnership(),sameOwner=owner?.store===store&&owner.runId===rid&&owner.projectId===p.id&&owner.dispatchId===q.dispatchId&&owner.generation===q.generation&&owner.mode==='live';
  if(cache.status==='pending'&&sameOwner){/* The exact original owner already committed and closed its generated worker. */}
  else{
   if(cache.status!=='done')fail();const response=object(JSON.parse(String(cache.response)));if(response.hash!==operation||response.appliedRevision!==version.revision)fail();
   const finished=one('DispatchFinished','dispatchId',q.dispatchId);if(finished.data.generation!==q.generation||finished.data.outcome!=='COMPLETED'||finished.data.cleanupReturned!==true||finished.sequence<=committed.sequence)fail();
  }
  const retained=one('SqliteDataRuntimeRetained','operationHash',operation);if(retained.data.jobId!==c.jobId||retained.data.resultHash!==c.resultHash||!sha(retained.data.manifestHash)||retained.data.state!=='RETAINED'||retained.data.guestRemoved!==false||retained.sequence<=committed.sequence)fail();
  const basis:Omit<SqliteRetirementBasis,'authorityHash'>={schema:'dream-maker.sqlite-retirement-basis.v1',projectId:p.id,runId:rid,specHash:run.specHash,operationHash:operation,revision:version.revision,versionHash:version.contentHash,jobId:c.jobId,sourceHash:version.sourceTreeHash,inputHash,resultHash:c.resultHash,manifestHash:retained.data.manifestHash,workerHash:d.workerHash,resourceHelperHash:d.resourceHelperHash,resourceFinalHash:d.resourceFinalHash,imageHash:version.image.imageHash,imageBytes:version.image.imageBytes,parentOperationHash:parent?.image.operationHash??null,parentImageHash:parent?.image.imageHash??null,parentImageBytes:parent?.image.imageBytes??0,committedRecordId:committed.id,requestedRecordId:requested.id,closedRecordId:closed.id,cleanupRecordId:cleanup.id,grantRecordId:grant.id,originalDispatchId:q.dispatchId};
  return Object.freeze({...basis,authorityHash:hash(basis)});
 }catch{fail();}
}
interface Grant {store:Store;root:string;owner:ProcessOwnershipScope;signal:AbortSignal;basis:SqliteRetirementBasis;used:boolean;check():void}
const grants=new WeakMap<object,Grant>();
export function consumeSqliteRetirementPermit(permit:SqliteRetirementPermit,store:Store,root:string,signal:AbortSignal):SqliteRetirementBasis{
 const g=permit&&grants.get(permit);if(!g||g.used||g.store!==store||g.root!==resolve(root).toLowerCase()||g.owner!==currentProcessOwnership()||g.signal!==signal||signal.aborted)fail('SQLITE_RETIREMENT_PERMIT_REQUIRED');g.check();g.used=true;return g.basis;
}
/** The exact input and output images stay pinned until the fixed cleanup callback closes. */
export async function withSqliteRetirementPermit<T>(store:Store,root:string,data:string,rid:string,operation:string,action:(permit:SqliteRetirementPermit,signal:AbortSignal)=>Promise<T>|T,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<T>{
 const owner=currentProcessOwnership();if(!owner||owner.store!==store||owner.runId!==rid||owner.mode!=='live'||!processCleanupProven(owner))fail('SQLITE_RETIREMENT_OWNERSHIP_REQUIRED');if(options.signal?.aborted)fail('RUN_CANCELLED');
 if(resolve(data).toLowerCase()!==resolve(dirname(store.path)).toLowerCase())fail('SQLITE_RETIREMENT_STORAGE_BINDING_REQUIRED');
 const basis=sqliteRetirementBasis(store,rid,operation);if(owner.projectId!==basis.projectId)fail('SQLITE_RETIREMENT_OWNERSHIP_REQUIRED');
 return withWindowsStorageCustody(root,data,async lease=>{
  const directory='controller/sqlite-images/'+hash(basis.projectId);await lease.directory(directory);await lease.image(directory,operation,basis.imageBytes,basis.imageHash);
  if(basis.parentOperationHash)await lease.image(directory,basis.parentOperationHash,basis.parentImageBytes,basis.parentImageHash!);
  const check=()=>{lease.assertActive();if(sqliteRetirementBasis(store,rid,operation).authorityHash!==basis.authorityHash)fail();};check();
  const permit=Object.freeze({schema:'dream-maker.sqlite-retirement-permit.v1' as const,authorityHash:basis.authorityHash});grants.set(permit,{store,root:resolve(root).toLowerCase(),owner,signal:lease.signal,basis,used:false,check});
  store.record('SqliteDataRetirementAuthorized',basis.projectId,rid,{dispatchId:owner.dispatchId,generation:owner.generation,operationHash:operation,jobId:basis.jobId,authorityHash:basis.authorityHash,committedRecordId:basis.committedRecordId,versionHash:basis.versionHash,imageHash:basis.imageHash,modelCalls:0});
  try{return await action(permit,lease.signal);}finally{grants.delete(permit);}
 },{...options,keepAliveOnAbort:true});
}
