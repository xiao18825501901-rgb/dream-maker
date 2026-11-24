// Actual Store/SQLite state snapshots and fixed Demo data; never native acceptance or full restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {ManagedDatasets} from '../../dist/server/managed-data.js';
import {hash} from '../../dist/server/security.js';
import {harness,ready,root} from '../helpers.mjs';
import {treeHash} from '../../dist/server/workspace.js';
const actor='local-session:'+'a'.repeat(64),payload=title=>[{id:'t1',title,done:false}];
async function setup(t){const h=harness(t,0),{p,s}=await ready(h),run=h.engine.create(p.id,s.hash,true);await h.engine.settled(run.id);const current=h.store.run(run.id),data=new ManagedDatasets(h.store,root),maintenance=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>h.engine.jobs.size>0});data.importBrowser(run.id,current.treeHash,payload('备份里的样例数据'),true,hash('import'),actor);return {h,p,run:current,data,maintenance};}
test('state snapshots preserve managed data history and bind their full identity in the original Store',async t=>{
 const {h,maintenance}=await setup(t),snapshot=maintenance.create('managed-data-state');assert.equal(snapshot.application.managedData.datasets,1);assert.equal(snapshot.application.managedData.versions,1);
 const anchor=h.store.db.prepare('SELECT manifest_hash FROM state_snapshot_anchors WHERE snapshot_id=?').get(snapshot.id);assert.equal(anchor.manifest_hash,hash(snapshot));
 assert.throws(()=>h.store.db.prepare('UPDATE state_snapshot_anchors SET manifest_hash=? WHERE snapshot_id=?').run('b'.repeat(64),snapshot.id));
 const rehearsal=maintenance.rehearse(snapshot.id,'readonly-data-rehearsal'),db=new DatabaseSync(resolve(h.dir,'controller/state-rehearsals',rehearsal.id,'application.sqlite'),{readOnly:true});try{assert.equal(JSON.parse(db.prepare('SELECT data_json FROM managed_dataset_versions').get().data_json)[0].title,'备份里的样例数据');}finally{db.close();}
 assert.equal(rehearsal.engineStarted,false);assert.equal(snapshot.completeProjectBackup,false);
});
test('recomputed adjacent manifest and database hashes cannot impersonate the controller-held snapshot identity',async t=>{
 const {h,run,data,maintenance}=await setup(t),a=maintenance.create('before-data-edit');data.writePreview(run.id,run.treeHash,payload('另一份内容'),1,hash('edit'),actor);const b=maintenance.create('after-data-edit');
 const dir=id=>resolve(h.dir,'controller/state-backups',id);copyFileSync(resolve(dir(b.id),'application.sqlite'),resolve(dir(a.id),'application.sqlite'));
 const forged={...a,application:b.application,files:b.files};writeFileSync(resolve(dir(a.id),'manifest.json'),JSON.stringify(forged));
 assert.throws(()=>maintenance.verify(a.id),{code:'MAINTENANCE_SNAPSHOT_ANCHOR_MISMATCH'});assert.equal(data.read(run.projectId).tasks[0].title,'另一份内容');
});
test('a changed managed payload is rejected even if SQLite remains structurally valid',async t=>{
 const {h,maintenance}=await setup(t),snapshot=maintenance.create('dataset-integrity'),path=resolve(h.dir,'controller/state-backups',snapshot.id,'application.sqlite');
 const db=new DatabaseSync(path);db.exec('DROP TRIGGER managed_dataset_versions_no_update');db.prepare('UPDATE managed_dataset_versions SET data_json=?').run(JSON.stringify(payload('被改写的内容')));db.close();
 const manifest=JSON.parse(readFileSync(resolve(h.dir,'controller/state-backups',snapshot.id,'manifest.json'),'utf8'));manifest.files[0].sha256=hash(readFileSync(path));manifest.files[0].bytes=readFileSync(path).length;writeFileSync(resolve(h.dir,'controller/state-backups',snapshot.id,'manifest.json'),JSON.stringify(manifest));
 assert.throws(()=>maintenance.verify(snapshot.id));
});
test('immutable dataset and snapshot rows reject SQL replacement even with recursive delete triggers disabled',async t=>{
 const {h,maintenance}=await setup(t);maintenance.create('immutable-insert');h.store.db.exec('PRAGMA recursive_triggers=OFF');
 for(const table of ['managed_dataset_versions','managed_dataset_operations','state_snapshot_anchors'])assert.throws(()=>h.store.db.exec('INSERT OR REPLACE INTO '+table+' SELECT * FROM '+table+' LIMIT 1'),table);
});
test('verified rehearsal restores only data into a new revision, preserving source, plan and approvals',async t=>{
 const {h,p,run,data,maintenance}=await setup(t),snapshot=maintenance.create('restore-source'),rehearsal=maintenance.rehearse(snapshot.id,'restore-proof');
 data.writePreview(run.id,run.treeHash,payload('恢复前的新内容'),1,hash('newer-data'),actor);
 const before={tree:treeHash(run.workspace),project:h.store.project(p.id),approvals:h.store.db.prepare('SELECT * FROM approvals ORDER BY rowid').all(),spec:h.store.spec(run.specId)};
 const restored=data.restoreFromRehearsal(p.id,2,()=>maintenance.managedDataSource(snapshot.id,rehearsal.id,p.id),hash('restore-data-only'),actor);
 assert.equal(restored.revision,3);assert.equal(restored.tasks[0].title,'备份里的样例数据');assert.deepEqual(new ManagedDatasets(h.store,root).read(p.id).tasks,restored.tasks);
 const after={tree:treeHash(run.workspace),project:h.store.project(p.id),approvals:h.store.db.prepare('SELECT * FROM approvals ORDER BY rowid').all(),spec:h.store.spec(run.specId)};assert.deepEqual(after,before);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM managed_dataset_versions WHERE project_id=?').get(p.id).n,3);assert.equal(h.store.records(p.id,'ModelAttempt').length,0);assert.equal(h.store.records(p.id,'ManagedDataRestore').length,1);
});
test('restore requires current target revision and the same project, and cannot trust a caller receipt flag',async t=>{
 const {h,p,run,data,maintenance}=await setup(t),snapshot=maintenance.create('scope-source'),rehearsal=maintenance.rehearse(snapshot.id,'scope-proof');data.writePreview(run.id,run.treeHash,payload('不可覆盖的内容'),1,hash('scope-edit'),actor);
 assert.throws(()=>data.restoreFromRehearsal(p.id,1,()=>maintenance.managedDataSource(snapshot.id,rehearsal.id,p.id),hash('stale-restore'),actor),{code:'MANAGED_DATA_CONFLICT'});
 const other=h.interviews.create('另一个恢复目标','不能跨项目搬运','demo');assert.throws(()=>data.restoreFromRehearsal(other.id,0,()=>maintenance.managedDataSource(snapshot.id,rehearsal.id,p.id),hash('wrong-target'),actor),{code:'MANAGED_DATA_RESTORE_SOURCE_INVALID'});
 assert.throws(()=>data.restoreFromRehearsal(p.id,2,()=>({verified:true,scope:'FULL_PROJECT_RESTORED'}),hash('fake-receipt'),actor),{code:'MANAGED_DATA_RESTORE_SOURCE_INVALID'});assert.equal(data.read(p.id).revision,2);
});
test('replaying a data restore rechecks actual rehearsal bytes instead of using an old success',async t=>{
 const {h,p,data,maintenance}=await setup(t),snapshot=maintenance.create('replay-source'),rehearsal=maintenance.rehearse(snapshot.id,'replay-proof'),operation=hash('same-restore');
 data.restoreFromRehearsal(p.id,1,()=>maintenance.managedDataSource(snapshot.id,rehearsal.id,p.id),operation,actor);assert.equal(data.read(p.id).revision,2);
 const path=resolve(h.dir,'controller/state-rehearsals',rehearsal.id,'application.sqlite'),bytes=readFileSync(path);bytes[0]^=1;writeFileSync(path,bytes);
 assert.throws(()=>data.restoreFromRehearsal(p.id,1,()=>maintenance.managedDataSource(snapshot.id,rehearsal.id,p.id),operation,actor));assert.equal(data.read(p.id).revision,2);
});
