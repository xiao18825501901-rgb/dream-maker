// Actual original SQLite migrations and consistent backups; no role or business acceptance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {Store,APPLICATION_SCHEMA_VERSION} from '../../dist/server/store.js';
import {root} from '../helpers.mjs';
function old(t){
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const folder=mkdtempSync(join(parent,'sqlite-v5-')),path=join(folder,'state.sqlite');
 t.after(()=>rmSync(folder,{recursive:true,force:true}));const db=new DatabaseSync(path);
 for(const file of ['001_initial.sql','002_plan_versions.sql','003_managed_data.sql','003_managed_data_guards.sql','004_json_business_data.sql','003_managed_data_guards.sql'])db.exec(readFileSync(join(root,'migrations',file),'utf8'));
 db.exec("INSERT INTO schema_versions VALUES(2,'2026-11-01'); INSERT INTO schema_versions VALUES(3,'2026-11-01'); INSERT INTO schema_versions VALUES(4,'2026-11-02')");
 const original=JSON.stringify({id:'old',name:'原数据逐字节保留',mode:'live'});db.prepare('INSERT INTO projects VALUES(?,?,?)').run('old',1,original);
 db.close();return{folder,path,original};
}
test('v5 extends original tables after a verified pre-v5 consistent backup',t=>{
 const x=old(t),store=new Store(x.path);
 try{
  assert.equal(store.db.prepare('SELECT max(version) v FROM schema_versions').get().v,APPLICATION_SCHEMA_VERSION);assert.equal(store.db.prepare('SELECT data FROM projects').get().data,x.original);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='business_image_intent_bindings'").get().n,1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'business_image_intent_bindings_no_%'").get().n,3);
  const name=readdirSync(join(x.folder,'migration-backups')).find(name=>name.startsWith('before-v5-')&&name.endsWith('.sqlite'));assert.ok(name);
  const before=new DatabaseSync(join(x.folder,'migration-backups',name),{readOnly:true});try{assert.equal(before.prepare('SELECT max(version) v FROM schema_versions').get().v,4);assert.equal(before.prepare('SELECT data FROM projects').get().data,x.original);}finally{before.close();}
 }finally{store.close();}
});
test('failed v5 transaction preserves v4 rows and its backup without partial table replacement',t=>{
 const x=old(t),db=new DatabaseSync(x.path);db.exec('CREATE TABLE business_image_intents(legacy TEXT)');db.close();let unexpected;
 try{assert.throws(()=>{unexpected=new Store(x.path);});}finally{unexpected?.close();}
 const after=new DatabaseSync(x.path,{readOnly:true});try{
  assert.equal(after.prepare('SELECT max(version) v FROM schema_versions').get().v,4);assert.equal(after.prepare('SELECT data FROM projects').get().data,x.original);
  assert.equal(after.prepare("SELECT count(*) n FROM sqlite_master WHERE name='managed_dataset_versions_v4'").get().n,0);
 }finally{after.close();}
 assert.ok(readdirSync(join(x.folder,'migration-backups')).some(name=>name.startsWith('before-v5-')));
});
