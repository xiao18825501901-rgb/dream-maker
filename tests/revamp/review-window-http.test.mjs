// Original local authentication/CSRF/HTTP, explicit Engine spy. No role or formal state.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {defaults} from '../../dist/server/config.js';
import {DomainError} from '../../dist/server/security.js';import {root} from '../helpers.mjs';
test('review-window approval needs original auth, CSRF, exact fields and explicit consent',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'review-window-http-'));
 const configPath=join(data,'config.json');writeFileSync(configPath,JSON.stringify(defaults));
 const app=await createApp({root,data,configPath,port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json(),calls=[];
 app.engine.approveReviewWindow=async(...args)=>{calls.push(args);throw new DomainError('OFFLINE_WINDOW_APPROVAL_STOP',409);};
 const send=(body,headers={})=>fetch(app.origin+'/api/runs/OFFLINE_RUN/review-window',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 const input={sourceHash:'a'.repeat(64),expectedVersion:7,seconds:3600,confirmed:true};
 assert.equal((await send(input,{'x-csrf-token':'WRONG'})).status,403);
 assert.equal((await send({...input,confirmed:false})).status,403);assert.equal(calls.length,0);
 assert.equal((await send({...input,seconds:7201})).status,400);assert.equal((await send({...input,maxCalls:100})).status,400);
 assert.equal(calls.length,0);const response=await send(input);assert.equal(response.status,409);assert.equal((await response.json()).error,'OFFLINE_WINDOW_APPROVAL_STOP');
 assert.deepEqual(calls[0].slice(0,2),['OFFLINE_RUN',input]);assert.match(calls[0][2],/^local-session:[a-f0-9]{64}$/);
 assert.equal(app.store.runs().length,0);assert.equal(app.store.records('OFFLINE_PROJECT','ReviewWindowApproval').length,0);
});
