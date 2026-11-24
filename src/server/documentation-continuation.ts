import {mkdirSync,writeFileSync} from 'node:fs';import {dirname} from 'node:path';
import type {Config,Run} from '../shared/types.js';import type {Store} from './store.js';
import type {DocumentationCorrectionCandidate,DocumentationCustodyPrepared} from '../shared/documentation-correction.js';
import {DomainError,hash,id,now,object,within} from './security.js';import {files,get} from './workspace.js';
import {classicFlowSnapshot,runUsesLaya} from './flow-configuration.js';
export interface DocumentationContinuationRequest {confirmed:boolean;file:string;candidateHash:string;taskDeadline:null}
export interface DocumentationContinuationCallExtensionRequest {
 confirmed:true;expectedVersion:number;approvalRecordId:string;approvalHash:string;ownerDecisionHash:string;
}
export interface DocumentationContinuationCallExtension {
 schema:'dream-maker.documentation-continuation-call-extension.v1';runId:string;projectId:string;
 approvalRecordId:string;approvalHash:string;previousRunVersion:number;previousMaxCalls:2;
 newMaxCalls:3;previousSeriesMaxCalls:number;newSeriesMaxCalls:number;additionalCalls:1;
 scope:'ONE_ADDITIONAL_ENGINEERING_CALL_NO_REPAIR';ownerDecisionHash:string;actorHash:string;
 requestHash:string;at:string;confirmed:true;modelDispatched:false;automaticRepair:false;
}
export interface BoundedCodeVerificationRecoveryRequest {
 confirmed:true;expectedVersion:number;sourceHash:string;verificationEvidenceId:string;ownerDecisionHash:string;
}
export interface BoundedCodeReviewRecoveryRequest {
 confirmed:true;expectedVersion:number;sourceHash:string;verificationEvidenceId:string;reviewPacketId:string;ownerDecisionHash:string;
}
export interface BoundedCodeVerificationRecovery {
 schema:'dream-maker.bounded-code-verification-recovery.v1'|'dream-maker.bounded-code-verification-recovery.v2';runId:string;projectId:string;
 approvalRecordId:string;approvalHash:string;parentRunId:string;previousVersion:number;
 previousState:'BLOCKED';previousPhase:'VERIFYING';
 previousReason:'BOUNDED_CODE_REPAIR_VERIFICATION_FAILED';
  previousCalls:1|2|3|4;previousMaxCalls:2|3|4|5;newMaxCalls:3|4|5|6;repairCount:1;maxRepairs:1;
 sourceHash:string;verificationEvidenceId:string;verificationEvidenceHash:string;
 failedCaseId:'C16_MALFORMED_JSON';failedCaseHash:string;
  firstExecutorSessionId:string;firstExecutorRequestId:string;firstExecutorEvidenceHash:string;
 previousRecoveryRecordId?:string;previousRecoveryHash?:string;
 previousExecutorSessionId?:string;previousExecutorRequestId?:string;previousExecutorEvidenceHash?:string;
 taskId:string;writePaths:string[];requestHash:string;ownerDecisionHash:string;actorHash:string;
 additionalDshRepairs:1;additionalReviewerReviews:1;at:string;confirmed:true;
 modelDispatched:false;automaticRetry:false;
}
interface BoundedCodeRecoveryRecordRef {id:string;kind:string;sha256:string}
interface BoundedCodeRecoveryEventRef {id:number;sha256:string}
export interface BoundedCodeReviewRecovery {
 schema:'dream-maker.bounded-code-review-recovery.v1';runId:string;projectId:string;
 approvalRecordId:string;approvalHash:string;parentRunId:string;previousVersion:number;
 previousState:'BLOCKED';previousPhase:'REVIEWING';previousReason:'CODEX_INCLUDED_USAGE_UNAVAILABLE';
 previousCalls:2;previousMaxCalls:2;newMaxCalls:4;repairCount:1;maxRepairs:1;
 sourceHash:string;verificationEvidenceId:string;verificationEvidenceHash:string;
 reviewPacketId:string;reviewPacketHash:string;
 reviewerDispatchId:string;reviewerDispatchGeneration:string;
 reviewerDispatch:{queued:BoundedCodeRecoveryRecordRef;granted:BoundedCodeRecoveryRecordRef;
   finished:BoundedCodeRecoveryRecordRef;cleanup:BoundedCodeRecoveryRecordRef[]};
 reviewerPreparation:BoundedCodeRecoveryEventRef[];
 firstExecutorSessionId:string;firstExecutorRequestId:string;firstExecutorEvidenceHash:string;
 taskId:string;writePaths:string[];requestHash:string;ownerDecisionHash:string;actorHash:string;
 additionalDshRepairs:1;additionalReviewerReviews:1;at:string;confirmed:true;
 modelDispatched:false;automaticRetry:false;
}
export interface DocumentationContinuationApproval {
 schema:'dream-maker.documentation-continuation.v1'|'dream-maker.bounded-code-repair-continuation.v1';
 repairKind?:'CODE';runId:string;projectId:string;parentRunId:string;parentRunHash:string;
 parentReviewRecordId:string;parentPlanRecordId:string;parentPlannerSessionRecordId:string;
 parentReviewRecordHash:string;parentReviewPacketId:string;parentReviewPacketHash:string;
 parentPlannerRequestId:string;parentPlannerUsageRecordId:string;parentPlannerCompletionEventId:number;
 parentPlanHash:string;parentSourceHash:string;candidateHash:string;custodyRecordId:string;custodyHash:string;
 planVersionId:string;planVersionHash:string;flowConfigHash:string;taskId:string;writePaths:string[];
 protectedFiles:{path:string;bytes:number;sha256:string}[];parentCalls:number;parentSupplementalCalls:number;seriesMaxCalls:number;
 additionalCalls:2;additionalRepairs:1;taskDeadline:null;actorHash:string;at:string;confirmed:true;modelDispatched:false;
}
export interface DocumentationNativeBudgetOps {
 repairRevision(runId:string):number;
 reserveRepair(runId:string):void;
}
interface PlanningReference {
 planRecordId:string;sessionRecordId:string;requestId:string;usageRecordId:string;completionEventId:number;
 identity:{runner:string;provider:string;authentication:string;model:string;sessionId:string;requestId:string};
}
const fail=():never=>{throw new DomainError('DOCUMENTATION_CONTINUATION_CHANGED',409);};
const extensionChanged=():never=>{throw new DomainError('DOCUMENTATION_CALL_EXTENSION_CHANGED',409);};
const extensionNotEligible=():never=>{throw new DomainError('DOCUMENTATION_CALL_EXTENSION_NOT_ELIGIBLE',409);};
const recoveryChanged=():never=>{throw new DomainError('BOUNDED_CODE_REPAIR_RECOVERY_CHANGED',409);};
const recoveryNotEligible=():never=>{throw new DomainError('BOUNDED_CODE_REPAIR_RECOVERY_NOT_ELIGIBLE',409);};
const recoveryAlreadyUsed=():never=>{throw new DomainError('BOUNDED_CODE_REPAIR_RECOVERY_ALREADY_USED',409);};
const reviewRecoveryChanged=():never=>{throw new DomainError('BOUNDED_CODE_REVIEW_RECOVERY_CHANGED',409);};
const reviewRecoveryNotEligible=():never=>{throw new DomainError('BOUNDED_CODE_REVIEW_RECOVERY_NOT_ELIGIBLE',409);};
const reviewRecoveryAlreadyUsed=():never=>{throw new DomainError('BOUNDED_CODE_REVIEW_RECOVERY_ALREADY_USED',409);};
const MAX_BOUNDED_VERIFICATION_RECOVERIES=4;
const protectedSourceChanged=():never=>{throw new DomainError('DOCUMENTATION_CONTINUATION_PROTECTED_SOURCE_CHANGED',409);};
const isCode=(approval:{schema:DocumentationContinuationApproval['schema'];repairKind?:'CODE'})=>
 approval.schema==='dream-maker.bounded-code-repair-continuation.v1'&&approval.repairKind==='CODE';
