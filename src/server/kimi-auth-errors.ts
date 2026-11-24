import { DomainError } from './security.js';

/**
 * C02: Kimi authentication error attribution.
 *
 * Why this module exists: the pinned upstream `classifyFailure()` in
 * packages/agent-core-v2/src/app/auth/authService.ts collapses almost everything into one bucket —
 * DeviceCodeTimeoutError→expired, an OAuthError whose message contains "aborted"→cancelled, every
 * other OAuthError→denied, and **every other error→denied**. So `flow = "denied"` is a coarse
 * failure bucket, not evidence that a human pressed the reject button.
 *
 * Reporting "the user declined" on that basis is a wrong attribution, and it hid a real engineering
 * problem (memory-only storage) behind an apparent human gate. This module keeps the distinctions
 * the UI and the human queue need, and it refuses to blame the owner without proof.
 *
 * Nothing here is allowed to hold a token, a device code or a raw exception string.
 */
export type KimiAuthLayer = 'L1_LOCAL_SESSION' | 'L2_MANAGEMENT_AUTH' | 'L3_OAUTH' | 'L4_TURN';

export type KimiAuthFailureClass =
    /** Upstream really said access_denied / authorization_denied for this flow. */
    | 'USER_DENIED_PROVEN'
    /** Coarse bucket ("denied") with no proof of a refusal. */
    | 'OAUTH_FLOW_FAILED_UNKNOWN'
    | 'DEVICE_CODE_EXPIRED'
    | 'FLOW_CANCELLED'
    | 'TEMPORARY_NETWORK_ERROR'
    | 'TOKEN_PERSIST_FAILED'
    | 'AUTH_COMMIT_UNCERTAIN'
    | 'REGION_OR_POLICY_RESTRICTED'
    | 'REAUTH_REQUIRED';

export type KimiAuthStage = 'DEVICE_REQUEST' | 'DEVICE_POLL' | 'TOKEN_SAVE' | 'REFRESH' | 'CONFIG' | 'UNKNOWN';

export interface KimiFailureInput {
    stage?: KimiAuthStage;
    /** The flow status the local server reports (pending/expired/denied/cancelled/failed...). */
    flowStatus?: string;
    /** Upstream OAuth error code, when we actually have one (e.g. access_denied). */
    oauthErrorCode?: string;
    httpStatus?: number;
    /** Raw message; used ONLY for a coarse, redacted classification. */
    message?: string;
    /** True when a refresh was requested but the durable commit result is not known. */
    rotationUncertain?: boolean;
    /**
     * Where the failure was observed. The four layers must stay distinguishable: a 401 on a model
     * turn (L4) or on the local management bearer (L2) is not evidence that the Kimi account needs
     * a new OAuth login (L3).
     */
    layer?: KimiAuthLayer;
    /** True only when an official refresh was actually attempted before this observation. */
    refreshAttempted?: boolean;
    /** True when a persist attempt failed. */
    persistFailed?: boolean;
    generation?: number;
}

export interface KimiFailureVerdict {
    class: KimiAuthFailureClass;
    layer: KimiAuthLayer;
    /** Can this be retried without a human? */
    retryable: boolean;
    /** Does the human queue need an entry? */
    requiresUserAction: boolean;
    /** Must the caller stop using credentials (do not silently retry with an old refresh token)? */
    stopCredentialUse: boolean;
    /** Fixed, redaction-safe explanation for logs and the UI. */
    reason: string;
}

const DENY_CODES = ['access_denied', 'authorization_denied', 'user_cancelled_authorization'];

/**
 * Redact a message before it can reach a log, a status endpoint or a human queue.
 * Device codes look like `ABCD-EFGH`; URLs carry the device code and sometimes a token.
 */
