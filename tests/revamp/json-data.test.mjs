// Real original Store/SQLite and source-byte checks; seeded Live-shaped metadata is OFFLINE_TEST only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../../dist/server/store.js';
import {JsonDatasets,checkedJsonDocument} from '../../dist/server/json-data.js';
import {hash,registerCredentialEnv} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {harness,ready,root} from '../helpers.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {inProcessDemoVerifier} from '../fixtures/in-process-demo-verifier.mjs';
const actor='local-session:'+'a'.repeat(64),op=name=>hash('OFFLINE_JSON_'+name);
async function setup(t,limits){
 const h=harness(t,0);fixedControllerCapacity(h.engine);inProcessDemoVerifier(h);const {p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);await h.engine.settled(created.id);
 // This is not a native receipt. The test only exercises storage admission against controller records.
 const project=h.store.project(p.id);project.mode='live';h.store.saveProject(project);const run=h.store.run(created.id);run.mode='live';run.review={...run.review,source:'CODEX'};h.store.saveRun(run);
 return {h,p:project,s,run,data:new JsonDatasets(h.store,root,limits)};
}
test('bounded JSON accepts plain business data but rejects cycles, getters, prototype keys and secrets',()=>{
 assert.deepEqual(checkedJsonDocument({list:[{name:'中文',done:false}],count:2,empty:null}),{list:[{name:'中文',done:false}],count:2,empty:null});
 for(const value of [[],null,{x:NaN},{x:undefined},JSON.parse('{"__proto__":{}}'),Object.defineProperty({},'x',{get(){throw Error('must not execute');},enumerable:true})])assert.throws(()=>checkedJsonDocument(value));
 const loop={};loop.self=loop;assert.throws(()=>checkedJsonDocument(loop));let deep={};for(let i=0;i<20;i++)deep={next:deep};assert.throws(()=>checkedJsonDocument(deep));
});
test('JSON versions persist in the original Store and never enter plans, records, prompts or request cache',async t=>{
 const {h,p,s,run,data}=await setup(t),before={source:treeHash(run.workspace),spec:h.store.spec(s.id),approvals:h.store.db.prepare('SELECT * FROM approvals').all()};
 const first=data.write(run.id,run.treeHash,{notes:['用户独立业务内容']},0,op('save'),actor);assert.equal(first.revision,1);assert.equal(first.nativeExecutionGranted,false);
 assert.deepEqual(new JsonDatasets(h.store,root).read(p.id).document,first.document);assert.deepEqual(h.store.spec(s.id),before.spec);assert.equal(treeHash(run.workspace),before.source);assert.deepEqual(h.store.db.prepare('SELECT * FROM approvals').all(),before.approvals);
 assert.doesNotMatch(JSON.stringify(h.store.records(p.id)),/用户独立业务内容/);assert.doesNotMatch(JSON.stringify(h.store.events(p.id,0)),/用户独立业务内容/);assert.equal(h.store.db.prepare('SELECT count(*) n FROM requests').get().n,0);
});
test('stale JSON writes are rejected and replay reads current data without rebasing old input',async t=>{
 const {p,run,data}=await setup(t);data.write(run.id,run.treeHash,{v:1},0,op('one'),actor);data.write(run.id,run.treeHash,{v:2},1,op('two'),actor);
 assert.throws(()=>data.write(run.id,run.treeHash,{v:3},1,op('late'),actor),{code:'JSON_DATA_CONFLICT'});assert.deepEqual(data.write(run.id,run.treeHash,{v:1},0,op('one'),actor).document,{v:2});assert.throws(()=>data.write(run.id,run.treeHash,{v:9},0,op('one'),actor),{code:'JSON_DATA_IDEMPOTENCY_CONFLICT'});
 assert.deepEqual(data.read(p.id).document,{v:2});
});
test('explicit import, different projects, changed source and uncertain delivery remain separated',async t=>{
 const {h,p,run,data}=await setup(t);assert.throws(()=>data.import(run.id,run.treeHash,{a:1},false,op('denied'),actor),{code:'JSON_DATA_CONSENT_REQUIRED'});data.import(run.id,run.treeHash,{a:1},true,op('import'),actor);assert.throws(()=>data.import(run.id,run.treeHash,{a:2},true,op('overwrite'),actor),{code:'JSON_DATA_ALREADY_EXISTS'});
 const other=h.interviews.create('另一个','保持独立','demo');assert.throws(()=>data.read(other.id),{code:'JSON_DATA_LIVE_ONLY'});assert.equal(data.read(p.id).revision,1);
 writeFileSync(resolve(run.workspace,'extra.txt'),'changed');assert.throws(()=>data.write(run.id,run.treeHash,{a:3},1,op('changed'),actor),{code:'JSON_DATA_SOURCE_CHANGED'});
});
test('registered credentials and history quotas reject before changing prior data',async t=>{
 const {run,data}=await setup(t,{versions:1,operations:2,bytes:10000}),saved=process.env.DM_JSON_CANARY;process.env.DM_JSON_CANARY='OFFLINE_JSON_CANARY_NOT_A_REAL_SECRET';registerCredentialEnv('DM_JSON_CANARY');
 try{assert.throws(()=>data.write(run.id,run.treeHash,{value:process.env.DM_JSON_CANARY},0,op('secret'),actor),{code:'JSON_DATA_SECRET_DENIED'});}finally{if(saved===undefined)delete process.env.DM_JSON_CANARY;else process.env.DM_JSON_CANARY=saved;}
 data.write(run.id,run.treeHash,{v:1},0,op('limit1'),actor);assert.throws(()=>data.write(run.id,run.treeHash,{v:2},1,op('limit2'),actor),{code:'JSON_DATA_VERSION_LIMIT'});assert.equal(data.read(run.projectId).revision,1);
});
test('anchored snapshot and rehearsal restore JSON as a new revision, rechecking tampering on replay',async t=>{
 const {h,p,run,data}=await setup(t),maintenance=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>false});data.write(run.id,run.treeHash,{v:'保留内容'},0,op('snapshot-data'),actor);
 const snapshot=maintenance.create('json-snapshot'),rehearsal=maintenance.rehearse(snapshot.id,'json-rehearsal');assert.equal(snapshot.application.managedData.datasets,1);
 data.write(run.id,run.treeHash,{v:'后续修改'},1,op('edit-after-backup'),actor);
 const source=()=>maintenance.jsonDataSource(snapshot.id,rehearsal.id,p.id),result=data.restore(p.id,2,source,op('restore'),actor);assert.equal(result.revision,3);assert.deepEqual(result.document,{v:'保留内容'});assert.equal(result.nativeExecutionGranted,false);
 assert.equal(data.restore(p.id,2,source,op('restore'),actor).revision,3);assert.throws(()=>data.restore(p.id,1,source,op('stale-restore'),actor),{code:'JSON_DATA_CONFLICT'});
 writeFileSync(resolve(h.dir,'controller/state-rehearsals',rehearsal.id,'application.sqlite'),'tampered owned fixture');assert.throws(()=>data.restore(p.id,2,source,op('restore'),actor));assert.equal(data.read(p.id).revision,3);
});
test('array accessors and toJSON hooks are rejected without invoking them',()=>{
 let calls=0;const list=[1];Object.defineProperty(list,'toJSON',{value(){calls++;return [];},enumerable:false});assert.throws(()=>checkedJsonDocument({list}));assert.equal(calls,0);
});

