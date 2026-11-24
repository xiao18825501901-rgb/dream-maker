// Real local Store/queue, synthetic callbacks only; no native/model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineDispatch} from '../../dist/server/flow/dispatch.js';
import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import {harness} from '../helpers.mjs';
const measure=()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:8192,sampledAt:new Date().toISOString()});
const request=()=>({purpose:'DSH_ENGINEERING_ACCEPTANCE',acceptanceId:'dsh_acceptance_offline',projectId:null,runId:null,kind:'executor',mode:'live',signal:new AbortController().signal});
test('same Engine queue owns engineering work without fake project/run rows',async t=>{
 const h=harness(t),q=new EngineDispatch(h.store,{measure,isCurrent:()=>true});t.after(()=>q.close());
 const value=await q.run(request(),async control=>{const scope=currentProcessOwnership();assert.equal(scope.projectId,null);assert.equal(scope.runId,null);assert.equal(scope.acceptanceId,'dsh_acceptance_offline');control.confirmCleanup();return 'offline';});
 assert.equal(value,'offline');assert.equal(h.store.projects().length,0);assert.equal(h.store.runs().length,0);
 const records=h.store.db.prepare("SELECT project_id,run_id,data FROM records WHERE kind='DispatchGranted'").all();assert.equal(records.length,1);
 assert.equal(records[0].project_id,null);assert.equal(records[0].run_id,null);assert.equal(JSON.parse(records[0].data).acceptanceId,'dsh_acceptance_offline');
});
test('null scopes cannot admit ordinary projects, supervisors, Demo, or a user-project engineering claim',async t=>{
 const h=harness(t),q=new EngineDispatch(h.store,{measure,isCurrent:()=>true});t.after(()=>q.close());let invoked=0;
 for(const patch of [{purpose:undefined},{acceptanceId:'bad'},{kind:'planner2'},{kind:'reviewer'},{mode:'demo'},{projectId:'project_madeup'}])await assert.rejects(q.run({...request(),...patch},async()=>{invoked++;}),{code:'DISPATCH_SCOPE_INVALID'});
 assert.equal(invoked,0);assert.equal(h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='DispatchGranted'").get().n,0);
});
test('uncertain engineering cleanup retains exact identity across queue reconstruction',async t=>{
 const h=harness(t),q=new EngineDispatch(h.store,{measure,isCurrent:()=>true});
 await assert.rejects(q.run(request(),async()=>{throw Error('OFFLINE_UNKNOWN');}),{code:'PROCESS_CLEANUP_UNPROVEN'});await q.close();
 const reopened=new EngineDispatch(h.store,{measure,isCurrent:()=>true});t.after(()=>reopened.close());
 assert.equal(reopened.snapshot().quarantined[0].acceptanceId,'dsh_acceptance_offline');
 assert.equal(reopened.hasUncertain('dsh_acceptance_offline'),true);
 assert.throws(()=>reopened.assertReconciliationReady('dsh_acceptance_offline'),{code:'DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED'});
});
