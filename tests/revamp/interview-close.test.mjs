// Controller lifecycle with offline provider boundaries. No real account, model, native proof or fee.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Interviews} from '../../dist/server/interview.js';
import {createKimiAdmission} from '../../dist/server/kimi-admission.js';
import {DomainError,hash} from '../../dist/server/security.js';
import {harness,bindKimi} from '../helpers.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
function rig(t,respondToAbort=true){
 let interviews;t.after(async()=>{await interviews?.close();});const h=harness(t),started=deferred(),answer=deferred();bindKimi(h.config);
 h.config.kimi={enabled:true,baseUrl:'http://127.0.0.1:1',timeoutMs:5000,pollMs:10,tokenFile:'/OFFLINE_NOT_A_CREDENTIAL'};
 const admission=createKimiAdmission({schema:1,state:'OFF',source:'USER_ATTESTED',accountRef:'kimi:offline-lifecycle',observedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
 const body=JSON.stringify({topic:'goal',text:'仅用于取消边界的离线问题',suggestion:'',prerequisites:[],options:['甲','乙','丙','丁'].map((label,i)=>({id:'o'+i,label})),allowMultiple:false});
 const runner={run(input){started.resolve(input.signal);if(respondToAbort)input.signal.addEventListener('abort',()=>answer.reject(new DomainError('OFFLINE_REQUEST_ABORTED',409)),{once:true});return answer.promise;}};
 interviews=new Interviews(h.store,h.model,h.laya,()=>h.config,{runner,workspace:h.dir,instructions:'OFFLINE_LIFECYCLE_ONLY',admission});
 const p=interviews.create('关闭边界测试','关闭时保留未修改的需求','live');
 return {h,p,interviews,started,answer,release:()=>answer.resolve({text:body,sessionId:'OFFLINE_ONLY',usage:{role:'planner1',costUsd:null,source:'OFFLINE_TEST'},receipt:{turnId:'OFFLINE_TURN',reason:'completed',answerChars:body.length,answerHash:hash(body)}})};
}
test('closing aborts and joins a regular in-flight interview before returning, without appending a question',async t=>{
 const r=rig(t),request=r.interviews.next(r.p.id).then(value=>({value}),error=>({error}));let closing;
 try{const signal=await r.started.promise;closing=r.interviews.close();await closing;assert.equal(signal.aborted,true);assert.ok((await request).error);assert.equal(r.h.store.project(r.p.id).questions.length,0);assert.equal(r.interviews.activeOperations,0);}
 finally{r.answer.reject(new DomainError('OFFLINE_TEST_END',409));await Promise.allSettled([request,closing]);}
});
test('closing waits for an uncooperative boundary and rejects future model work instead of accepting its late answer',async t=>{
 const r=rig(t,false),request=r.interviews.next(r.p.id).then(value=>({value}),error=>({error}));let closing,closed=false;
 try{const signal=await r.started.promise;closing=r.interviews.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(signal.aborted,true);
  r.release();await closing;assert.ok((await request).error);assert.equal(r.h.store.project(r.p.id).questions.length,0);
  await assert.rejects(()=>r.interviews.next(r.p.id),{code:'INTERVIEW_CLOSED'});assert.equal(r.interviews.activeOperations,0);
 }finally{r.release();await Promise.allSettled([request,closing]);}
});
test('a pending helper decision cannot append a Demo question after interview shutdown has begun',async t=>{
 let interviews;t.after(async()=>{await interviews?.close();});const h=harness(t),started=deferred(),decision=deferred();
 const laya={decide(){started.resolve();return decision.promise;}};interviews=new Interviews(h.store,h.model,laya,()=>h.config);const p=interviews.create('本机关闭测试','不产生迟到问题','demo');
 const request=interviews.next(p.id).then(value=>({value}),error=>({error}));let closing,closed=false;
 try{await started.promise;closing=interviews.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  decision.resolve({role:'planner1',mode:'off',adoption:'off',label:null});await closing;assert.ok((await request).error);assert.equal(h.store.project(p.id).questions.length,0);assert.equal(interviews.activeOperations,0);
 }finally{decision.resolve({role:'planner1',mode:'off',adoption:'off',label:null});await Promise.allSettled([request,closing]);}
});
