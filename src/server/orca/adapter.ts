import { DomainError } from '../security.js';

/**
 * A06: Orca adapter contract.
 *
 * What this file is: the pure, transport-free half of the Orca integration — state normalisation,
 * ticket validation, guard rails that stop a supervisor report from ever becoming a verification
 * result, and a redacted projection for SHADOW mode.
 *
 * What this file is NOT: an Orca client. Nothing here starts a process, opens a socket, or reads an
 * Orca database. Without a real, approved Orca instance the honest status is
 * ADAPTER_IMPLEMENTED_NATIVE_NOT_RUN — which is why every export is testable offline and why the
 * tests never claim a native connection.
 *
 * Split of authority (plan §3/§5): the Engine owns DAG readiness, approval, budget, leases,
 * cancellation fencing, verification and the final ACCEPTED. Orca only supervises resources and
 * reports observations. A "Done" in Orca is an input to review, never a verdict.
 */
export const ORCA_PIN = {
    repository: 'stablyai/orca',
    version: '1.4.229',
    tag: 'v1.4.229',
    tagObject: 'a3fdce0977b75dc3777439df6d3b928ad4d911cf',
    commit: 'a0cd1644f320f1327f7495650a816111b495f3cd',
    licence: 'MIT (Copyright 2026 Lovecast Inc.)',
    /** The pinned tag is annotated but unsigned: never describe this as signature-verified. */
    signature: 'UNSIGNED_TAG'
} as const;

export type OrcaMode = 'OFF' | 'SHADOW' | 'MANAGED_EXECUTOR';

/** Observation states the Engine is willing to reason about. Nothing here is "accepted". */
export type WorkerLifecycle =
    | 'READY'
    | 'RUNNING'
    | 'REPORT_PENDING_VERIFICATION'
    | 'FAILED_CANDIDATE'
    | 'UNKNOWN'
    | 'CANCEL_REQUESTED'
    | 'CANCELLED';

export interface WorkerObservation {
    dispatchId: string;
    lifecycle: WorkerLifecycle;
    /** Resource facts, deliberately separate from business outcome. */
    terminalResourceState: 'retained' | 'release_pending' | 'released' | 'unknown';
    reportClaim?: string;
    sourceChange?: boolean;
}

function fail(code: string, message: string): never {
    throw new DomainError(code, 409, message);
}

/**
 * Map an upstream worker status onto a lifecycle the Engine may act on.
 *
 * The traps this encodes (plan §5), all observed in the audited CLI contract:
 *  - worker-start exit 0 means "ready", not "working";
 *  - worker_done means "a report exists", not "verified";
 *  - worker-stop on an unsupervised dispatch only fences; it does not close the terminal;
 *  - worker-release exit 0 may still be retained / release_pending.
 */
export function normalizeWorkerState(raw: { status?: unknown; finished?: unknown; stopRequested?: unknown }): WorkerObservation['lifecycle'] {
    const status = typeof raw.status === 'string' ? raw.status : '';
    if (raw.stopRequested === true) return 'CANCEL_REQUESTED';
    switch (status) {
        case 'ready':
        case 'heartbeat': return 'READY';
        case 'working': return 'RUNNING';
        case 'worker_done':
        case 'done':
        case 'succeeded': return 'REPORT_PENDING_VERIFICATION';
        case 'failed':
        case 'error': return 'FAILED_CANDIDATE';
        case 'cancelled':
        case 'stopped': return 'CANCELLED';
        case 'unknown':
        case 'missing':
        case '': return 'UNKNOWN';
        default:
            // An unrecognised status is UNKNOWN, never a success: forwarding unknown words upward is
            // how a supervisor's vocabulary leaks into an acceptance decision.
            return 'UNKNOWN';
    }
}

/**
 * The Engine is the only writer of ACCEPTED. This function exists so that every path which has a
 * supervisor report in hand must pass through it, and it always refuses to award a verdict.
 */
export function assertNotAcceptance(observation: WorkerObservation): never {
    const detail = observation.lifecycle === 'REPORT_PENDING_VERIFICATION'
        ? 'worker_done 只是一份待验证报告，不是 ACCEPTED。'
        : 'Orca 的观察结果不能直接变成任务验收。';
    fail('ORCA_REPORT_IS_NOT_ACCEPTANCE', detail);
}

/** A cursor belongs to one source. Splicing a changed source into it would mix two streams. */
export function assertCursorUsable(cursor: { source: string; value: string } | undefined, currentSource: string): void {
    if (!cursor) fail('ORCA_CURSOR_MISSING', '没有游标可用。');
    if (cursor.source !== currentSource)
        fail('ORCA_CURSOR_SOURCE_CHANGED', '日志源已变化；禁止把新源拼到旧游标上。');
    if (cursor.value.length === 0) fail('ORCA_CURSOR_INVALID', '游标为空。');
}

