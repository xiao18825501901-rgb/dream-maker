import {installPrework,savePreworkResult} from '../../dist/server/prework/runtime.js';
// OFFLINE explicit receipt/role/OS-free Store fixture. Never Native qualification or product evidence.
import {mkdirSync,writeFileSync,cpSync} from 'node:fs';import {join,dirname} from 'node:path';
import {harness,ready} from '../helpers.mjs';import {captureSource,buildReviewPacket} from '../../dist/server/review-packet.js';import {hash} from '../../dist/server/security.js';import {treeHash} from '../../dist/server/workspace.js';
export async function reviewWindowFixture(t,options={}){
 const h=harness(t);options.configure?.(h);let p,s;
 if(options.unapproved){const made=h.interviews.create('未批准的离线方案','仅控制端反例，不调用模型','demo');await h.interviews.finish(made.id,'',false);p=h.store.project(made.id);s=h.store.spec(p.specId);}
 else({p,s}=await ready(h));
 if(!options.unapproved)h.store.approve(p.id,s.hash,'BUILD','OFFLINE_EXPLICIT_APPROVAL');
 h.engine.launch=()=>{};const made=h.engine.create(p.id,s.hash,true),stored=h.store.run(made.id);const workspace=stored.workspace;
 const identities={planner2:{runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:'OFFLINE_CODEX',sessionId:'OFFLINE_P2',requestId:'OFFLINE_P2_REQUEST'},executor:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:'OFFLINE_DSH',sessionId:'OFFLINE_EXECUTOR',requestId:'OFFLINE_EXECUTOR_REQUEST'}};
 const r={...stored,id:stored.id,mode:'live',flowName:'classic',projectId:p.id,specHash:s.hash,specId:s.id,planVersionId:s.id,planVersionHash:h.store.planVersion(s.id).contentHash,createdAt:new Date().toISOString(),workspace,plan:{tasks:[]},findings:[],roleIdentities:identities,sessions:{planner2:'OFFLINE_P2',executor:'OFFLINE_EXECUTOR'}};
 const snapshot=stage=>{const snap=captureSource(workspace,{runId:r.id,specHash:s.hash},stage);h.store.record('SourceSnapshot',p.id,r.id,snap);r.treeHash=snap.treeHash;};
 if(options.preworkPrerequisite){r.phase=r.state='IMPLEMENTING';r.tasks=[{id:'OFFLINE_TASK',title:'OFFLINE repair source',dependsOn:[],requirementIds:s.requirements.map(v=>v.id),acceptance:['OFFLINE source'],writePaths:['main.mjs'],status:'pending'}];r.plan={tasks:r.tasks.map(({status,...task})=>task)};}
 let preworkTurn;
 snapshot('BASELINE');if(options.preworkPrerequisite){h.store.saveRun(r);installPrework(h.store,r.id);Object.assign(r,h.store.run(r.id));
  preworkTurn={dispatchId:'OFFLINE_PREWORK_EXECUTOR_DISPATCH',generation:'OFFLINE_PREWORK_GENERATION',beforeHash:r.treeHash};
  h.store.record('DispatchGranted',p.id,r.id,{...preworkTurn,kind:'executor',mode:'live'});
  preworkTurn.intentId=h.store.record('ToolIntent',p.id,r.id,{tool:'desk_write',specHash:s.hash,sourceHash:r.treeHash,requestHash:hash('OFFLINE_PREWORK_WRITE')});
 }writeFileSync(join(workspace,'main.mjs'),'// OFFLINE source, not executed\n');
 for(const path of options.emptyDirectories??[])mkdirSync(join(workspace,path),{recursive:true});
 for(const [path,content] of Object.entries(options.sourceFiles??{})){mkdirSync(dirname(join(workspace,path)),{recursive:true});writeFileSync(join(workspace,path),content);}
 snapshot('EXECUTOR_AFTER');snapshot('VERIFIER_INPUT');
 const definition={id:'C1',requirementIds:s.requirements.map(v=>v.id),runtime:'node',entry:'main.mjs',args:[],stdin:options.stdin??'原始输入\n',expectedExitCode:0,expectedStdout:'OK\n',expectedStderr:'',...(options.fixtures?{fixtures:options.fixtures}:{})};
 const planText=JSON.stringify({schema:'dream-maker.cli-verifier.v1',specHash:s.hash,cases:[definition]},null,2)+'\n',planHash=hash(planText);
 const raw={schema:'dream-maker.trusted-cli-evidence.v1',specHash:s.hash,sourceHash:r.treeHash,planHash,planText,ok:true,cases:[{id:'C1',requirementIds:definition.requirementIds,ok:true,expectedExitCode:0,actualExitCode:0,outputMatched:true,diagnosticMatched:true,stdinHash:hash(definition.stdin),sourceHash:r.treeHash,workerHash:'b'.repeat(64),jobId:'OFFLINE_JOB',status:'EXECUTED',command:['/usr/bin/node','/workspace/main.mjs'],stdout:'OK\n',stderr:'',stderrTail:'',fixtureCount:0}]};
 if(options.fixtures){const copy=join(h.dir,'fixture-source');cpSync(workspace,copy,{recursive:true});for(const [path,content] of Object.entries(options.fixtures)){mkdirSync(dirname(join(copy,path)),{recursive:true});writeFileSync(join(copy,path),content);}raw.cases[0].sourceHash=treeHash(copy);raw.cases[0].fixtureCount=Object.keys(options.fixtures).length;}
 const evidence={stepId:'OFFLINE_STEP',attempt:1,specHash:s.hash,treeHash:r.treeHash,command:['dream-maker-controller-cli-oracle',s.hash,planHash],stdout:JSON.stringify(raw),stderr:'',code:0,at:new Date().toISOString(),scope:'LIVE_VERIFIER'};
 const evidenceId=h.store.record('Evidence',p.id,r.id,evidence);r.verification={ok:true,evidenceId,treeHash:r.treeHash};
 const approvalId=h.store.record('VerifierApproval',p.id,null,{specHash:s.hash,planHash,source:'EXPLICIT_LOCAL_SESSION_ACTION'});
 const sessionIds=[];const publishSessions=()=>{for(const [role,identity] of Object.entries(identities))sessionIds.push(h.store.record('AgentSession',p.id,r.id,{role,...identity,...(preworkTurn&&role==='executor'?{taskId:'OFFLINE_TASK',dispatchId:preworkTurn.dispatchId,generation:preworkTurn.generation}:{}),modelEvidence:'ADAPTER_VERIFIED_RESPONSE'}));};if(!preworkTurn)publishSessions();
 const intentId=preworkTurn?.intentId??h.store.record('ToolIntent',p.id,r.id,{tool:'desk_write',specHash:s.hash,sourceHash:hash([]),sliceId:'OFFLINE_SLICE',requestHash:hash('OFFLINE_WRITE')});
 h.store.record('ToolResult',p.id,r.id,{intentId,tool:'desk_write',specHash:s.hash,sourceHash:r.treeHash,...(preworkTurn?{}:{sliceId:'OFFLINE_SLICE'}),status:'COMPLETE',responseHash:hash('OFFLINE_RESULT')});
 const receiptId=h.store.record('NativeBudgetReceipt',p.id,r.id,{method:'dm/budget',params:{requests:[{id:'OFFLINE_REQUEST',observedModel:'OFFLINE_DSH',outcome:'COMPLETE',completionObserved:true,responseModelMatched:true,usage:null}]}});
 if(preworkTurn){h.store.record('DispatchFinished',p.id,r.id,{dispatchId:preworkTurn.dispatchId,generation:preworkTurn.generation,outcome:'COMPLETED',cleanupReturned:true});publishSessions();
  const usage={role:'executor',requestId:identities.executor.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'OFFLINE_TEST_ONLY'};r.usage=[usage];h.store.record('UsageLedger',p.id,r.id,usage);
 }
 const admissionId=h.store.event(p.id,r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'planner2',threadId:'OFFLINE_P2',model:'OFFLINE_CODEX',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',includedUsageAllowed:true,paidFallback:false,permissionProfile:'OFFLINE_READ_ONLY',policyHash:'d'.repeat(64)}});
 h.store.event(p.id,r.id,'agent.event',{method:'dm/codexCompletion',params:{role:'planner2',threadId:'OFFLINE_P2',turnId:'OFFLINE_P2_REQUEST',model:'OFFLINE_CODEX',provider:'openai',status:'completed',specHash:s.hash,runId:r.id}});
 Object.assign(r,{state:'BLOCKED',phase:'REVIEWING',reason:'REVIEW_PACKET_LIMIT',review:null,calls:4,maxCalls:13,repairCount:1,maxRepairs:2,maxSeconds:1,attempt:7,tasks:options.preworkPrerequisite?r.tasks.map(task=>({...task,status:'implemented'})):[{id:'OFFLINE_TASK',status:'implemented'}]});h.store.saveRun(r);
if(preworkTurn)savePreworkResult(h.store,h.store.run(r.id),{taskId:'OFFLINE_TASK',dispatchId:preworkTurn.dispatchId,generation:preworkTurn.generation,sessionId:identities.executor.sessionId,requestId:identities.executor.requestId,beforeHash:preworkTurn.beforeHash,afterHash:r.treeHash,changedPaths:['main.mjs']});
h.store.record('Step',p.id,r.id,{phase:'REVIEWING',attempt:r.attempt,specHash:r.specHash,treeHash:r.treeHash});h.store.event(p.id,r.id,'run.blocked',{state:'BLOCKED',phase:'REVIEWING',reason:'REVIEW_PACKET_LIMIT'});
t.mock.timers.enable({apis:['Date'],now:Date.now()+5000});
return {h,p,s,r,actor:'local-session:'+'a'.repeat(64),request:{sourceHash:r.treeHash,expectedVersion:r.version,seconds:3600,confirmed:true}};
}
