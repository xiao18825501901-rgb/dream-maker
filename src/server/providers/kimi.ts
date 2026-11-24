import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { DomainError, object, redact, hash } from '../security.js';
import { type KimiAdmission, denyAllAdmission } from '../kimi-admission.js';
import type { KimiCredentialAuthority } from '../kimi-credential-authority.js';
import { withBoundedRetry } from '../kimi-retry.js';
import {createWindowsCredentialEncryption} from '../siwc/windows-credential-encryption.js';
import { attachHttpStatus, classifyKimiFailure, httpPathOf, httpStatusOf, kimiFailureError, layerForPath } from '../kimi-auth-errors.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Minimal loopback HTTP client. The shared jsonFetch carries the public-egress allowlist and
 * therefore refuses 127.0.0.1; this helper is deliberately narrower than that guard (loopback
 * only, http only, no redirects) instead of being an exception to it.
 */
function loopbackFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<Record<string, unknown>> {
    const target = new URL(url);
    if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname))
        throw new DomainError('KIMI_TARGET_NOT_LOOPBACK', 409);
    return new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port, path: target.pathname + target.search, method: init.method, headers: init.headers, signal: init.signal }, res => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { raw += chunk; if (raw.length > 8_000_000) req.destroy(new Error('KIMI_RESPONSE_TOO_LARGE')); });
            // Without this listener a connection that dies mid-response emits an unhandled 'error' on
            // the response stream — in a long-lived local server that is not a rejected call but a
            // thrown event. Treat it as what it is: a transient transport failure.
            res.on('error', error => reject(error instanceof DomainError ? error : new DomainError('KIMI_TRANSPORT_FAILED', 502)));
            res.on('end', () => {
                try {
                    const body: unknown = JSON.parse(raw);
                    // The status used to be discarded here, which also threw away the only cheap
                    // attribution evidence (401 vs 429 vs 503). It rides out-of-band on the body so
                    // every existing caller sees a byte-identical payload.
                    if (body && typeof body === 'object')
                        attachHttpStatus(body as Record<string, unknown>, res.statusCode ?? 0, target.pathname);
                    resolve(body as Record<string, unknown>);
                }
                catch {
                    reject(new DomainError('KIMI_RESPONSE_NOT_JSON', 502));
                }
            });
        });
        req.on('error', error => reject(error instanceof DomainError ? error : new DomainError('KIMI_TRANSPORT_FAILED', 502)));
        if (init.body !== undefined) req.write(init.body);
        req.end();
    });
}
import type { Config, Runner, AgentInput, AgentOutput, Usage } from '../../shared/types.js';

/**
 * Kimi Code 2.2.0 planner1 runner (K03 final code slice).
 *
 * It drives the *local, loopback-only* Kimi server that we build from the pinned
 * source, never a public endpoint, and it is deliberately intolerant:
 *  - a session is created per run, so nothing is reused across projects;
 *  - any tool or sub-agent frame is a policy violation under the zero-tool profile;
 *  - only a turn.state of "completed" yields text; failed/cancelled/blocked never do;
 *  - usage is reported as provider numbers or UNKNOWN, never as free.
 *
 * Everything crossing the wire is injected as a transport, so this module is testable
 * offline and cannot silently reach the network.
 */
export interface KimiTransportInit { method?: string; body?: unknown; signal?: AbortSignal }
export type KimiTransport = (path: string, init?: KimiTransportInit) => Promise<Record<string, unknown>>;

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked', 'interrupted']);

/**
 * Loopback-only transport for the local Kimi server. The management bearer is read from the
 * isolated home's control file on every call so rotation is picked up. Unchanged DPAPI bytes may
 * reuse a decrypted value for at most one minute, avoiding a PowerShell process for every poll.
 * No plaintext is returned, logged or written into an evidence file.
 */
