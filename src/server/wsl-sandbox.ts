import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { own } from './process.js';
import { files, get, treeHash } from './workspace.js';
import { DomainError, object, text, hash, id, childEnv, redact, hasSecret } from './security.js';
import { currentProcessOwnership } from './flow/process-ownership.js';
import { SqliteFrameDecoder,sqliteInputDescriptor,checkSqliteImageBytes,type SqliteChannelBinding,type SqliteInputDescriptor,type SqliteFrame } from './sqlite-channel.js';
import {sandboxBootstrap,readSavedResourceJob,checkResourceObservation} from './sandbox-resource.js';
import {probeSandboxAbsence} from './wsl-sandbox-absence.js';

export const WSL_ENVIRONMENT = 'DreamMaker-Acceptance-F-20261101-R2';
export interface SandboxCommand { runtime:'node'|'python'; entry:string; args:string[]; stdin:string }
export interface SandboxResult {
    schema:'dream-maker.wsl-result.v1';jobId:string;sourceHash:string;workerHash:string;
    status:string;exitCode:number;stdout:string;stderr:string;
    cleanup:{remainingPids:string[];groupRemoved:boolean;delegationRestored:boolean;sourceUnchanged:boolean};
    limits?:Record<string,unknown>;environment?:string;resourceEvents?:Record<string,string>;
    command?:string[];
}
export interface SqliteSandboxExpected {
    jobId:string;sourceHash:string;workerHash:string;environment:string;
    descriptor:SqliteInputDescriptor;snapshotHelperHash:string;
}
export interface SqliteSandboxExchange {result:SandboxResult;image:Buffer|null;exchangeMetadata:SqliteFrame}
/** This gate supplements, never replaces, the original owned-job/cleanup check. */
export function checkSqliteSandboxResult(raw:unknown,expected:SqliteSandboxExpected,frame:SqliteFrame):SandboxResult {
    const result=checkSandboxResult(raw,expected),s=object(object(raw).sqlite),retention=object(s.retention),d=expected.descriptor;
    const empty=hash(Buffer.alloc(0)),emptyPids=(p:unknown)=>Array.isArray(p)&&p.length===0;
    if(s.schema!=='dream-maker.sqlite-execution.v1'||s.kind!==d.kind||s.inputHash!==d.inputHash||s.expectedRevision!==d.expectedRevision||
        s.imageHash!==d.imageHash||s.imageBytes!==d.imageBytes||s.snapshotHelperHash!==expected.snapshotHelperHash||
        !emptyPids(s.generatedPidsAfter)||!emptyPids(s.snapshotPidsAfter)||s.privateMountNamespace!==true||
        s.runTmpfsBytes!==33554432||s.dataTmpfsBytes!==218103808||s.mountsRemoved!==true||
        retention.schema!=='dream-maker.sqlite-retention.v1'||retention.state!=='RETAINED'||
        !Number.isSafeInteger(retention.bytes)||Number(retention.bytes)<0||Number(retention.bytes)>768*1024*1024||
        typeof retention.manifestHash!=='string'||!/^[a-f0-9]{64}$/.test(retention.manifestHash)||
        frame.inputHash!==d.inputHash||frame.expectedRevision!==d.expectedRevision)
        throw new DomainError('SQLITE_SANDBOX_RESULT_UNPROVEN',502);
    if(s.snapshotStatus==='READY'){
        if(s.snapshot===null||typeof s.snapshot!=='object'||Array.isArray(s.snapshot))throw new DomainError('SQLITE_SANDBOX_RESULT_UNPROVEN',502);
        const snapshot=object(s.snapshot);
        if(result.status!=='EXECUTED'||result.exitCode!==0||snapshot.schema!=='dream-maker.sqlite-snapshot.v1'||snapshot.integrity!=='ok'||
            typeof snapshot.sqliteVersion!=='string'||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(snapshot.sqliteVersion)||
            frame.imageBytes<512||snapshot.bytes!==frame.imageBytes||snapshot.sha256!==frame.imageHash)
            throw new DomainError('SQLITE_SANDBOX_RESULT_UNPROVEN',502);
    }else if(!['NOT_RUN','REJECTED'].includes(String(s.snapshotStatus))||s.snapshot!==null||frame.imageBytes!==0||frame.imageHash!==empty){
        throw new DomainError('SQLITE_SANDBOX_RESULT_UNPROVEN',502);
    }
    return result;
}
export function validateSandboxCommand(raw:unknown):SandboxCommand {
    const v=object(raw);
    if(hasSecret(JSON.stringify(v)))throw new DomainError('SECRET_IN_SANDBOX_INPUT',403);
    if(Object.keys(v).some(k=>!['runtime','entry','args','stdin'].includes(k)) || !['node','python'].includes(v.runtime as string))
        throw new DomainError('SANDBOX_COMMAND_DENIED',403);
    const entry=text(v.entry,300);
    if(!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(entry) || entry.split('/').some(s=>['.','..','node_modules','.git'].includes(s)||/^\.env(?:\.|$)/i.test(s)) ||
        !(v.runtime==='node'?/\.(mjs|cjs|js)$/:/\.py$/).test(entry)) throw new DomainError('SANDBOX_ENTRY_DENIED',403);
    if(!Array.isArray(v.args)||v.args.length>32)throw new DomainError('SANDBOX_ARGUMENTS_DENIED',403);
    if(v.args.some(a=>typeof a!=='string'||a.length>8192||a.includes('\0'))||typeof v.stdin!=='string'||v.stdin.length>65536)
        throw new DomainError('SANDBOX_ARGUMENTS_DENIED',403);
    const args=v.args as string[],stdin=v.stdin as string;
    if(args.reduce((n,s)=>n+s.length,0)>8192)throw new DomainError('SANDBOX_ARGUMENTS_DENIED',403);
    return {runtime:v.runtime as SandboxCommand['runtime'],entry,args,stdin};
}
export function checkSandboxResult(raw:unknown,expected:{jobId:string;sourceHash:string;workerHash:string;environment?:string}):SandboxResult {
    const v=object(raw),c=object(v.cleanup);
    if(v.schema!=='dream-maker.wsl-result.v1'||v.jobId!==expected.jobId||v.sourceHash!==expected.sourceHash||v.workerHash!==expected.workerHash||expected.environment!==undefined&&v.environment!==expected.environment||
        !['EXECUTED','TIMED_OUT','CANCELLED','OUTPUT_LIMIT','MEMORY_LIMIT'].includes(v.status as string)||
        !Number.isInteger(v.exitCode)||typeof v.stdout!=='string'||typeof v.stderr!=='string'||v.stdout.length>2000000||v.stderr.length>2000000||
        !Array.isArray(c.remainingPids)||c.remainingPids.length||c.groupRemoved!==true||c.delegationRestored!==true||c.sourceUnchanged!==true)
        throw new DomainError('SANDBOX_RESULT_OR_CLEANUP_UNPROVEN',502);
    return v as unknown as SandboxResult;
}

