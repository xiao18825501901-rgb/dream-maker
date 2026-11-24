import type {Run,Event} from '../../shared/types.js';
import type {Store} from '../store.js';
import {DomainError,hash,object} from '../security.js';
import {treeHash,files} from '../workspace.js';
import {boundExecutorAssignment} from '../flow/executor-slices.js';
import {assertRunEngineAgainstStore} from '../engine-mode.js';
import {inheritedDocumentationPlanning,documentationContinuationEvidence} from '../documentation-continuation.js';
import {buildPrework,validatePrework,assertWorkPackage,projectPreworkEvent,type PreworkContract,type PreworkContext} from './contract.js';

/** Same owner permission as original events; expose only the allowlisted projection.
 * Epoch comes from the persisted contract, never from the subscriber or raw payload. */
export function storedPreworkEvent(store:Store,projectId:string,event:Event){
 if(event.projectId!==projectId||!event.runId||!['prework.ready','prework.blocked','prework.result','prework.closeout'].includes(event.type))return null;
 const run=store.run(event.runId);if(run.projectId!==projectId||!run.prework)return null;
 const contract=readPrework(store,run),projected=projectPreworkEvent(contract.sourceEpoch,event);
 if(projected?.payload.contractId!==contract.contractId)throw new DomainError('PREWORK_EVENT_CONTRACT_CHANGED',409);
 return {...projected,mode:run.mode,evidenceScope:run.mode==='demo'?'SYNTHETIC_DEMO_NOT_LIVE':'LIVE_RUN_NOT_ACCEPTANCE'};
}

