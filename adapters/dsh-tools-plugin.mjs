// Actual pinned DSH defineTool/registry extension; no SDK replacement or host shell.
import {readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash,registerCredentialEnv,within} from '../dist/server/security.js';
import {toolClient} from './dsh-tool-client.mjs';
export const name='dream-maker-executor-tools';
export const inject=['tools'];
export const TOOL_NAMES=Object.freeze(['desk_read','desk_search','desk_write','desk_edit','desk_run']);
export const TERMINAL_TOOL_NAMES=Object.freeze({planner2:'submit_engineering_plan',reviewer:'submit_review'});
export async function apply(ctx){
    registerCredentialEnv('DM_TOOL_PROXY_TOKEN');
    const path=process.env.DM_DSH_TOOL_CLIENT_CONFIG,expected=process.env.DM_DSH_TOOL_CLIENT_SHA256;
    if(!path||!isAbsolute(path)||!expected)throw Error('DREAM_MAKER_TOOL_BINDING_REQUIRED');
    const bytes=readFileSync(path);if(hash(bytes)!==expected)throw Error('DREAM_MAKER_TOOL_BINDING_CHANGED');
    const c=JSON.parse(bytes);
    if(c.schema!=='dream-maker.dsh-tool-client.v1'||!isAbsolute(c.sdkToolsModule)||c.sdkCommit!=='4878cdabd87d4041bdaff61d04c966883b9fd07a'||!Array.isArray(c.dependencies))throw Error('DREAM_MAKER_SDK_BINDING_DENIED');
    if(!c.dependencies.some(f=>resolve(f.path)===resolve(c.sdkToolsModule)))throw Error('DREAM_MAKER_SDK_BINDING_DENIED');
    for(const f of c.dependencies)if(!isAbsolute(f.path)||hash(readFileSync(f.path))!==f.sha256)throw Error('DREAM_MAKER_SDK_BINDING_CHANGED');
    const {defineTool}=await import(pathToFileURL(c.sdkToolsModule).href);
    const role=c.role??'executor';
    const roster=installRoleTools(ctx,defineTool,toolClient(c.toolUrl,process.env.DM_TOOL_PROXY_TOKEN),role);
    const expectedRoster=role==='executor'?[...TOOL_NAMES].sort():[TERMINAL_TOOL_NAMES[role]];
    if(JSON.stringify(roster())!==JSON.stringify(expectedRoster))throw Error('DREAM_MAKER_TOOL_ROSTER_NOT_EXCLUSIVE');
    if(process.env.DM_DSH_PROFILE_MANIFEST){
        const {assertNativeProfile,sdkProvider}=await import('./dsh-native-profile.mjs');
        const manifest=assertNativeProfile(process.env.DM_DSH_PROFILE_MANIFEST,process.env.DM_DSH_PROFILE_SHA256);
        if(resolve(manifest.home)!==resolve(process.env.DSH_HOME??'')||manifest.modelURL!==process.env.DEEPSEEK_BASE_URL||!process.env.DEEPSEEK_API_KEY||(manifest.role??'executor')!==role||manifest.provider!==c.provider||
            (manifest.provider!==undefined?manifest.model!==c.model:c.model!==undefined))throw Error('DREAM_MAKER_PROFILE_ROUTE_CHANGED');
        writeFileSync(within(manifest.home,'runtime-attestation.json'),JSON.stringify({schema:'dream-maker.dsh-profile-runtime.v1',at:new Date().toISOString(),
            pid:process.pid,profileSha256:process.env.DM_DSH_PROFILE_SHA256,role,roster:roster(),model:manifest.model,provider:manifest.provider??sdkProvider,...(manifest.provider!==undefined?{sdkProvider}:{}),
            modelURL:manifest.modelURL,home:manifest.home,cwd:process.cwd(),evidenceClass:'ACTUAL_PROFILE_REGISTRATION_NOT_MODEL_TURN'},null,2)+'\n',{flag:'wx',mode:0o600});
    }
}
export function installRoleTools(ctx,defineTool,dispatch,role){
    if(!['executor','planner2','reviewer'].includes(role))throw Error('DREAM_MAKER_ROLE_DENIED');
    if(ctx.tools.schemas().length!==0){
        ctx.tools.guard(()=>'DREAM_MAKER_TOOL_DENIED');
        throw Error('DREAM_MAKER_TOOL_ROSTER_NOT_EXCLUSIVE');
    }
    if(role==='executor')return installExecutorTools(ctx,defineTool,dispatch);
    return installTerminalTool(ctx,defineTool,dispatch,role);
}
export function installTerminalTool(ctx,defineTool,dispatch,role){
    const toolName=TERMINAL_TOOL_NAMES[role];
    const requiredString={type:'string',required:true};
    const task={type:'object',additionalProperties:false,properties:{
        id:requiredString,title:requiredString,
        dependsOn:{type:'array',required:true,items:{type:'string'}},
        requirementIds:{type:'array',required:true,items:{type:'string'}},
        acceptance:{type:'array',required:true,items:{type:'string'}},
        writePaths:{type:'array',required:true,items:{type:'string'}}
    }};
    const reviewFinding={type:'object',additionalProperties:false,properties:{
        id:requiredString,severity:{type:'string',required:true,enum:['critical','high','medium','low']},
        description:requiredString,evidence:requiredString
    }};
    // defineTool takes an implicit parameter property map, not a raw object-root
    // JSON Schema. Keep strict top-level validation in the controller as well.
    const parameters=role==='planner2'
        ?{tasks:{type:'array',required:true,items:task},notes:{type:'string'},dataRuntime:{
            type:'object',additionalProperties:false,properties:{
                schema:{type:'string',required:true,enum:['dream-maker.json-runtime-plan.v1','dream-maker.sqlite-runtime-plan.v1']},
                protocol:{type:'string',required:true,enum:['JSON_DOCUMENT_V1','SQLITE_IMAGE_V1']},
                runtime:{type:'string',required:true,enum:['node','python']},entry:requiredString,
                args:{type:'array',required:true,items:{type:'string'}}
            }
        }}
        :{verdict:{type:'string',required:true,enum:['PASS','CHANGES_REQUESTED','BLOCKED']},findings:{type:'array',required:true,items:reviewFinding},
            preworkCoverage:{type:'array',items:{type:'object',additionalProperties:false,properties:{requirementId:requiredString,
                artifactPaths:{type:'array',required:true,items:{type:'string'}},caseIds:{type:'array',required:true,items:{type:'string'}},acceptanceIds:{type:'array',required:true,items:{type:'string'}}}}}};
    const output={schema:{type:'object',additionalProperties:false,properties:{text:requiredString}},render:(_args,value)=>[{type:'text',text:value.text}]};
    const definition=defineTool({name:toolName,description:role==='planner2'
        ?'Submit the complete engineering plan. Call this exactly once; it is the only task result.'
        :'Submit the complete independent review. Call this exactly once; it is the only task result.',
        parameters,output,async execute(args,execution){
        if(typeof execution.concludeTurn!=='function')throw Error('DREAM_MAKER_TERMINAL_LIFECYCLE_REQUIRED');
        const result=await dispatch(toolName,args,execution.signal);
        if(result?.accepted!==true)throw Error('DREAM_MAKER_TERMINAL_NOT_ACCEPTED');
        execution.concludeTurn();
        return{text:JSON.stringify(result)};
    }});
    ctx.tools.register(definition);
    ctx.tools.guard(execution=>execution.name===toolName&&ctx.tools.get(toolName,execution.agent)===definition?undefined:'DREAM_MAKER_TOOL_DENIED');
    return()=>ctx.tools.schemas().map(s=>s.name).sort();
}
export function installExecutorTools(ctx,defineTool,dispatch) {
    const output={schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]};
    const str={type:'string',required:true};
    const definitions=[
        ['desk_read','Read approved source and its current SHA256.',{path:str}],
        ['desk_search','Literal bounded search in approved source.',{text:str}],
        ['desk_write','Write approved source. For a NEW file set expected_sha to the empty string "". For an existing file use its current SHA256 returned by desk_read. Never use the future content hash or a placeholder.',{path:str,content:str,expected_sha:str}],
        ['desk_edit','Replace one unique exact match in approved source with current SHA. Pass actual file characters: do not copy JSON backslash escapes around quotes from desk_read output. If the same text occurs more than once, include unique surrounding content; when every occurrence must change, use desk_write with the complete updated file.',{path:str,old_text:str,new_text:str,expected_sha:str}],
        ['desk_run','Execute only a staged Node/Python entry in the dedicated network-denied OS sandbox.',{runtime:{type:'string',required:true,enum:['node','python']},entry:str,args:{type:'array',required:true,items:{type:'string'}},stdin:str}]
    ];
    const trusted=new Map();
    for(const [tool,description,parameters] of definitions){const definition=defineTool({name:tool,description,parameters,output,
        async execute(args,execution){return{text:JSON.stringify(await dispatch(tool,args,execution.signal))};}
    });trusted.set(tool,definition);ctx.tools.register(definition);}
    ctx.tools.guard(execution=>trusted.has(execution.name)&&ctx.tools.get(execution.name,execution.agent)===trusted.get(execution.name)?undefined:'DREAM_MAKER_TOOL_DENIED');
    return ()=>ctx.tools.schemas().map(s=>s.name).sort();
}
