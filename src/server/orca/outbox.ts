import { DomainError } from '../security.js';

/**
 * A06: operation outbox/inbox.
 *
 * The failure this exists to prevent (plan §5): a response is lost, the caller assumes "nothing was
 * started", and a second worker is launched for the same operation. Local UUIDs are not upstream
 * idempotency keys, so the only safe rule is: record the intent, record what the authority actually
 * created, and when the outcome cannot be determined keep the fence and the worst-case budget
 * reservation instead of falling back to a native run.
 */
export type OperationState =
    | 'PENDING_DISPATCH'
    | 'DISPATCHED'
    | 'OUTCOME_UNKNOWN'
    | 'COMPLETED'
    | 'FENCED';

export interface OperationRecord {
    operationId: string;
    state: OperationState;
    dispatchId?: string;
    /** Worst-case reservation kept while the outcome is unknown. */
    budgetReservationId: string;
    attempts: number;
    lastError?: string;
}

export interface OperationOutbox {
    begin(operationId: string, budgetReservationId: string): OperationRecord;
    recordDispatched(operationId: string, dispatchId: string): OperationRecord;
    markOutcomeUnknown(operationId: string, reason: string): OperationRecord;
    complete(operationId: string): OperationRecord;
    fence(operationId: string): OperationRecord;
    get(operationId: string): OperationRecord | undefined;
    list(): OperationRecord[];
}

function fail(code: string, message: string): never {
    throw new DomainError(code, 409, message);
}

export function createOperationOutbox(): OperationOutbox {
    const records = new Map<string, OperationRecord>();
    const require = (operationId: string): OperationRecord => {
        const record = records.get(operationId);
        if (!record) fail('ORCA_OPERATION_UNKNOWN', '没有该 operation 的记录。');
        return record;
    };
    return {
        begin(operationId, budgetReservationId) {
            if (operationId.length === 0) fail('ORCA_OPERATION_ID_INVALID', 'operationId 不能为空。');
            if (records.has(operationId))
                // Re-beginning is exactly the double-launch bug: the first attempt either exists
                // upstream or its outcome is unknown, and neither is fixed by starting again.
                fail('ORCA_OPERATION_DUPLICATE', '同一 operationId 已存在；禁止重复启动 worker。');
            const record: OperationRecord = { operationId, state: 'PENDING_DISPATCH', budgetReservationId, attempts: 0 };
            records.set(operationId, record);
            return { ...record };
        },
        recordDispatched(operationId, dispatchId) {
            const record = require(operationId);
            if (record.state === 'COMPLETED' || record.state === 'FENCED')
                fail('ORCA_OPERATION_TERMINAL', '已终态的 operation 不能再次派发。');
            if (record.state === 'OUTCOME_UNKNOWN')
                fail('ORCA_OPERATION_OUTCOME_UNKNOWN', '派发结果未知；必须先对账，不能重新派发。');
            if (dispatchId.length === 0) fail('ORCA_DISPATCH_ID_INVALID', 'dispatchId 不能为空。');
            if (record.dispatchId && record.dispatchId !== dispatchId)
                fail('ORCA_DISPATCH_ID_CHANGED', '同一 operation 出现了不同的 dispatchId；状态已不可信。');
            record.state = 'DISPATCHED';
            record.dispatchId = dispatchId;
            record.attempts += 1;
            return { ...record };
        },
        markOutcomeUnknown(operationId, reason) {
            const record = require(operationId);
            if (record.state === 'COMPLETED')
                fail('ORCA_OPERATION_TERMINAL', '已完成的 operation 不能标记为未知。');
            // The reservation is deliberately NOT released: the worker may be running and billing.
            record.state = 'OUTCOME_UNKNOWN';
            record.lastError = reason;
            return { ...record };
        },
        complete(operationId) {
            const record = require(operationId);
            if (record.state === 'OUTCOME_UNKNOWN')
                fail('ORCA_OPERATION_OUTCOME_UNKNOWN', '结果未知时不能直接标记完成；先对账。');
            record.state = 'COMPLETED';
            return { ...record };
        },
        fence(operationId) {
            const record = require(operationId);
            record.state = 'FENCED';
            return { ...record };
        },
        get: operationId => {
            const record = records.get(operationId);
            return record ? { ...record } : undefined;
        },
        list: () => [...records.values()].map(r => ({ ...r }))
    };
}
