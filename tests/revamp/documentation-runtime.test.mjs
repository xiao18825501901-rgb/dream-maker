import {offlinePreworkReview} from '../fixtures/offline-prework-review.mjs';
// Explicit OFFLINE runtime wiring. No native model, account or formal database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {documentationCorrectionFixture} from '../fixtures/documentation-correction.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {hash,DomainError} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {readPrework,assertPreworkDispatch} from '../../dist/server/prework/runtime.js';
import {
  assertDocumentationProtectedFiles,
  documentationPreparedEvidence,
  reserveDocumentationRepair,
} from '../../dist/server/documentation-continuation.js';

const actor='local-session:'+'a'.repeat(64);

async function prepared(t,options={}){
  const x=await documentationCorrectionFixture(t,{includeMainTask:true,...options});
  const candidate=x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md');
  const child=await x.h.engine.approveDocumentationContinuation(
    x.r.id,
    {confirmed:true,file:'README.md',candidateHash:candidate.candidateHash,taskDeadline:null},
    actor,
  );
  return {...x,child};
}

function reservation(x){
  let revision=0,reserves=0;
  return {
    get reserves(){return reserves},
    get revision(){return revision},
    ops:{
      repairRevision(){return revision},
      reserveRepair(runId){
        assert.equal(runId,x.child.id);
        reserves++;
        revision++;
      },
    },
  };
}

test('approved continuation has a new Prework contract with inherited planning and no fabricated child P2',async t=>{
 const x=await prepared(t),r=x.h.store.run(x.child.id);
 assert.ok(r.prework,'continuation must pass the same mandatory handoff');
 assert.equal(x.child.version,r.version,'preparation returns the persisted contract revision');
 const contract=readPrework(x.h.store,r);
 assert.equal(contract.planner2.provenance.origin,'INHERITED_NOT_NEW_PLANNING');
 assert.equal(contract.planner2.provenance.parentFlowId,x.r.id);
 assert.equal(r.sessions.planner2,undefined);assert.equal(r.roleIdentities?.planner2,undefined);
 const carried=r.tasks.filter(task=>task.inheritedFrom);
 assert.ok(carried.length);
 for(const task of carried)assert.throws(()=>assertPreworkDispatch(x.h.store,r,task.id),{code:'PREWORK_CARRIED_TASK_NOT_DISPATCHABLE'});
 const active=assertPreworkDispatch(x.h.store,r);
 assert.deepEqual(active.packages.map(w=>w.taskId),r.tasks.filter(task=>!task.inheritedFrom).map(task=>task.id));
});

async function blockedRecovery(t){
  const x=await prepared(t);
  const running=x.h.store.run(x.child.id);
  running.state='IMPLEMENTING';running.reason=undefined;running.calls=1;running.repairCount=1;
  x.h.store.saveRun(running);
  const wave=x.h.engine.executorSlices.prepare(x.child.id);
  const blocked=x.h.store.run(x.child.id);
  blocked.state='BLOCKED';blocked.reason='DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED';
  x.h.store.saveRun(blocked);
  x.h.store.record('DocumentationNativeRepairReservation',x.p.id,x.child.id,{
    schema:'dream-maker.documentation-native-repair-reservation.v1',
    runId:x.child.id,parentRunId:x.r.id,approvalRecordId:blocked.documentationContinuation.recordId,
    approvalHash:blocked.documentationContinuation.sha256,sourceHash:blocked.treeHash,budgetRevision:1,
    automaticRetry:false,modelDispatched:false,
  });
  return {x,wave};
}

test('documentation repair budget reservation is idempotent across replay',async t=>{
  const x=await prepared(t),r=reservation(x);
  const first=reserveDocumentationRepair(x.h.store,x.child,r.ops);
  const before=x.h.store.records(x.p.id,'DocumentationNativeRepairReservation').length;
  const second=reserveDocumentationRepair(x.h.store,first,r.ops);
  assert.equal(r.reserves,1);
  assert.equal(r.revision,1);
  assert.equal(first.repairCount,1);
  assert.equal(second.repairCount,1);
  assert.equal(before,1);
  assert.equal(x.h.store.records(x.p.id,'DocumentationNativeRepairReservation').filter(row=>row.runId===x.child.id).length,1);
  await assert.rejects(
    async()=>reserveDocumentationRepair(x.h.store,{...second,repairCount:0},r.ops),
    {code:'DOCUMENTATION_CONTINUATION_CHANGED'},
  );
});

