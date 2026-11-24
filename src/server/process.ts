import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import { childEnv, DomainError } from './security.js';
import { beginOwnedProcess,type ProcessCleanupProof } from './flow/process-ownership.js';
import { WindowsJobSession } from './flow/windows-job.js';
import {assertNotProtectedProcess} from './protected-processes.js';
export interface Owned {
    child: ChildProcessWithoutNullStreams;
    closed: Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }>;
    stop: () => Promise<void>;
    proveCleanup: (proof:ProcessCleanupProof) => void;
    ready:Promise<void>;
    /** Actual executable PID after ready, including a Windows Job wrapper. */
    targetPid?:()=>number|undefined;
    processId?:string;
}
export function own(command: string, args: string[], options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    windowsJobRoot?:string;
    windowsJobReadyMs?:number;
    onIntent?:(processId:string|undefined)=>void;
}): Owned {
    assertNotProtectedProcess(command,args);
    if (/\.(cmd|bat)$/i.test(command))
        throw new DomainError('DIRECT_EXECUTABLE_REQUIRED', 409, 'Use an .exe or node plus the CLI .js entry; shell wrappers are not accepted.');
    const ownership=beginOwnedProcess(command,args);
    let job:WindowsJobSession|undefined;
    try{options.onIntent?.(ownership?.processId);job=options.windowsJobRoot?new WindowsJobSession(options.windowsJobRoot,command,args,options.cwd,options.env??childEnv(),ownership?.processId,options.windowsJobReadyMs):undefined;}
    catch(error){ownership?.notStarted();throw error;}
    const child = spawn(job?.command??command, job?.args??args, { cwd: options.cwd, env: job?.environment??options.env ?? childEnv(), shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const ready=job?.pin()??Promise.resolve();ready.catch(()=>{});
    let ownershipFailed=false;
    const observe=(fn:()=>void)=>{try{fn();}catch{ownershipFailed=true;}};
    child.once('spawn',()=>{if(ownership&&child.pid)observe(()=>ownership.started(child.pid!));});
    let exited = false;
    let closedResolve!: (value: {
        code: number | null;
        signal: NodeJS.Signals | null;
    }) => void;
    const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }>(res => closedResolve = res);
    child.once('error', () => { exited = true; if(!child.pid)observe(()=>ownership?.notStarted());observe(()=>ownership?.exited({code:null,signal:null}));closedResolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => { exited = true; observe(()=>ownership?.exited({code,signal}));closedResolve({ code, signal }); });
    let stopping: Promise<void> | null = null;
    const stop = () => stopping ?? (stopping = (async () => {
        if (!child.pid)
            return;
        const pid = child.pid;
        if (process.platform === 'win32') {
            if (!exited)
                await new Promise<void>(res => { const p = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, env: childEnv() }); p.once('error', () => res()); p.once('close', () => res()); });
        }
        else {
            try {
                process.kill(-pid, 'SIGTERM');
            }
            catch { }
            await Promise.race([closed, new Promise(res => setTimeout(res, 300))]);
            // Also reap surviving group children after a parent exits; this group was created here.
            try {
                process.kill(-pid, 'SIGKILL');
            }
            catch { }
        }
        const done = await Promise.race([closed, new Promise<null>(res => setTimeout(() => res(null), 3000))]);
        if (done === null)
            throw new DomainError('PROCESS_CLEANUP_UNPROVEN', 500);
        if(ownershipFailed)throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500,'OWNED_PROCESS_JOURNAL_UNAVAILABLE');
        if(job){try{
            // A missed startup observation is not a cleanup verdict. After root exit,
            // independently validate the exact persisted marker and current OS Job state.
            await ready.catch(()=>{});const proof=await job.prove();ownership?.proveCleanup(proof);
        }catch(error){
            // The outer code stays PROCESS_CLEANUP_UNPROVEN: no cleanup is proven either way.
            // The inner reason (query timeout vs. job still active vs. marker mismatch) is the
            // only thing that distinguishes an environment stall from a real ownership defect,
            // and swallowing it made two paid dispatches indistinguishable.
            const inner=error as {code?:unknown;message?:unknown};
            const detail=['WINDOWS_JOB_PROOF_UNAVAILABLE',typeof inner?.code==='string'?inner.code:null,typeof inner?.message==='string'?inner.message.slice(0,200):null].filter(Boolean).join(':');
            throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500,detail);
        }}
    })());
    return { child, closed, stop,ready,targetPid:()=>job?job.targetPid:child.pid,processId:ownership?.processId,proveCleanup:proof=>ownership?.proveCleanup(proof) };
}
export async function capture(command: string, args: string[], options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    maxBytes?: number;
    /** Receives decoded stdout chunks while capture retains its bounded final copy. */
    onStdout?: (chunk: string) => void;
    onCleanup?:()=>void;
    windowsJobRoot?:string;
    /** Trusted controller input only; never appears in argv or diagnostic output. */
    input?:string;
    /** Explicit controller packet bound; default remains 64 KiB, maximum 4 MiB. */
    maxInputBytes?:number;
}): Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
}> {
    const inputLimit=options.maxInputBytes??65536;
    if(!Number.isSafeInteger(inputLimit)||inputLimit<1||inputLimit>4194304||options.input!==undefined&&(typeof options.input!=='string'||Buffer.byteLength(options.input)>inputLimit))throw new DomainError('PROCESS_INPUT_LIMIT',400);
    const owned = own(command, args, options);
    let stdout = '', stderr = '', bytes = 0, error: Error | null = null;
    const stdoutDecoder=new StringDecoder('utf8'),stderrDecoder=new StringDecoder('utf8');
    const stop = () => { void owned.stop().catch(e => { error = e; }); };
    const onAbort = () => { error = new DomainError('PROCESS_CANCELLED', 409); stop(); };
    const timer = setTimeout(() => { error = new DomainError('PROCESS_TIMEOUT', 504); stop(); }, options.timeoutMs ?? 60000);
    const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 1000000)) {
        error = new DomainError('PROCESS_OUTPUT_LIMIT');
        stop();
        return;
    } if (stream === 'stdout') {
        const decoded = stdoutDecoder.write(chunk);
        stdout += decoded;
        if (options.onStdout) {
            try { options.onStdout(decoded); }
            catch { error ??= new DomainError('PROCESS_STDOUT_OBSERVER_FAILED', 502); stop(); }
        }
    }
    else
        stderr += stderrDecoder.write(chunk); };
    owned.child.stdout.on('data', (v: Buffer) => append(v, 'stdout'));
    owned.child.stderr.on('data', (v: Buffer) => append(v, 'stderr'));
    owned.child.on('error', () => { error = new DomainError('EXECUTABLE_NOT_AVAILABLE', 409); });
    // Every pipe gets a listener: an 'error' with no handler is a thrown EVENT, not a rejected call,
    // and it terminates the whole local server. A child that dies while we close stdin (EPIPE) is the
    // ordinary way this happens.
    const onPipeFailure = (code: string) => () => { error ??= new DomainError(code, 502); };
    owned.child.stdin.on('error', onPipeFailure('PROCESS_STDIN_CLOSED'));
    owned.child.stdout.on('error', onPipeFailure('PROCESS_STDOUT_FAILED'));
    owned.child.stderr.on('error', onPipeFailure('PROCESS_STDERR_FAILED'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted)
        onAbort();
    owned.child.stdin.end(options.input);
    try {
        const result = await owned.closed;
        await owned.stop();
        options.onCleanup?.();
        if (error)
            throw error;
        stdout+=stdoutDecoder.end();stderr+=stderrDecoder.end();
        return { stdout, stderr, code: result.code };
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}
