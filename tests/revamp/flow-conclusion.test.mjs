// Real controller/SQLite/offline Demo flow. Not native four-role acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness,ready } from '../helpers.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {inProcessDemoVerifier} from '../fixtures/in-process-demo-verifier.mjs';
test('ending a delivered Flow for an alternative saves a report without accepting or rebuilding',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);inProcessDemoVerifier(h);const {p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);
 assert.equal(h.store.run(r.id).state,'READY_FOR_DELIVERY');
 const ended=await h.engine.conclude(r.id,'ALTERNATIVE','offline-session-actor');
 assert.equal(ended.report.evidenceClass,'OFFLINE_DEMO_NOT_LIVE_AGENT');
 assert.equal(h.store.run(r.id).state,'READY_FOR_DELIVERY');
 assert.equal(h.store.approved(p.id,s.hash,'DELIVERY'),false);
 assert.equal(h.store.runs(p.id).length,1);
 assert.equal((await h.engine.conclude(r.id,'ALTERNATIVE','offline-session-actor')).reportId,ended.reportId);
 await assert.rejects(h.engine.resume(r.id),{code:'RUN_NOT_RESUMABLE'});
 const constraint='我不愿安装额外组件，请保留原有本机数据。';
 const next=h.interviews.alternative(p.id,constraint);
 assert.equal(next.batchSize,5);assert.equal(next.state,'INTERVIEWING');
 assert.equal(next.alternativeContext.userConstraint,constraint);assert.equal(next.idea,p.idea);
 await h.interviews.finish(p.id,'',false);
 const revised=h.store.spec(h.store.project(p.id).specId);assert.equal(revised.requirements.at(-1).text,constraint);
 assert.match(revised.masterPrompt,/USER_ALTERNATIVE_CONSTRAINT/);
 assert.equal(h.store.planVersion(s.id).snapshot.hash,s.hash);
 assert.ok(h.engine.export(r.id).length>0,'old frozen artifact remains exportable');
});
test('paused or uncertain writer cannot end a Flow merely to release its lease',async t=>{
 const h=harness(t,100);fixedControllerCapacity(h.engine);inProcessDemoVerifier(h);const {p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);
 h.engine.pause(r.id);await h.engine.settled(r.id);
 await assert.rejects(h.engine.conclude(r.id,'SAVE','offline-session-actor'),{code:'FLOW_NOT_SETTLED'});
 assert.equal(h.store.owns(p.id,r.id),true);
 await h.engine.cancel(r.id);
});
test('executor completion summaries do not become verified work in the novice report',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);inProcessDemoVerifier(h);const {p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);
 const current=h.store.run(r.id);current.review.verdict='BLOCKED';h.store.saveRun(current);
 const report=h.engine.flowReport(r.id);
 assert.equal(report.verifiedCount,0);
 assert.equal(report.remainingCount,s.requirements.length);
 assert.equal(report.technicalRequirementsMet,false);
 assert.equal(report.userAccepted,false);
});
test('saved Flow keeps a recoverable follow-up; changing next-step choice never edits its original conclusion',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);inProcessDemoVerifier(h);const {p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);
 const first=await h.engine.conclude(r.id,'SAVE','offline-session-actor'),before=h.store.records(p.id,'FlowConclusion')[0];
 const next=await h.engine.conclude(r.id,'ALTERNATIVE','offline-session-actor');
 assert.equal(next.reportId,first.reportId);assert.deepEqual(h.store.records(p.id,'FlowConclusion')[0],before);
 assert.equal(h.store.records(p.id,'FlowFollowup').length,1);assert.equal(h.store.runs(p.id).length,1);
 assert.equal(h.interviews.alternative(p.id).batchSize,5);
});
