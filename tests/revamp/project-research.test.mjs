import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, bindKimi } from '../helpers.mjs';
import { ProjectResearch } from '../../dist/server/research/project-research.js';
const empty=url=>Response.json(new URL(url).hostname==='api.github.com'?{items:[],incomplete_results:false}:[]);
function live(h,consent=true){bindKimi(h.config);return h.interviews.create('公开检索边界','不允许把这段原话发送为搜索词。','live',consent,'LOCAL_TEST_ACTOR');}
test('no consent and non-generic or secret terms stop locally before source requests',async t=>{
 const h=harness(t),p=live(h,false);let calls=0;const service=new ProjectResearch(h.store,h.dir,async u=>{calls++;return empty(u);});
 try{
  assert.throws(()=>service.start(p.id,['notes'],p.version),{code:'PUBLIC_RESEARCH_CONSENT_REQUIRED'});
  h.interviews.authorizeResearch(p.id,true,p.version,'LOCAL_TEST_ACTOR');
  for(const words of [['private company codename'],['owner@example.com'],['C:\\Users\\Hp'],['Bearer secret']])assert.throws(()=>service.start(p.id,words,h.store.project(p.id).version));
  assert.equal(calls,0);
 }finally{await service.close();}
});
test('a bounded two-platform result persists and repeats reuse the same completed operation',async t=>{
 const h=harness(t),p=live(h);const sent=[];const service=new ProjectResearch(h.store,h.dir,async(u,init)=>{sent.push({url:u,headers:init.headers});return empty(u);});
 try{
  const op=service.start(p.id,['notes','offline'],p.version);await service.settled(op.id);
  const saved=service.history(p.id)[0];assert.equal(saved.status,'COMPLETED');assert.equal(saved.result.status,'SEARCHED_WITHIN_BOUNDS');assert.equal(saved.requestCount,2);
  assert.deepEqual(saved.result.results.map(x=>x.platform),['github','gitlab']);assert.equal(saved.result.snapshots.length,0);
  assert.ok(sent.every(x=>!JSON.stringify(x).includes(p.idea)&&!('Authorization' in x.headers)));
  assert.equal(service.start(p.id,['notes','offline'],p.version).id,op.id);assert.equal(sent.length,2);
 }finally{await service.close();}
});
test('source failure is unavailable, not an empty successful search or a proof of no repositories',async t=>{
 const h=harness(t),p=live(h);const service=new ProjectResearch(h.store,h.dir,async()=>{throw Error('DO_NOT_LOG_RAW_NETWORK_ERROR');});
 try{const op=service.start(p.id,['notes'],p.version);await service.settled(op.id);const result=service.history(p.id)[0];assert.equal(result.result.status,'UNAVAILABLE');assert.equal(result.result.failures.length,2);assert.doesNotMatch(JSON.stringify(result),/DO_NOT_LOG/);}finally{await service.close();}
});
test('changing an input during source reads rejects late research instead of committing it into the new plan',async t=>{
 const h=harness(t),p=live(h);let release,started;const entering=new Promise(r=>started=r),gate=new Promise(r=>release=r);let calls=0;
 const service=new ProjectResearch(h.store,h.dir,async u=>{if(calls++===0){started();await gate;}return empty(u);});
 try{const op=service.start(p.id,['notes'],p.version);await entering;const changed=h.store.project(p.id);changed.idea+=' 新增要求';h.store.saveProject(changed);release();await service.settled(op.id);const saved=service.history(p.id)[0];assert.equal(saved.status,'FAILED');assert.equal(saved.code,'RESEARCH_INPUT_STALE');assert.equal(saved.result,undefined);}finally{release();await service.close();}
});
test('cancel waits for the actual read to settle and a restart never silently reruns an uncertain operation',async t=>{
 const h=harness(t),p=live(h);let started;const entering=new Promise(r=>started=r);
 const service=new ProjectResearch(h.store,h.dir,async(_u,init)=>new Promise((_res,rej)=>{started();init.signal.addEventListener('abort',()=>rej(Error('cancelled')),{once:true});}));
 try{const op=service.start(p.id,['notes'],p.version);await entering;const restored=new ProjectResearch(h.store,h.dir,async()=>{throw Error('must not run');});assert.equal(restored.history(p.id)[0].status,'RESULT_UNCERTAIN');assert.throws(()=>restored.start(p.id,['notes'],p.version),{code:'RESEARCH_RECONCILIATION_REQUIRED'});await restored.close();assert.equal((await service.cancel(p.id,op.id)).status,'CANCELLED');}finally{await service.close();}
});
