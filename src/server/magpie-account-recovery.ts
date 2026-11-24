import {lstatSync,readFileSync} from 'node:fs';
import type {Store} from './store.js';
import type {MagpieAccountRecoveryView} from '../shared/magpie-account-check.js';
import {accountCheckRecoveryTarget,accountCheckRecoveryView,accountCheckProcessJournal,finishAccountCheckRecovery} from './magpie-account-check-state.js';
import type {AccountCheckProcessRecord} from './magpie-account-check-state.js';
import {withMagpieLocalRecovery,requireMagpieControllerReopen,magpieControllerReopenRequired} from './magpie-check.js';
import {probeProcessIdentity} from './server-lock.js';
import {readWindowsJobCleanup} from './flow/windows-job.js';
import type {ProcessCleanupProof} from './flow/process-ownership.js';
import {DomainError,hash,object,within} from './security.js';

interface JobBinding {jobId:string;markerSha256:string;helperSha256:string;requestSha256:string;commandSha256:string;argvSha256:string;parentPid:number;parentTicks:string}
interface Observers {
 processIdentity:(pid:number)=>string|null;
 jobCleanup:(root:string,binding:JobBinding)=>ProcessCleanupProof;
}
const fail=():never=>{throw new DomainError('MAGPIE_ACCOUNT_RECOVERY_UNPROVEN',409);};
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** Same original job reader, additionally bound to the original actual launch bytes. */
function readAccountJobCleanup(root:string,b:JobBinding):ProcessCleanupProof {
 const path=within(root,`.runtime/owned-process-jobs/${b.jobId}/request.json`),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)return fail();
 const bytes=readFileSync(path);if(hash(bytes)!==b.requestSha256)return fail();const request=object(JSON.parse(bytes.toString('utf8')));
 if(hash(request.binary)!==b.commandSha256||hash(request.args)!==b.argvSha256||hash(request.args)!==hash([])||request.jobName!=='Local\\DreamMaker_'+b.jobId||request.parentPid!==b.parentPid||request.parentTicks!==b.parentTicks||request.marker!==within(root,`.runtime/owned-process-jobs/${b.jobId}/started.json`))return fail();
 return readWindowsJobCleanup(root,b);
}
function one(rows:AccountCheckProcessRecord[],kind:string,required=true):AccountCheckProcessRecord|undefined {
 const selected=rows.filter(row=>row.kind===kind);if(selected.length>1||required&&selected.length!==1)return fail();return selected[0];
}
/** Uses only existing owned-process evidence. This never launches/stops an agent,
 * reads a credential, grants a role, or reconciles a different Classic dispatch. */
export class MagpieAccountRecoveries {
 constructor(private store:Store,private root:string,private observers:Observers={processIdentity:probeProcessIdentity,jobCleanup:readAccountJobCleanup},private verified:(projectId:string)=>boolean=()=>false){}
 latest(projectId:string):MagpieAccountRecoveryView{const view=accountCheckRecoveryView(this.store,projectId,()=>this.verified(projectId));return view.status==='RECOVERED'?{...view,restartRequired:magpieControllerReopenRequired(this.store)}:view;}
 async reconcile(projectId:string,expectedTargetHash:string,actor:string,signal:AbortSignal):Promise<MagpieAccountRecoveryView>{
  if(!digest(expectedTargetHash)||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('MAGPIE_ACCOUNT_RECOVERY_INPUT_INVALID',400);
  if(signal.aborted)throw new DomainError('APPLICATION_STOPPING',409);
  return withMagpieLocalRecovery(this.store,expectedTargetHash,async()=>{
   const target=accountCheckRecoveryTarget(this.store,projectId);
   if(!target||target.targetHash!==expectedTargetHash)throw new DomainError('MAGPIE_ACCOUNT_RECOVERY_STALE',409);
   if(target.recovered)return this.latest(projectId);
   if(!target.ownership||target.ownership.platform!=='win32')return fail();
   const rows=accountCheckProcessJournal(this.store,target.intent,target.ownership),before=hash(rows),intent=one(rows,'OwnedProcessIntent')!,processId=intent.data.processId;
   if(rows.some(row=>row.data.processId!==processId)||rows[0]!==intent||intent.data.platform!=='win32'||!digest(intent.data.commandSha256)||!digest(intent.data.argvSha256))return fail();
   const never=one(rows,'OwnedProcessNotLaunched',false),start=one(rows,'OwnedProcessRootStarted',false);let proof:unknown;
   if(never){
    if(never.data.noProcessCreated!==true||start||one(rows,'OwnedWindowsJobPinned',false))return fail();
    proof={kind:'DURABLE_NOT_LAUNCHED',recordId:never.id};
   }else{
    const job=one(rows,'OwnedWindowsJobIntent')!,pinned=one(rows,'OwnedWindowsJobPinned')!,marker=object(pinned.data.marker),closed=one(rows,'OwnedProcessRootExited',false);
    if(!start||!Number.isSafeInteger(start.data.pid)||Number(start.data.pid)<1||typeof start.data.identity!=='string'||!/^win32:\d+$/.test(start.data.identity)||rows.indexOf(job)<=rows.indexOf(intent)||rows.indexOf(start)<=rows.indexOf(job)||rows.indexOf(pinned)<=rows.indexOf(start)||closed&&(closed.data.rootClosed!==true||rows.indexOf(closed)<=rows.indexOf(start)))return fail();
    const jobId=job.data.jobId;
    if(typeof jobId!=='string'||!/^windows_job_[a-f0-9]{20}$/.test(jobId)||pinned.data.jobId!==jobId||!digest(job.data.requestSha256)||!digest(job.data.helperSha256)||pinned.data.helperSha256!==job.data.helperSha256||!digest(pinned.data.markerSha256)||marker.requestSha256!==job.data.requestSha256||marker.wrapperPid!==start.data.pid||marker.parentPid!==job.data.parentPid||marker.parentTicks!==job.data.parentTicks||!Number.isSafeInteger(job.data.parentPid)||Number(job.data.parentPid)<1||typeof job.data.parentTicks!=='string'||!/^\d+$/.test(job.data.parentTicks))return fail();
    // A closed/nonexistent exact Job is insufficient while its original launcher
    // could still execute. PID reuse is checked against the captured start identity.
    const current=this.observers.processIdentity(Number(start.data.pid));if(current!==null&&(typeof current!=='string'||!/^win32:\d+$/.test(current)))return fail();
    if(current===start.data.identity)throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
    const cleanup=this.observers.jobCleanup(this.root,{jobId,markerSha256:pinned.data.markerSha256,helperSha256:job.data.helperSha256,requestSha256:job.data.requestSha256,commandSha256:intent.data.commandSha256,argvSha256:intent.data.argvSha256,parentPid:Number(job.data.parentPid),parentTicks:job.data.parentTicks});
    if(!cleanup||cleanup.kind!=='TRUSTED_WINDOWS_JOB'||cleanup.scopeId!==jobId||!digest(cleanup.receiptSha256))return fail();
    proof={kind:'CURRENT_ORIGINAL_WINDOWS_JOB_CLOSED',rootRecordId:start.id,jobRecordId:pinned.id,observedRootIdentity:current,cleanup};
   }
   if(signal.aborted)throw new DomainError('APPLICATION_STOPPING',409);
   // Evidence is read outside the finishing transaction: a preparation lookup never nests one.
   const accountVerified=this.verified(projectId);
   finishAccountCheckRecovery(this.store,projectId,expectedTargetHash,before,proof,actor,()=>accountVerified);requireMagpieControllerReopen(this.store);return this.latest(projectId);
  });
 }
}
