// Explicit offline failure injection with actual controllers/SQLite, not native acceptance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {NativeProbes} from '../../dist/server/native-probes.js';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {DomainError} from '../../dist/server/security.js';
import {harness} from '../helpers.mjs';
const sha='a'.repeat(64),deferred=()=>{let resolve;const promise=new Promise(ok=>{resolve=ok;});return {promise,resolve};};
function probes(h,started,code){return new NativeProbes({store:h.store,key:randomBytes(32),current:()=>({scopeId:'OFFLINE_CLOSE_FAILURE',authorizationHash:sha,sourceHash:sha,configurationHash:sha,expiresAt:new Date(Date.now()+60000).toISOString(),planner1Mode:'api_key',planner2Mode:'chatgpt_subscription',models:{planner1:'offline-api',planner2:'offline-codex',executor:'deepseek-flash',reviewer:'offline-codex'}}),ledger:()=>[],invoke:async(_role,_challenge,signal)=>{started.resolve();await new Promise((_ok,reject)=>signal.addEventListener('abort',()=>reject(new DomainError(code,409)),{once:true}));}});}

test('probe close preserves cleanup-uncertain failure across repeated close calls instead of swallowing it as cancellation',async t=>{
 const h=harness(t),started=deferred(),p=probes(h,started,'PROCESS_CLEANUP_UNPROVEN');t.after(()=>p.close().catch(()=>{}));
 const pending=p.run('planner2',new AbortController().signal);pending.catch(()=>{});await started.promise;
 const closing=p.close();await assert.rejects(pending,{code:'PROCESS_CLEANUP_UNPROVEN'});await assert.rejects(closing,{code:'NATIVE_PROBE_CLEANUP_UNCERTAIN'});assert.equal(p.close(),closing);await assert.rejects(p.close(),{code:'NATIVE_PROBE_CLEANUP_UNCERTAIN'});
 assert.equal(h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeProbeReceipt'").get().n,0);
});

test('ordinary cancellation remains a settled probe close',async t=>{
 const h=harness(t),started=deferred(),p=probes(h,started,'RUN_CANCELLED');t.after(()=>p.close());const pending=p.run('planner2',new AbortController().signal);pending.catch(()=>{});await started.promise;
 const closing=p.close();await assert.rejects(pending,{code:'RUN_CANCELLED'});await closing;
});

test('native owner final disposal propagates uncertain probe cleanup and retains the monetary journal',async t=>{
 let owner,budget;t.after(async()=>{await owner?.close().catch(()=>{});budget?.close();});const h=harness(t),started=deferred();
 const authority={scopeId:'OFFLINE_OWNER_CLEANUP',authorizationHash:'OFFLINE_NOT_LIVE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
 owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config});budget=new NativeBudget(resolve(h.dir,'isolated-budget.sqlite'),authority);owner.budget=budget;owner.probes=probes(h,started,'PROCESS_CLEANUP_UNPROVEN');
 const pending=owner.probes.run('planner2',new AbortController().signal);pending.catch(()=>{});await started.promise;owner.stopRequests();
 await assert.rejects(pending,{code:'PROCESS_CLEANUP_UNPROVEN'});await assert.rejects(owner.close(),{code:'NATIVE_OWNER_CLEANUP_UNCERTAIN'});assert.deepEqual(budget.requests(),[]);assert.deepEqual(h.store.projects(),[]);
});
