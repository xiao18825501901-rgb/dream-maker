import { readFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DomainError,hash,object,childEnv,within,hasSecret } from '../security.js';
import { capture } from '../process.js';
import { inspectOutsideExecutionScope } from './process-ownership.js';

export interface UnpinnedJobBinding {jobId:string;parentPid:number;parentTicks:string;rootPid:number;rootTicks:string}
type RequestBinding=UnpinnedJobBinding&{requestSha256:string;helperSha256:string;commandSha256:string;argvSha256:string};
const epoch=621355968000000000n;
const unproven=():never=>{throw new DomainError('WINDOWS_INTENT_OBSERVATION_UNPROVEN',409);};
function ticks(value:unknown):bigint {if(typeof value!=='string'||!/^\d{1,19}$/.test(value)||BigInt(value)<=0n)return unproven();return BigInt(value);}
function pid(value:unknown):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>0x7fffffff)return unproven();return value;}
function utc(value:unknown):bigint {
    if(typeof value!=='string')return unproven();const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(value);
    if(!match)return unproven();const millis=Date.parse(match[1]+'Z');
    if(!Number.isFinite(millis)||new Date(millis).toISOString().slice(0,19)!==match[1])return unproven();
    return epoch+BigInt(millis)*10000n+BigInt((match[2]??'').padEnd(7,'0'));
}
export function checkUnpinnedJobObservation(binding:UnpinnedJobBinding,raw:unknown,rawClock:unknown){
    const snapshot=object(raw),clock=object(rawClock),origin=ticks(binding.rootTicks),begin=ticks(snapshot.captureStartTicks),boot=ticks(snapshot.bootTicks);
    pid(binding.rootPid);pid(binding.parentPid);
    if(!/^windows_job_[a-f0-9]{20}$/.test(binding.jobId)||binding.rootPid<=0||binding.parentPid<=0||origin<=ticks(binding.parentTicks)||boot>=origin||begin<=origin||
        snapshot.schema!=='dream-maker.windows-job-os-snapshot.v1'||snapshot.enumeration!=='TOOLHELP_FROZEN_LIST_WITH_BOUND_IDENTITIES'||snapshot.identitiesBound!==true||
        !Array.isArray(snapshot.processes)||snapshot.processes.length<1||snapshot.processes.length>32768||snapshot.processCount!==snapshot.processes.length)return unproven();
    if(utc(snapshot.at)<begin||clock.schema!=='dream-maker.windows-clock-observation.v1'||clock.enabled!==true||utc(clock.at)<utc(snapshot.at)||
        utc(clock.oldestTime)>origin||clock.limit!==4097||!Array.isArray(clock.changes)||clock.changes.length>=4097)return unproven();
    const processes=new Map<number,{pid:number;parent:number;created:bigint;session:number}>(),sessions=new Set<number>([0]);
    for(const rawProcess of snapshot.processes){
        const row=object(rawProcess),id=pid(row.pid),parent=pid(row.parent),session=pid(row.session),created=ticks(row.createdTicks);
        if(processes.has(id)||created>=begin||typeof row.image!=='string'||row.image.length>260||
            !['HANDLE_BOUND_IDENTITY','POST_FREEZE_BOUND_IDENTITY','KERNEL_BOOT_IDENTITY'].includes(String(row.identityBasis))||
            row.identityBasis==='KERNEL_BOOT_IDENTITY'&&(![0,4].includes(id)||created!==boot))return unproven();
        processes.set(id,{pid:id,parent,created,session});sessions.add(session);
    }
    if(processes.get(binding.rootPid)?.created===origin||processes.get(binding.parentPid)?.created===ticks(binding.parentTicks))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
    const coverage=object(clock.coverage??{}),start=object(coverage.startRecord??{}),service=processes.get(pid(coverage.servicePid));
    if(coverage.classic!==true||coverage.serviceRunning!==true||!service||service.created!==ticks(coverage.serviceCreatedTicks)||service.created>=origin||
        utc(start.at)<service.created||utc(start.at)>=origin||!Number.isSafeInteger(start.id)||Number(start.id)<1||!Number.isSafeInteger(coverage.lastRecordId)||
        !Array.isArray(coverage.recordIds)||coverage.recordIds.length<1||coverage.recordIds.length>8192||
        Number(coverage.lastRecordId)-Number(start.id)+1!==coverage.recordIds.length||coverage.recordIds.some((id,index)=>id!==Number(start.id)+index)||
        !Array.isArray(coverage.startRecordIds)||coverage.startRecordIds.length!==1||coverage.startRecordIds[0]!==start.id||
        !Array.isArray(coverage.stopOrClearRecordIds)||coverage.stopOrClearRecordIds.length!==0||!Array.isArray(coverage.clockRecordIds))return unproven();
    const clockRecords=new Set(coverage.clockRecordIds);
    if(clockRecords.size!==coverage.clockRecordIds.length||clockRecords.size!==clock.changes.length)return unproven();
    for(const rawChange of clock.changes){const change=object(rawChange),before=utc(change.oldTime),after=utc(change.newTime);
        if(!Number.isSafeInteger(change.recordId)||Number(change.recordId)<Number(start.id)||Number(change.recordId)>Number(coverage.lastRecordId)||!clockRecords.delete(change.recordId)||before>=origin&&after<before)return unproven();
    }
    let postOriginProcesses=0;
    for(const row of processes.values()){
        if(row.created<origin)continue;postOriginProcesses++;
        let current=row;const seen=new Set<number>();
        while(current.created>=origin){
            if(seen.has(current.pid)||current.parent===0)return unproven();seen.add(current.pid);
            const parent=processes.get(current.parent);
            // Equal creation ticks cannot distinguish an exited parent from PID reuse.
            if(!parent||parent.created>=current.created)return unproven();current=parent;
        }
    }
    if(sessions.size>128||!Array.isArray(snapshot.jobs))return unproven();
    const expected=new Set([...sessions].map(n=>`\\Sessions\\${n}\\BaseNamedObjects\\DreamMaker_${binding.jobId}`));expected.add(`\\BaseNamedObjects\\DreamMaker_${binding.jobId}`);
    if(snapshot.jobs.length!==expected.size)return unproven();
    for(const rawJob of snapshot.jobs){
        const job=object(rawJob);if(typeof job.path!=='string'||!expected.delete(job.path)||!['ABSENT','QUERIED'].includes(String(job.status))||typeof job.active!=='number'||!Number.isSafeInteger(job.active)||job.active<0)return unproven();
        if(job.active!==0)throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
    }
    if(expected.size)return unproven();
    return {schema:'dream-maker.windows-unpinned-check.v1',jobId:binding.jobId,basis:'FROZEN_PROCESS_ANCESTRY_AND_ALL_SESSION_JOBS',
        rootIdentity:'win32:'+binding.rootTicks,processes:processes.size,postOriginProcesses,sessions:[...sessions].sort((a,b)=>a-b),modelCompletionClaim:false};
}

