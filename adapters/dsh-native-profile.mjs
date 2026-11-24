// Native profile policy; the installed parser reads dynamic tags as data, never code.
import {resolve,dirname,isAbsolute} from 'node:path';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,lstatSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {hash,within} from '../dist/server/security.js';

export const DEEPSEEK_STREAM_IDLE_TIMEOUT_MS=180000;

const core=Object.freeze({
 timer:'@deepseek-ai/cordis-plugin-timer',llm:'@deepseek-ai/dsh-llm',
 'deepseek-llm-api-extensions':'@deepseek-ai/dsh-deepseek-llm-api-extensions',
 session:'@deepseek-ai/dsh-session','session-log-deepseek':'@deepseek-ai/dsh-session-log-deepseek',
 typert:'@deepseek-ai/dsh-typert-registry',agent:'@deepseek-ai/dsh-agent',
 'agent-default-model':'@deepseek-ai/dsh-agent-default-model','session-title':'@deepseek-ai/dsh-session-title',
 'session-persistence-jsonl':'@deepseek-ai/dsh-session-persistence-jsonl',
 'session-projection':'@deepseek-ai/dsh-session-projection',storage:'@deepseek-ai/dsh-storage',
 'storage-json':'@deepseek-ai/dsh-storage-json','storage-domain':'@deepseek-ai/dsh-storage-domain',
 'session-projection-cache':'@deepseek-ai/dsh-session-projection-cache',
 tools:'@deepseek-ai/dsh-tools','system-prompt':'@deepseek-ai/dsh-system-prompt',
 'agent-loop':'@deepseek-ai/dsh-agent-loop','llm-deepseek':'@deepseek-ai/dsh-llm-deepseek-api-key',
 'sdk-app-startup':'@deepseek-ai/dsh-sdk-app','sdk-jsonrpc-server':'@deepseek-ai/dsh-sdk-jsonrpc-server'
});

