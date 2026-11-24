import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store,APPLICATION_SCHEMA_VERSION} from '../../dist/server/store.js';
import {hash} from '../../dist/server/security.js';
import {decodeManagedVersion} from '../../dist/server/managed-data.js';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {root} from '../helpers.mjs';
function v3(t){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(resolve(parent,'json-v4-')),path=resolve(dir,'application.sqlite'),db=new DatabaseSync(path);t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const file of ['001_initial.sql','002_plan_versions.sql','003_managed_data.sql','003_managed_data_guards.sql'])db.exec(readFileSync(resolve(root,'migrations',file),'utf8'));db.exec("INSERT INTO schema_versions VALUES(2,'2026-11-01'); INSERT INTO schema_versions VALUES(3,'2026-11-01')");
 const original=JSON.stringify({id:'p',mode:'demo',version:1,name:'保留旧项目',idea:'逐字节保留',questions:[],answers:[]});db.prepare('INSERT INTO projects VALUES(?,?,?)').run('p',1,original);db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run('r','p',1,JSON.stringify({id:'r',projectId:'p',mode:'demo'}));
 const at='2026-11-01T00:00:00.000Z',tasks=[{id:'t',title:'原业务内容',done:false}],version={projectId:'p',kind:'FIXED_DEMO_TASKS_V1',revision:1,parentRevision:null,parentHash:null,tasks,dataHash:hash(tasks),sourceRunId:'r',sourceTreeHash:'b'.repeat(64),origin:'BROWSER_IMPORT',sourceSnapshotId:null,actor:'local-session:'+'a'.repeat(64),at},contentHash=hash(version);
 db.prepare('INSERT INTO managed_dataset_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('p',version.kind,1,null,null,JSON.stringify(tasks),version.dataHash,contentHash,'r',version.sourceTreeHash,version.origin,null,version.actor,at);db.prepare('INSERT INTO managed_dataset_heads VALUES(?,?,?)').run('p',version.kind,1);db.prepare('INSERT INTO managed_dataset_operations VALUES(?,?,?,?,?,?)').run('c'.repeat(64),'p',version.kind,'d'.repeat(64),1,at);
 const tables=['projects','runs','managed_dataset_versions','managed_dataset_heads','managed_dataset_operations'],before=Object.fromEntries(tables.map(name=>[name,db.prepare('SELECT * FROM '+name).all()]));db.close();return {dir,path,original,contentHash,before};
}
test('v3 upgrades to JSON-capable original tables with old rows, hashes and pre-v4 consistent backup retained',t=>{
 const x=v3(t),store=new Store(x.path);try{
  assert.equal(store.db.prepare('SELECT max(version) v FROM schema_versions').get().v,APPLICATION_SCHEMA_VERSION);
  for(const [name,rows] of Object.entries(x.before))assert.deepEqual(store.db.prepare('SELECT * FROM '+name).all(),rows,name);
  assert.equal(decodeManagedVersion(store.db.prepare('SELECT * FROM managed_dataset_versions').get()).contentHash,x.contentHash);assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  const file=readdirSync(resolve(x.dir,'migration-backups')).find(n=>/^before-v4-.*\.sqlite$/.test(n));assert.ok(file);const old=new DatabaseSync(resolve(x.dir,'migration-backups',file),{readOnly:true});try{assert.equal(old.prepare('SELECT max(version) v FROM schema_versions').get().v,3);assert.equal(old.prepare('SELECT data FROM projects').get().data,x.original);}finally{old.close();}
 }finally{store.close();}
});
test('v4 preserves immutable version and operation guards including REPLACE',t=>{
 const x=v3(t),store=new Store(x.path);try{
  for(const sql of ['UPDATE managed_dataset_versions SET data_json=\'[]\'','DELETE FROM managed_dataset_versions','INSERT OR REPLACE INTO managed_dataset_versions SELECT * FROM managed_dataset_versions','UPDATE managed_dataset_operations SET input_hash=\''+'e'.repeat(64)+'\'','DELETE FROM managed_dataset_operations','INSERT OR REPLACE INTO managed_dataset_operations SELECT * FROM managed_dataset_operations'])assert.throws(()=>store.db.exec(sql),/IMMUTABLE/,sql);
  assert.deepEqual(store.db.prepare('SELECT * FROM managed_dataset_versions').all(),x.before.managed_dataset_versions);
 }finally{store.close();}
});
test('a failed v4 transaction keeps v3 rows, tables and schema and does not delete its backup',t=>{
 const x=v3(t),db=new DatabaseSync(x.path);db.exec('CREATE TABLE managed_dataset_versions_v3(retained TEXT)');db.close();let unexpected;try{assert.throws(()=>{unexpected=new Store(x.path);});}finally{unexpected?.close();}
 const check=new DatabaseSync(x.path,{readOnly:true});try{assert.equal(check.prepare('SELECT max(version) v FROM schema_versions').get().v,3);assert.deepEqual(check.prepare('SELECT * FROM managed_dataset_versions').all(),x.before.managed_dataset_versions);assert.equal(check.prepare('SELECT count(*) n FROM managed_dataset_versions_v3').get().n,0);}finally{check.close();}
 assert.ok(readdirSync(resolve(x.dir,'migration-backups')).some(n=>/^before-v4-.*\.sqlite$/.test(n)));
});
test('state maintenance creates and revalidates a v4 snapshot without altering old business data',t=>{
 const x=v3(t),store=new Store(x.path);try{assert.equal(store.db.prepare('SELECT max(version) v FROM schema_versions').get().v,APPLICATION_SCHEMA_VERSION);const service=new StateMaintenance({store,data:x.dir,isBusy:()=>false}),snapshot=service.create('v4-state');assert.equal(snapshot.application.managedData.versions,1);assert.deepEqual(service.verify(snapshot.id),snapshot);assert.equal(snapshot.completeProjectBackup,false);assert.equal(store.db.prepare('SELECT data FROM projects').get().data,x.original);}finally{store.close();}
});
