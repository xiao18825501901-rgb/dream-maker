// OFFLINE host-envelope contracts. These are not Archon/DSH model or isolation evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness,root } from './helpers.mjs';
import { hash } from '../dist/server/security.js';
import { createArchonAdapter } from '../adapters/archon-dsh-native.mjs';
import {buildNativeProfile} from '../adapters/dsh-native-profile.mjs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const source = `let hostStarts=0;export function hostStartCount(){return hostStarts;}export class NodeHostHarness {
 constructor(options){hostStarts++;this.options=options;this.closed=false;}
 async run(input,options){
  const config=this.options.config;
  if(input==='OFFLINE_FROZEN_MODEL'&&(config.provider!=='deepseek-official'||config.model!=='tenant/model-v2'))throw Error('OFFLINE_HOST_MODEL_CHANGED');
  if(config.env)throw Error('KEYS_IN_CONFIG');
  if(this.options.env.SHENLIN_LAYA_ENABLED!=='false')throw Error('HIDDEN_HOOK_NOT_DISABLED');
  if(this.options.env.DEEPSEEK_BASE_URL!=='http://127.0.0.1:12345/v1')throw Error('MODEL_GATEWAY_ROUTE_LOST');
  if(this.options.env.DEEPSEEK_API_KEY!=='OFFLINE_EPHEMERAL_BEARER')throw Error('MODEL_GATEWAY_BEARER_LOST');
  if(this.options.env.DM_NATIVE_AUDIT_PATH||this.options.env.DM_MODEL_GATEWAY_TOKEN)throw Error('EXCESS_CONTROL_ENV');
  if(this.options.env.DM_TOOL_PROXY_URL!=='http://127.0.0.1:12346/tools'||this.options.env.DM_TOOL_PROXY_TOKEN!=='OFFLINE_TOOL_BEARER')throw Error('TOOL_BRIDGE_LOST');
  if(!this.options.env.DM_DSH_PROFILE_MANIFEST||!this.options.env.DM_DSH_PROFILE_SHA256)throw Error('PROFILE_BINDING_LOST');
  if(config.cwd.includes('workspace'))throw Error('UNTRUSTED_MODEL_RUNTIME_CWD');
  for(const event of [
   {type:'status',status:'running',phase:'prompt accepted'},
   {type:'status',status:'idle',raw:'turn ended: completed'},
   {type:'assistant_text',text:'OFFLINE_ARCHON_HOST_RESULT'},
   {type:'result',stopReason:'completed',sawReceipt:true,sawIdle:true}
  ]) options.onNotification({method:'agent-desk',params:{schemaVersion:1,...event}});
  return {sessionId:options.sessionId,closed:input!=='OFFLINE_CLOSE_FAILURE',turns:1};
 }
 async close(){this.closed=true;}
}
export class HostEventBridge {
 constructor(){this.assistant=false;}
 consume(n){if(n.params.type==='assistant_text'){this.assistant=true;return [{type:'assistant',content:n.params.text}];}return [];}
 finish(){return {ok:this.assistant,reason:'OFFLINE_TEST'};}
 status(){return {openTools:0};}
}`;

function fixture(t,role,route) {
    const ownedEnv={DM_DSH_KEY_ENV:'DM_OFFLINE_GATEWAY_KEY',DM_OFFLINE_GATEWAY_KEY:'OFFLINE_EPHEMERAL_BEARER',DM_MODEL_GATEWAY_URL:'http://127.0.0.1:12345/v1',DM_MODEL_GATEWAY_TOKEN:'OFFLINE_EPHEMERAL_BEARER'};
    const prior=Object.fromEntries(Object.keys(ownedEnv).map(k=>[k,process.env[k]]));
    Object.assign(process.env,ownedEnv);
    t.after(()=>{for(const [k,v] of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
    const h = harness(t), module = resolve(h.dir, 'host-fixture.mjs');
    writeFileSync(module, source);
    const toolConfig=resolve(h.dir,'offline-tool-config.json');
    writeFileSync(toolConfig,JSON.stringify({schema:'dream-maker.dsh-tool-client.v1',toolUrl:'http://127.0.0.1:12346/tools',...(role?{role}:{}),...route}));
    const toolEnv={DM_TOOL_PROXY_URL:'http://127.0.0.1:12346/tools',DM_TOOL_PROXY_TOKEN:'OFFLINE_TOOL_BEARER',DM_DSH_TOOL_CLIENT_CONFIG:toolConfig,DM_DSH_TOOL_CLIENT_SHA256:hash(readFileSync(toolConfig))};
    const previous=Object.fromEntries(Object.keys(toolEnv).map(k=>[k,process.env[k]]));Object.assign(process.env,toolEnv);
    t.after(()=>{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
    const sdkRoot = resolve(h.dir, 'sdk'), sdkEntry = resolve(sdkRoot, 'lib/index.js');
    mkdirSync(resolve(sdkRoot, 'lib'), { recursive: true });
    writeFileSync(sdkEntry, '// OFFLINE SDK identity placeholder, never executed.');
    const dsh='C:/Users/Hp/Documents/Archon_Astra_DSH_Source_Package/Archon_Astra_DSH_Source_Package/upstream/deepseek-harness';
    const parser=createRequire(dsh+'/packages/boot/app-boot/package.json').resolve('js-yaml');
    const paths={basePatch:dsh+'/packages/bundle/base/cordis.patch.yml',sdkPatch:dsh+'/packages/bundle/sdk-app/cordis.patch.yml',yamlModule:parser};
    const profile=buildNativeProfile(h.dir,{sdkCommit:'4878cdabd87d4041bdaff61d04c966883b9fd07a',...paths,dependencies:Object.values(paths).map(path=>({path,sha256:hash(readFileSync(path))}))},
      {modelURL:'http://127.0.0.1:12345/v1',maxTokens:256,contextTokens:1048576,pluginURL:pathToFileURL(resolve(root,'adapters/dsh-tools-plugin.mjs')).href,...(role?{role}:{}),...route});
    const options = { hostModule: module, eventModule: module, hostScript: module, sdkRoot, dshBin: module, dshHome: profile.home,profileManifestPath:profile.manifestPath,profileManifestSha256:profile.manifestSha256, controlRoot: resolve(h.dir, 'control'), dependencyFiles: [], patches: [], profile: 'sdk', verifierModule: module, reasoningEffort: 'off', maxTokens: 256, timeoutMs: 5000 };
    const audit = { status: 'OFFLINE_TEST_NOT_LIVE', evidenceFiles: [module, sdkEntry].map(path => ({ path, sha256: hash(readFileSync(path)) })) };
    const input = { role: 'executor', workspace: resolve(h.dir, 'workspace'), prompt: 'OFFLINE_CONTRACT_INPUT', runId: 'offline-run', specHash: 'offline-spec', model: 'deepseek-flash', laya: { adoption: 'off' } };
    return { h, options, audit, input, adapter: createArchonAdapter(options, audit) };
}

test('Archon adapter reuses a bound host, returns its session, and owns exactly one dispatch', async t => {
    const f = fixture(t), events = [];
    const result = await f.adapter.run(f.input, event => events.push(event), new AbortController().signal);
    assert.equal(result.text, 'OFFLINE_ARCHON_HOST_RESULT');
    assert.match(result.sessionId, /^archon_session_/);
    assert.equal(events[0].owner, 'dream-maker-engine');
    assert.equal((await f.adapter.capabilities()).verified, false);
});

test('Archon adapter refuses another role, cancellation and changed file bindings before dispatch', async t => {
    const f = fixture(t), signal = new AbortController().signal;
    await assert.rejects(f.adapter.run({ ...f.input, role: 'reviewer' }, () => {}, signal), { code: 'ARCHON_EXECUTOR_ROLE_REQUIRED' });
    await assert.rejects(f.adapter.run(f.input, () => {}, AbortSignal.abort()), { code: 'RUN_CANCELLED' });
    writeFileSync(f.options.hostModule, source + '\n// changed');
    await assert.rejects(f.adapter.run(f.input, () => {}, signal), { code: 'ARCHON_BINDING_CHANGED' });
});

test('Archon adapter cannot treat a host result with unproven close as completion', async t => {
    const f = fixture(t);
    f.input.prompt = 'OFFLINE_CLOSE_FAILURE';
    await assert.rejects(f.adapter.run(f.input, () => {}, new AbortController().signal), { code: 'ARCHON_HOST_CLOSE_UNPROVEN' });
});

test('Archon adapter has no fake verifier fallback', async t => {
    const f = fixture(t);
    delete f.options.verifierModule;
    await assert.rejects(f.adapter.verify(f.input, () => {}, new AbortController().signal), { code: 'NATIVE_SANDBOX_VERIFIER_REQUIRED' });
});
test('Archon dispatch refuses absent or mismatched monetary gateway before running the native host',async t=>{
    const f=fixture(t);
    delete process.env.DM_MODEL_GATEWAY_URL;
    await assert.rejects(f.adapter.run(f.input,()=>{},new AbortController().signal),{code:'NATIVE_MODEL_GATEWAY_REQUIRED'});
    process.env.DM_MODEL_GATEWAY_URL='https://api.deepseek.com/v1';
    await assert.rejects(f.adapter.run(f.input,()=>{},new AbortController().signal),{code:'NATIVE_MODEL_GATEWAY_INVALID'});
});

test('Archon dispatch refuses a missing tool bridge even with a valid model gateway',async t=>{
 const f=fixture(t);
 const prior=process.env.DM_TOOL_PROXY_TOKEN;delete process.env.DM_TOOL_PROXY_TOKEN;
 t.after(()=>{if(prior===undefined)delete process.env.DM_TOOL_PROXY_TOKEN;else process.env.DM_TOOL_PROXY_TOKEN=prior;});
 await assert.rejects(f.adapter.run(f.input,()=>{},new AbortController().signal),{code:'NATIVE_TOOL_PROXY_REQUIRED'});
});

test('Archon dispatch refuses missing profile and extra overlays that can reenable host tools',async t=>{
 const f=fixture(t),signal=new AbortController().signal,path=f.options.profileManifestPath;
 delete f.options.profileManifestPath;
 await assert.rejects(f.adapter.run(f.input,()=>{},signal),{code:'NATIVE_FROZEN_PROFILE_REQUIRED'});
 f.options.profileManifestPath=path;f.options.patches=[f.options.hostScript];
 await assert.rejects(f.adapter.run(f.input,()=>{},signal),{code:'NATIVE_PROFILE_OVERLAYS_DENIED'});
});

test('trusted model runtime directories cannot overlap generated source',async t=>{
 const f=fixture(t);f.options.controlRoot=f.input.workspace;
 await assert.rejects(f.adapter.run(f.input,()=>{},new AbortController().signal),{code:'NATIVE_CONTROL_SOURCE_OVERLAP'});
});

for(const role of ['planner2','reviewer'])test('an explicitly frozen Custom '+role+' uses its own SDK session with no executor authority',async t=>{
 const f=fixture(t,role);f.input.role=role;f.input.specHash='b'.repeat(64);
 f.options.runBinding={runId:f.input.runId,specHash:f.input.specHash,role,roleId:role,configurationHash:'a'.repeat(64)};
 const adapter=createArchonAdapter(f.options,f.audit),one=await adapter.run(f.input,()=>{},new AbortController().signal),two=await adapter.run(f.input,()=>{},new AbortController().signal);
 assert.notEqual(one.sessionId,two.sessionId);assert.equal(one.text,'OFFLINE_ARCHON_HOST_RESULT');
 await assert.rejects(adapter.run({...f.input,role:'executor'},()=>{},new AbortController().signal),{code:'NATIVE_DISPATCH_ROLE_MISMATCH'});
});
test('Custom native host uses the declared model only with the matching frozen provider',async t=>{
 const route={provider:'account-provider',model:'tenant/model-v2'},f=fixture(t,'reviewer',route);
 Object.assign(f.input,{role:'reviewer',specHash:'b'.repeat(64),...route,prompt:'OFFLINE_FROZEN_MODEL'});
 const binding={runId:f.input.runId,specHash:f.input.specHash,role:'reviewer',roleId:'reviewer',configurationHash:'a'.repeat(64),...route};
 const adapter=createArchonAdapter({...f.options,runBinding:binding},f.audit);
 assert.equal((await adapter.run(f.input,()=>{},new AbortController().signal)).text,'OFFLINE_ARCHON_HOST_RESULT');
 await assert.rejects(adapter.run({...f.input,model:'deepseek-flash'},()=>{},new AbortController().signal),{code:'NATIVE_MODEL_GATEWAY_INVALID'});
 await assert.rejects(createArchonAdapter({...f.options,runBinding:{...binding,provider:'other'}},f.audit).run({...f.input,provider:'other'},()=>{},new AbortController().signal),{code:'NATIVE_TOOL_PROXY_BINDING_INVALID'});
 await assert.rejects(adapter.run({...f.input,provider:'other'},()=>{},new AbortController().signal),{code:'NATIVE_MODEL_GATEWAY_INVALID'});
});
test('frozen supervisor cannot borrow a legacy executor profile or tool client',async t=>{
 const f=fixture(t);f.input.role='reviewer';f.input.specHash='b'.repeat(64);f.options.runBinding={runId:f.input.runId,specHash:f.input.specHash,role:'reviewer',roleId:'reviewer',configurationHash:'a'.repeat(64)};
 await assert.rejects(createArchonAdapter(f.options,f.audit).run(f.input,()=>{},new AbortController().signal),{code:'NATIVE_TOOL_ROLE_MISMATCH'});
});
test('a matching supervisor tool client cannot conceal a mismatched executor profile',async t=>{
 const f=fixture(t);f.input.role='reviewer';f.input.specHash='b'.repeat(64);f.options.runBinding={runId:f.input.runId,specHash:f.input.specHash,role:'reviewer',roleId:'reviewer',configurationHash:'a'.repeat(64)};
 const path=process.env.DM_DSH_TOOL_CLIENT_CONFIG,client=JSON.parse(readFileSync(path));client.role='reviewer';writeFileSync(path,JSON.stringify(client));process.env.DM_DSH_TOOL_CLIENT_SHA256=hash(readFileSync(path));
 await assert.rejects(createArchonAdapter(f.options,f.audit).run(f.input,()=>{},new AbortController().signal),{code:'NATIVE_FROZEN_PROFILE_CHANGED'});
 assert.equal((await import(pathToFileURL(f.options.hostModule).href)).hostStartCount(),0);
});
test('v2 executor input must match its exact frozen executor roleId before any host starts',async t=>{
 const f=fixture(t,'executor');f.input.specHash='b'.repeat(64);f.options.runBinding={runId:f.input.runId,specHash:f.input.specHash,role:'executor',roleId:'execA',configurationHash:'a'.repeat(64)};
 const adapter=createArchonAdapter(f.options,f.audit);
 for(const executorRoleId of [undefined,'execB'])await assert.rejects(adapter.run({...f.input,executorRoleId},()=>{},AbortSignal.abort()),{code:'NATIVE_DISPATCH_ROLE_MISMATCH'});
 await assert.rejects(adapter.run({...f.input,executorRoleId:'execA'},()=>{},AbortSignal.abort()),{code:'RUN_CANCELLED'});
 assert.equal((await import(pathToFileURL(f.options.hostModule).href)).hostStartCount(),0);
});
