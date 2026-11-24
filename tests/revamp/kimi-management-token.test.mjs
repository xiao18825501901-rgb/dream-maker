// OFFLINE controller custody cases. No credentials, OAuth or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createKimiTransport} from '../../dist/server/providers/kimi.js';

function fixture(t,decrypt,fetch){
 const dir=mkdtempSync(join(tmpdir(),'dm-kimi-custody-')),tokenFile=join(dir,'control.dpapi'),seen=[];
 t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(tokenFile,'OFFLINE_CIPHER_A');
 const transport=createKimiTransport({baseUrl:'http://127.0.0.1:12345',tokenFile,decrypt,
  fetchImpl:async(_url,init)=>{seen.push(init.headers.authorization);return fetch?fetch(init):{code:0,data:{ok:true}};}});
 return{tokenFile,seen,transport};
}

test('unchanged encrypted management bytes do not start a decrypt process for every poll',async t=>{
 let decryptions=0;const f=fixture(t,async()=>{decryptions++;return'OFFLINE_MANAGEMENT_A';});
 for(let i=0;i<6;i++)assert.deepEqual(await f.transport('/api/v1/auth'),{code:0,data:{ok:true}});
 assert.equal(decryptions,1);assert.deepEqual(f.seen,Array(6).fill('Bearer OFFLINE_MANAGEMENT_A'));
 writeFileSync(f.tokenFile,'OFFLINE_CIPHER_B');
 await f.transport('/api/v1/auth');assert.equal(decryptions,2);
});

test('rotation and missing files revoke a warm token before the next request',async t=>{
 const f=fixture(t,async bytes=>Buffer.from(bytes).toString()==='OFFLINE_CIPHER_A'?'OFFLINE_MANAGEMENT_A':'OFFLINE_MANAGEMENT_B');
 await f.transport('/api/v1/auth');writeFileSync(f.tokenFile,'OFFLINE_CIPHER_B');await f.transport('/api/v1/auth');
 assert.deepEqual(f.seen,['Bearer OFFLINE_MANAGEMENT_A','Bearer OFFLINE_MANAGEMENT_B']);
 rmSync(f.tokenFile);await assert.rejects(f.transport('/api/v1/auth'),{code:'KIMI_SERVER_TOKEN_MISSING'});assert.equal(f.seen.length,2);
});

test('a failed replacement decrypt never reuses the old token or reflects private errors',async t=>{
 const f=fixture(t,async bytes=>{if(Buffer.from(bytes).toString()==='OFFLINE_CIPHER_B')throw Error('OFFLINE_PRIVATE_ERROR');return'OFFLINE_MANAGEMENT_A';});
 await f.transport('/api/v1/auth');writeFileSync(f.tokenFile,'OFFLINE_CIPHER_B');
 await assert.rejects(f.transport('/api/v1/auth'),e=>e.code==='KIMI_SERVER_TOKEN_DECRYPT_FAILED'&&!String(e).includes('OFFLINE_PRIVATE_ERROR'));
 assert.equal(f.seen.length,1);
});

test('local decrypt timeout is distinguished from a missing file and never dispatches',async t=>{
 const f=fixture(t,async()=>{throw Error('DPAPI_TIMEOUT');});
 await assert.rejects(f.transport('/api/v1/auth'),{code:'KIMI_SERVER_TOKEN_DECRYPT_TIMEOUT'});assert.equal(f.seen.length,0);
});

test('a token rotated during decrypt cannot send a stale management request',async t=>{
 let entered,release;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 const f=fixture(t,async()=>{entered();await held;return'OFFLINE_MANAGEMENT_A';});
 const call=f.transport('/api/v1/auth');await Promise.race([ready,call]);writeFileSync(f.tokenFile,'OFFLINE_CIPHER_B');release();
 await assert.rejects(call,{code:'KIMI_SERVER_TOKEN_CHANGED'});assert.equal(f.seen.length,0);
});

test('cancellation during decrypt prevents the subsequent local request',async t=>{
 let entered,release;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r),abort=new AbortController();
 const f=fixture(t,async()=>{entered();await held;return'OFFLINE_MANAGEMENT_A';});
 const call=f.transport('/api/v1/sessions',{method:'POST',body:{},signal:abort.signal});await Promise.race([ready,call]);abort.abort();release();
 await assert.rejects(call,{code:'RUN_CANCELLED'});assert.equal(f.seen.length,0);
});

test('an overdue eviction callback cannot extend the plaintext cache deadline',async t=>{
 let now=100,decryptions=0;t.mock.method(performance,'now',()=>now);
 const f=fixture(t,async()=>{decryptions++;return'OFFLINE_MANAGEMENT_A';});
 await f.transport('/api/v1/auth');now+=60001;await f.transport('/api/v1/auth');assert.equal(decryptions,2);
});

test('safe GET retry observes a rotated management file before sending again',async t=>{
 let sends=0;const f=fixture(t,async bytes=>Buffer.from(bytes).toString()==='OFFLINE_CIPHER_A'?'OFFLINE_MANAGEMENT_A':'OFFLINE_MANAGEMENT_B',async()=>{
  if(++sends===1){writeFileSync(f.tokenFile,'OFFLINE_CIPHER_B');throw Error('ECONNRESET');}return{code:0};
 });
 await f.transport('/api/v1/auth');assert.deepEqual(f.seen,['Bearer OFFLINE_MANAGEMENT_A','Bearer OFFLINE_MANAGEMENT_B']);
});

test('safe GET retry refuses a deleted file rather than reusing its bearer',async t=>{
 const f=fixture(t,async()=> 'OFFLINE_MANAGEMENT_A',async()=>{rmSync(f.tokenFile);throw Error('ECONNRESET');});
 await assert.rejects(f.transport('/api/v1/auth'),{code:'KIMI_SERVER_TOKEN_MISSING'});assert.equal(f.seen.length,1);
});

test('an unknown POST outcome is never automatically resent',async t=>{
 const f=fixture(t,async()=> 'OFFLINE_MANAGEMENT_A',async()=>{throw Error('ECONNRESET');});
 await assert.rejects(f.transport('/api/v1/sessions',{method:'POST',body:{}}),/ECONNRESET/);assert.equal(f.seen.length,1);
});

test('the physical method and body cannot change while decryption is pending',async t=>{
 let entered,release,sends=0;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r),requests=[];
 const f=fixture(t,async()=>{entered();await held;return'OFFLINE_MANAGEMENT_A';},async init=>{
  requests.push({method:init.method,body:init.body});if(++sends===1)throw Error('ECONNRESET');return{code:0};
 });
 const init={method:'GET',body:{version:1}},call=f.transport('/api/v1/auth',init);await Promise.race([ready,call]);
 init.method='POST';init.body.version=2;release();await call;
 assert.deepEqual(requests,[{method:'GET',body:'{"version":1}'},{method:'GET',body:'{"version":1}'}]);
});

test('replacing the init signal cannot evade cancellation of the original request',async t=>{
 let entered,release;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r),abort=new AbortController();
 const f=fixture(t,async()=>{entered();await held;return'OFFLINE_MANAGEMENT_A';});
 const init={method:'POST',signal:abort.signal},call=f.transport('/api/v1/sessions',init);await Promise.race([ready,call]);
 init.signal=new AbortController().signal;abort.abort();release();await assert.rejects(call,{code:'RUN_CANCELLED'});assert.equal(f.seen.length,0);
});
