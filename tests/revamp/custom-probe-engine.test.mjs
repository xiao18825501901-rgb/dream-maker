// OFFLINE factory boundary. No actual SDK/model, credentials or production qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import {harness} from '../helpers.mjs';import {Engine} from '../../dist/server/engine.js';
import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';import {hash} from '../../dist/server/security.js';
import {customProbeNonce,isCustomProbeNonce} from '../../dist/server/security.js';
function fixture(t,patch={},options={}){
 const h=harness(t),preparation={role:'planner2',roleId:'planner2',bindingHash:hash('OFFLINE_BINDING'),configurationHash:hash('OFFLINE_CONFIG'),expiresAt:new Date(Date.now()+60000).toISOString()};let calls=0,signs=0,lastProbeId,lastNonce='';
 const native={assertReady(){throw Error('NO_CLASSIC');},executor(){throw Error('NO_PROJECT');},verify(){throw Error('NO_VERIFIER');},async close(){},
  customProbePreparation:()=>({...preparation}),async prepareCustomProbeEvidence(){},
  async executeCustomRoleProbe(input){calls++;lastNonce=input.nonce;const owned=currentProcessOwnership();assert.ok(owned);assert.equal(owned.projectId,null);assert.equal(owned.runId,null);assert.equal(owned.acceptanceId,input.probeId);
   const grant=JSON.parse(h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchGranted'").get().data);assert.equal(grant.purpose,'CUSTOM_ROLE_PROBE');assert.equal(grant.kind,'planner2');
   return{attemptId:'OFFLINE_ATTEMPT',bindingHash:preparation.bindingHash,observation:{sessionId:'OFFLINE_SESSION'}};
  },
  completeCustomRoleProbe(input){signs++;lastProbeId=input.probeId;assert.equal(currentProcessOwnership(),undefined);const f=JSON.parse(h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchFinished' ORDER BY rowid DESC LIMIT 1").get().data);assert.equal(f.outcome,'COMPLETED');assert.equal(f.cleanupReturned,true);return{evidenceId:'OFFLINE_RECEIPT',probeId:input.probeId,role:'planner2',roleId:'planner2',model:'deepseek-flash',source:'REAL_MODEL_RESPONSE'};},
  customProbeReceipt(selection,roleId,evidenceId){return{evidenceId,probeId:lastProbeId,role:'planner2',roleId,model:'deepseek-flash',source:'REAL_MODEL_RESPONSE'};},...patch};
  if(options.clashEnabled)h.config.clash.enabled=true;
  const engine=new Engine(h.store,h.laya,()=>h.config,h.dir,h.dir,0,native,options.networkRoute);engine.dispatch.binding.measure=()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:8192,sampledAt:new Date().toISOString()});t.after(()=>engine.close());
 const selection={projectId:'OFFLINE_PROJECT',specHash:hash('OFFLINE_SPEC'),profileHash:hash('OFFLINE_PROFILE'),preparation:{identityHash:hash('OFFLINE_ID'),contentHash:hash('OFFLINE_PREP')}};
 return{h,engine,selection,preparation,calls:()=>calls,signs:()=>signs,lastNonce:()=>lastNonce};
}
test('Custom qualification uses a short unpredictable code while retaining legacy receipt validation',async t=>{
 const codes=Array.from({length:64},()=>customProbeNonce());
 assert.equal(new Set(codes).size,codes.length);
 for(const code of codes){assert.match(code,/^dmcp[a-f0-9]{12}$/);assert.equal(isCustomProbeNonce(code),true);}
 assert.equal(isCustomProbeNonce('DM_CUSTOM_PROBE_LEGACY_ACCOUNT'),true);
 for(const bad of ['DM_CUSTOM_PRO#','dmcp','dmcp0123456789ABCDEF','dmcp0123456789abcde','xdmcp0123456789abcdef'])assert.equal(isCustomProbeNonce(bad),false);
 const x=fixture(t);await x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_SHORT_NONCE',true);
 assert.match(x.lastNonce(),/^dmcp[a-f0-9]{12}$/);assert.equal(isCustomProbeNonce(x.lastNonce()),true);
});
test('Custom qualification uses original Dispatch and signs only after completed cleanup, then replays without dispatch',async t=>{
 const x=fixture(t);assert.equal(typeof x.engine.probeCustomRole,'function');await assert.rejects(x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_OP',false),{code:'CUSTOM_PROBE_CONFIRMATION_REQUIRED'});
 const out=await x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_OP',true);assert.equal(out.evidenceId,'OFFLINE_RECEIPT');assert.equal(x.calls(),1);assert.equal(x.signs(),1);assert.equal(x.engine.activeJobCount,0);
 assert.deepEqual(await x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_OP',true),out);assert.equal(x.calls(),1);
 for(const table of ['projects','runs','approvals','workspace_leases'])assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
});
test('Custom qualification holds the existing CFW run lease around the real role dispatch',async t=>{
 let active=false,routeCalls=0;
 const route={async withRun(probeId,signal,action){routeCalls++;assert.match(probeId,/^custom_probe_/);assert.equal(signal.aborted,false);active=true;try{return await action();}finally{active=false;}},async assertRecovered(){assert.equal(active,false);return{scope:'OWNED_CLASH_JOURNALS',pendingLocks:0};},childEnvironment:extra=>extra};
 const x=fixture(t,{}, {clashEnabled:true,networkRoute:route}),execute=x.engine.nativeExecution.executeCustomRoleProbe;
 x.engine.nativeExecution.executeCustomRoleProbe=async input=>{assert.equal(active,true);return execute(input);};
 const out=await x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_CFW_LEASE',true);
 assert.equal(out.evidenceId,'OFFLINE_RECEIPT');assert.equal(routeCalls,1);assert.equal(active,false);assert.equal(x.calls(),1);assert.equal(x.signs(),1);
});
test('Custom qualification fails closed before dispatch when CFW is enabled without the existing route',async t=>{
 const x=fixture(t,{}, {clashEnabled:true});
 await assert.rejects(x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_CFW_REQUIRED',true),{code:'CLASH_RUN_LEASE_REQUIRED'});
 assert.equal(x.calls(),0);assert.equal(x.signs(),0);
});
test('failed Custom qualification retains its intent and never retries the same operation',async t=>{
 const x=fixture(t,{async executeCustomRoleProbe(){throw Object.assign(Error('OFFLINE_TRANSPORT'),{code:'MODEL_GATEWAY_FAILED'});}});assert.equal(typeof x.engine.probeCustomRole,'function');
 await assert.rejects(x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_FAILURE',true),{code:'MODEL_GATEWAY_FAILED'});
 await assert.rejects(x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_FAILURE',true),{code:'CUSTOM_PROBE_RECOVERY_REQUIRED'});assert.equal(x.signs(),0);assert.equal(x.engine.activeJobCount,0);
 const result=JSON.parse(x.h.store.db.prepare("SELECT data FROM records WHERE kind='CustomRoleProbeResult'").get().data);assert.equal(result.status,'FAILED');assert.equal(result.automaticRetry,false);
});
test('Engine shutdown aborts and joins its original Custom qualification without signing',async t=>{
 let entered,started=new Promise(r=>entered=r);const x=fixture(t,{async executeCustomRoleProbe(input){entered();await new Promise(r=>input.signal.addEventListener('abort',r,{once:true}));throw Object.assign(Error('STOP'),{code:'RUN_CANCELLED'});}});assert.equal(typeof x.engine.probeCustomRole,'function');
 const call=x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_CLOSE',true),rejected=assert.rejects(call,{code:'RUN_CANCELLED'});await started;assert.equal(x.engine.activeJobCount,1);await x.engine.close();await rejected;assert.equal(x.signs(),0);assert.equal(x.engine.activeJobCount,0);
});
test('configuration drift after role execution cannot be signed or silently retried',async t=>{
 const x=fixture(t);assert.equal(typeof x.engine.probeCustomRole,'function');const run=x.engine.nativeExecution.executeCustomRoleProbe;
 x.engine.nativeExecution.executeCustomRoleProbe=async input=>{const stage=await run(input);x.preparation.bindingHash=hash('DRIFT');return stage;};
 await assert.rejects(x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_DRIFT',true));assert.equal(x.signs(),0);assert.equal(x.calls(),1);
});
test('an expired qualification deadline cannot prepare keys, dispatch or spend',async t=>{
 const x=fixture(t);x.preparation.expiresAt='2020-01-01T00:00:00Z';
 await assert.rejects(x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_EXPIRED',true),{code:'CUSTOM_PROBE_EXPIRY_REQUIRED'});assert.equal(x.calls(),0);assert.equal(x.signs(),0);
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='CustomRoleProbeIntent'").get().n,0);
});
test('a pre-dispatch refusal is durably closed and the same late request can never start a model',async t=>{const x=fixture(t),original=x.engine.dispatch.snapshot.bind(x.engine.dispatch);x.engine.dispatch.snapshot=()=>({...original(),quarantined:[{reason:'OFFLINE_BUSY'}]});await assert.rejects(x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_REFUSED',true),{code:'CUSTOM_PROBE_BUSY_OR_UNCERTAIN'});x.engine.dispatch.snapshot=original;const closed=await x.engine.customRoleProbeStatus(x.selection,'planner2','OFFLINE_REFUSED');assert.equal(closed.status,'NOT_ADMITTED');assert.equal(closed.executionGranted,false);assert.equal(x.calls(),0);await assert.rejects(x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_REFUSED',true),{code:'CUSTOM_PROBE_NOT_ADMITTED'});assert.equal(x.calls(),0);const fresh=await x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_NEW_EXPLICIT_REQUEST',true);assert.ok(fresh.probeId);assert.equal(x.calls(),1);});
function quarantineProbeDispatch(x,dispatchId,probeId,extra=[]){
 const at=new Date().toISOString(),generation='dispatch_owner_offline_unclean';
 x.h.store.record('DispatchGranted',null,null,{dispatchId,kind:'planner2',mode:'live',resources:{cpu:1,memoryMiB:512,availableMemoryMiB:4096,sampledAt:at},cleanupReturned:false,purpose:'CUSTOM_ROLE_PROBE',acceptanceId:probeId,generation,at});
 x.h.store.record('DispatchFinished',null,null,{dispatchId,outcome:'CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY',cleanupReturned:false,purpose:'CUSTOM_ROLE_PROBE',acceptanceId:probeId,generation,at});
 for(const record of extra)x.h.store.record(record.kind,null,null,record.data);
 x.engine.dispatch.quarantined.set(dispatchId,{projectId:null,runId:null,kind:'planner2',acceptanceId:probeId});
}
test('an unclean Custom probe dispatch with no owned process is closed by an engine-supplied ownership proof',async t=>{
 const x=fixture(t),dispatchId='dispatch_offline_unclean',probeId='custom_probe_offline_unclean';
 quarantineProbeDispatch(x,dispatchId,probeId);
 assert.equal(x.engine.dispatch.snapshot().quarantined.length,1);
 const out=await x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_PROBE_RECONCILED',true);
 assert.equal(out.evidenceId,'OFFLINE_RECEIPT');assert.equal(x.calls(),1);
 const reconciled=JSON.parse(x.h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchReconciled' AND json_extract(data,'$.dispatchId')=?").get(dispatchId).data);
 assert.equal(reconciled.cleanupReturned,true);assert.equal(reconciled.proof.schema,'dream-maker.dispatch-recovery.v1');assert.equal(reconciled.proof.proven,true);
 assert.equal(x.engine.dispatch.snapshot().quarantined.length,0);
});
test('an unclean Custom probe dispatch with an unproven owned process stays quarantined',async t=>{
 const x=fixture(t),dispatchId='dispatch_offline_owned',probeId='custom_probe_offline_owned';
 quarantineProbeDispatch(x,dispatchId,probeId,[{kind:'OwnedProcessIntent',data:{processId:'owned_process_offline',dispatchId,generation:'dispatch_owner_offline_unclean',commandSha256:hash('OFFLINE_COMMAND'),argvSha256:hash('OFFLINE_ARGS'),platform:process.platform,at:new Date().toISOString()}}]);
 await assert.rejects(x.engine.probeCustomRole(x.selection,'planner2','OFFLINE_PROBE_UNPROVEN',true),{code:'CUSTOM_PROBE_BUSY_OR_UNCERTAIN'});
 assert.equal(x.calls(),0);assert.equal(x.signs(),0);
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='DispatchReconciled'").get().n,0);
 assert.equal(x.engine.dispatch.snapshot().quarantined.length,1);
 x.engine.dispatch.quarantined.delete(dispatchId);
});
test('engine close resolves a provably clean probe dispatch instead of refusing to close',async t=>{
 const x=fixture(t),dispatchId='dispatch_offline_close',probeId='custom_probe_offline_close';
 quarantineProbeDispatch(x,dispatchId,probeId);
 await x.engine.close();
 assert.equal(x.engine.dispatch.snapshot().quarantined.length,0);
 const reconciled=JSON.parse(x.h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchReconciled' AND json_extract(data,'$.dispatchId')=?").get(dispatchId).data);
 assert.equal(reconciled.cleanupReturned,true);assert.equal(reconciled.proof.proven,true);
});
