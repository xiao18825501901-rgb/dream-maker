// OFFLINE policy/authority tests. No product role or provider is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roleRunner } from '../../dist/server/engine.js';
import { rolePolicyBinding, executionIdentity } from '../../dist/server/role-policy.js';
import { defaults } from '../../dist/server/config.js';
import { harness, ready } from '../helpers.mjs';

function configured() {
 const c=structuredClone(defaults);
 c.independent={enabled:true,baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',keyEnv:'OFFLINE_KEY',maxOutputTokens:128,maxRequests:1};
 c.codex.model='codex-offline-target'; c.dsh.model='deepseek-flash'; return c;
}
test('new role policy selects Codex for both supervisory roles despite historical degraded settings',()=>{
 const config=configured(), before=JSON.stringify(config),executor={},codex={},independent={};
 const parts={executor:()=>executor,codex:()=>codex,independent};
 assert.equal(roleRunner('planner2',config,parts),codex);
 assert.equal(roleRunner('reviewer',config,parts),codex);
 assert.equal(roleRunner('executor',config,parts),executor);
 assert.equal(roleRunner('planner2',config,parts,'LEGACY_CONFIGURED_V1'),independent);
 assert.equal(JSON.stringify(config),before,'routing must not rewrite shared/local configuration');
 const binding=rolePolicyBinding(config);
 assert.equal(binding.planner2Mode,'chatgpt_subscription');
 assert.equal(binding.independence,'CROSS_VENDOR');
 assert.equal(binding.models.planner2,config.codex.model);
 assert.equal(binding.models.reviewer,config.codex.model);
 assert.equal(binding.rolePolicy,'CODEX_DSH_V1');
});
test('unknown role policy and missing actual identity are refused rather than inferred from configuration',()=>{
 const config=configured();
 assert.throws(()=>rolePolicyBinding(config,'BOGUS'),{code:'ROLE_POLICY_UNKNOWN'});
 const out={sessionId:'offline-session',text:'{}',model:config.codex.model,usage:{requestId:'offline-request'}};
 assert.throws(()=>executionIdentity('planner2',config,out),{code:'ROLE_EXECUTION_IDENTITY_UNVERIFIED'});
 const identity={runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:config.codex.model};
 assert.equal(executionIdentity('planner2',config,{...out,identity}).model,config.codex.model);
 assert.throws(()=>executionIdentity('reviewer',config,{...out,identity:{...identity,provider:'deepseek-official'}}),{code:'ROLE_EXECUTION_ROUTE_MISMATCH'});
 assert.throws(()=>executionIdentity('reviewer',config,{...out,model:'unapproved-alias',identity:{...identity,model:'unapproved-alias'}}),{code:'ROLE_EXECUTION_ROUTE_MISMATCH'});
});
test('new Flow persists its fixed role policy while old records remain readable unchanged',async t=>{
 const h=harness(t),{p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);
 await h.engine.settled(r.id);
 assert.equal(h.store.run(r.id).rolePolicy,'CODEX_DSH_V1');
 const old=h.store.run(r.id);delete old.rolePolicy;h.store.saveRun(old);
 assert.equal(h.store.run(r.id).rolePolicy,undefined);
 assert.equal(h.store.run(r.id).mode,'demo');
});