// The pinned SDK registers its local loopback transport under this fixed key.
export const sdkProvider = 'deepseek-official';
export function customProfileRoute(provider,model){
 if(typeof provider!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(provider)||
    typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(model)||model.includes('://'))throw Error('PROFILE_CUSTOM_ROUTE_INVALID');
 return {provider,model};
}
export function planNativeProfile(base,sdk,yaml,options){
 const role=options.role??'executor';if(!['executor','planner2','reviewer'].includes(role))throw Error('PROFILE_ROLE_DENIED');
 const route=new URL(options.modelURL),plugin=new URL(options.pluginURL);
 if(route.protocol!=='http:'||route.hostname!=='127.0.0.1'||!route.port||route.pathname!=='/v1'||route.username||route.password||route.search||route.hash)throw Error('PROFILE_MODEL_ROUTE_DENIED');
 if(plugin.protocol!=='file:'||plugin.host||plugin.search||plugin.hash)throw Error('PROFILE_TOOL_MODULE_DENIED');
 if(!Number.isSafeInteger(options.maxTokens)||options.maxTokens<128||options.maxTokens>16000||!Number.isSafeInteger(options.contextTokens)||options.contextTokens<1)throw Error('PROFILE_LIMITS_DENIED');
 const schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:value=>Object.freeze({opaqueJs:value})})]);
 const rows=new Map();
 for(const source of [base,sdk]){
  if(typeof source!=='string'||Buffer.byteLength(source)>500000)throw Error('PROFILE_INPUT_LIMIT');
  const patches=yaml.load(source,{schema});if(!Array.isArray(patches))throw Error('PROFILE_PATCH_INVALID');
  for(const entry of patches){
   if(!entry||typeof entry!=='object')throw Error('PROFILE_PATCH_INVALID');
   if(Array.isArray(entry.insert)){
    for(const row of entry.insert){
     if(typeof row.id!=='string'||typeof row.name!=='string')throw Error('PROFILE_DYNAMIC_IDENTITY');
     if(rows.has(row.id))throw Error('PROFILE_DUPLICATE_ROW');
     rows.set(row.id,{id:row.id,name:row.name});
    }
   }else if(typeof entry.id==='string'&&rows.has(entry.id)){
    if(entry.name!==undefined){if(typeof entry.name!=='string')throw Error('PROFILE_DYNAMIC_IDENTITY');rows.get(entry.id).name=entry.name;}
   }else throw Error('PROFILE_PATCH_INVALID');
  }
 }
 for(const[id,name]of Object.entries(core))if(rows.get(id)?.name!==name)throw Error('PROFILE_CORE_IDENTITY_CHANGED:'+id);
 const explicitRoute=options.provider!==undefined||options.model!==undefined;
 if(explicitRoute&&options.role===undefined)throw Error('PROFILE_CUSTOM_ROLE_REQUIRED');
 const routeModel=explicitRoute?customProfileRoute(options.provider,options.model).model:'deepseek-flash';
 const overrides={
  // The pinned SDK otherwise adds dsh_session_log (the complete session event log)
  // to model requests. Custom routes permit only the frozen model payload fields.
  ...(options.role!==undefined?{'session-log-deepseek':{enabled:false}}:{}),
  tools:{mode:'native',maxParallelSubCalls:1},
  'agent-default-model':{provider:sdkProvider,model:routeModel},
  'agent-loop':{agents:[]},'sdk-jsonrpc-server':{maxTokensAsSuccess:false},
  'system-prompt':{personaPrefix:role==='executor'?'You are the Dream Maker executor. Use only the approved desk tools. Completion is decided by the external verifier and reviewer.':role==='planner2'?'You are the Dream Maker planner2. Use only the controller-provided frozen materials and do not modify source. Submit the complete engineering plan by calling submit_engineering_plan exactly once; do not answer in prose.':'You are the Dream Maker reviewer. Use only the controller-provided frozen materials and do not modify source. Submit the complete independent review by calling submit_review exactly once; do not answer in prose.'},
  'session-persistence-jsonl':{root:resolve(options.home,'sessions')},
  'storage-json':{root:resolve(options.home,'storages')},'storage-domain':{backend:'json'},
  'session-projection-cache':{writeEveryEvents:200,writeIntervalMs:5000},
  'llm-deepseek':{baseURL:options.modelURL,apiKeyEnv:'DEEPSEEK_API_KEY',thinking:'disabled',reasoningEffort:'off',maxTokens:options.maxTokens,
   defaultContextWindow:options.contextTokens,models:[{id:routeModel,contextWindow:options.contextTokens,maxTokens:options.maxTokens,inputModalities:['text']}],
   retryPolicy:{mode:'normal',maxRetries:0},streamIdleTimeoutMs:DEEPSEEK_STREAM_IDLE_TIMEOUT_MS}
 };
 const patch=[...rows.values()].map(row=>({id:row.id,disabled:!Object.hasOwn(core,row.id),...(Object.hasOwn(overrides,row.id)?{config:overrides[row.id]}:{})}));
 patch.push({insert:[{id:'dream-maker-executor-tools',name:options.pluginURL}]});
 return{patch,disabled:patch.filter(r=>r.disabled).map(r=>r.id),enabled:Object.keys(core),rows:[...rows.values()]};
}

