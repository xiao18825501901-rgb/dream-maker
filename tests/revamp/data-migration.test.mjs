// Real SQLite schema migration/rollback in owned temporary files; no user database or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store,APPLICATION_SCHEMA_VERSION} from '../../dist/server/store.js';
import {migrationBackup} from '../../dist/server/migration-backup.js';
import {root} from '../helpers.mjs';
function oldDatabase(t){const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(resolve(parent,'data-schema-')),path=resolve(dir,'state.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));const db=new DatabaseSync(path);db.exec(readFileSync(resolve(root,'migrations/001_initial.sql'),'utf8'));db.exec(readFileSync(resolve(root,'migrations/002_plan_versions.sql'),'utf8'));db.prepare('INSERT INTO schema_versions VALUES(2,?)').run('2026-11-01T00:00:00.000Z');const text=JSON.stringify({id:'project_legacy',version:1,name:'旧数据原文',idea:'不覆盖已有内容',answers:[{text:'我的原回答'}]});db.prepare('INSERT INTO projects VALUES(?,?,?)').run('project_legacy',1,text);return {dir,path,db,text};}
test('schema2 upgrades with a consistent pre-v3 backup and byte-identical old project data',t=>{
 let store;t.after(()=>{if(store?.db.isOpen)store.close();});const x=oldDatabase(t);x.db.close();store=new Store(x.path);assert.equal(store.db.prepare('SELECT max(version) v FROM schema_versions').get().v,APPLICATION_SCHEMA_VERSION);assert.equal(store.db.prepare('SELECT data FROM projects').get().data,x.text);
 const names=readdirSync(resolve(x.dir,'migration-backups')).filter(name=>name.startsWith('before-v3-'));assert.equal(names.length,1);const backup=new DatabaseSync(resolve(x.dir,'migration-backups',names[0]),{readOnly:true});try{assert.equal(backup.prepare('SELECT max(version) v FROM schema_versions').get().v,2);assert.equal(backup.prepare('SELECT data FROM projects').get().data,x.text);}finally{backup.close();}
});
test('a failed new table migration rolls back without relabelling or deleting legacy user data',t=>{
 const x=oldDatabase(t);x.db.exec('CREATE TABLE managed_dataset_versions(legacy_canary TEXT)');x.db.close();let unexpected;try{assert.throws(()=>{unexpected=new Store(x.path);});}finally{unexpected?.close();}const db=new DatabaseSync(x.path,{readOnly:true});try{assert.equal(db.prepare('SELECT max(version) v FROM schema_versions').get().v,2);assert.equal(db.prepare('SELECT data FROM projects').get().data,x.text);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='managed_dataset_heads'").get().n,0);}finally{db.close();}
});
test('a future schema is rejected before migration or backup writes',t=>{
 const x=oldDatabase(t);x.db.prepare('INSERT INTO schema_versions VALUES(?,?)').run(APPLICATION_SCHEMA_VERSION+1,'2026-11-01T00:00:00.000Z');x.db.close();assert.throws(()=>new Store(x.path),{code:'DATABASE_NEWER_THAN_RUNTIME'});assert.equal(existsSync(resolve(x.dir,'migration-backups')),false);
});
test('retrying the same failed migration reuses one verified pre-upgrade backup',t=>{
 const x=oldDatabase(t);x.db.exec('CREATE TABLE managed_dataset_versions(legacy_canary TEXT)');x.db.close();
 for(let i=0;i<3;i++)assert.throws(()=>new Store(x.path));
 assert.equal(readdirSync(resolve(x.dir,'migration-backups')).filter(name=>name.startsWith('before-v3-')&&name.endsWith('.sqlite')).length,1);
});
test('migration backup count is bounded before another full database copy or schema change',t=>{
 const x=oldDatabase(t);x.db.close();const dir=resolve(x.dir,'migration-backups');mkdirSync(dir);for(let i=0;i<20;i++)writeFileSync(resolve(dir,'existing-'+i+'.keep'),'retained test canary');let unexpected;
 try{assert.throws(()=>{unexpected=new Store(x.path);},{code:'MIGRATION_BACKUP_LIMIT'});}finally{unexpected?.close();}
 assert.equal(readdirSync(dir).length,20);const db=new DatabaseSync(x.path,{readOnly:true});try{assert.equal(db.prepare('SELECT max(version) v FROM schema_versions').get().v,2);}finally{db.close();}
});
test('backup source identity distinguishes equal rows stored in different tables',t=>{
 const x=oldDatabase(t);try{x.db.exec("CREATE TABLE legacy_a(value TEXT); CREATE TABLE legacy_b(value TEXT); INSERT INTO legacy_a VALUES('offline same row');");const first=migrationBackup(x.db,x.path,3);
 x.db.exec("DELETE FROM legacy_a; INSERT INTO legacy_b VALUES('offline same row');");const second=migrationBackup(x.db,x.path,3);assert.notEqual(second,first);
 const copy=new DatabaseSync(second,{readOnly:true});try{assert.equal(copy.prepare('SELECT count(*) n FROM legacy_b').get().n,1);assert.equal(copy.prepare('SELECT count(*) n FROM legacy_a').get().n,0);}finally{copy.close();}
 }finally{x.db.close();}
});

test('backup identity preserves the journal ordering consumed by Store',t=>{
 const x=oldDatabase(t);try{
  x.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run('r_a','Canary','project_legacy',null,'{}','2026-11-01');
  x.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run('r_b','Canary','project_legacy',null,'{}','2026-11-01');
  const first=migrationBackup(x.db,x.path,3),copy=new DatabaseSync(first);
  try{copy.exec("UPDATE records SET rowid=100 WHERE id='r_a'");}finally{copy.close();}
  assert.throws(()=>migrationBackup(x.db,x.path,3),{code:'MIGRATION_BACKUP_CHANGED'});
 }finally{x.db.close();}
});

test('an interrupted staging copy is retained and counted without poisoning a fresh backup',t=>{
 const x=oldDatabase(t);try{
  const folder=resolve(x.dir,'migration-backups');mkdirSync(folder);
  const partial=resolve(folder,'stage-before-v3-interrupted.sqlite.partial');writeFileSync(partial,'interrupted copy');
  const final=migrationBackup(x.db,x.path,3);assert.equal(readFileSync(partial,'utf8'),'interrupted copy');assert.match(final,/before-v3-[a-f0-9]{64}\.sqlite$/);
  assert.equal(readdirSync(folder).filter(name=>/^stage-v3-[a-f0-9-]+\.sqlite\.partial$/.test(name)).length,1,'published stage alias is intentionally retained');
  assert.equal(readdirSync(folder).length,3);
 }finally{x.db.close();}
});
