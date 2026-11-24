/**
 * Star answers: read one question's answer with its history, and edit it when the project is
 * genuinely free.
 *
 * The six freeze conditions are enforced here, on the server, from Store facts only. A control
 * that is disabled in the page is a courtesy; this file is the gate:
 *
 *   RUN_IN_PROGRESS        — a Flow is planning / implementing / verifying / reviewing / repairing
 *   RUN_PAUSED             — a Flow is paused or asking to pause
 *   WORKSPACE_LEASE_HELD   — a workspace lease has not been released
 *   RESULT_UNKNOWN         — a previous result is uncertain, so nobody knows what state we are in
 *   DELIVERY_NOT_SETTLED   — a delivered result was not accepted or closed yet
 *   DF_WORK_IN_PROGRESS    — DF (custom) work is open on this project
 *
 * An accepted edit keeps the old answer in `answerHistory`, marks the spec that depended on it
 * stale, drops the project's spec pointer, revokes its approvals and drops the confirmation the
 * requirements draft carried — the draft no longer describes what the owner just said.
 */
import type { Project, Run } from '../shared/types.js';
import type { StarAnswerView, StarEditSavedView, StarFreezeReason, StarHistoryEntry, StarStatus } from '../shared/project-roles.js';
import { DomainError, hash, integer, hasSecret, text } from './security.js';
import type { Store } from './store.js';
import type { EngineModes } from './engine-mode.js';
import type { Interviews } from './interview.js';
import { reportOf } from './role-configuration.js';

