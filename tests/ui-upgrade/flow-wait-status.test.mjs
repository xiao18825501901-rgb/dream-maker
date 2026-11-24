// Shared real view with explicit synthetic queue samples. No provider, model or product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {flowWorkspace} from '../../dist/web/flow-workspace-view.js';
const wait=(reason='MEMORY',age=0)=>({scope:'RESOURCE_OBSERVATION_ONLY',reason,sampledAt:new Date(Date.now()-age).toISOString(),availableMemoryMiB:1536,estimatedMemoryGapMiB:1024});
function view(observation=wait()){
 const run={id:'run_current',projectId:'project_current',specId:'spec_current',state:'IMPLEMENTING',tasks:[],flowName:'classic'};
 return {mode:'local',snapshot:{project:{id:'project_current',specId:'spec_current'},spec:{id:'spec_current',stale:false},runs:[run]},settings:null,
  dispatch:{executorSlots:2,active:[],quarantined:[],queued:[{projectId:'project_current',runId:'run_current',kind:'executor',dispatchId:'INTERNAL_DISPATCH_DO_NOT_DISPLAY',wait:observation}]}};
}
test('current memory wait is plain Chinese, estimated, and does not display internal IDs',()=>{
 const html=flowWorkspace(view());assert.match(html,/等待运行条件/);assert.match(html,/可用内存.*1\.5 GB/);assert.match(html,/估算.*1\.0 GB/);
 assert.match(html,/无需重复提交/);assert.match(html,/role="status"/);assert.doesNotMatch(html,/INTERNAL_DISPATCH_DO_NOT_DISPLAY|RESOURCE_OBSERVATION_ONLY/);
});
test('other projects, historical rounds and terminal runs do not borrow waiting evidence',()=>{
 for(const change of [v=>v.dispatch.queued[0].projectId='another',v=>v.dispatch.queued[0].runId='old',v=>v.snapshot.runs[0].state='ACCEPTED']){
  const v=view();change(v);assert.doesNotMatch(flowWorkspace(v),/等待运行条件/);
 }
});
test('stale and future samples do not promise a current memory threshold',()=>{
 for(const age of [60000,-60000]){const html=flowWorkspace(view(wait('MEMORY',age)));assert.match(html,/刷新.*确认/);assert.doesNotMatch(html,/1\.0 GB|1\.5 GB|条件满足后原队列会继续/);}
});
test('cleanup and ordinary capacity waits stay separate from memory and automatic recovery',()=>{
 const cleanup=flowWorkspace(view(wait('CLEANUP')));assert.match(cleanup,/清理.*核验/);assert.doesNotMatch(cleanup,/资源足够后.*自动继续/);
 const capacity=flowWorkspace(view(wait('CAPACITY')));assert.match(capacity,/其他任务.*运行资源/);assert.doesNotMatch(capacity,/还差.*GB/);
});
test('unknown diagnostics cannot inject HTML or invent service eligibility',()=>{
 const html=flowWorkspace(view({...wait(),reason:'<img src=x onerror=alert(1)>',availableMemoryMiB:NaN}));
 assert.doesNotMatch(html,/<img|onerror=|NaN|Infinity/);assert.match(html,/确认排队原因/);
 assert.doesNotMatch(html,/条件满足后原队列会继续/);
});
test('public and frontend-review fixtures retain an explicit synthetic label',()=>{
 for(const change of [v=>v.mode='public-demo',v=>v.presentation='frontend-review']){const v=view();change(v);assert.match(flowWorkspace(v),/演示排队/);}
});
