// Actual local HTTP auth/CSRF; explicit Engine substitute, no formal database or model.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {defaults} from '../../dist/server/config.js';import {root} from '../helpers.mjs';
test('bounded successor preparation requires explicit owner confirmation and null duration without accepting caller limits',async t=>{
 const dir=join(root,'.runtime/test-temp');mkdirSync(dir,{recursive:true});const data=mkdtempSync(join(dir,'doc-continuation-http-')),configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 let models=0,preparations=0;const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{models++;throw Error('MODEL_FORBIDDEN');}});t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const url=app.origin+'/api/runs/OFFLINE_PARENT/documentation-correction/continue',input={confirmed:true,file:'README.md',candidateHash:'a'.repeat(64),taskDeadline:null};
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status,401);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 app.engine.approveDocumentationContinuation=async(rid,body,actor)=>{preparations++;assert.equal(rid,'OFFLINE_PARENT');assert.deepEqual(body,input);assert.match(actor,/^local-session:[a-f0-9]{64}$/);return {id:'OFFLINE_CHILD',state:'PAUSED',phase:'IMPLEMENTING',version:1,treeHash:'b'.repeat(64),calls:0,maxCalls:2,repairCount:0,maxRepairs:1,documentationContinuation:{recordId:'OFFLINE_APPROVAL',sha256:'c'.repeat(64)}};};
 const send=(body=input,headers={},suffix='')=>fetch(url+suffix,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 assert.equal((await send(input,{'x-csrf-token':'WRONG'})).status,403);assert.equal((await send({...input,confirmed:false})).status,403);
 for(const body of [{...input,maxCalls:99},{...input,taskDeadline:3600},{confirmed:true,file:'README.md',candidateHash:input.candidateHash}])assert.equal((await send(body)).status,400);
 assert.equal((await send(input,{},'?maxCalls=99')).status,400);assert.equal(preparations,0);
 const response=await send();assert.equal(response.status,200);const result=await response.json();assert.equal(result.runId,'OFFLINE_CHILD');assert.equal(result.state,'PAUSED');assert.equal(result.maxCalls,2);assert.equal(result.executionStartedByPreparation,false);assert.equal(result.taskDeadline,null);assert.equal(models,0);assert.equal(preparations,1);assert.ok(JSON.stringify(result).length<2048);assert.equal(app.store.runs().length,0);
});
