/**
 * Star work status: the seven states a star shows for the task its answer started.
 *
 * ADDITIVE ONLY. `chat-projection.starsFor` already decides pending / answered / changed /
 * working / blocked / done, and those decisions must not move. This module only supplies the
 * three states that were missing between "working" and the terminal "done":
 *
 *     working (进行中)  ->  crafted (已制作)  ->  verified (已验证)  ->  reviewed (已审查)  ->  done
 *
 * NO EVIDENCE, NO PROMOTION. Each rank is earned by its own fact:
 *   crafted  : at least one task, and every task of the run is closed.
 *   verified : crafted AND the verifier passed on the exact tree the run holds.
 *   reviewed : verified AND the reviewer returned PASS on that same tree.
 *   done     : the existing, stricter closeout+acceptance rule in starsFor — unchanged.
 *
 * A missing or mismatched fact keeps the star at the rank below it; nothing is inferred from a
 * filled answer, an implemented task or a review of another source version.
 */

export type QuestionWorkStatus =
    /** No answer yet: the task this star would create has not started. */
    | 'pending'
    /** Answered, still open for the same reason the shell already showed 'answered'. */
    | 'answered'
    /** The answer was revised: the requirement moved. */
    | 'changed'
    | 'working'
    | 'blocked'
    /** 已制作 — work is done, nothing verified it yet. */
    | 'crafted'
    /** 已验证 — the verifier passed on the current source. */
    | 'verified'
    /** 已审查 — the reviewer returned PASS on the same source. */
    | 'reviewed'
    /** 已完成 — the existing closeout + acceptance rule. */
    | 'done';

export const WORK_STATUS_LABEL: Readonly<Record<QuestionWorkStatus, string>> = Object.freeze({
    pending: '未开始',
    answered: '已作答',
    changed: '需求变更',
    working: '进行中',
    blocked: '受阻',
    crafted: '已制作',
    verified: '已验证',
    reviewed: '已审查',
    done: '已完成'
});

export interface WorkEvidence {
    /** The question has a saved answer. */
    answered: boolean;
    /** Answer revision; above 1 means the user changed the requirement. */
    answerRevision: number;
    /** Tasks the current run planned for the requirements this answer produced. */
    taskCount: number;
    tasksDone: number;
    tasksRunning: number;
    /** The run is BLOCKED and it owns tasks. */
    runBlocked: boolean;
    /** `verification.ok && verification.treeHash === run.treeHash`. */
    verificationMatchesSource: boolean;
    /** `review.verdict === 'PASS' && review.treeHash === run.treeHash`. */
    reviewPassedOnSource: boolean;
    /** The existing terminal rule: closeout coverage + contract + tree + accepted/ready. */
    closeoutComplete: boolean;
}

export interface WorkStatusResult {
    status: QuestionWorkStatus;
    label: string;
    /** Why the star sits at this rank — shown next to the status, never a promise. */
    reason: string;
}

export function workStatusFor(evidence: WorkEvidence): WorkStatusResult {
    const taskCount = Math.max(0, Math.trunc(evidence.taskCount));
    const tasksDone = Math.min(taskCount, Math.max(0, Math.trunc(evidence.tasksDone)));
    const tasksRunning = Math.max(0, Math.trunc(evidence.tasksRunning));
    const allTasksClosed = taskCount > 0 && tasksDone === taskCount;

    // 1-5: decisions that already existed. Their precedence is untouched.
    if (!evidence.answered) return result('pending', '这题还没有回答。');
    if (evidence.closeoutComplete) return result('done', '相关工作已验证、已审查并完成交接。');
    if (tasksRunning > 0) return result('working', '相关工作正在执行。');
    if (evidence.runBlocked && taskCount > 0) return result('blocked', '相关工作受阻，等待处理。');

    // 6-8: the three new ranks. Each one re-tests the fact below it.
    const verified = allTasksClosed && evidence.verificationMatchesSource;
    const reviewed = verified && evidence.reviewPassedOnSource;
    if (reviewed) return result('reviewed', '验证已通过，审查也已通过；最终接受仍由你决定。');
    if (verified) return result('verified', '验证器在当前源码上通过了；还没有审查结论。');
    if (allTasksClosed) return result('crafted', '工作包都已收口，还没有验证结论。');

    // 9: the original default for an answered question.
    return evidence.answerRevision > 1 ? result('changed', '这题的回答改过，需求随之更新。') : result('answered', '回答已保存，还没有关联的工作包。');
}

function result(status: QuestionWorkStatus, reason: string): WorkStatusResult {
    return { status, label: WORK_STATUS_LABEL[status], reason };
}

/** CSS class suffix used by the shell (`is-<status>`); kept here so the two cannot drift. */
export function workStatusClass(status: QuestionWorkStatus): string {
    return 'is-' + status;
}
