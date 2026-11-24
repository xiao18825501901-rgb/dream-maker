import {resolve,dirname} from 'node:path';
import {Store} from './store.js';
import {DomainError,hash,hasSecret,now} from './security.js';
import {treeHash} from './workspace.js';
import {readWorkspace} from './workspace-location.js';
import {LEGACY_DEMO_DATA_TREES} from './demo-data-contract.js';
import {checkedDemoTasks} from '../shared/demo-tasks.js';
import {FIXED_DEMO_DATA_KIND,type ManagedDataVersion,type ManagedDataView,type ManagedDataOperationView} from '../shared/managed-data.js';
export interface ManagedDataRestoreSource {snapshotId:string;rehearsalId:string;sourceManifestHash:string;version:ManagedDataVersion}
const DEFAULT_LIMITS={versions:1000,bytes:8000000,operations:5000,payloadBytes:100000};
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function fail(code:string,status=409):never{throw new DomainError(code,status);}
function tasks(value:unknown){
 let result;try{result=checkedDemoTasks(value);}catch{fail('MANAGED_DATA_INVALID',400);}
 const json=JSON.stringify(result);if(Buffer.byteLength(json)>DEFAULT_LIMITS.payloadBytes)fail('MANAGED_DATA_PAYLOAD_LIMIT',413);
 if(hasSecret(json))fail('MANAGED_DATA_SECRET_DENIED',403);return result;
}
/** Reused by readonly backup inspection; accepts a bounded row, not a source or execution claim. */
export function decodeManagedVersion(row:Record<string,unknown>):ManagedDataVersion{
 if(typeof row.data_json!=='string'||Buffer.byteLength(row.data_json)>DEFAULT_LIMITS.payloadBytes)fail('MANAGED_DATA_INTEGRITY_FAILED');
 let parsed;try{parsed=JSON.parse(row.data_json);}catch{fail('MANAGED_DATA_INTEGRITY_FAILED');}
 const version:ManagedDataVersion={projectId:String(row.project_id),kind:FIXED_DEMO_DATA_KIND,revision:Number(row.revision),parentRevision:row.parent_revision===null?null:Number(row.parent_revision),parentHash:row.parent_hash===null?null:String(row.parent_hash),tasks:tasks(parsed),dataHash:String(row.data_hash),contentHash:String(row.content_hash),sourceRunId:String(row.source_run_id),sourceTreeHash:String(row.source_tree_hash),origin:row.origin as ManagedDataVersion['origin'],sourceSnapshotId:row.source_snapshot_id===null?null:String(row.source_snapshot_id),actor:String(row.actor),at:String(row.at)};
 const {contentHash,...content}=version;
 if(row.kind!==FIXED_DEMO_DATA_KIND||!Number.isSafeInteger(version.revision)||version.revision<1||!['PREVIEW_EDIT','BROWSER_IMPORT','RESTORE'].includes(version.origin)||!/^local-session:[a-f0-9]{64}$/.test(version.actor)||!sha(version.sourceTreeHash)||!sha(version.dataHash)||!sha(contentHash)||version.dataHash!==hash(version.tasks)||contentHash!==hash(content)||!Number.isFinite(Date.parse(version.at))||version.revision===1&&(version.parentRevision!==null||version.parentHash!==null)||version.revision>1&&(version.parentRevision!==version.revision-1||!sha(version.parentHash))||(version.origin==='RESTORE')!==(version.sourceSnapshotId!==null))fail('MANAGED_DATA_INTEGRITY_FAILED');
 return version;
}
/** The original Store owns these data-only tables. No paths, prompts, permits or model calls. */
export class ManagedDatasets {
 private limits={...DEFAULT_LIMITS};
 constructor(private store:Store,private root:string,limits:Partial<Pick<typeof DEFAULT_LIMITS,'versions'|'bytes'|'operations'>>={}){
  for(const key of Object.keys(limits) as (keyof typeof limits)[]){const value=limits[key];if(!['versions','bytes','operations'].includes(key)||typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>DEFAULT_LIMITS[key])fail('MANAGED_DATA_LIMITS_INVALID',400);this.limits[key]=value;}
 }
 private project(pid:string){const project=this.store.project(pid);if(project.mode!=='demo')fail('MANAGED_DATA_DEMO_ONLY');return project;}
 private head(pid:string):ManagedDataVersion|null{
  const row=this.store.db.prepare('SELECT v.* FROM managed_dataset_heads h JOIN managed_dataset_versions v ON v.project_id=h.project_id AND v.kind=h.kind AND v.revision=h.revision WHERE h.project_id=? AND h.kind=?').get(pid,FIXED_DEMO_DATA_KIND);
  const max=Number(this.store.db.prepare('SELECT max(revision) n FROM managed_dataset_versions WHERE project_id=? AND kind=?').get(pid,FIXED_DEMO_DATA_KIND)?.n??0);
  if(!row){if(max)fail('MANAGED_DATA_INTEGRITY_FAILED');return null;}
  const version=decodeManagedVersion(row);if(version.revision!==max)fail('MANAGED_DATA_INTEGRITY_FAILED');
  if(version.revision>1){const previous=this.store.db.prepare('SELECT content_hash FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(pid,FIXED_DEMO_DATA_KIND,version.revision-1);if(previous?.content_hash!==version.parentHash)fail('MANAGED_DATA_INTEGRITY_FAILED');}
  return version;
 }
 read(pid:string):ManagedDataView{
  this.project(pid);const head=this.head(pid),usage=this.store.db.prepare('SELECT count(*) versions,coalesce(sum(length(CAST(data_json AS BLOB))),0) bytes FROM managed_dataset_versions WHERE project_id=? AND kind=?').get(pid,FIXED_DEMO_DATA_KIND)!;
  const operations=Number(this.store.db.prepare('SELECT count(*) n FROM managed_dataset_operations WHERE project_id=? AND kind=?').get(pid,FIXED_DEMO_DATA_KIND)!.n);
  return {schema:'dream-maker.managed-data.v1',projectId:pid,kind:FIXED_DEMO_DATA_KIND,revision:head?.revision??0,tasks:head?.tasks??[],dataHash:head?.dataHash??null,contentHash:head?.contentHash??null,usage:{versions:Number(usage.versions),bytes:Number(usage.bytes),operations},limits:{...this.limits},scope:'FIXED_DEMO_DATA_ONLY',nativeExecutionGranted:false};
 }
 previewBinding(runId:string){
  const run=this.store.run(runId);this.admit(runId,run.treeHash??'','BROWSER_IMPORT');
  return {treeHash:run.treeHash!,dataProtocol:LEGACY_DEMO_DATA_TREES.has(run.treeHash!)?1:2};
 }
 readPreview(runId:string,sourceHash:string):ManagedDataView{
  const run=this.admit(runId,sourceHash,'BROWSER_IMPORT');return this.read(run.projectId);
 }
 private admit(runId:string,sourceHash:string,origin:'PREVIEW_EDIT'|'BROWSER_IMPORT'){
  const run=this.store.run(runId);this.project(run.projectId);
  if(!sha(sourceHash)||sourceHash!==run.treeHash||sourceHash!==treeHash(readWorkspace(run,dirname(this.store.path)))||sourceHash!==treeHash(resolve(this.root,'examples/study-board'))&&!(origin==='BROWSER_IMPORT'&&LEGACY_DEMO_DATA_TREES.has(sourceHash)))fail('MANAGED_DATA_SOURCE_CHANGED');
  if(run.mode!=='demo'||!['READY_FOR_DELIVERY','ACCEPTED'].includes(run.state)||!run.verification?.ok||run.verification.treeHash!==sourceHash||run.review?.source!=='DEMO_RULES'||run.review.verdict!=='PASS'||run.review.treeHash!==sourceHash||this.store.owns(run.projectId,run.id))fail('MANAGED_DATA_SOURCE_UNVERIFIED');
  return run;
 }
 writePreview(runId:string,sourceHash:string,value:unknown,revision:number,operation:string,actor:string):ManagedDataOperationView{
  return this.write(runId,sourceHash,value,revision,'PREVIEW_EDIT',operation,actor);
 }
 importBrowser(runId:string,sourceHash:string,value:unknown,confirmed:boolean,operation:string,actor:string):ManagedDataOperationView{
  if(confirmed!==true)fail('MANAGED_DATA_CONSENT_REQUIRED',403);return this.write(runId,sourceHash,value,0,'BROWSER_IMPORT',operation,actor);
 }
 restoreFromRehearsal(pid:string,revision:number,source:()=>ManagedDataRestoreSource,operation:string,actor:string):ManagedDataOperationView{
  this.project(pid);if(typeof source!=='function')fail('MANAGED_DATA_RESTORE_SOURCE_INVALID');
  const restored=source();
  if(!restored||typeof restored!=='object'||!/^snapshot_[a-f0-9]{32}$/.test(restored.snapshotId)||!/^rehearsal_[a-f0-9]{32}$/.test(restored.rehearsalId)||!sha(restored.sourceManifestHash)||!restored.version||restored.version.projectId!==pid||restored.version.kind!==FIXED_DEMO_DATA_KIND)fail('MANAGED_DATA_RESTORE_SOURCE_INVALID');
  const version=restored.version,{contentHash,...content}=version;
  if(!sha(contentHash)||hash(content)!==contentHash||hash(tasks(version.tasks))!==version.dataHash)fail('MANAGED_DATA_RESTORE_SOURCE_INVALID');
  const run=this.store.run(version.sourceRunId);if(run.projectId!==pid||run.mode!=='demo'||run.treeHash!==version.sourceTreeHash)fail('MANAGED_DATA_RESTORE_SOURCE_INVALID');
  if(this.store.db.prepare('SELECT 1 FROM workspace_leases LIMIT 1').get())fail('MANAGED_DATA_BUSY');
  return this.commit(pid,version.sourceRunId,version.sourceTreeHash,version.tasks,revision,'RESTORE',operation,actor,restored);
 }
 private write(runId:string,sourceHash:string,value:unknown,revision:number,origin:'PREVIEW_EDIT'|'BROWSER_IMPORT',operation:string,actor:string):ManagedDataOperationView{
  const data=tasks(value),run=this.admit(runId,sourceHash,origin);
  return this.commit(run.projectId,runId,sourceHash,data,revision,origin,operation,actor);
 }
 private commit(pid:string,runId:string,sourceHash:string,value:unknown,revision:number,origin:ManagedDataVersion['origin'],operation:string,actor:string,restored?:ManagedDataRestoreSource):ManagedDataOperationView{
  if(!sha(operation)||!/^local-session:[a-f0-9]{64}$/.test(actor)||!Number.isSafeInteger(revision)||revision<0)fail('MANAGED_DATA_INPUT_INVALID',400);
  const data=tasks(value),inputHash=hash({pid,kind:FIXED_DEMO_DATA_KIND,runId,sourceHash,data,revision,origin,actor,restore:restored?{snapshotId:restored.snapshotId,rehearsalId:restored.rehearsalId,sourceManifestHash:restored.sourceManifestHash,sourceContentHash:restored.version.contentHash}:null});
  let replayed=false,appliedRevision=0;
  this.store.tx(()=>{
   const current=this.read(pid),previous=this.store.db.prepare('SELECT input_hash,applied_revision FROM managed_dataset_operations WHERE operation_hash=?').get(operation);
   if(previous){if(previous.input_hash!==inputHash)fail('MANAGED_DATA_IDEMPOTENCY_CONFLICT');replayed=true;appliedRevision=Number(previous.applied_revision);return;}
   if(current.usage.operations>=this.limits.operations)fail('MANAGED_DATA_OPERATION_LIMIT');
   if(origin==='BROWSER_IMPORT'&&current.revision)fail('MANAGED_DATA_ALREADY_EXISTS');
   if(revision!==current.revision)fail('MANAGED_DATA_CONFLICT');
   let applied=current.revision;const dataHash=hash(data);
   if(current.dataHash!==dataHash||origin==='RESTORE'){
    const json=JSON.stringify(data);if(current.usage.versions>=this.limits.versions)fail('MANAGED_DATA_VERSION_LIMIT');if(current.usage.bytes+Buffer.byteLength(json)>this.limits.bytes)fail('MANAGED_DATA_STORAGE_LIMIT');
    const content:Omit<ManagedDataVersion,'contentHash'>={projectId:pid,kind:FIXED_DEMO_DATA_KIND,revision:current.revision+1,parentRevision:current.revision||null,parentHash:current.contentHash,tasks:data,dataHash,sourceRunId:runId,sourceTreeHash:sourceHash,origin,sourceSnapshotId:restored?.snapshotId??null,actor,at:now()},digest=hash(content);applied=content.revision;
    this.store.db.prepare('INSERT INTO managed_dataset_versions(project_id,kind,revision,parent_revision,parent_hash,data_json,data_hash,content_hash,source_run_id,source_tree_hash,origin,source_snapshot_id,actor,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pid,FIXED_DEMO_DATA_KIND,applied,content.parentRevision,content.parentHash,json,dataHash,digest,runId,sourceHash,origin,content.sourceSnapshotId,actor,content.at);
    this.store.db.prepare('INSERT INTO managed_dataset_heads VALUES(?,?,?) ON CONFLICT(project_id,kind) DO UPDATE SET revision=excluded.revision').run(pid,FIXED_DEMO_DATA_KIND,applied);
    this.store.event(pid,null,'managed-data.saved',{kind:FIXED_DEMO_DATA_KIND,revision:applied,contentHash:digest,origin,sourceRunId:runId});
    if(restored)this.store.record('ManagedDataRestore',pid,null,{operationHash:operation,sourceSnapshotId:restored.snapshotId,rehearsalId:restored.rehearsalId,sourceManifestHash:restored.sourceManifestHash,sourceRevision:restored.version.revision,sourceContentHash:restored.version.contentHash,previousRevision:current.revision,appliedRevision:applied,contentHash:digest,scope:'FIXED_DEMO_DATA_ONLY',engineStarted:false,actor});
   }
   this.store.db.prepare('INSERT INTO managed_dataset_operations VALUES(?,?,?,?,?,?)').run(operation,pid,FIXED_DEMO_DATA_KIND,inputHash,applied,now());
   appliedRevision=applied;
  });
  return {...this.read(pid),operation:{hash:operation,appliedRevision,replayed}};
 }
}
