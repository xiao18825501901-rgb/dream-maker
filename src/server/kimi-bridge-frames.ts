import { DomainError } from './security.js';

/**
 * A02: the trusted byte channel between the Linux bridge (which owns the Kimi process) and the
 * Windows controller (which alone can use DPAPI).
 *
 * Design constraints that shaped this file:
 *  - It is a TRANSPORT, not cryptography. Tokens travel inside a private pipe; the only thing that
 *    protects them at rest is DPAPI on the Windows side, after the controller has verified the
 *    frame's identity and generation.
 *  - Every frame is length-prefixed (4-byte big-endian) so a stream cannot desynchronise on a
 *    token containing newlines or quotes, and a truncated frame is a hard error rather than a
 *    silently shorter value.
 *  - Identity is explicit: protocolVersion + instanceId + accountRef + storageName + generation +
 *    messageId. A frame for another namespace, another account, or an older generation is refused
 *    even if its bytes parse cleanly.
 */
export const PROTOCOL_VERSION = 1;
export const FRAME_LIMIT = 64 * 1024;
/** The storage name is the value the upstream toolkit looks tokens up by (see 52-K03W). */
export const STORAGE_NAME = 'kimi-code';

export type FrameType = 'HELLO' | 'RESTORE' | 'ROTATE' | 'COMMIT_ACK' | 'ERROR' | 'CLOSE';
const TYPES: readonly string[] = ['HELLO', 'RESTORE', 'ROTATE', 'COMMIT_ACK', 'ERROR', 'CLOSE'];

export interface BridgeFrame {
    type: FrameType;
    protocolVersion: number;
    instanceId: string;
    storageName: string;
    generation?: number;
    messageId?: string;
    accountRef?: string;
    token?: Record<string, unknown>;
    code?: string;
}

function fail(code: string, message: string): never {
    throw new DomainError(code, 409, message);
}

export function encodeFrame(frame: BridgeFrame): Buffer {
    const body = Buffer.from(JSON.stringify(frame), 'utf8');
    if (body.length > FRAME_LIMIT)
        fail('KIMI_FRAME_TOO_LARGE', '帧超过 64KiB 上限；拒绝发送。');
    const out = Buffer.allocUnsafe(4 + body.length);
    out.writeUInt32BE(body.length, 0);
    body.copy(out, 4);
    return out;
}

function validate(frame: unknown): BridgeFrame {
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame))
        fail('KIMI_FRAME_INVALID', '帧不是 JSON 对象。');
    const f = frame as Record<string, unknown>;
    const type = typeof f.type === 'string' ? f.type : '';
    if (!TYPES.includes(type))
        fail('KIMI_FRAME_TYPE_UNKNOWN', '未知帧类型。');
    if (f.protocolVersion !== PROTOCOL_VERSION)
        fail('KIMI_FRAME_PROTOCOL_MISMATCH', '协议版本不匹配。');
    if (typeof f.instanceId !== 'string' || f.instanceId.length === 0)
        fail('KIMI_FRAME_IDENTITY_MISSING', '帧缺少 instanceId。');
    if (f.storageName !== STORAGE_NAME)
        fail('KIMI_FRAME_NAMESPACE_MISMATCH', `帧的 storageName 必须是 ${STORAGE_NAME}。`);
    const needsOrder = type === 'ROTATE' || type === 'COMMIT_ACK';
    if (needsOrder) {
        if (!Number.isInteger(f.generation) || (f.generation as number) < 1)
            fail('KIMI_FRAME_GENERATION_INVALID', 'ROTATE/COMMIT_ACK 必须带 generation≥1。');
        if (typeof f.messageId !== 'string' || f.messageId.length === 0)
            fail('KIMI_FRAME_MESSAGE_ID_MISSING', 'ROTATE/COMMIT_ACK 必须带 messageId。');
    }
    if (type === 'ROTATE') {
        if (typeof f.accountRef !== 'string' || f.accountRef.length === 0)
            fail('KIMI_FRAME_ACCOUNT_MISSING', 'ROTATE 必须带 accountRef。');
        if (f.token === null || typeof f.token !== 'object' || Array.isArray(f.token))
            fail('KIMI_FRAME_TOKEN_INVALID', 'ROTATE 的 token 必须是对象。');
    }
    return {
        type: type as FrameType,
        protocolVersion: PROTOCOL_VERSION,
        instanceId: f.instanceId,
        storageName: STORAGE_NAME,
        generation: typeof f.generation === 'number' ? f.generation : undefined,
        messageId: typeof f.messageId === 'string' ? f.messageId : undefined,
        accountRef: typeof f.accountRef === 'string' ? f.accountRef : undefined,
        token: f.token as Record<string, unknown> | undefined,
        code: typeof f.code === 'string' ? f.code : undefined
    };
}

