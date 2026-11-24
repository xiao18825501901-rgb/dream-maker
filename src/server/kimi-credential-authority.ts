import { DomainError } from './security.js';
import type { KimiTokenStore } from './kimi-token-store.js';
import type { KimiAdmission } from './kimi-admission.js';

/**
 * C03: the durable credential authority.
 *
 * One owner, one record, one generation. The rules come straight from the reliability contract:
 *  - `restore()` is a BARRIER. Until it finishes, nothing may read a token; a caller that asks too
 *    early gets KIMI_RESTORE_NOT_READY instead of `undefined` (undefined is what made "damaged
 *    store" and "first login" indistinguishable).
 *  - A complete official TokenInfo is persisted (accessToken, refreshToken, expiresAt, expiresIn,
 *    scope, tokenType) — not just the access token.
 *  - `commit()` is the only way a new generation is written; it returns the ACK only after the
 *    store write succeeded, and replaying the same messageId with the same content returns the same
 *    ACK without a second write (this is what makes a lost ACK recoverable).
 *  - A revoked tombstone (empty tokens) is a legitimate state, not an incomplete token.
 *  - A late logout cannot delete a newer generation.
 */
export const TOKEN_FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'expiresIn', 'scope', 'tokenType'] as const;

/**
 * The upstream `TokenInfo.expiresAt` is **Unix SECONDS** (`packages/oauth/src/types.ts`: "Unix seconds
 * when access_token expires"), while every `Date`/comparison in this codebase works in milliseconds.
 * Mixing them makes a live token look like it expired in 1970 — which is exactly what happened once.
 * Callers that need a comparable instant use this helper instead of the raw field.
 */
export function expiresAtMs(token: Pick<TokenInfo, 'expiresAt'>): number {
    const value = typeof token.expiresAt === 'number' && Number.isFinite(token.expiresAt) ? token.expiresAt : 0;
    // Guard against an already-millisecond record (some fixtures/tests use ms).
    return value > 1e11 ? value : value * 1000;
}

export interface TokenInfo {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    expiresIn: number;
    scope: string;
    tokenType: string;
}

export type StoredCredentialState =
    | { status: 'MISSING' }
    | {
        status: 'OK'; token: TokenInfo; generation: number; messageId: string;
        /** When this record was written, so a failure observed BEFORE it is known to be superseded. */
        savedAtMs: number | null;
    }
    | { status: 'REVOKED'; generation: number; messageId: string }
    | { status: 'CORRUPT'; reason: string };

export type BarrierState = 'NOT_STARTED' | 'PENDING' | 'READY' | 'FAILED';

export interface CredentialAck {
    ack: true;
    generation: number;
    messageId: string;
    /** True when this call confirmed an already-committed generation instead of writing again. */
    replay: boolean;
}

export interface KimiCredentialAuthority {
    restore(): Promise<StoredCredentialState>;
    barrier(): BarrierState;
    assertReady(): void;
    current(): StoredCredentialState;
    /** Usable token or a precise error; never `undefined`. */
    requireToken(): TokenInfo;
    commit(input: { token: TokenInfo; generation: number; messageId: string }): Promise<CredentialAck>;
    revoke(input: { generation: number; messageId: string; scope?: string; tokenType?: string }): Promise<CredentialAck>;
    logout(input: { generation: number }): Promise<{ removed: boolean; ignored: boolean }>;
}

const META = '__dm';
const TOKEN_NAME = 'kimi-code';

function fail(code: string, message: string): never {
    throw new DomainError(code, 409, message);
}

function isTokenInfo(value: unknown): value is TokenInfo {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const t = value as Record<string, unknown>;
    if (typeof t.accessToken !== 'string' || t.accessToken.length === 0) return false;
    if (typeof t.refreshToken !== 'string' || t.refreshToken.length === 0) return false;
    if (typeof t.expiresAt !== 'number' || !Number.isFinite(t.expiresAt)) return false;
    if (typeof t.expiresIn !== 'number' || !Number.isFinite(t.expiresIn)) return false;
    if (typeof t.scope !== 'string') return false;
    if (typeof t.tokenType !== 'string' || t.tokenType.length === 0) return false;
    return true;
}

/** Validate the whole official TokenInfo: persisting only the access token is the defect this closes. */
export function assertCompleteToken(token: unknown): TokenInfo {
    if (!isTokenInfo(token)) {
        const t = (token ?? {}) as Record<string, unknown>;
        const missing = TOKEN_FIELDS.filter(f => t[f] === undefined || t[f] === '');
        fail('KIMI_TOKEN_INCOMPLETE', `令牌记录缺少字段：${missing.join(',') || 'accessToken/refreshToken'}；不得只保存 accessToken。`);
    }
    return token;
}

function encode(token: TokenInfo, meta: { status: 'OK' | 'REVOKED'; generation: number; messageId: string; savedAt: string }): Record<string, unknown> {
    return { ...token, [META]: meta };
}