const script=String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$dmSource=[IO.File]::ReadAllText($env:DM_INSPECT_SOURCE);$dmSha=[Security.Cryptography.SHA256]::Create();try{$dmActual=[BitConverter]::ToString($dmSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($dmSource))).Replace('-','').ToLowerInvariant()}finally{$dmSha.Dispose()};if($dmActual -ne $env:DM_INSPECT_SOURCE_HASH){throw 'INSPECTOR_SOURCE_CHANGED'}
Add-Type -TypeDefinition $dmSource -ErrorAction Stop
$dmSnapshot=[DmJobInspector]::Inspect($env:DM_INSPECT_JOB,$env:DM_INSPECT_ORIGIN)
$dmLog=Get-WinEvent -ListLog System -ErrorAction Stop;$dmOldest=Get-WinEvent -LogName System -Oldest -MaxEvents 1 -ErrorAction Stop
$dmStart=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='EventLog';Id=6005} -MaxEvents 1 -ErrorAction Stop;$dmLast=Get-WinEvent -LogName System -MaxEvents 1 -ErrorAction Stop
$dmSpan=@(Get-WinEvent -LogName System -FilterXPath "*[System[(EventRecordID >= $($dmStart.RecordId)) and (EventRecordID <= $($dmLast.RecordId))]]" -MaxEvents 8193 -ErrorAction Stop | Sort-Object RecordId)
$dmService=Get-CimInstance Win32_Service -Filter "Name='EventLog'" -ErrorAction Stop;$dmServiceIdentity=[DmJobInspector]::ReadIdentity([int]$dmService.ProcessId)
$dmChanges=@($dmSpan|Where-Object { $_.ProviderName -eq 'Microsoft-Windows-Kernel-General' -and $_.Id -eq 1 })
$dmClockRows=@(foreach($dmEvent in $dmChanges){$dmXml=[xml]$dmEvent.ToXml();$dmOld=$dmXml.Event.EventData.Data|Where-Object Name -eq 'OldTime';$dmNew=$dmXml.Event.EventData.Data|Where-Object Name -eq 'NewTime';@{recordId=$dmEvent.RecordId;oldTime=$dmOld.'#text';newTime=$dmNew.'#text'}})
$dmCoverage=@{classic=$dmLog.IsClassicLog;serviceRunning=($dmService.State -eq 'Running');servicePid=[int]$dmService.ProcessId;serviceCreatedTicks=$dmServiceIdentity.createdTicks;startRecord=@{id=$dmStart.RecordId;at=$dmStart.TimeCreated.ToUniversalTime().ToString('o')};lastRecordId=$dmLast.RecordId;recordIds=@($dmSpan|ForEach-Object {$_.RecordId});startRecordIds=@($dmSpan|Where-Object {$_.ProviderName -eq 'EventLog' -and $_.Id -eq 6005}|ForEach-Object {$_.RecordId});stopOrClearRecordIds=@($dmSpan|Where-Object {($_.ProviderName -eq 'EventLog' -and $_.Id -eq 6006) -or ($_.ProviderName -eq 'Microsoft-Windows-Eventlog' -and $_.Id -eq 104)}|ForEach-Object {$_.RecordId});clockRecordIds=@($dmChanges|ForEach-Object {$_.RecordId})}
@{snapshot=$dmSnapshot;clock=@{schema='dream-maker.windows-clock-observation.v1';at=[datetime]::UtcNow.ToString('o');enabled=$dmLog.IsEnabled;oldestTime=$dmOldest.TimeCreated.ToUniversalTime().ToString('o');limit=4097;changes=$dmClockRows;coverage=$dmCoverage}} | ConvertTo-Json -Depth 8 -Compress`;

function requestDirectory(root:string,binding:RequestBinding){
    if(process.platform!=='win32'||!/^windows_job_[a-f0-9]{20}$/.test(binding.jobId))return unproven();
    const directory=within(root,'.runtime/owned-process-jobs/'+binding.jobId),requestBytes=readFileSync(within(directory,'request.json')),
        request=object(JSON.parse(requestBytes.toString('utf8'))),helper=readFileSync(within(root,'scripts/isolation/windows-owned-job.cs'));
    if(typeof request.binary!=='string'||!Array.isArray(request.args)||request.args.some(arg=>typeof arg!=='string')||hash(requestBytes)!==binding.requestSha256||hash(helper)!==binding.helperSha256||hash(request.binary)!==binding.commandSha256||hash(request.args)!==binding.argvSha256||request.parentPid!==binding.parentPid||request.parentTicks!==binding.parentTicks||
        request.jobName!=='Local\\DreamMaker_'+binding.jobId||resolve(String(request.marker))!==resolve(directory,'started.json'))throw new DomainError('WINDOWS_INTENT_BINDING_INVALID',409);
    return directory;
}
/** Diagnostic only: EVTX reads cannot attest submission completion or losslessness.
 * Never use this result to release a formal lease. Production uses the uptime witness. */
export async function inspectUnpinnedJob(root:string,binding:RequestBinding){
    const directory=requestDirectory(root,binding);
    const source=within(root,'scripts/isolation/windows-job-inspector.cs'),sourceHash=hash(readFileSync(source));
    const inspectionDirectory=mkdtempSync(join(directory,'recovery-inspection-'));
    const result=await inspectOutsideExecutionScope(()=>capture(resolve(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{cwd:root,env:childEnv({TEMP:inspectionDirectory,TMP:inspectionDirectory,DM_INSPECT_SOURCE:source,DM_INSPECT_SOURCE_HASH:sourceHash,DM_INSPECT_JOB:binding.jobId,DM_INSPECT_ORIGIN:binding.rootTicks}),timeoutMs:20000,maxBytes:1500000}));
    if(result.code!==0)throw new DomainError('WINDOWS_INTENT_OS_OBSERVATION_UNAVAILABLE',409);
    if(hasSecret(result.stdout))throw new DomainError('WINDOWS_INTENT_OBSERVATION_SECRET',409);
    const observed=object(JSON.parse(result.stdout)),checked=checkUnpinnedJobObservation(binding,observed.snapshot,observed.clock);
    return {checked,observation:observed,inspectorSha256:sourceHash,requestSha256:binding.requestSha256,helperSha256:binding.helperSha256,inspectionDirectory};
}

function uptime(raw:unknown):bigint {
    const value=object(raw);
    if(value.schema!=='dream-maker.windows-uptime.v1'||value.source!=='KERNEL32_GET_TICK_COUNT_64'||typeof value.hostHash!=='string'||!/^[a-f0-9]{64}$/.test(value.hostHash)||typeof value.milliseconds!=='string'||!/^\d{1,15}$/.test(value.milliseconds))return unproven();
    const count=BigInt(value.milliseconds);
    // Reject implausible/overflowing measurements; an ordinary boot counter cannot wrap in this range.
    if(count<1000n||count>10n*366n*24n*3600n*1000n)return unproven();return count;
}
export function checkWindowsUptimeReset(rawWitness:unknown,current:unknown,scopeHash:string,rawReader:unknown){
    const witness=object(rawWitness),reader=object(rawReader);
    if(!/^[a-f0-9]{64}$/.test(scopeHash)||witness.schema!=='dream-maker.windows-uptime-witness.v1'||witness.scopeHash!==scopeHash)return unproven();
    for(const field of ['inspectorSha256','readerSha256'])if(typeof witness[field]!=='string'||!/^[a-f0-9]{64}$/.test(String(witness[field]))||reader[field]!==witness[field])return unproven();
    const before=uptime(witness.measurement),after=uptime(current);
    if(object(witness.measurement).hostHash!==object(current).hostHash)return unproven();
    if(after>=before)throw new DomainError('WINDOWS_RESTART_REQUIRED_FOR_OWNERSHIP',409);
    return {schema:'dream-maker.windows-uptime-reset-proof.v1',basis:'WINDOWS_UPTIME_RESET_AFTER_DURABLE_WITNESS',
        scopeHash,readerSha256:reader.readerSha256,inspectorSha256:reader.inspectorSha256,witnessUptimeMilliseconds:String(before),currentUptimeMilliseconds:String(after),modelCompletionClaim:false};
}
/** A kernel monotonic counter, independent of UTC and event-log delivery. The caller
 * durably stores the first observation BEFORE asking for a human-controlled restart. */
export async function observeWindowsUptime(root:string,binding:RequestBinding){
    const directory=requestDirectory(root,binding),source=within(root,'scripts/isolation/windows-job-inspector.cs'),sourceHash=hash(readFileSync(source)),inspectionDirectory=mkdtempSync(join(directory,'uptime-inspection-'));
    const prefix=script.slice(0,script.indexOf('$dmSnapshot='));
    const command=prefix+String.raw`$dmMachine=[Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography','MachineGuid',$null);if(-not $dmMachine){throw 'WINDOWS_HOST_IDENTITY_UNAVAILABLE'};$dmHash=[Security.Cryptography.SHA256]::Create();try{$dmHostHash=[BitConverter]::ToString($dmHash.ComputeHash([Text.Encoding]::UTF8.GetBytes('dream-maker.windows-host.v1|'+$dmMachine.ToString().ToLowerInvariant()+'|'+[Environment]::MachineName))).Replace('-','').ToLowerInvariant()}finally{$dmHash.Dispose()};$dmMachine=$null
@{schema='dream-maker.windows-uptime.v1';source='KERNEL32_GET_TICK_COUNT_64';hostHash=$dmHostHash;milliseconds=[DmJobInspector]::UptimeMilliseconds()}|ConvertTo-Json -Compress`;
    const readerCommand=resolve(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),readerArgs=['-NoLogo','-NoProfile','-NonInteractive','-Command',command];
    const readerSha256=hash({schema:'dream-maker.windows-uptime-reader.v1',inspectorSha256:sourceHash,command:readerCommand,argv:readerArgs,unit:'MILLISECONDS'});
    const result=await inspectOutsideExecutionScope(()=>capture(readerCommand,readerArgs,
        {cwd:root,env:childEnv({TEMP:inspectionDirectory,TMP:inspectionDirectory,DM_INSPECT_SOURCE:source,DM_INSPECT_SOURCE_HASH:sourceHash}),timeoutMs:20000,maxBytes:64000}));
    if(result.code!==0)throw new DomainError('WINDOWS_UPTIME_OBSERVATION_UNAVAILABLE',409);
    const measurement=object(JSON.parse(result.stdout));uptime(measurement);
    return {measurement,inspectorSha256:sourceHash,readerSha256,inspectionDirectory};
}