const read=(store:Store,projectId:string,runId:string,recordId:string,kind:string)=>{
 const row=store.db.prepare('SELECT data FROM records WHERE project_id=? AND run_id=? AND id=? AND kind=?').get(projectId,runId,recordId,kind);if(!row)return fail();return object(JSON.parse(String(row.data)));
};
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function exactExecutorEvidence(store:Store,run:Run,expectedSessions=1){
 const identity=run.roleIdentities?.executor,sessionId=run.sessions.executor;
 if(!identity||!sessionId||identity.sessionId!==sessionId||identity.runner!=='DSH'||identity.provider!=='deepseek-official'||
   identity.authentication!=='API_KEY'||Object.keys(run.sessions).some(role=>role!=='executor'&&role!=='reviewer'))return null;
 const sessions=store.records(run.projectId,'AgentSession').filter(row=>row.runId===run.id&&row.data.role==='executor');
 const usage=store.records(run.projectId,'UsageLedger').filter(row=>row.runId===run.id&&row.data.role==='executor');
 if(sessions.length!==expectedSessions||usage.length!==expectedSessions)return null;
 const latest=sessions.at(-1)?.data,ledger=usage.at(-1)?.data;
 if(!latest||!ledger||latest.sessionId!==sessionId||latest.modelEvidence!=='ADAPTER_VERIFIED_RESPONSE'||
   !['runner','provider','authentication','model'].every(key=>latest[key]===identity[key as keyof typeof identity])||
   ledger.requestId!==identity.requestId)return null;
 return{
  identity:structuredClone(identity),sessionId,identityHash:hash(identity),
  sessions:sessions.map(row=>({id:String(row.id),data:row.data})),
  usage:usage.map(row=>({id:String(row.id),data:row.data})),
 };
}
function exactC16FailureEvidence(store:Store,run:Run,evidenceId:string){
 if(run.verification?.ok!==false||run.verification.evidenceId!==evidenceId||run.verification.treeHash!==run.treeHash)return null;
 const row=store.db.prepare("SELECT run_id,data FROM records WHERE project_id=? AND id=? AND kind='Evidence'").get(run.projectId,evidenceId);
 if(!row||String(row.run_id)!==run.id)return null;
 const evidence=object(JSON.parse(String(row.data)));
 if(evidence.treeHash!==run.treeHash||evidence.specHash!==run.specHash||evidence.code!==run.verification.exitCode||
   evidence.stdout!==run.verification.stdout||evidence.stderr!==run.verification.stderr||
   hash(evidence.command)!==hash(run.verification.command)||typeof evidence.stdout!=='string')return null;
 let raw:any;
 try{raw=object(JSON.parse(evidence.stdout));}catch{return null;}
 if(raw.schema!=='dream-maker.trusted-cli-evidence.v2'||raw.specHash!==run.specHash||raw.sourceHash!==run.treeHash||
   raw.ok!==false||!Array.isArray(raw.cases)||raw.cases.length!==20)return null;
 const cases=raw.cases.map(object);
 if(new Set(cases.map((item:any)=>item.id)).size!==20)return null;
 const failed=cases.filter((item:any)=>item.ok!==true);
 if(failed.length!==1||failed[0].id!=='C16_MALFORMED_JSON'||failed[0].status!=='EXECUTED'||
   failed[0].sourceHash!==run.treeHash||failed[0].outputMatched!==true||failed[0].diagnosticMatched!==false)return null;
 return{failedCaseHash:hash(failed[0]),evidenceHash:hash(evidence)};
}
function exactSuccessfulVerificationEvidence(store:Store,run:Run,evidenceId:string,expectedSourceHash=run.treeHash){
 const row=store.db.prepare("SELECT run_id,data FROM records WHERE project_id=? AND id=? AND kind='Evidence'")
   .get(run.projectId,evidenceId);
 if(!row||String(row.run_id)!==run.id)return null;
 const evidence=object(JSON.parse(String(row.data)));
 if(evidence.specHash!==run.specHash||evidence.treeHash!==expectedSourceHash||evidence.scope!=='LIVE_VERIFIER'||
   typeof evidence.stdout!=='string'||Buffer.byteLength(evidence.stdout)>2*1024*1024)return null;
 let raw:any;
 try{raw=object(JSON.parse(evidence.stdout));}catch{return null;}
 if(raw.schema!=='dream-maker.trusted-cli-evidence.v2'||raw.specHash!==run.specHash||
   raw.sourceHash!==expectedSourceHash||raw.ok!==true||!Array.isArray(raw.cases)||raw.cases.length!==20)return null;
 const cases=raw.cases.map(object);
 if(new Set(cases.map((item:any)=>item.id)).size!==20||
   cases.some((item:any)=>item.status!=='EXECUTED'||item.ok!==true||item.outputMatched!==true||
     item.diagnosticMatched!==true||item.sourceHash!==expectedSourceHash))return null;
 return{evidenceHash:hash(evidence),casesHash:hash(cases)};
}
function recoveryRecordRef(store:Store,projectId:string,runId:string,id:string,kind:string){
 const row=store.db.prepare('SELECT id,run_id,kind,data FROM records WHERE project_id=? AND id=? AND kind=?')
   .get(projectId,id,kind);
 if(!row||String(row.run_id)!==runId)return null;
 const data=object(JSON.parse(String(row.data)));
 return{ref:{id:String(row.id),kind:String(row.kind),sha256:hash(data)},data};
}
function exactCodexUsageBlockedReviewer(store:Store,run:Run,reviewPacketId:string,expectedSourceHash=run.treeHash){
 const packetRow=store.db.prepare("SELECT id,run_id,data FROM records WHERE project_id=? AND id=? AND kind='ReviewPacket'")
   .get(run.projectId,reviewPacketId);
 if(!packetRow||String(packetRow.run_id)!==run.id)return null;
 const packetRecord=object(JSON.parse(String(packetRow.data))),packet=object(packetRecord.packet);
 if(packetRecord.sha256!==hash(packet)||packet.schema!=='dream-maker.review-packet.v1'||
   packet.runId!==run.id||packet.specHash!==run.specHash||
   !Array.isArray(packet.sourceHistory)||!packet.sourceHistory.length||
   object(packet.sourceHistory.at(-1)).treeHash!==expectedSourceHash)return null;
 const queued=store.db.prepare(
   "SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='DispatchQueued' AND json_extract(data,'$.kind')='reviewer' ORDER BY rowid LIMIT 2",
 ).all(run.projectId,run.id);
 if(queued.length!==1)return null;
 const queuedData=object(JSON.parse(String(queued[0].data))),dispatchId=String(queuedData.dispatchId),generation=String(queuedData.generation);
 const granted=store.db.prepare(
   "SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='DispatchGranted' AND json_extract(data,'$.dispatchId')=? ORDER BY rowid LIMIT 2",
 ).all(run.projectId,run.id,dispatchId);
 const finished=store.db.prepare(
   "SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='DispatchFinished' AND json_extract(data,'$.dispatchId')=? ORDER BY rowid LIMIT 2",
 ).all(run.projectId,run.id,dispatchId);
 if(granted.length!==1||finished.length!==1)return null;
 const grantedData=object(JSON.parse(String(granted[0].data))),finishedData=object(JSON.parse(String(finished[0].data)));
 if(grantedData.generation!==generation||grantedData.cleanupReturned!==false||
   finishedData.generation!==generation||finishedData.outcome!=='CODEX_INCLUDED_USAGE_UNAVAILABLE'||
   finishedData.cleanupReturned!==true)return null;
 const cleanupKinds=['OwnedProcessIntent','OwnedProcessRootStarted','OwnedProcessRootExited','OwnedProcessCleanup',
   'OwnedWindowsJobIntent','OwnedWindowsJobPinned','OwnedWindowsJobClosed'];
 const cleanupRows=store.db.prepare(
   "SELECT id,kind,data FROM records WHERE project_id=? AND run_id=? AND json_extract(data,'$.dispatchId')=? AND kind IN ("+
   cleanupKinds.map(()=>'?').join(',')+") ORDER BY rowid LIMIT 32",
 ).all(run.projectId,run.id,dispatchId,...cleanupKinds);
 if(cleanupRows.length!==cleanupKinds.length)return null;
 const cleanup=cleanupRows.map(row=>({ref:{id:String(row.id),kind:String(row.kind),sha256:hash(object(JSON.parse(String(row.data))))},
   data:object(JSON.parse(String(row.data)))}));
 const cleanupByKind=new Map(cleanup.map(row=>[row.ref.kind,row]));
 if(cleanupByKind.size!==cleanupKinds.length||cleanupKinds.some(kind=>!cleanupByKind.has(kind)))return null;
 const processIntent=cleanupByKind.get('OwnedProcessIntent')!.data,
   rootStarted=cleanupByKind.get('OwnedProcessRootStarted')!.data,
   rootExited=cleanupByKind.get('OwnedProcessRootExited')!.data,
   processCleanup=cleanupByKind.get('OwnedProcessCleanup')!.data,
   jobIntent=cleanupByKind.get('OwnedWindowsJobIntent')!.data,
   jobPinned=cleanupByKind.get('OwnedWindowsJobPinned')!.data,
   jobClosed=cleanupByKind.get('OwnedWindowsJobClosed')!.data;
 const processIds=[processIntent,rootStarted,rootExited,processCleanup,jobIntent,jobPinned,jobClosed]
   .map(data=>data.processId);
 if(typeof processIds[0]!=='string'||!processIds[0]||new Set(processIds).size!==1||
   processIntent.platform!=='win32'||rootStarted.identityState!=='OS_START_IDENTITY'||
   rootExited.rootClosed!==true||processCleanup.cleanupReturned!==true)return null;
 const jobIds=[jobIntent,jobPinned,jobClosed].map(data=>data.jobId);
 if(typeof jobIds[0]!=='string'||!/^windows_job_[a-f0-9]{20}$/.test(jobIds[0])||new Set(jobIds).size!==1||
   typeof jobPinned.markerSha256!=='string'||!sha(jobPinned.markerSha256)||
   typeof jobPinned.helperSha256!=='string'||!sha(jobPinned.helperSha256)||
   jobIntent.helperSha256!==jobPinned.helperSha256||jobClosed.helperSha256!==jobPinned.helperSha256||
   jobClosed.markerSha256!==jobPinned.markerSha256||jobClosed.activeProcesses!==0)return null;
 const proof=object(jobClosed.proof);
 if(proof.kind!=='TRUSTED_WINDOWS_JOB'||proof.scopeId!==jobIds[0]||
   typeof proof.receiptSha256!=='string'||!sha(proof.receiptSha256)||
   processCleanup.kind!=='TRUSTED_WINDOWS_JOB'||processCleanup.scopeId!==jobIds[0]||
   processCleanup.receiptSha256!==proof.receiptSha256)return null;
 const prepRows=store.db.prepare(
   "SELECT id,payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND "+
   "json_extract(payload,'$.method')='dm/codexPreparation' AND json_extract(payload,'$.params.role')='reviewer' ORDER BY id LIMIT 8",
 ).all(run.projectId,run.id);
 const expected=[['initialize','STARTED'],['initialize','COMPLETED'],['account/read','STARTED'],['account/read','COMPLETED'],
   ['account/rateLimits/read','STARTED'],['account/rateLimits/read','COMPLETED']];
 if(prepRows.length!==expected.length)return null;
 const preparation=prepRows.map((row,index)=>{
   const data=object(JSON.parse(String(row.payload))),params=object(data.params);
   if(data.method!=='dm/codexPreparation'||params.role!=='reviewer'||params.method!==expected[index][0]||
     params.status!==expected[index][1])return null;
   return{id:Number(row.id),sha256:hash(data)};
 });
 if(preparation.some(item=>item===null))return null;
 const modelEvents=store.db.prepare(
   "SELECT count(*) n FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND ("+
   "json_extract(payload,'$.method') IN ('dm/codexAdmission','dm/codexCompletion','thread/start','turn/start','model/generate') OR "+
   "json_extract(payload,'$.params.method') IN ('thread/start','turn/start','model/generate'))",
 ).get(run.projectId,run.id);
 if(Number(modelEvents?.n)!==0||run.review!==null||run.sessions.reviewer!==undefined||run.roleIdentities?.reviewer||
   store.records(run.projectId,'AgentSession').some(row=>row.runId===run.id&&row.data.role==='reviewer')||
   store.records(run.projectId,'UsageLedger').some(row=>row.runId===run.id&&row.data.role==='reviewer')||
   store.records(run.projectId,'Review').some(row=>row.runId===run.id))return null;
 return{
   reviewPacketHash:String(packetRecord.sha256),
   reviewerDispatchId:dispatchId,reviewerDispatchGeneration:generation,
   queued:{id:String(queued[0].id),kind:'DispatchQueued',sha256:hash(queuedData)},
   granted:{id:String(granted[0].id),kind:'DispatchGranted',sha256:hash(grantedData)},
   finished:{id:String(finished[0].id),kind:'DispatchFinished',sha256:hash(finishedData)},
   cleanup:cleanup.map(row=>row.ref),preparation:preparation as BoundedCodeRecoveryEventRef[],
 };
}
function boundedCodeReviewRecoveryEvidence(store:Store,run:Run,approval:DocumentationContinuationApproval){
 const rows=store.db.prepare(
   "SELECT id,run_id,data FROM records WHERE project_id=? AND run_id=? AND kind='BoundedCodeReviewRecovery' ORDER BY rowid LIMIT 2",
 ).all(run.projectId,run.id);
 if(run.boundedCodeReviewRecovery===undefined){if(rows.length)return reviewRecoveryChanged();return null;}
 if(rows.length!==1||run.boundedCodeReviewRecovery===undefined||String(rows[0].id)!==run.boundedCodeReviewRecovery.recordId)
   return reviewRecoveryChanged();
 if(String(rows[0].run_id)!==run.id||typeof rows[0].data!=='string')return reviewRecoveryChanged();
 const data=object(JSON.parse(String(rows[0].data))) as unknown as BoundedCodeReviewRecovery;
 if(hash(data)!==run.boundedCodeReviewRecovery.sha256||data.schema!=='dream-maker.bounded-code-review-recovery.v1'||
   data.runId!==run.id||data.projectId!==run.projectId||data.approvalRecordId!==run.documentationContinuation?.recordId||
   data.approvalHash!==run.documentationContinuation?.sha256||data.parentRunId!==approval.parentRunId||
   data.previousState!=='BLOCKED'||data.previousPhase!=='REVIEWING'||data.previousReason!=='CODEX_INCLUDED_USAGE_UNAVAILABLE'||
   data.previousCalls!==2||data.previousMaxCalls!==2||data.newMaxCalls!==4||data.repairCount!==1||data.maxRepairs!==1||
   data.taskId!==approval.taskId||hash(data.writePaths)!==hash(approval.writePaths)||
   data.additionalDshRepairs!==1||data.additionalReviewerReviews!==1||data.confirmed!==true||
   data.modelDispatched!==false||data.automaticRetry!==false||!sha(data.sourceHash)||
   !sha(data.verificationEvidenceHash)||!sha(data.reviewPacketHash)||!sha(data.firstExecutorEvidenceHash)||
   !sha(data.requestHash)||!sha(data.ownerDecisionHash)||!sha(data.actorHash)||
   !Array.isArray(data.reviewerPreparation)||data.reviewerPreparation.length!==6||
   !Array.isArray(data.reviewerDispatch?.cleanup))return reviewRecoveryChanged();
 const verification=exactSuccessfulVerificationEvidence(store,run,data.verificationEvidenceId,data.sourceHash);
 if(!verification||verification.evidenceHash!==data.verificationEvidenceHash)return reviewRecoveryChanged();
 const packet=recoveryRecordRef(store,run.projectId,run.id,data.reviewPacketId,'ReviewPacket');
 const packetBody:any=packet?object(packet.data.packet):null;
 if(!packet||packet.ref.sha256!==hash(packet.data)||packet.data.sha256!==data.reviewPacketHash||
   packetBody.runId!==run.id||!Array.isArray(packetBody.sourceHistory)||
   object(packetBody.sourceHistory.at(-1)).treeHash!==data.sourceHash)return reviewRecoveryChanged();
 const dispatch=[
   recoveryRecordRef(store,run.projectId,run.id,data.reviewerDispatch.queued?.id,'DispatchQueued'),
   recoveryRecordRef(store,run.projectId,run.id,data.reviewerDispatch.granted?.id,'DispatchGranted'),
   recoveryRecordRef(store,run.projectId,run.id,data.reviewerDispatch.finished?.id,'DispatchFinished'),
 ];
 if(dispatch.some((item,index)=>!item||item.ref.sha256!==data.reviewerDispatch[['queued','granted','finished'][index] as 'queued'|'granted'|'finished'].sha256||
   (index===0&&item.data.kind!=='reviewer')||
   (index>0&&(item.data.dispatchId!==data.reviewerDispatchId||item.data.generation!==data.reviewerDispatchGeneration))))return reviewRecoveryChanged();
 if(dispatch[2]!.data.outcome!=='CODEX_INCLUDED_USAGE_UNAVAILABLE'||dispatch[2]!.data.cleanupReturned!==true)
   return reviewRecoveryChanged();
 for(const ref of data.reviewerDispatch.cleanup){
   const current=recoveryRecordRef(store,run.projectId,run.id,ref.id,ref.kind);
   if(!current||current.ref.sha256!==ref.sha256)return reviewRecoveryChanged();
 }
 for(const ref of data.reviewerPreparation){
   const row=store.db.prepare("SELECT payload FROM events WHERE project_id=? AND run_id=? AND id=? AND type='agent.event'")
     .get(run.projectId,run.id,ref.id);
   if(!row||hash(object(JSON.parse(String(row.payload))))!==ref.sha256)return reviewRecoveryChanged();
 }
 const executorSessions=store.records(run.projectId,'AgentSession')
   .filter(row=>row.runId===run.id&&row.data.role==='executor');
 if(executorSessions.length!==1&&executorSessions.length!==2)return reviewRecoveryChanged();
 const executor=exactExecutorEvidence(store,run,executorSessions.length);
 const first=executor?.sessions[0];
 if(!executor||!first||first.data.sessionId!==data.firstExecutorSessionId||
   hash(first.data)!==data.firstExecutorEvidenceHash||
   first.data.requestId!==undefined&&first.data.requestId!==data.firstExecutorRequestId||
   !executor.usage.some(row=>row.data.requestId===data.firstExecutorRequestId))return reviewRecoveryChanged();
 if(run.maxCalls!==4||run.repairCount!==1||run.maxRepairs!==1||
   run.documentationContinuationExtension!==undefined||run.boundedCodeVerificationRecovery!==undefined)
   return reviewRecoveryChanged();
 return data;
}
type BoundedRecoveryEvidence=BoundedCodeVerificationRecovery&{recoveryRound:1|2|3|4};
function boundedVerificationRecoveryEvidence(store:Store,run:Run,approval:DocumentationContinuationApproval):BoundedRecoveryEvidence|null{
 const rows=store.db.prepare(
   "SELECT id,run_id,data FROM records WHERE project_id=? AND run_id=? AND kind='BoundedCodeVerificationRecovery' ORDER BY rowid LIMIT 5",
 ).all(run.projectId,run.id);
 if(run.boundedCodeVerificationRecovery===undefined){if(rows.length)return recoveryChanged();return null;}
 if(rows.length<1||rows.length>MAX_BOUNDED_VERIFICATION_RECOVERIES||String(rows.at(-1)?.id)!==run.boundedCodeVerificationRecovery.recordId)
  return recoveryChanged();
 const records=rows.map(row=>{
  if(String(row.run_id)!==run.id||typeof row.data!=='string')return recoveryChanged();
  const data=object(JSON.parse(row.data)) as unknown as BoundedCodeVerificationRecovery;
  return{id:String(row.id),data,sha256:hash(data)};
 });
 const first=records[0],latest=records.at(-1)!;
 if(latest.sha256!==run.boundedCodeVerificationRecovery.sha256)return recoveryChanged();
 for(const [index,record]of records.entries()){
  const data=record.data,round=index+1;
  const roundShape=round===1
   ?data.schema==='dream-maker.bounded-code-verification-recovery.v1'&&data.previousCalls===1&&
    data.previousMaxCalls===2&&data.newMaxCalls===3
   :data.schema==='dream-maker.bounded-code-verification-recovery.v2'&&
    data.previousCalls===round&&data.previousMaxCalls===round+1&&data.newMaxCalls===round+2;
  if(!roundShape||data.runId!==run.id||data.projectId!==run.projectId||
    data.approvalRecordId!==run.documentationContinuation?.recordId||data.approvalHash!==run.documentationContinuation?.sha256||
    data.parentRunId!==approval.parentRunId||data.previousState!=='BLOCKED'||data.previousPhase!=='VERIFYING'||
    data.previousReason!=='BOUNDED_CODE_REPAIR_VERIFICATION_FAILED'||data.repairCount!==1||data.maxRepairs!==1||
    data.taskId!==approval.taskId||hash(data.writePaths)!==hash(approval.writePaths)||
    data.additionalDshRepairs!==1||data.additionalReviewerReviews!==1||data.confirmed!==true||
    data.modelDispatched!==false||data.automaticRetry!==false||typeof data.firstExecutorRequestId!=='string'||
    !data.firstExecutorRequestId||!sha(data.sourceHash)||!sha(data.verificationEvidenceHash)||
    !sha(data.failedCaseHash)||!sha(data.firstExecutorEvidenceHash)||!sha(data.requestHash)||
    !sha(data.ownerDecisionHash)||!sha(data.actorHash))return recoveryChanged();
  const evidence=store.db.prepare("SELECT run_id,data FROM records WHERE project_id=? AND id=? AND kind='Evidence'")
    .get(run.projectId,data.verificationEvidenceId);
  if(!evidence||String(evidence.run_id)!==run.id||hash(JSON.parse(String(evidence.data)))!==data.verificationEvidenceHash)
   return recoveryChanged();
  if(round>1&&(
    data.previousRecoveryRecordId!==records[index-1]!.id||data.previousRecoveryHash!==records[index-1]!.sha256||
    typeof data.previousExecutorSessionId!=='string'||!data.previousExecutorSessionId||
    typeof data.previousExecutorRequestId!=='string'||!data.previousExecutorRequestId||
    !sha(data.previousExecutorEvidenceHash)
  ))return recoveryChanged();
 }
 // `calls` advances before the current Executor role is committed, so it cannot
 // prove whether this recovery round has a second AgentSession yet. Accept only
 // the two exact evidence states: prepared (records.length sessions) or complete
 // (one additional Executor session).
 const executorSessionCount=store.records(run.projectId,'AgentSession')
   .filter(row=>row.runId===run.id&&row.data.role==='executor').length;
 if(executorSessionCount!==records.length&&executorSessionCount!==records.length+1)return recoveryChanged();
 const executor=exactExecutorEvidence(store,run,executorSessionCount);
 if(!executor)return recoveryChanged();
 const firstData=first.data,latestData=latest.data;
 const firstSession=executor.sessions[0];
 if(!firstSession||firstSession.data.sessionId!==firstData.firstExecutorSessionId||
   hash(firstSession.data)!==firstData.firstExecutorEvidenceHash||
   (firstSession.data.requestId!==undefined&&firstSession.data.requestId!==firstData.firstExecutorRequestId)||
   !executor.usage.some(row=>row.data.requestId===firstData.firstExecutorRequestId))return recoveryChanged();
 for(const [index,record]of records.entries()){
  if(index===0)continue;
  const previousSession=executor.sessions[index];
  if(!previousSession||previousSession.data.sessionId!==record.data.previousExecutorSessionId||
    hash(previousSession.data)!==record.data.previousExecutorEvidenceHash||
    (previousSession.data.requestId!==undefined&&previousSession.data.requestId!==record.data.previousExecutorRequestId)||
    !executor.usage.some(row=>row.data.requestId===record.data.previousExecutorRequestId))return recoveryChanged();
 }
 const expectedMaxCalls=records.length+2;
 if(run.maxCalls!==expectedMaxCalls||run.repairCount!==1||run.maxRepairs!==1||
   run.documentationContinuationExtension!==undefined)return recoveryChanged();
 return{...latestData,recoveryRound:records.length as 1|2|3|4};
}
function continuationExtension(store:Store,run:Run,approval:DocumentationContinuationApproval){
 const rows=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='DocumentationContinuationCallExtension' ORDER BY rowid LIMIT 2").all(run.projectId,run.id);
 if(run.documentationContinuationExtension===undefined){if(rows.length)return fail();return null;}
 if(rows.length!==1)return extensionChanged();const row=rows[0],x=object(JSON.parse(String(row.data))) as unknown as DocumentationContinuationCallExtension;
 if(hash(x)!==run.documentationContinuationExtension.sha256||String(row.id)!==run.documentationContinuationExtension.recordId||
   x.schema!=='dream-maker.documentation-continuation-call-extension.v1'||x.runId!==run.id||x.projectId!==run.projectId||
   x.approvalRecordId!==run.documentationContinuation!.recordId||x.approvalHash!==run.documentationContinuation!.sha256||
   !Number.isSafeInteger(x.previousRunVersion)||x.previousRunVersion<1||x.previousMaxCalls!==2||x.newMaxCalls!==3||
   !Number.isSafeInteger(x.previousSeriesMaxCalls)||x.previousSeriesMaxCalls!==approval.seriesMaxCalls||
   !Number.isSafeInteger(x.newSeriesMaxCalls)||x.newSeriesMaxCalls!==approval.seriesMaxCalls+1||x.additionalCalls!==1||
   x.scope!=='ONE_ADDITIONAL_ENGINEERING_CALL_NO_REPAIR'||!sha(x.ownerDecisionHash)||!sha(x.actorHash)||!sha(x.requestHash)||
   typeof x.at!=='string'||!Number.isFinite(Date.parse(x.at))||x.confirmed!==true||x.modelDispatched!==false||x.automaticRepair!==false)
  return extensionChanged();
 const expectedRequest:DocumentationContinuationCallExtensionRequest={confirmed:true,expectedVersion:x.previousRunVersion,approvalRecordId:x.approvalRecordId,approvalHash:x.approvalHash,ownerDecisionHash:x.ownerDecisionHash};
 if(x.requestHash!==hash(expectedRequest))return extensionChanged();
 return x;
}
/** Original Plan publication follows its real role completion/usage transaction. */
function originalPlanningReference(store:Store,parent:Run,planId:string,sessionId:string,depth=0):PlanningReference{
 if(depth>16)return fail();
 if(parent.documentationContinuation){
  const ref=parent.documentationContinuation,b=read(store,parent.projectId,parent.id,ref.recordId,'DocumentationContinuationApproval') as unknown as DocumentationContinuationApproval;
  if(hash(b)!==ref.sha256||!['dream-maker.documentation-continuation.v1','dream-maker.bounded-code-repair-continuation.v1'].includes(b.schema)||
   b.runId!==parent.id||b.projectId!==parent.projectId||b.parentPlanRecordId!==planId||b.parentPlannerSessionRecordId!==sessionId||
   b.planVersionId!==parent.planVersionId||b.planVersionHash!==parent.planVersionHash||b.flowConfigHash!==parent.flowConfigHash||
   b.parentPlanHash!==hash(parent.plan))return fail();
  const inherited=originalPlanningReference(store,store.run(b.parentRunId),b.parentPlanRecordId,b.parentPlannerSessionRecordId,depth+1);
  if(inherited.requestId!==b.parentPlannerRequestId||inherited.usageRecordId!==b.parentPlannerUsageRecordId||
   inherited.completionEventId!==b.parentPlannerCompletionEventId)return fail();
  return {...inherited,planRecordId:planId,sessionRecordId:sessionId};
 }
 const plan=read(store,parent.projectId,parent.id,planId,'Plan'),session=read(store,parent.projectId,parent.id,sessionId,'AgentSession'),identity=parent.roleIdentities?.planner2;
 if(!identity||identity.runner!=='CODEX_CLI'||identity.provider!=='openai'||identity.authentication!=='CHATGPT_SUBSCRIPTION'||typeof identity.requestId!=='string'||!identity.requestId||parent.sessions.planner2!==identity.sessionId||session.role!=='planner2'||session.sessionId!==identity.sessionId||session.modelEvidence!=='ADAPTER_VERIFIED_RESPONSE'||!['runner','provider','model','authentication'].every(k=>session[k]===identity[k as keyof typeof identity])||session.requestId!==undefined&&session.requestId!==identity.requestId||hash(plan.plan)!==hash(parent.plan)||plan.specHash!==parent.specHash)return fail();
 const usage=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='UsageLedger' AND rowid>(SELECT rowid FROM records WHERE id=?) AND rowid<(SELECT rowid FROM records WHERE id=?) AND json_extract(data,'$.role')='planner2' LIMIT 2").all(parent.projectId,parent.id,sessionId,planId);
 if(usage.length!==1||object(JSON.parse(String(usage[0].data))).requestId!==identity.requestId)return fail();
 const events=store.db.prepare("SELECT id,payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND json_extract(payload,'$.method')='dm/codexCompletion' AND json_extract(payload,'$.params.threadId')=? AND json_extract(payload,'$.params.turnId')=? LIMIT 2").all(parent.projectId,parent.id,identity.sessionId,identity.requestId);
 if(events.length!==1)return fail();const completion=object(object(JSON.parse(String(events[0].payload))).params);
 if(completion.role!=='planner2'||completion.status!=='completed'||completion.runId!==parent.id||completion.specHash!==parent.specHash||completion.model!==identity.model||completion.provider!==identity.provider)return fail();
 return {planRecordId:planId,sessionRecordId:sessionId,identity:{runner:String(identity.runner),provider:String(identity.provider),authentication:String(identity.authentication),model:String(identity.model),sessionId:String(identity.sessionId),requestId:String(identity.requestId)},requestId:identity.requestId,usageRecordId:String(usage[0].id),completionEventId:Number(events[0].id)};
}
/** Immutable original row links, not a newly manufactured Planner 2 identity. */
export function documentationContinuationEvidence(store:Store,run:Run):DocumentationContinuationApproval|null{
 if(run.documentationContinuation===undefined)return null;
 try{
  const ref=run.documentationContinuation,b=read(store,run.projectId,run.id,ref.recordId,'DocumentationContinuationApproval') as unknown as DocumentationContinuationApproval;
   const code=isCode(b);
   if(hash(b)!==ref.sha256||!['dream-maker.documentation-continuation.v1','dream-maker.bounded-code-repair-continuation.v1'].includes(b.schema)||b.repairKind!==(code?'CODE':undefined)||b.runId!==run.id||b.projectId!==run.projectId||run.mode!=='live'||run.flowName!=='classic'||b.planVersionId!==run.planVersionId||b.planVersionHash!==run.planVersionHash||b.flowConfigHash!==run.flowConfigHash||b.parentPlanHash!==hash(run.plan)||b.additionalCalls!==2||b.additionalRepairs!==1||b.taskDeadline!==null||b.confirmed!==true||b.modelDispatched!==false||run.maxRepairs!==1||run.calls<0||run.repairCount<0||run.repairCount>1||(code&&(b.writePaths.length!==1||b.writePaths[0]!=='main.mjs')))return fail();
   const extension=continuationExtension(store,run,b),recovery=boundedVerificationRecoveryEvidence(store,run,b),
     reviewRecovery=boundedCodeReviewRecoveryEvidence(store,run,b);
   if(recovery&&reviewRecovery)return fail();
   const expectedMaxCalls=reviewRecovery?4:recovery?recovery.recoveryRound+2:extension?3:2;
  if(run.maxCalls!==expectedMaxCalls||run.calls>expectedMaxCalls||b.seriesMaxCalls!==b.parentCalls+b.parentSupplementalCalls+2)return fail();
  const parent=store.run(b.parentRunId),planning=originalPlanningReference(store,parent,b.parentPlanRecordId,b.parentPlannerSessionRecordId);
  if(hash(parent)!==b.parentRunHash||parent.projectId!==run.projectId||parent.specId!==run.specId||parent.specHash!==run.specHash||parent.treeHash!==b.parentSourceHash||parent.planVersionHash!==b.planVersionHash||hash(parent.plan)!==b.parentPlanHash||planning.requestId!==b.parentPlannerRequestId||planning.usageRecordId!==b.parentPlannerUsageRecordId||planning.completionEventId!==b.parentPlannerCompletionEventId||b.parentCalls!==parent.calls)return fail();
  const parentReview=read(store,b.projectId,parent.id,b.parentReviewRecordId,'Review');if(hash(parentReview)!==b.parentReviewRecordHash||parentReview.verdict!=='CHANGES_REQUESTED'||parentReview.treeHash!==b.parentSourceHash||parentReview.packetId!==b.parentReviewPacketId||parentReview.packetHash!==b.parentReviewPacketHash)return fail();
  const custody=read(store,b.projectId,parent.id,b.custodyRecordId,'DocumentationCorrectionPrepared'),custodyResult=object(custody.result);
  const custodyPaths=Array.isArray(custodyResult.writePaths)?custodyResult.writePaths:[];
  if(hash(custody)!==b.custodyHash||custodyResult.candidateHash!==b.candidateHash||custodyResult.sourceHash!==b.parentSourceHash||custodyResult.executionGranted!==false||custodyResult.repairKind!==(code?'CODE':undefined)||(code&&(custodyPaths.length!==1||custodyPaths[0]!=='main.mjs')))return fail();

  if(run.tasks.length!==parent.tasks.length||new Set(run.tasks.map(t=>t.id)).size!==run.tasks.length||run.tasks.some(t=>{const old=parent.tasks.find(p=>p.id===t.id);if(!old||hash({...t,status:null,inheritedFrom:undefined})!==hash({...old,status:null,inheritedFrom:undefined}))return true;return t.id===b.taskId?!['pending','running','implemented','done'].includes(t.status)||hash(t.writePaths)!==hash(b.writePaths)||t.inheritedFrom!==undefined:!['implemented','done'].includes(t.status)||t.inheritedFrom?.runId!==parent.id||t.inheritedFrom.taskId!==t.id;}))return fail();
  return b;
 }catch{return fail();}
}
/** Add one audited call to a continuation that already consumed one failed dispatch. */
export async function extendDocumentationContinuationCall(store:Store,runId:string,request:DocumentationContinuationCallExtensionRequest,actor:string):Promise<Run>{
 const fields=['confirmed','expectedVersion','approvalRecordId','approvalHash','ownerDecisionHash'];
 if(!object(request)||Object.keys(request).length!==fields.length||fields.some(key=>!Object.hasOwn(request,key))||request.confirmed!==true||
   !Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||typeof request.approvalRecordId!=='string'||
   !request.approvalRecordId||typeof request.approvalHash!=='string'||!sha(request.approvalHash)||
   typeof request.ownerDecisionHash!=='string'||!sha(request.ownerDecisionHash)||!/^local-session:[a-f0-9]{64}$/.test(actor))
  throw new DomainError('DOCUMENTATION_CALL_EXTENSION_INPUT_INVALID',400);
 const requestHash=hash(request);
 const eligible=(run:Run,approval:DocumentationContinuationApproval)=>{
  if(run.state!=='PAUSED'||run.phase!=='IMPLEMENTING'||run.reason!=='EXECUTOR_CHECKPOINT_PREPARED'||
    run.version!==request.expectedVersion||run.calls!==1||run.maxCalls!==2||run.repairCount!==1||run.maxRepairs!==1||
    run.documentationContinuationExtension!==undefined||run.documentationContinuation?.recordId!==request.approvalRecordId||
    run.documentationContinuation.sha256!==request.approvalHash||approval.taskId===''||
    !store.owns(run.projectId,run.id)||store.project(run.projectId).activeRunId!==run.id)return false;
  const task=run.tasks.find(item=>item.id===approval.taskId);
  return !!task&&task.inheritedFrom===undefined&&task.status==='pending'&&run.tasks.every(item=>item.id===task.id||
    ['implemented','done'].includes(item.status)&&item.inheritedFrom?.runId===approval.parentRunId);
 };
 const current=store.run(runId),approval=documentationContinuationEvidence(store,current);
 if(!approval)return fail();
 assertDocumentationProtectedFiles(store,current);
 const existing=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='DocumentationContinuationCallExtension' ORDER BY rowid LIMIT 2").all(current.projectId,current.id);
 if(existing.length){
  if(existing.length!==1||current.documentationContinuationExtension===undefined)return extensionChanged();
  const extension=continuationExtension(store,current,approval);
  if(!extension||extension.requestHash!==requestHash)return extensionChanged();
  return current;
 }
 if(!eligible(current,approval))return extensionNotEligible();
 await store.once('documentation-call-extension:'+current.id,request,async()=>{
  return store.tx(()=>{
   const latest=store.run(runId),approvalNow=documentationContinuationEvidence(store,latest);
   if(!approvalNow)return fail();
   assertDocumentationProtectedFiles(store,latest);
   if(!eligible(latest,approvalNow))return extensionNotEligible();
   const at=now(),data:DocumentationContinuationCallExtension={
    schema:'dream-maker.documentation-continuation-call-extension.v1',runId:latest.id,projectId:latest.projectId,
    approvalRecordId:request.approvalRecordId,approvalHash:request.approvalHash,previousRunVersion:latest.version,
    previousMaxCalls:2,newMaxCalls:3,previousSeriesMaxCalls:approvalNow.seriesMaxCalls,
    newSeriesMaxCalls:approvalNow.seriesMaxCalls+1,additionalCalls:1,
    scope:'ONE_ADDITIONAL_ENGINEERING_CALL_NO_REPAIR',ownerDecisionHash:request.ownerDecisionHash,
    actorHash:hash(actor),requestHash,at,confirmed:true,modelDispatched:false,automaticRepair:false,
   };
   const recordId=store.record('DocumentationContinuationCallExtension',latest.projectId,latest.id,data);
   latest.documentationContinuationExtension={recordId,sha256:hash(data)};latest.maxCalls=3;store.saveRun(latest);
   store.event(latest.projectId,latest.id,'run.documentation-continuation.call-extension',{recordId,sha256:hash(data),additionalCalls:1,previousMaxCalls:2,newMaxCalls:3,previousSeriesMaxCalls:approvalNow.seriesMaxCalls,newSeriesMaxCalls:approvalNow.seriesMaxCalls+1,modelDispatched:false,automaticRepair:false});
   const result=store.run(runId);documentationContinuationEvidence(store,result);return {recordId,sha256:hash(data)};
  });
 });
 return store.run(runId);
}
/**
 * One exact recovery after the first bounded code repair failed the frozen
 * verifier. This extends the same run by exactly one Executor call and one
 * Reviewer call; it never fabricates a review or starts a second planner.
 */
