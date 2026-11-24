import type {Run} from '../shared/types.js';import type {Store} from './store.js';import {DomainError,hash,object} from './security.js';
export interface ReviewOnlyWindowApproval{
 schema:'dream-maker.review-only-window.v1';runId:string;projectId:string;specHash:string;planVersionHash:string;flowConfigHash:string;sourceHash:string;
 parentHash:string;parentExpiresAt:string;originalCreatedAt:string;originalMaxSeconds:number;calls:number;maxCalls:number;repairCount:number;maxRepairs:number;
 at:string;seconds:number|null;expiresAt:string|null;actorHash:string;confirmed:true;modelDispatched:false;scope:'REVIEW_ONLY_NO_REPAIR';proofHash:string;proofRecordId:string;
}
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** Additive owner time only. Parent bytes, model/repair limits and source remain bound. */
export function readReviewOnlyWindow(store:Store,run:Run,parent:{expiresAt:string}|null):ReviewOnlyWindowApproval|null{
 if(run.reviewOnlyWindow===undefined)return null;const fail=():never=>{throw new DomainError('REVIEW_ONLY_WINDOW_BINDING_INVALID',409);};
 const ref=run.reviewOnlyWindow;if(!parent||!run.reviewWindow||!ref||typeof ref.recordId!=='string'||!sha(ref.sha256))return fail();
 const rows=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='ReviewOnlyWindowApproval' LIMIT 2").all(run.projectId,run.id);
 if(rows.length!==1||rows[0].id!==ref.recordId||typeof rows[0].data!=='string')return fail();let raw;try{raw=object(JSON.parse(rows[0].data));}catch{return fail();}
 const b=raw as unknown as ReviewOnlyWindowApproval,at=Date.parse(b.at);
 const unlimited=b.seconds===null&&b.expiresAt===null;
 const expires=typeof b.expiresAt==='string'?Date.parse(b.expiresAt):NaN;
 if(hash(raw)!==ref.sha256||b.schema!=='dream-maker.review-only-window.v1'||run.mode!=='live'||run.flowName!=='classic'||b.runId!==run.id||b.projectId!==run.projectId||
  b.specHash!==run.specHash||b.planVersionHash!==run.planVersionHash||b.flowConfigHash!==run.flowConfigHash||!sha(b.sourceHash)||b.sourceHash!==run.treeHash||
  b.parentHash!==run.reviewWindow.sha256||b.parentExpiresAt!==parent.expiresAt||b.originalCreatedAt!==run.createdAt||b.originalMaxSeconds!==run.maxSeconds||
  !Number.isFinite(at)||at<Date.parse(parent.expiresAt)||b.at!==new Date(at).toISOString()||
  (!unlimited&&(!Number.isFinite(expires)||b.expiresAt!==new Date(expires).toISOString()||typeof b.seconds!=='number'||!Number.isSafeInteger(b.seconds)||b.seconds<60||b.seconds>3600||expires!==at+b.seconds*1000))||
  !Number.isSafeInteger(b.calls)||b.calls<0||run.calls<b.calls||run.calls>run.maxCalls||b.maxCalls!==run.maxCalls||
  b.repairCount!==run.repairCount||b.maxRepairs!==run.maxRepairs||b.repairCount!==b.maxRepairs||
  !sha(b.actorHash)||!sha(b.proofHash)||b.confirmed!==true||b.modelDispatched!==false||b.scope!=='REVIEW_ONLY_NO_REPAIR')return fail();
 if(typeof b.proofRecordId!=='string'||!b.proofRecordId)return fail();
 const row=store.db.prepare("SELECT data FROM records WHERE id=? AND project_id=? AND run_id=? AND kind='ReviewOnlyWindowProofs'").get(b.proofRecordId,run.projectId,run.id);
 if(!row||typeof row.data!=='string')return fail();let evidence;try{evidence=object(JSON.parse(row.data));}catch{return fail();}
 const basis=object(evidence.basis??{}),proof=object(evidence.proof??{});
 if(hash(evidence)!==b.proofHash||evidence.schema!=='dream-maker.review-only-window-proof.v1'||evidence.runId!==run.id||evidence.projectId!==run.projectId||evidence.specHash!==run.specHash||evidence.sourceHash!==b.sourceHash||
  typeof basis.dispatchId!=='string'||typeof basis.generation!=='string'||!basis.generation||!sha(basis.basisHash)||
  proof.schema!=='dream-maker.dispatch-recovery.v1'||proof.dispatchId!==basis.dispatchId||proof.proven!==true||!sha(proof.basisSha256))return fail();
 const grants=store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND kind='DispatchGranted' AND json_extract(data,'$.dispatchId')=? LIMIT 2").all(run.projectId,run.id,basis.dispatchId);
 if(grants.length!==1)return fail();const grant=object(JSON.parse(String(grants[0].data)));
 if(grant.kind!=='reviewer'||grant.mode!=='live'||grant.generation!==basis.generation)return fail();
 return b;
}
