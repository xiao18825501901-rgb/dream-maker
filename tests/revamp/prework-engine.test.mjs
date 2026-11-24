import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';
import {captureSource} from '../../dist/server/review-packet.js';
import {installPrework,readPrework,assertPreworkDispatch} from '../../dist/server/prework/runtime.js';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {codexReviewOutputSchema} from '../../dist/server/engine.js';

test('PW live reviewer output may carry strict Prework coverage; non-Prework output stays closed',()=>{
 const base=codexReviewOutputSchema(false);
 assert.deepEqual(Object.keys(base.properties),['verdict','findings']);
 assert.equal(base.additionalProperties,false);
 const prework=codexReviewOutputSchema(true);
 assert.deepEqual(Object.keys(prework.properties),['verdict','findings','preworkCoverage']);
 assert.equal(prework.additionalProperties,false);
 assert.deepEqual(prework.properties.preworkCoverage.items.required,['requirementId','artifactPaths','caseIds','acceptanceIds']);
 assert.deepEqual(prework.required,['verdict','findings','preworkCoverage']);
 assert.equal(prework.properties.preworkCoverage.items.additionalProperties,false);
});
test('PW original Engine refuses an unplanned executor before queue, counter or model effects',async t=>{
 const h=harness(t);const{p,s}=await ready(h);h.engine.launch=()=>{};
 const r=h.engine.create(p.id,s.hash,true);const before=h.store.run(r.id),count=h.store.records(p.id,'DispatchQueued').length;
 await assert.rejects(h.engine.role(r,'executor','SYNTHETIC',new AbortController().signal),e=>e.code==='PREWORK_CONTRACT_REQUIRED');
 assert.equal(h.store.run(r.id).calls,before.calls);assert.equal(h.store.records(p.id,'DispatchQueued').length,count);
});
test('PW contract survives original SQLite close/reopen and immutable records reject update',async t=>{
 const h=harness(t);const{p,s}=await ready(h);h.engine.launch=()=>{};let r=h.engine.create(p.id,s.hash,true);
 h.store.record('SourceSnapshot',p.id,r.id,captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'BASELINE'));
 r.tasks=[{id:'T1',title:'synthetic',dependsOn:[],requirementIds:s.requirements.map(x=>x.id),acceptance:['synthetic acceptance'],writePaths:['main.mjs'],status:'pending'}];r.phase=r.state='IMPLEMENTING';r.treeHash=captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'BASELINE').treeHash;h.store.saveRun(r);
 const c=installPrework(h.store,r.id);r=h.store.run(r.id);assert.equal(assertPreworkDispatch(h.store,r,'T1').contract.contractId,c.contractId);
 assert.deepEqual(readPrework(h.store,r),c);assert.throws(()=>h.store.db.prepare("UPDATE records SET data='{}' WHERE id=?").run(r.prework.recordId));
 const {Store}=await import('../../dist/server/store.js');const second=new Store(h.store.path);try{assert.deepEqual(readPrework(second,second.run(r.id)),c);}finally{second.close();}
});
test('PW full original Demo loop retains synthetic scope and saves the same contract through closeout', {timeout:30000},async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);const{p,s}=await ready(h);const r=h.engine.create(p.id,s.hash,true);
 await h.engine.settled(r.id);const current=h.store.run(r.id);
 assert.equal(current.state,'READY_FOR_DELIVERY',current.reason??'not delivered');
 assert.ok(current.prework);const rows=h.store.records(p.id,'PreworkCloseout').filter(x=>x.runId===r.id);
 assert.equal(rows.length,1);assert.equal(rows[0].data.contractId,current.prework.contractId);assert.equal(rows[0].data.scope,'SYNTHETIC_DEMO_NOT_LIVE');
});
