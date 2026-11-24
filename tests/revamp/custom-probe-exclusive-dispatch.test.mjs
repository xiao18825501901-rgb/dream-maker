// OFFLINE original Store/Dispatch, synthetic capacities/callbacks only. No OS/model proof.
import test from 'node:test';import assert from 'node:assert/strict';
import {harness} from '../helpers.mjs';
import {EngineDispatch} from '../../dist/server/flow/dispatch.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const probe=(signal,id='ONE')=>({projectId:null,runId:null,kind:'executor',mode:'live',purpose:'CUSTOM_ROLE_PROBE',acceptanceId:'custom_probe_OFFLINE_EXCLUSIVE_'+id,executorRoleId:'executor-one',signal});
function rig(t,usable=1024){const h=harness(t);let memory=usable;const q=new EngineDispatch(h.store,{isCurrent:()=>true,measure:()=>({cpu:4,memoryMiB:memory,availableMemoryMiB:memory+1024,sampledAt:new Date().toISOString()})});t.after(()=>q.close());return{h,q,setMemory:value=>{memory=value;}};}
test('a solitary no-tool qualification can use its full1GiB demand without unused parallel-supervisor headroom',async t=>{const {h,q}=rig(t),controller=new AbortController(),entered=deferred();const work=q.run(probe(controller.signal),async ctl=>{entered.resolve(true);ctl.confirmCleanup();return'OFFLINE_NO_MODEL';});work.catch(()=>{});const started=await Promise.race([entered.promise,pause(100).then(()=>false)]);if(!started)controller.abort();const result=await work.catch(e=>e.code);assert.equal(started,true,'SINGLETON_MINIMUM_PROBE_STILL_WAITED_FOR_UNUSED_SUPERVISOR');assert.equal(result,'OFFLINE_NO_MODEL');const queued=JSON.parse(h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchQueued'").get().data);assert.equal(queued.demand.memoryMiB,1024);assert.equal(h.store.projects().length,0);assert.equal(h.store.runs().length,0);});
test('ordinary engineering acceptance keeps the parallel supervisor reservation',async t=>{const {q}=rig(t),controller=new AbortController();let starts=0;const work=q.run({projectId:null,runId:null,kind:'executor',mode:'live',purpose:'DSH_ENGINEERING_ACCEPTANCE',acceptanceId:'dsh_acceptance_OFFLINE_KEEPS_RESERVE',signal:controller.signal},async ctl=>{starts++;ctl.confirmCleanup();});work.catch(()=>{});await pause(30);controller.abort();await assert.rejects(work,{code:'RUN_CANCELLED'});assert.equal(starts,0);});
test('minimum probe still cannot start below its full1GiB plus the unchanged1GiB OS margin',async t=>{const {q}=rig(t,1023),controller=new AbortController();let starts=0;const work=q.run(probe(controller.signal,'LOW'),async ctl=>{starts++;ctl.confirmCleanup();});work.catch(()=>{});await pause(30);controller.abort();await assert.rejects(work,{code:'RUN_CANCELLED'});assert.equal(starts,0);});
test('new model work cannot run concurrently with a probe admitted without spare supervisor memory',async t=>{const {q,setMemory}=rig(t),controller=new AbortController(),entered=deferred(),release=deferred();const first=q.run(probe(controller.signal,'HELD'),async ctl=>{entered.resolve();await release.promise;ctl.confirmCleanup();});first.catch(()=>{});if(!await Promise.race([entered.promise.then(()=>true),pause(100).then(()=>false)])){controller.abort();await first.catch(()=>{});assert.fail('EXCLUSIVE_PROBE_NOT_GRANTED');}
 setMemory(8192);let secondStarts=0;const second=q.run({projectId:null,runId:null,kind:'planner2',mode:'live',purpose:'CUSTOM_ROLE_PROBE',acceptanceId:'custom_probe_OFFLINE_AFTER_EXCLUSIVE',signal:controller.signal},async ctl=>{secondStarts++;ctl.confirmCleanup();});second.catch(()=>{});await pause(30);assert.equal(secondStarts,0);release.resolve();await first;await second;assert.equal(secondStarts,1);
});

test('2047/2048 minimum and2559/2560 ordinary free-MiB boundaries preserve original demands',async t=>{
 for(const minimum of [true,false]){
  const{h,q,setMemory}=rig(t,minimum?1023:1535),c=new AbortController();let starts=0;
  const request=minimum?probe(c.signal,'BOUNDARY'):{projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',kind:'executor',mode:'live',signal:c.signal};
  const work=q.run(request,async ctl=>{starts++;ctl.confirmCleanup();});work.catch(()=>{});await pause(20);assert.equal(starts,0);
  setMemory(minimum?1024:1536);q.poke();await work;assert.equal(starts,1);
  const grant=JSON.parse(h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchGranted'").get().data);
  assert.equal(grant.resourceMode,minimum?'EXCLUSIVE_MINIMUM_PROBE':undefined);
  assert.equal(grant.resources.availableMemoryMiB,minimum?2048:2560);await q.close();
 }
});
test('two queued probes cannot borrow singleton memory even after capacity increases to2048MiB',async t=>{
 const{q,setMemory}=rig(t,0),c=new AbortController();let starts=0;
 const work=[q.run(probe(c.signal,'MULTI1'),async ctl=>{starts++;ctl.confirmCleanup();}),q.run(probe(c.signal,'MULTI2'),async ctl=>{starts++;ctl.confirmCleanup();})];work.forEach(p=>p.catch(()=>{}));
 setMemory(1024);q.poke();await pause(20);assert.equal(starts,0);c.abort();await Promise.all(work.map(p=>assert.rejects(p,{code:'RUN_CANCELLED'})));
});
test('ordinary requests cannot claim the internal exclusive resource mode',async t=>{
 const{q}=rig(t),c=new AbortController();let calls=0;
 const work=q.run({projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',kind:'executor',mode:'live',signal:c.signal,resourceMode:'EXCLUSIVE_MINIMUM_PROBE'},async ctl=>{calls++;ctl.confirmCleanup();});work.catch(()=>{});
 await pause(20);assert.equal(calls,0);c.abort();await assert.rejects(work,{code:'RUN_CANCELLED'});
});
test('Custom probe at usable1535 is exclusive but at1536 retains ordinary scheduling',async t=>{
 for(const memory of [1535,1536]){
  const{h,q}=rig(t,memory),c=new AbortController();await q.run(probe(c.signal,'UPPER_'+memory),async ctl=>ctl.confirmCleanup());
  const grant=JSON.parse(h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchGranted'").get().data),queued=JSON.parse(h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchQueued'").get().data);
  assert.equal(grant.resourceMode,memory===1535?'EXCLUSIVE_MINIMUM_PROBE':undefined);assert.equal(queued.demand.memoryMiB,1024);await q.close();
 }
});
test('mixed pending ordinary work and probe cannot borrow singleton memory',async t=>{
 const{q,setMemory}=rig(t,0),c=new AbortController();let starts=0;const action=async ctl=>{starts++;ctl.confirmCleanup();};
 const work=[q.run(probe(c.signal,'MIXED'),action),q.run({projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',kind:'executor',mode:'live',signal:c.signal},action)];work.forEach(p=>p.catch(()=>{}));
 setMemory(1024);q.poke();await pause(20);assert.equal(starts,0);c.abort();await Promise.all(work.map(p=>assert.rejects(p,{code:'RUN_CANCELLED'})));
});
for(const kind of ['planner2','reviewer','executor','verifier','data-runtime','route'])test('exclusive probe blocks later '+kind+' even when free memory grows',async t=>{
 const{h,q,setMemory}=rig(t),c=new AbortController(),release=deferred();t.after(()=>release.resolve());
 const first=q.run(probe(c.signal,'HOLD_'+kind),async ctl=>{await release.promise;ctl.confirmCleanup();});first.catch(()=>{});
 assert.equal(q.snapshot().active.length,1);setMemory(8192);let later=0;
 const next=q.run({projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',kind,mode:'live',signal:c.signal},async ctl=>{later++;ctl.confirmCleanup();});next.catch(()=>{});
 await pause(20);assert.equal(later,0);assert.equal(h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='DispatchGranted'").get().n,1);
 release.resolve();await first;await next;assert.equal(later,1);
});
test('active work prevents the singleton shortcut',async t=>{
 const{q,setMemory}=rig(t,8192),c=new AbortController(),release=deferred();t.after(()=>release.resolve());
 const first=q.run({projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',kind:'verifier',mode:'live',signal:c.signal},async ctl=>{await release.promise;ctl.confirmCleanup();});first.catch(()=>{});
 setMemory(1024);let starts=0;const next=q.run(probe(c.signal,'ACTIVE'),async ctl=>{starts++;ctl.confirmCleanup();});next.catch(()=>{});await pause(20);assert.equal(starts,0);
 c.abort();release.resolve();await first.catch(()=>{});await assert.rejects(next,{code:'RUN_CANCELLED'});
});
for(const failure of ['cleanup','journal'])test('exclusive '+failure+' failure retains quarantine after reconstruction',async t=>{
 const{h,q}=rig(t),c=new AbortController(),original=h.store.record.bind(h.store);
 if(failure==='journal')h.store.record=(kind,...args)=>{if(kind==='DispatchFinished')throw Error('OFFLINE_JOURNAL');return original(kind,...args);};
 await assert.rejects(q.run(probe(c.signal,'FAIL_'+failure),async ctl=>{if(failure==='journal')ctl.confirmCleanup();}),{code:'PROCESS_CLEANUP_UNPROVEN'});
 assert.equal(q.snapshot().quarantined.length,1);h.store.record=original;const reopened=new EngineDispatch(h.store,{isCurrent:()=>true});t.after(()=>reopened.close());assert.equal(reopened.snapshot().quarantined.length,1);
});
test('cancelled exclusive probe stays active until its cleanup callback ends',async t=>{
 const{q,setMemory}=rig(t),c=new AbortController(),release=deferred();t.after(()=>release.resolve());
 const first=q.run(probe(c.signal,'CANCEL'),async ctl=>{await release.promise;ctl.confirmCleanup();});const rejection=assert.rejects(first,{code:'RUN_CANCELLED'});c.abort(Object.assign(Error('OFFLINE_CANCEL'),{code:'RUN_CANCELLED'}));setMemory(8192);
 let later=0;const next=q.run({projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',kind:'route',mode:'live',signal:new AbortController().signal},async ctl=>{later++;ctl.confirmCleanup();});next.catch(()=>{});
 await pause(20);assert.equal(later,0);release.resolve();await rejection;await next;assert.equal(later,1);
});