export function redactAuthMessage(input: string | undefined, limit = 180): string {
    if (typeof input !== 'string' || input.length === 0) return '';
    let out = input
        .replace(/https?:\/\/\S+/gi, '<url>')
        .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '<device-code>')
        // Key-shaped strings only. The previous pattern (`dm` + 8 chars) also matched ordinary
        // hyphenated words like `dm-bridge-smoke`, which silently mangled paths in tracebacks.
        .replace(/\b(?:sk|ak)-[A-Za-z0-9]{8,}\b/gi, '<token>')
        .replace(/\bDM_[A-Z0-9_]{8,}\b/g, '<token>')
        // Long opaque strings are redacted, but a PATH is not a secret and redacting it turns every
        // traceback into an unreadable puzzle (observed: "/tmp/<token>/connect.py"). Paths keep their
        // shape; only same-length strings without a path separator are treated as opaque.
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, match => (/[\\/]/.test(match) ? match : '<opaque>'))
        .replace(/\s+/g, ' ')
        .trim();
    if (out.length > limit) out = out.slice(0, limit) + '…';
    return out;
}

export function classifyKimiFailure(input: KimiFailureInput): KimiFailureVerdict {
    const message = (input.message ?? '').toLowerCase();
    const code = (input.oauthErrorCode ?? '').toLowerCase();
    const flow = (input.flowStatus ?? '').toLowerCase();
    const stage = input.stage ?? 'UNKNOWN';

    // 1) A rotation whose durable outcome is unknown wins over everything else: the caller must not
    //    reach for the old refresh token while the new one may already be committed upstream.
    if (input.rotationUncertain === true)
        return { class: 'AUTH_COMMIT_UNCERTAIN', layer: 'L3_OAUTH', retryable: false, requiresUserAction: false, stopCredentialUse: true, reason: '已请求轮转但持久化结果未知；先对账，不重发刷新。' };
    if (input.persistFailed === true)
        return { class: 'TOKEN_PERSIST_FAILED', layer: 'L3_OAUTH', retryable: true, requiresUserAction: false, stopCredentialUse: true, reason: '令牌保存失败；未 ACK，不宣称已保存。' };

    // A caller that knows where it observed the failure always wins over a stage-based guess: the
    // layer must describe the observation, not the most likely caller.
    const observed = input.layer;

    // 2) Only a real upstream denial, observed in the authorisation flow, counts as a refusal.
    //    A 403 that merely carries the text "access_denied" on a model turn (L4) or on the local
    //    management bearer (L2) is not evidence about the owner's decision — turning it into
    //    "please authorise again" would blame a human for a server-side policy. Outside the OAuth
    //    flow it keeps falling through to the policy / unknown branches below.
    const inOauthFlow = observed === undefined || observed === 'L3_OAUTH'
        || stage === 'DEVICE_REQUEST' || stage === 'DEVICE_POLL' || stage === 'REFRESH';
    if (inOauthFlow && (DENY_CODES.includes(code) || message.includes('access_denied') || message.includes('authorization denied')))
        return { class: 'USER_DENIED_PROVEN', layer: observed ?? 'L3_OAUTH', retryable: false, requiresUserAction: true, stopCredentialUse: true, reason: '上游返回明确的授权拒绝（access_denied）。' };

    // 3) The coarse bucket: no proof of a human decision.
    if (flow === 'denied')
        return { class: 'OAUTH_FLOW_FAILED_UNKNOWN', layer: observed ?? 'L3_OAUTH', retryable: true, requiresUserAction: false, stopCredentialUse: true, reason: '上游把本次失败归入 denied 粗桶；没有 access_denied 证据，不能认定是用户拒绝。' };

    // A device code can only expire inside the device flow. A model turn or a refresh that times out
    // is a transport condition — calling it DEVICE_CODE_EXPIRED would send a reader back to the login
    // page for a slow socket. The message form is kept only when it names the device code itself.
    const deviceFlow = stage === 'DEVICE_REQUEST' || stage === 'DEVICE_POLL';
    const timedOut = message.includes('timeout') || message.includes('timed out');
    if (flow === 'expired' || message.includes('device code') || (deviceFlow && timedOut))
        return { class: 'DEVICE_CODE_EXPIRED', layer: observed ?? 'L3_OAUTH', retryable: true, requiresUserAction: false, stopCredentialUse: false, reason: '设备码或轮询超时；这不是授权结论。' };

    if (flow === 'cancelled' || flow === 'canceled' || message.includes('aborted'))
        return { class: 'FLOW_CANCELLED', layer: observed ?? 'L3_OAUTH', retryable: true, requiresUserAction: false, stopCredentialUse: false, reason: '流程被本机取消（abort）。' };

    // 4) Transient transport problems never invalidate credentials.
    if (input.httpStatus === 429 || input.httpStatus === 502 || input.httpStatus === 503 || input.httpStatus === 504
        || /etimedout|econnreset|econnrefused|enotfound|socket hang up|network|fetch failed|temporary|timeout|timed out/.test(message))
        return { class: 'TEMPORARY_NETWORK_ERROR', layer: observed ?? (stage === 'DEVICE_POLL' || stage === 'REFRESH' ? 'L3_OAUTH' : 'L2_MANAGEMENT_AUTH'), retryable: true, requiresUserAction: false, stopCredentialUse: false, reason: '临时网络/服务不可用；保留凭据，有界退避。' };

    // 5) Policy/region refusals are not user faults either.
    if (input.httpStatus === 403 || /forbidden|region|policy|not available in your/.test(message))
        return { class: 'REGION_OR_POLICY_RESTRICTED', layer: observed ?? 'L3_OAUTH', retryable: false, requiresUserAction: false, stopCredentialUse: false, reason: '服务端策略/地区限制（HTTP 403 或等价提示）；不改代理/地区，独立记录。' };

    // 6) A 401 is only evidence about the layer it was observed on. On a model turn (L4) or on the
    //    local management bearer (L2) it says nothing about the OAuth grant, so demanding a new
    //    login would be a wrong attribution — the exact bug the four-layer split exists to prevent.
    //    The same rule applies whether the rejection arrived as an HTTP status or only as message
    //    text: an `unauthorized`/"revoked" string on a turn or a management call is not proof either.
    const rejected = input.httpStatus === 401 || message.includes('revoked') || message.includes('unauthorized');
    if (rejected) {
        const layer = observed ?? 'L3_OAUTH';
        const outsideGrant = layer === 'L1_LOCAL_SESSION' || layer === 'L2_MANAGEMENT_AUTH' || layer === 'L4_TURN';
        if (outsideGrant && input.refreshAttempted !== true)
            return {
                class: 'OAUTH_FLOW_FAILED_UNKNOWN', layer, retryable: true, requiresUserAction: false, stopCredentialUse: false,
                reason: layer === 'L4_TURN'
                    ? '模型回合层收到拒绝，但尚未尝试官方 refresh；这不证明凭据失效，先刷新再判断，不要求重登。'
                    : '本机会话/管理令牌被拒绝（L1/L2）；重启本地服务并重新读取令牌即可，不代表 Kimi 账户需要重新授权。'
            };
        return { class: 'REAUTH_REQUIRED', layer, retryable: false, requiresUserAction: true, stopCredentialUse: true, reason: '凭据被服务端拒绝或已撤销；需要重新授权。' };
    }

    return { class: 'OAUTH_FLOW_FAILED_UNKNOWN', layer: observed ?? 'L3_OAUTH', retryable: true, requiresUserAction: false, stopCredentialUse: false, reason: '无法证明的失败原因；记 UNKNOWN，不归因用户。' };
}

