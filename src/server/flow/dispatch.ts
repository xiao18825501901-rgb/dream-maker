import { availableParallelism, freemem } from 'node:os';
import { DomainError, id, now,redact } from '../security.js';
import type { Store } from '../store.js';
import type { Mode } from '../../shared/types.js';
import { proposeDispatch, type SchedulingTask } from './scheduler.mjs';
import { withProcessOwnership, processCleanupProven } from './process-ownership.js';
import type { DispatchRecoveryProof } from './ownership-recovery.js';
import {cleanupUncertain} from '../cleanup-uncertainty.js';
import type {DispatchWaitObservation} from '../../shared/dispatch-status.js';

type Kind='planner2'|'executor'|'reviewer'|'verifier'|'route'|'data-runtime';
interface Request {projectId:string|null;runId:string|null;kind:Kind;mode:Mode;signal:AbortSignal;executorRoleId?:string;executorSliceId?:string;executorParallelClass?:'CLASSIC_SERIAL'|'CUSTOM_MULTI';dataFormat?:'SQLITE_IMAGE_V1';purpose?:'DSH_ENGINEERING_ACCEPTANCE'|'CUSTOM_ROLE_PROBE';acceptanceId?:string}
interface DispatchScope {projectId:string|null;runId:string|null;kind:string;acceptanceId?:string}
const flowKey=(r:Request|DispatchScope)=>r.runId??r.acceptanceId!;
const projectKey=(r:Request|DispatchScope)=>r.projectId??'engineering:'+r.acceptanceId;
interface Resources {cpu:number;memoryMiB:number;availableMemoryMiB:number;sampledAt:string;serialLowMemory?:boolean}
export interface DispatchControl {confirmCleanup():void}
interface Ticket {request:Request;task:SchedulingTask;action:(control:DispatchControl)=>Promise<unknown>;resolve:(v:unknown)=>void;reject:(e:unknown)=>void;abort:()=>void;readonly resourceMode?:'EXCLUSIVE_MINIMUM_PROBE'|'EXCLUSIVE_LOW_MEMORY'}
const supervisor=(kind:Kind)=>kind==='planner2'||kind==='reviewer';
export function dispatchResourcesFromSample(cpu:number,availableMemoryMiB:number):Resources {
    if(!Number.isSafeInteger(cpu)||cpu<1||!Number.isSafeInteger(availableMemoryMiB)||availableMemoryMiB<0)throw new DomainError('DISPATCH_RESOURCE_SAMPLE_INVALID',409);
    const serialLowMemory=availableMemoryMiB<3072;
    return {cpu:Math.min(32,cpu),memoryMiB:availableMemoryMiB<1024?0:Math.max(0,availableMemoryMiB-(serialLowMemory?512:1024)),availableMemoryMiB,sampledAt:now(),serialLowMemory};
}
export function measureDispatchResources():Resources {
    return dispatchResourcesFromSample(availableParallelism(),Math.floor(freemem()/1048576));
}
/** Owned by the one Engine. Proposals never grant authority: journal + original bindings precede
 * every callback. No expiry, frontend status or model result can release an uncertain grant. */