export interface FrameDecoder {
    /** Feed arbitrary bytes; returns the frames that became complete. */
    push(chunk: Buffer): BridgeFrame[];
    /** Refuse a stream that ended mid-frame. */
    finish(): void;
    pending(): number;
}

/**
 * Incremental decoder. A pipe gives no message boundaries, so this must cope with one frame split
 * across many reads and with many frames arriving in one read — both are covered by tests.
 */
export function createFrameDecoder(limit = FRAME_LIMIT): FrameDecoder {
    let buffer = Buffer.alloc(0);
    return {
        push(chunk) {
            buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
            const frames: BridgeFrame[] = [];
            for (;;) {
                if (buffer.length < 4)
                    break;
                const length = buffer.readUInt32BE(0);
                if (length === 0)
                    fail('KIMI_FRAME_EMPTY', '长度为 0 的帧是非法输入。');
                if (length > limit)
                    fail('KIMI_FRAME_TOO_LARGE', '帧声明长度超过上限；拒绝整个流。');
                if (buffer.length < 4 + length)
                    break;
                const body = buffer.subarray(4, 4 + length);
                buffer = buffer.subarray(4 + length);
                let parsed: unknown;
                try { parsed = JSON.parse(body.toString('utf8')); }
                catch { fail('KIMI_FRAME_NOT_JSON', '帧正文不是合法 UTF-8 JSON；拒绝整个流。'); }
                frames.push(validate(parsed));
            }
            return frames;
        },
        finish() {
            if (buffer.length !== 0)
                fail('KIMI_FRAME_TRUNCATED', '流在帧中间结束；拒绝这个尾部。');
        },
        pending: () => buffer.length
    };
}

export type CommitOutcome = 'COMMITTED' | 'IDEMPOTENT_REPLAY';

export interface GenerationGate {
    /** Verify and accept a ROTATE; returns whether it was new or a replay of the committed one. */
    accept(frame: BridgeFrame): CommitOutcome;
    committed(): { generation: number; messageId: string; tokenHash: string } | undefined;
}

function digest(token: Record<string, unknown>): string {
    const access = typeof token.accessToken === 'string' ? token.accessToken : '';
    const refresh = typeof token.refreshToken === 'string' ? token.refreshToken : '';
    if (access.length === 0 || refresh.length === 0)
        fail('KIMI_ROTATE_TOKEN_INCOMPLETE', '旋转帧必须同时带 accessToken 与 refreshToken。');
    // Not a security hash of a secret at rest — it exists to tell "same rotation replayed" from
    // "different token claiming the same messageId". It never leaves this process.
    return `${access.length}:${refresh.length}:${access.slice(-6)}:${refresh.slice(-6)}`;
}

/**
 * Generation/ACK bookkeeping for the controller side. The rules exist because a lost ACK must not
 * become a second upstream refresh, and because a stale frame must not overwrite a newer token:
 *  - same messageId + same content      → COMMITTED once, then IDEMPOTENT_REPLAY (re-ACK, no refresh)
 *  - same messageId + different content → refused
 *  - generation <= committed            → refused (rollback / stale bridge)
 *  - generation > committed + 1         → refused (skipped a generation: state is unknown)
 */
export function createGenerationGate(): GenerationGate {
    let committed: { generation: number; messageId: string; tokenHash: string } | undefined;
    return {
        accept(frame) {
            const generation = frame.generation ?? 0, messageId = frame.messageId ?? '';
            const hash = digest(frame.token ?? {});
            if (committed) {
                if (messageId === committed.messageId) {
                    if (hash !== committed.tokenHash)
                        fail('KIMI_ROTATE_REPLAY_MISMATCH', '同一 messageId 携带了不同令牌内容；拒绝。');
                    return 'IDEMPOTENT_REPLAY';
                }
                if (generation <= committed.generation)
                    fail('KIMI_ROTATE_GENERATION_STALE', '代数是旧的；拒绝用旧令牌覆盖已提交的更新令牌。');
                if (generation > committed.generation + 1)
                    fail('KIMI_ROTATE_GENERATION_SKIPPED', '代数跳号；本地状态与桥接端不一致，必须先对账。');
            }
            committed = { generation, messageId, tokenHash: hash };
            return 'COMMITTED';
        },
        committed: () => committed
    };
}
