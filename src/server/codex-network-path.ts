import {childEnv,DomainError,hash} from './security.js';
import {capture} from './process.js';
import {inspectOutsideExecutionScope} from './flow/process-ownership.js';
import type {ClashController,ClashConnection} from './clash-route.js';
import {
    CODEX_REQUEST_TARGETS,
    type CodexRequestClassification,
    type CodexRequestPathObservation,
    type CodexRequestPathState,
    type CodexRequestTargetHost
} from '../shared/network-contexts.js';
import {RpcChildError} from './providers/rpc.js';

export {CODEX_REQUEST_TARGETS};

export interface CodexProcessInfo {
    pid:number;
    identity:string|null;
    descendantPids?:number[];
    descendantIdentities?:{pid:number;identity:string}[];
}
export interface CodexRouteEvidence {
    path:CodexRequestPathState;
    processPid:number;
    processIdentitySha256:string|null;
    sourcePortSha256:string|null;
    proxyEndpoint:string|null;
    selectedNode:string|null;
    expectedNode:string;
    chains:string[];
    targetHost:CodexRequestTargetHost|null;
    targetHosts:CodexRequestTargetHost[];
    sourcePortCount:number;
}
export type CodexRequestRouteObserver=(input:{process:CodexProcessInfo;signal:AbortSignal})=>Promise<CodexRouteEvidence>;

export interface ProbeCodexRouteInput {
    process:CodexProcessInfo;
    proxyUrl:string;
    expectedNode:string;
    controller:Pick<ClashController,'connections'>;
    targetHosts?:readonly CodexRequestTargetHost[];
    targetPort:443;
    signal?:AbortSignal;
    timeoutMs?:number;
}
export interface WindowsTcpObservations {
    proxyOwners:Map<number,number>;
    directOwners:Map<number,number>;
}

const sleep=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason??new DomainError('CLASH_REQUEST_ABORTED',409));return;}
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    const abort=()=>{clearTimeout(timer);reject(signal?.reason??new DomainError('CLASH_REQUEST_ABORTED',409));};
    signal?.addEventListener('abort',abort,{once:true});
});

/** Bounded descendant selection for the Windows Node -> native Codex process tree.
 * Rows are controller-read CIM metadata, never caller-supplied route evidence. */
export function descendantProcessIds(raw:unknown,rootPid:number,maxDepth=8,limit=64):number[]{
    if(!Number.isSafeInteger(rootPid)||rootPid<1||!Number.isSafeInteger(maxDepth)||maxDepth<1||!Number.isSafeInteger(limit)||limit<1)return[];
    const rows=Array.isArray(raw)?raw:[];
    const children=new Map<number,number[]>();
    const present=new Set<number>();
    for(const item of rows){
        if(!item||typeof item!=='object'||Array.isArray(item))continue;
        const value=item as Record<string,unknown>,pid=Number(value.ProcessId),parent=Number(value.ParentProcessId);
        if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647)continue;
        present.add(pid);
        if(!Number.isSafeInteger(parent)||parent<1||parent>2147483647)continue;
        const list=children.get(parent)??[];
        if(!list.includes(pid))list.push(pid);
        children.set(parent,list);
    }
    if(!present.has(rootPid))return[];
    const seen=new Set<number>(),result:number[]=[],queue:[number,number][]=[[rootPid,0]];
    while(queue.length&&result.length<limit){
        const [pid,depth]=queue.shift()!;
        if(seen.has(pid))continue;
        seen.add(pid);result.push(pid);
        if(depth>=maxDepth)continue;
        const next=(children.get(pid)??[]).slice().sort((a,b)=>a-b);
        for(const child of next)if(!seen.has(child))queue.push([child,depth+1]);
    }
    return result;
}

function proxyEndpoint(proxyUrl:string):string|null{
    try{
        const value=new URL(proxyUrl);
        if(value.protocol!=='http:'||value.hostname!=='127.0.0.1'||!value.port)return null;
        return`${value.hostname}:${value.port}`;
    }catch{return null;}
}

function isCodexTarget(value:string):value is CodexRequestTargetHost{
    return (CODEX_REQUEST_TARGETS as readonly string[]).includes(value);
}

function candidateChains(connections:ClashConnection[],sourcePorts:Set<number>,targets:readonly CodexRequestTargetHost[]):ClashConnection[]{
    const allowed=new Set(targets);
    return connections.filter(connection=>
        isCodexTarget(connection.targetHost)&&allowed.has(connection.targetHost)&&connection.targetPort===443&&sourcePorts.has(connection.sourcePort));
}

