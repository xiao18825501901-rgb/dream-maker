import type { Store } from './store.js';
import type { Project, Run, Spec } from '../shared/types.js';
import { DomainError, hash, hasSecret, integer, object, text } from './security.js';
import { canReviseAfterFlow } from './flow/conclusion.js';

/** Presentation metadata shares the original append-only records table. No new database. */
export interface ChatProjectPresentation {
    pinned: boolean;
    archived: boolean;
    revision: number;
    nameEdited: boolean;
    nameSource: 'USER' | 'MODEL' | 'DEMO_RULES' | 'ORIGINAL';
}

export function chatProjectPresentation(store: Store, pid: string): ChatProjectPresentation {
    const rows = store.records(pid, 'ChatProjectPresentation');
    const latest = rows.at(-1)?.data;
    if (!latest) return { pinned: false, archived: false, revision: 0, nameEdited: false, nameSource: 'ORIGINAL' };
    return {
        pinned: latest.pinned === true,
        archived: latest.archived === true,
        revision: Number.isSafeInteger(latest.revision) ? latest.revision : 0,
        nameEdited: latest.nameEdited === true,
        nameSource: ['USER', 'MODEL', 'DEMO_RULES', 'ORIGINAL'].includes(latest.nameSource) ? latest.nameSource : 'ORIGINAL'
    };
}

/** The browser receives the actual original lease/conclusion gate, never guesses from a badge. */
export function chatProjectEditable(store: Store, project: Project): boolean {
    if (store.db.prepare('SELECT run_id FROM workspace_leases WHERE project_id=?').get(project.id)) return false;
    return !project.activeRunId || canReviseAfterFlow(store, store.run(project.activeRunId));
}

/** Reading a settled review does not require the user's later conclusion or grant edit authority. */
export function chatReviewFeedbackReady(store: Store, project: Project, run: Run | undefined): boolean {
    if (!run || project.planner1Mode === 'USER' || run.projectId !== project.id || project.specId !== run.specId ||
        project.activeRunId && project.activeRunId !== run.id ||
        store.db.prepare('SELECT run_id FROM workspace_leases WHERE project_id=?').get(project.id)) return false;
    return ['ACCEPTED', 'CANCELLED', 'FAILED', 'PARTIAL', 'BLOCKED', 'READY_FOR_DELIVERY'].includes(run.state) &&
        !!run.review && !!run.treeHash && run.review.treeHash === run.treeHash && !(run.mode === 'live' && run.review.source === 'DEMO_RULES');
}

/** Explicit evidence projection is independent of the recent-records window. It never grants authority. */
export function chatEvidenceProjection(store: Store, project: Project, run: Run | undefined, spec: Spec | null) {
    const empty = {reviewFeedbackBinding: null, reviewFeedback: null, preworkCloseout: null};
    if (!run || !spec || spec.stale || run.projectId !== project.id || project.specId !== spec.id ||
        run.specId !== spec.id || run.specHash !== spec.hash || project.activeRunId && project.activeRunId !== run.id)
        return empty;
    const reviewFeedbackBinding = run.review && run.treeHash && run.review.treeHash === run.treeHash ? {
        runId: run.id, runVersion: run.version, specHash: run.specHash,
        reviewHash: hash(run.review), projectVersion: project.version
    } : null;
    const reviewFeedback = reviewFeedbackBinding ? store.records(project.id, 'SeekerReviewFeedback').find(row => {
        const d = row.data;
        return row.runId === run.id && d.runId === run.id && d.runVersion === run.version &&
            d.specHash === run.specHash && d.reviewHash === reviewFeedbackBinding.reviewHash &&
            d.projectVersion === project.version && !(run.mode === 'live' && d.source !== 'MODEL');
    }) ?? null : null;
    const closeout = run.prework && run.treeHash && run.verification?.ok &&
        run.verification.treeHash === run.treeHash && run.review?.verdict === 'PASS' &&
        run.review.treeHash === run.treeHash ? store.records(project.id, 'PreworkCloseout').reverse().find(row => {
            const d = row.data;
            return row.runId === run.id && d.schema === 'dm.prework.closeout.v1' &&
                d.contractId === run.prework!.contractId && d.treeHash === run.treeHash &&
                d.verificationEvidenceId === run.verification!.evidenceId && d.coverageReached === true &&
                Array.isArray(d.matrix) && d.matrix.length > 0 &&
                d.matrix.every((x: Record<string, unknown>) => typeof x?.requirementId === 'string' && x.reached === true) &&
                !(run.mode === 'live' && d.scope !== 'REAL_ROLE_AND_VERIFIER_EVIDENCE');
        }) : undefined;
    return {reviewFeedbackBinding, reviewFeedback, preworkCloseout: closeout ? {
        contractId: closeout.data.contractId as string, treeHash: closeout.data.treeHash as string,
        coverageReached: true, requirementIds: closeout.data.matrix.map((x: {requirementId: string}) => x.requirementId) as string[]
    } : null};
}

