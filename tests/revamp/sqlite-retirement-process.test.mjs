// OFFLINE ownership journal only. No model or native business execution.
import test from 'node:test';import assert from 'node:assert/strict';import {harness,root} from '../helpers.mjs';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {DomainError} from '../../dist/server/security.js';
const load=()=>import('../../dist/server/sqlite-retirement-process.js');
test('native retirement consumes an original opaque permit before starting any process or account operation',async t=>{
 const h=harness(t),owner=Object.create(NativeOwner.prototype);let reads=0;owner.context={root,store:h.store,getConfig(){reads++;throw Error('NO_CONFIG');},getSecret(){reads++;throw Error('NO_CREDENTIAL');}};
 const input={permit:{schema:'dream-maker.sqlite-retirement-permit.v1',authorityHash:'a'.repeat(64)},signal:new AbortController().signal};
 assert.equal(typeof owner.retireSqliteData,'function');await assert.rejects(owner.retireSqliteData(input),{code:'SQLITE_RETIREMENT_NOT_RELEASED'});
 const m=await load();await assert.rejects(m.retireSqliteGuest(h.store,root,input),{code:'SQLITE_RETIREMENT_PERMIT_REQUIRED'});
 assert.equal(reads,0);assert.equal(h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='OwnedProcessIntent'").get().n,0);
});
test('retirement root closure requires one ordered exact Windows identity and terminal observation',async()=>{
 const m=await load(),processId='owned_process_offline',generation='generation_offline',record=(kind,data)=>({id:'rec_'+kind,kind,data:{processId,generation,...data}}),rows=[record('OwnedProcessIntent',{}),record('OwnedProcessRootStarted',{pid:52,identity:'win32:123456'}),record('OwnedProcessRootExited',{rootClosed:true,code:7,signal:null})];
 assert.equal(m.retirementRootClosure(rows,processId,generation).pid,52);
 for(const bad of [rows.slice(0,2),[rows[0],rows[2],rows[1]],[...rows,rows[1]],rows.map(r=>r.kind==='OwnedProcessRootStarted'?{...r,data:{...r.data,identity:null}}:r),rows.map(r=>({...r,data:{...r.data,generation:'foreign'}}))])assert.throws(()=>m.retirementRootClosure(bad,processId,generation));
});

test('retirement process settlement is bounded when close and fallback stop never finish',async()=>{
 const m=await load();
 await assert.rejects(m.settleRetirementProcess(new Promise(()=>{}),()=>new Promise(()=>{}),{closeMs:15,stopMs:15}),{code:'SQLITE_RETIREMENT_CLEANUP_UNPROVEN'});
});

test('retirement process settlement returns only after both close and stop proof finish',async()=>{
 const m=await load(),events=[];
 const closed=new Promise(resolve=>setTimeout(()=>{events.push('closed');resolve({code:0,signal:null});},10));
 const result=await m.settleRetirementProcess(closed,async()=>{events.push('stopped');},{closeMs:50,stopMs:50});
 assert.deepEqual(result,{code:0,signal:null});
 assert.deepEqual(events,['closed','stopped']);
});
