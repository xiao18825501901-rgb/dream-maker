// Actual local HTTP, explicit controller spy only; no model, native proof or formal database.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {defaults} from '../../dist/server/config.js';
import {DomainError} from '../../dist/server/security.js';import {root} from '../helpers.mjs';
test('pre-turn review recovery retains authentication, CSRF and explicit confirmation before Engine',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'review-retry-http-'));
 const configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();let calls=[];
 app.engine.prepareReviewRetry=async(...args)=>{calls.push(args);throw new DomainError('OFFLINE_RECOVERY_GATE_STOP',409);};
 const send=(body,headers={})=>fetch(app.origin+'/api/runs/OFFLINE_RUN/prepare-review',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 assert.equal((await send({confirmed:true,packetHash:'a'.repeat(64)},{'x-csrf-token':'wrong'})).status,403);
 assert.equal((await send({confirmed:false,packetHash:'a'.repeat(64)})).status,403);assert.equal(calls.length,0);
 const response=await send({confirmed:true,packetHash:'a'.repeat(64)});assert.equal(response.status,409);
 assert.equal((await response.json()).error,'OFFLINE_RECOVERY_GATE_STOP');assert.equal(calls.length,1);
 assert.deepEqual(calls[0].slice(0,2),['OFFLINE_RUN','a'.repeat(64)]);assert.match(calls[0][2],/^local-session:[a-f0-9]{64}$/);
 assert.equal(app.store.runs().length,0);assert.equal(app.store.projects().length,0);
});

test('interrupted Codex recovery accepts only authenticated confirmed source/version, never caller history proof',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'review-interrupted-http-'));
 const configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json(),calls=[];
 app.engine.prepareInterruptedReview=async(...args)=>{calls.push(args);throw new DomainError('OFFLINE_INTERRUPTED_GATE_STOP',409);};
 const input={confirmed:true,bindingKind:'INTERRUPTED_CODEX',sourceHash:'a'.repeat(64),expectedVersion:7};
 const send=(body,headers={})=>fetch(app.origin+'/api/runs/OFFLINE_RUN/prepare-review',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 assert.equal((await send(input,{cookie:''})).status,401);
 assert.equal((await send(input,{'x-csrf-token':'wrong'})).status,403);
 assert.equal((await send({...input,confirmed:false})).status,403);
 for(const key of ['threadId','proof','contextPath','packetHash'])assert.equal((await send({...input,[key]:'untrusted'})).status,400);
 assert.equal((await send({...input,expectedVersion:0})).status,400);assert.equal(calls.length,0);
 const response=await send(input);assert.equal((await response.json()).error,'OFFLINE_INTERRUPTED_GATE_STOP');
 assert.deepEqual(calls[0].slice(0,3),['OFFLINE_RUN',input.sourceHash,7]);assert.match(calls[0][3],/^local-session:[a-f0-9]{64}$/);
 assert.equal(app.store.runs().length,0);assert.equal(app.store.projects().length,0);
});

test('new zero-dispatch HTTP preparation binds version/source and keeps explicit confirmation',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'review-source-http-'));
 const configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();const calls=[];
 app.engine.prepareUndispatchedReviewRetry=async(...args)=>{calls.push(args);throw new DomainError('OFFLINE_SOURCE_GATE_STOP',409);};
 const send=body=>fetch(app.origin+'/api/runs/OFFLINE_RUN/prepare-review',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)});
 const input={confirmed:true,bindingKind:'SOURCE_VERSION',sourceHash:'a'.repeat(64),expectedVersion:7};
 assert.equal((await send({...input,confirmed:false})).status,403);assert.equal(calls.length,0);
 const response=await send(input);assert.equal((await response.json()).error,'OFFLINE_SOURCE_GATE_STOP');assert.deepEqual(calls[0].slice(0,3),['OFFLINE_RUN','a'.repeat(64),7]);
 assert.equal((await send({...input,bindingKind:'UNKNOWN'})).status,400);
 assert.equal((await send({...input,packetHash:'b'.repeat(64)})).status,400);
 assert.equal(calls.length,1);assert.equal(app.store.runs().length,0);
});

