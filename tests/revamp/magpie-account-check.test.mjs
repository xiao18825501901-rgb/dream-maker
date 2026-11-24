// OFFLINE SQLite and explicit controller seam, not a real process/account/model.
import test from 'node:test';import assert from 'node:assert/strict';import {harness,ready} from '../helpers.mjs';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';import {hash,DomainError} from '../../dist/server/security.js';import {magpieBlocksNative} from '../../dist/server/magpie-check.js';
const actor='local-session:'+'a'.repeat(64);
async function rig(t){const {MagpieAccountChecks}=await import('../../dist/server/magpie-account-check.js'),h=harness(t),{p,s}=await ready(h),role=(id,write=false)=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const configuration={mode:'custom',laya:false,accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE'}],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'},profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_ACCOUNT_CHECK_PROFILE'),prep=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash),input={projectId:p.id,specHash:s.hash,profileHash:profile.contentHash,preparation:{identityHash:prep.identityHash,contentHash:prep.contentHash}};
 return{h,p,prep,input,checks:new MagpieAccountChecks(h.store,()=>h.config,()=>({flowConfigHash:prep.flowConfigHash,sourceBindingHash:'f'.repeat(64)})),signal:new AbortController().signal};
}
const observation=x=>({schema:'dream-maker.magpie-account-control-observation.v1',projectId:x.p.id,flowConfigHash:x.prep.flowConfigHash,sourceBindingHash:'f'.repeat(64),accountCount:1,processClosed:true,accountVerified:false,modelVerified:false,customExecutionGranted:false});

test('the original durable intent precedes inspection, and replay never launches another process',async t=>{
 const x=await rig(t),op=hash('OFFLINE_CHECK_EXEC');let calls=0;
 const inspect=async()=>{calls++;const intents=x.h.store.records(x.p.id,'MagpieAccountCheckIntent');assert.equal(intents.length,1);assert.equal(intents[0].data.sourceBindingHash,'f'.repeat(64));assert.equal(magpieBlocksNative(x.h.store),true);return observation(x);};
 const first=await x.checks.check(x.input,op,actor,x.signal,inspect);assert.equal(first.status,'PASSED');assert.equal(first.accountVerified,false);assert.equal(first.customExecutionGranted,false);assert.equal(magpieBlocksNative(x.h.store),false);
 assert.deepEqual(await x.checks.check(x.input,op,actor,x.signal,inspect),first);assert.equal(calls,1);assert.equal(x.h.store.runs(x.p.id).length,0);
 await assert.rejects(x.checks.check({...x.input,profileHash:'0'.repeat(64)},op,actor,x.signal,inspect),{code:'IDEMPOTENCY_KEY_REUSED'});assert.equal(calls,1);
});
test('unknown cleanup persists and quarantines other checks, with no raw exception text',async t=>{
 const x=await rig(t);let calls=0;const result=await x.checks.check(x.input,hash('OFFLINE_UNKNOWN'),actor,x.signal,async()=>{calls++;throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500,'PRIVATE_ERROR_VALUE');});assert.equal(result.status,'UNCERTAIN');assert.equal(result.processClosed,false);assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR_VALUE'),false);assert.equal(magpieBlocksNative(x.h.store),true);
 await assert.rejects(x.checks.check(x.input,hash('OFFLINE_NEW_AFTER_UNKNOWN'),actor,x.signal,async()=>{calls++;return observation(x);}),{code:'MAGPIE_CHECK_RECOVERY_REQUIRED'});assert.equal(calls,1);
});
test('foreign preparation and cancellation refuse without an intent or inspection',async t=>{
 const x=await rig(t);let calls=0;const inspect=async()=>{calls++;return observation(x);};
 await assert.rejects(x.checks.check({...x.input,preparation:{...x.input.preparation,contentHash:'0'.repeat(64)}},hash('OFFLINE_BAD_PREP'),actor,x.signal,inspect));
 const cancel=new AbortController();cancel.abort();await assert.rejects(x.checks.check(x.input,hash('OFFLINE_CANCEL'),actor,cancel.signal,inspect));assert.equal(calls,0);assert.equal(x.h.store.records(x.p.id,'MagpieAccountCheckIntent').length,0);
});
test('post-inspection configuration drift preserves a closed failure rather than a fresh pass',async t=>{
 const x=await rig(t),view=await x.checks.check(x.input,hash('OFFLINE_AFTER_DRIFT'),actor,x.signal,async()=>{x.h.config.limits.maxCalls++;return observation(x);});assert.equal(view.status,'FAILED');assert.equal(view.reason,'SELECTION_CHANGED');assert.equal(view.processClosed,true);assert.equal(view.modelVerified,false);
});
test('unknown errors and a counterfeit qualification never become a model or process success',async t=>{
 for(const inspect of [async()=>{throw Error('PRIVATE_UNEXPECTED');},async()=>({accountVerified:true})]){const x=await rig(t),view=await x.checks.check(x.input,hash('OFFLINE_BAD_OBSERVATION'),actor,x.signal,inspect);assert.notEqual(view.status,'PASSED');assert.equal(view.modelVerified,false);assert.equal(view.customExecutionGranted,false);assert.equal(JSON.stringify(view).includes('PRIVATE_UNEXPECTED'),false);}
});

test('malformed observations and unknown DomainErrors cannot clear native quarantine',async t=>{
 for(const inspect of [async()=>null,async()=>[],async()=>42,async()=>{throw new DomainError('UNRECOGNIZED_CONTROLLER_FAILURE',500);}]){const x=await rig(t),view=await x.checks.check(x.input,hash('OFFLINE_UNKNOWN_DOMAIN'),actor,x.signal,inspect);assert.equal(view.status,'UNCERTAIN');assert.equal(magpieBlocksNative(x.h.store),true);}
});
