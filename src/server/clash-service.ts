import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readdir,lstat } from 'node:fs/promises';
import type { Config, Role } from '../shared/types.js';
import { DomainError, childEnv, jsonFetch,hash,networkFailureFromResponse,networkFailureError } from './security.js';
import { ClashController, SelectionLeaseManager, isConcreteProxy, parseClashConfig, type TunnelIdentity } from './clash-route.js';
import { clashFetch, clashResearchFetch, diagnoseClashRoute, probeOpenAiTls, probeCodexTls, probeCodexControlTls, probeDeepSeekTls } from './clash-transport.js';
import {observeLocalProxyHealth} from './network-local-health.js';
import {
    classifyNetworkResponse,
    classifyNetworkFailure,
    classifyRoutedResponse,
    isInferenceTarget,
    type NetworkFailureEvidence
} from './network-failure.js';
import {
    CODEX_CONTROL_TARGET_HOSTS,
    type CodexControlTargetHost,
    type LocalProxyHealth,
    type OpenAiTlsProbe,
    type RoutedRequestObservation,
    type RoutedRequestRole
} from '../shared/network-contexts.js';
import { observeRoutedResponse } from './routed-response-observer.js';
import { probeCodexRoute,type CodexProcessInfo,type CodexRouteEvidence } from './codex-network-path.js';

type RoutedTransport = (
    input: {
        proxyUrl: string;
        expectedNode: string;
        controller: ClashController;
        onRoute?: (evidence: { selectedNode: string; chains: string[] }) => void;
    },
    url: string | URL | Request,
    init: RequestInit
) => Promise<Response>;

/** Local service control traffic must not be sent through the external CFW proxy. */
function isDirectLoopbackTarget(value: string | URL | Request): boolean {
    try {
        const url = new URL(value instanceof Request ? value.url : String(value));
        return (url.protocol === 'http:' || url.protocol === 'https:') &&
            (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1') &&
            !url.username && !url.password;
    } catch {
        return false;
    }
}

export function controlledProxyEnvironment(base: NodeJS.ProcessEnv, proxyUrl: string): NodeJS.ProcessEnv {
    let proxy: URL;
    try { proxy = new URL(proxyUrl); } catch { throw new DomainError('CLASH_PROXY_URL_INVALID', 409); }
    if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port ||
        proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash)
        throw new DomainError('CLASH_PROXY_LOOPBACK_REQUIRED', 409);
    const normalized = proxy.href, bypass = 'localhost,127.0.0.1,::1,[::1]';
    return {
        ...base,
        HTTP_PROXY: normalized,
        http_proxy: normalized,
        HTTPS_PROXY: normalized,
        https_proxy: normalized,
        ALL_PROXY: normalized,
        all_proxy: normalized,
        NO_PROXY: bypass,
        no_proxy: bypass
    };
}