test('any protected source change is rejected before runtime',async t=>{
  const x=await prepared(t);
  assert.doesNotThrow(()=>assertDocumentationProtectedFiles(x.h.store,x.child));
  writeFileSync(join(x.child.workspace,'main.mjs'),'// OFFLINE protected source changed\n');
  assert.throws(
    ()=>assertDocumentationProtectedFiles(x.h.store,x.child),
    {code:'DOCUMENTATION_CONTINUATION_PROTECTED_SOURCE_CHANGED'},
  );
  const r=reservation(x);
  await assert.rejects(
    async()=>x.h.engine.resume(x.child.id),
    {code:'DOCUMENTATION_CONTINUATION_PROTECTED_SOURCE_CHANGED'},
  );
  assert.equal(r.reserves,0);
});

test('Engine resumes one README-only DSH turn, merges it once and never uses segmented execution',async t=>{
  const x=await prepared(t);
  fixedControllerCapacity(x.h.engine);
  x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
  let revision=0,reserves=0,executorRuns=0,verifyRuns=0;
  const originalMain=readFileSync(join(x.child.workspace,'main.mjs'));
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(runId){assert.equal(runId,x.child.id);reserves++;revision++;},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        const source=treeHash(input.workspace);
        const intentId=x.h.store.record('ToolIntent',x.p.id,x.child.id,{
          tool:'desk_write',
          specHash:x.child.specHash,
          sourceHash:source,
          sliceId:input.executorSliceId,
          requestHash:hash('OFFLINE_DOC_README_WRITE'),
        });
        writeFileSync(join(input.workspace,'README.md'),'# OFFLINE corrected README\n\nUse --help for supported arguments.\n');
        x.h.store.record('ToolResult',x.p.id,x.child.id,{
          intentId,
          tool:'desk_write',
          specHash:x.child.specHash,
          sourceHash:treeHash(input.workspace),
          sliceId:input.executorSliceId,
          status:'COMPLETE',
          responseHash:hash('OFFLINE_DOC_README_RESULT'),
        });
        return{
          text:'README examples corrected.',
          model:x.h.config.dsh.model,
          sessionId:'OFFLINE_DOC_DSH_SESSION',
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'OFFLINE_DOC_DSH_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    codex(){throw new Error('OFFLINE_REVIEWER_MUST_NOT_RUN');},
    async verify(){verifyRuns++;throw new DomainError('OFFLINE_VERIFY_STOP',409);},
    async close(){},
  };
  x.h.engine.executorSegmented=()=>{throw new Error('DOCUMENTATION_SEGMENTED_EXECUTION_FORBIDDEN');};
  const resumed=await x.h.engine.resume(x.child.id);
  assert.equal(resumed.state,'IMPLEMENTING');
  assert.equal(resumed.repairCount,1);
  await x.h.engine.settled(x.child.id);
  const final=x.h.store.run(x.child.id);
  assert.equal(reserves,1);
  assert.equal(executorRuns,1);
  assert.equal(verifyRuns,1);
  assert.equal(final.calls,1);
  assert.equal(final.state,'BLOCKED');
  assert.equal(final.reason,'OFFLINE_VERIFY_STOP');
  assert.match(readFileSync(join(final.workspace,'README.md'),'utf8'),/--help/);
  assert.deepEqual(readFileSync(join(final.workspace,'main.mjs')),originalMain);
  assert.equal(x.h.store.records(x.p.id,'DocumentationNativeRepairReservation').filter(row=>row.runId===x.child.id).length,1);
});

test('resume accepts a pending executor wave only for the approved documentation task', async t => {
  const {x,wave} = await blockedRecovery(t);
  assert.equal(wave.assignments.length, 1);
  assert.equal(wave.assignments[0].taskId, 'OFFLINE_DOC');

  fixedControllerCapacity(x.h.engine);
  x.h.engine.launch = Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
  x.h.engine.nativeExecution = {
    assertReady() {},
    executor() {
      return {
        run: async () => {
          throw new DomainError('OFFLINE_EXECUTOR_STOP', 409);
        },
      };
    },
    async verify() {
      throw Error('OFFLINE_VERIFIER_MUST_NOT_RUN');
    },
    async close() {},
    repairRevision() {
      return 1;
    },
    reserveRepair() {
      throw Error('OFFLINE_RESERVATION_MUST_NOT_BE_RENEWED');
    },
  };

  const resumed = await x.h.engine.resume(x.child.id,true);
  assert.equal(resumed.state, 'IMPLEMENTING');
  await x.h.engine.settled(x.child.id);
  const final = x.h.store.run(x.child.id);
  assert.equal(final.reason, 'OFFLINE_EXECUTOR_STOP');
  assert.notEqual(final.reason, 'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED');
  assert.equal(x.h.store.records(x.p.id,'DocumentationContinuationRecovery').filter(row=>row.runId===x.child.id).length,1);
});

