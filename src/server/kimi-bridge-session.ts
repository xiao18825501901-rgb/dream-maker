import { DomainError } from './security.js';
import { type BridgeFrame, PROTOCOL_VERSION, STORAGE_NAME, createFrameDecoder, encodeFrame } from './kimi-bridge-frames.js';
import type { KimiCredentialAuthority, TokenInfo } from './kimi-credential-authority.js';

/**
 * C03/C04: the controller half of the trusted byte channel.
 *
 * This is the piece that turns "frames exist" into "a rotation is only acknowledged once it is
 * durably stored". It is deliberately transport-agnostic: it is handed a byte sink and is fed bytes,
 * so the whole handshake is testable offline, and the process spawning (fixed wsl.exe, absolute
 * bridge script, no shell) stays a thin, separately-reviewable layer.
 *
 * Direction summary:
 *   controller -> bridge : HELLO, RESTORE (with the restored token or an explicit status), COMMIT_ACK, ERROR
 *   bridge -> controller : HELLO, ROTATE, ERROR, CLOSE
 *
 * A ROTATE is acknowledged ONLY after the durable commit succeeded. If persistence fails, the bridge
 * gets an ERROR and no ACK — so `storage.save()` on the Linux side cannot report success.
 */
export interface BridgeSession {
    start(): Promise<void>;
    onBytes(chunk: Buffer): void;
    /** Frames this controller sent, in order — for tests and for a bounded evidence log. */
    sent(): BridgeFrame[];
    closed(): boolean;
}

export function createBridgeSession(options: {
    instanceId: string;
    accountRef: string;
    send: (bytes: Buffer) => void;
    authority: KimiCredentialAuthority;
    /** Observability only: every frame in BOTH directions, for a bounded local ledger. */
    onFrame?: (frame: BridgeFrame, direction: 'in' | 'out') => void;
}): BridgeSession {
    const { instanceId, accountRef, send, authority } = options;
    const decoder = createFrameDecoder();
    const out: BridgeFrame[] = [];
    let closed = false;

    const emit = (frame: Omit<BridgeFrame, 'protocolVersion' | 'instanceId' | 'storageName'>): void => {
        if (closed) return;
        const full: BridgeFrame = { ...frame, protocolVersion: PROTOCOL_VERSION, instanceId, storageName: STORAGE_NAME } as BridgeFrame;
        try {
            send(encodeFrame(full));
        }
        catch {
            // A dead channel must not turn into an unhandled rejection inside a promise chain: the
            // session simply stops, and the caller learns about it through exit()/closed().
            closed = true;
            return;
        }
        // Record AFTER the bytes were accepted: `sent()` and the frame ledger are evidence, and an
        // ACK that died on the wire must never appear as "confirmed to the peer".
        out.push(full);
        options.onFrame?.(full, 'out');
    };
    const fail = (code: string): void => { emit({ type: 'ERROR', code }); };
    const close = (): void => {
        if (closed) return;
        emit({ type: 'CLOSE' });
        closed = true;
    };

    return {
        async start() {
            if (authority.barrier() !== 'READY')
                // The controller cannot hand out credentials it has not restored. This is an ordering
                // error, not "the user must log in".
                fail('KIMI_RESTORE_NOT_READY');
            else
                emit({ type: 'HELLO' });
            if (authority.barrier() !== 'READY') return;
            const state = authority.current();
            if (state.status === 'OK')
                emit({ type: 'RESTORE', generation: state.generation, messageId: state.messageId, accountRef, token: state.token as unknown as Record<string, unknown> });
            else if (state.status === 'REVOKED')
                emit({ type: 'RESTORE', token: {} });
            else if (state.status === 'CORRUPT')
                fail('KIMI_STORED_STATE_CORRUPT');
            else
                emit({ type: 'RESTORE', token: {} });
        },
        onBytes(chunk) {
            if (closed) return;
            let frames: BridgeFrame[];
            try {
                frames = decoder.push(chunk);
            }
            catch (error) {
                fail((error as { code?: string }).code ?? 'KIMI_FRAME_INVALID');
                closed = true;
                return;
            }
            for (const frame of frames) {
                if (closed) return;
                if (frame.instanceId !== instanceId && frame.type !== 'CLOSE') {
                    // A frame addressed to another instance is not evidence that OUR peer is alive:
                    // report the error (which is recorded) but do not count it as an inbound frame.
                    fail('KIMI_FRAME_IDENTITY_MISMATCH');
                    continue;
                }
                options.onFrame?.(frame, 'in');
                if (frame.type === 'ROTATE') {
                    const generation = frame.generation ?? 0, messageId = frame.messageId ?? '';
                    const token = frame.token as unknown as TokenInfo;
                    if (frame.accountRef !== accountRef && frame.accountRef !== undefined) {
                        fail('KIMI_ACCOUNT_MISMATCH');
                        continue;
                    }
                    authority
                        .commit({ token, generation, messageId })
                        .then(ack => {
                            // Only a completed, verified write produces this frame.
                            emit({ type: 'COMMIT_ACK', generation: ack.generation, messageId: ack.messageId });
                        })
                        .catch((error: { code?: string }) => {
                            const code = error.code ?? 'KIMI_TOKEN_PERSIST_FAILED';
                            // "The write may or may not have landed" is not a plain persistence
                            // failure — the durable outcome is UNKNOWN. Use the fixed vocabulary name
                            // so this channel, the ledger and a human read the same word. The peer only
                            // stringifies the code (dmTokenStorage: rejectAll("DM_TOKEN_PERSIST_REJECTED:"+code)),
                            // so the wire semantics are unchanged: still no ACK.
                            fail(code === 'KIMI_TOKEN_PERSIST_UNVERIFIED' ? 'KIMI_AUTH_COMMIT_UNCERTAIN' : code);
                        });
                    continue;
                }
                if (frame.type === 'HELLO') continue;
                if (frame.type === 'CLOSE') { closed = true; continue; }
                if (frame.type === 'ERROR') { closed = true; continue; }
                // COMMIT_ACK is controller->bridge only; receiving one here is a protocol violation.
                fail('KIMI_FRAME_DIRECTION_VIOLATION');
            }
        },
        sent: () => [...out],
        closed: () => closed
    };
}

/** Guard used by callers that must not start a bridge without a durable authority at hand. */
export function assertBridgeStartable(authority: KimiCredentialAuthority): void {
    if (authority.barrier() !== 'READY')
        throw new DomainError('KIMI_RESTORE_NOT_READY', 409, 'RESTORE 屏障未完成，不能启动受信桥。');
}