export async function recoverBoundedCodeVerificationFailure(
 store:Store,runId:string,request:BoundedCodeVerificationRecoveryRequest,actor:string,
):Promise<Run>{
 const fields=['confirmed','expectedVersion','sourceHash','verificationEvidenceId','ownerDecisionHash'];
 if(!object(request)||Object.keys(request).length!==fields.length||fields.some(key=>!Object.hasOwn(request,key))||
   request.confirmed!==true||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||
   !sha(request.sourceHash)||typeof request.verificationEvidenceId!=='string'||!request.verificationEvidenceId||
   request.verificationEvidenceId.length>200||!sha(request.ownerDecisionHash)||!/^local-session:[a-f0-9]{64}$/.test(actor))
  throw new DomainError('BOUNDED_CODE_REPAIR_RECOVERY_INPUT_INVALID',400);
 const requestHash=hash(request);
 const current=store.run(runId),approval=documentationContinuationEvidence(store,current);
 if(!approval||!isCode(approval))return recoveryNotEligible();
 const rows=store.db.prepare(
   "SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='BoundedCodeVerificationRecovery' ORDER BY rowid LIMIT 5",
 ).all(current.projectId,current.id);
 if(rows.length>MAX_BOUNDED_VERIFICATION_RECOVERIES)return recoveryChanged();
 const existing=rows.map(row=>({
   id:String(row.id),
   data:object(JSON.parse(String(row.data))) as unknown as BoundedCodeVerificationRecovery,
 }));
 if(existing.length){
   const recovery=boundedVerificationRecoveryEvidence(store,current,approval);
   if(!recovery||current.boundedCodeVerificationRecovery?.recordId!==existing.at(-1)!.id)return recoveryChanged();
   if(existing.at(-1)!.data.requestHash===requestHash){
    if(current.state==='PAUSED'&&current.phase==='IMPLEMENTING'&&
      current.reason==='BOUNDED_CODE_REPAIR_VERIFICATION_RECOVERY_PREPARED'&&
      current.calls===existing.at(-1)!.data.previousCalls&&
      current.maxCalls===existing.at(-1)!.data.newMaxCalls)return current;
    return recoveryAlreadyUsed();
   }
   if(current.state==='PAUSED'&&current.phase==='IMPLEMENTING'&&
     current.reason==='BOUNDED_CODE_REPAIR_VERIFICATION_RECOVERY_PREPARED')return recoveryChanged();
   if(existing.length>=MAX_BOUNDED_VERIFICATION_RECOVERIES)return recoveryAlreadyUsed();
 }
  const round=(existing.length+1) as 1|2|3|4;
 const eligible=(run:Run,proof:DocumentationContinuationApproval)=>{
  try{
    const priorRecovery=existing.at(-1);
   if(run.state!=='BLOCKED'||run.phase!=='VERIFYING'||run.reason!=='BOUNDED_CODE_REPAIR_VERIFICATION_FAILED'||
     run.version!==request.expectedVersion||run.treeHash!==request.sourceHash||
      (round===1?run.calls!==1||run.maxCalls!==2||run.boundedCodeVerificationRecovery!==undefined:
        run.calls!==round||run.maxCalls!==round+1||run.boundedCodeVerificationRecovery?.recordId!==priorRecovery?.id)||
     run.repairCount!==1||run.maxRepairs!==1||run.review!==null||
     run.documentationContinuationExtension!==undefined||proof.runId!==run.id||
     store.project(run.projectId).activeRunId!==run.id||store.owns(run.projectId,run.id)||
     hash(files(run.workspace))!==run.treeHash)return false;
   const task=run.tasks.find(item=>item.id===proof.taskId);
   if(!task||task.inheritedFrom!==undefined||task.status!=='implemented'||hash(task.writePaths)!==hash(proof.writePaths)||
     run.tasks.some(item=>item.id!==task.id&&(item.inheritedFrom?.runId!==proof.parentRunId||item.status!=='implemented')))
    return false;
   if(Object.keys(run.sessions).some(role=>role!=='executor')||run.roleIdentities?.reviewer||
     run.roleIdentities?.planner2||run.sessions.planner2||run.sessions.reviewer)return false;
   if(!exactExecutorEvidence(store,run,round)||!exactC16FailureEvidence(store,run,request.verificationEvidenceId))return false;
   assertDocumentationProtectedFiles(store,run);
   return true;
  }catch{return false;}
 };
 if(!eligible(current,approval))return recoveryNotEligible();
 await store.once('bounded-code-verification-recovery:'+current.id+':round-'+round,request,async()=>store.tx(()=>{
  const latest=store.run(runId),approvalNow=documentationContinuationEvidence(store,latest);
  if(!approvalNow||!isCode(approvalNow)||!eligible(latest,approvalNow))return recoveryNotEligible();
  const priorRows=store.db.prepare(
     "SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='BoundedCodeVerificationRecovery' ORDER BY rowid LIMIT 5",
  ).all(latest.projectId,latest.id);
  if(priorRows.length!==round-1)return recoveryChanged();
  const prior=priorRows.map(row=>({
    id:String(row.id),
    data:object(JSON.parse(String(row.data))) as unknown as BoundedCodeVerificationRecovery,
    sha256:hash(object(JSON.parse(String(row.data)))),
  }));
  const failure=exactC16FailureEvidence(store,latest,request.verificationEvidenceId);
  if(!failure)return recoveryNotEligible();
  const executor=exactExecutorEvidence(store,latest,round);
  if(!executor)return recoveryNotEligible();
  const executorRow=store.records(latest.projectId,'AgentSession').find(row=>
    row.runId===latest.id&&row.data.role==='executor'&&row.data.sessionId===executor.sessionId);
  if(!executorRow)return recoveryNotEligible();
  const firstExecutor=executor.sessions[0],previousExecutor=executor.sessions.at(-1);
  if(!firstExecutor||!previousExecutor)return recoveryNotEligible();
  const previous=prior.at(-1);
  const at=now(),data:BoundedCodeVerificationRecovery={
   schema:round===1?'dream-maker.bounded-code-verification-recovery.v1':'dream-maker.bounded-code-verification-recovery.v2',
   runId:latest.id,projectId:latest.projectId,
   approvalRecordId:latest.documentationContinuation!.recordId,approvalHash:latest.documentationContinuation!.sha256,
   parentRunId:approvalNow.parentRunId,previousVersion:latest.version,previousState:'BLOCKED',previousPhase:'VERIFYING',
    previousReason:'BOUNDED_CODE_REPAIR_VERIFICATION_FAILED',previousCalls:round,
    previousMaxCalls:(round+1) as 2|3|4|5,newMaxCalls:(round+2) as 3|4|5|6,
   repairCount:1,maxRepairs:1,sourceHash:request.sourceHash,verificationEvidenceId:request.verificationEvidenceId,
   verificationEvidenceHash:failure.evidenceHash,failedCaseId:'C16_MALFORMED_JSON',failedCaseHash:failure.failedCaseHash,
   firstExecutorSessionId:firstExecutor.data.sessionId,
   firstExecutorRequestId:round===1?executor.identity.requestId:String(prior[0]?.data.firstExecutorRequestId??''),
   firstExecutorEvidenceHash:hash(firstExecutor.data),
    ...(round>1?{
    previousRecoveryRecordId:previous!.id,previousRecoveryHash:previous!.sha256,
    previousExecutorSessionId:previousExecutor.data.sessionId,
    previousExecutorRequestId:executor.identity.requestId,
    previousExecutorEvidenceHash:hash(previousExecutor.data),
   }:{}),
   taskId:approvalNow.taskId,writePaths:structuredClone(approvalNow.writePaths),requestHash,
   ownerDecisionHash:request.ownerDecisionHash,actorHash:hash(actor),additionalDshRepairs:1,
   additionalReviewerReviews:1,at,confirmed:true,modelDispatched:false,automaticRetry:false,
  };
  store.acquire(latest.projectId,latest.id);
  const recordId=store.record('BoundedCodeVerificationRecovery',latest.projectId,latest.id,data);
   latest.boundedCodeVerificationRecovery={recordId,sha256:hash(data)};latest.maxCalls=round+2;
  latest.tasks=latest.tasks.map(task=>task.id===approvalNow.taskId?{...task,status:'pending'}:task);
  latest.state='PAUSED';latest.phase='IMPLEMENTING';latest.reason='BOUNDED_CODE_REPAIR_VERIFICATION_RECOVERY_PREPARED';
  store.saveRun(latest);
  store.event(latest.projectId,latest.id,'run.bounded-code-verification-recovery.prepared',{
   recordId,sha256:hash(data),verificationEvidenceId:request.verificationEvidenceId,
   failedCaseId:'C16_MALFORMED_JSON',additionalDshRepairs:1,additionalReviewerReviews:1,
    recoveryRound:round,previousMaxCalls:round+1,newMaxCalls:round+2,
   modelDispatched:false,automaticRetry:false,
  });
  const result=store.run(runId);boundedVerificationRecoveryEvidence(store,result,approvalNow);
  return{recordId,sha256:hash(data)};
 }));
 const result=store.run(runId);
 if(result.state!=='PAUSED'||result.reason!=='BOUNDED_CODE_REPAIR_VERIFICATION_RECOVERY_PREPARED')
  return recoveryAlreadyUsed();
 return result;
}
/**
 * Recover one exact account-gate block that happened after a fresh Reviewer
 * process reached preparation but before any thread, turn or AgentSession.
 * The failed dispatch consumed its call and remains immutable. This recovery
 * adds only one DSH repair call and one fresh Reviewer call on the same run.
 */
