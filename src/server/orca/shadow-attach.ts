import type { ShadowMirror } from './shadow.js';

/**
 * A09: attach the SHADOW mirror to the Engine's event stream.
 *
 * The Engine stays untouched: the store's `event` call is wrapped, which means a single seam and no
 * behavioural change for any other caller. Two invariants:
 *  - the mirror can never affect the business path: a throwing mirror is swallowed and the original
 *    return value is preserved;
 *  - detaching restores the exact original function, so a mode change (or a test) leaves no residue.
 */
/**
 * The mirror records WHICH fields moved, never what they contained. Key names are structure; the
 * values are business content (modes, hashes, paths, sometimes text) and stay inside Dream Maker.
 */
function fieldNames(payload: unknown): string {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return '';
    return Object.keys(payload as Record<string, unknown>).slice(0, 8).join(',');
}

export interface EventSink {
    event(projectId: string | null, runId: string | null, type: string, payload: unknown): unknown;
}

export function attachShadowMirror(store: EventSink, mirror: ShadowMirror): () => void {
    // Keep BOTH: the raw reference is what detaching must restore, the bound one is what we call.
    // Restoring a bound copy would pass a smoke test but silently break identity comparisons.
    const raw = store.event;
    const original = raw.bind(store);
    store.event = (projectId, runId, type, payload) => {
        try {
            mirror.push(type, runId ?? '', fieldNames(payload));
        }
        catch {
            // Observation must never break the run it is observing.
        }
        return original(projectId, runId, type, payload);
    };
    return () => {
        store.event = raw;
    };
}
