import http from 'node:http';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DomainError } from './security.js';

type ProxyInfo = { name: string; type: string; now?: string; all?: string[] };
type ControllerLike = {
    endpoint: string;
    config(signal?: AbortSignal): Promise<{ mode: string }>;
    proxies(signal?: AbortSignal): Promise<Record<string, ProxyInfo>>;
    proxy(name: string, signal?: AbortSignal): Promise<ProxyInfo>;
    setSelection(group: string, node: string, signal?: AbortSignal): Promise<void>;
};
export interface TunnelIdentity { sourcePort: number; sourceAddress: string; proxyPort: number; targetHost: string; targetPort: number }
export interface ClashConnection {
    sourceAddress:string;sourcePort:number;proxyPort:number|null;
    targetHost:string;targetPort:number;chains:string[];rule:string|null;start:string|null;
}

function routeError(code: string, status = 409): DomainError { return new DomainError(code, status); }
function requireRoute(condition: unknown, code: string): asserts condition { if (!condition) throw routeError(code); }

function scalar(value: string): string {
    const raw = value.trim();
    if (!raw) return '';
    if (raw.startsWith('"')) {
        try { const parsed = JSON.parse(raw); requireRoute(typeof parsed === 'string', 'CLASH_CONFIG_SCALAR_REQUIRED'); return parsed; }
        catch (error) { if (error instanceof DomainError) throw error; throw routeError('CLASH_CONFIG_QUOTE_INVALID'); }
    }
    if (raw.startsWith("'")) {
        requireRoute(raw.endsWith("'") && raw.length >= 2, 'CLASH_CONFIG_QUOTE_INVALID');
        return raw.slice(1, -1).replace(/''/g, "'");
    }
    requireRoute(!/[#\r\n]/.test(raw), 'CLASH_CONFIG_INLINE_COMMENT_DENIED');
    return raw;
}

/** Parse only the CFW top-level routing fields. This is deliberately not a general YAML parser. */
export function parseClashConfig(source: string): {
    controllerUrl: string;
    proxyUrl: string;
    secret: string;
    allowLan: boolean | null;
    bindAddress: string | null;
} {
    requireRoute(typeof source === 'string' && Buffer.byteLength(source) <= 128 * 1024, 'CLASH_CONFIG_TOO_LARGE');
    const values = new Map<string, string>();
    for (const line of source.split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line)) continue;
        const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
        if (!match || !['external-controller', 'mixed-port', 'secret', 'allow-lan', 'bind-address'].includes(match[1])) continue;
        requireRoute(!values.has(match[1]), 'CLASH_CONFIG_DUPLICATE_KEY');
        values.set(match[1], scalar(match[2]));
    }
    const controller = values.get('external-controller') ?? '';
    const controllerMatch = /^(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/.exec(controller);
    requireRoute(controllerMatch, 'CLASH_CONTROLLER_LOOPBACK_REQUIRED');
    const controllerPort = Number(controllerMatch[2]);
    requireRoute(controllerPort <= 65535, 'CLASH_CONTROLLER_PORT_INVALID');
    const mixedPort = Number(values.get('mixed-port'));
    requireRoute(Number.isInteger(mixedPort) && mixedPort >= 1 && mixedPort <= 65535, 'CLASH_MIXED_PORT_INVALID');
    const secret = values.get('secret');
    requireRoute(typeof secret === 'string' && secret.length <= 4096 && !/[\r\n\0]/.test(secret), 'CLASH_SECRET_INVALID');
    const allowLanValue = values.get('allow-lan');
    const allowLan = allowLanValue === 'true' ? true : allowLanValue === 'false' ? false : null;
    const bindAddressValue = values.get('bind-address');
    const bindAddress = typeof bindAddressValue === 'string' && /^[A-Za-z0-9.*:_-]{1,255}$/.test(bindAddressValue)
        ? bindAddressValue
        : null;
    const controllerHost = controllerMatch[1] === '[::1]' ? '[::1]' : '127.0.0.1';
    return {
        controllerUrl: `http://${controllerHost}:${controllerPort}/`,
        proxyUrl: `http://127.0.0.1:${mixedPort}/`,
        secret,
        allowLan,
        bindAddress
    };
}

function endpoint(input: string): URL {
    let url: URL;
    try { url = new URL(input); } catch { throw routeError('CLASH_ENDPOINT_INVALID'); }
    requireRoute(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname), 'CLASH_ENDPOINT_LOOPBACK_REQUIRED');
    requireRoute(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'CLASH_ENDPOINT_INVALID');
    return url;
}

