import type {Snapshot} from './contracts.js';import {UiError} from './contracts.js';
export interface ReviewPreparationBinding{
 projectId:string;runId:string;version:number;kind:'RECORDED_PACKET'|'SOURCE_VERSION';packetHash:string|null;sourceHash:string;
 calls:number;maxCalls:number;repairCount:number;maxRepairs:number;createdAt:string;maxSeconds:number;
}
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const counter=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export function reviewPreparationBinding(snapshot:Snapshot|null):ReviewPreparationBinding|null{
 const r=snapshot?.runs[0];
 const preAdmission=r?.reason==='REVIEW_ADMISSION_BINDING_INVALID';
 const probeBindingRecovery=r?.reason==='NATIVE_PROBE_MISSING'||r?.reason==='NATIVE_PROBE_BINDING_CHANGED';
 if(!r||snapshot!.project.activeRunId!==r.id||r.projectId!==snapshot!.project.id||r.mode!=='live'||r.flowName!=='classic'||
  r.state!=='BLOCKED'||r.phase!=='REVIEWING'||!['REVIEW_PACKET_LIMIT','REVIEW_ADMISSION_BINDING_INVALID','NATIVE_PROBE_MISSING','NATIVE_PROBE_BINDING_CHANGED'].includes(r.reason??'')||
  r.review!==null||r.sessions?.reviewer||r.roleIdentities?.reviewer||
  !r.tasks.length||r.tasks.some(t=>t.status!=='implemented')||!r.verification?.ok||!sha(r.treeHash)||
  ![r.version,r.calls,r.maxCalls,r.repairCount,r.maxRepairs,r.maxSeconds].every(counter)||r.version<1||
  (preAdmission||probeBindingRecovery?r.calls!==r.maxCalls||r.repairCount!==r.maxRepairs:r.calls>=r.maxCalls)||!Number.isFinite(Date.parse(r.createdAt)))return null;
 const packets=snapshot!.records.filter(row=>row.runId===r.id&&row.kind==='ReviewPacket');
 let kind:ReviewPreparationBinding['kind']='RECORDED_PACKET',packetHash:string|null=null;
 if(probeBindingRecovery){
  const candidate=r.reviewPreparationCandidate,last=packets.at(-1)?.data as {sha256?:unknown}|null;
  if(!candidate||candidate.kind!=='SOURCE_VERSION'||candidate.version!==r.version||candidate.sourceHash!==r.treeHash||
   packets.length!==2||!last||!sha(last.sha256))return null;
  kind='SOURCE_VERSION';
 }else if(packets.length===0){const candidate=r.reviewPreparationCandidate;
  if(!candidate||candidate.kind!=='SOURCE_VERSION'||candidate.version!==r.version||candidate.sourceHash!==r.treeHash)return null;
  kind='SOURCE_VERSION';
 }else{if(packets.length!==1)return null;const data=packets[0].data as {sha256?:unknown}|null;if(!data||!sha(data.sha256))return null;packetHash=data.sha256;}
 return {projectId:r.projectId,runId:r.id,version:r.version,kind,packetHash,sourceHash:r.treeHash,calls:r.calls,maxCalls:r.maxCalls,
  repairCount:r.repairCount,maxRepairs:r.maxRepairs,createdAt:r.createdAt,maxSeconds:r.maxSeconds};
}
export function reviewPreparationRequest(b:ReviewPreparationBinding){
 return b.kind==='SOURCE_VERSION'?{confirmed:true,bindingKind:'SOURCE_VERSION',sourceHash:b.sourceHash,expectedVersion:b.version}:{confirmed:true,packetHash:b.packetHash};
}
export function readReviewPreparationResult(raw:unknown,b:ReviewPreparationBinding):Snapshot{
 const s=raw as Snapshot,r=s?.runs?.find(run=>run.id===b.runId);
 if(!s?.project||s.project.id!==b.projectId||s.project.activeRunId!==b.runId||!r||r.projectId!==b.projectId||r.version!==b.version+1||
  r.state!=='PAUSED'||r.phase!=='REVIEWING'||r.reason!=='REVIEW_PREPARATION_RECHECKED'||r.review!==null||r.treeHash!==b.sourceHash||
  r.calls!==b.calls||r.maxCalls!==b.maxCalls||r.repairCount!==b.repairCount||r.maxRepairs!==b.maxRepairs||r.createdAt!==b.createdAt||r.maxSeconds!==b.maxSeconds)
  throw new UiError('REVIEW_PREPARATION_RESPONSE_INVALID','核对结果还没有确认，请刷新项目状态；没有自动继续审查或接受成果。');
 return s;
}
export function reviewPreparationNotice(s:Snapshot|null,formalLocal:boolean):string{
 return formalLocal&&reviewPreparationBinding(s)?'<section class="notice warning" aria-label="审查材料需要核对"><h3>审查尚未开始</h3><p>上次在准备审查材料时停止。现有文件和测试记录保留；先核对材料与进程状态，不调用模型。</p><button type="button" data-action="review-preparation">核对审查材料</button></section>':'';
}
export function reviewPreparationConfirmation():string{
 return '<h2 id="dialog-title">核对材料，准备独立审查</h2><p id="dialog-description">服务将检查同一份源码、已批准方案、完整测试记录及旧进程是否已结束。不会修改文件、调用模型、改写审查结果或接受成果。核对通过后保持暂停，之后另行点击“继续运行”，仍受账户、费用和当前运行条件约束。</p><form id="review-preparation-form"><label class="check"><input type="checkbox" name="reviewPreparationConsent" required><span>我确认只核对已有材料，准备后保持暂停；这不表示审查已经通过。</span></label><div class="actions"><button type="button" data-action="close-modal">返回项目</button><button type="submit" class="primary">核对并准备（不调用模型）</button></div></form>';
}
export function reviewPreparationError(code:string):string|undefined{
 if(code==='REVIEW_PACKET_LIMIT')return '审查材料的完整性或大小检查未通过，审查尚未开始。现有文件保留，请先核对审查材料。';
 if(code==='REVIEW_ADMISSION_BINDING_INVALID')return '独立审查在开始前停下了，没有生成审查结论。现有文件和测试记录保留，请先核对旧进程与材料绑定。';
 if(code==='NATIVE_PROBE_MISSING')return '当前没有可用的角色最小调用证明。请先重新核验所需角色，再继续；不会自动跳过或伪造证明。';
 if(code==='NATIVE_PROBE_BINDING_CHANGED')return '源码或配置已更新，旧的最小调用证明已失效。请重新核验所需角色后再继续；不会复用旧证明。';
 if(code==='REVIEW_PREPARATION_RECHECKED')return '材料已核对，流程保持暂停。账户、费用和当前运行条件满足后，可另行继续独立审查。';
 if(code.startsWith('REVIEW_PREPARATION_'))return '审查准备还没有核清。请保留现有文件并刷新项目状态，不要直接重复提交或接受成果。';
 return undefined;
}
