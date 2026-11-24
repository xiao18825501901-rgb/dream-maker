// OFFLINE original Engine/Store. Selected accounts/models are unverified reference strings.
import test from 'node:test';import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';import {resolve} from 'node:path';
import {Store} from '../../dist/server/store.js';import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {hash,canonical} from '../../dist/server/security.js';import * as flows from '../../dist/server/flow-configuration.js';
import {CustomFlowPreparations} from '../../dist/server/custom-flow-preparation.js';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {DatabaseSync} from 'node:sqlite';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {harness,ready} from '../helpers.mjs';
const actor='local-session:'+'a'.repeat(64);
function config(){const role=(id,write=false)=>({id,provider:'github',authentication:'oauth',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT',runtime:'copilot-sdk',model:{kind:'model',id:'OFFLINE_MODEL'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});return{mode:'custom',laya:false,accounts:[{provider:'github',authentication:'oauth',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'}],roles:{planner2:role('planner2'),executors:[role('worker-one',true),role('worker-two',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:['private']},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};}
async function setup(t){const h=harness(t),{p,s}=await ready(h),profiles=new FlowProfiles(h.store),version=profiles.confirm(p.id,{configuration:config(),expectedRevision:0,confirmed:true},actor,'OFFLINE_PROFILE');return{...h,p,s,profiles,version};}

test('the original Engine freezes the approved plan and every Custom choice without granting execution',async t=>{
 const h=await setup(t),value=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash);
 assert.equal(value.scope,'CONFIGURATION_PREPARATION_ONLY');assert.equal(value.executionGranted,false);assert.equal(value.flowConfig.schema,'dream-maker.flow-config.v2');assert.equal(value.flowConfig.mode,'custom');assert.equal(value.flowConfig.profile.contentHash,h.version.contentHash);assert.equal(value.flowConfig.plan.versionId,h.s.id);assert.equal(value.flowConfig.plan.contentHash,h.store.planVersion(h.s.id).contentHash);
 assert.deepEqual(value.flowConfig.roles,h.version.configuration.roles);assert.deepEqual(value.flowConfig.accounts,h.version.configuration.accounts);assert.deepEqual(value.flowConfig.privacy,h.version.configuration.privacy);assert.deepEqual(value.flowConfig.budget,h.version.configuration.budget);assert.equal(value.flowConfig.laya.enabled,false);assert.equal(value.flowConfig.qualification,'NOT_VERIFIED');assert.equal(value.flowConfigHash,hash(value.flowConfig));
 assert.equal(h.store.runs(h.p.id).length,0);assert.equal(h.engine.activeJobCount,0);assert.equal(h.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);assert.equal(h.store.approved(h.p.id,h.s.hash,'BUILD'),false);assert.equal(existsSync(resolve(h.dir,'workspaces',value.flowConfig.runId)),false);
});
test('preparation replay is durable and caller mutations cannot change the original snapshot',async t=>{
 const h=await setup(t),first=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),original=structuredClone(first);first.flowConfig.roles.executors[0].model.id='caller-mutated';
 assert.deepEqual(h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),original);assert.equal(h.store.records(h.p.id,'CustomFlowPrepared').length,1);
 const reopened=new Store(h.store.path);try{const stored=reopened.records(h.p.id,'CustomFlowPrepared')[0].data;assert.deepEqual(stored,original);}finally{reopened.close();}
});
test('a new profile keeps the old preparation while refusing stale profile input',async t=>{
 const h=await setup(t),one=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),next=config();next.roles.executors[0].model.id='OFFLINE_NEXT_MODEL';
 const version=h.profiles.confirm(h.p.id,{configuration:next,expectedRevision:1,confirmed:true},actor,'OFFLINE_NEXT_PROFILE');
 assert.throws(()=>h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),{code:'FLOW_PROFILE_STALE'});const two=h.engine.prepareCustomFlow(h.p.id,h.s.hash,version.contentHash);assert.notEqual(one.contentHash,two.contentHash);assert.notEqual(one.flowConfig.runId,two.flowConfig.runId);assert.deepEqual(h.store.records(h.p.id,'CustomFlowPrepared')[0].data,one);
});
test('P1 changes do not refreeze engineering; engineering changes produce a separate preparation',async t=>{
 const h=await setup(t),one=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash);h.config.planner1.model='OFFLINE_OTHER_P1';assert.deepEqual(h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),one);
 h.config.limits.maxCalls+=1;const two=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash);assert.notEqual(one.flowConfig.configurationFingerprint,two.flowConfig.configurationFingerprint);assert.equal(h.store.records(h.p.id,'CustomFlowPrepared').length,2);
});
test('a changed or unapproved plan cannot reuse a preparation or create a build approval',async t=>{
 const h=await setup(t);assert.throws(()=>h.engine.prepareCustomFlow(h.p.id,'f'.repeat(64),h.version.contentHash),{code:'SPEC_APPROVAL_STALE'});
 h.store.db.prepare('DELETE FROM approvals WHERE project_id=? AND kind=?').run(h.p.id,'SPEC');assert.throws(()=>h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),{code:'SPEC_APPROVAL_STALE'});assert.equal(h.store.records(h.p.id,'CustomFlowPrepared').length,0);assert.equal(h.store.approved(h.p.id,h.s.hash,'BUILD'),false);
});
test('Custom v2 is understood by the original run binding while unqualified Custom cannot launch as Classic',async t=>{
 const h=await setup(t),p=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),snapshot=p.flowConfig;
 const run={id:snapshot.runId,projectId:h.p.id,flowName:'custom',planVersionId:h.s.id,planVersionHash:snapshot.plan.contentHash,specId:h.s.id,specHash:h.s.hash,flowConfig:snapshot,flowConfigHash:p.flowConfigHash,configFingerprint:snapshot.configurationFingerprint};
 assert.doesNotThrow(()=>flows.assertFlowSnapshot(run));assert.throws(()=>h.engine.assertBinding(run),{code:'CUSTOM_MAGPIE_SECURITY_REQUIRED'});
 const forged=structuredClone(run);forged.flowConfig.laya.enabled=true;forged.flowConfigHash=hash(forged.flowConfig);assert.throws(()=>flows.assertFlowSnapshot(forged),{code:'FLOW_CONFIG_INTEGRITY_FAILED'});
 assert.throws(()=>h.engine.create(h.p.id,h.s.hash,true,false,'custom'),{code:'CUSTOM_MAGPIE_SECURITY_REQUIRED'});assert.equal(h.store.runs(h.p.id).length,0);
});
test('tampering a prepared record is detected instead of silently issuing a replacement',async t=>{
 const h=await setup(t),first=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),row=h.store.records(h.p.id,'CustomFlowPrepared')[0],changed=structuredClone(first);changed.flowConfig.roles.reviewer.permissions.push('source_write');
 h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(changed),row.id);assert.throws(()=>h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),{code:'FLOW_PREPARATION_INTEGRITY_FAILED'});assert.equal(h.store.records(h.p.id,'CustomFlowPrepared').length,1);
});