// Only trusted controller code may launch WSL. Neither argv nor stdin contains credentials.
export class WslSandbox {
    private active=false;
    constructor(private root:string) {}
    async run(workspace:string,raw:unknown,options:{signal?:AbortSignal;wallSeconds?:number;jobId?:string;onResult?:(r:SandboxResult)=>void}={}):Promise<SandboxResult> {
        return (await this.runTransport(workspace,raw,options)).result;
    }
    async runSqlite(workspace:string,raw:unknown,image:Buffer|null,binding:SqliteChannelBinding,options:{signal?:AbortSignal;wallSeconds?:number;jobId?:string;onResult?:(r:SandboxResult)=>void}={}):Promise<SqliteSandboxExchange> {
        if(process.platform!=='win32')throw new DomainError('DEDICATED_WINDOWS_WSL_REQUIRED',409);
        if(this.active)throw new DomainError('ONE_SANDBOX_JOB_ONLY',409);
        if(options.signal?.aborted)throw new DomainError('RUN_CANCELLED',409);
        if(image!==null)checkSqliteImageBytes(image);
        // Own the input bytes before the first await; a caller may reuse its Buffer afterwards.
        const captured=image===null?null:Buffer.from(image),descriptor=sqliteInputDescriptor(captured,binding);
        return this.runTransport(workspace,raw,options,{image:captured,descriptor});
    }
    private async runTransport(workspace:string,raw:unknown,options:{signal?:AbortSignal;wallSeconds?:number;jobId?:string;onResult?:(r:SandboxResult)=>void},sqlite?:{image:Buffer|null;descriptor:SqliteInputDescriptor}):Promise<SqliteSandboxExchange> {
        if(process.platform!=='win32')throw new DomainError('DEDICATED_WINDOWS_WSL_REQUIRED',409);
        if(this.active)throw new DomainError('ONE_SANDBOX_JOB_ONLY',409);
        if(options.signal?.aborted)throw new DomainError('RUN_CANCELLED',409);
        const command=validateSandboxCommand(raw),wallSeconds=options.wallSeconds??30;
        if(!Number.isInteger(wallSeconds)||wallSeconds<1||wallSeconds>120)throw new DomainError('SANDBOX_WALL_LIMIT_DENIED');
        const catalog=files(workspace),sourceHash=treeHash(workspace),jobId=options.jobId??id('wsl_job');
        if(!/^wsl_job_[a-z0-9_-]{1,80}$/.test(jobId))throw new DomainError('SANDBOX_JOB_ID_DENIED');
        if(!catalog.some(f=>f.path===command.entry))throw new DomainError('SANDBOX_ENTRY_MISSING',409);
        const sourceFiles=catalog.map(f=>{const data=get(workspace,f.path);if(hash(data)!==f.sha256)throw new DomainError('SOURCE_CHANGED_DURING_STAGING',409);return {...f,body:data.toString('base64')};});
        const worker=readFileSync(resolve(this.root,'scripts/isolation/wsl-worker.py'),'utf8'),workerHash=hash(worker);
        const resourceHelper=readFileSync(resolve(this.root,'scripts/isolation/wsl-resource-context.py'),'utf8'),resourceHelperHash=hash(resourceHelper);
        const snapshotHelper=sqlite?readFileSync(resolve(this.root,'scripts/isolation/sqlite-snapshot.py'),'utf8'):undefined,snapshotHelperHash=snapshotHelper?hash(snapshotHelper):undefined;
        const request={schema:sqlite?'dream-maker.wsl-job.v2':'dream-maker.wsl-job.v1',jobId,sourceHash,workerHash,command,wallSeconds,files:sourceFiles,worker,resourceHelper,resourceHelperHash,
            ...(sqlite?{sqlite:{...sqlite.descriptor,snapshotHelper,snapshotHelperHash}}:{})};
        const line=JSON.stringify(request)+'\n';
        if(sqlite&&Buffer.byteLength(line)>40000001)throw new DomainError('SANDBOX_INPUT_METADATA_LIMIT',413);
        const bootstrap=sandboxBootstrap(workerHash,resourceHelperHash);
        const owned=currentProcessOwnership();
        this.active=true;
        let p;try{p=own('wsl.exe',['-d',WSL_ENVIRONMENT,'--exec','python3','-c',bootstrap],{cwd:this.root,env:childEnv(),onIntent:processId=>owned?.store.record('OwnedWslSandboxIntent',owned.projectId,owned.runId,{processId,dispatchId:owned.dispatchId,generation:owned.generation,jobId,sourceHash,workerHash,resourceHelperHash,environment:WSL_ENVIRONMENT,...(sqlite?{sqlite:sqlite.descriptor,snapshotHelperHash}:{})})});}
        catch(error){this.active=false;throw error;}
        let bytes=0,error:Error|null=null;const stdout:Buffer[]=[],stderr:Buffer[]=[];
        const decoder=sqlite?new SqliteFrameDecoder(sqlite.descriptor):null;
        let fallback:ReturnType<typeof setTimeout>|undefined;
        const cancel=()=>{
            // EOF is the supervisor's parent-death/cancel channel, not an inferred PID kill.
            p.child.stdin.end();
            fallback??=setTimeout(()=>{error=new DomainError('SANDBOX_CLEANUP_UNPROVEN',502);void p.stop().catch(()=>{});},8000);
        };
        const append=(chunk:Buffer,target:Buffer[])=>{bytes+=chunk.length;if(bytes>16000000){error=new DomainError('SANDBOX_PROTOCOL_OUTPUT_LIMIT',502);cancel();}else target.push(chunk);};
        p.child.stdout.on('data',(b:Buffer)=>{if(!decoder)return append(b,stdout);if(error)return;try{decoder.push(b);}catch(e){error=e as Error;cancel();}});p.child.stderr.on('data',(b:Buffer)=>append(b,stderr));
        p.child.on('error',()=>{error=new DomainError('WSL_EXECUTABLE_UNAVAILABLE',409);});
        p.child.stdin.on('error',()=>{if(!error)error=new DomainError('SANDBOX_INPUT_CHANNEL_FAILED',502);});
        p.child.stdout.on('error',()=>{error??=new DomainError('SANDBOX_OUTPUT_CHANNEL_FAILED',502);cancel();});
        p.child.stderr.on('error',()=>{error??=new DomainError('SANDBOX_OUTPUT_CHANNEL_FAILED',502);cancel();});
        const timer=setTimeout(cancel,(wallSeconds+30)*1000);
        options.signal?.addEventListener('abort',cancel,{once:true});
        // Write callbacks bound the queued input to a single chunk and settle on channel failure.
        const send=async()=>{
            const write=(body:Buffer)=>new Promise<void>((yes,no)=>p.child.stdin.write(body,e=>e?no(e):yes()));
            await write(Buffer.from(line));
            if(sqlite?.image)for(let offset=0;offset<sqlite.image.length;offset+=65536){
                if(error||options.signal?.aborted||p.child.stdin.writableEnded)break;
                await write(sqlite.image.subarray(offset,offset+65536));
            }
        };
        const sending=options.signal?.aborted?(cancel(),Promise.resolve()):send().catch(()=>{error??=new DomainError('SANDBOX_INPUT_CHANNEL_FAILED',502);cancel();});
        try {
            const closed=await p.closed;await sending;await p.stop();if(error)throw error;
            if(closed.code!==0){
                let code='FAILED';try{const e=JSON.parse(Buffer.concat(stdout).toString('utf8'));if(e.schema==='dream-maker.wsl-supervisor-error.v1'&&typeof e.code==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(e.code))code=e.code;}catch{}
                const raw=Buffer.concat(stderr),diagnostic=redact(raw.toString('utf8').replaceAll('\0','')).slice(-1200);
                const absence=await probeSandboxAbsence(this.root,jobId,resourceHelperHash,WSL_ENVIRONMENT).catch(()=>null);
                if(absence){
                    owned?.store.record('OwnedWslSandboxNotCreated',owned.projectId,owned.runId,{dispatchId:owned.dispatchId,generation:owned.generation,jobId,sourceHash,workerHash,resourceHelperHash,environment:WSL_ENVIRONMENT,absenceSha256:hash(absence)});
                    p.proveCleanup({kind:'TRUSTED_WSL_SANDBOX_ABSENCE',scopeId:jobId,receiptSha256:hash(absence)});
                    throw new DomainError('SANDBOX_JOB_NOT_CREATED',409,'The dedicated sandbox supervisor exited before creating any job; no process, cgroup or job receipt exists. The run stopped without retrying.');
                }
                throw new DomainError('SANDBOX_RESOURCE_CLEANUP_UNPROVEN',502,`Supervisor ${code} exit ${closed.code}; ${diagnostic}`);
            }
            let rawResult,frame:SqliteFrame|undefined,image:Buffer|null=null;
            if(decoder){const decoded=decoder.finish();frame=decoded.frame;image=decoded.image;rawResult=frame.result;}
            else try{rawResult=JSON.parse(Buffer.concat(stdout).toString('utf8'));}catch{throw new DomainError('SANDBOX_PROTOCOL_INVALID',502);}
            const expected={jobId,sourceHash,workerHash,environment:WSL_ENVIRONMENT};
            const result=sqlite?checkSqliteSandboxResult(rawResult,{...expected,descriptor:sqlite.descriptor,snapshotHelperHash:snapshotHelperHash!},frame!):checkSandboxResult(rawResult,expected);
            const resourceExpected={jobId,sourceHash,workerHash,resourceHelperHash},saved=await readSavedResourceJob(this.root,resourceExpected);
            if(hash(saved.result)!==hash(rawResult))throw new DomainError('SANDBOX_RESOURCE_CLEANUP_UNPROVEN',502);
            const resourceFinal=checkResourceObservation(saved.observation,resourceExpected,rawResult);
            if(treeHash(workspace)!==sourceHash)throw new DomainError('VERIFIER_SOURCE_CHANGED',409);
            owned?.store.record('OwnedWslSandboxClosed',owned.projectId,owned.runId,{dispatchId:owned.dispatchId,generation:owned.generation,jobId,sourceHash,workerHash,resourceHelperHash,resultSha256:hash(result),resourceFinalHash:hash(resourceFinal),cleanup:result.cleanup});
            p.proveCleanup({kind:'TRUSTED_WSL_SANDBOX',scopeId:jobId,receiptSha256:hash({result,resourceFinal})});
            if(sqlite&&options.signal?.aborted&&result.status!=='CANCELLED')throw new DomainError('RUN_CANCELLED',409);
            options.onResult?.(result);return {result,image,exchangeMetadata:frame!};
        }finally{
            clearTimeout(timer);if(fallback)clearTimeout(fallback);options.signal?.removeEventListener('abort',cancel);
            p.child.stdin.destroy();this.active=false;
        }
    }
}
