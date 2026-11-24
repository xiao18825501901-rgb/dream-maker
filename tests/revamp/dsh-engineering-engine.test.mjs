// Explicit OFFLINE native-factory boundary. No model/OAuth/native qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {harness} from '../helpers.mjs';
import {Engine} from '../../dist/server/engine.js';
import {dshEngineeringContractHash} from '../../dist/server/flow/dsh-engineering.js';
import {hash} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
function setup(t,patch={}){const h=harness(t);let calls=0;const native={assertReady(){throw Error('NO_PROJECT_BUILD_ALLOWED');},executor(){throw Error('NO_PROJECT_EXECUTOR_ALLOWED');},verify(){throw Error('NO_PROJECT_VERIFIER_ALLOWED');},async close(){},
 dshEngineeringPreparation:()=>({contractHash:dshEngineeringContractHash,configurationHash:hash(h.config.dsh)}),
 async executeDshEngineering(input){calls++;writeFileSync(join(input.workspace,'main.mjs'),'// OFFLINE_FACTORY_OUTPUT\n');writeFileSync(join(input.workspace,'README.md'),'OFFLINE_ONLY');return{sourceHash:treeHash(input.workspace),output:{text:'OFFLINE',sessionId:'OFFLINE',usage:{source:'OFFLINE_TEST'}},ledgerRequestIds:[],requests:[]};},
 async verifyDshEngineering(input){return{sourceHash:treeHash(input.workspace),ok:true,cases:[{id:'OFFLINE_FACTORY_ONLY',ok:true}]};},...patch};
 const engine=new Engine(h.store,h.laya,()=>h.config,h.dir,h.dir,0,native);engine.dispatch.binding.measure=()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:8192,sampledAt:new Date().toISOString()});t.after(()=>engine.close());return{h,engine,calls:()=>calls};}
test('engineering requires explicit confirmation, no existing user plan, and uses the original dispatch without project approvals',async t=>{
 const {h,engine,calls}=setup(t);await assert.rejects(engine.runDshEngineeringAcceptance('offline_operation',false),{code:'ENGINEERING_ACCEPTANCE_CONFIRMATION_REQUIRED'});
 assert.equal(calls(),0);const result=await engine.runDshEngineeringAcceptance('offline_operation',true);
 assert.equal(result.purpose,'DSH_EXECUTOR_COMPONENT_ONLY');assert.equal(result.fourRoleLive,'NOT_RUN');assert.equal(result.reviewer,'BLOCKED');assert.equal(calls(),1);
 for(const table of ['projects','runs','approvals','specs','workspace_leases'])assert.equal(h.store.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
 const grants=h.store.db.prepare("SELECT data,project_id,run_id FROM records WHERE kind='DispatchGranted'").all();assert.equal(grants.length,2);assert.ok(grants.every(g=>g.project_id===null&&g.run_id===null&&JSON.parse(g.data).acceptanceId===result.acceptanceId));
 const replay=await engine.runDshEngineeringAcceptance('offline_operation',true);assert.equal(replay.acceptanceId,result.acceptanceId);assert.equal(calls(),1);
 writeFileSync(join(result.workspace,'README.md'),'outside');await assert.rejects(engine.runDshEngineeringAcceptance('offline_operation',true),{code:'ENGINEERING_ACCEPTANCE_RESULT_CHANGED'});assert.equal(calls(),1);
});
test('an old interrupted acceptance is never automatically rerun after Engine reconstruction',async t=>{
 const f=setup(t);f.h.store.record('EngineeringAcceptanceIntent',null,null,{acceptanceId:'dsh_acceptance_old',operationHash:hash('offline_interrupted'),contractHash:dshEngineeringContractHash,configurationHash:hash(f.h.config.dsh),workspace:join(f.h.dir,'unused')});
 await assert.rejects(f.engine.runDshEngineeringAcceptance('offline_interrupted',true),{code:'ENGINEERING_ACCEPTANCE_RECOVERY_REQUIRED'});assert.equal(f.calls(),0);
});
test('failed or cancelled independent execution does not retry, call Codex or award a verified result',async t=>{
 const f=setup(t,{async executeDshEngineering(){throw Object.assign(Error('OFFLINE_FAILURE'),{code:'DSH_HOST_TIMEOUT'});}});
 await assert.rejects(f.engine.runDshEngineeringAcceptance('offline_failure',true),{code:'DSH_HOST_TIMEOUT'});
 await assert.rejects(f.engine.runDshEngineeringAcceptance('offline_failure',true),{code:'ENGINEERING_ACCEPTANCE_RECOVERY_REQUIRED'});
 const result=JSON.parse(f.h.store.db.prepare("SELECT data FROM records WHERE kind='EngineeringAcceptanceResult'").get().data);assert.equal(result.status,'FAILED');
 assert.equal(f.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeProbeReceipt'").get().n,0);
});
