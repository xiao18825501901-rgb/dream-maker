import type {MergeRecoveryChoice,MergeRecoveryPreview,MergeRecoveryResult} from '../shared/merge-recovery.js';
import type {RunView} from './contracts.js';
import {UiError} from './contracts.js';
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const count=(value:unknown,max=5000)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=max;
const invalid=()=>new UiError('MERGE_RECOVERY_RESPONSE_INVALID','文件与恢复范围尚未核清，请重新检查；没有获得继续制作的许可。');
export function readMergeRecoveryPreview(raw:unknown,runId:string):MergeRecoveryPreview{
 const value=raw as MergeRecoveryPreview;
 if(!value||value.schema!=='dream-maker.merge-recovery-preview.v1'||value.runId!==runId||typeof value.waveId!=='string'||!/^executor_wave_[A-Za-z0-9_-]{1,80}$/.test(value.waveId)||!sha(value.previewHash)||!value.source||![value.source.baseHash,value.source.combinedHash,value.source.currentHash].every(sha)||!['SOURCE_UNCHANGED','COMBINED_UNCOMMITTED','PARTIALLY_PUBLISHED','EXTERNAL_CHANGE'].includes(value.sourceState)||!count(value.changedFiles)||!count(value.publishedFiles)||value.publishedFiles>value.changedFiles||!count(value.previousAttempts,8)||typeof value.canKeepFiles!=='boolean'||typeof value.canRestoreBase!=='boolean'||value.canKeepFiles!==value.canRestoreBase||value.sourceState==='EXTERNAL_CHANGE'&&(value.canKeepFiles||value.canRestoreBase)||value.requiresProcessCheck!==true||value.scope!=='SOURCE_FILES_ONLY'||value.businessDataChanged!==false||value.modelsCalled!==0||value.executionGranted!==false||value.automaticResume!==false)throw invalid();
 return value;
}
export function readMergeRecoveryResult(raw:unknown,preview:MergeRecoveryPreview,choice:MergeRecoveryChoice):MergeRecoveryResult{
 const value=raw as MergeRecoveryResult,target=choice==='RESTORE_BASE_AND_END'?preview.source.baseHash:preview.source.currentHash;
 if(!value||value.schema!=='dream-maker.merge-recovery-result.v1'||value.runId!==preview.runId||value.waveId!==preview.waveId||typeof value.recoveryId!=='string'||!/^recovery_[a-f0-9]{32}$/.test(value.recoveryId)||!sha(value.operationHash)||value.choice!==choice||value.sourceHash!==target||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||typeof value.replayed!=='boolean'||value.scope!=='SOURCE_FILES_ONLY'||value.flowEnded!==true||value.originalMergeApplied!==false||value.sourceCopiesRetained!==true||value.businessDataChanged!==false||value.modelsCalled!==0||value.executionGranted!==false||value.automaticResume!==false)throw invalid();
 return value;
}
export function mergeRecoveryConfirmation(value:MergeRecoveryPreview):string{
 const state={SOURCE_UNCHANGED:'还没有发布改动',COMBINED_UNCOMMITTED:'文件已全部发布，但完成记录未提交',PARTIALLY_PUBLISHED:'只发布了部分改动',EXTERNAL_CHANGE:'发现另外发生的文件变化'}[value.sourceState];
 const description='<p id="dialog-description">先保留当前文件快照，再结束这一轮未完成的制作。方案版本、业务数据、审批、账户和费用记录保留；不会自动调用模型或开始下一轮。</p>';
 if(!value.canKeepFiles||!value.canRestoreBase)return '<h2 id="dialog-title">合并恢复暂时不能进行</h2>'+description+'<p class="notice warning">'+state+'。现在不能自动覆盖文件或宣告恢复完成。请保留原目录与副本，先核对外部变化或仍在工作的进程。</p><button type="button" data-action="merge-recovery">重新核对文件</button><button type="button" data-action="close-modal">先保留，返回</button>';
 return '<h2 id="dialog-title">处理未完成的文件合并</h2>'+description+'<p class="notice">'+state+'。共 '+value.changedFiles+' 个待合并文件，其中 '+value.publishedFiles+' 个已发布。继续前还会检查旧进程是否结束。</p><form id="merge-recovery-form"><fieldset><legend>请选择文件处理方式</legend><label class="check"><input type="radio" name="mergeChoice" value="KEEP_FILES_AND_END" required><span>保留当前文件，并结束本轮。现状可能只有部分改动，不代表可以使用或已通过审查。</span></label><label class="check"><input type="radio" name="mergeChoice" value="RESTORE_BASE_AND_END" required><span>还原到合并前的源码，并结束本轮。还原前的文件、原始基线和组合副本都会保留。</span></label></fieldset><label class="check"><input type="checkbox" name="mergeConsent" required>我了解文件处理范围，确认结束本轮；这不表示制作完成或接受成果。</label><div class="actions"><button type="button" data-action="close-modal">暂不处理</button><button type="submit" class="primary">确认处理文件并结束本轮</button></div></form>';
}
export function mergeRecoveryNotice(run:Pick<RunView,'mergeRecoveryRequired'>,formalLocal:boolean):string{
 return formalLocal&&run.mergeRecoveryRequired===true?'<section class="notice warning" aria-label="文件合并需要核对"><h3>上次文件合并没有完成</h3><p>当前文件、合并前基线和组合副本均保留。先检查并选择文件处理方式，再结束旧轮次；不能直接继续或接受成果。</p><button type="button" data-action="merge-recovery">检查文件并处理未完成合并</button></section>':'';
}
export function sourceTaskLabel(status:string,runState?:string):string{
 if(status==='running'&&['CANCELLED','FAILED','PARTIAL'].includes(runState??''))return '已停止，未确认';
 if(status==='running'&&runState==='BLOCKED')return '结果待核对';
 return ({pending:'未开始',running:'执行中',implemented:'已实现 · 待验证',done:'已完成'} as Record<string,string>)[status]??'状态尚未核验';
}
export function mergeRecoveryError(code:string):string|undefined{
 const messages:Record<string,string>={EXECUTOR_MERGE_RESULT_UNCERTAIN:'上次文件合并没有完成。请先检查文件，再选择保留现状或还原合并前源码。',MERGE_RECOVERY_FILES_RETAINED:'已保留当前文件并结束旧轮次；文件可能仍未完整，尚未通过审查。',MERGE_RECOVERY_BASE_RESTORED:'已还原合并前源码并结束旧轮次；没有继续制作或接受成果。',MERGE_RECOVERY_RESULT_UNCERTAIN:'上次恢复的结果还没有核清，不能重复执行。请重新核对文件，再决定下一步。',MERGE_RECOVERY_SOURCE_CHANGED:'文件发生了变化，已停止本次处理。请重新核对；现有文件和副本保留。',MERGE_RECOVERY_PREVIEW_CHANGED:'检查范围已经变化，本次确认不再有效。请重新核对文件，再作选择。',MERGE_RECOVERY_NOT_REQUIRED:'当前已不需要此项恢复。请刷新项目状态，核对旧轮次是否结束。',MERGE_RECOVERY_DATABASE_UNREGISTERED:'源码目录含有未登记的业务数据库，不能用普通文件还原覆盖。原数据库保留，请先完成一致备份与数据适配。',MERGE_RECOVERY_CANCELLED:'恢复已停止，尚未宣告文件处理完成。请重新打开后核对。',MERGE_RECOVERY_BUSY:'另一个文件恢复操作还没结束，请等待核对结果。',MERGE_RECOVERY_RESPONSE_INVALID:'恢复响应的范围无法核对，未把本次操作当成成功。请刷新项目并重新检查。'};
 if(messages[code])return messages[code];
 if(/^MERGE_RECOVERY_|^EXECUTOR_SLICE_(?:BASE_CHANGED|BINDING_CHANGED|CHANGED|STORAGE_LIMIT)/.test(code))return '文件来源、进程状态或可用空间尚未核清，已停止处理。现有文件和副本保留；请重新检查，需要时查看帮助。';
 return undefined;
}
