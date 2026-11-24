// Actual localhost/SQLite + real NativeOwner metadata path. Synthetic value, no project/model.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {NativeOwner} from '../../dist/server/native-owner.js';import {root} from '../helpers.mjs';
import {request as httpRequest} from 'node:http';
const keyValue='DM_SYNTHETIC_SOURCE_HTTP_VALUE_NOT_REAL';
for(const product of ['dream-maker','dreamflow'])test(product+' registers a source before any project through original auth, confirmation and idempotency',{timeout:30000},async()=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'registered-source-http-'));let reads=0,modelCalls=0;
 const app=await createApp({root,data,configPath:join(data,'config.json'),product,port:0,paidRequestGuard:()=>{modelCalls++;throw Error('NO_MODEL');},nativeOwnerBuilder:ctx=>new NativeOwner({...ctx,root:data,getSecret:()=>{reads++;return keyValue;}})});
 try{
  assert.equal((await fetch(app.origin+'/api/account-sources')).status,401);
  const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const get=async()=>{const response=await fetch(app.origin+'/api/account-sources',{headers:{cookie}});return{status:response.status,body:await response.json()};};
  const request={sourceId:'CONTROLLER_DSH_SESSION',label:'我的专用模型来源',confirmed:true},post=(body=request,extra={})=>new Promise((resolve,reject)=>{
   // Send exact headers: the Fetch implementation rewrites Host to the destination.
   const wire=JSON.stringify(body),req=httpRequest(app.origin+'/api/account-sources',{method:'POST',headers:{cookie,'content-type':'application/json','content-length':Buffer.byteLength(wire),'x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...extra}},res=>{let bytes='';res.setEncoding('utf8');res.on('data',chunk=>bytes+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(bytes)});}catch(e){reject(e);}});});req.on('error',reject);req.end(wire);
  });
  const first=await get();assert.equal(first.status,200);assert.equal(first.body.sources.length,0);assert.equal(first.body.choices[0].accountVerified,false);assert.equal(reads,0);
  assert.equal((await post(request,{'x-csrf-token':'wrong'})).status,403);assert.equal((await post({...request,confirmed:false})).status,403);assert.equal((await post({...request,key:keyValue})).status,400);assert.equal(reads,0);
  const unusedName='DM_CUSTOM_UNUSED_API_KEY',previous=process.env[unusedName];process.env[unusedName]='CUSTOM_ACCOUNT_SOURCE_CONSENT_REQUIRED';
  try{
   const refused=await post({...request,confirmed:false});assert.equal(refused.status,403);assert.equal(refused.body.message.includes('[REDACTED]'),false,'refusing consent must not inspect unrelated environment values');
   for(const [code,headers] of [['ORIGIN_DENIED',{origin:'http://untrusted.invalid'}],['HOST_DENIED',{host:'untrusted.invalid'}],['CROSS_ORIGIN_DENIED',{'sec-fetch-site':'cross-site'}]]){
    process.env[unusedName]=code;const early=await post(request,headers);assert.equal(early.status,403);assert.equal(early.body.message.includes('[REDACTED]'),false,'early rejection must not inspect unrelated environment values');
   }
  }finally{if(previous===undefined)delete process.env[unusedName];else process.env[unusedName]=previous;}
  const id=crypto.randomUUID(),saved=await post(request,{'idempotency-key':id});assert.equal(saved.status,200);assert.equal(saved.body.source.status,'SELECTED_UNVERIFIED');assert.equal(saved.body.source.executionGranted,false);
  assert.deepEqual((await post(request,{'idempotency-key':id})).body,saved.body);assert.equal((await post({...request,label:'另一个请求'},{'idempotency-key':id})).status,409);
  const sources=await get();assert.equal(sources.body.sources.length,1);assert.deepEqual(sources.body.sources[0],saved.body.source);assert.equal(app.store.db.prepare("SELECT count(*) n FROM records WHERE kind='CustomAccountSourceRegistered'").get().n,1);
  const beforeReads=reads,identities=await fetch(app.origin+'/api/account-sources?identities=1',{headers:{cookie}});
  if(product==='dreamflow'){
   assert.equal(identities.status,200);const {authRef,accountRef,provider,authentication}=saved.body.source;
   assert.deepEqual(await identities.json(),{sources:[{authRef,accountRef,provider,authentication}]});
  }else assert.equal(identities.status,404);
  assert.equal(reads,beforeReads);
  const records=JSON.stringify(app.store.db.prepare('SELECT data FROM records').all());assert.equal(records.includes(keyValue),false);assert.equal(records.includes('DEEPSEEK_API_KEY'),false);assert.equal(app.store.projects().length,0);assert.equal(app.store.runs().length,0);assert.equal(modelCalls,0);
 }finally{await app.close();rmSync(data,{recursive:true,force:true});}
});
