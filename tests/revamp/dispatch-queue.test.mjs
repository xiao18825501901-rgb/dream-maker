// Deterministic actual callback dispatch, SQLite journal and recovery; not model/OS qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineDispatch } from '../../dist/server/flow/dispatch.js';
import { harness,ready,until } from '../helpers.mjs';
import { capture } from '../../dist/server/process.js';
const resources=()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:8192,sampledAt:new Date().toISOString()});
const completed=action=>async control=>{const value=await action();control.confirmCleanup();return value;};
const latch=()=>{let release;const promise=new Promise(r=>release=r);return{promise,release};};
async function context(t){const h=harness(t),a=await ready(h),b=await ready(h);return{h,a,b};}
function request(p,kind,signal=new AbortController().signal){return{projectId:p.id,runId:'flow_'+p.id,kind,mode:'demo',signal};}
test('a queued actor is frozen before the original grant instead of following caller mutation',async t=>{
 const gate=latch();let queue;t.after(async()=>{gate.release();await queue?.close();});const {h,a,b}=await context(t);queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true});
 const first=queue.run({...request(a.p,'executor'),executorRoleId:'worker-one'},completed(()=>gate.promise));await until(()=>queue.snapshot().active.length===1);
 const pending={...request(b.p,'executor'),executorRoleId:'worker-two'},second=queue.run(pending,completed(async()=>{}));pending.executorRoleId='caller-changed-actor';gate.release();await Promise.all([first,second]);
 assert.equal(h.store.records(b.p.id,'DispatchGranted').at(-1).data.executorRoleId,'worker-two');
 await assert.rejects(queue.run({...request(b.p,'reviewer'),executorRoleId:'worker-two'},completed(async()=>{})),{code:'DISPATCH_EXECUTOR_ROLE_INVALID'});
});
test('executor slot remains serial while a supervisor can actually run and other projects wait',async t=>{
 const {h,a,b}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true}),gate=latch(),started=[];
 const one=queue.run(request(a.p,'executor'),completed(async()=>{started.push('one');await gate.promise;return 1;}));
 await until(()=>started.length===1);
 const two=queue.run(request(b.p,'executor'),completed(async()=>{started.push('two');return 2;}));
 const review=queue.run(request(b.p,'reviewer'),completed(async()=>{started.push('review');return 3;}));
 assert.equal(await review,3);assert.deepEqual(started,['one','review']);
 gate.release();assert.deepEqual(await Promise.all([one,two]),[1,2]);
 assert.equal(queue.snapshot().active.length,0);assert.equal(queue.snapshot().queued.length,0);
 assert.equal(h.store.records(a.p.id,'DispatchGranted').length,1);assert.equal(h.store.records(b.p.id,'DispatchFinished').length,2);
 await queue.close();
});
test('two Custom executors use both measured slots while Classic reserves serial execution',async t=>{
 const {h,a,b}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true}),gate=latch(),started=[];
 const custom=(p,role)=>queue.run({...request(p,'executor'),executorRoleId:role,executorParallelClass:'CUSTOM_MULTI'},completed(async()=>{started.push(role);await gate.promise;return role;}));
 const one=custom(a.p,'custom-worker-one');
 await until(()=>started.length===1);
 const two=custom(b.p,'custom-worker-two');
 await until(()=>started.length===2);
 const classic=queue.run({...request(a.p,'executor'),executorRoleId:'classic-worker'},completed(async()=>{started.push('classic');return 'classic';}));
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.deepEqual(started,['custom-worker-one','custom-worker-two']);
 assert.equal(queue.snapshot().executorSlots,2);
 assert.equal(queue.snapshot().queued.length,1);
 gate.release();
 assert.deepEqual(await Promise.all([one,two,classic]),['custom-worker-one','custom-worker-two','classic']);
 await queue.close();
});
test('two Live Custom executors use two model slots without consuming the supervisor reserve',async t=>{
 const {h,a,b}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true}),gate=latch(),started=[];
 const custom=(p,role)=>queue.run({...request(p,'executor'),mode:'live',executorRoleId:role,executorParallelClass:'CUSTOM_MULTI'},completed(async()=>{started.push(role);await gate.promise;return role;}));
 const one=custom(a.p,'live-custom-one'),two=custom(b.p,'live-custom-two');
 await until(()=>started.length===2);
 assert.deepEqual(started.sort(),['live-custom-one','live-custom-two']);
 assert.equal(queue.snapshot().executorSlots,2);
 assert.equal(queue.snapshot().externalModelSlots,3);
 gate.release();assert.deepEqual(await Promise.all([one,two]),['live-custom-one','live-custom-two']);
 await queue.close();
});
test('two Custom executor slices from the same Run use different scheduling workspaces',async t=>{
 const {h,a}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true}),gate=latch(),started=[];
 const custom=slice=>queue.run({...request(a.p,'executor'),mode:'live',executorRoleId:'worker-'+slice,executorSliceId:'slice-'+slice,executorParallelClass:'CUSTOM_MULTI'},completed(async()=>{started.push(slice);await gate.promise;return slice;}));
 const one=custom('one'),two=custom('two');
 await until(()=>started.length===2);
 assert.deepEqual(started.sort(),['one','two']);
 const queued=h.store.records(a.p.id,'DispatchQueued').filter(row=>row.data.kind==='executor');
 assert.notEqual(queued[0].data.schedulingWorkspace,queued[1].data.schedulingWorkspace);
 gate.release();assert.deepEqual(await Promise.all([one,two]),['one','two']);
 await queue.close();
});
test('executor parallelism class is server-only and invalid on non-executor work',async t=>{
 const {h,a}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true});
 await assert.rejects(queue.run({...request(a,'reviewer'),executorParallelClass:'CUSTOM_MULTI'},completed(async()=>true)),{code:'DISPATCH_EXECUTOR_ROLE_INVALID'});
 await assert.rejects(queue.run({...request(a,'executor'),executorRoleId:'worker',executorParallelClass:'ARBITRARY'},completed(async()=>true)),{code:'DISPATCH_EXECUTOR_ROLE_INVALID'});
 await queue.close();
});
test('cancelled queued work is journaled without a grant or callback invocation',async t=>{
 const {h,a,b}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true}),gate=latch();
 const one=queue.run(request(a.p,'executor'),completed(()=>gate.promise));await until(()=>queue.snapshot().active.length===1);
 const abort=new AbortController();let calls=0;
 const two=queue.run(request(b.p,'executor',abort.signal),completed(async()=>{calls++;}));abort.abort();
 await assert.rejects(two,{code:'RUN_CANCELLED'});assert.equal(calls,0);assert.equal(h.store.records(b.p.id,'DispatchGranted').length,0);
 gate.release();await one;await queue.close();
});
test('cleanup uncertainty survives reconstruction and cannot be released by age',async t=>{
 const {h,a,b}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true});
 const uncertain=Object.assign(new Error('offline cleanup uncertainty'),{code:'PROCESS_CLEANUP_UNPROVEN'});
 await assert.rejects(queue.run(request(a.p,'executor'),async()=>{throw uncertain;}),e=>e===uncertain);
 assert.equal(queue.snapshot().quarantined.length,1);
 const restarted=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true});assert.equal(restarted.snapshot().quarantined.length,1);
 assert.throws(()=>restarted.releaseAfterOwnershipProof('flow_'+a.p.id),{code:'DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED'});
 assert.equal(restarted.snapshot().quarantined.length,1,'an old host.pid check alone cannot clear a newer unknown process');
 const abort=new AbortController();let invoked=false;
 const wait=restarted.run(request(b.p,'executor',abort.signal),completed(async()=>{invoked=true;}));
 assert.equal(invoked,false);abort.abort();await assert.rejects(wait,{code:'RUN_CANCELLED'});
 await queue.close();await restarted.close();
});
test('a changed current Flow fences a late callback result and its durable outcome',async t=>{
 const {h,a}=await context(t);let current=true;const queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>current}),gate=latch();
 const work=queue.run(request(a.p,'executor'),completed(async()=>{await gate.promise;return 'late';}));await until(()=>queue.snapshot().active.length===1);current=false;gate.release();
 await assert.rejects(work,{code:'DISPATCH_RESULT_FENCED'});
 assert.equal(h.store.records(a.p.id,'DispatchFinished')[0].data.outcome,'DISPATCH_RESULT_FENCED');await queue.close();
});
test('an aborted callback completion cannot become a successful dispatch',async t=>{
 const {h,a}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true}),abort=new AbortController();
 const reason=Object.assign(new Error('offline deadline'),{code:'RUN_WALL_TIME_BUDGET_EXCEEDED'});
 await assert.rejects(queue.run(request(a.p,'reviewer',abort.signal),completed(async()=>{abort.abort(reason);return 'late PASS';})),e=>e===reason);
 await queue.close();
});
test('unverified adapter/route failure quarantines even without a cleanup keyword',async t=>{
 const {h,a}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true});
 const error=Object.assign(new Error('offline protocol failure'),{code:'SANDBOX_PROTOCOL_INVALID'});
 await assert.rejects(queue.run(request(a.p,'verifier'),async()=>{throw error;}),{code:'PROCESS_CLEANUP_UNPROVEN'});
 assert.equal(queue.snapshot().quarantined.length,1);await queue.close();
});
test('failed stale-ticket journaling still rejects that ticket and permits cancellation to settle',async t=>{
 const {h,a,b}=await context(t);let current=true;const queue=new EngineDispatch(h.store,{measure:resources,isCurrent:r=>r.projectId!==b.p.id||current}),gate=latch();
 const first=queue.run(request(a.p,'executor'),completed(()=>gate.promise));await until(()=>queue.snapshot().active.length===1);
 const second=queue.run(request(b.p,'executor'),completed(async()=>{})),record=h.store.record.bind(h.store);
 h.store.record=(kind,...args)=>{if(kind==='DispatchDropped')throw Error('offline journal failure');return record(kind,...args);};
 current=false;queue.poke();
 await assert.rejects(Promise.race([second,new Promise((_,reject)=>setTimeout(()=>reject(Error('STRANDED_TICKET')),500))]),{code:'DISPATCH_JOURNAL_UNAVAILABLE'});
 h.store.record=record;gate.release();await first;await queue.close();
});
test('low memory retains supervisor headroom instead of filling it with an executor',async t=>{
 const {h,a,b}=await context(t),queue=new EngineDispatch(h.store,{measure:()=>({...resources(),memoryMiB:1280}),isCurrent:()=>true}),abort=new AbortController();let started=false;
 const work=queue.run({...request(a.p,'executor',abort.signal),mode:'live'},completed(async()=>{started=true;}));
 const supervisor=queue.run({...request(b.p,'reviewer'),mode:'live'},completed(async()=>true));
 assert.equal(await supervisor,true);assert.equal(started,false);
 abort.abort();await assert.rejects(work,{code:'RUN_CANCELLED'});await queue.close();
});