export class EngineDispatch {
    private queued=new Map<string,Ticket>();private active=new Map<string,Ticket>();
    private waiting=new Map<string,DispatchWaitObservation>();
    private quarantined=new Map<string,DispatchScope>();
    private counts:Record<string,number>={};private timer:NodeJS.Timeout|undefined;
    private closed=false;private pumping=false;
    private generation=id('dispatch_owner');
    constructor(private store:Store,private binding:{measure?:()=>Resources;isCurrent:(request:Request,stage?:'RESULT')=>boolean}) {
        const settled=new Set(store.db.prepare("SELECT data FROM records WHERE kind IN ('DispatchFinished','DispatchReconciled')").all().map(row=>JSON.parse(String(row.data))).filter(v=>v.cleanupReturned===true).map(v=>v.dispatchId));
        for(const row of store.db.prepare("SELECT project_id,run_id,data FROM records WHERE kind='DispatchGranted'").all()){
            const value=JSON.parse(String(row.data)),scope:DispatchScope={projectId:row.project_id===null?null:String(row.project_id),runId:row.run_id===null?null:String(row.run_id),kind:String(value.kind),...(value.acceptanceId?{acceptanceId:String(value.acceptanceId)}:{})};
            const pid=projectKey(scope);
            this.counts[pid]=(this.counts[pid]??0)+1;
            if(!settled.has(value.dispatchId))this.quarantined.set(value.dispatchId,scope);
        }
    }
    snapshot(){return {generation:this.generation,resources:(this.binding.measure??measureDispatchResources)(),
        active:[...this.active.values()].map(t=>({dispatchId:t.task.id,projectId:t.request.projectId,runId:t.request.runId,kind:t.request.kind,...(t.request.acceptanceId?{acceptanceId:t.request.acceptanceId}:{})})),
        queued:[...this.queued.values()].map(t=>({dispatchId:t.task.id,projectId:t.request.projectId,runId:t.request.runId,kind:t.request.kind,...(t.request.acceptanceId?{acceptanceId:t.request.acceptanceId}:{}),...(this.waiting.has(t.task.id)?{wait:{...this.waiting.get(t.task.id)!}}:{})})),
        quarantined:[...this.quarantined.entries()].map(([dispatchId,scope])=>({dispatchId,...scope})),
        executorSlots:2,externalModelSlots:3,scope:'MEASURED_LOGICAL_DISPATCH_NOT_OS_ISOLATION'};}
    private customProbeGranted(r:Request):boolean {
        return r.purpose==='CUSTOM_ROLE_PROBE'&&!!this.store.db.prepare("SELECT 1 FROM records WHERE kind='DispatchGranted' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.purpose')='CUSTOM_ROLE_PROBE' AND json_extract(data,'$.acceptanceId')=? LIMIT 1").get(r.acceptanceId!);
    }
    run<T>(request:Request,action:(control:DispatchControl)=>Promise<T>):Promise<T> {
        // The caller cannot change the actor while its ticket waits for resources.
        request=Object.freeze({...request});
        if(this.closed)return Promise.reject(new DomainError('DISPATCH_CLOSED',409));
        if(request.executorRoleId!==undefined&&(request.kind!=='executor'||typeof request.executorRoleId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(request.executorRoleId)))return Promise.reject(new DomainError('DISPATCH_EXECUTOR_ROLE_INVALID',409));
        if(request.executorSliceId!==undefined&&(request.kind!=='executor'||typeof request.executorSliceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(request.executorSliceId)))return Promise.reject(new DomainError('DISPATCH_EXECUTOR_SLICE_INVALID',409));
        if(request.executorParallelClass!==undefined&&(request.kind!=='executor'||!['CLASSIC_SERIAL','CUSTOM_MULTI'].includes(request.executorParallelClass)))return Promise.reject(new DomainError('DISPATCH_EXECUTOR_ROLE_INVALID',409));
        const engineering=request.purpose==='DSH_ENGINEERING_ACCEPTANCE';
        const customProbe=request.purpose==='CUSTOM_ROLE_PROBE';
        if(customProbe?(request.projectId!==null||request.runId!==null||request.mode!=='live'||!['planner2','executor','reviewer'].includes(request.kind)||typeof request.acceptanceId!=='string'||!/^custom_probe_[A-Za-z0-9_-]{1,100}$/.test(request.acceptanceId)||request.dataFormat!==undefined||request.executorParallelClass!==undefined||request.executorSliceId!==undefined||request.kind==='executor'&&request.executorRoleId===undefined):engineering?(request.projectId!==null||request.runId!==null||request.mode!=='live'||!['executor','verifier'].includes(request.kind)||typeof request.acceptanceId!=='string'||!/^dsh_acceptance_[a-zA-Z0-9_-]{1,100}$/.test(request.acceptanceId)||request.dataFormat!==undefined||request.executorParallelClass!==undefined||request.executorSliceId!==undefined):
            (typeof request.projectId!=='string'||typeof request.runId!=='string'||request.acceptanceId!==undefined||request.purpose!==undefined))return Promise.reject(new DomainError('DISPATCH_SCOPE_INVALID',409));
        if(customProbe)try{
            if([request.acceptanceId,request.executorRoleId].some(value=>value!==undefined&&redact(value)!==value))return Promise.reject(new DomainError('DISPATCH_SCOPE_INVALID',409));
            if(this.customProbeGranted(request)||[...this.queued.values(),...this.active.values()].some(t=>t.request.purpose==='CUSTOM_ROLE_PROBE'&&t.request.acceptanceId===request.acceptanceId))return Promise.reject(new DomainError('CUSTOM_PROBE_ID_REUSED',409));
        }catch{return Promise.reject(new DomainError('DISPATCH_JOURNAL_UNAVAILABLE',500));}
        if(request.signal.aborted)return Promise.reject(new DomainError('RUN_CANCELLED',409));
        if(request.dataFormat!==undefined&&(request.kind!=='data-runtime'||request.dataFormat!=='SQLITE_IMAGE_V1'||request.mode!=='live'))return Promise.reject(new DomainError('DISPATCH_DATA_FORMAT_INVALID',409));
        if(this.queued.size>=128)return Promise.reject(new DomainError('DISPATCH_QUEUE_FULL',409));
        const customMulti=request.kind==='executor'&&request.executorParallelClass==='CUSTOM_MULTI';
        const schedulingWorkspace=customMulti?projectKey(request)+':executor:'+(request.executorSliceId??request.executorRoleId??'unscoped'):projectKey(request);
        if(customMulti&&[...this.queued.values(),...this.active.values()].some(t=>t.request.kind==='executor'&&t.request.runId===request.runId&&
            (t.request.executorSliceId??t.request.executorRoleId)===(request.executorSliceId??request.executorRoleId)))return Promise.reject(new DomainError('DISPATCH_EXECUTOR_SLICE_REUSED',409));
        // 64MiB roundtrip observed ~254MiB controller RSS plus ~211MiB guest peak. Reserve
        // 1.5GiB for buffers, private tmpfs, the full guest cap and filesystem/cache overhead.
        // Normal mode keeps1GiB host +512MiB concurrent supervision. Owner-authorized
        // low-memory mode uses512MiB host margin, no concurrent heavy task, same demand.
        const dispatchId=id('dispatch'),kind=request.kind,sup=supervisor(kind),memory=request.dataFormat==='SQLITE_IMAGE_V1'?1536:kind==='route'?0:request.mode==='demo'?128:kind==='executor'?1024:512;
        const task:SchedulingTask={id:dispatchId,projectId:projectKey(request),flowId:flowKey(request),workspaceKey:schedulingWorkspace,
            kind:request.mode==='live'&&!['verifier','route','data-runtime'].includes(kind)?'MODEL':'DETERMINISTIC',dependsOn:[],reads:[],writes:kind==='executor'&&!customMulti?['source']:[],exclusiveResources:[],
            demand:{cpu:kind==='route'?0:1,memoryMiB:memory,externalModelSlots:request.mode==='live'&&!['verifier','route','data-runtime'].includes(kind)?1:0,executorSlots:kind==='executor'?(request.executorParallelClass==='CUSTOM_MULTI'?1:2):0,supervisorSlots:sup?1:0,verifierSlots:['verifier','data-runtime'].includes(kind)?1:0,routeSlots:kind==='route'?1:0}};
        return new Promise<T>((resolve,reject)=>{
            const abort=()=>{if(!this.queued.delete(dispatchId))return;request.signal.removeEventListener('abort',abort);
                try{this.record('DispatchDropped',request,{dispatchId,outcome:'RUN_CANCELLED',modelDispatched:false});reject(new DomainError('RUN_CANCELLED',409));}
                catch{reject(new DomainError('DISPATCH_JOURNAL_UNAVAILABLE',500));}this.poke();};
            const ticket:Ticket={request,task,action,resolve:resolve as (value:unknown)=>void,reject,abort};
            try{this.record('DispatchQueued',request,{dispatchId,kind,mode:request.mode,demand:task.demand,schedulingWorkspace,...(request.executorParallelClass?{executorParallelClass:request.executorParallelClass}:{})});}
            catch{reject(new DomainError('DISPATCH_JOURNAL_UNAVAILABLE',500));return;}
            this.queued.set(dispatchId,ticket);request.signal.addEventListener('abort',abort,{once:true});this.poke();
        });
    }
    private record(kind:string,r:Request,value:Record<string,unknown>){
        const data={...value,...(r.acceptanceId?{purpose:r.purpose,acceptanceId:r.acceptanceId}:{}),generation:this.generation,at:now()};
        if(r.purpose==='CUSTOM_ROLE_PROBE'){const bytes=JSON.stringify(data);if(redact(bytes)!==bytes)throw new DomainError('CUSTOM_PROBE_METADATA_REDACTED',409);}
        return this.store.record(kind,r.projectId,r.runId,data);
    }
    private waitObservation(reason:DispatchWaitObservation['reason'],resources?:Resources,gap:number|null=null):DispatchWaitObservation {
        return {scope:'RESOURCE_OBSERVATION_ONLY',reason,sampledAt:resources?.sampledAt??now(),availableMemoryMiB:resources?.availableMemoryMiB??null,estimatedMemoryGapMiB:gap};
    }
    private observeProposal(proposal:ReturnType<typeof proposeDispatch>|null,resources:Resources):void {
        for(const blocked of proposal?.blocked??[]){
            const ticket=this.queued.get(blocked.taskId);if(!ticket)continue;
            const gap=blocked.reason==='CAPACITY_OR_ENTITLEMENT_LIMIT'?Math.max(0,ticket.task.demand.memoryMiB-proposal!.remaining.memoryMiB):0;
            const reason:DispatchWaitObservation['reason']=blocked.reason==='CAPACITY_OR_ENTITLEMENT_LIMIT'?(gap>0?'MEMORY':'CAPACITY'):
                blocked.reason==='RESOURCE_CONFLICT'?'CONFLICT':blocked.reason==='DEPENDENCIES_PENDING'?'DEPENDENCIES':blocked.reason==='NOT_CURRENT_ACTIVE_FLOW'?'CURRENT_FLOW':'RESOURCE_RECHECK';
            this.waiting.set(ticket.task.id,this.waitObservation(reason,resources,gap>0?gap:null));
        }
    }
    poke(){
        if(this.closed||this.pumping)return;
        if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
        this.pumping=true;
        this.waiting.clear();let sampled:Resources|undefined;
        try{
            for(const t of [...this.queued.values()])if(!this.binding.isCurrent(t.request)){
                this.queued.delete(t.task.id);t.request.signal.removeEventListener('abort',t.abort);
                try{this.record('DispatchDropped',t.request,{dispatchId:t.task.id,outcome:'DISPATCH_INPUT_STALE',modelDispatched:false});t.reject(new DomainError('DISPATCH_INPUT_STALE',409));}
                catch{t.reject(new DomainError('DISPATCH_JOURNAL_UNAVAILABLE',500));}
            }
            if(!this.queued.size)return;
            if(this.quarantined.size){for(const ticket of this.queued.values())this.waiting.set(ticket.task.id,this.waitObservation('CLEANUP'));return;}
            // A minimum probe admitted without parallel-supervisor memory owns the
            // whole dispatcher until its process AND route cleanup has settled.
            if([...this.active.values()].some(t=>t.resourceMode==='EXCLUSIVE_MINIMUM_PROBE'||t.resourceMode==='EXCLUSIVE_LOW_MEMORY')){
                for(const ticket of this.queued.values())this.waiting.set(ticket.task.id,this.waitObservation('CAPACITY'));
                return;
            }
            const resources=(this.binding.measure??measureDispatchResources)();
            sampled=resources;
            const low=resources.serialLowMemory===true;
            if(low&&(resources.availableMemoryMiB<1024||[...this.active.values()].some(t=>t.request.kind!=='route'))){
                for(const ticket of this.queued.values())this.waiting.set(ticket.task.id,this.waitObservation('MEMORY',resources,resources.availableMemoryMiB<1024?1024-resources.availableMemoryMiB:null));
                return;
            }
            // Two Custom Executors may share the provider-facing executor capacity.
            // The third model slot remains reserved for one planning/review supervisor.
            const capacity={cpu:resources.cpu,memoryMiB:resources.memoryMiB,externalModelSlots:3,executorSlots:2,supervisorSlots:1,verifierSlots:1,routeSlots:1};
            const active=[...this.active.values()],pending=[...this.queued.values()],byId=new Map([...active,...pending].map(t=>[t.task.id,t]));
            const exclusive=active.length===0&&pending.length===1&&pending[0].request.purpose==='CUSTOM_ROLE_PROBE'&&
                pending[0].request.kind==='executor'&&resources.memoryMiB>=1024&&resources.memoryMiB<1536?pending[0]:undefined;
            const activeFlowByProject=Object.fromEntries([...active,...pending].map(t=>[projectKey(t.request),flowKey(t.request)]));
            const propose=(tickets:Ticket[],running:Ticket[],reserve:Record<string,number>={})=>tickets.length?proposeDispatch({tasks:tickets.map(t=>t.task),activeIds:running.map(t=>t.task.id),capacity,reservedForSupervisors:reserve,activeFlowByProject,projectDispatchCounts:this.counts}):null;
            const sup=propose([...active,...pending.filter(t=>supervisor(t.request.kind))],active);
            const chosenSup=(low?(sup?.taskIds??[]).slice(0,1):(sup?.taskIds??[])).map(key=>byId.get(key)!);
            const running=[...active,...chosenSup];
            // Parallel mode reserves supervision; exclusive low-memory work does not
            // reserve a second simultaneous role. Task demands remain unchanged.
            const supervisorMemory=[...active,...pending].some(t=>t.request.mode==='live')?512:128;
            const reserve:Record<string,number>=running.some(t=>supervisor(t.request.kind))?{}:{cpu:resources.cpu>=2?1:0,memoryMiB:supervisorMemory,externalModelSlots:1};
            // Keep CPU/model spare, the full executor demand and measured OS margin.
            // Only unused concurrent-supervisor memory is waived for this singleton.
            if(exclusive||low)reserve.memoryMiB=0;
            const other=low&&chosenSup.length?null:propose([...running,...pending.filter(t=>!supervisor(t.request.kind))],running,reserve);
            this.observeProposal(sup,resources);this.observeProposal(other,resources);
            const candidates=[...chosenSup,...(other?.taskIds??[]).map(key=>byId.get(key)!)];
            for(const t of low?candidates.slice(0,1):candidates){
                if(t.request.signal.aborted||!this.binding.isCurrent(t.request)){t.abort();continue;}
                const grant=()=>{
                    if(this.customProbeGranted(t.request))throw new DomainError('CUSTOM_PROBE_ID_REUSED',409);
                    if(low&&t.request.kind!=='route')Object.defineProperty(t,'resourceMode',{value:'EXCLUSIVE_LOW_MEMORY',writable:false});
                    else if(t===exclusive)Object.defineProperty(t,'resourceMode',{value:'EXCLUSIVE_MINIMUM_PROBE',writable:false});
                    this.record('DispatchGranted',t.request,{dispatchId:t.task.id,kind:t.request.kind,mode:t.request.mode,resources,cleanupReturned:false,...(t.resourceMode?{resourceMode:t.resourceMode}:{}),...(t.request.executorRoleId?{executorRoleId:t.request.executorRoleId}:{}),...(t.request.executorSliceId?{executorSliceId:t.request.executorSliceId}:{}),...(t.request.executorParallelClass?{executorParallelClass:t.request.executorParallelClass}:{})});
                };
                try{if(t.request.purpose==='CUSTOM_ROLE_PROBE')this.store.tx(grant);else grant();}
                catch(error){
                    if(error instanceof DomainError&&error.code==='CUSTOM_PROBE_ID_REUSED'){this.queued.delete(t.task.id);t.request.signal.removeEventListener('abort',t.abort);t.reject(error);continue;}throw error;
                }
                this.queued.delete(t.task.id);this.active.set(t.task.id,t);const key=projectKey(t.request);this.counts[key]=(this.counts[key]??0)+1;
                void this.execute(t);
            }
        }catch(error){
            // Resource measurements can shrink below active reservations; keep existing grants, start
            // nothing else and remeasure. Invalid journal/contract data also fails closed.
            if(!(error&&typeof error==='object'&&['ACTIVE_RESOURCE_OVERCOMMIT','INSUFFICIENT_SUPERVISOR_RESERVE'].includes(String((error as {code?:unknown}).code)))){
                for(const t of this.queued.values()){t.request.signal.removeEventListener('abort',t.abort);t.reject(new DomainError('DISPATCH_ADMISSION_UNAVAILABLE',409));}this.queued.clear();
            }else for(const ticket of this.queued.values())this.waiting.set(ticket.task.id,this.waitObservation('RESOURCE_RECHECK',sampled));
        }finally{this.pumping=false;if(this.queued.size&&!this.closed&&!this.quarantined.size)this.timer=setTimeout(()=>this.poke(),1000);}
    }
    private async execute(t:Ticket){
        let outcome='COMPLETED',failure:unknown,result:unknown,cleanupReturned=false;
        const ownership={store:this.store,projectId:t.request.projectId,runId:t.request.runId,dispatchId:t.task.id,generation:this.generation,mode:t.request.mode,...(t.request.acceptanceId?{acceptanceId:t.request.acceptanceId}:{})};
        try{
            if(t.request.signal.aborted){cleanupReturned=true;throw t.request.signal.reason??new DomainError('RUN_CANCELLED',409);}
            result=await withProcessOwnership(ownership,()=>t.action({confirmCleanup:()=>{cleanupReturned=true;}}));
            if(t.request.signal.aborted)throw t.request.signal.reason??new DomainError('RUN_CANCELLED',409);
            if(!cleanupReturned)throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);
            if(!this.binding.isCurrent(t.request,'RESULT'))throw new DomainError('DISPATCH_RESULT_FENCED',409);
        }
        catch(error){failure=error;if(cleanupUncertain(error))cleanupReturned=false;const code=error&&typeof error==='object'?(error as {code?:unknown}).code:null;outcome=typeof code==='string'&&/^[A-Z_]{1,100}$/.test(code)?code:'DISPATCH_FAILED';if(!cleanupReturned&&outcome!=='PROCESS_CLEANUP_UNPROVEN')failure=new DomainError('PROCESS_CLEANUP_UNPROVEN',500,outcome);}
        if(!processCleanupProven(ownership)){cleanupReturned=false;failure=new DomainError('PROCESS_CLEANUP_UNPROVEN',500);outcome='PROCESS_CLEANUP_UNPROVEN';}
        try{this.record('DispatchFinished',t.request,{dispatchId:t.task.id,outcome,cleanupReturned,...(t.resourceMode?{resourceMode:t.resourceMode}:{})});}
        catch{cleanupReturned=false;failure=new DomainError('PROCESS_CLEANUP_UNPROVEN',500,'DISPATCH_JOURNAL_UNAVAILABLE');}
        if(!cleanupReturned)this.quarantined.set(t.task.id,{projectId:t.request.projectId,runId:t.request.runId,kind:t.request.kind,...(t.request.acceptanceId?{acceptanceId:t.request.acceptanceId}:{})});
        this.active.delete(t.task.id);t.request.signal.removeEventListener('abort',t.abort);
        if(failure)t.reject(failure);else t.resolve(result);this.poke();
    }
    /** The older host.pid-only proof does not cover a supervisor CLI or WSL verifier. Until a
     * dispatch-bound OS process proof is attached, recovery must refuse before changing the lease. */
    assertReconciliationReady(runId:string){if([...this.quarantined.values()].some(scope=>flowKey(scope)===runId))throw new DomainError('DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED',409);}
    async reconcileOwned(runId:string,check:(dispatchId:string,scope:DispatchScope)=>Promise<DispatchRecoveryProof>){
        if([...this.active.values()].some(t=>flowKey(t.request)===runId))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const targets=[...this.quarantined.entries()].filter(([,scope])=>flowKey(scope)===runId),proofs:DispatchRecoveryProof[]=[];
        for(const [dispatchId,scope]of targets){const proof=await check(dispatchId,scope);if(proof.schema!=='dream-maker.dispatch-recovery.v1'||proof.dispatchId!==dispatchId||proof.proven!==true||!/^[a-f0-9]{64}$/.test(proof.basisSha256))throw new DomainError('DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED',409);proofs.push(proof);}
        this.store.tx(()=>{for(let i=0;i<targets.length;i++){const [dispatchId,scope]=targets[i];this.store.record('DispatchReconciled',scope.projectId,scope.runId,{dispatchId,cleanupReturned:true,proof:proofs[i],generation:this.generation,at:now(),...(scope.acceptanceId?{acceptanceId:scope.acceptanceId}:{})});}});
        for(const [dispatchId]of targets)this.quarantined.delete(dispatchId);
    }
    hasUncertain(runId:string){return [...this.quarantined.values()].some(scope=>flowKey(scope)===runId);}
    pauseQueued(runId:string){
        for(const ticket of [...this.queued.values()]){
            if(ticket.request.runId!==runId)continue;
            this.queued.delete(ticket.task.id);ticket.request.signal.removeEventListener('abort',ticket.abort);
            try{this.record('DispatchDropped',ticket.request,{dispatchId:ticket.task.id,outcome:'DISPATCH_PAUSED',modelDispatched:false});ticket.reject(new DomainError('DISPATCH_PAUSED',409));}
            catch{ticket.reject(new DomainError('DISPATCH_JOURNAL_UNAVAILABLE',500));}
        }
    }
    hasActiveRoute(runId:string){return [...this.active.values()].some(t=>t.request.runId===runId&&t.request.kind==='route');}
    releaseAfterOwnershipProof(runId:string){this.assertReconciliationReady(runId);this.poke();}
    async close(){this.closed=true;if(this.timer)clearTimeout(this.timer);for(const t of this.queued.values()){t.request.signal.removeEventListener('abort',t.abort);t.reject(new DomainError('DISPATCH_CLOSED',409));}this.queued.clear();this.waiting.clear();}
}
