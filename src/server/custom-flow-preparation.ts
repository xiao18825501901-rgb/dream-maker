import type {Store} from './store.js';import type {Config,Run} from '../shared/types.js';
import type {CustomFlowPreparation,CustomFlowPreparationRef} from '../shared/custom-flow-preparation.js';
import {FlowProfiles} from './flow-profiles.js';import {canReviseAfterFlow} from './flow/conclusion.js';
import {assertCustomSnapshot,customFlowSnapshot} from './flow-configuration.js';
import {DomainError,hash,id,now,object} from './security.js';
import {executionWorkspace} from './workspace-location.js';import {treeHash} from './workspace.js';import {dirname} from 'node:path';
import {lstatSync} from 'node:fs';
import {reviewPreparationBasis} from './review-preparation-retry.js';

const identity=(v:CustomFlowPreparation['flowConfig'])=>hash({projectId:v.projectId,specHash:v.plan.specHash,planHash:v.plan.contentHash,profileHash:v.profile.contentHash,configurationFingerprint:v.configurationFingerprint});
function storedPreparation(raw:unknown,projectId:string):CustomFlowPreparation {
 const fail=():never=>{throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);};
 try{const v=object(raw),keys=['schema','projectId','identityHash','flowConfig','flowConfigHash','createdAt','scope','executionGranted','contentHash'];
  if(Reflect.ownKeys(v).length!==keys.length||keys.some(key=>!Object.hasOwn(v,key)))return fail();
  assertCustomSnapshot(v.flowConfig);const {contentHash,...body}=v;
  if(v.schema!=='dream-maker.custom-flow-preparation.v1'||v.projectId!==projectId||v.flowConfig.projectId!==projectId||v.scope!=='CONFIGURATION_PREPARATION_ONLY'||v.executionGranted!==false||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||v.flowConfigHash!==hash(v.flowConfig)||v.identityHash!==identity(v.flowConfig)||contentHash!==hash(body))return fail();
  return structuredClone(v) as unknown as CustomFlowPreparation;
 }catch{return fail();}
}
/** Configuration preparation in the original Store, not a second run queue or authority. */
export class CustomFlowPreparations {
 constructor(private store:Store,private config:()=>Config){}
 /** Re-read only the exact frozen preparation of a clean paused Flow, or an
  * undispatched first-review recovery. This cannot
  * revise its configuration, release its lease, qualify a role or resume execution. */
 private pausedPreparationReadable(value:CustomFlowPreparation,blocking:Run[]):boolean{
  if(blocking.length!==1)return false;
  const run=blocking[0],project=this.store.project(value.projectId),snapshot=value.flowConfig;
  const firstReviewRecovery=run.state==='BLOCKED'&&run.phase==='REVIEWING'&&run.reason==='REVIEW_ROLE_EVIDENCE_REQUIRED';
  // Reading the exact frozen preparation is required to refresh stale role
  // receipts before the strict one-shot transport retry can run. This does not
  // grant execution: prepareReviewTransportRetry still rebuilds and validates
  // the packet, basis, cleanup and Native admission.
  const transportParseRecovery=run.state==='BLOCKED'&&run.phase==='REVIEWING'&&run.reason==='UPSTREAM_HTTP_502'&&
   run.review===null&&run.sessions?.reviewer===undefined&&run.roleIdentities?.reviewer===undefined&&
   run.verification?.ok===true&&Array.isArray(run.tasks)&&run.tasks.length>0&&run.tasks.every(task=>task.status==='implemented')&&
   !this.store.db.prepare("SELECT 1 FROM records WHERE project_id=? AND run_id=? AND kind IN ('ReviewTransportRetryPreparation','ReviewTransportRetryRecovery') LIMIT 1").get(run.projectId,run.id);
  if(run.id!==snapshot.runId||project.activeRunId!==run.id||run.mode!=='live'||run.flowName!=='custom'||run.rolePolicy!=='CUSTOM_FROZEN_V1'||
   run.state!=='PAUSED'&&!firstReviewRecovery&&!transportParseRecovery||!this.store.owns(project.id,run.id)||run.projectId!==project.id||run.specId!==project.specId||
   run.specHash!==snapshot.plan.specHash||run.planVersionHash!==snapshot.plan.contentHash||run.flowConfigHash!==value.flowConfigHash||
   hash(run.flowConfig)!==value.flowConfigHash||run.configFingerprint!==snapshot.configurationFingerprint||!run.treeHash||
   !this.store.approved(project.id,run.specHash,'BUILD'))return false;
  executionWorkspace(run,dirname(this.store.path));
  try{const stat=lstatSync(run.workspace);if(!stat.isDirectory()||stat.isSymbolicLink())return false;}catch{return false;}
  if(treeHash(run.workspace)!==run.treeHash)return false;
  const rows=this.store.db.prepare("SELECT kind,data FROM records WHERE project_id=? AND run_id=? AND kind IN ('DispatchGranted','DispatchFinished') ORDER BY rowid LIMIT 257")
   .all(project.id,run.id).map(row=>({kind:row.kind,data:object(JSON.parse(String(row.data)))}));
  if(rows.length>256)return false;
  const grants=rows.filter(r=>r.kind==='DispatchGranted'),finished=rows.filter(r=>r.kind==='DispatchFinished');
  if(run.calls>0&&!grants.length||finished.length!==grants.length)return false;
  const ids=new Set<unknown>();
  for(const grant of grants){
   const d=grant.data;if(typeof d.dispatchId!=='string'||!/^dispatch_[a-f0-9]{20}$/.test(d.dispatchId)||typeof d.generation!=='string'||!/^dispatch_owner_[a-f0-9]{20}$/.test(d.generation)||ids.has(d.dispatchId))return false;ids.add(d.dispatchId);
   const ends=finished.filter(r=>r.data.dispatchId===d.dispatchId);
   if(ends.length!==1||ends[0].data.generation!==d.generation||ends[0].data.cleanupReturned!==true)return false;
  }
  if(firstReviewRecovery){
   // Eligibility only: the real Engine must rebuild the packet, verify current
   // Native qualification and perform its original cleanup/admission checks.
   try{if(!reviewPreparationBasis(this.store,run,'0'.repeat(64),{allowPacketRebuild:true}).preDispatch)return false;}
   catch{return false;}
  }
  return true;
 }
 /** Immutable metadata only; current eligibility cannot hide an old operation. */
 historical(projectId:string,expected:CustomFlowPreparationRef):CustomFlowPreparation{
  const ref=object(expected);if(Object.keys(ref).length!==2||typeof ref.identityHash!=='string'||!/^[a-f0-9]{64}$/.test(ref.identityHash)||typeof ref.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(ref.contentHash))throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);
  const rows=this.store.db.prepare("SELECT data FROM records WHERE project_id=? AND kind='CustomFlowPrepared' AND json_extract(data,'$.identityHash')=? AND json_extract(data,'$.contentHash')=? LIMIT 2").all(projectId,ref.identityHash,ref.contentHash);
  if(rows.length!==1)throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);
  return storedPreparation(JSON.parse(String(rows[0].data)),projectId);
 }
 prepareCurrent(projectId:string,specHash:string):CustomFlowPreparation {
  const profile=new FlowProfiles(this.store).current(projectId);if(!profile)throw new DomainError('FLOW_PROFILE_REQUIRED',409);
  return this.prepare(projectId,specHash,profile.contentHash);
 }
 prepare(projectId:string,specHash:string,profileHash:string,expected?:CustomFlowPreparationRef):CustomFlowPreparation {
  return this.store.tx(()=>{
   let bound:CustomFlowPreparationRef|undefined;
   if(expected!==undefined){
    const value=object(expected),identityHash=value.identityHash,contentHash=value.contentHash;
    if(Reflect.ownKeys(value).length!==2||!Object.hasOwn(value,'identityHash')||!Object.hasOwn(value,'contentHash')||typeof identityHash!=='string'||typeof contentHash!=='string'||!/^[a-f0-9]{64}$/.test(identityHash)||!/^[a-f0-9]{64}$/.test(contentHash))throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);
    bound={identityHash,contentHash};
   }
   const project=this.store.project(projectId);
   if(!project.specId||project.state!=='READY_TO_BUILD')throw new DomainError('SPEC_NOT_APPROVED',409);
   const spec=this.store.spec(project.specId),plan=this.store.planVersion(spec.id);
   if(spec.stale||spec.hash!==specHash||!this.store.approved(projectId,specHash,'SPEC'))throw new DomainError('SPEC_APPROVAL_STALE',409);
   if(!plan.approval)throw new DomainError('PLAN_VERSION_APPROVAL_REQUIRED',409);
   const blocking=this.store.runs(projectId).filter(run=>!canReviseAfterFlow(this.store,run));
   if(!bound&&blocking.length)throw new DomainError('FLOW_TERMINATION_REQUIRED',409);
   const profile=new FlowProfiles(this.store).current(projectId);if(!profile)throw new DomainError('FLOW_PROFILE_REQUIRED',409);
   if(profile.contentHash!==profileHash)throw new DomainError('FLOW_PROFILE_STALE',409);
   const config=this.config(),candidate=customFlowSnapshot(config,plan,id('run'),profile),identityHash=identity(candidate);
   if(bound&&bound.identityHash!==identityHash)throw new DomainError('FLOW_PREPARATION_STALE',409);
   const rows=this.store.db.prepare("SELECT data FROM records WHERE project_id=? AND kind='CustomFlowPrepared' ORDER BY rowid LIMIT 129").all(projectId);
   if(rows.length>128)throw new DomainError('FLOW_PREPARATION_LIMIT',409);
   const saved=rows.map(row=>{try{return storedPreparation(JSON.parse(String(row.data)),projectId);}catch{throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);}}),matches=saved.filter(value=>value.identityHash===identityHash);
   if(bound){
    const exact=matches.filter(value=>value.contentHash===bound.contentHash);if(exact.length!==1)throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);
    const value=exact[0],snapshot=customFlowSnapshot(config,plan,value.flowConfig.runId,profile);if(hash(snapshot)!==value.flowConfigHash)throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);
    if(blocking.length&&!this.pausedPreparationReadable(value,blocking))throw new DomainError('FLOW_TERMINATION_REQUIRED',409);return value;
   }
   // A prepared snapshot owns a prospective run id. Once that run exists, even as a terminal
   // historical failure, reusing the snapshot would collide with its immutable run row. Return
   // an existing unused preparation for idempotent pre-build replay; otherwise freeze a fresh
   // run identity while preserving the same role/plan/profile identity.
   const unused=matches.filter(value=>!this.store.db.prepare('SELECT 1 FROM runs WHERE id=?').get(value.flowConfig.runId));
   if(unused.length>1)throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);
   if(unused.length){const value=unused[0],snapshot=customFlowSnapshot(config,plan,value.flowConfig.runId,profile);if(hash(snapshot)!==value.flowConfigHash)throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);return value;}
   if(rows.length>=128)throw new DomainError('FLOW_PREPARATION_LIMIT',409);
   const body={schema:'dream-maker.custom-flow-preparation.v1' as const,projectId,identityHash,flowConfig:candidate,flowConfigHash:hash(candidate),createdAt:now(),scope:'CONFIGURATION_PREPARATION_ONLY' as const,executionGranted:false as const},value={...body,contentHash:hash(body)};
   this.store.record('CustomFlowPrepared',projectId,null,value);return storedPreparation(value,projectId);
  });
 }
}
