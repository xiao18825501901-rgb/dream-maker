import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {COPYFILE_EXCL} from 'node:constants';
import {existsSync,lstatSync,readdirSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,statfsSync,openSync,readSync,closeSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {Store} from './store.js';
import {StateMaintenance} from './maintenance.js';
import {readWorkspace} from './workspace-location.js';
import {files,get} from './workspace.js';
import {DomainError,hash,within} from './security.js';
import {SNAPSHOT_FILE_LIMIT} from './database-snapshot.js';
import {maintenanceStorageBytes,assertMaintenanceRoom} from './maintenance-storage.js';
import type {RegisteredBackup,RegisteredBackupFile,RegisteredBackupSqliteAttachment,RegisteredExtraction} from '../shared/registered-backup.js';
import {withProcessOwnership} from './flow/process-ownership.js';
import {withWindowsStorageCustody} from './windows-storage-custody.js';
import {pinCustodyParentDirectories} from './storage-custody-paths.js';
const MAX_STORAGE=1000000000,exclusions:RegisteredBackup['exclusions']=['CREDENTIALS','CONFIGURATION_AND_RUNNERS','DEPENDENCY_CACHES_AND_GIT','UNREGISTERED_EXTERNAL_DATA'];
function fail(code:string):never{throw new DomainError(code,409);}
const checkedId=(id:string)=>{if(!/^snapshot_[a-f0-9]{32}$/.test(id))fail('REGISTERED_BACKUP_ID_INVALID');return id;};
function digest(path:string):{bytes:number;sha256:string}{
 let stat;try{stat=lstatSync(path);}catch{fail('REGISTERED_BACKUP_FILE_CHANGED');}if(!stat.isFile()||stat.isSymbolicLink()||stat.size>SNAPSHOT_FILE_LIMIT)fail('REGISTERED_BACKUP_FILE_DENIED');
 const fd=openSync(path,'r'),sha=createHash('sha256'),buffer=Buffer.alloc(65536);let bytes=0;
 try{for(let n;(n=readSync(fd,buffer,0,buffer.length,null))>0;){bytes+=n;if(bytes>SNAPSHOT_FILE_LIMIT)fail('REGISTERED_BACKUP_FILE_DENIED');sha.update(buffer.subarray(0,n));}}finally{closeSync(fd);}
 if(bytes!==stat.size)fail('REGISTERED_BACKUP_FILE_CHANGED');return {bytes,sha256:sha.digest('hex')};
}
/** File custody composes the original state backup and immutable Store anchor. It grants no execution. */
export class RegisteredProjectBackups {
 constructor(private context:{store:Store;data:string;root:string;maintenance:StateMaintenance;isBusy:()=>boolean}){}
 private base(kind:'backups'|'extractions'){return within(this.context.data,'controller/registered-'+kind);}
 private folder(id:string){return within(this.base('backups'),checkedId(id));}
 private idle(){if(this.context.isBusy())fail('MAINTENANCE_BUSY');if(this.context.store.db.prepare('SELECT 1 FROM workspace_leases LIMIT 1').get())fail('MAINTENANCE_WRITER_UNSETTLED');}
 private custody<T>(action:(lease:Parameters<Parameters<typeof withWindowsStorageCustody>[2]>[0])=>Promise<T>):Promise<T>{
  const binding={store:this.context.store,projectId:null,runId:null,dispatchId:'registered_backup_store_'+randomUUID(),generation:'registered_backup_store_'+randomUUID(),mode:'live' as const};
  return withProcessOwnership(binding,()=>withWindowsStorageCustody(this.context.root,this.context.data,action,{timeoutMs:120000}));
 }
 private relative(path:string){const value=relative(resolve(this.context.data),resolve(path));if(!value||isAbsolute(value)||value==='..'||value.startsWith('../')||value.startsWith('..\\'))fail('REGISTERED_BACKUP_FILE_DENIED');return value.split('\\').join('/');}
 private scan(path:string,limit=50000,excludeDependencies=false){
  let entries=0,bytes=0,fileCount=0;const walk=(folder:string,depth:number)=>{if(depth>36)fail('REGISTERED_BACKUP_FILE_LIMIT');for(const entry of readdirSync(folder,{withFileTypes:true})){
   if(excludeDependencies&&['node_modules','.git'].includes(entry.name.toLowerCase()))continue;
   if(++entries>limit||entry.isSymbolicLink())fail('REGISTERED_BACKUP_FILE_DENIED');const target=within(folder,entry.name),stat=lstatSync(target);if(stat.isDirectory())walk(target,depth+1);else if(stat.isFile()){bytes+=stat.size;fileCount++;}else fail('REGISTERED_BACKUP_FILE_DENIED');
  }};if(existsSync(path)){if(!lstatSync(path).isDirectory())fail('REGISTERED_BACKUP_FILE_DENIED');walk(path,0);}return {entries,bytes,fileCount};
 }
 usage(){let bytes=0,entries=0;const counts={backups:0,extractions:0};for(const kind of ['backups','extractions'] as const){const base=this.base(kind);if(!existsSync(base))continue;const names=readdirSync(base);if(names.length>20)fail('REGISTERED_BACKUP_LIMIT');counts[kind]=names.length;for(const name of names){if(!(kind==='backups'?/^snapshot_[a-f0-9]{32}$/:/^recovered_[a-f0-9]{32}$/).test(name))fail('REGISTERED_BACKUP_STORAGE_UNKNOWN');const value=this.scan(within(base,name));bytes+=value.bytes;entries+=value.entries;if(entries>50000||bytes>MAX_STORAGE)fail('REGISTERED_BACKUP_STORAGE_LIMIT');}}return {...counts,bytes:maintenanceStorageBytes(this.context.data),limitBytes:MAX_STORAGE};}
 private room(kind:'backups'|'extractions',additional:number,allocation:{files:number;directories:number}){const usage=this.usage(),disk=statfsSync(this.context.data,{bigint:true});if(usage[kind]>=20)fail('REGISTERED_BACKUP_LIMIT');assertMaintenanceRoom(usage.bytes,additional,disk.bavail*disk.bsize,'REGISTERED_BACKUP_STORAGE_LIMIT',{...allocation,unit:disk.bsize});}
 private directories(paths:string[]){const names=new Set<string>();for(const path of paths){const parts=path.split('/');for(let n=1;n<parts.length;n++){names.add(parts.slice(0,n).join('/'));if(names.size>30000)fail('REGISTERED_BACKUP_FILE_LIMIT');}}return names.size;}
 private sourceBody(workspace:string,file:{path:string;bytes:number;sha256:string}){
  const body=get(workspace,file.path);if(body.length!==file.bytes||hash(body)!==file.sha256)fail('REGISTERED_BACKUP_SOURCE_CHANGED');
  const wal=body.length>=4&&[0x377f0682,0x377f0683].includes(body.readUInt32BE(0));
  if(/\.(?:sqlite|sqlite3|db)(?:-wal|-shm|-journal)?$|-(?:wal|shm|journal)$/i.test(file.path)||body.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))||wal||body.subarray(0,8).equals(Buffer.from([0xd9,0xd5,0x05,0xf9,0x20,0xa1,0x63,0xd7])))fail('REGISTERED_BACKUP_DATABASE_UNREGISTERED');return body;
 }
 private catalog(){
  const runs=this.context.store.runs();if(runs.length>256)fail('REGISTERED_BACKUP_RUN_LIMIT');let count=0,total=0;
  return runs.map(run=>{const workspace=readWorkspace(run,this.context.data);if(!existsSync(workspace))fail('REGISTERED_BACKUP_WORKSPACE_MISSING');this.scan(workspace,5000,true);const catalog=files(workspace);
   for(const file of catalog){this.sourceBody(workspace,file);count++;total+=file.bytes;if(count>10000||total>500000000)fail('REGISTERED_BACKUP_FILE_LIMIT');}
   return {runId:run.id,projectId:run.projectId,recordedSourceHash:run.treeHash,runStateHash:hash(run),sourceHash:hash(catalog),workspace,catalog};});
 }
 private assertStateRuns(path:string,expected:Pick<RegisteredBackup['runs'][number],'runId'|'projectId'|'recordedSourceHash'|'runStateHash'>[]){
  const db=new DatabaseSync(path,{readOnly:true});try{
   const rows=db.prepare('SELECT id,project_id,data FROM runs ORDER BY id LIMIT 257').all();if(rows.length>256)fail('REGISTERED_BACKUP_RUN_LIMIT');
   const actual=rows.map(row=>{const run=JSON.parse(String(row.data));return {runId:String(row.id),projectId:String(row.project_id),recordedSourceHash:run.treeHash,runStateHash:hash(run)};});
   const wanted=expected.map(run=>({runId:run.runId,projectId:run.projectId,recordedSourceHash:run.recordedSourceHash,runStateHash:run.runStateHash})).sort((a,b)=>a.runId<b.runId?-1:a.runId>b.runId?1:0);
   if(hash(actual)!==hash(wanted))fail('REGISTERED_BACKUP_STATE_CHANGED');
  }finally{db.close();}
 }
 private read(id:string):RegisteredBackup{
  const path=within(this.folder(id),'manifest.json');if(!existsSync(path))fail('REGISTERED_BACKUP_MANIFEST_INVALID');const stat=lstatSync(path);if(!stat.isFile()||stat.size>4000000)fail('REGISTERED_BACKUP_MANIFEST_INVALID');let value:RegisteredBackup;
  try{value=JSON.parse(readFileSync(path,'utf8'));}catch{fail('REGISTERED_BACKUP_MANIFEST_INVALID');}
  if(!value||value.schema!=='dream-maker.registered-backup.v2'||value.id!==id||value.scope!=='REGISTERED_STATE_AND_PROJECT_FILES'||value.completeProjectBackup!==false||!value.state||typeof value.state.snapshotId!=='string'||!/^snapshot_[a-f0-9]{32}$/.test(value.state.snapshotId)||!/^[a-f0-9]{64}$/.test(value.state.manifestHash)||!['CAPTURED','UNAVAILABLE'].includes(value.state.budget)||!Array.isArray(value.files)||value.files.length>10002||!Array.isArray(value.runs)||value.runs.length>256)fail('REGISTERED_BACKUP_MANIFEST_INVALID');
  const hasImages=value.state.sqliteImages!==undefined||value.state.attachments!==undefined;
  if(hasImages){
   const summary=value.state.sqliteImages,attachments=value.state.attachments,operations=new Set<string>();
   if(!summary||!['NONE','CAPTURED'].includes(summary.status)||!Number.isSafeInteger(summary.files)||summary.files<0||summary.files>24||!Number.isSafeInteger(summary.bytes)||summary.bytes<0||!Array.isArray(attachments)||attachments.length>24||
    summary.files!==attachments.length||(summary.files===0)!==(summary.status==='NONE')||summary.bytes!==attachments.reduce((total,item)=>total+item.bytes,0))fail('REGISTERED_BACKUP_MANIFEST_INVALID');
   for(const item of attachments){
    if(!item||item.path!=='sqlite-images/'+item.operationHash+'.sqlite'||operations.has(item.operationHash)||typeof item.projectId!=='string'||!item.projectId||!Number.isSafeInteger(item.revision)||item.revision<1||
     !/^[a-f0-9]{64}$/.test(item.operationHash)||!Number.isSafeInteger(item.bytes)||item.bytes<512||item.bytes>67108864||item.bytes%512||!/^[a-f0-9]{64}$/.test(item.sha256))fail('REGISTERED_BACKUP_MANIFEST_INVALID');
    operations.add(item.operationHash);
    const file=value.files.find(candidate=>candidate.path===item.path);
    if(!file||file.bytes!==item.bytes||file.sha256!==item.sha256)fail('REGISTERED_BACKUP_MANIFEST_INVALID');
   }
  }
  return value;
 }
 private verifyFiles(folder:string,expected:RegisteredBackupFile[],manifest=false){if(this.scan(folder).fileCount!==expected.length+(manifest?1:0))fail('REGISTERED_BACKUP_FILE_CHANGED');const seen=new Set<string>();for(const file of expected){if(!file||typeof file.path!=='string'||seen.has(file.path.toLowerCase())||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256))fail('REGISTERED_BACKUP_MANIFEST_INVALID');seen.add(file.path.toLowerCase());const actual=digest(within(folder,file.path));if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)fail('REGISTERED_BACKUP_FILE_CHANGED');}}
 verify(id:string):RegisteredBackup{
  const value=this.read(checkedId(id)),anchor=this.context.store.db.prepare('SELECT manifest_hash FROM state_snapshot_anchors WHERE snapshot_id=?').get(id);
  if(!anchor||anchor.manifest_hash!==hash(value))fail('REGISTERED_BACKUP_ANCHOR_MISMATCH');
  if(hash(this.context.maintenance.verify(value.state.snapshotId))!==value.state.manifestHash)fail('REGISTERED_BACKUP_STATE_CHANGED');this.verifyFiles(this.folder(id),value.files,true);this.assertStateRuns(within(this.folder(id),'application.sqlite'),value.runs);return value;
 }
 list(){const base=this.base('backups');if(!existsSync(base))return [];const names=readdirSync(base);if(names.length>20)fail('REGISTERED_BACKUP_LIMIT');return names.sort().map(id=>{checkedId(id);try{return {id,integrity:'NOT_RECHECKED' as const,createdAt:this.read(id).createdAt};}catch{return {id,integrity:'INCOMPLETE_OR_INVALID' as const};}});}
 create(operation:string):RegisteredBackup{
  this.idle();const operationHash=hash({scope:'REGISTERED_STATE_AND_PROJECT_FILES',operation}),id='snapshot_'+operationHash.slice(0,32),folder=this.folder(id);if(existsSync(folder))return this.verify(id);
  const source=this.catalog(),sourceBytes=source.reduce((n,run)=>n+run.catalog.reduce((s,file)=>s+file.bytes,0),0);
  const paths=source.flatMap(run=>run.catalog.map(file=>'workspaces/'+run.runId+'/'+file.path)),directories=this.directories(paths);
  this.room('backups',sourceBytes+2*this.context.maintenance.snapshotReservationBytes()+4000000,{files:paths.length+6,directories:directories+6});
  // The whole archive is idempotent above. A failed attempt must not reuse an older state snapshot.
  const state=this.context.maintenance.create('registered-files:'+operation+':'+randomUUID()),manifestFiles:RegisteredBackupFile[]=[];
  this.assertStateRuns(within(this.context.data,'controller/state-backups/'+state.id+'/application.sqlite'),source);
  const bytes=sourceBytes+state.files.reduce((n,file)=>n+file.bytes,4000000);this.room('backups',bytes,{files:paths.length+state.files.length+1,directories:directories+3});mkdirSync(this.base('backups'),{recursive:true,mode:0o700});mkdirSync(folder,{mode:0o700});
  for(const file of state.files){const from=within(this.context.data,'controller/state-backups/'+state.id+'/'+file.path),to=within(folder,file.path);copyFileSync(from,to,COPYFILE_EXCL);if(digest(from).sha256!==file.sha256||digest(to).sha256!==file.sha256)fail('REGISTERED_BACKUP_FILE_CHANGED');manifestFiles.push({...file});}
  for(const run of source)for(const file of run.catalog){const body=this.sourceBody(run.workspace,file),path='workspaces/'+run.runId+'/'+file.path,to=within(folder,path);mkdirSync(dirname(to),{recursive:true,mode:0o700});within(folder,path);writeFileSync(to,body,{flag:'wx',mode:0o600});manifestFiles.push({...file,path});}
  if(hash(this.catalog())!==hash(source))fail('REGISTERED_BACKUP_SOURCE_CHANGED');
  const value:RegisteredBackup={schema:'dream-maker.registered-backup.v2',id,operationHash,createdAt:new Date().toISOString(),scope:'REGISTERED_STATE_AND_PROJECT_FILES',completeProjectBackup:false,integrity:'SHA256_VERIFIED',state:{snapshotId:state.id,manifestHash:hash(state),budget:state.budget.status},runs:source.map(({workspace,catalog,...run})=>({...run,files:catalog.length,bytes:catalog.reduce((n,file)=>n+file.bytes,0)})),files:manifestFiles,exclusions};
  this.verifyFiles(folder,value.files);const raw=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(raw)>4000000)fail('REGISTERED_BACKUP_MANIFEST_INVALID');writeFileSync(within(folder,'manifest.json'),raw,{flag:'wx',mode:0o600});
  this.context.store.db.prepare('INSERT INTO state_snapshot_anchors VALUES(?,?,?)').run(id,hash(value),value.createdAt);return this.verify(id);
 }
 async createCustodied(operation:string):Promise<RegisteredBackup>{
  this.idle();const operationHash=hash({scope:'REGISTERED_STATE_AND_PROJECT_FILES',operation}),id='snapshot_'+operationHash.slice(0,32),folder=this.folder(id);if(existsSync(folder))return this.verify(id);
  const source=this.catalog(),sourceBytes=source.reduce((n,run)=>n+run.catalog.reduce((s,file)=>s+file.bytes,0),0);
  const paths=source.flatMap(run=>run.catalog.map(file=>'workspaces/'+run.runId+'/'+file.path)),directories=this.directories(paths);
  this.room('backups',sourceBytes+2*this.context.maintenance.snapshotReservationBytes()+4000000,{files:paths.length+6,directories:directories+6});
  const state=await this.context.maintenance.createCustodied('registered-files:'+operation+':'+randomUUID()),attachments:RegisteredBackupSqliteAttachment[]=(state.attachments??[]).map(item=>({...item}));
  this.assertStateRuns(within(this.context.data,'controller/state-backups/'+state.id+'/application.sqlite'),source);
  const stateFiles:RegisteredBackupFile[]=[...state.files,...attachments.map(item=>({path:item.path,bytes:item.bytes,sha256:item.sha256}))],
   stateBytes=stateFiles.reduce((n,file)=>n+file.bytes,0),bytes=sourceBytes+stateBytes+4000000,manifestFiles:RegisteredBackupFile[]=[];
  this.room('backups',bytes,{files:paths.length+stateFiles.length+1,directories:directories+this.directories(stateFiles.map(file=>file.path))+6});
  await this.custody(async lease=>{
   const destination='controller/registered-backups/'+id,sourceState='controller/state-backups/'+state.id;
   await lease.directory('controller/registered-backups',true);lease.assertActive();
   await lease.directory(destination,true);lease.assertActive();
   await lease.directory(sourceState);lease.assertActive();
   await pinCustodyParentDirectories(lease,destination,[...stateFiles.map(file=>file.path),...paths],true);lease.assertActive();
   for(const run of source)if(this.relative(run.workspace)!=='workspaces/'+run.runId)fail('REGISTERED_BACKUP_FILE_DENIED');
   for(const item of attachments){await lease.image(sourceState+'/sqlite-images',item.operationHash,item.bytes,item.sha256);lease.assertActive();}
   if(hash(this.context.maintenance.verify(state.id))!==hash(state))fail('REGISTERED_BACKUP_STATE_CHANGED');
   for(const file of state.files){
    await lease.file(sourceState+'/'+file.path,file.bytes,file.sha256);lease.assertActive();
    const from=within(this.context.data,'controller/state-backups/'+state.id+'/'+file.path),to=within(folder,file.path);copyFileSync(from,to,COPYFILE_EXCL);
    if(digest(from).sha256!==file.sha256||digest(to).sha256!==file.sha256)fail('REGISTERED_BACKUP_FILE_CHANGED');
    await lease.file(destination+'/'+file.path,file.bytes,file.sha256);lease.assertActive();manifestFiles.push({...file});
   }
   for(const item of attachments){
    const from=within(this.context.data,'controller/state-backups/'+state.id+'/'+item.path),to=within(folder,item.path);
    within(folder,item.path);copyFileSync(from,to,COPYFILE_EXCL);
    if(digest(from).sha256!==item.sha256||digest(to).sha256!==item.sha256)fail('REGISTERED_BACKUP_FILE_CHANGED');
    await lease.image(destination+'/sqlite-images',item.operationHash,item.bytes,item.sha256);lease.assertActive();
    manifestFiles.push({path:item.path,bytes:item.bytes,sha256:item.sha256});
   }
   for(const run of source)for(const file of run.catalog){const body=this.sourceBody(run.workspace,file),path='workspaces/'+run.runId+'/'+file.path,to=within(folder,path);within(folder,path);writeFileSync(to,body,{flag:'wx',mode:0o600});manifestFiles.push({...file,path});}
   if(hash(this.catalog())!==hash(source))fail('REGISTERED_BACKUP_SOURCE_CHANGED');
   if(hash(this.context.maintenance.verify(state.id))!==hash(state))fail('REGISTERED_BACKUP_STATE_CHANGED');
   this.assertStateRuns(within(folder,'application.sqlite'),source);this.verifyFiles(folder,manifestFiles);
   const value:RegisteredBackup={schema:'dream-maker.registered-backup.v2',id,operationHash,createdAt:new Date().toISOString(),scope:'REGISTERED_STATE_AND_PROJECT_FILES',completeProjectBackup:false,integrity:'SHA256_VERIFIED',
    state:{snapshotId:state.id,manifestHash:hash(state),budget:state.budget.status,sqliteImages:{status:attachments.length?'CAPTURED':'NONE',files:attachments.length,bytes:attachments.reduce((n,file)=>n+file.bytes,0)},attachments},
    runs:source.map(({workspace,catalog,...run})=>({...run,files:catalog.length,bytes:catalog.reduce((n,file)=>n+file.bytes,0)})),files:manifestFiles,exclusions};
   const raw=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(raw)>4000000)fail('REGISTERED_BACKUP_MANIFEST_INVALID');writeFileSync(within(folder,'manifest.json'),raw,{flag:'wx',mode:0o600});
   this.verifyFiles(folder,value.files,true);lease.assertActive();
   this.context.store.db.prepare('INSERT INTO state_snapshot_anchors VALUES(?,?,?)').run(id,hash(value),value.createdAt);lease.assertActive();
  });
  return this.verify(id);
 }
 extract(id:string,operation:string):RegisteredExtraction{
  this.idle();const backup=this.verify(id),operationHash=hash({id,operation}),rid='recovered_'+operationHash.slice(0,32),directory=within(this.base('extractions'),rid),path=within(directory,'manifest.json'),sourceManifestHash=hash(backup),bytes=backup.files.reduce((n,file)=>n+file.bytes,0);
  const identity={schema:'dream-maker.registered-extraction.v1' as const,id:rid,backupId:id,operationHash,sourceManifestHash,directory,scope:'SIDE_BY_SIDE_EXTRACTION_ONLY' as const,workingDataReplaced:false as const,executionGranted:false as const,automaticResume:false as const,files:backup.files.length,bytes};
  if(existsSync(directory)){
   if(!existsSync(path)||lstatSync(path).size>32000)fail('REGISTERED_BACKUP_EXTRACTION_INCOMPLETE');let value:RegisteredExtraction;try{value=JSON.parse(readFileSync(path,'utf8'));}catch{fail('REGISTERED_BACKUP_EXTRACTION_INCOMPLETE');}
   const {createdAt,...rest}=value!;if(!Number.isFinite(Date.parse(createdAt))||hash(rest)!==hash(identity))fail('REGISTERED_BACKUP_EXTRACTION_CHANGED');this.verifyFiles(directory,backup.files,true);return value!;
  }
  this.room('extractions',bytes+32000,{files:backup.files.length+1,directories:this.directories(backup.files.map(file=>file.path))+3});mkdirSync(this.base('extractions'),{recursive:true,mode:0o700});mkdirSync(directory,{mode:0o700});
  for(const file of backup.files){const from=within(this.folder(id),file.path),to=within(directory,file.path);mkdirSync(dirname(to),{recursive:true,mode:0o700});within(directory,file.path);copyFileSync(from,to,COPYFILE_EXCL);if(digest(from).sha256!==file.sha256)fail('REGISTERED_BACKUP_FILE_CHANGED');}
  this.verifyFiles(directory,backup.files);this.verify(id);const result:RegisteredExtraction={...identity,createdAt:new Date().toISOString()};writeFileSync(path,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
 }
 async extractCustodied(id:string,operation:string):Promise<RegisteredExtraction>{
  this.idle();const backup=this.verify(id),operationHash=hash({id,operation}),rid='recovered_'+operationHash.slice(0,32),directory=within(this.base('extractions'),rid),path=within(directory,'manifest.json'),sourceManifestHash=hash(backup),bytes=backup.files.reduce((n,file)=>n+file.bytes,0);
  const identity={schema:'dream-maker.registered-extraction.v1' as const,id:rid,backupId:id,operationHash,sourceManifestHash,directory,scope:'SIDE_BY_SIDE_EXTRACTION_ONLY' as const,workingDataReplaced:false as const,executionGranted:false as const,automaticResume:false as const,files:backup.files.length,bytes};
  const existed=existsSync(directory);
  this.room('extractions',bytes+32000,{files:backup.files.length+1,directories:this.directories(backup.files.map(file=>file.path))+3});
  return this.custody(async lease=>{
   const source='controller/registered-backups/'+id,destination='controller/registered-extractions/'+rid;
   await lease.directory('controller/registered-extractions',true);lease.assertActive();
   await lease.directory(destination,!existed);lease.assertActive();
   await lease.directory(source);lease.assertActive();
   await pinCustodyParentDirectories(lease,source,backup.files.map(file=>file.path),false);lease.assertActive();
   await pinCustodyParentDirectories(lease,destination,backup.files.map(file=>file.path),!existed);lease.assertActive();
   if(hash(this.verify(id))!==hash(backup))fail('REGISTERED_BACKUP_FILE_CHANGED');
   if(existed){
    if(!existsSync(path)||lstatSync(path).size>32000)fail('REGISTERED_BACKUP_EXTRACTION_INCOMPLETE');let value:RegisteredExtraction;try{value=JSON.parse(readFileSync(path,'utf8'));}catch{fail('REGISTERED_BACKUP_EXTRACTION_INCOMPLETE');}
    const {createdAt,...rest}=value!;if(!Number.isFinite(Date.parse(createdAt))||hash(rest)!==hash(identity))fail('REGISTERED_BACKUP_EXTRACTION_CHANGED');this.verifyFiles(directory,backup.files,true);this.verify(id);lease.assertActive();return value!;
   }
   const attachments=new Map((backup.state.attachments??[]).map(item=>[item.path,item]));
   for(const file of backup.files){
    const attachment=attachments.get(file.path),from=within(this.folder(id),file.path),to=within(directory,file.path);
    if(attachment)await lease.image(source+'/sqlite-images',attachment.operationHash,attachment.bytes,attachment.sha256);
    else if(file.path==='application.sqlite'||file.path==='budget.sqlite')await lease.file(source+'/'+file.path,file.bytes,file.sha256);
    lease.assertActive();within(directory,file.path);copyFileSync(from,to,COPYFILE_EXCL);
    if(digest(from).sha256!==file.sha256||digest(to).sha256!==file.sha256)fail('REGISTERED_BACKUP_FILE_CHANGED');
    if(attachment)await lease.image(destination+'/sqlite-images',attachment.operationHash,attachment.bytes,attachment.sha256);
    else if(file.path==='application.sqlite'||file.path==='budget.sqlite')await lease.file(destination+'/'+file.path,file.bytes,file.sha256);
    lease.assertActive();
   }
   this.verifyFiles(directory,backup.files);if(hash(this.verify(id))!==hash(backup))fail('REGISTERED_BACKUP_FILE_CHANGED');
   const result:RegisteredExtraction={...identity,createdAt:new Date().toISOString()};writeFileSync(path,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
   this.verifyFiles(directory,backup.files,true);if(hash(this.verify(id))!==hash(backup))fail('REGISTERED_BACKUP_FILE_CHANGED');lease.assertActive();
   return result;
  });
 }
}
