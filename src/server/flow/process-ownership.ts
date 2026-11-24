import { AsyncLocalStorage } from 'node:async_hooks';
import type { Store } from '../store.js';
import { hash,id,now } from '../security.js';
import { probeProcessIdentity } from '../server-lock.js';
export interface ProcessOwnershipScope {store:Store;projectId:string|null;runId:string|null;dispatchId:string;generation:string;mode?:'demo'|'live';acceptanceId?:string}
export interface ProcessCleanupProof {kind:'TRUSTED_WSL_CODEX_GROUP'|'TRUSTED_WSL_SANDBOX'|'TRUSTED_WSL_SANDBOX_ABSENCE'|'TRUSTED_WINDOWS_JOB'|'TRUSTED_WSL_SQLITE_RETIREMENT';receiptSha256:string;scopeId:string}
const scope=new AsyncLocalStorage<ProcessOwnershipScope|undefined>();
const pending=new WeakMap<ProcessOwnershipScope,Set<string>>();
export function withProcessOwnership<T>(binding:ProcessOwnershipScope,action:()=>T):T {return scope.run(binding,action);}
export function currentProcessOwnership():ProcessOwnershipScope|undefined{return scope.getStore();}
/** Fixed read-only OS inspectors cannot create model turns or execute generated code. Their own
 * transport must still close; a failed inspector keeps its enclosing execution unproven. */
export function inspectOutsideExecutionScope<T>(action:()=>T):T{return scope.run(undefined,action);}
export function processCleanupProven(binding:ProcessOwnershipScope):boolean{return binding.mode==='demo'||!(pending.get(binding)?.size);}
/** Intent is durable before spawning. Root closure is useful evidence but cannot by itself
 * attest a WSL process group, namespace or escaped descendants. No command/env values are logged. */
export function beginOwnedProcess(command:string,args:string[]){
    const binding=scope.getStore();if(!binding)return undefined;
    const processId=id('owned_process');
    const record=(kind:string,value:Record<string,unknown>)=>binding.store.record(kind,binding.projectId,binding.runId,{processId,dispatchId:binding.dispatchId,generation:binding.generation,...(binding.acceptanceId?{acceptanceId:binding.acceptanceId}:{}),...value,at:now()});
    record('OwnedProcessIntent',{commandSha256:hash(command),argvSha256:hash(args),platform:process.platform});
    let processes=pending.get(binding);if(!processes){processes=new Set();pending.set(binding,processes);}processes.add(processId);
    return {processId,
        notStarted(){record('OwnedProcessNotLaunched',{noProcessCreated:true});processes.delete(processId);},
        proveCleanup(proof:ProcessCleanupProof){
            if(!/^[a-f0-9]{64}$/.test(proof.receiptSha256)||!proof.scopeId)throw new Error('PROCESS_CLEANUP_RECEIPT_REQUIRED');
            record('OwnedProcessCleanup',{...proof,cleanupReturned:true});processes.delete(processId);
        },
        started(pid:number){let identity:string|null=null;if(binding.mode!=='demo')try{identity=probeProcessIdentity(pid);}catch{/* A short child can exit between spawn and the OS query. This is unknown, not a journal failure. */}record('OwnedProcessRootStarted',{pid,identity,identityState:identity?'OS_START_IDENTITY':binding.mode==='demo'?'NOT_CAPTURED_DEMO_ONLY':'NOT_CAPTURED',descendantsProven:false});},
        exited(value:{code:number|null;signal:NodeJS.Signals|null}){record('OwnedProcessRootExited',{...value,rootClosed:true,descendantsProven:false});}
    };
}
