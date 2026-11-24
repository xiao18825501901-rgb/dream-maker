// Original Store persistence and negative boundaries only; no accounts, gateway or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../dist/server/store.js';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {harness,ready} from '../helpers.mjs';
const actor='local-session:'+'a'.repeat(64);
export function configuration(){
 const role=(id,write=false)=>({id,provider:'github',authentication:'oauth',authRef:'dm-account-auth',accountRef:'dm-account',runtime:'copilot-sdk',model:{kind:'model',id:'selected-not-verified'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 return {mode:'custom',laya:false,accounts:[{provider:'github',authentication:'oauth',authRef:'dm-account-auth',accountRef:'dm-account'}],roles:{planner2:role('planner2'),executors:[role('executor-1',true),role('executor-2',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
}

test('custom configuration is confirmed separately from plan/build and survives restart without service qualification',async t=>{
 const h=harness(t),{p}=await ready(h),profiles=new FlowProfiles(h.store),input=configuration(),before=h.store.records(p.id,'UsageLedger').length;
 const first=profiles.confirm(p.id,{configuration:input,expectedRevision:0,confirmed:true},actor,'operation-1');
 assert.equal(first.revision,1);assert.equal(first.executionGranted,false);assert.equal(first.serviceIdentity,'NOT_VERIFIED');assert.equal(first.configuration.roles.executors.length,2);
 input.roles.executors[0].model.id='caller-mutated';assert.equal(profiles.current(p.id).configuration.roles.executors[0].model.id,'selected-not-verified');
 assert.deepEqual(profiles.confirm(p.id,{configuration:configuration(),expectedRevision:0,confirmed:true},actor,'operation-1'),first);
 assert.equal(h.store.runs(p.id).length,0);assert.equal(h.store.approved(p.id,h.store.planHead(p.id).specHash,'BUILD'),false);assert.equal(h.store.records(p.id,'UsageLedger').length,before);
 const reopened=new Store(h.store.path);try{assert.deepEqual(new FlowProfiles(reopened).current(p.id),first);}finally{reopened.close();}
});

test('Custom input rejects credentials, write-capable supervisors, ambiguous groups, privacy and budget expansion',async t=>{
 const h=harness(t),{p}=await ready(h),profiles=new FlowProfiles(h.store);
 const bad=[
  c=>{c.verified=true;},c=>{c.roles.reviewer.permissions.push('source_write');},
  c=>{c.roles.planner2.apiKey='SYNTHETIC_NOT_A_SECRET';},c=>{c.roles.executors[1].id='executor-1';},
  c=>{c.roles.planner2.runtime='C:/user/runner.exe';},c=>{c.roles.planner2.model={kind:'group',id:'missing'};},
  c=>{c.budget.maxMicros=-1;},c=>{c.roles.planner2.budget.maxMicros=3000000;},
  c=>{c.privacy.deniedProviders=['github'];},c=>{c.laya=true;},
  c=>{c.roles.planner2.transport='native';},c=>{c.roles.planner2.authentication='cookie';}
 ];
 for(let i=0;i<bad.length;i++){const input=configuration();bad[i](input);assert.throws(()=>profiles.confirm(p.id,{configuration:input,expectedRevision:0,confirmed:true},actor,'bad-'+i));}
 assert.equal(profiles.current(p.id),null);assert.equal(h.store.db.prepare('SELECT count(*) n FROM engineering_profiles').get().n,0);
});

test('new revisions use original Store CAS and immutable history; replay cannot overwrite a later revision',async t=>{
 const h=harness(t),{p}=await ready(h),profiles=new FlowProfiles(h.store),input=configuration();
 const first=profiles.confirm(p.id,{configuration:input,expectedRevision:0,confirmed:true},actor,'first');
 input.roles.executors[0].model.id='next-model';
 assert.throws(()=>profiles.confirm(p.id,{configuration:input,expectedRevision:0,confirmed:true},actor,'stale'),{code:'FLOW_PROFILE_REVISION_CONFLICT'});
 const second=profiles.confirm(p.id,{configuration:input,expectedRevision:1,confirmed:true},actor,'second');assert.equal(second.parentHash,first.contentHash);
 assert.equal(profiles.confirm(p.id,{configuration:configuration(),expectedRevision:0,confirmed:true},actor,'first').revision,1);assert.equal(profiles.current(p.id).revision,2);
 assert.throws(()=>h.store.db.prepare('UPDATE engineering_profiles SET data=?').run('{}'));
 assert.throws(()=>h.store.db.exec('DELETE FROM engineering_profiles'));
 assert.throws(()=>h.store.db.exec('INSERT OR REPLACE INTO engineering_profiles SELECT * FROM engineering_profiles WHERE revision=1'));
 assert.throws(()=>profiles.confirm(p.id,{configuration:input,expectedRevision:2,confirmed:false},actor,'unconfirmed'),{code:'FLOW_PROFILE_CONFIRMATION_REQUIRED'});
});

test('route-group members stay inside explicit auth/account/capability scope and do not assert account readiness',async t=>{
 const h=harness(t),{p}=await ready(h),profiles=new FlowProfiles(h.store),input=configuration();
 input.groups=[{id:'approved-models',strategy:'failure_only',members:[{id:'member-1',provider:'github',model:'selected-model',authRef:'dm-account-auth',accountRef:'dm-account',permissions:['source_read']}]}];
 input.roles.planner2.model={kind:'group',id:'approved-models'};input.roles.planner2.selectedMemberId='member-1';
 const invalid=structuredClone(input);invalid.groups[0].members[0].accountRef='other-account';assert.throws(()=>profiles.confirm(p.id,{configuration:invalid,expectedRevision:0,confirmed:true},actor,'wrong-account'),{code:'FLOW_PROFILE_GROUP_SCOPE_INVALID'});
 const saved=profiles.confirm(p.id,{configuration:input,expectedRevision:0,confirmed:true},actor,'group');assert.equal(saved.configuration.groups.length,1);assert.equal(saved.serviceIdentity,'NOT_VERIFIED');
});

test('an initial route-group member is persisted explicitly and checked against its frozen group',async t=>{
 const h=harness(t),{p}=await ready(h),profiles=new FlowProfiles(h.store),input=configuration();
 input.groups=[{id:'approved-models',strategy:'failure_only',members:[
  {id:'member-1',provider:'github',model:'selected-model',authRef:'dm-account-auth',accountRef:'dm-account',permissions:['source_read']},
  {id:'member-2',provider:'github',model:'alternate-model',authRef:'dm-account-auth',accountRef:'dm-account',permissions:['source_read']}
 ]}];
 input.roles.planner2.model={kind:'group',id:'approved-models'};
 input.roles.planner2.selectedMemberId='member-2';
 const saved=profiles.confirm(p.id,{configuration:input,expectedRevision:0,confirmed:true},actor,'selected-group-member');
 assert.equal(saved.configuration.roles.planner2.selectedMemberId,'member-2');
 const reopened=new Store(h.store.path);try{assert.equal(new FlowProfiles(reopened).current(p.id).configuration.roles.planner2.selectedMemberId,'member-2');}finally{reopened.close();}
 const invalid=structuredClone(input);invalid.roles.planner2.selectedMemberId='member-missing';
 assert.throws(()=>profiles.confirm(p.id,{configuration:invalid,expectedRevision:1,confirmed:true},actor,'missing-group-member'),{code:'FLOW_PROFILE_GROUP_SCOPE_INVALID'});
 const omitted=structuredClone(input);delete omitted.roles.planner2.selectedMemberId;
 assert.throws(()=>profiles.confirm(p.id,{configuration:omitted,expectedRevision:1,confirmed:true},actor,'omitted-group-member'),{code:'FLOW_PROFILE_GROUP_SCOPE_INVALID'});
});

test('a group can select a different provider/account only when explicitly included in the confirmed scope',async t=>{
 const h=harness(t),{p}=await ready(h),profiles=new FlowProfiles(h.store),input=configuration();
 input.accounts.push({provider:'deepseek',authentication:'api_key',authRef:'another-auth',accountRef:'another-account'});
 input.roles.planner2.model={kind:'group',id:'multi-provider'};input.roles.planner2.selectedMemberId='alternate';
 input.groups=[{id:'multi-provider',strategy:'failure_only',members:[{id:'alternate',provider:'deepseek',model:'deepseek-flash',authRef:'another-auth',accountRef:'another-account',permissions:['source_read']}]}];
 const saved=profiles.confirm(p.id,{configuration:input,expectedRevision:0,confirmed:true},actor,'multi-provider');assert.equal(saved.configuration.groups[0].members[0].provider,'deepseek');assert.equal(saved.serviceIdentity,'NOT_VERIFIED');
});

test('two Store connections reject stale configuration and preserve it in a real backup/rehearsal',async t=>{
 const h=harness(t),{p}=await ready(h),one=new FlowProfiles(h.store),otherStore=new Store(h.store.path);
 try{
  const two=new FlowProfiles(otherStore),saved=one.confirm(p.id,{configuration:configuration(),expectedRevision:0,confirmed:true},actor,'one');
  assert.throws(()=>two.confirm(p.id,{configuration:configuration(),expectedRevision:0,confirmed:true},actor,'two'),{code:'FLOW_PROFILE_REVISION_CONFLICT'});
  const maintenance=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>false}),snapshot=maintenance.create('custom-profile-backup');assert.equal(snapshot.application.engineeringProfiles,1);
  const db=new DatabaseSync(join(h.dir,'controller/state-backups',snapshot.id,'application.sqlite'),{readOnly:true});
  try{assert.equal(JSON.parse(db.prepare('SELECT data FROM engineering_profiles').get().data).contentHash,saved.contentHash);}finally{db.close();}
  const rehearsal=maintenance.rehearse(snapshot.id,'custom-profile-rehearsal');assert.equal(rehearsal.application.engineeringProfiles,1);assert.equal(rehearsal.engineStarted,false);assert.deepEqual(one.current(p.id),saved);
 }finally{otherStore.close();}
});

test('a still-open Flow prevents configuration changes without cancelling, dispatching or replacing it',async t=>{
 const h=harness(t),{p,s}=await ready(h);fixedControllerCapacity(h.engine);
 const run=h.engine.create(p.id,s.hash,true),profiles=new FlowProfiles(h.store);
 assert.throws(()=>profiles.confirm(p.id,{configuration:configuration(),expectedRevision:0,confirmed:true},actor,'active'),{code:'FLOW_TERMINATION_REQUIRED'});
 assert.equal(profiles.current(p.id),null);assert.equal(h.store.owns(p.id,run.id),true);
 await h.engine.cancel(run.id);await h.engine.settled(run.id);
});
