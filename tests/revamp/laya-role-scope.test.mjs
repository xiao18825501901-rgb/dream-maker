// OFFLINE role-assistance contract and fixed Demo Engine. No real Laya/model/audit acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaBridge } from '../../dist/server/laya.js';
import { createLayaObserver } from '../../dist/server/laya-observation.js';
import { harness,ready } from '../helpers.mjs';
import {roleAssistanceBrief} from '../../dist/server/flow/role-assistance.js';
function fakeAdvice(h){let calls=0;const laya=new LayaBridge(()=>h.config,async(url,init)=>{calls++;if(url.endsWith('/info'))return{revision:'offline-revision'};const body=JSON.parse(init.body),role=body.state.role;return{answers:{route:{choice:role==='planner2'?'plan':role==='reviewer'?'security':'code',confidence:0.9}},usage:{truncated:false}};});return{laya,calls:()=>calls};}
test('a second executor gets its own explicitly assigned task while a sealed sibling remains running',async t=>{
 const h=harness(t),{p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);h.engine.pause(r.id);await h.engine.settled(r.id);
 const run=h.store.run(r.id);run.tasks=[{id:'A',title:'first copy',dependsOn:[],status:'running'},{id:'B',title:'second copy',dependsOn:[],status:'pending'}];
 const brief=roleAssistanceBrief(h.store,run,'executor','TASK_B',true,'B');assert.equal(brief.support.taskId,'B');assert.equal(brief.state.currentTask.id,'B');
 assert.throws(()=>roleAssistanceBrief(h.store,run,'executor','UNKNOWN',true,'missing'),{code:'LAYA_TASK_SCOPE_INVALID'});
});
test('a Flow-specific OFF can only narrow global Laya permission and sends no request',async t=>{
 const h=harness(t);h.config.laya.mode='advisory';const f=fakeAdvice(h);
 const decision=await f.laya.decide('executor','offline',{role:'executor'},['code','unknown'],undefined,{forceOff:true});
 assert.equal(f.calls(),0);assert.equal(decision.mode,'off');assert.equal(decision.adoption,'off');assert.equal(h.config.laya.mode,'advisory');
});
test('an explicitly ordinary Flow stays OFF for every role even when global advice is enabled',async t=>{
 const h=harness(t),{p,s}=await ready(h);h.config.laya.mode='advisory';h.config.laya.expectedRevision='offline-revision';const f=fakeAdvice(h);h.engine.laya=f.laya;
 const r=h.engine.create(p.id,s.hash,true,false,'classic');await h.engine.settled(r.id);
 assert.equal(h.store.run(r.id).state,'READY_FOR_DELIVERY');assert.equal(h.store.run(r.id).flowName,'classic');assert.equal(f.calls(),0);
 assert.ok(h.store.records(p.id,'LayaDecision').every(row=>row.data.mode==='off'&&row.data.adoption==='off'));
 assert.equal(h.config.laya.mode,'advisory');
});
test('an omitted flow choice cannot infer new Laya authorization from the global setting',async t=>{
 const h=harness(t),{p,s}=await ready(h);h.config.laya.mode='advisory';h.config.laya.expectedRevision='offline-revision';const f=fakeAdvice(h);h.engine.laya=f.laya;
 const run=h.engine.create(p.id,s.hash,true);await h.engine.settled(run.id);assert.equal(h.store.run(run.id).flowName,'classic');assert.equal(f.calls(),0);
});
test('enhanced role decisions have independent task/source scope and an advisory-only guide',async t=>{
 const h=harness(t),{p,s}=await ready(h);h.config.laya.mode='advisory';h.config.laya.expectedRevision='offline-revision';const f=fakeAdvice(h);h.engine.laya=f.laya;
 const r=h.engine.create(p.id,s.hash,true,false,'classic',{laya:true});await h.engine.settled(r.id);
 assert.equal(h.store.run(r.id).state,'READY_FOR_DELIVERY');const rows=h.store.records(p.id,'LayaDecision').map(row=>row.data);
 for(const role of ['planner2','executor','reviewer']){const data=rows.filter(v=>v.role===role);assert.ok(data.length);assert.ok(data.every(v=>v.support?.runId===r.id&&v.support.specHash===s.hash&&v.support.authority==='ADVISORY_ONLY'));assert.ok(data.some(v=>v.support.guide));}
 const executors=rows.filter(v=>v.role==='executor');assert.equal(new Set(executors.map(v=>v.inputHash)).size,executors.length,'separate task contexts cannot share a cached decision');
});
test('fallback and shadow do not count as advice applied to an engineering role',()=>{
 const observer=createLayaObserver();observer.record({role:'executor',mode:'advisory',adoption:'fallback'});observer.record({role:'reviewer',mode:'shadow',adoption:'shadow'});
 assert.equal(observer.summary().influencedTurns,0);assert.equal(observer.summary().fullyOff,false);
});
test('received advice is distinct from advice supplied to a completed real role',()=>{
 const observer=createLayaObserver();observer.record({role:'executor',mode:'advisory',adoption:'advisory',applied:false,runMode:'demo'});
 assert.equal(observer.summary().receivedAdviceTurns,1);assert.equal(observer.summary().influencedTurns,0);
 observer.record({role:'reviewer',mode:'advisory',adoption:'advisory',applied:true,runMode:'live'});assert.equal(observer.summary().influencedTurns,1);
});
test('unavailable enhancement stops honestly; a separate ordinary Flow can use the same approved plan',async t=>{
 const h=harness(t),{p,s}=await ready(h);h.config.laya.mode='advisory';let calls=0;h.engine.laya=new LayaBridge(()=>h.config,async()=>{calls++;throw Error('offline unavailable Laya');});
 const run=h.engine.create(p.id,s.hash,true,false,'classic',{laya:true});await h.engine.settled(run.id);
 assert.equal(h.store.run(run.id).state,'BLOCKED');assert.equal(h.store.run(run.id).reason,'LAYA_ROLE_SUPPORT_UNAVAILABLE');assert.equal(h.engine.dispatchStatus().quarantined.length,0);
 const used=calls;await h.engine.cancel(run.id);const ordinary=h.engine.create(p.id,s.hash,true,false,'classic');await h.engine.settled(ordinary.id);
 assert.equal(h.store.run(ordinary.id).state,'READY_FOR_DELIVERY');assert.equal(calls,used);assert.equal(h.store.run(run.id).flowConfig.laya.enabled,true);
});
test('persisted Laya summaries are scoped to one Flow and Demo advice is never counted as provided',async t=>{
 const h=harness(t),a=await ready(h),b=await ready(h);h.config.laya.mode='advisory';h.config.laya.expectedRevision='offline-revision';h.engine.laya=fakeAdvice(h).laya;
 const ordinary=h.engine.create(a.p.id,a.s.hash,true,false,'classic');await h.engine.settled(ordinary.id);
 const enhanced=h.engine.create(b.p.id,b.s.hash,true,false,'classic',{laya:true});await h.engine.settled(enhanced.id);
 const one=h.engine.layaObservation(ordinary.id),two=h.engine.layaObservation(enhanced.id);
 assert.equal(one.fullyOff,true);assert.equal(one.receivedAdviceTurns,0);assert.ok(two.receivedAdviceTurns>=3);assert.equal(two.influencedTurns,0);
 assert.equal(one.evidenceClass,'CONTROLLER_DECISIONS_NOT_NATIVE_HOOKS');
});
test('switching OFF discards a rejected in-flight advisory response as OFF, preserving dispatch mode history',async t=>{
 const h=harness(t);h.config.laya.mode='advisory';let started;const ready=new Promise(r=>started=r);const bridge=new LayaBridge(()=>h.config,async(_url,init)=>{started();await new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('offline aborted')),{once:true}));});
 const pending=bridge.decide('reviewer','offline',{role:'reviewer'},['security','unknown']);await ready;h.config.laya.mode='off';bridge.invalidate();const result=await pending;
 assert.equal(result.adoption,'off');assert.equal(result.mode,'advisory','an earlier enabled request must not be rewritten as a wholly OFF turn');
});
