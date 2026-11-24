// OFFLINE localhost authentication/CSRF/dispatch boundary; zero model requests.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {root,ready} from '../helpers.mjs';
import {hash} from '../../dist/server/security.js';
test('build forwards explicit null with its authenticated actor and preserves idempotency',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'deadline-build-http-'));
 const app=await createApp({root,data,configPath:join(data,'config.json'),port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const {p,s}=await ready({interviews:app.interviews,store:app.store}),calls=[];
 app.engine.create=(...args)=>{calls.push(args);};
 const send=(body,headers={})=>fetch(app.origin+`/api/projects/${p.id}/build`,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});
 const input={specHash:s.hash,approved:true,flowName:'custom',taskDeadline:null};
 assert.equal((await send(input,{cookie:''})).status,401);
 assert.equal((await send(input,{'x-csrf-token':'wrong'})).status,403);
 for(const value of [0,3600,false,'none',{}])assert.equal((await send({...input,taskDeadline:value})).status,400);
 assert.equal((await send({...input,actor:'local-session:'+'f'.repeat(64)})).status,400);
 assert.equal((await send({...input,approved:false})).status,403);assert.equal(calls.length,0);
 const key=crypto.randomUUID();assert.equal((await send(input,{'idempotency-key':key})).status,200);
 assert.equal((await send(input,{'idempotency-key':key})).status,200);assert.equal(calls.length,1);
 assert.deepEqual(calls[0].slice(0,5),[p.id,s.hash,true,false,'custom']);
 assert.equal(calls[0][5].taskDeadline,null);assert.equal(calls[0][6],'local-session:'+hash(cookie.slice('dm_session='.length)));
 assert.equal((await send({specHash:s.hash,approved:true})).status,200);
 assert.equal(Object.hasOwn(calls[1][5],'taskDeadline'),false);
 assert.equal(app.store.runs().length,0); // the stub never grants a build/model run
});
