import type { Run, SeekerReviewInterpretation, Spec } from '../shared/types.js';
import { Store } from './store.js';
import { DomainError, hash, id, now, object, text, hasSecret } from './security.js';

/**
 * Reviewer -> Seeker hand-back.
 *
 * When the reviewer reaches a terminal verdict the result is *interpreted* by Seeker rather than
 * silently turning into another questionnaire or an automatic acceptance. The interpretation is
 * bound to exactly one reviewer record:
 *   same run, same plan version, same spec bytes, same workspace, same review record hash.
 * A stale pointer from a previous run, an earlier plan version or a sibling workspace is refused
 * instead of being interpreted, because an interpretation of the wrong review is worse than none.
 */
export const SEEKER_REVIEW_TASK = 'review_interpretation';
/** States in which the reviewer has actually finished speaking. */
export const REVIEW_TERMINAL_STATES = ['READY_FOR_DELIVERY', 'BLOCKED', 'REPAIRING'] as const;
/** The only next steps Seeker may offer. It never owns a permission, a build or an acceptance. */
export const SEEKER_NEXT_STEPS = ['REVISE_REQUIREMENTS', 'CONTINUE_INTERVIEW', 'NEW_INTERVIEW', 'REPAIR_AND_RERUN', 'REVIEW_AGAIN', 'DELIVER', 'STOP'] as const;
export type SeekerNextStep = typeof SEEKER_NEXT_STEPS[number];

export interface SeekerReviewHandoff {
    runId: string;
    projectId: string;
    specId: string;
    specHash: string;
    planVersionId: string | null;
    planVersionHash: string | null;
    workspace: string;
    treeHash: string | null;
    reviewRecordId: string;
    reviewRecordHash: string;
    verdict: 'PASS' | 'CHANGES_REQUESTED' | 'BLOCKED';
    at: string;
}

function reviewRows(store: Store, run: Run) {
    return store.records(run.projectId, 'Review').filter(row => row.runId === run.id);
}

export function latestReviewRow(store: Store, run: Run) {
    return reviewRows(store, run).at(-1) ?? null;
}

/** Build the binding from what the run actually recorded. Nothing here is caller-supplied. */
export function buildSeekerHandoff(store: Store, run: Run): SeekerReviewHandoff {
    const review = latestReviewRow(store, run);
    if (!review)
        throw new DomainError('SEEKER_REVIEW_NOT_TERMINAL', 409, '这次运行还没有 reviewer 结论；Seeker 不解读未完成的结果。');
    if (!(REVIEW_TERMINAL_STATES as readonly string[]).includes(run.state))
        throw new DomainError('SEEKER_REVIEW_NOT_TERMINAL', 409, 'reviewer 结束后运行还没有进入可解读的状态。');
    const verdict = object(review.data).verdict;
    if (verdict !== 'PASS' && verdict !== 'CHANGES_REQUESTED' && verdict !== 'BLOCKED')
        throw new DomainError('SEEKER_REVIEW_NOT_TERMINAL', 409);
    const plan = run.planVersionId ? store.planVersion(run.planVersionId) : null;
    return {
        runId: run.id, projectId: run.projectId, specId: run.specId, specHash: run.specHash,
        planVersionId: run.planVersionId ?? null, planVersionHash: plan?.contentHash ?? run.planVersionHash ?? null,
        workspace: run.workspace, treeHash: run.treeHash,
        reviewRecordId: String(review.id), reviewRecordHash: hash(review.data), verdict, at: now(),
    };
}

const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a === b;

/**
 * Called by the engine the moment the reviewer's verdict is settled. It records the hand-back, not an
 * acceptance and not a new interview: the interpretation itself is a separate, owner-requested step,
 * so a PASS never drags the owner back into the questionnaire.
 */
export function recordSeekerHandoff(store: Store, run: Run): string | null {
    try {
        const handoff = buildSeekerHandoff(store, run);
        return store.record('SeekerReviewHandoff', run.projectId, run.id, { ...handoff, autoAccept: false, requiresNewInterview: false });
    }
    catch (error) {
        // A run a recovery path already closed is not an opportunity to invent a hand-back.
        if (error instanceof DomainError && error.code === 'SEEKER_REVIEW_NOT_TERMINAL')
            return null;
        throw error;
    }
}