test('partial repair preparation retains original authentication and cannot accept supplied completion proof',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'partial-repair-http-'));
 const configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json(),calls=[];
 app.engine.preparePartialRepair=async(...args)=>{calls.push(args);throw new DomainError('OFFLINE_PARTIAL_GATE_STOP',409);};
 const input={confirmed:true,sourceHash:'a'.repeat(64),expectedVersion:7};const send=(body,headers={})=>fetch(app.origin+'/api/runs/OFFLINE_RUN/prepare-repair',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 assert.equal((await send(input,{cookie:''})).status,401);assert.equal((await send(input,{'x-csrf-token':'wrong'})).status,403);assert.equal((await send({...input,confirmed:false})).status,403);
 for(const k of ['proof','maxRepairs','completed','threadId'])assert.equal((await send({...input,[k]:true})).status,400);
 assert.equal(calls.length,0);const response=await send(input);assert.equal((await response.json()).error,'OFFLINE_PARTIAL_GATE_STOP');assert.deepEqual(calls[0].slice(0,2),['OFFLINE_RUN',input]);assert.match(calls[0][2],/^local-session:[a-f0-9]{64}$/);
 assert.equal(app.store.runs().length,0);
});
test('review-only window requires local confirmation, CSRF and bounded exact fields',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'review-only-window-http-')),configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json(),calls=[];
 app.engine.approveReviewOnlyWindow=async(...args)=>{calls.push(args);throw new DomainError('OFFLINE_REVIEW_ONLY_STOP',409);};
 const input={confirmed:true,sourceHash:'a'.repeat(64),expectedVersion:7,seconds:3600};const send=(body,headers={})=>fetch(app.origin+'/api/runs/OFFLINE_RUN/review-only-window',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 assert.equal((await send(input,{cookie:''})).status,401);assert.equal((await send(input,{'x-csrf-token':'wrong'})).status,403);assert.equal((await send({...input,confirmed:false})).status,403);assert.equal((await send({...input,seconds:3601})).status,400);assert.equal((await send({...input,proof:{}})).status,400);assert.equal(calls.length,0);
 const response=await send(input);assert.equal((await response.json()).error,'OFFLINE_REVIEW_ONLY_STOP');assert.deepEqual(calls[0].slice(0,2),['OFFLINE_RUN',input]);assert.match(calls[0][2],/^local-session:[a-f0-9]{64}$/);assert.equal(app.store.runs().length,0);
 const unlimited={...input,seconds:null};assert.equal((await (await send(unlimited)).json()).error,'OFFLINE_REVIEW_ONLY_STOP');assert.deepEqual(calls[1][1],unlimited);
 const missing={...input};delete missing.seconds;assert.equal((await send(missing)).status,400);assert.equal(calls.length,2);
});

test('transport-only retry retains original HTTP confirmation and rejects supplied proof/path/session',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'review-transport-http-')),configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json(),calls=[];
 app.engine.prepareReviewTransportRetry=async(...args)=>{calls.push(args);throw new DomainError('OFFLINE_TRANSPORT_GATE',409);};
 const input={confirmed:true,bindingKind:'TRANSPORT_VERSION',sourceHash:'a'.repeat(64),expectedVersion:7},send=(body,headers={})=>fetch(app.origin+'/api/runs/OFFLINE_RUN/prepare-review',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 assert.equal((await send(input,{cookie:''})).status,401);assert.equal((await send(input,{'x-csrf-token':'wrong'})).status,403);assert.equal((await send({...input,confirmed:false})).status,403);
 for(const key of ['proof','threadId','contextPath','packetHash'])assert.equal((await send({...input,[key]:'UNTRUSTED'})).status,400);assert.equal(calls.length,0);
 const response=await send(input);assert.equal((await response.json()).error,'OFFLINE_TRANSPORT_GATE');assert.deepEqual(calls[0].slice(0,2),['OFFLINE_RUN',{confirmed:true,sourceHash:input.sourceHash,expectedVersion:7}]);assert.match(calls[0][2],/^local-session:[a-f0-9]{64}$/);assert.equal(app.store.runs().length,0);
});

test('M126 no-turn review recovery keeps original HTTP auth, exact binding and explicit consent',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
 const data=mkdtempSync(join(parent,'review-usage-recovery-http-')),configPath=join(data,'config.json');
 writeFileSync(configPath,JSON.stringify(defaults));
 const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json(),calls=[];
 app.engine.recoverBoundedCodeReviewUsage=async(...args)=>{
  calls.push(args);
  throw new DomainError('OFFLINE_REVIEW_USAGE_RECOVERY_GATE_STOP',409);
 };
 const input={
  confirmed:true,
  expectedVersion:14,
  sourceHash:'a'.repeat(64),
  verificationEvidenceId:'rec_verification',
  reviewPacketId:'rec_review_packet',
  ownerDecisionHash:'b'.repeat(64),
 };
 const endpoint=app.origin+'/api/runs/OFFLINE_RUN/bounded-code-repair/recover-review';
 const send=(body=input,headers={},query='')=>fetch(endpoint+query,{
  method:'POST',
  headers:{
   cookie,
   'content-type':'application/json',
   'x-csrf-token':csrf,
   'idempotency-key':crypto.randomUUID(),
   ...headers,
  },
  body:JSON.stringify(body),
 });
 assert.equal((await send(input,{cookie:''})).status,401);
 assert.equal((await send(input,{'x-csrf-token':'wrong'})).status,403);
 assert.equal((await send(input,{'idempotency-key':''})).status,400);
 assert.equal((await send({...input,confirmed:false})).status,403);
 for(const extra of [
  {proof:{}},
  {threadId:'UNTRUSTED_THREAD'},
  {usage:{ordinaryUsageAllowed:true}},
  {review:{verdict:'PASS'}},
 ])assert.equal((await send({...input,...extra})).status,400);
 assert.equal((await send({...input,expectedVersion:0})).status,400);
 assert.equal((await send({...input,sourceHash:'bad'})).status,400);
 assert.equal((await send({...input,ownerDecisionHash:'bad'})).status,400);
 assert.equal((await send(input,{},'?unexpected=true')).status,400);
 const missing={...input};delete missing.reviewPacketId;
 assert.equal((await send(missing)).status,400);
 assert.equal(calls.length,0);
 const response=await send(input);
 assert.equal(response.status,409);
 assert.equal((await response.json()).error,'OFFLINE_REVIEW_USAGE_RECOVERY_GATE_STOP');
 assert.deepEqual(calls[0].slice(0,2),['OFFLINE_RUN',input]);
 assert.match(calls[0][2],/^local-session:[a-f0-9]{64}$/);
 assert.equal(app.store.runs().length,0);
 assert.equal(app.store.projects().length,0);
});