export async function recoverBoundedCodeReviewUsage(
 store:Store,runId:string,request:BoundedCodeReviewRecoveryRequest,actor:string,
):Promise<Run>{
 const fields=['confirmed','expectedVersion','sourceHash','verificationEvidenceId','reviewPacketId','ownerDecisionHash'];
 if(!object(request)||Object.keys(request).length!==fields.length||fields.some(key=>!Object.hasOwn(request,key))||
   request.confirmed!==true||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||
   !sha(request.sourceHash)||typeof request.verificationEvidenceId!=='string'||!request.verificationEvidenceId||
   request.verificationEvidenceId.length>200||typeof request.reviewPacketId!=='string'||!request.reviewPacketId||
   request.reviewPacketId.length>200||!sha(request.ownerDecisionHash)||!/^local-session:[a-f0-9]{64}$/.test(actor))
  throw new DomainError('BOUNDED_CODE_REVIEW_RECOVERY_INPUT_INVALID',400);
 const requestHash=hash(request),current=store.run(runId),approval=documentationContinuationEvidence(store,current);
 if(!approval||!isCode(approval))return reviewRecoveryNotEligible();
 const rows=store.db.prepare(
   "SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='BoundedCodeReviewRecovery' ORDER BY rowid LIMIT 2",
 ).all(current.projectId,current.id);
 if(rows.length>1)return reviewRecoveryChanged();
 if(rows.length){
   const recovery=boundedCodeReviewRecoveryEvidence(store,current,approval);
   if(!recovery||current.boundedCodeReviewRecovery?.recordId!==String(rows[0].id))return reviewRecoveryChanged();
   const existing=object(JSON.parse(String(rows[0].data)));
   if(existing.requestHash!==requestHash)return current.state==='PAUSED'?reviewRecoveryChanged():reviewRecoveryAlreadyUsed();
   if(current.state==='PAUSED'&&current.phase==='IMPLEMENTING'&&
     current.reason==='BOUNDED_CODE_REVIEW_RECOVERY_PREPARED'&&
     current.calls===2&&current.maxCalls===4)return current;
   return reviewRecoveryAlreadyUsed();
 }
 const eligible=(run:Run,proof:DocumentationContinuationApproval)=>{
  try{
   if(run.state!=='BLOCKED'||run.phase!=='REVIEWING'||run.reason!=='CODEX_INCLUDED_USAGE_UNAVAILABLE'||
     run.version!==request.expectedVersion||run.treeHash!==request.sourceHash||
     run.calls!==2||run.maxCalls!==2||run.repairCount!==1||run.maxRepairs!==1||run.review!==null||
     run.verification?.ok!==true||run.verification.evidenceId!==request.verificationEvidenceId||
     run.boundedCodeVerificationRecovery!==undefined||run.boundedCodeReviewRecovery!==undefined||
     run.documentationContinuationExtension!==undefined||proof.runId!==run.id||
     store.project(run.projectId).activeRunId!==run.id||!store.owns(run.projectId,run.id)||
     hash(files(run.workspace))!==run.treeHash)return false;
   const task=run.tasks.find(item=>item.id===proof.taskId);
   if(!task||task.inheritedFrom!==undefined||task.status!=='implemented'||hash(task.writePaths)!==hash(proof.writePaths)||
     run.tasks.some(item=>item.id!==task.id&&(item.inheritedFrom?.runId!==proof.parentRunId||item.status!=='implemented')))
    return false;
   if(Object.keys(run.sessions).some(role=>role!=='executor')||run.roleIdentities?.reviewer||
     run.roleIdentities?.planner2||run.sessions.planner2||run.sessions.reviewer)return false;
   if(!exactExecutorEvidence(store,run,1)||!exactSuccessfulVerificationEvidence(store,run,request.verificationEvidenceId)||
     !exactCodexUsageBlockedReviewer(store,run,request.reviewPacketId))return false;
   assertDocumentationProtectedFiles(store,run);
   return true;
  }catch{return false;}
 };
 if(!eligible(current,approval))return reviewRecoveryNotEligible();
 await store.once('bounded-code-review-recovery:'+current.id,request,async()=>store.tx(()=>{
  const latest=store.run(runId),approvalNow=documentationContinuationEvidence(store,latest);
  if(!approvalNow||!isCode(approvalNow)||!eligible(latest,approvalNow))return reviewRecoveryNotEligible();
  const priorRows=store.db.prepare(
    "SELECT id FROM records WHERE project_id=? AND run_id=? AND kind='BoundedCodeReviewRecovery' LIMIT 2",
  ).all(latest.projectId,latest.id);
  if(priorRows.length!==0)return reviewRecoveryChanged();
  const verification=exactSuccessfulVerificationEvidence(store,latest,request.verificationEvidenceId),
    reviewer=exactCodexUsageBlockedReviewer(store,latest,request.reviewPacketId),
    executor=exactExecutorEvidence(store,latest,1);
  if(!verification||!reviewer||!executor)return reviewRecoveryNotEligible();
  const first=executor.sessions[0];
  if(!first)return reviewRecoveryNotEligible();
  const at=now(),data:BoundedCodeReviewRecovery={
   schema:'dream-maker.bounded-code-review-recovery.v1',runId:latest.id,projectId:latest.projectId,
   approvalRecordId:latest.documentationContinuation!.recordId,approvalHash:latest.documentationContinuation!.sha256,
   parentRunId:approvalNow.parentRunId,previousVersion:latest.version,previousState:'BLOCKED',previousPhase:'REVIEWING',
   previousReason:'CODEX_INCLUDED_USAGE_UNAVAILABLE',previousCalls:2,previousMaxCalls:2,newMaxCalls:4,
   repairCount:1,maxRepairs:1,sourceHash:request.sourceHash,
   verificationEvidenceId:request.verificationEvidenceId,verificationEvidenceHash:verification.evidenceHash,
   reviewPacketId:request.reviewPacketId,reviewPacketHash:reviewer.reviewPacketHash,
   reviewerDispatchId:reviewer.reviewerDispatchId,reviewerDispatchGeneration:reviewer.reviewerDispatchGeneration,
   reviewerDispatch:{queued:reviewer.queued,granted:reviewer.granted,finished:reviewer.finished,cleanup:reviewer.cleanup},
   reviewerPreparation:reviewer.preparation,
   firstExecutorSessionId:String(first.data.sessionId),firstExecutorRequestId:executor.identity.requestId,
   firstExecutorEvidenceHash:hash(first.data),taskId:approvalNow.taskId,writePaths:structuredClone(approvalNow.writePaths),
   requestHash,ownerDecisionHash:request.ownerDecisionHash,actorHash:hash(actor),
   additionalDshRepairs:1,additionalReviewerReviews:1,at,confirmed:true,modelDispatched:false,automaticRetry:false,
  };
  const recordId=store.record('BoundedCodeReviewRecovery',latest.projectId,latest.id,data);
  latest.boundedCodeReviewRecovery={recordId,sha256:hash(data)};latest.maxCalls=4;
  latest.tasks=latest.tasks.map(task=>task.id===approvalNow.taskId?{...task,status:'pending'}:task);
  latest.state='PAUSED';latest.phase='IMPLEMENTING';latest.reason='BOUNDED_CODE_REVIEW_RECOVERY_PREPARED';
  store.saveRun(latest);
  store.event(latest.projectId,latest.id,'run.bounded-code-review-recovery.prepared',{
   recordId,sha256:hash(data),verificationEvidenceId:request.verificationEvidenceId,reviewPacketId:request.reviewPacketId,
   reviewerDispatchId:reviewer.reviewerDispatchId,additionalDshRepairs:1,additionalReviewerReviews:1,
   modelDispatched:false,automaticRetry:false,
  });
  const result=store.run(runId);boundedCodeReviewRecoveryEvidence(store,result,approvalNow);
  return{recordId,sha256:hash(data)};
 }));
 const result=store.run(runId);
 if(result.state!=='PAUSED'||result.reason!=='BOUNDED_CODE_REVIEW_RECOVERY_PREPARED')
  return reviewRecoveryAlreadyUsed();
 return result;
}
export function documentationPreparedEvidence(store:Store,run:Run){
 const b=documentationContinuationEvidence(store,run);if(!b)return fail();
  const preparedReason=isCode(b)?'BOUNDED_CODE_REPAIR_PREPARED':'DOCUMENTATION_CONTINUATION_PREPARED';
  if(run.state!=='PAUSED'||run.phase!=='IMPLEMENTING'||run.reason!==preparedReason||run.calls!==0||run.repairCount!==0||run.review!==null||run.verification!==null||run.usage.length||Object.keys(run.sessions).length||run.roleIdentities&&Object.keys(run.roleIdentities).length||run.treeHash!==b.parentSourceHash||hash(files(run.workspace))!==b.parentSourceHash)return fail();
 if(run.tasks.some(t=>t.id===b.taskId?t.status!=='pending':t.status!=='implemented'))return fail();return b;
}
/** Every byte outside the one declared document path is frozen to the approved parent source. */
export function assertDocumentationProtectedFiles(store:Store,run:Run){
 const approval=documentationContinuationEvidence(store,run);if(!approval)return fail();
 try{
  if(approval.writePaths.length!==1||approval.writePaths.some(path=>!path||path.endsWith('/')||path.includes('\\')))return protectedSourceChanged();
  const writable=new Set(approval.writePaths),catalog=files(run.workspace),byPath=new Map(catalog.map(file=>[file.path,file]));
  if(new Set(approval.protectedFiles.map(file=>file.path)).size!==approval.protectedFiles.length||approval.protectedFiles.length>2000)return protectedSourceChanged();
  for(const expected of approval.protectedFiles){
   const actual=byPath.get(expected.path);if(!actual||actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)return protectedSourceChanged();
   const body=get(run.workspace,expected.path);if(body.length!==expected.bytes||hash(body)!==expected.sha256)return protectedSourceChanged();
  }
  const protectedPaths=new Set(approval.protectedFiles.map(file=>file.path));
  if(catalog.some(file=>!protectedPaths.has(file.path)&&!writable.has(file.path)))return protectedSourceChanged();
  if(approval.protectedFiles.some(file=>writable.has(file.path)))return protectedSourceChanged();
  return approval;
 }catch(error){if(error instanceof DomainError&&error.code==='DOCUMENTATION_CONTINUATION_PROTECTED_SOURCE_CHANGED')throw error;return protectedSourceChanged();}
}
/** Runtime evidence keeps inherited planning immutable while allowing only the approved document bytes to change. */
export function documentationRuntimeEvidence(store:Store,run:Run){
 const approval=assertDocumentationProtectedFiles(store,run),task=run.tasks.find(task=>task.id===approval.taskId);
 if(!task||task.inheritedFrom!==undefined||hash(task.writePaths)!==hash(approval.writePaths)||
   run.tasks.some(other=>other.id!==task.id&&(other.inheritedFrom?.runId!==approval.parentRunId||other.inheritedFrom.taskId!==other.id))||
   run.tasks.some(other=>other.id===task.id?![ 'pending','running','implemented','done' ].includes(other.status):!['implemented','done'].includes(other.status)))return fail();
 return{approval,task};
}
/**
 * The paid documentation repair is reserved once in the original NativeBudget.
 * A crash after the external reservation but before the Store transaction can be
 * reconciled from repairRevision without issuing a second reservation.
 */
