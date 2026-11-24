// Actual local HTTP seam only; no model, native verifier or product evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {defaults} from '../../dist/server/config.js';
import {DomainError} from '../../dist/server/security.js';
import {root} from '../helpers.mjs';

test('interrupted repair verification keeps original HTTP authentication, CSRF and exact fields',async t=>{
 const parent=join(root,'.runtime/test-temp');
 mkdirSync(parent,{recursive:true});
 const data=mkdtempSync(join(parent,'interrupted-repair-verification-http-'));
 const configPath=join(data,'config.json');
 writeFileSync(configPath,JSON.stringify(defaults));
 const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const {csrf}=await login.json();
 const calls=[];
 app.engine.prepareInterruptedRepairVerification=async(...args)=>{
  calls.push(args);
  throw new DomainError('OFFLINE_INTERRUPTED_REPAIR_GATE_STOP',409);
 };
 const input={confirmed:true,sourceHash:'a'.repeat(64),expectedVersion:7};
 const send=(body,headers={})=>fetch(app.origin+'/api/runs/OFFLINE_RUN/interrupted-repair-verification',{
  method:'POST',
  headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},
  body:JSON.stringify(body),
 });
 assert.equal((await send(input,{cookie:''})).status,401);
 assert.equal((await send(input,{'x-csrf-token':'wrong'})).status,403);
 assert.equal((await send({...input,confirmed:false})).status,403);
 for(const key of ['proof','completion','threadId','modelDispatched'])
  assert.equal((await send({...input,[key]:true})).status,400);
 assert.equal(calls.length,0);
 const response=await send(input);
 assert.equal(response.status,409);
 assert.equal((await response.json()).error,'OFFLINE_INTERRUPTED_REPAIR_GATE_STOP');
 assert.deepEqual(calls[0].slice(0,2),['OFFLINE_RUN',input]);
 assert.match(calls[0][2],/^local-session:[a-f0-9]{64}$/);
 assert.equal(app.store.runs().length,0);
 assert.equal(app.store.projects().length,0);
});
