// OFFLINE original-Engine lifecycle regression; never Native role evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';
import {DomainError} from '../../dist/server/security.js';

async function parked(t){
  const h=harness(t),{p,s}=await ready(h),launch=h.engine.launch.bind(h.engine);
  h.engine.launch=()=>{};
  const run=h.engine.create(p.id,s.hash,true);
  h.engine.launch=launch;
  return{h,run};
}

test('Classic RPC recovery continues inside the original job and cancellation signal',async t=>{
  const {h,run}=await parked(t),observed=[];
  h.engine.role=async(_run,role,_prompt,signal)=>{
    observed.push({role,signal,job:h.engine.jobs.get(run.id)});
    throw new DomainError(observed.length===1?'RUNNER_RPC_ERROR':'OFFLINE_RETRY_REACHED',502);
  };
  h.engine.launch(run.id);await h.engine.settled(run.id);
  assert.equal(observed.length,2);
  assert.deepEqual(observed.map(x=>x.role),['planner2','executor']);
  assert.ok(observed[0].job);assert.equal(observed[0].job,observed[1].job);
  assert.equal(observed[0].signal,observed[1].signal);
  const final=h.store.run(run.id);
  assert.equal(final.state,'BLOCKED');assert.equal(final.reason,'OFFLINE_RETRY_REACHED');
  assert.equal(final.repairCount,1);assert.equal(h.engine.activeJobCount,0);
});

test('repeated Classic RPC failure stops within the existing repair policy',async t=>{
  const {h,run}=await parked(t);let attempts=0;
  h.engine.role=async()=>{attempts++;throw new DomainError('RUNNER_RPC_ERROR',502);};
  h.engine.launch(run.id);await h.engine.settled(run.id);
  const final=h.store.run(run.id);
  assert.equal(attempts,2);assert.equal(final.state,'BLOCKED');
  assert.equal(final.reason,'REPEATED_FAILURE_NO_PROGRESS');assert.equal(final.repairCount,1);
});

for(const [code,maxRepairs] of [['PROCESS_CLEANUP_UNPROVEN',2],['RUNNER_RPC_ERROR',0]]){
  test('Classic does not retry '+code+' with repair ceiling '+maxRepairs,async t=>{
    const {h,run}=await parked(t);let attempts=0;
    const initial=h.store.run(run.id);initial.maxRepairs=maxRepairs;h.store.saveRun(initial);
    h.engine.role=async()=>{attempts++;throw new DomainError(code,502);};
    h.engine.launch(run.id);await h.engine.settled(run.id);
    const final=h.store.run(run.id);
    assert.equal(attempts,1);assert.equal(final.state,'BLOCKED');assert.equal(final.reason,code);
    assert.equal(final.repairCount,0);assert.equal(h.engine.activeJobCount,0);
  });
}
