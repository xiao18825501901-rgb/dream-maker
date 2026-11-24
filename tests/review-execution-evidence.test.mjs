// OFFLINE Store/packet fixtures only. These seeded records never qualify native roles.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,cpSync} from 'node:fs';import {join,dirname} from 'node:path';
import {harness,ready} from './helpers.mjs';import {captureSource,buildReviewPacket} from '../dist/server/review-packet.js';import {hash} from '../dist/server/security.js';
import {verifierCaseEvidence} from '../dist/server/wsl-verifier.js';
import {treeHash} from '../dist/server/workspace.js';
import {assertReviewTaskBodySafe} from '../dist/server/review-admission.js';
import {FlowProfiles} from '../dist/server/flow-profiles.js';
import {CustomFlowPreparations} from '../dist/server/custom-flow-preparation.js';
async function setup(t,options={}){
 const h=harness(t);let p,s;
 if(options.unapproved){const made=h.interviews.create('未批准的离线方案','仅控制端反例，不调用模型','demo');await h.interviews.finish(made.id,'',false);p=h.store.project(made.id);s=h.store.spec(p.specId);}
 else({p,s}=await ready(h));
 if(options.confirmedAcceptance){
  const revised=h.interviews.reviseSemantics(p.id,s.hash,{confirmed:true,
   requirements:s.requirements.map(requirement=>({id:requirement.id,kind:'functional',priority:requirement.priority})),
   acceptanceItems:[{id:'A1',requirementIds:s.requirements.map(requirement=>requirement.id),criterion:'OFFLINE manual acceptance linked to explicit executable evidence.',method:'manual'}]});
  p=h.store.project(p.id);s=h.store.spec(revised.specId);h.interviews.approve(p.id,s.hash);
 }
 if(!options.unapproved)h.store.approve(p.id,s.hash,'BUILD','OFFLINE_EXPLICIT_APPROVAL');
 const custom=options.custom===true;
 let prepared;
 if(custom){
  const account={provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'};
  const role=(id,write=false)=>({id,...account,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,
   permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
  const profile=new FlowProfiles(h.store).confirm(p.id,{configuration:{mode:'custom',laya:false,accounts:[account],roles:{planner2:role('planner2'),executors:[role('worker-one',true),role('worker-two',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'},expectedRevision:0,confirmed:true},'local-session:'+'c'.repeat(64),'OFFLINE_CUSTOM_PACKET');
  prepared=new CustomFlowPreparations(h.store,()=>h.config).prepare(p.id,s.hash,profile.contentHash);
 }
 const workspace=join(h.dir,'packet-source');mkdirSync(workspace);
 const planner2=custom?{runner:'DSH',runtime:'dsh',provider:'deepseek-official',authentication:'API_KEY',model:'deepseek-flash',roleId:'planner2',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT',configurationHash:prepared.flowConfigHash,routeHash:'1'.repeat(64),sessionId:'OFFLINE_P2',requestId:'OFFLINE_P2_REQUEST'}
  :{runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:'OFFLINE_CODEX',sessionId:'OFFLINE_P2',requestId:'OFFLINE_P2_REQUEST'};
 const executors=custom?['one','two'].map((suffix,index)=>({...planner2,roleId:index?'worker-two':'worker-one',routeHash:(index?'3':'2').repeat(64),sessionId:'OFFLINE_EXECUTOR_'+suffix.toUpperCase(),requestId:'OFFLINE_EXECUTOR_REQUEST_'+suffix.toUpperCase(),executorRoleId:index?'worker-two':'worker-one',taskId:'OFFLINE_TASK_'+suffix.toUpperCase(),sliceId:'OFFLINE_SLICE_'+suffix.toUpperCase(),dispatchId:'OFFLINE_DISPATCH_'+suffix.toUpperCase(),generation:'OFFLINE_GENERATION'}))
  :[{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:'OFFLINE_DSH',sessionId:'OFFLINE_EXECUTOR',requestId:'OFFLINE_EXECUTOR_REQUEST'}];
 const identities={planner2,executor:publicExecutorIdentity(executors[0])};
 function publicExecutorIdentity(value){if(!custom)return value;const {executorRoleId,taskId,sliceId,dispatchId,generation,...identity}=value;return identity;}
 const runId=custom?prepared.flowConfig.runId:'OFFLINE_PACKET_RUN';
 const r={id:runId,mode:'live',flowName:custom?'custom':'classic',...(custom?{rolePolicy:'CUSTOM_FROZEN_V1',flowConfig:prepared.flowConfig,flowConfigHash:prepared.flowConfigHash,configFingerprint:prepared.flowConfig.configurationFingerprint,executorRoleIdentities:executors}:{}),projectId:p.id,specHash:s.hash,specId:s.id,planVersionId:s.id,planVersionHash:h.store.planVersion(s.id).contentHash,createdAt:new Date().toISOString(),workspace,plan:{tasks:[]},findings:[],roleIdentities:identities,sessions:{planner2:'OFFLINE_P2',executor:executors[0].sessionId}};
 const snapshot=stage=>{const snap=captureSource(workspace,{runId:r.id,specHash:s.hash},stage);h.store.record('SourceSnapshot',p.id,r.id,snap);r.treeHash=snap.treeHash;};
 snapshot('BASELINE');writeFileSync(join(workspace,'main.mjs'),'// OFFLINE source, not executed\n');
 for(const path of options.emptyDirectories??[])mkdirSync(join(workspace,path),{recursive:true});
 for(const [path,content] of Object.entries(options.sourceFiles??{})){mkdirSync(dirname(join(workspace,path)),{recursive:true});writeFileSync(join(workspace,path),content);}
 snapshot('EXECUTOR_AFTER');snapshot('VERIFIER_INPUT');
 const definition={id:'C1',requirementIds:s.requirements.map(v=>v.id),...(options.confirmedAcceptance?{acceptanceIds:['A1']}:{}),runtime:'node',entry:'main.mjs',args:[],stdin:options.stdin??'原始输入\n',expectedExitCode:0,expectedStdout:'OK\n',expectedStderr:'',...(options.fixtures?{fixtures:options.fixtures}:{})};
 const planText=JSON.stringify({schema:'dream-maker.cli-verifier.v1',specHash:s.hash,cases:[definition]},null,2)+'\n',planHash=hash(planText);
 const raw={schema:'dream-maker.trusted-cli-evidence.v2',specHash:s.hash,sourceHash:r.treeHash,planHash,planText,ok:true,cases:[{id:'C1',requirementIds:definition.requirementIds,...(definition.acceptanceIds?{acceptanceIds:definition.acceptanceIds}:{}),ok:true,expectedExitCode:0,actualExitCode:0,outputMatched:true,diagnosticMatched:true,stdinHash:hash(definition.stdin),...verifierCaseEvidence(definition),sourceHash:r.treeHash,workerHash:'b'.repeat(64),jobId:'OFFLINE_JOB',status:'EXECUTED',command:['/usr/bin/node','/workspace/main.mjs'],stdout:'OK\n',stderr:'',stderrTail:'',fixtureCount:0}]};
 if(options.fixtures){const copy=join(h.dir,'fixture-source');cpSync(workspace,copy,{recursive:true});for(const [path,content] of Object.entries(options.fixtures)){mkdirSync(dirname(join(copy,path)),{recursive:true});writeFileSync(join(copy,path),content);}raw.cases[0].sourceHash=treeHash(copy);raw.cases[0].fixtureCount=Object.keys(options.fixtures).length;}
 const evidence={stepId:'OFFLINE_STEP',attempt:1,specHash:s.hash,treeHash:r.treeHash,command:['dream-maker-controller-cli-oracle',s.hash,planHash],stdout:JSON.stringify(raw),stderr:'',code:0,at:new Date().toISOString(),scope:'LIVE_VERIFIER'};
 const evidenceId=h.store.record('Evidence',p.id,r.id,evidence);r.verification={ok:true,evidenceId,treeHash:r.treeHash};
 const approvalId=h.store.record('VerifierApproval',p.id,null,{specHash:s.hash,planHash,source:'EXPLICIT_LOCAL_SESSION_ACTION'});
 const sessionRecords=custom?[['planner2',planner2],...executors.map(identity=>['executor',identity])]:Object.entries(identities),sessionIds=[];
 for(const [role,identity] of sessionRecords){
  sessionIds.push(h.store.record('AgentSession',p.id,r.id,{role,...identity,modelEvidence:'ADAPTER_VERIFIED_RESPONSE'}));
  if(custom&&role==='executor'){
   h.store.record('DispatchGranted',p.id,r.id,{dispatchId:identity.dispatchId,generation:identity.generation,kind:'executor',mode:'live',executorRoleId:identity.executorRoleId,executorSliceId:identity.sliceId,cleanupReturned:false});
   // OFFLINE fixture chronology mirrors real tools: grant -> intent/result -> finish.
   const intentId=h.store.record('ToolIntent',p.id,r.id,{tool:'desk_write',specHash:s.hash,sourceHash:hash([]),sliceId:identity.sliceId,requestHash:hash('OFFLINE_WRITE_'+identity.sliceId)});
   h.store.record('ToolResult',p.id,r.id,{intentId,tool:'desk_write',specHash:s.hash,sourceHash:r.treeHash,sliceId:identity.sliceId,status:'COMPLETE',responseHash:hash('OFFLINE_RESULT_'+identity.sliceId)});
   h.store.record('DispatchFinished',p.id,r.id,{dispatchId:identity.dispatchId,generation:identity.generation,outcome:'COMPLETED',cleanupReturned:true});
   h.store.record('UsageLedger',p.id,r.id,{role:'executor',requestId:identity.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'});
  }
 }
 const writeSlices=custom?[]:['OFFLINE_SLICE'];
 for(const sliceId of writeSlices){const intentId=h.store.record('ToolIntent',p.id,r.id,{tool:'desk_write',specHash:s.hash,sourceHash:hash([]),sliceId,requestHash:hash('OFFLINE_WRITE_'+sliceId)});h.store.record('ToolResult',p.id,r.id,{intentId,tool:'desk_write',specHash:s.hash,sourceHash:r.treeHash,sliceId,status:'COMPLETE',responseHash:hash('OFFLINE_RESULT_'+sliceId)});}
 const observedModel=custom?'deepseek-flash':'OFFLINE_DSH',requests=Array.from({length:custom?2:1},(_,index)=>({id:'OFFLINE_REQUEST_'+index,observedModel,outcome:'COMPLETE',completionObserved:true,responseModelMatched:true,usage:null}));
 const receiptId=h.store.record('NativeBudgetReceipt',p.id,r.id,{method:'dm/budget',params:{requests}});
 let admissionId;
 if(!custom){admissionId=h.store.event(p.id,r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'planner2',threadId:'OFFLINE_P2',model:'OFFLINE_CODEX',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',includedUsageAllowed:true,paidFallback:false,permissionProfile:'OFFLINE_READ_ONLY',policyHash:'d'.repeat(64)}});
  h.store.event(p.id,r.id,'agent.event',{method:'dm/codexCompletion',params:{role:'planner2',threadId:'OFFLINE_P2',turnId:'OFFLINE_P2_REQUEST',model:'OFFLINE_CODEX',provider:'openai',status:'completed',specHash:s.hash,runId:r.id}});}
 return{h,p,s,r,raw,evidence,evidenceId,approvalId,sessionIds,receiptId,admissionId,packet:()=>buildReviewPacket(h.store,r,s)};
}

test('Live packet carries original completed role sessions, actual tool journal, receipts and verifier approval',async t=>{
 const f=await setup(t),packet=f.packet(),evidence=packet.executionEvidence;
 assert.deepEqual(evidence.roleIdentities,f.r.roleIdentities);assert.equal(evidence.sessions.length,2);
 assert.deepEqual(evidence.sessions.map(row=>row.recordId),f.sessionIds);assert.equal(evidence.toolJournal.find(row=>row.kind==='ToolResult').data.status,'COMPLETE');
 assert.equal(evidence.modelReceipts[0].recordId,f.receiptId);assert.equal(evidence.codexEvents[0].data.method,'dm/codexAdmission');
 assert.equal(packet.verifierApproval.recordId,f.approvalId);assert.equal(packet.verifierApproval.planHash,f.raw.planHash);
});
test('R11 review packet maps owner-confirmed items to explicit executable evidence without claiming manual review',async t=>{
 const f=await setup(t,{confirmedAcceptance:true}),packet=f.packet(),acceptance=packet.acceptanceEvidence;
 assert.equal(acceptance.schema,'dream-maker.acceptance-evidence.v1');
 assert.equal(acceptance.specHash,f.s.hash);assert.equal(acceptance.evidenceId,f.evidenceId);assert.equal(acceptance.planHash,f.raw.planHash);
 assert.deepEqual(acceptance.items.map(item=>({id:item.id,executable:item.executableEvidenceStatus,manual:item.manualAcceptanceStatus,cases:item.caseIds})),
  [{id:'A1',executable:'PASS',manual:'NOT_RUN',cases:['C1']}]);
 assert.equal(acceptance.coverage.withoutExecutableEvidence,0);
});
test('a completed desk_edit is valid executor write evidence',async t=>{
  const f=await setup(t),intent=f.h.store.records(f.p.id,'ToolIntent').find(row=>row.runId===f.r.id&&row.data.tool==='desk_write'),
    result=f.h.store.records(f.p.id,'ToolResult').find(row=>row.runId===f.r.id&&row.data.intentId===intent.id);
  for(const [row,tool] of [[intent,'desk_edit'],[result,'desk_edit']])
    f.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...row.data,tool}),row.id);
  assert.doesNotThrow(f.packet);
});
test('tool intent and result must name the same write operation',async t=>{
  const f=await setup(t),intent=f.h.store.records(f.p.id,'ToolIntent').find(row=>row.runId===f.r.id&&row.data.tool==='desk_write'),
    result=f.h.store.records(f.p.id,'ToolResult').find(row=>row.runId===f.r.id&&row.data.intentId===intent.id);
  f.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...result.data,tool:'desk_edit'}),result.id);
  assert.throws(f.packet,{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});
});
test('Custom multi-executor packet carries every independently dispatched worker session and write',async t=>{
 const f=await setup(t,{custom:true}),packet=f.packet(),evidence=packet.executionEvidence;
 assert.equal(evidence.executorRoleIdentities.length,2);
 assert.deepEqual(evidence.executorRoleIdentities.map(value=>value.executorRoleId).sort(),['worker-one','worker-two']);
 assert.equal(new Set(evidence.executorRoleIdentities.map(value=>value.sessionId)).size,2);
 assert.equal(new Set(evidence.executorRoleIdentities.map(value=>value.sliceId)).size,2);
 assert.equal(evidence.sessions.filter(row=>row.data.role==='executor').length,2);
 assert.equal(evidence.usage.filter(row=>row.data.role==='executor').length,2);
 assert.equal(evidence.codexEvents.length,0);
 // A Custom Planner 2 is not necessarily Codex, so there is no Codex admission to
 // bind. The packet must say so rather than fabricate one or demand one.
 assert.equal(evidence.planningAdmission,undefined);
});
test('Codex Planner 2 still requires its own admission and completion events',async t=>{
 const f=await setup(t),evidence=f.packet().executionEvidence;
 assert.equal(evidence.planningAdmission.schema,'dream-maker.planning-admission.v1');
 assert.equal(evidence.planningAdmission.runner,'CODEX_CLI');
 assert.equal(evidence.planningAdmission.sessionId,'OFFLINE_P2');
 // Removing the single completion turns the same Classic packet into a blocker
 // instead of silently accepting a Planner 2 session with no recorded turn.
 f.h.store.db.prepare("DELETE FROM events WHERE run_id=? AND json_extract(payload,'$.method')='dm/codexCompletion'").run(f.r.id);
 assert.throws(f.packet,{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});
});
test('a non-Codex Planner 2 cannot borrow Codex admission events it never had',async t=>{
 const f=await setup(t);
 f.r.roleIdentities={...f.r.roleIdentities,planner2:{...f.r.roleIdentities.planner2,runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:'deepseek-flash'}};
 // Runner switch is itself a binding change for the AgentSession row, so the
 // stricter session check still fails closed rather than treating DSH as Codex.
 assert.throws(f.packet,{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});
});

test('Live packet includes original project approval evidence without rewriting the frozen proposal',async t=>{
 const f=await setup(t),before=hash(f.s),versionBefore=hash(f.h.store.planVersion(f.s.id)),e=f.packet().approvalEvidence;
 assert.equal(e.schema,'dream-maker.project-approval-evidence.v1');assert.equal(e.planVersion.id,f.r.planVersionId);assert.equal(e.planVersion.contentHash,f.r.planVersionHash);
 assert.equal(e.planApproval.plan_id,f.r.planVersionId);assert.equal(e.planApproval.spec_hash,f.r.specHash);assert.equal(e.specApproval.kind,'SPEC');assert.equal(e.buildApproval.kind,'BUILD');
 assert.ok(Date.parse(e.planApproval.at)<=Date.parse(f.r.createdAt));assert.ok(Date.parse(e.buildApproval.at)<=Date.parse(e.firstSourceSnapshotAt));
 assert.equal(hash(f.s),before);assert.equal(hash(f.h.store.planVersion(f.s.id)),versionBefore);
});

async function pooled(t,options={}){
 const f=await setup(t,{sourceFiles:{'repeated.txt':'R'.repeat(100000)},stdin:'Q'.repeat(60000),...options});
 for(let n=0;n<5;n++)f.r.verification.evidenceId=f.h.store.record('Evidence',f.p.id,f.r.id,f.evidence);
 return{...f,packet:f.packet()};
}
test('oversized complete packet shares repeated source bytes without dropping any snapshot or raw evidence',async t=>{
 const f=await pooled(t),p=f.packet;assert.equal(p.sourceContentEncoding,'CONTENT_POOL_V1');assert.equal(p.rawTests.length,6);
 const {expandReviewSourcePool,expandReviewTestDataPool}=await import('../dist/server/review-source-pool.js'),expanded=expandReviewSourcePool(p),expandedTests=expandReviewTestDataPool(p);
 const originals=f.h.store.records(f.p.id,'SourceSnapshot').filter(x=>x.runId===f.r.id).map(x=>({recordId:x.id,...x.data}));
 assert.equal(p.rawTestDataEncoding,'CONTENT_POOL_V1');assert.deepEqual(expanded,originals);
 assert.deepEqual(expandedTests,JSON.parse(JSON.stringify(f.h.store.records(f.p.id,'Evidence').filter(x=>x.runId===f.r.id).slice(-6).map(x=>({recordId:x.id,data:x.data})))));
 assert.ok(Buffer.byteLength(JSON.stringify(p))<=512000);assert.doesNotThrow(()=>assertReviewTaskBodySafe(p));
});
test('oversized review pooling preserves the complete acceptance evidence projection',async t=>{
 const f=await pooled(t,{confirmedAcceptance:true}),p=f.packet,item=p.acceptanceEvidence.items[0];
 assert.equal(p.sourceContentEncoding,'CONTENT_POOL_V1');
 assert.equal(p.acceptanceEvidence.schema,'dream-maker.acceptance-evidence.v1');
 assert.equal(p.acceptanceEvidence.evidenceId,f.r.verification.evidenceId);
 assert.deepEqual({id:item.id,executable:item.executableEvidenceStatus,manual:item.manualAcceptanceStatus,cases:item.caseIds},
  {id:'A1',executable:'PASS',manual:'NOT_RUN',cases:['C1']});
 assert.deepEqual(p.acceptanceEvidence.coverage,{acceptanceItems:1,withExecutableEvidence:1,withoutExecutableEvidence:0,passedExecutableEvidence:1,failedExecutableEvidence:0});
});
for(const defect of ['missing','altered','orphan'])test('source pool '+defect+' cannot cross the review admission boundary',async t=>{
 const f=await pooled(t),p=f.packet,key=Object.keys(p.sourceContentPool)[0];
 if(defect==='missing')delete p.sourceContentPool[key];else if(defect==='altered')p.sourceContentPool[key].content+='X';else p.sourceContentPool['f'.repeat(64)]={...p.sourceContentPool[key]};
 assert.throws(()=>assertReviewTaskBodySafe(p));
});
for(const defect of ['missing','altered','orphan'])test('raw test pool '+defect+' cannot cross the review admission boundary',async t=>{
 const f=await pooled(t),p=f.packet,key=Object.keys(p.rawTestDataPool)[0];
 if(defect==='missing')delete p.rawTestDataPool[key];else if(defect==='altered')p.rawTestDataPool[key]={...(p.rawTestDataPool[key]),tampered:true};else p.rawTestDataPool['f'.repeat(64)]={...p.rawTestDataPool[key]};
 assert.throws(()=>assertReviewTaskBodySafe(p));
});
test('an unapproved project cannot substitute proposal flags for original approval rows',async t=>{
 const f=await setup(t,{unapproved:true});f.s.approved=true;
 assert.throws(f.packet,{code:'REVIEW_PROJECT_APPROVAL_REQUIRED'});
});
for(const kind of ['SPEC','BUILD'])test('missing '+kind+' original approval refuses reviewer preparation',async t=>{
 const f=await setup(t);f.h.store.db.prepare('DELETE FROM approvals WHERE project_id=? AND kind=?').run(f.p.id,kind);
 assert.throws(f.packet,{code:'REVIEW_PROJECT_APPROVAL_REQUIRED'});
});
test('a wrong approved version hash is not permission to review this material',async t=>{
 const f=await setup(t);f.r.planVersionHash='f'.repeat(64);assert.throws(f.packet,{code:'REVIEW_PROJECT_APPROVAL_BINDING_INVALID'});
});

for(const [name,alter] of [
 ['requirements',s=>s.requirements[0].text+=' OFFLINE_UNAPPROVED_CHANGE'],
 ['acceptance',s=>s.acceptance.push('OFFLINE_UNAPPROVED_ACCEPTANCE')],
 ['master prompt',s=>s.masterPrompt+=' OFFLINE_UNAPPROVED_PROMPT'],
 ['project plan',s=>s.projectPlan={...s.projectPlan,summary:'OFFLINE_UNAPPROVED_PLAN'}]
])test('original approval cannot authorize altered '+name+' with unchanged ID and hash labels',async t=>{
 const f=await setup(t),storedBefore=hash(f.h.store.spec(f.s.id));alter(f.s);
 assert.throws(f.packet,{code:'REVIEW_PROJECT_APPROVAL_BINDING_INVALID'});
 assert.equal(hash(f.h.store.spec(f.s.id)),storedBefore);
});

for(const offset of ['-10:00','+10:00'])test('BUILD timestamp offset '+offset+' cannot bypass actual approval order',async t=>{
 const f=await setup(t);f.h.store.db.prepare("UPDATE approvals SET at=? WHERE project_id=? AND kind='BUILD'")
  .run(f.r.createdAt.replace('Z',offset),f.p.id);
 assert.throws(f.packet,{code:'REVIEW_PROJECT_APPROVAL_BINDING_INVALID'});
});

test('future SPEC with a misleading timezone cannot authorize this run',async t=>{
 const f=await setup(t);f.h.store.db.prepare("UPDATE approvals SET at=? WHERE project_id=? AND kind='SPEC'")
  .run(f.r.createdAt.replace('Z','-10:00'),f.p.id);
 f.h.store.db.prepare("UPDATE approvals SET at=? WHERE project_id=? AND kind='BUILD'").run(f.r.createdAt,f.p.id);
 assert.throws(f.packet,{code:'REVIEW_PROJECT_APPROVAL_BINDING_INVALID'});
});

test('BUILD recorded within run creation may precede source without preceding run timestamp',async t=>{
 const f=await setup(t),buildAt=new Date(Date.parse(f.r.createdAt)+14).toISOString(),snapshotAt=new Date(Date.parse(buildAt)+1).toISOString();
 f.h.store.db.prepare("UPDATE approvals SET at=? WHERE project_id=? AND kind='BUILD'").run(buildAt,f.p.id);
 f.h.store.db.prepare("UPDATE records SET at=? WHERE run_id=? AND kind='SourceSnapshot'").run(snapshotAt,f.r.id);
 assert.equal(f.packet().approvalEvidence.buildApproval.at,buildAt);
});
test('a late recorded build approval cannot retrospectively authorize earlier source',async t=>{
 const f=await setup(t);f.h.store.db.prepare("UPDATE approvals SET at='2099-01-01T00:00:00.000Z' WHERE project_id=? AND kind='BUILD'").run(f.p.id);
 assert.throws(f.packet,{code:'REVIEW_PROJECT_APPROVAL_REQUIRED'});
});
test('the original plan approval must precede the recorded run creation',async t=>{
 const f=await setup(t);f.r.createdAt='2000-01-01T00:00:00.000Z';assert.throws(f.packet,{code:'REVIEW_PROJECT_APPROVAL_BINDING_INVALID'});
});

test('missing completed role evidence is refused before paying for a reviewer',async t=>{
 const f=await setup(t);f.h.store.db.prepare('DELETE FROM records WHERE id=?').run(f.sessionIds[0]);
 assert.throws(f.packet,{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});
});

for(const [name,alter] of [
 ['missing input text',raw=>delete raw.planText],['missing full diagnostic',raw=>delete raw.cases[0].stderr],
 ['changed input hash',raw=>raw.cases[0].stdinHash='c'.repeat(64)],['changed approved plan bytes',raw=>raw.planText+=' '],
 ['missing raw input',raw=>delete raw.cases[0].input],['changed raw input',raw=>raw.cases[0].input.stdin='篡改后的输入\n'],
 ['changed raw expectation',raw=>raw.cases[0].expected.stdout='篡改后的期望\n']
])test('Live packet refuses '+name+' rather than presenting partial raw evidence',async t=>{
 const f=await setup(t);alter(f.raw);f.evidence.stdout=JSON.stringify(f.raw);
 f.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(f.evidence),f.evidenceId);
 assert.throws(f.packet,{code:'REVIEW_RAW_EVIDENCE_INCOMPLETE'});
});

test('role journal never includes another run and rejects secret-bearing current records',async t=>{
 const f=await setup(t);f.h.store.record('AgentSession',f.p.id,'OFFLINE_OTHER_RUN',{role:'planner2',sessionId:'FOREIGN_SESSION'});
 assert.doesNotMatch(JSON.stringify(f.packet()),/FOREIGN_SESSION/);
 // Store.record correctly redacts secrets. Simulate corrupted/imported raw storage to test the read boundary.
 const id=f.h.store.record('NativeBudgetReceipt',f.p.id,f.r.id,{unexpected:'SAFE_OFFLINE'});
 f.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({unexpected:'sk-'+'A'.repeat(30)}),id);
 assert.throws(f.packet,{code:'REVIEW_SECRET_IN_MATERIAL'});
});

test('nested JSON credentials cannot cross the review boundary',async t=>{
 const f=await setup(t,{stdin:JSON.stringify({Authorization:'Bearer OFFLINE_TOKEN'})});
 assert.throws(f.packet,{code:'REVIEW_SECRET_IN_MATERIAL'});
});
test('prefixed JSON-line credentials cannot cross the review boundary',async t=>{
 const text='diagnostic: '+JSON.stringify({headers:JSON.stringify({Authorization:'Bearer OFFLINE_TOKEN'})})+'\n{}\n';
 const f=await setup(t,{stdin:text});assert.throws(f.packet,{code:'REVIEW_SECRET_IN_MATERIAL'});
});
test('fixture source binding follows actual case-insensitive Windows file and parent names',async t=>{
 const f=await setup(t,{sourceFiles:{'Data.json':'old','Case/file.json':'old child'},fixtures:{'data.json':'new','case/added.json':'new child'}});
 const packet=f.packet();assert.equal(packet.rawTests.at(-1).data.treeHash,f.r.treeHash);
});
test('fixture source binding preserves actual empty parent directory names',async t=>{
 const f=await setup(t,{emptyDirectories:['Case'],fixtures:{'case/added.json':'new child'}});assert.ok(f.packet());
});
test('a complete historical timeout remains failed and does not hide a later actual pass',async t=>{
 const f=await setup(t),raw=structuredClone(f.raw);raw.ok=false;Object.assign(raw.cases[0],{status:'TIMED_OUT',actualExitCode:-1,ok:false});
 f.h.store.record('Evidence',f.p.id,f.r.id,{...f.evidence,code:1,stdout:JSON.stringify(raw)});
 f.r.verification.evidenceId=f.h.store.record('Evidence',f.p.id,f.r.id,f.evidence);
 const packet=f.packet();assert.equal(packet.rawTests.length,3);assert.equal(JSON.parse(packet.rawTests[1].data.stdout).cases[0].status,'TIMED_OUT');
});
for(const [name,alter] of [
 ['missing Codex admission',f=>f.h.store.db.prepare('DELETE FROM events WHERE id=?').run(f.admissionId)],
 ['empty model receipt',f=>f.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({method:'dm/budget',params:{requests:[]}}),f.receiptId)]
])test('missing evidence refuses '+name+' before the reviewer model',async t=>{
 const f=await setup(t);alter(f);assert.throws(f.packet,{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});
});
