import {offlinePreworkReview} from '../fixtures/offline-prework-review.mjs';
// Isolated original Engine/Store/workspaces. Every role here is explicitly OFFLINE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {documentationCorrectionFixture} from '../fixtures/documentation-correction.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {DomainError,hash} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {buildReviewPacket} from '../../dist/server/review-packet.js';
import {
  assertDocumentationProtectedFiles,
  completedDocumentationEngineeringRoles,
  documentationPreparedEvidence,
  inheritedDocumentationPlanning,
} from '../../dist/server/documentation-continuation.js';
import {
  validateVerifierPlan,
  verifierCaseEvidence,
} from '../../dist/server/wsl-verifier.js';

const actor='local-session:'+'a'.repeat(64);

async function baseFixture(t){
  const x=await documentationCorrectionFixture(t,{includeMainTask:true});
  const original=x.h.store.run(x.r.id);
  const reviewRecord=x.h.store.records(x.p.id,'Review').at(-1);
  assert.ok(reviewRecord);
  const finding={
    ...original.review.findings[0],
    id:'M117_F1',
    description:'Malformed JSON reports the beginning instead of the truncated end.',
    evidence:'main.mjs:61-101',
  };
  original.review={...original.review,findings:[finding]};
  original.findings=[finding];
  original.calls=11;
  original.maxCalls=13;
  x.h.store.saveRun(original);
  const ownerReviewRecordId=x.h.store.record('Review',x.p.id,original.id,{
    ...reviewRecord.data,
    verdict:original.review.verdict,
    source:original.review.source,
    treeHash:original.review.treeHash,
    findings:original.review.findings,
  });
  const r=x.h.store.run(original.id);
  const ownerApproval={
    schema:'dream-maker.owner-bounded-code-repair-approval.v1',
    approvedBy:'USER',
    approvedAt:'2026-11-08T00:00:00.000Z',
    sourceRef:'OFFLINE_M117_OWNER_AUTHORIZATION',
    statement:'Authorize one code repair and one fresh independent review.',
    projectId:r.projectId,
    runId:r.id,
    specHash:r.specHash,
    sourceHash:r.treeHash,
    reviewRecordId:ownerReviewRecordId,
    file:'main.mjs',
    dshRepairTurns:1,
    reviewerReviews:1,
    maxRepairs:1,
    noAdditionalPlanning:true,
    freshIndependentReviewer:true,
  };
  return {...x,r,ownerApproval};
}

async function fixture(t){
  const x=await baseFixture(t);
  await x.h.engine.registerBoundedCodeRepairAuthorization(x.r.id,{
    confirmed:true,
    file:'main.mjs',
    ownerApproval:x.ownerApproval,
  },actor);
  const candidate=x.h.engine.boundedCodeRepairCandidate(x.r.id,'main.mjs');
  return {
    ...x,
    candidate,
    input:{
      confirmed:true,
      file:'main.mjs',
      candidateHash:candidate.candidateHash,
      taskDeadline:null,
    },
  };
}

function trustedVerifierResult(x,workspace){
  const currentSpec=x.h.store.spec(x.r.specId),requirements=currentSpec.requirements.map(item=>item.id);
  const definitions=Array.from({length:20},(_,index)=>({
    id:'M117_CASE_'+(index+1),
    requirementIds:[requirements[index%requirements.length]],
    runtime:'node',
    entry:'main.mjs',
    args:[],
    stdin:'',
    expectedExitCode:0,
    expectedStdout:'OK\n',
    expectedStderr:'',
  }));
  const planText=JSON.stringify({
    schema:'dream-maker.cli-verifier.v1',
    specHash:x.r.specHash,
    cases:definitions,
  });
  const plan=validateVerifierPlan(JSON.parse(planText),x.r.specHash,requirements);
  const sourceHash=treeHash(workspace);
  const raw={
    schema:'dream-maker.trusted-cli-evidence.v2',
    specHash:x.r.specHash,
    sourceHash,
    planHash:hash(planText),
    planText,
    ok:true,
    cases:plan.cases.map((definition,index)=>({
      id:definition.id,
      requirementIds:definition.requirementIds,
      ok:true,
      expectedExitCode:0,
      actualExitCode:0,
      outputMatched:true,
      diagnosticMatched:true,
      stdinHash:hash(definition.stdin),
      sourceHash,
      workerHash:'b'.repeat(64),
      jobId:'M117_OFFLINE_VERIFIER_JOB_'+(index+1),
      status:'EXECUTED',
      command:['/usr/bin/node','/workspace/main.mjs'],
      stdout:'OK\n',
      stderr:'',
      stderrTail:'',
      fixtureCount:0,
      ...verifierCaseEvidence(definition),
    })),
  };
  x.h.store.record('VerifierApproval',x.p.id,null,{
    specHash:x.r.specHash,
    planHash:raw.planHash,
    source:'OFFLINE_M117_FIXED_ORACLE',
  });
  return {
    command:['dream-maker-controller-cli-oracle',x.r.specHash,hash(planText)],
    stdout:JSON.stringify(raw),
    stderr:'',
    exitCode:0,
  };
}

function trustedVerifierFailureResult(x,workspace){
  const currentSpec=x.h.store.spec(x.r.specId),requirements=currentSpec.requirements.map(item=>item.id);
  const definitions=Array.from({length:20},(_,index)=>({
    id:index===15?'C16_MALFORMED_JSON':'M120_CASE_'+(index+1),
    requirementIds:[requirements[index%requirements.length]],
    runtime:'node',
    entry:'main.mjs',
    args:[],
    stdin:'',
    expectedExitCode:0,
    expectedStdout:'OK\n',
    expectedStderr:'',
  }));
  const planText=JSON.stringify({
    schema:'dream-maker.cli-verifier.v1',
    specHash:x.r.specHash,
    cases:definitions,
  });
  const plan=validateVerifierPlan(JSON.parse(planText),x.r.specHash,requirements);
  const sourceHash=treeHash(workspace);
  x.h.store.record('VerifierApproval',x.p.id,null,{
    specHash:x.r.specHash,
    planHash:hash(planText),
    source:'OFFLINE_M120_FAILED_VERIFIER_PLAN',
  });
  const cases=plan.cases.map((definition,index)=>{
    const failed=index===15;
    return{
      id:definition.id,
      requirementIds:definition.requirementIds,
      ok:!failed,
      expectedExitCode:definition.expectedExitCode,
      actualExitCode:failed?1:0,
      outputMatched:true,
      diagnosticMatched:!failed,
      stdinHash:hash(definition.stdin),
      sourceHash,
      workerHash:'b'.repeat(64),
      jobId:'M120_OFFLINE_VERIFIER_JOB_'+(index+1),
      status:'EXECUTED',
      command:['/usr/bin/node','/workspace/main.mjs'],
      stdout:'OK\n',
      stderr:failed?'C16 invalid JSON location mismatch\n':'',
      stderrTail:failed?'C16 invalid JSON location mismatch\n':'',
      fixtureCount:0,
      ...verifierCaseEvidence(definition),
    };
  });
  return{
    command:['dream-maker-controller-cli-oracle',x.r.specHash,hash(planText)],
    stdout:JSON.stringify({
      schema:'dream-maker.trusted-cli-evidence.v2',
      specHash:x.r.specHash,
      sourceHash,
      planHash:hash(planText),
      planText,
      ok:false,
      cases,
    }),
    stderr:'C16_MALFORMED_JSON failed',
    exitCode:1,
  };
}

