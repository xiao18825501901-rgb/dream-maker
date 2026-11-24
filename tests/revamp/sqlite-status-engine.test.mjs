// Original Store/Engine/Dispatch plus controlled Windows Job; synthetic project/role state and fixed test capacity, NOT Native proof.
import test from 'node:test';import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';import {hash} from '../../dist/server/security.js';
async function setup(t){
 const h=harness(t),{p,s}=await ready(h),made=h.engine.create(p.id,s.hash,true);await h.engine.settled(made.id);
 const project=h.store.project(p.id);project.mode='live';h.store.saveProject(project);const run=h.store.run(made.id);run.mode='live';h.store.saveRun(run);fixedControllerCapacity(h.engine);
 h.engine.nativeExecution={assertReady(){throw Error('MODEL_AUTH_FORBIDDEN');},executor(){throw Error('MODEL_FORBIDDEN');},async close(){}};
 return {h,p:project,run};
}
test('a foreign active-run reference cannot coalesce another project status or journal a cross-project join',async t=>{
 const {h,p,run}=await setup(t),other=h.interviews.create('另一项目','仅测试错误的项目引用','demo');other.mode='live';other.activeRunId=run.id;h.store.saveProject(other);
 const before=h.store.records(other.id,'SqliteDataReadJoined').length;
 h.engine.dataJobs.set(run.id,{kind:'SQLITE_READ',controller:new AbortController(),projectId:p.id,projectVersion:p.version,runVersion:run.version,promise:Promise.resolve({projectId:p.id,marker:'OFFLINE_OTHER_PROJECT_NOT_FOR_REQUESTER'})});
 try{await assert.rejects(h.engine.sqliteDataStatus(other.id),{code:'SQLITE_DATA_READ_CHANGED'});}finally{h.engine.dataJobs.delete(run.id);}
 assert.equal(h.store.records(other.id,'SqliteDataReadJoined').length,before);
});

test('cancel and pause stop an actually owned status keeper without changing the delivered Flow',async t=>{
 for(const action of ['cancel','pause']){
  const {h,p,run}=await setup(t),before=hash(h.store.run(run.id)),record=h.store.record.bind(h.store);let stop,entered,seen=false;
  const started=new Promise(resolve=>{entered=resolve;});const mock=t.mock.method(h.store,'record',(...args)=>{const value=record(...args);if(!seen&&args[0]==='OwnedWindowsJobPinned'){seen=true;queueMicrotask(()=>{stop=action==='cancel'?h.engine.cancel(run.id):h.engine.pauseAll();stop.catch(()=>{});entered();});}return value;});
  const work=h.engine.sqliteDataStatus(p.id);work.catch(()=>{});let timer;
  try{await Promise.race([started,work.then(()=>{throw Error('STATUS_FINISHED_BEFORE_STOP_BOUNDARY');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OWNED_KEEPER_START_NOT_OBSERVED')),15000);})]);}finally{clearTimeout(timer);}
  await assert.rejects(work,e=>['RUN_CANCELLED','SQLITE_DATA_READ_CANCELLED','APPLICATION_PAUSING'].includes(e.code));await stop;mock.mock.restore();
  assert.equal(seen,true);assert.equal(hash(h.store.run(run.id)),before);assert.equal(h.engine.activeJobCount,0);assert.equal(h.engine.dispatchStatus().quarantined.length,0);
  const requested=h.store.records(p.id,'SqliteDataReadRequested');assert.equal(requested.length,1);const finished=h.store.records(p.id,'DispatchFinished').filter(r=>r.data.dispatchId===requested[0].data.dispatchId);assert.equal(finished.length,1);assert.equal(finished[0].data.cleanupReturned,true);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);assert.equal(h.store.records(p.id,'ModelAttempt').length,0);
 }
});
