// Browser configuration logic + original server input contract, no actual provider/runtime calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWizard,addWizardItem,removeWizardItem,wizardConfiguration,applyWizardFields,serializeWizard,restoreWizard,moneyMicros} from '../../dist/web/custom-flow-state.js';
import {customFlowProfile} from '../../dist/server/flow-profiles.js';
const data=o=>({get:name=>o[name]??null});
function ready(){const s=createWizard('p1',null);s.configuration.roles.planner2.model.id='p2-model';s.configuration.roles.reviewer.model.id='review-model';s.configuration.roles.executors[0].model.id='executor-model';return s;}

test('a new Custom wizard recommends a changeable Copilot OAuth pairing without a third mode or fabricated login/model',()=>{
 const s=createWizard('p1',null);assert.equal(s.configuration.mode,'custom');assert.equal(s.configuration.laya,false);assert.equal(s.configuration.accounts[0].provider,'github');assert.equal(s.configuration.accounts[0].authentication,'oauth');assert.equal(s.configuration.roles.planner2.runtime,'copilot-sdk');assert.equal(s.configuration.roles.planner2.model.id,'');assert.equal(s.baseRevision,0);
 assert.throws(()=>wizardConfiguration(s));assert.equal(s.money.project,'0');
});

test('completed user selections satisfy the original server contract and independent Executor edits survive serialization',()=>{
 const s=ready();addWizardItem(s,'executor');s.configuration.roles.executors[1].model.id='second-model';s.configuration.roles.executors[1].runtime='dsh';
 const config=wizardConfiguration(s);assert.deepEqual(customFlowProfile(config),config);assert.equal(config.roles.executors[0].runtime,'copilot-sdk');assert.equal(config.roles.executors[1].runtime,'dsh');
 const restored=restoreWizard(serializeWizard(s),'p1');assert.deepEqual(wizardConfiguration(restored),config);assert.equal(restoreWizard(serializeWizard(s),'other-project'),null);
});

test('decimal money is exact and cannot silently round, accept exponents or grow past the original bound',()=>{
 assert.equal(moneyMicros('0.000001'),1);assert.equal(moneyMicros('50'),50000000);assert.equal(moneyMicros('1.234567'),1234567);
 for(const value of ['-1','1e4','1.0000001','Infinity','1000000.000001','', '1,000'])assert.throws(()=>moneyMicros(value));
 const s=ready();s.money.project='10';s.money.roles.planner2='11';assert.throws(()=>wizardConfiguration(s));
});

test('removing a referenced account or route group refuses; unverified saved native/group selections are retained',()=>{
 const s=ready();assert.throws(()=>removeWizardItem(s,'account',0));addWizardItem(s,'group');s.configuration.groups[0].members[0].model='backup-model';s.configuration.roles.planner2.model={kind:'group',id:s.configuration.groups[0].id};
 s.configuration.roles.planner2.selectedMemberId=s.configuration.groups[0].members[0].id;
 assert.throws(()=>removeWizardItem(s,'group',0));const config=wizardConfiguration(s);const version={projectId:'p1',revision:2,contentHash:'a'.repeat(64),configuration:config};
 const restored=createWizard('p1',version);assert.deepEqual(wizardConfiguration(restored),config);
});

test('a role using a route group must name and retain its initial member instead of taking the first candidate',()=>{
 const s=ready();addWizardItem(s,'group');const g=s.configuration.groups[0];g.members[0].model='backup-one';addWizardItem(s,'member',0);g.members[1].model='backup-two';
 s.configuration.roles.planner2.model={kind:'group',id:g.id};s.step=1;assert.throws(()=>wizardConfiguration(s));
 const next=applyWizardFields(s,data({'role-kind-0':'group','role-group-0':g.id,'role-member-0':g.members[1].id}));
 assert.equal(next.configuration.roles.planner2.selectedMemberId,g.members[1].id);
 const config=wizardConfiguration(next);assert.equal(config.roles.planner2.selectedMemberId,g.members[1].id);
 assert.equal(restoreWizard(serializeWizard(next),'p1').configuration.roles.planner2.selectedMemberId,g.members[1].id);
 removeWizardItem(next,'member',0,1);assert.equal(next.configuration.roles.planner2.selectedMemberId,undefined);assert.throws(()=>wizardConfiguration(next));
});

test('changing an account source clears dependent model choices without altering the old saved config',()=>{
 const s=ready(),old=structuredClone(s.configuration);const next=applyWizardFields(s,data({'account-provider-0':'deepseek','account-auth-0':'api_key','account-label-0':'我自己的账户'}));
 assert.equal(next.configuration.roles.planner2.provider,'deepseek');assert.equal(next.configuration.roles.planner2.model.id,'');assert.deepEqual(s.configuration,old);
});

test('drafts reject secret-like input and bounded collections retain distinct executor identities',()=>{
 const s=ready();s.configuration.roles.planner2.model.id='sk-SYNTHETIC_SECRET_NOT_FOR_STORAGE';assert.throws(()=>serializeWizard(s));
 const clean=ready();for(let i=1;i<64;i++)addWizardItem(clean,'executor');assert.equal(new Set(clean.configuration.roles.executors.map(r=>r.id)).size,64);assert.throws(()=>addWizardItem(clean,'executor'));
});

test('editing budgets leaves a valid empty or write-only route-member permission set unchanged',()=>{
 for(const permissions of [[],['source_write']]){
  const s=ready();addWizardItem(s,'group');const g=s.configuration.groups[0];g.members[0].model='backup-model';g.members[0].permissions=permissions;s.configuration.roles.executors[0].model={kind:'group',id:g.id};s.configuration.roles.executors[0].selectedMemberId=g.members[0].id;s.step=2;
  assert.deepEqual(customFlowProfile(wizardConfiguration(s)),wizardConfiguration(s));
  const next=applyWizardFields(s,data({'member-write-0-0':permissions.includes('source_write')?'on':null}));assert.deepEqual(next.configuration.groups[0].members[0].permissions,permissions);
 }
});