export class ClashService {
    private readonly processStartedAt = new Date().toISOString();
    private active: { controller: ClashController; proxyUrl: string; expectedNode: string; selectionPolicy: 'pinned' | 'current' } | null = null;
    private routedEvidence = new WeakMap<Response, { selectedNode: string; chains: string[] }>();
    constructor(private getConfig: () => Config, private stateDirectory: string,
        private recordRequest?: (observation: RoutedRequestObservation) => void,
        private stabilityProbe?: (input: {
            proxyUrl: string;
            expectedNode: string;
            controller: ClashController;
            signal: AbortSignal;
        }) => Promise<LocalProxyHealth>,
        private routedTransport: RoutedTransport = clashFetch,
        private researchRoutedTransport: RoutedTransport = clashResearchFetch) { }
    private binding() {
        const config = this.getConfig().clash, path = resolve(config.configPath);
        let info;
        try { info = lstatSync(path); } catch { throw new DomainError('CLASH_CONFIG_NOT_FOUND', 409); }
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new DomainError('CLASH_CONFIG_FILE_DENIED', 409);
        const bytes=readFileSync(path),parsed = parseClashConfig(bytes.toString('utf8'));
        const controller = new ClashController(parsed.controllerUrl, parsed.secret);
        return { config, controller, proxyUrl: parsed.proxyUrl, allowLan: parsed.allowLan, bindAddress: parsed.bindAddress,
            configurationFingerprint:hash({path,source:hash(bytes)}),lease: new SelectionLeaseManager({ controller, stateDirectory: this.stateDirectory }) };
    }
    async inspect(signal?: AbortSignal) {
        const configured = this.getConfig().clash;
        const unavailable = (status: string) => ({ enabled: configured.enabled, status, configured: { selector: configured.selector, node: configured.node, expectedMode: configured.expectedMode }, controller: null, selectors: [], nodes: [], recoveryRequired: status.includes('RECOVERY') });
        try {
            const binding = this.binding(), observed = await binding.controller.inspect(signal), pending = configured.selector ? await binding.lease.pending(configured.selector) : null;
            return {
                enabled: configured.enabled,
                status: pending ? 'RECOVERY_REQUIRED' : configured.enabled ? 'CONTROLLER_OBSERVED_ROUTE_UNVERIFIED' : 'CONTROLLER_OBSERVED_DISABLED',
                configured: { selector: configured.selector, node: configured.node, selectionPolicy: configured.selectionPolicy, expectedMode: configured.expectedMode },
                controller: { version: observed.version, mode: observed.config.mode, mixedPort: observed.config.mixedPort,
                    allowLan: observed.config.allowLan, bindAddress: binding.bindAddress,
                    controllerPort: Number(new URL(binding.controller.endpoint).port) },
                selectors: observed.selectors.map(selector => ({ name: selector.name, now: selector.now ?? '', members: (selector.all ?? []).filter(name => observed.nodes.some(node => node.name === name)) })),
                nodes: observed.nodes.map(node => ({ name: node.name, type: node.type })),
                recoveryRequired: Boolean(pending),
                evidence: observed.evidence
            };
        } catch (error) {
            if (error instanceof DomainError) return unavailable(error.code);
            throw error;
        }
    }
    /** Read-only correlation for a controller-owned diagnostic tunnel. */
    traceConnection(identity:TunnelIdentity,signal?:AbortSignal){
        return this.binding().controller.traceConnection(identity,signal);
    }
    async verify(signal?: AbortSignal) {
        if (!this.getConfig().clash.enabled) throw new DomainError('CLASH_ROUTE_DISABLED', 409);
        const binding = this.binding(), { config } = binding;
        if (!config.selector) throw new DomainError('CLASH_ROUTE_SELECTION_REQUIRED', 409);
        if (config.selectionPolicy === 'current') {
            const observed = await binding.lease.withObservedSelection({
                group: config.selector,
                expectedMode: config.expectedMode,
                owner: { dmRunId: 'diagnostic-current', processStartedAt: this.processStartedAt },
                signal
            }, async lease => {
                await lease.assertCurrent();
                return diagnoseClashRoute({ proxyUrl: binding.proxyUrl, expectedNode: lease.node, controller: binding.controller, signal });
            });
            return { ...observed.result, selectedNode: observed.selection, restored: false, selectorMutation: false, checkedAt: new Date().toISOString() };
        }
        if (!config.node) throw new DomainError('CLASH_ROUTE_SELECTION_REQUIRED', 409);
        const proxies = await binding.controller.proxies(signal);
        if (!isConcreteProxy(proxies[config.node])) throw new DomainError('CLASH_CONCRETE_NODE_REQUIRED', 409);
        const leased = await binding.lease.withSelection({ group: config.selector, node: config.node, expectedMode: config.expectedMode, mutationScope: 'shared-selector', owner: { dmRunId: 'diagnostic', processStartedAt: this.processStartedAt }, signal }, async lease => {
            await lease.assertCurrent();
            return diagnoseClashRoute({ proxyUrl: binding.proxyUrl, expectedNode: config.node, controller: binding.controller, signal });
        });
        return { ...leased.result, restored: leased.restored, checkedAt: new Date().toISOString() };
    }
    /** Existing controller/endpoint only: read-only selection custody, TCP and TLS; no HTTP request. */
    async observeLocalStability(signal:AbortSignal){
        const binding=this.binding();
        const observe=async(expectedNode:string)=>{
            const tlsProbe=(target:'api.openai.com'|'chatgpt.com'|'api.deepseek.com'|CodexControlTargetHost)=>async()=>{
                try{
                    const input={proxyUrl:binding.proxyUrl,configuredNode:expectedNode,controller:binding.controller,signal};
                    return target==='api.openai.com'?await probeOpenAiTls(input):
                        target==='chatgpt.com'?await probeCodexTls(input):
                        target==='api.deepseek.com'?await probeDeepSeekTls(input):await probeCodexControlTls(input,target);
                }
                catch(error){
                    if(signal.aborted)throw error;
                    const code=typeof(error as {code?:unknown})?.code==='string'?String((error as {code:string}).code):'TLS_PROBE_FAILED';
                    const state=/CONNECT_REJECTED|CONNECT_PROTOCOL|PROXY_AUTH/.test(code)?'CONNECT_REJECTED' as const:
                        /TLS|CERT|SSL|ALTNAME/.test(code)?'TLS_FAILED' as const:
                        /TIMEOUT/.test(code)?'TIMEOUT' as const:'FAILED' as const;
                    return{state,target:`${target}:443` as OpenAiTlsProbe['target'],protocol:null,authorized:false,alpn:null,elapsedMs:null,selectedNode:null,
                        selectionMatchesExpected:null,nodeChainMatched:false,errorClass:/^[A-Z0-9_]{1,80}$/.test(code)?code:'TLS_PROBE_FAILED',httpRequestSent:false as const,modelCalls:0 as const};
                }
            };
            const health=this.stabilityProbe
                ? await this.stabilityProbe({proxyUrl:binding.proxyUrl,expectedNode,controller:binding.controller,signal})
                : await observeLocalProxyHealth({
                    proxyUrl:binding.proxyUrl,
                    controller:binding.controller,
                    signal,
                    tlsProbe:tlsProbe('api.openai.com'),
                    codexTlsProbe:tlsProbe('chatgpt.com'),
                    codexControlTlsProbes:{
                        'ws.chatgpt.com':tlsProbe('ws.chatgpt.com'),
                        'codex-cloud-backend.chatgpt.com':tlsProbe('codex-cloud-backend.chatgpt.com'),
                        'codex-cloud-environments.chatgpt.com':tlsProbe('codex-cloud-environments.chatgpt.com')
                    },
                    deepSeekTlsProbe:tlsProbe('api.deepseek.com')
                });
            if(this.configurationFingerprint()!==binding.configurationFingerprint)throw new DomainError('NETWORK_CONFIGURATION_CHANGED',409);
            return{...health,endpointFingerprint:binding.configurationFingerprint};
        };
        if(this.active)return observe(this.active.expectedNode);
        if((binding.config.selectionPolicy??'pinned')==='current'){
            if(!binding.config.selector)throw new DomainError('CLASH_ROUTE_SELECTION_REQUIRED',409);
            const checked=await binding.lease.withObservedSelection({
                group:binding.config.selector,
                expectedMode:binding.config.expectedMode,
                owner:{dmRunId:'diagnostic-local-check',processStartedAt:this.processStartedAt},
                signal
            },async lease=>{
                await lease.assertCurrent();
                return observe(lease.node);
            });
            return checked.result;
        }
        if(!binding.config.node)throw new DomainError('CLASH_ROUTE_SELECTION_REQUIRED',409);
        return observe(binding.config.node);
    }
    /** Effective existing file identity; never returns controller credentials. */
    configurationFingerprint():string{
        try{return this.binding().configurationFingerprint;}catch(error){return hash({path:this.getConfig().clash.configPath,unavailable:error instanceof DomainError?error.code:'UNAVAILABLE'});}
    }
    async recover() {
        const binding = this.binding(), group = binding.config.selector;
        if (!group) throw new DomainError('CLASH_ROUTE_SELECTION_REQUIRED', 409);
        return binding.lease.recover(group, this.processStartedAt);
    }
    /** No controller mutation. The existing lease protocol removes a lock only after restoration.
     * Check the original state root even when the current UI choice has changed or is disabled. */
    async assertRecovered(){
        if(this.active)throw new DomainError('CLASH_ROUTE_ALREADY_ACTIVE',409);
        let names:string[];try{names=await readdir(this.stateDirectory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{scope:'OWNED_CLASH_JOURNALS',pendingLocks:0};throw error;}
        if(names.length>256||(await lstat(this.stateDirectory)).isSymbolicLink()||names.some(name=>name.startsWith('selection-')&&name.endsWith('.lock')))throw new DomainError('CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY',409);
        return {scope:'OWNED_CLASH_JOURNALS',pendingLocks:0};
    }
    async withRun<T>(runId: string, signal: AbortSignal, action: () => Promise<T>,onRestored?:()=>void): Promise<T> {
        if (!this.getConfig().clash.enabled) {try{return await action();}finally{onRestored?.();}}
        if (this.active) throw new DomainError('CLASH_ROUTE_ALREADY_ACTIVE', 409);
        const binding = this.binding(), { config } = binding;
        if (!config.selector) throw new DomainError('CLASH_ROUTE_SELECTION_REQUIRED', 409);
        if ((config.selectionPolicy ?? 'pinned') === 'current') {
            const observed = await binding.lease.withObservedSelection({
                group: config.selector,
                expectedMode: config.expectedMode,
                owner: { dmRunId: runId, processStartedAt: this.processStartedAt },
                signal,
                onReleased: onRestored
            }, async lease => {
                await lease.assertCurrent();
                this.active = { controller: binding.controller, proxyUrl: binding.proxyUrl, expectedNode: lease.node, selectionPolicy: 'current' };
                try { return await action(); } finally { this.active = null; }
            });
            return observed.result;
        }
        if (!config.node) throw new DomainError('CLASH_ROUTE_SELECTION_REQUIRED', 409);
        const leased = await binding.lease.withSelection({ group: config.selector, node: config.node, expectedMode: config.expectedMode, mutationScope: 'shared-selector', owner: { dmRunId: runId, processStartedAt: this.processStartedAt }, signal,onRestored }, async lease => {
            await lease.assertCurrent();
            await diagnoseClashRoute({ proxyUrl: binding.proxyUrl, expectedNode: config.node, controller: binding.controller, signal });
            this.active = { controller: binding.controller, proxyUrl: binding.proxyUrl, expectedNode: config.node, selectionPolicy: 'pinned' };
            try { return await action(); } finally { this.active = null; }
        });
        return leased.result;
    }
    /**
     * Reuse a role/Engine lease already active for the caller; otherwise create
     * one owned lease for a controller-only process. This avoids nested leases
     * while still making an out-of-run Magpie/account check fail closed.
     */
    async withRunOrActive<T>(runId:string,signal:AbortSignal,action:()=>Promise<T>,onRestored?:()=>void):Promise<T>{
        if(this.active)return action();
        return this.withRun(runId,signal,action,onRestored);
    }
    private async routedFetch(url: string | URL | Request, init: RequestInit = {}, recordGenericResponse = false, role?: RoutedRequestRole): Promise<Response> {
        return this.routedFetchWithTransport(url,init,recordGenericResponse,role,this.routedTransport);
    }
    private async routedFetchWithTransport(url:string|URL|Request,init:RequestInit={},recordGenericResponse=false,role?:RoutedRequestRole,transport:RoutedTransport=this.routedTransport):Promise<Response>{
        // Magpie, DSH and the original local gateways communicate over loopback.
        // CFW is only for the external model connection, never for these local
        // service calls. Keep this check before any lease/controller work so a
        // loopback request cannot be accidentally wrapped in a proxy route.
        if (isDirectLoopbackTarget(url)) return fetch(url, { ...init, redirect: 'error' });
        const binding = this.active;
        let observedRoute: { selectedNode: string; chains: string[] } | undefined;
        const startedAt = new Date().toISOString(), started = performance.now();
        const invoke = (
            proxyUrl: string,
            expectedNode: string,
            controller: ClashController
        ) => transport({
            proxyUrl,
            expectedNode,
            controller,
            onRoute: evidence => { observedRoute = evidence; }
        }, url, init);
        const observeResponse = (
            response: Response,
            expectedNode: string,
            selectionPolicy: 'pinned' | 'current'
        ) => recordGenericResponse ? observeRoutedResponse({
            response,
            target: String(url),
            method: String(init.method ?? 'GET'),
            selectionPolicy,
            selectedNode: observedRoute?.selectedNode ?? expectedNode,
            expectedNode,
            role,
            startedAt,
            started,
            record: this.recordRequest
        }) : response;
        if (!this.getConfig().clash.enabled) return fetch(url, { ...init, redirect: 'error' });
        if (binding) {
            const response = await invoke(binding.proxyUrl, binding.expectedNode, binding.controller);
            if (observedRoute) this.routedEvidence.set(response, observedRoute);
            return observeResponse(response, binding.expectedNode, binding.selectionPolicy);
        }
        const transient = this.binding(), config = transient.config;
        if (!config.selector) throw new DomainError('CLASH_ROUTE_SELECTION_REQUIRED', 409);
        if ((config.selectionPolicy ?? 'pinned') === 'current') {
            const observed = await transient.lease.withObservedSelection({
                group: config.selector,
                expectedMode: config.expectedMode,
                owner: { dmRunId: 'provider-call', processStartedAt: this.processStartedAt },
                signal: init.signal ?? undefined
            }, async lease => {
                await lease.assertCurrent();
                return invoke(transient.proxyUrl, lease.node, transient.controller);
            });
            if (observedRoute) this.routedEvidence.set(observed.result, observedRoute);
            return observeResponse(observed.result, observed.selection, 'current');
        }
        if (!config.node) throw new DomainError('CLASH_ROUTE_SELECTION_REQUIRED', 409);
        const leased = await transient.lease.withSelection({ group: config.selector, node: config.node, expectedMode: config.expectedMode, mutationScope: 'shared-selector', owner: { dmRunId: 'provider-call', processStartedAt: this.processStartedAt }, signal: init.signal ?? undefined }, async lease => {
            await lease.assertCurrent();
            return invoke(transient.proxyUrl, config.node, transient.controller);
        });
        if (observedRoute) this.routedEvidence.set(leased.result, observedRoute);
        return observeResponse(leased.result, config.node, 'pinned');
    }
    readonly fetch: typeof fetch = (url, init) => this.routedFetch(url, init, true);
    /** Planner-1 public repository research uses the same lease, CONNECT and node-chain checks. */
    readonly researchFetch: typeof fetch = (url,init)=>{
        if(!this.getConfig().clash.enabled)throw new DomainError('CLASH_RESEARCH_ROUTE_DISABLED',409);
        return this.routedFetchWithTransport(url,init,true,'planner1',this.researchRoutedTransport);
    };
    fetchForRole(role: RoutedRequestRole): typeof fetch {
        this.assertRequestRole(role);
        return (url, init) => this.routedFetch(url, init, true, role);
    }
    readonly jsonRequest = (
        url: string,
        init: RequestInit,
        maxBytes = 1_000_000
    ) => this.jsonRequestInternal(url, init, maxBytes);
    jsonRequestForRole(role: RoutedRequestRole) {
        this.assertRequestRole(role);
        return (url: string, init: RequestInit, maxBytes = 1_000_000) =>
            this.jsonRequestInternal(url, init, maxBytes, role);
    }
    private assertRequestRole(role: RoutedRequestRole): void {
        if (!['planner1', 'planner2', 'executor', 'reviewer'].includes(role))
            throw new DomainError('NETWORK_REQUEST_ROLE_INVALID', 400);
    }
    private async jsonRequestInternal(
        url: string,
        init: RequestInit,
        maxBytes: number,
        role?: RoutedRequestRole
    ) {
        if (!this.getConfig().clash.enabled) return jsonFetch(url, init, maxBytes);
        const startedAt = new Date().toISOString(), started = performance.now();
        let response: Response | null = null;
        try {
            response = await this.routedFetch(url, init, false);
        } catch (error) {
            const failure = (error as { networkFailure?: NetworkFailureEvidence })?.networkFailure;
            if (failure) this.recordObservation(url, init, response, startedAt, started, failure, role);
            throw error;
        }
        if (!response) throw new DomainError('UPSTREAM_EMPTY', 502);
        if (!response.ok) {
            try {
                throw await networkFailureFromResponse(response.clone());
            } catch (error) {
                const failure = (error as { networkFailure?: NetworkFailureEvidence })?.networkFailure;
                if (failure) this.recordObservation(url, init, response, startedAt, started, failure, role);
                throw error;
            }
        }
        if (!response.headers.get('content-type')?.includes('application/json')) throw new DomainError('UPSTREAM_CONTENT_TYPE', 502);
        let bytes: Uint8Array;
        try {
            bytes = new Uint8Array(await response.arrayBuffer());
        } catch (error) {
            const failure = classifyNetworkFailure({error,context:'RESPONSE',httpStatus:response.status,
                requestId:response.headers.get('x-request-id')??response.headers.get('request-id')});
            this.recordObservation(url, init, response, startedAt, started, failure, role);
            throw networkFailureError(failure, 'UPSTREAM_INTERRUPTED');
        }
        if (bytes.byteLength > maxBytes) throw new DomainError('UPSTREAM_TOO_LARGE', 502);
        try {
            const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            this.recordObservation(url, init, response, startedAt, started, classifyRoutedResponse({
                status: response.status,
                requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id'),
                target: String(url),
                inferenceRequest: isInferenceTarget(String(url)),
                payload: value,
                contentType: response.headers.get('content-type') ?? ''
            }), role);
            return value as Record<string, unknown>;
        }
        catch { throw new DomainError('UPSTREAM_BAD_JSON', 502); }
    };
    private recordObservation(
        url: string | URL | Request,
        init: RequestInit,
        response: Response | null,
        startedAt: string,
        started: number,
        failure: NetworkFailureEvidence,
        role?: RoutedRequestRole
    ): void {
        if (!this.recordRequest) return;
        try {
            const target = new URL(String(url));
            const evidence = response ? this.routedEvidence.get(response) : undefined;
            const method = String(init.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
            const requestId = response?.headers.get('x-request-id') ?? response?.headers.get('request-id') ?? null;
            const selectionPolicy = this.active?.selectionPolicy ?? (this.getConfig().clash.selectionPolicy ?? 'pinned');
            const selectedNode = evidence?.selectedNode ?? this.active?.expectedNode ?? '';
            const configuredNode = this.getConfig().clash.node || '';
            const expectedNode = this.active?.expectedNode || configuredNode ||
                (selectionPolicy === 'current' ? selectedNode : '');
            this.recordRequest({
                schema: 'dream-maker.routed-request-observation.v1',
                at: new Date().toISOString(),
                startedAt,
                completedAt: new Date().toISOString(),
                process: 'DM_CONTROLLED_TRANSPORT',
                ...(role ? { role } : {}),
                targetHost: target.hostname,
                method,
                selectionPolicy,
                selectedNode,
                expectedNode,
                httpStatus: response?.status ?? failure.httpStatus,
                classification: failure.classification,
                automaticRetryAllowed: failure.automaticRetryAllowed,
                requestIdSha256: failure.requestIdSha256 ?? (requestId ? hash(requestId) : null),
                elapsedMs: Math.min(300000, Math.max(0, Math.floor(performance.now() - started)))
            });
        } catch {
            // Diagnostics are best effort and never replace the request result.
        }
    }
    childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
        const base = childEnv(extra);
        if (!this.getConfig().clash.enabled) return base;
        const binding = this.active;
        if (!binding) throw new DomainError('CLASH_RUN_LEASE_REQUIRED', 409);
        return controlledProxyEnvironment(base, binding.proxyUrl);
    }
    /** Observe one DM-owned Windows Codex turn against the active CFW lease.
     * A diagnostic refusal is returned as evidence and never changes the turn result. */
    async observeCodexRequestRoute(input:{process:CodexProcessInfo;signal:AbortSignal}):Promise<CodexRouteEvidence>{
        const config=this.getConfig(),binding=this.active;
        const base={
            processPid:input.process.pid,
            processIdentitySha256:input.process.identity?hash(input.process.identity):null,
            sourcePortSha256:null,
            proxyEndpoint:null,
            selectedNode:null,
            expectedNode:binding?.expectedNode??config.clash.node??'',
            chains:[] as string[],
            targetHost:null,
            targetHosts:[],
            sourcePortCount:0
        };
        if(!config.clash.enabled)return{...base,path:'ROUTE_DISABLED'};
        if(!binding)return{...base,path:'CFW_UNAVAILABLE'};
        try{
            return await probeCodexRoute({
                process:input.process,
                proxyUrl:binding.proxyUrl,
                expectedNode:binding.expectedNode,
                controller:binding.controller,
                targetPort:443,
                signal:input.signal,
                timeoutMs:12000
            });
        }catch{
            return{...base,path:'PROCESS_ROUTE_NOT_OBSERVED'};
        }
    }
}

/**
 * Codex planner/reviewer children need one observed CFW lease for the whole
 * probe. Other roles route their own HTTP requests and must not acquire a
 * child-process lease merely to prove a role.
 */
export async function withCodexRoleProbeLease<T>(
    clash: ClashService,
    role: Role,
    signal: AbortSignal,
    action: () => Promise<T>
): Promise<T> {
    if (role !== 'planner2' && role !== 'reviewer') return action();
    return clash.withRun(`native-probe-${role}`, signal, action);
}