export function reserveDocumentationRepair(store:Store,run:Run,ops:DocumentationNativeBudgetOps):Run{
 if(!ops||typeof ops.repairRevision!=='function'||typeof ops.reserveRepair!=='function')throw new DomainError('DOCUMENTATION_REPAIR_ACCOUNTING_REQUIRED',409);
 const rows=store.records(run.projectId,'DocumentationNativeRepairReservation').filter(row=>row.runId===run.id);
 if(rows.length>1)return fail();
 if(!rows.length)documentationPreparedEvidence(store,run);else if(run.repairCount!==1)return fail();
 assertDocumentationProtectedFiles(store,run);
 let revision=ops.repairRevision(run.id);
 if(!Number.isSafeInteger(revision)||revision<0||revision>1)return fail();
 if(revision===0){
  if(rows.length)return fail();
  ops.reserveRepair(run.id);revision=ops.repairRevision(run.id);
 }
 if(revision!==1)return fail();
 return store.tx(()=>{
  const current=store.run(run.id);
  if(current.version<run.version||current.specHash!==run.specHash||current.treeHash!==run.treeHash||current.state!==run.state||current.phase!==run.phase)return fail();
  assertDocumentationProtectedFiles(store,current);
  const currentRows=store.records(current.projectId,'DocumentationNativeRepairReservation').filter(row=>row.runId===current.id);
  if(currentRows.length>1)return fail();
  if(!currentRows.length){
   documentationPreparedEvidence(store,current);
   const data={schema:'dream-maker.documentation-native-repair-reservation.v1' as const,runId:current.id,parentRunId:read(store,current.projectId,current.id,current.documentationContinuation!.recordId,'DocumentationContinuationApproval').parentRunId as string,
    approvalRecordId:current.documentationContinuation!.recordId,approvalHash:current.documentationContinuation!.sha256,sourceHash:current.treeHash,budgetRevision:1,automaticRetry:false,modelDispatched:false};
   store.record('DocumentationNativeRepairReservation',current.projectId,current.id,data);
   current.repairCount=1;store.saveRun(current);
   store.event(current.projectId,current.id,'run.documentation-continuation.repair-reserved',{budgetRevision:1,sourceHash:current.treeHash,modelDispatched:false});
  }else if(current.repairCount!==1)return fail();
  return current;
 });
}
/** Completed current Executor/Reviewer evidence plus the original inherited P2 lineage. */
export function completedDocumentationEngineeringRoles(store:Store,run:Run):boolean{
 try{
  if(!run.documentationContinuation)return false;
  const runtime=documentationRuntimeEvidence(store,run),parent=store.run(runtime.approval.parentRunId),planner2=parent.roleIdentities?.planner2,
    executor=run.roleIdentities?.executor,reviewer=run.roleIdentities?.reviewer,
    recovery=boundedVerificationRecoveryEvidence(store,run,runtime.approval),
    reviewRecovery=boundedCodeReviewRecoveryEvidence(store,run,runtime.approval);
  if(recovery&&reviewRecovery)return false;
  if(!planner2||!executor||!reviewer||run.sessions.planner2!==undefined||
    executor.runner!=='DSH'||executor.provider!=='deepseek-official'||executor.authentication!=='API_KEY'||
    reviewer.runner!=='CODEX_CLI'||reviewer.provider!=='openai'||reviewer.authentication!=='CHATGPT_SUBSCRIPTION'||
    run.sessions.executor!==executor.sessionId||run.sessions.reviewer!==reviewer.sessionId||
    reviewer.sessionId===planner2.sessionId||reviewer.sessionId===parent.sessions.reviewer||reviewer.sessionId===executor.sessionId||
    runtime.task.status!=='done')return false;
  const rows=store.records(run.projectId,'AgentSession').filter(row=>row.runId===run.id),
    sessions=rows.filter(row=>row.data.role==='executor'||row.data.role==='reviewer'),
    usage=store.records(run.projectId,'UsageLedger').filter(row=>row.runId===run.id),
    executorSessions=sessions.filter(row=>row.data.role==='executor'),
    recoveryRounds=recovery?.recoveryRound??0,reviewRecoveryRounds=reviewRecovery?1:0;
  if(sessions.length!==recoveryRounds+reviewRecoveryRounds+2||executorSessions.length!==recoveryRounds+reviewRecoveryRounds+1||
    rows.some(row=>row.data.role==='planner2')||
    usage.length!==recoveryRounds+reviewRecoveryRounds+2||
    run.usage.length!==recoveryRounds+reviewRecoveryRounds+2||
    new Set(sessions.map(row=>row.data.sessionId)).size!==sessions.length)return false;
  if(recovery||reviewRecovery){
   const basis=recovery??reviewRecovery!,
     first=executorSessions.find(row=>row.data.sessionId===basis.firstExecutorSessionId);
   if(!first||hash(first.data)!==basis.firstExecutorEvidenceHash||
     first.data.requestId!==undefined&&first.data.requestId!==basis.firstExecutorRequestId||
     !usage.some(row=>row.data.role==='executor'&&row.data.requestId===basis.firstExecutorRequestId)||
     !run.usage.some(item=>item.role==='executor'&&item.requestId===basis.firstExecutorRequestId))return false;
  }
  for(const [role,identity]of [['executor',executor],['reviewer',reviewer]] as const){
   if(!sessions.some(row=>{const d=object(row.data);return d.role===role&&d.sessionId===identity.sessionId&&d.modelEvidence==='ADAPTER_VERIFIED_RESPONSE'&&
     ['runner','provider','authentication','model'].every(key=>d[key]===identity[key as keyof typeof identity])&&(role!=='executor'||d.taskId===runtime.approval.taskId);}))return false;
   if(!usage.some(row=>row.data.role===role&&row.data.requestId===identity.requestId)||!run.usage.some(item=>item.role===role&&item.requestId===identity.requestId))return false;
  }
  return true;
 }catch{return false;}
}
export function documentationContinuationReplay(store:Store,parentId:string,request:DocumentationContinuationRequest):Run|null{
 const parent=store.run(parentId),rows=store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND kind='DocumentationContinuationPrepared' LIMIT 2").all(parent.projectId,parentId);
 if(!rows.length)return null;if(rows.length!==1)return fail();const d=object(JSON.parse(String(rows[0].data)));if(d.requestHash!==hash(request)||typeof d.runId!=='string')return fail();
 const child=store.run(d.runId),approval=documentationPreparedEvidence(store,child);if(!approval||approval.parentRunId!==parentId||store.project(child.projectId).activeRunId!==child.id||child.treeHash!==hash(files(child.workspace)))return fail();
 return child;
}
/** Read original rows with explicit provenance; no child role/session/plan is written. */
export function inheritedDocumentationPlanning(store:Store,run:Run){
 try{
  const approval=documentationContinuationEvidence(store,run);if(!approval)return fail();const parent=store.run(approval.parentRunId);
  const lineage=[parent];let cursor=parent;
  while(cursor.documentationContinuation){
   if(lineage.length>16)return fail();
   const ref=cursor.documentationContinuation,ancestorApproval=read(store,cursor.projectId,cursor.id,ref.recordId,'DocumentationContinuationApproval') as unknown as DocumentationContinuationApproval;
   if(hash(ancestorApproval)!==ref.sha256||ancestorApproval.runId!==cursor.id||ancestorApproval.projectId!==cursor.projectId)return fail();
   cursor=store.run(ancestorApproval.parentRunId);if(lineage.some(item=>item.id===cursor.id))return fail();lineage.push(cursor);
  }
  const lineageIds=new Set(lineage.map(item=>item.id));
  const material=(recordId:string,kind:string,scope:'PARENT'|'LINEAGE')=>{
   const row=store.db.prepare('SELECT id,run_id,kind,at,data FROM records WHERE project_id=? AND id=? AND kind=?').get(run.projectId,recordId,kind);
   if(!row||typeof row.data!=='string'||Buffer.byteLength(row.data)>2*1024*1024+4096)return fail();
   if(scope==='PARENT'?String(row.run_id)!==parent.id:!lineageIds.has(String(row.run_id)))return fail();
   return {recordId:String(row.id),kind:String(row.kind),at:String(row.at),data:object(JSON.parse(row.data))};
  };
  const review=material(approval.parentReviewRecordId,'Review','PARENT'),packetRow=material(approval.parentReviewPacketId,'ReviewPacket','PARENT'),packet=object(packetRow.data.packet);
  if(hash(review.data)!==approval.parentReviewRecordHash||packetRow.data.sha256!==approval.parentReviewPacketHash||hash(packet)!==approval.parentReviewPacketHash||packet.schema!=='dream-maker.review-packet.v1'||packet.runId!==parent.id||packet.specHash!==run.specHash||hash(packet.plan)!==approval.parentPlanHash||!Array.isArray(packet.sourceHistory)||object(packet.sourceHistory.at(-1)).treeHash!==approval.parentSourceHash)return fail();
  const planning=originalPlanningReference(store,parent,approval.parentPlanRecordId,approval.parentPlannerSessionRecordId);
  const plan=material(approval.parentPlanRecordId,'Plan','LINEAGE'),session=material(approval.parentPlannerSessionRecordId,'AgentSession','LINEAGE'),usage=material(approval.parentPlannerUsageRecordId,'UsageLedger','LINEAGE'),execution=object(packet.executionEvidence),inherited=execution.inheritedPlanning===undefined?null:object(execution.inheritedPlanning),inheritedPlanner=inherited?object(inherited.planner):null,identity=planning.identity;
  const matches=(items:unknown,record:{recordId:string;data:unknown})=>Array.isArray(items)&&items.filter(raw=>object(raw).recordId===record.recordId&&hash(object(raw).data)===hash(record.data)).length===1;
  if(inheritedPlanner){
   if(hash(object(inheritedPlanner.identity))!==hash(identity)||hash(object(inheritedPlanner.session))!==hash(session)||hash(object(inheritedPlanner.usage))!==hash(usage))return fail();
  }else if(hash(object(object(execution.roleIdentities).planner2))!==hash(identity)||!matches(execution.sessions,session)||!matches(execution.usage,usage))return fail();
  const lineageSql=lineage.map(()=>'?').join(',');
  const rows=store.db.prepare("SELECT id,at,payload FROM events WHERE project_id=? AND run_id IN ("+lineageSql+") AND type='agent.event' AND json_extract(payload,'$.method') IN ('dm/codexAdmission','dm/codexCompletion') AND json_extract(payload,'$.params.role')='planner2' AND json_extract(payload,'$.params.threadId')=? ORDER BY id LIMIT 9").all(run.projectId,...lineage.map(item=>item.id),identity.sessionId);
  if(rows.length>8)return fail();const codexEvents=rows.map(row=>({eventId:Number(row.id),at:String(row.at),data:object(JSON.parse(String(row.payload)))})),admissions=codexEvents.filter(e=>e.data.method==='dm/codexAdmission'),completions=codexEvents.filter(e=>e.eventId===approval.parentPlannerCompletionEventId);
  const recordedEvents=[...(Array.isArray(execution.codexEvents)?execution.codexEvents:[]),...(inherited&&Array.isArray(inherited.codexEvents)?inherited.codexEvents:[])];
  if(admissions.length!==1||completions.length!==1||codexEvents.some(event=>recordedEvents.filter(raw=>object(raw).eventId===event.eventId&&hash(object(raw).data)===hash(event.data)).length!==1))return fail();
  const a=object(admissions[0].data.params);if(a.model!==identity.model||a.provider!==identity.provider||a.authentication!==identity.authentication||a.includedUsageAllowed!==true||a.paidFallback!==false||typeof a.permissionProfile!=='string'||!a.permissionProfile||typeof a.policyHash!=='string'||!/^[a-f0-9]{64}$/.test(a.policyHash))return fail();
   // The parent packet has already been reviewed and its full digest is bound
   // by the continuation approval. Do not copy its complete transport payload
   // into every successor review packet; retain the exact digest and the
   // planner identity needed to prove lineage and reviewer independence.
   const inheritedPacket={schema:packet.schema,runId:packet.runId,specHash:packet.specHash,
     executionEvidence:{roleIdentities:{planner2:identity}}};
   return {schema:'dream-maker.inherited-planning-evidence.v1' as const,origin:'INHERITED_NOT_NEW_PLANNING' as const,parentRunId:parent.id,parentRunHash:approval.parentRunHash,approval:run.documentationContinuation!,plan,planner:{identity,session,usage},codexEvents,review,packet:{recordId:packetRow.recordId,sha256:approval.parentReviewPacketHash,packet:inheritedPacket}};
 }catch{return fail();}
}
/** Zero model preparation using the original Store lease and ordinary owned workspace. */
export async function prepareDocumentationContinuation(store:Store,data:string,config:Config,candidate:DocumentationCorrectionCandidate,custody:DocumentationCustodyPrepared,request:DocumentationContinuationRequest,actor:string,check:()=>DocumentationCorrectionCandidate,room:(bytes:number,nodes:number)=>void,seed:(child:Run)=>void):Promise<Run>{
 const parent=store.run(candidate.runId),requestHash=hash(request),replay=documentationContinuationReplay(store,parent.id,request);if(replay)return replay;
 const current=()=>{if(check().candidateHash!==candidate.candidateHash||hash(store.run(parent.id))!==hash(parent))return fail();};
 return store.once('documentation-continuation:'+parent.id+':'+candidate.reviewRecordId,{requestHash},async()=>{
  current();const custodyRows=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='DocumentationCorrectionPrepared' LIMIT 2").all(parent.projectId,parent.id);if(custodyRows.length!==1)return fail();const custodyRow=custodyRows[0],saved=object(JSON.parse(String(custodyRow.data)));if(hash(saved.result)!==hash(custody))return fail();
  const rawRows=store.db.prepare('SELECT id,kind,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097').all(parent.projectId,parent.id);if(rawRows.length>4096)return fail();
  const parentRows=rawRows.map(row=>({id:String(row.id),kind:String(row.kind),data:object(JSON.parse(String(row.data)))}));
  let planning;
  if(parent.documentationContinuation){
   const inherited=documentationContinuationEvidence(store,parent);if(!inherited)return fail();
   planning=originalPlanningReference(store,parent,inherited.parentPlanRecordId,inherited.parentPlannerSessionRecordId);
  }else{
   const plans=parentRows.filter(x=>x.kind==='Plan'&&hash(x.data.plan)===hash(parent.plan)),sessions=parentRows.filter(x=>x.kind==='AgentSession'&&x.data.role==='planner2'&&x.data.sessionId===parent.sessions.planner2);
   if(plans.length!==1||sessions.length!==1)return fail();
   planning=originalPlanningReference(store,parent,plans[0].id,sessions[0].id);
  }
  const parentReview=read(store,parent.projectId,parent.id,candidate.reviewRecordId,'Review');
  const catalog=files(parent.workspace),source=within(data,'controller/executor-waves/'+custody.preparationId+'/source');if(hash(catalog)!==candidate.sourceHash||hash(files(source))!==candidate.sourceHash)return fail();
  const rid=id('run'),workspace=within(data,'workspaces/'+rid),at=now(),planVersion=store.planVersion(candidate.planVersionId),flowConfig=classicFlowSnapshot(config,planVersion,rid,runUsesLaya(parent));
  const code=candidate.repairKind==='CODE',preparedReason=code?'BOUNDED_CODE_REPAIR_PREPARED':'DOCUMENTATION_CONTINUATION_PREPARED';
  const child:Run={id:rid,projectId:parent.projectId,mode:'live',version:1,specId:parent.specId,specHash:parent.specHash,planVersionId:parent.planVersionId,planVersionHash:parent.planVersionHash,rolePolicy:parent.rolePolicy,flowName:'classic',flowConfig,flowConfigHash:hash(flowConfig),configFingerprint:flowConfig.configurationFingerprint,state:'PAUSED',phase:'IMPLEMENTING',repairCount:0,maxRepairs:1,calls:0,maxCalls:2,createdAt:at,updatedAt:at,workspace,treeHash:candidate.sourceHash,tasks:parent.tasks.map(t=>t.id===candidate.taskId?{...structuredClone(t),status:'pending'}:{...structuredClone(t),status:'implemented',inheritedFrom:{runId:parent.id,taskId:t.id}}),findings:structuredClone(parent.review!.findings),plan:structuredClone(parent.plan),verification:null,review:null,artifacts:[],reason:preparedReason,failedFingerprints:[],attempt:0,demoFault:false,maxSeconds:parent.maxSeconds,usage:[],sessions:{}};
  const body:DocumentationContinuationApproval={schema:code?'dream-maker.bounded-code-repair-continuation.v1':'dream-maker.documentation-continuation.v1',...(code?{repairKind:'CODE' as const}:{}),runId:rid,projectId:parent.projectId,parentRunId:parent.id,parentRunHash:hash(parent),parentReviewRecordId:candidate.reviewRecordId,parentReviewRecordHash:hash(parentReview),parentReviewPacketId:String(parentReview.packetId),parentReviewPacketHash:String(parentReview.packetHash),parentPlanRecordId:planning.planRecordId,parentPlannerSessionRecordId:planning.sessionRecordId,parentPlannerRequestId:planning.requestId,parentPlannerUsageRecordId:planning.usageRecordId,parentPlannerCompletionEventId:planning.completionEventId,parentPlanHash:hash(parent.plan),parentSourceHash:candidate.sourceHash,candidateHash:candidate.candidateHash,custodyRecordId:String(custodyRow.id),custodyHash:hash(saved),planVersionId:planVersion.id,planVersionHash:planVersion.contentHash,flowConfigHash:child.flowConfigHash!,taskId:candidate.taskId,writePaths:candidate.writePaths,protectedFiles:catalog.filter(f=>!candidate.writePaths.includes(f.path)),parentCalls:candidate.parentCalls,parentSupplementalCalls:candidate.parentSupplementalCalls,seriesMaxCalls:candidate.parentCalls+candidate.parentSupplementalCalls+2,additionalCalls:2,additionalRepairs:1,taskDeadline:null,actorHash:hash(actor),at,confirmed:true,modelDispatched:false};
  const dirs=new Set<string>();for(const f of catalog){const pieces=f.path.split('/');for(let n=1;n<pieces.length;n++)dirs.add(pieces.slice(0,n).join('/'));}room(catalog.reduce((sum,f)=>sum+f.bytes,0),catalog.length+dirs.size+2);current();
  const intentId=store.record('DocumentationContinuationIntent',parent.projectId,parent.id,{runId:rid,parentRunHash:body.parentRunHash,requestHash,approvalHash:hash(body),sourceHash:candidate.sourceHash,modelDispatched:false});
  mkdirSync(within(data,'workspaces'),{recursive:true,mode:0o700});mkdirSync(workspace,{mode:0o700});
  for(const f of catalog){const bytes=get(source,f.path);if(hash(bytes)!==f.sha256||bytes.length!==f.bytes)return fail();const target=within(workspace,f.path);mkdirSync(dirname(target),{recursive:true,mode:0o700});within(workspace,f.path);writeFileSync(target,bytes,{flag:'wx',flush:true,mode:0o600});}
  return store.tx(()=>{current();if(hash(files(source))!==candidate.sourceHash||hash(files(workspace))!==candidate.sourceHash)return fail();store.acquire(parent.projectId,rid);
   const approvalId=store.record('DocumentationContinuationApproval',parent.projectId,rid,body);child.documentationContinuation={recordId:approvalId,sha256:hash(body)};store.insertRun(child);seed(child);
   documentationPreparedEvidence(store,child);const project=store.project(parent.projectId);project.activeRunId=rid;store.saveProject(project);store.record('DocumentationContinuationPrepared',parent.projectId,parent.id,{runId:rid,intentId,requestHash,approval:child.documentationContinuation,modelDispatched:false});store.event(parent.projectId,rid,code?'run.bounded-code-repair.prepared':'run.documentation-continuation.prepared',{parentRunId:parent.id,repairKind:code?'CODE':'DOCUMENTATION',calls:0,maxCalls:2,inheritedCalls:body.parentCalls+body.parentSupplementalCalls,seriesMaxCalls:body.seriesMaxCalls,modelDispatched:false,taskDeadline:null});return child;
  });
 });
}
