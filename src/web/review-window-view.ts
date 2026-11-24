import type {Snapshot} from './contracts.js';import {UiError} from './contracts.js';
export interface ReviewWindowBinding{projectId:string;runId:string;version:number;sourceHash:string;calls:number;maxCalls:number;repairCount:number;maxRepairs:number;createdAt:string;maxSeconds:number}
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function reviewWindowBinding(s:Snapshot|null):ReviewWindowBinding|null{
 const r=s?.runs[0],c=r?.reviewWindowCandidate;
 if(!r||!c||s!.project.activeRunId!==r.id||s!.project.id!==r.projectId||r.mode!=='live'||r.flowName!=='classic'||
  r.state!=='BLOCKED'||r.phase!=='REVIEWING'||r.reason!=='REVIEW_PACKET_LIMIT'||r.review!==null||r.reviewWindow!==undefined||
  r.sessions?.reviewer||r.roleIdentities?.reviewer||c.kind!=='EXPIRED_REVIEW_WINDOW'||c.version!==r.version||c.sourceHash!==r.treeHash||c.maxSeconds!==7200||!sha(r.treeHash)||
  ![r.version,r.calls,r.maxCalls,r.repairCount,r.maxRepairs,r.maxSeconds].every(v=>Number.isSafeInteger(v)&&v>=0)||r.version<1||r.calls>=r.maxCalls||!Number.isFinite(Date.parse(r.createdAt)))return null;
 return {projectId:r.projectId,runId:r.id,version:r.version,sourceHash:r.treeHash,calls:r.calls,maxCalls:r.maxCalls,repairCount:r.repairCount,maxRepairs:r.maxRepairs,createdAt:r.createdAt,maxSeconds:r.maxSeconds};
}
export function reviewWindowRequest(b:ReviewWindowBinding,seconds:number){
 if(!Number.isSafeInteger(seconds)||seconds<60||seconds>7200)throw new UiError('REVIEW_WINDOW_INPUT_INVALID','请选择最多两小时的继续时间。');
 return {confirmed:true,sourceHash:b.sourceHash,expectedVersion:b.version,seconds};
}
export function readReviewWindowResult(raw:unknown,b:ReviewWindowBinding):Snapshot{
 const s=raw as Snapshot,r=s?.runs?.find(x=>x.id===b.runId);
 if(!s?.project||s.project.id!==b.projectId||s.project.activeRunId!==b.runId||!r||r.projectId!==b.projectId||r.version!==b.version+1||
  r.state!=='BLOCKED'||r.phase!=='REVIEWING'||r.reason!=='REVIEW_PACKET_LIMIT'||r.review!==null||r.treeHash!==b.sourceHash||
  !r.reviewWindow||typeof r.reviewWindow.recordId!=='string'||!r.reviewWindow.recordId||!sha(r.reviewWindow.sha256)||
  r.calls!==b.calls||r.maxCalls!==b.maxCalls||r.repairCount!==b.repairCount||r.maxRepairs!==b.maxRepairs||r.createdAt!==b.createdAt||r.maxSeconds!==b.maxSeconds)
  throw new UiError('REVIEW_WINDOW_RESPONSE_INVALID','继续时间尚未确认，请返回项目刷新；没有自动开始审查。');
 return s;
}
export function reviewWindowNotice(s:Snapshot|null,local:boolean):string{
 return local&&reviewWindowBinding(s)?'<section class="notice warning" aria-label="审查时间已结束"><h3>原定时间已结束</h3><p>制作文件与测试记录已保留，独立审查尚未开始。可明确允许一段新的继续时间，费用与返修上限保持原样。</p><button type="button" data-action="review-window">设置审查继续时间</button></section>':'';
}
export function reviewWindowConfirmation():string{
 return '<h2 id="dialog-title">允许继续独立审查多久？</h2><p id="dialog-description">从本地服务保存批准起计时。现有方案、文件、费用、调用次数和返修上限保留；只保存时间批准，不调用模型。之后需要另行核对材料并点击继续。</p><form id="review-window-form"><label>继续时间<select name="reviewWindowSeconds" required><option value="900">15分钟</option><option value="1800">30分钟</option><option value="3600">1小时</option><option value="7200">2小时</option></select></label><label class="check"><input type="checkbox" name="reviewWindowConsent" required><span>我批准所选的继续时间；这不表示审查已通过或成果已接受。</span></label><div class="actions"><button type="button" data-action="close-modal">返回项目</button><button type="submit" class="primary">保存继续时间</button></div></form>';
}