function decode(record: Record<string, unknown>): StoredCredentialState {
    const meta = record[META];
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta))
        return { status: 'CORRUPT', reason: 'NO_META' };
    const m = meta as Record<string, unknown>;
    const generation = typeof m.generation === 'number' ? m.generation : Number.NaN;
    const messageId = typeof m.messageId === 'string' ? m.messageId : '';
    if (!Number.isInteger(generation) || generation < 1 || messageId.length === 0)
        return { status: 'CORRUPT', reason: 'BAD_META' };
    if (m.status === 'REVOKED')
        return { status: 'REVOKED', generation, messageId };
    if (m.status !== 'OK')
        return { status: 'CORRUPT', reason: 'BAD_STATUS' };
    const token = {
        accessToken: record.accessToken, refreshToken: record.refreshToken, expiresAt: record.expiresAt,
        expiresIn: record.expiresIn, scope: record.scope, tokenType: record.tokenType
    } as unknown as TokenInfo;
    if (!isTokenInfo(token)) return { status: 'CORRUPT', reason: 'BAD_TOKEN' };
    const savedAt = typeof m.savedAt === 'string' ? Date.parse(m.savedAt) : Number.NaN;
    return { status: 'OK', token, generation, messageId, savedAtMs: Number.isFinite(savedAt) ? savedAt : null };
}

