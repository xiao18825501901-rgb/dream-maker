// OFFLINE Engine/Store boundaries only. Synthetic route and role; never a model proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';
import {Engine} from '../../dist/server/engine.js';
import {EngineDispatch} from '../../dist/server/flow/dispatch.js';
import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import {hash,DomainError} from '../../dist/server/security.js';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,20));
function fixture(t,{routeError,inspectionError,missingInspector=false,modelError,inspectionGate,evidence={scope:'OWNED_CLASH_JOURNALS',pendingLocks:0}}={}){
 const h=harness(t),entered=defer(),release=defer(),inspectionEntered=defer();let signs=0,inspections=0;
 h.config.clash.enabled=true;
 const preparation={role:'executor',roleId:'executor-1',bindingHash:hash('OFFLINE_BINDING'),configurationHash:hash('OFFLINE_CONFIG'),expiresAt:new Date(Date.now()+60000).toISOString()};
 const route={async withRun(id,signal,action){let value,error;try{value=await action();}catch(e){error=e;}finally{entered.resolve();await release.promise;}if(routeError)throw routeError;if(error)throw error;return value;},
  async assertRecovered(){inspections++;inspectionEntered.resolve();if(inspectionGate)await inspectionGate.promise;if(inspectionError)throw inspectionError;return evidence;},childEnvironment:x=>x};
 if(missingInspector)delete route.assertRecovered;
 const native={async close(){},customProbePreparation:()=>({...preparation}),async prepareCustomProbeEvidence(){},
  async executeCustomRoleProbe(){assert.ok(currentProcessOwnership());if(modelError)throw modelError;return{attemptId:'OFFLINE',bindingHash:preparation.bindingHash,observation:{sessionId:'OFFLINE'}};},
  completeCustomRoleProbe(input){signs++;return{evidenceId:'OFFLINE_ONLY',probeId:input.probeId};},customProbeReceipt(){throw Error('NOT_REPLAY');}};
 const engine=new Engine(h.store,h.laya,()=>h.config,h.dir,h.dir,0,native,route);
 engine.dispatch.binding.measure=()=>({cpu:4,memoryMiB:1024,availableMemoryMiB:2048,sampledAt:new Date().toISOString()});
 t.after(async()=>{release.resolve();inspectionGate?.resolve();if(engine.dispatch.snapshot().quarantined.length)await assert.rejects(engine.close(),{code:'ENGINE_CLOSE_UNCERTAIN'});else await engine.close();});
 const selection={projectId:'OFFLINE',specHash:hash('OFFLINE_SPEC'),profileHash:hash('OFFLINE_PROFILE'),preparation:{identityHash:hash('OFFLINE_ID'),contentHash:hash('OFFLINE_PREP')}};
 return{h,engine,entered,release,inspectionEntered,selection,signs:()=>signs,inspections:()=>inspections};
}
test('route restoration stays inside original Dispatch until verified journal absence',async t=>{
 const x=fixture(t);
 const call=x.engine.probeCustomRole(x.selection,'executor-1','OFFLINE_ROUTE_LIFETIME',true);call.catch(()=>{});await x.entered.promise;
 assert.equal(x.engine.dispatch.snapshot().active.length,1,'ROUTE_RESTORATION_ESCAPED_DISPATCH');
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='DispatchFinished'").get().n,0);
 assert.equal(x.signs(),0);x.release.resolve();await call;assert.equal(x.inspections(),1);assert.equal(x.signs(),1);
});
for(const scenario of ['restore-fails','raw-remove-fails','retained-lock','missing-inspector'])test('route '+scenario+' retains quarantine and cannot sign',async t=>{
 const x=fixture(t,{routeError:scenario==='restore-fails'?new DomainError('CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY',409):scenario==='raw-remove-fails'?Object.assign(Error('OFFLINE_FS'),{code:'EACCES'}):undefined,
 inspectionError:scenario==='retained-lock'?new DomainError('CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY',409):undefined,missingInspector:scenario==='missing-inspector'});
 const call=x.engine.probeCustomRole(x.selection,'executor-1','OFFLINE_ROUTE_'+scenario,true);const rejected=assert.rejects(call,{code:'PROCESS_CLEANUP_UNPROVEN'});
 await x.entered.promise;x.release.resolve();await rejected;assert.equal(x.signs(),0);assert.equal(x.engine.dispatch.snapshot().quarantined.length,1);
 const reopened=new EngineDispatch(x.h.store,{isCurrent:()=>true});assert.equal(reopened.snapshot().quarantined.length,1);await reopened.close();
});
test('model failure with proven route release settles cleanly without qualification',async t=>{
 const x=fixture(t,{modelError:new DomainError('MODEL_GATEWAY_FAILED',409)});
 const call=x.engine.probeCustomRole(x.selection,'executor-1','OFFLINE_MODEL_FAILURE_ROUTE',true);const rejected=assert.rejects(call,{code:'MODEL_GATEWAY_FAILED'});
 await x.entered.promise;x.release.resolve();await rejected;assert.equal(x.signs(),0);assert.equal(x.inspections(),1);assert.equal(x.engine.dispatch.snapshot().quarantined.length,0);
});
test('cancellation during restoration does not release the exclusive grant early',async t=>{
 const x=fixture(t),controller=new AbortController();
 const call=x.engine.probeCustomRole(x.selection,'executor-1','OFFLINE_ROUTE_CANCEL',true,controller.signal);call.catch(()=>{});await x.entered.promise;
 controller.abort();await tick();assert.equal(x.engine.dispatch.snapshot().active.length,1);assert.equal(x.signs(),0);x.release.resolve();await assert.rejects(call);assert.equal(x.signs(),0);
});
test('exclusive Engine probe holds later work through route restoration and separate journal inspection',async t=>{
 const inspectionGate=defer(),x=fixture(t,{inspectionGate});
 // A real test-Store project/lease/current run; suppress only its automatic
 // offline Demo loop so the unrelated callback can be queued deliberately.
 const prepared=await ready(x.h),launch=x.engine.launch;x.engine.launch=()=>{};
 let nextRun;try{nextRun=x.engine.create(prepared.p.id,prepared.s.hash,true);}finally{x.engine.launch=launch;}
 const call=x.engine.probeCustomRole(x.selection,'executor-1','OFFLINE_EXCLUSIVE_ROUTE_AND_INSPECTION',true);call.catch(()=>{});await x.entered.promise;
 const grant=JSON.parse(x.h.store.db.prepare("SELECT data FROM records WHERE kind='DispatchGranted'").get().data);assert.equal(grant.resourceMode,'EXCLUSIVE_MINIMUM_PROBE');
 x.engine.dispatch.binding.measure=()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:9216,sampledAt:new Date().toISOString()});let later=0;
 const next=x.engine.dispatch.run({projectId:nextRun.projectId,runId:nextRun.id,kind:'route',mode:nextRun.mode,signal:new AbortController().signal},async ctl=>{later++;ctl.confirmCleanup();});next.catch(()=>{});
 const held=()=>{assert.equal(later,0);assert.equal(x.engine.dispatch.snapshot().queued.length,1);assert.equal(x.signs(),0);assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='DispatchFinished'").get().n,0);};
 await tick();held();x.release.resolve();await x.inspectionEntered.promise;await tick();held();inspectionGate.resolve();await call;await next;assert.equal(later,1);assert.equal(x.signs(),1);
});
for(const kind of ['raw-read-error','malformed-evidence'])test('exclusive probe refuses '+kind+' from route inspector',async t=>{
 const x=fixture(t,{inspectionError:kind==='raw-read-error'?Object.assign(Error('OFFLINE_READ'),{code:'EIO'}):undefined,evidence:{scope:'UNVERIFIED',pendingLocks:0}});
 const call=x.engine.probeCustomRole(x.selection,'executor-1','OFFLINE_INSPECT_'+kind,true);const rejected=assert.rejects(call,{code:'PROCESS_CLEANUP_UNPROVEN'});await x.entered.promise;x.release.resolve();await rejected;
 assert.equal(x.signs(),0);assert.equal(x.engine.dispatch.snapshot().quarantined.length,1);
});
