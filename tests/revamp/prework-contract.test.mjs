import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../../dist/server/security.js';
import {readFileSync} from 'node:fs';
import {handoffSchema} from '../../dist/server/prework/schema.js';
import {buildPrework,validatePrework,assertWorkPackage,preworkCloseout,projectPreworkEvent} from '../../dist/server/prework/contract.js';
const sha='a'.repeat(64), tree='b'.repeat(64);
const context=()=>({projectId:'synthetic-project',flowId:'synthetic-flow',planId:'synthetic-plan',planVersion:1,planHash:sha,approvedAt:'2026-11-13T00:00:00+08:00',sourceEpoch:'synthetic-epoch',baselineHash:tree,plannerSession:'synthetic-p2',plannerRuntime:'SYNTHETIC',requirements:[{id:'R1',acceptance:['支持记录']},{id:'R2',acceptance:['保存结果']}],tasks:[{id:'T1',dependsOn:[],requirementIds:['R1','R2'],acceptance:['支持记录','保存结果'],writePaths:['main.mjs']}],mode:'demo'});
const valid=()=>buildPrework(context());
test('PW shipped contract and embedded runtime schema are identical',()=>assert.deepEqual(handoffSchema,JSON.parse(readFileSync(new URL('../../contracts/DM_PREWORK_HANDOFF_V1.schema.json',import.meta.url),'utf8'))));
test('PW a caller cannot self-assert inherited planning against current-flow authority',()=>{
 const c=valid();c.planner2.provenance={origin:'INHERITED_NOT_NEW_PLANNING',parentFlowId:'synthetic-parent',approvalRef:'record:synthetic',approvalHash:sha,planRecordRef:'record:synthetic-plan',sessionRecordRef:'record:synthetic-session',evidenceHash:sha,carriedTaskIds:[]};
 const{contractId,...body}=structuredClone(c);body.evidencePolicy.artifactRoot='';c.contractId='prework_'+hash(body);c.evidencePolicy.artifactRoot='prework/'+c.sourceEpoch+'/'+c.flowId+'/'+c.contractId;
 assert.throws(()=>validatePrework(c,context()),{code:'PREWORK_PLANNER_IDENTITY_CHANGED'});
});
test('PW: controller binding and complete coverage produce a planning contract, never acceptance',()=>{
 const c=valid();assert.equal(c.schema,'dm.prework.handoff.v1');assert.equal(c.status,'ready-for-dispatch');assert.equal(c.requirements.length,2);assert.equal(c.reviewPlan.targetIndependence,'R0');assert.equal(c.forecast.bestReachableEvidence,'E2');assert.equal(c.workPackages[0].retryPolicy,'reconcile-before-retry');assert.deepEqual(validatePrework(JSON.stringify(c)+'\n',context()),c);
});
for(const [name,mutate] of [
 ['unknown top field',c=>c.inferenceSucceeded=true],['unknown nested field',c=>c.baseline.success=true],
 ['duplicate requirement',c=>c.requirements.push(c.requirements[0])],['orphan requirement',c=>c.requirements.pop()],
 ['stale plan',c=>c.planBinding.contentDigest='c'.repeat(64)],['multiple baselines',c=>c.baseline=[c.baseline,c.baseline]],
 ['baseline drift',c=>c.baseline.tree='d'.repeat(64)],['unresolved drift',c=>c.baseline.state='drift-detected'],
 ['self asserted R2',c=>c.reviewPlan.targetIndependence='R2'],['fake R2 receipt',c=>Object.assign(c.reviewPlan,{targetIndependence:'R2',reviewerSessionRef:'fake',routeRef:'fake',bundleRef:'fake',receiptRef:'fake',resultRef:'fake'})],
 ['unreachable without decision',c=>c.requirements[0].reachable=false],['unreachable even if recorded open',c=>Object.assign(c.requirements[0],{reachable:false,gapDecision:'accept-as-open',gapReason:'missing capability'})],
 ['path traversal',c=>c.workPackages[0].writePaths=['../other']],['scope broadening',c=>c.workPackages[0].writePaths=['src/']],
 ['missing review coverage',c=>c.reviewPlan.coverage=[]],['mutable evidence',c=>c.evidencePolicy.immutableOutputs[0].strategy='overwrite'],
 ['contaminated control copy',c=>c.evidencePolicy.controlCopies=[{ref:'copy',verifiedBeforeUse:true,executionAfterVerification:true}]],
 ['cycle',c=>c.workPackages[0].dependsOn=['T1']],
])test('PW rejects '+name+' even with a recomputed digest',()=>{const c=valid();mutate(c);const{contractId,...body}=structuredClone(c);body.evidencePolicy.artifactRoot='';c.contractId='prework_'+hash(body);c.evidencePolicy.artifactRoot='prework/'+c.sourceEpoch+'/'+c.flowId+'/'+c.contractId;assert.throws(()=>validatePrework(c,context()),e=>e.code?.startsWith('PREWORK_'));});
test('PW dispatch checks current contract, dependencies and exact path scope',()=>{
 const c=valid();const w=assertWorkPackage(c,context(),'T1',[]);assert.deepEqual(w.writePaths,['main.mjs']);
 assert.throws(()=>assertWorkPackage(undefined,context(),'T1',[]),/PREWORK_/);
 assert.throws(()=>assertWorkPackage(c,context(),'T2',[]),/PREWORK_/);
 const changed=context();changed.baselineHash='e'.repeat(64);assert.throws(()=>assertWorkPackage(c,changed,'T1',[]),/PREWORK_/);
});
test('PW independent concurrent packages require disjoint paths; dependencies permit shared paths',()=>{
 const ctx=context();ctx.tasks.push({...structuredClone(ctx.tasks[0]),id:'T2',writePaths:['README.md']});
 assert.equal(buildPrework(ctx).workPackages.length,2);
 ctx.tasks[1].writePaths=['main.mjs'];assert.throws(()=>buildPrework(ctx),{code:'PREWORK_PARALLEL_WRITE_CONFLICT'});
 ctx.tasks[1].dependsOn=['T1'];const c=buildPrework(ctx);
 assert.throws(()=>assertWorkPackage(c,ctx,'T2',[]),{code:'PREWORK_DEPENDENCY_NOT_READY'});
 assert.equal(assertWorkPackage(c,ctx,'T2',['T1']).taskId,'T2');
});
test('PW evidence and review axes do not compensate each other',()=>{
 const liveContext=context();liveContext.mode='live';const c=buildPrework(liveContext);assert.equal(preworkCloseout(c,[]).coverageReached,false);
 const rows=c.requirements.map(r=>({requirementId:r.requirementId,evidence:'E5',review:'R0',artifactRef:'synthetic-result'}));
 assert.equal(preworkCloseout(c,rows).coverageReached,false);rows.forEach(r=>r.review='R1');assert.equal(preworkCloseout(c,rows).coverageReached,true);
});
test('PW sidecar projection drops all private payload and dedupes by producer epoch',()=>{
 const e={id:7,type:'prework.ready',projectId:'p',runId:'r',at:'2026-11-13T00:00:00Z',payload:{contractId:'c',status:'ready-for-dispatch',prompt:'PRIVATE',token:'PRIVATE',stdout:'PRIVATE'}};
 const a=projectPreworkEvent('epoch-123',e),b=projectPreworkEvent('epoch-456',e);
 assert.notEqual(a.key,b.key);assert.ok(!JSON.stringify(a).includes('PRIVATE'));assert.equal(projectPreworkEvent('epoch-123',{...e,type:'agent.event'}),null);
});

