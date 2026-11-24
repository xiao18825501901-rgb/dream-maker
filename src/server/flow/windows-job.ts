import { mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync } from 'node:fs';
import { resolve,isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DomainError,hash,id,childEnv,object,now,within } from '../security.js';
import { probeProcessIdentity } from '../server-lock.js';
import { currentProcessOwnership,type ProcessCleanupProof } from './process-ownership.js';

const digest="function Get-DmOwnedSha([string]$text){$dmHasher=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($dmHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-','').ToLowerInvariant()}finally{$dmHasher.Dispose()}}; ";
const loadSource=digest+"$dmSource=[IO.File]::ReadAllText($env:DM_OWNED_JOB_SOURCE); if((Get-DmOwnedSha $dmSource) -ne $env:DM_OWNED_JOB_SOURCE_SHA256){throw 'OWNED_JOB_SOURCE_CHANGED'}; Add-Type -TypeDefinition $dmSource -ErrorAction Stop; ";
const driver="$ErrorActionPreference='Stop'; "+loadSource+"$dmRaw=[IO.File]::ReadAllText($env:DM_OWNED_JOB_REQUEST); $dmHash=Get-DmOwnedSha $dmRaw; if($dmHash -ne $env:DM_OWNED_JOB_REQUEST_SHA256){throw 'OWNED_JOB_REQUEST_CHANGED'}; $dmJob=$dmRaw|ConvertFrom-Json; exit [DreamMakerOwnedJob]::Run($dmJob.binary,[string[]]$dmJob.args,$dmJob.cwd,$dmJob.jobName,$dmJob.marker,[int]$dmJob.parentPid,[long]$dmJob.parentTicks,$dmHash);";
const inspector="$ErrorActionPreference='Stop'; "+loadSource+"[DreamMakerOwnedJob]::Status($env:DM_OWNED_JOB_NAME,[int]$env:DM_OWNED_JOB_SESSION);";
/** Every Windows Job call pays a cold PowerShell start plus an Add-Type compile.
 * Measured on the owner's machine: 4.1s warm, 15-40s under load, 104.7s worst.
 * The ceiling stays a hard, bounded refusal; it only stops the helper from being
 * declared unknown before its own compile can finish. */