export function saveChatProjectPresentation(store: Store, pid: string, raw: unknown, actor: string): void {
    const input = object(raw);
    if (Object.keys(input).some(key => !['version', 'name', 'pinned', 'archived'].includes(key)) ||
        !['name', 'pinned', 'archived'].some(key => Object.hasOwn(input, key)))
        throw new DomainError('CHAT_PRESENTATION_INPUT_INVALID', 400);
    const expected = integer(input.version, 1, 1000000);
    if (Object.hasOwn(input, 'pinned') && typeof input.pinned !== 'boolean' ||
        Object.hasOwn(input, 'archived') && typeof input.archived !== 'boolean')
        throw new DomainError('CHAT_PRESENTATION_INPUT_INVALID', 400);
    const project = store.project(pid);
    if (project.version !== expected) throw new DomainError('STALE_PROJECT_VERSION', 409);
    const renamed = Object.hasOwn(input, 'name');
    const name = renamed ? text(input.name, 120) : project.name;
    if (hasSecret(name)) throw new DomainError('SECRET_IN_PROJECT_NAME', 400);
    // Archiving is recoverable metadata but cannot hide an active or unreconciled project.
    if ((renamed || input.archived === true) && !chatProjectEditable(store, project))
        throw new DomainError('RUN_MUST_STOP_BEFORE_EDIT', 409);
    const current = chatProjectPresentation(store, pid);
    const next: ChatProjectPresentation = {
        ...current, revision: current.revision + 1,
        ...(Object.hasOwn(input, 'pinned') ? { pinned: input.pinned as boolean } : {}),
        ...(Object.hasOwn(input, 'archived') ? { archived: input.archived as boolean } : {}),
        ...(renamed ? { nameEdited: true, nameSource: 'USER' as const } : {})
    };
    store.tx(() => {
        if (store.project(pid).version !== expected) throw new DomainError('STALE_PROJECT_VERSION', 409);
        if (renamed) { project.name = name; store.saveProject(project); }
        // Pinning never changes project input/version and cannot invalidate a model already in flight.
        store.record('ChatProjectPresentation', pid, null, { ...next, actor });
        store.event(pid, null, 'project.presentation.changed', { revision: next.revision, renamed, pinned: next.pinned, archived: next.archived });
    });
}

/** Called only inside the first question's original transaction; the question and title commit together. */
export function applyInitialChatTitle(store: Store, project: Project, proposed: string | undefined): void {
    if (!proposed || project.questions.length !== 1 || project.name !== '新项目') return;
    const current = chatProjectPresentation(store, project.id);
    if (current.nameEdited || hasSecret(proposed) || !proposed.trim() || proposed.length > 80 || proposed.includes('\0')) return;
    project.name = proposed.trim();
    store.record('ChatProjectPresentation', project.id, null, {
        ...current, revision: current.revision + 1, nameSource: project.mode === 'demo' ? 'DEMO_RULES' : 'MODEL', actor: 'SEEKER_FIRST_QUESTION'
    });
}