test('PW a current task cannot self-declare inherited baseline to bypass write and resource checks',()=>{
 const ctx=context(),c=buildPrework(ctx),w=c.workPackages[0];
 Object.assign(w,{inheritedBaseline:true,readPaths:[],writePaths:[],outputs:[],resourceClaims:{authority:'NO_NEW_DISPATCH_INHERITED_BASELINE',executorSlots:0,maxConcurrentTools:0}});
 const{contractId,...body}=structuredClone(c);body.evidencePolicy.artifactRoot='';c.contractId='prework_'+hash(body);c.evidencePolicy.artifactRoot='prework/'+c.sourceEpoch+'/'+c.flowId+'/'+c.contractId;
 assert.throws(()=>validatePrework(c,ctx),{code:'PREWORK_WORK_PACKAGE_CHANGED'});
});
test('PW immutable earlier v1 contracts without the new baseline flag remain byte-for-byte valid',()=>{
 const ctx=context(),c=buildPrework(ctx);for(const w of c.workPackages)delete w.inheritedBaseline;
 const{contractId,...body}=structuredClone(c);body.evidencePolicy.artifactRoot='';c.contractId='prework_'+hash(body);c.evidencePolicy.artifactRoot='prework/'+c.sourceEpoch+'/'+c.flowId+'/'+c.contractId;
 const bytes=JSON.stringify(c),accepted=validatePrework(bytes,ctx);
 assert.equal(JSON.stringify(accepted),bytes);assert.equal(accepted.contractId,c.contractId);
 assert.equal(assertWorkPackage(c,ctx,'T1',[]).taskId,'T1');
});