export const WINDOWS_JOB_COMPILE_CEILING_MS=180_000;
function powerShell(){const path=resolve(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');if(!existsSync(path))throw new DomainError('WINDOWS_JOB_OS_COMPONENT_REQUIRED',409);return path;}
export function readWindowsJobCleanup(root:string,binding:{jobId:string;markerSha256:string;helperSha256:string}):ProcessCleanupProof {
    if(process.platform!=='win32'||!/^windows_job_[a-f0-9]{20}$/.test(binding.jobId)||!/^[a-f0-9]{64}$/.test(binding.markerSha256))throw new DomainError('WINDOWS_JOB_RECOVERY_BINDING_INVALID',409);
    const markerPath=within(root,`.runtime/owned-process-jobs/${binding.jobId}/started.json`),sourcePath=within(root,'scripts/isolation/windows-owned-job.cs');
    const raw=readFileSync(markerPath),marker=object(JSON.parse(raw.toString('utf8'))),jobName='Local\\DreamMaker_'+binding.jobId;
    if(hash(raw)!==binding.markerSha256||hash(readFileSync(sourcePath))!==binding.helperSha256||marker.schema!=='dream-maker.windows-owned-job.v1'||marker.jobName!==jobName||marker.assignedBeforeResume!==true||marker.killOnClose!==true||marker.breakawayAllowed!==false||!Number.isSafeInteger(marker.sessionId))throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);
    // This inspector compiles the pinned C# helper, so it pays the full cold PowerShell
    // start *plus* a compile. Measured 18.9s-39.9s under load on the owner's machine
    // against the old 12s ceiling, which reported PROCESS_CLEANUP_UNPROVEN for a job
    // that had actually closed. The query stays read-only and still fails closed when
    // it does not get a verified answer.
    const result=execFileSync(powerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',inspector],{encoding:'utf8',env:childEnv({TEMP:resolve(markerPath,'..'),TMP:resolve(markerPath,'..'),DM_OWNED_JOB_SOURCE:sourcePath,DM_OWNED_JOB_SOURCE_SHA256:binding.helperSha256,DM_OWNED_JOB_NAME:jobName,DM_OWNED_JOB_SESSION:String(marker.sessionId)}),windowsHide:true,timeout:WINDOWS_JOB_COMPILE_CEILING_MS,stdio:['ignore','pipe','ignore']}).trim();
    if(!['ABSENT','0'].includes(result))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
    return {kind:'TRUSTED_WINDOWS_JOB',scopeId:binding.jobId,receiptSha256:hash({jobId:binding.jobId,jobName,markerSha256:binding.markerSha256,helperSha256:binding.helperSha256,osStatus:result,activeProcesses:0,scope:'WINDOWS_JOB_TREE_NOT_FILESYSTEM_OR_NETWORK_SANDBOX'})};
}
export class WindowsJobSession {
    readonly jobId=id('windows_job');readonly jobName='Local\\DreamMaker_'+this.jobId;readonly markerPath:string;
    readonly command:string;readonly args:string[];readonly environment:NodeJS.ProcessEnv;
    private requestHash:string;private sourceHash:string;private pinned='';private recordBinding=currentProcessOwnership();
    private executablePid?:number;
    get targetPid():number|undefined{return this.executablePid;}
    private sourcePath:string;private parentTicks:string;
    // Cold PowerShell/C# startup was measured at 4100 ms on the owner's machine.
    // Wait within the existing hard startup ceiling; ownership is still pinned before RPC.
    constructor(private root:string,binary:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,private processId?:string,private readyTimeoutMs=WINDOWS_JOB_COMPILE_CEILING_MS){
        if(!Number.isSafeInteger(readyTimeoutMs)||readyTimeoutMs<50||readyTimeoutMs>WINDOWS_JOB_COMPILE_CEILING_MS)throw new DomainError('WINDOWS_JOB_START_LIMIT_INVALID',409);
        if(process.platform!=='win32'||!isAbsolute(binary)||!existsSync(binary)||!isAbsolute(cwd))throw new DomainError('WINDOWS_JOB_LAUNCH_DENIED',409);
        // The Windows component is already used for PID identity. No install, app-bundled runtime,
        // execution-policy change, global profile or PATH-dependent executable selection is needed.
        this.command=powerShell();
        this.sourcePath=within(root,'scripts/isolation/windows-owned-job.cs');this.sourceHash=hash(readFileSync(this.sourcePath));
        this.parentTicks=probeProcessIdentity(process.pid)?.replace(/^win32:/,'')??'';if(!/^\d+$/.test(this.parentTicks))throw new DomainError('WINDOWS_JOB_OWNER_IDENTITY_REQUIRED',409);
        const parent=within(root,'.runtime/owned-process-jobs');mkdirSync(parent,{recursive:true,mode:0o700});if(lstatSync(parent).isSymbolicLink())throw new DomainError('WINDOWS_JOB_CONTROLLER_PATH_REQUIRED',409);
        const directory=resolve(parent,this.jobId);mkdirSync(directory,{mode:0o700});this.markerPath=resolve(directory,'started.json');
        const request={binary,args,cwd,jobName:this.jobName,marker:this.markerPath,parentPid:process.pid,parentTicks:this.parentTicks};
        const raw=JSON.stringify(request),requestPath=resolve(directory,'request.json');this.requestHash=hash(raw);writeFileSync(requestPath,raw,{flag:'wx',mode:0o600});
        this.environment={...env,TEMP:directory,TMP:directory,DM_OWNED_JOB_REQUEST:requestPath,DM_OWNED_JOB_REQUEST_SHA256:this.requestHash,DM_OWNED_JOB_SOURCE:this.sourcePath,DM_OWNED_JOB_SOURCE_SHA256:this.sourceHash};
        this.args=['-NoLogo','-NoProfile','-NonInteractive','-Command',driver];
        this.record('OwnedWindowsJobIntent',{jobId:this.jobId,jobName:this.jobName,markerPath:this.markerPath,requestSha256:this.requestHash,helperSha256:this.sourceHash,parentPid:process.pid,parentTicks:this.parentTicks});
    }
    private record(kind:string,data:Record<string,unknown>){const b=this.recordBinding;b?.store.record(kind,b.projectId,b.runId,{...data,processId:this.processId,dispatchId:b.dispatchId,generation:b.generation,at:now()});}
    async pin(){
        if(this.pinned)return;
        const deadline=Date.now()+this.readyTimeoutMs;
        while(Date.now()<deadline){
            if(existsSync(this.markerPath)){
                let raw:string,value:Record<string,unknown>;try{raw=readFileSync(this.markerPath,'utf8');value=object(JSON.parse(raw));}catch{await new Promise(r=>setTimeout(r,25));continue;}
                if(value.schema!=='dream-maker.windows-owned-job.v1'||value.jobName!==this.jobName||value.requestSha256!==this.requestHash||value.parentPid!==process.pid||value.parentTicks!==this.parentTicks||value.assignedBeforeResume!==true||value.killOnClose!==true||value.breakawayAllowed!==false||value.maxProcesses!==64||value.maxMemoryBytes!==1073741824||!Number.isSafeInteger(value.wrapperPid)||!Number.isSafeInteger(value.childPid))throw new DomainError('WINDOWS_JOB_MARKER_INVALID',409);
                this.pinned=hash(raw);this.executablePid=Number(value.childPid);this.record('OwnedWindowsJobPinned',{jobId:this.jobId,jobName:this.jobName,marker:value,markerSha256:this.pinned,helperSha256:this.sourceHash});return;
            }await new Promise(r=>setTimeout(r,25));
        }throw new DomainError('WINDOWS_JOB_MARKER_UNAVAILABLE',409);
    }
    async prove():Promise<ProcessCleanupProof>{
        await this.pin();if(hash(readFileSync(this.markerPath))!==this.pinned||hash(readFileSync(this.sourcePath))!==this.sourceHash)throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);
        const proof=readWindowsJobCleanup(this.root,{jobId:this.jobId,markerSha256:this.pinned,helperSha256:this.sourceHash});
        this.record('OwnedWindowsJobClosed',{jobId:this.jobId,jobName:this.jobName,markerSha256:this.pinned,helperSha256:this.sourceHash,activeProcesses:0,proof});return proof;
    }
}
