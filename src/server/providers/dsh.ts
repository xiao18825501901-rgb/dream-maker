import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { RpcPeer,RpcChildError } from './rpc.js';
import { createTurnWatchdog, type TurnWatchdog } from '../turn-watchdog.js';
import {assertPaidDispatchAllowed} from '../zero-usage.js';
import { DomainError, object, childEnv, id, hash, loopbackUrl } from '../security.js';
import type { Config, AgentInput, AgentOutput, Runner } from '../../shared/types.js';
export function translateDshRpcError(error:unknown,stalled:boolean):unknown {
    if(stalled&&error instanceof DomainError&&['RUNNER_RPC_ERROR','RUNNER_CLOSED'].includes(error.code))return new DomainError('DSH_HOST_STALLED',504,'执行器宿主超过 limits.idleTimeoutMs 没有任何工具或模型事件，看门狗已终止该宿主进程（不是崩溃）。');
    if(error instanceof RpcChildError&&error.evidence.failureCategories.includes('DSH_HOST_TIMEOUT')||error instanceof DomainError&&error.code==='RUNNER_RPC_ERROR'&&/run timeout reached/i.test(error.message))return new DomainError('DSH_HOST_TIMEOUT',504,'执行器宿主触发自身 run 超时（Archon dsh-node-host.mjs:227，配置项 timeoutMs），不是子进程崩溃。');
    if(error instanceof DomainError&&error.code==='RPC_REQUEST_TIMEOUT')return new DomainError('DSH_HOST_TIMEOUT',504,'桥请求超时（limits.stepTimeoutMs）；一次回合的工具步数可能超过单次步进上限。');
    return error;
}
export const nativeReadiness=(c:Config)=>runtimeReadiness(c,true);
/** Custom DSH qualification does not open or require a Codex account/home/model. */
export const dshRuntimeReadiness=(c:Config)=>runtimeReadiness(c,false);
function runtimeReadiness(c: Config,requireCodex:boolean): {
    ok: boolean;
    reasons: string[];
    configurationHash: string;
} {
    const legacyFingerprint=hash({codex:c.codex,dsh:c.dsh,laya:c.laya,limits:c.limits});
    const fingerprint=requireCodex?legacyFingerprint:hash({dsh:c.dsh,laya:c.laya,limits:c.limits}),reasons:string[]=[];
    if (!c.dsh.modulePath || !isAbsolute(c.dsh.modulePath) || !existsSync(c.dsh.modulePath))
        reasons.push('DSH_NATIVE_MODULE_MISSING');
    if (requireCodex&&(!c.codex.home || !existsSync(c.codex.home)))
        reasons.push('ISOLATED_CODEX_HOME_REQUIRED');
    if (requireCodex&&!c.codex.model)
        reasons.push('CODEX_MODEL_REQUIRED');
    if (!c.nativeAuditPath || !existsSync(c.nativeAuditPath))
        reasons.push('NATIVE_AUDIT_REQUIRED');
    else
        try {
            const audit = object(JSON.parse(readFileSync(c.nativeAuditPath, 'utf8')));
            // A new independently generated DSH binding excludes unrelated Codex settings.
            // Legacy audits retain their original stricter binding until actually re-audited.
            if (requireCodex?audit.configurationHash!==fingerprint:audit.dshConfigurationHash!==undefined?audit.dshConfigurationHash!==fingerprint:audit.configurationHash!==legacyFingerprint)
                reasons.push('NATIVE_AUDIT_CONFIG_MISMATCH');
            if (audit.status !== 'LIVE_READY')
                reasons.push('NATIVE_AUDIT_NOT_READY');
            if (audit.osIsolationVerified !== true || audit.secretIsolationVerified !== true)
                reasons.push('NATIVE_ISOLATION_UNVERIFIED');
            if (audit.noImplicitLayaVerified !== true)
                reasons.push('NATIVE_LAYA_OFF_UNVERIFIED');
            if (audit.verifierImplemented !== true)
                reasons.push('NATIVE_VERIFIER_NOT_IMPLEMENTED');
            // A validating function is not an executing boundary: without a real sandbox run the
            // audit would certify isolation it never crossed.
            if (audit.sandboxExecutionVerified !== true)
                reasons.push('NATIVE_SANDBOX_EXECUTION_UNVERIFIED');
            if (typeof audit.expiresAt !== 'string' || Date.parse(audit.expiresAt) < Date.now() || !Number.isFinite(Date.parse(audit.expiresAt)))
                reasons.push('NATIVE_AUDIT_EXPIRED');
            if (!Array.isArray(audit.evidenceFiles) || audit.evidenceFiles.length === 0)
                reasons.push('NATIVE_AUDIT_EVIDENCE_MISSING');
            else
                for (const v of audit.evidenceFiles) {
                    const e = object(v);
                    if (typeof e.path !== 'string' || typeof e.sha256 !== 'string' || !existsSync(e.path) || hash(readFileSync(e.path)) !== e.sha256)
                        reasons.push('NATIVE_EVIDENCE_MISMATCH');
                }
            if (c.dsh.modulePath && existsSync(c.dsh.modulePath) && audit.moduleSha256 !== hash(readFileSync(c.dsh.modulePath)))
                reasons.push('NATIVE_MODULE_CHANGED');
        }
        catch {
            reasons.push('NATIVE_AUDIT_INVALID');
        }
    return { ok: reasons.length === 0, reasons: [...new Set(reasons)], configurationHash: fingerprint };
}
/** Trusted controller selection only; never parsed from an Agent response or HTTP proof flag. */
export interface CustomDshRoleBinding {
    role:'planner2'|'executor'|'reviewer';roleId:string;provider?:string;model:string;assertCurrent():void;
    /** Product supervision must submit through its one role-specific terminal tool. */
    requireTerminal?:boolean;
}
interface DshToolBinding {
    url:string;token:string;configPath:string;configSha256:string;dispatchPath?:string;dispatchSha256?:string;
    terminal?:()=>string|undefined;
    close():Promise<void>;
}
export class DshRunner implements Runner {
    private readonly customRole?:Readonly<CustomDshRoleBinding>;
    constructor(private config: () => Config, private root: string, private gateway?: () => Promise<{
        url: string; token: string; close(): Promise<void>; receipts(): unknown[];
    }>, private tools?: () => Promise<DshToolBinding>,customRole?:CustomDshRoleBinding) {
        if(customRole)this.customRole=Object.freeze({...customRole});
    }
    private selectedModel(input:AgentInput):string {
        const selected=this.customRole;if(!selected)return this.config().dsh.model;
        const validModel=typeof selected.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(selected.model)&&!selected.model.includes('://');
        const validProvider=selected.provider===undefined?['deepseek-flash','deepseek-v4-pro'].includes(selected.model):
            typeof selected.provider==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(selected.provider);
        if(!['planner2','executor','reviewer'].includes(selected.role)||!validModel||!validProvider||
            !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(selected.roleId)||
            (selected.role==='executor'?['planner2','reviewer'].includes(selected.roleId):selected.roleId!==selected.role)||
            input.role!==selected.role||input.model!==selected.model||
            (selected.role==='executor'?input.executorRoleId!==selected.roleId:input.executorRoleId!==undefined)||
            input.laya.mode!=='off'||input.laya.adoption!=='off'||this.config().laya.mode!=='off'||typeof selected.assertCurrent!=='function')
            throw new DomainError('CUSTOM_DSH_ROLE_BINDING_INVALID',409);
        const allowed:unknown=selected.assertCurrent();
        if(allowed!==undefined){if(allowed instanceof Promise)void allowed.catch(()=>{});throw new DomainError('CUSTOM_DSH_CURRENTNESS_INVALID',409);}
        return selected.model;
    }
    async call(method: string, input: AgentInput, onEvent: (e: unknown) => void): Promise<Record<string, unknown>> {
        const c = this.config();
        const selectedModel=this.selectedModel(input);
        if(this.customRole&&method!=='dm/run')throw new DomainError('CUSTOM_DSH_METHOD_DENIED',409);
        const readiness = this.customRole?dshRuntimeReadiness(c):nativeReadiness(c);
        if (!readiness.ok)
            throw new DomainError('NATIVE_INTEGRATION_BLOCKED', 409, readiness.reasons.join(', '));
        if(input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);
        assertPaidDispatchAllowed(false);
        if (method === 'dm/run' && !this.gateway) throw new DomainError('NATIVE_BUDGET_REQUIRED', 409);
        if (method === 'dm/run' && !this.tools) throw new DomainError('NATIVE_TOOL_PROXY_REQUIRED', 409);
        const gateway = method === 'dm/run' ? await this.gateway!() : undefined;
        let tools: Awaited<ReturnType<NonNullable<DshRunner['tools']>>>|undefined;
        let peer: RpcPeer | undefined;
        let watchdog: TurnWatchdog | undefined;
        const abort = () => { void peer?.close().catch(() => { }); };
        input.signal.addEventListener('abort', abort, { once: true });
        try {
            if(method==='dm/run'){
                tools=await this.tools!();const url=new URL(tools.url);loopbackUrl(url.origin);
                if(url.pathname!=='/tools'||url.username||url.password||url.search||url.hash||!tools.token||!isAbsolute(tools.configPath)||hash(readFileSync(tools.configPath))!==tools.configSha256)
                    throw new DomainError('NATIVE_TOOL_PROXY_BINDING_INVALID',409);
                if(tools.dispatchPath&&(!isAbsolute(tools.dispatchPath)||hash(readFileSync(tools.dispatchPath))!==tools.dispatchSha256))throw new DomainError('NATIVE_DISPATCH_BINDING_INVALID',409);
            }
            if (gateway) {
                const url = new URL(gateway.url);
                loopbackUrl(url.origin);
                if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1' || !gateway.token)
                    throw new DomainError('NATIVE_GATEWAY_BINDING_INVALID', 409);
            }
            // Only the gateway's ephemeral bearer reaches the adapter, never the real API key.
            const env = childEnv({ ...(gateway ? { [c.dsh.keyEnv]: gateway.token, DM_MODEL_GATEWAY_URL: gateway.url, DM_MODEL_GATEWAY_TOKEN: gateway.token } : {}),
                ...(tools?{DM_TOOL_PROXY_URL:tools.url,DM_TOOL_PROXY_TOKEN:tools.token,DM_DSH_TOOL_CLIENT_CONFIG:tools.configPath,DM_DSH_TOOL_CLIENT_SHA256:tools.configSha256,
                    ...(tools.dispatchPath?{DM_ARCHON_DISPATCH_PATH:tools.dispatchPath,DM_ARCHON_DISPATCH_SHA256:tools.dispatchSha256}:{})}:{}),DM_DSH_KEY_ENV: c.dsh.keyEnv, DM_NATIVE_AUDIT_PATH: c.nativeAuditPath });
            // The bridge child can be pinned to a DIFFERENT Node build than the app, on purpose: a Windows
            // Node regression (e.g. the 24.19 WorkerThreadsTaskRunner shutdown gap fixed in 24.20/24.22) can
            // then be worked around without touching the system Node, WSL Node, the Kimi runner or any other
            // project. Anything but an absolute, existing file is refused rather than silently ignored.
            const nodeBin = process.env.DM_DSH_NODE_BIN ? resolve(process.env.DM_DSH_NODE_BIN) : process.execPath;
            if (process.env.DM_DSH_NODE_BIN && !(isAbsolute(nodeBin) && existsSync(nodeBin)))
                throw new DomainError('DSH_NODE_BIN_INVALID', 409, 'DM_DSH_NODE_BIN 必须是存在的绝对路径。');
            peer = new RpcPeer(nodeBin, [resolve(this.root, 'scripts/dsh-host.mjs'), c.dsh.modulePath], { cwd: input.workspace, env,...(process.platform==='win32'?{windowsJobRoot:this.root}:{}) }, c.limits.stepTimeoutMs);
            // Two independent, FINITE bounds now govern one turn: the total deadline (limits.stepTimeoutMs,
            // handed to every RPC request) and a no-progress watchdog. The watchdog is what makes a longer
            // deadline safe: if the host stops emitting bridge events for limits.idleTimeoutMs it is killed
            // instead of silently burning the whole window. Progress means 'the host notified us', nothing more.
            // Windows Job startup has its own bounded ownership check. Count bridge idle time from readiness.
            if(this.customRole)await peer.ready;
            let stalled = false;
            watchdog = createTurnWatchdog({
                idleMs: Math.max(1000, c.limits.idleTimeoutMs),
                onStall: () => { stalled = true; void peer?.close().catch(() => { }); }
            });
            peer.onNotification = (method, params) => { watchdog?.touch(); onEvent({ method, params }); };
            // Translate the two failure modes that used to be indistinguishable. The Archon host arms its own
            // run timer (scripts/dsh-node-host.mjs:227) and, when it fires, prints 'run timeout reached' and
            // exits 0 — the parent only ever saw a rejected RPC and the run history said RUNNER_RPC_ERROR,
            // which reads like a crash. Naming it turns the next investigation into a one-line lookup.
            const translate = (error: unknown) => translateDshRpcError(error,stalled);
            if (input.signal.aborted)
                throw new DomainError('RUN_CANCELLED', 409);
            this.selectedModel(input);
            // Custom adapter loading and capability negotiation share the configured step and idle bounds.
            const initTimeoutMs = this.customRole ? c.limits.stepTimeoutMs : 10000;
            const caps = await peer.request('dm/initialize', { protocol: 'dream-maker.bridge.v1' }, initTimeoutMs).catch(error => { throw translate(error); });
            if (caps.protocol !== 'dream-maker.bridge.v1' || caps.runner !== 'dsh' || caps.nativeTools !== true)
                throw new DomainError('DSH_BRIDGE_CAPABILITIES_INVALID', 502);
            if(this.customRole)watchdog.touch();
            const { signal, ...payload } = input;
            this.selectedModel(input);
            try {
                const output=await peer.request(method, { ...payload, model: selectedModel, ...(this.customRole?.provider?{provider:this.customRole.provider}:{}) }, c.limits.stepTimeoutMs);
                this.selectedModel(input);
                const terminal=tools?.terminal?.();
                return typeof terminal==='string'?{...output,__terminalText:terminal}:output;
            }
            catch (error) { throw translate(error); }
        }
        finally {
            watchdog?.stop();
            input.signal.removeEventListener('abort', abort);
            try { await peer?.close(); }
            finally {
                try{await tools?.close();}finally{await gateway?.close();}
                if (gateway) onEvent({ method: 'dm/budget', params: { requests: gateway.receipts() } });
            }
        }
    }
    async run(input: AgentInput, onEvent: (e: unknown) => void): Promise<AgentOutput> {
        const selectedModel=this.selectedModel(input);let actualModel: string | undefined;
        const output = await this.call('dm/run', input, event => {
            if (event && typeof event === 'object' && (event as {method?: string}).method === 'dm/budget') {
                const receipts = (event as {params?: {requests?: {observedModel?: string; completionObserved?: boolean; outcome?: string}[]}}).params?.requests;
                const complete = receipts?.filter(r => r.outcome === 'COMPLETE' && r.completionObserved === true);
                if (complete?.length && complete.every(r => r.observedModel === selectedModel)) actualModel = complete[0].observedModel;
            }
            onEvent(event);
        });
        const terminalText=typeof output.__terminalText==='string'?output.__terminalText:undefined;
        const text=this.customRole?.requireTerminal?terminalText:typeof output.text==='string'?output.text:terminalText;
        if (this.customRole?.requireTerminal&&typeof terminalText!=='string')
            throw new DomainError('CUSTOM_TERMINAL_SUBMISSION_REQUIRED',409,'工程角色必须通过其唯一的终态工具提交完整结果。');
        if (typeof text !== 'string' || typeof output.sessionId !== 'string')
            throw new DomainError('DSH_OUTPUT_SCHEMA', 502);
        return { text, sessionId: output.sessionId, model: actualModel,
            ...(actualModel ? {identity: {runner: 'DSH' as const, provider: this.customRole?.provider??'deepseek-official', authentication: 'API_KEY' as const, model: actualModel}} : {}),
            usage: { role: this.customRole?.role??'executor', inputTokens: null, outputTokens: null, costUsd: null, source: 'UNKNOWN', requestId: id('dsh_request') } };
    }
}