/** Convert one bounded CFW observation into evidence. The caller must already
 * have verified that sourcePorts belongs to the DM-owned process identity. */
export function evidenceFromConnections(input:{
    process:CodexProcessInfo;proxyUrl:string;expectedNode:string;connections:ClashConnection[];sourcePorts:Set<number>;targetHosts?:readonly CodexRequestTargetHost[];
}):CodexRouteEvidence{
    const targets=input.targetHosts??CODEX_REQUEST_TARGETS;
    const candidates=candidateChains(input.connections,input.sourcePorts,targets);
    const base={processPid:input.process.pid,processIdentitySha256:input.process.identity?hash(input.process.identity):null,
        sourcePortSha256:null,proxyEndpoint:proxyEndpoint(input.proxyUrl),expectedNode:input.expectedNode,chains:[] as string[],
        targetHost:null as CodexRequestTargetHost|null,targetHosts:[] as CodexRequestTargetHost[],sourcePortCount:0};
    if(!input.process.identity)return{...base,path:'PROCESS_IDENTITY_UNVERIFIED',selectedNode:null};
    if(!base.proxyEndpoint)return{...base,path:'CFW_UNAVAILABLE',selectedNode:null};
    if(!candidates.length)return{...base,path:'PROCESS_ROUTE_NOT_OBSERVED',selectedNode:null};
    const sourcePorts=[...new Set(candidates.map(candidate=>candidate.sourcePort))].sort((a,b)=>a-b);
    const observedHosts:CodexRequestTargetHost[]=[];
    for(const candidate of candidates){
        const host=candidate.targetHost;
        if(isCodexTarget(host)&&!observedHosts.includes(host))observedHosts.push(host);
    }
    const targetHost=observedHosts[0]??null;
    const chains=candidates.map(candidate=>candidate.chains);
    if(chains.some(chain=>chain.length===0||JSON.stringify(chain)!==JSON.stringify(chains[0])))
        return{...base,path:'CONNECTION_AMBIGUOUS',selectedNode:null};
    const selected=candidates[0];
    const common={...base,targetHost,targetHosts:observedHosts,sourcePortCount:sourcePorts.length};
    if(!selected.chains.includes(input.expectedNode))
        return{...common,path:'NODE_MISMATCH',selectedNode:selected.chains[0]??null,chains:[...selected.chains]};
    return{...common,path:'REQUEST_ROUTE_VERIFIED',selectedNode:selected.chains[0]??null,chains:[...selected.chains],
        sourcePortSha256:hash(sourcePorts.join('\n'))};
}

export function classifyCodexTurnError(error:unknown):CodexRequestClassification{
    if(error instanceof RpcChildError){
        const evidence=error.evidence;
        if(evidence.policyRestricted)return'REGION_OR_POLICY_RESTRICTED';
        if(evidence.httpStatus===401||evidence.failureCategories.includes('UNAUTHORIZED'))return'HTTP_401_AUTHENTICATION_FAILED';
        if(evidence.httpStatus===403||evidence.failureCategories.includes('FORBIDDEN'))return'HTTP_403_PERMISSION_DENIED';
        if(evidence.httpStatus===429||evidence.failureCategories.includes('RATE_LIMIT'))return'HTTP_429_QUOTA_EXCEEDED';
        if(evidence.modelUnavailable||evidence.failureCategories.includes('MODEL_UNAVAILABLE'))return'MODEL_UNAVAILABLE';
        for(const classification of ['DNS_FAILURE','TLS_HANDSHAKE_FAILURE','PROXY_CONNECTION_RESET','TCP_CONNECTION_FAILURE','STREAM_INTERRUPTED'] as const)
            if(evidence.failureCategories.includes(classification))return classification;
        if(evidence.failureCategories.includes('NETWORK')||evidence.failureCategories.includes('DSH_HOST_TIMEOUT'))return'STREAM_INTERRUPTED';
    }
    const code=error instanceof DomainError?error.code:'';
    if(/MODEL_(?:NOT_LISTED|UNAVAILABLE)|CODEX_MODEL_NOT_LISTED/.test(code))return'MODEL_UNAVAILABLE';
    if(/TIMEOUT|INTERRUPTED|TRANSPORT_CLOSED/.test(code))return'STREAM_INTERRUPTED';
    if(/PROXY|RESET/.test(code))return'PROXY_CONNECTION_RESET';
    return'NOT_OBSERVED';
}

