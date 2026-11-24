import { DomainError, hash, object } from '../security.js';

/**
 * Frozen Kimi Code 2.2.0 protocol contract (K05, offline half).
 *
 * Source of truth: the official Server API reference fetched on 2026-10-17
 * (docs/kimi-p1/evidence/raw/server-api-en.txt). Nothing here is verified against a
 * running server yet; it is a contract module plus a reducer, exercised offline.
 *
 * Deliberate rules, all evidence-driven:
 * - Event frames are { type, seq, epoch?, volatile?, offset?, session_id?, timestamp, payload }.
 *   Durable frames carry a strictly increasing seq and are replayable; *.delta frames are
 *   volatile and never replayed.
 * - assistant.delta is DRAFT text only. thinking.delta never becomes answer text and is never
 *   treated as progress.
 * - A turn is successful only when turn.ended reports reason "completed". cancelled / failed
 *   / blocked and a bare prompt.completed are never success.
 * - With a zero-tool policy, ANY tool.* / subagent.* / shell.* / task.* / approval / question
 *   event is a policy violation and stops the turn.
 */
export const KIMI_PROTOCOL_VERSION = 1;

export const KIMI_EVENT_FAMILIES = {
    turns: ['turn.started', 'turn.ended', 'turn.step.started', 'turn.step.completed', 'turn.step.interrupted', 'turn.step.retrying'],
    streaming: ['assistant.delta', 'thinking.delta'],
    tools: ['tool.call.started', 'tool.call.delta', 'tool.progress', 'tool.result'],
    interactions: ['event.approval.requested', 'event.approval.resolved', 'event.question.requested', 'event.question.answered', 'event.question.dismissed'],
    subagents: ['subagent.spawned', 'subagent.started', 'subagent.suspended', 'subagent.completed', 'subagent.failed'],
    background: ['task.started', 'task.terminated', 'shell.started', 'shell.output', 'shell.completed'],
    misc: ['skill.activated', 'goal.updated', 'error', 'warning']
} as const;

/** Families that must never appear under a zero-tool policy. */
const FORBIDDEN_UNDER_ZERO_TOOLS = new Set<string>([
    ...KIMI_EVENT_FAMILIES.tools,
    ...KIMI_EVENT_FAMILIES.subagents,
    ...KIMI_EVENT_FAMILIES.background,
    ...KIMI_EVENT_FAMILIES.interactions
]);

export interface KimiEventFrame {
    type: string;
    seq?: number;
    epoch?: string | number;
    volatile?: boolean;
    offset?: number;
    session_id?: string;
    timestamp?: string;
    payload?: Record<string, unknown>;
}

export interface KimiTurnExpectation {
    serverId: string;
    epoch: string | number;
    sessionId: string;
    agentId: string;
    promptId: string;
}

export interface KimiTurnReceipt {
    protocolVersion: number;
    serverId: string;
    epoch: string | number;
    sessionId: string;
    agentId: string;
    promptId: string;
    turnId: string;
    reason: 'completed';
    seq: number | null;
    answerChars: number;
    answerHash: string;
    thinkingChars: number;
    duplicateFrames: number;
    /** True only when the turn was terminated by turn.ended with reason=completed. */
    completedByTurnEnd: boolean;
}

/**
 * REST envelope check. HTTP 200 alone is never success: the business code must say so.
 * Returns the payload and throws KIMI_API_ERROR when the server reported a non-zero code.
 */
export function unwrapKimiResponse(body: unknown): Record<string, unknown> {
    const value = object(body);
    if (value.code !== undefined && value.code !== 0 && value.code !== '0')
        throw new DomainError('KIMI_API_ERROR', 502, 'Kimi 服务返回非零业务码；不把 HTTP 200 当成成功。');
    const data = value.data;
    const payload = data === undefined ? value : object(data);
    // Live observation 2026-10-17 (K03 qualification): /api/v1/oauth/usage and /oauth/userinfo
    // answer HTTP 200 with code 0 and an in-band { kind: "error", message } payload when no
    // account is bound. A zero business code alone is therefore not success either.
    if (payload.kind === 'error')
        throw new DomainError('KIMI_API_IN_BAND_ERROR', 502, 'Kimi 服务以 in-band error 回应；code=0 也不能当作成功。');
    return payload;
}

export class KimiTurnStream {
    private readonly expected: KimiTurnExpectation;
    private readonly zeroTools: boolean;
    private draft = '';
    private thinking = '';
    private lastSeq = -1;
    private duplicates = 0;
    private turnId = '';
    private ended: 'completed' | 'not-completed' | null = null;
    private promptCompletedSeen = false;

    constructor(expected: KimiTurnExpectation, options: { zeroTools?: boolean } = {}) {
        for (const key of ['serverId', 'sessionId', 'agentId', 'promptId'] as const)
            if (typeof expected[key] !== 'string' || expected[key].length === 0)
                throw new DomainError('KIMI_BINDING_INCOMPLETE', 500, `缺少真实 ${key}；不得用自签标签代替上游元信息。`);
        this.expected = expected;
        this.zeroTools = options.zeroTools !== false;
    }

    get answer(): string { return this.draft; }
    get isComplete(): boolean { return this.ended === 'completed'; }
    get currentTurnId(): string { return this.turnId; }