export function createKimiTransport(options: {
    baseUrl: string;
    tokenFile: string;
    fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<Record<string, unknown>>;
    /** Controller-only test seam, like fetchImpl; never accepted from an HTTP request. */
    decrypt?: (bytes: Uint8Array) => Promise<string>;
}): KimiTransport {
    const call = options.fetchImpl ?? ((url: string, init: Record<string, unknown>) => loopbackFetch(url, init as { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }));
    const tokenFile = options.tokenFile;
    const encrypted = tokenFile.toLowerCase().endsWith('.dpapi');
    const decrypt = options.decrypt ?? createWindowsCredentialEncryption({entropy:'DreamMakerSuite-dedicated-appdata-v1'}).decrypt;
    let cached: { bytes: Buffer; token: string; expiresAt: number } | undefined;
    let cacheTimer: ReturnType<typeof setTimeout> | undefined;
    const clearCache = () => { cached = undefined; clearTimeout(cacheTimer); cacheTimer = undefined; };
    const readControl = (): Buffer => {
        try {
            const bytes=readFileSync(tokenFile);if(bytes.byteLength>64000)throw new Error('CONTROL_TOKEN_TOO_LARGE');
            return bytes;
        } catch {
            clearCache();
            throw new DomainError('KIMI_SERVER_TOKEN_MISSING', 409, '找不到可用的本机 Kimi 管理文件；未发送请求。');
        }
    };
    let base = options.baseUrl;
    while (base.endsWith('/')) base = base.slice(0, -1);
    return async (path, init) => {
        const method = (init?.method ?? 'GET').toUpperCase(), signal = init?.signal;
        const body = init?.body === undefined ? undefined : JSON.stringify(init.body);
        if (signal?.aborted) throw new DomainError('RUN_CANCELLED',409);
        if (!path.startsWith('/api/')) throw new DomainError('KIMI_PATH_DENIED',409);
        // This function is also the safe-read retry boundary: every physical request checks the
        // current file rather than reusing an authorization header across a rotation or deletion.
        const send = async () => {
            if (signal?.aborted) throw new DomainError('RUN_CANCELLED',409);
            const bytes=readControl();
            let token = '';
            if(encrypted && cached && cached.expiresAt>performance.now() && cached.bytes.equals(bytes)) token=cached.token;
            else {
                clearCache();
                try { token=(encrypted ? await decrypt(bytes) : bytes.toString('utf8')).trim(); }
                catch(error) {
                    clearCache();
                    if(signal?.aborted)throw new DomainError('RUN_CANCELLED',409);
                    const timeout=error instanceof Error && error.message==='DPAPI_TIMEOUT';
                    throw new DomainError(timeout?'KIMI_SERVER_TOKEN_DECRYPT_TIMEOUT':'KIMI_SERVER_TOKEN_DECRYPT_FAILED',409,
                        timeout?'读取本机 Kimi 管理信息超时；未发送请求。':'无法解密本机 Kimi 管理信息；未发送请求。');
                }
                if(signal?.aborted)throw new DomainError('RUN_CANCELLED',409);
                if(!readControl().equals(bytes))throw new DomainError('KIMI_SERVER_TOKEN_CHANGED',409,'本机 Kimi 管理信息已轮换；未使用旧值发送请求。');
            }
            if (!token || token.length < 8 || token.length>8192 || /[\x00-\x1f\x7f]/.test(token))
                throw new DomainError('KIMI_SERVER_TOKEN_MISSING', 409, '管理令牌为空或格式不符；不发起请求。');
            if(encrypted && !cached) {
                cached={bytes:Buffer.from(bytes),token,expiresAt:performance.now()+60000};
                cacheTimer=setTimeout(clearCache,60000);cacheTimer.unref();
            }
            if(signal?.aborted)throw new DomainError('RUN_CANCELLED',409);
            const headers: Record<string, string> = { authorization: `Bearer ${token}` };
            const request: Record<string, unknown> = { method, headers, signal: signal ?? AbortSignal.timeout(60000) };
            if (body !== undefined) {
                headers['content-type'] = 'application/json';
                request.body = body;
            }
            return await call(base + path, request);
        };
        // C04: only safe reads get a bounded retry. A POST here would be a session/prompt write, and
        // re-sending it after an unknown outcome duplicates reasoning — so it stays single-shot and
        // the caller must reconcile instead.
        if (method === 'POST' || method === 'PUT' || method === 'DELETE')
            return await send();
        return await withBoundedRetry(send, { method, signal });
    };
}
const TOOL_KINDS = new Set(['tool', 'toolCall', 'tool_call', 'toolUse', 'tool_use']);

