import { DomainError,hash,within } from '../security.js';
import { isAbsolute, relative, posix,win32,join } from 'node:path';
import {mkdirSync,mkdtempSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import type { Config } from '../../shared/types.js';

/** Closed controller settings for supervisory roles. A disabled apply-patch format
 * flag is not a filesystem boundary: the selected runtime still denies all writes. */
export const codexSupervisorFeatures=Object.freeze({shell_tool:false,unified_exec:false,view_image:false,image_generation:false,js_repl:false,code_mode:false,multi_agent:false,multi_agent_v2:false,apps:false,plugins:false,hooks:false,codex_hooks:false,plugin_hooks:false,memory_tool:false,memories:false,request_permissions_tool:false,tool_search:false,tool_suggest:false,browser_use:false,computer_use:false,remote_control:false,skip_host_skill_discovery:true,workspace_dependencies:false,stable_environment_tools:false,deferred_executor:false,executor_capability_discovery:false});
export function windowsCodexSupervisorConfig(permissionProfile:string){
    if(permissionProfile!=='dream-maker-supervisor-data')throw new DomainError('CODEX_SUPERVISOR_PROFILE_INVALID',409);
    return{
        default_permissions:permissionProfile,
        permissions:{[permissionProfile]:{filesystem:{':minimal':'read'},network:{enabled:false}}},
        features:{...codexSupervisorFeatures},mcp_servers:{},project_doc_max_bytes:0,web_search:'disabled',
        tools:{update_plan:{enabled:false},experimental_request_user_input:{enabled:false}}
    };
}
export function windowsCodexContextArguments(directory:string){
    const values=['windows.sandbox="mxc"','cli_auth_credentials_store="file"','forced_login_method="chatgpt"','check_for_update_on_startup=false','history.persistence="none"','analytics.enabled=false','log_dir='+JSON.stringify(join(directory,'logs')),'sqlite_home='+JSON.stringify(join(directory,'sqlite')),'mcp_servers={}',...Object.entries(codexSupervisorFeatures).map(([key,value])=>'features.'+key+'='+String(value))];
    return values.flatMap(value=>['-c',value]);
}

/**
 * Build the exact cold-resume request accepted by the pinned app-server.
 * ThreadResumeParams in 0.162.0 has no `environments` field; environment policy
 * is reasserted on the next turn/start. Keeping this shape in one place prevents
 * a successful model turn from becoming unrecoverable after process restart.
 */
export function windowsCodexResumeRequest(input:{
    threadId:string;
    model:string;
    cwd:string;
    permissionProfile:string;
    config:Record<string,unknown>;
    excludeTurns?:boolean;
}){
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(input.threadId))throw new DomainError('CODEX_THREAD_ID_INVALID',409);
    if(typeof input.model!=='string'||!input.model||input.model.length>200)throw new DomainError('CODEX_MODEL_BINDING_INVALID',409);
    if(!isAbsolute(input.cwd))throw new DomainError('CODEX_RESUME_CWD_INVALID',409);
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.permissionProfile))throw new DomainError('CODEX_PERMISSION_PROFILE_INVALID',409);
    if(input.config===null||typeof input.config!=='object'||Array.isArray(input.config))throw new DomainError('CODEX_RESUME_CONFIG_INVALID',409);
    if(input.excludeTurns!==undefined&&typeof input.excludeTurns!=='boolean')throw new DomainError('CODEX_RESUME_EXCLUDE_TURNS_INVALID',409);
    return {
        threadId:input.threadId,
        model:input.model,
        modelProvider:'openai',
        serviceTier:'default',
        cwd:input.cwd,
        approvalPolicy:'never',
        permissions:input.permissionProfile,
        config:structuredClone(input.config),
        runtimeWorkspaceRoots:[],
        excludeTurns:input.excludeTurns??false
    };
}

/** F/project-owned runtime. Existing authentication is referenced only by CODEX_HOME;
 * no authentication file is opened, copied or included in its persisted context. */
