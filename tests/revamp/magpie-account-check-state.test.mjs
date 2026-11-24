// OFFLINE original SQLite: synthetic check records, no process/account/model.
import test from 'node:test';import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';import {Store} from '../../dist/server/store.js';import {hash} from '../../dist/server/security.js';import {magpieBlocksNative} from '../../dist/server/magpie-check.js';
const actor='local-session:'+'a'.repeat(64);
async function rig(t){const api=await import('../../dist/server/magpie-account-check-state.js'),h=harness(t),{p,s}=await ready(h),selection={projectId:p.id,specHash:s.hash,profileHash:'b'.repeat(64),preparation:{identityHash:'c'.repeat(64),contentHash:'d'.repeat(64)}};return{api,h,p,selection,binding:{flowConfigHash:'e'.repeat(64),sourceBindingHash:'f'.repeat(64)}};}
const passed=intent=>({schema:'dream-maker.magpie-account-check.v1',projectId:intent.selection.projectId,scope:'REGISTERED_MEMORY_TRANSFER_ONLY',historical:true,status:'PASSED',selection:intent.selection,flowConfigHash:intent.flowConfigHash,sourceBindingHash:'f'.repeat(64),checkedAt:new Date().toISOString(),accountCount:1,processClosed:true,reason:null,accountVerified:false,modelVerified:false,customExecutionGranted:false});

test('intent alone remains unknown after actual Store reopen and blocks original native admission',async t=>{
 const x=await rig(t),intent=x.api.beginAccountCheck(x.h.store,x.selection,x.binding,actor,hash('OFFLINE_CHECK_ONE'));
 const current=x.api.latestAccountCheck(x.h.store,x.p.id);assert.equal(current.status,'UNCERTAIN');assert.equal(current.processClosed,false);assert.equal(current.accountVerified,false);assert.equal(magpieBlocksNative(x.h.store),true);
 const reopened=new Store(x.h.store.path);try{assert.deepEqual(x.api.latestAccountCheck(reopened,x.p.id),current);assert.equal(magpieBlocksNative(reopened),true);}finally{reopened.close();}
 assert.equal(x.h.store.runs(x.p.id).length,0);assert.equal(intent.requestHash,hash(x.selection));
});
test('an exact closed result is immutable and repeated request input cannot be changed',async t=>{
 const x=await rig(t),operation=hash('OFFLINE_CHECK_DONE'),intent=x.api.beginAccountCheck(x.h.store,x.selection,x.binding,actor,operation),view=passed(intent);
 x.api.finishAccountCheck(x.h.store,intent,view);assert.deepEqual(x.api.latestAccountCheck(x.h.store,x.p.id),view);assert.equal(magpieBlocksNative(x.h.store),false);
 assert.deepEqual(x.api.beginAccountCheck(x.h.store,x.selection,x.binding,actor,operation),intent);
 assert.throws(()=>x.api.beginAccountCheck(x.h.store,{...x.selection,profileHash:'1'.repeat(64)},x.binding,actor,operation),{code:'IDEMPOTENCY_KEY_REUSED'});
 assert.throws(()=>x.api.finishAccountCheck(x.h.store,intent,{...view,checkedAt:'2026-01-01T00:00:00.000Z'}),{code:'MAGPIE_ACCOUNT_CHECK_RESULT_EXISTS'});
});
test('an unknown operation cannot be hidden by a newer successful record',async t=>{
 const x=await rig(t);x.api.beginAccountCheck(x.h.store,x.selection,x.binding,actor,hash('OFFLINE_UNKNOWN'));
 const two=x.api.beginAccountCheck(x.h.store,x.selection,x.binding,actor,hash('OFFLINE_LATER_SYNTHETIC'));x.api.finishAccountCheck(x.h.store,two,passed(two));
 assert.equal(x.api.latestAccountCheck(x.h.store,x.p.id).status,'PASSED');assert.equal(magpieBlocksNative(x.h.store),true);
});
test('corrupt metadata and counterfeit account qualification fail closed without copying raw text',async t=>{
 const x=await rig(t),intent=x.api.beginAccountCheck(x.h.store,x.selection,x.binding,actor,hash('OFFLINE_CORRUPT'));
 assert.throws(()=>x.api.finishAccountCheck(x.h.store,intent,{...passed(intent),accountVerified:'VERIFIED'}),{code:'MAGPIE_ACCOUNT_CHECK_INTEGRITY'});
 x.h.store.db.prepare("UPDATE records SET data=? WHERE kind='MagpieAccountCheckIntent'").run('{PRIVATE_CORRUPT');
 assert.throws(()=>x.api.latestAccountCheck(x.h.store,x.p.id),e=>e.code==='MAGPIE_ACCOUNT_CHECK_INTEGRITY'&&!e.message.includes('PRIVATE_CORRUPT'));assert.equal(magpieBlocksNative(x.h.store),true);
});