function proxyName(value: unknown): string {
    requireRoute(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value), 'CLASH_PROXY_NAME_INVALID');
    return value;
}

function cleanProxy(value: unknown, fallbackName: string): ProxyInfo {
    requireRoute(value !== null && typeof value === 'object' && !Array.isArray(value), 'CLASH_PROXY_RESPONSE_INVALID');
    const record = value as Record<string, unknown>;
    requireRoute(typeof record.type === 'string' && record.type.length > 0 && record.type.length <= 100, 'CLASH_PROXY_RESPONSE_INVALID');
    const result: ProxyInfo = { name: fallbackName, type: record.type };
    if (record.now !== undefined) result.now = proxyName(record.now);
    if (record.all !== undefined) {
        requireRoute(Array.isArray(record.all) && record.all.length <= 20000, 'CLASH_PROXY_RESPONSE_INVALID');
        result.all = record.all.map(proxyName);
    }
    return result;
}

function localJsonOnce(url: URL, path: string, secret: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
        let settled = false, size = 0;
        const chunks: Buffer[] = [];
        const finish = (error?: Error, value?: unknown) => {
            if (settled) return;
            settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
            error ? reject(error) : resolve(value);
        };
        const headers: Record<string, string> = { accept: 'application/json', connection: 'close' };
        if (secret) headers.authorization = `Bearer ${secret}`;
        if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
        const request = http.request({ hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, path, method, headers, agent: false }, response => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
                response.destroy();
                finish(routeError(status === 401 || status === 403 ? 'CLASH_CONTROLLER_AUTH_REJECTED' : status >= 300 && status < 400 ? 'CLASH_CONTROLLER_REDIRECT_REJECTED' : 'CLASH_CONTROLLER_HTTP_ERROR', 502));
                return;
            }
            response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { response.destroy(); finish(routeError('CLASH_CONTROLLER_RESPONSE_TOO_LARGE', 502)); } else chunks.push(chunk); });
            response.on('error', () => finish(routeError('CLASH_CONTROLLER_RESPONSE_INTERRUPTED', 502)));
            response.on('end', () => { if (!size) return finish(undefined, null); try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(routeError('CLASH_CONTROLLER_NON_JSON', 502)); } });
        });
        request.on('error', () => finish(routeError('CLASH_CONTROLLER_NETWORK_ERROR', 502)));
        const abort = () => { request.destroy(); finish(routeError('CLASH_REQUEST_ABORTED')); };
        const timer = setTimeout(() => { request.destroy(); finish(routeError('CLASH_CONTROLLER_TIMEOUT', 504)); }, 5000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else request.end(payload);
    });
}