/** Human-queue gate: only a proven refusal or a proven revocation may ask the owner to act. */
export function assertNoBlameWithoutProof(verdict: KimiFailureVerdict, flowStatus: string | undefined): void {
    // Second safety net: even a "proven" refusal is only meaningful inside the authorisation flow.
    // A verdict that claims the owner refused while being observed on a turn or a management call is
    // a programming error, not something to show a human.
    if (verdict.class === 'USER_DENIED_PROVEN' && verdict.layer !== 'L3_OAUTH')
        throw new DomainError('KIMI_AUTH_BLAME_WITHOUT_PROOF', 409, '只有在授权流程（L3）里观察到的拒绝才能归因为用户拒绝。');
    if (verdict.class === 'USER_DENIED_PROVEN') return;
    if ((flowStatus ?? '').toLowerCase() === 'denied' && verdict.requiresUserAction)
        throw new DomainError('KIMI_AUTH_BLAME_WITHOUT_PROOF', 409, '没有 access_denied 证据时不得把失败归因为用户拒绝。');
}
/**
 * The HTTP status the Kimi server answered with.
 *
 * `loopbackFetch` used to discard it before parsing the body, which threw away the only cheap
 * evidence for attribution (401 vs 429 vs 503). It is carried as a NON-ENUMERABLE property so the
 * body stays byte-identical for every existing caller: `JSON.stringify`, `object()`, `envelope()`
 * and deep-equality assertions cannot see it.
 */
