// Synthetic original SQLite transaction test; no model, Native grant or formal DB.
import test from 'node:test';import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';
import {commitRoleResult} from '../../dist/server/flow/role-result.js';
import {hash} from '../../dist/server/security.js';
import {captureSource} from '../../dist/server/review-packet.js';
import {installPrework} from '../../dist/server/prework/runtime.js';

test('PW contract installation joins and rolls back with original continuation transaction',async t=>{
 const h=harness(t),{p,s}=await ready(h);h.engine.launch=()=>{};const created=h.engine.create(p.id,s.hash,true),r=h.store.run(created.id);
 const baseline=captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'BASELINE');
 r.state=r.phase='IMPLEMENTING';r.tasks=[{id:'T1',title:'OFFLINE_ATOMIC_PREWORK',dependsOn:[],requirementIds:s.requirements.map(v=>v.id),acceptance:['OFFLINE'],writePaths:['main.mjs'],status:'pending'}];r.treeHash=baseline.treeHash;h.store.saveRun(r);h.store.record('SourceSnapshot',p.id,r.id,baseline);
 const before=hash(h.store.run(r.id)),recordCount=h.store.records(p.id).length;
 assert.throws(()=>h.store.tx(()=>{installPrework(h.store,r.id);throw Error('OFFLINE_OUTER_TRANSACTION_FAILURE');}),/OFFLINE_OUTER_TRANSACTION_FAILURE/);
 assert.equal(hash(h.store.run(r.id)),before);assert.equal(h.store.records(p.id).length,recordCount);
 assert.equal(h.store.records(p.id,'PreworkContract').length,0);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM prework_record_identities').get().n,0);
});
test('PW failed result publication rolls back role/session usage and package result together',async t=>{
 const h=harness(t);const{p,s}=await ready(h);h.engine.launch=()=>{};
 const created=h.engine.create(p.id,s.hash,true),r=h.store.run(created.id);r.state=r.phase='IMPLEMENTING';h.store.saveRun(r);
 h.store.record('DispatchGranted',p.id,r.id,{dispatchId:'OFFLINE_DISPATCH',generation:'OFFLINE_GENERATION',kind:'executor',mode:'demo'});
 h.store.record('DispatchFinished',p.id,r.id,{dispatchId:'OFFLINE_DISPATCH',generation:'OFFLINE_GENERATION',outcome:'COMPLETED',cleanupReturned:true});
 const before=hash(h.store.run(r.id));
 assert.throws(()=>commitRoleResult(h.store,h.store.run(r.id),'executor',{result:{mode:'demo'},dispatchId:'OFFLINE_DISPATCH',generation:'OFFLINE_GENERATION',phase:'IMPLEMENTING'},()=>{
  h.store.record('PreworkPackageResult',p.id,r.id,{dispatchId:'OFFLINE_DISPATCH',scope:'SYNTHETIC_ROLLBACK_TEST'});throw Error('SYNTHETIC_PUBLICATION_FAILURE');
 }),/SYNTHETIC_PUBLICATION_FAILURE/);
 assert.equal(hash(h.store.run(r.id)),before);assert.equal(h.store.records(p.id,'PreworkPackageResult').length,0);assert.equal(h.store.owns(p.id,r.id),true);
});
