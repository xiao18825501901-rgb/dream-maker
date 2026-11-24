import { DomainError } from '../security.js';
import type { OperationOutbox } from './outbox.js';
import type { ObservationPass } from './observe.js';
import type { ShadowMirror, ShadowMode } from './shadow.js';

/**
 * A09: one SHADOW pass, wired end to end but with no authority.
 *
 * It ties the three pieces together — the durable outbox (so a restart cannot re-launch an unknown
 * dispatch), the observation pass (bounded, source-safe) and the mirror (bounded, redacted) — while
 * refusing to do anything that would make it a controller: it never completes a task, never accepts a
 * report, never releases resources, and in OFF it does not even poll.
 */
export interface ShadowPassResult {
    fired: boolean;
    reason: string;
    observed?: ObservationPass;
}

export async function runShadowPass(input: {
    mode: ShadowMode;
    outbox: Pick<OperationOutbox, 'begin' | 'recordDispatched' | 'markOutcomeUnknown' | 'get'>;
    observer: { poll(): Promise<ObservationPass> };
    mirror?: Pick<ShadowMirror, 'push'>;
    operationId: string;
    budgetReservationId: string;
}): Promise<ShadowPassResult> {
    if (input.mode === 'OFF') return { fired: false, reason: 'MODE_OFF' };
    if (input.operationId.length === 0) throw new DomainError('ORCA_OPERATION_ID_INVALID', 409, 'operationId 不能为空。');

    try {
        input.outbox.begin(input.operationId, input.budgetReservationId);
    }
    catch (error) {
        // A duplicate begin means this operation already exists — possibly unknown upstream. It is a
        // refusal, not a reason to poll again and pretend the second pass is the first.
        return { fired: false, reason: (error as { code?: string }).code ?? 'ORCA_OPERATION_DUPLICATE' };
    }

    const observed = await input.observer.poll();
    input.mirror?.push('shadow.pass', input.operationId, observed.ok ? 'observed' : 'failed');

    if (!observed.ok) {
        input.outbox.markOutcomeUnknown(input.operationId, observed.errorCode ?? 'ORCA_OBSERVE_FAILED');
        // The reservation is deliberately retained: an unobserved dispatch may still be running.
        return { fired: true, reason: 'OBSERVATION_FAILED', observed };
    }
    const first = observed.workers[0];
    if (first) {
        try {
            input.outbox.recordDispatched(input.operationId, first.dispatchId);
        }
        catch {
            // Already recorded with a different dispatch id: keep the unknown state rather than
            // overwrite it with a guess.
            input.outbox.markOutcomeUnknown(input.operationId, 'ORCA_DISPATCH_ID_CHANGED');
            return { fired: true, reason: 'DISPATCH_ID_CHANGED', observed };
        }
    }
    // Note what is deliberately absent: no complete(), no accept, no release.
    return { fired: true, reason: 'OBSERVED', observed };
}
