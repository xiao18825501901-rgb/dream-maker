// Actual original local HTTP/session boundary, explicit read-only Engine substitute. NOT Native evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {defaults} from '../../dist/server/config.js';import {root} from '../helpers.mjs';
test('documentation candidate uses original authentication, one exact query and no execution endpoint',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'documentation-correction-http-')),configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 let models=0,reads=0;const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{models++;throw Error('MODEL_FORBIDDEN');}});t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const path=app.origin+'/api/runs/OFFLINE_RUN/documentation-correction',url=path+'?file=README.md';assert.equal((await fetch(url)).status,401);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 app.engine.documentationCorrectionCandidate=(rid,file)=>{reads++;assert.equal(rid,'OFFLINE_RUN');assert.equal(file,'README.md');return {schema:'OFFLINE_READONLY_PROTOCOL_RESPONSE',writePaths:[file],executionGranted:false,roleQualification:'NOT_CHECKED_BY_CANDIDATE'};};
 const valid=await fetch(url,{headers:{cookie}});assert.equal(valid.status,200);assert.equal((await valid.json()).candidate.executionGranted,false);assert.equal(reads,1);
 for(const suffix of ['','?file=README.md&file=other.md','?file=README.md&confirmed=true','?file=README.md&budget=999'])assert.equal((await fetch(path+suffix,{headers:{cookie}})).status,400);
 assert.equal(reads,1);assert.equal((await fetch(url,{method:'POST',headers:{cookie,origin:app.origin,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({confirmed:true})})).status,404);
 assert.equal(reads,1);assert.equal(models,0);assert.equal(app.store.runs().length,0);assert.equal(app.store.db.prepare("SELECT count(*) n FROM records WHERE kind LIKE '%Approval'").get().n,0);
});

test('source custody preparation requires original login, CSRF, confirmation and exact metadata, without exposing execution',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'documentation-custody-http-')),configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 let models=0,copies=0;const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{models++;throw Error('MODEL_FORBIDDEN');}});t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const path=app.origin+'/api/runs/OFFLINE_RUN/documentation-correction/prepare',input={confirmed:true,file:'README.md',candidateHash:'a'.repeat(64)};
 assert.equal((await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status,401);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 app.engine.prepareDocumentationCorrection=async(rid,body,actor)=>{copies++;assert.equal(rid,'OFFLINE_RUN');assert.deepEqual(body,input);assert.match(actor,/^local-session:[a-f0-9]{64}$/);return {scope:'SOURCE_CUSTODY_ONLY',executionGranted:false,modelDispatched:false,additionalCallsGranted:0};};
 const send=(body=input,headers={},suffix='')=>fetch(path+suffix,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 assert.equal((await send(input,{'x-csrf-token':'WRONG'})).status,403);
 assert.equal((await send({...input,confirmed:false})).status,403);assert.equal((await send({...input,additionalCalls:99})).status,400);
 assert.equal((await send(input,{},'?confirmed=true')).status,400);assert.equal(copies,0);
 const result=await send();assert.equal(result.status,200);assert.equal((await result.json()).additionalCallsGranted,0);assert.equal(copies,1);assert.equal(models,0);assert.equal(app.store.runs().length,0);
});