test('documentation recovery rejects changed task, write scope, source or existing tool effects', async t => {
  const {x,wave}=await blockedRecovery(t);
  const assignment=wave.assignments[0];
  assert.throws(
    ()=>x.h.engine.executorSlices.pendingRecoveryWave(x.child.id,'OFFLINE_OTHER',assignment.writePaths),
    {code:'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED'},
  );
  assert.throws(
    ()=>x.h.engine.executorSlices.pendingRecoveryWave(x.child.id,assignment.taskId,['main.mjs']),
    {code:'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED'},
  );
  const changedTask=x.h.store.run(x.child.id);
  changedTask.tasks.find(item=>item.id===assignment.taskId).status='implemented';
  x.h.store.saveRun(changedTask);
  assert.throws(
    ()=>x.h.engine.executorSlices.pendingRecoveryWave(x.child.id,assignment.taskId,assignment.writePaths),
    {code:'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED'},
  );
  changedTask.tasks.find(item=>item.id===assignment.taskId).status='pending';
  x.h.store.saveRun(changedTask);
  writeFileSync(join(x.child.workspace,'README.md'),'# changed after the wave was prepared\n');
  assert.throws(
    ()=>x.h.engine.executorSlices.pendingRecoveryWave(x.child.id,assignment.taskId,assignment.writePaths),
    {code:'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED'},
  );
});

test('documentation recovery refuses multiple pending waves', async t=>{
  const {x,wave}=await blockedRecovery(t);
  x.h.store.record('ExecutorWavePrepared',x.p.id,x.child.id,{
    id:'executor_wave_untrusted',manifestHash:'a'.repeat(64),sourceHash:wave.sourceHash,
    assignmentCount:1,executorRoleOffset:0,
  });
  assert.throws(
    ()=>x.h.engine.executorSlices.pendingRecoveryWave(x.child.id,wave.assignments[0].taskId,wave.assignments[0].writePaths),
    {code:'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED'},
  );
});

test('documentation recovery refuses duplicate assignments', async t=>{
  const {x,wave}=await blockedRecovery(t);
  const changed={...wave,assignments:[wave.assignments[0],wave.assignments[0]]};
  const manifest=Buffer.from(JSON.stringify(changed));
  writeFileSync(join(wave.directory,'wave.json'),manifest);
  const row=x.h.store.records(x.p.id,'ExecutorWavePrepared').find(item=>item.data.id===wave.id);
  row.data.manifestHash=hash(manifest);
  x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(row.data),row.id);
  assert.throws(
    ()=>x.h.engine.executorSlices.pendingRecoveryWave(x.child.id,wave.assignments[0].taskId,wave.assignments[0].writePaths),
    {code:'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED'},
  );
});

test('documentation recovery does not replay a recorded recovery', async t=>{
  const {x,wave}=await blockedRecovery(t);
  const assignment=wave.assignments[0];
  x.h.store.record('DocumentationContinuationRecovery',x.p.id,x.child.id,{
    schema:'dream-maker.documentation-continuation-recovery.v1',runId:x.child.id,
    reason:'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED',sourceHash:x.child.treeHash,
    waveId:wave.id,taskId:assignment.taskId,calls:1,repairCount:1,modelsDispatched:false,automaticRetry:false,
  });
  await assert.rejects(
    async()=>x.h.engine.resume(x.child.id),
    {code:'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED'},
  );
});

test('documentation recovery refuses unknown tool effects', async t=>{
  const {x,wave}=await blockedRecovery(t);
  x.h.store.record('ToolIntent',x.p.id,x.child.id,{
    tool:'desk_read',sliceId:wave.assignments[0].id,specHash:x.child.specHash,sourceHash:wave.sourceHash,requestHash:'b'.repeat(64),
  });
  assert.throws(
    ()=>x.h.engine.executorSlices.pendingRecoveryWave(x.child.id,wave.assignments[0].taskId,wave.assignments[0].writePaths),
    {code:'TOOL_RECOVERY_REQUIRED'},
  );
});

