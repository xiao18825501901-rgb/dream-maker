import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../store.js';
import type { Config } from '../../shared/types.js';
import { capture } from '../process.js';
import { inspectOutsideExecutionScope } from './process-ownership.js';
import { readWindowsJobCleanup } from './windows-job.js';
import { observeWindowsUptime,checkWindowsUptimeReset } from './windows-job-recovery.js';
import { validateOwnedCodexStatus } from '../providers/codex-owned.js';
import { checkSandboxResult,WSL_ENVIRONMENT } from '../wsl-sandbox.js';
import {readSavedResourceJob,checkResourceObservation,requireResourceProcessClosure} from '../sandbox-resource.js';
import {probeSandboxAbsence} from '../wsl-sandbox-absence.js';
import { DomainError,childEnv,hash,object } from '../security.js';
import {readSqliteRetirement,retirementRootClosure,type RetirementIntent} from '../sqlite-retirement-process.js';

export interface DispatchRecoveryProof {schema:'dream-maker.dispatch-recovery.v1';dispatchId:string;proven:true;basisSha256:string}
/**
 * Codex network observation used short-lived PowerShell/netstat inspectors before those calls were
 * moved outside execution ownership. These exact argv hashes were durably journaled; a hash preimage
 * cannot turn an arbitrary command into one of them. Do not add open-ended patterns here.
 */
