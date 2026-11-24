// Local HTTP and a synthetic Magpie /v1/models only. No model request, no paid route.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {defaults} from '../../dist/server/config.js';
import {root} from '../helpers.mjs';

async function fixture(t,{product='dream-maker',magpiePort}={}){
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'p1-models-http-'));writeFileSync(join(data,'config.json'),JSON.stringify(structuredClone(defaults)));
 let modelCalls=0;
 const app=await createApp({root,data,configPath:join(data,'config.json'),product,port:0,desktopMagpieCatalogPort:magpiePort,paidRequestGuard:()=>{modelCalls++;throw Error('NO_MODEL_ALLOWED');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const get=async path=>{const response=await fetch(app.origin+'/api'+path,{headers:{cookie}});return {status:response.status,body:await response.json()};};
 const post=async(path,body)=>{const response=await fetch(app.origin+'/api'+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 return {app,get,post,calls:()=>modelCalls};
}

async function magpie(t,payload){
 const server=createServer((request,response)=>{
  if(request.url!=='/v1/models'){response.writeHead(404,{'content-type':'application/json'});response.end('{}');return;}
  response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(payload));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return server.address().port;
}

const catalog={object:'list',data:[
 {object:'model',id:'packyapi/deepseek-flash',owned_by:'packyapi',native_endpoints:['/v1/chat/completions']},
 {object:'model',id:'packyapi/claude-sonnet-5',owned_by:'packyapi',native_endpoints:['/v1/messages']},
 {object:'model',id:'deepseek/deepseek-flash',owned_by:'deepseek',native_endpoints:['/v1/chat/completions','/v1/responses']},
 {object:'model',id:'other/model',owned_by:'other',native_endpoints:['/v1/chat/completions']}
]};
const shape=['available','context','id','label','notes','output'];

test('classic catalog lists only registered official names and never calls a model',async t=>{
 const x=await fixture(t);
 const deep=await x.get('/planner1/models?provider=deepseek');
 assert.equal(deep.status,200);assert.equal(deep.body.schema,'dream-maker.planner1-models.v1');assert.equal(deep.body.source,'classic');assert.equal(deep.body.provider,'deepseek');
 assert.deepEqual(deep.body.models.map(model=>model.id),['deepseek-flash','deepseek-v4-pro']);
 for(const model of deep.body.models)assert.deepEqual(Object.keys(model).sort(),shape);
 assert.equal(deep.body.models[0].context,1048576);assert.equal(deep.body.models.every(model=>model.available),true);
 const open=await x.get('/planner1/models?provider=openai');
 assert.equal(open.status,200);assert.equal(open.body.source,'classic');assert.deepEqual(open.body.models.map(model=>model.id),['gpt-6-luna']);assert.equal(open.body.models[0].context,272000);
 assert.equal(x.calls(),0);assert.equal(x.app.store.projects().length,0);assert.equal(x.app.store.runs().length,0);
});

test('custom catalog filters the local Magpie owned_by prefix and marks wire availability',async t=>{
 const port=await magpie(t,catalog),x=await fixture(t,{magpiePort:port});
 const pack=await x.get('/planner1/models?provider=packyapi&source=custom');
 assert.equal(pack.status,200);assert.equal(pack.body.source,'custom');assert.deepEqual(pack.body.models.map(model=>model.id),['packyapi/deepseek-flash','packyapi/claude-sonnet-5']);
 assert.deepEqual(pack.body.models.map(model=>model.available),[true,false]);assert.match(pack.body.models[1].notes,/未声明/);
 const deep=await x.get('/planner1/models?provider=deepseek&source=custom');
 assert.equal(deep.status,200);assert.equal(deep.body.source,'custom');assert.deepEqual(deep.body.models.map(model=>model.id),['deepseek/deepseek-flash']);
 assert.equal(deep.body.models[0].available,true);assert.match(deep.body.models[0].notes,/chat-completions/);
 assert.equal(x.calls(),0);
});

test('unknown, missing and malformed providers are rejected instead of becoming an empty catalog',async t=>{
 const x=await fixture(t);
 const unknown=await x.get('/planner1/models?provider=unknown&source=classic');assert.equal(unknown.status,400);assert.equal(unknown.body.error,'PLANNER1_MODEL_PROVIDER_UNKNOWN');
 const missing=await x.get('/planner1/models');assert.equal(missing.status,400);assert.equal(missing.body.error,'PLANNER1_MODEL_QUERY_INVALID');
 const malformed=await x.get('/planner1/models?provider=..%2Fsecret&source=custom');assert.equal(malformed.status,400);assert.equal(malformed.body.error,'PLANNER1_MODEL_PROVIDER_INVALID');
 const source=await x.get('/planner1/models?provider=deepseek&source=local');assert.equal(source.status,400);assert.equal(source.body.error,'PLANNER1_MODEL_SOURCE_INVALID');
 const duplicate=await x.get('/planner1/models?provider=deepseek&provider=openai');assert.equal(duplicate.status,400);assert.equal(duplicate.body.error,'PLANNER1_MODEL_QUERY_INVALID');
});

test('an unreachable Magpie keeps its real error and never returns an empty list',async t=>{
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const x=await fixture(t,{magpiePort:port});
 const response=await x.get('/planner1/models?provider=packyapi&source=custom');
 assert.equal(response.status,503);assert.equal(response.body.error,'CUSTOM_MAGPIE_CATALOG_UNAVAILABLE');assert.equal(response.body.models,undefined);
});

test('a saved Seeker selection becomes a v2 binding without any inference request',async t=>{
 const x=await fixture(t);
 const before=await x.get('/config');assert.equal(before.body.planner1Binding.bindingVersion,1);assert.equal(before.body.planner1Retired,true);
 const selected=await x.post('/planner1/selection',{provider:'deepseek',authentication:'api_key',model:'deepseek-flash',confirmed:true});
 assert.equal(selected.status,200);assert.equal(selected.body.planner1Binding.bindingVersion,2);assert.equal(selected.body.planner1Binding.provider,'deepseek');assert.equal(selected.body.planner1Binding.model,'deepseek-flash');
 const after=await x.get('/config');assert.equal(after.body.planner1Binding.bindingVersion,2);assert.equal(after.body.planner1Retired,false);
 assert.equal(x.calls(),0);assert.equal(x.app.store.projects().length,0);
});
