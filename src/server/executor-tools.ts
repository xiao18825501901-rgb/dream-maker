import { readFileSync, existsSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';
import type { Config, Role } from '../shared/types.js';
import { DomainError, hash, id, object, text, hasSecret, within } from './security.js';
import { files, treeHash } from './workspace.js';
import { validateSandboxCommand } from './wsl-sandbox.js';
import {boundExecutorAssignment,executorMayWrite,assertExecutorWriteRoom,executorCheckpointSeed,validateWritePaths} from './flow/executor-slices.js';
import {readPrework} from './prework/runtime.js';
import {runConfigurationFingerprint} from './flow-configuration.js';

export interface FileBinding {modulePath:string;dependencies:{path:string;sha256:string}[];readPaths:string[];writePaths:string[]}
interface NativeFiles {resolve(path:string,write?:boolean):Promise<string>;read(path:string):Promise<string>;search(needle:string):Promise<unknown>}
interface Kernel {run(workspace:string,command:unknown,options:{signal:AbortSignal}):Promise<unknown>}
const allowed=['desk_read','desk_search','desk_write','desk_edit','desk_run'];
/** Tool-call budget for one run, plus a fresh allowance per substantive repair (see dispatch). */
export const TOOL_BASE_CALLS=128;
export const PER_REPAIR_CALLS=32;
// A plan's tool need scales with how many tasks it declares. run_14c86e9a9ad51c0ff495 was planned as eight
// finer-grained tasks and had already spent all 128 calls at six of them (every turn verifies with desk_run, so
// a task costs 15-22 calls), which would have starved the last two. Forty calls per planned task keeps the
// bound proportional to the work the planner asked for and still bounded; repairs keep their own allowance on
// top, and the operator request ceiling remains the money guard.
export const PER_TASK_CALLS=40;
/** New isolated task copies must fit the frozen eight-call task contract. */
export const SLICE_TOOL_CALLS=8;
const argumentKeys:Record<string,string[]>={desk_read:['path'],desk_search:['text'],desk_write:['path','content','expected_sha'],desk_edit:['path','old_text','new_text','expected_sha'],desk_run:['runtime','entry','args','stdin']};
/**
 * Select one exact source match. The second pass only repairs the redundant
 * backslash that models sometimes copy from JSON-encoded desk_read output.
 * Exact source bytes always win, and normalized text must still be unique.
 */
export function editUniqueText(content:string,oldText:string,newText:string):string|undefined{
    const candidates=[{oldText,newText}];
    if(oldText.includes('\\"'))candidates.push({oldText:oldText.replaceAll('\\"','"'),newText:newText.replaceAll('\\"','"')});
    for(const candidate of candidates)if(content.split(candidate.oldText).length===2)
        return content.replace(candidate.oldText,()=>candidate.newText);
    return undefined;
}
export async function createBoundedFileTools(binding:FileBinding,workspace:string,granted?:readonly string[]):Promise<NativeFiles> {
    const policy=structuredClone(binding);
    for(const item of policy.dependencies)if(hash(readFileSync(item.path))!==item.sha256)throw new DomainError('NATIVE_FILE_BINDING_CHANGED',409);
    if(!policy.dependencies.some(f=>resolve(f.path)===resolve(policy.modulePath)))throw new DomainError('NATIVE_FILE_MODULE_NOT_AUDITED',409);
    const ioPath=resolve(dirname(policy.modulePath),'../core/io.js');
    if(!policy.dependencies.some(f=>resolve(f.path)===ioPath))throw new DomainError('NATIVE_FILE_DEPENDENCY_NOT_AUDITED',409);
    const native=await import(pathToFileURL(policy.modulePath).href);
    if(typeof native.BoundedFileTools!=='function')throw new DomainError('NATIVE_FILE_EXPORT_INVALID',409);
    // The approved plan declares exactly which files this run may touch, and the workspace root stays the hard
    // boundary (safePath rejects traversal and absolute paths). A fixed operator list could never cover filenames
    // a planner invents, so every Custom run failed as EXECUTOR_FILE_POLICY_DENIED. The grant is the union of the
    // declared write paths, minus the directories the native tool never exposes.
    const grant=granted&&granted.length?[...new Set(granted.map(p=>p.replace(/\/$/,'')).filter(p=>p&&!p.startsWith('/')&&!p.includes('..')))]:undefined;
    return new native.BoundedFileTools({version:1,root:workspace,readPaths:grant??policy.readPaths,writePaths:grant??policy.writePaths,maxFileBytes:2000000,maxSearchFiles:2000}) as NativeFiles;
}
export async function createExecutorTools(store:Store,config:()=>Config,runId:string,binding:FileBinding,kernel:Kernel,sliceId?:string) {
    const initial=store.run(runId),fingerprint=runConfigurationFingerprint(initial,config());
    // A slice wave gives every executor turn its own copy of the tree, and the merge only reads that copy. When
    // no slice id arrives the tools used to fall back to the run workspace without saying so, so the deliverable
    // landed where the merge never looks and the wave then reported EXECUTOR_DECLARED_FILES_MISSING. That silent
    // fallback cost many misdiagnosed runs, so it is now a named error whenever the run really does have a wave.
    if(!sliceId){
        let waveBound=false;
        try{waveBound=store.records(initial.projectId,'ExecutorWavePrepared').some(row=>{
            try{const data=JSON.parse(String((row as {data?:unknown}).data??'{}'));return data.runId===runId||data.run===runId;}catch{return false;}});}catch{waveBound=false;}
        if(waveBound)throw new DomainError('EXECUTOR_SLICE_UNBOUND',409);
}
    const assignment=sliceId?boundExecutorAssignment(store,runId,sliceId):undefined,workspace=assignment?.workspace??initial.workspace;
    // Grant exactly what the approved plan declares for this run; the workspace root remains the boundary.
    const declared=[...new Set(initial.tasks.flatMap(task=>task.writePaths===undefined?[]:validateWritePaths(task.writePaths).map(p=>p.replace(/\/$/,''))))];
    // Single choke point for every executor tool surface. The wave protocol needs the slice copy here; when this
    // resolves to the canonical tree the merge answers EXTERNAL_WORKSPACE_CHANGE and the delivery stops there.
    process.stderr.write('EXECUTOR_TOOLS_WORKSPACE '+JSON.stringify({sliceId:sliceId??null,bound:!!assignment,workspace,canonical:initial.workspace})+'\n');
    const nativeFiles=await createBoundedFileTools(binding,workspace,declared);
    // A plan is not a grant of native file access. Check every declared deliverable before
    // exposing the tools, so an inaccessible later task cannot burn paid model turns.
    for(const scope of initial.tasks.flatMap(task=>task.writePaths===undefined?[]:validateWritePaths(task.writePaths))){
        try{await nativeFiles.resolve(scope.replace(/\/$/,''),true);}
        catch(error){
            if(error instanceof Error&&'code' in error&&error.code==='TOOL_SCOPE')
                throw new DomainError('EXECUTOR_FILE_POLICY_DENIED',409,'方案要求写入的文件尚未获得本机权限；请先核对交付文件和允许范围。');
            throw error;
        }
    }
    const stageRoot=resolve(dirname(workspace),'.dm-tool-stages',runId,sliceId??'canonical');
    let expectedTree=treeHash(workspace),active=false,effectChanged=false,recoveryRequired=false;
    const observed=new Map<string,string>();
    function checkJournal(){
        const intents=store.records(initial.projectId,'ToolIntent').filter(r=>r.runId===runId);
        const results=store.records(initial.projectId,'ToolResult').filter(r=>r.runId===runId);
        const completed=new Set(results.filter(r=>['COMPLETE','FAILED_NO_EFFECT'].includes(r.data.status)).map(r=>r.data.intentId));
        if(results.some(r=>r.data.status==='UNKNOWN_EFFECT')||intents.some(r=>!completed.has(r.id)))throw new DomainError('TOOL_RECOVERY_REQUIRED',409);
        const last=sliceId?intents.filter(r=>r.data.sliceId===sliceId).at(-1):store.records(initial.projectId).filter(r=>r.runId===runId&&(r.kind==='ExecutorMergeApplied'||r.kind==='ToolIntent'&&!r.data.sliceId)).at(-1);
        if(last){
            const receipt=last.kind==='ToolIntent'?results.filter(r=>r.data.intentId===last.id).at(-1):undefined;
            const checkpoint=receipt?.data.sourceHash??last.data.sourceHash;
            if(typeof checkpoint!=='string'||!/^[a-f0-9]{64}$/.test(checkpoint))throw new DomainError('TOOL_JOURNAL_INVALID',409);
            if(checkpoint!==expectedTree)throw new DomainError('EXTERNAL_WORKSPACE_CHANGE',409);
        }else if(sliceId){
            const seed=executorCheckpointSeed(store,runId,sliceId);
            if(seed!==undefined&&seed!==expectedTree)throw new DomainError('EXECUTOR_CHECKPOINT_SOURCE_CHANGED',409);
        }
        return intents.length;
    }
    checkJournal();
    function authority(role:Role,signal:AbortSignal){
        if(role!=='executor')throw new DomainError('EXECUTOR_ROLE_REQUIRED',403);
        if(signal.aborted)throw new DomainError('RUN_CANCELLED',409);
        const r=store.run(runId),p=store.project(r.projectId),s=store.spec(r.specId);
        if(!['IMPLEMENTING','REPAIRING'].includes(r.state))throw new DomainError('EXECUTOR_PHASE_NOT_ACTIVE',409);
        if(!store.owns(r.projectId,r.id))throw new DomainError('WORKSPACE_LEASE_LOST',409);
        if(r.configFingerprint!==fingerprint||runConfigurationFingerprint(r,config())!==fingerprint)throw new DomainError('RUN_CONFIG_CHANGED',409);
        if(sliceId&&boundExecutorAssignment(store,runId,sliceId).workspace!==workspace)throw new DomainError('EXECUTOR_SLICE_BINDING_CHANGED',409);
        if(p.specId!==r.specId||s.stale||s.hash!==r.specHash)throw new DomainError('RUN_SPEC_STALE',409);
        if(!store.approved(r.projectId,r.specHash,'SPEC')||!store.approved(r.projectId,r.specHash,'BUILD'))throw new DomainError('EXECUTOR_APPROVAL_REQUIRED',403);
        if(treeHash(workspace)!==expectedTree)throw new DomainError('EXTERNAL_WORKSPACE_CHANGE',409);
        return r;
    }
    async function read(path:string){
        let content:string;
        try{content=await nativeFiles.read(path);}
        catch(error){
            // The audited reader checks its read allowlist before reaching lstat/readFile.
            // Do not borrow the write allowlist to reveal a missing, unreadable path.
            if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;
            observed.set(path,'');return{exists:false,content:'',sha256:''};
        }
        if(hasSecret(content))throw new DomainError('SECRET_IN_TOOL_OUTPUT',403);
        const sha256=hash(content);observed.set(path,sha256);return{content,sha256};
    }
    async function write(path:string,content:string,expected:string,role:Role,signal:AbortSignal){
        if(assignment&&!executorMayWrite(assignment.writePaths,path))throw new DomainError('EXECUTOR_SLICE_WRITE_DENIED',403);
        if(typeof content!=='string'||Buffer.byteLength(content)>2000000)throw new DomainError('TOOL_FILE_LIMIT',413);
        if(hasSecret(content))throw new DomainError('SECRET_IN_TOOL_INPUT',403);
        const file=await nativeFiles.resolve(path,true);
        if(sliceId)assertExecutorWriteRoom(store,runId,sliceId,Buffer.byteLength(content));
        if(expected&&observed.get(path)!==expected)throw new DomainError('READ_BEFORE_WRITE_REQUIRED',409);
        await mkdir(dirname(file),{recursive:true});await nativeFiles.resolve(path,true);
        await mkdir(stageRoot,{recursive:true});
        const temp=within(stageRoot,id('dm_stage')),fd=await open(temp,'wx',0o600);
        try{
            await fd.writeFile(content);await fd.sync();await fd.close();
            // No async operation inside the commit fence. SQLite serializes lease/approval changes.
            store.tx(()=>{
                authority(role,signal);
                const old=existsSync(file)?readFileSync(file):null;
                if((old?hash(old):'')!==expected)throw new DomainError('STALE_TOOL_WRITE',409);
                if(old&&(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink()||lstatSync(file).nlink!==1))throw new DomainError('TOOL_SPECIAL_FILE_DENIED',403);
                const catalog=files(workspace),previous=catalog.find(f=>f.path===path)?.bytes??0;
                if(catalog.reduce((n,f)=>n+f.bytes,0)-previous+Buffer.byteLength(content)>20000000||(!old&&catalog.length>=2000))throw new DomainError('WORKSPACE_LIMIT',413);
                renameSync(temp,file);effectChanged=true;expectedTree=treeHash(workspace);
            });
            const sha256=hash(content);observed.set(path,sha256);return{sha256,sourceHash:expectedTree};
        }finally{await fd.close().catch(()=>{});if(existsSync(temp))unlinkSync(temp);}
    }
    return {async dispatch(role:Role,name:string,raw:unknown,signal:AbortSignal):Promise<Record<string,unknown>>{
        if(recoveryRequired)throw new DomainError('TOOL_RECOVERY_REQUIRED',409);
        if(!allowed.includes(name))throw new DomainError('EXECUTOR_TOOL_DENIED',403);
        if(active)throw new DomainError('ONE_EXECUTOR_TOOL_ONLY',409);
        const args=object(raw),keys=argumentKeys[name];
        if(Object.keys(args).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(args,k)))throw new DomainError('INVALID_TOOL_ARGUMENTS');
        if(hasSecret(JSON.stringify(args)))throw new DomainError('SECRET_IN_TOOL_INPUT',403);
        const r=authority(role,signal),prework=readPrework(store,r),packages=assignment?prework.workPackages.filter(w=>w.taskId===assignment.taskId):prework.workPackages;
        const withinScope=(path:unknown,scopes:string[])=>typeof path==='string'&&scopes.some(s=>s.endsWith('/')?path.startsWith(s):path===s);
        const scopes=packages.flatMap(w=>name==='desk_write'||name==='desk_edit'?w.writePaths:w.readPaths);
        if(name!=='desk_search'&&!withinScope(name==='desk_run'?args.entry:args.path,scopes))throw new DomainError('PREWORK_SCOPE_INVALID',403);
        if(name==='desk_run'&&files(workspace).some(file=>!withinScope(file.path,scopes)))throw new DomainError('PREWORK_SCOPE_INVALID',403);
        const intentId=store.tx(()=>{
            // A repair turn needs its own allowance. The bound used to be a flat 128 calls per run, so an
            // 8-task run spent all 128 while implementing and the repair turn could not even read the file:
            // run_7ed78beaa126a811a1f3 answered every tool call with EXECUTOR_TOOL_LIMIT, made no change, and
            // was blocked as REPEATED_FAILURE_NO_PROGRESS with the fix it needed still undone. Each substantive
            // repair adds PER_REPAIR_CALLS; the base bound is unchanged for a run that never repairs.
            const current=store.run(runId),planned=Array.isArray(current.tasks)?current.tasks.length:0;
            if(checkJournal()>=Math.max(TOOL_BASE_CALLS,PER_TASK_CALLS*planned)+PER_REPAIR_CALLS*(current.repairCount??0))throw new DomainError('EXECUTOR_TOOL_LIMIT',409);
            // Persisted slice identity owns this ceiling: rebuilding the controller cannot
            // replenish it, and an over-limit call creates neither an Intent nor a side effect.
            if(sliceId&&store.records(r.projectId,'ToolIntent').filter(row=>row.runId===runId&&row.data.sliceId===sliceId).length>=SLICE_TOOL_CALLS)
                throw new DomainError('EXECUTOR_TASK_TOOL_LIMIT',409);
            return store.record('ToolIntent',r.projectId,r.id,{tool:name,specHash:r.specHash,sourceHash:expectedTree,...(sliceId?{sliceId}:{}),requestHash:hash(args),at:new Date().toISOString()});
        });
        active=true;effectChanged=false;
        try{
            let result:Record<string,unknown>;
            if(name==='desk_read')result=await read(text(args.path,500));
            else if(name==='desk_search'){
                // Search only declared source files, not an unrestricted workspace scan.
                const query=text(args.text,500),matches:{path:string;line:number;text:string}[]=[];
                for(const file of files(workspace).filter(f=>withinScope(f.path,scopes))){
                    const source=await read(file.path);String(source.content).split('\n').forEach((line,index)=>{if(line.includes(query)&&matches.length<200)matches.push({path:file.path,line:index+1,text:line.slice(0,1000)});});
                }
                result={matches};
            }
            else if(name==='desk_write')result=await write(text(args.path,500),args.content as string,text(args.expected_sha,64,true),role,signal);
            else if(name==='desk_edit'){
                const path=text(args.path,500),oldText=args.old_text,newText=args.new_text;
                if(typeof oldText!=='string'||!oldText.length||oldText.length>2000000||typeof newText!=='string')throw new DomainError('INVALID_TEXT');
                const current=await read(path),edited=editUniqueText(current.content,oldText,newText);
                if(current.sha256!==args.expected_sha||edited===undefined)throw new DomainError('STALE_OR_AMBIGUOUS_EDIT',409);
                result=await write(path,edited,current.sha256,role,signal);
            }else{
                const command=validateSandboxCommand(args);
                // A missing entry cannot have run anything: the catalog check in wsl-sandbox happens
                // BEFORE any spawn. Marking it as an unknown effect (the old behaviour, because
                // effectChanged was already true here) poisoned the journal permanently: run_9151bc3544b6e275d0ed
                // ended with one UNKNOWN_EFFECT desk_run (SANDBOX_ENTRY_MISSING) and checkJournal then
                // refused every later dispatch with TOOL_RECOVERY_REQUIRED, at done=5/8. Determinate
                // pre-spawn refusals stay FAILED_NO_EFFECT so the model can simply fix the file.
                if(!files(workspace).some(f=>f.path===command.entry))throw new DomainError('SANDBOX_ENTRY_MISSING',409);
                effectChanged=true;
                result={execution:await kernel.run(workspace,command,{signal})};
                effectChanged=false;
            }
            authority(role,signal);
            if(hasSecret(JSON.stringify(result)))throw new DomainError('SECRET_IN_TOOL_OUTPUT',403);
            store.tx(()=>{
                store.record('ToolResult',r.projectId,r.id,{intentId,tool:name,specHash:r.specHash,sourceHash:expectedTree,...(sliceId?{sliceId}:{}),status:'COMPLETE',responseHash:hash(result)});
                store.event(r.projectId,r.id,'executor.tool.completed',{intentId,tool:name,specHash:r.specHash,sourceHash:expectedTree});
            });
            return result;
        }catch(error){
            recoveryRequired=effectChanged;
            try{store.record('ToolResult',r.projectId,r.id,{intentId,tool:name,...(sliceId?{sliceId}:{}),status:effectChanged?'UNKNOWN_EFFECT':'FAILED_NO_EFFECT',code:error instanceof DomainError?error.code:'NATIVE_TOOL_FAILED'});}
            catch{recoveryRequired=true;}
            throw error;
        }finally{active=false;}
    }};
}
