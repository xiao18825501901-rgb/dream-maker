// Actual local SQLite/files only. No native roles, account custody or automatic source execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {resolve} from 'node:path';
import {RegisteredProjectBackups} from '../../dist/server/registered-backups.js';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {treeHash} from '../../dist/server/workspace.js';
import {get} from '../../dist/server/workspace.js';
import {harness,ready} from '../helpers.mjs';
async function setup(t){const h=harness(t),{p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);let busy=false;const maintenance=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>busy}),backups=new RegisteredProjectBackups({store:h.store,data:h.dir,maintenance,isBusy:()=>busy});return {h,p,s,run:h.store.run(r.id),maintenance,backups,busy:()=>{busy=true;}};}
test('registered backup preserves original state and exact project files, then extracts into a new directory only',async t=>{
 const {h,p,run,backups}=await setup(t),source=treeHash(run.workspace),spec=JSON.stringify(h.store.spec(run.specId)),approvals=h.store.db.prepare('SELECT * FROM approvals').all();
 mkdirSync(resolve(h.dir,'controller/credentials'),{recursive:true});writeFileSync(resolve(h.dir,'controller/credentials/never-copy.key'),'OFFLINE_CUSTODY_CANARY');
 const backup=backups.create('offline-full-files');assert.equal(backup.completeProjectBackup,false);assert.equal(backup.scope,'REGISTERED_STATE_AND_PROJECT_FILES');assert.equal(backup.runs.length,1);assert.ok(backup.files.some(file=>file.path==='application.sqlite'));assert.ok(backup.files.some(file=>file.path==='workspaces/'+run.id+'/index.html'));assert.ok(backup.files.every(file=>!file.path.includes('credentials')));
 assert.equal(backups.create('offline-full-files').id,backup.id);
 const restored=backups.extract(backup.id,'offline-extract');assert.equal(restored.executionGranted,false);assert.equal(restored.workingDataReplaced,false);assert.equal(restored.automaticResume,false);assert.equal(treeHash(resolve(restored.directory,'workspaces',run.id)),source);assert.ok(existsSync(resolve(restored.directory,'application.sqlite')));
 assert.equal(treeHash(run.workspace),source);assert.equal(JSON.stringify(h.store.spec(run.specId)),spec);assert.deepEqual(h.store.db.prepare('SELECT * FROM approvals').all(),approvals);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');assert.equal(h.store.records(p.id,'ModelAttempt').length,0);assert.equal(backups.extract(backup.id,'offline-extract').id,restored.id);
});
test('archive tampering and a recomputed adjacent manifest cannot replace the Store-held origin anchor',async t=>{
 const {h,run,backups}=await setup(t),before=treeHash(run.workspace),backup=backups.create('offline-tamper'),path=resolve(h.dir,'controller/registered-backups',backup.id,'manifest.json'),manifest=JSON.parse(readFileSync(path,'utf8'));
 manifest.files[0].sha256='f'.repeat(64);writeFileSync(path,JSON.stringify(manifest));assert.throws(()=>backups.verify(backup.id),{code:'REGISTERED_BACKUP_ANCHOR_MISMATCH'});assert.throws(()=>backups.extract(backup.id,'tampered-extract'));assert.equal(treeHash(run.workspace),before);
});
test('incomplete extraction and later changed copies never overwrite existing files or claim replay success',async t=>{
 const {run,backups}=await setup(t),backup=backups.create('offline-copy'),restored=backups.extract(backup.id,'offline-copy-extract'),path=resolve(restored.directory,'workspaces',run.id,'index.html');writeFileSync(path,'changed saved copy');assert.throws(()=>backups.extract(backup.id,'offline-copy-extract'),{code:'REGISTERED_BACKUP_FILE_CHANGED'});assert.notEqual(readFileSync(path,'utf8'),readFileSync(resolve(run.workspace,'index.html'),'utf8'));
});
test('busy work, unregistered workspace databases and malformed IDs fail before granting recovery',async t=>{
 const {run,backups,busy}=await setup(t);assert.throws(()=>backups.verify('../outside'));writeFileSync(resolve(run.workspace,'business.sqlite'),'not a consistent registered database');assert.throws(()=>backups.create('offline-raw-db'),{code:'REGISTERED_BACKUP_DATABASE_UNREGISTERED'});busy();assert.throws(()=>backups.create('offline-busy'),{code:'MAINTENANCE_BUSY'});
});

