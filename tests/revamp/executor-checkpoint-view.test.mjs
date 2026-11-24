// OFFLINE response/view contracts only; not proof of a real recovery or native role.
import test from 'node:test';import assert from 'node:assert/strict';
import {readExecutorCheckpointPreview,readExecutorCheckpointResult,executorCheckpointConfirmation,executorCheckpointNotice,executorCheckpointError} from '../../dist/web/executor-checkpoint-view.js';
const view={schema:'dream-maker.executor-checkpoint-preview.v1',runId:'run_offline',runVersion:8,waveId:'executor_wave_offline',canonicalHash:'a'.repeat(64),checkpointHash:'b'.repeat(64),toolJournalHash:'c'.repeat(64),previewHash:'d'.repeat(64),tasks:[{taskId:'T1',sourceHash:'e'.repeat(64),fileCount:1,toolCalls:17,priorResultSealed:false}],canPrepare:true,requiresProcessCheck:true,modelsCalled:0,executionGranted:false,automaticResume:false};
test('the checkpoint dialog requires unchecked consent and describes unfinished files without promising completion',()=>{
 assert.deepEqual(readExecutorCheckpointPreview(view,view.runId),view);const html=executorCheckpointConfirmation(view);assert.match(html,/name="checkpointConsent" required/);assert.doesNotMatch(html,/\bchecked\b|[a-e]{64}/);assert.match(html,/未完成|未确认/);assert.match(html,/不会自动|不自动/);assert.match(html,/预算|费用/);
 assert.doesNotMatch(executorCheckpointConfirmation({...view,canPrepare:false}),/<form/);
 for(const patch of [{modelsCalled:1},{executionGranted:true},{automaticResume:true},{requiresProcessCheck:false},{runVersion:-1},{tasks:[{...view.tasks[0],fileCount:99999}]}])assert.throws(()=>readExecutorCheckpointPreview({...view,...patch},view.runId));
});
test('a result must bind the inspected checkpoint and pause without assuming completion or execution authority',()=>{
 const result={schema:'dream-maker.executor-checkpoint-result.v1',runId:view.runId,previousWaveId:view.waveId,newWaveId:'executor_wave_new',operationHash:'f'.repeat(64),checkpointHash:view.checkpointHash,canonicalHash:view.canonicalHash,runVersion:view.runVersion+1,state:'PAUSED',replayed:false,sourceCopiesRetained:true,taskCompletionAssumed:false,modelsCalled:0,executionGranted:false,automaticResume:false};
 assert.deepEqual(readExecutorCheckpointResult(result,view),result);
 for(const patch of [{state:'READY_FOR_DELIVERY'},{taskCompletionAssumed:true},{executionGranted:true},{automaticResume:true},{modelsCalled:1},{canonicalHash:'0'.repeat(64)},{runVersion:view.runVersion},{newWaveId:view.waveId}])assert.throws(()=>readExecutorCheckpointResult({...result,...patch},view));
});
test('the action appears only for a formal local interrupted task and errors use plain Chinese',()=>{
 assert.match(executorCheckpointNotice({executorCheckpointRequired:true},true),/data-action="executor-checkpoint"/);assert.equal(executorCheckpointNotice({executorCheckpointRequired:true},false),'');assert.equal(executorCheckpointNotice({executorCheckpointRequired:false},true),'');
 assert.match(executorCheckpointError('EXECUTOR_SLICE_RESULT_UNCERTAIN'),/文件|核对/);assert.match(executorCheckpointError('EXECUTOR_TASK_TOOL_LIMIT'),/上限/);assert.match(executorCheckpointError('EXECUTOR_CHECKPOINT_RESULT_UNCERTAIN'),/不能.*重/);
});