/** A fenced consumer must stop claiming; it may not be revived by a retry loop. */
export function assertClaimAllowed(state: { consumerFenced: boolean }): void {
    if (state.consumerFenced)
        fail('ORCA_CONSUMER_FENCED', '消费者已被 fence；不得继续认领任务。');
}

export interface TaskTicket {
    schemaVersion: 1;
    projectId: string;
    runId: string;
    taskId: string;
    attemptId: string;
    operationId: string;
    role: 'executor';
    baseTreeHash: string;
    specHash: string;
    planHash: string;
    allowedPathSetHash: string;
    verifierPlanHash: string;
    runnerConfigHash: string;
    policyHash: string;
    budgetReservationId: string;
    leaseGeneration: number;
    expiresAt: string;
}

const TICKET_FIELDS: readonly (keyof TaskTicket)[] = [
    'projectId', 'runId', 'taskId', 'attemptId', 'operationId', 'baseTreeHash', 'specHash', 'planHash',
    'allowedPathSetHash', 'verifierPlanHash', 'runnerConfigHash', 'policyHash', 'budgetReservationId'
];

/**
 * A ticket is a capability: it names exactly one pre-approved task, is usable once, and expires.
 * Anything that would let a worker widen its own scope (free-form command, an unknown field, a
 * missing hash, a different role) is refused before any process starts.
 */
export function assertTicketUsable(ticket: TaskTicket, context: { now: number; claimed: Set<string>; leaseGeneration: number }): void {
    if (ticket.schemaVersion !== 1) fail('ORCA_TICKET_SCHEMA', '票据 schema 版本不支持。');
    if (ticket.role !== 'executor') fail('ORCA_TICKET_ROLE', '票据只能发给 executor 角色。');
    for (const field of TICKET_FIELDS) {
        const value = ticket[field];
        if (typeof value !== 'string' || value.length === 0)
            fail('ORCA_TICKET_INCOMPLETE', `票据缺少 ${String(field)}。`);
    }
    if (!Number.isInteger(ticket.leaseGeneration) || ticket.leaseGeneration < 1)
        fail('ORCA_TICKET_LEASE_INVALID', '票据租约代数非法。');
    if (ticket.leaseGeneration !== context.leaseGeneration)
        fail('ORCA_TICKET_LEASE_STALE', '票据租约代数与当前租约不一致；拒绝认领。');
    const expires = Date.parse(ticket.expiresAt);
    if (!Number.isFinite(expires)) fail('ORCA_TICKET_EXPIRY_INVALID', '票据到期时间不可解析。');
    if (expires <= context.now) fail('ORCA_TICKET_EXPIRED', '票据已过期。');
    if (context.claimed.has(ticket.operationId))
        fail('ORCA_TICKET_ALREADY_CLAIMED', '同一 operationId 只能认领一次。');
}

const FORBIDDEN_PROJECTION_KEYS = ['prompt', 'token', 'secret', 'apiKey', 'authorization', 'entry', 'args', 'command', 'env', 'path', 'workspace'] as const;

/**
 * SHADOW projection (plan §4/§9): mirror task shape and lifecycle, never contents. This is a
 * whitelist builder, so a new Engine field cannot leak by default — and `assertProjectionSafe`
 * makes the redaction rule testable rather than a comment.
 */
export interface ShadowProjection {
    projectId: string;
    runId: string;
    taskId: string;
    phase: string;
    lifecycle: string;
    requiredRequirementIds: string[];
    exclusiveResources: string[];
    specHash: string;
    planHash: string;
}

export function projectTaskForShadow(task: {
    projectId: string; runId: string; taskId: string; phase: string; lifecycle: string;
    requiredRequirementIds?: string[]; exclusiveResources?: string[]; specHash: string; planHash: string;
}): ShadowProjection {
    const projection: ShadowProjection = {
        projectId: task.projectId,
        runId: task.runId,
        taskId: task.taskId,
        phase: task.phase,
        lifecycle: task.lifecycle,
        requiredRequirementIds: [...(task.requiredRequirementIds ?? [])],
        exclusiveResources: [...(task.exclusiveResources ?? [])],
        specHash: task.specHash,
        planHash: task.planHash
    };
    assertProjectionSafe(projection);
    return projection;
}

export function assertProjectionSafe(value: unknown, trail = ''): void {
    if (Array.isArray(value)) {
        value.forEach((item, i) => assertProjectionSafe(item, trail + '[' + i + ']'));
        return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if ((FORBIDDEN_PROJECTION_KEYS as readonly string[]).includes(key))
            fail('ORCA_PROJECTION_LEAK', `SHADOW 投影包含禁止字段 ${trail}.${key}。`);
        assertProjectionSafe(child, trail + '.' + key);
    }
}
