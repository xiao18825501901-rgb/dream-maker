import type {ExecutorCheckpointPreview,ExecutorCheckpointResult} from '../shared/executor-checkpoint.js';
import type {RunView} from './contracts.js';import {UiError} from './contracts.js';
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const count=(v:unknown,max=1000000)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
const wave=(v:unknown)=>typeof v==='string'&&/^executor_wave_[A-Za-z0-9_-]{1,80}$/.test(v);
const invalid=()=>new UiError('EXECUTOR_CHECKPOINT_RESPONSE_INVALID','保留文件的结果还没有核清，请刷新项目状态；没有开始新的制作。');
export function readExecutorCheckpointPreview(raw:unknown,runId:string):ExecutorCheckpointPreview{
 const v=raw as ExecutorCheckpointPreview;
 if(!v||v.schema!=='dream-maker.executor-checkpoint-preview.v1'||v.runId!==runId||!count(v.runVersion)||v.runVersion<1||!wave(v.waveId)||![v.canonicalHash,v.checkpointHash,v.toolJournalHash,v.previewHash].every(sha)||!Array.isArray(v.tasks)||!v.tasks.length||v.tasks.length>4||new Set(v.tasks.map(t=>t.taskId)).size!==v.tasks.length||v.tasks.some(t=>typeof t.taskId!=='string'||!t.taskId||t.taskId.length>100||!sha(t.sourceHash)||!count(t.fileCount,2000)||!count(t.toolCalls,4096)||typeof t.priorResultSealed!=='boolean')||typeof v.canPrepare!=='boolean'||v.requiresProcessCheck!==true||v.modelsCalled!==0||v.executionGranted!==false||v.automaticResume!==false)throw invalid();
 return v;
}
export function readExecutorCheckpointResult(raw:unknown,p:ExecutorCheckpointPreview):ExecutorCheckpointResult{
 const v=raw as ExecutorCheckpointResult;
 if(!v||v.schema!=='dream-maker.executor-checkpoint-result.v1'||v.runId!==p.runId||v.previousWaveId!==p.waveId||!wave(v.newWaveId)||v.newWaveId===p.waveId||!sha(v.operationHash)||v.checkpointHash!==p.checkpointHash||v.canonicalHash!==p.canonicalHash||v.runVersion!==p.runVersion+1||v.state!=='PAUSED'||typeof v.replayed!=='boolean'||v.sourceCopiesRetained!==true||v.taskCompletionAssumed!==false||v.modelsCalled!==0||v.executionGranted!==false||v.automaticResume!==false)throw invalid();
 return v;
}
export function executorCheckpointConfirmation(p:ExecutorCheckpointPreview):string{
 const description='<p id="dialog-description">已写入的文件尚未作为完整任务提交。先核对旧进程和工具记录，再保留副本，准备继续未完成任务；不会自动调用模型、合并成果或接受交付。后续继续仍需账户资格与费用预算。</p>';
 if(!p.canPrepare)return '<h2 id="dialog-title">还不能准备继续</h2>'+description+'<p class="notice warning">任务仍在处理，或已达到恢复次数上限。现有文件保留，请先读取项目状态。</p><button type="button" data-action="close-modal">返回项目</button>';
 return '<h2 id="dialog-title">保留已写文件，准备继续</h2>'+description+'<p class="notice">本次核对 '+p.tasks.length+' 个任务副本，共 '+p.tasks.reduce((n,t)=>n+t.fileCount,0)+' 个文件。准备后流程保持暂停，任务仍未完成。</p><form id="executor-checkpoint-form"><label class="check"><input type="checkbox" name="checkpointConsent" required><span>我确认保留已写文件，准备继续未完成任务；这不表示制作成功或接受成果。</span></label><div class="actions"><button type="button" data-action="close-modal">先保留，返回</button><button type="submit" class="primary">核对并准备继续（不调用模型）</button></div></form>';
}
export function executorCheckpointNotice(run:Pick<RunView,'executorCheckpointRequired'>,formalLocal:boolean):string{
 return formalLocal&&run.executorCheckpointRequired===true?'<section class="notice warning" aria-label="执行结果需要核对"><h3>上次执行没有确认完成</h3><p>已写文件与工具记录保留。先核对旧进程和实际文件，再准备继续未完成任务；暂不能接受成果。</p><button type="button" data-action="executor-checkpoint">检查并保留已写文件</button></section>':'';
}
export function executorCheckpointError(code:string):string|undefined{
 if(code==='EXECUTOR_SLICE_RESULT_UNCERTAIN')return '执行结果尚未核清，已写文件保留。请先检查并保留已写文件，再准备继续。';
 if(code==='EXECUTOR_CHECKPOINT_PREPARED')return '已保留旧文件和新的任务副本，流程保持暂停。账户与费用条件满足后，才能手动继续未完成任务。';
 if(code==='EXECUTOR_TASK_TOOL_LIMIT')return '当前任务达到本次工具上限，已写文件保留。请核对任务结果，再决定下一步。';
 if(code==='EXECUTOR_CHECKPOINT_RESULT_UNCERTAIN')return '上次准备继续的结果尚未核清，不能重复执行。请先读取项目状态并保留全部副本。';
 if(code==='RECOVERY_DATABASE_UNREGISTERED')return '目录含有未登记的业务数据库，不能当普通源码复制恢复。请先完成一致备份与数据核验。';
 if(code.startsWith('EXECUTOR_CHECKPOINT_')||code==='TOOL_RECOVERY_REQUIRED'||code==='RECOVERY_SOURCE_CHANGED')return '文件、工具操作或进程状态还没有核清，暂未准备继续。现有文件与费用记录保留，请刷新状态后检查。';
 return undefined;
}
