import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../dist/server/store.js';
import { defaults } from '../dist/server/config.js';
import { LayaBridge } from '../dist/server/laya.js';
import { ModelProvider } from '../dist/server/providers/model.js';
import { Interviews } from '../dist/server/interview.js';
import { Engine } from '../dist/server/engine.js';
import { fixtureProjectPlan } from './fixtures/full-project-plan.mjs';
import { offlineKimi } from './fixtures/offline-kimi.mjs';
export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, timeout = 10000) { const start = Date.now(); while (Date.now() - start < timeout) {
    const v = await fn();
    if (v)
        return v;
    await sleep(20);
} throw new Error('Condition timed out'); }
/**
 * Historical Kimi binding. Tests must opt in explicitly; old API defaults stay
 * retired. This helper only shapes local
 * configuration — it never contains or reads a credential.
 */
export function bindKimi(config) {
    config.planner1.provider = 'kimi';
    config.planner1.accountRef = 'offline-test-account';
    config.planner1.model = 'kimi-code';
    config.planner1.policyHash = 'offline-test-policy';
    config.planner1.protocolHash = 'offline-test-protocol';
    config.planner1.bindingVersion = 1;
    return config;
}
/** Explicit v2 API boundary for offline model-contract tests, never a live account. */
export function bindOfflineApi(config) {
    Object.assign(config.planner1,{provider:'openai',bindingVersion:2,authMode:'api_key',model:'OFFLINE_TEST_MODEL',protocol:'openai-responses',baseUrl:'https://api.openai.com/v1'});
    return config;
}
export function harness(t, delay = 0) { const parent=resolve(root,'.runtime/test-temp'); mkdirSync(parent,{recursive:true}); const dir = mkdtempSync(resolve(parent, 'dream-maker-test-')), config = structuredClone(defaults), store = new Store(resolve(dir, 'state.sqlite')); const laya = new LayaBridge(() => config), model = new ModelProvider(() => config, root), interviews = new Interviews(store, model, laya, () => config), engine = new Engine(store, laya, () => config, root, dir, delay); t.after(async () => { await interviews.close(); await engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }); return { dir, config, store, laya, model, interviews, engine }; }
export async function ready(h, mode = 'demo') {
 const p=h.interviews.create('学习任务板','创建一个可以记录学习任务的本地工具。',mode);
 if(mode==='live'){
  // Seed the full plan through the selected provider boundary, with explicit offline
  // output/receipts. No test fixture is installed in the product or formal database.
  const config=structuredClone(h.config),model={complete:async payload=>({data:fixtureProjectPlan(payload.requiredUserRequirements),usage:{role:'planner1',costUsd:null,source:'OFFLINE_TEST'}})};
  if(config.planner1.provider==='kimi')config.kimi.enabled=true;
  const planner=new Interviews(h.store,model,h.laya,()=>config,config.planner1.provider==='kimi'?offlineKimi(h.dir,model.complete):undefined);
  try{await planner.finish(p.id);}finally{await planner.close();}
 }else await h.interviews.finish(p.id,'',false);
 const pp=h.store.project(p.id),s=h.store.spec(pp.specId);h.interviews.approve(p.id,s.hash);return{p:h.store.project(p.id),s};
}
