// Explicit local selection only. No provider request, OAuth assertion, real credential or Live claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Settings,defaults} from '../../dist/server/config.js';
import {planner1Binding,assertPlanner1DispatchAllowed} from '../../dist/server/planner1-binding.js';
import {harness,bindKimi} from '../helpers.mjs';

function settings(t){const h=harness(t),path=join(h.dir,'p1-selection.json'),c=bindKimi(structuredClone(defaults));c.dsh.keyEnv='OWNER_DSH_KEY_REF';writeFileSync(path,JSON.stringify(c));const value=new Settings(path);return{settings:value,path,c:structuredClone(value.value)};}
test('explicit P1 API selection creates a v2 binding without changing engineering configuration or asserting OAuth',t=>{
 const {settings:s,c,path}=settings(t),view=s.selectPlanner1({provider:'openai',authentication:'api_key',model:'owner-openai-model',confirmed:true});
 assert.equal(view.planner1Binding.provider,'openai');assert.equal(view.planner1Binding.runner,'http-api');assert.equal(view.planner1Binding.authMethod,'api_key');assert.equal(view.planner1Binding.bindingVersion,2);
 assert.equal(view.planner1Retired,false);assert.equal(view.nativeStatus,'NOT_VERIFIED');assert.deepEqual(s.value.codex,c.codex);assert.deepEqual(s.value.dsh,c.dsh);assert.deepEqual(s.value.kimi,c.kimi);assert.deepEqual(s.value.laya,c.laya);
 assert.equal(s.value.planner1.baseUrl,'https://api.openai.com/v1');assert.equal(s.value.planner1.protocol,'openai-responses');assert.equal(s.value.planner1.keyEnv,'OPENAI_API_KEY');
 assert.doesNotThrow(()=>assertPlanner1DispatchAllowed(planner1Binding(new Settings(path).value)));
});
test('explicit DeepSeek P1 selection binds the official route and the controller-owned credential reference',t=>{
 const {settings:s}=settings(t);s.selectPlanner1({provider:'deepseek',authentication:'api_key',model:'owner-deepseek-model',confirmed:true});
 assert.equal(s.value.planner1.baseUrl,'https://api.deepseek.com');assert.equal(s.value.planner1.protocol,'chat-completions');assert.equal(s.value.planner1.keyEnv,'OWNER_DSH_KEY_REF');assert.equal(planner1Binding(s.value).authMethod,'api_key');
 assert.doesNotThrow(()=>assertPlanner1DispatchAllowed(planner1Binding(s.value)));
});
test('explicit local P1 selection binds only the fixed loopback Ollama route and leaves every engineering role untouched',t=>{
 const {settings:s,c}=settings(t),view=s.selectPlanner1({provider:'local',authentication:'none',model:'qwen2.5:7b',confirmed:true});
 assert.equal(view.planner1Binding.provider,'local');assert.equal(view.planner1Binding.runner,'local-http');assert.equal(view.planner1Binding.authMethod,'none');assert.equal(view.planner1Binding.bindingVersion,3);
 assert.equal(view.planner1Binding.credentialRef,'DM_LOCAL_PLANNER1_NO_KEY');assert.equal(view.planner1Retired,false);assert.equal(view.nativeStatus,'NOT_VERIFIED');
 assert.equal(s.value.planner1.baseUrl,'http://127.0.0.1:11434/v1');assert.equal(s.value.planner1.protocol,'chat-completions');assert.equal(s.value.planner1.keyEnv,'DM_LOCAL_PLANNER1_NO_KEY');
 assert.deepEqual(s.value.codex,c.codex);assert.deepEqual(s.value.dsh,c.dsh);assert.deepEqual(s.value.kimi,c.kimi);assert.deepEqual(s.value.laya,c.laya);
 assert.doesNotThrow(()=>assertPlanner1DispatchAllowed(planner1Binding(s.value)));
});
test('selection cannot turn unsupported OAuth into an API key or accept credential/endpoint authority from HTTP data',t=>{
 const {settings:s,path}=settings(t),before=readFileSync(path,'utf8');
 for(const [input,code] of [
  [{provider:'openai',authentication:'oauth',model:'owner-model',confirmed:true},'PLANNER1_OFFICIAL_AUTH_UNAVAILABLE'],
  [{provider:'deepseek',authentication:'api_key',model:'owner-model',confirmed:false},'PLANNER1_SELECTION_CONFIRMATION_REQUIRED'],
  [{provider:'openai',authentication:'api_key',model:'owner-model',confirmed:true,baseUrl:'http://127.0.0.1:1'},'PLANNER1_SELECTION_FIELDS_INVALID'],
  [{provider:'openai',authentication:'api_key',model:'owner-model',confirmed:true,apiKey:'SYNTHETIC_NOT_A_CREDENTIAL'},'PLANNER1_SELECTION_FIELDS_INVALID'],
  [{provider:'local',authentication:'api_key',model:'qwen2.5:7b',confirmed:true},'PLANNER1_OFFICIAL_AUTH_UNAVAILABLE'],
  [{provider:'local',authentication:'none',model:'qwen2.5:7b',confirmed:true,baseUrl:'http://127.0.0.1:11434/v1'},'PLANNER1_SELECTION_FIELDS_INVALID'],
  [{provider:'openai',authentication:'api_key',model:'sk-SYNTHETIC_MODEL_KEY',confirmed:true},'PLANNER1_SELECTION_CONTAINS_SECRET']]){
  assert.throws(()=>s.selectPlanner1(input),{code});assert.equal(readFileSync(path,'utf8'),before);assert.equal(s.value.planner1.provider,'kimi');
 }
});
test('ordinary API settings cannot change a v2 provider, credential source, or API authentication kind',t=>{
 const {settings:s,path}=settings(t);s.selectPlanner1({provider:'openai',authentication:'api_key',model:'owner-model',confirmed:true});const before=readFileSync(path,'utf8');
 for(const patch of [{provider:'deepseek',protocol:'chat-completions',model:'owner-model'},{provider:'openai',protocol:'chat-completions',model:'owner-model'},{provider:'openai',authMode:'siwc_plan',protocol:'openai-responses',model:'owner-model'},{provider:'local',authMode:'api_key',protocol:'chat-completions',model:'qwen2.5:7b'}]){
  assert.throws(()=>s.updateUI({planner1:patch}));assert.equal(readFileSync(path,'utf8'),before);
 }
});
test('legacy retired bindings are never promoted by loading a file or ordinary settings edits',t=>{
 const h=harness(t),path=join(h.dir,'legacy-api.json');writeFileSync(path,JSON.stringify(defaults));const s=new Settings(path);
 assert.throws(()=>assertPlanner1DispatchAllowed(planner1Binding(s.value)),{code:'PLANNER1_PROVIDER_RETIRED'});
 s.updateUI({planner1:{protocol:'openai-responses',model:'legacy-model'}});assert.equal(s.value.planner1.bindingVersion,1);assert.equal(s.public().planner1Retired,true);
});