    accept(frame: KimiEventFrame): void {
        const frameType = typeof frame.type === 'string' ? frame.type : '';
        if (!frameType)
            throw new DomainError('KIMI_EVENT_MALFORMED', 502);
        if (typeof frame.session_id === 'string' && frame.session_id !== this.expected.sessionId)
            throw new DomainError('KIMI_EVENT_FOREIGN_SESSION', 502, '事件属于其他会话；不得计入本回合。');
        if (frame.epoch !== undefined && String(frame.epoch) !== String(this.expected.epoch))
            throw new DomainError('KIMI_EVENT_EPOCH_MISMATCH', 502, 'epoch 已变化；必须重新订阅并重建，不得拼接旧流。');
        if (frame.volatile !== true) {
            if (!Number.isSafeInteger(frame.seq) || Number(frame.seq) < 0)
                throw new DomainError('KIMI_EVENT_SEQ_REQUIRED', 502);
            const seq = Number(frame.seq);
            if (seq === this.lastSeq) { this.duplicates++; return; }
            if (seq < this.lastSeq)
                throw new DomainError('KIMI_EVENT_SEQ_REGRESSION', 502, '事件乱序；不得按到达顺序拼装答案。');
            this.lastSeq = seq;
        }
        if (this.zeroTools && FORBIDDEN_UNDER_ZERO_TOOLS.has(frameType))
            throw new DomainError('KIMI_TOOL_EVENT_VIOLATION', 409, `零工具策略下出现 ${frameType}；立即停止并记录违反策略。`);
        const payload = object(frame.payload ?? {});
        switch (frameType) {
            case 'turn.started': {
                const id = typeof payload.turn_id === 'string' ? payload.turn_id : typeof payload.id === 'string' ? payload.id : '';
                if (id) this.turnId = id;
                return;
            }
            case 'assistant.delta': {
                const text = typeof payload.text === 'string' ? payload.text : typeof payload.content === 'string' ? payload.content : '';
                if (!text) return;
                if (typeof frame.offset === 'number' && frame.offset !== this.draft.length)
                    throw new DomainError('KIMI_DELTA_OFFSET_GAP', 502, 'delta 偏移与已收文本不一致；必须先 snapshot 对账，不盲拼。');
                this.draft += text;
                return;
            }
            case 'thinking.delta': {
                const text = typeof payload.text === 'string' ? payload.text : '';
                this.thinking += text;
                return;
            }
            case 'turn.ended': {
                const reported = object(payload.turn ?? {});
                const endedTurn = typeof reported.id === 'string' ? reported.id : typeof payload.turn_id === 'string' ? payload.turn_id : '';
                if (this.turnId && endedTurn && endedTurn !== this.turnId)
                    throw new DomainError('KIMI_TURN_ID_MISMATCH', 502, '结束事件属于其他回合；不得据此提交。');
                const reason = typeof payload.reason === 'string' ? payload.reason : typeof reported.reason === 'string' ? reported.reason : '';
                if (reason !== 'completed') {
                    this.ended = 'not-completed';
                    throw new DomainError('KIMI_TURN_NOT_COMPLETED', 502, `回合终态为 ${reason || 'UNKNOWN'}；cancelled/failed/blocked 都不是成功。`);
                }
                this.ended = 'completed';
                return;
            }
            case 'prompt.completed': {
                // A prompt completion is corroboration only; the name alone is never success.
                const reason = typeof payload.reason === 'string' ? payload.reason : '';
                const reported = object(payload.turn ?? {});
                const endedTurn = typeof reported.id === 'string' ? reported.id : typeof payload.turn_id === 'string' ? payload.turn_id : '';
                if (this.turnId && endedTurn && endedTurn !== this.turnId)
                    throw new DomainError('KIMI_TURN_ID_MISMATCH', 502, 'prompt 完成事件属于其他回合。');
                if (reason && reason !== 'completed')
                    throw new DomainError('KIMI_TURN_NOT_COMPLETED', 502, `prompt 终态为 ${reason}；不当作成功。`);
                this.promptCompletedSeen = true;
                return;
            }
            case 'error': {
                throw new DomainError('KIMI_STREAM_ERROR', 502, '上游以 error 事件终止本回合。');
            }
            default:
                return;
        }
    }

    /**
     * Atomic-commit precondition. Callers must additionally re-verify project version, lease and
     * the cancellation flag immediately before writing; this only proves the protocol side.
     */
    receipt(): KimiTurnReceipt {
        if (this.ended !== 'completed')
            throw new DomainError('KIMI_TURN_INCOMPLETE', 409, '回合未以 completed 结束；不得提交部分结果。');
        if (!this.turnId)
            throw new DomainError('KIMI_TURN_ID_MISSING', 502, '没有真实 turnId；不得伪造上游标识。');
        return {
            protocolVersion: KIMI_PROTOCOL_VERSION,
            serverId: this.expected.serverId,
            epoch: this.expected.epoch,
            sessionId: this.expected.sessionId,
            agentId: this.expected.agentId,
            promptId: this.expected.promptId,
            turnId: this.turnId,
            reason: 'completed',
            seq: this.lastSeq >= 0 ? this.lastSeq : null,
            answerChars: this.draft.length,
            answerHash: hash(this.draft),
            thinkingChars: this.thinking.length,
            duplicateFrames: this.duplicates,
            completedByTurnEnd: true
        };
    }
}