export function finalizeCodexRequestPath(input:{
    role:'planner2'|'reviewer';startedAt:string;completedAt:string;evidence:CodexRouteEvidence;
    classification:CodexRequestClassification;requestId:string|null;httpStatus?:number|null;
}):CodexRequestPathObservation{
    return{
        schema:'dream-maker.codex-request-path.v1',at:new Date().toISOString(),startedAt:input.startedAt,completedAt:input.completedAt,
        role:input.role,method:'turn/start',targetHost:input.evidence.targetHost,targetPort:443,path:input.evidence.path,
        targetHosts:[...input.evidence.targetHosts],sourcePortCount:input.evidence.sourcePortCount,
        processPid:input.evidence.processPid,processIdentitySha256:input.evidence.processIdentitySha256,
        sourcePortSha256:input.evidence.sourcePortSha256,proxyEndpoint:input.evidence.proxyEndpoint,
        selectedNode:input.evidence.selectedNode,expectedNode:input.evidence.expectedNode,chains:input.evidence.chains,
        classification:input.classification,httpStatus:input.httpStatus??null,
        requestIdSha256:input.requestId?hash(input.requestId):null,automaticRetryAllowed:false
    };
}

/** Resolve the exact bounded process tree created beneath the DM-owned app-server. */
export async function windowsCodexProcessIds(rootPid:number,cwd:string,signal?:AbortSignal):Promise<Set<number>>{
    if(process.platform!=='win32'||!Number.isSafeInteger(rootPid)||rootPid<1)return new Set();
    const script="$ErrorActionPreference='Stop';$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId);$rows|ConvertTo-Json -Compress";
    const result=await inspectOutsideExecutionScope(()=>capture('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{
        cwd,env:childEnv(),signal,timeoutMs:5000,maxBytes:1024*1024
    }));
    if(result.code!==0||!result.stdout.trim())return new Set();
    let value:unknown;
    try{value=JSON.parse(result.stdout);}catch{throw new DomainError('CODEX_PROCESS_TREE_OBSERVER_INVALID',502);}
    return new Set(descendantProcessIds(value,rootPid));
}

/** Read only the loopback source ports owned by the already verified process tree. */
export async function windowsProxySourcePorts(input:{pids:readonly number[];proxyPort:number;cwd:string;signal?:AbortSignal}):Promise<Set<number>>{
    return new Set((await windowsProxySourcePortOwners(input)).keys());
}

/** Retain the owner mapping in memory so a candidate port can be checked again
 * against the descendant start identities before it becomes persisted evidence. */
export async function windowsProxySourcePortOwners(input:{pids:readonly number[];proxyPort:number;cwd:string;signal?:AbortSignal}):Promise<Map<number,number>>{
    return (await windowsCodexTcpObservations(input)).proxyOwners;
}

export async function windowsCodexTcpObservations(input:{pids:readonly number[];proxyPort:number;cwd:string;signal?:AbortSignal}):Promise<WindowsTcpObservations>{
    const ids=[...new Set(input.pids)].filter(pid=>Number.isSafeInteger(pid)&&pid>=1&&pid<=2147483647).slice(0,64);
    if(process.platform!=='win32'||!ids.length||!Number.isInteger(input.proxyPort)||input.proxyPort<1||input.proxyPort>65535)
        return{proxyOwners:new Map(),directOwners:new Map()};
    const result=await inspectOutsideExecutionScope(()=>capture('netstat.exe',['-ano','-p','tcp'],{
        cwd:input.cwd,env:childEnv(),signal:input.signal,timeoutMs:4000,maxBytes:2*1024*1024
    }));
    if(result.code!==0)return{proxyOwners:new Map(),directOwners:new Map()};
    return parseWindowsNetstatProcessObservations(result.stdout,new Set(ids),input.proxyPort);
}

/** Parse `netstat -ano -p tcp` without retaining endpoint text. */
export function parseWindowsNetstatSourcePorts(raw:string,pids:Set<number>,proxyPort:number):Set<number>{
    return new Set(parseWindowsNetstatSourcePortOwners(raw,pids,proxyPort).keys());
}

export function parseWindowsNetstatSourcePortOwners(raw:string,pids:Set<number>,proxyPort:number):Map<number,number>{
    return parseWindowsNetstatProcessObservations(raw,pids,proxyPort).proxyOwners;
}

