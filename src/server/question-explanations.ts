/**
 * Question explanations: "换种说法 / 举例子 / 解释选项" beside one star.
 *
 * Three rules, enforced here rather than trusted to the page:
 *   1. It never writes an answer, never changes the spec or the plan and never starts a Flow.
 *      This module holds no reference to `Interviews.answer` or to the Engine at all.
 *   2. Its context is its own: every request is stored as a `QuestionExplanationSession` record
 *      next to the answer, never merged into `project.answers`.
 *   3. It costs money like any other model turn: it records a `ModelAttempt` before dispatch, so
 *      it spends from the same per-project call budget, and it stops at its own turn cap.
 *
 * An explanation that arrives after the owner already answered is marked `superseded` and
 * changes no state. The reply text is still returned — the owner asked a question and gets the
 * answer — but nothing in the project moves because of it.
 */
import type { Config } from '../shared/types.js';
import type { StarExplainSessionView, StarExplainTurn, StarExplainView } from '../shared/project-roles.js';
import { DomainError, hash, id, hasSecret, now } from './security.js';
import type { Store } from './store.js';
import { ENGINE_ROLES } from '../shared/engine-mode.js';

export const EXPLANATION_SESSION_KIND = 'QuestionExplanationSession';
export const EXPLANATION_SESSION_SCHEMA = 'dm.question-explanation-session.v1';
const MAX_TURNS_PER_REQUEST = 12;
const MAX_TURNS_PER_PROJECT = 24;
const MAX_TURN_CHARS = 4000;

export interface ExplanationModelResult {
    data: Record<string, unknown>;
    usage?: unknown;
}
/** The one seam a model is reached through; tests inject an offline stub. */
export interface ExplanationModel {
    complete(payload: Record<string, unknown>, signal?: AbortSignal): Promise<ExplanationModelResult>;
}

export interface ExplanationAskInput {
    turns: unknown;
    /** The question text the page rendered. Recorded for audit; the Store's own text decides. */
    question?: unknown;
}

const readTurn = (raw: unknown): StarExplainTurn => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('EXPLANATION_TURNS_INVALID', 400, '解释会话的每一轮都必须是 {role, text}。');
    const row = raw as Record<string, unknown>;
    const keys = Object.keys(row);
    if (keys.length !== 2 || !Object.hasOwn(row, 'role') || !Object.hasOwn(row, 'text')) throw new DomainError('EXPLANATION_TURNS_INVALID', 400, '解释会话的每一轮只能有 role 和 text。');
    if (row.role !== 'user' && row.role !== 'model') throw new DomainError('EXPLANATION_TURNS_INVALID', 400, '解释会话的角色只有 user 与 model。');
    if (typeof row.text !== 'string' || !row.text.trim() || row.text.length > MAX_TURN_CHARS || hasSecret(row.text))
        throw new DomainError('EXPLANATION_TURNS_INVALID', 400, '解释会话的文本为空、过长或包含凭据样式的内容。');
    return Object.freeze({ role: row.role as 'user' | 'model', text: row.text });
};

export class QuestionExplanations {
    constructor(
        private readonly store: Store,
        private readonly model: ExplanationModel,
        private readonly config: () => Config
    ) { }

    private project(projectId: string) {
        const project = this.store.project(projectId);
        return project;
    }

    private question(projectId: string, starId: string) {
        const project = this.project(projectId);
        const question = project.questions.find(candidate => candidate.id === starId);
        if (!question) throw new DomainError('STAR_NOT_FOUND', 404, '这个项目里没有这颗星星（问题）对应的记录。');
        return { project, question };
    }

    private turnsUsed(projectId: string): number {
        return this.store.records(projectId, EXPLANATION_SESSION_KIND).length;
    }

    private callsUsed(projectId: string): number {
        return this.store.records(projectId, 'ModelAttempt').length;
    }

    private remaining(projectId: string): number {
        const byProject = Math.max(0, MAX_TURNS_PER_PROJECT - this.turnsUsed(projectId));
        const byBudget = Math.max(0, this.config().planner1.maxCallsPerProject - this.callsUsed(projectId));
        return Math.min(byProject, byBudget);
    }

    /** Every explanation session of one star, oldest first. Never includes the formal answer. */
    history(projectId: string, starId: string): StarExplainSessionView[] {
        const { project } = this.question(projectId, starId);
        const answerRevision = project.answers.find(candidate => candidate.questionId === starId)?.revision ?? null;
        return this.store.records(projectId, EXPLANATION_SESSION_KIND)
            .filter(row => (row.data as { starId?: unknown }).starId === starId)
            .map(row => {
                const value = row.data as {
                    sessionId: string; starId: string; question: string; turns: StarExplainTurn[];
                    answerRevisionAtStart: number | null; superseded: boolean; ended: boolean; at: string;
                };
                return Object.freeze({
                    sessionId: value.sessionId,
                    starId: value.starId,
                    question: value.question,
                    turns: Object.freeze(value.turns.map(turn => Object.freeze({ role: turn.role, text: turn.text }))) as readonly StarExplainTurn[],
                    answerRevision: value.answerRevisionAtStart,
                    superseded: value.superseded === true || (answerRevision !== null && answerRevision !== value.answerRevisionAtStart),
                    ended: value.ended === true,
                    at: value.at
                });
            });
    }

