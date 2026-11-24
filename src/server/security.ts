import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { lstatSync, existsSync, realpathSync } from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import { LOCAL_PLANNER1_BASE_URL, LOCAL_PLANNER1_MODEL_PATHS } from './local-planner1-contract.js';
import {
    classifyNetworkFailure,
    classifyNetworkResponse,
    type NetworkFailureEvidence
} from './network-failure.js';
export class DomainError extends Error {
    constructor(public code: string, public status = 400, message?: string) { super(message ?? code); }
}
export type NetworkDomainError = DomainError & { networkFailure: NetworkFailureEvidence };
export function networkFailureError(evidence: NetworkFailureEvidence, legacyCode: string = evidence.classification): NetworkDomainError {
    const status = evidence.httpStatus === 401 || evidence.httpStatus === 403 || evidence.httpStatus === 429
        ? evidence.httpStatus
        : 502;
    const error = new DomainError(legacyCode, status, evidence.classification) as NetworkDomainError;
    Object.defineProperty(error, 'networkFailure', {
        value: Object.freeze(structuredClone(evidence)),
        enumerable: true,
        writable: false,
        configurable: false
    });
    return error;
}
export const id = (prefix: string) => `${prefix}_${randomBytes(10).toString('hex')}`;
// Short enough for a model to repeat verbatim, still random and role-bound by the signed probe.
export const customProbeNonce = () => `dmcp${randomBytes(6).toString('hex')}`;
export const isCustomProbeNonce = (value: unknown): value is string =>
    typeof value === 'string' && (/^dmcp[a-f0-9]{12}$/.test(value) || /^DM_CUSTOM_PROBE_[A-Za-z0-9_-]{1,100}$/.test(value));
