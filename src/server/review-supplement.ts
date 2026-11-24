import type {Run,Role,AgentOutput} from '../shared/types.js';
import type {Store} from './store.js';
import {DomainError,hash,object} from './security.js';
import {TARGET_ROLE_POLICY} from './role-policy.js';
const fail=():never=>{throw new DomainError('REVIEW_SUPPLEMENT_BINDING_INVALID',409);};
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function material(store:Store,run:Run){
 const rows=store.db.prepare('SELECT id,kind,at,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097').all(run.projectId,run.id);
 if(rows.length>4096)return fail();return rows.map((r,index)=>({id:String(r.id),kind:String(r.kind),at:String(r.at),data:object(JSON.parse(String(r.data))),index}));
}
/** Read-only eligibility for a single evidence addendum, never permission to call a model. */
export function reviewSupplementBasis(store:Store,run:Run,packet:unknown){
 if(run.mode!=='live'||run.flowName!=='classic'||run.rolePolicy!==TARGET_ROLE_POLICY||run.state!=='BLOCKED'||run.phase!=='REVIEWING'||run.reason!=='REVIEW_BLOCKED'||run.review?.verdict!=='BLOCKED'||
  !run.treeHash||run.review.treeHash!==run.treeHash||!run.verification?.ok||run.verification.treeHash!==run.treeHash||!run.tasks.length||run.tasks.some(t=>t.status!=='implemented')||
  run.calls!==run.maxCalls||run.repairCount!==run.maxRepairs||run.reviewSupplement)return fail();
 const rows=material(store,run);if(rows.some(r=>r.kind==='ReviewSupplementApproval'||r.kind==='ReviewSupplementCallReservation'))return fail();
 const review=rows.filter(r=>r.kind==='Review').at(-1),grant=rows.filter(r=>r.kind==='DispatchGranted').at(-1),identity=run.roleIdentities?.reviewer;
 if(!review||!grant||!identity||identity.runner!=='CODEX_CLI'||identity.provider!=='openai'||identity.authentication!=='CHATGPT_SUBSCRIPTION'||
  identity.sessionId===run.sessions.planner2||identity.sessionId!==run.sessions.reviewer||grant.data.kind!=='reviewer'||grant.data.mode!=='live'||typeof grant.data.dispatchId!=='string'||typeof grant.data.generation!=='string'||
  review.data.verdict!=='BLOCKED'||review.data.source!=='CODEX'||review.data.treeHash!==run.treeHash||hash(run.review)!==hash({verdict:review.data.verdict,findings:review.data.findings,source:review.data.source,treeHash:review.data.treeHash}))return fail();
 const dispatchId=grant.data.dispatchId,generation=grant.data.generation;
 const ends=rows.filter(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===dispatchId),sessions=rows.filter(r=>r.kind==='AgentSession'&&r.data.dispatchId===dispatchId);
 if(rows.filter(r=>r.kind==='DispatchGranted'&&r.data.dispatchId===dispatchId).length!==1||ends.length!==1||ends[0].data.outcome!=='COMPLETED'||ends[0].data.cleanupReturned!==true||ends[0].data.generation!==generation||
  ends[0].index<=grant.index||review.index<=ends[0].index||sessions.length!==1||sessions[0].index<=ends[0].index||sessions[0].index>=review.index||sessions[0].data.role!=='reviewer'||sessions[0].data.generation!==generation||sessions[0].data.modelEvidence!=='ADAPTER_VERIFIED_RESPONSE'||
  !['runner','provider','authentication','model','sessionId'].every(k=>sessions[0].data[k]===identity[k as keyof typeof identity]))return fail();
 const during=rows.slice(grant.index+1,ends[0].index),processes=during.filter(r=>r.kind==='OwnedProcessIntent');
 if(!processes.length||new Set(processes.map(p=>p.data.processId)).size!==processes.length||during.some(r=>r.kind==='ToolIntent'||r.kind==='ToolResult')||processes.some(p=>{
  const c=rows.filter(r=>r.kind==='OwnedProcessCleanup'&&r.data.processId===p.data.processId);
  return typeof p.data.processId!=='string'||!p.data.processId||p.data.dispatchId!==dispatchId||p.data.generation!==generation||rows.filter(r=>r.kind==='OwnedProcessIntent'&&r.data.processId===p.data.processId).length!==1||c.length!==1||c[0].index<=p.index||c[0].index>=ends[0].index||c[0].data.dispatchId!==dispatchId||c[0].data.generation!==generation||c[0].data.cleanupReturned!==true;
 }))return fail();
 const old=rows.find(r=>r.id===review.data.packetId&&r.kind==='ReviewPacket');if(!old||old.index>=grant.index||hash(old.data.packet)!==old.data.sha256||review.data.packetHash!==old.data.sha256)return fail();
 const events=store.db.prepare("SELECT id,type,at,payload FROM events WHERE project_id=? AND run_id=? AND (type='role.dispatch' OR type='agent.event' AND json_extract(payload,'$.method') IN ('dm/codexAdmission','dm/codexCompletion')) ORDER BY id LIMIT 1001").all(run.projectId,run.id).map(r=>({id:Number(r.id),type:String(r.type),at:String(r.at),data:object(JSON.parse(String(r.payload)))}));
 const start=Date.parse(grant.at),end=Date.parse(ends[0].at),markers=events.filter(e=>e.type==='role.dispatch'&&Date.parse(e.at)>=start&&Date.parse(e.at)<=end);
 if(events.length>1000||!Number.isFinite(start)||!Number.isFinite(end)||end<start||markers.length!==1||markers[0].data.phase!=='REVIEWING'||markers[0].data.state!=='REVIEWING')return fail();
 const current=events.filter(e=>e.id>markers[0].id&&e.type==='agent.event'&&Date.parse(e.at)>=Date.parse(markers[0].at)&&Date.parse(e.at)<=end);
 const admissions=current.filter(e=>{const p=object(e.data.params??{});return e.data.method==='dm/codexAdmission'&&p.role==='reviewer'&&p.threadId===identity.sessionId&&p.model===identity.model&&p.provider===identity.provider&&p.authentication===identity.authentication&&p.includedUsageAllowed===true&&p.paidFallback===false&&p.reviewPacketHash===old.data.sha256;});
 const completions=current.filter(e=>{const p=object(e.data.params??{});return e.data.method==='dm/codexCompletion'&&p.role==='reviewer'&&p.threadId===identity.sessionId&&p.turnId===identity.requestId&&p.model===identity.model&&p.provider===identity.provider&&p.status==='completed'&&p.runId===run.id&&p.specHash===run.specHash;});
 if(admissions.length!==1||completions.length!==1||admissions[0].id>=completions[0].id||!sha(object(admissions[0].data.params).policyHash))return fail();
 const oldPacket=object(old.data.packet),p=object(packet),custody=object(object(p.executionEvidence??{}).incompleteTurnCustody??{});
 if(oldPacket.runId!==run.id||oldPacket.specHash!==run.specHash||p.runId!==run.id||p.specHash!==run.specHash||!Array.isArray(custody.links)||!custody.links.length||
  object(oldPacket.executionEvidence??{}).incompleteTurnCustody!==undefined||hash(packet)===old.data.sha256)return fail();
 return {dispatchId,generation,previousReviewRecordId:review.id,previousReviewHash:hash(review.data),previousPacketHash:old.data.sha256,reviewPolicyHash:object(admissions[0].data.params).policyHash,packetHash:hash(packet),basisHash:hash({rows,packet,current})};
}
export function reviewSupplementEvidence(store:Store,run:Run){
 if(!run.reviewSupplement)return null;const ref=run.reviewSupplement,rows=material(store,run),approvals=rows.filter(r=>r.kind==='ReviewSupplementApproval');
 if(approvals.length!==1||approvals[0].id!==ref.recordId||!sha(ref.sha256))return fail();const body=approvals[0].data;
 if(hash(body)!==ref.sha256||body.schema!=='dream-maker.review-supplement.v1'||body.runId!==run.id||body.projectId!==run.projectId||body.specHash!==run.specHash||body.planVersionHash!==run.planVersionHash||body.flowConfigHash!==run.flowConfigHash||body.configFingerprint!==run.configFingerprint||
  body.sourceHash!==run.treeHash||body.calls!==run.calls||body.maxCalls!==run.maxCalls||body.calls!==body.maxCalls||body.repairCount!==run.repairCount||body.maxRepairs!==run.maxRepairs||
  body.originalCreatedAt!==run.createdAt||body.originalMaxSeconds!==run.maxSeconds||body.additionalCalls!==1||body.scope!=='REVIEWER_ONLY_NO_REPAIR'||body.confirmed!==true||body.modelDispatched!==false||!sha(body.actorHash)||!sha(body.packetHash)||!sha(body.reviewPolicyHash)||
  typeof body.at!=='string'||!Number.isFinite(Date.parse(body.at))||body.at!==new Date(Date.parse(body.at)).toISOString()||run.mode!=='live'||run.flowName!=='classic'||run.rolePolicy!==TARGET_ROLE_POLICY)return fail();
 const previous=rows.find(r=>r.id===body.previousReviewRecordId&&r.kind==='Review'),proof=object(body.proof??{});
 if(!previous||hash(previous.data)!==body.previousReviewHash||!sha(body.basisHash)||proof.schema!=='dream-maker.dispatch-recovery.v1'||proof.dispatchId!==body.dispatchId||proof.proven!==true||!sha(proof.basisSha256))return fail();
 const reservations=rows.filter(r=>r.kind==='ReviewSupplementCallReservation');
 if(reservations.length>1||reservations.some(r=>{
  const grants=rows.filter(g=>g.kind==='DispatchGranted'&&g.data.dispatchId===r.data.dispatchId);
  return r.data.approvalRecordId!==ref.recordId||r.data.approvalHash!==ref.sha256||r.data.sourceHash!==run.treeHash||r.data.role!=='reviewer'||typeof r.data.dispatchId!=='string'||typeof r.data.generation!=='string'||
   !Number.isSafeInteger(r.data.eventBoundaryId)||Number(r.data.eventBoundaryId)<1||grants.length!==1||grants[0].index<=approvals[0].index||grants[0].index>=r.index||grants[0].data.kind!=='reviewer'||grants[0].data.mode!=='live'||grants[0].data.generation!==r.data.generation;
 }))return fail();
 return {approval:body,used:reservations.length as 0|1};
}
export function assertReviewSupplementPacket(store:Store,run:Run,packet:unknown){
 const supplement=reviewSupplementEvidence(store,run);if(!supplement)return fail();
 const {reviewSupplementApproval,...base}=object(packet);if(hash(reviewSupplementApproval)!==hash(supplement.approval)||hash(base)!==supplement.approval.packetHash)return fail();
 return supplement;
}
export function reserveReviewSupplementCall(store:Store,run:Run,role:Role,dispatch:{dispatchId:string;generation:string}){
 const evidence=reviewSupplementEvidence(store,run);if(!evidence||role!=='reviewer'||run.phase!=='REVIEWING')throw new DomainError('REVIEW_SUPPLEMENT_ROLE_DENIED',409);
 if(evidence.used)throw new DomainError('REVIEW_SUPPLEMENT_CALL_EXHAUSTED',409);
 const rows=material(store,run),approval=rows.find(r=>r.id===run.reviewSupplement!.recordId),grants=rows.filter(r=>r.kind==='DispatchGranted'&&r.data.dispatchId===dispatch.dispatchId);
 if(!approval||!store.owns(run.projectId,run.id)||grants.length!==1||grants[0].index<=approval.index||grants[0].data.kind!=='reviewer'||grants[0].data.mode!=='live'||grants[0].data.generation!==dispatch.generation||
  !/^[A-Za-z0-9_-]{1,200}$/.test(dispatch.dispatchId)||!/^[A-Za-z0-9_-]{1,200}$/.test(dispatch.generation)||rows.some(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===dispatch.dispatchId))return fail();
 const eventBoundaryId=store.event(run.projectId,run.id,'run.review-supplement.call-reserved',{approvalRecordId:run.reviewSupplement!.recordId,dispatchId:dispatch.dispatchId,generation:dispatch.generation,sourceHash:run.treeHash,role});
 store.record('ReviewSupplementCallReservation',run.projectId,run.id,{approvalRecordId:run.reviewSupplement!.recordId,approvalHash:run.reviewSupplement!.sha256,sourceHash:run.treeHash,role,dispatchId:dispatch.dispatchId,generation:dispatch.generation,eventBoundaryId});
}
/** Extra review results must belong to this owned dispatch, never replayed prior output. */
export function assertReviewSupplementCompletion(store:Store,run:Run,role:Role,out:AgentOutput,dispatch:{dispatchId:string;generation:string}){
 const evidence=reviewSupplementEvidence(store,run),rows=material(store,run),reservation=rows.find(r=>r.kind==='ReviewSupplementCallReservation');
 if(!evidence||evidence.used!==1||role!=='reviewer'||!reservation||reservation.data.dispatchId!==dispatch.dispatchId||reservation.data.generation!==dispatch.generation||
  !out.sessionId||!out.usage.requestId||rows.some(r=>r.kind==='AgentSession'&&r.data.sessionId===out.sessionId||r.kind==='UsageLedger'&&r.data.requestId===out.usage.requestId)||
  Object.values(run.roleIdentities??{}).some(i=>i?.sessionId===out.sessionId||i?.requestId===out.usage.requestId))return fail();
 const grant=rows.find(r=>r.kind==='DispatchGranted'&&r.data.dispatchId===dispatch.dispatchId),ends=rows.filter(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===dispatch.dispatchId);
 if(!grant||ends.length!==1||ends[0].data.generation!==dispatch.generation||ends[0].data.outcome!=='COMPLETED'||ends[0].data.cleanupReturned!==true||ends[0].index<=reservation.index)return fail();
 const during=rows.slice(grant.index+1,ends[0].index),processes=during.filter(r=>r.kind==='OwnedProcessIntent');
 if(!processes.length||new Set(processes.map(p=>p.data.processId)).size!==processes.length||during.some(r=>r.kind==='ToolIntent'||r.kind==='ToolResult')||processes.some(p=>{
  const cleanups=rows.filter(r=>r.kind==='OwnedProcessCleanup'&&r.data.processId===p.data.processId);
  return p.data.platform!=='win32'||p.data.dispatchId!==dispatch.dispatchId||p.data.generation!==dispatch.generation||rows.filter(r=>r.kind==='OwnedProcessIntent'&&r.data.processId===p.data.processId).length!==1||cleanups.length!==1||cleanups[0].index<=p.index||cleanups[0].index>=ends[0].index||cleanups[0].data.dispatchId!==dispatch.dispatchId||cleanups[0].data.generation!==dispatch.generation||cleanups[0].data.cleanupReturned!==true;
 }))return fail();
 const packet=rows.filter(r=>r.kind==='ReviewPacket'&&r.index<grant.index).at(-1);if(!packet||hash(packet.data.packet)!==packet.data.sha256)return fail();assertReviewSupplementPacket(store,run,packet.data.packet);
 const endMarkers=rows.filter(r=>r.kind==='ReviewSupplementDispatchEnd'&&r.data.dispatchId===dispatch.dispatchId),startEvent=store.db.prepare("SELECT at,payload FROM events WHERE id=? AND project_id=? AND run_id=? AND type='run.review-supplement.call-reserved'").get(Number(reservation.data.eventBoundaryId),run.projectId,run.id);
 if(endMarkers.length!==1||endMarkers[0].index<=reservation.index||endMarkers[0].index>=ends[0].index||endMarkers[0].data.generation!==dispatch.generation||!Number.isSafeInteger(endMarkers[0].data.eventBoundaryId)||!startEvent)return fail();
 const boundary=object(JSON.parse(String(startEvent.payload))),from=Date.parse(reservation.at),until=Date.parse(endMarkers[0].at),grantAt=Date.parse(grant.at),finishAt=Date.parse(ends[0].at),startAt=Date.parse(String(startEvent.at));
 if(boundary.dispatchId!==dispatch.dispatchId||boundary.generation!==dispatch.generation||boundary.approvalRecordId!==run.reviewSupplement!.recordId||boundary.sourceHash!==run.treeHash||boundary.role!=='reviewer'||
  ![from,until,grantAt,finishAt,startAt].every(Number.isFinite)||from<grantAt||until<from||until>finishAt||startAt<grantAt||startAt>from)return fail();
 const events=store.db.prepare("SELECT id,at,payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND json_extract(payload,'$.dispatchId')=? ORDER BY id LIMIT 1001").all(run.projectId,run.id,dispatch.dispatchId).map(r=>({id:Number(r.id),at:String(r.at),data:object(JSON.parse(String(r.payload)))}));
 if(events.length>1000||events.some(e=>e.data.generation!==dispatch.generation||e.id<=Number(reservation.data.eventBoundaryId)||e.id>Number(endMarkers[0].data.eventBoundaryId)||!Number.isFinite(Date.parse(e.at))||Date.parse(e.at)<from||Date.parse(e.at)>until))return fail();
 const admissions=events.filter(e=>e.data.method==='dm/codexAdmission'),completions=events.filter(e=>e.data.method==='dm/codexCompletion');
 if(admissions.length!==1||completions.length!==1||admissions[0].id>=completions[0].id)return fail();
 const a=object(admissions[0].data.params),c=object(completions[0].data.params);
 if(a.role!=='reviewer'||a.threadId!==out.sessionId||a.model!==out.model||a.provider!=='openai'||a.authentication!=='CHATGPT_SUBSCRIPTION'||a.includedUsageAllowed!==true||a.paidFallback!==false||a.permissionProfile!=='dream-maker-supervisor-data'||a.policyHash!==evidence.approval.reviewPolicyHash||a.reviewPacketHash!==packet.data.sha256||
  c.role!=='reviewer'||c.threadId!==out.sessionId||c.turnId!==out.usage.requestId||c.model!==out.model||c.provider!=='openai'||c.status!=='completed'||c.runId!==run.id||c.specHash!==run.specHash)return fail();
}
