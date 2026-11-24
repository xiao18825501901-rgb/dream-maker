// Actual cached YAML parser/source inputs, no SDK model or authorization claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {planNativeProfile,buildNativeProfile,assertNativeProfile} from '../adapters/dsh-native-profile.mjs';

test('Custom role profiles suppress the pinned SDK session-log request extension',()=>{
 for(const role of ['planner2','executor','reviewer']){
  const planned=planNativeProfile(base,sdk,yaml,{...options,role});
  assert.equal(planned.patch.find(row=>row.id==='session-log-deepseek').config?.enabled,false);
 }
 assert.equal(planNativeProfile(base,sdk,yaml,options).patch.find(row=>row.id==='session-log-deepseek').config,undefined,'legacy Classic profile is unchanged');
});
test('Custom supervisor roles are told to use their one terminal tool, never contradictory no-tool prose',()=>{
 const expected={planner2:'submit_engineering_plan',reviewer:'submit_review'};
 for(const [role,tool] of Object.entries(expected)){
  const persona=planNativeProfile(base,sdk,yaml,{...options,role}).patch
   .find(row=>row.id==='system-prompt').config.personaPrefix;
  assert.match(persona,new RegExp(tool));
  assert.doesNotMatch(persona,/No tools are authorized/i);
 }
 const executor=planNativeProfile(base,sdk,yaml,{...options,role:'executor'}).patch
  .find(row=>row.id==='system-prompt').config.personaPrefix;
 assert.match(executor,/approved desk tools/);
 assert.doesNotMatch(executor,/submit_engineering_plan|submit_review/);
});
import {hash} from '../dist/server/security.js';
import {harness} from './helpers.mjs';
const dsh='C:/Users/Hp/Documents/Archon_Astra_DSH_Source_Package/Archon_Astra_DSH_Source_Package/upstream/deepseek-harness';
const yaml=createRequire(dsh+'/packages/boot/app-boot/package.json')('js-yaml');
const base=readFileSync(dsh+'/packages/bundle/base/cordis.patch.yml','utf8'),sdk=readFileSync(dsh+'/packages/bundle/sdk-app/cordis.patch.yml','utf8');
const options={modelURL:'http://127.0.0.1:12345/v1',maxTokens:256,contextTokens:1048576,home:'C:/owned/runtime/home',pluginURL:'file:///C:/owned/adapters/dsh-tools-plugin.mjs'};
test('strict profile disables every unapproved row and pins only the configured model route',()=>{
 const p=planNativeProfile(base,sdk,yaml,options),rows=new Map(p.patch.filter(r=>r.id).map(r=>[r.id,r]));
 for(const name of ['tool-pwsh','tool-fs','tool-web','web','web-search-deepseek','session-telemetry-otel','otel','plugin-manager','hmr','credentials','llm-pi-ai','llm-deepseek-account','goal','llm-retry','tool-ralph','subagent','skill-filesystem'])assert.equal(rows.get(name).disabled,true,name);
 assert.equal(rows.get('tools').disabled,false);assert.equal(rows.get('tools').config.maxParallelSubCalls,1);
 assert.deepEqual(rows.get('llm-deepseek').config.retryPolicy,{mode:'normal',maxRetries:0});
 assert.equal(rows.get('llm-deepseek').config.baseURL,options.modelURL);
 assert.deepEqual(rows.get('llm-deepseek').config.models.map(m=>m.id),['deepseek-flash']);
 assert.equal(rows.get('llm-deepseek').config.streamIdleTimeoutMs,180000);
 assert.equal(rows.get('sdk-jsonrpc-server').config.maxTokensAsSuccess,false);
 assert.equal(p.patch.at(-1).insert[0].name,options.pluginURL);
 assert.ok(p.disabled.length>40);
});
test('reading bundle dynamic tags never evaluates their JavaScript',()=>{
 globalThis.__profileCanary=0;
 planNativeProfile(base+'\n- id: hmr\n  config: !!js "globalThis.__profileCanary = 1"\n',sdk,yaml,options);
 assert.equal(globalThis.__profileCanary,0);delete globalThis.__profileCanary;
});
test('unknown rows stay disabled; duplicate rows, changed retained identity and non-loopback model routes fail closed',()=>{
 const extra='\n- insert:\n    - id: unknown-network\n      name: malicious-new-plugin\n';
 assert.equal(planNativeProfile(base+extra,sdk,yaml,options).patch.find(r=>r.id==='unknown-network').disabled,true);
 assert.throws(()=>planNativeProfile(base+extra+extra,sdk,yaml,options),/PROFILE_DUPLICATE_ROW/);
 assert.throws(()=>planNativeProfile(base.replace("'@deepseek-ai/dsh-tools'","'unapproved-tools'"),sdk,yaml,options),/PROFILE_CORE_IDENTITY_CHANGED/);
 assert.throws(()=>planNativeProfile(base,sdk,yaml,{...options,modelURL:'https://api.deepseek.com/v1'}),/PROFILE_MODEL_ROUTE_DENIED/);
});

test('frozen profile uses unique owned homes, contains no bearer and rejects edited bytes',async t=>{
 const h=harness(t),require=createRequire(dsh+'/packages/boot/app-boot/package.json');
 const paths={basePatch:dsh+'/packages/bundle/base/cordis.patch.yml',sdkPatch:dsh+'/packages/bundle/sdk-app/cordis.patch.yml',yamlModule:require.resolve('js-yaml')};
 const binding={sdkCommit:'4878cdabd87d4041bdaff61d04c966883b9fd07a',...paths,dependencies:Object.values(paths).map(path=>({path,sha256:hash(readFileSync(path))}))};
 const previous=process.env.DM_MODEL_GATEWAY_TOKEN;process.env.DM_MODEL_GATEWAY_TOKEN='OFFLINE_PROFILE_BEARER';
 t.after(()=>{if(previous===undefined)delete process.env.DM_MODEL_GATEWAY_TOKEN;else process.env.DM_MODEL_GATEWAY_TOKEN=previous;});
 const actual={...options,pluginURL:new URL('../adapters/dsh-tools-plugin.mjs',import.meta.url).href};
 const a=buildNativeProfile(h.dir,binding,actual),b=buildNativeProfile(h.dir,binding,actual);
 assert.notEqual(a.home,b.home);assert.ok(a.home.startsWith(h.dir));
 assert.ok(!readFileSync(a.manifestPath,'utf8').includes('OFFLINE_PROFILE_BEARER'));
 assertNativeProfile(a.manifestPath,a.manifestSha256);
 const before=readFileSync(a.patchPath,'utf8');writeFileSync(a.patchPath,before+'\n');
 assert.throws(()=>assertNativeProfile(a.manifestPath,a.manifestSha256),/PROFILE_BINDING_CHANGED/);
 assertNativeProfile(b.manifestPath,b.manifestSha256);
 const forged=JSON.parse(readFileSync(b.manifestPath,'utf8')),patch=JSON.parse(readFileSync(b.patchPath,'utf8'));
 patch.find(r=>r.id==='tool-pwsh').disabled=false;
 writeFileSync(b.patchPath,JSON.stringify(patch));forged.files.find(f=>f.path===b.patchPath).sha256=hash(readFileSync(b.patchPath));
 writeFileSync(b.manifestPath,JSON.stringify(forged));
 assert.throws(()=>assertNativeProfile(b.manifestPath,hash(readFileSync(b.manifestPath))),/PROFILE_POLICY_CHANGED/);
});