function envelope(body: Record<string, unknown>): Record<string, unknown> {
    // A real transport answered >= 400: attribute it by layer before anything else looks at the
    // payload. A 401 on a model turn (L4) or on the local management bearer (L2) is NOT proof that
    // the Kimi account needs a new login, and must never be reported as one.
    const status = httpStatusOf(body);
    if (status !== undefined && status >= 400) {
        const text = typeof body.msg === 'string' ? body.msg : typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : '';
        throw kimiFailureError(classifyKimiFailure({ stage: 'UNKNOWN', httpStatus: status, layer: layerForPath(httpPathOf(body) ?? ''), message: text }));
    }
    const code = body.code;
    if (code !== undefined && code !== 0 && code !== '0')
        throw new DomainError('KIMI_API_ERROR', 502, 'Kimi 返回业务码 ' + String(code) + (typeof body.msg === 'string' ? '：' + body.msg.slice(0, 120) : ''));
    const data = body.data;
    return data === undefined ? body : object(data);
}

export class KimiRunner implements Runner {
    constructor(
        private config: () => Config,
        private transport: KimiTransport,
        private clock: () => number = () => Date.now(),
        private wait: (ms: number) => Promise<void> = ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
        /**
         * A01: admission is a constructor dependency with a fail-closed default, so a caller that
         * forgets to pass evidence gets "no reasoning" instead of unmetered membership usage.
         * It sits last so existing clock/wait injection points keep their positions.
         */
        private admission: KimiAdmission = denyAllAdmission(),
        /**
         * C03/C04: the durable credential state. Optional so no caller silently loses the gate: when
         * it is absent the runner simply has no persistent-store opinion to enforce, while the
         * durable record is still what decides CORRUPT/REVOKED here.
         */
        private authority?: KimiCredentialAuthority,
        /**
         * C02: where the last *classified* auth failure goes, so the status surface stops claiming
         * "can reason" right after the server rejected a call. Observation only — it never gates.
         */
        private reportAuthFailure?: (failure: { code?: unknown; message?: unknown } | null) => void
    ) {}

    /**
     * Public entry point: wraps the dispatch so the Kimi session is archived whether the turn
     * succeeded or failed. Archiving is best effort and never changes the outcome — a leaked
     * session is a housekeeping problem, not a reason to hide a real error.
     */
    async run(input: AgentInput, onEvent: (event: unknown) => void): Promise<AgentOutput & { receipt?: { turnId: string; reason: string; answerChars: number; answerHash: string; sessionId: string; promptId: string; source: string } }> {
        let sessionId = '';
        const track = (id: string) => { sessionId = id; };
        try {
            const output = await this.dispatch(input, onEvent, track);
            // A turn that completed is proof the credential works right now, so any older rejection
            // is retired instead of keeping the status surface red.
            this.reportAuthFailure?.(null);
            return output;
        }
        catch (error) {
            this.reportAuthFailure?.(error as { code?: unknown; message?: unknown });
            throw error;
        }
        finally {
            if (sessionId) {
                // C05: cleanup is reported, not assumed. A minimum probe refuses a session that was
                // not archived, so "cleanupReturned" stops being a constant written by the caller.
                let archived = false;
                try {
                    await this.transport(`/api/v1/sessions/${sessionId}:archive`, { method: 'POST' });
                    archived = true;
                }
                catch { /* best effort: archiving must never mask the run outcome */ }
                try { onEvent({ method: 'dm/kimiArchive', params: { sessionId, archived } }); }
                catch { /* an event sink must never change the run outcome */ }
            }
        }
    }