/**
 * Validate a caller's pointer against the live run. Every mismatch names the field that disagreed,
 * so a UI cannot interpret a review from another run and call it the same one.
 */
export function assertSeekerHandoffBinding(store: Store, run: Run, raw: unknown): SeekerReviewHandoff {
    const input = object(raw);
    const handoff = buildSeekerHandoff(store, run);
    if (!same(input.runId, handoff.runId))
        throw new DomainError('SEEKER_HANDOFF_RUN_MISMATCH', 409, '这次解读请求不是针对同一次运行。');
    if (input.projectId !== undefined && !same(input.projectId, handoff.projectId))
        throw new DomainError('SEEKER_HANDOFF_RUN_MISMATCH', 409, '这次解读请求不是针对同一个项目。');
    if (!same(input.reviewRecordId, handoff.reviewRecordId) || !same(input.reviewRecordHash, handoff.reviewRecordHash))
        throw new DomainError('SEEKER_HANDOFF_REVIEW_MISMATCH', 409, '这不是该运行最新的 reviewer 记录，或它的内容已经改变。');
    if (!same(input.specId, handoff.specId) || !same(input.specHash, handoff.specHash))
        throw new DomainError('SEEKER_HANDOFF_PLAN_MISMATCH', 409, '这次解读请求指向了另一份方案。');
    if (input.planVersionId !== undefined && !same(input.planVersionId ?? '', handoff.planVersionId ?? ''))
        throw new DomainError('SEEKER_HANDOFF_PLAN_MISMATCH', 409, '这次解读请求指向了另一版计划。');
    if (input.planVersionHash !== undefined && !same(input.planVersionHash ?? '', handoff.planVersionHash ?? ''))
        throw new DomainError('SEEKER_HANDOFF_PLAN_MISMATCH', 409, '计划内容已经不是被审查的那一份。');
    if (!same(input.workspace, handoff.workspace))
        throw new DomainError('SEEKER_HANDOFF_WORKSPACE_MISMATCH', 409, '这次解读请求指向了另一个工作区。');
    if (input.verdict !== undefined && !same(input.verdict, handoff.verdict))
        throw new DomainError('SEEKER_HANDOFF_REVIEW_MISMATCH', 409, '结论与实际 reviewer 记录不一致。');
    return handoff;
}

/** The reading request. Seeker gets the verdict, the findings and the frozen requirements only. */
export function buildInterpretationRequest(handoff: SeekerReviewHandoff, spec: Spec, review: Record<string, unknown>): Record<string, unknown> {
    const findings = Array.isArray(review.findings) ? review.findings.slice(0, 100).map(item => {
        const f = object(item);
        return { id: text(f.id, 80), severity: text(f.severity, 20), description: text(f.description, 2000) };
    }) : [];
    return {
        task: SEEKER_REVIEW_TASK,
        runId: handoff.runId,
        verdict: handoff.verdict,
        treeHash: handoff.treeHash,
        findings,
        requirements: spec.requirements.map(r => ({ id: r.id, text: r.text, origin: r.origin })),
        nextStepChoices: [...SEEKER_NEXT_STEPS],
        instruction: 'Explain the reviewer result to the owner in Chinese. Return JSON {blockers:string[], requirementsToReconfirm:[requirementId], nextSteps:[one of nextStepChoices], summary:string}. blockers are the concrete current obstacles. requirementsToReconfirm may only use ids from requirements. nextSteps are options the owner may choose; you never choose for them. A PASS must return an empty requirementsToReconfirm and must not demand another interview. Never accept the result, never start a build, never grant a permission, never claim a test passed.',
    };
}

