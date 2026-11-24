// Original Engine/Store with fixed Demo only. No model, native role proof or fee.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {resolve} from 'node:path';
import {ManagedDatasets} from '../../dist/server/managed-data.js';
import {hash,registerCredentialEnv} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {harness,ready,root} from '../helpers.mjs';
const actor='local-session:'+'a'.repeat(64),task=title=>[{id:'task1',title,done:false}],op=name=>hash('OFFLINE_DATA_'+name);
async function setup(t,limits){const h=harness(t,0),{p,s}=await ready(h),run=h.engine.create(p.id,s.hash,true);await h.engine.settled(run.id);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');return {h,p,s,run:h.store.run(run.id),data:new ManagedDatasets(h.store,root,limits)};}

test('business data persists in the original Store without changing source, plans, approvals or model records',async t=>{
 const {h,p,s,run,data}=await setup(t),before={tree:treeHash(run.workspace),spec:h.store.spec(s.id),approvals:h.store.db.prepare('SELECT * FROM approvals ORDER BY rowid').all(),project:h.store.project(p.id)};
 assert.equal(data.read(p.id).revision,0);const first=data.writePreview(run.id,run.treeHash,task('本机用户的实际样例内容'),0,op('first'),actor);
 assert.equal(first.revision,1);assert.equal(first.tasks[0].title,'本机用户的实际样例内容');assert.deepEqual(new ManagedDatasets(h.store,root).read(p.id).tasks,first.tasks);
 const after={tree:treeHash(run.workspace),spec:h.store.spec(s.id),approvals:h.store.db.prepare('SELECT * FROM approvals ORDER BY rowid').all(),project:h.store.project(p.id)};assert.deepEqual(after,before);
 assert.doesNotMatch(JSON.stringify(h.store.records(p.id)),/本机用户的实际样例内容/);assert.equal(h.store.records(p.id,'ModelAttempt').length,0);
});
test('a stale rendered revision is rejected; the operation key binds actual input and repeats return current data',async t=>{
 const {p,run,data}=await setup(t);data.writePreview(run.id,run.treeHash,task('第一份'),0,op('a'),actor);data.writePreview(run.id,run.treeHash,task('第二份'),1,op('b'),actor);
 assert.throws(()=>data.writePreview(run.id,run.treeHash,task('迟到旧页面'),1,op('stale'),actor),{code:'MANAGED_DATA_CONFLICT'});
 assert.equal(data.writePreview(run.id,run.treeHash,task('第一份'),0,op('a'),actor).revision,2);assert.equal(data.read(p.id).tasks[0].title,'第二份');
 assert.throws(()=>data.writePreview(run.id,run.treeHash,task('改了同一个请求'),0,op('a'),actor),{code:'MANAGED_DATA_IDEMPOTENCY_CONFLICT'});
});
test('browser import is explicit, initially empty only, and retains revision history after later edits',async t=>{
 const {h,p,run,data}=await setup(t);assert.throws(()=>data.importBrowser(run.id,run.treeHash,task('旧浏览器内容'),false,op('import-denied'),actor),{code:'MANAGED_DATA_CONSENT_REQUIRED'});
 assert.equal(data.importBrowser(run.id,run.treeHash,task('旧浏览器内容'),true,op('import'),actor).revision,1);
 data.writePreview(run.id,run.treeHash,task('新内容'),1,op('edit'),actor);assert.throws(()=>data.importBrowser(run.id,run.treeHash,task('不得覆盖'),true,op('second-import'),actor),{code:'MANAGED_DATA_ALREADY_EXISTS'});
 const history=h.store.db.prepare('SELECT count(*) n FROM managed_dataset_versions WHERE project_id=?').get(p.id);assert.equal(history.n,2);
 assert.throws(()=>h.store.db.prepare('DELETE FROM managed_dataset_versions WHERE project_id=?').run(p.id));
});
test('unverified source, another project and secret-like inputs cannot acquire dataset write authority',async t=>{
 const {h,p,run,data}=await setup(t);assert.throws(()=>data.writePreview(run.id,'b'.repeat(64),task('bad'),0,op('tree'),actor),{code:'MANAGED_DATA_SOURCE_CHANGED'});
 const other=h.interviews.create('另一个项目','只读空数据','demo');assert.equal(data.read(other.id).revision,0);assert.throws(()=>data.writePreview('missing_run',run.treeHash,task('bad'),0,op('unknown'),actor));
 const saved=process.env.DM_DATA_OFFLINE_CANARY;process.env.DM_DATA_OFFLINE_CANARY='OFFLINE_DATA_CANARY_NOT_A_CREDENTIAL';registerCredentialEnv('DM_DATA_OFFLINE_CANARY');
 try{assert.throws(()=>data.writePreview(run.id,run.treeHash,task(process.env.DM_DATA_OFFLINE_CANARY),0,op('canary'),actor),{code:'MANAGED_DATA_SECRET_DENIED'});}finally{if(saved===undefined)delete process.env.DM_DATA_OFFLINE_CANARY;else process.env.DM_DATA_OFFLINE_CANARY=saved;}
 assert.equal(data.read(p.id).revision,0);assert.equal(data.read(other.id).revision,0);
});
test('changed workspace bytes and extra data fields fail before a data revision is written',async t=>{
 const {p,run,data}=await setup(t);assert.throws(()=>data.writePreview(run.id,run.treeHash,[{...task('x')[0],command:'not-a-capability'}],0,op('fields'),actor),{code:'MANAGED_DATA_INVALID'});
 const path=resolve(run.workspace,'README.md'),bytes=readFileSync(path);writeFileSync(path,Buffer.concat([bytes,Buffer.from('\nOFFLINE_CHANGED\n')]));
 assert.throws(()=>data.writePreview(run.id,run.treeHash,task('bad'),0,op('changed'),actor),{code:'MANAGED_DATA_SOURCE_CHANGED'});assert.equal(data.read(p.id).revision,0);
});
test('revision and no-op operation limits stop writes without deleting prior data or duplicating task payloads',async t=>{
 const {h,p,run,data}=await setup(t,{versions:2,operations:3,bytes:10000});data.writePreview(run.id,run.treeHash,task('one'),0,op('quota1'),actor);data.writePreview(run.id,run.treeHash,task('two'),1,op('quota2'),actor);
 data.writePreview(run.id,run.treeHash,task('two'),2,op('noop'),actor);assert.throws(()=>data.writePreview(run.id,run.treeHash,task('two'),2,op('noop-limit'),actor),{code:'MANAGED_DATA_OPERATION_LIMIT'});
 assert.equal(data.read(p.id).revision,2);assert.equal(h.store.db.prepare('SELECT count(*) n FROM managed_dataset_versions WHERE project_id=?').get(p.id).n,2);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM requests').get().n,0,'dataset idempotency must not cache task payloads in generic HTTP requests');
});
test('a registered legacy browser source remains importable after the controller template changes',async t=>{
 const h=harness(t,0),{p,s}=await ready(h),otherRoot=resolve(h.dir,'legacy-controller'),template=resolve(otherRoot,'examples/study-board');mkdirSync(template,{recursive:true});cpSync(resolve(root,'tests/fixtures/legacy-study-board'),template,{recursive:true});
 cpSync(resolve(root,'prompts'),resolve(otherRoot,'prompts'),{recursive:true});mkdirSync(resolve(otherRoot,'scripts'));cpSync(resolve(root,'scripts/verify-board.mjs'),resolve(otherRoot,'scripts/verify-board.mjs'));
 // A constructor root is changed only in this offline harness before it dispatches any task.
 h.engine.root=otherRoot;const created=h.engine.create(p.id,s.hash,true);await h.engine.settled(created.id);const run=h.store.run(created.id);assert.equal(run.state,'READY_FOR_DELIVERY');assert.equal(run.treeHash,'6fabb72ff9ba50d02d57a01a8c3bcd2590fa1281689dbbde55f33cee44787f72');
 const changed=new ManagedDatasets(h.store,root);assert.notEqual(treeHash(resolve(root,'examples/study-board')),run.treeHash);
 assert.equal(changed.importBrowser(run.id,run.treeHash,task('旧版本浏览器的数据'),true,op('legacy-upgrade'),actor).revision,1);assert.equal(changed.read(p.id).tasks[0].title,'旧版本浏览器的数据');
});
