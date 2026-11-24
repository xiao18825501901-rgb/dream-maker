import { DomainError, hash } from './security.js';
import { planner1Binding } from './planner1-binding.js';
import type { AgentInput, Config, Runner } from '../shared/types.js';
import type { ProbeObservation } from './native-probes.js';
import type { KimiCredentialAuthority } from './kimi-credential-authority.js';

/**
 * K02/C05: the minimum probe for the subscription planner1.
 *
 * The four-role probe contract used to assume a paid OpenAI planner1, so the active Kimi binding
 * could never produce a planner1 receipt and the budget phase could never leave PROBE. That was a
 * deadlock, not a policy: the probe gate demanded a CNY ledger entry for a leg that has no CNY price.
 *
 * What is proved here instead, all from a real model answer:
 *  - a challenge nonce echoed by the model itself (the answer is not written by this process),
 *  - the credential generation that paid for the turn, read from the durable authority,
 *  - the account the credential belongs to, fingerprinted so a different account cannot be replayed,
 *  - a session that was actually archived, reported by the runner rather than assumed here,
 *  - no API ledger entry or paid fallback; subscription/extra-usage cost remains unknown.
 */
export type Planner1Probe = (challenge: string, signal: AbortSignal, workspace: string) => Promise<ProbeObservation>;

