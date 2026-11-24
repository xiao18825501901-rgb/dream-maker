import type {Snapshot} from './contracts.js';import {UiError} from './contracts.js';
type RecordValue=Record<string,unknown>;
const object=(v:unknown):v is RecordValue=>!!v&&typeof v==='object'&&!Array.isArray(v);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
const counter=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const invalid=():never=>{throw new UiError('REVIEW_SUPPLEMENT_RESPONSE_INVALID','补充复审条件或保存结果还没有核清。已有文件和记录保留，请刷新项目；不要直接重复提交。');};
export interface ReviewSupplementBinding{
 projectId:string;runId:string;version:number;sourceHash:string;specId:string;specHash:string;planVersionHash:string;flowConfigHash:string;
 calls:number;maxCalls:number;repairCount:number;maxRepairs:number;createdAt:string;maxSeconds:number;originalReview:NonNullable<Snapshot['runs'][number]['review']>;
}
export interface ReviewSupplementPreview extends ReviewSupplementBinding{packetHash:string;previousReviewRecordId:string}
export interface ReviewSupplementAck{version:number;reviewSupplement:{recordId:string;sha256:string}}
export function sameReviewSupplementBinding(a:ReviewSupplementBinding|null,b:ReviewSupplementBinding):boolean{
 return !!a&&(['projectId','runId','version','sourceHash','specId','specHash','planVersionHash','flowConfigHash','calls','maxCalls','repairCount','maxRepairs','createdAt','maxSeconds'] as const).every(k=>a[k]===b[k])&&JSON.stringify(a.originalReview)===JSON.stringify(b.originalReview);
}
/** This is only a request affordance. The original server decides actual eligibility. */
export function reviewSupplementBinding(s:Snapshot|null):ReviewSupplementBinding|null{
 const r=s?.runs[0];if(!r||s!.project.id!==r.projectId||s!.project.activeRunId!==r.id||s!.project.specId!==r.specId||s!.spec?.id!==r.specId||s!.spec.hash!==r.specHash||s!.spec.stale||
  r.mode!=='live'||r.flowName!=='classic'||r.state!=='BLOCKED'||r.phase!=='REVIEWING'||r.reason!=='REVIEW_BLOCKED'||r.review?.verdict!=='BLOCKED'||r.review.source!=='CODEX'||r.reviewSupplement!==undefined||
  !sha(r.treeHash)||r.review.treeHash!==r.treeHash||r.verification?.ok!==true||r.verification.treeHash!==r.treeHash||!sha(r.planVersionHash)||!sha(r.flowConfigHash)||
  !r.tasks.length||r.tasks.some(t=>t.status!=='implemented')||![r.version,r.calls,r.maxCalls,r.repairCount,r.maxRepairs,r.maxSeconds].every(counter)||r.version<1||r.version>=Number.MAX_SAFE_INTEGER||r.calls<1||r.calls!==r.maxCalls||r.repairCount!==r.maxRepairs||!Number.isFinite(Date.parse(r.createdAt)))return null;
 return {projectId:r.projectId,runId:r.id,version:r.version,sourceHash:r.treeHash,specId:r.specId,specHash:r.specHash,planVersionHash:r.planVersionHash,flowConfigHash:r.flowConfigHash,calls:r.calls,maxCalls:r.maxCalls,repairCount:r.repairCount,maxRepairs:r.maxRepairs,createdAt:r.createdAt,maxSeconds:r.maxSeconds,originalReview:structuredClone(r.review)};
}
export function readReviewSupplementPreview(raw:unknown,b:ReviewSupplementBinding):ReviewSupplementPreview{
 if(!object(raw)||!object(raw.candidate))return invalid();const c=raw.candidate;
 if(Object.keys(c).some(k=>!['sourceHash','expectedVersion','packetHash','previousReviewRecordId','additionalCalls','scope','modelDispatched'].includes(k))||c.sourceHash!==b.sourceHash||c.expectedVersion!==b.version||!sha(c.packetHash)||!id(c.previousReviewRecordId)||c.additionalCalls!==1||c.scope!=='REVIEWER_ONLY_NO_REPAIR'||c.modelDispatched!==false)return invalid();
 return {...b,packetHash:c.packetHash,previousReviewRecordId:c.previousReviewRecordId};
}
export function reviewSupplementRequest(b:ReviewSupplementPreview){return {confirmed:true,sourceHash:b.sourceHash,expectedVersion:b.version,packetHash:b.packetHash,previousReviewRecordId:b.previousReviewRecordId};}
export function readReviewSupplementResult(raw:unknown,b:ReviewSupplementPreview):ReviewSupplementAck{
 if(!object(raw)||raw.runId!==b.runId||raw.state!=='PAUSED'||raw.version!==b.version+1||raw.sourceHash!==b.sourceHash||raw.calls!==b.calls||raw.maxCalls!==b.maxCalls||raw.additionalCalls!==1||raw.modelDispatched!==false||!object(raw.reviewSupplement)||!id(raw.reviewSupplement.recordId)||!sha(raw.reviewSupplement.sha256))return invalid();
 return {version:Number(raw.version),reviewSupplement:{recordId:raw.reviewSupplement.recordId,sha256:raw.reviewSupplement.sha256}};
}
export function readReviewSupplementSnapshot(raw:Snapshot,b:ReviewSupplementPreview,ack:ReviewSupplementAck):Snapshot{
 const r=raw?.runs?.find(r=>r.id===b.runId);
 if(!raw?.project||raw.project.id!==b.projectId||raw.project.activeRunId!==b.runId||raw.project.specId!==b.specId||raw.spec?.id!==b.specId||raw.spec.hash!==b.specHash||raw.spec.stale||!r||r.projectId!==b.projectId||r.specId!==b.specId||r.specHash!==b.specHash||r.mode!=='live'||r.flowName!=='classic'||
  r.version!==ack.version||r.state!=='PAUSED'||r.phase!=='REVIEWING'||r.reason!=='REVIEW_SUPPLEMENT_PREPARED'||r.treeHash!==b.sourceHash||r.planVersionHash!==b.planVersionHash||r.flowConfigHash!==b.flowConfigHash||r.reviewSupplement?.recordId!==ack.reviewSupplement.recordId||r.reviewSupplement.sha256!==ack.reviewSupplement.sha256||
  r.calls!==b.calls||r.maxCalls!==b.maxCalls||r.repairCount!==b.repairCount||r.maxRepairs!==b.maxRepairs||r.createdAt!==b.createdAt||r.maxSeconds!==b.maxSeconds||JSON.stringify(r.review)!==JSON.stringify(b.originalReview)||
  r.verification?.ok!==true||r.verification.treeHash!==b.sourceHash||!r.tasks.length||r.tasks.some(t=>t.status!=='implemented'))return invalid();
 return raw;
}
export function reviewSupplementNotice(s:Snapshot|null,formalLocal:boolean):string{
 if(!formalLocal)return '';
 if(reviewSupplementBinding(s))return '<section class="notice warning" aria-label="补充材料后独立复审"><h3>独立审查尚未通过</h3><p>现有文件和测试记录保留。可以先核对补充材料，再决定是否只增加一次独立复审。</p><button type="button" data-action="review-supplement">核对补充复审条件</button></section>';
 const r=s?.runs[0];return r?.mode==='live'&&r.flowName==='classic'&&id(r.reviewSupplement?.recordId)&&sha(r.reviewSupplement?.sha256)?'<p class="notice">本轮已单独批准一次补充复审，原工程调用计数保留。实际用量与审查结论请查看本轮报告。</p>':'';
}
export function reviewSupplementConfirmation(_b:ReviewSupplementPreview):string{
 return '<h2 id="dialog-title">只追加一次独立复审</h2><p id="dialog-description">同一份方案、成果和测试继续保留。只额外允许一次 Codex 复审，不增加制作或返修；原费用、调用记录和时间设置不改写。</p><p>保存后仍保持暂停，不会自动调用模型、继续运行或接受成果。你可以核对账户和费用后，再单独点击“继续运行”。</p><form id="review-supplement-form"><label class="check"><input type="checkbox" name="reviewSupplementConsent" required><span>我批准只增加这一次独立复审；这不代表审查已通过或成果已接受。</span></label><div class="actions"><button type="button" data-action="close-modal">返回项目</button><button type="submit" class="primary">保存一次复审批准（不调用模型）</button></div></form>';
}
export function reviewSupplementError(code:string):string|undefined{
 if(code==='REVIEW_BLOCKED')return '独立审查尚未通过。现有成果已保留，请查看本轮报告与需要补充的材料。';
 if(code==='REVIEW_SUPPLEMENT_CALL_EXHAUSTED')return '单独批准的这一次复审已使用，不能自动再派发。请先查看本轮报告，保留当前成果与费用记录。';
 if(code.startsWith('REVIEW_SUPPLEMENT_'))return '补充复审还没有核清。已有文件与费用记录保留，请刷新项目并查看报告，不要直接重复提交。';
 return undefined;
}
