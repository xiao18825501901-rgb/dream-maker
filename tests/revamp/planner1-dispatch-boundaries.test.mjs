// Adversarial local controller seams. All providers are explicit stubs; no Live/OAuth evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Interviews} from '../../dist/server/interview.js';
import {createNativeOwner} from '../../dist/server/native-owner.js';
import {DomainError} from '../../dist/server/security.js';
import {harness} from '../helpers.mjs';
function apiConfig(h){Object.assign(h.config.planner1,{provider:'openai',bindingVersion:2,authMode:'api_key',model:'offline-model',baseUrl:'https://api.openai.com/v1',protocol:'openai-responses'});h.config.kimi.enabled=true;}
test('an enabled saved Kimi integration cannot capture an explicitly selected API interview',async t=>{
 let interviews;t.after(()=>interviews?.close());const h=harness(t);apiConfig(h);let api=0,kimi=0;
 interviews=new Interviews(h.store,{complete:async()=>{api++;return{data:{ok:true},usage:{role:'planner1',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN',requestId:'OFFLINE_API_STUB'}};}},h.laya,()=>h.config);
 interviews.askKimi=async()=>{kimi++;throw Error('SAVED_KIMI_MUST_NOT_CAPTURE_API');};
 const p=interviews.create('离线角色边界','固定测试，不执行真实模型。','live');const result=await interviews.askModelInternal(p.id,{task:'offline-boundary'});
 assert.deepEqual(result,{ok:true});assert.equal(api,1);assert.equal(kimi,0);assert.equal(h.config.kimi.enabled,true);
});
test('the API probe must pass the same Native readiness gate before reaching a provider',async t=>{
 let owner;t.after(()=>owner?.close());const h=harness(t);apiConfig(h);owner=createNativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config});let readiness=0,provider=0;
 owner.assertReady=()=>{readiness++;throw new DomainError('OFFLINE_AUDIT_REQUIRED',409);};
 const model={probe:async()=>{provider++;throw new DomainError('OFFLINE_PROVIDER_REACHED',500);}};
 await assert.rejects(owner.probeTurn('planner1','OFFLINE_NONCE',new AbortController().signal,model,{summary:()=>({phase:'PROBE'})},h.config),{code:'OFFLINE_AUDIT_REQUIRED'});
 assert.equal(readiness,1);assert.equal(provider,0);
});
