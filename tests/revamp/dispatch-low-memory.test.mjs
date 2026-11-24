// OFFLINE original SQLite/Dispatch callbacks. Synthetic samples are not Native qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineDispatch,dispatchResourcesFromSample} from '../../dist/server/flow/dispatch.js';
import {harness} from '../helpers.mjs';
const request=(kind,signal)=>({projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',kind,mode:'live',signal});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
test('1GiB measured floor preserves real demand and 512MiB low-memory host margin',()=>{
 assert.equal(dispatchResourcesFromSample(4,1023).memoryMiB,0);
 assert.equal(dispatchResourcesFromSample(4,1024).memoryMiB,512);
 assert.equal(dispatchResourcesFromSample(4,1536).memoryMiB,1024);
 assert.equal(dispatchResourcesFromSample(4,3072).memoryMiB,2048);
 assert.equal(dispatchResourcesFromSample(4,3072).serialLowMemory,false);
});
test('a supervisor starts at1024 but an Executor waits until its unchanged full demand fits',async t=>{
 const h=harness(t);let free=1024;const q=new EngineDispatch(h.store,{measure:()=>dispatchResourcesFromSample(4,free),isCurrent:()=>true}),c=new AbortController();
 t.after(async()=>{c.abort();await q.close();});
 await q.run(request('planner2',c.signal),async ctl=>ctl.confirmCleanup());
 let started=false;const work=q.run(request('executor',c.signal),async ctl=>{started=true;ctl.confirmCleanup();});work.catch(()=>{});
 assert.equal(started,false);free=1536;q.poke();await work;assert.equal(started,true);
 const grant=JSON.parse(h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchGranted' ORDER BY rowid DESC LIMIT 1").get().data);
 assert.equal(grant.resourceMode,'EXCLUSIVE_LOW_MEMORY');assert.equal(grant.resources.availableMemoryMiB,1536);
});
test('low-memory grant stays exclusive after memory recovers and permits the zero-memory route parent',async t=>{
 const h=harness(t);let free=1536;const q=new EngineDispatch(h.store,{measure:()=>dispatchResourcesFromSample(4,free),isCurrent:()=>true}),c=new AbortController(),held=deferred(),release=deferred();
 t.after(async()=>{release.resolve();c.abort();await q.close();});
 const route=q.run(request('route',c.signal),async ctl=>{await held.promise;ctl.confirmCleanup();});route.catch(()=>{});
 const first=q.run(request('executor',c.signal),async ctl=>{await release.promise;ctl.confirmCleanup();});first.catch(()=>{});
 assert.equal(q.snapshot().active.length,2);free=8192;let secondStarted=false;
 const next=q.run(request('reviewer',c.signal),async ctl=>{secondStarted=true;ctl.confirmCleanup();});next.catch(()=>{});
 assert.equal(secondStarted,false);release.resolve();await first;await next;held.resolve();await route;assert.equal(secondStarted,true);
});
test('below1GiB no callback starts, while cancellation still settles the queue',async t=>{
 const h=harness(t),q=new EngineDispatch(h.store,{measure:()=>dispatchResourcesFromSample(4,1023),isCurrent:()=>true}),c=new AbortController();
 t.after(()=>q.close());let starts=0;const work=q.run(request('reviewer',c.signal),async ctl=>{starts++;ctl.confirmCleanup();});work.catch(()=>{});
 c.abort();await assert.rejects(work,{code:'RUN_CANCELLED'});assert.equal(starts,0);
});