export function createKimiCredentialAuthority(options: {
    store: KimiTokenStore;
    name?: string;
    clock?: () => number;
    /** Admission is NOT consulted here: durable restore is allowed while inference stays refused. */
    admission?: KimiAdmission;
}): KimiCredentialAuthority {
    const store = options.store;
    const name = options.name ?? TOKEN_NAME;
    const clock = options.clock ?? (() => Date.now());
    let barrier: BarrierState = 'NOT_STARTED';
    let current: StoredCredentialState = { status: 'MISSING' };
    let lastAck: CredentialAck | undefined;

    const readRecord = async (): Promise<StoredCredentialState> => {
        const stored = await store.loadRecord(name);
        if (stored.status === 'MISSING') return { status: 'MISSING' };
        if (stored.status === 'CORRUPT') return { status: 'CORRUPT', reason: stored.reason };
        return decode(stored.record);
    };

    return {
        async restore() {
            barrier = 'PENDING';
            try {
                current = await readRecord();
                // CORRUPT is a real failure of the restore, not an empty account. The barrier still
                // lifts (callers need the diagnosis) but every token access refuses.
                barrier = current.status === 'CORRUPT' ? 'FAILED' : 'READY';
                return current;
            }
            catch {
                barrier = 'FAILED';
                current = { status: 'CORRUPT', reason: 'RESTORE_FAILED' };
                return current;
            }
        },
        barrier: () => barrier,
        assertReady() {
            if (barrier !== 'READY') fail('KIMI_RESTORE_NOT_READY', '凭据尚未完成 RESTORE 屏障；不允许读取令牌（这不是"首次登录"）。');
        },
        current: () => current,
        requireToken() {
            if (barrier === 'NOT_STARTED' || barrier === 'PENDING') fail('KIMI_RESTORE_NOT_READY', '凭据尚未完成 RESTORE 屏障。');
            switch (current.status) {
                case 'OK': return current.token;
                case 'MISSING': fail('KIMI_CREDENTIALS_MISSING', '没有任何已保存的凭据。');
                case 'REVOKED': fail('KIMI_CREDENTIAL_REVOKED', '凭据已被撤销；需要重新授权。');
                default: fail('KIMI_STORED_STATE_CORRUPT', `已保存的凭据损坏（${current.reason}）；不清空、不当作首次登录。`);
            }
        },
        async commit({ token, generation, messageId }) {
            if (barrier !== 'READY') fail('KIMI_RESTORE_NOT_READY', '必须先完成 RESTORE 才能提交新令牌。');
            assertCompleteToken(token);
            if (!Number.isInteger(generation) || generation < 1) fail('KIMI_GENERATION_INVALID', 'generation 必须是 ≥1 的整数。');
            if (messageId.length === 0) fail('KIMI_MESSAGE_ID_INVALID', 'messageId 不能为空。');
            const committed = current.status === 'OK' || current.status === 'REVOKED' ? current : undefined;
            const committedOk = current.status === 'OK' ? current : undefined;
            if (committed) {
                if (messageId === committed.messageId && committedOk) {
                    // A lost ACK may be replayed — but only for the SAME generation and the SAME token.
                    // Same id with a different generation or different content is a protocol violation,
                    // and silently ACKing it would let a stale caller overwrite a newer rotation.
                    const same = generation === committedOk.generation
                        && token.accessToken === committedOk.token.accessToken
                        && token.refreshToken === committedOk.token.refreshToken;
                    if (!same) fail('KIMI_ROTATE_REPLAY_MISMATCH', '同一 messageId 携带了不同的代数或令牌内容；拒绝。');
                    const ack: CredentialAck = { ack: true, generation: committed.generation, messageId, replay: true };
                    lastAck = ack;
                    return ack;
                }
                if (messageId === committed.messageId && current.status === 'REVOKED')
                    fail('KIMI_ROTATE_REPLAY_MISMATCH', '同一 messageId 已作为撤销提交；不能复用为登录。');
                if (generation <= committed.generation) fail('KIMI_ROTATE_GENERATION_STALE', '代数是旧的；拒绝用旧令牌覆盖已提交的更新记录。');
                if (generation > committed.generation + 1) fail('KIMI_ROTATE_GENERATION_SKIPPED', '代数跳号；本地与桥接端状态不一致，先对账。');
            }
            try {
                await store.save(name, encode(token, { status: 'OK', generation, messageId, savedAt: new Date(clock()).toISOString() }));
            }
            catch {
                // No ACK on a failed write: the caller must treat persistence as unproven.
                fail('KIMI_TOKEN_PERSIST_FAILED', '令牌写入失败；没有 ACK，不得宣称已保存。');
            }
            const after = await store.loadRecord(name);
            if (after.status !== 'OK') fail('KIMI_TOKEN_PERSIST_UNVERIFIED', '写入后无法读回；没有 ACK。');
            const verified = decode(after.record);
            if (verified.status !== 'OK' || verified.generation !== generation || verified.messageId !== messageId)
                fail('KIMI_TOKEN_PERSIST_UNVERIFIED', '写入后读回的内容与提交不一致；没有 ACK。');
            current = verified;
            const ack: CredentialAck = { ack: true, generation, messageId, replay: false };
            lastAck = ack;
            return ack;
        },
        async revoke({ generation, messageId, scope = '', tokenType = 'Bearer' }) {
            if (barrier !== 'READY') fail('KIMI_RESTORE_NOT_READY', '必须先完成 RESTORE 才能提交撤销。');
            if (!Number.isInteger(generation) || generation < 1) fail('KIMI_GENERATION_INVALID', 'generation 必须是 ≥1 的整数。');
            if (messageId.length === 0) fail('KIMI_MESSAGE_ID_INVALID', 'messageId 不能为空。');
            const committed = current.status === 'OK' || current.status === 'REVOKED' ? current : undefined;
            if (committed) {
                // A revocation that lost its ACK may be replayed exactly like a commit. It must be
                // idempotent for the SAME id+generation, and refused for anything else — otherwise a
                // retry after a dropped ACK reads as a protocol violation and the peer is left
                // believing the revocation was rejected while the tombstone is already on disk.
                if (messageId === committed.messageId) {
                    if (generation !== committed.generation)
                        fail('KIMI_ROTATE_REPLAY_MISMATCH', '同一 messageId 携带了不同的代数；拒绝。');
                    if (current.status !== 'REVOKED')
                        fail('KIMI_ROTATE_REPLAY_MISMATCH', '同一 messageId 已作为登录提交；不能复用为撤销。');
                    const replayed: CredentialAck = { ack: true, generation, messageId, replay: true };
                    lastAck = replayed;
                    return replayed;
                }
                if (generation <= committed.generation)
                    fail('KIMI_ROTATE_GENERATION_STALE', '撤销代数不是新的；拒绝。');
                if (generation > committed.generation + 1)
                    fail('KIMI_ROTATE_GENERATION_SKIPPED', '代数跳号；本地与桥接端状态不一致，先对账。');
            }
            // The upstream tombstone carries empty token fields on purpose; validation must allow it.
            const tombstone: TokenInfo = { accessToken: '', refreshToken: '', expiresAt: 0, expiresIn: 0, scope, tokenType };
            try {
                await store.save(name, encode(tombstone, { status: 'REVOKED', generation, messageId, savedAt: new Date(clock()).toISOString() }));
            }
            catch {
                // Same durability contract as commit: no ACK when the write is unproven.
                fail('KIMI_TOKEN_PERSIST_FAILED', '撤销写入失败；没有 ACK，不得宣称已撤销。');
            }
            const after = await store.loadRecord(name);
            if (after.status !== 'OK') fail('KIMI_TOKEN_PERSIST_UNVERIFIED', '撤销写入后无法读回；没有 ACK。');
            const verified = decode(after.record);
            if (verified.status !== 'REVOKED' || verified.generation !== generation || verified.messageId !== messageId)
                fail('KIMI_TOKEN_PERSIST_UNVERIFIED', '撤销读回的内容与提交不一致；没有 ACK。');
            current = verified;
            const ack: CredentialAck = { ack: true, generation, messageId, replay: false };
            lastAck = ack;
            return ack;
        },
        async logout({ generation }) {
            // Without RESTORE this instance has not read the durable record yet, so `current` is a
            // default MISSING that says nothing about the disk. Deleting on that basis would let a
            // late logout from a previous session wipe a credential this process never saw.
            if (barrier !== 'READY') fail('KIMI_RESTORE_NOT_READY', '必须先完成 RESTORE 才能处理登出。');
            if (!Number.isInteger(generation) || generation < 1) fail('KIMI_GENERATION_INVALID', 'generation 必须是 ≥1 的整数。');
            const committed = current.status === 'OK' || current.status === 'REVOKED' ? current : undefined;
            // A logout that arrives after a newer login must not delete the newer record.
            if (committed && generation < committed.generation) return { removed: false, ignored: true };
            await store.remove(name);
            current = { status: 'MISSING' };
            lastAck = undefined;
            return { removed: true, ignored: false };
        }
    };
}
