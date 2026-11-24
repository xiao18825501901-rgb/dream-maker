import test from 'node:test';
import assert from 'node:assert/strict';
import {readMergeRecoveryPreview,readMergeRecoveryResult,mergeRecoveryConfirmation,mergeRecoveryNotice,mergeRecoveryError,sourceTaskLabel} from '../../dist/web/merge-recovery-view.js';
const preview={schema:'dream-maker.merge-recovery-preview.v1',runId:'run_offline',waveId:'executor_wave_offline',previewHash:'a'.repeat(64),sourceState:'PARTIALLY_PUBLISHED',source:{baseHash:'b'.repeat(64),combinedHash:'c'.repeat(64),currentHash:'d'.repeat(64)},changedFiles:2,publishedFiles:1,previousAttempts:0,canKeepFiles:true,canRestoreBase:true,requiresProcessCheck:true,scope:'SOURCE_FILES_ONLY',businessDataChanged:false,modelsCalled:0,executionGranted:false,automaticResume:false};
test('merge recovery UI validates current source scope and requires both an explicit choice and unchecked consent',()=>{
 assert.deepEqual(readMergeRecoveryPreview(preview,preview.runId),preview);
 for(const patch of [{businessDataChanged:true},{modelsCalled:1},{executionGranted:true},{automaticResume:true},{publishedFiles:3},{previousAttempts:9},{sourceState:'guess'},{source:{...preview.source,currentHash:'<bad>'}}])assert.throws(()=>readMergeRecoveryPreview({...preview,...patch},preview.runId));
 assert.throws(()=>readMergeRecoveryPreview(preview,'other_run'));
 const html=mergeRecoveryConfirmation(preview);assert.match(html,/合并.*中断|合并.*未完成/);assert.match(html,/保留当前文件/);assert.match(html,/还原.*合并前/);assert.match(html,/name="mergeChoice"/);assert.match(html,/name="mergeConsent" required/);assert.doesNotMatch(html,/\bchecked\b/);assert.match(html,/业务数据|费用/);assert.doesNotMatch(html,/[a-d]{64}/);
 const blocked={...preview,sourceState:'EXTERNAL_CHANGE',canKeepFiles:false,canRestoreBase:false};const denied=mergeRecoveryConfirmation(readMergeRecoveryPreview(blocked,preview.runId));assert.doesNotMatch(denied,/<form/);assert.match(denied,/外部|另外/);
});
test('recovery result cannot invent original merge success, model usage, changed business data or another source',()=>{
 const result={schema:'dream-maker.merge-recovery-result.v1',runId:preview.runId,waveId:preview.waveId,recoveryId:'recovery_'+'e'.repeat(32),operationHash:'f'.repeat(64),choice:'RESTORE_BASE_AND_END',sourceHash:preview.source.baseHash,createdAt:new Date().toISOString(),replayed:false,scope:'SOURCE_FILES_ONLY',flowEnded:true,originalMergeApplied:false,sourceCopiesRetained:true,businessDataChanged:false,modelsCalled:0,executionGranted:false,automaticResume:false};
 assert.deepEqual(readMergeRecoveryResult(result,preview,'RESTORE_BASE_AND_END'),result);
 for(const patch of [{originalMergeApplied:true},{flowEnded:false},{sourceCopiesRetained:false},{businessDataChanged:true},{sourceHash:preview.source.combinedHash},{runId:'other'},{waveId:'other'},{replayed:'yes'},{recoveryId:'../outside'}])assert.throws(()=>readMergeRecoveryResult({...result,...patch},preview,'RESTORE_BASE_AND_END'));
});
test('only formal local views offer recovery and stopped tasks never say they are executing',()=>{
 const run={mergeRecoveryRequired:true};assert.match(mergeRecoveryNotice(run,true),/data-action="merge-recovery"/);assert.equal(mergeRecoveryNotice(run,false),'');assert.equal(mergeRecoveryNotice({mergeRecoveryRequired:false},true),'');
 assert.equal(sourceTaskLabel('running','CANCELLED'),'已停止，未确认');assert.equal(sourceTaskLabel('running','IMPLEMENTING'),'执行中');assert.equal(sourceTaskLabel('done','CANCELLED'),'已完成');assert.match(mergeRecoveryError('MERGE_RECOVERY_RESULT_UNCERTAIN'),/重新核对/);
});