export function buildNativeProfile(root,binding,connection){
 if(!isAbsolute(root)||binding.sdkCommit!=='4878cdabd87d4041bdaff61d04c966883b9fd07a'||!Array.isArray(binding.dependencies))throw Error('PROFILE_NATIVE_BINDING_REQUIRED');
 for(const path of [binding.basePatch,binding.sdkPatch,binding.yamlModule]){
  const expected=binding.dependencies.find(f=>f.path===path);
  if(!expected||!isAbsolute(path)||hash(readFileSync(path))!==expected.sha256)throw Error('PROFILE_INPUT_CHANGED');
 }
 const yaml=createRequire(import.meta.url)(binding.yamlModule);
 const parent=within(root,'.runtime/dsh-profiles');mkdirSync(parent,{recursive:true});
 const home=mkdtempSync(resolve(parent,'owned-')),directory=within(home,'profiles/sdk');mkdirSync(directory,{recursive:true});
 const planned=planNativeProfile(readFileSync(binding.basePatch,'utf8'),readFileSync(binding.sdkPatch,'utf8'),yaml,{...connection,home});
 const packagePath=resolve(directory,'package.json'),patchPath=resolve(directory,'cordis.patch.yml');
 writeFileSync(packagePath,JSON.stringify({name:'dream-maker-owned-sdk',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-sdk-app']}}},null,2)+'\n',{flag:'wx',mode:0o600});
 writeFileSync(patchPath,JSON.stringify(planned.patch,null,2)+'\n',{flag:'wx',mode:0o600});
 const pluginPath=fileURLToPath(connection.pluginURL);
 const ownFiles=[fileURLToPath(import.meta.url),pluginPath,resolve(dirname(pluginPath),'dsh-tool-client.mjs'),resolve(dirname(pluginPath),'../dist/server/security.js')];
 const dependencies=[...binding.dependencies,...ownFiles.map(path=>({path,sha256:hash(readFileSync(path))}))];
 const manifest={schema:'dream-maker.dsh-profile.v1',sdkCommit:binding.sdkCommit,home,profile:'sdk',
  inputs:{basePatch:binding.basePatch,sdkPatch:binding.sdkPatch,yamlModule:binding.yamlModule},pluginURL:connection.pluginURL,
  modelURL:connection.modelURL,model:connection.model??'deepseek-flash',...(connection.provider!==undefined?{provider:connection.provider}:{}),maxTokens:connection.maxTokens,contextTokens:connection.contextTokens,enabled:planned.enabled,disabled:planned.disabled,...(connection.role?{role:connection.role}:{}),
  files:[packagePath,patchPath].map(path=>({path,sha256:hash(readFileSync(path))})),dependencies,
  hostTools:false,credentialFallback:false,telemetry:false,implicitLaya:false,automaticRetry:false,validation:'NOT_LIVE_AGENT'};
 const manifestPath=resolve(home,'profile-manifest.json');writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 return{home,profile:'sdk',patchPath,manifestPath,manifestSha256:hash(readFileSync(manifestPath))};
}

export function assertNativeProfile(path,expected){
 if(!isAbsolute(path)||lstatSync(path).isSymbolicLink())throw Error('PROFILE_BINDING_CHANGED');
 const bytes=readFileSync(path);if(hash(bytes)!==expected)throw Error('PROFILE_BINDING_CHANGED');
 const m=JSON.parse(bytes);
 if(m.schema!=='dream-maker.dsh-profile.v1'||m.sdkCommit!=='4878cdabd87d4041bdaff61d04c966883b9fd07a'||m.profile!=='sdk'||
  (m.provider===undefined?m.model!=='deepseek-flash':m.role===undefined)||m.hostTools!==false||m.credentialFallback!==false||m.telemetry!==false||m.implicitLaya!==false||m.automaticRetry!==false||!Array.isArray(m.files)||!Array.isArray(m.dependencies))throw Error('PROFILE_BINDING_CHANGED');
 for(const item of [...m.files,...m.dependencies]){
  if(!isAbsolute(item.path)||lstatSync(item.path).isSymbolicLink()||hash(readFileSync(item.path))!==item.sha256)throw Error('PROFILE_BINDING_CHANGED');
 }
 const expectedPackage={name:'dream-maker-owned-sdk',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-sdk-app']}}};
 const packagePath=within(m.home,'profiles/sdk/package.json'),patchPath=within(m.home,'profiles/sdk/cordis.patch.yml');
 if(!m.files.some(f=>f.path===packagePath)||!m.files.some(f=>f.path===patchPath)||!m.inputs||
  Object.values(m.inputs).some(path=>!m.dependencies.some(f=>f.path===path)))throw Error('PROFILE_POLICY_CHANGED');
 const yaml=createRequire(import.meta.url)(m.inputs.yamlModule);
 const planned=planNativeProfile(readFileSync(m.inputs.basePatch,'utf8'),readFileSync(m.inputs.sdkPatch,'utf8'),yaml,
  {home:m.home,modelURL:m.modelURL,...(m.provider!==undefined?customProfileRoute(m.provider,m.model):{}),maxTokens:m.maxTokens,contextTokens:m.contextTokens,pluginURL:m.pluginURL,...(m.role!==undefined?{role:m.role}:{})});
 if(hash(JSON.parse(readFileSync(packagePath,'utf8')))!==hash(expectedPackage)||hash(JSON.parse(readFileSync(patchPath,'utf8')))!==hash(planned.patch)||
  hash(m.enabled)!==hash(planned.enabled)||hash(m.disabled)!==hash(planned.disabled))throw Error('PROFILE_POLICY_CHANGED');
 return m;
}
