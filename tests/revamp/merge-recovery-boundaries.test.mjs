// Private F files and original SQLite; faults are injected, not real power-loss or product agent evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,sep} from 'node:path';
import {interruptedMerge} from '../fixtures/executor-recovery.mjs';
import {hash,DomainError} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
const actor='local-session:'+'b'.repeat(64),op=name=>hash('OFFLINE_MERGE_BOUNDARY_'+name);
const input=h=>{const view=h.engine.mergeRecoveryPreview(h.store.runs()[0].id);return {choice:'RESTORE_BASE_AND_END',previewHash:view.previewHash,expectedHash:view.source.currentHash,confirmed:true};};
const request=(h,run,body,key)=>h.engine.recoverMerge(run.id,body,op(key),actor);
for(const fault of ['RENAME','COMMIT'])test('interrupted recovery '+fault+' retains intent and copies; same key does not repeat, fresh preview can end safely',async t=>{
 const {h,run,wave}=await interruptedMerge(t,'COMBINED'),body=input(h),rename=fs.renameSync,record=h.store.record.bind(h.store);let count=0;
 fs.renameSync=(from,to)=>{if(fault==='RENAME'&&resolve(to).startsWith(resolve(run.workspace)+sep)&&++count===2)throw Error('OFFLINE_RECOVERY_INTERRUPTED');return rename(from,to);};syncBuiltinESMExports();
 h.store.record=(kind,...args)=>{if(fault==='COMMIT'&&kind==='ExecutorMergeRecovered')throw Error('OFFLINE_RECOVERY_INTERRUPTED');return record(kind,...args);};
 try{await assert.rejects(request(h,run,body,fault),/OFFLINE_RECOVERY_INTERRUPTED/);}finally{fs.renameSync=rename;syncBuiltinESMExports();h.store.record=record;}
 assert.equal(h.store.run(run.id).state,'BLOCKED');assert.equal(h.store.owns(run.projectId,run.id),true);assert.equal(h.store.records(run.projectId,'ExecutorMergeRecovered').length,0);assert.equal(h.store.records(run.projectId,'ExecutorMergeRecoveryIntent').length,1);
 const stopped=treeHash(run.workspace);await assert.rejects(request(h,run,body,fault),{code:'MERGE_RECOVERY_RESULT_UNCERTAIN'});assert.equal(treeHash(run.workspace),stopped);
 assert.ok(fs.readdirSync(wave.directory).some(name=>name.startsWith('recovery_')));
 const fresh=input(h),result=await request(h,run,fresh,fault+'-fresh');assert.equal(result.flowEnded,true);assert.equal(h.store.run(run.id).state,'CANCELLED');assert.equal(fs.readFileSync(resolve(run.workspace,'b.txt'),'utf8'),'b0');
});
for(const change of ['SOURCE','LEASE','CONFIG','SPEC'])test('rechecks '+change+' after asynchronous OS reconciliation before any source publication',async t=>{
 const {h,run,wave}=await interruptedMerge(t),body=input(h),before=treeHash(run.workspace);
 h.engine.dispatch.reconcileOwned=async()=>{if(change==='SOURCE')fs.writeFileSync(resolve(run.workspace,'a.txt'),'external source');if(change==='LEASE')h.store.release(run.projectId,run.id);if(change==='CONFIG')h.config.limits.maxCalls++;if(change==='SPEC'){const spec=h.store.spec(run.specId);spec.stale=true;h.store.saveSpec(spec);}};
 await assert.rejects(request(h,run,body,change),{code:{SOURCE:'MERGE_RECOVERY_SOURCE_CHANGED',LEASE:'WORKSPACE_LEASE_LOST',CONFIG:'RUN_CONFIG_CHANGED',SPEC:'RUN_SPEC_STALE'}[change]});
 if(change==='SOURCE')assert.equal(fs.readFileSync(resolve(run.workspace,'a.txt'),'utf8'),'external source');else assert.equal(treeHash(run.workspace),before);assert.equal(fs.readFileSync(resolve(run.workspace,'b.txt'),'utf8'),'b0');assert.equal(fs.readdirSync(wave.directory).filter(n=>n.startsWith('recovery_')).length,0);
});
for(const action of ['pauseAll','close'])test(action+' reports unknown recovery cleanup instead of silently claiming safe stop',async t=>{
 const {h,run}=await interruptedMerge(t),body=input(h);let release,started;const begun=new Promise(r=>started=r),pending=new Promise((_,reject)=>release=reject);
 h.engine.dispatch.reconcileOwned=async()=>{started();return pending;};
 const work=request(h,run,body,action),rejected=assert.rejects(work,{code:'PROCESS_CLEANUP_UNPROVEN'});await begun;
 const stop=h.engine[action](),stopResult=assert.rejects(stop,{code:action==='close'?'ENGINE_CLOSE_UNCERTAIN':'ENGINE_PAUSE_UNCERTAIN'});release(new DomainError('PROCESS_CLEANUP_UNPROVEN',409));await rejected;await stopResult;
 assert.equal(h.store.owns(run.projectId,run.id),true);assert.equal(h.store.run(run.id).state,'BLOCKED');
 // The private harness gets an explicit second clean shutdown; no product state is reconciled by hand.
 h.engine.pauseWork=undefined;h.engine.pausing=false;
});
test('recovery preserves nonempty managed business versions, all approvals, plans and usage rows',async t=>{
 const {h,run}=await interruptedMerge(t,'PARTIAL',{businessData:true}),tables=['managed_dataset_heads','managed_dataset_versions','managed_dataset_operations','approvals','plan_versions'];
 const before=Object.fromEntries(tables.map(name=>[name,h.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));assert.ok(before.managed_dataset_versions.length>0);
 await request(h,run,input(h),'business');for(const name of tables)assert.deepEqual(h.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all(),before[name]);
});
test('an actual undeclared SQLite database disguised as a source file is never overwritten',async t=>{
 const {h,run,wave}=await interruptedMerge(t,'PARTIAL',{database:true}),body=input(h),before=treeHash(run.workspace),database=fs.readFileSync(resolve(run.workspace,'business.bin'));
 await assert.rejects(request(h,run,body,'database'),{code:'MERGE_RECOVERY_DATABASE_UNREGISTERED'});assert.equal(treeHash(run.workspace),before);assert.deepEqual(fs.readFileSync(resolve(run.workspace,'business.bin')),database);assert.equal(fs.readdirSync(wave.directory).filter(n=>n.startsWith('recovery_')).length,0);
});
