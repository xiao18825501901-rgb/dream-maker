/**
 * Phase strip projection: the five product stages in the order they really happened.
 *
 * Pure data in, pure data out — no DOM, no clock, no fetch. The chat shell renders the result
 * and `tests/revamp/chat-stages.test.mjs` drives it without a browser.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * `chat-shell.ts` used to show one bubble for the current phase. The product asks for the whole
 * sequence (Seeker 探寻中 -> DreamFlow 流转中 -> Planner 规划中 -> Executor 执行中 -> Reviewer
 * 审查中, with DF having no seeker segment), so the ordering rule needs to live somewhere it can
 * be tested on its own instead of inside a 7 KB template literal.
 *
 * HONEST ORDER
 * ------------
 * A stage's time comes from real evidence: the earliest message that role actually produced, or
 * the phase timestamp the controller observed. Two stages are compared by their real timestamps;
 * when either side has no timestamp the product order wins, so an unstarted stage can never be
 * sorted in front of a stage that already happened.
 *
 * Display names come from `src/shared/role-names.ts` (the rename source of truth), never from a
 * literal in this file.
 */
import { acceptsAlias, roleMetadata } from '../shared/role-names.js';

export type StageId = 'seeker' | 'dreamflow' | 'planner' | 'executor' | 'reviewer';
export type StageProduct = 'dm' | 'df';
/** `paused` is separate from `blocked`: a paused flow is not a failed one. */
export type StageVisualState = 'done' | 'active' | 'pending' | 'blocked' | 'paused';

/** The message shape this projection needs; `ChatMessage` satisfies it structurally. */
export interface StageEvidenceMessage {
    role: string;
    at?: string;
}

/** The state shape this projection needs; `ChatState` satisfies it structurally. */
export interface StageInput {
    product: StageProduct;
    phase: string;
    phaseAt?: string;
    messages: readonly StageEvidenceMessage[];
    /** Optional: an interview with questions is seeker evidence even before a message lands. */
    questions?: readonly unknown[];
}

export interface StageBubble {
    stage: StageId;
    /** "Seeker", "DreamFlow", "Planner", "Executor", "Reviewer" — from role-names. */
    role: string;
    /** "Shown verb": 探寻中 / 流转中 / 规划中 / 执行中 / 审查中. */
    verb: string;
    /** "Seeker 探寻中" — the visible bubble text. */
    label: string;
    state: StageVisualState;
    /** Earliest real timestamp for this stage, '' when nothing observed it. */
    at: string;
    /** True for the one stage the current phase belongs to. */
    current: boolean;
}

/** Product order per product. DF has no seeker segment at all. */
const PRODUCT_ORDER: Readonly<Record<StageProduct, readonly StageId[]>> = Object.freeze({
    dm: Object.freeze(['seeker', 'dreamflow', 'planner', 'executor', 'reviewer'] as const),
    df: Object.freeze(['dreamflow', 'planner', 'executor', 'reviewer'] as const)
});

const STAGE_VERB: Readonly<Record<StageId, string>> = Object.freeze({
    seeker: '探寻中',
    dreamflow: '流转中',
    planner: '规划中',
    executor: '执行中',
    reviewer: '审查中'
});

/**
 * Which stage owns a phase. Phases that span a stage boundary (prework 交接, verifying 核验)
 * stay inside the executor stage — the precise wording is still shown in the phase detail line,
 * so the strip is not allowed to claim a stage that has not started.
 */
const PHASE_STAGE: Readonly<Record<string, StageId | null>> = Object.freeze({
    idle: null,
    seeking: 'seeker',
    awaiting_answer: 'seeker',
    optimizing: 'seeker',
    awaiting_confirmation: 'seeker',
    review_feedback: 'seeker',
    flow: 'dreamflow',
    planning: 'planner',
    prework: 'executor',
    executing: 'executor',
    verifying: 'executor',
    reviewing: 'reviewer',
    ready: null,
    accepted: null,
    blocked: null,
    paused: null,
    cancelling: null,
    error: null
});

/** Phases that mean the whole flow already ran. */
const TERMINAL_PHASES: readonly string[] = Object.freeze(['ready', 'accepted']);
/** Phases that are not "working" but must not read as done either. */
const STOPPED_PHASES: Readonly<Record<string, StageVisualState>> = Object.freeze({
    blocked: 'blocked',
    paused: 'paused',
    cancelling: 'paused',
    error: 'paused'
});

