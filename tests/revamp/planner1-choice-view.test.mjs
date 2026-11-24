import test from 'node:test';
import assert from 'node:assert/strict';
import {planner1ChoiceForm,loadLocalPlanner1Check} from '../../dist/web/planner1-choice-view.js';
import {defaults} from '../../dist/server/config.js';
import {planner1Binding} from '../../dist/server/planner1-binding.js';
import {shell} from '../../dist/web/views.js';
test('P1 choice separates official OAuth and API routes, with consent and no key input',()=>{
 const html=planner1ChoiceForm({config:defaults,planner1Binding:{provider:'deepseek',authMethod:'api_key',model:'<untrusted>'}});
 assert.match(html,/value="deepseek:api_key" selected/);assert.match(html,/value="kimi:oauth"/);assert.doesNotMatch(html,/value="openai:oauth"/);assert.match(html,/name="p1ChoiceConsent" required/);assert.match(html,/&lt;untrusted&gt;/);assert.doesNotMatch(html,/<input[^>]+name="(?:apiKey|token|password)"/);
});
test('local P1 is an explicit Ollama loopback choice and exposes only the controller-owned capability check',()=>{
 const html=planner1ChoiceForm({config:defaults,planner1Binding:{provider:'local',authMethod:'none',model:'qwen2.5:7b'}});
 assert.match(html,/value="local:none" selected/);assert.match(html,/Ollama/);assert.match(html,/127\.0\.0\.1:11434/);assert.match(html,/data-action="planner1-local-check"/);
 assert.match(html,/只替换方案助手/);assert.doesNotMatch(html,/<input[^>]+name="(?:endpoint|baseUrl|apiKey|token|password)"/);
});
test('a successful local check also reads the separate role scope before rendering',async()=>{
 const hardware={totalMemoryMiB:32768,availableMemoryMiB:16384,cpuCores:8,platform:'win32',architecture:'x64',sampledAt:'2026-11-07T00:00:00.000Z'};
 const capability={schema:'dream-maker.local-planner1-capability.v1',status:'PASSED',provider:'local',runner:'LOCAL_HTTP',authentication:'NONE',endpoint:'http://127.0.0.1:11434/v1',model:'qwen2.5:7b',bindingHash:'a'.repeat(64),checkedAt:'2026-11-07T00:00:00.000Z',responseId:'local_response',responseHash:'b'.repeat(64),hardware};
 const status={schema:'dream-maker.local-planner1-status.v1',planner1:{mode:'LOCAL_ONLY',endpoint:'http://127.0.0.1:11434/v1',model:'qwen2.5:7b',cloudFallback:false,requestsOtherAccounts:false},hardware,models:[],recommendedModel:'qwen2.5:7b',otherRoles:[{role:'executor',configuration:'DSH / deepseek-flash',network:'按 DeepSeek 官方服务条件单独核验',separateApproval:true}],projectDependencies:{status:'NOT_PREDETERMINED',note:'实际项目依赖另行确认'},limits:['不会自动切换云端']};
 const calls=[];
 const adapter={request:async(path,method,body)=>{calls.push({path,method,body});return method==='POST'?capability:status;}};
 const view=await loadLocalPlanner1Check(adapter);
 assert.deepEqual(calls.map(item=>[item.path,item.method]),[['/planner1/local/check','POST'],['/planner1/local/status','GET']]);
 assert.deepEqual(calls[0].body,{confirmed:true});
 assert.equal(view.model,'qwen2.5:7b');assert.equal(view.otherRoles[0].role,'executor');assert.deepEqual(view.limits,['不会自动切换云端']);
});
test('local Planner 1 settings do not fall back to the legacy API-key protocol form',()=>{
 const config=structuredClone(defaults);
 Object.assign(config.planner1,{provider:'local',bindingVersion:3,authMode:'api_key',protocol:'chat-completions',baseUrl:'http://127.0.0.1:11434/v1',keyEnv:'DM_LOCAL_PLANNER1_NO_KEY',model:'qwen2.5:7b'});
 const view={product:'dream-maker',mode:'local',screen:'settings',projects:[],snapshot:null,settings:{config,planner1Binding:planner1Binding(config),keyStatus:{planner1:false,executor:false},nativeStatus:'NOT_VERIFIED',flows:[]},tab:'work',busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:40,clash:null,draft:()=>'',hasDraft:()=>false};
 const html=shell(view);
 assert.match(html,/本机 Ollama/);assert.match(html,/qwen2\.5:7b/);assert.match(html,/data-action="planner1-choice"/);
 assert.doesNotMatch(html,/name="protocol"|name="authMode"|name="p1Model"|data-action="models"/);
});
test('local Planner 1 Live consent names the loopback model and cannot use the paid API consent',()=>{
 const config=structuredClone(defaults);
 Object.assign(config.planner1,{provider:'local',bindingVersion:3,authMode:'api_key',protocol:'chat-completions',baseUrl:'http://127.0.0.1:11434/v1',keyEnv:'DM_LOCAL_PLANNER1_NO_KEY',model:'qwen2.5:7b'});
 const view={product:'dream-maker',mode:'local',screen:'home',projects:[],snapshot:null,settings:{config,planner1Binding:planner1Binding(config),keyStatus:{planner1:false,executor:false},nativeStatus:'NOT_VERIFIED',flows:[]},tab:'work',busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:40,clash:null,draft:()=>'',hasDraft:()=>false};
 const html=shell(view);
 assert.match(html,/name="localConsent"/);assert.match(html,/本机 Ollama/);assert.doesNotMatch(html,/name="apiConsent"/);
});
