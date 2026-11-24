import {DomainError,hash,object} from '../security.js';
import {validateWritePaths} from '../flow/executor-slices.js';
import {handoffSchema} from './schema.js';

export interface PreworkPlanningProvenance {
 origin:'INHERITED_NOT_NEW_PLANNING';parentFlowId:string;approvalRef:string;approvalHash:string;
 planRecordRef:string;sessionRecordRef:string;evidenceHash:string;carriedTaskIds:string[];
}
export interface PreworkContext {
 projectId:string;flowId:string;planId:string;planVersion:number;planHash:string;approvedAt:string;
 sourceEpoch:string;baselineHash:string;baselineRecordRef?:string;baselineObservedAt?:string;sourcePaths?:string[];plannerSession:string;plannerRuntime:string;mode:'live'|'demo';
 requirements:{id:string;acceptance:string[]}[];executorSlots?:1|2;plannerProvenance?:PreworkPlanningProvenance;
 tasks:{id:string;dependsOn:string[];requirementIds:string[];acceptance:string[];writePaths?:string[]}[];
}
export interface WorkPackage {
 inheritedBaseline?:boolean;
 workPackageId:string;taskId:string;dependsOn:string[];requirementIds:string[];readPaths:string[];writePaths:string[];denyPaths:string[];
 inputs:string[];outputs:string[];checks:string[];stopConditions:string[];retryPolicy:'reconcile-before-retry';mergePolicy:'single-coordinator';sharedResources:string[];
 resourceClaims:{authority:'ORIGINAL_ENGINE_DISPATCH'|'NO_NEW_DISPATCH_INHERITED_BASELINE';executorSlots:0|1|2;maxConcurrentTools:0|1};
}
export interface PreworkContract {
 schema:'dm.prework.handoff.v1';contractId:string;projectId:string;flowId:string;
 planBinding:{planId:string;version:number;contentDigest:string;approvedAt:string};sourceEpoch:string;
 baseline:{candidateId:string;kind:'source-snapshot';tree:string;snapshotRef:string;observedAt:string;state:'consistent'};
 planner2:{role:'planner2';runtime:string;sessionRef:string;provenance?:PreworkPlanningProvenance};
 requirements:{requirementId:string;planRequirementRef:string;workPackageIds:string[];targetEvidence:string;targetReview:string;reachable:boolean;acceptance:string[]}[];
 workPackages:WorkPackage[];reviewPlan:{required:boolean;targetIndependence:string;reviewerRole:string;coverage:string[]};
 evidencePolicy:{immutableOutputs:{artifact:string;writer:string;strategy:string}[];controlCopies:{ref:string;verifiedBeforeUse:boolean;executionAfterVerification:boolean}[];artifactRoot:string};
 forecast:{bestReachableEvidence:string;disclosures:string[]};status:'ready-for-dispatch';createdAt:string;
}
const fail=(code='CONTRACT_INVALID'):never=>{throw new DomainError('PREWORK_'+code,409);};
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
const unique=(xs:string[])=>new Set(xs).size===xs.length;
const equalSet=(a:string[],b:string[])=>unique(a)&&unique(b)&&same([...a].sort(),[...b].sort());

/** Bounded interpreter for the trusted DM-owned schema. It validates data only;
 * no network, file access, coercion, inference, authorization or evidence signing. */