export function stageSequence(product: StageProduct): StageId[] {
    return [...PRODUCT_ORDER[product === 'df' ? 'df' : 'dm']];
}

/** Display name from the shared role metadata; the flow stage is not a role. */
export function stageDisplayName(stage: StageId): string {
    if (stage === 'dreamflow') return 'DreamFlow';
    const wireId = acceptsAlias(stage);
    return wireId ? roleMetadata(wireId).displayName : stage;
}

export function stageVerb(stage: StageId): string {
    return STAGE_VERB[stage];
}

/** "Seeker 探寻中" — display name + verb, no hard-coded role literal. */
export function stageLabel(stage: StageId): string {
    return stageDisplayName(stage) + ' ' + stageVerb(stage);
}

/** The stage the current phase belongs to, or null when the phase names no single stage. */
export function phaseStage(phase: string): StageId | null {
    return Object.hasOwn(PHASE_STAGE, phase) ? PHASE_STAGE[phase] ?? null : null;
}

function parseAt(value: string | undefined): number | null {
    if (!value) return null;
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
}

interface Evidence {
    seen: boolean;
    at: string;
}

/** Earliest real timestamp for one role. A message without a timestamp still proves it ran. */
function earliest(rows: readonly StageEvidenceMessage[], role: string): Evidence {
    let at = '';
    let time = Number.POSITIVE_INFINITY;
    let seen = false;
    for (const row of rows) {
        if (row.role !== role) continue;
        seen = true;
        const parsed = parseAt(row.at);
        if (parsed !== null && parsed < time) {
            time = parsed;
            at = row.at ?? '';
        }
    }
    return { seen, at };
}

function stageEvidence(stage: StageId, input: StageInput): Evidence {
    const order = stageSequence(input.product);
    const index = order.indexOf(stage);
    const questionSeen = (input.questions?.length ?? 0) > 0;
    if (stage === 'seeker') {
        const own = earliest(input.messages, 'seeker');
        if (own.seen) return own;
        if (questionSeen) return { seen: true, at: '' };
        // An interview phase before any message still counts as the seeker working.
        return { seen: phaseStage(input.phase) === 'seeker', at: phaseStage(input.phase) === 'seeker' ? input.phaseAt ?? '' : '' };
    }
    if (stage === 'dreamflow') {
        if (input.product === 'df') return { seen: true, at: input.phase === 'flow' ? input.phaseAt ?? '' : '' };
        const own = input.phase === 'flow' ? { seen: true, at: input.phaseAt ?? '' } : { seen: false, at: '' };
        if (own.seen) return own;
        // Planning cannot start before the flow decision, so a later stage with evidence proves
        // DreamFlow ran. The seeker gets no such inference: DF projects and imported plans in DM
        // legitimately reach planning without an interview.
        const later = order.slice(index + 1).some(later => stageEvidenceRaw(later, input).seen);
        return { seen: later, at: '' };
    }
    const own = earliest(input.messages, stage);
    if (own.seen) return own;
    return { seen: false, at: '' };
}

/** Evidence without the dreamflow look-ahead, so the two functions cannot recurse. */
function stageEvidenceRaw(stage: StageId, input: StageInput): Evidence {
    if (stage === 'dreamflow' && input.product === 'df') return { seen: true, at: '' };
    return stageEvidence(stage, input);
}

/**
 * The phase strip for one product.
 *
 * - DF never yields a seeker bubble.
 * - `idle` yields every bubble as pending.
 * - `ready`/`accepted` yield every bubble as done: reaching them means the flow ran.
 * - `blocked` marks the furthest stage reached; `paused`/`cancelling`/`error` mark it paused.
 */