    /**
     * One explanation turn. The reply is model text; it is stored beside the answer and never
     * written into it, and a reply that arrives after the owner answered changes nothing.
     */
    async ask(projectId: string, starId: string, input: ExplanationAskInput): Promise<StarExplainView> {
        const { project, question } = this.question(projectId, starId);
        const rawTurns = input.turns;
        if (!Array.isArray(rawTurns) || rawTurns.length === 0 || rawTurns.length > MAX_TURNS_PER_REQUEST)
            throw new DomainError('EXPLANATION_TURNS_INVALID', 400, '解释会话需要 1 到 ' + MAX_TURNS_PER_REQUEST + ' 轮对话。');
        const turns = rawTurns.map(readTurn);
        if (turns[turns.length - 1].role !== 'user')
            throw new DomainError('EXPLANATION_TURNS_INVALID', 400, '解释会话的最后一句必须由用户提出。');
        const answer = project.answers.find(candidate => candidate.questionId === starId) ?? null;
        if (this.remaining(projectId) < 1)
            throw new DomainError('EXPLANATION_CALL_BUDGET_EXCEEDED', 409, '这个项目的解释请求已经用完（或已到调用上限）；不会自动改用其他计费路径。');
        const answerRevisionAtStart = answer?.revision ?? null;
        const sessionId = id('explain');
        const startedAt = now();
        const modelName = this.config().planner1.model || 'UNCONFIGURED';
        const configurationHash = hash(this.config().planner1);
        this.store.record('ModelAttempt', projectId, null, {
            at: startedAt, status: 'REQUESTED', costUsd: null, model: modelName,
            protocol: 'question-explanation', provider: 'LOCAL_PRODUCT', providerId: 'question-explanation',
            sessionId, configurationHash
        });
        let reply: string;
        try {
            const result = await this.model.complete({
                task: 'question_explanation',
                contract: 'dm.question-explanation.v1',
                projectId,
                starId,
                question: question.text,
                answered: answer?.status === 'answered',
                instruction: '只解释这一道问题：换一种说法、举一个具体例子、或者解释选项之间的差别。不要替用户作答，不要写出可以直接填进回答的正式答案，不要提出方案变更，不要启动任何工程步骤。用简体中文，最多 400 字。',
                turns
            });
            const value = result.data.reply;
            if (typeof value !== 'string' || !value.trim() || value.length > MAX_TURN_CHARS)
                throw new DomainError('EXPLANATION_OUTPUT_INCONTRACT', 502, '模型没有返回可用的解释文本；不会拿它当解释。');
            reply = value.trim();
            const usage = result.usage && typeof result.usage === 'object'
                ? { ...(result.usage as Record<string, unknown>), costUsd: null, source: 'QUESTION_EXPLANATION' }
                : { role: 'planner1', costUsd: null, source: 'QUESTION_EXPLANATION' };
            this.store.record('UsageLedger', projectId, null, usage);
            this.store.record('ModelAttempt', projectId, null, { at: now(), status: 'COMPLETED', providerId: 'question-explanation', model: modelName, costUsd: null, protocol: 'question-explanation', sessionId, configurationHash });
        } catch (error) {
            const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'EXPLANATION_FAILED';
            this.store.record('ModelAttemptFailure', projectId, null, { at: now(), status: 'FAILED_OR_INTERRUPTED', code, sessionId, configurationHash });
            throw error;
        }
        // The owner may have answered while the model was thinking. That answer wins: the late
        // explanation is recorded as history and changes nothing else.
        const current = this.store.project(projectId);
        const currentRevision = current.answers.find(candidate => candidate.questionId === starId)?.revision ?? null;
        const superseded = currentRevision !== answerRevisionAtStart;
        const allTurns: StarExplainTurn[] = [...turns, Object.freeze({ role: 'model' as const, text: reply })];
        const remaining = Math.max(0, this.remaining(projectId));
        const ended = superseded || remaining < 1 || allTurns.length >= MAX_TURNS_PER_REQUEST;
        this.store.record(EXPLANATION_SESSION_KIND, projectId, null, {
            schema: EXPLANATION_SESSION_SCHEMA,
            sessionId,
            starId,
            question: question.text,
            requestedQuestion: typeof input.question === 'string' ? input.question.slice(0, 2000) : '',
            turns: allTurns,
            answerRevisionAtStart,
            superseded,
            ended,
            at: startedAt,
            model: modelName
        });
        this.store.event(projectId, null, 'question.explanation', { starId, sessionId, superseded, ended });
        return Object.freeze({ sessionId, reply, ended, superseded, turns: allTurns.length, remainingCalls: remaining });
    }

    /** The roles this module will never touch, named so a reader can see the boundary is real. */
    static readonly UNTOUCHED_ROLES = ENGINE_ROLES;
}