export interface Planner1ProbeLifecycle {
    schema: 'dream-maker.planner1-probe-lifecycle.v1';
    stage: 'STARTED' | 'ACCEPTED' | 'COMPLETED' | 'RECEIPT' | 'ARCHIVE' | 'VALIDATED' | 'FAILED';
    at: string; attemptId: string; model: string; credentialGeneration: number; accountFingerprint: string;
    evidence: 'RUNNER_OBSERVATION_NOT_NATIVE_QUALIFICATION'; costStatus: 'UNKNOWN'; costCny: null; costUsd: null;
    sessionId?: string; promptId?: string; turnId?: string; archived?: boolean; code?: string;
    answerHash?: string; rawInputTokens?: number | null; cacheReadTokens?: number | null;
    billableInputTokens?: number | null; inputTokens?: number | null; outputTokens?: number | null;
}
const journalId = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined;
const journalCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function createKimiPlanner1Probe(options: {
    getConfig: () => Config;
    runner: Runner;
    credentials?: Pick<KimiCredentialAuthority, 'barrier' | 'current'>;
    /** Controller-owned synchronous durable sink, never supplied by HTTP or a model. */
    onLifecycle?: (event: Readonly<Planner1ProbeLifecycle>) => void;
}): Planner1Probe {
    return async (challenge, signal, workspace) => {
        if (!/^DM_PROBE_[A-Za-z0-9]{32}$/.test(challenge))
            throw new DomainError('NATIVE_PROBE_CHALLENGE_INVALID', 409);
        const binding = planner1Binding(options.getConfig());
        if (binding.provider !== 'kimi' || binding.authMethod !== 'oauth')
            throw new DomainError('PLANNER1_RUNNER_ROUTE_MISMATCH', 409, '这不是 Kimi OAuth 绑定；不得用会员订阅回路冒充其他计费路径。');
        if (!binding.accountRef)
            throw new DomainError('KIMI_ACCOUNT_NOT_BOUND', 409);
        const credentials = options.credentials;
        if (!credentials)
            throw new DomainError('KIMI_PROBE_AUTHORITY_REQUIRED', 409, '没有持久化凭据权威时无法证明本次探测用的是哪一代凭据。');
        if (credentials.barrier() !== 'READY')
            throw new DomainError('KIMI_RESTORE_NOT_READY', 409, '凭据尚未完成 RESTORE 屏障；这不是登录失败。');
        const state = credentials.current();
        if (state.status !== 'OK')
            throw new DomainError('KIMI_CREDENTIALS_MISSING', 409, '本机身份已登录，但 Dream Maker 没有可用的持久化凭据。');
        if (!Number.isSafeInteger(state.generation) || state.generation < 1)
            throw new DomainError('KIMI_CREDENTIAL_GENERATION_INVALID', 409);
        const input: AgentInput = {
            role: 'planner1', workspace,
            prompt: 'Return exactly this JSON object and nothing else: ' + JSON.stringify({ probe: challenge }),
            model: binding.model, runId: 'probe_' + hash(challenge).slice(0, 20), specHash: hash({ challenge, role: 'planner1' }),
            laya: { role: 'planner1', mode: 'off', adoption: 'off', label: null, reason: 'MINIMUM_PROBE', latencyMs: 0, inputHash: '', modelRevision: null, confidence: null, cached: false },
            signal
        };
        const accountFingerprint = hash({ accountRef: binding.accountRef, generation: state.generation });
        const identity: {sessionId?: string; promptId?: string; turnId?: string} = {};
        let journalUnavailable = false;
        const emit = (stage: Planner1ProbeLifecycle['stage'], fields: Partial<Planner1ProbeLifecycle> = {}) => {
            if (!options.onLifecycle) return;
            try {
                const returned: unknown = options.onLifecycle(Object.freeze({
                    ...identity, ...fields, schema: 'dream-maker.planner1-probe-lifecycle.v1', stage,
                    at: new Date().toISOString(), attemptId: input.runId, model: binding.model,
                    credentialGeneration: state.generation, accountFingerprint,
                    evidence: 'RUNNER_OBSERVATION_NOT_NATIVE_QUALIFICATION', costStatus: 'UNKNOWN', costCny: null, costUsd: null
                }));
                if (returned !== undefined) {
                    if (returned instanceof Promise) void returned.catch(() => {});
                    throw new Error('SYNCHRONOUS_JOURNAL_REQUIRED');
                }
            } catch { journalUnavailable = true; throw new DomainError('KIMI_PROBE_JOURNAL_UNAVAILABLE', 503); }
        };
        emit('STARTED'); // Refuse a broken journal before the first possible model side effect.
        try {
        let archived = false;
        const seen = new Set<string>();
        const out = await options.runner.run(input, event => {
            if (!event || typeof event !== 'object') return;
            const e = event as {method?: unknown; params?: unknown};
            if (!e.params || typeof e.params !== 'object' || Array.isArray(e.params)) return;
            const p = e.params as Record<string, unknown>;
            const stage = e.method === 'dm/kimiAccepted' ? 'ACCEPTED' : e.method === 'dm/kimiCompletion' ? 'COMPLETED'
                : e.method === 'dm/kimiReceipt' ? 'RECEIPT' : e.method === 'dm/kimiArchive' ? 'ARCHIVE' : null;
            if (!stage || seen.has(stage)) return;
            seen.add(stage);
            for (const key of ['sessionId', 'promptId', 'turnId'] as const) {
                const id = journalId(p[key]);
                if (id && identity[key] && identity[key] !== id) throw new DomainError('KIMI_PROBE_EVENT_IDENTITY_MISMATCH', 502);
                if (id) identity[key] = id;
            }
            const fields: Partial<Planner1ProbeLifecycle> = {};
            if (stage === 'ARCHIVE') { archived = p.archived === true; fields.archived = archived; }
            if (stage === 'COMPLETED') {
                fields.rawInputTokens = journalCount(p.rawInputTokens); fields.cacheReadTokens = journalCount(p.cacheReadTokens);
                fields.billableInputTokens = journalCount(p.billableInputTokens);
                if (typeof p.answerHash === 'string' && /^[a-f0-9]{64}$/.test(p.answerHash)) fields.answerHash = p.answerHash;
            }
            emit(stage, fields);
        });
        // KimiRunner deliberately swallows archive-observer exceptions after cleanup. A durable
        // journal failure still disqualifies this response even when the runner returns normally.
        if (journalUnavailable) throw new DomainError('KIMI_PROBE_JOURNAL_UNAVAILABLE', 503);
        const receipt = (out as { receipt?: { turnId?: unknown; answerHash?: unknown; sessionId?: unknown } }).receipt;
        const responseId = typeof receipt?.turnId === 'string' ? receipt.turnId : '';
        const responseHash = typeof receipt?.answerHash === 'string' ? receipt.answerHash : '';
        const sessionId = typeof receipt?.sessionId === 'string' ? receipt.sessionId : String((out as { sessionId?: unknown }).sessionId ?? '');
        if (!responseId || !/^[A-Za-z0-9_-]{1,200}$/.test(responseId))
            throw new DomainError('KIMI_PROBE_RESPONSE_ID_REQUIRED', 502);
        if (!/^[a-f0-9]{64}$/.test(responseHash))
            throw new DomainError('KIMI_PROBE_RESPONSE_HASH_REQUIRED', 502);
        if (!sessionId || !/^[A-Za-z0-9_-]{1,200}$/.test(sessionId))
            throw new DomainError('KIMI_PROBE_SESSION_ID_REQUIRED', 502);
        if (identity.sessionId && identity.sessionId !== sessionId || identity.turnId && identity.turnId !== responseId)
            throw new DomainError('KIMI_PROBE_EVENT_IDENTITY_MISMATCH', 502);
        if (!archived)
            throw new DomainError('KIMI_PROBE_CLEANUP_UNVERIFIED', 409, '探测会话没有被归档；泄漏的会话不能当作干净的探测。');
        let reply = '';
        try {
            const parsed = JSON.parse(String((out as { text?: unknown }).text ?? '').trim()) as { probe?: unknown };
            if (typeof parsed.probe === 'string') reply = parsed.probe;
        } catch { /* a non-JSON answer simply fails the nonce check below */ }
        if (reply !== challenge)
            throw new DomainError('NATIVE_PROBE_KIMI_REPLY_UNVERIFIED', 409, '模型没有原样回抄挑战串；这不是真实本回合的答案。');
        Object.assign(identity, {sessionId, turnId: responseId});
        emit('VALIDATED', {inputTokens: journalCount(out.usage?.inputTokens), outputTokens: journalCount(out.usage?.outputTokens), answerHash: responseHash});
        return {
            role: 'planner1', model: binding.model, runner: 'KIMI_SERVER', provider: 'kimi-official',
            authentication: 'MEMBER_SUBSCRIPTION', responseId, responseHash, sessionId,
            accountFingerprint,
            credentialGeneration: state.generation, includedUsageAllowed: true, paidFallback: false,
            ledgerRequestIds: [], cleanupReturned: true, reply
        };
        } catch (error) {
            const code = error instanceof DomainError && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'KIMI_PROBE_RUNNER_FAILED';
            try { emit('FAILED', {code}); } catch { /* A failed journal must not mask the original failure or redispatch. */ }
            throw error;
        }
    };
}
