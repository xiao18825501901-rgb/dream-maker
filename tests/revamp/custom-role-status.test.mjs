// OFFLINE factory and records in a private original Store. Not role/model evidence.
import test from 'node:test';import assert from 'node:assert/strict';
import {harness} from '../helpers.mjs';import {Engine} from '../../dist/server/engine.js';import {hash} from '../../dist/server/security.js';
function fixture(t){const h=harness(t),selection={projectId:'OFFLINE_PROJECT',specHash:hash('SPEC'),profileHash:hash('PROFILE'),preparation:{identityHash:hash('ID'),contentHash:hash('PREP')}};
 const preparation={role:'planner2',roleId:'planner2',bindingHash:hash('BINDING'),configurationHash:hash('CONFIG'),expiresAt:'2030-01-01T00:00:00.000Z'};let dispatches=0,reads=0;
 const native={assertReady(){throw Error('NO_CLASSIC');},executor(){throw Error('NO_EXECUTOR');},verify(){throw Error('NO_VERIFY');},async close(){},customProbePreparation:()=>({...preparation}),async prepareCustomProbeEvidence(){},async executeCustomRoleProbe(){dispatches++;throw Error('NO_MODEL');},completeCustomRoleProbe(){throw Error('NO_SIGN');},customProbeReceipt:(s,r,id)=>{reads++;return{role:'planner2',roleId:r,evidenceId:id,probeId:'custom_probe_OFFLINE',model:'deepseek-flash',source:'REAL_MODEL_RESPONSE'};}};
 const engine=new Engine(h.store,h.laya,()=>h.config,h.dir,h.dir,0,native);t.after(()=>engine.close());
 const intent=()=>h.store.record('CustomRoleProbeIntent',null,null,{probeId:'custom_probe_OFFLINE',operationHash:hash('OP'),selectionHash:hash({selection,roleId:'planner2'}),preparation,purpose:'MINIMUM_ROLE_ONLY',automaticRetry:false,at:'2026-11-04T00:00:00.000Z'});
 const result=(status,code)=>h.store.record('CustomRoleProbeResult',null,null,{probeId:'custom_probe_OFFLINE',status,...(code?{code}:{}),...(status==='QUALIFIED_MINIMUM_ROLE_ONLY'?{receipt:{evidenceId:'OFFLINE_RECEIPT'}}:{}),automaticRetry:false,at:'2026-11-04T00:01:00.000Z'});
 return{h,engine,native,selection,preparation,intent,result,dispatches:()=>dispatches,reads:()=>reads};}
test('role status reads original records without model dispatch, signing, runs or approvals',async t=>{const x=fixture(t);assert.equal(typeof x.engine.customRoleProbeStatus,'function');
 const first=await x.engine.customRoleProbeStatus(x.selection,'planner2');assert.equal(first.status,'NOT_RUN');assert.equal(first.executionGranted,false);assert.equal(first.fourRoleLive,'NOT_RUN');
 x.intent();x.result('QUALIFIED_MINIMUM_ROLE_ONLY');const before=x.h.store.db.prepare('SELECT count(*) n FROM records').get().n;
 const done=await x.engine.customRoleProbeStatus(x.selection,'planner2');assert.equal(done.status,'PASSED_MINIMUM');assert.equal(done.evidenceId,'OFFLINE_RECEIPT');assert.equal(done.configurationHash,x.preparation.configurationHash);assert.equal(x.reads(),1);assert.equal(x.dispatches(),0);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM records').get().n,before);
 for(const table of ['runs','approvals','workspace_leases'])assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
});
test('a missing or duplicate terminal result is uncertain and cannot become role success',async t=>{const x=fixture(t);assert.equal(typeof x.engine.customRoleProbeStatus,'function');x.intent();assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2')).status,'UNCERTAIN');x.result('QUALIFIED_MINIMUM_ROLE_ONLY');x.result('FAILED');assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2')).status,'UNCERTAIN');assert.equal(x.reads(),0);});
test('failure stays readable after eligibility changes, while old success never grants new eligibility',async t=>{const x=fixture(t);assert.equal(typeof x.engine.customRoleProbeStatus,'function');x.intent();x.result('FAILED');x.preparation.bindingHash=hash('CHANGED');assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2')).status,'FAILED');assert.equal(x.dispatches(),0);assert.equal(x.reads(),0);const y=fixture(t);y.intent();y.result('QUALIFIED_MINIMUM_ROLE_ONLY');y.preparation.bindingHash=hash('CHANGED');assert.equal((await y.engine.customRoleProbeStatus(y.selection,'planner2')).status,'NOT_CURRENT');assert.equal(y.reads(),0);});
test('expired current eligibility cannot hide original failure or promote a recorded success',async t=>{const x=fixture(t);x.intent();x.result('FAILED');x.native.customProbePreparation=()=>{throw Object.assign(Error('OFFLINE_EXPIRED'),{code:'CUSTOM_PROBE_EXPIRY_REQUIRED'});};assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2','OP')).status,'FAILED');const y=fixture(t);y.intent();y.result('QUALIFIED_MINIMUM_ROLE_ONLY');y.native.customProbePreparation=x.native.customProbePreparation;assert.equal((await y.engine.customRoleProbeStatus(y.selection,'planner2','OP')).status,'NOT_CURRENT');assert.equal(x.dispatches()+y.dispatches(),0);assert.equal(x.reads()+y.reads(),0);});
test('a historical complete flag cannot override rejected signature or foreign receipt',async t=>{const x=fixture(t);assert.equal(typeof x.engine.customRoleProbeStatus,'function');x.intent();x.result('QUALIFIED_MINIMUM_ROLE_ONLY');x.native.customProbeReceipt=()=>{throw Error('NO_SIGNATURE');};assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2')).status,'NOT_CURRENT');x.native.customProbeReceipt=()=>({role:'reviewer',roleId:'reviewer',evidenceId:'OTHER',model:'other',source:'REAL_MODEL_RESPONSE'});assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2')).status,'NOT_CURRENT');assert.equal(x.dispatches(),0);});
test('another valid role receipt cannot settle this exact original probe',async t=>{const x=fixture(t);x.intent();x.result('QUALIFIED_MINIMUM_ROLE_ONLY');x.native.customProbeReceipt=()=>({role:'planner2',roleId:'planner2',evidenceId:'OFFLINE_RECEIPT',probeId:'custom_probe_DIFFERENT',model:'deepseek-flash',source:'REAL_MODEL_RESPONSE'});assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2','OP')).status,'NOT_CURRENT');});
test('exact operation reads cannot use a different successful attempt to settle an unknown request',async t=>{const x=fixture(t);assert.equal(typeof x.engine.customRoleProbeStatus,'function');x.intent();x.result('QUALIFIED_MINIMUM_ROLE_ONLY');assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2','OTHER_OP')).status,'NOT_RUN');assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2','OP')).status,'PASSED_MINIMUM');await assert.rejects(x.engine.customRoleProbeStatus({...x.selection,profileHash:hash('OTHER')},'planner2','OP'),{code:'CUSTOM_PROBE_BINDING_CHANGED'});assert.equal(x.dispatches(),0);});

