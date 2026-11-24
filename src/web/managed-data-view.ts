import type {ManagedDataView,ManagedDataRestorePlan} from '../shared/managed-data.js';
import type {DemoTask} from '../shared/demo-tasks.js';
import {checkedDemoTasks} from '../shared/demo-tasks.js';
import {UiError,escapeHtml as e} from './contracts.js';
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function readManagedData(value:unknown,projectId?:string):ManagedDataView{
 const v=value as ManagedDataView;let tasks:DemoTask[];
 try{tasks=checkedDemoTasks(v?.tasks);}catch{throw new UiError('MANAGED_DATA_STATUS_INVALID','任务数据响应无效，已有内容保留。');}
 if(!v||v.schema!=='dream-maker.managed-data.v1'||v.kind!=='FIXED_DEMO_TASKS_V1'||v.scope!=='FIXED_DEMO_DATA_ONLY'||v.nativeExecutionGranted!==false||typeof v.projectId!=='string'||projectId&&v.projectId!==projectId||!integer(v.revision)||!v.usage||!v.limits||!['versions','bytes','operations'].every(k=>integer(v.usage[k as keyof typeof v.usage])&&integer(v.limits[k as keyof typeof v.limits])&&v.usage[k as keyof typeof v.usage]<=v.limits[k as keyof typeof v.limits])||v.usage.versions!==v.revision||(v.revision===0?tasks.length!==0||v.dataHash!==null||v.contentHash!==null:!sha(v.dataHash)||!sha(v.contentHash)))throw new UiError('MANAGED_DATA_STATUS_INVALID','任务数据范围或版本无法核对，未覆盖已有内容。');
 return {...v,tasks};
}
export function managedDataErrorMessage(code:string):string|undefined{
 const messages:Record<string,string>={MANAGED_DATA_CONFLICT:'另一个页面已改动数据。你的输入保留；请先核对本机最新内容，再决定如何整理，不会自动覆盖。',MANAGED_DATA_ALREADY_EXISTS:'本机已有该项目的数据，不能用浏览器旧副本覆盖。旧浏览器内容仍保留。',MANAGED_DATA_SOURCE_CHANGED:'当前样例来源发生变化，已停止保存或迁移。源码和旧数据保留。',MANAGED_DATA_SECRET_DENIED:'内容包含不能写入任务数据的敏感信息，未保存。请保留必要工作内容并移除凭据。',MANAGED_DATA_STORAGE_LIMIT:'数据历史占用已达上限，未写入新版本；已有版本保留。',MANAGED_DATA_VERSION_LIMIT:'数据版本数量已达上限，未删除旧版本。',MANAGED_DATA_OPERATION_LIMIT:'本项目的数据操作数量已达上限，已有数据保留。',MANAGED_DATA_SNAPSHOT_EMPTY:'这份副本中没有所选项目的任务数据，请核对项目与副本。',MANAGED_DATA_LEGACY_CHANGED:'浏览器旧内容在确认期间发生了变化，未迁移；请重新核对。',MANAGED_DATA_STATUS_INVALID:'任务数据响应无法核对，未覆盖已有内容。',MAINTENANCE_SNAPSHOT_ANCHOR_MISMATCH:'副本与本机登记的原摘要不符，已停止恢复；当前数据保留。',MAINTENANCE_SNAPSHOT_UNANCHORED:'这份旧副本没有数据恢复所需的本机来源登记，只能按原范围核验。'};
 return messages[code];
}
export function managedPreviewPanel(protocol:number|undefined,data:ManagedDataView|undefined):string{
 if(!protocol)return '';
 if(protocol===1)return `<section class="card"><h2>旧样例的浏览器数据</h2><p>这个已交付样例仍保存在当前浏览器。迁移只复制当前项目和当前成果对应的任务，保留旧副本。</p>${data?.revision?`<p>本机已有数据版本 ${e(data.revision)}，共 ${e(data.tasks.length)} 项。旧样例预览仍使用浏览器副本，两者不会自动同步。</p>`:'<button type="button" data-action="managed-data-import">核对并迁移浏览器任务</button>'}</section>`;
 return `<section class="card" role="status"><h2>本机任务数据</h2><p>${data?`已核对版本 ${e(data.revision)} · ${e(data.tasks.length)} 项任务`:'正在核对本机保存状态。'}</p><p class="hint">任务数据与源码分开保存。历史版本保留，浏览器清理不会删除这里的数据；备份与恢复见“数据与维护”。这是固定 Demo 数据功能。</p></section>`;
}
export function managedImportConfirmation(count:number,runId:string):string{
 return `<h2 id="dialog-title">迁移这份浏览器任务？</h2><p id="dialog-description">将当前成果对应的 ${e(count)} 项任务复制到本机项目数据，建立第一个版本。旧浏览器副本保留，不合并或覆盖服务器已有数据。</p><p class="hint">成果：${e(runId)}。旧样例预览仍使用原浏览器副本；新协议样例才直接保存本机数据。</p><form id="managed-import-form"><label class="check"><input type="checkbox" name="managedConsent" required>我已核对，确认复制当前这份任务数据。</label><div class="actions"><button type="button" data-action="close-modal">返回</button><button type="submit" class="primary">确认迁移任务</button></div></form>`;
}
export function readManagedRestorePlan(value:unknown,pid:string,snapshotId:string,rehearsalId:string):ManagedDataRestorePlan{
 const v=value as ManagedDataRestorePlan;
 if(!v||v.schema!=='dream-maker.managed-data-restore-plan.v1'||v.scope!=='FIXED_DEMO_DATA_ONLY'||v.engineStarted!==false||v.projectId!==pid||v.snapshotId!==snapshotId||v.rehearsalId!==rehearsalId||!v.source||!v.target||!integer(v.source.revision)||v.source.revision<1||!sha(v.source.contentHash)||!integer(v.source.taskCount)||v.source.taskCount>200||!Number.isFinite(Date.parse(v.source.at))||!integer(v.target.revision)||!integer(v.target.taskCount)||v.target.taskCount>200||(v.target.revision===0?v.target.contentHash!==null:!sha(v.target.contentHash)))throw new UiError('MANAGED_DATA_STATUS_INVALID','恢复来源或目标暂时无法核对，未更改当前数据。');
 return v;
}
export function managedRestoreConfirmation(plan:ManagedDataRestorePlan,name:string):string{
 return `<h2 id="dialog-title">只恢复这个项目的任务数据？</h2><p id="dialog-description">${e(name)}：当前版本 ${e(plan.target.revision)}，${e(plan.target.taskCount)} 项任务。所选副本是版本 ${e(plan.source.revision)}，${e(plan.source.taskCount)} 项，记录于 ${e(plan.source.at)}。</p><p>会按副本内容创建新的数据版本，保留当前和历史版本。源码、完整方案、批准和原费用账本保持，不会开始制作或模型任务。</p><p class="hint break">副本 ${e(plan.snapshotId)} · 演练 ${e(plan.rehearsalId)}</p><form id="managed-restore-form"><label class="check"><input type="checkbox" name="managedConsent" required>我已核对项目和副本，确认仅将这些任务数据恢复为新版本。</label><div class="actions"><button type="button" data-action="close-modal">返回</button><button type="submit" class="primary">确认仅恢复任务数据</button></div></form>`;
}
