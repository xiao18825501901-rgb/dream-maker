// Offline safety checks for the merge into the newer budget/R11/Local-Only core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProvider } from '../../dist/server/providers/model.js';
import { defaults } from '../../dist/server/config.js';
import { root } from '../helpers.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('merged SIWC failures never reserve API money, dispatch API transport or select another provider',async()=>{
 const config=structuredClone(defaults);config.planner1.authMode='siwc_plan';
 let transport=0,reservations=0;
 for(const code of ['subscription_sharing_usage_limit_exceeded','unsupported_country_region_territory','response_incomplete']){
  const provider=new ModelProvider(()=>config,root,async()=>{transport++;throw Error('FORBIDDEN_API');},()=>{reservations++;throw Error('FORBIDDEN_API_BUDGET');},{complete:async()=>{throw {code};}});
  await assert.rejects(provider.complete({task:'question'}),{code});
  assert.equal(provider.activeCalls,0);
 }
 assert.equal(transport,0);assert.equal(reservations,0);
});

test('merged UI retains R11 and the opaque preview; public helpers stay revoked',()=>{
 const views=readFileSync(resolve(root,'src/web/views.ts'),'utf8'),ui=readFileSync(resolve(root,'src/web/ui.ts'),'utf8');
 assert.match(views,/semantics-form/);assert.match(ui,/semanticPayload/);
 assert.match(views,/sandbox="allow-scripts"/);assert.doesNotMatch(views,/allow-same-origin|allow-forms/);
 assert.match(ui,/previewStorage\.bind/);assert.match(ui,/previewStorage\.prepare/);
 assert.match(readFileSync(resolve(root,'scripts/ui-upgrade/publish-ui.mjs'),'utf8'),/LOCAL_ONLY_PUBLIC_ACCESS_REVOKED/);
});