export type ExactJsonRequest = (url: string, init: RequestInit, maxBytes?: number) => Promise<Record<string, unknown>>;
export const now = () => new Date().toISOString();
export function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}
export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value)).digest('hex');
export function object(v: unknown): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new DomainError('EXPECTED_OBJECT');
    return v as Record<string, unknown>;
}
export function text(v: unknown, max = 20000, allowEmpty = false): string {
    if (typeof v !== 'string' || v.length > max || (!allowEmpty && !v.trim()) || v.includes('\0'))
        throw new DomainError('INVALID_TEXT');
    return v.trim();
}
export function integer(v: unknown, min: number, max: number): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
        throw new DomainError('INVALID_INTEGER');
    return v;
}
export function choose<T extends string>(v: unknown, choices: readonly T[]): T {
    if (typeof v !== 'string' || !choices.includes(v as T))
        throw new DomainError('INVALID_ENUM');
    return v as T;
}
export function safeEqual(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
const credentialEnvNames = new Set<string>();
const explicitSecretInspection=new AsyncLocalStorage<readonly string[]>();
/** Metadata revalidation may inspect only explicitly selected values. Log redaction is unchanged. */
export function withExplicitSecretInspection<T>(values:readonly string[],action:()=>T):T {return explicitSecretInspection.run(Object.freeze([...values]),action);}
function redactPatterns(s:string):string {return s.replace(/\b(?:sk|dsk)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]').replace(/(Authorization["'\s:=]+Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');}
export function registerCredentialEnv(name: string): void {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) throw new DomainError('INVALID_ENV_NAME');
    credentialEnvNames.add(name.toLowerCase());
}
export function redact(value: unknown): string {
    let s = typeof value === 'string' ? value : JSON.stringify(value);
    for (const [key, val] of Object.entries(process.env))
        if ((/(?:API_KEY|SECRET|TOKEN|PASSWORD)$/i.test(key) || credentialEnvNames.has(key.toLowerCase())) && val && val.length >= 8) {
            for (const variant of [val, JSON.stringify(val).slice(1, -1)])
                s = s.split(variant).join('[REDACTED]');
        }
    return redactPatterns(s);
}
export function hasSecret(value: string) {
    const selected=explicitSecretInspection.getStore();if(selected===undefined)return redact(value)!==value;
    let text=value;for(const val of selected)if(val.length>0)for(const variant of [val,JSON.stringify(val).slice(1,-1)])text=text.split(variant).join('[REDACTED]');
    return redactPatterns(text)!==value;
}
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG'])
        if (process.env[key])
            out[key] = process.env[key];
    return { ...out, ...extra };
}
export function within(root: string, name: string): string {
    if (!name || name.includes('\0') || name.includes('\\') || name.includes(':') || isAbsolute(name))
        throw new DomainError('PATH_DENIED', 403);
    const base = resolve(root), target = resolve(base, name), rel = relative(base, target);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
        throw new DomainError('PATH_DENIED', 403);
    let part = base;
    if (existsSync(base) && lstatSync(base).isSymbolicLink())
        throw new DomainError('SYMLINK_DENIED', 403);
    for (const p of rel.split(sep).filter(Boolean)) {
        part = resolve(part, p);
        if (existsSync(part) && lstatSync(part).isSymbolicLink())
            throw new DomainError('SYMLINK_DENIED', 403);
    }
    if (existsSync(target) && existsSync(base)) {
        const rr = relative(realpathSync(base), realpathSync(target));
        if (rr === '..' || rr.startsWith('..' + sep))
            throw new DomainError('PATH_DENIED', 403);
    }
    return target;
}
export function publicApiUrl(base: string): URL {
    const u = new URL(base);
    if (u.protocol !== 'https:' || !['api.openai.com', 'api.deepseek.com'].includes(u.hostname) || u.username || u.password || u.search || u.hash || (u.port && u.port !== '443'))
        throw new DomainError('API_HOST_NOT_ALLOWED', 403);
    if (!['', '/', '/v1', '/v1/'].includes(u.pathname))
        throw new DomainError('API_PATH_NOT_ALLOWED');
    return u;
}
export function providerApiUrl(base: string, protocol: string): URL {
    const u = publicApiUrl(base);
    if (protocol === 'openai-responses' && (u.hostname !== 'api.openai.com' || !['/v1','/v1/'].includes(u.pathname)) ||
        protocol === 'chat-completions' && u.hostname !== 'api.deepseek.com')
        throw new DomainError('API_PROVIDER_PROTOCOL_MISMATCH', 403);
    return u;
}
export function localProviderApiUrl(base: string, protocol: string): URL {
    const u = new URL(base);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.port !== '11434' || u.username || u.password || u.search || u.hash ||
        u.href.replace(/\/$/, '') !== LOCAL_PLANNER1_BASE_URL || protocol !== 'chat-completions')
        throw new DomainError('LOCAL_PLANNER1_LOOPBACK_ONLY', 403);
    return u;
}
export function allowedJsonTarget(url: string, method = 'GET'): URL {
    const u = new URL(url);
    const requestedMethod = method.toUpperCase();
    const modelPaths: Record<string, string[]> = {
        'api.openai.com': ['/v1/models','/v1/responses'],
        'api.deepseek.com': ['/models','/v1/models','/chat/completions','/v1/chat/completions','/anthropic/v1/messages','/user/balance']
    };
    const external = u.protocol === 'https:' && (!u.port || u.port === '443') && modelPaths[u.hostname]?.includes(u.pathname);
    // The Laya wrapper discovers its port at runtime, so its protocol must work on loopback
    // ports other than 80. Keep the exemption path-and-method exact instead of turning this
    // into a generic localhost proxy.
    const layaLocal = u.protocol === 'http:' && u.hostname === '127.0.0.1' && (
        requestedMethod === 'GET' && ['/health','/info'].includes(u.pathname) ||
        requestedMethod === 'POST' && u.pathname === '/v1/decide'
    );
    const planner1Local = u.protocol === 'http:' && u.hostname === '127.0.0.1' &&
        u.port === '11434' && (LOCAL_PLANNER1_MODEL_PATHS as readonly string[]).includes(u.pathname);
    const local = layaLocal || planner1Local;
    if ((!external && !local) || u.username || u.password || u.search || u.hash || u.href !== url)
        throw new DomainError('NETWORK_TARGET_DENIED', 403);
    if (u.hostname === 'api.deepseek.com' && u.pathname === '/user/balance' && method !== 'GET')
        throw new DomainError('NETWORK_TARGET_DENIED', 403);
    assertNetworkTransportPolicy();
    return u;
}
export function loopbackUrl(base: string): URL {
    const u = new URL(base);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname))
        throw new DomainError('LAYA_LOOPBACK_ONLY', 403);
    return u;
}
function assertNetworkTransportPolicy(): void {
    if (process.env.NODE_USE_ENV_PROXY === '1' || /--use-env-proxy/.test(process.env.NODE_OPTIONS ?? '') || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
        throw new DomainError('NETWORK_PROXY_OR_TLS_OVERRIDE_DENIED', 403);
}

/**
 * Bind a text-role request to one in-memory DM gateway listener. This bypasses the
 * public target allowlist only after the exact origin, path, method, content type
 * and ephemeral bearer all match the route minted by DeepSeekGateway.start().
 */
export function loopbackGatewayChatRequest(address: { url: string; token: string }): ExactJsonRequest {
    let base: URL;
    try {
        base = new URL(address.url);
    } catch {
        throw new DomainError('NETWORK_TARGET_DENIED', 403);
    }
    const port = Number(base.port);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        base.username || base.password || base.pathname !== '/v1' || base.search || base.hash ||
        !/^[a-f0-9]{64}$/.test(address.token))
        throw new DomainError('NETWORK_TARGET_DENIED', 403);
    const expected = base.href.replace(/\/$/, '') + '/chat/completions';
    return async (url, init, maxBytes = 1000000) => {
        assertNetworkTransportPolicy();
        let headers: Headers;
        try {
            headers = new Headers(init.headers);
        } catch {
            throw new DomainError('NETWORK_TARGET_DENIED', 403);
        }
        if (url !== expected || (init.method ?? 'GET').toUpperCase() !== 'POST' ||
            !headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
            !safeEqual(headers.get('authorization') ?? '', 'Bearer ' + address.token))
            throw new DomainError('NETWORK_TARGET_DENIED', 403);
        return allowedJsonFetch(url, init, maxBytes);
    };
}

