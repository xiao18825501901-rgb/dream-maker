import type { KimiAuthFailureClass, KimiAuthLayer } from './kimi-auth-errors.js';
import { classForErrorCode, layerFromMessage } from './kimi-auth-errors.js';

/**
 * The last *proven* authentication failure this process observed, for the status surface.
 *
 * Why: the durable record can still say OK right after the server rejected the call — the Kimi side
 * can drop its token without telling us (`dmTokenStorage.remove()` sends no frame, see docs 99), and a
 * runtime 401 is only known to whoever caught it. Without this, the product would keep claiming
 * "可以推理" after it had just been refused.
 *
 * Deliberately tiny: one record, no message text, no token, no history.
 */
export interface KimiAuthFailureRecord {
    class: KimiAuthFailureClass;
    layer: KimiAuthLayer;
    /** Fixed error code that produced the record (e.g. KIMI_REAUTH_REQUIRED). */
    code: string;
    atMs: number;
}

export interface KimiAuthFailureLog {
    /**
     * Called with whatever the runner threw; non-auth errors are ignored.
     * Passing `null` means "a turn just succeeded", which retires the record: a rejection that has
     * since been superseded must never keep the status red or keep asking for a login.
     */
    record(failure: { code?: unknown; message?: unknown } | null): void;
    last(): KimiAuthFailureRecord | null;
    clear(): void;
}

export function createAuthFailureLog(clock: () => number = () => Date.now()): KimiAuthFailureLog {
    let current: KimiAuthFailureRecord | null = null;
    return {
        record(failure) {
            if (failure === null) { current = null; return; }
            const code = typeof failure.code === 'string' ? failure.code : '';
            const classified = classForErrorCode(code);
            if (!classified) return;
            // The layer travels in the message prefix ([L4_TURN] …), written by kimiFailureError().
            current = { class: classified, layer: layerFromMessage(typeof failure.message === 'string' ? failure.message : ''), code, atMs: clock() };
        },
        last: () => current,
        clear() { current = null; }
    };
}
