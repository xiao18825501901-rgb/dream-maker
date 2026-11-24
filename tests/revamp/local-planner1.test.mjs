// Offline local HTTP control tests. The local server is synthetic and this is not a real model capability claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {Settings,defaults} from '../../dist/server/config.js';
import {ModelProvider} from '../../dist/server/providers/model.js';
import {LocalPlanner1Runtime,assessLocalPlanner1Hardware,localPlanner1Status,recordLocalPlanner1Capability,currentLocalPlanner1Capability} from '../../dist/server/local-planner1.js';
import {planner1Binding} from '../../dist/server/planner1-binding.js';
import {Interviews} from '../../dist/server/interview.js';
import {harness,bindKimi,root} from '../helpers.mjs';

const hardware=overrides=>({totalMemoryMiB:32768,availableMemoryMiB:16384,cpuCores:8,platform:'win32',architecture:'x64',sampledAt:'2026-11-07T00:00:00.000Z',...overrides});
function localSettings(t){
 const h=harness(t),path=join(h.dir,'local-p1.json'),c=bindKimi(structuredClone(defaults));writeFileSync(path,JSON.stringify(c));const settings=new Settings(path);
 settings.selectPlanner1({provider:'local',authentication:'none',model:'qwen2.5:7b',confirmed:true});return{h,settings};
}
function chat(model='qwen2.5:7b') {
 return {id:'chatcmpl_local_1',model,choices:[{message:{content:'{"probe":"value"}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3}};
}

test('hardware assessment recommends only models that fit and never treats a local role as whole-product offline proof',t=>{
 const {settings}=localSettings(t),status=localPlanner1Status(settings.value,hardware());
 assert.equal(status.recommendedModel,'qwen2.5:7b');assert.equal(status.planner1.mode,'LOCAL_ONLY');assert.equal(status.planner1.cloudFallback,false);
 assert.equal(status.projectDependencies.status,'NOT_PREDETERMINED');assert.ok(status.otherRoles.some(role=>role.role==='executor'&&/DeepSeek/.test(role.network)));
 const low=assessLocalPlanner1Hardware('qwen2.5:7b',hardware({availableMemoryMiB:1024}));assert.equal(low.supported,false);assert.deepEqual(low.missing,['AVAILABLE_MEMORY']);
});

test('local capability check requires a real bounded response from the exact selected model',async t=>{
 let calls=0;const runtime=new LocalPlanner1Runtime(async(url,init)=>{
  calls++;
  if(url==='http://127.0.0.1:11434/v1/models')return{data:[{id:'qwen2.5:7b'}]};
  assert.equal(url,'http://127.0.0.1:11434/v1/chat/completions');assert.equal(init.headers.authorization,undefined);
  const body=JSON.parse(String(init.body)),challenge=JSON.parse(body.messages[1].content).probe,result=chat();
  result.choices[0].message.content=JSON.stringify({probe:challenge});return result;
 },()=>hardware());
 const capability=await runtime.check('qwen2.5:7b');assert.equal(capability.status,'PASSED');assert.equal(capability.runner,'LOCAL_HTTP');assert.equal(capability.authentication,'NONE');assert.equal(calls,2);
});

test('insufficient hardware rejects before any local service request',async()=>{
 let calls=0;const runtime=new LocalPlanner1Runtime(async()=>{calls++;throw Error('NO_NETWORK');},()=>hardware({availableMemoryMiB:512}));
 await assert.rejects(()=>runtime.check('qwen2.5:7b'),{code:'LOCAL_PLANNER1_HARDWARE_INSUFFICIENT'});assert.equal(calls,0);
});

test('the local ModelProvider uses no cloud paid guard or authorization header and binds the fixed loopback route',async t=>{
 const {settings}=localSettings(t),requests=[];let paid=0;
 const runtime={assertReady:async()=>({hardware:hardware(),installedModels:['qwen2.5:7b']})};
 const model=new ModelProvider(()=>settings.value,root,async(url,init)=>{
  requests.push({url,init});const result=chat();result.choices[0].message.content='{"goal":"OFFLINE_LOCAL"}';return result;
 },()=>{paid++;throw Error('PAID_GUARD_MUST_NOT_RUN');},undefined,runtime);
 const out=await model.complete({task:'summary',idea:'offline'});
 assert.equal(out.data.goal,'OFFLINE_LOCAL');assert.equal(paid,0);assert.equal(requests.length,1);
 assert.equal(requests[0].url,'http://127.0.0.1:11434/v1/chat/completions');assert.equal(requests[0].init.headers.authorization,undefined);
 assert.equal(out.observation.runner,'LOCAL_HTTP');assert.equal(out.observation.provider,'local-ollama');assert.equal(out.observation.ledgerRequestId,null);
});

test('capability evidence is bound to the exact local model and expires without enabling cloud fallback',async t=>{
 const {h,settings}=localSettings(t),binding=planner1Binding(settings.value),checkedAt='2026-11-07T00:00:00.000Z';
 recordLocalPlanner1Capability(h.store,binding,{schema:'dream-maker.local-planner1-capability.v1',status:'PASSED',provider:'local',runner:'LOCAL_HTTP',authentication:'NONE',endpoint:'http://127.0.0.1:11434/v1',model:'qwen2.5:7b',bindingHash:'',checkedAt,responseId:'local_response',responseHash:'a'.repeat(64),hardware:hardware({sampledAt:checkedAt})});
 assert.ok(currentLocalPlanner1Capability(h.store,binding,Date.parse(checkedAt)+1000));
 assert.equal(currentLocalPlanner1Capability(h.store,binding,Date.parse(checkedAt)+25*60*60*1000),null);
 const changed=structuredClone(binding);changed.model='qwen2.5:3b';assert.equal(currentLocalPlanner1Capability(h.store,changed,Date.parse(checkedAt)+1000),null);
});

test('Planner 1 refuses a selected local model until the controller capability check exists',async t=>{
 const {h,settings}=localSettings(t);let calls=0;
 const planner=new Interviews(h.store,{complete:async()=>{calls++;return{data:{ok:true},usage:{role:'planner1',inputTokens:0,outputTokens:0,costUsd:null,source:'OFFLINE_LOCAL'}};}},h.laya,()=>settings.value);
 t.after(()=>planner.close());
 const project=planner.create('本地方案助手边界','只验证能力检查门禁。','live');
 await assert.rejects(()=>planner.askModelInternal(project.id,{task:'offline-local'}),{code:'LOCAL_PLANNER1_CAPABILITY_CHECK_REQUIRED'});
 assert.equal(calls,0);
 const binding=planner1Binding(settings.value),checkedAt=new Date().toISOString();
 recordLocalPlanner1Capability(h.store,binding,{schema:'dream-maker.local-planner1-capability.v1',status:'PASSED',provider:'local',runner:'LOCAL_HTTP',authentication:'NONE',endpoint:'http://127.0.0.1:11434/v1',model:binding.model,bindingHash:'',checkedAt,responseId:'local_response',responseHash:'b'.repeat(64),hardware:hardware({sampledAt:checkedAt})});
 assert.deepEqual(await planner.askModelInternal(project.id,{task:'offline-local'}),{ok:true});assert.equal(calls,1);
});