export function createWindowsCodexContext(root:string,home:string,role:string,source:NodeJS.ProcessEnv=process.env){
    if(!['planner2','reviewer'].includes(role))throw new DomainError('CODEX_ROLE_DENIED',403);
    if(!home||!isAbsolute(home))throw new DomainError('ISOLATED_CODEX_HOME_REQUIRED',409);
    const parent=within(root,'.runtime/windows-codex');mkdirSync(parent,{recursive:true});within(root,'.runtime/windows-codex');
    // Every dispatch used to leave its isolated home behind: 85 stale planner2 homes (about 50 MB each)
    // exhausted the disk and aborted runs with EXECUTOR_SLICE_STORAGE_LIMIT. Reclaim a bounded recent
    // window instead; a dispatch in flight is always among the newest entries and is never touched.
    try{
        const stale=readdirSync(parent,{withFileTypes:true})
            .filter(entry=>entry.isDirectory()&&entry.name.startsWith(role+'-'))
            .map(entry=>({name:entry.name,at:statSync(join(parent,entry.name)).mtimeMs}))
            .sort((a,b)=>b.at-a.at)
            .slice(8);
        for(const entry of stale)rmSync(join(parent,entry.name),{recursive:true,force:true});
    }catch{/* Reclaiming space must never fail a dispatch. */}
    const directory=mkdtempSync(join(parent,role+'-')),cwd=join(directory,'packet'),profile=join(directory,'profile');
    const paths={TEMP:join(directory,'temp'),TMP:join(directory,'temp'),TMPDIR:join(directory,'temp'),HOME:profile,USERPROFILE:profile,APPDATA:join(profile,'AppData/Roaming'),LOCALAPPDATA:join(profile,'AppData/Local'),CODEX_SQLITE_HOME:join(directory,'sqlite')};
    for(const path of new Set([cwd,join(directory,'logs'),...Object.values(paths)]))mkdirSync(path,{recursive:true});
    const environment:NodeJS.ProcessEnv={...paths,CODEX_HOME:home};
    for(const name of ['SystemDrive','ProgramData','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','USERNAME','USERDOMAIN'])if(source[name])environment[name]=source[name];
    writeFileSync(join(directory,'context.json'),JSON.stringify({schema:'dream-maker.windows-codex-context.v1',role,scope:'RPC_FROZEN_MATERIAL_ONLY',homeHash:hash(home),cwd,createdAt:new Date().toISOString()},null,2),{flag:'wx'});
    return{directory,cwd,environment,args:windowsCodexContextArguments(directory)};
}

/**
 * K07-B: Windows -> WSL launch shape for the product planner2/reviewer CLI.
 *
 * The runner must not silently keep spawning a Windows binary when an isolated Linux
 * CLI is the qualified transport. This module builds the exact argv; it never builds a
 * shell string, so no path can smuggle a command through a shell.
 *
 * Launch/protocol inventory and actual model qualification are separate evidence layers.
 */
export interface CodexLaunch {
    command: string;
    args: string[];
    cwd: string | undefined;
    transport: 'stdio' | 'wsl';
}

/** A private WSL host address discovered from /proc/net/route. */
export interface WslProxyBinding {
    gateway: string;
    port: number;
    proxyUrl: string;
}

const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
// Absolute POSIX path with no empty, dot or dot-dot segments, and no spaces or shell metacharacters.
// '@' and '+' are allowed because the pinned CLI lives under an npm scope (@openai/...): excluding
// them made the one binary this project installs fail the check that guards it.
const POSIX_SEGMENT = /^(?!\.$)(?!\.\.$)[A-Za-z0-9._@+-]+$/;
function isSafePosixAbsolute(value: string): boolean {
    if (!value.startsWith('/') || value.length > 400) return false;
    const segments = value.slice(1).split('/');
    return segments.length > 0 && segments.every(segment => POSIX_SEGMENT.test(segment));
}

/** Supervisory roles receive frozen source/diff/test packets as data and have no shell tools.
 * Their Linux cwd is a trusted packet directory, never a host generated-workspace mount. */
export function codexAgentCwd(config: Config, workspace: string): string {
    if ((config.codex.transport ?? 'stdio') !== 'wsl') return workspace;
    const cwd = config.codex.wslCwdRoot ?? '';
    if (!isSafePosixAbsolute(cwd)) throw new DomainError('CODEX_WSL_CWD_INVALID', 409);
    return cwd;
}
export function codexCwdMatches(config: Config, expected: string, actual: unknown): boolean {
    if (typeof actual !== 'string') return false;
    return (config.codex.transport ?? 'stdio') === 'wsl'
        ? isSafePosixAbsolute(actual) && posix.relative(expected, actual) === ''
        : isAbsolute(actual) && relative(expected, actual) === '';
}