test('a documentation runner RPC failure is retained once and never auto-repaired',async t=>{
  const x=await prepared(t);
  fixedControllerCapacity(x.h.engine);
  x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
  let revision=0,runs=0;
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){revision++;},
    repairRevision(){return revision;},
    executor(){return{run:async()=>{runs++;throw new DomainError('RUNNER_RPC_ERROR',502);}};},
    codex(){throw new Error('OFFLINE_REVIEWER_MUST_NOT_RUN');},
    async verify(){throw new Error('OFFLINE_VERIFIER_MUST_NOT_RUN');},
    async close(){},
  };
  await x.h.engine.resume(x.child.id);
  await x.h.engine.settled(x.child.id);
  const final=x.h.store.run(x.child.id);
  assert.equal(runs,1);
  assert.equal(revision,1);
  assert.equal(final.state,'BLOCKED');
  assert.equal(final.reason,'EXECUTOR_SLICE_RESULT_UNCERTAIN');
  assert.equal(final.phase,'IMPLEMENTING');
  assert.equal(final.repairCount,1);
});

test('direct launch cannot bypass the prepared continuation resume boundary',async t=>{
  const x=await prepared(t);
  assert.equal(documentationPreparedEvidence(x.h.store,x.child).modelDispatched,false);
  assert.throws(
    ()=>Object.getPrototypeOf(x.h.engine).launch.call(x.h.engine,x.child.id),
    {code:'DOCUMENTATION_CONTINUATION_RESUME_REQUIRED'},
  );
  assert.equal(x.h.store.run(x.child.id).calls,0);
});

