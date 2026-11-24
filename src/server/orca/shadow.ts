import { assertProjectionSafe } from './adapter.js';

/**
 * A09 (SHADOW, source half): project an Engine run into the deliberately small shape Orca is allowed
 * to see. This is a whitelist builder — a field the Engine adds later does NOT appear here by
 * default, which is the only way "shadow" stays honest as the product grows.
 *
 * Never projected: the workspace path, the plan body, finding text, task acceptance text, prompts,
 * tokens or logs. Orca observes shape and lifecycle; the Engine still owns every decision.
 */
export interface ShadowTask {
    id: string;
    title: string;
    status: string;
    dependsOn: string[];
    requirementCount: number;
    acceptanceCount: number;
}

export interface ShadowRunProjection {
    projectId: string;
    runId: string;
    mode: string;
    state: string;
    phase: string;
    specHash: string;
    treeHash: string | null;
    calls: { used: number; max: number };
    repairs: { used: number; max: number };
    tasks: ShadowTask[];
    /** How many tasks were omitted because of the bound. Never silently zero. */
    tasksTruncated: number;
}

export interface ShadowProjectionInput {
    id: string;
    projectId: string;
    mode: string;
    state: string;
    phase: string;
    specHash: string;
    treeHash?: string | null;
    calls: number;
    maxCalls: number;
    repairCount: number;
    maxRepairs: number;
    tasks: { id: string; title: string; status: string; dependsOn?: string[]; requirementIds?: string[]; acceptance?: string[] }[];
}

const TITLE_LIMIT = 80;
const DEFAULT_MAX_TASKS = 50;

export function projectRunForShadow(run: ShadowProjectionInput, options: { maxTasks?: number } = {}): ShadowRunProjection {
    const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
    if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 500)
        throw new Error('SHADOW_MAX_TASKS_INVALID');
    const tasks = run.tasks.slice(0, maxTasks).map(task => ({
        id: String(task.id),
        // Titles are business content, not secrets: capped so a runaway title cannot become a payload.
        title: String(task.title ?? '').slice(0, TITLE_LIMIT),
        status: String(task.status ?? ''),
        dependsOn: [...(task.dependsOn ?? [])].map(String),
        // Counts, not text: acceptance criteria and requirement bodies stay inside Dream Maker.
        requirementCount: (task.requirementIds ?? []).length,
        acceptanceCount: (task.acceptance ?? []).length
    }));
    const projection: ShadowRunProjection = {
        projectId: String(run.projectId),
        runId: String(run.id),
        mode: String(run.mode),
        state: String(run.state),
        phase: String(run.phase),
        specHash: String(run.specHash),
        treeHash: run.treeHash ?? null,
        calls: { used: run.calls, max: run.maxCalls },
        repairs: { used: run.repairCount, max: run.maxRepairs },
        tasks,
        tasksTruncated: Math.max(0, run.tasks.length - tasks.length)
    };
    // Belt and braces: the key-based guard in the adapter would reject a leak even if a future edit
    // slipped a forbidden field into this object.
    assertProjectionSafe(projection);
    return projection;
}
export type ShadowMode = 'OFF' | 'SHADOW' | 'MANAGED_EXECUTOR';

export interface ShadowEvent {
    at: string;
    kind: string;
    runId: string;
    detail: string;
}

export interface ShadowMirror {
    /** Project one engine event, or null when mirroring is off. */
    push(kind: string, runId: string, detail?: string): ShadowEvent | null;
    /** Most recent projections, oldest first. Bounded: the mirror never grows without limit. */
    recent(): ShadowEvent[];
    stats(): { accepted: number; dropped: number; mode: ShadowMode };
}

/**
 * A bounded event mirror for SHADOW mode. Two rules matter:
 *  - OFF means OFF: in `OFF` nothing is recorded at all (a mirror that "only collects a little" is
 *    still a mirror);
 *  - the buffer is bounded and drops are counted, because an unbounded log is a denial-of-service
 *    vector and a silent drop is a lie about coverage.
 */
export function createShadowMirror(input: { mode: ShadowMode; maxEvents?: number; clock?: () => number }): ShadowMirror {
    const mode = input.mode;
    const maxEvents = input.maxEvents ?? 200;
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000)
        throw new Error('SHADOW_MAX_EVENTS_INVALID');
    const clock = input.clock ?? (() => Date.now());
    const buffer: ShadowEvent[] = [];
    let accepted = 0, dropped = 0;
    return {
        push(kind, runId, detail = '') {
            if (mode === 'OFF') return null;
            const event: ShadowEvent = {
                at: new Date(clock()).toISOString(),
                kind: String(kind).slice(0, 64),
                runId: String(runId).slice(0, 64),
                detail: String(detail).slice(0, 200)
            };
            accepted += 1;
            buffer.push(event);
            while (buffer.length > maxEvents) { buffer.shift(); dropped += 1; }
            return event;
        },
        recent: () => [...buffer],
        stats: () => ({ accepted, dropped, mode })
    };
}
/**
 * A09/HA-003: resolve the requested Orca mode without silently pretending it took effect.
 *
 * Only `OFF`, `SHADOW` and `MANAGED_EXECUTOR` are recognised. Anything else — a typo, or the
 * plausible-but-unsupported `MANAGED` — used to fall back to `OFF` with no signal at all, so an
 * operator who asked for management would read "OFF" and never learn their setting was ignored.
 * The degradation is reported instead: effective mode, what was requested, and why they differ.
 */
export function resolveOrcaMode(raw: string | undefined): {
    requested: string;
    effective: ShadowMode;
    degraded: boolean;
    reason: string | null;
} {
    const trimmed = (raw ?? '').trim().toUpperCase();
    // An empty variable means "not set", not "a mode called ''".
    const requested = trimmed === '' ? 'OFF' : trimmed;
    const effective: ShadowMode = requested === 'SHADOW' || requested === 'MANAGED_EXECUTOR' ? requested : 'OFF';
    const degraded = effective !== requested;
    return { requested, effective, degraded, reason: degraded ? 'ORCA_MODE_NOT_AVAILABLE' : null };
}
