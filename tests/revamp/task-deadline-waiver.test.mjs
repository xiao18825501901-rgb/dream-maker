import test from 'node:test';import assert from 'node:assert/strict';
import {reviewWindowFixture} from '../fixtures/review-window.mjs';
import {hash} from '../../dist/server/security.js';
import {runDeadline,taskDeadlineWaiverEvidence} from '../../dist/server/review-window.js';

async function setup(t){
 const x=await reviewWindowFixture(t);await x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor);t.mock.timers.tick(3600001);
 const before=x.h.store.run(x.r.id),request={confirmed:true,sourceHash:before.treeHash,expectedVersion:before.version};
 return {...x,before,request};
}
test('an explicit owner waiver removes only the overall task deadline and preserves all counters',async t=>{
 const x=await setup(t),after=await x.h.engine.approveTaskDeadlineWaiver(x.r.id,x.request,x.actor);
 assert.equal(after.state,x.before.state);assert.equal(after.reason,x.before.reason);assert.equal(runDeadline(x.h.store,after),Infinity);
 for(const key of ['calls','maxCalls','repairCount','maxRepairs','createdAt','maxSeconds','treeHash','reviewWindow'])assert.deepEqual(after[key],x.before[key]);
 const rows=x.h.store.records(x.p.id,'TaskDeadlineWaiverApproval');assert.equal(rows.length,1);
 assert.equal(rows[0].data.scope,'OWNER_PROJECT_TASK_DEADLINES_DISABLED');assert.equal(rows[0].data.taskDeadline,null);
 assert.equal(rows[0].data.technicalTimeoutsPreserved,true);assert.equal(rows[0].data.modelDispatched,false);
 assert.equal(taskDeadlineWaiverEvidence(x.h.store,after)?.scope,'OWNER_PROJECT_TASK_DEADLINES_DISABLED');
});
for(const [name,alter]of [
 ['record tamper',x=>{const row=x.h.store.records(x.p.id,'TaskDeadlineWaiverApproval')[0];x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.taskDeadline',3600) WHERE id=?").run(row.id);}],
 ['clock drift',x=>{const r=x.h.store.run(x.r.id);r.createdAt=new Date(Date.parse(r.createdAt)+1).toISOString();x.h.store.saveRun(r);}],
 ['counter regression',x=>{const r=x.h.store.run(x.r.id);r.calls--;x.h.store.saveRun(r);}],
 ['limit expansion',x=>{const r=x.h.store.run(x.r.id);r.maxCalls++;x.h.store.saveRun(r);}],
 ['foreign project binding',x=>{const r=x.h.store.run(x.r.id);const record=x.h.store.records(x.p.id,'TaskDeadlineWaiverApproval')[0];const data={...record.data,projectId:'project_other'};x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),record.id);r.taskDeadlineWaiver.sha256=hash(data);x.h.store.saveRun(r);}]
])test('task deadline waiver fails closed after '+name,async t=>{
 const x=await setup(t);await x.h.engine.approveTaskDeadlineWaiver(x.r.id,x.request,x.actor);alter(x);assert.throws(()=>runDeadline(x.h.store,x.h.store.run(x.r.id)),{code:'TASK_DEADLINE_WAIVER_INVALID'});
});
test('a duplicate or non-owner waiver request creates no second approval',async t=>{
 const x=await setup(t);await x.h.engine.approveTaskDeadlineWaiver(x.r.id,x.request,x.actor);
 await assert.rejects(x.h.engine.approveTaskDeadlineWaiver(x.r.id,x.request,x.actor),{code:'TASK_DEADLINE_WAIVER_ALREADY_PRESENT'});
 assert.equal(x.h.store.records(x.p.id,'TaskDeadlineWaiverApproval').length,1);
 await assert.rejects(x.h.engine.approveTaskDeadlineWaiver(x.r.id,{...x.request,expectedVersion:x.h.store.run(x.r.id).version},'MODEL_CLAIM'),{code:'TASK_DEADLINE_WAIVER_CONFIRMATION_REQUIRED'});
});