test('JSON strings cannot impersonate the frozen Laya-off or DM-only gateway objects',async t=>{
 const h=await setup(t),preparation=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash);
 for(const field of ['laya','magpie']){const forged=structuredClone(preparation.flowConfig);forged[field]=canonical(forged[field]);assert.throws(()=>flows.assertCustomSnapshot(forged),{code:'FLOW_CONFIG_INTEGRITY_FAILED'});}
});
test('two original Store connections reuse the same prepared identity without a second record',async t=>{
 const h=await setup(t),first=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),second=new Store(h.store.path);
 try{const service=new CustomFlowPreparations(second,()=>h.config);assert.deepEqual(service.prepare(h.p.id,h.s.hash,h.version.contentHash),first);assert.equal(second.records(h.p.id,'CustomFlowPrepared').length,1);}finally{second.close();}
});
test('a terminal run retires its used preparation and the next build gets a new run identity',async t=>{
 const h=await setup(t),first=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash);
 h.store.insertRun({id:first.flowConfig.runId,projectId:h.p.id,mode:'live',version:1,specId:h.s.id,specHash:h.s.hash,planVersionId:h.s.id,planVersionHash:first.flowConfig.plan.contentHash,rolePolicy:'CUSTOM_FROZEN_V1',flowName:'custom',flowConfig:first.flowConfig,flowConfigHash:first.flowConfigHash,configFingerprint:first.flowConfig.configurationFingerprint,state:'CANCELLED',phase:'PLANNING',repairCount:0,maxRepairs:0,calls:0,maxCalls:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),workspace:resolve(h.dir,'workspaces',first.flowConfig.runId),treeHash:null,tasks:[],findings:[],plan:null,verification:null,review:null,artifacts:[],reason:'USER_CANCELLED',failedFingerprints:[],attempt:1,demoFault:false,maxSeconds:1,usage:[],sessions:{}});
 const second=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash);
 assert.notEqual(second.flowConfig.runId,first.flowConfig.runId);
 assert.equal(second.identityHash,first.identityHash);
 assert.notEqual(second.contentHash,first.contentHash);
 assert.deepEqual(h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),second);
 const prepared=h.store.records(h.p.id,'CustomFlowPrepared').map(row=>row.data);
 assert.equal(prepared.length,2);
 assert.deepEqual(prepared[0],first);
 assert.deepEqual(prepared[1],second);
});
test('a caller bound to the retired preparation can still read that exact historical operation',async t=>{
 const h=await setup(t),first=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),ref={identityHash:first.identityHash,contentHash:first.contentHash};
 h.store.insertRun({id:first.flowConfig.runId,projectId:h.p.id,mode:'live',version:1,specId:h.s.id,specHash:h.s.hash,planVersionId:h.s.id,planVersionHash:first.flowConfig.plan.contentHash,rolePolicy:'CUSTOM_FROZEN_V1',flowName:'custom',flowConfig:first.flowConfig,flowConfigHash:first.flowConfigHash,configFingerprint:first.flowConfig.configurationFingerprint,state:'CANCELLED',phase:'PLANNING',repairCount:0,maxRepairs:0,calls:0,maxCalls:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),workspace:resolve(h.dir,'workspaces',first.flowConfig.runId),treeHash:null,tasks:[],findings:[],plan:null,verification:null,review:null,artifacts:[],reason:'USER_CANCELLED',failedFingerprints:[],attempt:1,demoFault:false,maxSeconds:1,usage:[],sessions:{}});
 assert.deepEqual(h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash,ref),first);
 assert.equal(h.store.records(h.p.id,'CustomFlowPrepared').length,1);
});
test('original SQLite reads Custom v2 and protects it while Engine refuses unqualified imported execution',async t=>{
 const h=await setup(t),prepared=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash);fixedControllerCapacity(h.engine);const classic=h.engine.create(h.p.id,h.s.hash,true);await h.engine.settled(classic.id);
 const saved=structuredClone(h.store.run(classic.id));Object.assign(saved,{id:prepared.flowConfig.runId,version:1,flowName:'custom',flowConfig:prepared.flowConfig,flowConfigHash:prepared.flowConfigHash,configFingerprint:prepared.flowConfig.configurationFingerprint,workspace:resolve(h.dir,'workspaces',prepared.flowConfig.runId)});h.store.insertRun(saved);assert.deepEqual(h.store.run(saved.id).flowConfig,prepared.flowConfig);
 const changed=structuredClone(saved);changed.flowConfig.roles.executors[0].model.id='FORGED_MODEL';changed.flowConfigHash=hash(changed.flowConfig);assert.throws(()=>h.store.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(changed),saved.id),/IMMUTABLE_FLOW_CONFIG/);assert.throws(()=>h.engine.accept(saved.id),{code:'CUSTOM_MAGPIE_SECURITY_REQUIRED'});assert.equal(existsSync(saved.workspace),false);
});

