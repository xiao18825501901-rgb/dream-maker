import type { BridgeFrame, FrameType } from './kimi-bridge-frames.js';

/**
 * C03: a bounded, secret-free ledger of the frames the controller actually exchanged.
 *
 * Why it exists: the app could only say "the bridge is running". Whether a rotation was really
 * acknowledged — the one fact that makes durable credentials more than a claim — lived only in a
 * script's stdout. This keeps that fact where the product can read it, and it deliberately records
 * NOTHING that could carry a credential: type, generation, error code and a counter, never
 * `token`, `messageId` or `accountRef`.
 *
 * Bounded on purpose: a long-lived channel must not grow an unbounded evidence array.
 */
export interface BridgeFrameLedger {
    /** `direction` defaults to "out"; incoming frames are what prove the peer is really there. */
    record(frame: BridgeFrame, direction?: 'in' | 'out'): void;
    snapshot(): {
        /** Total frames observed, including ones dropped from the tail buffer. */
        frames: number;
        counts: Partial<Record<FrameType, number>>;
        /** Highest generation seen on a ROTATE. Undefined until a rotation arrives. */
        lastRotateGeneration: number | null;
        /** Highest generation this controller acknowledged. Undefined until durability succeeded. */
        lastAckGeneration: number | null;
        /**
         * Frames the peer actually sent us. `running: true` only means our own process is alive —
         * a socket with no listener still lets us "send" HELLO/RESTORE, so this is the only honest
         * evidence that a channel exists at all.
         */
        inbound: Partial<Record<FrameType, number>>;
        /** True once at least one frame arrived from the peer. */
        established: boolean;
        /** Last ERROR code the channel reported, if any. Codes only — never a message. */
        lastErrorCode: string | null;
        /** True once a CLOSE or ERROR frame was seen. */
        closed: boolean;
        /** The tail of what happened, newest last, as small redaction-safe tuples. */
        recent: string[];
    };
}

const RECENT_LIMIT = 12;

export function createBridgeFrameLedger(limit = RECENT_LIMIT): BridgeFrameLedger {
    const counts: Partial<Record<FrameType, number>> = {};
    const inbound: Partial<Record<FrameType, number>> = {};
    const recent: string[] = [];
    let frames = 0;
    let lastRotateGeneration: number | null = null;
    let lastAckGeneration: number | null = null;
    let lastErrorCode: string | null = null;
    let closed = false;
    const gen = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null);
    return {
        record(frame, direction = 'out') {
            frames += 1;
            counts[frame.type] = (counts[frame.type] ?? 0) + 1;
            if (direction === 'in') inbound[frame.type] = (inbound[frame.type] ?? 0) + 1;
            const g = gen(frame.generation);
            if (frame.type === 'ROTATE' && g !== null && (lastRotateGeneration === null || g > lastRotateGeneration))
                lastRotateGeneration = g;
            if (frame.type === 'COMMIT_ACK' && g !== null && (lastAckGeneration === null || g > lastAckGeneration))
                lastAckGeneration = g;
            if (frame.type === 'ERROR') {
                // A code is a fixed identifier, but keep it bounded so a malformed frame cannot smuggle text.
                lastErrorCode = typeof frame.code === 'string' ? frame.code.slice(0, 64) : 'KIMI_FRAME_ERROR_UNSPECIFIED';
                closed = true;
            }
            if (frame.type === 'CLOSE') closed = true;
            recent.push((direction === 'in' ? '<' : '>') + (g === null ? frame.type : frame.type + '#' + g));
            if (recent.length > limit) recent.splice(0, recent.length - limit);
        },
        snapshot: () => ({
            frames, counts: { ...counts }, lastRotateGeneration, lastAckGeneration, lastErrorCode, closed,
            inbound: { ...inbound }, established: Object.values(inbound).some(n => (n ?? 0) > 0),
            recent: [...recent]
        })
    };
}