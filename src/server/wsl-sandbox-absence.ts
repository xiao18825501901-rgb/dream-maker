import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {capture} from './process.js';
import {inspectOutsideExecutionScope} from './flow/process-ownership.js';
import {DomainError,childEnv,hash,object} from './security.js';

/**
 * A supervisor that fails before writing its resource intent never created a
 * job directory, cgroup or worker process. The intent receipt is written before
 * any fork inside the fixed helper, so its absence is durable evidence rather
 * than an assumption. This probe is read-only and never retries a model or a
 * sandbox turn.
 */
export const WSL_SANDBOX_ABSENCE_SCHEMA='dream-maker.wsl-sandbox-absence.v1';
const SCRIPT=`import json,os,pathlib,re,sys
job=sys.argv[1]
assert re.fullmatch(r'wsl_job_[a-z0-9_-]{1,80}',job)
base=pathlib.Path('/opt/dream-maker-acceptance-20261011')
name='dm_scope_'+job
rec=base/'resource-contexts'
job_dir=base/job
cgroup=pathlib.Path('/sys/fs/cgroup')/name
hit=False
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        body=(entry/'cgroup').read_text()
    except Exception:
        continue
    if name in body:
        hit=True
        break
print(json.dumps({'schema':'dream-maker.wsl-sandbox-absence.v1','jobId':job,
  'jobDirAbsent':not job_dir.exists(),'intentAbsent':not (rec/(name+'.intent.json')).exists(),
  'finalAbsent':not (rec/(name+'.final.json')).exists(),'cgroupAbsent':not cgroup.exists(),
  'processAbsent':not hit},separators=(',',':')))`;

export interface SandboxAbsence {
    schema:typeof WSL_SANDBOX_ABSENCE_SCHEMA;jobId:string;
    jobDirAbsent:true;intentAbsent:true;finalAbsent:true;cgroupAbsent:true;processAbsent:true;
}
export function validateSandboxAbsence(raw:unknown,jobId:string):SandboxAbsence{
    try{
        const v=object(raw);
        if(v.schema!==WSL_SANDBOX_ABSENCE_SCHEMA||v.jobId!==jobId||
            v.jobDirAbsent!==true||v.intentAbsent!==true||v.finalAbsent!==true||
            v.cgroupAbsent!==true||v.processAbsent!==true)throw new Error('unproven');
        return v as unknown as SandboxAbsence;
    }catch{throw new DomainError('SANDBOX_RESOURCE_CLEANUP_UNPROVEN',502);}
}
/** Fresh read-only observation of the fixed distro. A changed helper or an
 * unreadable guest keeps the ownership uncertain. */
export async function probeSandboxAbsence(root:string,jobId:string,expectedHelperHash:string,environment:string):Promise<SandboxAbsence>{
    try{
        if(!/^wsl_job_[a-z0-9_-]{1,80}$/.test(jobId)||!/^DreamMaker-Acceptance-[A-Za-z0-9-]{1,80}$/.test(environment))throw new Error('input');
        const helper=readFileSync(resolve(root,'scripts/isolation/wsl-resource-context.py'),'utf8');
        if(hash(helper)!==expectedHelperHash)throw new Error('source');
        const out=await inspectOutsideExecutionScope(()=>capture('wsl.exe',['-d',environment,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-c',SCRIPT,jobId],{cwd:root,env:childEnv(),timeoutMs:15000,maxBytes:200000}));
        if(out.code!==0)throw new Error('unavailable');
        return validateSandboxAbsence(JSON.parse(out.stdout),jobId);
    }catch(error){
        if(error instanceof DomainError)throw error;
        throw new DomainError('SANDBOX_RESOURCE_CLEANUP_UNPROVEN',502);
    }
}
