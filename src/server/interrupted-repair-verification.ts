import type {Store} from './store.js';
import type {Run} from '../shared/types.js';
import {DomainError,hash,object} from './security.js';
import {treeHash} from './workspace.js';

export const INTERRUPTED_REPAIR_VERIFICATION_REASON='INTERRUPTED_REPAIR_VERIFICATION_PREPARED';

export interface InterruptedRepairVerificationRequest {
    confirmed: boolean;
    sourceHash: string;
    expectedVersion: number;
}

interface RecordRow {
    id: string;
    kind: string;
    data: Record<string, unknown>;
}

function fail(): never {
    throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_NOT_RECOVERABLE', 409);
}

function records(store: Store, run: Run): RecordRow[] {
    const rows = store.db.prepare(
        "SELECT id,kind,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097",
    ).all(run.projectId, run.id).map(row => ({
        id: String(row.id),
        kind: String(row.kind),
        data: object(JSON.parse(String(row.data))),
    }));
    if (rows.length > 4096) fail();
    return rows;
}

function validCoordinate(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/**
 * A repair can finish every file/tool effect, then lose only the final model
 * transport turn. This basis proves that exact settled prefix and never treats
 * the failed transport turn as a verifier or reviewer verdict.
 */
export function interruptedRepairVerificationBasis(store: Store, run: Run, sourceHash: string) {
    if (!/^[a-f0-9]{64}$/.test(sourceHash) ||
        run.mode !== 'live' ||
        run.flowName !== 'classic' ||
        run.state !== 'BLOCKED' ||
        run.phase !== 'REPAIRING' ||
        !['RUNNER_RPC_ERROR','WORKER_RESTART_RESULT_UNCERTAIN'].includes(run.reason??'') ||
        run.review !== null ||
        !run.verification ||
        run.verification.ok ||
        run.verification.treeHash === sourceHash ||
        !run.tasks.length ||
        run.tasks.some(task => task.status !== 'implemented') ||
        run.repairCount !== run.maxRepairs ||
        run.calls >= run.maxCalls ||
        !store.owns(run.projectId, run.id) ||
        store.project(run.projectId).activeRunId !== run.id ||
        treeHash(run.workspace) !== sourceHash) {
        fail();
    }

    const rows = records(store, run);
    if (rows.some(row => ['InterruptedRepairVerificationRecovery', 'InterruptedRepairVerificationRecoveryReplay'].includes(row.kind))) fail();

    const executorGrants = rows.filter(row => row.kind === 'DispatchGranted' && row.data.kind === 'executor');
    const grant = executorGrants.at(-1);
    if (!grant || !validCoordinate(grant.data.dispatchId) || !validCoordinate(grant.data.generation)) fail();
    const dispatchId = String(grant.data.dispatchId);
    const generation = String(grant.data.generation);
    const grantIndex = rows.indexOf(grant);
    const finishes = rows.filter(row => row.kind === 'DispatchFinished' && row.data.dispatchId === dispatchId);
    if (finishes.length !== 1) fail();
    const finish = finishes[0];
    const finishIndex = rows.indexOf(finish);
    if (finishIndex <= grantIndex ||
        finish.data.generation !== generation ||
        finish.data.outcome !== 'RUNNER_RPC_ERROR' ||
        finish.data.cleanupReturned !== true) {
        fail();
    }

    const after = rows.slice(finishIndex + 1);
    if (after.some(row =>
        row.kind === 'ToolIntent' ||
        row.kind === 'ToolResult' ||
        row.kind === 'OwnedProcessIntent' ||
        row.kind === 'DispatchGranted' && row.data.kind === 'executor'
    )) fail();

    const during = rows.slice(grantIndex + 1, finishIndex);
    const intents = during.filter(row => row.kind === 'ToolIntent');
    const results = during.filter(row => row.kind === 'ToolResult');
    if (!intents.length || intents.length !== results.length) fail();
    let checkpoint=run.treeHash;
    let completed=0;
    for (const intent of intents) {
        const settled = results.filter(row => row.data.intentId === intent.id);
        if (settled.length !== 1) fail();
        const result = settled[0];
        if (result.data.tool !== intent.data.tool ||
            intent.data.specHash !== run.specHash ||
            intent.data.sourceHash !== checkpoint ||
            during.indexOf(result) <= during.indexOf(intent)) {
            fail();
        }
        if(result.data.status==='COMPLETE'){
            if(result.data.specHash!==run.specHash||typeof result.data.sourceHash!=='string'||
                !/^[a-f0-9]{64}$/.test(result.data.sourceHash))fail();
            checkpoint=result.data.sourceHash;completed++;
        }else if(result.data.status==='FAILED_NO_EFFECT'){
            if(typeof result.data.code!=='string'||!/^[A-Z][A-Z0-9_]{1,100}$/.test(result.data.code)||
                result.data.sourceHash!==undefined&&result.data.sourceHash!==checkpoint||
                result.data.specHash!==undefined&&result.data.specHash!==run.specHash)fail();
        }else fail();
    }
    const lastResult = results.at(-1);
    if (!lastResult || !completed || checkpoint !== sourceHash) fail();

    const processIntents = during.filter(row => row.kind === 'OwnedProcessIntent');
    if (!processIntents.length || new Set(processIntents.map(row => String(row.data.processId))).size !== processIntents.length) fail();
    for (const intent of processIntents) {
        const processId = String(intent.data.processId);
        const cleanups = during.filter(row => row.kind === 'OwnedProcessCleanup' && row.data.processId === processId);
        if (!validCoordinate(processId) ||
            intent.data.dispatchId !== dispatchId ||
            intent.data.generation !== generation ||
            cleanups.length !== 1 ||
            cleanups[0].data.dispatchId !== dispatchId ||
            cleanups[0].data.generation !== generation ||
            cleanups[0].data.cleanupReturned !== true ||
            during.indexOf(cleanups[0]) <= during.indexOf(intent)) {
            fail();
        }
    }

    return {
        schema: 'dream-maker.interrupted-repair-verification.v1' as const,
        dispatchId,
        generation,
        sourceHash,
        previousSourceHash: run.treeHash,
        previousVerificationTreeHash: run.verification.treeHash,
        lastToolResultId: lastResult.id,
        basisHash: hash(rows),
    };
}

export function interruptedRepairVerificationEvidence(store: Store, run: Run) {
    const rows = store.records(run.projectId, 'InterruptedRepairVerificationRecovery').filter(row => row.runId === run.id);
    if (rows.length !== 1 || !run.interruptedRepairVerification) fail();
    const row = rows[0];
    const data = object(row.data);
    if (run.interruptedRepairVerification.recordId !== row.id ||
        run.interruptedRepairVerification.sha256 !== hash(data) ||
        data.schema !== 'dream-maker.interrupted-repair-verification.v1' ||
        data.sourceHash !== run.treeHash ||
        data.specHash !== run.specHash ||
        data.planVersionHash !== run.planVersionHash ||
        data.calls !== run.calls ||
        data.repairCount !== run.repairCount ||
        data.maxRepairs !== run.maxRepairs ||
        data.createdAt !== run.createdAt ||
        data.maxSeconds !== run.maxSeconds ||
        data.modelDispatched !== false ||
        data.automaticRetry !== false ||
        run.state !== 'PAUSED' ||
        run.phase !== 'VERIFYING' ||
        run.reason !== INTERRUPTED_REPAIR_VERIFICATION_REASON ||
        treeHash(run.workspace) !== data.sourceHash) {
        fail();
    }
    return data;
}