async function localJson(url: URL, path: string, secret: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await localJsonOnce(url, path, secret, method, body, signal);
        } catch (error) {
            const code = error instanceof DomainError ? error.code : '';
            if (method !== 'GET' || attempt >= 2 || signal?.aborted ||
                !['CLASH_CONTROLLER_TIMEOUT', 'CLASH_CONTROLLER_NETWORK_ERROR'].includes(code))
                throw error;
            // Controller reads are side-effect free. A cold or briefly busy CFW
            // controller can miss one 5s window; retry once, never retry writes.
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

export class ClashController implements ControllerLike {
    readonly endpoint: string;
    private url: URL;
    constructor(controllerUrl: string, private secret: string) { this.url = endpoint(controllerUrl); this.endpoint = this.url.origin; }
    async version(signal?: AbortSignal) {
        const value = await localJson(this.url, '/version', this.secret, 'GET', undefined, signal) as Record<string, unknown>;
        requireRoute(typeof value?.version === 'string', 'CLASH_VERSION_RESPONSE_INVALID');
        return { version: value.version.slice(0, 200), premium: typeof value.premium === 'boolean' ? value.premium : null };
    }
    async config(signal?: AbortSignal) {
        const value = await localJson(this.url, '/configs', this.secret, 'GET', undefined, signal) as Record<string, unknown>;
        requireRoute(typeof value?.mode === 'string', 'CLASH_CONFIG_RESPONSE_INVALID');
        const port = (key: string) => Number.isInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 65535 ? Number(value[key]) : null;
        return { mode: value.mode.toLowerCase(), mixedPort: port('mixed-port'), port: port('port'), socksPort: port('socks-port'), allowLan: value['allow-lan'] === true };
    }
    async proxies(signal?: AbortSignal) {
        const value = await localJson(this.url, '/proxies', this.secret, 'GET', undefined, signal) as { proxies?: Record<string, unknown> };
        requireRoute(value?.proxies && typeof value.proxies === 'object' && !Array.isArray(value.proxies), 'CLASH_PROXIES_RESPONSE_INVALID');
        return Object.fromEntries(Object.entries(value.proxies).map(([name, proxy]) => [proxyName(name), cleanProxy(proxy, name)]));
    }
    async proxy(name: string, signal?: AbortSignal) { return cleanProxy(await localJson(this.url, `/proxies/${encodeURIComponent(proxyName(name))}`, this.secret, 'GET', undefined, signal), name); }
    async setSelection(group: string, node: string, signal?: AbortSignal) { await localJson(this.url, `/proxies/${encodeURIComponent(proxyName(group))}`, this.secret, 'PUT', { name: proxyName(node) }, signal); }
    async inspect(signal?: AbortSignal) {
        const [version, config, proxies] = await Promise.all([this.version(signal), this.config(signal), this.proxies(signal)]);
        return { version, config, selectors: Object.values(proxies).filter(proxy => proxy.type.toLowerCase() === 'selector'), nodes: Object.values(proxies).filter(isConcreteProxy), evidence: 'CONTROLLER_OBSERVED_ROUTE_UNVERIFIED' as const };
    }
    /** Read and allowlist the controller's current connection table. This is
     * observation only: no selector, proxy or account mutation is possible. */
    async connections(signal?:AbortSignal):Promise<ClashConnection[]>{
        const value=await localJson(this.url,'/connections',this.secret,'GET',undefined,signal) as {connections?:unknown[]};
        requireRoute(Array.isArray(value?.connections)&&value.connections.length<=10000,'CLASH_CONNECTION_OBSERVER_UNAVAILABLE');
        const result:ClashConnection[]=[];
        for(const item of value.connections){
            if(!item||typeof item!=='object'||Array.isArray(item))continue;
            const metadata=(item as {metadata?:unknown}).metadata;
            if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))continue;
            const m=metadata as Record<string,unknown>;
            const sourceAddress=typeof m.sourceIP==='string'?m.sourceIP.replace(/^::ffff:/,'').toLowerCase():'';
            const targetHost=typeof m.host==='string'?m.host.toLowerCase():'';
            const sourcePort=Number(m.sourcePort),targetPort=Number(m.destinationPort),proxyPort=Number(m.inboundPort);
            if(!sourceAddress||!/^[a-z0-9.:-]{1,253}$/.test(sourceAddress)||
                !targetHost||!/^[a-z0-9.-]{1,253}$/.test(targetHost)||
                !Number.isInteger(sourcePort)||sourcePort<1||sourcePort>65535||
                !Number.isInteger(targetPort)||targetPort<1||targetPort>65535)continue;
            const chains=(item as {chains?:unknown}).chains;
            if(!Array.isArray(chains)||chains.length>64||chains.some(chain=>typeof chain!=='string'||chain.length<1||chain.length>512))continue;
            result.push({
                sourceAddress,sourcePort,
                proxyPort:Number.isInteger(proxyPort)&&proxyPort>=1&&proxyPort<=65535?proxyPort:null,
                targetHost,targetPort,chains:[...chains],
                rule:typeof (item as {rule?:unknown}).rule==='string'?String((item as {rule?:unknown}).rule).slice(0,512):null,
                start:typeof (item as {start?:unknown}).start==='string'?String((item as {start?:unknown}).start).slice(0,128):null
            });
        }
        return result;
    }
    async traceConnection(identity: TunnelIdentity, signal?: AbortSignal) {
        const normalize = (input: unknown) => String(input ?? '').replace(/^::ffff:/, '').toLowerCase();
        const connections=await this.connections(signal);
        const matches=connections.filter(item=>
            item.sourcePort===identity.sourcePort&&item.sourceAddress===normalize(identity.sourceAddress)&&
            item.targetPort===identity.targetPort&&item.targetHost===normalize(identity.targetHost)&&
            (item.proxyPort===null||item.proxyPort===identity.proxyPort)
        );
        requireRoute(matches.length === 1, 'CLASH_CONNECTION_NOT_UNIQUELY_OBSERVED');
        const match = matches[0];
        requireRoute(Array.isArray(match.chains)&&match.chains.length>0,'CLASH_CONNECTION_CHAIN_UNAVAILABLE');
        return { chains: match.chains, rule: match.rule, inboundPortMatched: match.proxyPort!==null };
    }
}

