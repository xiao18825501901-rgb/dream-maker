import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { DomainError, allowedJsonTarget, networkFailureError, type NetworkDomainError } from './security.js';
import type { TunnelIdentity } from './clash-route.js';
import { classifyNetworkFailure, type NetworkFailureEvidence } from './network-failure.js';
import {researchRequestTarget} from './research/transport.js';
import {
    CODEX_CONTROL_TARGET_HOSTS,
    type CodexControlTargetHost,
    type OpenAiTlsProbe
} from '../shared/network-contexts.js';

function fail(code: string, status = 502): DomainError { return new DomainError(code, status); }

export const DEFAULT_CLASH_RESPONSE_HEADER_TIMEOUT_MS = 300_000;
export const MAX_CLASH_RESPONSE_HEADER_TIMEOUT_MS = 300_000;
const MIN_CLASH_RESPONSE_HEADER_TIMEOUT_MS = 50;

/** Caller signals still enforce shorter deadlines; this is only the transport's finite fallback. */
export function resolveClashResponseHeaderTimeoutMs(value?: unknown): number {
    if(value===undefined)return DEFAULT_CLASH_RESPONSE_HEADER_TIMEOUT_MS;
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<MIN_CLASH_RESPONSE_HEADER_TIMEOUT_MS||value>MAX_CLASH_RESPONSE_HEADER_TIMEOUT_MS)
        throw fail('CLASH_RESPONSE_HEADER_TIMEOUT_INVALID',409);
    return value;
}

