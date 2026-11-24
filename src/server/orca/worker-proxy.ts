import { DomainError } from '../security.js';
import { assertTicketUsable, type TaskTicket } from './adapter.js';

/**
 * A10 (source half): the `dm-orca-worker` proxy contract.
 *
 * The proxy exists so Orca can supervise a resource without ever becoming an authority: it claims ONE
 * pre-approved ticket from the Engine over a private channel, and the actual model work still runs
 * through NativeOwner/WSL with the Engine's budget and lease. So this module is deliberately small:
 *
 *  - one claim per operation, ever (a second claim is a double-launch bug, not a retry);
 *  - the ticket must be complete, unexpired and on the current lease generation;
 *  - the proxy accepts TICKETS, never command text — there is no API here that turns a string into a
 *    process, because that would hand the model a shell through the back door.
 */
export interface ClaimResult {
    ok: boolean;
    code: string;
    operationId: string | null;
}

export interface WorkerProxy {
    claim(ticket: TaskTicket): ClaimResult;
    claimedOperations(): string[];
    /** Documents the absence of an execution API; kept callable so a test can pin it. */
    acceptsArbitraryCommand(): false;
}

export function createWorkerProxy(input: { now?: () => number; leaseGeneration: number; claimed?: Set<string> }): WorkerProxy {
    const clock = input.now ?? (() => Date.now());
    // Shared across proxy instances on purpose: the claim set is the anti-double-launch memory.
    const claimed = input.claimed ?? new Set<string>();
    return {
        claim(ticket: TaskTicket): ClaimResult {
            const operationId = typeof ticket?.operationId === 'string' ? ticket.operationId : null;
            const fail = (code: string): ClaimResult => ({ ok: false, code, operationId });
            if (claimed.has(ticket?.operationId ?? '')) return fail('ORCA_PROXY_ALREADY_CLAIMED');
            try {
                assertTicketUsable(ticket, { now: clock(), claimed, leaseGeneration: input.leaseGeneration });
            }
            catch (error) {
                return { ok: false, code: (error as { code?: string }).code ?? 'ORCA_TICKET_INVALID', operationId };
            }
            claimed.add(ticket.operationId);
            return { ok: true, code: 'CLAIMED', operationId };
        },
        claimedOperations: () => [...claimed],
        acceptsArbitraryCommand: () => false
    };
}

/**
 * A ticket that reaches the proxy must also belong to this run and this workspace generation. Keeping
 * this as a separate check means the proxy cannot be talked into running another run's task merely by
 * presenting a well-formed ticket.
 */
export function assertTicketBelongsTo(ticket: TaskTicket, expected: { runId: string; allowedPathSetHash: string }): void {
    if (ticket.runId !== expected.runId)
        throw new DomainError('ORCA_TICKET_WRONG_RUN', 409, '票据属于另一个 run；拒绝认领。');
    if (ticket.allowedPathSetHash !== expected.allowedPathSetHash)
        throw new DomainError('ORCA_TICKET_PATH_SET_MISMATCH', 409, '票据的允许路径集与当前工作区不一致；拒绝认领。');
}
