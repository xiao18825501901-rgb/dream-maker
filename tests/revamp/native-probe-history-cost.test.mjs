// OFFLINE signature/cost regression. No Native authority, real account or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {harness} from '../helpers.mjs';
import {NativeProbes} from '../../dist/server/native-probes.js';
import {hash} from '../../dist/server/security.js';

function fixture(t){
 const h=harness(t),sha='a'.repeat(64),current={scopeId:'OFFLINE_HISTORY_COST',authorizationHash:sha,sourceHash:sha,configurationHash:sha,expiresAt:new Date(Date.now()+600000).toISOString(),planner1Mode:'api_key',planner2Mode:'chatgpt_subscription',models:{planner1:'offline-api',planner2:'offline-codex',executor:'deepseek-flash',reviewer:'offline-codex'}};
 let reads=0,invocations=0;
 const probes=new NativeProbes({store:h.store,key:randomBytes(32),current:()=>{reads++;return current;},ledger:()=>[],invoke:async(role,nonce)=>{
  invocations++;return{role,runner:'CODEX',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:current.models[role],responseId:'OFFLINE_RESPONSE_'+invocations,responseHash:sha,sessionId:'OFFLINE_SESSION_'+invocations,accountFingerprint:sha,includedUsageAllowed:true,paidFallback:false,ledgerRequestIds:[],cleanupReturned:true,reply:nonce};
 }});t.after(()=>probes.close());
 const seed=async n=>{for(let i=0;i<n;i++){current.sourceHash=hash('OFFLINE_SOURCE_'+invocations);await probes.run('planner2',new AbortController().signal);}current.sourceHash=hash('OFFLINE_CURRENT_NO_RECEIPT_'+invocations);};
 const status=()=>{reads=0;const callsBefore=invocations,value=probes.status();assert.equal(invocations,callsBefore,'read-only status must never invoke a model substitute');return{value,sourceReads:reads};};
 return{h,current,probes,seed,status};
}

test('source inventory cost is bounded by roles rather than the number of stale signed receipts',async t=>{
 const f=fixture(t);await f.seed(3);const small=f.status();await f.seed(12);const large=f.status();
 t.diagnostic(JSON.stringify({scope:'OFFLINE_BINDING_READ_COST_NOT_NATIVE_TIMING',threeStale:small.sourceReads,fifteenStale:large.sourceReads}));
 assert.equal(small.value.planner2.present,true);assert.equal(small.value.planner2.valid,false);assert.equal(large.value.planner2.valid,false);
 assert.ok(large.sourceReads<=small.sourceReads+1,'historical receipts must not repeat the expensive current-source inventory');
 assert.ok(large.sourceReads<=5,'one synchronous lookup per role bounds status source-read work');
});

test('a lookup snapshot never survives source changes or forgery in a later public operation',async t=>{
 const f=fixture(t);await f.seed(5);const ref=await f.probes.run('planner2',new AbortController().signal);
 assert.equal(f.status().value.planner2.valid,true);assert.equal(f.probes.verify('planner2',ref),true);
 const original=f.current.sourceHash;f.current.sourceHash=hash('OFFLINE_CHANGED_AFTER_STATUS');
 assert.equal(f.status().value.planner2.valid,false);assert.equal(f.probes.verify('planner2',ref),false);
 f.current.sourceHash=original;assert.equal(f.probes.verify('planner2',ref),true);
 f.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.payload.observation.provider','FORGED') WHERE id=?").run(ref.evidenceId);
 assert.equal(f.status().value.planner2.valid,false);assert.equal(f.probes.verify('planner2',ref),false);
});