const HTTP_STATUS = Symbol.for('dream-maker.kimi.httpStatus');
const HTTP_PATH = Symbol.for('dream-maker.kimi.httpPath');

export function attachHttpStatus<T extends object>(body: T, status: number, path?: string): T {
    if (!Number.isInteger(status)) return body;
    Object.defineProperty(body, HTTP_STATUS, { value: status, enumerable: false, configurable: true, writable: false });
    if (typeof path === 'string')
        Object.defineProperty(body, HTTP_PATH, { value: path, enumerable: false, configurable: true, writable: false });
    return body;
}

export function httpStatusOf(body: unknown): number | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const value = (body as Record<symbol, unknown>)[HTTP_STATUS];
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function httpPathOf(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const value = (body as Record<symbol, unknown>)[HTTP_PATH];
    return typeof value === 'string' ? value : undefined;
}

/** Which of the four layers a Kimi REST path belongs to. */
export function layerForPath(path: string): KimiAuthLayer {
    if (/^\/api\/v1\/(sessions|prompts)(\/|\?|$)/.test(path) || path.includes('/transcript')) return 'L4_TURN';
    if (path.startsWith('/api/v1/oauth')) return 'L3_OAUTH';
    return 'L2_MANAGEMENT_AUTH';
}

const ERROR_MAP: Record<KimiAuthFailureClass, { code: string; status: number }> = {
    AUTH_COMMIT_UNCERTAIN: { code: 'KIMI_AUTH_COMMIT_UNCERTAIN', status: 409 },
    TOKEN_PERSIST_FAILED: { code: 'KIMI_TOKEN_PERSIST_FAILED', status: 409 },
    USER_DENIED_PROVEN: { code: 'KIMI_AUTH_USER_DENIED', status: 403 },
    OAUTH_FLOW_FAILED_UNKNOWN: { code: 'KIMI_AUTH_UNKNOWN', status: 502 },
    DEVICE_CODE_EXPIRED: { code: 'KIMI_AUTH_DEVICE_EXPIRED', status: 409 },
    FLOW_CANCELLED: { code: 'KIMI_AUTH_CANCELLED', status: 409 },
    TEMPORARY_NETWORK_ERROR: { code: 'KIMI_AUTH_TRANSIENT', status: 503 },
    REGION_OR_POLICY_RESTRICTED: { code: 'KIMI_AUTH_REGION', status: 403 },
    REAUTH_REQUIRED: { code: 'KIMI_REAUTH_REQUIRED', status: 401 }
};

/**
 * Turn a verdict into the error a caller may throw. The layer is part of the message on purpose:
 * "L4 401, refresh not attempted" and "L3 revoked" must never read the same in a log or the UI.
 */
export function kimiFailureError(verdict: KimiFailureVerdict): DomainError {
    const mapped = ERROR_MAP[verdict.class];
    return new DomainError(mapped.code, mapped.status, `[${verdict.layer}] ${verdict.reason}`);
}
/** Inverse of ERROR_MAP: which class an error code came from, or undefined for a non-auth code. */
export function classForErrorCode(code: string): KimiAuthFailureClass | undefined {
    for (const [cls, mapped] of Object.entries(ERROR_MAP))
        if (mapped.code === code) return cls as KimiAuthFailureClass;
    return undefined;
}

/** Read the layer back out of an error message written by kimiFailureError(). */
export function layerFromMessage(message: string): KimiAuthLayer {
    const match = /^\[(L1_LOCAL_SESSION|L2_MANAGEMENT_AUTH|L3_OAUTH|L4_TURN)\]/.exec(message);
    return (match?.[1] as KimiAuthLayer | undefined) ?? 'L3_OAUTH';
}