export function parseWindowsNetstatProcessObservations(raw:string,pids:Set<number>,proxyPort:number):WindowsTcpObservations{
    if(typeof raw!=='string'||raw.length>2*1024*1024||!Number.isInteger(proxyPort)||proxyPort<1||proxyPort>65535)
        return{proxyOwners:new Map(),directOwners:new Map()};
    const proxyOwners=new Map<number,number>(),directOwners=new Map<number,number>();
    for(const line of raw.split(/\r?\n/)){
        if(proxyOwners.size+directOwners.size>=128)break;
        const columns=line.trim().split(/\s+/);
        if(columns.length<5||columns[0].toUpperCase()!=='TCP'||columns[3].toUpperCase()!=='ESTABLISHED')continue;
        const owner=Number(columns[columns.length-1]),local=columns[1],remote=columns[2];
        if(!Number.isSafeInteger(owner)||!pids.has(owner))continue;
        const localPort=Number(local.slice(local.lastIndexOf(':')+1));
        const bracketed=remote.startsWith('[')&&remote.includes(']:'),lastColon=remote.lastIndexOf(':');
        const remoteAddress=(bracketed?remote.slice(1,remote.indexOf(']')):remote.slice(0,lastColon)).toLowerCase().replace(/^::ffff:/,'');
        const remotePort=Number(remote.slice(lastColon+1));
        if(!Number.isInteger(localPort)||localPort<1||localPort>65535||!Number.isInteger(remotePort)||remotePort<1||remotePort>65535)continue;
        if(['127.0.0.1','::1'].includes(remoteAddress)){
            if(remotePort===proxyPort)proxyOwners.set(localPort,owner);
        }else if(!['0.0.0.0','::'].includes(remoteAddress)){
            directOwners.set(localPort,owner);
        }
    }
    return{proxyOwners,directOwners};
}

export function sourcePortsWithStableOwners(
    owners:ReadonlyMap<number,number>,
    expected:ReadonlyMap<number,string>,
    current:ReadonlyMap<number,string>
):Set<number>{
    const result=new Set<number>();
    for(const [port,pid] of owners){
        const expectedIdentity=expected.get(pid),currentIdentity=current.get(pid);
        if(expectedIdentity&&currentIdentity===expectedIdentity)result.add(port);
    }
    return result;
}

/** Any direct socket owned by the bounded process tree is a fail-closed CFW bypass.
 * Start identities are still required before positive proxy attribution, but they
 * are not a reason to hide a newly observed direct socket. */
export function directRouteObserved(
    owners:ReadonlyMap<number,number>,
    boundedProcessIds:ReadonlySet<number>
):boolean{
    for(const pid of owners.values())if(boundedProcessIds.has(pid))return true;
    return false;
}

/** Read current Windows start identities in one bounded native call. */
export async function windowsProcessIdentities(input:{pids:readonly number[];cwd:string;signal?:AbortSignal}):Promise<Map<number,string>>{
    const ids=[...new Set(input.pids)].filter(pid=>Number.isSafeInteger(pid)&&pid>=1&&pid<=2147483647).slice(0,64);
    if(process.platform!=='win32'||!ids.length)return new Map();
    const script=[
        "$ErrorActionPreference='SilentlyContinue'",
        `$ids=@(${ids.join(',')})`,
        '$live=@(Get-Process -Id $ids | ForEach-Object {[pscustomobject]@{pid=[int]$_.Id;identity=(\'win32:\'+[string]$_.StartTime.ToUniversalTime().Ticks)}})',
        '$live|ConvertTo-Json -Compress -Depth 3'
    ].join(';');
    const result=await inspectOutsideExecutionScope(()=>capture('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{
        cwd:input.cwd,env:childEnv(),signal:input.signal,timeoutMs:5000,maxBytes:256*1024
    }));
    if(result.code!==0||!result.stdout.trim())return new Map();
    let raw:unknown;
    try{raw=JSON.parse(result.stdout);}catch{return new Map();}
    const rows=Array.isArray(raw)?raw:[raw],identities=new Map<number,string>();
    for(const item of rows){
        if(!item||typeof item!=='object'||Array.isArray(item))continue;
        const value=item as Record<string,unknown>,pid=Number(value.pid),identity=value.identity;
        if(Number.isSafeInteger(pid)&&pid>0&&pid<=2147483647&&typeof identity==='string'&&/^win32:\d+$/.test(identity)&&!identities.has(pid))identities.set(pid,identity);
    }
    return identities;
}

/** Poll the controller while the turn is in flight. Missing evidence is a
 * refusal to claim a route, not a reason to change the model result. */