class ConnectAgent extends https.Agent {
    private proxy: URL;
    constructor(proxyUrl: string, private timeoutMs: number, private observe: (identity: TunnelIdentity) => Promise<void>, private signal?: AbortSignal) {
        super({ keepAlive: false, maxSockets: 1 });
        this.proxy = new URL(proxyUrl);
        if (this.proxy.protocol !== 'http:' || this.proxy.hostname !== '127.0.0.1') throw fail('CLASH_PROXY_LOOPBACK_REQUIRED', 409);
    }
    createConnection(options: https.RequestOptions, callback?: (error: Error | null, socket: Duplex) => void): Duplex | null | undefined {
        if (!callback) throw fail('CLASH_PROXY_CALLBACK_REQUIRED');
        const host = String(options.hostname ?? options.host).replace(/^\[|\]$/g, ''), port = Number(options.port ?? 443), authority = `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
        let settled = false, raw: net.Socket | undefined, secure: tls.TLSSocket | undefined;
        const finish = (error: Error | null, socket?: tls.TLSSocket) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.signal?.removeEventListener('abort', abort);
            if (error) { raw?.destroy(); secure?.destroy(); request.destroy(); }
            callback(error, socket!);
        };
        const request = http.request({ hostname: '127.0.0.1', port: Number(this.proxy.port), method: 'CONNECT', path: authority, headers: { host: authority }, agent: false });
        request.once('connect', (response, socket, head) => {
            raw = socket;
            if (response.statusCode !== 200) { finish(fail(response.statusCode === 407 ? 'CLASH_PROXY_AUTH_REJECTED' : 'CLASH_PROXY_CONNECT_REJECTED')); return; }
            if (head.length) socket.unshift(head);
            secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert), ALPNProtocols: ['http/1.1'] });
            secure.once('error', () => finish(fail('CLASH_PROXY_TLS_ERROR')));
            secure.once('secureConnect', async () => {
                try { await this.observe({ sourcePort: socket.localPort!, sourceAddress: socket.localAddress!, proxyPort: socket.remotePort!, targetHost: host, targetPort: port }); finish(null, secure); }
                catch (error) { finish(error instanceof Error ? error : fail('CLASH_TUNNEL_OBSERVER_FAILED')); }
            });
        });
        request.once('response', response => { response.destroy(); finish(fail('CLASH_PROXY_CONNECT_PROTOCOL_ERROR')); });
        request.once('error', error => finish(networkFailureError(
            classifyNetworkFailure({ error, context: 'PROXY' }),
            'CLASH_PROXY_NETWORK_ERROR'
        )));
        const timer = setTimeout(() => finish(networkFailureError(
            classifyNetworkFailure({ error: { code: 'ETIMEDOUT' }, context: 'PROXY' }),
            'CLASH_PROXY_CONNECT_TIMEOUT'
        )), this.timeoutMs);
        const abort = () => finish(networkFailureError(
            classifyNetworkFailure({ error: { code: 'CLASH_REQUEST_ABORTED' }, context: 'PROXY' }),
            'CLASH_REQUEST_ABORTED'
        ));
        this.signal?.addEventListener('abort', abort, { once: true });
        if (this.signal?.aborted) queueMicrotask(abort); else request.end();
        return undefined;
    }
}

export async function diagnoseClashRoute(input: { proxyUrl: string; expectedNode: string; controller: { traceConnection(identity: TunnelIdentity, signal?: AbortSignal): Promise<{ chains: string[]; inboundPortMatched: boolean }> }; signal?: AbortSignal }) {
    const target = new URL('https://www.cloudflare.com/cdn-cgi/trace');
    let association: { chains: string[]; inboundPortMatched: boolean } | undefined;
    const agent = new ConnectAgent(input.proxyUrl, 15000, async identity => {
        association = await input.controller.traceConnection(identity, input.signal);
        if (!association.chains.includes(input.expectedNode)) throw fail('CLASH_EXPECTED_NODE_NOT_IN_CHAIN', 409);
    }, input.signal);
    try {
        const response = await new Promise<{ body: string; elapsedMs: number }>((resolve, reject) => {
            const started = Date.now(), chunks: Buffer[] = []; let size = 0, settled = false;
            const finish = (error?: Error, value?: { body: string; elapsedMs: number }) => { if (settled) return; settled = true; clearTimeout(timer); input.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value!); };
            const request = https.request(target, { method: 'GET', agent, headers: { accept: 'text/plain', 'accept-encoding': 'identity', 'user-agent': 'DreamMaker-Route-Diagnostic/0.1', connection: 'close' } }, res => {
                if ((res.statusCode ?? 0) !== 200) { res.destroy(); finish(fail('CLASH_PROBE_HTTP_REJECTED')); return; }
                if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); finish(fail('CLASH_PROBE_ENCODING_UNSUPPORTED')); return; }
                res.on('data', chunk => { size += chunk.length; if (size > 32768) { res.destroy(); finish(fail('CLASH_PROBE_RESPONSE_TOO_LARGE')); } else chunks.push(chunk); });
                res.on('error', () => finish(fail('CLASH_PROBE_INTERRUPTED')));
                res.on('end', () => finish(undefined, { body: Buffer.concat(chunks).toString('utf8'), elapsedMs: Date.now() - started }));
            });
            request.once('error', error => finish(error instanceof DomainError ? error : fail('CLASH_PROBE_NETWORK_ERROR')));
            const abort = () => { request.destroy(); finish(fail('CLASH_REQUEST_ABORTED', 409)); };
            const timer = setTimeout(() => { request.destroy(); finish(fail('CLASH_PROBE_TIMEOUT', 504)); }, 15000);
            input.signal?.addEventListener('abort', abort, { once: true });
            if (input.signal?.aborted) abort(); else request.end();
        });
        const trace = Object.fromEntries(response.body.split(/\r?\n/).map(line => { const index = line.indexOf('='); return index < 0 ? [] : [line.slice(0, index), line.slice(index + 1)]; }).filter(pair => pair.length === 2));
        if (!net.isIP(trace.ip) || !/^[A-Za-z]{2}$/.test(trace.loc ?? '')) throw fail('CLASH_EGRESS_RESPONSE_INVALID');
        if (!association) throw fail('CLASH_CONNECTION_ASSOCIATION_MISSING');
        return { status: 200, elapsedMs: response.elapsedMs, country: trace.loc.toUpperCase(), ipSha256: createHash('sha256').update(trace.ip).digest('hex'), nodeChainMatched: true, inboundPortMatched: association.inboundPortMatched, evidence: 'PROBE_NODE_CHAIN_AND_EGRESS_OBSERVED' as const };
    } finally { agent.destroy(); }
}

type TlsProbeTargetHost='api.openai.com'|'chatgpt.com'|'api.deepseek.com'|CodexControlTargetHost;

/** CONNECT and TLS only. No HTTP request, Authorization header, authentication or model call. */
async function probeTlsTarget(input: {
    proxyUrl:string;
    targetHost:TlsProbeTargetHost;
    configuredNode?:string|null;
    controller:{traceConnection(identity:TunnelIdentity,signal?:AbortSignal):Promise<{chains:string[];inboundPortMatched:boolean}>};
    signal?:AbortSignal;
}):Promise<OpenAiTlsProbe>{
    const started=Date.now();
    let association:{chains:string[];inboundPortMatched:boolean}|undefined;
    const agent=new ConnectAgent(input.proxyUrl,15000,async identity=>{
        association=await input.controller.traceConnection(identity,input.signal);
    },input.signal);
    try{
        const socket=await new Promise<Duplex>((resolve,reject)=>{
            agent.createConnection({hostname:input.targetHost,port:443},(error,stream)=>{
                if(error)reject(error);else resolve(stream);
            });
        });
        const secure=socket as tls.TLSSocket,selectedNode=association?.chains[0]??null;
        const result:OpenAiTlsProbe={
            state:'TLS_HANDSHAKE_COMPLETED',target:`${input.targetHost}:443`,protocol:secure.getProtocol()??null,
            authorized:secure.authorized===true,alpn:secure.alpnProtocol?String(secure.alpnProtocol):null,elapsedMs:Date.now()-started,
            selectedNode,selectionMatchesExpected:input.configuredNode&&selectedNode?input.configuredNode===selectedNode:null,
            nodeChainMatched:Boolean(input.configuredNode&&association?.chains.includes(input.configuredNode)),
            errorClass:null,httpRequestSent:false,modelCalls:0
        };
        socket.destroy();
        return result;
    }finally{
        agent.destroy();
    }
}

export function probeOpenAiTls(input:Omit<Parameters<typeof probeTlsTarget>[0],'targetHost'>):Promise<OpenAiTlsProbe>{
    return probeTlsTarget({...input,targetHost:'api.openai.com'});
}

export function probeCodexTls(input:Omit<Parameters<typeof probeTlsTarget>[0],'targetHost'>):Promise<OpenAiTlsProbe>{
    return probeTlsTarget({...input,targetHost:'chatgpt.com'});
}

export function probeCodexControlTls(input:Omit<Parameters<typeof probeTlsTarget>[0],'targetHost'>,targetHost:CodexControlTargetHost):Promise<OpenAiTlsProbe>{
    if(!(CODEX_CONTROL_TARGET_HOSTS as readonly string[]).includes(targetHost))throw fail('CLASH_TLS_TARGET_UNSUPPORTED',409);
    return probeTlsTarget({...input,targetHost});
}

export function probeDeepSeekTls(input:Omit<Parameters<typeof probeTlsTarget>[0],'targetHost'>):Promise<OpenAiTlsProbe>{
    return probeTlsTarget({...input,targetHost:'api.deepseek.com'});
}

function nextBeforeDeadline<T>(next: Promise<T>, idleMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('stream idle deadline'), { code: 'UPSTREAM_INTERRUPTED' })), idleMs);
        next.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); }
        );
    });
}

/** Incremental response body with backpressure, bounded memory, cancellation and an idle deadline. */
export function controlledResponseStream(
    upstream: AsyncIterable<Uint8Array | string>,
    options: { cleanup: () => void; signal?: AbortSignal; maxBytes?: number; idleMs?: number }
): ReadableStream<Uint8Array> {
    const iterator = upstream[Symbol.asyncIterator]();
    const maxBytes = options.maxBytes ?? 2_000_000;
    const idleMs = options.idleMs ?? 30_000;
    let bytes = 0;
    let finished = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let upstreamReturn: Promise<void> | undefined;
    const returnUpstream = () => upstreamReturn ??= Promise.resolve(iterator.return?.()).then(() => undefined, () => undefined);
    const cleanup = () => {
        if (finished) return;
        finished = true;
        options.signal?.removeEventListener('abort', abort);
        try { options.cleanup(); } catch { /* cleanup must not replace the transport result */ }
        void returnUpstream();
    };
    const abort = () => {
        if (finished) return;
        cleanup();
        try {
            streamController?.error(networkFailureError(
                classifyNetworkFailure({ error: { code: 'CLASH_REQUEST_ABORTED' }, context: 'RESPONSE' }),
                'CLASH_REQUEST_ABORTED'
            ));
        } catch { /* stream may already be closed */ }
    };
    return new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
            options.signal?.addEventListener('abort', abort, { once: true });
            if (options.signal?.aborted) queueMicrotask(abort);
        },
        async pull(controller) {
            try {
                const item = await nextBeforeDeadline(iterator.next(), idleMs);
                if (finished) return;
                if (item.done) {
                    cleanup();
                    controller.close();
                    return;
                }
                const value = typeof item.value === 'string' ? Buffer.from(item.value) : Buffer.from(item.value);
                bytes += value.byteLength;
                if (bytes > maxBytes) throw Object.assign(new Error('response size limit'), { code: 'UPSTREAM_TOO_LARGE' });
                controller.enqueue(new Uint8Array(value));
            } catch (error) {
                cleanup();
                const existing = (error as Partial<NetworkDomainError>)?.networkFailure;
                const networkFailure: NetworkFailureEvidence = existing ?? (
                    (error as { code?: unknown })?.code === 'UPSTREAM_TOO_LARGE'
                        ? {
                            ...classifyNetworkFailure({ error: { code: 'UPSTREAM_INTERRUPTED' }, context: 'RESPONSE' }),
                            classification: 'STREAM_INTERRUPTED'
                        }
                        : classifyNetworkFailure({ error, context: 'RESPONSE' })
                );
                controller.error(networkFailureError(networkFailure, 'STREAM_INTERRUPTED'));
            }
        },
        async cancel() {
            cleanup();
            await returnUpstream();
        }
    });
}

type ClashRequestTarget=(url:string,init:RequestInit)=>URL;
type ClashFetchInput={
    proxyUrl: string;
    expectedNode: string;
    controller: { traceConnection(identity: TunnelIdentity, signal?: AbortSignal): Promise<{ chains: string[] }> };
    onRoute?: (evidence: { selectedNode: string; chains: string[] }) => void;
    responseHeaderTimeoutMs?: number;
};

/** Provider transport with explicit CONNECT routing and per-request Clash chain correlation. */
export function clashFetch(input:ClashFetchInput,url:string|URL|Request,init:RequestInit={}):Promise<Response>{
    // Model turns stream for minutes; a 30 s gap between chunks aborted the planning call with
    // STREAM_INTERRUPTED even though limits.idleTimeoutMs asks for 120 s. The provider transport therefore
    // waits the configured window, while controlled research keeps the tighter 30 s boundary.
    return clashHttpsFetch(input,url,init,(value,request)=>allowedJsonTarget(value,request.method),120_000);
}

/** Public read-only source retrieval over the same CFW CONNECT/TLS/node-chain boundary. */
export function controlledResearchInit(init:RequestInit={}):RequestInit{
    const headers=new Headers(init.headers);
    if(!headers.get('user-agent')?.trim())headers.set('user-agent','DreamMaker-Research/0.1');
    return{...init,headers};
}

export function clashResearchFetch(input:ClashFetchInput,url:string|URL|Request,init:RequestInit={}):Promise<Response>{
    return clashHttpsFetch(input,url,controlledResearchInit(init),researchRequestTarget);
}

async function clashHttpsFetch(input:ClashFetchInput,url:string|URL|Request,init:RequestInit,targetFor:ClashRequestTarget,idleMs=30_000):Promise<Response>{
    if (url instanceof Request) throw fail('CLASH_REQUEST_OBJECT_UNSUPPORTED', 400);
    const href = String(url), method = String(init.method ?? 'GET').toUpperCase();
    const responseHeaderTimeoutMs=resolveClashResponseHeaderTimeoutMs(input.responseHeaderTimeoutMs);
    const target = targetFor(href, init);
    if (target.protocol !== 'https:') throw fail('CLASH_EXTERNAL_HTTPS_REQUIRED', 409);
    const signal = init.signal ?? undefined;
    const agent = new ConnectAgent(input.proxyUrl, 30000, async identity => {
        const association = await input.controller.traceConnection(identity, signal);
        if (!association.chains.includes(input.expectedNode)) throw fail('CLASH_EXPECTED_NODE_NOT_IN_CHAIN', 409);
        try {
            input.onRoute?.({
                selectedNode: association.chains[0] ?? input.expectedNode,
                chains: [...association.chains]
            });
        } catch {
            // Observation cannot alter the request decision or error classification.
        }
    }, signal);
    let handedOff = false;
    try {
        const requestBody = init.body == null ? undefined : typeof init.body === 'string' ? Buffer.from(init.body) : init.body instanceof Uint8Array ? Buffer.from(init.body) : undefined;
        if (init.body != null && !requestBody) throw fail('CLASH_REQUEST_BODY_UNSUPPORTED', 400);
        if (requestBody && requestBody.length > 512 * 1024) throw fail('CLASH_REQUEST_BODY_TOO_LARGE', 413);
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
        headers.connection = 'close'; headers['accept-encoding'] = 'identity';
        if (requestBody) headers['content-length'] = String(requestBody.length);
        return await new Promise<Response>((resolve, reject) => {
            let settled = false, request: http.ClientRequest;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                if (error) {
                    agent.destroy();
                    reject(error);
                }
            };
            request = https.request(target, { method, headers, agent }, response => {
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
                const body = controlledResponseStream(response, {
                    cleanup: () => {
                        response.destroy();
                        request.destroy();
                        agent.destroy();
                    },
                    signal,
                    maxBytes: 2_000_000,
                    idleMs
                });
                if (settled) {
                    void body.cancel().catch(() => {});
                    return;
                }
                settled = true;
                handedOff = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                resolve(new Response(body, {
                    status: response.statusCode ?? 502,
                    statusText: response.statusMessage,
                    headers: responseHeaders
                }));
            });
            request.once('error', error => {
                const networkFailure = classifyNetworkFailure({ error, context: 'PROXY' });
                finish(networkFailureError(networkFailure, error instanceof DomainError ? error.code : 'CLASH_PROVIDER_NETWORK_ERROR'));
            });
            const abort = () => {
                request.destroy();
                finish(networkFailureError(
                    classifyNetworkFailure({ error: { code: 'CLASH_REQUEST_ABORTED' }, context: 'PROXY' }),
                    'CLASH_REQUEST_ABORTED'
                ));
            };
            const timer = setTimeout(() => {
                request.destroy();
                finish(networkFailureError(
                    classifyNetworkFailure({ error: { code: 'UPSTREAM_INTERRUPTED' }, context: 'PROXY' }),
                    'CLASH_PROVIDER_TIMEOUT'
                ));
            }, responseHeaderTimeoutMs);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort(); else request.end(requestBody);
        });
    } finally {
        if (!handedOff) agent.destroy();
    }
}