const LEGACY_READONLY_NETWORK_OBSERVERS:ReadonlyMap<string,ReadonlySet<string>>=new Map([
    ['f307e73a3447b10444e67233700c1aa5ca8e3673dd2f292084bf485583caad6f',new Set([
        '98e23d86fa2bee25deab4f37a0198fc066a666ce7d1cb2a74ce66e4f300365c5',
        'c81023d771a12faeed97729cc42e8eec026bba60a6aef6e6c943ecb37d33e968',
        'fe4256e24816446635c032fdcbc80d000677c5ce93639573f1ff5da75a86b1e9'
    ])],
    ['2ef44474b8c0169065388a9b666cb4eb5b2015901fd790d502aa83d4690f4769',new Set([
        '91b7f09f4c369777edd998210c510994db44591968188369b434902662a6d182'
    ])]
]);
type RecoveryRecord={id:string;kind:string;data:Record<string,unknown>};
function legacyReadonlyNetworkObserverProof(records:RecoveryRecord[],grant:RecoveryRecord,processId:string){
    const intent=records.find(row=>row.kind==='OwnedProcessIntent'&&row.data.processId===processId);
    if(!intent||!['planner2','reviewer'].includes(String(grant.data.kind))||grant.data.mode!=='live'||intent.data.platform!=='win32')return null;
    const allowed=LEGACY_READONLY_NETWORK_OBSERVERS.get(String(intent.data.commandSha256));
    if(!allowed?.has(String(intent.data.argvSha256)))return null;
    const related=records.filter(row=>row.data.processId===processId);
    const starts=related.filter(row=>row.kind==='OwnedProcessRootStarted'),exits=related.filter(row=>row.kind==='OwnedProcessRootExited');
    if(related.length!==3||starts.length!==1||exits.length!==1)throw new DomainError('LEGACY_OBSERVER_PROCESS_RECORDS_AMBIGUOUS',409);
    const started=starts[0],closed=exits[0],intentIndex=records.indexOf(intent),startIndex=records.indexOf(started),exitIndex=records.indexOf(closed);
    const powershell=String(intent.data.commandSha256)=== 'f307e73a3447b10444e67233700c1aa5ca8e3673dd2f292084bf485583caad6f';
    if(intentIndex<0||startIndex<=intentIndex||exitIndex<=startIndex||closed.data.rootClosed!==true||closed.data.code!==0||closed.data.signal!==null||
        powershell&&(started.data.identityState!=='OS_START_IDENTITY'||typeof started.data.identity!=='string'||!/^win32:\d+$/.test(started.data.identity))||
        !powershell&&(started.data.identityState!=='NOT_CAPTURED'||started.data.identity!==null))
        throw new DomainError('LEGACY_OBSERVER_PROCESS_CLOSURE_INVALID',409);

    const mainCleanups=records.filter(row=>row.kind==='OwnedProcessCleanup'&&row.data.cleanupReturned===true&&row.data.kind==='TRUSTED_WINDOWS_JOB'&&row.data.processId!==processId);
    if(mainCleanups.length!==1)throw new DomainError('LEGACY_OBSERVER_MAIN_CLEANUP_UNPROVEN',409);
    const cleanup=mainCleanups[0],mainProcessId=String(cleanup.data.processId);
    const mainIntents=records.filter(row=>row.kind==='OwnedProcessIntent'&&row.data.processId===mainProcessId);
    const mainStarts=records.filter(row=>row.kind==='OwnedProcessRootStarted'&&row.data.processId===mainProcessId);
    const mainExits=records.filter(row=>row.kind==='OwnedProcessRootExited'&&row.data.processId===mainProcessId);
    const mainPinned=records.filter(row=>row.kind==='OwnedWindowsJobPinned'&&row.data.processId===mainProcessId);
    const mainClosed=records.filter(row=>row.kind==='OwnedWindowsJobClosed'&&row.data.processId===mainProcessId);
    if(mainIntents.length!==1||mainStarts.length!==1||mainExits.length!==1||mainPinned.length!==1||mainClosed.length!==1)
        throw new DomainError('LEGACY_OBSERVER_MAIN_CLOSURE_AMBIGUOUS',409);
    const mainStart=mainStarts[0],mainExit=mainExits[0],mainClose=mainClosed[0],mainStartIndex=records.indexOf(mainStart),mainCleanupIndex=records.indexOf(cleanup);
    if(mainStartIndex<0||mainStartIndex>=intentIndex||exitIndex>=mainCleanupIndex||records.indexOf(mainExit)<=exitIndex||records.indexOf(mainClose)<=exitIndex||
        mainStart.data.identityState!=='OS_START_IDENTITY'||typeof mainStart.data.identity!=='string'||!/^win32:\d+$/.test(mainStart.data.identity)||
        mainExit.data.rootClosed!==true||mainClose.data.activeProcesses!==0||mainClose.data.jobId!==mainPinned[0].data.jobId||
        cleanup.data.scopeId!==mainPinned[0].data.jobId)
        throw new DomainError('LEGACY_OBSERVER_MAIN_CLOSURE_INVALID',409);
    return {
        processId,kind:'LEGACY_READONLY_NETWORK_OBSERVER',
        commandSha256:String(intent.data.commandSha256),argvSha256:String(intent.data.argvSha256),
        intentRecordId:intent.id,startRecordId:started.id,exitRecordId:closed.id,
        mainProcessId,mainCleanupRecordId:cleanup.id,basisSha256:hash({processId,intent:intent.id,started:started.id,closed:closed.id,mainProcessId,mainStart:mainStart.id,mainExit:mainExit.id,mainPinned:mainPinned[0].id,mainClosed:mainClose.id,mainCleanup:cleanup.id})
    };
}
/** Only the Engine supplies this checker. No HTTP/model supplied receipt is accepted. Queries are
 * bounded, local and read-only: active/unknown processes stay owned, with no TTL or inferred success. */
