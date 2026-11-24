import type {Store} from './store.js';import type {DocumentationCorrectionCandidate} from '../shared/documentation-correction.js';
import {DomainError,hash,now,object} from './security.js';import {files} from './workspace.js';
import {validateWritePaths} from './flow/executor-slices.js';import {reviewSupplementEvidence} from './review-supplement.js';
import {TARGET_ROLE_POLICY} from './role-policy.js';
function fail():never{throw new DomainError('DOCUMENTATION_CORRECTION_UNAVAILABLE',409);}
/**
 * Original Store/source read only. This intentionally issues no permit,
 * approval, lease or model qualification.
 *
 * The storage names remain documentation-specific for compatibility with the
 * already accepted continuation lineage. A code candidate is a distinct schema
 * and only main.mjs can enter it.
 */
type CorrectionCandidateBase=Omit<DocumentationCorrectionCandidate,'candidateHash'|'authorization'>;
export interface OwnerBoundedCodeRepairApproval {
 schema:'dream-maker.owner-bounded-code-repair-approval.v1';approvedBy:'USER';approvedAt:string;sourceRef:string;
 statement:string;projectId:string;runId:string;specHash:string;sourceHash:string;reviewRecordId:string;
 file:'main.mjs';dshRepairTurns:1;reviewerReviews:1;maxRepairs:1;noAdditionalPlanning:true;freshIndependentReviewer:true;
}
export interface BoundedCodeRepairAuthorizationRequest {
 confirmed:true;file:'main.mjs';ownerApproval:OwnerBoundedCodeRepairApproval;
}
export interface BoundedCodeRepairAuthorization {
 schema:'dream-maker.bounded-code-repair-authorization.v1';projectId:string;runId:string;specHash:string;
 sourceHash:string;reviewRecordId:string;reviewRecordHash:string;candidateBaseHash:string;taskId:string;file:'main.mjs';
 dshRepairTurns:1;reviewerReviews:1;maxRepairs:1;noAdditionalPlanning:true;freshIndependentReviewer:true;
 ownerApproval:OwnerBoundedCodeRepairApproval;ownerApprovalHash:string;actorHash:string;requestHash:string;at:string;
}
const authorizationRequired=():never=>{throw new DomainError('BOUNDED_CODE_REPAIR_AUTHORIZATION_REQUIRED',409);};
const authorizationInvalid=(reason:string):never=>{throw new DomainError('BOUNDED_CODE_REPAIR_AUTHORIZATION_INVALID',409,reason);};
const authorizationChanged=():never=>{throw new DomainError('BOUNDED_CODE_REPAIR_AUTHORIZATION_CHANGED',409);};
function correctionCandidateBase(store:Store,rid:string,path:string,kind:'DOCUMENTATION'|'CODE'):CorrectionCandidateBase{
 try{
  const code=kind==='CODE';
  if(typeof path!=='string'||path.length>200||(code?path!=='main.mjs':!/\.(md|txt)$/i.test(path))||validateWritePaths([path])[0]!==path||path.endsWith('/'))fail();
  const r=store.run(rid),p=store.project(r.projectId),plan=r.planVersionId?store.planVersion(r.planVersionId):null;
  const continuationReasons=code
    ?['REPAIR_LIMIT','REVIEW_SUPPLEMENT_CHANGES_REQUESTED','BOUNDED_CODE_REPAIR_REVIEW_CHANGES_REQUESTED']
    :['REPAIR_LIMIT','REVIEW_SUPPLEMENT_CHANGES_REQUESTED'];
  if(r.mode!=='live'||p.mode!=='live'||r.flowName!=='classic'||r.rolePolicy!==TARGET_ROLE_POLICY||r.state!=='BLOCKED'||r.phase!=='REVIEWING'||!continuationReasons.includes(r.reason??'')||p.activeRunId!==rid||store.owns(p.id,rid)||p.specId!==r.specId||!plan?.approval||plan.projectId!==p.id||plan.contentHash!==r.planVersionHash||plan.specHash!==r.specHash||store.spec(specIdFor(store,r.specId)).stale||!store.approved(p.id,r.specHash,'SPEC')||!store.approved(p.id,r.specHash,'BUILD')||(code?r.calls>r.maxCalls:r.calls!==r.maxCalls)||r.repairCount!==r.maxRepairs)fail();
  const review=r.review,identity=r.roleIdentities?.reviewer;
  if(!r.treeHash||!review||review.verdict!=='CHANGES_REQUESTED'||review.source!=='CODEX'||review.treeHash!==r.treeHash||!review.findings.length||review.findings.some(f=>f.status!=='open')||!r.verification?.ok||r.verification.treeHash!==r.treeHash||r.tasks.some(t=>t.status!=='implemented'&&t.status!=='done')||!identity||identity.runner!=='CODEX_CLI'||identity.provider!=='openai'||identity.authentication!=='CHATGPT_SUBSCRIPTION'||identity.sessionId!==r.sessions.reviewer||identity.sessionId===r.sessions.planner2)fail();
  // The owner-authorized code path is deliberately one exact finding on one
  // exact file. It cannot be reused as a general code-writing continuation.
  if(code&&(review.findings.length!==1||!review.findings[0].evidence.includes(path)))fail();
  const scope=validateWritePaths([path]),tasks=r.tasks.filter(t=>t.writePaths&&hash(validateWritePaths(t.writePaths))===hash(scope));if(tasks.length!==1)fail();const task=tasks[0],planned=object(r.plan).tasks;
  if(!Array.isArray(planned)||planned.filter(t=>object(t).id===task.id&&hash(object(t).writePaths)===hash(scope)).length!==1)fail();
  const raw=store.db.prepare('SELECT id,kind,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097').all(p.id,rid);if(raw.length>4096)fail();
  const rows=raw.map(v=>({id:String(v.id),kind:String(v.kind),data:object(JSON.parse(String(v.data)))})),last=rows.filter(x=>x.kind==='Review').at(-1);if(!last)fail();
  const d=last.data;if(hash({verdict:d.verdict,source:d.source,treeHash:d.treeHash,findings:d.findings})!==hash(review))fail();
  const packetRow=rows.find(x=>x.id===d.packetId&&x.kind==='ReviewPacket');if(!packetRow||packetRow.data.sha256!==d.packetHash||hash(packetRow.data.packet)!==d.packetHash||rows.indexOf(packetRow)>=rows.indexOf(last))fail();
  const packet=object(packetRow.data.packet),history=packet.sourceHistory;if(packet.schema!=='dream-maker.review-packet.v1'||packet.runId!==rid||packet.specHash!==r.specHash||hash(packet.plan)!==hash(r.plan)||!Array.isArray(history)||object(history.at(-1)).treeHash!==r.treeHash)fail();
  const sessions=rows.filter(x=>x.kind==='AgentSession'&&x.data.role==='reviewer'&&x.data.sessionId===identity.sessionId);if(sessions.length!==1)fail();const session=sessions[0],dispatchId=session.data.dispatchId,generation=session.data.generation;
  if(session.data.modelEvidence!=='ADAPTER_VERIFIED_RESPONSE'||!['model','sessionId','requestId'].every(k=>typeof identity[k as keyof typeof identity]==='string'&&!!identity[k as keyof typeof identity])||!['runner','provider','authentication','model'].every(k=>session.data[k]===identity[k as keyof typeof identity])||session.data.requestId!==undefined&&session.data.requestId!==identity.requestId)fail();
  // Original AgentSession records intentionally omit requestId. Bind their original
  // official completion event instead of inventing a new field in historical rows.
  const usage=rows.slice(rows.indexOf(session)+1,rows.indexOf(last)).filter(x=>x.kind==='UsageLedger');
  if(usage.length!==1||usage[0].data.role!=='reviewer'||usage[0].data.requestId!==identity.requestId)fail();
  let completions=store.db.prepare("SELECT payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND json_extract(payload,'$.method')='dm/codexCompletion' AND json_extract(payload,'$.dispatchId')=? LIMIT 2").all(p.id,rid,String(dispatchId));
  // Ordinary pre-supplement events have no dispatch tags. Their unique official
  // thread/turn must also match the UsageLedger published with this AgentSession
  // after its exact cleaned Dispatch; never rewrite old events to invent tags.
  if(!completions.length)completions=store.db.prepare("SELECT payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND json_extract(payload,'$.method')='dm/codexCompletion' AND json_extract(payload,'$.params.threadId')=? AND json_extract(payload,'$.params.turnId')=? AND json_extract(payload,'$.dispatchId') IS NULL AND json_extract(payload,'$.generation') IS NULL LIMIT 2").all(p.id,rid,identity.sessionId,identity.requestId);
  if(completions.length>1||session.data.requestId===undefined&&completions.length!==1)fail();
  if(completions.length){const e=object(JSON.parse(String(completions[0].payload))),v=object(e.params);if(e.dispatchId!==undefined&&(e.dispatchId!==dispatchId||e.generation!==generation)||v.role!=='reviewer'||v.threadId!==identity.sessionId||v.turnId!==identity.requestId||v.status!=='completed'||v.model!==identity.model||v.provider!==identity.provider||v.runId!==rid||v.specHash!==r.specHash)fail();}
  const grants=rows.filter(x=>x.kind==='DispatchGranted'&&x.data.dispatchId===dispatchId),ends=rows.filter(x=>x.kind==='DispatchFinished'&&x.data.dispatchId===dispatchId);
  if(typeof dispatchId!=='string'||!dispatchId||typeof generation!=='string'||!generation||grants.length!==1||ends.length!==1||grants[0].data.kind!=='reviewer'||grants[0].data.mode!=='live'||grants[0].data.generation!==generation||ends[0].data.generation!==generation||ends[0].data.outcome!=='COMPLETED'||ends[0].data.cleanupReturned!==true||!(rows.indexOf(packetRow)<rows.indexOf(grants[0])&&rows.indexOf(grants[0])<rows.indexOf(ends[0])&&rows.indexOf(ends[0])<rows.indexOf(session)&&rows.indexOf(session)<rows.indexOf(last)))fail();
  const during=rows.slice(rows.indexOf(grants[0])+1,rows.indexOf(ends[0])),processes=during.filter(x=>x.kind==='OwnedProcessIntent');
  if(!processes.length||new Set(processes.map(x=>x.data.processId)).size!==processes.length||during.some(x=>x.kind==='ToolIntent'||x.kind==='ToolResult')||processes.some(x=>{const closed=during.filter(c=>c.kind==='OwnedProcessCleanup'&&c.data.processId===x.data.processId);return typeof x.data.processId!=='string'||!x.data.processId||x.data.platform!=='win32'||x.data.dispatchId!==dispatchId||x.data.generation!==generation||closed.length!==1||closed[0].data.generation!==generation||closed[0].data.dispatchId!==dispatchId||closed[0].data.cleanupReturned!==true||during.indexOf(closed[0])<=during.indexOf(x);} ))fail();
  const manifest=files(r.workspace);if(hash(manifest)!==r.treeHash)fail();const selected=manifest.find(f=>f.path===path),protectedFiles=manifest.filter(f=>f.path!==path);if(!selected||!protectedFiles.length)fail();
  const supplement=r.reviewSupplement?reviewSupplementEvidence(store,r):null;if(r.reason==='REVIEW_SUPPLEMENT_CHANGES_REQUESTED'&&supplement?.used!==1)fail();
   const body={schema:code?'dream-maker.bounded-code-repair-candidate.v1' as const:'dream-maker.documentation-correction-candidate.v1' as const,...(code?{repairKind:'CODE' as const}:{}),runId:rid,projectId:p.id,specHash:r.specHash,sourceHash:r.treeHash,expectedVersion:r.version,planVersionId:plan.id,planVersionHash:plan.contentHash,planHash:hash(r.plan),taskId:task.id,writePaths:scope,selectedFile:selected,protectedFileCount:protectedFiles.length,protectedFilesHash:hash(protectedFiles),protectedFileExamples:protectedFiles.slice(0,8),reviewRecordId:last.id,reviewPacketHash:String(d.packetHash),reviewDispatchId:dispatchId,findings:review.findings.map(({id,severity,description,evidence})=>({id,severity,description,evidence})),parentCalls:r.calls,parentMaxCalls:r.maxCalls,parentRepairs:r.repairCount,parentMaxRepairs:r.maxRepairs,parentSupplementalCalls:supplement?.used??0,additionalCalls:2 as const,additionalRepairRounds:1 as const,executionGranted:false as const,roleQualification:'NOT_CHECKED_BY_CANDIDATE' as const,requiresOwnerConfirmation:true as const,requiresOwnedProcessInspection:true as const};
   return body;
 }catch(error){if(error instanceof DomainError&&error.code==='DOCUMENTATION_CORRECTION_UNAVAILABLE')throw error;fail();}
}
const specIdFor=(store:Store,specId:string)=>specId;
export function documentationCorrectionCandidate(store:Store,rid:string,path:string):DocumentationCorrectionCandidate{
 const body=correctionCandidateBase(store,rid,path,'DOCUMENTATION');return {...body,candidateHash:hash(body)};
}
function authorizationRows(store:Store,projectId:string,runId:string){
 return store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='BoundedCodeRepairAuthorization' ORDER BY rowid LIMIT 2")
  .all(projectId,runId).map(row=>{
   if(typeof row.data!=='string'||Buffer.byteLength(row.data)>128000)return authorizationInvalid('authorization record is invalid');
   const data=object(JSON.parse(row.data)) as unknown as BoundedCodeRepairAuthorization;
   return {recordId:String(row.id),sha256:hash(data),data};
  });
}
function validateAuthorization(base:CorrectionCandidateBase,recordId:string,data:BoundedCodeRepairAuthorization){
 const owner=data.ownerApproval;
 if(!object(owner))authorizationInvalid('owner approval is not an object');
 if(owner.schema!=='dream-maker.owner-bounded-code-repair-approval.v1'||owner.approvedBy!=='USER'||
   typeof owner.approvedAt!=='string'||!Number.isFinite(Date.parse(owner.approvedAt))||typeof owner.sourceRef!=='string'||!owner.sourceRef||
   typeof owner.statement!=='string'||!owner.statement)authorizationInvalid('owner approval fields are invalid');
 if(owner.projectId!==base.projectId||owner.runId!==base.runId||owner.specHash!==base.specHash||owner.sourceHash!==base.sourceHash||
   owner.reviewRecordId!==base.reviewRecordId||owner.file!=='main.mjs'||owner.dshRepairTurns!==1||owner.reviewerReviews!==1||
   owner.maxRepairs!==1||owner.noAdditionalPlanning!==true||owner.freshIndependentReviewer!==true)
  authorizationInvalid('owner approval binding changed');
 if(data.schema!=='dream-maker.bounded-code-repair-authorization.v1'||data.projectId!==base.projectId||data.runId!==base.runId||
   data.specHash!==base.specHash||data.sourceHash!==base.sourceHash||data.reviewRecordId!==base.reviewRecordId||
   typeof data.reviewRecordHash!=='string'||!/^[a-f0-9]{64}$/.test(data.reviewRecordHash)||data.candidateBaseHash!==hash(base)||
   data.taskId!==base.taskId||data.file!=='main.mjs'||data.dshRepairTurns!==1||data.reviewerReviews!==1||data.maxRepairs!==1||
   data.noAdditionalPlanning!==true||data.freshIndependentReviewer!==true)authorizationInvalid('authorization binding changed');
 if(data.ownerApprovalHash!==hash(owner))authorizationInvalid('owner approval hash changed');
 if(typeof data.actorHash!=='string'||!/^[a-f0-9]{64}$/.test(data.actorHash)||typeof data.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(data.requestHash)||
   typeof data.at!=='string'||!Number.isFinite(Date.parse(data.at)))authorizationInvalid('authorization metadata is invalid');
 return {recordId,sha256:hash(data),data};
}
/** Owner-authorized one-file code repair; read-only until a separate successor approval. */
export function boundedCodeRepairCandidate(store:Store,rid:string,path:string):DocumentationCorrectionCandidate{
 const base=correctionCandidateBase(store,rid,path,'CODE'),rows=authorizationRows(store,base.projectId,base.runId);
 if(rows.length===0)return authorizationRequired();
 if(rows.length!==1)return authorizationChanged();
 const authorization=validateAuthorization(base,rows[0].recordId,rows[0].data);
 return {...base,authorization:{recordId:authorization.recordId,sha256:authorization.sha256},
  candidateHash:hash({...base,authorization:{recordId:authorization.recordId,sha256:authorization.sha256}})};
}
/** One-off operator action. The public HTTP API never receives owner evidence. */
export async function registerBoundedCodeRepairAuthorization(
 store:Store,rid:string,request:BoundedCodeRepairAuthorizationRequest,actor:string,
):Promise<BoundedCodeRepairAuthorization&{recordId:string;sha256:string}>{
 if(!/^local-session:[a-f0-9]{64}$/.test(actor)||!object(request)||request.confirmed!==true||request.file!=='main.mjs'||
   Object.keys(request).sort().join(',')!=='confirmed,file,ownerApproval'||!object(request.ownerApproval))
   return authorizationInvalid('request shape is invalid');
 const approval=request.ownerApproval;
 if(Object.keys(approval).sort().join(',')!==[
  'schema','approvedBy','approvedAt','sourceRef','statement','projectId','runId','specHash','sourceHash','reviewRecordId','file',
  'dshRepairTurns','reviewerReviews','maxRepairs','noAdditionalPlanning','freshIndependentReviewer',
 ].sort().join(',')||approval.schema!=='dream-maker.owner-bounded-code-repair-approval.v1'||approval.approvedBy!=='USER'||
    !Number.isFinite(Date.parse(approval.approvedAt))||typeof approval.sourceRef!=='string'||!approval.sourceRef.trim()||approval.sourceRef.length>200||
    typeof approval.statement!=='string'||!approval.statement.trim()||approval.statement.length>2000||
   approval.file!=='main.mjs'||approval.dshRepairTurns!==1||approval.reviewerReviews!==1||approval.maxRepairs!==1||
   approval.noAdditionalPlanning!==true||approval.freshIndependentReviewer!==true)
   return authorizationInvalid('owner approval shape is invalid');
 const base=correctionCandidateBase(store,rid,request.file,'CODE'),rowsList=authorizationRows(store,base.projectId,base.runId);
 if(rowsList.length>1)return authorizationChanged();
 const parent=store.run(rid),reviewRow=store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND id=? AND kind='Review'")
  .get(base.projectId,base.runId,base.reviewRecordId);
 if(!reviewRow||typeof reviewRow.data!=='string'||Buffer.byteLength(reviewRow.data)>128000)return authorizationInvalid('review record is invalid');
 const at=now(),body:BoundedCodeRepairAuthorization={
  schema:'dream-maker.bounded-code-repair-authorization.v1',projectId:base.projectId,runId:base.runId,specHash:parent.specHash,
  sourceHash:base.sourceHash,reviewRecordId:base.reviewRecordId,reviewRecordHash:hash(JSON.parse(reviewRow.data)),
  candidateBaseHash:hash(base),taskId:base.taskId,file:'main.mjs',dshRepairTurns:1,reviewerReviews:1,maxRepairs:1,
  noAdditionalPlanning:true,freshIndependentReviewer:true,ownerApproval:approval,ownerApprovalHash:hash(approval),
  actorHash:hash(actor),requestHash:hash(request),at,
 };
 validateAuthorization(base,'OFFLINE_AUTH_VALIDATION',body);
 if(rowsList.length){
  const existing=rowsList[0];
  const stable=(value:BoundedCodeRepairAuthorization)=>hash({...value,at:undefined});
  if(stable(existing.data)!==stable(body))return authorizationChanged();
  validateAuthorization(base,existing.recordId,existing.data);
  return {...existing.data,recordId:existing.recordId,sha256:existing.sha256};
 }
 const recordId=await store.once('bounded-code-repair-authorization:'+base.runId,{
  candidateBaseHash:body.candidateBaseHash,ownerApprovalHash:body.ownerApprovalHash,
 },async()=>{
  const current=correctionCandidateBase(store,rid,request.file,'CODE');
  if(hash(current)!==body.candidateBaseHash)return authorizationChanged();
  const id=store.tx(()=>{
   const row=store.record('BoundedCodeRepairAuthorization',base.projectId,base.runId,body);
   store.event(base.projectId,base.runId,'run.bounded-code-repair.authorized',{
    authorizationRecordId:row,file:'main.mjs',dshRepairTurns:1,reviewerReviews:1,modelDispatched:false,
   });
   return row;
  });
  return id;
 });
 return {...body,recordId,sha256:hash(body)};
}
