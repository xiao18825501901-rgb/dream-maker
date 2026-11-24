// OFFLINE actual child pipes. No model/account/session qualification.
import test from 'node:test';import assert from 'node:assert/strict';import {resolve} from 'node:path';
import {RpcPeer} from '../dist/server/providers/rpc.js';import {childEnv} from '../dist/server/security.js';import {root} from './helpers.mjs';
const make=()=>new RpcPeer(process.execPath,[resolve(root,'tests/fixtures/rpc-framing.mjs')],{cwd:root,env:childEnv()},10000);
test('RPC preserves Chinese and emoji split across individual stdout bytes',async()=>{
 const p=make();try{assert.equal((await p.request('fixture',{mode:'unicode'})).text,'中文说明😀');}finally{await p.close();}
});
test('coalesced valid lines are drained individually under the unchanged default limit',async()=>{
 const p=make();let frames=0;p.onNotification=()=>frames++;
 try{assert.equal((await p.request('fixture',{mode:'coalesced'})).ok,true);assert.equal(frames,2);}finally{await p.close();}
});
const text='"\\'.repeat(260000);
test('only the exact expected user echo may exceed the ordinary frame limit',async()=>{
 const p=make();let echo;p.onNotification=(_m,v)=>echo=v.item;
 try{p.expectUserMessage('OFFLINE_THREAD',text);assert.equal((await p.request('turn/start',{mode:'echo',text})).ok,true);assert.equal(echo.content[0].text,text);}finally{await p.close();}
});
for(const mode of ['foreign-text','foreign-thread','agent'])test('oversize '+mode+' is still refused even with an expected echo',async()=>{
 const p=make();try{p.expectUserMessage('OFFLINE_THREAD',text);await assert.rejects(p.request('turn/start',{mode,text}),{code:'RPC_LINE_TOO_LONG'});}finally{await p.close();}
});
test('an unqualified oversize message remains refused',async()=>{
 const p=make();try{await assert.rejects(p.request('turn/start',{mode:'echo',text}),{code:'RPC_LINE_TOO_LONG'});}finally{await p.close();}
});
test('controller-known UTF8 input can exceed one megabyte while its exact echo stays below two megabytes',async()=>{
 const p=make(),text='中文'.repeat(200000);try{p.expectUserMessage('OFFLINE_THREAD',text);assert.equal((await p.request('turn/start',{mode:'echo',text})).ok,true);}finally{await p.close();}
});
test('controller-known echo above the unchanged two-megabyte ceiling remains refused',async()=>{
 const p=make();try{assert.throws(()=>p.expectUserMessage('OFFLINE_THREAD','x'.repeat(2000001)),{code:'RPC_EXPECTED_ECHO_LIMIT'});}finally{await p.close();}
});
