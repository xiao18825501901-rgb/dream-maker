import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {capture} from './process.js';
import {inspectOutsideExecutionScope} from './flow/process-ownership.js';
import {DomainError,hash,object,childEnv} from './security.js';

export interface ResourceExpected {jobId:string;sourceHash:string;workerHash:string;resourceHelperHash:string}
export const resourceImplementationFiles=['dist/server/sandbox-resource.js','scripts/isolation/wsl-resource-context.py','scripts/isolation/wsl-worker.py'] as const;
export function requireResourceProcessClosure(rows:ReadonlyArray<{id:string;kind:string;data:Record<string,unknown>}>,processId:string,generation:string){
    const started=rows.filter(r=>r.kind==='OwnedProcessRootStarted'&&r.data.processId===processId),closed=rows.filter(r=>r.kind==='OwnedProcessRootExited'&&r.data.processId===processId);
    if(!generation||started.length!==1||closed.length!==1||started[0].data.generation!==generation||closed[0].data.generation!==generation||
        rows.indexOf(started[0])>=rows.indexOf(closed[0])||closed[0].data.rootClosed!==true||closed[0].data.code!==0||closed[0].data.signal!==null||
        !Number.isSafeInteger(started[0].data.pid)||Number(started[0].data.pid)<1||typeof started[0].data.identity!=='string'||!/^win32:[1-9][0-9]{0,19}$/.test(started[0].data.identity))
        throw new DomainError('SANDBOX_RESOURCE_CLEANUP_UNPROVEN',502);
    return{pid:Number(started[0].data.pid),identity:started[0].data.identity,startRecordId:started[0].id,closeRecordId:closed[0].id};
}
export async function readSavedResourceJob(root:string,expected:ResourceExpected):Promise<{result:unknown;observation:unknown}>{
    try{
        if(!/^wsl_job_[a-z0-9_-]{1,80}$/.test(expected.jobId))throw new Error('id');
        const helper=readFileSync(resolve(root,'scripts/isolation/wsl-resource-context.py'),'utf8');
        if(hash(helper)!==expected.resourceHelperHash)throw new Error('source');
        const script=helper+"\nprint(json.dumps(read_resource_job(sys.argv[1]),ensure_ascii=False,separators=(',',':')))";
        const out=await inspectOutsideExecutionScope(()=>capture('wsl.exe',['-d','DreamMaker-Acceptance-F-20261101-R2','--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-c',script,expected.jobId],{cwd:root,env:childEnv(),timeoutMs:15000,maxBytes:2_500_000}));
        if(out.code!==0)throw new Error('unavailable');
        const v=object(JSON.parse(out.stdout));return {result:v.result,observation:v.observation};
    }catch{throw new DomainError('SANDBOX_RESOURCE_CLEANUP_UNPROVEN',502);}
}
/** Called only on a fresh read by the fixed Linux helper, after the owned process closes. */
export function checkResourceObservation(raw:unknown,expected:ResourceExpected,result:unknown):Record<string,unknown>{
    try{
        const o=object(raw),v=object(o.final),c=object(v.cleanup),seen=object(o.observed),isolation=object(v.isolation),before=object(isolation.before),after=object(isolation.after);
        const identity=(value:unknown)=>{const p=object(value);return Number.isSafeInteger(p.pid)&&Number(p.pid)>1&&typeof p.startTicks==='string'&&/^[1-9][0-9]{0,19}$/.test(p.startTicks);};
        const ns=(v:unknown,name:string)=>typeof v==='string'&&new RegExp('^'+name+':\\[[0-9]+\\]$').test(v);
        if(v.schema!=='dream-maker.wsl-resource-final.v1'||v.environment!=='DreamMaker-Acceptance-F-20261101-R2'||
            Object.entries(expected).some(([k,value])=>v[k]!==value)||v.scopeId!=='dm_scope_'+expected.jobId||v.scopePath!=='/sys/fs/cgroup/dm_scope_'+expected.jobId||
            typeof v.bootId!=='string'||!/^[a-f0-9-]{36}$/.test(v.bootId)||!identity(v.parent)||!identity(v.child)||v.workerExitCode!==0||v.resultHash!==hash(result)||
            !['mnt','cgroup'].every(k=>ns(before[k],k)&&ns(after[k],k)&&before[k]!==after[k])||isolation.supervisorCgroup!=='0::/supervisor'||isolation.workerViewInitiallyEmpty!==true||isolation.controlFdsClosed!==true||
            c.scopeRemoved!==true||c.rootRestored!==true||!Array.isArray(c.remainingPids)||c.remainingPids.length||
            seen.scopeAbsent!==true||seen.parentAbsent!==true||seen.childAbsent!==true)throw new Error('unproven');
        return v;
    }catch{throw new DomainError('SANDBOX_RESOURCE_CLEANUP_UNPROVEN',502);}
}

/** Pins are embedded in the trusted command, independently of the transport metadata. */
export function sandboxBootstrap(workerHash:string,helperHash:string):string {
    if(![workerHash,helperHash].every(v=>/^[a-f0-9]{64}$/.test(v)))throw new DomainError('SANDBOX_PROGRAM_PIN_INVALID',409);
    return `import os,json,hashlib
line=bytearray()
transport_tail=b''
while True:
    part=os.read(0,65536)
    if not part: raise RuntimeError('SANDBOX_INPUT_TRUNCATED')
    end=part.find(b'\\n')
    line.extend(part if end<0 else part[:end])
    if len(line)>40000000: raise RuntimeError('SANDBOX_INPUT_METADATA_LIMIT')
    if end>=0:
        transport_tail=part[end+1:]
        break
def unique(pairs):
    value={}
    for key,item in pairs:
        if key in value: raise RuntimeError('SANDBOX_DUPLICATE_METADATA_KEY')
        value[key]=item
    return value
payload=json.loads(line,object_pairs_hook=unique)
del line
worker=payload.pop('worker')
helper=payload.pop('resourceHelper')
if not isinstance(worker,str) or not isinstance(helper,str) or hashlib.sha256(worker.encode()).hexdigest()!='${workerHash}' or payload['workerHash']!='${workerHash}' or hashlib.sha256(helper.encode()).hexdigest()!='${helperHash}' or payload['resourceHelperHash']!='${helperHash}':
    raise RuntimeError('SANDBOX_PROGRAM_PIN_MISMATCH')
trusted={'__name__':'dm_resource_context'}
exec(compile(helper,'<controller-owned-resource-context>','exec'),trusted)
trusted['run_resource_context'](payload,worker,'${helperHash}',transport_tail)
`;
}
