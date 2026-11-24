// Offline regression. Model adapters, credential custody and native qualification are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {WslVerifier} from '../../dist/server/wsl-verifier.js';
import {hash} from '../../dist/server/security.js';
import {assertCustomRoleDiversity} from '../../dist/server/flow/custom-role-identity.js';
import {createExecutorTools} from '../../dist/server/executor-tools.js';
import {treeHash} from '../../dist/server/workspace.js';
import {root} from '../helpers.mjs';
import {fixtureProjectPlan} from '../fixtures/full-project-plan.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {offlinePreworkReview} from '../fixtures/offline-prework-review.mjs';

const source='console.log("OFFLINE_OK");\n';
const account={provider:'deepseek-official',authentication:'api_key',accountRef:'OFFLINE_ACCOUNT',authRef:'OFFLINE_AUTH'};
function member(id,runtime,model,write=false){
 return {...account,id,runtime,model:{kind:'model',id:model},transport:'magpie',nativeException:false,
  permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}};
}

test('DreamFlow Custom build drives NativeOwner, Planner2, Prework, Executor, verifier and Reviewer to delivery offline',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
 const dir=mkdtempSync(join(parent,'dreamflow-custom-loop-'));
 const plannerAccount={provider:'openai',authentication:'oauth',accountRef:'OFFLINE_PLANNER',authRef:'OFFLINE_OAUTH'};
 const roles={planner2:{...member('planner2','codex','gpt-6-luna'),...plannerAccount,transport:'native',nativeException:true},executors:[member('worker-one','pi','deepseek-flash',true)],reviewer:member('reviewer','cline','deepseek-v4-pro')};
 const configuration={mode:'custom',laya:false,accounts:[account,plannerAccount],roles,groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:3000000},timeZone:'Asia/Shanghai'};
 const sequence=[];let spec,getConfig,paidCalls=0,localCases=0;
 const sdkDist='F:/DreamMakerSuite/runtime/archon-controller-dm-8896a7db4062/dist';
 const modulePath=join(sdkDist,'provider/file-tools.js');
 const files={modulePath,dependencies:[modulePath,join(sdkDist,'core/io.js')].map(path=>({path,sha256:hash(readFileSync(path))})),readPaths:['main.mjs'],writePaths:['main.mjs']};
 function offlineRole(input,actor,assertCurrent,configurationHash){return {run:async(_args,emit)=>{
  assertCurrent();const run=app.store.run(input.runId);sequence.push(input.role);
  let text;
  if(input.role==='planner2'){
   assert.equal(run.prework,undefined);
   const params={role:input.role,threadId:'OFFLINE_SESSION_planner2',provider:actor.provider,model:actor.model.id,runId:run.id,specHash:spec.hash};
   emit({method:'dm/codexAdmission',params:{...params,authentication:'CHATGPT_SUBSCRIPTION',permissionProfile:'OFFLINE_FIXTURE',policyHash:hash('OFFLINE_POLICY'),includedUsageAllowed:true,paidFallback:false}});
   emit({method:'dm/codexCompletion',params:{...params,turnId:'OFFLINE_REQUEST_planner2',status:'completed'}});
   text=JSON.stringify({tasks:spec.projectPlan.tasks.map(task=>({...task,acceptance:[task.check],writePaths:['main.mjs']}))});
  }else if(input.role==='executor'){
   assert.ok(run.prework?.recordId);assert.notEqual(input.workspace,run.workspace);
   const tools=await createExecutorTools(app.store,getConfig,run.id,files,{run(){throw Error('unexpected executor sandbox call');}},input.executorSliceId);
   await tools.dispatch('executor','desk_write',{path:'main.mjs',content:source,expected_sha:''},input.signal);
   const receipt={method:'dm/budget',params:{scope:'OFFLINE_FIXTURE',requests:[{id:'OFFLINE_REQUEST_executor',outcome:'COMPLETE',completionObserved:true,responseModelMatched:true,observedModel:actor.model.id}]}};
   app.store.record('NativeBudgetReceipt',run.projectId,run.id,receipt);emit(receipt);text='OFFLINE implementation completed';
  }else{text=JSON.stringify(offlinePreworkReview({dir,store:app.store},run.id));}
  const runner={codex:'CODEX_CLI',pi:'PI_CLI',cline:'CLINE_CLI'}[actor.runtime];
  return {text,model:actor.model.id,sessionId:'OFFLINE_SESSION_'+input.role,
   identity:{runner,runtime:actor.runtime,roleId:actor.id,provider:actor.provider,model:actor.model.id,authentication:actor.authentication==='oauth'?'CHATGPT_SUBSCRIPTION':'API_KEY',authRef:actor.authRef,accountRef:actor.accountRef,configurationHash,routeHash:hash('OFFLINE_ROUTE_'+actor.id)},
   usage:{role:input.role,requestId:'OFFLINE_REQUEST_'+input.role,inputTokens:null,outputTokens:null,costUsd:null,source:'OFFLINE_TEST'}};
 }};}
 let verifiedPlan;
 const verifier=new WslVerifier(root,dir,specHash=>specHash===spec.hash?verifiedPlan:null);
 // Execute only constant fixture bytes. The controller performs its original copy, comparisons and evidence assembly.
 verifier.sandbox={async run(workspace,command,{signal}){
  assert.equal(command.runtime,'node');assert.equal(command.entry,'main.mjs');assert.deepEqual(command.args,[]);
  assert.equal(readFileSync(join(workspace,'main.mjs'),'utf8'),source);
  const child=spawn(process.execPath,['main.mjs'],{cwd:workspace,env:{},signal,timeout:120000});
  let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;});child.stderr.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
  const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);child.stdin.end(command.stdin);});
  assert.equal(exitCode,0,stderr);assert.ok(child.pid>0);localCases++;
  return {status:'EXECUTED',command:['node','main.mjs'],exitCode,stdout,stderr,sourceHash:treeHash(workspace),workerHash:hash('OFFLINE_LOCAL_NODE'),jobId:'OFFLINE_PID_'+child.pid};
 }};
 const app=await createApp({root,data:dir,configPath:join(dir,'config.json'),port:0,product:'dreamflow',paidRequestGuard:()=>{paidCalls++;throw Error('unexpected paid request');},nativeOwnerBuilder:context=>{
  getConfig=context.getConfig;const owner=new NativeOwner({...context,root:dir});
  owner.configured=()=>({op:{},budget:{}});owner.assertNativeCleanup=()=>{};
  owner.customAccountCatalog=()=>({});owner.assertCustomReady=assertCustomRoleDiversity;owner.requireUserBudget=()=>{};
  owner.customCodex=offlineRole;owner.customTextMagpie=offlineRole;owner.customPi=(input,_role,...rest)=>offlineRole(input,...rest);
  owner.verifierPlan=(_projectId,specHash)=>{assert.equal(specHash,spec.hash);return verifiedPlan;};
  owner.verify=(input,emit)=>{sequence.push('verifier');return verifier.verify(input,emit);};return owner;
 }});
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});fixedControllerCapacity(app.engine);
 // This disposable WAL database exercises transaction semantics without a durability benchmark on removable media.
 app.store.db.exec('PRAGMA synchronous=NORMAL');
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 async function post(path,body){const response=await fetch(app.origin+'/api'+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)});const out=await response.json();assert.equal(response.status,200,path+' '+JSON.stringify(out).slice(0,500));return out;}
 const plan=fixtureProjectPlan([{id:'R1',text:'输出 OFFLINE_OK',origin:'USER',sources:['USER_DOCUMENT']}]);
 plan.tasks[0].check='运行入口并读取 OFFLINE_OK';plan.acceptance[0].check=plan.tasks[0].check;
 const initial=await post('/user-plans',{document:{schema:'dream-maker.user-plan.v1',name:'离线产品闭环',mode:'live',plan}});
 spec=initial.spec;const project='/projects/'+initial.project.id;
 await post(project+'/approve',{specHash:spec.hash});
 const profile=await post(project+'/flow-profile',{configuration,expectedRevision:0,confirmed:true});
 const prepared=await post(project+'/flow-preparation',{specHash:spec.hash,profileHash:profile.current.contentHash});
 const oracle=JSON.stringify({schema:'dream-maker.cli-verifier.v1',specHash:spec.hash,cases:[{id:'PRINT',requirementIds:['R1'],acceptanceIds:spec.acceptanceItems.map(a=>a.id),runtime:'node',entry:'main.mjs',args:[],stdin:'',expectedExitCode:0,expectedStdout:'OFFLINE_OK\n',expectedStderr:''}]});
 verifiedPlan={relativePath:'oracle.json',sha256:hash(oracle)};writeFileSync(join(dir,'oracle.json'),oracle);
 await post(project+'/native-verifier/approve',{specHash:spec.hash,planHash:verifiedPlan.sha256,approved:true});
 await post(project+'/build',{specHash:spec.hash,approved:true,flowName:'custom'});
 const runId=prepared.preparation.flowConfig.runId;await app.engine.settled(runId);
 const run=app.store.run(runId);assert.equal(run.state,'READY_FOR_DELIVERY',JSON.stringify({reason:run.reason,phase:run.phase,sequence}));
 assert.deepEqual(sequence,['planner2','executor','verifier','reviewer']);assert.equal(paidCalls,0);assert.equal(localCases,1);
 assert.equal(readFileSync(join(run.workspace,'main.mjs'),'utf8'),source);
 assert.deepEqual(['planner2','executor','reviewer'].map(role=>run.roleIdentities[role].runtime),['codex','pi','cline']);
 assert.equal(new Set(Object.values(run.roleIdentities).map(identity=>identity.sessionId)).size,3);
 const records=kind=>app.store.records(run.projectId,kind).filter(row=>row.runId===runId);
 assert.equal(new Set(Object.values(run.roleIdentities).map(identity=>identity.requestId)).size,3);
 assert.ok(app.store.db.prepare("SELECT id FROM records WHERE project_id=? AND run_id=? AND id=?").get(run.projectId,run.id,run.prework.recordId));
 assert.equal(records('AgentSession').length,3);assert.equal(run.review.verdict,'PASS');assert.equal(run.verification.ok,true);
 const closeouts=records('PreworkCloseout');assert.equal(closeouts.length,1);const closeout=closeouts[0].data;
 assert.equal(closeout.contractId,run.prework.contractId);assert.equal(closeout.verificationEvidenceId,run.verification.evidenceId);
 assert.equal(closeout.packetId,records('ReviewPacket')[0].id);assert.equal(closeout.reviewRecordId,records('Review')[0].id);
 const [seal]=records('ExecutorSliceSealed'),[intent]=records('ToolIntent'),[result]=records('ToolResult');
 assert.equal(intent.data.tool,'desk_write');assert.equal(result.data.intentId,intent.id);assert.equal(result.data.status,'COMPLETE');
 assert.ok(seal.data.sliceId);assert.equal(intent.data.sliceId,seal.data.sliceId);assert.equal(result.data.sliceId,seal.data.sliceId);
 assert.equal(closeout.treeHash,run.treeHash);
 const roleSessions=Object.fromEntries(Object.entries(run.roleIdentities).map(([role,id])=>[role,{runtime:id.runtime,model:id.model,session:id.sessionId,request:id.requestId}]));
 t.diagnostic(JSON.stringify({evidence:'OFFLINE_TEST',runId,state:run.state,sequence,paidCalls,localCases,prework:run.prework,sliceId:seal.data.sliceId,sealId:seal.id,writeIntent:intent.id,writeResult:result.id,closeoutId:closeouts[0].id,packetId:closeout.packetId,reviewId:closeout.reviewRecordId,verificationId:closeout.verificationEvidenceId,roleSessions,treeHash:run.treeHash}));
});
