import {readFileSync} from 'node:fs';import {resolve} from 'node:path';
import type {Store} from './store.js';import type {Run,Config} from '../shared/types.js';
import {DomainError,hash,object} from './security.js';import {reviewOnlyWindowEvidence,runDeadline} from './review-window.js';
import {CUSTOM_ROLE_POLICY,TARGET_ROLE_POLICY} from './role-policy.js';
import {assertCustomRoleDiversity,customRoleConfiguration} from './flow/custom-role-identity.js';

interface RetryRecord{id:string;kind:string;at:string;data:Record<string,unknown>}

function customParseFailureRetryBasis(store:Store,run:Run,currentPacket:unknown){
 const fail=():never=>{throw new DomainError('REVIEW_TRANSPORT_RETRY_NOT_ALLOWED',409);};
 if(run.mode!=='live'||run.flowName!=='custom'||run.rolePolicy!==CUSTOM_ROLE_POLICY||run.state!=='BLOCKED'||run.phase!=='REVIEWING'||run.reason!=='UPSTREAM_HTTP_502'||run.review!==null||
  !run.treeHash||!run.verification?.ok||run.verification.treeHash!==run.treeHash||!run.tasks.length||run.tasks.some(t=>t.status!=='implemented')||
  run.calls>=run.maxCalls||run.repairCount>run.maxRepairs||Date.now()>=runDeadline(store,run))return fail();
 if(!run.flowConfig||run.flowConfig.mode!=='custom'||run.flowConfig.magpie?.ownership!=='DM_ONLY'||run.flowConfig.magpie?.routing!=='MODELS_ONLY'||run.flowConfig.laya?.enabled!==false)return fail();
 let reviewerModel:string;try{assertCustomRoleDiversity(run.flowConfig);reviewerModel=customRoleConfiguration(run.flowConfig,'reviewer').model.id;}catch{return fail();}
 const planner=run.roleIdentities?.planner2,executor=run.roleIdentities?.executor;
 if(!planner||!executor||!run.sessions?.planner2||!run.sessions?.executor||run.sessions.planner2===run.sessions.executor||
  run.sessions?.reviewer!==undefined||run.roleIdentities?.reviewer!==undefined)return fail();
 const parse=(text:unknown)=>{try{return object(JSON.parse(String(text)));}catch{return fail();}};
 const rows:RetryRecord[]=store.db.prepare('SELECT id,kind,at,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097').all(run.projectId,run.id)
  .map(r=>({id:String(r.id),kind:String(r.kind),at:String(r.at),data:parse(r.data)}));
 if(rows.length>4096||rows.some(r=>r.kind==='ReviewTransportRetryPreparation'||r.kind==='ReviewTransportRetryRecovery'))return fail();
 const packets=rows.filter(r=>r.kind==='ReviewPacket'),queued=rows.filter(r=>r.kind==='DispatchQueued'&&r.data.kind==='reviewer'),
  grants=rows.filter(r=>r.kind==='DispatchGranted'&&r.data.kind==='reviewer');
 if(packets.length!==1||queued.length!==1||grants.length!==1)return fail();
 const packet=packets[0],queue=queued[0],grant=grants[0];
 if(queue.data.mode!==undefined&&queue.data.mode!=='live'||grant.data.mode!=='live'||typeof queue.data.dispatchId!=='string'||!queue.data.dispatchId||
  queue.data.dispatchId!==grant.data.dispatchId||typeof grant.data.dispatchId!=='string'||!grant.data.dispatchId||typeof grant.data.generation!=='string'||!grant.data.generation||
  queue.data.generation!==grant.data.generation||rows.indexOf(packet)>=rows.indexOf(queue)||rows.indexOf(queue)>=rows.indexOf(grant))return fail();
 const savedPacket=object(packet.data.packet);if(packet.data.sha256!==hash(savedPacket)||savedPacket.schema!=='dream-maker.review-packet.v1'||savedPacket.runId!==run.id||savedPacket.specHash!==run.specHash||
  !Array.isArray(savedPacket.sourceHistory)||object(savedPacket.sourceHistory.at(-1)).treeHash!==run.treeHash)return fail();
 const finishes=rows.filter(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===grant.data.dispatchId),
  intents=rows.filter(r=>r.kind==='OwnedProcessIntent'&&r.data.dispatchId===grant.data.dispatchId);
 if(finishes.length!==1||finishes[0].data.outcome!=='DISPATCH_FAILED'||finishes[0].data.cleanupReturned!==true||finishes[0].data.generation!==grant.data.generation||
  rows.indexOf(finishes[0])<=rows.indexOf(grant)||intents.length!==1||intents[0].data.platform!=='win32'||intents[0].data.generation!==grant.data.generation||
  typeof intents[0].data.processId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(intents[0].data.processId)||rows.indexOf(intents[0])<=rows.indexOf(grant)||
  rows.filter(r=>r.kind==='OwnedProcessIntent'&&r.data.processId===intents[0].data.processId).length!==1)return fail();
 const cleanup=rows.filter(r=>r.kind==='OwnedProcessCleanup'&&r.data.processId===intents[0].data.processId);
 if(cleanup.length!==1||cleanup[0].data.cleanupReturned!==true||cleanup[0].data.dispatchId!==grant.data.dispatchId||cleanup[0].data.generation!==grant.data.generation||
  rows.indexOf(cleanup[0])<=rows.indexOf(intents[0])||rows.indexOf(cleanup[0])>=rows.indexOf(finishes[0]))return fail();
 const interval=rows.slice(rows.indexOf(grant)+1,rows.indexOf(finishes[0]));
 const receipts=interval.filter(r=>r.kind==='NativeBudgetReceipt');
 if(receipts.length!==1)return fail();
 const receipt=receipts[0],params=object(receipt.data.params??{}),requests=params.requests;
 if(receipt.data.method!=='dm/budget'||!Array.isArray(requests)||requests.length!==1)return fail();
 const request=object(requests[0]);
 let upstream:URL;try{upstream=new URL(String(request.upstream));}catch{return fail();}
 if(!['127.0.0.1','::1','[::1]'].includes(upstream.hostname)||request.requestedModel!==reviewerModel||request.responseModelMatched!==false||
  request.responseId!==null||request.observedModel!==null||request.finishReason!==null||request.responseSha256!==null||request.outputTextHash!==null||
  request.completionObserved!==false||request.minimalResponseVerified!==false||request.protocolEventCount!==0||request.protocolLastEventType!==null||request.protocolLastEventDetail!==null||
  request.protocolFailureStage!=='PARSE'||request.toolArgumentFailureDetail!==null||request.upstreamHttpStatus!==200||request.upstreamContentType!=='application/json'||
  request.transportErrorCode!==null||request.networkFailureClass!==null||request.automaticRetryAllowed!==false||request.outcome!=='MODEL_GATEWAY_UPSTREAM_JSON_INVALID'||
  request.usage!==null||!Number.isSafeInteger(request.reservedMicros)||Number(request.reservedMicros)<=0)return fail();
 if(rows.slice(rows.indexOf(grant)+1,rows.indexOf(finishes[0])).some(r=>['ToolIntent','ToolResult','AgentSession','Review'].includes(r.kind)))return fail();
 const retryPacket=structuredClone(savedPacket),modelReceipts=object(retryPacket.executionEvidence??{}).modelReceipts;
 if(!Array.isArray(modelReceipts))return fail();
 object(retryPacket.executionEvidence).modelReceipts=[...modelReceipts,{recordId:receipt.id,kind:receipt.kind,at:receipt.at,data:receipt.data}];
 if(hash(retryPacket)!==hash(currentPacket))return fail();
 const basis={recoveryKind:'CUSTOM_PARSE_FAILURE_ONE_SHOT' as const,dispatchId:grant.data.dispatchId,generation:grant.data.generation,packetRecordId:packet.id,
  packetHash:packet.data.sha256,savedPacketHash:packet.data.sha256,retryPacketHash:hash(retryPacket),receiptRecordId:receipt.id,receiptOutcome:request.outcome,
  sourceHash:run.treeHash,priorModelOutcome:'NOT_OBSERVED' as const,priorUsage:'UNKNOWN_PRESERVED' as const,targetEncoding:'PACKET_OBJECT_V1' as const,version:run.version};
 return {...basis,basisHash:hash({basis,rows,retryPacket})};
}

