// OFFLINE original Store fixture. No Native qualification, Magpie process or model call.
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {bindOfflineApi,harness,ready} from '../helpers.mjs';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {hash} from '../../dist/server/security.js';
import {treeHash as workspaceTreeHash} from '../../dist/server/workspace.js';

const actor='local-session:'+'a'.repeat(64);

function configuration({diversified=true}={}){
 const openai={provider:'openai',authentication:'oauth',authRef:'OFFLINE_OPENAI_OAUTH',accountRef:'offline-openai-account'};
 const deepseek={provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_DEEPSEEK_KEY',accountRef:'offline-deepseek-account'};
 const role=(id,runtime,account,model,write=false)=>({
  id,provider:account.provider,authentication:account.authentication,authRef:account.authRef,accountRef:account.accountRef,
  runtime,model:{kind:'model',id:model},transport:'magpie',nativeException:false,
  permissions:write?['source_read','source_write']:['source_read'],
  budget:{currency:'CNY',maxMicros:1000000},
 });
 return{
  mode:'custom',laya:false,accounts:[openai,deepseek],
  roles:{
   planner2:role('planner2','codex',openai,'gpt-6-luna'),
   executors:[role('executor-one','dsh',deepseek,'deepseek-flash',true)],
   reviewer:role('reviewer','independent',deepseek,diversified?'deepseek-v4-pro':'deepseek-flash'),
  },
  groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},
  budget:{currency:'CNY',maxMicros:10000000},timeZone:'Asia/Shanghai',
 };
}

function failureReceipt({overrides={}}={}){
 return{
  method:'dm/budget',
  params:{requests:[{
   id:'OFFLINE_PARSE_FAILURE',
   upstream:'http://127.0.0.1:61359/v1/chat/completions',
   requestedModel:'deepseek-v4-pro',
   responseModelMatched:false,
   responseId:null,
   observedModel:null,
   finishReason:null,
   responseSha256:null,
   outputTextHash:null,
   completionObserved:false,
   minimalResponseVerified:false,
   protocolEventCount:0,
   protocolLastEventType:null,
   protocolLastEventDetail:null,
   protocolFailureStage:'PARSE',
   toolArgumentFailureDetail:null,
   upstreamHttpStatus:200,
   upstreamContentType:'application/json',
   upstreamBodyShape:null,
   upstreamBodyBytes:null,
   upstreamBodySha256:null,
   upstreamBodyCode:null,
   upstreamRequestIdSha256:null,
   transportErrorCode:null,
   elapsedMs:61000,
   elapsedMsCapped:false,
   networkFailureClass:null,
   automaticRetryAllowed:false,
   outcome:'MODEL_GATEWAY_UPSTREAM_JSON_INVALID',
   usage:null,
   reservedMicros:9658368,
   recordedAt:'2026-11-19T02:48:55.673Z',
   ...overrides,
  }]},
 };
}

function projected(saved,row){
 const current=structuredClone(saved);
 current.executionEvidence.modelReceipts=[
  ...current.executionEvidence.modelReceipts,
  {recordId:row.id,kind:row.kind,at:row.at,data:row.data},
 ];
 return current;
}

