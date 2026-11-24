// OFFLINE protocol test only. It proves receipt shape and ledger isolation, not a live Ollama call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {harness} from '../helpers.mjs';
import {NativeProbes} from '../../dist/server/native-probes.js';

function fixture(t){
 const h=harness(t),sha='a'.repeat(64);
 let ledgerReads=0,invocations=0,forgedLedgerId=false;
 const binding={
  scopeId:'OFFLINE_LOCAL_PLANNER1',authorizationHash:sha,sourceHash:sha,configurationHash:sha,
  expiresAt:new Date(Date.now()+600000).toISOString(),profile:'FULL_DM',planner1Mode:'local',planner1Provider:'local-ollama',
  planner2Mode:'chatgpt_subscription',models:{planner1:'qwen2.5:7b',planner2:'offline-codex',executor:'deepseek-flash',reviewer:'offline-codex'}
 };
 const probes=new NativeProbes({
  store:h.store,
  key:randomBytes(32),
  current:()=>binding,
  ledger:()=>{ledgerReads++;return [];},
  invoke:async(role,nonce)=>{
   invocations++;
   return{
    role,runner:'LOCAL_HTTP',provider:'local-ollama',authentication:'NONE',model:binding.models[role],
    responseId:'OFFLINE_LOCAL_RESPONSE_'+invocations,responseHash:sha,paidFallback:false,
    ledgerRequestIds:forgedLedgerId?['OFFLINE_FORGED_PAID_REQUEST']:[],cleanupReturned:true,reply:nonce
   };
  }
 });
 t.after(()=>probes.close());
 return{probes,counts:()=>({ledgerReads,invocations}),setForgedLedger:value=>{forgedLedgerId=value;}};
}

test('local Planner 1 uses the local-only receipt shape without consuming the paid ledger',async t=>{
 const f=fixture(t),receipt=await f.probes.run('planner1',new AbortController().signal);
 assert.equal(receipt.model,'qwen2.5:7b');
 assert.equal(receipt.source,'REAL_MODEL_RESPONSE');
 assert.deepEqual(f.counts(),{ledgerReads:0,invocations:1});
 assert.equal(f.probes.verify('planner1',receipt),true);
});

test('a local Planner 1 observation cannot borrow a paid request or API-key identity',async t=>{
 const f=fixture(t);f.setForgedLedger(true);
 await assert.rejects(()=>f.probes.run('planner1',new AbortController().signal),{code:'NATIVE_PROBE_LOCAL_UNVERIFIED'});
 assert.deepEqual(f.counts(),{ledgerReads:0,invocations:1});
});
