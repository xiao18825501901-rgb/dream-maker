import type {Store} from './store.js';import type {Run} from '../shared/types.js';
import {DomainError,hash,object} from './security.js';import {runDeadline} from './review-window.js';import {reviewAdmissionPrompt} from './review-admission.js';
export interface InterruptedReviewInput{runId:string;specHash:string;dispatchId:string;threadId:string;model:string;policyHash:string;inputHash:string;commandHash:string;argvHash:string}
export interface InterruptedReviewObservation{schema:'dream-maker.interrupted-review-observation.v1';threadId:string;turnId:string;status:'interrupted';inputHash:string;contextHash:string;transcriptHash:string;userOnly:true;modelDispatchesByInspection:0;cleanupReturned:true}
export function interruptedReviewBasis(store:Store,run:Run){
 const fail=():never=>{throw new DomainError('REVIEW_INTERRUPTION_NOT_RECOVERABLE',409);};
 if(run.mode!=='live'||run.flowName!=='classic'||run.state!=='BLOCKED'||run.phase!=='REVIEWING'||run.reason!=='RPC_LINE_TOO_LONG'||run.review!==null||
  run.sessions.reviewer||run.roleIdentities?.reviewer||!run.tasks.length||run.tasks.some(t=>t.status!=='implemented')||
  !run.verification?.ok||run.verification.treeHash!==run.treeHash||run.calls>=run.maxCalls||Date.now()>=runDeadline(store,run))return fail();
 const rows=store.db.prepare('SELECT id,kind,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097').all(run.projectId,run.id)
  .map(r=>({id:String(r.id),kind:String(r.kind),data:object(JSON.parse(String(r.data)))}));
 if(rows.length>4096||rows.some(r=>['Review','ReviewInterruptedRecovery'].includes(r.kind)||r.kind==='AgentSession'&&r.data.role==='reviewer'))return fail();
 const packets=rows.filter(r=>r.kind==='ReviewPacket'),grants=rows.filter(r=>r.kind==='DispatchGranted'&&r.data.kind==='reviewer');
 if(packets.length!==1||grants.length!==1)return fail();const packet=packets[0].data,grant=grants[0].data;
 if(packet.sha256!==hash(packet.packet)||object(packet.packet).runId!==run.id||object(packet.packet).specHash!==run.specHash)return fail();
 const finishes=rows.filter(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===grant.dispatchId);
 const intents=rows.filter(r=>r.kind==='OwnedProcessIntent'&&r.data.dispatchId===grant.dispatchId);
 if(finishes.length!==1||finishes[0].data.cleanupReturned!==true||finishes[0].data.outcome!=='RPC_LINE_TOO_LONG'||finishes[0].data.generation!==grant.generation||
  intents.length!==1||intents[0].data.platform!=='win32'||intents[0].data.generation!==grant.generation||
  !rows.some(r=>r.kind==='OwnedProcessCleanup'&&r.data.processId===intents[0].data.processId&&r.data.dispatchId===grant.dispatchId&&r.data.cleanupReturned===true))return fail();
 const events=store.db.prepare("SELECT id,payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' ORDER BY id LIMIT 4097").all(run.projectId,run.id)
  .map(r=>({id:Number(r.id),data:object(JSON.parse(String(r.payload)))}));if(events.length>4096)return fail();
 const admissions=events.filter(e=>e.data.method==='dm/codexAdmission'&&object(e.data.params??{}).role==='reviewer');
 if(admissions.length!==1||events.some(e=>e.data.method==='dm/codexCompletion'&&object(e.data.params??{}).role==='reviewer'))return fail();
 const admission=object(admissions[0].data.params),threadId=String(admission.threadId),policyHash=String(admission.policyHash),model=String(admission.model);
 if(!/^[A-Za-z0-9_-]{1,200}$/.test(threadId)||!/^[a-f0-9]{64}$/.test(policyHash)||admission.provider!=='openai'||admission.authentication!=='CHATGPT_SUBSCRIPTION'||
  admission.paidFallback!==false||admission.includedUsageAllowed!==true||admission.permissionProfile!=='dream-maker-supervisor-data'||admission.reviewPacketHash!==packet.sha256)return fail();
 const body=JSON.stringify({specHash:run.specHash,taskData:JSON.stringify(packet.packet),laya:null});
 if(admission.materialEncoding!==undefined&&admission.materialEncoding!=='PACKET_OBJECT_V1')return fail();
 const prompt=reviewAdmissionPrompt({role:'reviewer',runId:run.id,specHash:run.specHash,prompt:body} as Parameters<typeof reviewAdmissionPrompt>[0],
  {threadId,model,provider:'openai',permissionProfile:'dream-maker-supervisor-data',policyHash,...(admission.materialEncoding==='PACKET_OBJECT_V1'?{materialEncoding:'PACKET_OBJECT_V1' as const}:{})}).prompt;
 if(admission.materialEncoding==='PACKET_OBJECT_V1'&&(admission.inputHash!==hash(prompt)||admission.inputBytes!==Buffer.byteLength(prompt)))return fail();
 const input:InterruptedReviewInput={runId:run.id,specHash:run.specHash,dispatchId:String(grant.dispatchId),threadId,model,policyHash,inputHash:hash(prompt),
  commandHash:String(intents[0].data.commandSha256),argvHash:String(intents[0].data.argvSha256)};
 if(![input.commandHash,input.argvHash].every(v=>/^[a-f0-9]{64}$/.test(v)))return fail();
 return {input,basisHash:hash({rows,events}),packetHash:String(packet.sha256),version:run.version};
}