function shape(value:unknown,schema:unknown,depth=0):void {
 if(depth>20)fail();const s=object(schema);
 if(s.const!==undefined&&!same(value,s.const))fail();
 if(Array.isArray(s.enum)&&!s.enum.some(v=>same(v,value)))fail();
 const types=Array.isArray(s.type)?s.type:[s.type];
 if(s.type!==undefined&&!types.some(t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?!!value&&typeof value==='object'&&!Array.isArray(value):t==='integer'?Number.isSafeInteger(value):typeof value===t))fail();
 if(typeof value==='string'){
  if(value.length>16000||typeof s.minLength==='number'&&value.length<s.minLength||typeof s.pattern==='string'&&!new RegExp(s.pattern).test(value)||s.format==='date-time'&&(!/^\d{4}-\d\d-\d\dT/.test(value)||!Number.isFinite(Date.parse(value))))fail();
 }
 if(typeof value==='number'&&(!Number.isFinite(value)||typeof s.minimum==='number'&&value<s.minimum))fail();
 if(Array.isArray(value)){
  if(value.length>512||typeof s.minItems==='number'&&value.length<s.minItems||s.uniqueItems===true&&!unique(value.map(v=>JSON.stringify(v))))fail();
  if(s.items)value.forEach(v=>shape(v,s.items,depth+1));
 }else if(value&&typeof value==='object'){
  const o=object(value),props=object(s.properties??{});
  if(Object.keys(o).some(k=>['__proto__','constructor','prototype'].includes(k)))fail();
  if(Array.isArray(s.required)&&s.required.some(k=>typeof k!=='string'||!Object.hasOwn(o,k)))fail();
  if(s.additionalProperties===false&&Object.keys(o).some(k=>!Object.hasOwn(props,k)))fail();
  for(const [key,v] of Object.entries(o))if(Object.hasOwn(props,key))shape(v,props[key],depth+1);
  if(Array.isArray(s.allOf))for(const clause of s.allOf){
   const c=object(clause),condition=object(c.if??{});
   const present=!Array.isArray(condition.required)||condition.required.every(k=>typeof k==='string'&&Object.hasOwn(o,k));
   const matches=present&&Object.entries(object(condition.properties??{})).every(([k,v])=>!Object.hasOwn(o,k)||same(o[k],object(v).const));
   if(matches&&c.then)shape(o,c.then,depth+1);
  }
 }
}