export async function customReviewTransportRetryFixture(t,{
 diversified=true,receiptOverrides={},
}={}){
 const h=harness(t);bindOfflineApi(h.config);
 const {p,s}=await ready(h,'live');
 const profile=new FlowProfiles(h.store).confirm(p.id,{
  configuration:configuration({diversified}),expectedRevision:0,confirmed:true,
 },actor,'OFFLINE_CUSTOM_PARSE_PROFILE');
 const prepared=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);
 const runId=prepared.flowConfig.runId,workspace=resolve(h.dir,'workspaces',runId),at='2026-11-19T02:28:58.644Z',createdAt=new Date().toISOString();
 mkdirSync(workspace,{recursive:true});
 const treeHash=workspaceTreeHash(workspace);
 const plannerSession='OFFLINE_CUSTOM_PLANNER2',executorSession='OFFLINE_CUSTOM_EXECUTOR';
 const run={
  id:runId,projectId:p.id,mode:'live',version:28,specId:s.id,specHash:s.hash,
  planVersionId:s.id,planVersionHash:h.store.planVersion(s.id).contentHash,
  rolePolicy:'CUSTOM_FROZEN_V1',flowName:'custom',flowConfig:prepared.flowConfig,
  flowConfigHash:prepared.flowConfigHash,configFingerprint:prepared.flowConfig.configurationFingerprint,
  state:'BLOCKED',phase:'REVIEWING',repairCount:0,maxRepairs:2,calls:5,maxCalls:13,
  createdAt,updatedAt:at,workspace,treeHash,
  tasks:[{id:'T001',title:'OFFLINE',dependsOn:[],requirementIds:s.requirements.map(r=>r.id),acceptance:['OFFLINE'],writePaths:['main.mjs'],status:'implemented'}],
  findings:[],plan:{tasks:[{id:'T001',title:'OFFLINE',dependsOn:[],requirementIds:s.requirements.map(r=>r.id),acceptance:['OFFLINE'],writePaths:['main.mjs']}]},
  verification:{ok:true,exitCode:0,stdout:'OFFLINE',stderr:'',command:['offline'],treeHash,at,evidenceId:'OFFLINE_EVIDENCE'},
  review:null,artifacts:[],reason:'UPSTREAM_HTTP_502',failedFingerprints:[],attempt:1,demoFault:false,
  maxSeconds:10800,usage:[],
  roleIdentities:{
   planner2:{runner:'CODEX_CLI',runtime:'codex',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:'gpt-6-luna',roleId:'planner2',authRef:'OFFLINE_OPENAI_OAUTH',accountRef:'offline-openai-account',configurationHash:prepared.flowConfigHash,routeHash:'b'.repeat(64),sessionId:plannerSession,requestId:'OFFLINE_PLANNER_REQUEST'},
   executor:{runner:'DSH',runtime:'dsh',provider:'deepseek-official',authentication:'API_KEY',model:'deepseek-flash',roleId:'executor-one',authRef:'OFFLINE_DEEPSEEK_KEY',accountRef:'offline-deepseek-account',configurationHash:prepared.flowConfigHash,routeHash:'c'.repeat(64),sessionId:executorSession,requestId:'OFFLINE_EXECUTOR_REQUEST'},
  },
  sessions:{planner2:plannerSession,executor:executorSession},
 };
 h.store.insertRun(run);
 h.store.acquire(p.id,runId);
 const project=h.store.project(p.id);
 project.mode='live';
 project.activeRunId=runId;
 h.store.saveProject(project);

 const packet={
  schema:'dream-maker.review-packet.v1',runId,specHash:s.hash,
  sourceHistory:[{stage:'VERIFIER_INPUT',treeHash,files:[]}],
  executionEvidence:{
   roleIdentities:run.roleIdentities,
   sessions:[],
   toolJournal:[],
   modelReceipts:[],
   usage:[],
   merges:[],
   codexEvents:[],
  },
  prework:{contract:{contractId:'OFFLINE_CONTRACT'},results:[],requiredCoverage:[],closeoutPolicy:'OFFLINE'},
 };
 const packetHash=hash(packet),packetRecordId=h.store.record('ReviewPacket',p.id,runId,{packet,sha256:packetHash});
 const dispatchId='dispatch_offline_custom_parse',generation='dispatch_owner_offline_custom_parse',processId='owned_process_offline_custom_parse';
 h.store.record('DispatchQueued',p.id,runId,{dispatchId,kind:'reviewer',mode:'live',generation});
 h.store.record('DispatchGranted',p.id,runId,{dispatchId,kind:'reviewer',mode:'live',generation,cleanupReturned:false});
 h.store.event(p.id,runId,'role.dispatch',{state:'REVIEWING',phase:'REVIEWING'});
 h.store.record('OwnedProcessIntent',p.id,runId,{dispatchId,generation,processId,platform:'win32'});
 const receiptData=failureReceipt({overrides:receiptOverrides});
 const receiptRecordId=h.store.record('NativeBudgetReceipt',p.id,runId,receiptData),receiptAt=String(h.store.db.prepare('SELECT at FROM records WHERE id=?').get(receiptRecordId).at);
 h.store.record('OwnedProcessCleanup',p.id,runId,{dispatchId,generation,processId,kind:'TRUSTED_WINDOWS_JOB',cleanupReturned:true});
 h.store.record('DispatchFinished',p.id,runId,{dispatchId,generation,outcome:'DISPATCH_FAILED',cleanupReturned:true});
 h.store.event(p.id,runId,'run.blocked',{state:'BLOCKED',phase:'REVIEWING',reason:'UPSTREAM_HTTP_502'});

 const receiptRow={id:receiptRecordId,kind:'NativeBudgetReceipt',at:receiptAt,data:receiptData};
 return{
  h,p,s,runId,packetRecordId,packetHash,receiptRecordId,dispatchId,generation,processId,
  savedPacket:packet,currentPacket:projected(packet,receiptRow),
 };
}

export function updateReceipt(x,path,value){
 const row=x.h.store.db.prepare('SELECT data FROM records WHERE id=?').get(x.receiptRecordId);
 const data=JSON.parse(String(row.data));
 let cursor=data;
 const parts=path.split('.');
 for(let i=0;i<parts.length-1;i++)cursor=cursor[parts[i]];
 cursor[parts.at(-1)]=value;
 x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),x.receiptRecordId);
}