export async function jsonFetch(url: string, init: RequestInit, maxBytes = 1000000): Promise<Record<string, unknown>> {
    const target = allowedJsonTarget(url, init.method ?? 'GET');
    if (target.hostname === 'api.deepseek.com' && target.pathname === '/user/balance' && init.body != null)
        throw new DomainError('NETWORK_TARGET_DENIED', 403);
    return allowedJsonFetch(url, init, maxBytes);
}

async function allowedJsonFetch(url: string, init: RequestInit, maxBytes: number): Promise<Record<string, unknown>> {
    let response: Response;
    try {
        response = await fetch(url, { ...init, redirect: 'error' });
    } catch (error) {
        if (error instanceof DomainError) throw error;
        throw networkFailureError(classifyNetworkFailure({ error, context: 'DIRECT' }),
            String((error as { code?: unknown })?.code ?? 'UPSTREAM_TRANSPORT_FAILURE'));
    }
    if (!response.ok) {
        const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
        const body = await boundedResponseText(response, 64 * 1024);
        throw networkFailureError(
            classifyNetworkResponse({ status: response.status, body, requestId }),
            `UPSTREAM_HTTP_${response.status}`
        );
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
        throw new DomainError('UPSTREAM_CONTENT_TYPE', 502);
    const reader = response.body?.getReader();
    if (!reader)
        throw new DomainError('UPSTREAM_EMPTY', 502);
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > maxBytes)
                throw new DomainError('UPSTREAM_TOO_LARGE', 502);
            chunks.push(value);
        }
    }
    catch (e) {
        await reader.cancel();
        if (e instanceof DomainError) throw e;
        throw networkFailureError(classifyNetworkFailure({ error: e, context: 'RESPONSE' }), 'UPSTREAM_INTERRUPTED');
    }
    try {
        return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
    catch (e) {
        if (e instanceof DomainError)
            throw e;
        throw new DomainError('UPSTREAM_BAD_JSON', 502);
    }
}

/** Consume at most the diagnostic prefix. The response body is never retained or logged. */
export async function boundedResponseText(response: Response, maxBytes = 64 * 1024): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (bytes < maxBytes) {
            const { value, done } = await reader.read();
            if (done) break;
            const remaining = maxBytes - bytes;
            const part = value.byteLength > remaining ? value.subarray(0, remaining) : value;
            chunks.push(part);
            bytes += part.byteLength;
            if (part.byteLength < value.byteLength) break;
        }
    } catch {
        // The HTTP status still carries useful classification evidence.
    } finally {
        await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

export async function networkFailureFromResponse(response: Response, legacyCode?: string): Promise<NetworkDomainError> {
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
    const body = await boundedResponseText(response, 64 * 1024);
    return networkFailureError(
        classifyNetworkResponse({ status: response.status, body, requestId }),
        legacyCode ?? `UPSTREAM_HTTP_${response.status}`
    );
}
