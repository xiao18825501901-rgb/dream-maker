import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { capture } from '../process.js';
import { currentProcessOwnership,inspectOutsideExecutionScope } from '../flow/process-ownership.js';
import { codexLaunch,type CodexLaunch,type WslProxyBinding,wslProxyArgumentAssignments } from './codex-transport.js';
import { DomainError,childEnv,hash,id,object,now } from '../security.js';
import type { Config } from '../../shared/types.js';
import type { RpcPeer } from './rpc.js';

const MARKER_ROOT='/opt/dream-maker-controller/owned-role-processes-revamp';
const controllerPath=(v:unknown)=>typeof v==='string'&&/^\/opt\/dream-maker-controller\/(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+$/.test(v)&&!v.split('/').some(p=>p==='.'||p==='..');
export interface OwnedCodexBinding {markerId:string;home:string;cwd:string;binarySha256?:string}
/** Validate the fixed controller helper's bytes, never a model's claimed cleanup boolean. A group
 * receipt covers the trusted, tool-disabled CLI only; the independent OS policy still owns sandboxing. */
export function validateOwnedCodexStatus(raw:unknown,binding:OwnedCodexBinding,pinned?:string,requireEmpty=false){
    const value=object(raw),marker=object(value.marker),cleanup=object(value.cleanup);
    if(value.schema!=='dream-maker.owned-codex-status.v1'||value.readOnly!==true||value.modelTurnsRequested!==0||
        marker.schema!=='dream-maker.owned-codex.v1'||marker.markerId!==binding.markerId||
        !Number.isSafeInteger(marker.pid)||Number(marker.pid)<1||marker.pid!==marker.groupId||marker.pid!==marker.sessionId||
        typeof marker.startTicks!=='string'||!/^\d+$/.test(marker.startTicks)||typeof marker.bootId!=='string'||!marker.bootId||
        typeof marker.pidNamespace!=='string'||!/^pid:\[\d+\]$/.test(marker.pidNamespace)||
        marker.homeSha256!==hash(binding.home)||marker.cwdSha256!==hash(binding.cwd)||
        typeof marker.binarySha256!=='string'||!/^[a-f0-9]{64}$/.test(marker.binarySha256)||binding.binarySha256&&marker.binarySha256!==binding.binarySha256||
        value.markerSha256!==hash(marker)||pinned&&value.markerSha256!==pinned||
        !Array.isArray(value.members)||value.members.some(v=>!Number.isSafeInteger(v)||v<1))throw new DomainError('CODEX_OWNED_PROCESS_BINDING_UNVERIFIED',409);
    if(requireEmpty&&(!pinned||cleanup.proven!==true||value.members.length||!['SCOPED_PROCESS_GROUP_EMPTY','PREVIOUS_KERNEL_ENDED'].includes(String(cleanup.reason))))throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);
    return {marker,markerSha256:String(value.markerSha256),members:value.members as number[],cleanup};
}
export class OwnedCodexSession {
    readonly markerId=id('owned_codex');readonly helper:string;readonly helperSha256:string;readonly launch:CodexLaunch;
    private pinned='';private binarySha256='';private ownership=currentProcessOwnership();
    private processId:string|undefined;
    cleanupEvidence:Record<string,unknown>|undefined;
    constructor(private config:Config,private root:string,workspace:string,private wslProxy?:WslProxyBinding){
        codexLaunch(config,workspace);const c=config.codex;
        if((c.transport??'stdio')!=='wsl'||c.wslDistro!=='DreamMaker-Acceptance-F-20261101-R2'||![c.wslBinary,c.wslHome,c.wslCwdRoot].every(controllerPath))throw new DomainError('CODEX_OWNED_CONTROLLER_SCOPE_REQUIRED',409);
        this.helper=readFileSync(resolve(root,'scripts/isolation/codex-owned-process.py'),'utf8');this.helperSha256=hash(this.helper);
        this.launch={command:c.wslCommand||'wsl.exe',args:this.argv(['exec',MARKER_ROOT,this.markerId,c.wslBinary!,c.wslHome!,c.wslCwdRoot!,'app-server'],true),cwd:undefined,transport:'wsl'};
        this.record('OwnedCodexIntent',{markerId:this.markerId,markerRoot:MARKER_ROOT,distro:c.wslDistro,helperSha256:this.helperSha256,binaryPathSha256:hash(c.wslBinary),homeSha256:hash(c.wslHome),cwdSha256:hash(c.wslCwdRoot),modelTurnStarted:false});
    }
    private argv(args:string[],includeProxy=false){
        return ['-d',this.config.codex.wslDistro!,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin',
            ...(includeProxy&&this.wslProxy?wslProxyArgumentAssignments(this.wslProxy):[]),
            '/usr/bin/python3','-c',this.helper,...args];
    }
    bindProcess(processId:string|undefined){this.processId=processId;this.record('OwnedCodexProcessBound',{markerId:this.markerId,helperSha256:this.helperSha256});}
    private record(kind:string,value:Record<string,unknown>){const b=this.ownership;b?.store.record(kind,b.projectId,b.runId,{...value,processId:this.processId,dispatchId:b.dispatchId,generation:b.generation,at:now()});}
    private async status(){
        const result=await inspectOutsideExecutionScope(()=>capture(this.launch.command,this.argv(['status',MARKER_ROOT,this.markerId,...(this.pinned?[this.pinned]:[])]),{cwd:this.root,env:childEnv(),timeoutMs:15000,maxBytes:30000}));
        if(result.code!==0)throw new DomainError('CODEX_OWNED_PROCESS_STATUS_UNAVAILABLE',409);
        let raw;try{raw=JSON.parse(result.stdout);}catch{throw new DomainError('CODEX_OWNED_PROCESS_STATUS_INVALID',409);}
        return validateOwnedCodexStatus(raw,{markerId:this.markerId,home:this.config.codex.wslHome!,cwd:this.config.codex.wslCwdRoot!,...(this.binarySha256?{binarySha256:this.binarySha256}:{})},this.pinned||undefined);
    }
    /** Pin before account/thread/turn requests. No login or model side effects are performed here. */
    async pin(){if(this.pinned)return;const status=await this.status();this.pinned=status.markerSha256;this.binarySha256=String(status.marker.binarySha256);
        this.record('OwnedCodexPinned',{markerId:this.markerId,marker:status.marker,markerSha256:this.pinned,helperSha256:this.helperSha256,modelTurnStarted:false});}
    async finish(peer:RpcPeer){
        // Closing stdin lets the actual Linux server exit. Killing wsl.exe alone is not Linux cleanup.
        await peer.finish();if(!this.pinned)await this.pin();const status=await this.status();
        const raw={schema:'dream-maker.owned-codex-status.v1',...status,readOnly:true,modelTurnsRequested:0};
        validateOwnedCodexStatus(raw,{markerId:this.markerId,home:this.config.codex.wslHome!,cwd:this.config.codex.wslCwdRoot!,binarySha256:this.binarySha256},this.pinned,true);
        this.record('OwnedCodexClosed',{markerId:this.markerId,markerSha256:this.pinned,helperSha256:this.helperSha256,cleanup:status.cleanup,remainingMembers:status.members,scope:'TRUSTED_TOOL_DISABLED_CLI_GROUP_NOT_SANDBOX'});
        this.cleanupEvidence={markerId:this.markerId,markerSha256:this.pinned,helperSha256:this.helperSha256,binarySha256:this.binarySha256,cleanup:status.cleanup,remainingMembers:status.members,scope:'TRUSTED_TOOL_DISABLED_CLI_GROUP_NOT_SANDBOX'};
        peer.proveCleanup({kind:'TRUSTED_WSL_CODEX_GROUP',scopeId:this.markerId,receiptSha256:hash(raw)});
    }
}
