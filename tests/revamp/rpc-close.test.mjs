// Real local child/process failure injection; not a model or native-audit receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capture } from '../../dist/server/process.js';
import { root } from '../helpers.mjs';
test('background RPC failure consumes its cleanup rejection and every closer receives the same result',async()=>{
 const script=`import {RpcPeer} from './dist/server/providers/rpc.js';import {DomainError} from './dist/server/security.js';
 const p=new RpcPeer(process.execPath,['-e','process.stdout.write("invalid-json\\\\n")'],{cwd:process.cwd()});
 const stop=p.owned.stop;p.owned.stop=async()=>{await stop();throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);};
 await new Promise(r=>setTimeout(r,1000));const a=p.close(),b=p.close();let code;try{await a;}catch(e){code=e.code;}await b.catch(()=>{});await new Promise(r=>setTimeout(r,100));console.log(JSON.stringify({same:a===b,code}));`;
 const out=await capture(process.execPath,['--input-type=module','-e',script],{cwd:root,timeoutMs:10000});
 assert.equal(out.code,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout.trim()),{same:true,code:'PROCESS_CLEANUP_UNPROVEN'});
});