/** Explicit, one-shot migration of a failed, tool-free legacy review. A previous
 * model request/charge may have occurred: this is never a no-dispatch proof. */
export function readOnlyReviewRetryBasis(store:Store,run:Run,config:Config,root:string,currentPacket?:unknown){
 if(run.flowName==='custom')return customParseFailureRetryBasis(store,run,currentPacket);
 const fail=():never=>{throw new DomainError('REVIEW_TRANSPORT_RETRY_NOT_ALLOWED',409);};
 if(run.mode!=='live'||run.flowName!=='classic'||run.rolePolicy!==TARGET_ROLE_POLICY||run.state!=='BLOCKED'||run.phase!=='REVIEWING'||run.reason!=='RUNNER_RPC_ERROR'||run.review!==null||
  !run.treeHash||!run.verification?.ok||run.verification.treeHash!==run.treeHash||!run.tasks.length||run.tasks.some(t=>t.status!=='implemented')||
  run.maxCalls-run.calls!==1||run.repairCount!==run.maxRepairs||Date.now()>=runDeadline(store,run)||!reviewOnlyWindowEvidence(store,run)||
  config.codex.transport!=='stdio'||config.codex.permissionProfile!=='dream-maker-supervisor-data')return fail();
 let policyHash:string;try{policyHash=hash(readFileSync(config.codex.policyFile!));if(policyHash!==hash(readFileSync(resolve(root,'config/codex-supervisor-windows.toml'))))return fail();}catch{return fail();}
 const parse=(text:unknown)=>{try{return object(JSON.parse(String(text)));}catch{return fail();}};
 const rows=store.db.prepare('SELECT id,kind,at,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097').all(run.projectId,run.id)
  .map(r=>({id:String(r.id),kind:String(r.kind),at:String(r.at),data:parse(r.data)}));
 if(rows.length>4096||rows.some(r=>r.kind==='ReviewTransportRetryPreparation'))return fail();
 const grants=rows.filter(r=>r.kind==='DispatchGranted'),grant=grants.at(-1),packet=rows.filter(r=>r.kind==='ReviewPacket').at(-1);
 if(!grant||!packet||grant.data.kind!=='reviewer'||grant.data.mode!=='live'||typeof grant.data.dispatchId!=='string'||!grant.data.dispatchId||
  typeof grant.data.generation!=='string'||!grant.data.generation||rows.indexOf(packet)>=rows.indexOf(grant)||hash(packet.data.packet)!==packet.data.sha256)return fail();
 const p=object(packet.data.packet),history=p.sourceHistory;if(p.schema!=='dream-maker.review-packet.v1'||p.runId!==run.id||p.specHash!==run.specHash||!Array.isArray(history)||object(history.at(-1)).treeHash!==run.treeHash)return fail();
 const finishes=rows.filter(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===grant.data.dispatchId),intents=rows.filter(r=>r.kind==='OwnedProcessIntent'&&r.data.dispatchId===grant.data.dispatchId);
 if(finishes.length!==1||finishes[0].data.outcome!=='RUNNER_RPC_ERROR'||finishes[0].data.cleanupReturned!==true||finishes[0].data.generation!==grant.data.generation||rows.indexOf(finishes[0])<=rows.indexOf(grant)||
  intents.length!==1||intents[0].data.platform!=='win32'||intents[0].data.generation!==grant.data.generation||rows.indexOf(intents[0])<=rows.indexOf(grant)||
  typeof intents[0].data.processId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(intents[0].data.processId)||rows.filter(r=>r.kind==='OwnedProcessIntent'&&r.data.processId===intents[0].data.processId).length!==1)return fail();
 const cleanup=rows.filter(r=>r.kind==='OwnedProcessCleanup'&&r.data.processId===intents[0].data.processId);
 if(cleanup.length!==1||cleanup[0].data.cleanupReturned!==true||cleanup[0].data.dispatchId!==grant.data.dispatchId||cleanup[0].data.generation!==grant.data.generation||
  rows.indexOf(cleanup[0])<=rows.indexOf(intents[0])||rows.indexOf(cleanup[0])>=rows.indexOf(finishes[0])||
  rows.slice(rows.indexOf(grant)+1).some(r=>['ToolIntent','ToolResult','AgentSession','Review'].includes(r.kind)))return fail();
 const grantAt=Date.parse(grant.at),finishAt=Date.parse(finishes[0].at);
 if(!Number.isFinite(grantAt)||!Number.isFinite(finishAt)||finishAt<grantAt||grant.at!==new Date(grantAt).toISOString()||finishes[0].at!==new Date(finishAt).toISOString()||
  grants.some(g=>g!==grant&&(!Number.isFinite(Date.parse(g.at))||Date.parse(g.at)>=grantAt||g.data.dispatchId===grant.data.dispatchId)))return fail();
 // Read the whole dispatch interval, including anything before a later marker.
 // Equal/ambiguous grant timestamps fail closed instead of truncating history.
 const allEvents=store.db.prepare("SELECT id,type,at,payload FROM events WHERE project_id=? AND run_id=? AND type IN ('role.dispatch','agent.event') AND at>=? ORDER BY id LIMIT 1002").all(run.projectId,run.id,grant.at)
  .map(e=>({id:Number(e.id),type:String(e.type),at:String(e.at),data:parse(e.payload)}));
 const markers=allEvents.filter(e=>e.type==='role.dispatch'),marker=markers[0];
 if(allEvents.length>1001||markers.length!==1||marker.data.phase!=='REVIEWING'||marker.data.state!=='REVIEWING'||!Number.isFinite(Date.parse(marker.at))||marker.at!==new Date(Date.parse(marker.at)).toISOString()||Date.parse(marker.at)<grantAt||Date.parse(marker.at)>finishAt)return fail();
 const events=allEvents.filter(e=>e.type==='agent.event');
 const admissions=events.filter(e=>e.data.method==='dm/codexAdmission');
 if(events.length>1000||admissions.length!==1||events.some(e=>!['dm/codexPreparation','dm/codexAdmission'].includes(String(e.data.method))||object(e.data.params??{}).role!=='reviewer'))return fail();
 const a=object(admissions[0].data.params);
 if(admissions[0].id<=marker.id||!Number.isFinite(Date.parse(admissions[0].at))||admissions[0].at!==new Date(Date.parse(admissions[0].at)).toISOString()||Date.parse(admissions[0].at)<Date.parse(marker.at)||Date.parse(admissions[0].at)>finishAt)return fail();
 if(a.reviewPacketHash!==packet.data.sha256||a.provider!=='openai'||a.authentication!=='CHATGPT_SUBSCRIPTION'||a.includedUsageAllowed!==true||a.paidFallback!==false||
  a.permissionProfile!=='dream-maker-supervisor-data'||a.policyHash!==policyHash||a.materialEncoding!==undefined||a.inputHash!==undefined||a.inputBytes!==undefined||
  typeof a.threadId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(a.threadId)||a.threadId===run.sessions.planner2||a.model!==config.codex.model)return fail();
 return {dispatchId:grant.data.dispatchId,generation:grant.data.generation,packetRecordId:packet.id,packetHash:packet.data.sha256,sourceHash:run.treeHash,
  threadId:a.threadId,policyHash,basisHash:hash({rows,events,marker,policyHash}),version:run.version,
  priorModelOutcome:'UNKNOWN' as const,priorUsage:'UNKNOWN_PRESERVED' as const,targetEncoding:'PACKET_OBJECT_V1' as const};
}
