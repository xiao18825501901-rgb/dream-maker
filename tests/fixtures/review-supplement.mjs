// OFFLINE synthetic Store/Engine records. Never a product identity or Live evidence.
import {partialSourceCustodyFixture} from './partial-source-custody.mjs';
import {buildReviewPacket} from '../../dist/server/review-packet.js';
import {hash} from '../../dist/server/security.js';
export async function reviewSupplementFixture(t){
 const x=await partialSourceCustodyFixture(t,{admissionRecovery:true,configure:h=>{h.config.codex.model='OFFLINE_CODEX';h.config.codex.permissionProfile='dream-maker-supervisor-data';}}),s=x.h.store,r=s.run(x.r.id),record=(kind,data)=>s.record(kind,x.p.id,r.id,data);
 r.state='REVIEWING';r.phase='REVIEWING';r.calls=r.maxCalls;r.maxSeconds=3600;r.repairCount=r.maxRepairs;s.saveRun(r);
 const packet=buildReviewPacket(s,r,x.s);delete packet.executionEvidence.incompleteTurnCustody;
 const packetId=record('ReviewPacket',{packet,sha256:hash(packet)}),dispatchId='OFFLINE_COMPLETED_REVIEW',generation='OFFLINE_REVIEW_GENERATION',processId='OFFLINE_REVIEW_PROCESS';
 record('DispatchGranted',{dispatchId,generation,kind:'reviewer',mode:'live'});
 const markerId=s.event(x.p.id,r.id,'role.dispatch',{state:'REVIEWING',phase:'REVIEWING'});
 record('OwnedProcessIntent',{dispatchId,generation,processId,platform:'win32'});
 record('OwnedProcessCleanup',{dispatchId,generation,processId,cleanupReturned:true});record('DispatchFinished',{dispatchId,generation,outcome:'COMPLETED',cleanupReturned:true});
 const identity={runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:'OFFLINE_CODEX',sessionId:'OFFLINE_PRIOR_REVIEWER',requestId:'OFFLINE_PRIOR_REVIEW_TURN'};
 const {requestId,...recordIdentity}=identity;
 record('AgentSession',{role:'reviewer',...recordIdentity,modelEvidence:'ADAPTER_VERIFIED_RESPONSE',dispatchId,generation});
 s.event(x.p.id,r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'reviewer',threadId:identity.sessionId,model:identity.model,provider:'openai',authentication:identity.authentication,includedUsageAllowed:true,paidFallback:false,permissionProfile:'dream-maker-supervisor-data',policyHash:'d'.repeat(64),reviewPacketHash:hash(packet)}});
 s.event(x.p.id,r.id,'agent.event',{method:'dm/codexCompletion',params:{role:'reviewer',threadId:identity.sessionId,turnId:identity.requestId,model:identity.model,provider:'openai',status:'completed',specHash:r.specHash,runId:r.id}});
 const review={verdict:'BLOCKED',source:'CODEX',treeHash:r.treeHash,findings:[{id:'OFFLINE_CUSTODY',severity:'high',description:'offline missing custody evidence',evidence:'offline',status:'open'}]};
 const previousReviewRecordId=record('Review',{...review,packetId,packetHash:hash(packet)});
 r.state='BLOCKED';r.reason='REVIEW_BLOCKED';r.review=review;r.findings=review.findings;r.roleIdentities.reviewer=identity;r.sessions.reviewer=identity.sessionId;s.saveRun(r);s.release(r.projectId,r.id);
 x.h.engine.nativeExecution={assertReady:()=>{},executor:()=>{throw Error('MODEL_FORBIDDEN');},verify:async()=>{throw Error('MODEL_FORBIDDEN');},close:async()=>{}};
 const fresh=s.run(r.id);return {...x,r:fresh,dispatchId,processId,markerId,previousReviewRecordId,request:{confirmed:true,sourceHash:fresh.treeHash,expectedVersion:fresh.version,previousReviewRecordId,packetHash:hash(buildReviewPacket(s,fresh,x.s))}};
}