export async function inspectDispatchOwnership(store:Store,root:string,config:Config,projectId:string|null,runId:string|null,dispatchId:string,routeCheck?:()=>Promise<unknown>,deferObservation?:(obs:any)=>void):Promise<DispatchRecoveryProof>{
    const rows=store.db.prepare("SELECT id,kind,data FROM records WHERE project_id IS ? AND run_id IS ? AND json_extract(data,'$.dispatchId')=? ORDER BY rowid LIMIT 4097").all(projectId,runId,dispatchId);
    if(rows.length>4096)throw new DomainError('DISPATCH_RECOVERY_RECORD_LIMIT',409);
    const records=rows.map(row=>({id:String(row.id),kind:String(row.kind),data:object(JSON.parse(String(row.data)))})).filter(row=>row.data.dispatchId===dispatchId);
    const grants=records.filter(row=>row.kind==='DispatchGranted');if(!grants.length)throw new DomainError('DISPATCH_RECOVERY_GRANT_MISSING',409);
    if(grants.length!==1)throw new DomainError('DISPATCH_RECOVERY_GRANT_AMBIGUOUS',409);const grant=grants[0];
    const proofs:unknown[]=[];
    if(grant.data.kind==='route'){
        if(!routeCheck)throw new DomainError('CLASH_ROUTE_RECOVERY_PROOF_REQUIRED',409);
        proofs.push(await routeCheck());
    }
    const linux=async(script:string,args:string[])=>{
        const out=await inspectOutsideExecutionScope(()=>capture(config.codex.wslCommand||'wsl.exe',['-d',WSL_ENVIRONMENT,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-c',script,...args],{cwd:root,env:childEnv(),timeoutMs:15000,maxBytes:2_100_000}));
        if(out.code!==0)throw new DomainError('DISPATCH_LOCAL_OS_PROOF_UNAVAILABLE',409);
        try{return JSON.parse(out.stdout);}catch{throw new DomainError('DISPATCH_LOCAL_OS_PROOF_INVALID',409);}
    };
    for(const intent of records.filter(row=>row.kind==='OwnedProcessIntent')){
        const processId=intent.data.processId;
        if(records.some(row=>row.data.processId===processId&&row.kind==='OwnedProcessNotLaunched')){proofs.push({processId,kind:'DURABLE_NOT_LAUNCHED'});continue;}
        const settled=records.find(row=>row.data.processId===processId&&row.kind==='OwnedProcessCleanup'&&row.data.cleanupReturned===true);
        if(settled){proofs.push({processId,kind:'DURABLE_PREVIOUSLY_PROVEN_CLEANUP',recordId:settled.id});continue;}
        if(grant.data.mode==='demo'&&records.some(row=>row.data.processId===processId&&row.kind==='OwnedProcessRootExited')){proofs.push({processId,kind:'FIXED_DEMO_ROOT_ONLY_NOT_LIVE_PROOF'});continue;}
        const job=records.find(row=>row.data.processId===processId&&row.kind==='OwnedWindowsJobPinned');
        if(job){const proof=readWindowsJobCleanup(root,{jobId:String(job.data.jobId),markerSha256:String(job.data.markerSha256),helperSha256:String(job.data.helperSha256)});proofs.push({processId,...proof});continue;}
        const jobIntents=records.filter(row=>row.data.processId===processId&&row.kind==='OwnedWindowsJobIntent');
        if(jobIntents.length){
            const starts=records.filter(row=>row.data.processId===processId&&row.kind==='OwnedProcessRootStarted'),exits=records.filter(row=>row.data.processId===processId&&row.kind==='OwnedProcessRootExited'),started=starts[0],closed=exits[0];
            if(jobIntents.length!==1||starts.length!==1||exits.length!==1||closed.data.rootClosed!==true||typeof started.data.identity!=='string'||!/^win32:\d+$/.test(started.data.identity))throw new DomainError('WINDOWS_INTENT_OBSERVATION_UNPROVEN',409);
            const original=jobIntents[0].data;
            const sequence=[grant,intent,jobIntents[0],started,closed].map(row=>records.indexOf(row));
            if(typeof original.generation!=='string'||!original.generation||original.generation!==intent.data.generation||original.generation!==grant.data.generation||started.data.generation!==original.generation||closed.data.generation!==original.generation||
                sequence.some((value,index)=>index>0&&value<=sequence[index-1]))throw new DomainError('WINDOWS_INTENT_BINDING_INVALID',409);
            const binding={jobId:String(original.jobId),requestSha256:String(original.requestSha256),helperSha256:String(original.helperSha256),
                commandSha256:String(intent.data.commandSha256),argvSha256:String(intent.data.argvSha256),
                parentPid:Number(original.parentPid),parentTicks:String(original.parentTicks),rootPid:Number(started.data.pid),rootTicks:started.data.identity.slice(6)};
            const scopeHash=hash({projectId,runId,processId,dispatchId,generation:original.generation,binding}),observation=await observeWindowsUptime(root,binding);
            const witnesses=records.filter(row=>row.kind==='WindowsIntentUptimeWitness'&&row.data.processId===processId);
            if(witnesses.length>1)throw new DomainError('WINDOWS_INTENT_OBSERVATION_UNPROVEN',409);
            if(!witnesses.length){
                store.tx(()=>{
                    const existing=store.db.prepare("SELECT data FROM records WHERE project_id IS ? AND run_id IS ? AND kind='WindowsIntentUptimeWitness' AND json_extract(data,'$.processId')=?").all(projectId,runId,String(processId));
                    if(existing.length>1||existing.some(row=>object(JSON.parse(String(row.data))).scopeHash!==scopeHash))throw new DomainError('WINDOWS_INTENT_BINDING_INVALID',409);
                    if(!existing.length)store.record('WindowsIntentUptimeWitness',projectId,runId,{schema:'dream-maker.windows-uptime-witness.v1',processId,dispatchId,generation:original.generation,scopeHash,...observation});
                });
                throw new DomainError('WINDOWS_RESTART_REQUIRED_FOR_OWNERSHIP',409);
            }
            const witness=witnesses[0];
            if(records.indexOf(witness)<=records.indexOf(closed)||witness.data.generation!==original.generation)throw new DomainError('WINDOWS_INTENT_BINDING_INVALID',409);
            const checked=checkWindowsUptimeReset(witness.data,observation.measurement,scopeHash,observation),proof={checked,witnessRecordId:witness.id,...observation};
            const obs={processId,dispatchId,generation:original.generation,...proof};let recordId:string|undefined;
            if(deferObservation)deferObservation(obs);else{recordId=store.record('WindowsIntentRecoveryObservation',projectId,runId,obs);}
            proofs.push({processId,kind:'READONLY_WINDOWS_UPTIME_RESET',...(recordId?{recordId}:{}),receiptSha256:hash(proof)});continue;
        }
        const legacyObserver=legacyReadonlyNetworkObserverProof(records,grant,String(processId));
        if(legacyObserver){proofs.push(legacyObserver);continue;}
        const codex=records.find(row=>row.data.processId===processId&&row.kind==='OwnedCodexPinned');
        if(codex){
            const helper=readFileSync(resolve(root,'scripts/isolation/codex-owned-process.py'),'utf8');
            if(hash(helper)!==codex.data.helperSha256||!/^owned_codex_[a-f0-9]{20}$/.test(String(codex.data.markerId))||config.codex.wslDistro!==WSL_ENVIRONMENT)throw new DomainError('CODEX_RECOVERY_SOURCE_BINDING_CHANGED',409);
            const raw=await linux(helper,['status','/opt/dream-maker-controller/owned-role-processes-revamp',String(codex.data.markerId),String(codex.data.markerSha256)]);
            const status=validateOwnedCodexStatus(raw,{markerId:String(codex.data.markerId),home:config.codex.wslHome!,cwd:config.codex.wslCwdRoot!,binarySha256:String(object(codex.data.marker).binarySha256)},String(codex.data.markerSha256),true);
            proofs.push({processId,kind:'READONLY_CURRENT_LINUX_CODEX_GROUP',receiptSha256:hash(status)});continue;
        }
        const retirements=records.filter(row=>row.data.processId===processId&&row.kind==='OwnedSqliteRetirementIntent');
        if(retirements.length){
            const saved=retirements[0];
            if(retirements.length!==1||saved.data.generation!==grant.data.generation||saved.data.generation!==intent.data.generation||records.indexOf(saved)<=records.indexOf(intent))throw new DomainError('SQLITE_RETIREMENT_CLEANUP_UNPROVEN',409);
            const closure=retirementRootClosure(records,String(processId),String(grant.data.generation)),observation=await readSqliteRetirement(root,saved.data as unknown as RetirementIntent);
            proofs.push({processId,kind:'READONLY_EXACT_SQLITE_RETIREMENT_HELPER_ABSENCE',receiptSha256:hash({closure,observation})});continue;
        }
        const sandbox=records.find(row=>row.data.processId===processId&&row.kind==='OwnedWslSandboxIntent');
        if(sandbox){
            if(sandbox.data.environment!==WSL_ENVIRONMENT)throw new DomainError('SANDBOX_RECOVERY_ENVIRONMENT_CHANGED',409);
            const jobId=String(sandbox.data.jobId);if(!/^wsl_job_[a-z0-9_-]{1,80}$/.test(jobId))throw new DomainError('SANDBOX_JOB_ID_DENIED',409);
            if(sandbox.data.resourceHelperHash!==undefined){
                try{
                    const rootClosure=requireResourceProcessClosure(records,String(processId),String(sandbox.data.generation));
                    const expected={jobId,sourceHash:String(sandbox.data.sourceHash),workerHash:String(sandbox.data.workerHash),resourceHelperHash:String(sandbox.data.resourceHelperHash)};
                    const saved=await readSavedResourceJob(root,expected),result=checkSandboxResult(saved.result,{...expected,environment:WSL_ENVIRONMENT});
                    const resourceFinal=checkResourceObservation(saved.observation,expected,result);
                    proofs.push({processId,kind:'READONLY_EXACT_RESOURCE_SCOPE_AND_FINAL_RECEIPT',receiptSha256:hash({result,resourceFinal,rootClosure})});continue;
                }catch(error){
                    if(!(error instanceof DomainError)||error.code!=='SANDBOX_RESOURCE_CLEANUP_UNPROVEN')throw error;
                    if(sandbox.data.generation!==intent.data.generation||intent.data.generation!==grant.data.generation||
                        records.indexOf(sandbox)<=records.indexOf(intent)||
                        !/^[a-f0-9]{64}$/.test(String(sandbox.data.resourceHelperHash)))throw new DomainError('SANDBOX_INTENT_BINDING_INVALID',409);
                    // The fixed helper writes its intent receipt before forking or creating a cgroup.
                    // A fresh guest observation of all five absences proves no sandbox process was
                    // ever created; it never substitutes for a real final receipt.
                    const absence=await probeSandboxAbsence(root,jobId,String(sandbox.data.resourceHelperHash),WSL_ENVIRONMENT);
                    proofs.push({processId,kind:'READONLY_WSL_SANDBOX_NEVER_CREATED',receiptSha256:hash({jobId,absence})});continue;
                }
            }
            const script="import json,os,pathlib,stat,sys; j=sys.argv[1]; p=pathlib.Path('/opt/dream-maker-acceptance-20261011')/j/'result.json'; fd=os.open(str(p),os.O_RDONLY|os.O_NOFOLLOW); f=os.fdopen(fd,'rb'); assert stat.S_ISREG(os.fstat(f.fileno()).st_mode); raw=f.read(2000001); assert len(raw)<=2000000; value=json.loads(raw); assert not (pathlib.Path('/sys/fs/cgroup')/j).exists(); print(json.dumps(value))";
            const raw=await linux(script,[jobId]);const result=checkSandboxResult(raw,{jobId,sourceHash:String(sandbox.data.sourceHash),workerHash:String(sandbox.data.workerHash),environment:WSL_ENVIRONMENT});
            proofs.push({processId,kind:'READONLY_CURRENT_SANDBOX_GROUP_AND_SAVED_RESULT',receiptSha256:hash(result)});continue;
        }
        throw new DomainError('DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED',409);
    }
    return {schema:'dream-maker.dispatch-recovery.v1',dispatchId,proven:true,basisSha256:hash({dispatchId,grant:grant.id,recordIds:records.map(row=>row.id),proofs})};
}



