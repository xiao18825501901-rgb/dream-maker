// Original Engine/SQLite/queue with fixed Demo and offline helper boundaries; not product Live.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../../dist/server/engine.js';
import {DomainError} from '../../dist/server/security.js';
import {harness,ready,root,until} from '../helpers.mjs';
const deferred=()=>{let resolve;const promise=new Promise(ok=>{resolve=ok;});return {promise,resolve};};

test('pausing all work finishes the current round, stops new runs, and reopens without automatically replaying it',async t=>{
 let reopened;t.after(()=>reopened?.close());const h=harness(t,80),{p,s}=await ready(h),run=h.engine.create(p.id,s.hash,true);
 await until(()=>h.store.records(p.id,'LayaDecision').length>0);
 await h.engine.pauseAll();assert.equal(h.store.run(run.id).state,'PAUSED');assert.equal(h.engine.jobs.size,0);assert.equal(h.store.run(run.id).calls,1);assert.equal(h.store.owns(p.id,run.id),true);const plannerSession=h.store.run(run.id).sessions.planner2;
 assert.throws(()=>h.engine.create(p.id,s.hash,true),{code:'ENGINE_PAUSING'});await assert.rejects(h.engine.resume(run.id),{code:'ENGINE_PAUSING'});
 reopened=new Engine(h.store,h.laya,()=>h.config,root,h.dir,0);reopened.recover();assert.equal(h.store.run(run.id).state,'PAUSED');assert.equal(reopened.jobs.size,0);
 await reopened.resume(run.id);await reopened.settled(run.id);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');assert.equal(h.store.run(run.id).calls,4,'one planner, the two original Demo tasks, and one reviewer');assert.equal(h.store.run(run.id).sessions.planner2,plannerSession);assert.deepEqual(h.store.run(run.id).usage.map(row=>row.role).sort(),['executor','executor','planner2','reviewer']);assert.equal(h.store.approved(p.id,s.hash,'DELIVERY'),false);
});

test('pausing before a delayed helper returns prevents the queued role from beginning',async t=>{
 const h=harness(t,0),{p,s}=await ready(h),entered=deferred(),hold=deferred(),original=h.laya.decide.bind(h.laya);h.laya.decide=async(...args)=>{entered.resolve();await hold.promise;return original(...args);};
 const run=h.engine.create(p.id,s.hash,true);await entered.promise;let pausing;try{pausing=h.engine.pauseAll();}finally{hold.resolve();}
 await pausing;assert.equal(h.store.run(run.id).state,'PAUSED');assert.equal(h.store.events(p.id,0).some(event=>event.type==='role.demo.completed'),false);assert.equal(h.store.run(run.id).usage.length,0);
});

test('resource-queued work pauses without waiting for capacity or producing a new grant',async t=>{
 const h=harness(t,0),{p,s}=await ready(h);h.engine.dispatch.binding.measure=()=>({cpu:1,memoryMiB:0,availableMemoryMiB:1024,sampledAt:new Date().toISOString()});
 const run=h.engine.create(p.id,s.hash,true);await until(()=>h.engine.dispatchStatus().queued.length>0);await h.engine.pauseAll();
 assert.equal(h.store.run(run.id).state,'PAUSED');assert.equal(h.store.run(run.id).calls,0);assert.equal(h.engine.dispatchStatus().queued.length,0);assert.equal(h.store.records(p.id,'DispatchGranted').length,0);
});

test('an existing cleanup quarantine cannot be reported as safely paused or have its lease cleared',async t=>{
 const h=harness(t,0),{p,s}=await ready(h),run=h.engine.create(p.id,s.hash,true);h.engine.pause(run.id);await h.engine.settled(run.id);
 await assert.rejects(h.engine.dispatch.run({projectId:p.id,runId:run.id,kind:'route',mode:'demo',signal:new AbortController().signal},async()=>{throw Error('OFFLINE_UNKNOWN_ROUTE_CLEANUP');}),{code:'PROCESS_CLEANUP_UNPROVEN'});
 await assert.rejects(h.engine.pauseAll(),{code:'ENGINE_PAUSE_UNCERTAIN'});assert.equal(h.engine.dispatchStatus().quarantined.length,1);assert.equal(h.store.owns(p.id,run.id),true);
});

test('a transport failure cannot start an automatic executor continuation after a pause decision',async t=>{
 const h=harness(t,0),{p,s}=await ready(h),run=h.engine.create(p.id,s.hash,true);h.engine.pause(run.id);await h.engine.settled(run.id);let calls=0,pausing;
 const input={role:'executor',workspace:run.workspace,prompt:'OFFLINE_SEGMENT_BOUNDARY',model:'deepseek-flash',specHash:run.specHash,runId:run.id,laya:{role:'executor',mode:'off',adoption:'off'},signal:new AbortController().signal};
 const runner={async run(){calls++;pausing=h.engine.pauseAll();throw new DomainError('RPC_REQUEST_TIMEOUT',409);}};
 await assert.rejects(h.engine.executorSegmented(run,input,runner,'OFFLINE_TASK',{adoption:'off'},()=>{}),{code:'RPC_REQUEST_TIMEOUT'});await pausing;assert.equal(calls,1);assert.equal(h.store.events(p.id,0).some(event=>event.type==='role.segment.dispatch'),false);
});