test('ordinary failed probes remain closed even when a client or fixture claims no effect',async t=>{
 const x=fixture(t);
 x.intent();
 x.result('FAILED','NATIVE_PRICE_ROUTE_MISMATCH');
 x.native.customProbeFailureDisposition=()=>false;
 assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2','OP')).status,'FAILED');
 x.native.customProbeFailureDisposition=()=>{throw Error('OFFLINE_DISPOSITION_UNAVAILABLE');};
 assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2','OP')).status,'FAILED');
 assert.equal(x.dispatches(),0);
 assert.equal(x.reads(),0);
});

test('only the original controller proof can expose a pre-model failure as retryable',async t=>{
 const x=fixture(t);
 x.intent();
 x.result('FAILED','NATIVE_PRICE_ROUTE_MISMATCH');
 let dispositionReads=0;
 x.native.customProbeFailureDisposition=probeId=>{
  dispositionReads++;
  assert.equal(probeId,'custom_probe_OFFLINE');
  return true;
 };
 const view=await x.engine.customRoleProbeStatus(x.selection,'planner2','OP');
 assert.equal(view.status,'FAILED_NO_EFFECT');
 assert.equal(view.evidenceId,null);
 assert.equal(view.model,null);
 assert.equal(view.executionGranted,false);
 assert.equal(view.fourRoleLive,'NOT_RUN');
 assert.equal(dispositionReads,1);
 assert.equal(x.dispatches(),0);
 assert.equal(x.reads(),0);
});

test('a proven upstream gateway rejection is safe to retry without claiming model work',async t=>{
 const x=fixture(t);
 x.intent();
 x.result('FAILED','RUNNER_RPC_ERROR');
 x.native.customProbeFailureDisposition=()=>true;
 const view=await x.engine.customRoleProbeStatus(x.selection,'planner2','OP');
 assert.equal(view.status,'FAILED_NO_EFFECT');
 assert.equal(view.executionGranted,false);
 assert.equal(view.fourRoleLive,'NOT_RUN');
 assert.equal(x.dispatches(),0);
 assert.equal(x.reads(),0);
});

test('an unproven runner RPC failure remains closed',async t=>{
 const x=fixture(t);
 x.intent();
 x.result('FAILED','RUNNER_RPC_ERROR');
 x.native.customProbeFailureDisposition=()=>false;
 assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2','OP')).status,'FAILED');
 x.native.customProbeFailureDisposition=()=>{throw Error('OFFLINE_DISPOSITION_UNAVAILABLE');};
 assert.equal((await x.engine.customRoleProbeStatus(x.selection,'planner2','OP')).status,'FAILED');
 assert.equal(x.dispatches(),0);
 assert.equal(x.reads(),0);
});
