import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {mkdirSync,readdirSync,lstatSync,existsSync,statfsSync,openSync,closeSync,fsyncSync,linkSync,copyFileSync,constants} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {captureDatabaseState,snapshotDatabaseBytes,SNAPSHOT_FILE_LIMIT} from './database-snapshot.js';
import {DomainError,within,childEnv} from './security.js';
const fail=(code:string):never=>{throw new DomainError(code,409);};
const quoted=(name:string)=>'"'+name.replaceAll('"','""')+'"';
/** exFAT cannot hard-link. Preserve the verified stage and publish a second, verified file
 * through Windows' no-replace move; a reader must never observe a half-copied final name. */
function publish(stage:string,out:string,verify:(path:string)=>void){
 try{linkSync(stage,out);return;}catch(error){
  const code=(error as NodeJS.ErrnoException).code;if(code==='EEXIST')return;
  // This Windows exFAT volume reports EISDIR even for a verified regular stage file.
  if(process.platform!=='win32'||!lstatSync(stage).isFile()||!['EPERM','ENOTSUP','EOPNOTSUPP','ENOSYS','EINVAL','EISDIR'].includes(code??''))throw error;
 }
 const folder=dirname(out),disk=statfsSync(folder),size=lstatSync(stage).size;
 if(Number(disk.bavail)*Number(disk.bsize)<size+256000000)fail('MIGRATION_BACKUP_LIMIT');
 const candidate=within(folder,'publish-'+randomUUID().replaceAll('-','').slice(0,16)+'.sqlite.partial');
 copyFileSync(stage,candidate,constants.COPYFILE_EXCL);verify(candidate);
 const fd=openSync(candidate,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
 const script="$ErrorActionPreference='Stop';try{[IO.File]::Move($env:DM_MIGRATION_STAGE,$env:DM_MIGRATION_OUTPUT);exit 0}catch [IO.IOException]{if([IO.File]::Exists($env:DM_MIGRATION_OUTPUT)){exit 17};exit 1}catch{exit 1}";
 const moved=spawnSync((process.env.SystemRoot??'C:\\Windows')+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{shell:false,windowsHide:true,timeout:10000,env:childEnv({DM_MIGRATION_STAGE:candidate,DM_MIGRATION_OUTPUT:out}),stdio:['ignore','pipe','pipe']});
 if(moved.error||![0,17].includes(moved.status??-1))fail('MIGRATION_BACKUP_PUBLISH_FAILED');
}
/** Logical source identity includes schema and every stored value; never logs database contents.
 * Value order plus relative row order survives VACUUM's implicit-rowid renumbering. */
function identity(db:DatabaseSync):string{
 snapshotDatabaseBytes(db);const digest=createHash('sha256').update('dream-maker.migration-database.v2;');let rows=0;
 const value=(v:unknown)=>{
  if(v===null){digest.update('null;');return;}
  if(v instanceof Uint8Array){digest.update('blob:'+v.byteLength+':');digest.update(v);return;}
  if(typeof v==='string'){digest.update('text:'+Buffer.byteLength(v)+':');digest.update(v);return;}
  if(typeof v==='bigint'){digest.update('integer:'+v.toString()+';');return;}
  if(typeof v==='number'&&Number.isFinite(v)){digest.update('number:'+String(v)+';');return;}
  fail('MIGRATION_DATABASE_VALUE_UNSUPPORTED');
 };
 db.exec('BEGIN');try{
  const size=db.prepare("SELECT count(*) n,coalesce(sum(length(sql)),0) bytes FROM sqlite_master").get()!;if(Number(size.n)>512||Number(size.bytes)>1000000)fail('MIGRATION_DATABASE_LIMIT');
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  for(const entry of schema)for(const key of ['type','name','tbl_name','sql'])value(entry[key]);
  for(const entry of schema.filter(item=>item.type==='table')){
   const table=String(entry.name),columns=db.prepare('PRAGMA table_info('+quoted(table)+')').all();digest.update('table;');value(table);if(columns.length>128)fail('MIGRATION_DATABASE_LIMIT');
   const primary=columns.filter(column=>Number(column.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk));
   const order=(primary.length?primary:columns).map(column=>quoted(String(column.name))).join(',');if(!order)fail('MIGRATION_DATABASE_VALUE_UNSUPPORTED');
   const statement=db.prepare('SELECT * FROM '+quoted(table)+' ORDER BY '+order);statement.setReadBigInts(true);
   for(const row of statement.iterate()){if(++rows>100000)fail('MIGRATION_DATABASE_LIMIT');digest.update('row;');for(const column of columns){value(String(column.name));value(row[String(column.name)]);}}
   if(!/\bWITHOUT\s+ROWID\b/i.test(String(entry.sql))){
    digest.update('relative-row-order;');value(table);
    const rowid=['rowid','_rowid_','oid'].find(alias=>!columns.some(column=>String(column.name).toLowerCase()===alias));if(!rowid)fail('MIGRATION_DATABASE_VALUE_UNSUPPORTED');
    const ordered=db.prepare('SELECT * FROM '+quoted(table)+' ORDER BY '+rowid);ordered.setReadBigInts(true);
    for(const row of ordered.iterate()){digest.update('ordered-row;');for(const column of columns)value(row[String(column.name)]);}
   }
  }
  db.exec('COMMIT');return digest.digest('hex');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
/** Verified backups are reused after failed/restarted upgrades. All old/failed entries consume quota. */
export function migrationBackup(db:DatabaseSync,path:string,target:number,limitBytes=1000000000):string{
 if(!Number.isSafeInteger(limitBytes)||limitBytes<1||limitBytes>1000000000)fail('MIGRATION_BACKUP_LIMIT_INVALID');
 const parent=dirname(path),folder=within(parent,'migration-backups');mkdirSync(folder,{recursive:true,mode:0o700});within(parent,'migration-backups');
 const source=identity(db),out=within(parent,'migration-backups/before-v'+target+'-'+source+'.sqlite'),stagePrefix='stage-v'+target+'-'+source.slice(0,16)+'-';
 // Keep SQLite's native Windows path short. The full identity is always checked from contents.
 const stageNames=()=>{const names=readdirSync(folder);if(names.length>20)fail('MIGRATION_BACKUP_LIMIT');return names.filter(name=>name.startsWith(stagePrefix)&&/^[a-f0-9]{16}\.sqlite\.partial$/.test(name.slice(stagePrefix.length)));};
 const verify=(candidate:string)=>{
  const stat=lstatSync(candidate,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.size>BigInt(SNAPSHOT_FILE_LIMIT))fail('MIGRATION_BACKUP_CHANGED');
  if(stat.nlink!==1n){
   if(candidate!==out||stat.nlink!==2n||stat.ino===0n)fail('MIGRATION_BACKUP_CHANGED');
   const aliases=stageNames().filter(name=>{const stage=lstatSync(resolve(folder,name),{bigint:true});return stage.isFile()&&!stage.isSymbolicLink()&&stage.dev===stat.dev&&stage.ino===stat.ino&&stage.nlink===2n;});
   if(aliases.length!==1)fail('MIGRATION_BACKUP_CHANGED');
  }
  let copy:DatabaseSync|undefined;try{copy=new DatabaseSync(candidate,{readOnly:true});if(copy.prepare('PRAGMA quick_check').get()?.quick_check!=='ok'||identity(copy)!==source)fail('MIGRATION_BACKUP_CHANGED');}
  catch{fail('MIGRATION_BACKUP_CHANGED');}finally{copy?.close();}
 };
 if(existsSync(out)){verify(out);return out;}
 let bytes=0;const entries=readdirSync(folder);for(const name of entries){const stat=lstatSync(resolve(folder,name));if(!stat.isFile()||stat.isSymbolicLink())fail('MIGRATION_BACKUP_PATH_DENIED');bytes+=stat.size;}
 const expected=snapshotDatabaseBytes(db),disk=statfsSync(folder);
 let stage:string|undefined;for(const name of stageNames()){const candidate=within(folder,name);try{verify(candidate);stage=candidate;break;}catch{/* Preserve incomplete stages; they still consume quota. */}}
 const extraEntries=stage?1:2,extraBytes=stage?lstatSync(stage).size:expected*2;
 if(entries.length+extraEntries>20||bytes+extraBytes>limitBytes||Number(disk.bavail)*Number(disk.bsize)<(stage?0:expected)+256000000)fail('MIGRATION_BACKUP_LIMIT');
 if(!stage){stage=within(folder,stagePrefix+randomUUID().replaceAll('-','').slice(0,16)+'.sqlite.partial');closeSync(openSync(stage,'wx',0o600));captureDatabaseState(db,stage);}
 verify(stage);if(identity(db)!==source)fail('MIGRATION_SOURCE_CHANGED');
 const fd=openSync(stage,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
 if(existsSync(out)){verify(out);return out;}
 const names=readdirSync(folder);let occupiedBytes=0;
 for(const name of names){const stat=lstatSync(within(folder,name));if(!stat.isFile()||stat.isSymbolicLink())fail('MIGRATION_BACKUP_PATH_DENIED');occupiedBytes+=stat.size;}
 if(names.length+1>20||occupiedBytes+lstatSync(stage).size>limitBytes)fail('MIGRATION_BACKUP_LIMIT');
 publish(stage,out,verify);
 verify(out);return out;
}
