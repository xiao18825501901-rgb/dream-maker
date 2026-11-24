import type {Run} from '../shared/types.js';
import type {Store} from './store.js';
import {DomainError,hash,object} from './security.js';
import {readReviewOnlyWindow} from './review-only-window.js';
import {documentationContinuationEvidence} from './documentation-continuation.js';
import {taskDeadlineWaiverEvidence} from './task-deadline-waiver.js';

const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=():never=>{throw new DomainError('REVIEW_WINDOW_BINDING_INVALID',409);};
export interface ReviewWindowApproval {
    schema:'dream-maker.review-window-approval.v1';runId:string;projectId:string;specHash:string;
    planVersionHash:string;flowConfigHash:string;sourceHash:string;evidenceId:string;
    originalCreatedAt:string;originalMaxSeconds:number;originalDeadline:string;
    at:string;expiresAt:string;seconds:number;calls:number;maxCalls:number;repairCount:number;maxRepairs:number;
    packetHash:string;basisHash:string;actorHash:string;confirmed:true;modelDispatched:false;
    ownershipProofs:{recordId:string;sha256:string};
}
function record(store:Store,run:Run,id:string,kind:string):Record<string,unknown>{
    const row=store.db.prepare('SELECT data FROM records WHERE id=? AND project_id=? AND run_id=? AND kind=?').get(id,run.projectId,run.id,kind);
    if(!row||typeof row.data!=='string')return fail();
    try{return object(JSON.parse(row.data));}catch{return fail();}
}
/** The immutable original duration remains on Run. A separate, single owner
 * approval changes the effective clock, never calls, repairs or model authority. */
export function reviewWindowEvidence(store:Store,run:Run):ReviewWindowApproval|null{
    if(run.reviewWindow===undefined)return null;
    const ref=run.reviewWindow;
    if(!ref||typeof ref.recordId!=='string'||!ref.recordId||!sha(ref.sha256))return fail();
    const raw=record(store,run,ref.recordId,'ReviewWindowApproval'),body=raw as unknown as ReviewWindowApproval;
    const original=Date.parse(run.createdAt)+run.maxSeconds*1000,at=Date.parse(body.at),expires=Date.parse(body.expiresAt);
    if(hash(raw)!==ref.sha256||body.schema!=='dream-maker.review-window-approval.v1'||run.mode!=='live'||run.flowName!=='classic'||
        body.runId!==run.id||body.projectId!==run.projectId||body.specHash!==run.specHash||body.planVersionHash!==run.planVersionHash||
        body.flowConfigHash!==run.flowConfigHash||!sha(body.flowConfigHash)||!sha(body.planVersionHash)||!sha(body.sourceHash)||
        typeof body.evidenceId!=='string'||!body.evidenceId||body.originalCreatedAt!==run.createdAt||body.originalMaxSeconds!==run.maxSeconds||
        !Number.isFinite(original)||!Number.isFinite(at)||!Number.isFinite(expires)||at<original||
        body.originalDeadline!==new Date(original).toISOString()||body.at!==new Date(at).toISOString()||body.expiresAt!==new Date(expires).toISOString()||
        !Number.isSafeInteger(body.seconds)||body.seconds<60||body.seconds>7200||expires!==at+body.seconds*1000||
        body.maxCalls!==run.maxCalls||body.maxRepairs!==run.maxRepairs||!Number.isSafeInteger(body.maxCalls)||body.maxCalls<1||!Number.isSafeInteger(body.maxRepairs)||body.maxRepairs<0||
        !Number.isSafeInteger(body.calls)||body.calls<0||body.calls>=body.maxCalls||!Number.isSafeInteger(run.calls)||run.calls>body.maxCalls||
        !Number.isSafeInteger(body.repairCount)||body.repairCount<0||body.repairCount>body.maxRepairs||!Number.isSafeInteger(run.repairCount)||run.repairCount>body.maxRepairs||
        run.calls<body.calls||run.repairCount<body.repairCount||
        !sha(body.packetHash)||!sha(body.basisHash)||!sha(body.actorHash)||body.confirmed!==true||body.modelDispatched!==false)return fail();
    const refs=store.db.prepare("SELECT id FROM records WHERE project_id=? AND run_id=? AND kind='ReviewWindowApproval' LIMIT 2").all(run.projectId,run.id);
    if(refs.length!==1||refs[0].id!==ref.recordId||!body.ownershipProofs||typeof body.ownershipProofs.recordId!=='string'||!sha(body.ownershipProofs.sha256))return fail();
    const proofs=record(store,run,body.ownershipProofs.recordId,'ReviewWindowProcessProofs');
    if(hash(proofs)!==body.ownershipProofs.sha256||proofs.schema!=='dream-maker.review-window-process-proofs.v1'||proofs.runId!==run.id||!Array.isArray(proofs.proofs))return fail();
    return body;
}
export function runDeadline(store:Store,run:Run):number{
    const waiver=taskDeadlineWaiverEvidence(store,run);
    if(run.documentationContinuation){documentationContinuationEvidence(store,run);return Infinity;}
    const window=reviewWindowEvidence(store,run),continuation=readReviewOnlyWindow(store,run,window);
    // Validate every existing time record before allowing the owner waiver to
    // override the overall task clock. This does not change any technical timeout.
    if(waiver)return Infinity;
    if(continuation?.seconds===null)return Infinity;
    const deadline=continuation?Date.parse(continuation.expiresAt!):window?Date.parse(window.expiresAt):Date.parse(run.createdAt)+run.maxSeconds*1000;
    if(!Number.isFinite(deadline))return fail();return deadline;
}
export function reviewOnlyWindowEvidence(store:Store,run:Run){return readReviewOnlyWindow(store,run,reviewWindowEvidence(store,run));}
export {taskDeadlineWaiverEvidence} from './task-deadline-waiver.js';