test('inherited array serialization cannot execute or poison the persisted head',async t=>{
 const {p,run,data}=await setup(t);let calls=0;
 const list=Object.setPrototypeOf([1],{toJSON(){calls++;return [{constructor:7}];}});
 assert.throws(()=>data.write(run.id,run.treeHash,{list},0,op('inherited-array'),actor),{code:'JSON_DATA_INVALID'});
 assert.equal(calls,0);assert.equal(data.read(p.id).revision,0);
 assert.deepEqual(data.write(run.id,run.treeHash,{list:[1]},0,op('ordinary-array'),actor).document,{list:[1]});
});

test('JSON validation rejects proxies before executing reflection traps at any depth',()=>{
 for(const nested of [false,true]){
  let calls=0;const proxy=new Proxy({ok:1},{ownKeys(target){calls++;return Reflect.ownKeys(target);},getPrototypeOf(target){calls++;return Reflect.getPrototypeOf(target);}});
  assert.throws(()=>checkedJsonDocument(nested?{nested:proxy}:proxy),{code:'JSON_DATA_INVALID'});assert.equal(calls,0);
 }
});

test('restore and its replay recheck current source bytes and user approvals',async t=>{
 const {h,p,run,data}=await setup(t),maintenance=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>false});
 data.write(run.id,run.treeHash,{v:1},0,op('admission-save'),actor);
 const snapshot=maintenance.create('admission-snapshot'),rehearsal=maintenance.rehearse(snapshot.id,'admission-rehearsal');
 const source=()=>maintenance.jsonDataSource(snapshot.id,rehearsal.id,p.id);
 const result=data.restore(p.id,1,source,op('admitted-restore'),actor);assert.equal(result.revision,2);
 const changed=resolve(run.workspace,'admission-changed.txt');writeFileSync(changed,'not the approved source');
 assert.throws(()=>data.restore(p.id,2,source,op('changed-restore'),actor),{code:'JSON_DATA_SOURCE_CHANGED'});
 assert.throws(()=>data.restore(p.id,1,source,op('admitted-restore'),actor),{code:'JSON_DATA_SOURCE_CHANGED'});
 const {rmSync}=await import('node:fs');rmSync(changed);
 h.store.db.prepare('DELETE FROM approvals WHERE project_id=?').run(p.id);
 assert.throws(()=>data.restore(p.id,2,source,op('revoked-restore'),actor),{code:'JSON_DATA_SOURCE_UNVERIFIED'});
 assert.throws(()=>data.restore(p.id,1,source,op('admitted-restore'),actor),{code:'JSON_DATA_SOURCE_UNVERIFIED'});
 assert.equal(data.read(p.id).revision,2);
});