export function normalizeInterpretation(handoff: SeekerReviewHandoff, spec: Spec, raw: unknown): Pick<SeekerReviewInterpretation, 'blockers' | 'requirementsToReconfirm' | 'nextSteps' | 'requiresNewInterview'> {
    const data = object(raw), ids = new Set(spec.requirements.map(r => r.id));
    const list = (value: unknown, field: string, max: number) => {
        if (value === undefined)
            return [] as string[];
        if (!Array.isArray(value) || value.length > max)
            throw new DomainError('SEEKER_INTERPRETATION_INVALID', 502, '解读字段 ' + field + ' 必须是数组。');
        return value.map(item => text(item, 2000));
    };
    const blockers = list(data.blockers, 'blockers', 40);
    const reconfirm = list(data.requirementsToReconfirm, 'requirementsToReconfirm', 40).map(rid => {
        if (!ids.has(rid))
            throw new DomainError('SEEKER_INTERPRETATION_REQUIREMENT_UNKNOWN', 502, '解读要求确认的需求不在当前方案里：' + rid);
        return rid;
    });
    const nextSteps = list(data.nextSteps, 'nextSteps', 8).map(step => {
        if (!(SEEKER_NEXT_STEPS as readonly string[]).includes(step))
            throw new DomainError('SEEKER_INTERPRETATION_STEP_UNKNOWN', 502, '解读给出了不存在的下一步：' + step);
        return step;
    });
    if (hasSecret(JSON.stringify({ blockers, reconfirm, nextSteps })))
        throw new DomainError('SEEKER_INTERPRETATION_SECRET', 502);
    // A PASS is not a request for another questionnaire: the owner is never forced back into the
    // interview, and nothing is accepted on their behalf.
    const requiresNewInterview = handoff.verdict === 'PASS' ? false : data.requiresNewInterview === true;
    if (handoff.verdict === 'PASS' && reconfirm.length)
        throw new DomainError('SEEKER_INTERPRETATION_INVALID', 502, 'PASS 结论不能要求重新确认需求。');
    return { blockers, requirementsToReconfirm: reconfirm, nextSteps, requiresNewInterview };
}

/**
 * The Demo reading. A Demo run never dispatches a model, so the interpretation is derived from the
 * recorded verdict and findings by the same rules the Demo interview uses. It is labelled DEMO_RULES
 * so nobody mistakes it for a Seeker turn.
 */
export function deterministicInterpretation(handoff: SeekerReviewHandoff, review: Record<string, unknown>): Pick<SeekerReviewInterpretation, 'blockers' | 'requirementsToReconfirm' | 'nextSteps' | 'requiresNewInterview' | 'source'> {
    const findings = Array.isArray(review.findings) ? review.findings.map(item => object(item)) : [];
    const blockers = findings.filter(f => f.severity === 'critical' || f.severity === 'high').map(f => text(f.description, 2000));
    const nextSteps = handoff.verdict === 'PASS' ? ['DELIVER', 'STOP'] : handoff.verdict === 'BLOCKED' ? ['REVISE_REQUIREMENTS', 'STOP'] : ['REPAIR_AND_RERUN', 'REVISE_REQUIREMENTS'];
    return { blockers, requirementsToReconfirm: [], nextSteps, requiresNewInterview: false, source: 'DEMO_RULES' };
}

export function persistInterpretation(store: Store, handoff: SeekerReviewHandoff, value: Pick<SeekerReviewInterpretation, 'blockers' | 'requirementsToReconfirm' | 'nextSteps' | 'requiresNewInterview' | 'source'>, actor: string): SeekerReviewInterpretation {
    const interpretation: SeekerReviewInterpretation = {
        id: id('seeker'), runId: handoff.runId, projectId: handoff.projectId, specId: handoff.specId, specHash: handoff.specHash,
        planVersionId: handoff.planVersionId, planVersionHash: handoff.planVersionHash,
        workspace: handoff.workspace, treeHash: handoff.treeHash,
        reviewRecordId: handoff.reviewRecordId, reviewRecordHash: handoff.reviewRecordHash, verdict: handoff.verdict,
        ...value, autoAccept: false, at: now(),
    };
    store.tx(() => {
        store.record('SeekerInterpretation', handoff.projectId, handoff.runId, { ...interpretation, actor });
        store.event(handoff.projectId, handoff.runId, 'seeker.review.interpreted', {
            interpretationId: interpretation.id, reviewRecordId: handoff.reviewRecordId, verdict: handoff.verdict,
            blockers: interpretation.blockers.length, requirementsToReconfirm: interpretation.requirementsToReconfirm, autoAccept: false,
        });
    });
    return interpretation;
}
