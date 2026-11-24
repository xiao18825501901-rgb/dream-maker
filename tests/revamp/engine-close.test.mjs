// Offline cancellation boundaries, actual Engine/Store/dispatch journal. No model or OS worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../../dist/server/store.js';
import {Engine} from '../../dist/server/engine.js';
import {Interviews} from '../../dist/server/interview.js';
import {LayaBridge} from '../../dist/server/laya.js';
import {defaults} from '../../dist/server/config.js';
import {root,ready} from '../helpers.mjs';
const deferred=()=>{let resolve;const promise=new Promise(ok=>{resolve=ok;});return {promise,resolve};};

test('one uncertain cancellation cannot let close finish before every owned job has aborted and joined',async t=>{
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(resolve(parent,'engine-close-'));
 const store=new Store(resolve(dir,'state.sqlite')),config=structuredClone(defaults),laya=new LayaBridge(()=>config),interviews=new Interviews(store,{},laya,()=>config),engine=new Engine(store,laya,()=>config,root,dir,0);
 t.after(async()=>{await interviews.close();await engine.dispatch.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const h={store,config,laya,interviews,engine},runs=[];
 for(let i=0;i<2;i++){const {p,s}=await ready(h),run=engine.create(p.id,s.hash,true);engine.pause(run.id);await engine.settled(run.id);runs.push(run);}
 await assert.rejects(engine.dispatch.run({projectId:runs[0].projectId,runId:runs[0].id,kind:'route',mode:'demo',signal:new AbortController().signal},async()=>{throw Error('OFFLINE_UNKNOWN_CLEANUP');}),{code:'PROCESS_CLEANUP_UNPROVEN'});
 const hold=deferred(),controllers=runs.map(()=>new AbortController()),jobs=runs.map((run,i)=>hold.promise.then(()=>{store.record('OfflineCloseBoundary',run.projectId,run.id,{aborted:controllers[i].signal.aborted});}));
 runs.forEach((run,i)=>engine.jobs.set(run.id,{controller:controllers[i],promise:jobs[i]}));
 let settled=false,early,aborted;const closing=engine.close().then(()=>{settled=true;},error=>{settled=true;return error;});
 try{await new Promise(ok=>setImmediate(ok));early=settled;aborted=controllers.map(controller=>controller.signal.aborted);}
 finally{hold.resolve();await Promise.allSettled(jobs);}
 const failure=await closing;runs.forEach(run=>engine.jobs.delete(run.id));
 assert.equal(early,false,'failure from one cancellation must not cut short other owned cleanup');assert.deepEqual(aborted,[true,true]);assert.equal(failure?.code,'ENGINE_CLOSE_UNCERTAIN');
 assert.equal(engine.dispatch.hasUncertain(runs[0].id),true);assert.equal(store.owns(runs[0].projectId,runs[0].id),true);assert.equal(store.records(runs[1].projectId,'OfflineCloseBoundary').length,1);
});