export function validatePrework(raw:unknown,ctx:PreworkContext):PreworkContract {
 let data:unknown;
 try {if(typeof raw==='string'&&Buffer.byteLength(raw)>256000)fail();data=typeof raw==='string'?JSON.parse(raw):structuredClone(raw);if(Buffer.byteLength(JSON.stringify(data))>256000)fail();shape(data,handoffSchema);}
 catch(error){if(error instanceof DomainError&&error.code.startsWith('PREWORK_'))throw error;return fail();}
 const c=data as PreworkContract;
 if(c.status!=='ready-for-dispatch')fail('NOT_READY');
 if(c.projectId!==ctx.projectId||c.flowId!==ctx.flowId||c.sourceEpoch!==ctx.sourceEpoch||
  !same(c.planBinding,{planId:ctx.planId,version:ctx.planVersion,contentDigest:ctx.planHash,approvedAt:ctx.approvedAt}))fail('STALE_PLAN');
 if(c.baseline.state!=='consistent'||c.baseline.kind!=='source-snapshot'||c.baseline.tree!==ctx.baselineHash||c.baseline.candidateId!=='baseline_'+ctx.baselineHash||c.baseline.snapshotRef!==(ctx.baselineRecordRef??'synthetic-baseline')||c.baseline.observedAt!==(ctx.baselineObservedAt??ctx.approvedAt))fail('BASELINE_DRIFT');
 if(c.planner2.sessionRef!==ctx.plannerSession||c.planner2.runtime!==ctx.plannerRuntime)fail('PLANNER_IDENTITY_CHANGED');
 if(!same(c.planner2.provenance??null,ctx.plannerProvenance??null))fail('PLANNER_IDENTITY_CHANGED');
 if(!/^[a-f0-9]{64}$/.test(ctx.baselineHash)||!Number.isSafeInteger(ctx.planVersion)||ctx.planVersion<1||!ctx.plannerSession||!ctx.sourceEpoch)fail();
 if(!equalSet(c.requirements.map(r=>r.requirementId),ctx.requirements.map(r=>r.id))||!equalSet(c.workPackages.map(w=>w.taskId),ctx.tasks.map(t=>t.id))||!unique(c.workPackages.map(w=>w.workPackageId)))fail('COVERAGE_GAP');
 if(!c.reviewPlan.required||c.reviewPlan.reviewerRole!=='reviewer'||c.reviewPlan.targetIndependence!==(ctx.mode==='live'?'R1':'R0')||!equalSet(c.reviewPlan.coverage,ctx.requirements.map(r=>r.id)))fail('REVIEW_ROUTE_UNVERIFIED');
 // Existing product sessions prove at most R1. Nonempty strings are never R2 evidence.
 for(const row of c.requirements){
  const original=ctx.requirements.find(r=>r.id===row.requirementId)!;
  const expected=c.workPackages.filter(w=>w.requirementIds.includes(row.requirementId)).map(w=>w.workPackageId);
  if(!row.reachable)fail('CAPABILITY_GAP');
  if(row.planRequirementRef!==ctx.planId+':'+row.requirementId||!expected.length||!equalSet(row.workPackageIds,expected)||!same(row.acceptance,original.acceptance)||row.targetReview!==(ctx.mode==='live'?'R1':'R0'))fail('COVERAGE_GAP');
  if(row.targetEvidence!==(ctx.mode==='live'?'E5':'E2'))fail('EVIDENCE_TARGET_CHANGED');
 }
 const visiting=new Set<string>(),seen=new Set<string>();
 const visit=(id:string):void=>{if(visiting.has(id))fail('DAG_CYCLE');if(seen.has(id))return;const w=c.workPackages.find(w=>w.taskId===id);if(!w)return fail('DAG_REFERENCE');visiting.add(id);w.dependsOn.forEach(visit);visiting.delete(id);seen.add(id);};
 for(const w of c.workPackages){
  const task=ctx.tasks.find(t=>t.id===w.taskId)!;
  const carried=ctx.plannerProvenance?.carriedTaskIds.includes(task.id)??false;
  // Absence is the original v1 executing-package representation. Never mutate
  // immutable old bytes/digests; inherited packages need explicit true authority.
  if((w.inheritedBaseline??false)!==carried)fail('WORK_PACKAGE_CHANGED');
  let paths:string[];try{paths=carried?[]:validateWritePaths(w.writePaths);}catch{return fail('SCOPE_INVALID');}
  if(!same(w.writePaths,paths)||!same(paths,carried?[]:task.writePaths)||!equalSet(w.dependsOn,task.dependsOn)||!equalSet(w.requirementIds,task.requirementIds)||!carried&&!w.requirementIds.length||!same(w.checks,task.acceptance)||!same(w.outputs,paths)||w.retryPolicy!=='reconcile-before-retry'||w.mergePolicy!=='single-coordinator')fail('WORK_PACKAGE_CHANGED');
  const allPaths=[...new Set([...(ctx.sourcePaths??[]),...ctx.tasks.flatMap(t=>t.writePaths??[])])];
  if(paths.some(p=>/^(?:\.runtime|\.git|node_modules)(?:\/|$)/i.test(p))||!same(w.denyPaths,['.runtime/','.git/','node_modules/'])||!same(w.stopConditions,['binding-changed','scope-exceeded','result-uncertain'])||!same(w.sharedResources,[])||!same(w.readPaths,carried?[]:allPaths)||!same(w.inputs,[ctx.planId]))fail('SCOPE_INVALID');
  if(!same(w.resourceClaims,carried?{authority:'NO_NEW_DISPATCH_INHERITED_BASELINE',executorSlots:0,maxConcurrentTools:0}:{authority:'ORIGINAL_ENGINE_DISPATCH',executorSlots:ctx.executorSlots??2,maxConcurrentTools:1}))fail('RESOURCE_CLAIM_CHANGED');
  visit(w.taskId);
 }
 const ancestry=new Map<string,Set<string>>();
 const ancestors=(task:string):Set<string>=>{
  const cached=ancestry.get(task);if(cached)return cached;
  const all=new Set<string>();for(const id of c.workPackages.find(w=>w.taskId===task)!.dependsOn){all.add(id);for(const parent of ancestors(id))all.add(parent);}ancestry.set(task,all);return all;
 };
 const folded=(s:string)=>s.normalize('NFC').toLowerCase().replace(/\/$/,'');
 const overlaps=(a:string,b:string)=>{a=folded(a);b=folded(b);return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');};
 for(let i=0;i<c.workPackages.length;i++)for(let j=i+1;j<c.workPackages.length;j++){
  const a=c.workPackages[i],b=c.workPackages[j];
  if(!ancestors(a.taskId).has(b.taskId)&&!ancestors(b.taskId).has(a.taskId)&&a.writePaths.some(x=>b.writePaths.some(y=>overlaps(x,y))))fail('PARALLEL_WRITE_CONFLICT');
 }
 const evidenceRoot='prework/'+ctx.sourceEpoch+'/'+ctx.flowId+'/'+c.contractId;
 if(c.evidencePolicy.artifactRoot!==evidenceRoot||!same(c.evidencePolicy.immutableOutputs,[{artifact:'work-package-results',writer:'controller',strategy:'append-only'},{artifact:'review-packet',writer:'controller',strategy:'append-only'}])||c.evidencePolicy.controlCopies.length)fail('EVIDENCE_MUTATION_RISK');
 if(c.forecast.bestReachableEvidence!==(ctx.mode==='live'?'E5':'E2')||c.forecast.disclosures.length)fail('CAPABILITY_GAP');
 const {contractId,...body}=structuredClone(c);body.evidencePolicy.artifactRoot='';
 if(contractId!=='prework_'+hash(body))fail('DIGEST_CHANGED');
 return c;
}

/** Normalize the already validated Planner 2 DAG using controller-owned bindings.
 * This forecasts evidence collection; it never says the work or review has passed. */
export function buildPrework(ctx:PreworkContext):PreworkContract {
 // A planner naturally names the shared entry file in several slices, so the frozen plan can contain
 // sibling tasks that both declare it. The contract cannot run those in parallel and refusing the whole
 // plan (PARALLEL_WRITE_CONFLICT) discarded otherwise valid work, so an overlap between tasks that are
 // not already ordered becomes an ordering edge here instead of a rejection.
 const overlapFold=(s:string)=>s.normalize('NFC').toLowerCase().replace(/\/$/,'');
 const overlapOf=(a:string,b:string)=>{const x=overlapFold(a),y=overlapFold(b);return x===y||x.startsWith(y+'/')||y.startsWith(x+'/');};
 const order=new Map<string,string[]>(ctx.tasks.map(t=>[t.id,[...(t.dependsOn??[])]]));
 const upstream=(id:string):Set<string>=>{const seen=new Set<string>();const walk=(from:string)=>{for(const d of order.get(from)??[]){if(seen.has(d))continue;seen.add(d);walk(d);}};walk(id);return seen;};
 const orderedIds=[...ctx.tasks].map(t=>t.id).sort();
 for(let i=0;i<orderedIds.length;i++)for(let j=i+1;j<orderedIds.length;j++){
  const a=ctx.tasks.find(t=>t.id===orderedIds[i])!,b=ctx.tasks.find(t=>t.id===orderedIds[j])!;
  if(upstream(a.id).has(b.id)||upstream(b.id).has(a.id))continue;
  const wa=a.writePaths??[],wb=b.writePaths??[];
  if(!wa.some(x=>wb.some(y=>overlapOf(x,y))))continue;
  const list=order.get(b.id)!;if(!list.includes(a.id))list.push(a.id);
 }
 const workPackages:WorkPackage[]=ctx.tasks.map(t=>{
  const inheritedBaseline=ctx.plannerProvenance?.carriedTaskIds.includes(t.id)??false;
  const paths=inheritedBaseline?[]:t.writePaths??[];
  return{inheritedBaseline,workPackageId:'wp_'+t.id,taskId:t.id,dependsOn:order.get(t.id)??t.dependsOn,requirementIds:t.requirementIds,
   readPaths:inheritedBaseline?[]:[...new Set([...(ctx.sourcePaths??[]),...ctx.tasks.flatMap(t=>t.writePaths??[])])],
   writePaths:paths,denyPaths:['.runtime/','.git/','node_modules/'],inputs:[ctx.planId],outputs:paths,checks:t.acceptance,
   stopConditions:['binding-changed','scope-exceeded','result-uncertain'],retryPolicy:'reconcile-before-retry',mergePolicy:'single-coordinator',sharedResources:[],
   resourceClaims:inheritedBaseline?{authority:'NO_NEW_DISPATCH_INHERITED_BASELINE',executorSlots:0,maxConcurrentTools:0}:{authority:'ORIGINAL_ENGINE_DISPATCH',executorSlots:ctx.executorSlots??2,maxConcurrentTools:1}};
 });
 const body={schema:'dm.prework.handoff.v1' as const,projectId:ctx.projectId,flowId:ctx.flowId,
  planBinding:{planId:ctx.planId,version:ctx.planVersion,contentDigest:ctx.planHash,approvedAt:ctx.approvedAt},sourceEpoch:ctx.sourceEpoch,
  baseline:{candidateId:'baseline_'+ctx.baselineHash,kind:'source-snapshot' as const,tree:ctx.baselineHash,snapshotRef:ctx.baselineRecordRef??'synthetic-baseline',observedAt:ctx.baselineObservedAt??ctx.approvedAt,state:'consistent' as const},
  planner2:{role:'planner2' as const,runtime:ctx.plannerRuntime,sessionRef:ctx.plannerSession,...(ctx.plannerProvenance?{provenance:structuredClone(ctx.plannerProvenance)}:{})},
  requirements:ctx.requirements.map(r=>({requirementId:r.id,planRequirementRef:ctx.planId+':'+r.id,workPackageIds:workPackages.filter(w=>w.requirementIds.includes(r.id)).map(w=>w.workPackageId),targetEvidence:ctx.mode==='live'?'E5':'E2',targetReview:ctx.mode==='live'?'R1':'R0',reachable:true,acceptance:r.acceptance})),
  workPackages,reviewPlan:{required:true,targetIndependence:ctx.mode==='live'?'R1':'R0',reviewerRole:'reviewer',coverage:ctx.requirements.map(r=>r.id)},
  evidencePolicy:{immutableOutputs:[{artifact:'work-package-results',writer:'controller',strategy:'append-only'},{artifact:'review-packet',writer:'controller',strategy:'append-only'}],controlCopies:[],artifactRoot:''},
  forecast:{bestReachableEvidence:ctx.mode==='live'?'E5':'E2',disclosures:[]},status:'ready-for-dispatch' as const,createdAt:new Date().toISOString()};
 // The output namespace is derived after hashing the body without the namespace.
 const id='prework_'+hash(body);body.evidencePolicy.artifactRoot='prework/'+ctx.sourceEpoch+'/'+ctx.flowId+'/'+id;
 // Avoid a self-referential digest: final identity excludes only the derived root.
 const c={...body,contractId:id};return validatePrework(c,ctx);
}
export function assertWorkPackage(raw:unknown,ctx:PreworkContext,taskId:string,completed:string[]):WorkPackage {
 const c=validatePrework(raw,ctx);if(c.planner2.provenance?.carriedTaskIds.includes(taskId))return fail('CARRIED_TASK_NOT_DISPATCHABLE');
 const w=c.workPackages.find(w=>w.taskId===taskId);if(!w||w.dependsOn.some(id=>!completed.includes(id)))return fail('DEPENDENCY_NOT_READY');return structuredClone(w);
}
export function preworkCloseout(c:PreworkContract,actual:{requirementId:string;evidence:string;review:string;artifactRef:string}[]) {
 const matrix=c.requirements.map(r=>{const a=actual.filter(x=>x.requirementId===r.requirementId);const reached=a.some(x=>/^E[1-5]$/.test(x.evidence)&&/^R[0-2]$/.test(x.review)&&x.evidence>=r.targetEvidence&&x.review>=r.targetReview&&!!x.artifactRef);return{requirementId:r.requirementId,plannedEvidence:r.targetEvidence,plannedReview:r.targetReview,actual:a,reached};});
 return{schema:'dm.prework.closeout.v1',contractId:c.contractId,coverageReached:matrix.every(x=>x.reached),matrix};
}
export function projectPreworkEvent(sourceEpoch:string,e:{id:number;type:string;projectId:string|null;runId:string|null;at:string;payload:unknown}) {
 if(!['prework.ready','prework.blocked','prework.result','prework.closeout'].includes(e.type))return null;
 if(!/^[a-zA-Z0-9_-]{8,160}$/.test(sourceEpoch)||!Number.isSafeInteger(e.id)||e.id<1)fail('EVENT_INVALID');
 const p=object(e.payload);return{schema:'dm.prework.event.v1',key:sourceEpoch+':'+e.id,sourceEpoch,eventId:e.id,projectId:e.projectId,flowId:e.runId,at:e.at,type:e.type,
  payload:{...(typeof p.contractId==='string'&&/^prework_[a-f0-9]{64}$/.test(p.contractId)?{contractId:p.contractId}:{}),...(['ready-for-dispatch','blocked','awaiting-verification','coverage-reached'].includes(String(p.status))?{status:p.status}:{})}};
}