export function codexLaunch(config: Config, workspace: string, options: {wslProxy?:WslProxyBinding} = {}): CodexLaunch {
    const c = config.codex;
    const transport = c.transport ?? 'stdio';
    if (transport === 'stdio')
        return { command: c.command, args: [...c.args], cwd: workspace, transport };
    if (transport !== 'wsl')
        throw new DomainError('CODEX_TRANSPORT_UNKNOWN', 409);
    const distro = c.wslDistro ?? '';
    const cwd = c.wslCwdRoot ?? '';
    const binary = c.wslBinary ?? '';
    if (!DISTRO.test(distro))
        throw new DomainError('CODEX_WSL_DISTRO_INVALID', 409, 'WSL 发行版名不合法；不做 shell 拼接。');
    if (!isSafePosixAbsolute(cwd))
        throw new DomainError('CODEX_WSL_CWD_INVALID', 409, 'WSL 工作目录必须是安全的绝对 POSIX 路径（不含空格/元字符/..）。');
    if (!isSafePosixAbsolute(binary))
        throw new DomainError('CODEX_WSL_BINARY_INVALID', 409, 'WSL 二进制必须是安全的绝对 POSIX 路径。');
    // The Windows-side Codex home cannot be the CLI home inside WSL; requiring an explicit
    // Linux home keeps Windows credentials out of the generated command namespace.
    if (!c.wslHome || !isSafePosixAbsolute(c.wslHome))
        throw new DomainError('CODEX_WSL_HOME_REQUIRED', 409, 'WSL 传输必须给出隔离的 Linux CODEX_HOME 绝对路径。');
    // The preserved stdio setting may name the npm Windows launcher. It is not an argument to
    // an independent Linux executable. Recognize that one exact launcher shape without rewriting
    // the user's setting; never forward an arbitrary script or silently drop unreviewed options.
    const args=codexWslServerArgs(c.args);
    // wsl.exe does not forward arbitrary Windows variables to the Linux child, so CODEX_HOME must be
    // set inside the distro or the CLI silently runs with its default home (no login -> "subscription
    // account required"). '/usr/bin/env' carries exactly the two variables the isolated home needs.
    return {
        command: c.wslCommand || 'wsl.exe',
        args: ['-d', distro, '--cd', cwd, '--', '/usr/bin/env', 'HOME=' + c.wslHome, 'CODEX_HOME=' + c.wslHome,
            ...(options.wslProxy?wslProxyArgumentAssignments(options.wslProxy):[]), binary, ...args],
        cwd: undefined,
        transport
    };
}
export function codexWslServerArgs(args:string[]):string[]{
    if(args.length===1&&args[0]==='app-server')return ['app-server'];
    if(args.length===2&&win32.isAbsolute(args[0])&&/\/node_modules\/@openai\/codex\/bin\/codex\.js$/i.test(args[0].replaceAll('\\','/'))&&args[1]==='app-server')return ['app-server'];
    throw new DomainError('CODEX_WSL_ARGS_DENIED',409);
}
export interface CodexProxyEnvironmentEvidence {
    path:'CHILD_ENV_MATCH'|'DM_ROUTE_DISABLED'|'UNMANAGED_ENV_PRESENT';
    proxyEndpoint:string|null;
    proxyFingerprint:string|null;
    networkReachability:'NOT_TESTED';
    authentication:'NOT_VERIFIED';
    serviceEligibility:'NOT_VERIFIED';
    modelInference:'NOT_RUN';
}

const proxyNames=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'] as const;
const wslProxyNames=['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'] as const;
const wslProxyBypass='localhost,127.0.0.1,::1,[::1]';
function proxyValues(environment:NodeJS.ProcessEnv):string[]{
    return proxyNames.flatMap(name=>{
        const upper=environment[name],lower=environment[name.toLowerCase()];
        if(upper&&lower&&upper!==lower)throw new DomainError('CODEX_PROXY_ENVIRONMENT_MISMATCH',409);
        const value=upper??lower;
        return value?[value]:[];
    });
}