export function stageTimeline(input: StageInput): StageBubble[] {
    const order = stageSequence(input.product);
    const phase = typeof input.phase === 'string' ? input.phase : 'idle';
    const current = phaseStage(phase);
    const terminal = TERMINAL_PHASES.includes(phase);
    const stopped = STOPPED_PHASES[phase] ?? '';
    const evidence = new Map<StageId, Evidence>();
    for (const stage of order) evidence.set(stage, stageEvidence(stage, input));
    // Furthest stage with real evidence decides where an unmapped stop happened.
    let furthest: StageId | null = null;
    for (const stage of order) if (evidence.get(stage)?.seen) furthest = stage;
    if (current && order.includes(current) && (furthest === null || order.indexOf(current) > order.indexOf(furthest))) furthest = current;
    const currentIndex = current ? order.indexOf(current) : -1;
    const furthestIndex = furthest ? order.indexOf(furthest) : -1;
    const rows: StageBubble[] = order.map((stage, index) => {
        const own = evidence.get(stage) ?? { seen: false, at: '' };
        let state: StageVisualState = 'pending';
        if (phase === 'idle' && !own.seen) state = 'pending';
        else if (terminal) state = 'done';
        else if (current && index === currentIndex) state = stopped ? stopped : 'active';
        // "Done" needs this stage's own evidence. A later stage having started does not let the
        // strip tick a stage that never ran (a DF-style plan in DM has no seeker segment).
        else if (current && currentIndex > index && own.seen) state = 'done';
        else if (!current && stopped && index === furthestIndex) state = stopped;
        else if (!current && stopped && furthestIndex > index && own.seen) state = 'done';
        else if (own.seen) state = 'done';
        const at = own.at || (index === currentIndex ? input.phaseAt ?? '' : '');
        return {
            stage,
            role: stageDisplayName(stage),
            verb: stageVerb(stage),
            label: stageLabel(stage),
            state,
            at,
            current: index === currentIndex
        };
    });
    return rows.sort((left, right) => {
        const a = parseAt(left.at), b = parseAt(right.at);
        if (a !== null && b !== null && a !== b) return a - b;
        return order.indexOf(left.stage) - order.indexOf(right.stage);
    });
}

/** Human state words for the strip (and its accessible names). */
export const STAGE_STATE_LABEL: Readonly<Record<StageVisualState, string>> = Object.freeze({
    done: '已完成',
    active: '进行中',
    pending: '未开始',
    blocked: '受阻',
    paused: '已暂停'
});

/**
 * Which bubbles are actually shown at this moment.
 *
 * The rule the product asked for: a stage is only revealed once it has really started, and the
 * strip must not show all five from the first keystroke. Printing every bubble up front reads as
 * a promise the product has not made yet and destroys the strip's value as a progress signal.
 */
export function visibleStages(input: StageInput): StageId[] {
    const rows = stageTimeline(input);
    const shown = rows.filter(row => row.state !== 'pending');
    // Nothing has started yet: keep one empty slot so the row does not pop into existence later.
    if (!shown.length) {
        const order = stageSequence(input.product);
        return order.length ? [order[0]] : [];
    }
    return shown.map(row => row.stage);
}

export interface StageStripOptions {
    /** The precise current-phase wording (e.g. 验证器核验中) used as the active bubble's name. */
    activeDetail?: string;
}

const esc = (value: string): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Local HH:MM, matching the shell's own stamp format. */
function clock(value: string): string {
    const time = parseAt(value);
    if (time === null) return '';
    const date = new Date(time);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

/**
 * The strip markup. Kept next to the projection so a test can snapshot the DM and DF strips
 * without a browser: the only difference between the two is the missing seeker bubble.
 */
export function stageStripMarkup(input: StageInput, options: StageStripOptions = {}): string {
    const visible = new Set(visibleStages(input));
    const bubbles = stageTimeline(input).filter(row => visible.has(row.stage)).map(row => {
        const state = STAGE_STATE_LABEL[row.state];
        const name = row.current && options.activeDetail ? options.activeDetail : row.label;
        return '<span class="dc-stage-bubble" role="listitem"' +
            ' data-stage="' + esc(row.stage) + '" data-state="' + esc(row.state) + '"' +
            (row.current ? ' aria-current="step"' : '') +
            ' aria-label="' + esc(name) + ' · ' + esc(state) + '"' +
            ' title="' + esc(row.label) + ' · ' + esc(state) + '">' +
            '<span class="dc-stage-dot" aria-hidden="true"></span>' +
            '<span class="dc-stage-text">' + esc(row.label) + '</span>' +
            (row.at ? '<time class="dc-stage-time">' + esc(clock(row.at)) + '</time>' : '') +
            '</span>';
    }).join('');
    return '<div class="dc-stage-track" role="list" aria-label="本轮阶段">' + bubbles + '</div>';
}

/** Convenience for the shell: the one bubble that is working right now, if any. */
export function activeStageBubble(input: StageInput): StageBubble | null {
    return stageTimeline(input).find(row => row.state === 'active') ?? null;
}
