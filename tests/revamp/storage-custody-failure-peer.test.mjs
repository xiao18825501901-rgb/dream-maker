// OFFLINE protocol peer for failure semantics only. No OS, models, credentials, Store or cleanup authority.
import test from 'node:test';import assert from 'node:assert/strict';import {PassThrough} from 'node:stream';import {StringDecoder} from 'node:string_decoder';import * as path from 'node:path';import {readFileSync} from 'node:fs';
import {withWindowsStorageCustody} from '../../dist/server/windows-storage-custody.js';import {hash,id,object,within,childEnv,DomainError} from '../../dist/server/security.js';
const root=path.resolve('.');
function peer(mode,closeMode='normal'){
 const stdout=new PassThrough(),stderr=new PassThrough(),stdin=new PassThrough();let resolveClosed,stops=0,ownCalls=0;
 const closed=new Promise(res=>resolveClosed=res);let options;
 const send=v=>stdout.write(JSON.stringify({schema:'dream-maker.storage-custody.v1',nonce:options.env.DM_STORAGE_CUSTODY_NONCE,...v})+'\n');
 const finish=()=>{
  if(closeMode==='missing-ack'){resolveClosed({code:0,signal:null});return;}
  send({type:'closed',id:0});resolveClosed({code:0,signal:null});
 };
 const own=(_binary,_args,value)=>{ownCalls++;options=value;queueMicrotask(()=>send({type:'ready',id:0,identity:'1:2',libraryHash:options.env.DM_STORAGE_CUSTODY_LIBRARY_SHA256}));return {child:{stdout,stderr,stdin},ready:Promise.resolve(),closed,stop:async()=>{stops++;finish();}};};
 stdin.on('data',data=>{const q=JSON.parse(data);send(q.op==='directory'?{type:'directory',id:q.id,identity:mode==='identity'?'INVALID':'1:3'}:{type:'image',id:q.id,bytes:mode==='image'?q.bytes+512:q.bytes,sha256:q.sha256});});stdin.on('finish',finish);
 const names=['own','currentProcessOwnership','readFileSync','resolve','relative','sep','isAbsolute','StringDecoder','DomainError','hash','id','object','within','childEnv','schema','bootstrap','validHash','validateRelative'];
 const values=[own,()=>({kind:'OFFLINE_NOT_AUTHORITY'}),readFileSync,path.resolve,path.relative,path.sep,path.isAbsolute,StringDecoder,DomainError,hash,id,object,within,childEnv,'dream-maker.storage-custody.v1','OFFLINE_NOT_EXECUTED',v=>/^[a-f0-9]{64}$/.test(v),()=>{}];
 // Execute the actual compiled function with only its process boundary replaced.
 const run=new Function(...names,'return ('+withWindowsStorageCustody.toString()+');')(...values);
 return{run:(action,options={})=>run(root,path.join(root,'.runtime/test-temp'),action,{timeoutMs:1000,...options}),stdout,stderr,stops:()=>stops,owns:()=>ownCalls};
}
test('invalid keep-alive input is rejected before starting an owned keeper',async()=>{
 const p=peer();
 await assert.rejects(p.run(async()=> 'MUST_NOT_RUN',{keepAliveOnAbort:'invalid'}),{code:'STORAGE_CUSTODY_INPUT_DENIED'});
 assert.equal(p.owns(),0);assert.equal(p.stops(),0);
});
test('invalid cancellation signal is rejected before starting an owned keeper',async()=>{
 const p=peer();
 await assert.rejects(p.run(async()=> 'MUST_NOT_RUN',{signal:{}}),{code:'STORAGE_CUSTODY_INPUT_DENIED'});
 assert.equal(p.owns(),0);assert.equal(p.stops(),0);
});
for(const stream of ['stdout','stderr'])test('an '+stream+' error poisons the entire scope even if callback catches it',async()=>{
 const p=peer();await assert.rejects(p.run(async lease=>{try{p[stream].emit('error',new Error('OFFLINE_PIPE_ERROR'));}catch{}return 'MUST_NOT_SUCCEED';}),{code:'STORAGE_CUSTODY_TRANSPORT_FAILED'});assert.ok(p.stops()>0);
});
for(const mode of ['identity','image'])test('invalid '+mode+' response cannot be swallowed into success',async()=>{
 const p=peer(mode);await assert.rejects(p.run(async lease=>{try{if(mode==='identity')await lease.directory('valid',true);else await lease.image('valid','a'.repeat(64),8192,'b'.repeat(64));}catch{}lease.assertActive();return'MUST_NOT_SUCCEED';}),{code:'STORAGE_CUSTODY_PROTOCOL_INVALID'});
});
for(const [name,reason]of [['undefined',undefined],['null',null],['zero',0],['false',false],['empty','']])test('callback throw '+name+' remains a rejected operation',async()=>{
 const p=peer();await assert.rejects(p.run(async()=>{throw reason;}),e=>e===reason);assert.ok(p.stops()>0);
});
test('callback failure cannot hide an unproven keeper close',async()=>{
 const p=peer(undefined,'missing-ack');
 await assert.rejects(p.run(async()=>{throw new DomainError('OFFLINE_EXPECTED_CALLBACK_FAILURE',409);}),error=>{
  assert.equal(error.code,'STORAGE_CUSTODY_CLOSE_UNVERIFIED');
  assert.equal(error.cause?.code,'OFFLINE_EXPECTED_CALLBACK_FAILURE');
  return true;
 });
 assert.ok(p.stops()>0);
});
test('keeper transport failure cannot hide an unproven keeper close',async()=>{
 const p=peer(undefined,'missing-ack');
 await assert.rejects(p.run(async()=>{
  try{p.stdout.emit('error',new Error('OFFLINE_TRANSPORT_FAILURE'));}catch{}
  return'MUST_NOT_SUCCEED';
 }),error=>{
  assert.equal(error.code,'STORAGE_CUSTODY_CLOSE_UNVERIFIED');
  assert.equal(error.cause?.code,'STORAGE_CUSTODY_TRANSPORT_FAILED');
  return true;
 });
 assert.ok(p.stops()>0);
});
test('internal timeout aborts the callback signal and waits for cooperative exit',async()=>{
 const p=peer();let stopped=false;
 await assert.rejects(p.run(async lease=>{assert.ok(lease.signal instanceof AbortSignal);await new Promise((_,reject)=>lease.signal.addEventListener('abort',()=>{stopped=true;reject(lease.signal.reason);},{once:true}));}),{code:'STORAGE_CUSTODY_TIMEOUT'});
 assert.equal(stopped,true);assert.ok(p.stops()>0);
});

test('keep-alive cancellation leaves the keeper active until the action finishes cleanup',async()=>{
 const p=peer(),abort=new AbortController();
 const work=p.run(async lease=>{
  if(lease.signal.aborted)throw Error('CANCELLATION_WAS_NOT_DEFERRED');
  await new Promise(resolve=>{
   lease.signal.addEventListener('abort',resolve,{once:true});
   abort.abort(new DomainError('RUN_CANCELLED',409));
  });
  assert.equal(lease.signal.aborted,true);
  assert.equal(p.stops(),0);
  lease.assertActive();
  return'CLEANUP_COMPLETE';
 },{signal:abort.signal,keepAliveOnAbort:true});
 await assert.rejects(work,{code:'RUN_CANCELLED'});
 assert.ok(p.stops()>0);
});