export const STAR_ANSWER_EDIT_RECORD_KIND = 'StarAnswerEdit';
const ACTIVE_STATES = ['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'REPAIRING', 'CANCEL_REQUESTED'];
const PAUSED_STATES = ['PAUSE_REQUESTED', 'PAUSED'];
const DF_OPEN_STATES = [...ACTIVE_STATES, 'PAUSE_REQUESTED', 'PAUSED', 'BLOCKED'];
const UNCERTAIN = /RESULT_UNCERTAIN|RESULT_UNKNOWN|UNKNOWN_RESULT/;

export class StarAnswers {
    constructor(
        private readonly store: Store,
        private readonly interviews: Interviews,
        private readonly engines: EngineModes
    ) { }

    /** The one freeze evaluator. Every star read and every star write asks this function. */
    freeze(projectId: string): readonly StarFreezeReason[] {
        const project = this.store.project(projectId);
        const runs: Run[] = this.store.runs(projectId);
        const reasons: StarFreezeReason[] = [];
        if (runs.some(run => ACTIVE_STATES.includes(run.state))) reasons.push('RUN_IN_PROGRESS');
        if (runs.some(run => PAUSED_STATES.includes(run.state))) reasons.push('RUN_PAUSED');
        if (this.store.db.prepare('SELECT 1 FROM workspace_leases WHERE project_id=?').get(projectId)) reasons.push('WORKSPACE_LEASE_HELD');
        const uncertain = runs.some(run => UNCERTAIN.test(String((run as unknown as { reason?: unknown }).reason ?? '')))
            || (project.warnings ?? []).some(warning => UNCERTAIN.test(warning));
        if (uncertain) reasons.push('RESULT_UNKNOWN');
        if (runs.some(run => run.state === 'READY_FOR_DELIVERY')) reasons.push('DELIVERY_NOT_SETTLED');
        // DF work is in progress when this project is decided to be custom (or a custom Flow was
        // frozen on it) and some Flow of it is still open. A closed, accepted or cancelled Flow is
        // history, not work, so it never freezes an answer forever.
        const dfDecided = this.engines.resolve(projectId).engine === 'custom';
        const dfFrozen = runs.some(run => run.flowName === 'custom');
        if ((dfDecided || dfFrozen) && runs.some(run => DF_OPEN_STATES.includes(run.state))) reasons.push('DF_WORK_IN_PROGRESS');
        return Object.freeze(reasons);
    }

    /** What the star shows for the project's newest Flow. Never an optimistic guess. */
    status(projectId: string): StarStatus {
        const run = this.store.runs(projectId)[0];
        if (!run) return 'NOT_STARTED';
        if (ACTIVE_STATES.includes(run.state) || PAUSED_STATES.includes(run.state)) return 'IN_PROGRESS';
        if (run.state === 'READY_FOR_DELIVERY') return 'CRAFTED';
        if (run.state === 'ACCEPTED') return 'VERIFIED';
        if (run.state === 'CANCELLED') return 'CHANGED';
        if (['BLOCKED', 'FAILED', 'PARTIAL'].includes(run.state)) return 'BLOCKED';
        return 'IN_PROGRESS';
    }

    private question(project: Project, starId: string) {
        const question = project.questions.find(candidate => candidate.id === starId);
        if (!question) throw new DomainError('STAR_NOT_FOUND', 404, '这个项目里没有这颗星星（问题）对应的记录。');
        return question;
    }

    history(project: Project, starId: string): StarHistoryEntry[] {
        return (project.answerHistory ?? [])
            .filter(answer => answer.questionId === starId)
            .map(answer => Object.freeze({ revision: answer.revision, answer: answer.text, status: answer.status, at: answer.createdAt }))
            .sort((left, right) => left.revision - right.revision);
    }

    view(projectId: string, starId: string): StarAnswerView {
        const project = this.store.project(projectId);
        const question = this.question(project, starId);
        const answer = project.answers.find(candidate => candidate.questionId === starId) ?? null;
        const frozenBy = this.freeze(projectId);
        return Object.freeze({
            starId,
            question: question.text,
            answer: answer?.text ?? '',
            answeredAt: answer?.createdAt ?? '',
            status: this.status(projectId),
            taskId: null,
            taskTitle: '',
            revision: answer?.revision ?? 0,
            history: Object.freeze(this.history(project, starId)) as readonly StarHistoryEntry[],
            editable: frozenBy.length === 0 && project.planner1Mode !== 'USER',
            frozenBy,
            engine: reportOf(this.engines.view(projectId))
        });
    }

    private approvalsExist(projectId: string): boolean {
        return !!this.store.db.prepare('SELECT 1 FROM approvals WHERE project_id=? LIMIT 1').get(projectId);
    }

    /**
     * Write a new answer for one star. Refused under any freeze condition, with the reason named
     * in the code and in the message; never a silent no-op.
     */
    edit(projectId: string, starId: string, input: { revision: unknown; answer: unknown }, actor: string): StarEditSavedView {
        if (!/^local-session:[a-f0-9]{64}$/.test(actor)) throw new DomainError('STAR_ANSWER_ACTOR_REQUIRED', 400, '缺少本地会话身份；这次编辑没有被记录。');
        const project = this.store.project(projectId);
        this.question(project, starId);
        if (project.planner1Mode === 'USER') throw new DomainError('USER_PLANNER_REQUIRED', 409, '这个项目的方案由你自己维护；星星回答不会被改写。');
        const expectedRevision = integer(Number(input.revision), 0, 1000000);
        const answer = typeof input.answer === 'string' ? text(input.answer, 8000, true) : '';
        if (hasSecret(answer)) throw new DomainError('SECRET_IN_NOTES', 400, '回答里包含凭据样式的内空；不会保存。');
        const frozenBy = this.freeze(projectId);
        if (frozenBy.length) {
            const primary = frozenBy[0];
            throw new DomainError('STAR_ANSWER_FROZEN_' + primary, 409,
                '现在不能改这颗星星（' + frozenBy.join('、') + '）：' +
                (primary === 'RUN_IN_PROGRESS' ? '运行还在进行。' :
                    primary === 'RUN_PAUSED' ? '运行已暂停，继续或取消后才能改。' :
                        primary === 'WORKSPACE_LEASE_HELD' ? '工作区租约还没有释放。' :
                            primary === 'RESULT_UNKNOWN' ? '上一次结果未确定，先核对状态。' :
                                primary === 'DELIVERY_NOT_SETTLED' ? '已交付但还没有收口。' : 'DF 工作还在进行。'));
        }
        const current = project.answers.find(candidate => candidate.questionId === starId) ?? null;
        if ((current?.revision ?? 0) !== expectedRevision)
            throw new DomainError('STAR_ANSWER_REVISION_CONFLICT', 409, '这颗星星的回答已经被改过；请刷新后再改。');
        const before = {
            specId: project.specId,
            approvals: this.approvalsExist(projectId),
            draftConfirmed: project.requirementsDraft?.confirmed != null
        };
        // The requirements draft is the first thing that depended on the old answer: its
        // confirmation is dropped *before* the interview write, so a crash in between can only
        // leave the project more conservative, never less.
        if (before.draftConfirmed) {
            const fresh = this.store.project(projectId);
            if (fresh.requirementsDraft) {
                fresh.requirementsDraft = { ...fresh.requirementsDraft, confirmed: null };
                this.store.tx(() => this.store.saveProject(fresh));
            }
        }
        const version = this.store.project(projectId).version;
        this.interviews.answer(projectId, starId, answer, false, version, undefined);
        const after = this.store.project(projectId);
        const saved = after.answers.find(candidate => candidate.questionId === starId);
        this.store.record(STAR_ANSWER_EDIT_RECORD_KIND, projectId, null, {
            schema: 'dm.star-answer-edit.v1',
            projectId,
            starId,
            actor,
            at: new Date().toISOString(),
            before,
            after: { specId: after.specId, approvals: this.approvalsExist(projectId), draftConfirmed: after.requirementsDraft?.confirmed != null },
            answerRevision: saved?.revision ?? 0,
            answerHash: hash(answer)
        });
        return Object.freeze({
            starId,
            revision: saved?.revision ?? 0,
            answer: saved?.text ?? answer,
            status: 'CHANGED' as StarStatus,
            updatedAt: saved?.createdAt ?? new Date().toISOString(),
            engine: reportOf(this.engines.view(projectId)),
            superseded: Object.freeze({
                draftInvalidated: before.draftConfirmed,
                specId: before.specId,
                approvalsRevoked: before.approvals
            })
        });
    }
}
