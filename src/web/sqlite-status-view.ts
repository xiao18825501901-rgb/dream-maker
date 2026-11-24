import type {Snapshot} from './contracts.js';import type {SqliteDataView,SqliteDataRestorePlan,SqliteDataRecoveryCandidate,SqliteDataRecoveryPlan} from '../shared/sqlite-data.js';
import {UiError,escapeHtml as e} from './contracts.js';
type Values=Record<string,unknown>;
const object=(v:unknown):v is Values=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
// Maximum values of the current v1 wire contract; smaller configured limits remain valid.
const imageLimit=67108864,wireLimits:Record<string,number>={versions:32,bytes:536870912,operations:4096,pending:4};
const invalid=():never=>{throw new UiError('SQLITE_STATUS_RESPONSE_INVALID','保存状态还未核清。已有数据保留，请返回项目后重新核对。');};
export interface SqliteStatusBinding{projectId:string;runId:string;projectVersion:number;runVersion:number}
export function sqliteStatusBinding(s:Snapshot|null):SqliteStatusBinding|null{
 const p=s?.project,r=s?.runs[0];
 if(!p||!r||p.mode!=='live'||r.mode!=='live'||p.activeRunId!==r.id||r.projectId!==p.id||![p.id,r.id].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v))||!integer(p.version)||p.version<1||!integer(r.version)||r.version<1)return null;
 return {projectId:p.id,runId:r.id,projectVersion:p.version,runVersion:r.version};
}
export function sameSqliteStatusBinding(a:SqliteStatusBinding|null,b:SqliteStatusBinding):boolean{
 return !!a&&a.projectId===b.projectId&&a.runId===b.runId&&a.projectVersion===b.projectVersion&&a.runVersion===b.runVersion;
}
export function readSqliteStatus(raw:unknown,pid:string):SqliteDataView{
 if(!object(raw)||Object.keys(raw).some(k=>!['schema','projectId','kind','revision','imageHash','imageBytes','contentHash','usage','limits','scope','nativeExecutionGranted','operation'].includes(k))||raw.schema!=='dream-maker.sqlite-data.v1'||raw.kind!=='SQLITE_IMAGE_V1'||raw.projectId!==pid||raw.scope!=='PROJECT_SQLITE_DATA_ONLY'||raw.nativeExecutionGranted!==false||!integer(raw.revision)||!integer(raw.imageBytes)||!object(raw.usage)||!object(raw.limits))return invalid();
 const keys=['versions','bytes','operations','pending'],usage=raw.usage,limits=raw.limits;
 if([usage,limits].some(v=>Object.keys(v).some(k=>!keys.includes(k)))||keys.some(k=>!integer(usage[k])||!integer(limits[k])||Number(limits[k])<1||Number(limits[k])>wireLimits[k]||Number(usage[k])>Number(limits[k])))return invalid();
 const u=usage as Record<string,number>;
 if(u.versions!==raw.revision||u.operations!==u.versions+u.pending)return invalid();
 if(raw.revision===0?raw.imageHash!==null||raw.contentHash!==null||raw.imageBytes!==0:!sha(raw.imageHash)||!sha(raw.contentHash)||raw.imageBytes<512||raw.imageBytes>imageLimit||raw.imageBytes%512!==0)return invalid();
 const otherImages=u.operations-(raw.revision>0?1:0);
 if(u.bytes%512!==0||u.bytes<raw.imageBytes+512*otherImages||u.bytes>raw.imageBytes+imageLimit*otherImages)return invalid();
 if(raw.operation!==undefined&&(!object(raw.operation)||Object.keys(raw.operation).some(k=>!['hash','appliedRevision','replayed'].includes(k))||
  !sha(raw.operation.hash)||!integer(raw.operation.appliedRevision)||raw.operation.appliedRevision<1||typeof raw.operation.replayed!=='boolean'))return invalid();
 return structuredClone(raw) as unknown as SqliteDataView;
}
export function sqliteStatusEntry(s:Snapshot|null,formalLocal:boolean):string{
 if(!formalLocal||!sqliteStatusBinding(s))return '';
 return '<section class="notice" aria-label="数据库保存状态"><h3>数据库保存状态</h3><p>核对当前项目已保存的版本和待核清记录，不需要模型登录。</p><button type="button" data-action="sqlite-status">核对数据库保存状态</button></section>';
}
const actions='<div class="actions wrap"><button type="button" data-action="sqlite-status">再次核对</button><button type="button" data-action="close-modal">返回项目</button></div>';
const bytes=(n:number)=>n<1024?n+' 字节':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
export function sqliteStatusContent(v:SqliteDataView):string{
 return `<h2 id="dialog-title">数据库保存状态</h2><p id="dialog-description">本次核对${v.revision?'发现已保存版本 '+e(v.revision):'还没有已保存的数据库版本'}。这里只核对保存信息，尚不代表项目通过验收。</p><dl class="metrics"><div><dt>已保存历史</dt><dd>${e(v.usage.versions)} 版</dd></div><div><dt>计入保存额度</dt><dd>${e(bytes(v.usage.bytes))}</dd></div><div><dt>保存额度上限</dt><dd>${e(bytes(v.limits.bytes))}</dd></div></dl>${v.usage.pending?`<p class="notice warning" role="status">${e(v.usage.pending)} 次保存仍待核清，已有版本保留。请先核对记录，暂不要反复运行或恢复。</p>`:'<p class="hint">保存记录中暂未发现待核清项。</p>'}<p class="hint">保存额度也计入了仍待核清的记录。这是本次核对时的信息，需要更新时可以再次核对。</p><p>查看状态不会调用模型或运行成果。已核对的演练副本可以另经明确确认，写成新的数据库版本；不会覆盖正在使用的应用数据库。</p>${actions}`;
}
export function readSqliteRecoveryPlan(raw:unknown,pid:string):SqliteDataRecoveryPlan{
 if(!object(raw)||Object.keys(raw).some(k=>!['schema','scope','projectId','candidates','automaticReplay','modelCalls'].includes(k))||
  raw.schema!=='dream-maker.sqlite-data-recovery-plan.v1'||raw.scope!=='PROJECT_SQLITE_DATA_ONLY'||
  raw.projectId!==pid||raw.automaticReplay!==false||raw.modelCalls!==0||!Array.isArray(raw.candidates)||raw.candidates.length>4)
  return invalid();
 const seen=new Set<string>();
 for(const value of raw.candidates){
  if(!object(value)||Object.keys(value).some(k=>!['operationHash','expectedRevision','imageBytes','imageHash','actor','at','recoverable','blockedReason'].includes(k))||
   typeof value.operationHash!=='string'||!sha(value.operationHash)||!integer(value.expectedRevision)||!integer(value.imageBytes)||
   value.imageBytes<512||value.imageBytes>imageLimit||value.imageBytes%512!==0||!sha(value.imageHash)||
   typeof value.actor!=='string'||!/^local-session:[a-f0-9]{64}$/.test(value.actor)||
   typeof value.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at)||
   !Number.isFinite(Date.parse(value.at))||typeof value.recoverable!=='boolean'||
   (value.recoverable?(value.blockedReason!==null):!['INTENT_BINDING_REQUIRED','INTENT_BINDING_INVALID'].includes(String(value.blockedReason)))||
   seen.has(value.operationHash))return invalid();
  seen.add(value.operationHash);
 }
 return structuredClone(raw) as unknown as SqliteDataRecoveryPlan;
}
export function sqliteRecoverySection(plan:SqliteDataRecoveryPlan|null):string{
 if(!plan?.candidates.length)return '';
 return `<section class="notice warning" aria-label="待核清的数据库保存"><h3>待核清的数据库保存</h3><p>下列记录会先检查完整镜像、大小、摘要、来源和方案绑定。只有全部一致时才能提交一次；缺失、截断、内容变化或来源变化都会停止。</p><ul class="plain-list">${plan.candidates.map(value=>`<li><span>记录 ${e(value.operationHash.slice(0,12))}，应生成第 ${e(value.expectedRevision+1)} 版</span>${value.recoverable?`<button type="button" data-action="sqlite-recovery" data-operation="${e(value.operationHash)}">核对并恢复</button>`:`<span class="hint">${e(value.blockedReason==='INTENT_BINDING_INVALID'?'可信绑定已损坏，不能自动恢复。':'这是旧记录，缺少可信绑定，不能自动恢复。')}</span>`}</li>`).join('')}</ul><p class="hint">恢复不会重跑模型、DSH、生成程序或 WSL 任务；也不表示项目验收通过。</p></section>`;
}
export function sqliteRecoveryConfirmation(plan:SqliteDataRecoveryPlan,candidate:SqliteDataRecoveryCandidate,projectName:string):string{
 if(!candidate.recoverable||!plan.candidates.some(value=>value.operationHash===candidate.operationHash&&value.recoverable))return invalid();
 return `<h2 id="dialog-title">核对并恢复这条保存？</h2><p id="dialog-description">项目“${e(projectName)}”会检查这条记录的完整镜像、大小、摘要、来源和方案绑定；全部一致时只提交一次，生成第 ${e(candidate.expectedRevision+1)} 版。</p><p class="notice">不会重跑模型、DSH、生成程序或 WSL 任务。记录 ${e(candidate.operationHash.slice(0,12))} 的原始 Intent 和操作历史会保留。</p><form id="sqlite-recovery-form"><input type="hidden" name="operationHash" value="${e(candidate.operationHash)}"><label class="check"><input type="checkbox" name="sqliteRecoveryConsent" required>我已核对这条匿名记录，并允许它在原来源完全一致时生成一个新版本。</label><div class="actions"><button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">核对并恢复</button></div></form>`;
}
export function sqliteStatusLoading():string{
 return '<h2 id="dialog-title">正在核对数据库保存状态</h2><p id="dialog-description">只读取本机保存信息，不调用模型或运行成果。</p><button type="button" data-action="close-modal">先返回项目</button>';
}
export function sqliteStatusFailure(code:string):string{
 const text=code==='SQLITE_DATA_READ_CHANGED'||code==='SQLITE_DATA_RECOVERY_CHANGED'?'项目状态已变化，请返回项目刷新后再核对。':code==='SQLITE_DATA_BUSY'||code==='WORKSPACE_BUSY'?'本轮有任务尚未结束，请稍后再核对保存状态。':code==='PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED'?'后台进程尚未核清，请先到数据维护和 Help 查看需要处理的事项。':'保存信息暂未核清，请返回项目后再核对。';
 return `<h2 id="dialog-title">保存状态暂未核清</h2><p id="dialog-description">${text}已有数据保留，没有执行恢复或成果接受。</p>${actions}`;
}
export function readSqliteRestorePlan(raw:unknown,pid:string,snapshotId:string,rehearsalId:string):SqliteDataRestorePlan{
 if(!object(raw)||Object.keys(raw).some(k=>!['schema','scope','engineStarted','projectId','snapshotId','rehearsalId','source','target'].includes(k))||
  raw.schema!=='dream-maker.sqlite-data-restore-plan.v1'||raw.scope!=='PROJECT_SQLITE_DATA_ONLY'||raw.engineStarted!==false||
  raw.projectId!==pid||raw.snapshotId!==snapshotId||raw.rehearsalId!==rehearsalId||!object(raw.source)||!object(raw.target))return invalid();
 const source=raw.source,target=raw.target;
 if(Object.keys(source).some(k=>!['revision','contentHash','imageHash','imageBytes','at'].includes(k))||
  Object.keys(target).some(k=>!['revision','contentHash'].includes(k))||
  !integer(source.revision)||source.revision<1||!sha(source.contentHash)||!sha(source.imageHash)||!integer(source.imageBytes)||
  source.imageBytes<512||source.imageBytes>imageLimit||source.imageBytes%512!==0||typeof source.at!=='string'||
  !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(source.at)||!Number.isFinite(Date.parse(source.at))||
  !integer(target.revision)||(target.revision===0?target.contentHash!==null:!sha(target.contentHash)))return invalid();
 return structuredClone(raw) as unknown as SqliteDataRestorePlan;
}
export function sqliteRestoreConfirmation(plan:SqliteDataRestorePlan,projectName:string):string{
 return `<h2 id="dialog-title">恢复项目数据库为新版本？</h2><p id="dialog-description">项目“${e(projectName)}”会从已核对演练中的第 ${e(plan.source.revision)} 版，生成当前项目的新版本。旧版本和恢复记录都会保留。</p><p class="notice">只写项目数据库历史，不替换正在使用的应用数据库、源码、审批或费用账本；不会启动模型、制作或审查。</p><form id="sqlite-restore-form"><input type="hidden" name="snapshotId" value="${e(plan.snapshotId)}"><input type="hidden" name="rehearsalId" value="${e(plan.rehearsalId)}"><input type="hidden" name="expectedRevision" value="${e(plan.target.revision)}"><label class="check"><input type="checkbox" name="sqliteConsent" required>我已核对来源版本和恢复范围，确认生成新的项目数据库版本。</label><div class="actions"><button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">确认恢复为新版本</button></div></form>`;
}
