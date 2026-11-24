// A turn deadline alone is not a safety property: a host that stops making progress can burn the whole
// deadline without doing work. This watchdog is the second, independent bound. 'Progress' is defined by the
// caller (any bridge notification from the owned host) and nothing else — it cannot be extended by the
// task itself, so a stuck host dies instead of renewing its own lease.
export interface TurnWatchdog {
    touch(): void;
    stop(): void;
}
export function createTurnWatchdog(options: {
    idleMs: number;
    onStall: () => void;
    now?: () => number;
    setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}): TurnWatchdog {
    const now = options.now ?? Date.now;
    const setI = options.setIntervalFn ?? setInterval;
    const clearI = options.clearIntervalFn ?? clearInterval;
    const idleMs = Math.max(1, options.idleMs);
    const period = Math.max(1, Math.min(15000, Math.floor(idleMs / 4)));
    let last = now();
    let fired = false;
    let handle: ReturnType<typeof setInterval> | undefined = setI(() => {
        if (fired) return;
        if (now() - last <= idleMs) return;
        fired = true;
        try { options.onStall(); } finally { if (handle) { clearI(handle); handle = undefined; } }
    }, period);
    handle?.unref?.();
    return {
        touch() { last = now(); },
        stop() { if (handle) { clearI(handle); handle = undefined; } }
    };
}