function privateIpv4(value:string):boolean{
    const parts=value.split('.');
    if(parts.length!==4||parts.some(part=>!/^\d{1,3}$/.test(part)))return false;
    const numbers=parts.map(Number);
    if(numbers.some(part=>part<0||part>255))return false;
    return numbers[0]===10||(numbers[0]===172&&numbers[1]>=16&&numbers[1]<=31)||(numbers[0]===192&&numbers[1]===168);
}

/** Parse only the exact HTTP proxy shape reachable from the WSL NAT namespace.
 * The returned endpoint is a discovered host gateway, never Windows loopback. */
export function parseWslProxyBinding(proxyValue:string):WslProxyBinding{
    let proxy:URL;
    try{proxy=new URL(proxyValue);}catch{throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);}
    if(proxy.protocol!=='http:'||!privateIpv4(proxy.hostname)||!proxy.port||proxy.username||proxy.password||
        proxy.pathname!=='/'||proxy.search||proxy.hash)throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    const port=Number(proxy.port);
    if(!Number.isSafeInteger(port)||port<1||port>65535)throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    return{gateway:proxy.hostname,port,proxyUrl:`http://${proxy.hostname}:${port}/`};
}

/** Extract one consistent proxy endpoint from the lease-bound child environment.
 * This remains a preparation check; it does not claim that a request happened. */
export function wslProxyFromEnvironment(environment:NodeJS.ProcessEnv):WslProxyBinding|null{
    const values=proxyValues(environment);
    if(values.length===0)return null;
    if(values.length!==proxyNames.length||new Set(values).size!==1)
        throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    return parseWslProxyBinding(values[0]);
}

/** Read only the port from a lease-bound Windows loopback proxy tuple. The
 * resolver then discovers the corresponding WSL host gateway instead of
 * copying 127.0.0.1 into Linux. */
export function loopbackProxyPortFromEnvironment(environment:NodeJS.ProcessEnv):number|null{
    const values=proxyValues(environment);
    if(values.length===0)return null;
    if(values.length!==proxyNames.length||new Set(values).size!==1)
        throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    let proxy:URL;
    try{proxy=new URL(values[0]);}catch{throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);}
    if(proxy.protocol!=='http:'||proxy.hostname!=='127.0.0.1'||!proxy.port||proxy.username||proxy.password||
        proxy.pathname!=='/'||proxy.search||proxy.hash)throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    const port=Number(proxy.port);
    if(!Number.isSafeInteger(port)||port<1||port>65535)throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    return port;
}

export function wslProxyEnvironment(binding:WslProxyBinding):Record<string,string>{
    const verified=parseWslProxyBinding(binding.proxyUrl);
    if(verified.gateway!==binding.gateway||verified.port!==binding.port)
        throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    return Object.fromEntries([...wslProxyNames.map(name=>[name,verified.proxyUrl]),['NO_PROXY',wslProxyBypass],['no_proxy',wslProxyBypass]]);
}

/** `/usr/bin/env` must receive assignments before the executable, never via
 * wsl.exe's Windows environment or an inherited shell. */
export function wslProxyArgumentAssignments(binding:WslProxyBinding):string[]{
    return Object.entries(wslProxyEnvironment(binding)).map(([name,value])=>{
        if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||!value||/[\0\r\n]/.test(value))
            throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
        return `${name}=${value}`;
    });
}

/** Verify only the child-environment boundary. This does not prove that the
 * proxy accepted a CONNECT, that an account is authenticated, that service
 * eligibility exists, or that inference completed. */