    private async dispatch(input: AgentInput, onEvent: (event: unknown) => void, track: (id: string) => void): Promise<AgentOutput & { receipt?: { turnId: string; reason: string; answerChars: number; answerHash: string; sessionId: string; promptId: string; source: string } }> {
        // planner1 stays Kimi's default role. The reviewer is the one additional role a
        // Custom Flow may bind to this harness, and only through its own frozen profile:
        // Classic never routes reviewer here (roleRunner picks Codex/independent).
        if (input.role !== 'planner1' && input.role !== 'reviewer')
            throw new DomainError('KIMI_ROLE_DENIED', 403, 'Kimi 只服务 planner1 或显式绑定的 reviewer；其他角色不得复用该运行器。');
        const c = this.config().kimi;
        if (!c)
            throw new DomainError('KIMI_NOT_CONFIGURED', 409);
        if (!input.model)
            throw new DomainError('KIMI_MODEL_REQUIRED', 409);
        if (input.signal.aborted)
            throw new DomainError('RUN_CANCELLED', 409);
        // A01 gate, layer 2: this is the last point before any upstream byte leaves the process.
        // Nothing below it may run when Extra Usage is unknown, enabled, expired or another account.
        this.admission.assertMaySend('kimi.dispatch:' + input.role);
        // C03: a damaged or revoked durable record must not be reported as "please log in". Both are
        // refused before the first upstream byte, with the precise cause kept.
        if (this.authority) {
            const barrier = this.authority.barrier();
            if (barrier === 'NOT_STARTED' || barrier === 'PENDING')
                throw new DomainError('KIMI_RESTORE_NOT_READY', 409, '凭据尚未完成 RESTORE 屏障；这不是首次登录，属于启动顺序错误。');
            const state = this.authority.current();
            if (state.status === 'CORRUPT')
                throw state.reason === 'READ_FAILED'
                    // Same code, honest wording: an unreadable store is a transient condition, and
                    // telling the owner their credential is damaged would be a wrong attribution.
                    ? new DomainError('KIMI_STORED_STATE_CORRUPT', 409, '凭据存储读取失败（READ_FAILED）；不是损坏，也不是未登录，稍后重试。')
                    : new DomainError('KIMI_STORED_STATE_CORRUPT', 409, `已保存的凭据损坏（${state.reason}）；不清空、不要求重登。`);
            if (state.status === 'REVOKED')
                throw new DomainError('KIMI_CREDENTIAL_REVOKED', 409, '凭据已被撤销；需要重新授权，且不得用旧 refresh 重试。');
            // A MISSING record is the legitimate pre-login state, so the one-time login path below must
            // still be able to query the upstream (see C04-5). It is refused further down, once the
            // upstream proves it IS logged in — see the dispatch guard after the account binding.
        }

        // models_ready only proves that a provider entry exists; it stays true after a restart even
        // when the credential is gone (observed on this machine). The account check below is the
        // real precondition, and the turn state remains the final proof.
        const auth = envelope(await this.transport('/api/v1/auth'));
        if (auth.models_ready !== true)
            throw new DomainError('KIMI_NOT_AUTHENTICATED', 409, '本机 Kimi 服务没有可用账户；不得回退到其他计费路径。');
        const account = envelope(await this.transport('/api/v1/oauth/userinfo'));
        const info = object(account.userInfo ?? {});
        const bound = (typeof info.userId === 'string' && info.userId.length > 0)
            || (typeof info.userLevelName === 'string' && info.userLevelName.length > 0);
        if (!bound)
            throw new DomainError('KIMI_ACCOUNT_NOT_BOUND', 409, '本机 Kimi 服务没有绑定账户（models_ready 可能来自残留配置）；必须先完成 OAuth 登录。');
        // The evidence belongs to one account generation. If the bound account changed since the
        // owner attested Extra Usage is off, the old record no longer describes this account.
        this.admission.assertAccount('kimi.dispatch:' + input.role, typeof info.userId === 'string' ? 'kimi:' + info.userId : '');
        // The upstream is authenticated, but this process holds no durable record. Dispatching here
        // would spend quota through a credential that cannot survive a restart — the "memory login as
        // a normal path" this project refuses — and it would contradict the status surface, which
        // already reports KIMI_CREDENTIALS_MISSING. Refuse before the first session/prompt write.
        if (this.authority && this.authority.current().status === 'MISSING')
            throw new DomainError('KIMI_CREDENTIALS_MISSING', 409, '本机身份已登录，但 Dream Maker 没有持久化凭据；未持久化的登录不能作为正常路径使用（这也不是登录失效）。');

        // The session cwd must exist on the machine that runs the Kimi server (Linux in WSL), not on
        // the Windows side that runs Dream Maker. Refuse rather than let the server answer 40409.
        const sessionWorkspace = c.workspace && c.workspace.length > 0 ? c.workspace : input.workspace;
        if (!sessionWorkspace.startsWith('/'))
            throw new DomainError('KIMI_WORKSPACE_NOT_MAPPED', 409, 'Kimi 服务的会话目录必须是 Linux 绝对路径（Windows 路径在 WSL 里不存在）。');
        const created = envelope(await this.transport('/api/v1/sessions', { method: 'POST', body: { metadata: { cwd: sessionWorkspace } } }));
        const sessionId = typeof created.id === 'string' ? created.id : '';
        if (!/^session_[A-Za-z0-9_-]{1,80}$/.test(sessionId))
            throw new DomainError('KIMI_SESSION_ID_MISSING', 502);
        track(sessionId);
        // Invariant: this run owns a brand-new session and submits exactly one prompt, which is why
        // reading only the newest transcript page is sound. The K03-K19 test pins that structure;
        // a future change that reuses sessions must switch to matching the turn by prompt id.

        const accepted = envelope(await this.transport(`/api/v1/sessions/${sessionId}/prompts`, {
            method: 'POST',
            body: { content: [{ type: 'text', text: input.prompt }], model: input.model }
        }));
        const promptId = typeof accepted.prompt_id === 'string' ? accepted.prompt_id : '';
        if (!promptId)
            throw new DomainError('KIMI_PROMPT_ID_MISSING', 502);
        onEvent({ method: 'dm/kimiAccepted', params: { role: input.role, sessionId, promptId, model: input.model } });

        const deadline = this.clock() + c.timeoutMs;
        // A 401 on the transcript is not a verdict on the grant. The Kimi server refreshes its own
        // token lazily, so the honest move is to re-read the same page (an idempotent GET) and let
        // that refresh happen before anything is escalated to "please log in again".
        let rejectedReads = 0;
        const MAX_REJECTED_READS = 2;
        while (this.clock() < deadline) {
            if (input.signal.aborted)
                throw new DomainError('RUN_CANCELLED', 409);
            await this.wait(c.pollMs);
            // Re-check after the wait: a cancellation that arrives during the poll interval must be
            // noticed before the next request goes out, not on the following iteration.
            if (input.signal.aborted)
                throw new DomainError('RUN_CANCELLED', 409);
            let transcript: Record<string, unknown>;
            try {
                // envelope() is inside the guarded region on purpose: the classified 401 is thrown by
                // the envelope step, and that is the failure the retry policy is about.
                transcript = envelope(await this.transport(`/api/v1/sessions/${sessionId}/transcript?agent_id=main&page_size=1`));
            }
            catch (error) {
                // Only a "not yet proven" 401 gets the benefit of the doubt. Anything else keeps its
                // own verdict (transient, region, cancellation) and stops here.
                const verdictCode = (error as { code?: unknown }).code;
                const unknownLayer = /^\[(L2_MANAGEMENT_AUTH|L4_TURN)\]/.test(String((error as { message?: unknown }).message ?? ''));
                if (verdictCode !== 'KIMI_AUTH_UNKNOWN' || !unknownLayer)
                    throw error;
                rejectedReads += 1;
                if (rejectedReads <= MAX_REJECTED_READS) {
                    // Give the server's lazy refresh a chance; the read is safe to repeat.
                    onEvent({ method: 'dm/kimiAuthRetry', params: { role: input.role, attempt: rejectedReads, layer: 'L4_TURN' } });
                    continue;
                }
                // A refresh was effectively attempted (the server had its chance) and the read is
                // still rejected: now, and only now, this is a real reauth requirement.
                throw kimiFailureError(classifyKimiFailure({
                    stage: 'REFRESH', httpStatus: 401, layer: 'L4_TURN', refreshAttempted: true,
                    message: String((error as { message?: unknown }).message ?? '')
                }));
            }
            const items = Array.isArray(transcript.items) ? transcript.items : [];
            const turn = object(items[0] ?? {});
            const state = typeof turn.state === 'string' ? turn.state : '';
            if (!TERMINAL.has(state))
                continue;
            const steps = Array.isArray(turn.steps) ? turn.steps : [];
            let text = '';
            let thinking = 0;
            let toolFrames = 0;
            let usage: Record<string, unknown> = {};
            for (const rawStep of steps) {
                const step = object(rawStep);
                const frames = Array.isArray(step.frames) ? step.frames : [];
                for (const rawFrame of frames) {
                    const frame = object(rawFrame);
                    const kind = typeof frame.kind === 'string' ? frame.kind : '';
                    if (TOOL_KINDS.has(kind)) toolFrames++;
                    if (kind === 'thinking' && typeof frame.text === 'string') thinking += frame.text.length;
                    if (kind === 'text' && frame.role === 'assistant' && typeof frame.text === 'string') text += frame.text;
                }
                // Keep the most recent step usage: in a multi-step turn the later step is the one
                // whose numbers describe the whole turn.
                if (step.usage !== undefined) usage = object(step.usage);
            }
            if (toolFrames > 0)
                throw new DomainError('KIMI_TOOL_EVENT_VIOLATION', 409, '零工具策略下出现工具帧；立即停止并记录违反策略。');
            if (state !== 'completed')
                throw new DomainError('KIMI_TURN_NOT_COMPLETED', 502, `回合终态为 ${state}；cancelled/failed/blocked 都不是成功。`);
            const output = redact(text);
            if (!output.trim())
                throw new DomainError('KIMI_EMPTY_OUTPUT', 502);
            // The transcript step usage does not always carry token counts (observed: no
            // input_tokens/output_tokens keys), while the session snapshot does. Prefer the
            // snapshot and keep the step usage as a fallback; never invent a number.
            let tokenSource: Record<string, unknown> = usage;
            try {
                const snap = envelope(await this.transport(`/api/v1/sessions/${sessionId}/snapshot`));
                const sessionUsage = object(object(snap.session ?? {}).usage ?? {});
                if (Object.keys(sessionUsage).length > 0) tokenSource = sessionUsage;
            }
            catch { /* keep the step usage when the snapshot is unavailable */ }
            const count = (key: string): number | null => {
                const value = tokenSource[key];
                return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
            };
            // Billable input is the uncached input plus everything read from cache: the snapshot's
            // input_tokens alone reads as 0 on a cache hit, which would understate a real call.
            const rawInput = count('input_tokens');
            const cacheRead = count('cache_read_tokens') ?? count('cache_creation_tokens');
            const billableInput = rawInput === null ? null : rawInput + (cacheRead ?? 0);
            const tokens: Usage = {
                role: input.role,
                inputTokens: billableInput,
                outputTokens: count('output_tokens'),
                costUsd: null,
                source: 'PROVIDER',
                requestId: promptId
            };
            onEvent({
                method: 'dm/kimiCompletion',
                params: { role: input.role, sessionId, promptId, model: input.model, status: 'completed', thinkingChars: thinking, answerHash: hash(output), rawInputTokens: rawInput, cacheReadTokens: cacheRead, billableInputTokens: billableInput, specHash: input.specHash, runId: input.runId }
            });
            // The receipt is built only from what this run actually observed over the REST
            // transcript (never from assumed WebSocket metadata), so the commit guard has
            // genuine values instead of synthesised identifiers.
            const receipt = {
                turnId: typeof turn.turnId === 'string' && turn.turnId.length > 0 ? turn.turnId : promptId,
                reason: 'completed',
                answerChars: output.length,
                answerHash: hash(output),
                sessionId,
                promptId,
                source: 'REST_TRANSCRIPT'
            };
            onEvent({ method: 'dm/kimiReceipt', params: { sessionId, promptId, turnId: receipt.turnId, reason: receipt.reason, answerChars: receipt.answerChars } });
            return { text: output, sessionId, usage: tokens, receipt } as AgentOutput & { receipt: typeof receipt };
        }
        throw new DomainError('KIMI_TURN_TIMEOUT', 504);
    }
}