test('a previous failed attempt cannot mix an old state snapshot with a newly registered run',async t=>{
 const {h,backups,maintenance}=await setup(t);maintenance.create('registered-files:retry');const next=await ready(h),run=h.engine.create(next.p.id,next.s.hash,true);await h.engine.settled(run.id);
 const backup=backups.create('retry'),copy=new DatabaseSync(resolve(h.dir,'controller/registered-backups',backup.id,'application.sqlite'),{readOnly:true});try{const runIds=copy.prepare('SELECT id FROM runs ORDER BY id').all().map(row=>row.id);assert.deepEqual(runIds,backup.runs.map(row=>row.runId).sort());}finally{copy.close();}
});

test('Windows credential names are excluded case-insensitively before reading or archiving',async t=>{
 const {run,backups}=await setup(t);writeFileSync(resolve(run.workspace,'AUTH.JSON'),'opaque-refresh-value-not-in-the-process-environment');
 assert.throws(()=>get(run.workspace,'AUTH.JSON'),{code:'SENSITIVE_ARTIFACT_DENIED'});assert.throws(()=>backups.create('case-custody'),{code:'SENSITIVE_ARTIFACT_DENIED'});
});

test('SQLite and WAL magic are rejected even when the database has an unrelated extension',async t=>{
 const {run,backups}=await setup(t),file=resolve(run.workspace,'business.data');
 for(const [name,header] of [['db',Buffer.from('SQLite format 3\0')],['wal',Buffer.from([0x37,0x7f,0x06,0x82])],['journal',Buffer.from([0xd9,0xd5,0x05,0xf9,0x20,0xa1,0x63,0xd7])]]){
  const body=Buffer.alloc(4096);header.copy(body);writeFileSync(file,body);assert.throws(()=>backups.create('renamed-'+name),{code:'REGISTERED_BACKUP_DATABASE_UNREGISTERED'});rmSync(file);
 }
});

test('both maintenance views count state copies, rehearsals, registered archives and extractions together',async t=>{
 const {h,maintenance,backups}=await setup(t);for(const [base,id] of [['state-backups','snapshot_'],['state-rehearsals','rehearsal_'],['registered-backups','snapshot_'],['registered-extractions','recovered_']]){const folder=resolve(h.dir,'controller',base,id+'f'.repeat(32));mkdirSync(folder,{recursive:true});writeFileSync(resolve(folder,'application.sqlite'),Buffer.alloc(64));}
 assert.equal(backups.usage().bytes,256);assert.equal(maintenance.usage().bytes,256);
});

test('excluded dependency caches do not consume the project-file traversal budget',async t=>{
 const {run,backups}=await setup(t),folder=resolve(run.workspace,'node_modules',...Array(40).fill('a'));mkdirSync(folder,{recursive:true});writeFileSync(resolve(folder,'cache.sqlite'),'excluded dependency cache');
 const backup=backups.create('excluded-deps');assert.ok(backup.files.every(file=>!file.path.includes('node_modules')));
});

test('database rejection validates the exact bytes copied, even when a writer swaps content between reads',async t=>{
 const {run,backups}=await setup(t),target=resolve(run.workspace,'changing.data'),database=Buffer.alloc(4096),ordinary=Buffer.alloc(4096,32);Buffer.from('SQLite format 3\0').copy(database);writeFileSync(target,database);
 const original=fs.readFileSync,sequence=[database,ordinary,database,database,ordinary];let reads=0;
 fs.readFileSync=(path,...args)=>String(path)===target?sequence[reads++]??database:original(path,...args);syncBuiltinESMExports();
 try{assert.throws(()=>backups.create('swap-during-read'),error=>['REGISTERED_BACKUP_SOURCE_CHANGED','REGISTERED_BACKUP_DATABASE_UNREGISTERED'].includes(error.code));}
 finally{fs.readFileSync=original;syncBuiltinESMExports();}
});