for(const missingCoverage of [false,true])test(missingCoverage?'inherited delivery and closeout roll back together when the current review omits coverage':'OFFLINE full documentation chain uses inherited P2, one current DSH turn and one independent Codex review',async t=>{
  const x=await prepared(t);
  fixedControllerCapacity(x.h.engine);
  x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
  const caseDefinition={
    id:'OFFLINE_DOC_HELP',
    requirementIds:x.s.requirements.map(requirement=>requirement.id),
    runtime:'node',
    entry:'main.mjs',
    args:['--help'],
    stdin:'',
    expectedExitCode:0,
    expectedStdout:'Usage\n',
    expectedStderr:'',
  };
  const planText=JSON.stringify({schema:'dream-maker.cli-verifier.v1',specHash:x.child.specHash,cases:[caseDefinition]});
  const planHash=hash(planText);
  x.h.store.record('VerifierApproval',x.p.id,null,{specHash:x.child.specHash,planHash,source:'OFFLINE_EXPLICIT_LOCAL_SESSION_ACTION'});
  let revision=0,executorRuns=0,reviewerRuns=0;
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){revision++;},
    repairRevision(){return revision;},
    verifierPlan(){return{sha256:planHash,plan:JSON.parse(planText)};},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        const source=treeHash(input.workspace);
        const intentId=x.h.store.record('ToolIntent',x.p.id,x.child.id,{
          tool:'desk_write',
          specHash:x.child.specHash,
          sourceHash:source,
          sliceId:input.executorSliceId,
          requestHash:hash('OFFLINE_FULL_DOC_WRITE'),
        });
        writeFileSync(join(input.workspace,'README.md'),'# OFFLINE corrected README\n\nUse --help.\n');
        const after=treeHash(input.workspace);
        x.h.store.record('ToolResult',x.p.id,x.child.id,{
          intentId,
          tool:'desk_write',
          specHash:x.child.specHash,
          sourceHash:after,
          sliceId:input.executorSliceId,
          status:'COMPLETE',
          responseHash:hash('OFFLINE_FULL_DOC_RESULT'),
        });
        x.h.store.record('NativeBudgetReceipt',x.p.id,x.child.id,{
          method:'dm/budget',
          params:{requests:[{id:'OFFLINE_DOC_BUDGET',observedModel:x.h.config.dsh.model,outcome:'COMPLETE',completionObserved:true,responseModelMatched:true,usage:null}]},
        });
        return{
          text:'README corrected.',
          model:x.h.config.dsh.model,
          sessionId:'OFFLINE_DOC_CHILD_DSH',
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'OFFLINE_DOC_CHILD_DSH_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    codex(input){
      assert.equal(input.role,'reviewer');
      return{run:async()=>{
        reviewerRuns++;
        const sessionId='OFFLINE_DOC_CHILD_REVIEWER',requestId='OFFLINE_DOC_CHILD_REVIEWER_REQUEST';
        x.h.store.event(x.p.id,x.child.id,'agent.event',{method:'dm/codexAdmission',params:{role:'reviewer',threadId:sessionId,model:x.h.config.codex.model,provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',includedUsageAllowed:true,paidFallback:false,permissionProfile:'dream-maker-supervisor-data',policyHash:'c'.repeat(64)}});
        const output={
          text:JSON.stringify(missingCoverage?{verdict:'PASS',findings:[]}:offlinePreworkReview(x.h,x.child.id)),
          model:x.h.config.codex.model,
          sessionId,
          identity:{runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:x.h.config.codex.model},
          usage:{role:'reviewer',requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
        x.h.store.event(x.p.id,x.child.id,'agent.event',{method:'dm/codexCompletion',params:{role:'reviewer',threadId:sessionId,turnId:requestId,status:'completed',model:x.h.config.codex.model,provider:'openai',runId:x.child.id,specHash:x.child.specHash}});
        return output;
      }};
    },
    async verify(input){
      const sourceHash=treeHash(input.workspace);
      const raw={
        schema:'dream-maker.trusted-cli-evidence.v1',
        specHash:x.child.specHash,
        sourceHash,
        planHash,
        planText,
        ok:true,
        cases:[{
          id:caseDefinition.id,
          requirementIds:caseDefinition.requirementIds,
          ok:true,
          expectedExitCode:0,
          actualExitCode:0,
          outputMatched:true,
          diagnosticMatched:true,
          stdinHash:hash(caseDefinition.stdin),
          sourceHash,
          workerHash:'b'.repeat(64),
          jobId:'OFFLINE_DOC_VERIFIER_JOB',
          status:'EXECUTED',
          command:['/usr/bin/node','/workspace/main.mjs','--help'],
          stdout:'Usage\n',
          stderr:'',
          stderrTail:'',
          fixtureCount:0,
        }],
      };
      return{
        command:['dream-maker-controller-cli-oracle',x.child.specHash,planHash],
        stdout:JSON.stringify(raw),
        stderr:'',
        exitCode:0,
      };
    },
    async close(){},
  };
  await x.h.engine.resume(x.child.id);
  await x.h.engine.settled(x.child.id);
  const final=x.h.store.run(x.child.id);
  assert.equal(executorRuns,1);
  assert.equal(reviewerRuns,1);
  if(missingCoverage){
    assert.equal(final.state,'BLOCKED');assert.equal(final.reason,'PREWORK_REVIEW_COVERAGE_REQUIRED');
    assert.ok(final.tasks.every(task=>task.status==='implemented'));
    assert.equal(x.h.store.records(x.p.id,'PreworkCloseout').filter(row=>row.runId===final.id).length,0);
    assert.equal(x.h.store.owns(x.p.id,final.id),true);return;
  }
  assert.equal(final.state,'READY_FOR_DELIVERY',JSON.stringify({reason:final.reason,phase:final.phase}));
  assert.equal(final.calls,2);
  assert.equal(final.repairCount,1);
  assert.equal(final.tasks.find(task=>task.id==='OFFLINE_MAIN').status,'done');
  assert.equal(final.tasks.find(task=>task.id==='OFFLINE_DOC').status,'done');
  assert.equal(final.review.verdict,'PASS');
  assert.equal(final.sessions.planner2,undefined);
  assert.notEqual(final.sessions.reviewer,x.r.sessions.planner2);
  assert.notEqual(final.sessions.reviewer,x.r.sessions.reviewer);
  assert.equal(x.h.store.records(x.p.id,'AgentSession').filter(row=>row.runId===x.child.id&&row.data.role==='planner2').length,0);
  assert.equal(x.h.engine.flowReport(x.child.id).targetRolesMet,true);
  const accepted=x.h.engine.accept(x.child.id);
  assert.equal(accepted.state,'ACCEPTED');
});

test('inherited legacy task without a write scope remains baseline-only and cannot acquire permissions',async t=>{
 const x=await prepared(t,{legacyMainScope:true}),r=x.h.store.run(x.child.id),c=readPrework(x.h.store,r);
 const carried=c.workPackages.find(w=>w.taskId==='OFFLINE_MAIN');
 assert.equal(carried.inheritedBaseline,true);
 assert.deepEqual(carried.writePaths,[]);assert.deepEqual(carried.outputs,[]);assert.deepEqual(carried.requirementIds,[]);
 assert.equal(carried.resourceClaims.executorSlots,0);assert.equal(carried.resourceClaims.maxConcurrentTools,0);
 assert.equal(r.tasks.find(task=>task.id==='OFFLINE_MAIN').writePaths,undefined);
 assert.throws(()=>assertPreworkDispatch(x.h.store,r,'OFFLINE_MAIN'),{code:'PREWORK_CARRIED_TASK_NOT_DISPATCHABLE'});
 assert.deepEqual(assertPreworkDispatch(x.h.store,r).packages.map(w=>w.taskId),['OFFLINE_DOC']);
});