// OFFLINE runner lifecycle seam. No Codex CLI/model/OAuth is invoked.
import test from 'node:test';import assert from 'node:assert/strict';
import {NativeOwner} from '../../dist/server/native-owner.js';import {CodexRunner} from '../../dist/server/providers/codex.js';import {harness} from '../helpers.mjs';
test('Codex owner pins the original role/run/source/model/signal before a caller can mutate its input',async t=>{
 const h=harness(t),owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,product:'dreamflow'});
 owner.probes={codexAccountFingerprint:()=> 'a'.repeat(64),close:async()=>{}};
 let dispatched=0;t.mock.method(CodexRunner.prototype,'run',async()=>{dispatched++;return {text:'OFFLINE'};});
 try{
  for(const [field,value] of [['role','reviewer'],['runId','other'],['specHash','other'],['workspace','other'],['model','other'],['signal',new AbortController().signal]]){
   const input={role:'planner2',workspace:h.dir,runId:'offline',specHash:'offline',model:'offline',prompt:'OFFLINE',signal:new AbortController().signal};
   const runner=owner.codex(input);input[field]=value;
   await assert.rejects(runner.run(input,()=>{}),{code:'NATIVE_RUN_BINDING_CHANGED'});
  }
  assert.equal(dispatched,0);
 }finally{await owner.close();}
});
test('a Codex product runner cannot dispatch a second model request, including concurrent reuse',async t=>{
 const h=harness(t),owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,product:'dreamflow'});
 owner.probes={codexAccountFingerprint:()=> 'a'.repeat(64),close:async()=>{}};
 let dispatched=0;t.mock.method(CodexRunner.prototype,'run',async()=>{dispatched++;return {text:'OFFLINE'};});
 const input={role:'planner2',workspace:h.dir,runId:'offline',specHash:'offline',model:'offline',prompt:'OFFLINE',signal:new AbortController().signal};
 try{const runner=owner.codex(input),first=runner.run(input,()=>{});
  await assert.rejects(runner.run(input,()=>{}),{code:'NATIVE_RUN_ALREADY_DISPATCHED'});await first;
  await assert.rejects(runner.run(input,()=>{}),{code:'NATIVE_RUN_ALREADY_DISPATCHED'});assert.equal(dispatched,1);
 }finally{await owner.close();}
});
test('NativeOwner shutdown cancels and awaits its product Codex runner cleanup',async t=>{
 const h=harness(t),owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,product:'dreamflow'});
 owner.probes={codexAccountFingerprint:()=> 'a'.repeat(64),close:async()=>{}};
 let childSignal,release;const childClosed=new Promise(r=>{release=r;});
 t.mock.method(CodexRunner.prototype,'run',async input=>{childSignal=input.signal;await childClosed;throw Object.assign(Error('RUN_CANCELLED'),{code:'RUN_CANCELLED'});});
 const input={role:'planner2',workspace:h.dir,runId:'offline',specHash:'offline',model:'offline',prompt:'OFFLINE',signal:new AbortController().signal};
 const result=owner.codex(input).run(input,()=>{});result.catch(()=>{});
 let ownerClosed=false;const closing=owner.close().then(()=>{ownerClosed=true;});
 try{await new Promise(r=>setImmediate(r));assert.equal(childSignal.aborted,true);assert.equal(ownerClosed,false);}finally{release();await result.catch(()=>{});await closing;}
 assert.equal(ownerClosed,true);
});