test('SQLite data work reserves measured controller and guest headroom without consuming a model slot',async t=>{
 const {h,a}=await context(t);let memory=1280,calls=0;
 const queue=new EngineDispatch(h.store,{measure:()=>({...resources(),memoryMiB:memory}),isCurrent:()=>true}),abort=new AbortController();
 const work=queue.run({...request(a.p,'data-runtime',abort.signal),mode:'live',dataFormat:'SQLITE_IMAGE_V1'},completed(async()=>{calls++;return 'data';}));
 try{
  const demand=h.store.records(a.p.id,'DispatchQueued').at(-1).data.demand;
  assert.equal(demand.memoryMiB,1536);assert.equal(demand.externalModelSlots,0);assert.equal(demand.executorSlots,0);
  assert.equal(calls,0);assert.equal(queue.snapshot().queued.length,1);
  memory=2048;queue.poke();assert.equal(await work,'data');assert.equal(calls,1);
 }finally{abort.abort();await work.catch(()=>{});await queue.close();}
});

test('fixed Demo reserves its actual supervisor demand without consuming Live headroom',async t=>{
 const {h,a}=await context(t),queue=new EngineDispatch(h.store,{measure:()=>({...resources(),cpu:2,memoryMiB:256}),isCurrent:()=>true}),abort=new AbortController();
 const work=queue.run(request(a.p,'executor',abort.signal),completed(async()=> 'demo-ran')).then(value=>value,error=>error.code);
 try{assert.equal(await Promise.race([work,new Promise(resolve=>setTimeout(()=>resolve('not-granted'),300))]),'demo-ran');}
 finally{abort.abort();await work;await queue.close();}
});
test('a Live dispatch cannot treat root exit and a controller boolean as descendant cleanup',async t=>{
 const {h,a}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true});
 await assert.rejects(queue.run({...request(a.p,'reviewer'),mode:'live'},async control=>{
  await capture(process.execPath,['-e','process.stdout.write("benign")'],{cwd:h.dir});
  control.confirmCleanup();return 'root-exited-only';
 }),{code:'PROCESS_CLEANUP_UNPROVEN'});
 assert.equal(queue.snapshot().quarantined.length,1);
 assert.equal(h.store.records(a.p.id,'DispatchFinished').at(-1).data.cleanupReturned,false);
 await queue.close();
});
test('reconciliation waits for every controller ownership check and does not accept caller booleans',async t=>{
 const {h,a}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true});
 await assert.rejects(queue.run(request(a.p,'reviewer'),async()=>{throw Error('offline interrupted control');}),{code:'PROCESS_CLEANUP_UNPROVEN'});
 const runId='flow_'+a.p.id;
 await assert.rejects(queue.reconcileOwned(runId,async()=>({proven:false})),{code:'DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED'});
 assert.equal(queue.snapshot().quarantined.length,1);
 await assert.rejects(queue.reconcileOwned(runId,async()=>{throw Object.assign(Error('offline active scope'),{code:'PROCESS_OWNERSHIP_ACTIVE'});}),{code:'PROCESS_OWNERSHIP_ACTIVE'});
 assert.equal(queue.snapshot().quarantined.length,1);await queue.close();
});
test('a verifier cancellation with no outstanding owned processes keeps its cause and does not quarantine',async t=>{
 const {h,a}=await context(t),queue=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true});
 h.engine.nativeExecution={assertReady(){},executor(){throw Error('OFFLINE_NOT_CALLED');},async verify(){throw Object.assign(Error('offline verifier cancellation'),{code:'RUN_CANCELLED'});},async close(){}};
 await assert.rejects(queue.run({...request(a.p,'verifier'),mode:'live'},control=>h.engine.verifyOwned({signal:new AbortController().signal},()=>{},control)),{code:'RUN_CANCELLED'});
 assert.equal(queue.snapshot().quarantined.length,0);assert.equal(h.store.records(a.p.id,'DispatchFinished').at(-1).data.cleanupReturned,true);await queue.close();
});
