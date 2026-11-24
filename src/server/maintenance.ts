import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {COPYFILE_EXCL} from 'node:constants';
import {mkdirSync,lstatSync,existsSync,readFileSync,writeFileSync,openSync,closeSync,readSync,readdirSync,copyFileSync,statfsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {Store} from './store.js';
import {assertFlowSnapshot} from './flow-configuration.js';
import {readFlowProfiles} from './flow-profiles.js';
import type {Run} from '../shared/types.js';
import {DomainError,hash,within} from './security.js';
import {captureDatabaseState,snapshotDatabaseBytes,SNAPSHOT_FILE_LIMIT} from './database-snapshot.js';
import {inspectManagedData} from './managed-data-snapshot.js';
import {decodeManagedVersion,type ManagedDataRestoreSource} from './managed-data.js';
import {FIXED_DEMO_DATA_KIND} from '../shared/managed-data.js';
import {JSON_DATA_KIND} from '../shared/json-data.js';
import {decodeJsonVersion,type JsonDataRestoreSource} from './json-data.js';
import {decodeSqliteVersion,type SqliteDataRestoreSource} from './sqlite-data.js';
import {withProcessOwnership} from './flow/process-ownership.js';
import {withWindowsStorageCustody} from './windows-storage-custody.js';
import {maintenanceStorageBytes,assertMaintenanceRoom} from './maintenance-storage.js';
import type {StateFile,StateSnapshot,ApplicationStateCounts,RestoreRehearsal,StateSqliteAttachment} from '../shared/maintenance.js';
const exclusions:StateSnapshot['exclusions']=['GENERATED_PROJECT_FILES','EXTERNAL_BUSINESS_DATA','CREDENTIAL_DIRECTORIES','CONFIGURATION_AND_RUNNERS'];
const SQLITE_DATA_KIND='SQLITE_IMAGE_V1',MAX_SQLITE_ATTACHMENTS=24,SQLITE_IMAGE_FILE_LIMIT=67108864,MANIFEST_FILE_LIMIT=4000000;
function fail(code:string):never{throw new DomainError(code,409);}
const snapshotId=(id:string)=>{if(!/^snapshot_[a-f0-9]{32}$/.test(id))fail('MAINTENANCE_ID_INVALID');return id;};
const sqliteAttachmentPath=(operation:string)=>'sqlite-images/'+operation+'.sqlite';
const isHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const digestFile=(path:string):StateFile=>{
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>SNAPSHOT_FILE_LIMIT)fail('MAINTENANCE_FILE_DENIED');
 const fd=openSync(path,'r'),digest=createHash('sha256'),bytes=Buffer.alloc(65536);let total=0;
 try{for(let count;(count=readSync(fd,bytes,0,bytes.length,null))>0;){total+=count;if(total>SNAPSHOT_FILE_LIMIT)fail('MAINTENANCE_FILE_DENIED');digest.update(bytes.subarray(0,count));}}
 finally{closeSync(fd);}
 if(total!==stat.size)fail('MAINTENANCE_SNAPSHOT_CHANGED');return {path:'application.sqlite',bytes:total,sha256:digest.digest('hex')};
};
function digestLimited(path:string,limit:number):{bytes:number;sha256:string}{
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>limit)fail('MAINTENANCE_FILE_DENIED');
 const fd=openSync(path,'r'),digest=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0;
 try{for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){total+=count;if(total>limit)fail('MAINTENANCE_FILE_DENIED');digest.update(buffer.subarray(0,count));}}
 finally{closeSync(fd);}
 if(total!==stat.size)fail('MAINTENANCE_SNAPSHOT_CHANGED');return {bytes:total,sha256:digest.digest('hex')};
}
function sqliteAttachments(db:DatabaseSync):StateSqliteAttachment[]{
 const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_dataset_versions'").get();
 if(!table)return [];
 const pending=Number(db.prepare('SELECT count(*) n FROM business_image_intents i LEFT JOIN managed_dataset_operations o ON o.operation_hash=i.operation_hash WHERE o.operation_hash IS NULL').get()?.n??0);
 if(pending)fail('MAINTENANCE_SQLITE_OPERATION_UNCERTAIN');
 const rows=db.prepare('SELECT * FROM managed_dataset_versions WHERE kind=? ORDER BY project_id,revision LIMIT 25').all(SQLITE_DATA_KIND);
 if(rows.length>MAX_SQLITE_ATTACHMENTS)fail('MAINTENANCE_SQLITE_ATTACHMENT_LIMIT');
 const heads=new Map(db.prepare('SELECT project_id,revision FROM managed_dataset_heads WHERE kind=?').all(SQLITE_DATA_KIND).map(row=>[String(row.project_id),Number(row.revision)])),
  operations=new Map(db.prepare('SELECT operation_hash,project_id,kind,applied_revision FROM managed_dataset_operations WHERE kind=?').all(SQLITE_DATA_KIND).map(row=>[String(row.operation_hash),row])),
  byProject=new Map<string,ReturnType<typeof decodeSqliteVersion>[]>();
 for(const row of rows){const value=decodeSqliteVersion(row),list=byProject.get(value.projectId)??[];list.push(value);byProject.set(value.projectId,list);}
 const result:StateSqliteAttachment[]=[];
 for(const [projectId,versions] of byProject){
  versions.sort((a,b)=>a.revision-b.revision);if(heads.get(projectId)!==versions.length)fail('MAINTENANCE_DATABASE_INVALID');
  for(let index=0;index<versions.length;index++){
   const value=versions[index];if(value.revision!==index+1||value.parentRevision!==(index?versions[index-1].revision:null)||value.parentHash!==(index?versions[index-1].contentHash:null))fail('MAINTENANCE_DATABASE_INVALID');
   const operation=operations.get(value.image.operationHash);
   if(!operation||String(operation.project_id)!==projectId||String(operation.kind)!==SQLITE_DATA_KIND||Number(operation.applied_revision)!==value.revision)fail('MAINTENANCE_DATABASE_INVALID');
   result.push({path:sqliteAttachmentPath(value.image.operationHash),projectId,revision:value.revision,operationHash:value.image.operationHash,
    bytes:value.image.imageBytes,sha256:value.image.imageHash,contentHash:value.contentHash,sourceRunId:value.sourceRunId,sourceTreeHash:value.sourceTreeHash});
  }
 }
 if(new Set(result.map(item=>item.operationHash)).size!==result.length||operations.size!==result.length)fail('MAINTENANCE_DATABASE_INVALID');
 return result.sort((a,b)=>a.operationHash<b.operationHash?-1:a.operationHash>b.operationHash?1:0);
}
function inspectApplication(path:string):{counts:ApplicationStateCounts;attachments:StateSqliteAttachment[]}{
 const db=new DatabaseSync(path,{readOnly:true});try{
  if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok'))fail('MAINTENANCE_DATABASE_INVALID');
  const schema=Number(db.prepare('SELECT max(version) v FROM schema_versions').get()?.v);if(![2,3,4,5,6,7,8,9].includes(schema))fail('MAINTENANCE_SCHEMA_UNSUPPORTED');
  if(db.prepare('PRAGMA foreign_key_check').all().length)fail('MAINTENANCE_DATABASE_INVALID');
  if(Number(db.prepare('SELECT count(*) n FROM plan_versions').get()!.n)>100000)fail('MAINTENANCE_DATABASE_LIMIT');
  const versions=db.prepare('SELECT * FROM plan_versions LIMIT 100001').all();if(versions.length>100000)fail('MAINTENANCE_DATABASE_LIMIT');
  for(const row of versions){const value={id:row.id,projectId:row.project_id,revision:Number(row.revision),parentId:row.parent_id,specHash:row.spec_hash,origin:row.origin,snapshot:JSON.parse(String(row.snapshot)),source:JSON.parse(String(row.source))};if(hash(value)!==row.content_hash)fail('PLAN_INTEGRITY_FAILED');}
  const counts={} as ApplicationStateCounts;
  for(const [name,table] of Object.entries({projects:'projects',planVersions:'plan_versions',approvals:'approvals',runs:'runs',records:'records',events:'events'}))counts[name as Exclude<keyof ApplicationStateCounts,'managedData'>]=Number(db.prepare('SELECT count(*) n FROM '+table).get()!.n);
  if(counts.runs>100000)fail('MAINTENANCE_DATABASE_LIMIT');
  for(const row of db.prepare('SELECT data FROM runs LIMIT 100001').iterate())assertFlowSnapshot(JSON.parse(String(row.data)) as Run);
  if(schema>=3)counts.managedData=inspectManagedData(db);
  if(schema>=7){
   counts.engineeringProfiles=Number(db.prepare('SELECT count(*) n FROM engineering_profiles').get()!.n);
   if(counts.engineeringProfiles>100000)fail('MAINTENANCE_DATABASE_LIMIT');
   for(const row of db.prepare('SELECT DISTINCT project_id FROM engineering_profiles').iterate())readFlowProfiles(db,String(row.project_id));
  }
   return {counts,attachments:schema>=5?sqliteAttachments(db):[]};
 }finally{db.close();}
}
function inspectBudget(path:string):{requests:number}{
 const db=new DatabaseSync(path,{readOnly:true});try{
  if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok'))fail('MAINTENANCE_DATABASE_INVALID');
  if(Number(db.prepare('SELECT count(*) n FROM requests').get()!.n)>100000)fail('MAINTENANCE_DATABASE_LIMIT');
  const rows=db.prepare('SELECT data FROM requests LIMIT 100001').all();if(rows.length>100000)fail('MAINTENANCE_DATABASE_LIMIT');
  if(rows.some(row=>JSON.parse(String(row.data)).usageStatus==='PENDING'))fail('MAINTENANCE_BUDGET_IN_FLIGHT');return {requests:rows.length};
 }finally{db.close();}
}
function snapshotArtifacts(value:StateSnapshot):StateFile[]{return [...value.files,...(value.attachments??[]).map(item=>({path:item.path,bytes:item.bytes,sha256:item.sha256}))];}
/** Consistent controller state only. Restoring a working database or business files is not authorized here. */
export class StateMaintenance {
 constructor(private context:{store:Store;data:string;root?:string;isBusy:()=>boolean;captureBudget?:(path:string)=>boolean}){}
 private base(){return within(this.context.data,'controller/state-backups');}
 private folder(id:string){return within(this.context.data,'controller/state-backups/'+snapshotId(id));}
 private root(){const value=this.context.root;if(!value||typeof value!=='string')fail('MAINTENANCE_CUSTODY_UNAVAILABLE');return value;}
 private custody<T>(action:(lease:Parameters<Parameters<typeof withWindowsStorageCustody>[2]>[0])=>Promise<T>):Promise<T>{
  const binding={store:this.context.store,projectId:null,runId:null,dispatchId:'maintenance_state_store_'+randomUUID(),generation:'maintenance_state_store_'+randomUUID(),mode:'live' as const};
  return withProcessOwnership(binding,()=>withWindowsStorageCustody(this.root(),this.context.data,action,{timeoutMs:120000}));
 }
 private folderBytes(folder:string){
  let bytes=0;
  for(const entry of readdirSync(folder,{withFileTypes:true})){
   const path=within(folder,entry.name),stat=lstatSync(path);
   if(entry.name==='sqlite-images'&&stat.isDirectory()&&!stat.isSymbolicLink()){
    const names=readdirSync(path);if(names.length>MAX_SQLITE_ATTACHMENTS)fail('MAINTENANCE_STORAGE_UNKNOWN');
    for(const name of names){if(!/^[a-f0-9]{64}\.sqlite$/.test(name))fail('MAINTENANCE_STORAGE_UNKNOWN');const file=within(path,name),info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>SQLITE_IMAGE_FILE_LIMIT)fail('MAINTENANCE_STORAGE_UNKNOWN');bytes+=info.size;}
   }else{
    if(!['application.sqlite','budget.sqlite','manifest.json'].includes(entry.name)||!stat.isFile()||stat.isSymbolicLink())fail('MAINTENANCE_STORAGE_UNKNOWN');bytes+=stat.size;
   }
  }
  return bytes;
 }
 usage(){
  let bytes=0;const counts={snapshots:0,rehearsals:0};
  for(const [name,key,pattern] of [['state-backups','snapshots',/^snapshot_[a-f0-9]{32}$/],['state-rehearsals','rehearsals',/^rehearsal_[a-f0-9]{32}$/]] as const){
   const base=within(this.context.data,'controller/'+name);if(!existsSync(base))continue;const entries=readdirSync(base);if(entries.length>100)fail('MAINTENANCE_STORAGE_LIMIT');
   counts[key]=entries.length;
   for(const id of entries){if(!pattern.test(id))fail('MAINTENANCE_STORAGE_UNKNOWN');const folder=within(base,id);if(!lstatSync(folder).isDirectory())fail('MAINTENANCE_STORAGE_UNKNOWN');
     bytes+=this.folderBytes(folder);
   }
  }
  return {...counts,bytes:maintenanceStorageBytes(this.context.data),limitBytes:1000000000};
 }
 /** Conservative reservation before a composed backup creates its own state copy. */
 snapshotReservationBytes(){return snapshotDatabaseBytes(this.context.store.db)+(this.context.captureBudget?SNAPSHOT_FILE_LIMIT:0)+this.sqliteAttachments().reduce((total,item)=>total+item.bytes,0)+32000;}
 private room(kind:'snapshots'|'rehearsals',additionalBytes:number,files=3,directories=4){
  const usage=this.usage();if(usage[kind]>=50)fail(kind==='snapshots'?'MAINTENANCE_SNAPSHOT_LIMIT':'MAINTENANCE_REHEARSAL_LIMIT');
   const disk=statfsSync(this.context.data,{bigint:true});assertMaintenanceRoom(usage.bytes,additionalBytes,disk.bavail*disk.bsize,'MAINTENANCE_STORAGE_LIMIT',{files,directories,unit:disk.bsize});
 }
 private sqliteAttachments(){return sqliteAttachments(this.context.store.db);}
 private idle(){
  within(this.context.data,'controller/state-backups');
  if(this.context.isBusy())fail('MAINTENANCE_BUSY');
  if(this.context.store.db.prepare('SELECT count(*) n FROM workspace_leases').get()!.n)fail('MAINTENANCE_WRITER_UNSETTLED');
  if(this.context.store.path===':memory:'||resolve(dirname(this.context.store.path))!==resolve(this.context.data))fail('MAINTENANCE_STORE_MISMATCH');
 }
 private read(id:string):StateSnapshot {
  const path=within(this.folder(id),'manifest.json');if(!existsSync(path))fail('MAINTENANCE_SNAPSHOT_INCOMPLETE');
   if(lstatSync(path).size>MANIFEST_FILE_LIMIT)fail('MAINTENANCE_MANIFEST_INVALID');let value:StateSnapshot;try{value=JSON.parse(readFileSync(path,'utf8'));}catch{fail('MAINTENANCE_MANIFEST_INVALID');}
   if(!value||!['dream-maker.state-snapshot.v1','dream-maker.state-snapshot.v2'].includes(value.schema)||value.id!==id||value.scope!=='APPLICATION_STATE_ONLY'||value.completeProjectBackup!==false||value.status!=='VERIFIED'||!/^[a-f0-9]{64}$/.test(value.operationHash)||value.operationHash.slice(0,32)!==id.slice(9)||!Array.isArray(value.files)||value.files.length<1||value.files.length>2||JSON.stringify(value.exclusions)!==JSON.stringify(exclusions))fail('MAINTENANCE_MANIFEST_INVALID');
  if(value.files[0].path!=='application.sqlite'||new Set(value.files.map(file=>file.path)).size!==value.files.length||value.files.some(file=>!['application.sqlite','budget.sqlite'].includes(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>256000000||!/^[a-f0-9]{64}$/.test(file.sha256)))fail('MAINTENANCE_MANIFEST_INVALID');
   if(!['CAPTURED','UNAVAILABLE'].includes(value.budget?.status)||(value.budget.status==='CAPTURED')!==value.files.some(file=>file.path==='budget.sqlite'))fail('MAINTENANCE_MANIFEST_INVALID');
   if(value.schema==='dream-maker.state-snapshot.v1'){
    if(value.attachments!==undefined||value.sqliteImages!==undefined)fail('MAINTENANCE_MANIFEST_INVALID');
   }else{
    if(!Array.isArray(value.attachments)||value.attachments.length>MAX_SQLITE_ATTACHMENTS||!value.sqliteImages||!['NONE','CAPTURED'].includes(value.sqliteImages.status)||
      !Number.isSafeInteger(value.sqliteImages.files)||value.sqliteImages.files<0||value.sqliteImages.files>MAX_SQLITE_ATTACHMENTS||!Number.isSafeInteger(value.sqliteImages.bytes)||value.sqliteImages.bytes<0)fail('MAINTENANCE_MANIFEST_INVALID');
    const operations=new Set<string>();
    for(const item of value.attachments){
     if(!item||item.path!==sqliteAttachmentPath(item.operationHash)||operations.has(item.operationHash)||typeof item.projectId!=='string'||!item.projectId||
      !Number.isSafeInteger(item.revision)||item.revision<1||!isHash(item.operationHash)||!Number.isSafeInteger(item.bytes)||item.bytes<512||item.bytes>SQLITE_IMAGE_FILE_LIMIT||item.bytes%512||
      !isHash(item.sha256)||!isHash(item.contentHash)||typeof item.sourceRunId!=='string'||!item.sourceRunId||!isHash(item.sourceTreeHash))fail('MAINTENANCE_MANIFEST_INVALID');
     operations.add(item.operationHash);
    }
    const attachmentBytes=value.attachments.reduce((total,item)=>total+item.bytes,0);
    if(value.sqliteImages.files!==value.attachments.length||value.sqliteImages.bytes!==attachmentBytes||(value.attachments.length===0)!==(value.sqliteImages.status==='NONE'))fail('MAINTENANCE_MANIFEST_INVALID');
   }
   return value;
 }
 list(){
  const base=this.base();if(!existsSync(base))return [];
  return readdirSync(base).filter(id=>/^snapshot_[a-f0-9]{32}$/.test(id)).sort().map(id=>{try{const value=this.read(id);return {...value,status:'RECORDED_NOT_RECHECKED' as const};}catch{return {id,status:'INCOMPLETE_OR_INVALID' as const,scope:'APPLICATION_STATE_ONLY' as const,completeProjectBackup:false as const};}});
 }
 create(operation:string):StateSnapshot {
  this.idle();const operationHash=hash(operation),id='snapshot_'+operationHash.slice(0,32),folder=this.folder(id);
  if(existsSync(folder))return this.verify(id);
   if(this.sqliteAttachments().length)fail('MAINTENANCE_SQLITE_IMAGES_REQUIRED');
   const bytes=snapshotDatabaseBytes(this.context.store.db);this.room('snapshots',bytes+(this.context.captureBudget?SNAPSHOT_FILE_LIMIT:0)+32000);
  mkdirSync(this.base(),{recursive:true,mode:0o700});within(this.context.data,'controller/state-backups');mkdirSync(folder,{mode:0o700});
  const application=within(folder,'application.sqlite');captureDatabaseState(this.context.store.db,application);const applicationFile=digestFile(application);
   const applicationCounts=inspectApplication(application).counts;
  const budgetFile=within(folder,'budget.sqlite'),captured=this.context.captureBudget?.(budgetFile)===true;
  const files:StateFile[]=[applicationFile];if(captured)files.push({...digestFile(budgetFile),path:'budget.sqlite'});
   const budget:StateSnapshot['budget']=captured?{status:'CAPTURED',...inspectBudget(budgetFile)}:{status:'UNAVAILABLE'};
  const value:StateSnapshot={schema:'dream-maker.state-snapshot.v1',id,operationHash,createdAt:new Date().toISOString(),scope:'APPLICATION_STATE_ONLY',completeProjectBackup:false,status:'VERIFIED',application:applicationCounts,budget,files,exclusions};
  writeFileSync(within(folder,'manifest.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  const verified=this.verifySnapshot(id,true);
  this.context.store.db.prepare('INSERT INTO state_snapshot_anchors VALUES(?,?,?)').run(id,hash(verified),verified.createdAt);return this.verify(id);
 }
 async createCustodied(operation:string):Promise<StateSnapshot>{
   this.idle();const operationHash=hash(operation),id='snapshot_'+operationHash.slice(0,32),folder=this.folder(id);
   if(existsSync(folder))return this.verify(id);
   const attachments=this.sqliteAttachments();
   if(!attachments.length)return this.create(operation);
   const databaseBytes=snapshotDatabaseBytes(this.context.store.db),attachmentBytes=attachments.reduce((total,item)=>total+item.bytes,0);
   this.room('snapshots',databaseBytes+(this.context.captureBudget?SNAPSHOT_FILE_LIMIT:0)+attachmentBytes+32000,3+attachments.length,5);
   const verified=await this.custody(async lease=>{
    const base='controller/state-backups',relative=base+'/'+id,images=relative+'/sqlite-images';
    await lease.directory(base,true);lease.assertActive();await lease.directory(relative,true);lease.assertActive();await lease.directory(images,true);lease.assertActive();
    const application=within(folder,'application.sqlite');captureDatabaseState(this.context.store.db,application);lease.assertActive();
    const applicationFile=digestFile(application),applicationDetails=inspectApplication(application);
    if(hash(applicationDetails.attachments)!==hash(attachments))fail('MAINTENANCE_DATABASE_CHANGED');
    const budgetFile=within(folder,'budget.sqlite'),captured=this.context.captureBudget?.(budgetFile)===true;lease.assertActive();
    const files:StateFile[]=[applicationFile];if(captured)files.push({...digestFile(budgetFile),path:'budget.sqlite'});
    const budget:StateSnapshot['budget']=captured?{status:'CAPTURED',...inspectBudget(budgetFile)}:{status:'UNAVAILABLE'};
    for(const item of attachments){
     const source='controller/sqlite-images/'+hash(item.projectId),from=within(this.context.data,source+'/'+item.operationHash+'.sqlite');
     await lease.image(source,item.operationHash,item.bytes,item.sha256);lease.assertActive();
     const to=within(folder,item.path);copyFileSync(from,to,COPYFILE_EXCL);if(digestLimited(from,SQLITE_IMAGE_FILE_LIMIT).sha256!==item.sha256)fail('MAINTENANCE_SQLITE_IMAGE_CHANGED');
     const actual=digestLimited(to,SQLITE_IMAGE_FILE_LIMIT);if(actual.bytes!==item.bytes||actual.sha256!==item.sha256)fail('MAINTENANCE_SQLITE_IMAGE_CHANGED');
     await lease.image(images,item.operationHash,item.bytes,item.sha256);lease.assertActive();
    }
    if(hash(this.sqliteAttachments())!==hash(attachments))fail('MAINTENANCE_DATABASE_CHANGED');
    const value:StateSnapshot={schema:'dream-maker.state-snapshot.v2',id,operationHash,createdAt:new Date().toISOString(),scope:'APPLICATION_STATE_ONLY',completeProjectBackup:false,status:'VERIFIED',
      application:applicationDetails.counts,budget,files,sqliteImages:{status:'CAPTURED',files:attachments.length,bytes:attachmentBytes},attachments,exclusions};
    writeFileSync(within(folder,'manifest.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    lease.assertActive();const result=this.verifySnapshot(id,true);lease.assertActive();return result;
   });
   this.context.store.db.prepare('INSERT INTO state_snapshot_anchors VALUES(?,?,?)').run(id,hash(verified),verified.createdAt);return this.verify(id);
 }
 verify(id:string):StateSnapshot {
  return this.verifySnapshot(id,false);
 }
 private verifySnapshot(id:string,allowUnanchoredNew:boolean):StateSnapshot {
  const value=this.read(snapshotId(id)),folder=this.folder(id);
  const anchor=this.context.store.db.prepare('SELECT manifest_hash FROM state_snapshot_anchors WHERE snapshot_id=?').get(id);
  if(anchor&&anchor.manifest_hash!==hash(value))fail('MAINTENANCE_SNAPSHOT_ANCHOR_MISMATCH');
  if(!anchor&&value.application.managedData&&!allowUnanchoredNew)fail('MAINTENANCE_SNAPSHOT_UNANCHORED');
   for(const file of value.files){
    const path=within(folder,file.path),actual=file.path==='application.sqlite'?digestFile(path):{...digestFile(path),path:'budget.sqlite'};
    if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)fail('MAINTENANCE_SNAPSHOT_CHANGED');
    if(file.path==='application.sqlite'){
     const details=inspectApplication(path);if(hash(details.counts)!==hash(value.application))fail('MAINTENANCE_MANIFEST_INVALID');
     if(value.schema==='dream-maker.state-snapshot.v1'){if(details.attachments.length)fail('MAINTENANCE_MANIFEST_INVALID');}
     else if(hash(details.attachments)!==hash(value.attachments))fail('MAINTENANCE_MANIFEST_INVALID');
    }else if(inspectBudget(path).requests!==value.budget.requests)fail('MAINTENANCE_MANIFEST_INVALID');
   }
   const images=within(folder,'sqlite-images');
   if(value.schema==='dream-maker.state-snapshot.v2'){
    for(const item of value.attachments!){
     const path=within(folder,item.path),actual=digestLimited(path,SQLITE_IMAGE_FILE_LIMIT);
     if(actual.bytes!==item.bytes||actual.sha256!==item.sha256)fail('MAINTENANCE_SNAPSHOT_CHANGED');
    }
    if(existsSync(images)){if(!lstatSync(images).isDirectory()||readdirSync(images).length!==value.attachments!.length)fail('MAINTENANCE_SNAPSHOT_CHANGED');}
    else if(value.attachments!.length)fail('MAINTENANCE_SNAPSHOT_INCOMPLETE');
   }
  return value;
 }
 private verifyRehearsal(snapshot:StateSnapshot,rid:string,identity:Omit<RestoreRehearsal,'createdAt'>):RestoreRehearsal {
   const folder=within(this.context.data,'controller/state-rehearsals/'+rid),recordPath=within(folder,'manifest.json');
   if(!existsSync(recordPath)||lstatSync(recordPath).size>MANIFEST_FILE_LIMIT)fail('MAINTENANCE_REHEARSAL_INCOMPLETE');
   let record:RestoreRehearsal;try{record=JSON.parse(readFileSync(recordPath,'utf8'));}catch{fail('MAINTENANCE_REHEARSAL_CHANGED');}
   const {createdAt,...stored}=record;
   if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt)||!Number.isFinite(Date.parse(createdAt))||hash(stored)!==hash(identity))fail('MAINTENANCE_REHEARSAL_CHANGED');
   const artifacts=snapshotArtifacts(snapshot),expected=new Set([...artifacts.map(file=>file.path),'manifest.json']);
   for(const entry of readdirSync(folder,{withFileTypes:true})){
     const path=within(folder,entry.name),info=lstatSync(path);
     if(entry.name==='sqlite-images'&&info.isDirectory()&&!info.isSymbolicLink()){
       for(const name of readdirSync(path)){
         if(!expected.has('sqlite-images/'+name)||!lstatSync(within(path,name)).isFile()||lstatSync(within(path,name)).isSymbolicLink())fail('MAINTENANCE_REHEARSAL_CHANGED');
       }
     }else if(!expected.has(entry.name)||!info.isFile()||info.isSymbolicLink())fail('MAINTENANCE_REHEARSAL_CHANGED');
   }
   for(const file of artifacts){
     const path=within(folder,file.path),actual=digestLimited(path,file.path==='application.sqlite'||file.path==='budget.sqlite'?SNAPSHOT_FILE_LIMIT:SQLITE_IMAGE_FILE_LIMIT);
     if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)fail('MAINTENANCE_REHEARSAL_CHANGED');
     if(file.path==='application.sqlite'){const details=inspectApplication(path);if(hash(details.counts)!==hash(snapshot.application)||hash(details.attachments)!==hash(snapshot.attachments??[]))fail('MAINTENANCE_REHEARSAL_CHANGED');}
     if(file.path==='budget.sqlite'&&inspectBudget(path).requests!==snapshot.budget.requests)fail('MAINTENANCE_REHEARSAL_CHANGED');
   }
   return record;
 }
 /** Internal data-only source. The caller supplies IDs, never paths or a claimed verification flag. */
 managedDataSource(id:string,rid:string,pid:string):ManagedDataRestoreSource {
  const source=this.dataSource(id,rid,pid,FIXED_DEMO_DATA_KIND);if(source.version.kind!==FIXED_DEMO_DATA_KIND)fail('MANAGED_DATA_RESTORE_SOURCE_INVALID');return {...source,version:source.version};
 }
 jsonDataSource(id:string,rid:string,pid:string):JsonDataRestoreSource {
  const source=this.dataSource(id,rid,pid,JSON_DATA_KIND);if(source.version.kind!==JSON_DATA_KIND)fail('JSON_DATA_RESTORE_SOURCE_INVALID');return {...source,version:source.version};
 }
 async sqliteDataSource(id:string,rid:string,pid:string):Promise<SqliteDataRestoreSource>{
  this.idle();snapshotId(id);
  if(!/^rehearsal_[a-f0-9]{32}$/.test(rid)||typeof pid!=='string'||!pid)fail('MAINTENANCE_ID_INVALID');
  return this.custody(async lease=>{
   const snapshotFolder='controller/state-backups/'+id,rehearsalFolder='controller/state-rehearsals/'+rid;
   await lease.directory(snapshotFolder);lease.assertActive();
   await lease.directory(rehearsalFolder);lease.assertActive();
   const snapshot=this.verify(id);
   if(!snapshot.attachments?.length)fail('MAINTENANCE_SQLITE_IMAGES_REQUIRED');
   if(!this.context.store.db.prepare('SELECT 1 FROM state_snapshot_anchors WHERE snapshot_id=?').get(id))fail('MAINTENANCE_SNAPSHOT_UNANCHORED');
   for(const file of snapshot.files){await lease.file(snapshotFolder+'/'+file.path,file.bytes,file.sha256);lease.assertActive();}
   if(snapshot.attachments.length){
    await lease.directory(snapshotFolder+'/sqlite-images');lease.assertActive();
    await lease.directory(rehearsalFolder+'/sqlite-images');lease.assertActive();
   }
   const folder=within(this.context.data,rehearsalFolder),recordPath=within(folder,'manifest.json');
   if(!existsSync(recordPath)||lstatSync(recordPath).size>MANIFEST_FILE_LIMIT)fail('MAINTENANCE_REHEARSAL_INCOMPLETE');
   let record:RestoreRehearsal;try{record=JSON.parse(readFileSync(recordPath,'utf8'));}catch{fail('MAINTENANCE_REHEARSAL_CHANGED');}
   if(!record||typeof record.operationHash!=='string'||!/^[a-f0-9]{64}$/.test(record.operationHash)||record.operationHash.slice(0,32)!==rid.slice(10))fail('MAINTENANCE_REHEARSAL_CHANGED');
   const {createdAt,...stored}=record,sourceManifestHash=hash(snapshot),expected:Omit<RestoreRehearsal,'createdAt'>={schema:'dream-maker.state-rehearsal.v1',id:rid,operationHash:record.operationHash,sourceManifestHash,snapshotId:id,scope:'READONLY_RESTORE_REHEARSAL_ONLY',engineStarted:false,application:snapshot.application,budget:snapshot.budget};
   if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt)||!Number.isFinite(Date.parse(createdAt))||hash(stored)!==hash(expected))fail('MAINTENANCE_REHEARSAL_CHANGED');
    // Verify stable rehearsal bytes through the pinned directory before asking the
    // keeper to pin them. A keeper refusal closes that job, so a pre-existing
    // changed artifact must be classified as a rehearsal error, not a transport one.
   this.verifyRehearsal(snapshot,rid,expected);
    for(const item of snapshot.attachments){
     await lease.image(snapshotFolder+'/sqlite-images',item.operationHash,item.bytes,item.sha256);lease.assertActive();
     await lease.image(rehearsalFolder+'/sqlite-images',item.operationHash,item.bytes,item.sha256);lease.assertActive();
    }
   for(const file of snapshot.files){await lease.file(rehearsalFolder+'/'+file.path,file.bytes,file.sha256);lease.assertActive();}
   lease.assertActive();
   const db=new DatabaseSync(within(folder,'application.sqlite'),{readOnly:true});
   try{
    db.exec('BEGIN');
    if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok')||db.prepare('PRAGMA foreign_key_check').all().length)fail('MAINTENANCE_REHEARSAL_CHANGED');
    const attachments=sqliteAttachments(db);if(hash(attachments)!==hash(snapshot.attachments!))fail('MAINTENANCE_REHEARSAL_CHANGED');
    const row=db.prepare('SELECT v.* FROM managed_dataset_heads h JOIN managed_dataset_versions v ON v.project_id=h.project_id AND v.kind=h.kind AND v.revision=h.revision WHERE h.project_id=? AND h.kind=?').get(pid,SQLITE_DATA_KIND);
    if(!row)fail('MAINTENANCE_SQLITE_IMAGE_EMPTY');
    const version=decodeSqliteVersion(row),attachment=attachments.find(item=>item.projectId===pid&&item.revision===version.revision);
    if(!attachment||attachment.operationHash!==version.image.operationHash||attachment.bytes!==version.image.imageBytes||attachment.sha256!==version.image.imageHash||attachment.contentHash!==version.contentHash)fail('MAINTENANCE_REHEARSAL_CHANGED');
    const path=within(folder,attachment.path),stat=lstatSync(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==attachment.bytes||stat.size>SQLITE_IMAGE_FILE_LIMIT)fail('MAINTENANCE_REHEARSAL_CHANGED');
    const image=readFileSync(path);if(image.length!==attachment.bytes||hash(image)!==attachment.sha256)fail('MAINTENANCE_REHEARSAL_CHANGED');
    db.exec('COMMIT');lease.assertActive();
    return {snapshotId:id,rehearsalId:rid,sourceManifestHash,version,image};
   }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
  });
 }
 private dataSource(id:string,rid:string,pid:string,kind:typeof FIXED_DEMO_DATA_KIND|typeof JSON_DATA_KIND){
  this.idle();const snapshot=this.verify(id);
  if(!snapshot.application.managedData||!this.context.store.db.prepare('SELECT 1 FROM state_snapshot_anchors WHERE snapshot_id=?').get(id))fail('MAINTENANCE_SNAPSHOT_UNANCHORED');
  if(!/^rehearsal_[a-f0-9]{32}$/.test(rid))fail('MAINTENANCE_ID_INVALID');
  const folder=within(this.context.data,'controller/state-rehearsals/'+rid),recordPath=within(folder,'manifest.json');
   if(!existsSync(recordPath)||lstatSync(recordPath).size>MANIFEST_FILE_LIMIT)fail('MAINTENANCE_REHEARSAL_INCOMPLETE');
  let record:RestoreRehearsal;try{record=JSON.parse(readFileSync(recordPath,'utf8'));}catch{fail('MAINTENANCE_REHEARSAL_CHANGED');}
  if(!record||typeof record.operationHash!=='string'||!/^[a-f0-9]{64}$/.test(record.operationHash)||record.operationHash.slice(0,32)!==rid.slice(10))fail('MAINTENANCE_REHEARSAL_CHANGED');
  const {createdAt,...stored}=record,sourceManifestHash=hash(snapshot),expected={schema:'dream-maker.state-rehearsal.v1',id:rid,operationHash:record.operationHash,sourceManifestHash,snapshotId:id,scope:'READONLY_RESTORE_REHEARSAL_ONLY',engineStarted:false,application:snapshot.application,budget:snapshot.budget};
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt)||!Number.isFinite(Date.parse(createdAt))||hash(stored)!==hash(expected))fail('MAINTENANCE_REHEARSAL_CHANGED');
   for(const file of snapshotArtifacts(snapshot)){
    const path=within(folder,file.path),actual=digestLimited(path,file.path==='application.sqlite'||file.path==='budget.sqlite'?SNAPSHOT_FILE_LIMIT:SQLITE_IMAGE_FILE_LIMIT);
    if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)fail('MAINTENANCE_REHEARSAL_CHANGED');
    if(file.path==='application.sqlite'){const details=inspectApplication(path);if(hash(details.counts)!==hash(snapshot.application)||hash(details.attachments)!==hash(snapshot.attachments??[]))fail('MAINTENANCE_REHEARSAL_CHANGED');}
    if(file.path==='budget.sqlite'&&inspectBudget(path).requests!==snapshot.budget.requests)fail('MAINTENANCE_REHEARSAL_CHANGED');
  }
  const db=new DatabaseSync(within(folder,'application.sqlite'),{readOnly:true});db.exec('BEGIN');try{
   // Bind the extracted rows to the anchored data root in this same read transaction.
   // A previously verified path can be replaced before a later connection is opened.
   if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok')||db.prepare('PRAGMA foreign_key_check').all().length||hash(inspectManagedData(db))!==hash(snapshot.application.managedData))fail('MAINTENANCE_REHEARSAL_CHANGED');
   const row=db.prepare('SELECT v.* FROM managed_dataset_heads h JOIN managed_dataset_versions v ON v.project_id=h.project_id AND v.kind=h.kind AND v.revision=h.revision WHERE h.project_id=? AND h.kind=?').get(pid,kind);
   if(!row)fail('MANAGED_DATA_SNAPSHOT_EMPTY');
   const version=kind===JSON_DATA_KIND?decodeJsonVersion(row):decodeManagedVersion(row);db.exec('COMMIT');return {snapshotId:id,rehearsalId:rid,sourceManifestHash,version};
  }catch(error){db.exec('ROLLBACK');throw error;}finally{db.close();}
 }
 rehearse(id:string,operation:string):RestoreRehearsal {
   this.idle();const snapshot=this.verify(id);if(snapshot.attachments?.length)fail('MAINTENANCE_SQLITE_IMAGES_REQUIRED');
   const sourceManifestHash=hash(snapshot),operationHash=hash(operation),rid='rehearsal_'+operationHash.slice(0,32),base=within(this.context.data,'controller/state-rehearsals'),folder=within(this.context.data,'controller/state-rehearsals/'+rid);
  const recordPath=within(folder,'manifest.json');
  const identity={schema:'dream-maker.state-rehearsal.v1' as const,id:rid,operationHash,sourceManifestHash,snapshotId:id,scope:'READONLY_RESTORE_REHEARSAL_ONLY' as const,engineStarted:false as const,application:snapshot.application,budget:snapshot.budget};
  if(existsSync(folder)){
   if(!existsSync(recordPath))fail('MAINTENANCE_REHEARSAL_INCOMPLETE');if(lstatSync(recordPath).size>32000)fail('MAINTENANCE_REHEARSAL_CHANGED');
   let record:RestoreRehearsal;try{record=JSON.parse(readFileSync(recordPath,'utf8'));}catch{fail('MAINTENANCE_REHEARSAL_CHANGED');}
   const {createdAt,...stored}=record;if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt)||!Number.isFinite(Date.parse(createdAt))||hash(stored)!==hash(identity))fail('MAINTENANCE_REHEARSAL_CHANGED');
   for(const file of snapshot.files)if(digestFile(within(folder,file.path)).sha256!==file.sha256)fail('MAINTENANCE_REHEARSAL_CHANGED');return record;
  }
  this.room('rehearsals',snapshot.files.reduce((n,file)=>n+file.bytes,32000));
  mkdirSync(base,{recursive:true,mode:0o700});within(this.context.data,'controller/state-rehearsals');mkdirSync(folder,{mode:0o700});
  for(const file of snapshot.files){const from=within(this.folder(id),file.path),to=within(folder,file.path);copyFileSync(from,to,COPYFILE_EXCL);if(digestFile(to).sha256!==file.sha256||digestFile(from).sha256!==file.sha256)fail('MAINTENANCE_SNAPSHOT_CHANGED');if(file.path==='application.sqlite')inspectApplication(to);else inspectBudget(to);}
  const result:RestoreRehearsal={...identity,createdAt:new Date().toISOString()};
  writeFileSync(recordPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
 }
 async rehearseCustodied(id:string,operation:string):Promise<RestoreRehearsal>{
   this.idle();const snapshot=this.verify(id);
   if(!snapshot.attachments?.length)return this.rehearse(id,operation);
   const sourceManifestHash=hash(snapshot),operationHash=hash(operation),rid='rehearsal_'+operationHash.slice(0,32),base=within(this.context.data,'controller/state-rehearsals'),folder=within(this.context.data,'controller/state-rehearsals/'+rid),recordPath=within(folder,'manifest.json');
   const identity={schema:'dream-maker.state-rehearsal.v1' as const,id:rid,operationHash,sourceManifestHash,snapshotId:id,scope:'READONLY_RESTORE_REHEARSAL_ONLY' as const,engineStarted:false as const,application:snapshot.application,budget:snapshot.budget};
   if(existsSync(folder)){
     this.verifySnapshot(id,false);return this.verifyRehearsal(snapshot,rid,identity);
   }
   const bytes=snapshotArtifacts(snapshot).reduce((total,file)=>total+file.bytes,32000);
   this.room('rehearsals',bytes,3+snapshot.attachments.length,5);
   await this.custody(async lease=>{
    const source='controller/state-backups/'+id,destination='controller/state-rehearsals/'+rid;
    await lease.directory(source);lease.assertActive();await lease.directory(destination,true);lease.assertActive();await lease.directory(destination+'/sqlite-images',true);lease.assertActive();
    const verified=this.verifySnapshot(id,false);if(hash(verified)!==hash(snapshot))fail('MAINTENANCE_SNAPSHOT_CHANGED');
    for(const file of verified.files){const from=within(this.folder(id),file.path),to=within(folder,file.path);copyFileSync(from,to,COPYFILE_EXCL);const actual=digestLimited(to,SNAPSHOT_FILE_LIMIT);if(actual.bytes!==file.bytes||actual.sha256!==file.sha256||digestLimited(from,SNAPSHOT_FILE_LIMIT).sha256!==file.sha256)fail('MAINTENANCE_SNAPSHOT_CHANGED');}
    for(const item of verified.attachments!){
     await lease.image(source+'/sqlite-images',item.operationHash,item.bytes,item.sha256);lease.assertActive();
     const from=within(this.folder(id),item.path),to=within(folder,item.path);copyFileSync(from,to,COPYFILE_EXCL);
     const actual=digestLimited(to,SQLITE_IMAGE_FILE_LIMIT);if(actual.bytes!==item.bytes||actual.sha256!==item.sha256||digestLimited(from,SQLITE_IMAGE_FILE_LIMIT).sha256!==item.sha256)fail('MAINTENANCE_SNAPSHOT_CHANGED');
     await lease.image(destination+'/sqlite-images',item.operationHash,item.bytes,item.sha256);lease.assertActive();
    }
     const current=this.verifySnapshot(id,false);if(hash(current)!==hash(snapshot))fail('MAINTENANCE_SNAPSHOT_CHANGED');
     const result:RestoreRehearsal={...identity,createdAt:new Date().toISOString()};writeFileSync(recordPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
     lease.assertActive();this.verifyRehearsal(snapshot,rid,identity);lease.assertActive();
   });
    this.verifySnapshot(id,false);return this.verifyRehearsal(snapshot,rid,identity);
 }
}
