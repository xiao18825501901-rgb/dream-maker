import {lstatSync,mkdirSync,existsSync,readdirSync,readFileSync,openSync,closeSync,writeSync,fsyncSync,statfsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {Store} from './store.js';
import {DomainError,hash,now,object,within} from './security.js';
import {treeHash} from './workspace.js';
import {readWorkspace} from './workspace-location.js';
import {checkSqliteImageBytes,sqliteInputDescriptor,type SqliteChannelBinding} from './sqlite-channel.js';
import {checkSqliteSandboxResult,WSL_ENVIRONMENT,type SqliteSandboxExchange} from './wsl-sandbox.js';
import {SQLITE_DATA_KIND,type SqliteImageReference,type SqliteDataVersion,type SqliteDataView,
 type SqliteDataRecoveryCandidate,type SqliteDataRecoveryPlan} from '../shared/sqlite-data.js';
import {reviewedSqliteRuntime} from './sqlite-runtime-review.js';
import {withWindowsStorageCustody} from './windows-storage-custody.js';
import {currentProcessOwnership,withProcessOwnership} from './flow/process-ownership.js';
import {assertStorageVolumeHealthy,probeStorageVolumeHealth} from './storage-durability.js';
import type {StorageVolumeHealth} from '../shared/storage-durability.js';
const defaults={versions:32,bytes:512*1024*1024,operations:4096,pending:4},globalBytes=2*1024*1024*1024;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function fail(code:string):never{throw new DomainError(code,409);}
export interface SqliteDataCapture {
 projectId:string;runId:string;sourceHash:string;specHash:string;planHash:string;revision:number;contentHash:string|null;
 binding:SqliteChannelBinding;image:Buffer|null;
}
export interface SqliteDataRestoreSource {
 snapshotId:string;rehearsalId:string;sourceManifestHash:string;version:SqliteDataVersion;image:Buffer;
}
interface SqlitePublication {
 capture:SqliteDataCapture;image:Buffer;operation:string;actor:string;inputHash:string;resultHash:string;jobId:string;reference:SqliteImageReference;
}
interface SqliteImageIntent {
 operationHash:string;projectId:string;sourceRunId:string;sourceTreeHash:string;inputHash:string;
 expectedRevision:number;imageHash:string;imageBytes:number;actor:string;at:string;
}
interface SqliteImageIntentBinding {
 captureInputHash:string;planHash:string;resultHash:string;jobId:string;snapshotHelperHash:string;sqliteVersion:string;createdAt:string;
}
export function decodeSqliteVersion(row:Record<string,unknown>):SqliteDataVersion{
 let image:SqliteImageReference;try{image=JSON.parse(String(row.data_json));}catch{fail('SQLITE_DATA_INTEGRITY_FAILED');}
 const value:SqliteDataVersion={projectId:String(row.project_id),kind:SQLITE_DATA_KIND,revision:Number(row.revision),
  parentRevision:row.parent_revision===null?null:Number(row.parent_revision),parentHash:row.parent_hash===null?null:String(row.parent_hash),
  image:image!,dataHash:String(row.data_hash),contentHash:String(row.content_hash),sourceRunId:String(row.source_run_id),sourceTreeHash:String(row.source_tree_hash),
  origin:row.origin as SqliteDataVersion['origin'],sourceSnapshotId:row.source_snapshot_id===null?null:String(row.source_snapshot_id),actor:String(row.actor),at:String(row.at)};
 const {contentHash,...content}=value;
 if(row.kind!==SQLITE_DATA_KIND||!image||image.schema!=='dream-maker.sqlite-image-reference.v1'||!sha(image.operationHash)||
  !Number.isSafeInteger(image.imageBytes)||image.imageBytes<512||image.imageBytes>67108864||image.imageBytes%512||
  !sha(image.imageHash)||!sha(image.snapshotHelperHash)||typeof image.sqliteVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(image.sqliteVersion)||
  !Number.isSafeInteger(value.revision)||value.revision<1||!['SQLITE_RUNTIME_RESULT','RESTORE'].includes(value.origin)||
  (value.origin==='RESTORE')!==(value.sourceSnapshotId!==null)||
  !/^local-session:[a-f0-9]{64}$/.test(value.actor)||!sha(value.sourceTreeHash)||value.dataHash!==image.imageHash||!sha(contentHash)||
  hash(content)!==contentHash||!Number.isFinite(Date.parse(value.at))||value.revision===1&&(value.parentRevision!==null||value.parentHash!==null)||
  value.revision>1&&(value.parentRevision!==value.revision-1||!sha(value.parentHash)))fail('SQLITE_DATA_INTEGRITY_FAILED');
 return value;
}
/** Stores opaque image bytes. No SQLite supplied by a project is opened on the Windows controller. */
export class SqliteDatasets {
 private limits={...defaults};
 constructor(private store:Store,private root:string,private data:string,limits:Partial<typeof defaults>={},
  private storageProbe:(directory:string)=>Promise<StorageVolumeHealth>=probeStorageVolumeHealth){
  for(const [key,value] of Object.entries(limits)){
   if(!Object.hasOwn(defaults,key)||typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>defaults[key as keyof typeof defaults])fail('SQLITE_DATA_LIMITS_INVALID');
   this.limits[key as keyof typeof defaults]=value;
  }
 }
 /** Durable writeback is blocked unless the current Windows volume health is provably OK. */
 async assertStorageReady(signal?:AbortSignal):Promise<void>{
  if(signal?.aborted)fail('RUN_CANCELLED');
  let health:StorageVolumeHealth;
  try{health=await this.storageProbe(this.data);}catch{fail('STORAGE_VOLUME_HEALTH_UNKNOWN');}
  if(signal?.aborted)fail('RUN_CANCELLED');
  assertStorageVolumeHealthy(health);
 }
 private project(pid:string){const p=this.store.project(pid);if(p.mode!=='live')fail('SQLITE_DATA_LIVE_ONLY');return p;}
 private folder(pid:string,create=false):string{
  let path=resolve(this.data);
  for(const segment of ['', 'controller','sqlite-images',hash(pid)]){
   if(segment)path=within(path,segment);
   if(!existsSync(path)){if(!create)continue;mkdirSync(path,{mode:0o700});}
   const info=existsSync(path)?lstatSync(path):null;
   if(info&&(!info.isDirectory()||info.isSymbolicLink()))fail('SQLITE_DATA_STORAGE_UNKNOWN');
  }
  return path;
 }
 private head(pid:string):SqliteDataVersion|null{
  const row=this.store.db.prepare('SELECT v.* FROM managed_dataset_heads h JOIN managed_dataset_versions v ON v.project_id=h.project_id AND v.kind=h.kind AND v.revision=h.revision WHERE h.project_id=? AND h.kind=?').get(pid,SQLITE_DATA_KIND);
  const max=Number(this.store.db.prepare('SELECT max(revision) n FROM managed_dataset_versions WHERE project_id=? AND kind=?').get(pid,SQLITE_DATA_KIND)?.n??0);
  if(!row){if(max)fail('SQLITE_DATA_INTEGRITY_FAILED');return null;}
  const value=decodeSqliteVersion(row);if(value.revision!==max)fail('SQLITE_DATA_INTEGRITY_FAILED');
  if(value.revision>1&&this.store.db.prepare('SELECT content_hash FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(pid,SQLITE_DATA_KIND,value.revision-1)?.content_hash!==value.parentHash)fail('SQLITE_DATA_INTEGRITY_FAILED');
  return value;
 }
 private image(pid:string,reference:SqliteImageReference):Buffer{
  try{
   const path=within(this.folder(pid),reference.operationHash+'.sqlite'),info=lstatSync(path);
   if(!info.isFile()||info.isSymbolicLink()||info.size!==reference.imageBytes)fail('SQLITE_DATA_IMAGE_CHANGED');
   const bytes=readFileSync(path);checkSqliteImageBytes(bytes);if(hash(bytes)!==reference.imageHash)fail('SQLITE_DATA_IMAGE_CHANGED');return bytes;
  }catch{fail('SQLITE_DATA_IMAGE_CHANGED');}
 }
 private recoveryImage(pid:string,operation:string,bytes:number,imageHash:string):void{
   try{
     const path=within(this.folder(pid),operation+'.sqlite'),info=lstatSync(path);
     if(!info.isFile()||info.isSymbolicLink()||info.size!==bytes)fail('SQLITE_DATA_INTENT_IMAGE_UNAVAILABLE');
     const image=readFileSync(path);checkSqliteImageBytes(image);
     if(image.length!==bytes||hash(image)!==imageHash)fail('SQLITE_DATA_INTENT_IMAGE_UNAVAILABLE');
   }catch{fail('SQLITE_DATA_INTENT_IMAGE_UNAVAILABLE');}
 }
 read(pid:string):SqliteDataView{
  this.project(pid);const head=this.head(pid);if(head)this.image(pid,head.image);
  return this.view(pid,head);
 }
 /** Metadata-only planning view. It never opens the image or starts a keeper. */
 metadata(pid:string):SqliteDataView{
   this.project(pid);return this.view(pid,this.head(pid));
 }
 private view(pid:string,head:SqliteDataVersion|null):SqliteDataView{
  const usage=this.store.db.prepare('SELECT count(*) n,coalesce(sum(image_bytes),0) bytes FROM business_image_intents WHERE project_id=?').get(pid)!;
  const pending=Number(this.store.db.prepare('SELECT count(*) n FROM business_image_intents i LEFT JOIN managed_dataset_operations o ON o.operation_hash=i.operation_hash WHERE i.project_id=? AND o.operation_hash IS NULL').get(pid)!.n);
  const versions=Number(this.store.db.prepare('SELECT count(*) n FROM managed_dataset_versions WHERE project_id=? AND kind=?').get(pid,SQLITE_DATA_KIND)!.n);
  return {schema:'dream-maker.sqlite-data.v1',projectId:pid,kind:SQLITE_DATA_KIND,revision:head?.revision??0,imageHash:head?.dataHash??null,
   imageBytes:head?.image.imageBytes??0,contentHash:head?.contentHash??null,usage:{versions,bytes:Number(usage.bytes),operations:Number(usage.n),pending},
   limits:{...this.limits},scope:'PROJECT_SQLITE_DATA_ONLY',nativeExecutionGranted:false};
 }
 private intent(operation:string):SqliteImageIntent{
  const row=this.store.db.prepare('SELECT * FROM business_image_intents WHERE operation_hash=?').get(operation);
  if(!row)fail('SQLITE_DATA_INTENT_NOT_FOUND');
  const value:SqliteImageIntent={operationHash:String(row.operation_hash),projectId:String(row.project_id),sourceRunId:String(row.source_run_id),
   sourceTreeHash:String(row.source_tree_hash),inputHash:String(row.input_hash),expectedRevision:Number(row.expected_revision),
   imageHash:String(row.image_hash),imageBytes:Number(row.image_bytes),actor:String(row.actor),at:String(row.at)};
  if(!sha(value.operationHash)||value.operationHash!==operation||typeof value.projectId!=='string'||!value.projectId||
   typeof value.sourceRunId!=='string'||!value.sourceRunId||!sha(value.sourceTreeHash)||!sha(value.inputHash)||
   !Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0||!sha(value.imageHash)||
   !Number.isSafeInteger(value.imageBytes)||value.imageBytes<512||value.imageBytes>67108864||value.imageBytes%512||
   !/^local-session:[a-f0-9]{64}$/.test(value.actor)||!Number.isFinite(Date.parse(value.at))||new Date(value.at).toISOString()!==value.at)
   fail('SQLITE_DATA_INTENT_INTEGRITY_FAILED');
  return value;
 }
 private intentBinding(operation:string):SqliteImageIntentBinding{
  const row=this.store.db.prepare('SELECT * FROM business_image_intent_bindings WHERE operation_hash=?').get(operation);
  if(!row)fail('SQLITE_DATA_INTENT_BINDING_REQUIRED');
  const value:SqliteImageIntentBinding={captureInputHash:String(row.capture_input_hash),planHash:String(row.plan_hash),
   resultHash:String(row.result_hash),jobId:String(row.worker_job_id),
   snapshotHelperHash:String(row.snapshot_helper_hash),sqliteVersion:String(row.sqlite_version),createdAt:String(row.created_at)};
  if(!sha(value.captureInputHash)||!sha(value.planHash)||!sha(value.resultHash)||typeof value.jobId!=='string'||value.jobId.length<1||value.jobId.length>200||
   !/^[A-Za-z0-9_.:-]+$/.test(value.jobId)||!sha(value.snapshotHelperHash)||
   !/^\d+\.\d+\.\d+$/.test(value.sqliteVersion)||value.sqliteVersion.length>40||
   !Number.isFinite(Date.parse(value.createdAt))||new Date(value.createdAt).toISOString()!==value.createdAt)
   fail('SQLITE_DATA_INTENT_BINDING_CHANGED');
  return value;
 }
 recovery(pid:string):SqliteDataRecoveryPlan{
  this.project(pid);
  const rows=this.store.db.prepare(`SELECT i.* FROM business_image_intents i
   LEFT JOIN managed_dataset_operations o ON o.operation_hash=i.operation_hash
   WHERE i.project_id=? AND o.operation_hash IS NULL ORDER BY i.at DESC,i.operation_hash LIMIT ?`).all(pid,this.limits.pending);
  const candidates:SqliteDataRecoveryCandidate[]=rows.map(row=>{
   const value=this.intent(String(row.operation_hash));
   if(value.projectId!==pid)fail('SQLITE_DATA_INTENT_INTEGRITY_FAILED');
   let recoverable=false,blockedReason:SqliteDataRecoveryCandidate['blockedReason']='INTENT_BINDING_REQUIRED';
   if(this.store.db.prepare('SELECT 1 FROM business_image_intent_bindings WHERE operation_hash=?').get(value.operationHash)){
    try{this.intentBinding(value.operationHash);recoverable=true;blockedReason=null;}
    catch{blockedReason='INTENT_BINDING_INVALID';}
   }
   return {operationHash:value.operationHash,expectedRevision:value.expectedRevision,imageBytes:value.imageBytes,
    imageHash:value.imageHash,actor:value.actor,at:value.at,recoverable,blockedReason};
  });
  return {schema:'dream-maker.sqlite-data-recovery-plan.v1',scope:'PROJECT_SQLITE_DATA_ONLY',projectId:pid,
   candidates,automaticReplay:false,modelCalls:0};
 }
 private source(rid:string,sourceHash:string){
  const run=this.store.run(rid),p=this.project(run.projectId);
  if(!sha(sourceHash)||sourceHash!==run.treeHash||treeHash(readWorkspace(run,dirname(this.store.path)))!==sourceHash)fail('SQLITE_DATA_SOURCE_CHANGED');
  const spec=this.store.spec(run.specId);
  if(p.specId!==run.specId||p.activeRunId!==rid||spec.stale||run.mode!=='live'||!['READY_FOR_DELIVERY','ACCEPTED'].includes(run.state)||
   !run.verification?.ok||run.verification.treeHash!==sourceHash||
   spec.hash!==run.specHash||!this.store.approved(p.id,run.specHash,'BUILD')||!this.store.approved(p.id,run.specHash,'SPEC'))fail('SQLITE_DATA_SOURCE_UNVERIFIED');
  try{reviewedSqliteRuntime(this.store,run);}
  catch(error){
   if(error instanceof DomainError&&error.code==='SQLITE_DATA_REVIEW_BINDING_REQUIRED')throw error;
   fail('SQLITE_DATA_SOURCE_UNVERIFIED');
  }
  if(this.store.db.prepare('SELECT 1 FROM workspace_leases WHERE project_id=?').get(p.id))fail('SQLITE_DATA_BUSY');return run;
 }
 private inputHash(c:Omit<SqliteDataCapture,'binding'>):string{
  return hash({schema:'dream-maker.sqlite-runtime-input.v1',kind:SQLITE_DATA_KIND,projectId:c.projectId,runId:c.runId,specHash:c.specHash,
   sourceHash:c.sourceHash,planHash:c.planHash,revision:c.revision,contentHash:c.contentHash,imageHash:c.image===null?null:hash(c.image),imageBytes:c.image?.length??0});
 }
 /** Source-only fence for the original Engine; no unprotected database-image read. */
 assertRuntimeSource(rid:string,sourceHash:string):void{this.source(rid,sourceHash);}
 /** Metadata-only read. No generated entry, model admission or dataset mutation. */
 async readOwned(pid:string,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<SqliteDataView>{
  const ownership=currentProcessOwnership();if(!ownership)fail('STORAGE_CUSTODY_OWNERSHIP_REQUIRED');
  if(options.signal?.aborted)fail('RUN_CANCELLED');
  if(ownership.store!==this.store||ownership.projectId!==pid||!ownership.runId)fail('SQLITE_DATA_CUSTODY_BINDING_REQUIRED');
  const p=this.project(pid),r=this.store.run(ownership.runId),head=this.head(pid);
  if(r.projectId!==pid||r.mode!=='live'||p.activeRunId!==r.id)fail('SQLITE_DATA_CUSTODY_BINDING_REQUIRED');
  const current=()=>{
   const project=this.project(pid),run=this.store.run(r.id);
   if(project.activeRunId!==r.id||project.version!==p.version||run.projectId!==pid||run.mode!=='live'||run.version!==r.version)fail('SQLITE_DATA_READ_CHANGED');
   if((this.head(pid)?.contentHash??null)!==(head?.contentHash??null))fail('SQLITE_DATA_CONFLICT');
  };
  const view=await withWindowsStorageCustody(this.root,this.data,async lease=>{
   if(head){const directory='controller/sqlite-images/'+hash(pid);await lease.directory(directory);await lease.image(directory,head.image.operationHash,head.image.imageBytes,head.image.imageHash);}
   lease.assertActive();current();const result=this.view(pid,head);lease.assertActive();return result;
  },options);
  current();return view;
 }
 /** Protected controller capture; the original Dispatch owns every keeper process.
  * No SQLite is parsed and no version/Intent is published by this operation. */
 async captureOwned(rid:string,sourceHash:string,revision:number,planHash:string,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<SqliteDataCapture>{
  const ownership=currentProcessOwnership();
  if(!ownership)fail('STORAGE_CUSTODY_OWNERSHIP_REQUIRED');
  if(options.signal?.aborted)fail('RUN_CANCELLED');
  if(!Number.isSafeInteger(revision)||revision<0||!sha(planHash))fail('SQLITE_DATA_INPUT_INVALID');
  const run=this.source(rid,sourceHash),head=this.head(run.projectId);
  if(ownership.store!==this.store||ownership.projectId!==run.projectId||ownership.runId!==rid)fail('SQLITE_DATA_CUSTODY_BINDING_REQUIRED');
  if((head?.revision??0)!==revision)fail('SQLITE_DATA_CONFLICT');
  return withWindowsStorageCustody(this.root,this.data,async lease=>{
   if(head){
    const directory='controller/sqlite-images/'+hash(run.projectId);
    await lease.directory(directory);
    await lease.image(directory,head.image.operationHash,head.image.imageBytes,head.image.imageHash);
   }
   lease.assertActive();
   const current=this.head(run.projectId);
   if((current?.revision??0)!==revision||(current?.contentHash??null)!==(head?.contentHash??null))fail('SQLITE_DATA_CONFLICT');
   const capture=this.capture(rid,sourceHash,revision,planHash);
   lease.assertActive();return capture;
  },options);
 }
 capture(rid:string,sourceHash:string,revision:number,planHash:string):SqliteDataCapture{
  if(!Number.isSafeInteger(revision)||revision<0||!sha(planHash))fail('SQLITE_DATA_INPUT_INVALID');
  const run=this.source(rid,sourceHash),head=this.head(run.projectId);if((head?.revision??0)!==revision)fail('SQLITE_DATA_CONFLICT');
  const capture={projectId:run.projectId,runId:rid,sourceHash,specHash:run.specHash,planHash,revision,contentHash:head?.contentHash??null,image:head?this.image(run.projectId,head.image):null};
  return {...capture,binding:{inputHash:this.inputHash(capture),expectedRevision:revision}};
 }
 private currentInput(capture:SqliteDataCapture,head:SqliteDataVersion|null):void{
  if((head?.revision??0)!==capture.revision||(head?.contentHash??null)!==capture.contentHash)fail('SQLITE_DATA_CONFLICT');
  if(head){const actual=this.image(capture.projectId,head.image);if(capture.image===null||hash(actual)!==hash(capture.image))fail('SQLITE_DATA_IMAGE_CHANGED');}
  else if(capture.image!==null)fail('SQLITE_DATA_IMAGE_CHANGED');
 }
 private room(pid:string,bytes:number,resolvingIntent?:string){
  const view=this.read(pid);
  if(view.usage.versions>=this.limits.versions)fail('SQLITE_DATA_VERSION_LIMIT');
  const pending=view.usage.pending-(resolvingIntent?1:0);
  if(!resolvingIntent&&view.usage.operations>=this.limits.operations)fail('SQLITE_DATA_OPERATION_LIMIT');
  if(pending<0||pending>=this.limits.pending&&!resolvingIntent)fail('SQLITE_DATA_OPERATION_LIMIT');
  if(view.usage.bytes+bytes>this.limits.bytes)fail('SQLITE_DATA_STORAGE_LIMIT');
  const total=Number(this.store.db.prepare('SELECT coalesce(sum(image_bytes),0) bytes FROM business_image_intents').get()!.bytes);
  if(!Number.isSafeInteger(total)||total+bytes>globalBytes)fail('SQLITE_DATA_STORAGE_LIMIT');
  const pool=within(this.data,'controller/sqlite-images');let nodes=0;
  if(existsSync(pool))for(const entry of readdirSync(pool,{withFileTypes:true})){
   const folder=within(pool,entry.name),info=lstatSync(folder);
   if(!sha(entry.name)||!info.isDirectory()||info.isSymbolicLink())fail('SQLITE_DATA_STORAGE_UNKNOWN');
   for(const file of readdirSync(folder,{withFileTypes:true})){
    if(++nodes>100000||!/^([a-f0-9]{64})\.sqlite$/.test(file.name))fail('SQLITE_DATA_STORAGE_UNKNOWN');
    const path=within(folder,file.name),stat=lstatSync(path),intent=this.store.db.prepare('SELECT project_id,image_bytes FROM business_image_intents WHERE operation_hash=?').get(file.name.slice(0,64));
    if(!stat.isFile()||stat.isSymbolicLink()||!intent||hash(String(intent.project_id))!==entry.name||stat.size>Number(intent.image_bytes))fail('SQLITE_DATA_STORAGE_UNKNOWN');
   }
  }
  const disk=statfsSync(this.data,{bigint:true}),unit=disk.bsize<4096n?4096n:disk.bsize;
  if(unit>1073741824n||disk.bavail*disk.bsize<BigInt(bytes)+unit*48n+256000000n)fail('SQLITE_DATA_STORAGE_LIMIT');
 }
 private publication(capture:SqliteDataCapture,exchange:SqliteSandboxExchange,operation:string,actor:string):SqlitePublication{
  if(!sha(operation)||!/^local-session:[a-f0-9]{64}$/.test(actor)||!sha(capture.planHash)||capture.binding.expectedRevision!==capture.revision||
   capture.binding.inputHash!==this.inputHash(capture))fail('SQLITE_DATA_INPUT_INVALID');
  const run=this.source(capture.runId,capture.sourceHash);
  if(run.projectId!==capture.projectId||run.specHash!==capture.specHash)fail('SQLITE_DATA_SOURCE_CHANGED');
  if(exchange.image===null)fail('SQLITE_DATA_RUNTIME_FAILED');checkSqliteImageBytes(exchange.image);
  const image=Buffer.from(exchange.image);checkSqliteImageBytes(image);
  const descriptor=sqliteInputDescriptor(capture.image,capture.binding),helperHash=hash(readFileSync(resolve(this.root,'scripts/isolation/sqlite-snapshot.py'),'utf8'));
  checkSqliteSandboxResult(exchange.result,{jobId:exchange.result.jobId,sourceHash:capture.sourceHash,
   workerHash:hash(readFileSync(resolve(this.root,'scripts/isolation/wsl-worker.py'),'utf8')),environment:WSL_ENVIRONMENT,descriptor,snapshotHelperHash:helperHash},exchange.exchangeMetadata);
  if(exchange.result.status!=='EXECUTED'||exchange.result.exitCode!==0||object(object(exchange.result).sqlite).snapshotStatus!=='READY'||
   exchange.exchangeMetadata.imageBytes!==image.length||exchange.exchangeMetadata.imageHash!==hash(image)||hash(exchange.exchangeMetadata.result)!==hash(exchange.result))fail('SQLITE_DATA_RUNTIME_FAILED');
  const snapshot=object(object(object(exchange.result).sqlite).snapshot),resultHash=hash(exchange.result);
  const inputHash=hash({inputHash:capture.binding.inputHash,planHash:capture.planHash,actor,imageHash:hash(image),imageBytes:image.length,resultHash});
  return {capture,image,operation,actor,inputHash,resultHash,jobId:exchange.result.jobId,reference:{schema:'dream-maker.sqlite-image-reference.v1',operationHash:operation,imageBytes:image.length,imageHash:hash(image),snapshotHelperHash:helperHash,sqliteVersion:String(snapshot.sqliteVersion)}};
 }
 private reservePublication(publication:SqlitePublication,guard:()=>void,checkpoint:()=>void=()=>{}):number|null{
  const {capture,image,operation,actor,inputHash}=publication;
  let replay:number|null=null;
  this.store.tx(()=>{
   guard();checkpoint();
   const currentRun=this.source(capture.runId,capture.sourceHash);
   if(currentRun.projectId!==capture.projectId||currentRun.specHash!==capture.specHash||capture.binding.inputHash!==this.inputHash(capture))fail('SQLITE_DATA_SOURCE_CHANGED');
   const previous=this.store.db.prepare('SELECT project_id,kind,input_hash,applied_revision FROM managed_dataset_operations WHERE operation_hash=?').get(operation);
   if(previous){
    if(previous.project_id!==capture.projectId||previous.kind!==SQLITE_DATA_KIND||previous.input_hash!==inputHash)fail('SQLITE_DATA_IDEMPOTENCY_CONFLICT');
    replay=Number(previous.applied_revision);
    const row=this.store.db.prepare('SELECT * FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(capture.projectId,SQLITE_DATA_KIND,replay);
    if(!row)fail('SQLITE_DATA_INTEGRITY_FAILED');this.image(capture.projectId,decodeSqliteVersion(row).image);return;
   }
   if(this.store.db.prepare('SELECT 1 FROM business_image_intents WHERE operation_hash=?').get(operation))fail('SQLITE_DATA_RESULT_UNCERTAIN');
   this.currentInput(capture,this.head(capture.projectId));
   this.room(capture.projectId,image.length);
   this.store.db.prepare('INSERT INTO business_image_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(operation,capture.projectId,capture.runId,capture.sourceHash,inputHash,capture.revision,hash(image),image.length,actor,now());
   this.store.db.prepare('INSERT INTO business_image_intent_bindings VALUES(?,?,?,?,?,?,?,?)').run(operation,capture.binding.inputHash,
    capture.planHash,publication.resultHash,publication.jobId,publication.reference.snapshotHelperHash,
    publication.reference.sqliteVersion,now());
  });
  return replay;
 }
 private writePublication(publication:SqlitePublication,guard:()=>void,checkpoint:()=>void=()=>{}):void{
  const {capture,operation,image,reference}=publication;guard();checkpoint();
  const path=within(this.folder(capture.projectId,true),operation+'.sqlite'),fd=openSync(path,'wx',0o600);
  try{for(let offset=0;offset<image.length;){guard();const n=writeSync(fd,image,offset,Math.min(65536,image.length-offset));if(n<1)fail('SQLITE_DATA_WRITE_FAILED');offset+=n;}guard();fsyncSync(fd);}finally{closeSync(fd);}
  this.image(capture.projectId,reference);
 }
 private commitPublication(publication:SqlitePublication,guard:()=>void,checkpoint:()=>void=()=>{}):number{
  const {capture,operation,actor,inputHash,resultHash,jobId,reference}=publication;
  const revision=capture.revision+1;
  this.store.tx(()=>{
   guard();checkpoint();
   const currentRun=this.source(capture.runId,capture.sourceHash),head=this.head(capture.projectId);
   if(currentRun.projectId!==capture.projectId||currentRun.specHash!==capture.specHash||capture.binding.inputHash!==this.inputHash(capture))fail('SQLITE_DATA_SOURCE_CHANGED');
   this.currentInput(capture,head);this.image(capture.projectId,reference);
   const content:Omit<SqliteDataVersion,'contentHash'>={projectId:capture.projectId,kind:SQLITE_DATA_KIND,revision,parentRevision:head?.revision??null,
    parentHash:head?.contentHash??null,image:reference,dataHash:reference.imageHash,sourceRunId:capture.runId,sourceTreeHash:capture.sourceHash,
    origin:'SQLITE_RUNTIME_RESULT',sourceSnapshotId:null,actor,at:now()},contentHash=hash(content);
   this.store.db.prepare('INSERT INTO managed_dataset_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(capture.projectId,SQLITE_DATA_KIND,revision,content.parentRevision,
    content.parentHash,JSON.stringify(reference),reference.imageHash,contentHash,capture.runId,capture.sourceHash,content.origin,null,actor,content.at);
   this.store.db.prepare('INSERT INTO managed_dataset_heads VALUES(?,?,?) ON CONFLICT(project_id,kind) DO UPDATE SET revision=excluded.revision').run(capture.projectId,SQLITE_DATA_KIND,revision);
   this.store.db.prepare('INSERT INTO managed_dataset_operations VALUES(?,?,?,?,?,?)').run(operation,capture.projectId,SQLITE_DATA_KIND,inputHash,revision,now());
   this.store.record('SqliteDataRuntimeCommitted',capture.projectId,capture.runId,{operationHash:operation,inputHash:capture.binding.inputHash,resultHash,
    jobId,imageHash:reference.imageHash,imageBytes:reference.imageBytes,revision,sourceHash:capture.sourceHash,modelCalls:0,guestReleaseAuthorizedAfterCommit:true});
  });
  return revision;
 }
 private replayPublication(publication:SqlitePublication,revision:number):SqliteDataView{
  const row=this.store.db.prepare('SELECT * FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(publication.capture.projectId,SQLITE_DATA_KIND,revision);
  if(!row)fail('SQLITE_DATA_INTEGRITY_FAILED');this.image(publication.capture.projectId,decodeSqliteVersion(row).image);
  return {...this.read(publication.capture.projectId),operation:{hash:publication.operation,appliedRevision:revision,replayed:true}};
 }
 /** Legacy internal synchronous path. Not protected production I/O. */
 publish(capture:SqliteDataCapture,exchange:SqliteSandboxExchange,operation:string,actor:string):SqliteDataView{
  const publication=this.publication(capture,exchange,operation,actor),guard=()=>{},replay=this.reservePublication(publication,guard);
  if(replay!==null)return this.replayPublication(publication,replay);
  this.writePublication(publication,guard);const revision=this.commitPublication(publication,guard);
  return {...this.read(capture.projectId),operation:{hash:operation,appliedRevision:revision,replayed:false}};
 }
 /** Original controller/Dispatch only; no HTTP-supplied paths, bytes or cleanup authority.
  * Production admission and guest retirement remain the original Engine's responsibility. */
 async publishOwned(input:SqliteDataCapture,exchange:SqliteSandboxExchange,operation:string,actor:string,options:{signal?:AbortSignal;timeoutMs?:number;assertCurrent?:()=>void}={}):Promise<SqliteDataView>{
  const ownership=currentProcessOwnership();if(!ownership)fail('STORAGE_CUSTODY_OWNERSHIP_REQUIRED');
  if(options.signal?.aborted)fail('RUN_CANCELLED');
  if(ownership.store!==this.store||ownership.projectId!==input.projectId||ownership.runId!==input.runId)fail('SQLITE_DATA_CUSTODY_BINDING_REQUIRED');
  const assertCurrent=options.assertCurrent;
  if(assertCurrent!==undefined&&typeof assertCurrent!=='function')fail('SQLITE_DATA_BINDING_GUARD_INVALID');
  const checkpoint=()=>{if(assertCurrent&&assertCurrent()!==undefined)fail('SQLITE_DATA_BINDING_GUARD_INVALID');};
  if(input.image!==null)checkSqliteImageBytes(input.image);
  if(exchange.image!==null)checkSqliteImageBytes(exchange.image);
  // No caller-owned Buffer or mutable metadata survives across the first await.
  const capture:SqliteDataCapture={...input,binding:{...input.binding},image:input.image===null?null:Buffer.from(input.image)};
  let result:SqliteSandboxExchange['result'],image:Buffer|null,exchangeMetadata:SqliteSandboxExchange['exchangeMetadata'];
  try{
   image=exchange.image===null?null:Buffer.from(exchange.image);
   result=structuredClone(exchange.result);exchangeMetadata=structuredClone(exchange.exchangeMetadata);
  }catch{fail('SQLITE_DATA_INPUT_INVALID');}
  if(capture.image!==null)checkSqliteImageBytes(capture.image);
  if(image!==null)checkSqliteImageBytes(image);
  await this.assertStorageReady(options.signal);
  const publication=this.publication(capture,{result,image,exchangeMetadata},operation,actor);
  return withWindowsStorageCustody(this.root,this.data,async lease=>{
   const pool='controller/sqlite-images',directory=pool+'/'+hash(capture.projectId);
   await lease.directory(pool,true);lease.assertActive();await lease.directory(directory,true);lease.assertActive();
   const poolPath=within(this.data,pool),names=()=>readdirSync(poolPath,{withFileTypes:true}).map(entry=>{
    const info=lstatSync(within(poolPath,entry.name));if(!sha(entry.name)||!info.isDirectory()||info.isSymbolicLink())fail('SQLITE_DATA_STORAGE_UNKNOWN');return entry.name;
   }).sort(),pinnedNames=names();
   for(const name of pinnedNames){if(name!==hash(capture.projectId))await lease.directory(pool+'/'+name);lease.assertActive();}
   const pinnedHead=this.head(capture.projectId),references:SqliteImageReference[]=pinnedHead?[pinnedHead.image]:[];
   const referenceAt=(revision:number)=>{
    const row=this.store.db.prepare('SELECT * FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(capture.projectId,SQLITE_DATA_KIND,revision);
    if(!row)fail('SQLITE_DATA_INTEGRITY_FAILED');return decodeSqliteVersion(row).image;
   };
   if(capture.revision>0)references.push(referenceAt(capture.revision));
   const previous=this.store.db.prepare('SELECT applied_revision FROM managed_dataset_operations WHERE operation_hash=? AND project_id=? AND kind=?').get(operation,capture.projectId,SQLITE_DATA_KIND);
   if(previous)references.push(referenceAt(Number(previous.applied_revision)));
   const pinnedImages=new Set<string>();
   for(const image of references){if(pinnedImages.has(image.operationHash))continue;await lease.image(directory,image.operationHash,image.imageBytes,image.imageHash);lease.assertActive();pinnedImages.add(image.operationHash);}
   const guard=()=>{
    lease.assertActive();
    if(hash(names())!==hash(pinnedNames))fail('SQLITE_DATA_STORAGE_CHANGED');
    if((this.head(capture.projectId)?.contentHash??null)!==(pinnedHead?.contentHash??null))fail('SQLITE_DATA_CONFLICT');
   };
   guard();const replay=this.reservePublication(publication,guard,checkpoint);
   if(replay!==null){guard();return this.replayPublication(publication,replay);}
   guard();this.writePublication(publication,guard,checkpoint);
   await lease.image(directory,operation,publication.reference.imageBytes,publication.reference.imageHash);guard();
   const revision=this.commitPublication(publication,guard,checkpoint);lease.assertActive();
   return {...this.read(capture.projectId),operation:{hash:operation,appliedRevision:revision,replayed:false}};
  },options);
 }
 /** Reconcile only an already-durable image Intent whose exact output bytes are
  * complete. This never invokes a model, generated program or WSL job. */
 async recoverOwned(operation:string,recoveryActor:string,options:{signal?:AbortSignal;timeoutMs?:number;assertCurrent?:()=>void}={}):Promise<SqliteDataView>{
  const ownership=currentProcessOwnership();if(!ownership)fail('STORAGE_CUSTODY_OWNERSHIP_REQUIRED');
  if(options.signal?.aborted)fail('RUN_CANCELLED');
  if(!sha(operation)||!/^local-session:[a-f0-9]{64}$/.test(recoveryActor))fail('SQLITE_DATA_INPUT_INVALID');
  await this.assertStorageReady(options.signal);
  const intent=this.intent(operation);
  if(ownership.store!==this.store||ownership.projectId!==intent.projectId||ownership.runId!==intent.sourceRunId)fail('SQLITE_DATA_CUSTODY_BINDING_REQUIRED');
  const run=this.source(intent.sourceRunId,intent.sourceTreeHash);
  if(run.projectId!==intent.projectId)fail('SQLITE_DATA_SOURCE_CHANGED');
  const assertCurrent=options.assertCurrent;
  if(assertCurrent!==undefined&&typeof assertCurrent!=='function')fail('SQLITE_DATA_BINDING_GUARD_INVALID');
  const checkpoint=()=>{if(assertCurrent&&assertCurrent()!==undefined)fail('SQLITE_DATA_BINDING_GUARD_INVALID');};
  const existing=this.store.db.prepare('SELECT applied_revision FROM managed_dataset_operations WHERE operation_hash=? AND project_id=? AND kind=?')
    .get(operation,intent.projectId,SQLITE_DATA_KIND);
  const binding=existing?null:this.intentBinding(operation);
  const directory='controller/sqlite-images/'+hash(intent.projectId),pool='controller/sqlite-images';
  return withWindowsStorageCustody(this.root,this.data,async lease=>{
   await lease.directory(pool);lease.assertActive();await lease.directory(directory);lease.assertActive();
   if(existing){
    const revision=Number(existing.applied_revision),row=this.store.db.prepare(
      'SELECT * FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(intent.projectId,SQLITE_DATA_KIND,revision);
    if(!row)fail('SQLITE_DATA_INTEGRITY_FAILED');
    const image=decodeSqliteVersion(row).image;
    this.recoveryImage(intent.projectId,image.operationHash,image.imageBytes,image.imageHash);
    try{await lease.image(directory,image.operationHash,image.imageBytes,image.imageHash);}
    catch{fail('SQLITE_DATA_INTENT_IMAGE_UNAVAILABLE');}
    lease.assertActive();checkpoint();
    return {...this.read(intent.projectId),operation:{hash:operation,appliedRevision:revision,replayed:true}};
   }
   if(!binding)fail('SQLITE_DATA_INTENT_BINDING_REQUIRED');
   this.recoveryImage(intent.projectId,operation,intent.imageBytes,intent.imageHash);
   let pinnedImage:{path:string};
   try{pinnedImage=await lease.image(directory,operation,intent.imageBytes,intent.imageHash);}
   catch{fail('SQLITE_DATA_INTENT_IMAGE_UNAVAILABLE');}
   lease.assertActive();
   let image:Buffer;
   try{image=readFileSync(pinnedImage.path);checkSqliteImageBytes(image);}
   catch{fail('SQLITE_DATA_INTENT_IMAGE_UNAVAILABLE');}
   if(image.length!==intent.imageBytes||hash(image)!==intent.imageHash)fail('SQLITE_DATA_INTENT_IMAGE_UNAVAILABLE');
   const head=this.head(intent.projectId);
   if((head?.revision??0)!==intent.expectedRevision)fail('SQLITE_DATA_CONFLICT');
   if(head){await lease.image(directory,head.image.operationHash,head.image.imageBytes,head.image.imageHash);lease.assertActive();}
   const baseImage=head?this.image(intent.projectId,head.image):null;
   const capture:SqliteDataCapture={projectId:intent.projectId,runId:intent.sourceRunId,sourceHash:intent.sourceTreeHash,
    specHash:run.specHash,planHash:binding.planHash,revision:intent.expectedRevision,contentHash:head?.contentHash??null,image:baseImage,
    binding:{inputHash:binding.captureInputHash,expectedRevision:intent.expectedRevision}};
   if(this.inputHash(capture)!==binding.captureInputHash)fail('SQLITE_DATA_INTENT_BINDING_CHANGED');
   const guard=()=>{
    lease.assertActive();checkpoint();
    const currentRun=this.source(intent.sourceRunId,intent.sourceTreeHash),currentHead=this.head(intent.projectId);
    if((currentHead?.revision??0)!==intent.expectedRevision||(currentHead?.contentHash??null)!==(head?.contentHash??null))fail('SQLITE_DATA_CONFLICT');
    if(hash(reviewedSqliteRuntime(this.store,currentRun))!==binding.planHash)fail('SQLITE_DATA_RUNTIME_PLAN_CHANGED');
    this.currentInput(capture,currentHead);
    const actual=readFileSync(pinnedImage.path);checkSqliteImageBytes(actual);
    if(actual.length!==intent.imageBytes||hash(actual)!==intent.imageHash)fail('SQLITE_DATA_INTENT_IMAGE_UNAVAILABLE');
   };
   guard();this.room(intent.projectId,0,operation);
   const reference:SqliteImageReference={schema:'dream-maker.sqlite-image-reference.v1',operationHash:operation,
    imageBytes:intent.imageBytes,imageHash:intent.imageHash,snapshotHelperHash:binding.snapshotHelperHash,sqliteVersion:binding.sqliteVersion};
   const revision=intent.expectedRevision+1,recoveredAt=now();
   this.store.tx(()=>{
    guard();
    const currentHead=this.head(intent.projectId);
    const content:Omit<SqliteDataVersion,'contentHash'>={projectId:intent.projectId,kind:SQLITE_DATA_KIND,revision,
     parentRevision:currentHead?.revision??null,parentHash:currentHead?.contentHash??null,image:reference,dataHash:reference.imageHash,
     sourceRunId:intent.sourceRunId,sourceTreeHash:intent.sourceTreeHash,origin:'SQLITE_RUNTIME_RESULT',sourceSnapshotId:null,
     actor:intent.actor,at:recoveredAt},contentHash=hash(content);
    this.store.db.prepare('INSERT INTO managed_dataset_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(intent.projectId,SQLITE_DATA_KIND,
      revision,content.parentRevision,content.parentHash,JSON.stringify(reference),reference.imageHash,contentHash,intent.sourceRunId,
      intent.sourceTreeHash,content.origin,null,intent.actor,recoveredAt);
    this.store.db.prepare('INSERT INTO managed_dataset_heads VALUES(?,?,?) ON CONFLICT(project_id,kind) DO UPDATE SET revision=excluded.revision')
      .run(intent.projectId,SQLITE_DATA_KIND,revision);
    this.store.db.prepare('INSERT INTO managed_dataset_operations VALUES(?,?,?,?,?,?)').run(operation,intent.projectId,SQLITE_DATA_KIND,
      intent.inputHash,revision,recoveredAt);
    const recoveryHash=hash({schema:'dream-maker.sqlite-intent-recovery.v1',operationHash:operation,projectId:intent.projectId,
      runId:intent.sourceRunId,sourceHash:intent.sourceTreeHash,inputHash:intent.inputHash,planHash:binding.planHash,
      resultHash:binding.resultHash,jobId:binding.jobId,imageHash:intent.imageHash,imageBytes:intent.imageBytes,revision,recoveryActor,at:recoveredAt});
    this.store.record('SqliteDataIntentRecovered',intent.projectId,intent.sourceRunId,{schema:'dream-maker.sqlite-intent-recovery-record.v1',
      operationHash:operation,inputHash:intent.inputHash,planHash:binding.planHash,resultHash:binding.resultHash,jobId:binding.jobId,
      imageHash:intent.imageHash,imageBytes:intent.imageBytes,revision,sourceHash:intent.sourceTreeHash,recoveryActor,recoveryHash,
      modelCalls:0,generatedWorkRerun:false,guestWorkRerun:false});
   });
   lease.assertActive();const result=this.read(intent.projectId);lease.assertActive();
   return {...result,operation:{hash:operation,appliedRevision:revision,replayed:false}};
  },options);
 }
 /** Restore one rehearsed opaque image as a new version. The active application
  * database and generated source files are never replaced by this operation. */
 async restoreFromRehearsal(pid:string,revision:number,source:()=>SqliteDataRestoreSource|unknown|Promise<SqliteDataRestoreSource|unknown>,operation:string,actor:string,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<SqliteDataView>{
  if(typeof source!=='function'||!sha(operation)||!/^local-session:[a-f0-9]{64}$/.test(actor)||!Number.isSafeInteger(revision)||revision<0)fail('SQLITE_DATA_RESTORE_INPUT_INVALID');
  if(options.signal?.aborted)fail('RUN_CANCELLED');
  await this.assertStorageReady(options.signal);
  const p=this.project(pid);
  if(!p.activeRunId)fail('SQLITE_DATA_RESTORE_TARGET_INVALID');
  const targetRun=this.store.run(p.activeRunId);
  if(targetRun.projectId!==pid||targetRun.mode!=='live')fail('SQLITE_DATA_RESTORE_TARGET_INVALID');
  if(this.store.db.prepare('SELECT 1 FROM workspace_leases LIMIT 1').get())fail('SQLITE_DATA_BUSY');
  const binding={store:this.store,projectId:pid,runId:targetRun.id,dispatchId:'sqlite_restore_'+randomUUID(),generation:'sqlite_restore_'+randomUUID(),mode:'live' as const};
  return withProcessOwnership(binding,()=>withWindowsStorageCustody(this.root,this.data,async lease=>{
   const head=this.head(pid),priorOperation=this.store.db.prepare(
     'SELECT project_id,kind,input_hash,applied_revision FROM managed_dataset_operations WHERE operation_hash=?').get(operation);
   let targetContentHash:string|null;
   if(priorOperation){
    if(revision===0)targetContentHash=null;
    else{
     const targetRow=this.store.db.prepare(
       'SELECT * FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(pid,SQLITE_DATA_KIND,revision);
     if(!targetRow)fail('SQLITE_DATA_INTEGRITY_FAILED');
     targetContentHash=decodeSqliteVersion(targetRow).contentHash;
    }
   }else{
    if(Number(head?.revision??0)!==revision)fail('SQLITE_DATA_CONFLICT');
    targetContentHash=head?.contentHash??null;
   }
   await lease.directory('controller/sqlite-images',true);lease.assertActive();
   const directory='controller/sqlite-images/'+hash(pid);await lease.directory(directory,true);lease.assertActive();
   const restored=await source();
   lease.assertActive();
   if(!restored||typeof restored!=='object')fail('SQLITE_DATA_RESTORE_SOURCE_INVALID');
   const candidate=restored as SqliteDataRestoreSource;
   if(!/^snapshot_[a-f0-9]{32}$/.test(candidate.snapshotId)||!/^rehearsal_[a-f0-9]{32}$/.test(candidate.rehearsalId)||!sha(candidate.sourceManifestHash)||!Buffer.isBuffer(candidate.image))fail('SQLITE_DATA_RESTORE_SOURCE_INVALID');
   const image=Buffer.from(candidate.image),version=structuredClone(candidate.version);
   if(!version||version.projectId!==pid||version.kind!==SQLITE_DATA_KIND||!['SQLITE_RUNTIME_RESULT','RESTORE'].includes(version.origin)||!sha(version.contentHash))fail('SQLITE_DATA_RESTORE_SOURCE_INVALID');
   const {contentHash,...versionContent}=version;
   if(hash(versionContent)!==contentHash||hash(image)!==version.image.imageHash||image.length!==version.image.imageBytes)fail('SQLITE_DATA_RESTORE_SOURCE_INVALID');
   checkSqliteImageBytes(image);
   const sourceRun=this.store.run(version.sourceRunId);
   if(sourceRun.projectId!==pid||sourceRun.mode!=='live'||sourceRun.treeHash!==version.sourceTreeHash)fail('SQLITE_DATA_RESTORE_SOURCE_INVALID');
   const inputHash=hash({schema:'dream-maker.sqlite-restore.v1',pid,targetRunId:targetRun.id,targetRevision:revision,targetContentHash,
    operation,actor,snapshotId:candidate.snapshotId,rehearsalId:candidate.rehearsalId,sourceManifestHash:candidate.sourceManifestHash,
    sourceRevision:version.revision,sourceContentHash:version.contentHash,sourceRunId:version.sourceRunId,sourceTreeHash:version.sourceTreeHash,
    imageHash:version.image.imageHash,imageBytes:image.length});
   const previous=this.store.db.prepare('SELECT project_id,kind,input_hash,applied_revision FROM managed_dataset_operations WHERE operation_hash=?').get(operation);
   if(previous){
    if(previous.project_id!==pid||previous.kind!==SQLITE_DATA_KIND||previous.input_hash!==inputHash)fail('SQLITE_DATA_IDEMPOTENCY_CONFLICT');
    const row=this.store.db.prepare('SELECT * FROM managed_dataset_versions WHERE project_id=? AND kind=? AND revision=?').get(pid,SQLITE_DATA_KIND,Number(previous.applied_revision));
    if(!row)fail('SQLITE_DATA_INTEGRITY_FAILED');const existing=decodeSqliteVersion(row);
    await lease.image(directory,existing.image.operationHash,existing.image.imageBytes,existing.image.imageHash);lease.assertActive();
    return {...this.read(pid),operation:{hash:operation,appliedRevision:existing.revision,replayed:true}};
   }
   if(this.store.db.prepare('SELECT 1 FROM business_image_intents WHERE operation_hash=?').get(operation))fail('SQLITE_DATA_RESULT_UNCERTAIN');
   if((this.head(pid)?.contentHash??null)!==(head?.contentHash??null))fail('SQLITE_DATA_CONFLICT');
   this.room(pid,image.length);
   const reference:SqliteImageReference={schema:'dream-maker.sqlite-image-reference.v1',operationHash:operation,imageBytes:image.length,
    imageHash:hash(image),snapshotHelperHash:version.image.snapshotHelperHash,sqliteVersion:version.image.sqliteVersion};
   this.store.tx(()=>{
    lease.assertActive();
    if((this.head(pid)?.contentHash??null)!==(head?.contentHash??null))fail('SQLITE_DATA_CONFLICT');
    this.store.db.prepare('INSERT INTO business_image_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(operation,pid,version.sourceRunId,version.sourceTreeHash,
      inputHash,revision,reference.imageHash,reference.imageBytes,actor,now());
   });
   const path=within(this.folder(pid),operation+'.sqlite'),fd=openSync(path,'wx',0o600);
   try{for(let offset=0;offset<image.length;){lease.assertActive();const count=writeSync(fd,image,offset,Math.min(65536,image.length-offset));if(count<1)fail('SQLITE_DATA_WRITE_FAILED');offset+=count;}lease.assertActive();fsyncSync(fd);}finally{closeSync(fd);}
   this.image(pid,reference);await lease.image(directory,operation,reference.imageBytes,reference.imageHash);lease.assertActive();
   const appliedRevision=revision+1;
   this.store.tx(()=>{
    lease.assertActive();
    if((this.head(pid)?.contentHash??null)!==(head?.contentHash??null))fail('SQLITE_DATA_CONFLICT');
    this.image(pid,reference);
    const content:Omit<SqliteDataVersion,'contentHash'>={projectId:pid,kind:SQLITE_DATA_KIND,revision:appliedRevision,parentRevision:head?.revision??null,
      parentHash:head?.contentHash??null,image:reference,dataHash:reference.imageHash,sourceRunId:version.sourceRunId,sourceTreeHash:version.sourceTreeHash,
      origin:'RESTORE',sourceSnapshotId:candidate.snapshotId,actor,at:now()},digest=hash(content);
    this.store.db.prepare('INSERT INTO managed_dataset_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pid,SQLITE_DATA_KIND,appliedRevision,
      content.parentRevision,content.parentHash,JSON.stringify(reference),reference.imageHash,digest,content.sourceRunId,content.sourceTreeHash,
      content.origin,content.sourceSnapshotId,actor,content.at);
    this.store.db.prepare('INSERT INTO managed_dataset_heads VALUES(?,?,?) ON CONFLICT(project_id,kind) DO UPDATE SET revision=excluded.revision').run(pid,SQLITE_DATA_KIND,appliedRevision);
    this.store.db.prepare('INSERT INTO managed_dataset_operations VALUES(?,?,?,?,?,?)').run(operation,pid,SQLITE_DATA_KIND,inputHash,appliedRevision,now());
    this.store.record('SqliteDataRestore',pid,targetRun.id,{operationHash:operation,snapshotId:candidate.snapshotId,rehearsalId:candidate.rehearsalId,
      sourceManifestHash:candidate.sourceManifestHash,sourceRevision:version.revision,sourceContentHash:version.contentHash,previousRevision:revision,
      appliedRevision,contentHash:digest,imageHash:reference.imageHash,imageBytes:reference.imageBytes,scope:'PROJECT_SQLITE_DATA_ONLY',engineStarted:false,actor});
   });
   lease.assertActive();const result=this.read(pid);lease.assertActive();
   return {...result,operation:{hash:operation,appliedRevision,replayed:false}};
  },options));
 }
}
