import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { capture } from '../process.js';
import { childEnv, DomainError } from '../security.js';
import type { Config } from '../../shared/types.js';
import type { WslProxyReachability } from '../../shared/network-contexts.js';
import {
    loopbackProxyPortFromEnvironment,
    parseWslProxyBinding,
    type WslProxyBinding
} from './codex-transport.js';

const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

function privateGateway(value:unknown): value is string {
    if (typeof value !== 'string') return false;
    const parts = value.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false;
    const numbers = parts.map(Number);
    if (numbers.some(part => part < 0 || part > 255)) return false;
    return numbers[0] === 10 ||
        (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) ||
        (numbers[0] === 192 && numbers[1] === 168);
}

/** Validate the read-only WSL helper's result before it can alter a child
 * environment. A TCP-only success is deliberately not an inference claim. */
export function wslProxyBindingFromObservation(raw:unknown, expectedPort:number):WslProxyBinding {
    const value = raw as Partial<WslProxyReachability> | null;
    if (!value || typeof value !== 'object' ||
        value.schema !== 'dream-maker.wsl-proxy-reachability.v1' ||
        value.state !== 'TCP_REACHABLE_ONLY' ||
        !privateGateway(value.gateway) ||
        value.port !== expectedPort ||
        value.routeSource !== 'WSL_DEFAULT_ROUTE' ||
        value.networkPayloadBytes !== 0 ||
        value.httpRequests !== 0 ||
        value.tlsHandshakes !== 0 ||
        value.modelCalls !== 0 ||
        value.filesWritten !== 0 ||
        typeof value.elapsedMs !== 'number' ||
        !Number.isFinite(value.elapsedMs) ||
        value.elapsedMs < 0 ||
        value.elapsedMs > 5000) {
        throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED', 409);
    }
    return parseWslProxyBinding(`http://${value.gateway}:${expectedPort}/`);
}

/**
 * Resolve the CFW mixed-port lease into a WSL-reachable gateway. This invokes
 * only the existing bounded TCP-only helper; it sends no HTTP, TLS, auth or
 * model request and never changes the Clash selector.
 */
export async function resolveWslProxyBinding(
    config:Config,
    root:string,
    environment:NodeJS.ProcessEnv,
    signal?:AbortSignal
):Promise<WslProxyBinding> {
    const c=config.codex;
    if((c.transport??'stdio')!=='wsl')throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    return resolveWslProxyBindingForDistro(c.wslDistro??'',root,environment,{wslCommand:c.wslCommand,signal});
}

/**
 * Resolve one lease-bound Windows loopback proxy port into a private host
 * gateway for an explicitly selected DM-owned distro. The helper sends no HTTP,
 * TLS, authentication or model traffic and never mutates the CFW selector.
 */
export async function resolveWslProxyBindingForDistro(
    distro:string,
    root:string,
    environment:NodeJS.ProcessEnv,
    options:{wslCommand?:string;signal?:AbortSignal}={}
):Promise<WslProxyBinding> {
    if(!DISTRO.test(distro))throw new DomainError('CODEX_WSL_DISTRO_INVALID',409);
    const port=loopbackProxyPortFromEnvironment(environment);
    if(port===null)throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    const helperPath=resolve(root,'scripts/isolation/wsl-proxy-reachability.py');
    let info;
    try{info=lstatSync(helperPath);}catch{throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);}
    if(!info.isFile()||info.isSymbolicLink()||info.size>32768)
        throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    const source=readFileSync(helperPath,'utf8');
    if(Buffer.byteLength(source)>32768)throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    let result;
    try{
        result=await capture(options.wslCommand||'wsl.exe',
            ['-d',distro,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-I','-c',source],
            {cwd:root,env:childEnv(),input:JSON.stringify({port}),signal:options.signal,timeoutMs:8000,maxBytes:4096});
    }catch(error){
        if(error instanceof DomainError&&error.code==='PROCESS_CANCELLED')throw error;
        throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    }
    if(result.code!==0)throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);
    let raw:unknown;
    try{raw=JSON.parse(result.stdout);}catch{throw new DomainError('CODEX_WSL_PROXY_BINDING_UNVERIFIED',409);}
    return wslProxyBindingFromObservation(raw,port);
}
