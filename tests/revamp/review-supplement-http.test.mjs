// Real local auth/CSRF/idempotency, explicit Engine substitute. No model or formal data.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {defaults} from '../../dist/server/config.js';import {root} from '../helpers.mjs';
test('supplement candidate and approval use original authentication, strict fields and one idempotent compact response',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'review-supplement-http-')),configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const url=app.origin+'/api/runs/OFFLINE_RUN/review-supplement';assert.equal((await fetch(url)).status,401);
 const session=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();
 const input={confirmed:true,sourceHash:'a'.repeat(64),packetHash:'b'.repeat(64),expectedVersion:79,previousReviewRecordId:'OFFLINE_REVIEW'};let calls=0;
 app.engine.reviewSupplementCandidate=()=>({...input,modelDispatched:false,additionalCalls:1});
 app.engine.approveReviewSupplement=async(...args)=>{calls++;assert.deepEqual(args.slice(0,2),['OFFLINE_RUN',input]);assert.match(args[2],/^local-session:[a-f0-9]{64}$/);return {id:'OFFLINE_RUN',state:'PAUSED',version:80,treeHash:input.sourceHash,calls:13,maxCalls:13,reviewSupplement:{recordId:'OFFLINE_APPROVAL',sha256:'c'.repeat(64)}};};
 assert.equal((await fetch(url,{headers:{cookie}})).status,200);
 const key=crypto.randomUUID(),send=(body,headers={})=>fetch(url,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 assert.equal((await send(input,{'x-csrf-token':'WRONG'})).status,403);assert.equal((await send({...input,confirmed:false})).status,403);assert.equal((await send({...input,additionalCalls:99})).status,400);assert.equal(calls,0);
 const first=await send(input,{'idempotency-key':key});assert.equal(first.status,200);const result=await first.json();assert.equal(result.runId,'OFFLINE_RUN');assert.equal(result.modelDispatched,false);assert.ok(JSON.stringify(result).length<2048);
 const replay=await send(input,{'idempotency-key':key});assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);assert.equal(calls,1);assert.equal(app.store.runs().length,0);
});