test('an ungranted executor task stays pending and can actually continue after reopening',async t=>{
 let reopened;t.after(()=>reopened?.close());const h=harness(t,0),{p,s}=await ready(h),original=h.laya.decide.bind(h.laya);
 h.laya.decide=async(role,...args)=>{if(role==='planner2')h.engine.dispatch.binding.measure=()=>({cpu:1,memoryMiB:0,availableMemoryMiB:1024,sampledAt:new Date().toISOString()});return original(role,...args);};
 const run=h.engine.create(p.id,s.hash,true);await until(()=>h.engine.dispatchStatus().queued.some(ticket=>ticket.kind==='executor'));await h.engine.pauseAll();h.laya.decide=original;
 assert.equal(h.store.run(run.id).state,'PAUSED');assert.ok(h.store.run(run.id).tasks.every(task=>task.status==='pending'));
 reopened=new Engine(h.store,h.laya,()=>h.config,root,h.dir,0);reopened.recover();await reopened.resume(run.id);await reopened.settled(run.id);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');
});

test('a safely dropped Live-shaped route pauses without entering a route or manufacturing reconciliation',async t=>{
 // Only scheduling state is Live-shaped in this isolated fixture; no native admission or call occurs.
 const h=harness(t,0);h.config.clash.enabled=true;const runs=[];
 for(let i=0;i<2;i++){const {p,s}=await ready(h),run=h.engine.create(p.id,s.hash,true);h.engine.pause(run.id);await h.engine.settled(run.id);runs.push(run);}
 const hold=deferred(),entered=deferred();const blocker=h.engine.dispatch.run({projectId:runs[0].projectId,runId:runs[0].id,kind:'route',mode:'demo',signal:new AbortController().signal},async control=>{entered.resolve();await hold.promise;control.confirmCleanup();});await entered.promise;
 const target=h.store.run(runs[1].id),project=h.store.project(target.projectId);target.mode='live';target.state='PLANNING';project.mode='live';h.store.saveRun(target);h.store.saveProject(project);let routeCalls=0;
 h.engine.networkRoute={async withRun(){routeCalls++;throw Error('NO_REAL_ROUTE_IN_FIXTURE');},childEnvironment:extra=>extra};
 try{h.engine.launch(target.id);await until(()=>h.engine.dispatchStatus().queued.some(ticket=>ticket.kind==='route'));await h.engine.pauseAll().catch(error=>assert.equal(error.code,'ENGINE_PAUSE_UNCERTAIN'));assert.equal(h.store.run(target.id).state,'PAUSED');assert.equal(routeCalls,0);assert.equal(h.store.owns(target.projectId,target.id),true);}
 finally{hold.resolve();await blocker;}
});

test('cancellation wins when a dropped pause ticket rejects after the cancel decision',async t=>{
 const h=harness(t,0),{p,s}=await ready(h);h.engine.dispatch.binding.measure=()=>({cpu:1,memoryMiB:0,availableMemoryMiB:1024,sampledAt:new Date().toISOString()});
 const run=h.engine.create(p.id,s.hash,true);await until(()=>h.engine.dispatchStatus().queued.length>0);h.engine.pause(run.id);h.engine.dispatch.pauseQueued(run.id);
 const cancelled=await h.engine.cancel(run.id);assert.equal(cancelled.state,'CANCELLED');assert.equal(h.store.owns(p.id,run.id),false);
});

test('an already-queued executor completion cannot open verification after the pause decision',async t=>{
 const h=harness(t,0),{p,s}=await ready(h),started=deferred(),finished=deferred(),original=h.engine.role.bind(h.engine);
 // Only the final completion promise is controlled; actual fixed Demo files/verifier are original.
 h.engine.role=(run,role,prompt,signal,taskId)=>{if(role==='executor'&&taskId==='T2'){started.resolve();return finished.promise;}return original(run,role,prompt,signal,taskId);};
 const run=h.engine.create(p.id,s.hash,true);await started.promise;finished.resolve(null);await h.engine.pauseAll();
 assert.equal(h.store.run(run.id).state,'PAUSED');assert.equal(h.store.run(run.id).phase,'VERIFYING');assert.equal(h.store.records(p.id,'DispatchGranted').filter(row=>row.data.kind==='verifier').length,0);
});

test('a recovered historical pause at completed delivery releases its proven writer on explicit resume',async t=>{
 let reopened;t.after(()=>reopened?.close());const h=harness(t,0),{p,s}=await ready(h),run=h.engine.create(p.id,s.hash,true);await h.engine.settled(run.id);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');
 // Historical bad checkpoint shape observed in the dedicated browser. No proof or acceptance forged.
 const old=h.store.run(run.id);old.state='PAUSED';h.store.tx(()=>{h.store.acquire(p.id,run.id);h.store.saveRun(old);});
 reopened=new Engine(h.store,h.laya,()=>h.config,root,h.dir,0);reopened.recover();assert.equal(h.store.run(run.id).state,'PAUSED');await reopened.resume(run.id);await reopened.settled(run.id);
 assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');assert.equal(h.store.owns(p.id,run.id),false);assert.equal(h.store.approved(p.id,s.hash,'DELIVERY'),false);
});
