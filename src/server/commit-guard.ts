import { DomainError } from './security.js';

/**
 * K05 atomic-commit precondition.
 *
 * A model answer may only be written into project state when every one of these still holds at
 * the moment of writing, re-checked here and not merely earlier in the pipeline:
 *  - the turn receipt proves a completed, structurally valid turn;
 *  - the project version the caller read is still the current version;
 *  - the lease is still held by the same owner;
 *  - nobody asked to cancel while the answer was being produced.
 *
 * The function is deliberately pure so it can be tested without a store, and every failure has
 * its own code so a caller cannot silently treat a partial or stale result as success.
 */
export interface CommitPrecondition {
    /** Receipt from the protocol reducer, or null when the stream never completed. */
    receipt: { turnId: string; reason: string; answerChars: number; answerHash: string } | null;
    /** Project version that was current when the model call started. */
    expectedVersion: number;
    /** Project version read again immediately before writing. */
    currentVersion: number;
    /** Lease owner recorded when the run started. */
    expectedOwner: string;
    /** Lease owner read again immediately before writing (empty when no lease is held). */
    currentOwner: string;
    /** Cancellation observed after the answer was produced. */
    cancelledAfterAnswer: boolean;
}

/**
 * @param options.leaseRequired  True for Engine run writes, which hold a workspace lease.
 *   False for planner1 interview dispatch, where Interviews never holds a lease — passing an
 *   identity there would be a fake lease check, so the caller states that explicitly instead.
 */
export function assertAtomicCommitAllowed(p: CommitPrecondition, options: { leaseRequired?: boolean } = {}): void {
    if (!p.receipt)
        throw new DomainError('KIMI_TURN_INCOMPLETE', 409, '没有完成回执；不得提交部分结果。');
    if (p.receipt.reason !== 'completed')
        throw new DomainError('KIMI_TURN_NOT_COMPLETED', 409, `回合终态为 ${p.receipt.reason}；不是成功。`);
    if (!p.receipt.turnId || !/^[A-Za-z0-9_-]{1,200}$/.test(p.receipt.turnId))
        throw new DomainError('KIMI_TURN_ID_MISSING', 502, '没有真实 turnId；不得伪造上游标识。');
    if (!Number.isSafeInteger(p.receipt.answerChars) || p.receipt.answerChars < 0)
        throw new DomainError('KIMI_ANSWER_SHAPE_INVALID', 502);
    if (!/^[a-f0-9]{64}$/.test(p.receipt.answerHash))
        throw new DomainError('KIMI_ANSWER_HASH_INVALID', 502);
    if (p.cancelledAfterAnswer)
        throw new DomainError('COMMIT_CANCELLED', 409, '答案产生后收到取消；不提交。');
    if (!Number.isSafeInteger(p.expectedVersion) || !Number.isSafeInteger(p.currentVersion))
        throw new DomainError('PROJECT_VERSION_REQUIRED', 409);
    if (p.expectedVersion !== p.currentVersion)
        throw new DomainError('COMMIT_VERSION_STALE', 409, '项目版本在作答期间已变化；不提交过期结果。');
    if (options.leaseRequired === false)
        return;
    if (!p.expectedOwner)
        throw new DomainError('COMMIT_LEASE_REQUIRED', 409, '作答期间没有持有租约；不提交。');
    if (p.expectedOwner !== p.currentOwner)
        throw new DomainError('COMMIT_LEASE_LOST', 409, '租约已易主；不提交。');
}
/**
 * Run-level delivery precondition (Engine). Distinct from the planner1 answer commit above: here
 * the run owns a workspace lease, so the checks are lease, cancellation and tree stability.
 */
export function assertRunDeliveryAllowed(p: { leaseHeld: boolean; cancelled: boolean; treeHashStable: boolean }): void {
    if (p.cancelled)
        throw new DomainError('COMMIT_CANCELLED', 409, '运行已请求取消；不写交付状态。');
    if (!p.leaseHeld)
        throw new DomainError('COMMIT_LEASE_LOST', 409, '租约已不在本运行名下；不写交付状态。');
    if (!p.treeHashStable)
        throw new DomainError('COMMIT_TREE_CHANGED', 409, '工作区树在验证/审查后又被改动；不写交付状态。');
}
