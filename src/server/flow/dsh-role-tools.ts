import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {startToolBroker} from '../tool-broker.js';import {hash,within,DomainError} from '../security.js';import {PI_READ_ONLY_TOOLS} from './pi-native-wire.js';
interface Ref{path:string;sha256:string}
export const TERMINAL_TOOL_NAMES=Object.freeze({planner2:'submit_engineering_plan',reviewer:'submit_review'} as const);
type TerminalRole=keyof typeof TERMINAL_TOOL_NAMES;
export interface RoleToolController {
    dispatch(role:'planner1'|'planner2'|'executor'|'reviewer',name:string,args:unknown,signal:AbortSignal):Promise<Record<string,unknown>>;
    /** Exact immutable terminal tool arguments captured by the controller. */
    terminal?():string|undefined;
}
export interface DshRoleToolInput {
    root:string;role:'planner2'|'executor'|'reviewer';roleId:string;configurationHash:string;
    runId:string;specHash:string;provider:string;model:string;modelURL:string;maxOutputTokens:number;contextTokens:number;
    template:Ref;profileBinding:{sdkCommit:string;basePatch:string;sdkPatch:string;yamlModule:string;dependencies:Ref[]};sdkToolsModule:string;
    controller:RoleToolController;
}
/** Permissions come only from the immutable running role, never from tool arguments. */
export function customProductTools(role:'planner2'|'executor'|'reviewer',permissions:readonly string[],base:RoleToolController|undefined,assertCurrent:()=>void,ownedSignal:AbortSignal):RoleToolController {
    if(!(ownedSignal instanceof AbortSignal))throw new DomainError('CUSTOM_ROLE_SIGNAL_REQUIRED',409);
    const selected=new Set(permissions),allowed=new Set(['desk_read','desk_search',...(selected.has('source_write')?['desk_write','desk_edit','desk_run']:[])]);
    if(!['planner2','executor','reviewer'].includes(role)||!selected.has('source_read')||[...selected].some(p=>!['source_read','source_write'].includes(p))||role!=='executor'&&selected.has('source_write'))throw new DomainError('CUSTOM_ROLE_PERMISSION_DENIED',403);
    let submitted:unknown,used=false;
    const fail=(code:string,status=409):never=>{throw new DomainError(code,status);};
    const plain=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
    const exact=(value:unknown,keys:readonly string[],required:readonly string[]=keys):void=>{
        if(!plain(value)||Object.keys(value).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail('CUSTOM_TERMINAL_ARGS_INVALID',400);
    };
    const validateTerminal=(selectedRole:TerminalRole,value:unknown):unknown=>{
        if(selectedRole==='planner2'){
            exact(value,['tasks','notes','dataRuntime'],['tasks']);
            const plan=value as Record<string,unknown>;
            const tasks=plan.tasks;
            if(!Array.isArray(tasks)||tasks.length<1||tasks.length>30)fail('CUSTOM_TERMINAL_ARGS_INVALID',400);
            for(const task of tasks as unknown[]){
                exact(task,['id','title','dependsOn','requirementIds','acceptance','writePaths'],['id','title','dependsOn','requirementIds','acceptance','writePaths']);
                if(!Array.isArray((task as Record<string,unknown>).writePaths)||((task as Record<string,unknown>).writePaths as unknown[]).length===0)fail('CUSTOM_TERMINAL_ARGS_INVALID',400);
            }
        }else{
            exact(value,['verdict','findings','preworkCoverage'],['verdict','findings']);
            const review=value as Record<string,unknown>;
            const findings=review.findings;
            if(!Array.isArray(findings))fail('CUSTOM_TERMINAL_ARGS_INVALID',400);
            for(const finding of findings as unknown[]){
                exact(finding,['id','severity','description','evidence'],['id','severity','description','evidence']);
            }
            if(review.preworkCoverage!==undefined){
                if(!Array.isArray(review.preworkCoverage)||review.preworkCoverage.length>512)fail('CUSTOM_TERMINAL_ARGS_INVALID',400);
                for(const row of review.preworkCoverage as unknown[]){
                    exact(row,['requirementId','artifactPaths','caseIds','acceptanceIds']);
                    const r=row as Record<string,unknown>;
                    if(typeof r.requirementId!=='string'||['artifactPaths','caseIds','acceptanceIds'].some(k=>!Array.isArray(r[k])||(r[k] as unknown[]).some(v=>typeof v!=='string')))fail('CUSTOM_TERMINAL_ARGS_INVALID',400);
                }
            }
        }
        if(Buffer.byteLength(JSON.stringify(value),'utf8')>1000000)fail('CUSTOM_TERMINAL_ARGS_INVALID',400);
        return structuredClone(value);
    };
    return{async dispatch(toolRole,name,args,signal){
        const combined=AbortSignal.any([ownedSignal,signal]);
        if(combined.aborted)throw new DomainError('RUN_CANCELLED',409);
        const current:unknown=assertCurrent();if(current!==undefined){if(current instanceof Promise)void current.catch(()=>{});throw new DomainError('CUSTOM_DSH_CURRENTNESS_INVALID',409);}
        if(role==='planner2'||role==='reviewer'){
            if(toolRole!=='executor'||name!==TERMINAL_TOOL_NAMES[role])fail('CUSTOM_ROLE_PERMISSION_DENIED',403);
            if(used){submitted=undefined;fail('CUSTOM_TERMINAL_SUBMISSION_ALREADY_USED',409);}
            used=true;submitted=validateTerminal(role,args);
            return{accepted:true};
        }
        if(toolRole!=='executor'||!base||!allowed.has(name))throw new DomainError('CUSTOM_ROLE_PERMISSION_DENIED',403);
        return base.dispatch(toolRole,name,args,combined);
    },terminal(){return submitted===undefined?undefined:JSON.stringify(submitted);}};
}
/** A read-only Pi role's controller: the same owned desk_* implementations an executor reaches,
 *  narrowed to desk_read and desk_search.
 *
 *  Pi routes every tool intent through the DM broker, so the narrowing has to live on the
 *  controller, never in a tool declaration the model could ignore. A planner2 or reviewer turn
 *  therefore keeps the broker audit an executor turn has, while losing the three write tools even
 *  if a future permission table were to grant them: the frozen role, not the argument, decides.
 *  Permissions are still the frozen role's own — source_read is required and source_write is
 *  refused, exactly as customRoleConfiguration already refuses it for the two read roles. */
export function readOnlyDeskTools(role:'planner2'|'reviewer',permissions:readonly string[],base:RoleToolController|undefined,assertCurrent:()=>void,ownedSignal:AbortSignal):RoleToolController {
    if(!(ownedSignal instanceof AbortSignal))throw new DomainError('CUSTOM_ROLE_SIGNAL_REQUIRED',409);
    const selected=new Set(permissions);
    if(!['planner2','reviewer'].includes(role)||!selected.has('source_read')||selected.has('source_write')||
        [...selected].some(p=>!['source_read','source_write'].includes(p))||!base)throw new DomainError('CUSTOM_ROLE_PERMISSION_DENIED',403);
    return{async dispatch(toolRole,name,args,signal){
        const combined=AbortSignal.any([ownedSignal,signal]);
        if(combined.aborted)throw new DomainError('RUN_CANCELLED',409);
        const current:unknown=assertCurrent();if(current!==undefined){if(current instanceof Promise)void current.catch(()=>{});throw new DomainError('CUSTOM_DSH_CURRENTNESS_INVALID',409);}
        // The broker always speaks as the executor shape (startToolBroker); what this role owns is
        // the read half of the desk tool set, and nothing else reaches the owned implementation.
        if(toolRole!=='executor'||!PI_READ_ONLY_TOOLS.includes(name))throw new DomainError('CUSTOM_ROLE_PERMISSION_DENIED',403);
        return base.dispatch(toolRole,name,args,combined);
    }};
}
/** The same owned profile/tool channel for Custom probes and product roles. */
export async function openDshRoleTools(input:DshRoleToolInput){
    const broker=await startToolBroker(input.controller);
    try{
        const parent=within(input.root,'.runtime/native-dispatches');mkdirSync(parent,{recursive:true});const directory=mkdtempSync(resolve(parent,'owned-'));
        const module=await import(pathToFileURL(resolve(input.root,'adapters/dsh-native-profile.mjs')).href);
        const route=module.customProfileRoute(input.provider,input.model);
        const profile=module.buildNativeProfile(directory,input.profileBinding,{role:input.role,...route,modelURL:input.modelURL,maxTokens:input.maxOutputTokens,contextTokens:input.contextTokens,pluginURL:pathToFileURL(resolve(input.root,'adapters/dsh-tools-plugin.mjs')).href});
        const configPath=resolve(directory,'tool-client.json');writeFileSync(configPath,JSON.stringify({schema:'dream-maker.dsh-tool-client.v1',role:input.role,...route,sdkCommit:input.profileBinding.sdkCommit,sdkToolsModule:input.sdkToolsModule,toolUrl:broker.url,dependencies:[{path:input.sdkToolsModule,sha256:hash(readFileSync(input.sdkToolsModule))}]}),{flag:'wx',mode:0o600});
        const dispatchPath=resolve(directory,'dispatch-binding.json');writeFileSync(dispatchPath,JSON.stringify({schema:'dream-maker.archon-dispatch.v2',runId:input.runId,specHash:input.specHash,template:input.template,roleBinding:{...route,role:input.role,roleId:input.roleId,configurationHash:input.configurationHash},launch:{dshHome:profile.home,controlRoot:directory,profileManifestPath:profile.manifestPath,profileManifestSha256:profile.manifestSha256}}),{flag:'wx',mode:0o600});
        return{url:broker.url,token:broker.token,configPath,configSha256:hash(readFileSync(configPath)),dispatchPath,dispatchSha256:hash(readFileSync(dispatchPath)),terminal:()=>input.controller.terminal?.(),close:()=>broker.close()};
    }catch(error){await broker.close();throw error;}
}
