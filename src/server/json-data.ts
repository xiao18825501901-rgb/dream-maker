import {dirname} from 'node:path';
import {types} from 'node:util';
import {Store} from './store.js';
import {DomainError,hash,hasSecret,now} from './security.js';
import {treeHash} from './workspace.js';
import {readWorkspace} from './workspace-location.js';
import {reviewedDataPlan} from './data-source-review.js';
import {JSON_DATA_KIND,type JsonData,type JsonDataVersion,type JsonDataView} from '../shared/json-data.js';
const defaults={versions:1000,bytes:8000000,operations:5000,payloadBytes:100000};
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function fail(code:string,status=409):never{throw new DomainError(code,status);}
export interface JsonDataRestoreSource {snapshotId:string;rehearsalId:string;sourceManifestHash:string;version:JsonDataVersion}
/** A bounded, plain JSON value; never an executable, filesystem path or capability. */
export function checkedJsonDocument(value:unknown):Record<string,JsonData>{
 const seen=new Set<object>();let nodes=0;
 function walk(v:unknown,depth:number):void{
  if(++nodes>5000||depth>12)fail('JSON_DATA_COMPLEXITY_LIMIT',413);
  if(v===null||typeof v==='boolean')return;
  if(typeof v==='string'){if(v.length>65536)fail('JSON_DATA_PAYLOAD_LIMIT',413);return;}
  if(typeof v==='number'&&Number.isFinite(v))return;
  // Reject executable proxies before any reflection, and serialization hooks before stringify.
  if(!v||typeof v!=='object'||types.isProxy(v)||seen.has(v)||Object.getOwnPropertySymbols(v).length||'toJSON' in v)fail('JSON_DATA_INVALID',400);
  seen.add(v);
  if(Array.isArray(v)){
   if(Object.getPrototypeOf(v)!==Array.prototype)fail('JSON_DATA_INVALID',400);
   if(v.length>1000)fail('JSON_DATA_COMPLEXITY_LIMIT',413);
   if(Object.getOwnPropertyNames(v).some(key=>key!=='length'&&!/^(0|[1-9][0-9]*)$/.test(key)))fail('JSON_DATA_INVALID',400);
   for(let i=0;i<v.length;i++){const descriptor=Object.getOwnPropertyDescriptor(v,String(i));if(!descriptor||!('value' in descriptor))fail('JSON_DATA_INVALID',400);walk(descriptor.value,depth+1);}
   if(Object.keys(v).length!==v.length)fail('JSON_DATA_INVALID',400);
  }else{
   const proto=Object.getPrototypeOf(v);if(proto!==Object.prototype&&proto!==null)fail('JSON_DATA_INVALID',400);
   const entries=Object.entries(Object.getOwnPropertyDescriptors(v));if(entries.length>256)fail('JSON_DATA_COMPLEXITY_LIMIT',413);
   for(const [key,descriptor] of entries){if(!key||key.length>200||['__proto__','prototype','constructor'].includes(key)||!descriptor.enumerable||!('value' in descriptor))fail('JSON_DATA_INVALID',400);walk(descriptor.value,depth+1);}
  }
  seen.delete(v);
 }
 if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))fail('JSON_DATA_INVALID',400);walk(value,0);
 const json=JSON.stringify(value);if(Buffer.byteLength(json)>defaults.payloadBytes)fail('JSON_DATA_PAYLOAD_LIMIT',413);if(hasSecret(json))fail('JSON_DATA_SECRET_DENIED',403);
 return JSON.parse(json) as Record<string,JsonData>;
}
export function decodeJsonVersion(row:Record<string,unknown>):JsonDataVersion{
 if(row.kind!==JSON_DATA_KIND||typeof row.data_json!=='string'||Buffer.byteLength(row.data_json)>defaults.payloadBytes)fail('JSON_DATA_INTEGRITY_FAILED');
 let document;try{document=checkedJsonDocument(JSON.parse(row.data_json));}catch{fail('JSON_DATA_INTEGRITY_FAILED');}
 const value:JsonDataVersion={projectId:String(row.project_id),kind:JSON_DATA_KIND,revision:Number(row.revision),parentRevision:row.parent_revision===null?null:Number(row.parent_revision),parentHash:row.parent_hash===null?null:String(row.parent_hash),document:document!,dataHash:String(row.data_hash),contentHash:String(row.content_hash),sourceRunId:String(row.source_run_id),sourceTreeHash:String(row.source_tree_hash),origin:row.origin as JsonDataVersion['origin'],sourceSnapshotId:row.source_snapshot_id===null?null:String(row.source_snapshot_id),actor:String(row.actor),at:String(row.at)};
 const {contentHash,...content}=value;
 if(!Number.isSafeInteger(value.revision)||value.revision<1||!['LOCAL_DATA_EDIT','JSON_IMPORT','RUNTIME_RESULT','RESTORE'].includes(value.origin)||!/^local-session:[a-f0-9]{64}$/.test(value.actor)||!sha(value.sourceTreeHash)||!sha(value.dataHash)||!sha(contentHash)||value.dataHash!==hash(value.document)||contentHash!==hash(content)||!Number.isFinite(Date.parse(value.at))||value.revision===1&&(value.parentRevision!==null||value.parentHash!==null)||value.revision>1&&(value.parentRevision!==value.revision-1||!sha(value.parentHash))||(value.origin==='RESTORE')!==(value.sourceSnapshotId!==null))fail('JSON_DATA_INTEGRITY_FAILED');return value;
}
/** Uses the original Store's version, head and operation tables; never schedules execution. */
export class JsonDatasets {
 private limits={...defaults};
 constructor(private store:Store,private root:string,limits:Partial<Pick<typeof defaults,'versions'|'bytes'|'operations'>>={}){
  for(const [key,value] of Object.entries(limits)){if(!['versions','bytes','operations'].includes(key)||typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>defaults[key as 'versions'|'bytes'|'operations'])fail('JSON_DATA_LIMITS_INVALID',400);this.limits[key as 'versions'|'bytes'|'operations']=value;}
 }
 private project(pid:string){const p=this.store.project(pid);if(p.mode!=='live')fail('JSON_DATA_LIVE_ONLY');return p;}
 private head(pid:string):JsonDataVersion|null{
  const row=this.store.db.prepare('SELECT v.* FROM managed_dataset_heads h JOIN managed_dataset_versions v ON v.project_id=h.project_id AND v.kind=h.kind AND v.revision=h.revision WHERE h.project_id=? AND h.kind=?').get(pid,JSON_DATA_KIND),max=Number(this.store.db.prepare('SELECT max(revision) n FROM managed_dataset_versions WHERE project_id=? AND kind=?').get(pid,JSON_DATA_KIND)?.n??0);
  if(!row){if(max)fail('JSON_DATA_INTEGRITY_FAILED');return null;}
  const value=decodeJsonVersion(row);if(value.revision!==max)fail('JSON_DATA_INTEGRITY_FAILED');
  if(value.revision>1&&this.store.db.prepare('SELECT content_hash FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(pid,JSON_DATA_KIND,value.revision-1)?.content_hash!==value.parentHash)fail('JSON_DATA_INTEGRITY_FAILED');return value;
 }
 read(pid:string):JsonDataView{
  this.project(pid);const head=this.head(pid),usage=this.store.db.prepare('SELECT count(*) versions,coalesce(sum(length(CAST(data_json AS BLOB))),0) bytes FROM managed_dataset_versions WHERE project_id=? AND kind=?').get(pid,JSON_DATA_KIND)!,operations=Number(this.store.db.prepare('SELECT count(*) n FROM managed_dataset_operations WHERE project_id=? AND kind=?').get(pid,JSON_DATA_KIND)!.n);
  return {schema:'dream-maker.json-data.v1',projectId:pid,kind:JSON_DATA_KIND,revision:head?.revision??0,document:head?.document??{},dataHash:head?.dataHash??null,contentHash:head?.contentHash??null,usage:{versions:Number(usage.versions),bytes:Number(usage.bytes),operations},limits:{...this.limits},scope:'PROJECT_JSON_DATA_ONLY',nativeExecutionGranted:false};
 }
 readRun(runId:string,sourceHash:string):JsonDataView{const run=this.source(runId,sourceHash);return this.read(run.projectId);}
 private source(runId:string,sourceHash:string){
  const run=this.store.run(runId);this.project(run.projectId);
  if(!sha(sourceHash)||sourceHash!==run.treeHash||treeHash(readWorkspace(run,dirname(this.store.path)))!==sourceHash)fail('JSON_DATA_SOURCE_CHANGED');
  if(run.mode!=='live'||!['READY_FOR_DELIVERY','ACCEPTED'].includes(run.state)||!run.verification?.ok||run.verification.treeHash!==sourceHash||!run.review||run.review.verdict!=='PASS'||run.review.treeHash!==sourceHash||this.store.spec(run.specId).hash!==run.specHash||!this.store.approved(run.projectId,run.specHash,'BUILD')||!this.store.approved(run.projectId,run.specHash,'SPEC'))fail('JSON_DATA_SOURCE_UNVERIFIED');
  if(run.flowName==='custom'){
   try{reviewedDataPlan(this.store,run);}catch{fail('JSON_DATA_SOURCE_UNVERIFIED');}
  }else if(run.review.source!=='CODEX')fail('JSON_DATA_SOURCE_UNVERIFIED');
  if(this.store.db.prepare('SELECT 1 FROM workspace_leases WHERE project_id=?').get(run.projectId))fail('JSON_DATA_BUSY');return run;
 }
 write(runId:string,sourceHash:string,value:unknown,revision:number,operation:string,actor:string):JsonDataView{
  const document=checkedJsonDocument(value),run=this.source(runId,sourceHash);return this.commit(run.projectId,runId,sourceHash,document,revision,'LOCAL_DATA_EDIT',operation,actor);
 }
 /** Controller-only commit after the Engine's dispatch/cleanup fence; never exposed as HTTP input. */
 writeRuntime(runId:string,sourceHash:string,value:unknown,revision:number,operation:string,actor:string,receipt:{inputHash:string;resultHash:string}):JsonDataView{
  if(!receipt||!sha(receipt.inputHash)||!sha(receipt.resultHash))fail('JSON_DATA_RUNTIME_PROTOCOL_INVALID');
  const document=checkedJsonDocument(value),run=this.source(runId,sourceHash);
  return this.commit(run.projectId,runId,sourceHash,document,revision,'RUNTIME_RESULT',operation,actor,undefined,appliedRevision=>{
   this.store.record('JsonDataRuntimeCommitted',run.projectId,runId,{hash:operation,appliedRevision,sourceHash,...receipt,outputHash:hash(document),cleanupReturned:true,modelCalls:0});
  });
 }
 import(runId:string,sourceHash:string,value:unknown,confirmed:boolean,operation:string,actor:string):JsonDataView{
  if(confirmed!==true)fail('JSON_DATA_CONSENT_REQUIRED',403);const document=checkedJsonDocument(value),run=this.source(runId,sourceHash);return this.commit(run.projectId,runId,sourceHash,document,0,'JSON_IMPORT',operation,actor);
 }
 restore(pid:string,revision:number,source:()=>JsonDataRestoreSource,operation:string,actor:string):JsonDataView{
  this.project(pid);if(typeof source!=='function')fail('JSON_DATA_RESTORE_SOURCE_INVALID');const restored=source(),version=restored?.version;
  if(!restored||!/^snapshot_[a-f0-9]{32}$/.test(restored.snapshotId)||!/^rehearsal_[a-f0-9]{32}$/.test(restored.rehearsalId)||!sha(restored.sourceManifestHash)||!version||version.projectId!==pid||version.kind!==JSON_DATA_KIND)fail('JSON_DATA_RESTORE_SOURCE_INVALID');
  const {contentHash,...content}=version;if(!sha(contentHash)||hash(content)!==contentHash||hash(checkedJsonDocument(version.document))!==version.dataHash)fail('JSON_DATA_RESTORE_SOURCE_INVALID');
  const run=this.source(version.sourceRunId,version.sourceTreeHash);if(run.projectId!==pid)fail('JSON_DATA_RESTORE_SOURCE_INVALID');
  if(this.store.db.prepare('SELECT 1 FROM workspace_leases LIMIT 1').get())fail('JSON_DATA_BUSY');
  return this.commit(pid,run.id,version.sourceTreeHash,version.document,revision,'RESTORE',operation,actor,restored);
 }
 private commit(pid:string,runId:string,sourceHash:string,document:Record<string,JsonData>,revision:number,origin:JsonDataVersion['origin'],operation:string,actor:string,restored?:JsonDataRestoreSource,onCommit?:(revision:number)=>void):JsonDataView{
  if(!sha(operation)||!/^local-session:[a-f0-9]{64}$/.test(actor)||!Number.isSafeInteger(revision)||revision<0)fail('JSON_DATA_INPUT_INVALID',400);
  const dataHash=hash(document),inputHash=hash({pid,kind:JSON_DATA_KIND,runId,sourceHash,document,revision,origin,actor,restore:restored?{snapshotId:restored.snapshotId,rehearsalId:restored.rehearsalId,sourceManifestHash:restored.sourceManifestHash,sourceContentHash:restored.version.contentHash}:null});let replayed=false,appliedRevision=0;
  this.store.tx(()=>{
   const current=this.read(pid),previous=this.store.db.prepare('SELECT input_hash,applied_revision FROM managed_dataset_operations WHERE operation_hash=?').get(operation);
   if(previous){if(previous.input_hash!==inputHash)fail('JSON_DATA_IDEMPOTENCY_CONFLICT');replayed=true;appliedRevision=Number(previous.applied_revision);return;}
   if(current.usage.operations>=this.limits.operations)fail('JSON_DATA_OPERATION_LIMIT');if(origin==='JSON_IMPORT'&&current.revision)fail('JSON_DATA_ALREADY_EXISTS');if(revision!==current.revision)fail('JSON_DATA_CONFLICT');let applied=current.revision;
   if(current.dataHash!==dataHash||origin==='RESTORE'){
    const json=JSON.stringify(document);if(current.usage.versions>=this.limits.versions)fail('JSON_DATA_VERSION_LIMIT');if(current.usage.bytes+Buffer.byteLength(json)>this.limits.bytes)fail('JSON_DATA_STORAGE_LIMIT');
    const content:Omit<JsonDataVersion,'contentHash'>={projectId:pid,kind:JSON_DATA_KIND,revision:current.revision+1,parentRevision:current.revision||null,parentHash:current.contentHash,document,dataHash,sourceRunId:runId,sourceTreeHash:sourceHash,origin,sourceSnapshotId:restored?.snapshotId??null,actor,at:now()},digest=hash(content);applied=content.revision;
    this.store.db.prepare('INSERT INTO managed_dataset_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pid,JSON_DATA_KIND,applied,content.parentRevision,content.parentHash,json,dataHash,digest,runId,sourceHash,origin,content.sourceSnapshotId,actor,content.at);
    this.store.db.prepare('INSERT INTO managed_dataset_heads VALUES(?,?,?) ON CONFLICT(project_id,kind) DO UPDATE SET revision=excluded.revision').run(pid,JSON_DATA_KIND,applied);
    this.store.event(pid,null,'json-data.saved',{kind:JSON_DATA_KIND,revision:applied,contentHash:digest,origin,sourceRunId:runId});
    if(restored)this.store.record('JsonDataRestore',pid,null,{operationHash:operation,sourceSnapshotId:restored.snapshotId,rehearsalId:restored.rehearsalId,sourceManifestHash:restored.sourceManifestHash,sourceRevision:restored.version.revision,sourceContentHash:restored.version.contentHash,previousRevision:current.revision,appliedRevision:applied,contentHash:digest,scope:'PROJECT_JSON_DATA_ONLY',engineStarted:false,actor});
   }
   this.store.db.prepare('INSERT INTO managed_dataset_operations VALUES(?,?,?,?,?,?)').run(operation,pid,JSON_DATA_KIND,inputHash,applied,now());appliedRevision=applied;onCommit?.(applied);
  });return {...this.read(pid),operation:{hash:operation,appliedRevision,replayed}};
 }
}