export function inspectCodexProxyEnvironment(config:Config,environment:NodeJS.ProcessEnv):CodexProxyEnvironmentEvidence{
    const values=proxyValues(environment);
    if((config.codex.transport??'stdio')==='wsl'){
        if(!config.clash.enabled){
            if(values.length)throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
            return{path:'DM_ROUTE_DISABLED',proxyEndpoint:null,proxyFingerprint:null,networkReachability:'NOT_TESTED',authentication:'NOT_VERIFIED',serviceEligibility:'NOT_VERIFIED',modelInference:'NOT_RUN'};
        }
        const binding=wslProxyFromEnvironment(environment);
        if(!binding)throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
        return{path:'CHILD_ENV_MATCH',proxyEndpoint:binding.gateway+':'+binding.port,proxyFingerprint:hash(binding.proxyUrl),networkReachability:'NOT_TESTED',authentication:'NOT_VERIFIED',serviceEligibility:'NOT_VERIFIED',modelInference:'NOT_RUN'};
    }
    if(!config.clash.enabled)return{path:values.length?'UNMANAGED_ENV_PRESENT':'DM_ROUTE_DISABLED',proxyEndpoint:null,proxyFingerprint:null,networkReachability:'NOT_TESTED',authentication:'NOT_VERIFIED',serviceEligibility:'NOT_VERIFIED',modelInference:'NOT_RUN'};
    if(values.length!==proxyNames.length)throw new DomainError('CODEX_PROXY_ENVIRONMENT_MISSING',409);
    if(new Set(values).size!==1)throw new DomainError('CODEX_PROXY_ENVIRONMENT_MISMATCH',409);
    let proxy:URL;
    try{proxy=new URL(values[0]);}catch{throw new DomainError('CODEX_PROXY_ENVIRONMENT_MISMATCH',409);}
    if(proxy.protocol!=='http:'||proxy.hostname!=='127.0.0.1'||!proxy.port||proxy.username||proxy.password||proxy.pathname!=='/'||proxy.search||proxy.hash)
        throw new DomainError('CODEX_PROXY_ENVIRONMENT_MISMATCH',409);
    const bypass=String(environment.NO_PROXY??environment.no_proxy??'');
    if(!/(?:^|,)\s*(?:localhost|127[.]0[.]0[.]1|\[?::1\]?)\s*(?:,|$)/.test(bypass))
        throw new DomainError('CODEX_PROXY_ENVIRONMENT_MISMATCH',409);
    return{path:'CHILD_ENV_MATCH',proxyEndpoint:proxy.hostname+':'+proxy.port,proxyFingerprint:hash(values[0]),networkReachability:'NOT_TESTED',authentication:'NOT_VERIFIED',serviceEligibility:'NOT_VERIFIED',modelInference:'NOT_RUN'};
}

/** A Windows loopback proxy is not implicitly reachable inside this dedicated WSL environment.
 * Do not invent a forwarder, change host networking or silently drop the user's selected route. */
export function assertCodexTransportRoute(config:Config,environment:NodeJS.ProcessEnv):CodexProxyEnvironmentEvidence{
    return inspectCodexProxyEnvironment(config,environment);
}

/** Environment for the launch: a stdio launch keeps the Windows home, a WSL launch does not. */
export function codexHomeFor(config: Config): string {
    const c = config.codex;
    return (c.transport ?? 'stdio') === 'wsl' ? (c.wslHome ?? '') : c.home;
}

/**
 * A03: the child environment is built as data, not as a side effect inside the runner, so the rule
 * "the product CLI never sees the daily Codex home" is testable without spawning anything.
 *
 * The isolation is only real if the Linux home differs from the Windows one: pointing both at the
 * same directory would silently hand the daily login to the generated-command namespace, which is
 * exactly what this project forbids.
 */
export function codexEnv(config: Config): Record<string, string> {
    const c = config.codex;
    const transport = c.transport ?? 'stdio';
    if (transport === 'wsl') {
        const home = c.wslHome ?? '';
        if (!isSafePosixAbsolute(home))
            throw new DomainError('CODEX_WSL_HOME_INVALID', 409, 'WSL 传输必须给出隔离的 Linux CODEX_HOME 绝对路径。');
        const daily = (c.home ?? '').replace(/\\/g, '/').toLowerCase();
        if (daily.length > 0 && daily === home.toLowerCase())
            throw new DomainError('CODEX_HOME_NOT_ISOLATED', 409, 'WSL 的 CODEX_HOME 不能与日常 Windows home 相同。');
        return { CODEX_HOME: home };
    }
    if (!c.home)
        throw new DomainError('ISOLATED_CODEX_HOME_REQUIRED', 409);
    return { CODEX_HOME: c.home };
}
