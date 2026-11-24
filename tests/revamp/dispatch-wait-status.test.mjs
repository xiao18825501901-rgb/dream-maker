// Actual original queue/journal under explicit offline resource samples. No native role/model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineDispatch} from '../../dist/server/flow/dispatch.js';
import {harness,ready} from '../helpers.mjs';
const measured=(available=1536,cpu=4)=>({cpu,memoryMiB:Math.max(0,available-1024),availableMemoryMiB:available,sampledAt:new Date().toISOString()});
const request=(p,kind,signal)=>({projectId:p.id,runId:'flow_'+p.id,kind,mode:'live',signal});
test('memory wait is a copied observation and original resources resume the same single ticket',async t=>{
 let queue;const abort=new AbortController();t.after(async()=>{abort.abort();await queue?.close();});
 const h=harness(t),a=await ready(h);let available=1536,calls=0;
 queue=new EngineDispatch(h.store,{measure:()=>measured(available),isCurrent:()=>true});
 const work=queue.run(request(a.p,'executor',abort.signal),async control=>{calls++;control.confirmCleanup();return 'OFFLINE_ONCE';});work.catch(()=>{});
 const view=queue.snapshot().queued[0];assert.ok(view.wait);assert.equal(view.wait.scope,'RESOURCE_OBSERVATION_ONLY');
 assert.equal(view.wait.reason,'MEMORY');assert.equal(view.wait.availableMemoryMiB,1536);assert.equal(view.wait.estimatedMemoryGapMiB,1024);
 view.wait.estimatedMemoryGapMiB=0;assert.equal(queue.snapshot().queued[0].wait.estimatedMemoryGapMiB,1024);
 assert.equal(calls,0);assert.equal(h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='DispatchGranted'").get().n,0);
 available=3072;queue.poke();assert.equal(await work,'OFFLINE_ONCE');assert.equal(calls,1);assert.equal(queue.snapshot().queued.length,0);
});
test('a non-memory capacity wait never invents a memory shortage',async t=>{
 let queue;const abort=new AbortController();t.after(async()=>{abort.abort();await queue?.close();});
 const h=harness(t),a=await ready(h);queue=new EngineDispatch(h.store,{measure:()=>measured(8192,0),isCurrent:()=>true});
 const work=queue.run(request(a.p,'executor',abort.signal),async()=>assert.fail('OFFLINE capacity must hold'));work.catch(()=>{});
 assert.equal(queue.snapshot().queued[0].wait?.reason,'CAPACITY');assert.equal(queue.snapshot().queued[0].wait?.estimatedMemoryGapMiB,null);
 abort.abort();await assert.rejects(work,{code:'RUN_CANCELLED'});assert.equal(queue.snapshot().queued.length,0);
});
test('an incomplete resource proposal remains a recheck instead of inventing a grant or exact minimum',async t=>{
 let queue;const abort=new AbortController();t.after(async()=>{abort.abort();await queue?.close();});
 const h=harness(t),a=await ready(h);queue=new EngineDispatch(h.store,{measure:()=>measured(592),isCurrent:()=>true});
 const work=queue.run(request(a.p,'executor',abort.signal),async()=>assert.fail('OFFLINE resource reserve must hold'));work.catch(()=>{});
 assert.equal(queue.snapshot().queued[0].wait?.reason,'RESOURCE_RECHECK');assert.equal(queue.snapshot().queued[0].wait?.availableMemoryMiB,592);assert.equal(queue.snapshot().queued[0].wait?.estimatedMemoryGapMiB,null);
 abort.abort();await assert.rejects(work,{code:'RUN_CANCELLED'});
});
test('cleanup quarantine has priority over a memory explanation',async t=>{
 let queue;const abort=new AbortController();t.after(async()=>{abort.abort();await queue?.close();});
 const h=harness(t),a=await ready(h);queue=new EngineDispatch(h.store,{measure:()=>measured(592),isCurrent:()=>true});
 h.store.record('DispatchGranted',a.p.id,'flow_'+a.p.id,{dispatchId:'OFFLINE_OLD_UNKNOWN',generation:'OFFLINE_OLD_OWNER',kind:'executor',mode:'live'});
 await queue.close();queue=new EngineDispatch(h.store,{measure:()=>measured(592),isCurrent:()=>true});
 const work=queue.run(request(a.p,'reviewer',abort.signal),async()=>assert.fail('OFFLINE quarantine must hold'));work.catch(()=>{});
 assert.equal(queue.snapshot().queued[0].wait?.reason,'CLEANUP');assert.equal(queue.snapshot().queued[0].wait?.estimatedMemoryGapMiB,null);
 abort.abort();await assert.rejects(work,{code:'RUN_CANCELLED'});
});
