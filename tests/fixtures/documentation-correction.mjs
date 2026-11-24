// Explicit OFFLINE fixture only; never formal qualification, authorization or model evidence.
import assert from 'node:assert/strict';
import {reviewWindowFixture} from './review-window.mjs';
import {buildReviewPacket} from '../../dist/server/review-packet.js';
import {hash} from '../../dist/server/security.js';
export async function documentationCorrectionFixture(t,options={}){
 const x=await reviewWindowFixture(t,{sourceFiles:{'README.md':'# OFFLINE documentation\nExample needs correction.\n',...options.sourceFiles},configure:h=>{h.config.codex.model='OFFLINE_CODEX';}}),s=x.h.store,r=s.run(x.r.id),p=s.project(r.projectId);p.mode='live';s.saveProject(p);
 const task={id:'OFFLINE_DOC',title:'Offline documentation',dependsOn:options.includeMainTask?['OFFLINE_MAIN']:[],requirementIds:x.s.requirements.map(v=>v.id),acceptance:['offline consistent example'],writePaths:['README.md']},tasks=options.includeMainTask?[{id:'OFFLINE_MAIN',title:'Offline inherited implementation',dependsOn:[],requirementIds:options.legacyMainScope?[]:x.s.requirements.map(v=>v.id),acceptance:['offline source'],...(options.legacyMainScope?{}:{writePaths:['main.mjs']})},task]:[task];r.plan={tasks};r.tasks=tasks.map(t=>({...t,status:'implemented'}));r.calls=r.maxCalls;r.repairCount=r.maxRepairs;r.phase='REVIEWING';r.state='BLOCKED';r.reason='REVIEW_SUPPLEMENT_CHANGES_REQUESTED';
 const record=(kind,data)=>s.record(kind,p.id,r.id,{fixtureProvenance:'OFFLINE_ONLY',...data});record('UsageLedger',{role:'planner2',requestId:r.roleIdentities.planner2.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'});record('Plan',{plan:r.plan,specHash:r.specHash});
 const packet=buildReviewPacket(s,r,x.s),packetHash=hash(packet),packetId=record('ReviewPacket',{packet,sha256:packetHash}),dispatchId='OFFLINE_DOC_REVIEW',generation='OFFLINE_DOC_REVIEW_GENERATION',processId='OFFLINE_DOC_REVIEW_PROCESS';
 record('DispatchGranted',{dispatchId,generation,kind:'reviewer',mode:'live'});record('OwnedProcessIntent',{dispatchId,generation,processId,platform:'win32'});record('OwnedProcessCleanup',{dispatchId,generation,processId,cleanupReturned:true});
 if(options.secondProcess){record('OwnedProcessIntent',{dispatchId,generation,processId:processId+'_SECOND',platform:'win32'});record('OwnedProcessCleanup',{dispatchId,generation,processId:processId+'_SECOND',cleanupReturned:true});}
 record('DispatchFinished',{dispatchId,generation,outcome:'COMPLETED',cleanupReturned:true});
 const identity={runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:'OFFLINE_CODEX',sessionId:'OFFLINE_DOC_REVIEWER',requestId:'OFFLINE_DOC_REVIEW_TURN'};
 const sessionId=record('AgentSession',{role:'reviewer',...identity,modelEvidence:'ADAPTER_VERIFIED_RESPONSE',dispatchId,generation});
 record('UsageLedger',{role:'reviewer',requestId:identity.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'});
 const completionId=s.event(p.id,r.id,'agent.event',{dispatchId,generation,method:'dm/codexCompletion',params:{role:'reviewer',threadId:identity.sessionId,turnId:identity.requestId,status:'completed',model:identity.model,provider:identity.provider,runId:r.id,specHash:r.specHash}});
 r.review={verdict:'CHANGES_REQUESTED',source:'CODEX',treeHash:r.treeHash,findings:[{id:'OFFLINE_F1',severity:'low',status:'open',description:'offline documentation example differs',evidence:'README.md'}]};r.findings=r.review.findings;r.roleIdentities.reviewer=identity;r.sessions.reviewer=identity.sessionId;
 r.reason='REPAIR_LIMIT';const reviewId=record('Review',{...r.review,packetId,packetHash});s.saveRun(r);s.release(p.id,r.id);
 const persisted=JSON.parse(s.db.prepare('SELECT data FROM records WHERE id=?').get(packetId).data);assert.equal(hash(persisted.packet),persisted.sha256,'OFFLINE_PACKET_MUST_SURVIVE_STORE_SERIALIZATION');
 assert.equal(JSON.parse(s.db.prepare('SELECT data FROM records WHERE id=?').get(reviewId).data).packetHash,persisted.sha256,'OFFLINE_REVIEW_MUST_USE_FROZEN_PACKET_HASH');
 assert.equal(x.h.engine.documentationCorrectionCandidate(r.id,'README.md').executionGranted,false,'every negative fixture starts from an eligible read-only candidate');
 return {...x,r:s.run(r.id),packetId,reviewId,sessionId,dispatchId,completionId,record};
}