export async function probeCodexRoute(input:ProbeCodexRouteInput):Promise<CodexRouteEvidence>{
    const endpoint=proxyEndpoint(input.proxyUrl);
    const base={processPid:input.process.pid,processIdentitySha256:input.process.identity?hash(input.process.identity):null,
        sourcePortSha256:null,proxyEndpoint:endpoint,expectedNode:input.expectedNode,chains:[] as string[],
        targetHost:null as CodexRequestTargetHost|null,targetHosts:[] as CodexRequestTargetHost[],sourcePortCount:0};
    if(!endpoint)return{...base,path:'CFW_UNAVAILABLE',selectedNode:null};
    if(!input.process.identity)return{...base,path:'PROCESS_IDENTITY_UNVERIFIED',selectedNode:null};
    const proxyPort=Number(new URL(input.proxyUrl).port);
    const cwd=process.cwd();
    let observedProcessIds=new Set<number>([
        input.process.pid,
        ...(input.process.descendantPids??[]).filter(pid=>Number.isSafeInteger(pid)&&pid>=1&&pid<=2147483647)
    ]);
    const expectedIdentities=new Map<number,string>(
        (input.process.descendantIdentities??[])
            .filter(item=>observedProcessIds.has(item.pid))
            .map(item=>[item.pid,item.identity])
    );
    if(!expectedIdentities.size){
        observedProcessIds=await windowsCodexProcessIds(input.process.pid,cwd,input.signal);
        for(const [pid,identity] of await windowsProcessIdentities({pids:[...observedProcessIds],cwd,signal:input.signal}))
            expectedIdentities.set(pid,identity);
    }
    if(expectedIdentities.get(input.process.pid)!==input.process.identity)return{...base,path:'PROCESS_IDENTITY_UNVERIFIED',selectedNode:null};
    const deadline=Date.now()+(input.timeoutMs??12000);
    let nextProcessRefreshAt=0;
    do{
        if(input.signal?.aborted)throw input.signal.reason??new DomainError('CLASH_REQUEST_ABORTED',409);
        if(Date.now()>=nextProcessRefreshAt){
            // app-server can create its network-capable child after initialize.
            // Refresh within the same bounded loop, then pin each new descendant
            // to its Windows StartTime before any source port can be attributed.
            const currentTree=await windowsCodexProcessIds(input.process.pid,cwd,input.signal);
            if(currentTree.size){
                const currentIdentities=await windowsProcessIdentities({pids:[...currentTree],cwd,signal:input.signal});
                if(currentIdentities.get(input.process.pid)!==input.process.identity)
                    return{...base,path:'PROCESS_IDENTITY_UNVERIFIED',selectedNode:null};
                for(const pid of currentTree){
                    const identity=currentIdentities.get(pid);
                    if(!identity)continue;
                    const prior=expectedIdentities.get(pid);
                    if(prior===undefined)expectedIdentities.set(pid,identity);
                    else if(prior!==identity)expectedIdentities.delete(pid);
                }
                const merged=[input.process.pid,...observedProcessIds,...currentTree];
                observedProcessIds=new Set(merged.filter(pid=>pid===input.process.pid||expectedIdentities.has(pid)).slice(0,64));
            }
            nextProcessRefreshAt=Date.now()+1500;
        }
        const tcp=await windowsCodexTcpObservations({pids:[...observedProcessIds],proxyPort,cwd,signal:input.signal});
        if(tcp.directOwners.size){
            const currentRootIdentities=await windowsProcessIdentities({pids:[input.process.pid],cwd,signal:input.signal});
            if(currentRootIdentities.get(input.process.pid)!==input.process.identity)
                return{...base,path:'PROCESS_IDENTITY_UNVERIFIED',selectedNode:null};
            if(directRouteObserved(tcp.directOwners,observedProcessIds))
                return{...base,path:'DIRECT_ROUTE_OBSERVED',selectedNode:null};
        }
        const sourceOwners=tcp.proxyOwners;
        if(sourceOwners.size){
            // Capture the CFW connection first so a short request is not missed,
            // then prove every candidate owner still has the same start identity.
            const connections=await input.controller.connections(input.signal);
            const currentIdentities=await windowsProcessIdentities({pids:[input.process.pid,...sourceOwners.values()],cwd,signal:input.signal});
            if(currentIdentities.get(input.process.pid)!==input.process.identity)return{...base,path:'PROCESS_IDENTITY_UNVERIFIED',selectedNode:null};
            const revalidated=sourcePortsWithStableOwners(sourceOwners,expectedIdentities,currentIdentities);
            if(revalidated.size){
                const evidence=evidenceFromConnections({process:input.process,proxyUrl:input.proxyUrl,expectedNode:input.expectedNode,connections,sourcePorts:revalidated,targetHosts:input.targetHosts});
                if(evidence.path!=='PROCESS_ROUTE_NOT_OBSERVED')return evidence;
            }
        }
        await sleep(250,input.signal);
    }while(Date.now()<deadline);
    return{...base,path:'PROCESS_ROUTE_NOT_OBSERVED',selectedNode:null};
}
