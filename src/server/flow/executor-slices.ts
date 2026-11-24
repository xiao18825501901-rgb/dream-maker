import {DomainError,hash,id,now,within} from '../security.js';
import type {Task,Run} from '../../shared/types.js';
import {mkdirSync,existsSync,lstatSync,readdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,statfsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {Store} from '../store.js';
import {files,get,treeHash} from '../workspace.js';
import {executionWorkspace} from '../workspace-location.js';
import {assertMaintenanceRoom} from '../maintenance-storage.js';
import type {MergeRecoveryPreview,MergeSourceState} from '../../shared/merge-recovery.js';
import type {ExecutorCheckpointPreview,ExecutorCheckpointRequest,ExecutorCheckpointResult,ExecutorCheckpointResumeResult} from '../../shared/executor-checkpoint.js';
import {recoverySourceBody} from './recovery-source.js';
import {assertFlowSnapshot} from '../flow-configuration.js';
const folded=(name:string)=>name.normalize('NFC').toLowerCase();
/** The one list of reasons a retained checkpoint may recover from; the Engine reuses it for resume. */
export const checkpointReasons:ReadonlySet<string>=new Set(['EXECUTOR_SLICE_RESULT_UNCERTAIN','WORKER_RESTART_RESULT_UNCERTAIN','PROCESS_CLEANUP_UNPROVEN','EXECUTOR_TASK_TOOL_LIMIT','USER_BUDGET_LIMIT']);
function validPath(name:string):boolean{
 if(!name||name.length>500||name!==name.normalize('NFC')||/[\\:*?<>|\x00-\x1f]/.test(name))return false;
 return name.split('/').every(part=>!!part&&!['.','..','.git','node_modules','auth.json','credentials.json'].includes(folded(part))&&!/^\.env(?:\.|$)/i.test(part)&&!/[. ]$/.test(part)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function validateWritePaths(value:unknown):string[]{
 if(!Array.isArray(value)||!value.length||value.length>32)throw new DomainError('EXECUTOR_WRITE_SCOPE_INVALID',502);
 const seen=new Set<string>();
 return value.map(name=>{if(typeof name!=='string'||!validPath(name.endsWith('/')?name.slice(0,-1):name)||seen.has(folded(name)))throw new DomainError('EXECUTOR_WRITE_SCOPE_INVALID',502);seen.add(folded(name));return name;});
}
export function executorMayWrite(scopes:string[],name:string):boolean{
 if(!validPath(name))return false;const path=folded(name);
 return scopes.some(scope=>scope.endsWith('/')?path.startsWith(folded(scope)):path===folded(scope));
}
function overlap(a:string,b:string):boolean{
 a=folded(a).replace(/\/$/,'');b=folded(b).replace(/\/$/,'');return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
}
/** A proposal only; original dispatch/lease, native admission and budget still grant every turn. */
export function selectExecutorWave(tasks:Task[]):Task[]{
 const chosen:Task[]=[];
 for(const task of tasks){
  if(chosen.length===4)break;
  if(task.status!=='pending'||!task.writePaths||!task.dependsOn.every(id=>tasks.some(other=>other.id===id&&['implemented','done'].includes(other.status))))continue;
  const scope=validateWritePaths(task.writePaths);
  if(chosen.some(other=>other.writePaths!.some(a=>scope.some(b=>overlap(a,b)))))continue;
  chosen.push(task);
 }
 return chosen;
}
type Catalog=ReturnType<typeof files>;
export interface ExecutorAssignment {id:string;taskId:string;workspace:string;writePaths:string[];executorRoleId?:string}
export interface ExecutorWave {id:string;runId:string;projectId:string;sourceHash:string;specHash:string;configFingerprint:string;attempt:number;repairCount:number;directory:string;catalog:Catalog;assignments:ExecutorAssignment[];executorRoleOffset?:number}
function fail(code:string):never{throw new DomainError(code,409);}
/** Configured actors only; this never qualifies an account/model or expands dispatch slots. */
function executorRoles(run:Run):string[]{
 assertFlowSnapshot(run);
 if(run.flowConfig?.mode==='custom'){
  const roles=run.flowConfig.roles.executors.filter(role=>role.permissions.includes('source_read')&&role.permissions.includes('source_write')).map(role=>role.id);
  if(!roles.length)fail('EXECUTOR_ROLE_WRITE_PERMISSION_REQUIRED');return roles;
 }
 if(run.flowConfig&&(run.flowConfig.roles.executors.length!==1||run.flowConfig.roles.executors[0].id!=='executor-1'))fail('EXECUTOR_ROLE_BINDING_CHANGED');
 return ['executor-1'];
}
/** Canonical turns/repairs choose the first frozen writer; slices keep their anchored actor. */
export function executorRoleForTurn(run:Run,assignment?:ExecutorAssignment):string {
 const roles=executorRoles(run),selected=assignment?.executorRoleId;
 if(assignment&&selected===undefined&&run.flowConfig?.mode==='custom'||selected!==undefined&&!roles.includes(selected))fail('EXECUTOR_ROLE_BINDING_CHANGED');
 return selected??roles[0];
}
export function executorWaveReservation(baseBytes:number,taskCount:number){return baseBytes+20000000*(taskCount+2)+4000000;}
export function assertExecutorStageGrowth(used:number,additional:number){if(![used,additional,used+additional].every(n=>Number.isSafeInteger(n)&&n>=0)||used+additional>512000000)fail('EXECUTOR_SLICE_STORAGE_LIMIT');}
/** Original Store records bind copies; this helper cannot dispatch, approve or accept a Flow. */
export class ExecutorSlices {
 constructor(private store:Store,private data:string){}
 private rows(rid:string,kind:string){const r=this.store.run(rid);return this.store.records(r.projectId,kind).filter(row=>row.runId===rid);}
 private settledWaves(rid:string){return new Set([...this.rows(rid,'ExecutorMergeApplied'),...this.rows(rid,'ExecutorMergeRecovered'),...this.rows(rid,'ExecutorCheckpointPrepared')].map(row=>row.data.waveId));}
 hasUncertainMerge(rid:string){const settled=this.settledWaves(rid);return this.rows(rid,'ExecutorMergeIntent').some(row=>!settled.has(row.data.waveId));}
 private current(rid:string,wave?:ExecutorWave,allowPause=false){
  const r=this.store.run(rid);executionWorkspace(r,this.data);
  if(this.hasUncertainMerge(rid))fail('EXECUTOR_MERGE_RESULT_UNCERTAIN');
  if(!(r.state==='IMPLEMENTING'||allowPause&&r.state==='PAUSE_REQUESTED')||r.phase!=='IMPLEMENTING'||!this.store.owns(r.projectId,r.id))fail('EXECUTOR_SLICE_NOT_ACTIVE');
  const p=this.store.project(r.projectId),s=this.store.spec(r.specId);
  if(p.specId!==r.specId||p.activeRunId!==rid||s.stale||s.hash!==r.specHash||!this.store.approved(p.id,r.specHash,'SPEC')||!this.store.approved(p.id,r.specHash,'BUILD'))fail('EXECUTOR_SLICE_BINDING_CHANGED');
  if(wave&&(r.specHash!==wave.specHash||r.configFingerprint!==wave.configFingerprint||r.repairCount!==wave.repairCount||r.treeHash!==wave.sourceHash))fail('EXECUTOR_SLICE_BINDING_CHANGED');
  if(r.treeHash!==treeHash(r.workspace))fail('EXECUTOR_SOURCE_CHANGED');return r;
 }
 private path(rid:string,wid:string){if(!/^[A-Za-z0-9_-]{1,100}$/.test(wid))fail('EXECUTOR_SLICE_ID_INVALID');return within(this.data,'controller/executor-waves/'+rid+'/'+wid);}
 private custody(rid:string,wid:string):ExecutorWave{
  const matches=this.rows(rid,'ExecutorWavePrepared').filter(row=>row.data.id===wid);if(matches.length!==1)fail('EXECUTOR_SLICE_UNKNOWN');
  const manifest=within(this.path(rid,wid),'wave.json'),stat=lstatSync(manifest);if(!stat.isFile()||stat.size>4000000)fail('EXECUTOR_SLICE_BINDING_CHANGED');const body=readFileSync(manifest);
  if(body.length>4000000||hash(body)!==matches[0].data.manifestHash)fail('EXECUTOR_SLICE_BINDING_CHANGED');
  let wave:ExecutorWave;try{wave=JSON.parse(body.toString('utf8'));}catch{fail('EXECUTOR_SLICE_BINDING_CHANGED');}const r=this.store.run(rid);executionWorkspace(r,this.data);
  if(wave.id!==wid||wave.directory!==this.path(rid,wid)||wave.projectId!==r.projectId||wave.runId!==rid||wave.specHash!==r.specHash||wave.configFingerprint!==r.configFingerprint||wave.repairCount!==r.repairCount||!Array.isArray(wave.assignments)||!wave.assignments.length||wave.assignments.length>4||hash(wave.catalog)!==wave.sourceHash)fail('EXECUTOR_SLICE_BINDING_CHANGED');
  const roles=executorRoles(r);
  const offset=wave.executorRoleOffset??0,recordOffset=matches[0].data.executorRoleOffset;
  if(!Number.isSafeInteger(offset)||offset<0||offset>=roles.length||recordOffset!==undefined&&recordOffset!==offset||r.flowConfig?.mode==='custom'&&(wave.executorRoleOffset===undefined||recordOffset!==offset))fail('EXECUTOR_ROLE_BINDING_CHANGED');
  for(const [index,a] of wave.assignments.entries()){const task=r.tasks.find(t=>t.id===a.taskId);if(!task||hash(validateWritePaths(task.writePaths))!==hash(a.writePaths)||a.workspace!==within(wave.directory,a.id+'/source'))fail('EXECUTOR_SLICE_BINDING_CHANGED');
   if(a.executorRoleId===undefined?r.flowConfig?.mode==='custom':a.executorRoleId!==roles[(offset+index)%roles.length])fail('EXECUTOR_ROLE_BINDING_CHANGED');}
  if(hash(this.strictCatalog(within(wave.directory,'base')))!==hash(wave.catalog))fail('EXECUTOR_SLICE_BASE_CHANGED');return wave;
 }
 private read(rid:string,wid:string,allowPause=false):ExecutorWave{const wave=this.custody(rid,wid);this.current(rid,wave,allowPause);return wave;}
 /** Read-only byte census. It deliberately grants no process, source-write or execution permission. */
 inspectRecovery(rid:string,allowAttempt=true,ignoreRecoveryId?:string){
  const settled=this.settledWaves(rid),intents=this.rows(rid,'ExecutorMergeIntent').filter(row=>!settled.has(row.data.waveId));
  if(!intents.length)fail('MERGE_RECOVERY_NOT_REQUIRED');if(intents.length!==1)fail('MERGE_RECOVERY_JOURNAL_INVALID');
  const {intent,wave,base,combined}=this.recoveryArtifacts(rid,intents[0].data.waveId),r=this.store.run(rid);
  const current=files(r.workspace),before=new Map(base.map(f=>[f.path,f.sha256])),after=new Map(combined.map(f=>[f.path,f.sha256])),observed=new Map(current.map(f=>[f.path,f.sha256]));
  const paths=[...new Set([...before.keys(),...after.keys(),...observed.keys()])].sort(),changed=paths.filter(path=>before.get(path)!==after.get(path));
  const external=paths.some(path=>observed.get(path)!==before.get(path)&&observed.get(path)!==after.get(path)||existsSync(within(r.workspace,path))&&lstatSync(within(r.workspace,path)).isDirectory());
  const currentHash=hash(current),combinedHash=hash(combined),sourceState:MergeSourceState=external?'EXTERNAL_CHANGE':currentHash===wave.sourceHash?'SOURCE_UNCHANGED':currentHash===combinedHash?'COMBINED_UNCOMMITTED':'PARTIALLY_PUBLISHED';
  const attempts=readdirSync(wave.directory).filter(name=>name.startsWith('recovery_')).sort();if(attempts.length>8)fail('MERGE_RECOVERY_LIMIT');
  for(const name of attempts)if(!/^recovery_[a-f0-9]{32}$/.test(name)||!lstatSync(within(wave.directory,name)).isDirectory())fail('MERGE_RECOVERY_JOURNAL_INVALID');
  const visibleAttempts=attempts.filter(name=>name!==ignoreRecoveryId);
  const permitted=allowAttempt&&!external&&r.state==='BLOCKED'&&this.store.owns(r.projectId,rid)&&this.store.project(r.projectId).activeRunId===rid;
  const value={schema:'dream-maker.merge-recovery-preview.v1' as const,runId:rid,waveId:wave.id,sourceState,source:{baseHash:wave.sourceHash,combinedHash,currentHash},changedFiles:changed.length,publishedFiles:changed.filter(path=>observed.get(path)===after.get(path)).length,previousAttempts:visibleAttempts.length,
   canKeepFiles:permitted,canRestoreBase:permitted,requiresProcessCheck:true as const,scope:'SOURCE_FILES_ONLY' as const,businessDataChanged:false as const,modelsCalled:0 as const,executionGranted:false as const,automaticResume:false as const};
  const view:MergeRecoveryPreview={...value,previewHash:hash({...value,intentId:intent.id,attempts:visibleAttempts})};
  return {view,wave,base,combined,current,intentId:intent.id};
 }
 /** Anchored custody, also used to recheck an already completed recovery; never grants a write. */
 recoveryArtifacts(rid:string,wid:string){
  const intents=this.rows(rid,'ExecutorMergeIntent').filter(row=>row.data.waveId===wid);if(intents.length!==1)fail('MERGE_RECOVERY_JOURNAL_INVALID');
  const intent=intents[0],wave=this.custody(rid,wid),base=wave.catalog,combined=this.strictCatalog(within(wave.directory,'merged'));
  if(intent.data.beforeHash!==wave.sourceHash||hash(combined)!==intent.data.sourceHash)fail('MERGE_RECOVERY_COPY_CHANGED');
  for(const a of wave.assignments){const seal=this.sealed(rid,a.id),delta=this.delta(wave,a);if(!seal||seal.waveId!==wid||seal.sourceHash!==hash(delta.current)||seal.deltaHash!==delta.deltaHash)fail('EXECUTOR_SLICE_CHANGED');}
  return {intent,wave,base,combined};
 }
 reserveRecovery(additional:number,fileCount:number){this.room(additional,fileCount);}
 needsCheckpoint(rid:string){
  const r=this.store.run(rid),settled=this.settledWaves(rid);
  return r.state==='BLOCKED'&&r.phase==='IMPLEMENTING'&&checkpointReasons.has(r.reason??'')&&!this.hasUncertainMerge(rid)&&this.rows(rid,'ExecutorWavePrepared').some(row=>!settled.has(row.data.id));
 }
 /** Unmerged task bytes and settled tool effects only; the Engine must independently prove OS cleanup. */
 inspectCheckpoint(rid:string,allowPrepare=true,ignoreOperationHash?:string){
  const r=this.store.run(rid);executionWorkspace(r,this.data);
  if(r.state!=='BLOCKED'||r.phase!=='IMPLEMENTING'||!checkpointReasons.has(r.reason??''))fail('EXECUTOR_CHECKPOINT_NOT_REQUIRED');
  if(this.hasUncertainMerge(rid))fail('EXECUTOR_MERGE_RESULT_UNCERTAIN');
  const project=this.store.project(r.projectId),spec=this.store.spec(r.specId);
  if(!this.store.owns(r.projectId,rid)||project.activeRunId!==rid||project.specId!==r.specId||spec.stale||spec.hash!==r.specHash||!this.store.approved(r.projectId,r.specHash,'SPEC')||!this.store.approved(r.projectId,r.specHash,'BUILD'))fail('EXECUTOR_SLICE_BINDING_CHANGED');
  const completed=this.rows(rid,'ExecutorCheckpointPrepared'),operations=new Set(completed.map(row=>row.data.operationHash));
  if(this.rows(rid,'ExecutorCheckpointIntent').some(row=>row.data.operationHash!==ignoreOperationHash&&!operations.has(row.data.operationHash)))fail('EXECUTOR_CHECKPOINT_RESULT_UNCERTAIN');
  const settled=this.settledWaves(rid),pending=this.rows(rid,'ExecutorWavePrepared').filter(row=>!settled.has(row.data.id));if(pending.length!==1)fail('EXECUTOR_CHECKPOINT_WAVE_INVALID');
  const wave=this.custody(rid,String(pending[0].data.id)),canonical=this.strictCatalog(r.workspace);
  if(r.treeHash!==wave.sourceHash||hash(canonical)!==wave.sourceHash)fail('EXECUTOR_SOURCE_CHANGED');
  const intents=this.rows(rid,'ToolIntent'),results=this.rows(rid,'ToolResult');if(intents.length+results.length>8192)fail('EXECUTOR_CHECKPOINT_RECORD_LIMIT');
  const byIntent=new Map<string,typeof results>();
  for(const result of results){const key=String(result.data.intentId),list=byIntent.get(key)??[];list.push(result);byIntent.set(key,list);}
  for(const intent of intents){const matches=byIntent.get(String(intent.id));if(matches?.length!==1||!['COMPLETE','FAILED_NO_EFFECT'].includes(String(matches[0].data.status)))fail('TOOL_RECOVERY_REQUIRED');}
  if(results.some(row=>!intents.some(intent=>intent.id===row.data.intentId)))fail('TOOL_RECOVERY_REQUIRED');
  const copies=wave.assignments.map(a=>{
   const task=r.tasks.find(task=>task.id===a.taskId);if(!task||!['pending','running'].includes(task.status))fail('EXECUTOR_CHECKPOINT_TASK_INVALID');
   const delta=this.delta(wave,a),sourceHash=hash(delta.current),seal=this.sealed(rid,a.id);
   if(seal&&(seal.waveId!==wave.id||seal.sourceHash!==sourceHash||seal.deltaHash!==delta.deltaHash))fail('EXECUTOR_SLICE_CHANGED');
   const origin=completed.find(row=>row.data.newWaveId===wave.id),seeds=origin?.data.copies as {newSliceId:string;sourceHash:string}[]|undefined;
   let checkpoint=seeds?.find(seed=>seed.newSliceId===a.id)?.sourceHash??wave.sourceHash;
   const calls=intents.filter(row=>row.data.sliceId===a.id);
   for(const intent of calls){
    if(intent.data.specHash!==r.specHash||intent.data.sourceHash!==checkpoint||!/^[a-f0-9]{64}$/.test(String(intent.data.requestHash)))fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');
    const result=byIntent.get(String(intent.id))![0];if(result.data.tool!==intent.data.tool)fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');
    if(result.data.status==='COMPLETE'){if(!/^[a-f0-9]{64}$/.test(String(result.data.sourceHash)))fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');checkpoint=String(result.data.sourceHash);}
    else if(result.data.sourceHash!==undefined&&result.data.sourceHash!==checkpoint)fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');
   }
   if(checkpoint!==sourceHash)fail('EXECUTOR_CHECKPOINT_SOURCE_CHANGED');
   for(const file of delta.current)recoverySourceBody(a.workspace,file);
   return{sliceId:a.id,taskId:a.taskId,sourceHash,catalog:delta.current,toolCalls:calls.length,priorResultSealed:!!seal};
  });
  for(const file of canonical)recoverySourceBody(r.workspace,file);
  const checkpointHash=hash(copies),toolJournalHash=hash({intents,results}),value={schema:'dream-maker.executor-checkpoint-preview.v1' as const,runId:rid,runVersion:r.version,waveId:wave.id,canonicalHash:wave.sourceHash,checkpointHash,toolJournalHash,
   tasks:copies.map(c=>({taskId:c.taskId,sourceHash:c.sourceHash,fileCount:c.catalog.length,toolCalls:c.toolCalls,priorResultSealed:c.priorResultSealed})),canPrepare:allowPrepare&&completed.length<2,requiresProcessCheck:true as const,modelsCalled:0 as const,executionGranted:false as const,automaticResume:false as const};
  const view:ExecutorCheckpointPreview={...value,previewHash:hash({...value,manifestHash:pending[0].data.manifestHash})};return{view,wave,copies,canonical};
 }
 replayCheckpoint(rid:string,input:ExecutorCheckpointRequest,operationHash:string,actor:string):ExecutorCheckpointResult|undefined{
  const requestHash=hash({rid,input,actor}),found=this.rows(rid,'ExecutorCheckpointPrepared').filter(row=>row.data.operationHash===operationHash);
  if(!found.length){const pending=this.rows(rid,'ExecutorCheckpointIntent').filter(row=>row.data.operationHash===operationHash);if(pending.length){if(pending.length!==1||pending[0].data.requestHash!==requestHash)fail('IDEMPOTENCY_MISMATCH');fail('EXECUTOR_CHECKPOINT_RESULT_UNCERTAIN');}return;}
  if(found.length!==1||found[0].data.requestHash!==requestHash)fail('IDEMPOTENCY_MISMATCH');
  const data=found[0].data,result=data.result as ExecutorCheckpointResult,r=this.store.run(rid);
  if(!result||result.schema!=='dream-maker.executor-checkpoint-result.v1'||result.runId!==rid||result.operationHash!==operationHash||result.previousWaveId!==data.waveId||result.newWaveId!==data.newWaveId||result.modelsCalled!==0||result.executionGranted!==false||result.automaticResume!==false||result.taskCompletionAssumed!==false||result.state!=='PAUSED')fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');
  if(r.state!=='PAUSED'||r.reason!=='EXECUTOR_CHECKPOINT_PREPARED'||r.version!==result.runVersion||!this.store.owns(r.projectId,rid)||hash(this.strictCatalog(r.workspace))!==result.canonicalHash)fail('EXECUTOR_CHECKPOINT_SOURCE_CHANGED');
  const previous=this.custody(rid,result.previousWaveId),next=this.custody(rid,result.newWaveId),copies=data.copies as {previousSliceId:string;newSliceId:string;sourceHash:string}[];
  if(!Array.isArray(copies)||copies.length!==next.assignments.length||copies.length!==previous.assignments.length)fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');
  for(const copy of copies){const a=previous.assignments.find(a=>a.id===copy.previousSliceId),b=next.assignments.find(a=>a.id===copy.newSliceId);
   if(!a||!b||a.taskId!==b.taskId||hash(this.strictCatalog(a.workspace))!==copy.sourceHash||hash(this.strictCatalog(b.workspace))!==copy.sourceHash)fail('EXECUTOR_CHECKPOINT_SOURCE_CHANGED');
  }
  return{...result,replayed:true};
 }
 prepareCheckpoint(rid:string,input:ExecutorCheckpointRequest,operationHash:string,actor:string,signal:AbortSignal,cleanupProofHash:string,gate:(run:Run)=>void):ExecutorCheckpointResult{
  const inspection=this.inspectCheckpoint(rid),{wave,view,copies,canonical}=inspection,r=this.store.run(rid),requestHash=hash({rid,input,actor});
  if(input.previewHash!==view.previewHash)fail('EXECUTOR_CHECKPOINT_PREVIEW_CHANGED');if(!view.canPrepare)fail('EXECUTOR_CHECKPOINT_LIMIT');
  if(signal.aborted)fail('EXECUTOR_CHECKPOINT_CANCELLED');gate(r);
  const newWaveId='executor_wave_'+operationHash.slice(0,32),directory=this.path(rid,newWaveId);if(existsSync(directory))fail('EXECUTOR_CHECKPOINT_RESULT_UNCERTAIN');
  const next:ExecutorWave={...wave,id:newWaveId,directory,attempt:r.attempt,assignments:wave.assignments.map(a=>{const sid=id('executor_slice');return{...a,id:sid,workspace:within(directory,sid+'/source')};})};
  const bytes=canonical.reduce((n,f)=>n+f.bytes,0),seedBytes=copies.reduce((n,c)=>n+c.catalog.reduce((m,f)=>m+f.bytes,0),0);
  this.room(executorWaveReservation(bytes,copies.length)+seedBytes,canonical.length+copies.reduce((n,c)=>n+c.catalog.length,0)+copies.length*4+2);
  const check=()=>{if(signal.aborted)fail('EXECUTOR_CHECKPOINT_CANCELLED');gate(this.store.run(rid));if(this.inspectCheckpoint(rid,true,operationHash).view.previewHash!==view.previewHash)fail('EXECUTOR_CHECKPOINT_PREVIEW_CHANGED');};
  check();this.store.record('ExecutorCheckpointIntent',r.projectId,rid,{waveId:wave.id,newWaveId,operationHash,requestHash,previewHash:view.previewHash,checkpointHash:view.checkpointHash,cleanupProofHash,actor,automaticResume:false});
  mkdirSync(directory,{mode:0o700});const base=within(directory,'base');mkdirSync(base);this.copy(r.workspace,base,canonical);
  for(let i=0;i<next.assignments.length;i++){const a=next.assignments[i];mkdirSync(a.workspace,{recursive:true,mode:0o700});this.copy(wave.assignments[i].workspace,a.workspace,copies[i].catalog);}
  const manifest=Buffer.from(JSON.stringify(next));if(manifest.length>4000000)fail('EXECUTOR_SLICE_BINDING_CHANGED');writeFileSync(within(directory,'wave.json'),manifest,{flag:'wx',mode:0o600,flush:true});
  const provenance=next.assignments.map((a,i)=>({previousSliceId:wave.assignments[i].id,newSliceId:a.id,sourceHash:copies[i].sourceHash}));
  let result!:ExecutorCheckpointResult;
  this.store.tx(()=>{
   check();const current=this.store.run(rid);if(current.version!==view.runVersion)fail('STALE_RUN_VERSION');
   if(hash(readFileSync(within(directory,'wave.json')))!==hash(manifest)||hash(this.strictCatalog(base))!==view.canonicalHash)fail('EXECUTOR_CHECKPOINT_SOURCE_CHANGED');
   for(const a of next.assignments){const seed=provenance.find(c=>c.newSliceId===a.id)!;if(hash(this.strictCatalog(a.workspace))!==seed.sourceHash)fail('EXECUTOR_CHECKPOINT_SOURCE_CHANGED');}
   const taskIds=new Set(wave.assignments.map(a=>a.taskId));current.tasks=current.tasks.map(task=>taskIds.has(task.id)?{...task,status:'pending'}:task);current.state='PAUSED';current.reason='EXECUTOR_CHECKPOINT_PREPARED';
   result={schema:'dream-maker.executor-checkpoint-result.v1',runId:rid,previousWaveId:wave.id,newWaveId,operationHash,checkpointHash:view.checkpointHash,canonicalHash:view.canonicalHash,runVersion:current.version+1,state:'PAUSED',replayed:false,sourceCopiesRetained:true,taskCompletionAssumed:false,modelsCalled:0,executionGranted:false,automaticResume:false};
   this.store.record('ExecutorWavePrepared',r.projectId,rid,{id:next.id,manifestHash:hash(manifest),sourceHash:next.sourceHash,assignmentCount:next.assignments.length,executorRoleOffset:next.executorRoleOffset??0,checkpointOrigin:wave.id});
   this.store.record('ExecutorCheckpointPrepared',r.projectId,rid,{waveId:wave.id,newWaveId,operationHash,requestHash,previewHash:view.previewHash,cleanupProofHash,copies:provenance,result});
   this.store.saveRun(current);this.store.event(r.projectId,rid,'run.executor.checkpoint.prepared',{previousWaveId:wave.id,newWaveId,taskCount:taskIds.size,modelsCalled:0,taskCompletionAssumed:false,automaticResume:false});
  });return result;
 }
 /**
  * The only entry back out of a retained checkpoint. It reads exactly the custody the preview
  * reads, and makes the same field change the pause/resume paths already make: an interrupted
  * task is pending again, never implemented. No merge, seal, model call or business-data write.
  */
 resumeCheckpoint(rid:string,operationHash:string,actor:string,gate:(run:Run)=>void):ExecutorCheckpointResumeResult{
  if(!this.rows(rid,'ExecutorWavePrepared').length)fail('EXECUTOR_CHECKPOINT_RESUME_NOT_RETAINED');
  const r=this.store.run(rid),{wave}=this.inspectCheckpoint(rid),waveTaskIds=wave.assignments.map(a=>a.taskId),requestHash=hash({rid,operationHash,actor});
  gate(r);
  return this.store.tx(()=>{
   const current=this.store.run(rid);gate(current);
   if(current.version!==r.version)fail('STALE_RUN_VERSION');
   if(!checkpointReasons.has(current.reason??''))fail('EXECUTOR_CHECKPOINT_RESUME_NOT_RECOVERABLE');
   const taskIds=current.tasks.filter(task=>task.status==='running').map(task=>task.id);
   const resumed:ExecutorCheckpointResumeResult={schema:'dream-maker.executor-checkpoint-resume-result.v1',runId:rid,reason:String(current.reason),taskIds,waveTaskIds,waveId:wave.id,operationHash,runVersion:current.version+1,attempt:current.attempt+1,state:'IMPLEMENTING',phase:'IMPLEMENTING',replayed:false,taskCompletionAssumed:false,modelsCalled:0,automaticResume:false};
   current.tasks=current.tasks.map(task=>task.status==='running'?{...task,status:'pending'}:task);
   current.state='IMPLEMENTING';current.phase='IMPLEMENTING';current.reason=null;current.attempt+=1;
   // Identity and the recovered bytes only, so a retried key replays this row instead of live state.
   this.store.record('ExecutorCheckpointResumed',current.projectId,rid,{...resumed,previousReason:resumed.reason,requestHash,actor,at:now()});
   this.store.saveRun(current);
   this.store.event(current.projectId,rid,'run.executor.checkpoint.resumed',{state:current.state,phase:current.phase,attempt:current.attempt,reason:current.reason,waveId:wave.id,taskIds,modelsCalled:0,automaticResume:false});
   return resumed;
  });
 }
 /** A repeated key reads the recorded recovery back; it never re-derives from a run that moved on. */
 replayCheckpointResume(rid:string,operationHash:string,actor:string):ExecutorCheckpointResumeResult|undefined{
  const requestHash=hash({rid,operationHash,actor}),found=this.rows(rid,'ExecutorCheckpointResumed').filter(row=>row.data.operationHash===operationHash);
  if(!found.length)return;
  if(found.length!==1||found[0].data.requestHash!==requestHash)fail('IDEMPOTENCY_MISMATCH');
  const data=found[0].data,result:ExecutorCheckpointResumeResult={schema:'dream-maker.executor-checkpoint-resume-result.v1',runId:rid,reason:String(data.reason),taskIds:data.taskIds as string[],waveTaskIds:data.waveTaskIds as string[],waveId:String(data.waveId),operationHash,runVersion:Number(data.runVersion),attempt:Number(data.attempt),state:'IMPLEMENTING',phase:'IMPLEMENTING',replayed:true,taskCompletionAssumed:false,modelsCalled:0,automaticResume:false};
  if(data.schema!=='dream-maker.executor-checkpoint-resume-result.v1'||data.runId!==rid||!checkpointReasons.has(String(data.reason))||!Array.isArray(result.taskIds)||!Array.isArray(result.waveTaskIds)||!result.taskIds.every(value=>typeof value==='string')||!result.waveTaskIds.every(value=>typeof value==='string')||!Number.isSafeInteger(result.runVersion)||result.runVersion<1||!Number.isSafeInteger(result.attempt)||result.attempt<0)fail('EXECUTOR_CHECKPOINT_RESUME_JOURNAL_INVALID');
  return result;
 }
 pending(rid:string,allowPause=false):ExecutorWave|undefined{
  const settled=this.settledWaves(rid);const pending=this.rows(rid,'ExecutorWavePrepared').filter(row=>!settled.has(row.data.id));
  if(pending.length>1)fail('EXECUTOR_SLICE_BINDING_CHANGED');return pending[0]?this.read(rid,pending[0].data.id,allowPause):undefined;
 }
  /**
   * Read-only admission for the one documented recovery from a stopped
   * documentation-repair planning handoff. It deliberately does not loosen
   * pending()/current() for normal execution.
   */
  pendingRecoveryWave(rid:string,taskId:string,writePaths:string[]):ExecutorWave{
   const r=this.store.run(rid);executionWorkspace(r,this.data);
   if(r.state!=='BLOCKED'||r.phase!=='IMPLEMENTING'||r.reason!=='DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED')
    fail('DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED');
   if(this.hasUncertainMerge(rid))fail('EXECUTOR_MERGE_RESULT_UNCERTAIN');
   const project=this.store.project(r.projectId),spec=this.store.spec(r.specId);
   if(!this.store.owns(r.projectId,rid)||project.activeRunId!==rid||project.specId!==r.specId||spec.stale||spec.hash!==r.specHash||
      !this.store.approved(r.projectId,r.specHash,'SPEC')||!this.store.approved(r.projectId,r.specHash,'BUILD'))
    fail('EXECUTOR_SLICE_BINDING_CHANGED');
   const settled=this.settledWaves(rid),pending=this.rows(rid,'ExecutorWavePrepared').filter(row=>!settled.has(row.data.id));
   if(pending.length!==1)fail('DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED');
   const wave=this.custody(rid,String(pending[0].data.id)),assignment=wave.assignments[0],task=r.tasks.find(item=>item.id===taskId);
   if(!task||task.inheritedFrom!==undefined||!['pending','running'].includes(task.status)||wave.assignments.length!==1||!assignment||
      assignment.taskId!==taskId||hash(assignment.writePaths)!==hash(writePaths)||
      wave.sourceHash!==r.treeHash||hash(this.strictCatalog(r.workspace))!==wave.sourceHash)
    fail('DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED');
   const sliceId=assignment.id;
   if(this.rows(rid,'ToolIntent').some(row=>row.data.sliceId===sliceId)||this.rows(rid,'ToolResult').some(row=>row.data.sliceId===sliceId)||
      this.rows(rid,'ExecutorSliceSealed').some(row=>row.data.sliceId===sliceId))
    fail('TOOL_RECOVERY_REQUIRED');
   return wave;
  }
 private body(root:string,file:Catalog[number]){const body=get(root,file.path);if(body.length!==file.bytes||hash(body)!==file.sha256)fail('EXECUTOR_SLICE_CHANGED');return body;}
 private strictCatalog(root:string):Catalog{
  let nodes=0;const scan=(folder:string,depth=0)=>{if(depth>32)fail('WORKSPACE_LIMIT');for(const entry of readdirSync(folder,{withFileTypes:true})){if(++nodes>5000||entry.isSymbolicLink()||['.git','node_modules'].includes(entry.name.toLowerCase()))fail('EXECUTOR_SLICE_WRITE_DENIED');const path=within(folder,entry.name),stat=lstatSync(path);if(stat.isDirectory())scan(path,depth+1);else if(!stat.isFile())fail('EXECUTOR_SLICE_WRITE_DENIED');}};scan(root);return files(root);
 }
 private copy(root:string,target:string,catalog:Catalog){
  for(const file of catalog){if(!validPath(file.path))fail('EXECUTOR_SLICE_PATH_INVALID');const to=within(target,file.path);mkdirSync(dirname(to),{recursive:true,mode:0o700});within(target,file.path);writeFileSync(to,this.body(root,file),{flag:'wx',mode:0o600,flush:true});}
  if(hash(files(target))!==hash(catalog))fail('EXECUTOR_SLICE_CHANGED');
 }
 private room(additional:number,fileCount:number){
  const base=within(this.data,'controller/executor-waves');let bytes=0,nodes=0;
  const scan=(folder:string,depth=0)=>{if(depth>40)fail('EXECUTOR_SLICE_STORAGE_LIMIT');for(const entry of readdirSync(folder,{withFileTypes:true})){if(++nodes>100000||entry.isSymbolicLink())fail('EXECUTOR_SLICE_STORAGE_LIMIT');const path=within(folder,entry.name),stat=lstatSync(path);if(stat.isDirectory())scan(path,depth+1);else if(stat.isFile())bytes+=stat.size;else fail('EXECUTOR_SLICE_STORAGE_LIMIT');}};
  if(existsSync(base))scan(base);assertExecutorStageGrowth(bytes,additional);
  const disk=statfsSync(this.data,{bigint:true});assertMaintenanceRoom(bytes,additional,disk.bavail*disk.bsize,'EXECUTOR_SLICE_STORAGE_LIMIT',{files:fileCount,directories:fileCount+20,unit:disk.bsize});
 }
 assertWriteRoom(additional:number){this.room(additional,2);}
 private assertCheckpointCopy(rid:string,a:ExecutorAssignment){
  const seed=executorCheckpointSeed(this.store,rid,a.id);if(seed===undefined)return;
  const last=this.rows(rid,'ToolIntent').filter(row=>row.data.sliceId===a.id).at(-1);let expected=seed;
  if(last){const results=this.rows(rid,'ToolResult').filter(row=>row.data.intentId===last.id);if(results.length!==1||!['COMPLETE','FAILED_NO_EFFECT'].includes(String(results[0].data.status)))fail('TOOL_RECOVERY_REQUIRED');
   expected=String(results[0].data.sourceHash??last.data.sourceHash);if(!/^[a-f0-9]{64}$/.test(expected))fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');}
  if(hash(this.strictCatalog(a.workspace))!==expected)fail('EXECUTOR_CHECKPOINT_SOURCE_CHANGED');
 }
 prepare(rid:string):ExecutorWave{
  const r=this.current(rid),old=this.pending(rid);if(old){for(const a of old.assignments){const seal=this.sealed(rid,a.id);if(seal){const delta=this.delta(old,a);if(seal.sourceHash!==hash(delta.current)||seal.deltaHash!==delta.deltaHash)fail('EXECUTOR_SLICE_CHANGED');}else{if(r.tasks.find(t=>t.id===a.taskId)?.status==='running')fail('EXECUTOR_SLICE_RESULT_UNCERTAIN');this.assertCheckpointCopy(rid,a);}}return old;}
  const runRoot=within(this.data,'controller/executor-waves/'+rid);
  if(this.rows(rid,'ExecutorWavePrepared').length>=32||existsSync(runRoot)&&readdirSync(runRoot).length>=32)fail('EXECUTOR_SLICE_WAVE_LIMIT');
  const tasks=selectExecutorWave(r.tasks);if(!tasks.length)fail('EXECUTOR_SLICE_NO_RUNNABLE_TASK');const roles=executorRoles(r);
  const previous=this.rows(rid,'ExecutorWavePrepared').filter(row=>row.data.checkpointOrigin===undefined);
  if(previous.some(row=>!Number.isSafeInteger(row.data.assignmentCount)||Number(row.data.assignmentCount)<1||Number(row.data.assignmentCount)>4))fail('EXECUTOR_ROLE_BINDING_CHANGED');
  const executorRoleOffset=previous.reduce((sum,row)=>sum+Number(row.data.assignmentCount),0)%roles.length;
  const catalog=files(r.workspace),sourceHash=hash(catalog),wid=id('executor_wave'),directory=this.path(rid,wid),bytes=catalog.reduce((n,f)=>n+f.bytes,0);
  // Reserve base, all task copies, final combination and its publication copies before creating any.
  this.room(executorWaveReservation(bytes,tasks.length),2000*(tasks.length+2)+catalog.length);
  const wave:ExecutorWave={id:wid,runId:rid,projectId:r.projectId,sourceHash,specHash:r.specHash,configFingerprint:r.configFingerprint,attempt:r.attempt,repairCount:r.repairCount,directory,catalog,executorRoleOffset,
   assignments:tasks.map((t,index)=>{const sid=id('executor_slice');return {id:sid,taskId:t.id,workspace:within(directory,sid+'/source'),writePaths:validateWritePaths(t.writePaths),executorRoleId:roles[(executorRoleOffset+index)%roles.length]};})};
  mkdirSync(directory,{recursive:true,mode:0o700});mkdirSync(within(directory,'base'));this.copy(r.workspace,within(directory,'base'),catalog);
  for(const a of wave.assignments){mkdirSync(a.workspace,{recursive:true,mode:0o700});this.copy(r.workspace,a.workspace,catalog);}
  this.current(rid);const manifest=Buffer.from(JSON.stringify(wave));if(manifest.length>4000000)fail('EXECUTOR_SLICE_BINDING_CHANGED');writeFileSync(within(directory,'wave.json'),manifest,{flag:'wx',mode:0o600});
  // Names that resemble credentials remain private data; the redacted record anchors exact bytes.
  this.store.record('ExecutorWavePrepared',r.projectId,rid,{id:wid,manifestHash:hash(manifest),sourceHash,assignmentCount:wave.assignments.length,executorRoleOffset});return wave;
 }
 assignment(rid:string,sid:string):ExecutorAssignment{
  const wave=this.pending(rid);if(!wave)fail('EXECUTOR_SLICE_CLOSED');const a=wave.assignments.find(item=>item.id===sid);if(!a)fail('EXECUTOR_SLICE_UNKNOWN');
  if(this.sealed(rid,sid))fail('EXECUTOR_SLICE_CLOSED');
  const toolTaskStatus=this.store.run(rid).tasks.find(t=>t.id===a.taskId)?.status;
  if(toolTaskStatus!=='running'&&toolTaskStatus!=='implemented'){process.stderr.write('SLICE_NOT_ACTIVE_DETAIL '+JSON.stringify({runId:rid,sliceId:sid,taskId:a.taskId,status:toolTaskStatus??null})+'\n');fail('EXECUTOR_SLICE_NOT_ACTIVE');}
  if(toolTaskStatus==='implemented')process.stderr.write('TOOL_ROUND_AFTER_COMPLETION '+JSON.stringify({runId:rid,sliceId:a.id,taskId:a.taskId})+'\n');
  if(!this.rows(rid,'ToolIntent').some(row=>row.data.sliceId===sid))this.assertCheckpointCopy(rid,a);return a;
 }
 sealed(rid:string,sid:string){const matches=this.rows(rid,'ExecutorSliceSealed').filter(row=>row.data.sliceId===sid);if(matches.length>1)fail('EXECUTOR_SLICE_CHANGED');return matches[0]?.data as {sliceId:string;waveId:string;sourceHash:string;deltaHash:string}|undefined;}
 private delta(wave:ExecutorWave,a:ExecutorAssignment){
  const current=this.strictCatalog(a.workspace),before=new Map(wave.catalog.map(f=>[f.path,f])),after=new Map(current.map(f=>[f.path,f]));
  const changed=[...new Set([...before.keys(),...after.keys()])].sort().filter(path=>before.get(path)?.sha256!==after.get(path)?.sha256);
  if(changed.some(path=>!executorMayWrite(a.writePaths,path)))fail('EXECUTOR_SLICE_WRITE_DENIED');
  return {current,changed,deltaHash:hash(changed.map(path=>({path,before:before.get(path)?.sha256??null,after:after.get(path)?.sha256??null})))};
 }
 seal(rid:string,sid:string){
  const wave=this.pending(rid,true);if(!wave)fail('EXECUTOR_SLICE_CLOSED');const a=wave.assignments.find(item=>item.id===sid);if(!a||this.sealed(rid,sid))fail('EXECUTOR_SLICE_CLOSED');if(this.store.run(rid).tasks.find(t=>t.id===a.taskId)?.status!=='running')fail('EXECUTOR_SLICE_NOT_ACTIVE');const delta=this.delta(wave,a);
  const intents=this.rows(rid,'ToolIntent').filter(row=>row.data.sliceId===sid),results=this.rows(rid,'ToolResult').filter(row=>row.data.sliceId===sid);
  const settled=new Set(results.filter(row=>['COMPLETE','FAILED_NO_EFFECT'].includes(row.data.status)).map(row=>row.data.intentId));
  if(results.some(row=>row.data.status==='UNKNOWN_EFFECT')||intents.some(row=>!settled.has(row.id)))fail('TOOL_RECOVERY_REQUIRED');
  this.assertCheckpointCopy(rid,a);
  this.room(0,0);const value={sliceId:sid,waveId:wave.id,sourceHash:hash(delta.current),deltaHash:delta.deltaHash};this.store.record('ExecutorSliceSealed',wave.projectId,rid,value);return value;
 }
 merge(rid:string,wid:string,signal:AbortSignal,gate:(r:Run)=>void,commit:(r:Run,sourceHash:string)=>void){
  const wave=this.read(rid,wid),r=this.current(rid,wave);gate(r);if(signal.aborted)fail('RUN_CANCELLED');
  const bodies=new Map(wave.catalog.map(f=>[f.path,this.body(within(wave.directory,'base'),f)])),changed=new Set<string>();
  for(const a of wave.assignments){const seal=this.sealed(rid,a.id);if(!seal||seal.waveId!==wid)fail('EXECUTOR_SLICE_INCOMPLETE');const delta=this.delta(wave,a);
   if(seal.sourceHash!==hash(delta.current)||seal.deltaHash!==delta.deltaHash)fail('EXECUTOR_SLICE_CHANGED');
   for(const path of delta.changed){const key=folded(path);if([...changed].some(p=>folded(p)===key))fail('EXECUTOR_SLICE_WRITE_CONFLICT');changed.add(path);const f=delta.current.find(item=>item.path===path);if(f)bodies.set(path,this.body(a.workspace,f));else bodies.delete(path);}
  }
  const names=new Set<string>();for(const path of bodies.keys()){if(!validPath(path)||names.has(folded(path)))fail('EXECUTOR_SLICE_PATH_CONFLICT');names.add(folded(path));}
  // Type changes need a separate migration; reject before any durable publication intent.
  for(const path of changed){if(!bodies.has(path))continue;const parts=path.split('/');for(let n=1;n<=parts.length;n++){const target=within(r.workspace,parts.slice(0,n).join('/'));if(existsSync(target)&&lstatSync(target).isDirectory()!==(n<parts.length))fail('EXECUTOR_SLICE_PATH_CONFLICT');}}
  const bytes=[...bodies.values()].reduce((n,b)=>n+b.length,0);if(bytes>20000000||bodies.size>2000)fail('WORKSPACE_LIMIT');
  this.room(bytes*2+32000,bodies.size*2);
  const merged=within(wave.directory,'merged'),publish=within(wave.directory,'publish');if(existsSync(merged)||existsSync(publish))fail('EXECUTOR_MERGE_PREPARATION_INCOMPLETE');mkdirSync(merged);mkdirSync(publish);
  for(const [path,body]of bodies){const to=within(merged,path);mkdirSync(dirname(to),{recursive:true});writeFileSync(to,body,{flag:'wx',mode:0o600});}
  const catalog=files(merged),sourceHash=hash(catalog);this.copy(merged,publish,catalog);this.current(rid,wave);gate(this.store.run(rid));if(signal.aborted)fail('RUN_CANCELLED');
  // A task is only implemented when the files its plan declares really exist after the merge. Checking that
  // inside the merge transaction turned a missing deliverable into EXECUTOR_MERGE_RESULT_UNCERTAIN and the run
  // could not be reconciled, so the same rule is applied here, before the intent is written: a missing file
  // stays a repairable failure.
  const presentAfter=new Set<string>([...wave.catalog.map(f=>f.path).filter(path=>!changed.has(path)),...bodies.keys()]);
  const missingDeclared=[...new Set(wave.assignments.flatMap(a=>Array.isArray(a.writePaths)?a.writePaths:[]))].filter(path=>!presentAfter.has(path.replace(/\/$/,''))&&!presentAfter.has(path));
  if(missingDeclared.length){process.stderr.write('DECLARED_FILES_PREFLIGHT '+JSON.stringify({waveId:wid,missing:missingDeclared.slice(0,8)})+'\n');fail('EXECUTOR_DECLARED_FILES_MISSING');}
  // Persist before touching the canonical files. An interrupted publication cannot become a retry.
  this.store.record('ExecutorMergeIntent',r.projectId,rid,{waveId:wid,beforeHash:wave.sourceHash,sourceHash,changedCount:changed.size,changedHash:hash([...changed]),automaticResume:false});
  try{ this.store.tx(()=>{
   const current=this.store.run(rid);gate(current);if(treeHash(current.workspace)!==wave.sourceHash)fail('EXECUTOR_SOURCE_CHANGED');
   for(const path of changed){if(signal.aborted)fail('RUN_CANCELLED');const to=within(current.workspace,path),from=within(publish,path),old=wave.catalog.find(f=>f.path===path);
    if(existsSync(to)){const actual=get(current.workspace,path);if(!old||hash(actual)!==old.sha256)fail('EXECUTOR_SOURCE_CHANGED');}else if(old)fail('EXECUTOR_SOURCE_CHANGED');
    if(bodies.has(path)){mkdirSync(dirname(to),{recursive:true});within(current.workspace,path);renameSync(from,to);}else unlinkSync(to);
   }
   if(treeHash(current.workspace)!==sourceHash)fail('EXECUTOR_MERGE_SOURCE_CHANGED');
   commit(current,sourceHash);this.store.saveRun(current);
   this.store.record('ExecutorMergeApplied',r.projectId,rid,{waveId:wid,sourceHash,taskIds:wave.assignments.map(a=>a.taskId),verificationRequired:true,reviewRequired:true});
   this.store.event(r.projectId,rid,'executor.wave.merged',{waveId:wid,sourceHash,tasks:wave.assignments.length,verified:false});
  }); }catch(error){const code=(error as {code?:string}).code??'UNKNOWN';let wsHash='unreadable';try{wsHash=hash(files(this.store.run(rid).workspace));}catch{}process.stderr.write('MERGE_ABORT '+JSON.stringify({code,waveId:wid,waveSourceHash:wave.sourceHash,sourceHash,workspaceHash:wsHash})+'\n');throw error;}
 }
}
/** Native/tool callers derive the data directory from the already-bound canonical run, not input paths. */
export function boundExecutorAssignment(store:Store,rid:string,sid:string){const r=store.run(rid),data=dirname(dirname(r.workspace));executionWorkspace(r,data);return new ExecutorSlices(store,data).assignment(rid,sid);}
export function executorCheckpointSeed(store:Store,rid:string,sid:string):string|undefined{
 const r=store.run(rid),found:string[]=[];
 for(const row of store.records(r.projectId,'ExecutorCheckpointPrepared').filter(row=>row.runId===rid)){
  if(!Array.isArray(row.data.copies))fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');
  for(const copy of row.data.copies)if(copy.newSliceId===sid){if(typeof copy.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(copy.sourceHash))fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');found.push(copy.sourceHash);}
 }
 if(found.length>1)fail('EXECUTOR_CHECKPOINT_JOURNAL_INVALID');return found[0];
}
export function assertExecutorWriteRoom(store:Store,rid:string,sid:string,additional:number){const r=store.run(rid),data=dirname(dirname(r.workspace)),slices=new ExecutorSlices(store,data);slices.assignment(rid,sid);slices.assertWriteRoom(additional);}