test('the original consistent backup and restore rehearsal preserve prepared configuration without starting a Flow',async t=>{
 const h=await setup(t),first=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),maintenance=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>false}),snapshot=maintenance.create('OFFLINE_CUSTOM_PREPARATION_BACKUP');
 const db=new DatabaseSync(resolve(h.dir,'controller/state-backups',snapshot.id,'application.sqlite'),{readOnly:true});try{const row=db.prepare("SELECT data FROM records WHERE project_id=? AND kind='CustomFlowPrepared'").get(h.p.id);assert.deepEqual(JSON.parse(row.data),first);}finally{db.close();}
 const rehearsal=maintenance.rehearse(snapshot.id,'OFFLINE_CUSTOM_PREPARATION_REHEARSAL');assert.equal(rehearsal.engineStarted,false);assert.equal(rehearsal.application.engineeringProfiles,1);assert.equal(h.store.runs(h.p.id).length,0);assert.deepEqual(h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash),first);
});

test('an original preparation reference rejects engineering drift before adding another record',async t=>{
 const h=await setup(t),first=h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash);h.config.limits.maxCalls+=1;
 assert.throws(()=>h.engine.prepareCustomFlow(h.p.id,h.s.hash,h.version.contentHash,{identityHash:first.identityHash,contentHash:first.contentHash}),{code:'FLOW_PREPARATION_STALE'});assert.equal(h.store.records(h.p.id,'CustomFlowPrepared').length,1);
});