function fail(code:string):never{throw new DomainError('PREWORK_'+code,409);}
function context(store:Store,r:Run):PreworkContext {
 const s=store.spec(r.specId),v=store.planVersion(r.planVersionId??r.specId);
 if(s.stale||s.hash!==r.specHash||v.specHash!==r.specHash||v.contentHash!==r.planVersionHash||!v.approval||!store.approved(r.projectId,r.specHash,'SPEC')||!store.approved(r.projectId,r.specHash,'BUILD'))fail('STALE_PLAN');
 const rows=store.db.prepare("SELECT id,data,at FROM records WHERE run_id=? AND project_id=? AND kind='SourceSnapshot' AND json_extract(data,'$.stage')='BASELINE'").all(r.id,r.projectId);
 if(rows.length!==1)fail('BASELINE_REQUIRED');const baseline=object(JSON.parse(String(rows[0].data)));
 const {sha256,...body}=baseline;
 if(baseline.runId!==r.id||baseline.specHash!==r.specHash||sha256!==hash(body)||typeof baseline.treeHash!=='string')fail('BASELINE_DRIFT');
 const inherited=r.documentationContinuation?inheritedDocumentationPlanning(store,r):undefined;
 const planner=inherited?.planner.identity??r.roleIdentities?.planner2;
 if(inherited&&(r.sessions.planner2||r.roleIdentities?.planner2))fail('PLANNER_IDENTITY_CHANGED');
 if(r.mode==='live'&&(!planner||!planner.requestId||!inherited&&planner.sessionId!==r.sessions.planner2))fail('PLANNER_IDENTITY_CHANGED');
 const plannerProvenance:PreworkContext['plannerProvenance']=inherited?{origin:'INHERITED_NOT_NEW_PLANNING',parentFlowId:inherited.parentRunId,
  approvalRef:'record:'+inherited.approval.recordId,approvalHash:inherited.approval.sha256,planRecordRef:'record:'+inherited.plan.recordId,
  sessionRecordRef:'record:'+inherited.planner.session.recordId,evidenceHash:hash(inherited),carriedTaskIds:r.tasks.filter(t=>t.inheritedFrom).map(t=>t.id)}:undefined;
 return{projectId:r.projectId,flowId:r.id,planId:v.id,planVersion:v.revision,planHash:v.contentHash,approvedAt:v.approval.at,
  sourceEpoch:'epoch_'+hash({runId:r.id,baselineRecordId:rows[0].id,baseline:baseline.treeHash}),baselineHash:baseline.treeHash,baselineRecordRef:'record:'+rows[0].id,baselineObservedAt:String(rows[0].at),sourcePaths:Array.isArray(baseline.files)?baseline.files.map(f=>String(object(f).path)):[],
  plannerSession:planner?.sessionId??'demo_'+r.id,plannerRuntime:planner?.runner??'SYNTHETIC',mode:r.mode,executorSlots:r.flowName==='custom'?1:2,...(plannerProvenance?{plannerProvenance}:{}),
  requirements:s.requirements.map(req=>({id:req.id,acceptance:[req.text,...(s.acceptanceItems??[]).filter(a=>a.requirementIds.includes(req.id)).map(a=>a.criterion)]})),tasks:r.tasks};
}
/** Append-only normalization of a completed P2 plan. No dispatch, model or data migration. */
export function installPrework(store:Store,rid:string):PreworkContract {
 const persist=()=>{
  const r=store.run(rid);if(r.prework) return readPrework(store,r);
  const approval=r.documentationContinuation?documentationContinuationEvidence(store,r):null;
  if(r.phase!=='IMPLEMENTING'||!r.tasks.length||!r.tasks.some(t=>t.status==='pending')||r.tasks.some(t=>t.status!=='pending'&&!(approval&&t.status==='implemented'&&t.inheritedFrom?.runId===approval.parentRunId&&t.inheritedFrom.taskId===t.id)))fail('INSTALL_NOT_PLANNED');
  const contract=buildPrework(context(store,r)),recordId=store.record('PreworkContract',r.projectId,rid,{contract,digest:hash(contract)});
  r.prework={recordId,contractId:contract.contractId,digest:hash(contract)};store.saveRun(r);
  store.event(r.projectId,rid,'prework.ready',{contractId:contract.contractId,status:contract.status});return contract;
 };
 return store.inTransaction?persist():store.tx(persist);
}
export function readPrework(store:Store,r:Run):PreworkContract {
 if(!r.prework)fail('CONTRACT_REQUIRED');
 const row=store.db.prepare("SELECT data FROM records WHERE id=? AND run_id=? AND project_id=? AND kind='PreworkContract'").get(r.prework.recordId,r.id,r.projectId);
 if(!row)fail('CONTRACT_REQUIRED');const data=object(JSON.parse(String(row.data)));
 if(hash(data.contract)!==r.prework.digest||data.digest!==r.prework.digest)fail('DIGEST_CHANGED');
 const c=validatePrework(data.contract,context(store,r));if(c.contractId!==r.prework.contractId)fail('DIGEST_CHANGED');return c;
}
export function assertPreworkDispatch(store:Store,r:Run,taskId?:string) {
 // The same recorded engine decision the badge and the budget path read: a Flow may not be
 // handed its work packages under an engine the project was not decided to be.
 assertRunEngineAgainstStore(store,r);
 const c=readPrework(store,r);
 if(r.treeHash!==treeHash(r.workspace))fail('BASELINE_DRIFT');
 const completed=r.tasks.filter(t=>['implemented','done'].includes(t.status)).map(t=>t.id);
 return taskId?{contract:c,packages:[assertWorkPackage(c,context(store,r),taskId,completed)]}:{contract:c,packages:c.workPackages.filter(w=>!c.planner2.provenance?.carriedTaskIds.includes(w.taskId))};
}
/** A result is a controller-bound observation, never executor self-certification. */
export function savePreworkResult(store:Store,r:Run,input:{taskId?:string;dispatchId:string;generation:string;sessionId:string;requestId:string;beforeHash:string;afterHash:string;changedPaths:string[]}) {
 if(Object.keys(input).some(k=>!['taskId','dispatchId','generation','sessionId','requestId','beforeHash','afterHash','changedPaths'].includes(k)))fail('RESULT_UNBOUND');
 const c=readPrework(store,r),carried=c.planner2.provenance?.carriedTaskIds??[],packages=c.workPackages.filter(w=>(input.taskId===undefined||w.taskId===input.taskId)&&!carried.includes(w.taskId));
 if(!packages.length)fail('RESULT_UNBOUND');
 const allowed=packages.flatMap(w=>w.writePaths);
 if(input.changedPaths.some(p=>!allowed.some(scope=>scope.endsWith('/')?p.startsWith(scope):p===scope)))fail('SCOPE_INVALID');
 const finished=store.db.prepare("SELECT data,at,rowid ordinal FROM records WHERE project_id=? AND run_id=? AND kind='DispatchFinished' AND json_extract(data,'$.dispatchId')=?").all(r.projectId,r.id,input.dispatchId);
 if(finished.length!==1)fail('RESULT_UNBOUND');const f=object(JSON.parse(String(finished[0].data)));
 if(f.generation!==input.generation||f.outcome!=='COMPLETED'||f.cleanupReturned!==true)fail('RESULT_UNBOUND');
 if(!/^[a-f0-9]{64}$/.test(input.beforeHash)||!/^[a-f0-9]{64}$/.test(input.afterHash))fail('RESULT_UNBOUND');
 let sliceId:string|undefined;
 if(r.mode==='live'){
  const sessions=store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND kind='AgentSession' AND json_extract(data,'$.dispatchId')=?").all(r.projectId,r.id,input.dispatchId);
  const session=sessions.length===1?object(JSON.parse(String(sessions[0].data))):{};
  if(session.role!=='executor'||session.modelEvidence!=='ADAPTER_VERIFIED_RESPONSE'||session.sessionId!==input.sessionId||session.generation!==input.generation||input.taskId!==undefined&&session.taskId!==input.taskId||!r.usage.some(u=>u.role==='executor'&&u.requestId===input.requestId))fail('RESULT_UNBOUND');
  const identities=r.flowName==='custom'?r.executorRoleIdentities??[]:[r.roleIdentities?.executor].filter(x=>x!==undefined);
  if(!identities.some(identity=>identity.sessionId===input.sessionId&&identity.requestId===input.requestId&&(!('dispatchId' in identity)||identity.dispatchId===input.dispatchId)))fail('RESULT_UNBOUND');
  if(typeof session.sliceId==='string')sliceId=session.sliceId;
 }
 const source=files(sliceId?boundExecutorAssignment(store,r.id,sliceId).workspace:r.workspace);
 if(hash(source)!==input.afterHash)fail('BASELINE_DRIFT');
 const grant=store.db.prepare("SELECT at,rowid ordinal,data FROM records WHERE project_id=? AND run_id=? AND kind='DispatchGranted' AND json_extract(data,'$.dispatchId')=?").all(r.projectId,r.id,input.dispatchId);
 if(grant.length!==1||Number(grant[0].ordinal)>=Number(finished[0].ordinal))fail('RESULT_UNBOUND');
 const executedChecks=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='ToolResult' AND rowid>? AND rowid<? AND json_extract(data,'$.tool')='desk_run' ORDER BY rowid LIMIT 256").all(r.projectId,r.id,Number(grant[0].ordinal),Number(finished[0].ordinal))
  .flatMap(row=>{const data=object(JSON.parse(String(row.data)));return data.sliceId===sliceId?[{recordId:String(row.id),status:data.status,sourceHash:data.sourceHash,verifierVerdict:'NOT_CLAIMED'}]:[];});
 if(store.db.prepare("SELECT id FROM records WHERE run_id=? AND kind='PreworkPackageResult' AND json_extract(data,'$.dispatchId')=?").get(r.id,input.dispatchId))fail('RESULT_DUPLICATE');
 const result={schema:'dm.prework.work-package-result.v1',contractId:c.contractId,planBinding:c.planBinding,flowId:r.id,
  workPackageIds:packages.map(w=>w.workPackageId),...input,...(sliceId?{sliceId}:{}),startedAt:String(grant[0].at),finishedAt:String(finished[0].at),producedArtifacts:source.filter(f=>input.changedPaths.includes(f.path)),executedChecks,executionEvidence:r.mode==='live'?'ROLE_COMPLETED_NOT_VERIFIED':'SYNTHETIC_DEMO_NOT_LIVE',reviewIndependence:'R0',at:new Date().toISOString()};
 const recordId=store.record('PreworkPackageResult',r.projectId,r.id,result);store.event(r.projectId,r.id,'prework.result',{contractId:c.contractId,status:'awaiting-verification'});return recordId;
}
export function requiredPreworkReviewCoverage(
  contract:Pick<PreworkContract,'requirements'>,
  acceptanceEvidence:unknown,
  acceptance:{id:string;requirementIds:string[]}[],
  observedCases:readonly unknown[],
) {
  const casesByRequirement=new Map<string,Set<string>>();
  for(const rawCase of observedCases){
    const evidenceCase=object(rawCase),caseId=evidenceCase.id,requirementIds=evidenceCase.requirementIds;
    if(typeof caseId!=='string'||!caseId||!Array.isArray(requirementIds)||requirementIds.some(id=>typeof id!=='string'))fail('RESULT_COVERAGE_GAP');
    if(evidenceCase.ok!==true||evidenceCase.status!=='EXECUTED')continue;
    for(const requirementId of requirementIds as string[]){
      const ids=casesByRequirement.get(requirementId)??new Set<string>();
      ids.add(caseId);casesByRequirement.set(requirementId,ids);
    }
  }
  return contract.requirements.map(requirement=>({
    requirementId:requirement.requirementId,
    caseIds:[...(casesByRequirement.get(requirement.requirementId)??[])].sort(),
    acceptanceIds:acceptance.filter(item=>item.requirementIds.includes(requirement.requirementId)).map(item=>item.id).sort(),
  }));
}

