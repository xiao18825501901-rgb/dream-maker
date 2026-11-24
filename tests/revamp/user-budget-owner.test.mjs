// Actual owner/SQLite gates in an isolated root. No native audit proof, credentials, model or runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {harness} from '../helpers.mjs';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {UserPlans} from '../../dist/server/user-plans.js';
import {hash} from '../../dist/server/security.js';
import {fixtureProjectPlan} from '../fixtures/full-project-plan.mjs';
function setup(t){
 let owner;t.after(async()=>{await owner?.close();}); // Close the ledger before harness removes its Windows directory.
 const h=harness(t),authority={scopeId:'OWNER_BUDGET_OFFLINE_NOT_LIVE',authorizationHash:'TEST_ONLY_NO_NATIVE_PROOF',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2},dir=resolve(h.dir,'config');mkdirSync(dir);
 const path=resolve(dir,'authority.json'),bytes=JSON.stringify(authority);writeFileSync(path,bytes);
 writeFileSync(resolve(dir,'native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:h.dir,authority:{path,sha256:hash(bytes)},maxRequests:10,maxOutputTokens:128}));
 owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,product:'dreamflow'});
 return {h,owner,plans:new UserPlans(h.store)};
}
test('new Live build refuses missing user spending setup before checking or launching native tools',t=>{
 const {h,owner,plans}=setup(t),p=plans.create({schema:'dream-maker.user-plan.v1',name:'保留费用要求',mode:'live',plan:fixtureProjectPlan([{id:'R1',text:'保存本机数据',origin:'USER',sources:['USER_DOCUMENT']}])},'OFFLINE_DOCUMENT'),s=h.store.spec(p.specId);
 assert.throws(()=>owner.assertReady('build',{projectId:p.id,specHash:s.hash}),{code:'USER_BUDGET_SETUP_REQUIRED'});
 // Simulated mutable-record drift cannot remove the immutable source's requirement.
 const edited=h.store.project(p.id);delete edited.userSpendingRequired;h.store.saveProject(edited);
 assert.throws(()=>owner.assertReady('build',{projectId:p.id,specHash:s.hash}),{code:'USER_BUDGET_SETUP_REQUIRED'});
 owner.configureUserBudget({CNY:0,USD:0},0,'local-session:'+'a'.repeat(64),'OFFLINE_OWNER_LIMIT');
 assert.throws(()=>owner.assertReady('build',{projectId:p.id,specHash:s.hash}),{code:'NATIVE_INTEGRATION_BLOCKED'},'setting a cap grants no native permission or build approval');
 assert.equal(owner.budgetStatus().requests,0);assert.equal(h.store.runs(p.id).length,0);
});
test('historical plans without a user cap requirement are preserved rather than rewritten as new user scopes',t=>{
 const {h,owner,plans}=setup(t),p=plans.create({schema:'dream-maker.user-plan.v1',name:'历史演示范围',mode:'demo',plan:fixtureProjectPlan([{id:'R1',text:'保留旧资料',origin:'USER',sources:['USER_DOCUMENT']}])},'OFFLINE_DOCUMENT'),s=h.store.spec(p.specId);
 assert.equal(p.userSpendingRequired,undefined);assert.equal(h.store.planVersion(s.id).source.userSpendingRequired,undefined);
 assert.throws(()=>owner.assertReady('build',{projectId:p.id,specHash:s.hash}),{code:'NATIVE_INTEGRATION_BLOCKED'});assert.equal(owner.budgetStatus().userBudget.configured,false);
});
