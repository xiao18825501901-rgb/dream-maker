import type {Run} from '../shared/types.js';import type {Store} from './store.js';import {DomainError,hash,object} from './security.js';
/** This typed controller error occurs synchronously before turn/start is sent.
 * Admission means session readiness, not a turn or completed review. */
export function unstartedReviewBasis(store:Store,run:Run){
 const fail=():never=>{throw new DomainError('UNSTARTED_REVIEW_NOT_RECOVERABLE',409);};
 if(run.mode!=='live'||run.flowName!=='classic'||run.state!=='BLOCKED'||run.phase!=='REVIEWING'||run.reason!=='RPC_EXPECTED_ECHO_LIMIT'||run.review!==null||
  !run.verification?.ok||run.verification.treeHash!==run.treeHash||!run.tasks.length||run.tasks.some(t=>t.status!=='implemented')||run.calls>=run.maxCalls||run.repairCount!==run.maxRepairs)return fail();
 const rows=store.db.prepare('SELECT id,kind,at,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097').all(run.projectId,run.id)
  .map(r=>({id:String(r.id),kind:String(r.kind),at:String(r.at),data:object(JSON.parse(String(r.data)))}));if(rows.length>4096)return fail();
 const markers=rows.filter(r=>r.kind==='ReviewPreparationRecovery'&&r.data.sourceHash===run.treeHash);
 if(markers.length!==1||markers[0].data.preparationFailure==='RPC_EXPECTED_ECHO_LIMIT')return fail();
 const grants=rows.filter(r=>r.kind==='DispatchGranted'),grant=grants.at(-1),packet=rows.filter(r=>r.kind==='ReviewPacket').at(-1);
 if(!grant||grant.data.kind!=='reviewer'||grant.data.mode!=='live'||typeof grant.data.generation!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(grant.data.generation)||!packet||rows.indexOf(packet)>=rows.indexOf(grant)||hash(packet.data.packet)!==packet.data.sha256)return fail();
 const p=object(packet.data.packet),history=p.sourceHistory;if(p.schema!=='dream-maker.review-packet.v1'||p.runId!==run.id||p.specHash!==run.specHash||!Array.isArray(history)||object(history.at(-1)).treeHash!==run.treeHash)return fail();
 const finished=rows.filter(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===grant.data.dispatchId),intents=rows.filter(r=>r.kind==='OwnedProcessIntent'&&r.data.dispatchId===grant.data.dispatchId);
 if(finished.length!==1||finished[0].data.outcome!=='RPC_EXPECTED_ECHO_LIMIT'||finished[0].data.cleanupReturned!==true||finished[0].data.generation!==grant.data.generation||
  rows.indexOf(finished[0])<=rows.indexOf(grant)||intents.length!==1||rows.indexOf(intents[0])<=rows.indexOf(grant)||intents[0].data.platform!=='win32'||intents[0].data.generation!==grant.data.generation||
  typeof intents[0].data.processId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(intents[0].data.processId)||
  rows.filter(r=>r.kind==='OwnedProcessIntent'&&r.data.processId===intents[0].data.processId).length!==1)return fail();
 const cleanup=rows.filter(r=>r.kind==='OwnedProcessCleanup'&&r.data.processId===intents[0].data.processId);
 if(cleanup.length!==1||cleanup[0].data.dispatchId!==grant.data.dispatchId||cleanup[0].data.generation!==grant.data.generation||cleanup[0].data.cleanupReturned!==true||
  rows.indexOf(cleanup[0])<=rows.indexOf(intents[0])||rows.indexOf(cleanup[0])>=rows.indexOf(finished[0])||
  rows.slice(rows.indexOf(grant)+1).some(r=>['ToolIntent','ToolResult','AgentSession','Review'].includes(r.kind)))return fail();
 const events=store.db.prepare("SELECT id,payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND at>=? ORDER BY id LIMIT 1001").all(run.projectId,run.id,grant.at)
  .map(r=>({id:Number(r.id),data:object(JSON.parse(String(r.payload)))}));
 const admissions=events.filter(e=>e.data.method==='dm/codexAdmission');
 if(events.length>1000||admissions.length!==1||events.some(e=>!['dm/codexPreparation','dm/codexAdmission'].includes(String(e.data.method))||object(e.data.params??{}).role!=='reviewer'))return fail();
 const a=object(admissions[0].data.params);if(a.reviewPacketHash!==packet.data.sha256||a.provider!=='openai'||a.authentication!=='CHATGPT_SUBSCRIPTION'||a.includedUsageAllowed!==true||a.paidFallback!==false||
  typeof a.threadId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(a.threadId)||a.threadId===run.sessions.planner2||a.permissionProfile!=='dream-maker-supervisor-data'||typeof a.policyHash!=='string'||!/^[a-f0-9]{64}$/.test(a.policyHash))return fail();
 return {dispatchId:String(grant.data.dispatchId),generation:String(grant.data.generation),sourceHash:run.treeHash,packetRecordId:packet.id,packetHash:String(packet.data.sha256),threadId:a.threadId,basisHash:hash({rows,events}),version:run.version};
}
