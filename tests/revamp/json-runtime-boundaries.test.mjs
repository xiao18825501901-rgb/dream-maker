// Offline regression of controller boundaries; no product credentials or native role acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {JsonDatasets,checkedJsonDocument} from '../../dist/server/json-data.js';
import {DraftStore} from '../../dist/web/dom.js';
import {inspectDispatchOwnership} from '../../dist/server/flow/ownership-recovery.js';
import {hash} from '../../dist/server/security.js';
import {harness,ready,root} from '../helpers.mjs';
import {fixedControllerCapacity,fixtureEntered} from '../fixtures/controller-capacity.mjs';
const actor='local-session:'+'e'.repeat(64),latch=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release:()=>release()};};

test('cancelling current data work waits for its signal/cleanup and preserves the delivered Flow',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h),initial=h.engine.create(p.id,s.hash,true);await h.engine.settled(initial.id);
 const project=h.store.project(p.id);project.mode='live';h.store.saveProject(project);const run=h.store.run(initial.id);run.mode='live';run.review={...run.review,source:'CODEX'};run.plan={...run.plan,dataRuntime:{schema:'dream-maker.json-runtime-plan.v1',protocol:'JSON_DOCUMENT_V1',runtime:'node',entry:'data.mjs',args:[]}};h.store.saveRun(run);
 const entered=latch(),gate=latch();let signal,returned=false;
 h.engine.nativeExecution={assertReady(){},executor(){throw Error('NO_MODEL');},verify(){throw Error('NO_MODEL');},async close(){},async runData(input){signal=input.signal;entered.release();await gate.promise;return {status:'EXECUTED',exitCode:0,sourceHash:run.treeHash,stdout:'{}'};}};
 const work=h.engine.executeJsonData(run.id,run.treeHash,0,true,hash('OFFLINE_CANCEL_DATA'),actor),rejected=assert.rejects(work);await fixtureEntered(entered.promise,work,gate.release);
 const cancel=h.engine.cancel(run.id).then(value=>{returned=true;return value;});
 try{await new Promise(r=>setImmediate(r));assert.equal(signal.aborted,true);assert.equal(returned,false);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');}
 finally{gate.release();await Promise.allSettled([cancel,rejected]);}
 assert.equal(h.engine.activeJobCount,0);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');assert.equal(new JsonDatasets(h.store,root).read(p.id).revision,0);
});

test('unrelated history cannot exhaust the bounded ownership proof for one dispatch',async t=>{
 const h=harness(t),{p}=await ready(h),runId='OFFLINE_RUN',dispatchId='dispatch_offline_recovery';
 h.store.tx(()=>{for(let i=0;i<4097;i++)h.store.record('OfflineHistory',p.id,runId,{i});});
 h.store.record('DispatchGranted',p.id,runId,{dispatchId,kind:'data-runtime',mode:'live'});
 h.store.record('OwnedProcessIntent',p.id,runId,{dispatchId,processId:'offline-not-launched'});
 h.store.record('OwnedProcessNotLaunched',p.id,runId,{dispatchId,processId:'offline-not-launched',noProcessCreated:true});
 const proof=await inspectDispatchOwnership(h.store,root,h.config,p.id,runId,dispatchId);assert.equal(proof.proven,true);assert.equal(proof.dispatchId,dispatchId);
});

test('oversized draft is rejected whole without silently replacing the prior complete draft',()=>{
 const values=new Map();globalThis.sessionStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 try{const drafts=new DraftStore('offline-draft',10);drafts.set('json','{"ok":1}');assert.equal(drafts.set('json','{"long":"cannot truncate this"}'),false);assert.equal(drafts.get('json'),'{"ok":1}');assert.equal(new DraftStore('offline-draft',10).get('json'),'{"ok":1}');}
 finally{delete globalThis.sessionStorage;}
});

test('valid JSON may exceed 110000 characters when formatted; its complete bounded draft survives reload',()=>{
 const value=checkedJsonDocument({items:Array.from({length:1000},()=>({text:'x'.repeat(70),n:1}))}),pretty=JSON.stringify(value,null,2);
 assert.ok(Buffer.byteLength(JSON.stringify(value))<=100000);assert.ok(pretty.length>110000);
 const values=new Map();globalThis.sessionStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 try{const drafts=new DraftStore('offline-json',512000);drafts.set('json',pretty);assert.deepEqual(JSON.parse(new DraftStore('offline-json',512000).get('json')),value);}
 finally{delete globalThis.sessionStorage;}
});