export function isConcreteProxy(proxy: ProxyInfo | undefined): boolean {
    if (!proxy || proxy.all || proxy.now !== undefined) return false;
    const type = proxy.type.toLowerCase().replace(/[-_\s]/g, '');
    return ['shadowsocks', 'shadowsocksr', 'ss', 'ssr', 'vmess', 'vless', 'trojan', 'snell', 'http', 'socks', 'socks5', 'ssh', 'hysteria', 'hysteria2', 'tuic', 'wireguard', 'anytls', 'mieru', 'sudoku', 'trusttunnel', 'openvpn'].includes(type);
}

async function writeJournal(directory: string, value: unknown) {
    const temporary = join(directory, `journal-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, 'journal.json'));
}

export class SelectionLeaseManager {
    constructor(private options: { controller: ControllerLike; stateDirectory: string }) {
        requireRoute(isAbsolute(options.stateDirectory), 'CLASH_STATE_DIRECTORY_ABSOLUTE_REQUIRED');
    }
    lockDirectory(group: string) {
        proxyName(group);
        const key = createHash('sha256').update(this.options.controller.endpoint + '\0' + group).digest('hex');
        return join(this.options.stateDirectory, `selection-${key}.lock`);
    }
    async pending(group: string): Promise<unknown | null> {
        const directory = this.lockDirectory(group);
        try { return JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw routeError('CLASH_RECOVERY_JOURNAL_UNREADABLE');
            try { await stat(directory); } catch (lockError) { if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') return null; throw routeError('CLASH_RECOVERY_LOCK_UNREADABLE'); }
            return { schema: 'dm.clash.selection-journal.v1', phase: 'incomplete-lock' };
        }
    }
    /**
     * Observe the user's current selector without changing it. The journal exists only
     * to keep one DM route owner at a time and to make restart cleanup explicit. A
     * selection change is a fail-closed condition, never a reason to switch back.
     */
    async withObservedSelection<T>(input: {
        group: string;
        expectedMode: 'rule' | 'global';
        owner: { dmRunId: string; processStartedAt: string };
        signal?: AbortSignal;
        onReleased?: () => void;
    }, action: (lease: { id: string; node: string; assertCurrent(): Promise<boolean> }) => Promise<T>) {
        requireRoute(/^[A-Za-z0-9._:-]{1,160}$/.test(input.owner.dmRunId), 'CLASH_RUN_ID_INVALID');
        requireRoute(Number.isFinite(Date.parse(input.owner.processStartedAt)), 'CLASH_PROCESS_BIRTH_INVALID');
        const directory = this.lockDirectory(input.group);
        await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
        try {
            await mkdir(directory, { mode: 0o700 });
        } catch (error) {
            input.onReleased?.();
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw routeError('CLASH_ROUTE_BUSY_OR_RECOVERY_REQUIRED');
            throw routeError('CLASH_ROUTE_LOCK_UNAVAILABLE');
        }
        let journal: Record<string, unknown> | undefined;
        let actionError: unknown;
        let result!: T;
        let selected = '';
        try {
            const config = await this.options.controller.config(input.signal);
            requireRoute(config.mode === input.expectedMode, 'CLASH_MODE_CHANGED_OR_UNSUPPORTED');
            if (input.expectedMode === 'global') requireRoute(input.group === 'GLOBAL', 'CLASH_GLOBAL_SELECTOR_REQUIRED');
            const proxies = await this.options.controller.proxies(input.signal);
            const selector = proxies[input.group];
            requireRoute(selector?.type.toLowerCase() === 'selector' && Array.isArray(selector.all) && typeof selector.now === 'string', 'CLASH_MANUAL_SELECTOR_REQUIRED');
            requireRoute(selector.all.includes(selector.now), 'CLASH_SELECTION_NOT_MEMBER');
            requireRoute(isConcreteProxy(proxies[selector.now]), 'CLASH_CONCRETE_NODE_REQUIRED');
            selected = selector.now;
            journal = {
                schema: 'dm.clash.selection-journal.v2',
                mode: 'observed-current-selection',
                leaseId: randomUUID(),
                createdAt: new Date().toISOString(),
                pid: process.pid,
                host: hostname(),
                controllerUrl: this.options.controller.endpoint,
                dmRunId: input.owner.dmRunId,
                processStartedAt: input.owner.processStartedAt,
                group: input.group,
                selection: selected,
                expectedMode: input.expectedMode,
                phase: 'active'
            };
            await writeJournal(directory, journal);
            const assertCurrent = async () => {
                const current = await this.options.controller.proxy(input.group, input.signal);
                requireRoute(current.now === selected, 'CLASH_SELECTION_CHANGED_DURING_RUN');
                requireRoute((await this.options.controller.config(input.signal)).mode === input.expectedMode, 'CLASH_MODE_CHANGED_DURING_RUN');
                return true;
            };
            await assertCurrent();
            result = await action(Object.freeze({ id: String(journal.leaseId), node: selected, assertCurrent }));
            await assertCurrent();
        } catch (error) {
            actionError = error;
        } finally {
            try { await rm(directory, { recursive: true, force: true }); } catch { /* fail below without changing selector */ }
            input.onReleased?.();
        }
        if (actionError) throw actionError;
        return { result, selection: selected, restored: false, selectionChangedExternally: false, evidence: 'OBSERVED_SELECTION_ONLY' as const };
    }
    async withSelection<T>(input: { group: string; node: string; mutationScope: 'shared-selector'; expectedMode: 'rule' | 'global'; owner: { dmRunId: string; processStartedAt: string }; signal?: AbortSignal;onRestored?:()=>void }, action: (lease: { id: string; assertCurrent(): Promise<boolean> }) => Promise<T>) {
        requireRoute(/^[A-Za-z0-9._:-]{1,160}$/.test(input.owner.dmRunId), 'CLASH_RUN_ID_INVALID');
        requireRoute(Number.isFinite(Date.parse(input.owner.processStartedAt)), 'CLASH_PROCESS_BIRTH_INVALID');
        const directory = this.lockDirectory(input.group);
        await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
        try { await mkdir(directory, { mode: 0o700 }); } catch (error) { input.onRestored?.();if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw routeError('CLASH_ROUTE_BUSY_OR_RECOVERY_REQUIRED'); throw routeError('CLASH_ROUTE_LOCK_UNAVAILABLE'); }
        let journal: Record<string, unknown> | undefined, changed = false, mutationUncertain = false, actionError: unknown, result!: T, recovery = false;
        try {
            const config = await this.options.controller.config(input.signal);
            requireRoute(config.mode === input.expectedMode, 'CLASH_MODE_CHANGED_OR_UNSUPPORTED');
            if (input.expectedMode === 'global') requireRoute(input.group === 'GLOBAL', 'CLASH_GLOBAL_SELECTOR_REQUIRED');
            const proxies = await this.options.controller.proxies(input.signal), selector = proxies[input.group], candidate = proxies[input.node];
            requireRoute(selector?.type.toLowerCase() === 'selector' && Array.isArray(selector.all) && typeof selector.now === 'string', 'CLASH_MANUAL_SELECTOR_REQUIRED');
            requireRoute(selector.all.includes(input.node) && selector.all.includes(selector.now), 'CLASH_SELECTION_NOT_MEMBER');
            requireRoute(isConcreteProxy(candidate), 'CLASH_CONCRETE_NODE_REQUIRED');
            journal = { schema: 'dm.clash.selection-journal.v1', leaseId: randomUUID(), createdAt: new Date().toISOString(), pid: process.pid, host: hostname(), controllerUrl: this.options.controller.endpoint, dmRunId: input.owner.dmRunId, processStartedAt: input.owner.processStartedAt, group: input.group, previous: selector.now, intended: input.node, expectedMode: input.expectedMode, mutationScope: input.mutationScope, phase: 'prepared' };
            await writeJournal(directory, journal);
            if (selector.now !== input.node) {
                changed = true;
                try { await this.options.controller.setSelection(input.group, input.node, input.signal); }
                catch (error) {
                    mutationUncertain = !(['CLASH_CONTROLLER_AUTH_REJECTED', 'CLASH_CONTROLLER_REDIRECT_REJECTED'].includes((error as { code?: string }).code ?? ''));
                    throw error;
                }
            }
            const assertCurrent = async () => {
                const current = await this.options.controller.proxy(input.group, input.signal);
                requireRoute(current.now === input.node, 'CLASH_SELECTION_CHANGED_DURING_RUN');
                requireRoute((await this.options.controller.config(input.signal)).mode === input.expectedMode, 'CLASH_MODE_CHANGED_DURING_RUN');
                return true;
            };
            await assertCurrent(); journal.phase = 'active'; await writeJournal(directory, journal);
            result = await action(Object.freeze({ id: String(journal.leaseId), assertCurrent }));
            await assertCurrent();
        } catch (error) { actionError = error; }
        finally {
            if (journal && changed) {
                try {
                    journal.phase = 'restoring'; await writeJournal(directory, journal);
                    const current = await this.options.controller.proxy(input.group);
                    if (current.now === journal.intended) {
                        requireRoute(current.all?.includes(String(journal.previous)), 'CLASH_PREVIOUS_NODE_REMOVED');
                        await this.options.controller.setSelection(input.group, String(journal.previous));
                        requireRoute((await this.options.controller.proxy(input.group)).now === journal.previous, 'CLASH_RESTORE_READBACK_MISMATCH');
                    } else requireRoute(current.now === journal.previous, 'CLASH_SELECTION_CHANGED_EXTERNALLY');
                    if (mutationUncertain) throw routeError('CLASH_MUTATION_OUTCOME_UNCERTAIN');
                } catch { recovery = true; journal.phase = 'recovery-required'; try { await writeJournal(directory, journal); } catch { /* retain prior journal */ } }
            }
            if (!recovery) await rm(directory, { recursive: true, force: true });
        }
        if (recovery) throw routeError('CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY');
        input.onRestored?.(); // Restore readback and journal removal succeeded even if the action failed.
        if (actionError) throw actionError;
        return { result, restored: true, selectionChangedExternally: false, evidence: 'LEASE_COMPLETED' as const };
    }
    async recover(group: string, currentProcessStartedAt: string) {
        const directory = this.lockDirectory(group), pending = await this.pending(group);
        requireRoute(pending !== null && typeof pending === 'object' && !Array.isArray(pending), 'CLASH_RECOVERY_NOT_REQUIRED');
        const journal = pending as Record<string, unknown>;
        requireRoute(['dm.clash.selection-journal.v1','dm.clash.selection-journal.v2'].includes(String(journal.schema)) && journal.group === group, 'CLASH_RECOVERY_JOURNAL_INVALID');
        const pid = Number(journal.pid);
        requireRoute(Number.isInteger(pid) && pid > 0, 'CLASH_RECOVERY_OWNER_INVALID');
        if (pid === process.pid) requireRoute(journal.processStartedAt === currentProcessStartedAt, 'CLASH_RECOVERY_OWNER_CHANGED');
        else {
            try { process.kill(pid, 0); throw routeError('CLASH_RECOVERY_OWNER_MAY_BE_ACTIVE'); }
            catch (error) { if (error instanceof DomainError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw routeError('CLASH_RECOVERY_OWNER_MAY_BE_ACTIVE'); }
        }
        if (journal.schema === 'dm.clash.selection-journal.v2') {
            requireRoute(journal.mode === 'observed-current-selection' && typeof journal.selection === 'string', 'CLASH_RECOVERY_JOURNAL_INVALID');
            const current = await this.options.controller.proxy(group);
            await rm(directory, { recursive: true, force: true });
            return {
                outcome: current.now === journal.selection ? 'OBSERVED_SELECTION_UNCHANGED' : 'OBSERVED_SELECTION_PRESERVED',
                group,
                recoveryCleared: true,
                selectorMutation: false,
                evidence: 'OBSERVED_SELECTION_RECOVERY_COMPLETED' as const
            };
        }
        requireRoute(typeof journal.previous === 'string' && typeof journal.intended === 'string', 'CLASH_RECOVERY_JOURNAL_INVALID');
        const config = await this.options.controller.config();
        requireRoute(config.mode === journal.expectedMode, 'CLASH_MODE_CHANGED_OR_UNSUPPORTED');
        const current = await this.options.controller.proxy(group);
        requireRoute(Array.isArray(current.all), 'CLASH_MANUAL_SELECTOR_REQUIRED');
        let outcome = 'ALREADY_RESTORED';
        if (current.now === journal.intended) {
            requireRoute(current.all.includes(journal.previous), 'CLASH_PREVIOUS_NODE_REMOVED');
            await this.options.controller.setSelection(group, journal.previous);
            requireRoute((await this.options.controller.proxy(group)).now === journal.previous, 'CLASH_RESTORE_READBACK_MISMATCH');
            outcome = 'RESTORED_PREVIOUS';
        } else if (current.now !== journal.previous) outcome = 'EXTERNAL_SELECTION_PRESERVED';
        await rm(directory, { recursive: true, force: true });
        return { outcome, group, recoveryCleared: true, evidence: 'COMPARE_BEFORE_RESTORE_COMPLETED' as const };
    }
}
