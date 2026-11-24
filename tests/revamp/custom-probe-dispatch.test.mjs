// Original queue/Store and synthetic callbacks, not model or OS qualification.
import test from 'node:test';import assert from 'node:assert/strict';import {EngineDispatch} from '../../dist/server/flow/dispatch.js';import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';import {harness} from '../helpers.mjs';
import {DomainError} from '../../dist/server/security.js';
const measure=()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:8192,sampledAt:new Date().toISOString()}),request=role=>({purpose:'CUSTOM_ROLE_PROBE',acceptanceId:'custom_probe_OFFLINE_'+role,projectId:null,runId:null,kind:role,mode:'live',signal:new AbortController().signal,...(role==='executor'?{executorRoleId:'execA'}:{})});
for(const role of ['planner2','executor','reviewer'])test('original queue admits only scoped Custom '+role+' probes without fabricated runs',async t=>{
 const h=harness(t),q=new EngineDispatch(h.store,{measure,isCurrent:()=>true});t.after(()=>q.close());const value=await q.run(request(role),async ctl=>{assert.equal(currentProcessOwnership().acceptanceId,request(role).acceptanceId);ctl.confirmCleanup();return'OFFLINE';});assert.equal(value,'OFFLINE');assert.equal(h.store.projects().length,0);assert.equal(h.store.runs().length,0);const row=h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchGranted'").get();assert.equal(JSON.parse(row.data).purpose,'CUSTOM_ROLE_PROBE');if(role==='executor')assert.equal(JSON.parse(row.data).executorRoleId,'execA');
});
test('Custom probe scope cannot borrow a product run, Demo, verifier or missing Executor identity',async t=>{
 const h=harness(t),q=new EngineDispatch(h.store,{measure,isCurrent:()=>true});t.after(()=>q.close());let calls=0;for(const patch of [{projectId:'foreign'},{runId:'foreign'},{mode:'demo'},{kind:'verifier',executorRoleId:undefined},{acceptanceId:'dsh_acceptance_other'},{executorRoleId:undefined}])await assert.rejects(q.run({...request('executor'),...patch},async()=>{calls++;}),{code:'DISPATCH_SCOPE_INVALID'});assert.equal(calls,0);assert.equal(h.store.db.prepare('SELECT count(*) n FROM records').get().n,0);
});
for(const code of ['CLASH_RESTORE_READBACK_MISMATCH','PROCESS_CLEANUP_UNPROVEN'])test('recognized '+code+' overrides an optimistic cleanup confirmation and survives reconstruction',async t=>{
 const h=harness(t),q=new EngineDispatch(h.store,{measure,isCurrent:()=>true}),r=request('planner2');t.after(()=>q.close());
 await assert.rejects(q.run(r,async ctl=>{try{throw new DomainError(code,409);}finally{ctl.confirmCleanup();}}),{code:'PROCESS_CLEANUP_UNPROVEN'});
 assert.equal(q.snapshot().quarantined.length,1);assert.equal(JSON.parse(h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchFinished'").get().data).cleanupReturned,false);await q.close();
 const restored=new EngineDispatch(h.store,{measure,isCurrent:()=>true});t.after(()=>restored.close());assert.equal(restored.hasUncertain(r.acceptanceId),true);assert.throws(()=>restored.assertReconciliationReady(r.acceptanceId),{code:'DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED'});
});
test('one Custom probe identity has only one original grant across active dispatches and queue reconstruction',async t=>{
 const h=harness(t),q=new EngineDispatch(h.store,{measure,isCurrent:()=>true}),r=request('planner2');t.after(()=>q.close());let calls=0;const one=q.run(r,async ctl=>{calls++;ctl.confirmCleanup();}),two=q.run(r,async ctl=>{calls++;ctl.confirmCleanup();});two.catch(()=>{});
 await one;await assert.rejects(two,{code:'CUSTOM_PROBE_ID_REUSED'});await q.close();
 const restored=new EngineDispatch(h.store,{measure,isCurrent:()=>true});t.after(()=>restored.close());await assert.rejects(restored.run(r,async ctl=>{calls++;ctl.confirmCleanup();}),{code:'CUSTOM_PROBE_ID_REUSED'});assert.equal(calls,1);assert.equal(h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='DispatchGranted'").get().n,1);
});
test('two queues cannot both grant the same probe after waiting for resources',async t=>{
 const h=harness(t);let ready=false,calls=0;const resources=()=>ready?measure():{cpu:4,memoryMiB:0,availableMemoryMiB:0,sampledAt:new Date().toISOString()},q=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true}),other=new EngineDispatch(h.store,{measure:resources,isCurrent:()=>true}),r=request('reviewer');t.after(async()=>{await q.close();await other.close();});
 const action=async ctl=>{calls++;ctl.confirmCleanup();},one=q.run(r,action),two=other.run(r,action);two.catch(()=>{});ready=true;q.poke();other.poke();await one;await assert.rejects(two,{code:'CUSTOM_PROBE_ID_REUSED'});assert.equal(calls,1);assert.equal(h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='DispatchGranted'").get().n,1);
});
test('a probe identity changed by the existing log redactor cannot enter the queue',async t=>{
 const h=harness(t),q=new EngineDispatch(h.store,{measure,isCurrent:()=>true});t.after(()=>q.close());let calls=0;
 const r={...request('planner2'),acceptanceId:'custom_probe_x-'+['sk','ABCDEFGHIJKL'].join('-')};
 await assert.rejects(q.run(r,async ctl=>{calls++;ctl.confirmCleanup();}),{code:'DISPATCH_SCOPE_INVALID'});assert.equal(calls,0);assert.equal(h.store.db.prepare('SELECT count(*) n FROM records').get().n,0);
});
