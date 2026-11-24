// OFFLINE metadata only; no shared Magpie, credentials, model or dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCustomAccountSources,observeCustomAccountSources} from '../../dist/server/custom-account-sources.js';
const source=()=>({provider:'string',authentication:'api_key',authRef:'string-auth',accountRef:'string-account',secretEnv:'DM_CUSTOM_STRING_API_KEY',models:['claude-sonnet-5'],endpoint:{protocol:'anthropic-messages',baseUrl:'https://gateway.example.test/anthropic'}});
const manifest=a=>({schema:'dream-maker.custom-account-sources.v1',accounts:[a]});
const snapshot=()=>({projectId:'synthetic',accounts:[{provider:'string',authentication:'api_key',authRef:'string-auth',accountRef:'string-account'}],roles:{planner2:{authRef:'string-auth',transport:'magpie',model:{kind:'model',id:'claude-sonnet-5'}},executors:[],reviewer:{authRef:'string-auth',transport:'magpie',model:{kind:'model',id:'claude-sonnet-5'}}},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]}});
test('string requires an explicit private endpoint and models; observation is availability only',()=>{
 const a=source(),s=snapshot();assert.deepEqual(resolveCustomAccountSources(s,manifest(a),'DEEPSEEK_API_KEY'),[a]);
 const reads=[],view=observeCustomAccountSources(s,manifest(a),'a'.repeat(64),'DEEPSEEK_API_KEY',name=>{reads.push(name);return 'DM_SYNTHETIC_STRING_CANARY';});
 assert.deepEqual(reads,['DM_CUSTOM_STRING_API_KEY']);assert.equal(view.accounts[0].status,'AVAILABLE_UNVERIFIED');
 for(const k of ['accountVerified','modelVerified','runtimeStarted','executionGranted'])assert.equal(view[k],false);
 const text=JSON.stringify(view);for(const hidden of ['gateway.example.test','DM_CUSTOM_STRING_API_KEY','DM_SYNTHETIC_STRING_CANARY'])assert.equal(text.includes(hidden),false);
});
test('bad or missing string endpoints fail before secret lookup',()=>{
 for(const endpoint of [undefined,{protocol:'chat-completions',baseUrl:'https://gateway.example.test'},{protocol:'anthropic-messages',baseUrl:'http://gateway.example.test'},{protocol:'anthropic-messages',baseUrl:'https://u:p@gateway.example.test'},{protocol:'anthropic-messages',baseUrl:'https://gateway.example.test?key=secret'},{protocol:'anthropic-messages',baseUrl:'https://127.0.0.1'},{protocol:'anthropic-messages',baseUrl:'https://localhost'},{protocol:'anthropic-messages',baseUrl:'https://gateway.example.test',token:'forbidden'}]){
  const a=source();if(endpoint===undefined)delete a.endpoint;else a.endpoint=endpoint;let reads=0;
  assert.throws(()=>observeCustomAccountSources(snapshot(),manifest(a),null,'DEEPSEEK_API_KEY',()=>{reads++;return 'DM_SYNTHETIC';}),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});assert.equal(reads,0);
 }
});
test('string cannot borrow DSH credentials or omit its explicit model list',()=>{
 for(const patch of [{secretEnv:'DEEPSEEK_API_KEY'},{models:undefined},{models:['gpt-6-luna']},{models:['claude-sonnet-5'],model:'gpt-6-luna'}]){
  const a={...source(),...patch};if(a.models===undefined)delete a.models;
  assert.throws(()=>resolveCustomAccountSources(snapshot(),manifest(a),'DEEPSEEK_API_KEY'),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
 }
});
test('DeepSeek cannot replace its fixed endpoints using the string endpoint field',()=>{
 assert.throws(()=>resolveCustomAccountSources(snapshot(),manifest({...source(),provider:'deepseek-official',models:['deepseek-flash']}),'DEEPSEEK_API_KEY'),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
});
test('string cannot reuse a DSH key even when its variable has the Custom prefix',()=>{
 assert.throws(()=>resolveCustomAccountSources(snapshot(),manifest(source()),'DM_CUSTOM_STRING_API_KEY'),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
});