export function preworkReviewMaterials(store:Store,r:Run,requiredCoverage?:ReturnType<typeof requiredPreworkReviewCoverage>) {
 if(!r.prework)return undefined; // Historical review is never retroactively labelled Prework.
 const contract=readPrework(store,r);
 const rows=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='PreworkPackageResult' ORDER BY rowid").all(r.projectId,r.id);
 const results:(Record<string,unknown>&{recordId:string})[]=rows.map(row=>({recordId:String(row.id),...object(JSON.parse(String(row.data)))}));
 const carried=contract.planner2.provenance?.carriedTaskIds??[];
 for(const w of contract.workPackages)if(!carried.includes(w.taskId)&&!results.some(x=>x.contractId===contract.contractId&&Array.isArray(x.workPackageIds)&&x.workPackageIds.includes(w.workPackageId)))fail('RESULT_COVERAGE_GAP');
 const carriedBaselineEvidence=contract.workPackages.filter(w=>carried.includes(w.taskId)).map(w=>({workPackageId:w.workPackageId,taskId:w.taskId,origin:'APPROVED_PARENT_BASELINE_NOT_NEW_EXECUTION',baselineRef:contract.baseline.snapshotRef,provenance:contract.planner2.provenance}));
  return{contract,results,...(carriedBaselineEvidence.length?{carriedBaselineEvidence}:{}),...(requiredCoverage?{requiredCoverage}:{}),closeoutPolicy:'A PASS must include preworkCoverage, one row per requirement: {requirementId,artifactPaths,caseIds,acceptanceIds}. requiredCoverage supplies the exact requirementId, caseIds and acceptanceIds to use; copy those arrays exactly and choose only actual packet source paths for artifactPaths. Do not add case-level acceptance ids that are not approved for that requirement. Cite only source files and actually EXECUTED successful cases in this exact packet. manualAcceptanceStatus NOT_RUN is expected controller state, not a code defect; final user acceptance is independent of technical review. Explicit approved-parent baseline references are inherited material, never a new role or dispatch result. R1 is the maximum established by separate product sessions; never promote minimum probes to project review.'};
}
