// OFFLINE original Store/files fixture. Not a real Executor, native proof or acceptance.
import {mkdirSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {harness,ready} from '../helpers.mjs';import {ExecutorSlices} from '../../dist/server/flow/executor-slices.js';
import {assertOfflineHarness,installOfflinePrework} from './offline-prework.mjs';
import {hash} from '../../dist/server/security.js';import {treeHash} from '../../dist/server/workspace.js';
export async function interruptedTask(t,options={}){
 const h=options.h??harness(t);assertOfflineHarness(h);
 const {p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);h.engine.pause(created.id);await h.engine.settled(created.id);
 const run=h.store.run(created.id);run.state=run.phase='IMPLEMENTING';run.tasks=['A','B'].map((id,i)=>({id,title:id,status:'pending',dependsOn:[],requirementIds:s.requirements.map(v=>v.id),acceptance:['offline fixture'],writePaths:[i?'b.txt':'a.txt']}));
 mkdirSync(run.workspace,{recursive:true});writeFileSync(resolve(run.workspace,'a.txt'),'a0');writeFileSync(resolve(run.workspace,'b.txt'),'b0');run.treeHash=treeHash(run.workspace);h.store.saveRun(run);
 installOfflinePrework(h,run.id);
 const slices=new ExecutorSlices(h.store,h.dir),wave=slices.prepare(run.id),a=wave.assignments[0];
 const current=h.store.run(run.id);current.tasks[0].status='running';h.store.saveRun(current);
 const intent=h.store.record('ToolIntent',p.id,run.id,{tool:'desk_write',sliceId:a.id,specHash:s.hash,sourceHash:treeHash(a.workspace),requestHash:hash('OFFLINE_WRITE')});
 writeFileSync(resolve(a.workspace,'a.txt'),'a1');h.store.record('ToolResult',p.id,run.id,{intentId:intent,tool:'desk_write',sliceId:a.id,specHash:s.hash,status:'COMPLETE',sourceHash:treeHash(a.workspace),responseHash:hash('OFFLINE_RESPONSE')});
 const blocked=h.store.run(run.id);blocked.state='BLOCKED';blocked.reason='EXECUTOR_SLICE_RESULT_UNCERTAIN';h.store.saveRun(blocked);
 return{h,p,s,run:blocked,slices,wave,a};
}