function reviewerUsageBlocked(x){
  return{
    run:async()=>{
      const grant=x.h.store.records(x.p.id,'DispatchGranted')
        .filter(row=>row.runId===x.child.id&&row.data.kind==='reviewer').at(-1);
      assert.ok(grant,'reviewer dispatch must be granted before the account gate');
      for(const method of ['initialize','account/read','account/rateLimits/read']){
        x.h.store.event(x.p.id,x.child.id,'agent.event',{
          method:'dm/codexPreparation',
          params:{role:'reviewer',method,status:'STARTED',timeoutMs:30000},
        });
        x.h.store.event(x.p.id,x.child.id,'agent.event',{
          method:'dm/codexPreparation',
          params:{role:'reviewer',method,status:'COMPLETED',elapsedMs:1},
        });
      }
      const processId='M126_OFFLINE_REVIEWER_PROCESS';
      const jobId='windows_job_'+'a'.repeat(20),markerSha256='b'.repeat(64),
        helperSha256='c'.repeat(64),receiptSha256='d'.repeat(64);
      x.h.store.record('OwnedProcessIntent',x.p.id,x.child.id,{
        processId,platform:'win32',dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      x.h.store.record('OwnedProcessRootStarted',x.p.id,x.child.id,{
        processId,platform:'win32',identityState:'OS_START_IDENTITY',
        dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      x.h.store.record('OwnedWindowsJobIntent',x.p.id,x.child.id,{
        processId,jobId,markerSha256,helperSha256,
        dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      x.h.store.record('OwnedWindowsJobPinned',x.p.id,x.child.id,{
        processId,jobId,markerSha256,helperSha256,
        dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      x.h.store.record('OwnedProcessRootExited',x.p.id,x.child.id,{
        processId,platform:'win32',rootClosed:true,
        dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      x.h.store.record('OwnedWindowsJobClosed',x.p.id,x.child.id,{
        processId,jobId,markerSha256,helperSha256,activeProcesses:0,
        proof:{kind:'TRUSTED_WINDOWS_JOB',scopeId:jobId,receiptSha256},
        dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      x.h.store.record('OwnedProcessCleanup',x.p.id,x.child.id,{
        processId,kind:'TRUSTED_WINDOWS_JOB',scopeId:jobId,receiptSha256,cleanupReturned:true,
        dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      throw new DomainError('CODEX_INCLUDED_USAGE_UNAVAILABLE',409);
    },
  };
}

function reviewerPass(x,child){
  return{
    run:async()=>{
      const grant=x.h.store.records(x.p.id,'DispatchGranted')
        .filter(row=>row.runId===child.id&&row.data.kind==='reviewer').at(-1);
      assert.ok(grant);
      const processId='M126_OFFLINE_FRESH_REVIEWER_PROCESS';
      x.h.store.record('OwnedProcessIntent',x.p.id,child.id,{
        processId,platform:'win32',dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      x.h.store.record('OwnedWindowsJobIntent',x.p.id,child.id,{
        processId,dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      x.h.store.record('OwnedWindowsJobPinned',x.p.id,child.id,{
        processId,dispatchId:grant.data.dispatchId,generation:grant.data.generation,
      });
      x.h.store.record('OwnedWindowsJobClosed',x.p.id,child.id,{
        processId,dispatchId:grant.data.dispatchId,generation:grant.data.generation,cleanupReturned:true,
      });
      x.h.store.record('OwnedProcessCleanup',x.p.id,child.id,{
        processId,dispatchId:grant.data.dispatchId,generation:grant.data.generation,cleanupReturned:true,
      });
      return{
        text:JSON.stringify(offlinePreworkReview(x.h,child.id)),
        model:x.h.config.codex.model,sessionId:'M126_OFFLINE_FRESH_REVIEWER_SESSION',
        identity:{runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:x.h.config.codex.model},
        usage:{role:'reviewer',requestId:'M126_OFFLINE_FRESH_REVIEWER_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
      };
    },
  };
}

async function reviewerUsageBlockFixture(t){
  const x=await fixture(t),child=await x.h.engine.approveBoundedCodeRepair(x.r.id,x.input,actor);
  fixedControllerCapacity(x.h.engine);
  x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
  x.h.engine.executorSegmented=()=>{throw new Error('M126_SEGMENTED_EXECUTION_FORBIDDEN');};
  let revision=0,executorRuns=0,verifyRuns=0;
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(runId){assert.equal(runId,child.id);revision++;},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        const source=treeHash(input.workspace);
        const intentId=x.h.store.record('ToolIntent',x.p.id,child.id,{
          tool:'desk_write',specHash:child.specHash,sourceHash:source,
          sliceId:input.executorSliceId,requestHash:hash('M126_REPAIR_'+executorRuns),
        });
        writeFileSync(join(input.workspace,'main.mjs'),executorRuns===1
          ?'// M126 FIRST REPAIR STILL HAS NESTED JSON POSITION BUG\n'
          :'// M126 SECOND REPAIR FIXES NESTED JSON POSITION\n');
        x.h.store.record('ToolResult',x.p.id,child.id,{
          intentId,tool:'desk_write',specHash:child.specHash,sourceHash:treeHash(input.workspace),
          sliceId:input.executorSliceId,status:'COMPLETE',responseHash:hash('M126_RESULT_'+executorRuns),
        });
        x.h.store.record('NativeBudgetReceipt',x.p.id,child.id,{
          method:'dm/budget',
          params:{requests:[{
            observedModel:x.h.config.dsh.model,
            outcome:'COMPLETE',
            completionObserved:true,
            responseModelMatched:true,
          }]},
        });
        return{
          text:'Offline repair attempt '+executorRuns,
          model:x.h.config.dsh.model,sessionId:'M126_OFFLINE_DSH_SESSION_'+executorRuns,
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M126_OFFLINE_DSH_REQUEST_'+executorRuns,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){
      verifyRuns++;
      return verifyRuns===1?trustedVerifierResult(x,input.workspace):trustedVerifierResult(x,input.workspace);
    },
    codex(){x.child=child;return reviewerUsageBlocked(x);},
    async close(){},
  };
  await x.h.engine.resume(child.id);
  await x.h.engine.settled(child.id);
  const failed=x.h.store.run(child.id);
  assert.equal(failed.state,'BLOCKED');
  assert.equal(failed.phase,'REVIEWING');
  assert.equal(failed.reason,'CODEX_INCLUDED_USAGE_UNAVAILABLE');
  assert.equal(failed.calls,2);
  assert.equal(failed.maxCalls,2);
  return{...x,child:failed,request:{
    confirmed:true,
    expectedVersion:failed.version,
    sourceHash:failed.treeHash,
    verificationEvidenceId:failed.verification.evidenceId,
    reviewPacketId:x.h.store.records(x.p.id,'ReviewPacket').filter(row=>row.runId===child.id).at(-1).id,
    ownerDecisionHash:'a'.repeat(64),
  }};
}

test('M117 code repair requires the exact owner authorization record',async t=>{
  const x=await baseFixture(t);
  assert.throws(()=>x.h.engine.boundedCodeRepairCandidate(x.r.id,'main.mjs'),{
    code:'BOUNDED_CODE_REPAIR_AUTHORIZATION_REQUIRED',
  });
  const authorization=await x.h.engine.registerBoundedCodeRepairAuthorization(x.r.id,{
    confirmed:true,
    file:'main.mjs',
    ownerApproval:x.ownerApproval,
  },actor);
  assert.equal(authorization.schema,'dream-maker.bounded-code-repair-authorization.v1');
  assert.equal(authorization.file,'main.mjs');
  assert.equal(authorization.dshRepairTurns,1);
  assert.equal(authorization.reviewerReviews,1);
  assert.equal(authorization.candidateBaseHash.length,64);
  const candidate=x.h.engine.boundedCodeRepairCandidate(x.r.id,'main.mjs');
  assert.equal(candidate.authorization.recordId,authorization.recordId);
  assert.equal(candidate.authorization.sha256,authorization.sha256);
});

test('M117 authorization rejects a changed owner binding and cannot be replayed with different evidence',async t=>{
  const x=await baseFixture(t);
  await assert.rejects(x.h.engine.registerBoundedCodeRepairAuthorization(x.r.id,{
    confirmed:true,
    file:'main.mjs',
    ownerApproval:{...x.ownerApproval,sourceHash:'0'.repeat(64)},
  },actor),{code:'BOUNDED_CODE_REPAIR_AUTHORIZATION_INVALID'});
  await x.h.engine.registerBoundedCodeRepairAuthorization(x.r.id,{
    confirmed:true,
    file:'main.mjs',
    ownerApproval:x.ownerApproval,
  },actor);
  await assert.rejects(x.h.engine.registerBoundedCodeRepairAuthorization(x.r.id,{
    confirmed:true,
    file:'main.mjs',
    ownerApproval:{...x.ownerApproval,statement:'A different scope.'},
  },actor),{code:'BOUNDED_CODE_REPAIR_AUTHORIZATION_CHANGED'});
});

test('M117 candidate is a distinct read-only main.mjs scope and inherits the one approved repair',async t=>{
  const x=await fixture(t),before=hash(x.r),count=x.h.store.db.prepare('SELECT count(*) n FROM records').get().n;
  assert.equal(x.candidate.schema,'dream-maker.bounded-code-repair-candidate.v1');
  assert.equal(x.candidate.repairKind,'CODE');
  assert.deepEqual(x.candidate.writePaths,['main.mjs']);
  assert.equal(x.candidate.taskId,'OFFLINE_MAIN');
  assert.equal(x.candidate.parentCalls,11);
  assert.equal(x.candidate.additionalCalls,2);
  assert.equal(x.candidate.additionalRepairRounds,1);
  assert.equal(x.candidate.executionGranted,false);
  assert.equal(hash(x.h.store.run(x.r.id)),before);
  assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM records').get().n,count);
  assert.throws(()=>x.h.engine.documentationCorrectionCandidate(x.r.id,'main.mjs'),{
    code:'DOCUMENTATION_CORRECTION_UNAVAILABLE',
  });
});

test('M117 refuses README, broader code scopes, changed evidence and an exhausted parent counter',async t=>{
  const x=await fixture(t);
  for(const path of ['README.md','src/main.mjs','package.json'])assert.throws(
    ()=>x.h.engine.boundedCodeRepairCandidate(x.r.id,path),
    {code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'},
  );
  const changed=x.h.store.run(x.r.id);
  changed.review={...changed.review,findings:[{...changed.review.findings[0],evidence:'README.md'}]};
  x.h.store.saveRun(changed);
  assert.throws(()=>x.h.engine.boundedCodeRepairCandidate(x.r.id,'main.mjs'),{
    code:'DOCUMENTATION_CORRECTION_UNAVAILABLE',
  });
  changed.review=x.r.review;
  changed.calls=14;
  x.h.store.saveRun(changed);
  assert.throws(()=>x.h.engine.boundedCodeRepairCandidate(x.r.id,'main.mjs'),{
    code:'DOCUMENTATION_CORRECTION_UNAVAILABLE',
  });
});

test('M117 approval creates one paused successor with only T1 pending and no new planner',async t=>{
  const x=await fixture(t),child=await x.h.engine.approveBoundedCodeRepair(x.r.id,x.input,actor);
  assert.equal(child.state,'PAUSED');
  assert.equal(child.phase,'IMPLEMENTING');
  assert.equal(child.reason,'BOUNDED_CODE_REPAIR_PREPARED');
  assert.equal(child.calls,0);
  assert.equal(child.maxCalls,2);
  assert.equal(child.repairCount,0);
  assert.equal(child.maxRepairs,1);
  assert.equal(child.treeHash,x.r.treeHash);
  assert.deepEqual(child.plan,x.r.plan);
  assert.equal(child.sessions.planner2,undefined);
  assert.equal(child.roleIdentities?.planner2,undefined);
  assert.equal(x.h.store.records(x.p.id,'Plan').filter(row=>row.runId===child.id).length,0);
  assert.deepEqual(child.tasks.filter(task=>task.status==='pending').map(task=>task.id),['OFFLINE_MAIN']);
  assert.deepEqual(child.tasks.find(task=>task.id==='OFFLINE_DOC').inheritedFrom,{
    runId:x.r.id,
    taskId:'OFFLINE_DOC',
  });
  const approval=documentationPreparedEvidence(x.h.store,child);
  assert.equal(approval.repairKind,'CODE');
  assert.equal(approval.schema,'dream-maker.bounded-code-repair-continuation.v1');
  assert.doesNotThrow(()=>assertDocumentationProtectedFiles(x.h.store,child));
  assert.match(readFileSync(join(child.workspace,'main.mjs'),'utf8'),/OFFLINE|main|stdin/i);
});

test('M117 paused code successor can approve only its exact verifier plan without losing custody',async t=>{
  const x=await fixture(t),child=await x.h.engine.approveBoundedCodeRepair(x.r.id,x.input,actor);
  const verifierPlan={schema:'dream-maker.cli-verifier.v1',specHash:child.specHash,cases:[]};
  const planHash=hash(verifierPlan);
  x.h.engine.nativeExecution={
    assertReady(){},
    executor(){throw new Error('M117_OFFLINE_EXECUTOR_MUST_NOT_RUN');},
    async verify(){throw new Error('M117_OFFLINE_VERIFIER_MUST_NOT_RUN');},
    verifierPlan(){return{sha256:planHash,plan:verifierPlan};},
    async close(){},
  };
  const childBefore=hash(x.h.store.run(child.id));
  const leaseBefore=x.h.store.db.prepare('SELECT project_id,run_id FROM workspace_leases WHERE project_id=?').all(x.p.id);
  assert.equal(leaseBefore.length,1);
  assert.equal(leaseBefore[0].run_id,child.id);

  const approval=x.h.engine.approveVerifier(x.p.id,child.specHash,planHash,true);
  assert.deepEqual(approval,{specHash:child.specHash,planHash,approved:true});
  assert.equal(hash(x.h.store.run(child.id)),childBefore);
  assert.deepEqual(x.h.store.db.prepare('SELECT project_id,run_id FROM workspace_leases WHERE project_id=?').all(x.p.id),leaseBefore);
  assert.equal(x.h.store.approved(x.p.id,child.specHash,'VERIFIER'),true);
  assert.deepEqual(x.h.store.records(x.p.id,'VerifierApproval').at(-1).data,{
    specHash:child.specHash,
    planHash,
    source:'EXPLICIT_LOCAL_SESSION_ACTION',
  });

  const recordsBefore=x.h.store.db.prepare('SELECT count(*) n FROM records').get().n;
  assert.throws(()=>x.h.engine.approveVerifier(x.p.id,child.specHash,hash('M117_OTHER_PLAN'),true),{
    code:'TRUSTED_VERIFIER_PLAN_CHANGED',
  });
  assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM records').get().n,recordsBefore);

  const ordinary=x.h.store.run(child.id);
  ordinary.state='IMPLEMENTING';
  ordinary.reason='M117_OFFLINE_ORDINARY_ACTIVE_RUN';
  x.h.store.saveRun(ordinary);
  const ordinaryBefore=hash(x.h.store.run(child.id));
  assert.throws(()=>x.h.engine.approveVerifier(x.p.id,child.specHash,planHash,true),{
    code:'WORKSPACE_BUSY',
  });
  assert.equal(hash(x.h.store.run(child.id)),ordinaryBefore);
  assert.deepEqual(x.h.store.db.prepare('SELECT project_id,run_id FROM workspace_leases WHERE project_id=?').all(x.p.id),leaseBefore);
});

test('M117 preparation is replay-safe and cannot switch to the documentation route',async t=>{
  const x=await fixture(t),first=await x.h.engine.approveBoundedCodeRepair(x.r.id,x.input,actor);
  const replay=await x.h.engine.approveBoundedCodeRepair(x.r.id,x.input,actor);
  assert.equal(replay.id,first.id);
  await assert.rejects(
    x.h.engine.approveDocumentationContinuation(x.r.id,{
      confirmed:true,file:'README.md',candidateHash:'0'.repeat(64),taskDeadline:null,
    },actor),
    {code:'DOCUMENTATION_CONTINUATION_CHANGED'},
  );
  assert.equal(x.h.store.runs(x.p.id).length,2);
});

test('M117 executes one DSH turn, reruns the trusted verifier and uses one fresh reviewer',async t=>{
  const x=await fixture(t),child=await x.h.engine.approveBoundedCodeRepair(x.r.id,x.input,actor);
  fixedControllerCapacity(x.h.engine);
  x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
  let revision=0,reserves=0,executorRuns=0,verifyRuns=0,reviewerRuns=0;
  const readmeBefore=readFileSync(join(child.workspace,'README.md'));
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(runId){assert.equal(runId,child.id);reserves++;revision++;},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        const source=treeHash(input.workspace);
        const intentId=x.h.store.record('ToolIntent',x.p.id,child.id,{
          tool:'desk_write',
          specHash:child.specHash,
          sourceHash:source,
          sliceId:input.executorSliceId,
          requestHash:hash('M117_OFFLINE_MAIN_WRITE'),
        });
        writeFileSync(join(input.workspace,'main.mjs'),'// M117 OFFLINE JSON POSITION REPAIR\n');
        x.h.store.record('ToolResult',x.p.id,child.id,{
          intentId,
          tool:'desk_write',
          specHash:child.specHash,
          sourceHash:treeHash(input.workspace),
          sliceId:input.executorSliceId,
          status:'COMPLETE',
          responseHash:hash('M117_OFFLINE_MAIN_RESULT'),
        });
        x.h.store.record('NativeBudgetReceipt',x.p.id,child.id,{
          method:'dm/budget',
          params:{requests:[{
            id:'M117_OFFLINE_DSH_BUDGET',
            observedModel:x.h.config.dsh.model,
            outcome:'COMPLETE',
            completionObserved:true,
            responseModelMatched:true,
            usage:null,
          }]},
        });
        return{
          text:'Malformed JSON position repaired.',
          model:x.h.config.dsh.model,
          sessionId:'M117_OFFLINE_DSH_SESSION',
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M117_OFFLINE_DSH_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){
      verifyRuns++;
      return trustedVerifierResult(x,input.workspace);
    },
    codex(){
      return{run:async()=>{
        reviewerRuns++;
        const grant=x.h.store.records(x.p.id,'DispatchGranted')
          .filter(row=>row.runId===child.id&&row.data.kind==='reviewer').at(-1);
        assert.ok(grant);
        const processId='M117_OFFLINE_NEW_REVIEWER_PROCESS';
        x.h.store.record('OwnedProcessIntent',x.p.id,child.id,{
          processId,
          platform:'win32',
          dispatchId:grant.data.dispatchId,
          generation:grant.data.generation,
        });
        x.h.store.record('OwnedProcessCleanup',x.p.id,child.id,{
          processId,
          dispatchId:grant.data.dispatchId,
          generation:grant.data.generation,
          cleanupReturned:true,
        });
        return{
          text:JSON.stringify(offlinePreworkReview(x.h,child.id)),
          model:x.h.config.codex.model,
          sessionId:'M117_OFFLINE_NEW_REVIEWER_SESSION',
          identity:{runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:x.h.config.codex.model},
          usage:{role:'reviewer',requestId:'M117_OFFLINE_NEW_REVIEWER_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async close(){},
  };
  x.h.engine.executorSegmented=()=>{throw new Error('M117_SEGMENTED_EXECUTION_FORBIDDEN');};
  const resumed=await x.h.engine.resume(child.id);
  assert.equal(resumed.state,'IMPLEMENTING');
  assert.equal(resumed.repairCount,1);
  await x.h.engine.settled(child.id);
  const final=x.h.store.run(child.id);
  assert.equal(reserves,1);
  assert.equal(executorRuns,1);
  assert.equal(verifyRuns,1);
  assert.equal(reviewerRuns,1,JSON.stringify({state:final.state,phase:final.phase,reason:final.reason,verification:final.verification?.ok}));
  assert.equal(final.calls,2);
  assert.equal(final.state,'READY_FOR_DELIVERY');
  assert.equal(final.review.verdict,'PASS');
  assert.equal(final.review.treeHash,final.treeHash);
  assert.equal(final.sessions.reviewer,'M117_OFFLINE_NEW_REVIEWER_SESSION');
  assert.notEqual(final.sessions.reviewer,x.r.sessions.reviewer);
  assert.equal(new Set([
    x.r.sessions.planner2,
    x.r.sessions.executor,
    x.r.sessions.reviewer,
    final.sessions.executor,
    final.sessions.reviewer,
  ]).size,5);
  assert.match(readFileSync(join(final.workspace,'main.mjs'),'utf8'),/M117 OFFLINE JSON POSITION REPAIR/);
  assert.deepEqual(readFileSync(join(final.workspace,'README.md')),readmeBefore);
  const runs=x.h.store.runs(x.p.id).length;
  assert.throws(()=>x.h.engine.boundedCodeRepairCandidate(x.r.id,'main.mjs'),{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
  assert.equal(x.h.store.runs(x.p.id).length,runs);
  assert.equal(executorRuns,1);
  assert.equal(reviewerRuns,1,JSON.stringify({state:final.state,phase:final.phase,reason:final.reason,calls:final.calls,verification:final.verification?.ok,review:final.review}));
  await assert.rejects(x.h.engine.resume(child.id),{code:'RUN_NOT_RESUMABLE'});

  await t.test('M118 a reviewed bounded successor can receive one fresh owner-authorized successor',async()=>{
    const sourceHash=final.treeHash;
    const finding={
      id:'M118_F1',
      severity:'medium',
      description:'A deeply nested malformed JSON document still reports the wrong location.',
      evidence:'main.mjs:198-200',
      status:'open',
    };
    const passReview=x.h.store.records(x.p.id,'Review').at(-1);
    const reviewRecordId=x.h.store.record('Review',x.p.id,child.id,{
      ...passReview.data,
      verdict:'CHANGES_REQUESTED',
      treeHash:sourceHash,
      findings:[finding],
    });
    const blocked=x.h.store.run(child.id);
    blocked.state='BLOCKED';
    blocked.phase='REVIEWING';
    blocked.reason='BOUNDED_CODE_REPAIR_REVIEW_CHANGES_REQUESTED';
    blocked.calls=2;
    blocked.maxCalls=2;
    blocked.repairCount=1;
    blocked.maxRepairs=1;
    blocked.findings=[finding];
    blocked.review={
      verdict:'CHANGES_REQUESTED',
      source:'CODEX',
      treeHash:sourceHash,
      findings:[finding],
    };
    x.h.store.saveRun(blocked);
    const reviewer=blocked.roleIdentities.reviewer;
    const completionCount=x.h.store.db.prepare(
      "SELECT count(*) n FROM events WHERE project_id=? AND run_id=? AND type='agent.event' "+
      "AND json_extract(payload,'$.method')='dm/codexCompletion' "+
      "AND json_extract(payload,'$.params.threadId')=? AND json_extract(payload,'$.params.turnId')=?",
    ).get(x.p.id,child.id,reviewer.sessionId,reviewer.requestId).n;
    assert.equal(completionCount,0);
    x.h.store.event(x.p.id,child.id,'agent.event',{
      method:'dm/codexCompletion',
      params:{
        role:'reviewer',
        threadId:reviewer.sessionId,
        turnId:reviewer.requestId,
        status:'completed',
        model:reviewer.model,
        provider:reviewer.provider,
        runId:child.id,
        specHash:blocked.specHash,
      },
    });

    assert.throws(
      ()=>x.h.engine.boundedCodeRepairCandidate(child.id,'main.mjs'),
      {code:'BOUNDED_CODE_REPAIR_AUTHORIZATION_REQUIRED'},
    );
    const ownerApproval={
      schema:'dream-maker.owner-bounded-code-repair-approval.v1',
      approvedBy:'USER',
      approvedAt:new Date().toISOString(),
      sourceRef:'OFFLINE_M118_OWNER_AUTHORIZATION',
      statement:'Authorize one fresh DSH repair and one independent Codex review.',
      projectId:x.p.id,
      runId:child.id,
      specHash:blocked.specHash,
      sourceHash,
      reviewRecordId,
      file:'main.mjs',
      dshRepairTurns:1,
      reviewerReviews:1,
      maxRepairs:1,
      noAdditionalPlanning:true,
      freshIndependentReviewer:true,
    };
    const freshActor='local-session:'+'c'.repeat(64);
    const authorization=await x.h.engine.registerBoundedCodeRepairAuthorization(
      child.id,
      {confirmed:true,file:'main.mjs',ownerApproval},
      freshActor,
    );
    const candidate=x.h.engine.boundedCodeRepairCandidate(child.id,'main.mjs');
    assert.equal(candidate.reviewRecordId,reviewRecordId);
    assert.equal(candidate.sourceHash,sourceHash);
    assert.equal(candidate.authorization.recordId,authorization.recordId);
    const grandchild=await x.h.engine.approveBoundedCodeRepair(child.id,{
      confirmed:true,
      file:'main.mjs',
      candidateHash:candidate.candidateHash,
      taskDeadline:null,
    },freshActor);
    assert.notEqual(grandchild.id,child.id);
    assert.equal(grandchild.state,'PAUSED');
    assert.equal(grandchild.treeHash,sourceHash);
    assert.deepEqual(
      grandchild.tasks.filter(task=>task.status==='pending').map(task=>task.id),
      ['OFFLINE_MAIN'],
    );
    const approval=documentationPreparedEvidence(x.h.store,grandchild);
    assert.equal(approval.parentRunId,child.id);
    assert.equal(approval.repairKind,'CODE');
    assert.equal(approval.additionalRepairs,1);
    const planning=inheritedDocumentationPlanning(x.h.store,grandchild);
    assert.equal(planning.parentRunId,child.id);
    assert.equal(planning.planner.identity.sessionId,x.r.sessions.planner2);
  });
});

test('M117 verifier failure stops after the one authorized DSH turn without another dispatch',async t=>{
  const x=await fixture(t),child=await x.h.engine.approveBoundedCodeRepair(x.r.id,x.input,actor);
  fixedControllerCapacity(x.h.engine);
  x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
  let revision=0,executorRuns=0,verifyRuns=0;
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){revision++;},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        const source=treeHash(input.workspace);
        const intentId=x.h.store.record('ToolIntent',x.p.id,child.id,{
          tool:'desk_write',specHash:child.specHash,sourceHash:source,
          sliceId:input.executorSliceId,requestHash:hash('M117_FAILURE_WRITE'),
        });
        writeFileSync(join(input.workspace,'main.mjs'),'// M117 OFFLINE FAILED REPAIR\n');
        x.h.store.record('ToolResult',x.p.id,child.id,{
          intentId,tool:'desk_write',specHash:child.specHash,sourceHash:treeHash(input.workspace),
          sliceId:input.executorSliceId,status:'COMPLETE',responseHash:hash('M117_FAILURE_RESULT'),
        });
        return{
          text:'Repair made.',model:x.h.config.dsh.model,sessionId:'M117_FAILURE_DSH_SESSION',
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M117_FAILURE_DSH_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(){
      verifyRuns++;
      return{command:['dream-maker-controller-cli-oracle','OFFLINE_SPEC','OFFLINE_ORACLE'],stdout:'',stderr:'case C16 failed',exitCode:1};
    },
    codex(){throw new Error('M117_REVIEWER_MUST_NOT_RUN');},
    async close(){},
  };
  await x.h.engine.resume(child.id);
  await x.h.engine.settled(child.id);
  const final=x.h.store.run(child.id);
  assert.equal(executorRuns,1);
  assert.equal(verifyRuns,1);
  assert.equal(final.calls,1);
  assert.equal(final.state,'BLOCKED');
  assert.equal(final.reason,'BOUNDED_CODE_REPAIR_VERIFICATION_FAILED');
});

test('M120 exact C16 verifier failure can recover once for one DSH repair and one fresh reviewer',async t=>{
  const x=await fixture(t),child=await x.h.engine.approveBoundedCodeRepair(x.r.id,x.input,actor);
  fixedControllerCapacity(x.h.engine);
  x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
  x.h.engine.executorSegmented=()=>{throw new Error('M120_SEGMENTED_EXECUTION_FORBIDDEN');};
  let revision=0,reserves=0,executorRuns=0,verifyRuns=0,reviewerRuns=0;
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(runId){assert.equal(runId,child.id);reserves++;revision++;},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        const source=treeHash(input.workspace);
        const intentId=x.h.store.record('ToolIntent',x.p.id,child.id,{
          tool:'desk_write',specHash:child.specHash,sourceHash:source,
          sliceId:input.executorSliceId,requestHash:hash('M120_FIRST_FAILED_WRITE'),
        });
        writeFileSync(join(input.workspace,'main.mjs'),'// M120 FIRST FAILED OFFLINE REPAIR\n');
        x.h.store.record('ToolResult',x.p.id,child.id,{
          intentId,tool:'desk_write',specHash:child.specHash,sourceHash:treeHash(input.workspace),
          sliceId:input.executorSliceId,status:'COMPLETE',responseHash:hash('M120_FIRST_FAILED_RESULT'),
        });
        return{
          text:'First repair did not preserve deep JSON error position.',
          model:x.h.config.dsh.model,sessionId:'M120_OFFLINE_DSH_SESSION_1',
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M120_OFFLINE_DSH_REQUEST_1',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){verifyRuns++;return trustedVerifierFailureResult(x,input.workspace);},
    codex(){throw new Error('M120_REVIEWER_MUST_NOT_RUN_BEFORE_C16_PASS');},
    async close(){},
  };
  await x.h.engine.resume(child.id);
  await x.h.engine.settled(child.id);
  const failed=x.h.store.run(child.id);
  assert.equal(executorRuns,1);
  assert.equal(verifyRuns,1);
  assert.equal(failed.state,'BLOCKED');
  assert.equal(failed.phase,'VERIFYING');
  assert.equal(failed.reason,'BOUNDED_CODE_REPAIR_VERIFICATION_FAILED');
  assert.equal(failed.calls,1);
  assert.equal(failed.maxCalls,2);
  assert.equal(failed.review,null);
  assert.equal(failed.verification.ok,false);

  const request={
    confirmed:true,
    expectedVersion:failed.version,
    sourceHash:failed.treeHash,
    verificationEvidenceId:failed.verification.evidenceId,
    ownerDecisionHash:'d'.repeat(64),
  };
  await assert.rejects(x.h.engine.recoverBoundedCodeVerificationFailure(child.id,{
    ...request,sourceHash:'0'.repeat(64),
  },actor),{code:'BOUNDED_CODE_REPAIR_RECOVERY_NOT_ELIGIBLE'});

  const recovered=await x.h.engine.recoverBoundedCodeVerificationFailure(child.id,request,actor);
  assert.equal(recovered.state,'PAUSED');
  assert.equal(recovered.phase,'IMPLEMENTING');
  assert.equal(recovered.reason,'BOUNDED_CODE_REPAIR_VERIFICATION_RECOVERY_PREPARED');
  assert.equal(recovered.calls,1);
  assert.equal(recovered.maxCalls,3);
  assert.equal(recovered.repairCount,1);
  assert.equal(recovered.maxRepairs,1);
  assert.equal(recovered.review,null);
  assert.equal(recovered.verification.evidenceId,request.verificationEvidenceId);
  assert.deepEqual(recovered.tasks.filter(task=>task.status==='pending').map(task=>task.id),['OFFLINE_MAIN']);
  assert.equal(x.h.store.records(x.p.id,'BoundedCodeVerificationRecovery').filter(row=>row.runId===child.id).length,1);

  const versionAfterRecovery=recovered.version;
  const replay=await x.h.engine.recoverBoundedCodeVerificationFailure(child.id,request,actor);
  assert.equal(replay.version,versionAfterRecovery);
  assert.equal(x.h.store.records(x.p.id,'BoundedCodeVerificationRecovery').filter(row=>row.runId===child.id).length,1);
  await assert.rejects(x.h.engine.recoverBoundedCodeVerificationFailure(child.id,{
    ...request,ownerDecisionHash:'e'.repeat(64),
  },actor),{code:'BOUNDED_CODE_REPAIR_RECOVERY_CHANGED'});

  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){throw new Error('M120_RECOVERY_MUST_NOT_RESERVE_A_SECOND_REPAIR');},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        const source=treeHash(input.workspace);
        const intentId=x.h.store.record('ToolIntent',x.p.id,child.id,{
          tool:'desk_write',specHash:child.specHash,sourceHash:source,
          sliceId:input.executorSliceId,requestHash:hash('M120_SECOND_REPAIR_WRITE'),
        });
        writeFileSync(join(input.workspace,'main.mjs'),'// M120 DEEP JSON POSITION REPAIR\n');
        x.h.store.record('ToolResult',x.p.id,child.id,{
          intentId,tool:'desk_write',specHash:child.specHash,sourceHash:treeHash(input.workspace),
          sliceId:input.executorSliceId,status:'COMPLETE',responseHash:hash('M120_SECOND_REPAIR_RESULT'),
        });
        x.h.store.record('NativeBudgetReceipt',x.p.id,child.id,{
          method:'dm/budget',
          params:{requests:[{
            observedModel:x.h.config.dsh.model,
            outcome:'COMPLETE',
            completionObserved:true,
            responseModelMatched:true,
          }]},
        });
        return{
          text:'Deeply nested malformed JSON now reports the actual parser location.',
          model:x.h.config.dsh.model,sessionId:'M120_OFFLINE_DSH_SESSION_2',
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M120_OFFLINE_DSH_REQUEST_2',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){verifyRuns++;return trustedVerifierResult(x,input.workspace);},
    codex(){
      return{run:async()=>{
        reviewerRuns++;
        const grant=x.h.store.records(x.p.id,'DispatchGranted')
          .filter(row=>row.runId===child.id&&row.data.kind==='reviewer').at(-1);
        assert.ok(grant);
        const processId='M120_OFFLINE_FRESH_REVIEWER_PROCESS';
        x.h.store.record('OwnedProcessIntent',x.p.id,child.id,{
          processId,platform:'win32',dispatchId:grant.data.dispatchId,generation:grant.data.generation,
        });
        x.h.store.record('OwnedProcessCleanup',x.p.id,child.id,{
          processId,dispatchId:grant.data.dispatchId,generation:grant.data.generation,cleanupReturned:true,
        });
        return{
          text:JSON.stringify(offlinePreworkReview(x.h,child.id)),
          model:x.h.config.codex.model,sessionId:'M120_OFFLINE_FRESH_REVIEWER_SESSION',
          identity:{runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:x.h.config.codex.model},
          usage:{role:'reviewer',requestId:'M120_OFFLINE_FRESH_REVIEWER_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async close(){},
  };
  await x.h.engine.resume(child.id);
  await x.h.engine.settled(child.id);
  const final=x.h.store.run(child.id);
  assert.equal(executorRuns,2);
  assert.equal(verifyRuns,2,JSON.stringify({state:final.state,phase:final.phase,reason:final.reason,calls:final.calls,verification:final.verification,review:final.review}));
  assert.equal(reviewerRuns,1,JSON.stringify({state:final.state,phase:final.phase,reason:final.reason,calls:final.calls,verification:final.verification?.ok,review:final.review}));
  assert.equal(reserves,1);
  assert.equal(final.calls,3);
  assert.equal(final.maxCalls,3);
  assert.equal(final.state,'READY_FOR_DELIVERY');
  assert.equal(final.review.verdict,'PASS');
  assert.equal(final.review.treeHash,final.treeHash);
  assert.equal(final.verification.ok,true);
  assert.equal(final.verification.treeHash,final.treeHash);
  assert.equal(final.sessions.reviewer,'M120_OFFLINE_FRESH_REVIEWER_SESSION');
  assert.equal(final.roleIdentities.executor.sessionId,'M120_OFFLINE_DSH_SESSION_2');
  assert.equal(completedDocumentationEngineeringRoles(x.h.store,final),true);
  assert.equal(x.h.store.records(x.p.id,'AgentSession').filter(row=>row.runId===child.id&&row.data.role==='executor').length,2);
  assert.equal(x.h.store.records(x.p.id,'AgentSession').filter(row=>row.runId===child.id&&row.data.role==='reviewer').length,1);
  assert.equal(x.h.store.records(x.p.id,'UsageLedger').filter(row=>row.runId===child.id).length,3);
  assert.match(readFileSync(join(final.workspace,'main.mjs'),'utf8'),/M120 DEEP JSON POSITION REPAIR/);
  await assert.rejects(x.h.engine.recoverBoundedCodeVerificationFailure(child.id,request,actor),{
    code:'BOUNDED_CODE_REPAIR_RECOVERY_ALREADY_USED',
  });
});

test('M126 no-turn reviewer recovery rejects a nonempty or mismatched Windows Job close',async t=>{
  const x=await reviewerUsageBlockFixture(t);
  const update=(path,value)=>x.h.store.db.prepare(
    `UPDATE records SET data=json_set(data,'${path}',?) WHERE run_id=? AND kind='OwnedWindowsJobClosed'`,
  ).run(value,x.child.id);
  update('$.activeProcesses',1);
  await assert.rejects(
    x.h.engine.recoverBoundedCodeReviewUsage(x.child.id,x.request,actor),
    {code:'BOUNDED_CODE_REVIEW_RECOVERY_NOT_ELIGIBLE'},
  );
  assert.equal(
    x.h.store.records(x.p.id,'BoundedCodeReviewRecovery')
      .filter(row=>row.runId===x.child.id).length,
    0,
  );
  update('$.activeProcesses',0);
  update('$.proof.scopeId','windows_job_'+'e'.repeat(20));
  await assert.rejects(
    x.h.engine.recoverBoundedCodeReviewUsage(x.child.id,x.request,actor),
    {code:'BOUNDED_CODE_REVIEW_RECOVERY_NOT_ELIGIBLE'},
  );
  assert.equal(
    x.h.store.records(x.p.id,'BoundedCodeReviewRecovery')
      .filter(row=>row.runId===x.child.id).length,
    0,
  );
});

test('M126 no-turn reviewer usage block recovers exactly one DSH repair and one fresh reviewer',async t=>{
  const x=await reviewerUsageBlockFixture(t);
  const recovered=await x.h.engine.recoverBoundedCodeReviewUsage(x.child.id,x.request,actor);
  assert.equal(recovered.state,'PAUSED');
  assert.equal(recovered.phase,'IMPLEMENTING');
  assert.equal(recovered.reason,'BOUNDED_CODE_REVIEW_RECOVERY_PREPARED');
  assert.equal(recovered.calls,2);
  assert.equal(recovered.maxCalls,4);
  assert.equal(recovered.repairCount,1);
  assert.equal(recovered.maxRepairs,1);
  assert.equal(recovered.review,null);
  assert.deepEqual(recovered.tasks.filter(task=>task.status==='pending').map(task=>task.id),['OFFLINE_MAIN']);
  assert.equal(x.h.store.records(x.p.id,'BoundedCodeReviewRecovery').filter(row=>row.runId===x.child.id).length,1);

  const versionAfterRecovery=recovered.version;
  const replay=await x.h.engine.recoverBoundedCodeReviewUsage(x.child.id,x.request,actor);
  assert.equal(replay.version,versionAfterRecovery);
  assert.equal(x.h.store.records(x.p.id,'BoundedCodeReviewRecovery').filter(row=>row.runId===x.child.id).length,1);
  await assert.rejects(x.h.engine.recoverBoundedCodeReviewUsage(x.child.id,{
    ...x.request,ownerDecisionHash:'b'.repeat(64),
  },actor),{code:'BOUNDED_CODE_REVIEW_RECOVERY_CHANGED'});

  let executorRuns=1,verifyRuns=1,reviewerRuns=0;
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){throw new Error('M126_RECOVERY_MUST_NOT_RESERVE_ANOTHER_REPAIR');},
    repairRevision(){return 1;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        writeFileSync(join(input.workspace,'main.mjs'),'// M126 ACTUAL OFFLINE FIX\n');
        return{
          text:'F1 repaired.',model:x.h.config.dsh.model,sessionId:'M126_OFFLINE_RECOVERY_DSH',
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M126_OFFLINE_RECOVERY_DSH_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){verifyRuns++;return trustedVerifierResult(x,input.workspace);},
    codex(){
      return{run:async()=>{
        reviewerRuns++;
        return reviewerPass(x,x.child).run();
      }};
    },
    async close(){},
  };
  await x.h.engine.resume(x.child.id);
  await x.h.engine.settled(x.child.id);
  const final=x.h.store.run(x.child.id);
  assert.equal(executorRuns,2);
  assert.equal(verifyRuns,2,JSON.stringify({state:final.state,phase:final.phase,reason:final.reason}));
  assert.equal(reviewerRuns,1,JSON.stringify({state:final.state,phase:final.phase,reason:final.reason}));
  assert.equal(final.calls,4);
  assert.equal(final.maxCalls,4);
  assert.equal(final.state,'READY_FOR_DELIVERY');
  assert.equal(final.review.verdict,'PASS');
  assert.equal(final.verification.ok,true);
  assert.equal(final.sessions.reviewer,'M126_OFFLINE_FRESH_REVIEWER_SESSION');
  assert.equal(completedDocumentationEngineeringRoles(x.h.store,final),true);
});

test('M126 second verification failure stops before any Reviewer dispatch',async t=>{
  const x=await reviewerUsageBlockFixture(t);
  await x.h.engine.recoverBoundedCodeReviewUsage(x.child.id,x.request,actor);
  let reviewerRuns=0;
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){throw new Error('M126_MUST_NOT_RESERVE');},
    repairRevision(){return 1;},
    executor(input){
      return{run:async()=>{
        writeFileSync(join(input.workspace,'main.mjs'),'// M126 STILL BROKEN\n');
        return{
          text:'Still broken.',model:x.h.config.dsh.model,sessionId:'M126_STILL_BROKEN_DSH',
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M126_STILL_BROKEN_DSH_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){return trustedVerifierFailureResult(x,input.workspace);},
    codex(){reviewerRuns++;throw new Error('M126_REVIEWER_MUST_NOT_RUN_AFTER_F1_FAILURE');},
    async close(){},
  };
  await x.h.engine.resume(x.child.id);
  await x.h.engine.settled(x.child.id);
  const final=x.h.store.run(x.child.id);
  assert.equal(reviewerRuns,0);
  assert.equal(final.state,'BLOCKED');
  assert.equal(final.phase,'VERIFYING');
  assert.equal(final.reason,'BOUNDED_CODE_REPAIR_VERIFICATION_FAILED');
  assert.equal(final.calls,3);
  assert.equal(final.maxCalls,4);
  assert.equal(x.h.store.records(x.p.id,'AgentSession').filter(row=>row.runId===x.child.id&&row.data.role==='reviewer').length,0);
});

test('M126 recovery rejects a fabricated Reviewer turn',async t=>{
  const blocked=await reviewerUsageBlockFixture(t);
  blocked.h.store.record('AgentSession',blocked.p.id,blocked.child.id,{
    role:'reviewer',sessionId:'FABRICATED_REVIEWER',requestId:'FABRICATED_REVIEWER_REQUEST',
    modelEvidence:'ADAPTER_VERIFIED_RESPONSE',
  });
  await assert.rejects(blocked.h.engine.recoverBoundedCodeReviewUsage(blocked.child.id,blocked.request,actor),{
    code:'BOUNDED_CODE_REVIEW_RECOVERY_NOT_ELIGIBLE',
  });
});

test('M126 recovery rejects changed Reviewer preparation evidence',async t=>{
  const changed=await reviewerUsageBlockFixture(t);
  const event=changed.h.store.db.prepare(
    "SELECT id,payload FROM events WHERE run_id=? AND type='agent.event' AND json_extract(payload,'$.params.method')='account/rateLimits/read' ORDER BY id DESC LIMIT 1",
  ).get(changed.child.id);
  const payload=JSON.parse(event.payload);
  changed.h.store.db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify({
    ...payload,params:{...payload.params,method:'turn/start'},
  }),event.id);
  await assert.rejects(changed.h.engine.recoverBoundedCodeReviewUsage(changed.child.id,changed.request,actor),{
    code:'BOUNDED_CODE_REVIEW_RECOVERY_NOT_ELIGIBLE',
  });
  assert.equal(changed.h.store.records(changed.p.id,'BoundedCodeReviewRecovery').length,0);
});

test('M123 fourth bounded verification recovery remains exact and preserves one fresh review',async t=>{
  const x=await fixture(t),child=await x.h.engine.approveBoundedCodeRepair(x.r.id,x.input,actor);
  fixedControllerCapacity(x.h.engine);
  x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
  x.h.engine.executorSegmented=()=>{throw new Error('M120_SEGMENTED_EXECUTION_FORBIDDEN');};
  let revision=0,executorRuns=0,verifyRuns=0,reviewerRuns=0;
  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){revision++;},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        writeFileSync(join(input.workspace,'main.mjs'),'// M120 BOUNDED FAILURE '+executorRuns+'\n');
        return{
          text:'Offline bounded repair attempt.',
          model:x.h.config.dsh.model,sessionId:'M120_FAILURE_DSH_SESSION_'+executorRuns,
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M120_FAILURE_DSH_REQUEST_'+executorRuns,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){verifyRuns++;return trustedVerifierFailureResult(x,input.workspace);},
    codex(){reviewerRuns++;throw new Error('M120_REVIEWER_MUST_NOT_RUN_AFTER_SECOND_FAILURE');},
    async close(){},
  };
  await x.h.engine.resume(child.id);
  await x.h.engine.settled(child.id);
  const firstFailure=x.h.store.run(child.id);
  const request={
    confirmed:true,expectedVersion:firstFailure.version,sourceHash:firstFailure.treeHash,
    verificationEvidenceId:firstFailure.verification.evidenceId,ownerDecisionHash:'f'.repeat(64),
  };
  await x.h.engine.recoverBoundedCodeVerificationFailure(child.id,request,actor);
  await x.h.engine.resume(child.id);
  await x.h.engine.settled(child.id);
  const final=x.h.store.run(child.id);
  assert.equal(executorRuns,2);
  assert.equal(verifyRuns,2,JSON.stringify({state:final.state,phase:final.phase,reason:final.reason,calls:final.calls,verification:final.verification,review:final.review}));
  assert.equal(reviewerRuns,0);
  assert.equal(final.calls,2);
  assert.equal(final.maxCalls,3);
  assert.equal(final.state,'BLOCKED');
  assert.equal(final.phase,'VERIFYING');
  assert.equal(final.reason,'BOUNDED_CODE_REPAIR_VERIFICATION_FAILED');
  assert.equal(final.review,null);
  assert.equal(x.h.store.records(x.p.id,'BoundedCodeVerificationRecovery').filter(row=>row.runId===child.id).length,1);
  await assert.rejects(x.h.engine.resume(child.id),{code:'WORKSPACE_LEASE_LOST'});

  const secondRequest={
    confirmed:true,
    expectedVersion:final.version,
    sourceHash:final.treeHash,
    verificationEvidenceId:final.verification.evidenceId,
    ownerDecisionHash:'9'.repeat(64),
  };
  const secondRecovery=await x.h.engine.recoverBoundedCodeVerificationFailure(
    child.id,
    secondRequest,
    actor,
  );
  assert.equal(secondRecovery.state,'PAUSED');
  assert.equal(secondRecovery.phase,'IMPLEMENTING');
  assert.equal(secondRecovery.calls,2);
  assert.equal(secondRecovery.maxCalls,4);
  assert.equal(secondRecovery.repairCount,1);
  assert.equal(secondRecovery.maxRepairs,1);
  assert.equal(
    x.h.store.records(x.p.id,'BoundedCodeVerificationRecovery')
      .filter(row=>row.runId===child.id).length,
    2,
  );
  const secondReplay=await x.h.engine.recoverBoundedCodeVerificationFailure(
    child.id,
    secondRequest,
    actor,
  );
  assert.equal(secondReplay.version,secondRecovery.version);

  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){throw new Error('M122_THIRD_RECOVERY_MUST_NOT_RESERVE_ANOTHER_REPAIR');},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        writeFileSync(join(input.workspace,'main.mjs'),'// M122 THIRD BOUNDED FAILURE\n');
        return{
          text:'Offline third bounded repair attempt.',
          model:x.h.config.dsh.model,sessionId:'M122_FAILURE_DSH_SESSION_'+executorRuns,
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M122_FAILURE_DSH_REQUEST_'+executorRuns,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){verifyRuns++;return trustedVerifierFailureResult(x,input.workspace);},
    codex(){reviewerRuns++;throw new Error('M122_REVIEWER_MUST_NOT_RUN_AFTER_THIRD_FAILURE');},
    async close(){},
  };
  await x.h.engine.resume(child.id);
  await x.h.engine.settled(child.id);
  const thirdFailure=x.h.store.run(child.id);
  assert.equal(thirdFailure.calls,3);
  assert.equal(thirdFailure.maxCalls,4);
  assert.equal(thirdFailure.state,'BLOCKED');
  assert.equal(thirdFailure.phase,'VERIFYING');
  assert.equal(thirdFailure.reason,'BOUNDED_CODE_REPAIR_VERIFICATION_FAILED');
  assert.equal(thirdFailure.review,null);
  assert.equal(executorRuns,3);
  assert.equal(verifyRuns,3);
  assert.equal(reviewerRuns,0);

  const thirdRequest={
    confirmed:true,
    expectedVersion:thirdFailure.version,
    sourceHash:thirdFailure.treeHash,
    verificationEvidenceId:thirdFailure.verification.evidenceId,
    ownerDecisionHash:'7'.repeat(64),
  };
  const thirdRecovery=await x.h.engine.recoverBoundedCodeVerificationFailure(
    child.id,
    thirdRequest,
    actor,
  );
  assert.equal(thirdRecovery.state,'PAUSED');
  assert.equal(thirdRecovery.phase,'IMPLEMENTING');
  assert.equal(thirdRecovery.calls,3);
  assert.equal(thirdRecovery.maxCalls,5);
  assert.equal(thirdRecovery.repairCount,1);
  assert.equal(thirdRecovery.maxRepairs,1);
  assert.equal(
    x.h.store.records(x.p.id,'BoundedCodeVerificationRecovery')
      .filter(row=>row.runId===child.id).length,
    3,
  );
  const thirdReplay=await x.h.engine.recoverBoundedCodeVerificationFailure(
    child.id,
    thirdRequest,
    actor,
  );
  assert.equal(thirdReplay.version,thirdRecovery.version);

  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){throw new Error('M123_FOURTH_RECOVERY_MUST_NOT_RESERVE_ANOTHER_REPAIR');},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        writeFileSync(join(input.workspace,'main.mjs'),'// M123 FOURTH BOUNDED FAILURE\n');
        return{
          text:'Offline fourth bounded repair attempt.',
          model:x.h.config.dsh.model,sessionId:'M123_FAILURE_DSH_SESSION_'+executorRuns,
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M123_FAILURE_DSH_REQUEST_'+executorRuns,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){verifyRuns++;return trustedVerifierFailureResult(x,input.workspace);},
    codex(){reviewerRuns++;throw new Error('M123_REVIEWER_MUST_NOT_RUN_AFTER_FOURTH_FAILURE');},
    async close(){},
  };
  await x.h.engine.resume(child.id);
  await x.h.engine.settled(child.id);
  const fourthFailure=x.h.store.run(child.id);
  assert.equal(fourthFailure.calls,4);
  assert.equal(fourthFailure.maxCalls,5);
  assert.equal(fourthFailure.state,'BLOCKED');
  assert.equal(fourthFailure.phase,'VERIFYING');
  assert.equal(fourthFailure.reason,'BOUNDED_CODE_REPAIR_VERIFICATION_FAILED');
  assert.equal(fourthFailure.review,null);
  assert.equal(executorRuns,4);
  assert.equal(verifyRuns,4);
  assert.equal(reviewerRuns,0);

  const fourthRequest={
    confirmed:true,
    expectedVersion:fourthFailure.version,
    sourceHash:fourthFailure.treeHash,
    verificationEvidenceId:fourthFailure.verification.evidenceId,
    ownerDecisionHash:'6'.repeat(64),
  };
  const fourthRecovery=await x.h.engine.recoverBoundedCodeVerificationFailure(
    child.id,
    fourthRequest,
    actor,
  );
  assert.equal(fourthRecovery.state,'PAUSED');
  assert.equal(fourthRecovery.phase,'IMPLEMENTING');
  assert.equal(fourthRecovery.calls,4);
  assert.equal(fourthRecovery.maxCalls,6);
  assert.equal(fourthRecovery.repairCount,1);
  assert.equal(fourthRecovery.maxRepairs,1);
  assert.equal(
    x.h.store.records(x.p.id,'BoundedCodeVerificationRecovery')
      .filter(row=>row.runId===child.id).length,
    4,
  );
  const fourthReplay=await x.h.engine.recoverBoundedCodeVerificationFailure(
    child.id,
    fourthRequest,
    actor,
  );
  assert.equal(fourthReplay.version,fourthRecovery.version);

  x.h.engine.nativeExecution={
    assertReady(){},
    reserveRepair(){throw new Error('M123_FINAL_RECOVERY_MUST_NOT_RESERVE_ANOTHER_REPAIR');},
    repairRevision(){return revision;},
    executor(input){
      return{run:async()=>{
        executorRuns++;
        const source=treeHash(input.workspace);
        const intentId=x.h.store.record('ToolIntent',x.p.id,child.id,{
          tool:'desk_write',specHash:child.specHash,sourceHash:source,
          sliceId:input.executorSliceId,requestHash:hash('M123_FOURTH_RECOVERY_WRITE'),
        });
        writeFileSync(join(input.workspace,'main.mjs'),'// M123 CORRECTED JSON POSITION REPAIR\n');
        x.h.store.record('ToolResult',x.p.id,child.id,{
          intentId,tool:'desk_write',specHash:child.specHash,sourceHash:treeHash(input.workspace),
          sliceId:input.executorSliceId,status:'COMPLETE',responseHash:hash('M123_FOURTH_RECOVERY_RESULT'),
        });
        x.h.store.record('NativeBudgetReceipt',x.p.id,child.id,{
          method:'dm/budget',
          params:{requests:[{
            observedModel:x.h.config.dsh.model,
            outcome:'COMPLETE',
            completionObserved:true,
            responseModelMatched:true,
          }]},
        });
        return{
          text:'Corrected the scanner so an opened object is a successful value transition.',
          model:x.h.config.dsh.model,
          sessionId:'M123_OFFLINE_DSH_SESSION_5',
          identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:x.h.config.dsh.model},
          usage:{role:'executor',requestId:'M123_OFFLINE_DSH_REQUEST_5',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async verify(input){verifyRuns++;return trustedVerifierResult(x,input.workspace);},
    codex(){
      return{run:async()=>{
        reviewerRuns++;
        const grant=x.h.store.records(x.p.id,'DispatchGranted')
          .filter(row=>row.runId===child.id&&row.data.kind==='reviewer').at(-1);
        assert.ok(grant);
        const processId='M123_OFFLINE_FRESH_REVIEWER_PROCESS';
        x.h.store.record('OwnedProcessIntent',x.p.id,child.id,{
          processId,platform:'win32',dispatchId:grant.data.dispatchId,generation:grant.data.generation,
        });
        x.h.store.record('OwnedProcessCleanup',x.p.id,child.id,{
          processId,dispatchId:grant.data.dispatchId,generation:grant.data.generation,cleanupReturned:true,
        });
        return{
          text:JSON.stringify(offlinePreworkReview(x.h,child.id)),
          model:x.h.config.codex.model,
          sessionId:'M123_OFFLINE_FRESH_REVIEWER_SESSION',
          identity:{runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:x.h.config.codex.model},
          usage:{role:'reviewer',requestId:'M123_OFFLINE_FRESH_REVIEWER_REQUEST',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
        };
      }};
    },
    async close(){},
  };
  await x.h.engine.resume(child.id);
  await x.h.engine.settled(child.id);
  const repaired=x.h.store.run(child.id);
  assert.equal(repaired.state,'READY_FOR_DELIVERY');
  assert.equal(repaired.calls,6);
  assert.equal(repaired.maxCalls,6);
  assert.equal(repaired.review.verdict,'PASS');
  assert.equal(repaired.verification.ok,true);
  assert.equal(executorRuns,5);
  assert.equal(verifyRuns,5);
  assert.equal(reviewerRuns,1);
  assert.equal(
    x.h.store.records(x.p.id,'AgentSession')
      .filter(row=>row.runId===child.id&&row.data.role==='executor').length,
    5,
  );
  assert.equal(
    x.h.store.records(x.p.id,'AgentSession')
      .filter(row=>row.runId===child.id&&row.data.role==='reviewer').length,
    1,
  );
  assert.equal(
    x.h.store.records(x.p.id,'UsageLedger').filter(row=>row.runId===child.id).length,
    6,
  );
  assert.equal(completedDocumentationEngineeringRoles(x.h.store,repaired),true);
  await assert.rejects(x.h.engine.recoverBoundedCodeVerificationFailure(child.id,{
    ...thirdRequest,
    expectedVersion:repaired.version,
    sourceHash:repaired.treeHash,
    verificationEvidenceId:repaired.verification.evidenceId,
    ownerDecisionHash:'8'.repeat(64),
  },actor),{code:'BOUNDED_CODE_REPAIR_RECOVERY_ALREADY_USED'});
});
