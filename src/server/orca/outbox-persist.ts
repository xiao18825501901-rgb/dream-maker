import { DomainError } from '../security.js';
import { createOperationOutbox, type OperationOutbox, type OperationRecord } from './outbox.js';

/**
 * C07: the outbox must survive the process that created it.
 *
 * An in-memory outbox solves the double-launch problem only until the controller restarts — and a
 * restart is exactly when someone is most likely to "just try again". So the records are persisted
 * atomically, and a corrupt store is a hard error: an outbox that silently reads as empty is
 * indistinguishable from "nothing was ever dispatched", which is the failure mode being prevented.
 */
export interface OutboxStore {
    read(): string | undefined;
    write(serialized: string): void;
}

export function createPersistentOperationOutbox(store: OutboxStore): OperationOutbox {
    const memory = createOperationOutbox();
    const raw = store.read();
    if (raw !== undefined) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new DomainError('ORCA_OUTBOX_CORRUPT', 409, 'outbox 文件不是合法 JSON；拒绝以“空 outbox”继续（会把未知派发当成从未发生）。');
        }
        const records = (parsed as { records?: unknown })?.records;
        if (!Array.isArray(records))
            throw new DomainError('ORCA_OUTBOX_CORRUPT', 409, 'outbox 结构不合法；拒绝继续。');
        for (const record of records as OperationRecord[]) {
            if (typeof record?.operationId !== 'string' || typeof record?.state !== 'string' || typeof record?.budgetReservationId !== 'string')
                throw new DomainError('ORCA_OUTBOX_CORRUPT', 409, 'outbox 记录不合法；拒绝继续。');
            // Rebuild by replaying the recorded state through the normal guards.
            memory.begin(record.operationId, record.budgetReservationId);
            if (record.dispatchId) memory.recordDispatched(record.operationId, record.dispatchId);
            if (record.state === 'OUTCOME_UNKNOWN') memory.markOutcomeUnknown(record.operationId, record.lastError ?? 'restored');
            else if (record.state === 'COMPLETED') memory.complete(record.operationId);
            else if (record.state === 'FENCED') memory.fence(record.operationId);
        }
    }
    const persist = (): void => {
        store.write(JSON.stringify({ schema: 1, records: memory.list() }) + '\n');
    };
    const wrap = (fn: () => OperationRecord): OperationRecord => {
        const record = fn();
        persist();
        return record;
    };
    return {
        begin: (operationId, budgetReservationId) => wrap(() => memory.begin(operationId, budgetReservationId)),
        recordDispatched: (operationId, dispatchId) => wrap(() => memory.recordDispatched(operationId, dispatchId)),
        markOutcomeUnknown: (operationId, reason) => wrap(() => memory.markOutcomeUnknown(operationId, reason)),
        complete: operationId => wrap(() => memory.complete(operationId)),
        fence: operationId => wrap(() => memory.fence(operationId)),
        get: operationId => memory.get(operationId),
        list: () => memory.list()
    };
}
