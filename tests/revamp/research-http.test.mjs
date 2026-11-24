import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../../dist/server/http.js';
import { defaults } from '../../dist/server/config.js';
import { bindKimi,root } from '../helpers.mjs';
async function web(t){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'research-http-'));
 const configPath=resolve(data,'config.json');writeFileSync(configPath,JSON.stringify(bindKimi(structuredClone(defaults))));
 let requests=0;const app=await createApp({root,data,configPath,port:0,researchTransport:async url=>{requests++;return Response.json(new URL(url).hostname==='api.github.com'?{items:[],incomplete_results:false}:[]);}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,extra={})=>{
  const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...extra},body:body?JSON.stringify(body):undefined});
  return{status:response.status,body:await response.json()};
 };
 return{app,call,requests:()=>requests,cookie};
}
test('real HTTP research binds session consent, keeps CSRF, and does not run models or source code',async t=>{
 const w=await web(t);const made=await w.call('/projects',{name:'本地公开检索测试',idea:'这段原始描述不能出现在外部请求。',mode:'live',kimiConsent:true,publicResearch:true,actor:'FORGED_ACTOR'});
 assert.equal(made.status,200);const p=made.body.project;
 assert.match(p.publicResearch.actor,/^local-session:[a-f0-9]{64}$/);
 assert.notEqual(p.publicResearch.actor,'FORGED_ACTOR');
 assert.equal((await fetch(w.app.origin+`/api/projects/${p.id}/research`)).status,401);
 assert.equal((await w.call(`/projects/${p.id}/research`,{keywords:['notes'],version:p.version},{'x-csrf-token':'wrong'})).status,403);
 const started=await w.call(`/projects/${p.id}/research`,{keywords:['notes'],version:p.version,disclosure:{kind:'FRAUD'}});
 assert.equal(started.status,200);await w.app.projectResearch.settled(started.body.id);
 const saved=await w.call(`/projects/${p.id}/research`);
 assert.equal(saved.body.operations[0].status,'COMPLETED');assert.equal(saved.body.operations[0].result.executedSourceCode,false);assert.equal(w.requests(),2);
 assert.equal(w.app.store.records(p.id,'ModelAttempt').length,0);assert.equal(w.app.store.runs(p.id).length,0);
 assert.equal((await w.call(`/projects/${p.id}/research/${started.body.id}/sources/`+'a'.repeat(64))).status,404);
});
test('client disclosure cannot authorize an old project; authenticated permission binds a new input version',async t=>{
 const w=await web(t);const made=await w.call('/projects',{name:'同意边界',idea:'小工具',mode:'live',kimiConsent:true});const p=made.body.project;
 assert.equal((await w.call(`/projects/${p.id}/research`,{keywords:['notes'],version:p.version,publicResearch:true,disclosure:{kind:'PUBLIC_GENERIC_TERMS_ONLY'}})).status,403);
 assert.equal(w.requests(),0);
 const allowed=await w.call(`/projects/${p.id}/research-permission`,{enabled:true,version:p.version,actor:'MODEL'});
 assert.equal(allowed.status,200);assert.notEqual(allowed.body.project.publicResearch.actor,'MODEL');
 assert.equal((await w.call(`/projects/${p.id}/research`,{keywords:['notes'],version:p.version})).status,409);
 assert.equal((await w.call(`/projects/${p.id}/research`,{keywords:['private code name'],version:allowed.body.project.version})).status,403);assert.equal(w.requests(),0);
});
