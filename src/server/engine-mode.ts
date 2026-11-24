/**
 * The one place that decides classic vs custom.
 *
 * Inputs: the project's effective role selection and the product defaults (or, for a project
 * that already ran, the configuration it actually ran under). Output: an `EngineDecision`.
 *
 * The signature that all callers share:
 *
 *   resolveEngineDecision({ entry, selection, defaults, recorded?, historical? }): EngineDecision
 *
 * Semantics, in evaluation order:
 *   1. `recorded`    — a decision already in the Store wins unchanged (origin kept). The Store is
 *                      the truth; a reader never re-derives over it.
 *   2. `historical`  — a project that already has a frozen Flow keeps the engine that Flow used,
 *                      marked HISTORICAL_FROZEN. Changing today's defaults cannot re-flag it.
 *   3. otherwise     — compare every role field with its product default. No difference is
 *                      `classic` (Laya attached, PRODUCT_DEFAULT); any difference at all — harness,
 *                      model, or reasoning strength alone — is `custom` (USER_OVERRIDE), and every
 *                      deviating role/field is reported in `reasons`.
 */
import type { Config, Run } from '../shared/types.js';
import type { EngineeringMode } from '../shared/flow-configuration.js';
import {
    ENGINE_DECISION_SCHEMA, ENGINE_FIELDS, ENGINE_ROLES,
    type EngineBadge, type EngineBillingPath, type EngineDecision, type EngineDeviation, type EngineDeviationCode,
    type EngineEntry, type EngineField, type EngineRole, type EngineRoleSelection, type EngineRoleSet
} from '../shared/engine-mode.js';
import { DomainError, hash, integer, now, object } from './security.js';
import type { Store } from './store.js';
import { planner1Binding } from './planner1-binding.js';

/** Record kind that holds the append-only decision chain of one project. */
export const ENGINE_DECISION_RECORD_KIND = 'EngineDecision';
export const ENGINE_DECISION_RECORD_SCHEMA = 'dm.engine-decision-record.v1';
const MAX_DECISION_RECORDS = 512;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const DIGEST = /^[a-f0-9]{64}$/;

/**
 * The product defaults. They are exactly the classic bindings the product already ships, so a
 * project that never touched its roles is classic by construction, never by a guess:
 * planner1 runs on the configured Seeker runner, planner2 and reviewer on the Codex app-server
 * lane, and the executor on the DSH lane (`classicFlowSnapshot` in `flow-configuration.ts`).
 */
export function classicRoleDefaults(config: Config): EngineRoleSet {
    const seekerRunner = ((): string => {
        try { return planner1Binding(config).runner; } catch { return 'http-api'; }
    })();
    const seekerModel = config.planner1.model || 'UNSET_MODEL';
    const codexModel = config.codex.model || 'UNSET_MODEL';
    const dshModel = config.dsh.model || 'UNSET_MODEL';
    const role = (harness: string, model: string): EngineRoleSelection => Object.freeze({ harness, model, reasoning: 'default' });
    return Object.freeze({
        planner1: role(seekerRunner, seekerModel),
        planner2: role('codex-app-server', codexModel),
        executor: role('dsh', dshModel),
        reviewer: role('codex-app-server', codexModel)
    });
}

const value = (input: unknown): string => (typeof input === 'string' ? input.slice(0, 200) : '');

/** Digest of one role set; two selections with the same digest are the same configuration. */
export function roleSetHash(roles: EngineRoleSet): string {
    return hash(ENGINE_ROLES.map(role => [role, value(roles[role].harness), value(roles[role].model), value(roles[role].reasoning)]));
}

const DEVIATION_CODE: Readonly<Record<EngineField, EngineDeviationCode>> = Object.freeze({
    harness: 'HARNESS_DEVIATES_FROM_DEFAULT',
    model: 'MODEL_DEVIATES_FROM_DEFAULT',
    reasoning: 'REASONING_DEVIATES_FROM_DEFAULT'
});

/**
 * Every role/field where the selection is not the default, in role order then field order.
 * The comparison is on the normalized string, so re-typing the default value is not a deviation.
 */
/**
 * Model ids reach this comparison from two places: the product default (`deepseek-flash`) and the
 * registered catalog (`deepseek/deepseek-flash`). A provider prefix is not a configuration change,
 * so compare on the bare id; otherwise a project could never return to classic once it saved a
 * catalog id that names the same model as the default.
 */
const sameModelId = (a: string, b: string): boolean => a === b || a.split('/').pop() === b.split('/').pop();

export function engineDeviations(selection: EngineRoleSet, defaults: EngineRoleSet): EngineDeviation[] {
    const out: EngineDeviation[] = [];
    for (const role of ENGINE_ROLES) {
        for (const field of ENGINE_FIELDS) {
            const configured = value(selection[role][field]);
            const fallback = value(defaults[role][field]);
            if (field === 'model' ? sameModelId(configured, fallback) : configured === fallback) continue;
            out.push(Object.freeze({ role, field, code: DEVIATION_CODE[field], configured, fallback }));
        }
    }
    return out;
}

export interface EngineDecisionInput {
    readonly entry: EngineEntry;
    /** The project's effective role selection (what the owner has right now). */
    readonly selection: EngineRoleSet;
    /** The product defaults that selection is measured against. */
    readonly defaults: EngineRoleSet;
    /** A decision already persisted in the Store; when present it wins unchanged. */
    readonly recorded?: EngineDecision | null;
    /** The engine this project actually ran under, from its own frozen Flow configuration. */
    readonly historical?: { readonly engine: EngineeringMode; readonly runId: string } | null;
}

/** The single determination. Pure: same inputs, same decision, no Store access. */
export function resolveEngineDecision(input: EngineDecisionInput): EngineDecision {
    const selectionHash = roleSetHash(input.selection);
    const defaultsHash = roleSetHash(input.defaults);
    if (input.recorded) return input.recorded;
    if (input.historical) {
        return Object.freeze({
            schema: ENGINE_DECISION_SCHEMA,
            engine: input.historical.engine,
            origin: 'HISTORICAL_FROZEN' as const,
            entry: input.entry,
            reasons: Object.freeze([]) as readonly EngineDeviation[],
            selectionHash, defaultsHash,
            historicalRunId: input.historical.runId
        });
    }
    const reasons = engineDeviations(input.selection, input.defaults);
    const engine: EngineeringMode = reasons.length ? 'custom' : 'classic';
    return Object.freeze({
        schema: ENGINE_DECISION_SCHEMA,
        engine,
        origin: reasons.length ? 'USER_OVERRIDE' as const : 'PRODUCT_DEFAULT' as const,
        entry: input.entry,
        reasons: Object.freeze(reasons) as readonly EngineDeviation[],
        selectionHash, defaultsHash,
        historicalRunId: null
    });
}

/** Strict readback of a stored decision. Anything unexpected is an integrity failure, never a default. */
export function readEngineDecision(raw: unknown): EngineDecision {
    const fail = (): never => { throw new DomainError('ENGINE_DECISION_INTEGRITY_FAILED', 409); };
    try {
        const decision = object(raw);
        const keys = ['schema', 'engine', 'origin', 'entry', 'reasons', 'selectionHash', 'defaultsHash', 'historicalRunId'];
        if (Reflect.ownKeys(decision).length !== keys.length || keys.some(key => !Object.hasOwn(decision, key))) return fail();
        if (decision.schema !== ENGINE_DECISION_SCHEMA) return fail();
        if (decision.engine !== 'classic' && decision.engine !== 'custom') return fail();
        const origin = String(decision.origin);
        if (!['PRODUCT_DEFAULT', 'USER_OVERRIDE', 'HISTORICAL_FROZEN', 'RECORDED'].includes(origin)) return fail();
        if (decision.entry !== 'DM' && decision.entry !== 'DF') return fail();
        if (typeof decision.selectionHash !== 'string' || !DIGEST.test(decision.selectionHash)) return fail();
        if (typeof decision.defaultsHash !== 'string' || !DIGEST.test(decision.defaultsHash)) return fail();
        if (decision.historicalRunId !== null && (typeof decision.historicalRunId !== 'string' || !REF.test(decision.historicalRunId))) return fail();
        if (!Array.isArray(decision.reasons) || decision.reasons.length > ENGINE_ROLES.length * ENGINE_FIELDS.length) return fail();
        const seen = new Set<string>();
        for (const row of decision.reasons) {
            const reason = object(row);
            const reasonKeys = ['role', 'field', 'code', 'configured', 'fallback'];
            if (Reflect.ownKeys(reason).length !== reasonKeys.length || reasonKeys.some(key => !Object.hasOwn(reason, key))) return fail();
            if (!(ENGINE_ROLES as readonly string[]).includes(String(reason.role))) return fail();
            if (!(ENGINE_FIELDS as readonly string[]).includes(String(reason.field))) return fail();
            if (reason.code !== DEVIATION_CODE[reason.field as EngineField]) return fail();
            if (typeof reason.configured !== 'string' || reason.configured.length > 200) return fail();
            if (typeof reason.fallback !== 'string' || reason.fallback.length > 200) return fail();
            const identity = reason.role + ':' + reason.field;
            if (seen.has(identity)) return fail();
            seen.add(identity);
        }
        if (origin === 'PRODUCT_DEFAULT' && (decision.engine !== 'classic' || decision.reasons.length !== 0)) return fail();
        if (origin === 'USER_OVERRIDE' && (decision.engine !== 'custom' || decision.reasons.length === 0)) return fail();
        if (origin === 'HISTORICAL_FROZEN' && (decision.reasons.length !== 0 || decision.historicalRunId === null)) return fail();
        if (origin !== 'HISTORICAL_FROZEN' && decision.historicalRunId !== null) return fail();
        return Object.freeze(structuredClone(decision)) as unknown as EngineDecision;
    } catch (error) {
        if (error instanceof DomainError && error.code === 'ENGINE_DECISION_INTEGRITY_FAILED') throw error;
        return fail();
    }
}

export function engineBadge(decision: EngineDecision): EngineBadge {
    return decision.engine === 'classic'
        ? Object.freeze({ engine: 'classic' as const, label: 'classic · 含 Laya', laya: 'ON' as const, magpie: 'NOT_APPLICABLE' as const, prework: 'REQUIRED' as const })
        : Object.freeze({ engine: 'custom' as const, label: 'custom · DM 专属 Magpie', laya: 'OFF' as const, magpie: 'DM_ONLY' as const, prework: 'REQUIRED' as const });
}

/** Which budget/billing layer this decision selects. Every budget reader asks this function. */
export function engineBillingPath(decision: EngineDecision): EngineBillingPath {
    return decision.engine === 'classic'
        ? Object.freeze({ engine: 'classic' as const, layer: 'classic-laya' as const, payee: 'LAYA_SUBSCRIPTION_ROUTE' as const, budgetSource: 'CLASSIC_RUN_LIMITS' as const })
        : Object.freeze({ engine: 'custom' as const, layer: 'custom-magpie' as const, payee: 'MAGPIE_CUSTOM_ROUTE' as const, budgetSource: 'CUSTOM_FLOW_BUDGET' as const });
}

export interface EngineDecisionRecord {
    readonly schema: typeof ENGINE_DECISION_RECORD_SCHEMA;
    readonly projectId: string;
    readonly revision: number;
    readonly parentHash: string | null;
    readonly decision: EngineDecision;
    readonly source: string;
    readonly actor: string;
    readonly recordedAt: string;
    readonly contentHash: string;
}

function readEngineDecisionRecord(raw: unknown, projectId: string, revision: number, parentHash: string | null): EngineDecisionRecord {
    const fail = (): never => { throw new DomainError('ENGINE_DECISION_INTEGRITY_FAILED', 409); };
    try {
        const record = object(raw);
        const keys = ['schema', 'projectId', 'revision', 'parentHash', 'decision', 'source', 'actor', 'recordedAt', 'contentHash'];
        if (Reflect.ownKeys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return fail();
        if (record.schema !== ENGINE_DECISION_RECORD_SCHEMA || record.projectId !== projectId) return fail();
        if (Number(record.revision) !== revision || record.parentHash !== parentHash) return fail();
        if (typeof record.source !== 'string' || !REF.test(record.source)) return fail();
        if (typeof record.actor !== 'string' || !/^local-session:[a-f0-9]{64}$/.test(record.actor)) return fail();
        if (typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) return fail();
        const decision = readEngineDecision(record.decision);
        const { contentHash, ...body } = record;
        if (typeof contentHash !== 'string' || contentHash !== hash(body)) return fail();
        return Object.freeze({ ...(body as Omit<EngineDecisionRecord, 'contentHash'>), contentHash }) as EngineDecisionRecord;
    } catch (error) {
        if (error instanceof DomainError && error.code === 'ENGINE_DECISION_INTEGRITY_FAILED') throw error;
        return fail();
    }
}

/** The stored decision chain of one project, validated end to end. Needs no configuration. */
export function readDecisionChain(store: Store, projectId: string): EngineDecisionRecord[] {
    store.project(projectId);
    const rows = store.records(projectId, ENGINE_DECISION_RECORD_KIND);
    if (rows.length > MAX_DECISION_RECORDS) throw new DomainError('ENGINE_DECISION_HISTORY_LIMIT', 409);
    const out: EngineDecisionRecord[] = [];
    let parentHash: string | null = null;
    for (const row of rows) {
        const record = readEngineDecisionRecord(row.data, projectId, out.length + 1, parentHash);
        parentHash = record.contentHash;
        out.push(record);
    }
    return out;
}

/** The decision the Store already holds, or null when this project never recorded one. */
export function recordedEngineDecision(store: Store, projectId: string): EngineDecision | null {
    return readDecisionChain(store, projectId).at(-1)?.decision ?? null;
}

/**
 * Store-only gate shared by the Prework admission and the budget path, so the two can never
 * disagree: a Flow's frozen engine and the project's recorded decision must be the same engine.
 * A project that never recorded a decision has no second opinion to contradict, so only its own
 * frozen Flow describes it and nothing is refused.
 */
export function assertRunEngineAgainstStore(store: Store, run: Run): void {
    const frozen = run.flowConfig?.mode;
    if (!frozen) return;
    const recorded = recordedEngineDecision(store, run.projectId);
    if (!recorded) return;
    if (recorded.engine !== frozen)
        throw new DomainError('ENGINE_DECISION_MISMATCH', 409,
            '这个项目记录的引擎判定是 ' + recorded.engine + '，但这条流程冻结在 ' + frozen + '；不会按另一种引擎派发或计费。');
}

/** Same gate for a caller that has a project id and the engine its own path requires. */
export function assertProjectEngineAgainstStore(store: Store, projectId: string, expected: EngineeringMode): void {
    const recorded = recordedEngineDecision(store, projectId);
    if (!recorded) return;
    if (recorded.engine !== expected)
        throw new DomainError(expected === 'custom' ? 'CUSTOM_BUDGET_REQUIRES_CUSTOM_ENGINE' : 'CLASSIC_BILLING_REQUIRES_CLASSIC_ENGINE', 409,
            '这个项目记录的引擎判定是 ' + recorded.engine + '，与 ' + expected + ' 的预算路径不一致；不会按另一条计费路径预留。');
}

export interface EngineView {
    readonly schema: 'dm.workbench-engine.v1';
    readonly projectId: string;
    readonly entry: EngineEntry;
    readonly engine: EngineeringMode;
    readonly origin: EngineDecision['origin'];
    readonly decision: EngineDecision;
    readonly badge: EngineBadge;
    readonly billing: EngineBillingPath;
    readonly roles: {
        readonly selection: EngineRoleSet;
        readonly defaults: EngineRoleSet;
        readonly deviations: readonly EngineDeviation[];
    };
    readonly revision: number;
}

/**
 * The Store-backed reader every other module uses. It holds no rule of its own: the rule lives
 * in `resolveEngineDecision`, and this class only supplies it with the three possible inputs.
 */
export class EngineModes {
    constructor(
        private readonly store: Store,
        private readonly config: () => Config,
        /** Reads the project's stored role configuration; absent means "never configured". */
        private readonly roleSelection?: (projectId: string) => EngineRoleSet | null
    ) { }

    defaults(): EngineRoleSet { return classicRoleDefaults(this.config()); }

    selectionFor(projectId: string): EngineRoleSet {
        return this.roleSelection?.(projectId) ?? this.defaults();
    }

    /** The entry a project belongs to. Recorded first, then the project's own route. */
    entry(projectId: string): EngineEntry {
        const recorded = this.recorded(projectId);
        if (recorded) return recorded.entry;
        return this.store.project(projectId).planner1Mode === 'USER' ? 'DF' : 'DM';
    }

    records(projectId: string): EngineDecisionRecord[] {
        return readDecisionChain(this.store, projectId);
    }

    recorded(projectId: string): EngineDecision | null {
        return this.records(projectId).at(-1)?.decision ?? null;
    }

    /**
     * The configuration a project actually ran under. Newest frozen Flow first: that is the
     * evidence an already-running project has, so no later default can rewrite it.
     */
    historical(projectId: string): { engine: EngineeringMode; runId: string } | null {
        const run: Run | undefined = this.store.runs(projectId).find(candidate => candidate.flowConfig !== null && candidate.flowConfig !== undefined);
        if (!run || !run.flowConfig) return null;
        return { engine: run.flowConfig.mode, runId: run.id };
    }

    resolve(projectId: string): EngineDecision {
        this.store.project(projectId);
        return resolveEngineDecision({
            entry: this.entry(projectId),
            selection: this.selectionFor(projectId),
            defaults: this.defaults(),
            recorded: this.recorded(projectId),
            historical: this.recorded(projectId) ? null : this.historical(projectId)
        });
    }

    /**
     * Persist the decision that holds from now on. Called when a project is created and on every
     * role-configuration write, so the Store, the API, the badge, the Prework gate and the budget
     * path all read the same stored answer.
     */
    record(projectId: string, input: { source: string; actor: string; entry?: EngineEntry; ignoreHistory?: boolean }): EngineDecision {
        const persist = (): EngineDecision => {
            const history = this.records(projectId);
            const entry = input.entry ?? this.entry(projectId);
            const decision = resolveEngineDecision({
                entry,
                selection: this.selectionFor(projectId),
                defaults: this.defaults(),
                // An explicit configuration write is a new decision: the owner changed the roles,
                // so the configuration that an older Flow froze no longer describes this project.
                historical: input.ignoreHistory === true ? null : this.historical(projectId)
            });
            const last = history.at(-1);
            if (last && last.decision.entry === decision.entry && hash(last.decision) === hash(decision)) return last.decision;
            if (history.length >= MAX_DECISION_RECORDS) throw new DomainError('ENGINE_DECISION_HISTORY_LIMIT', 409);
            const body = {
                schema: ENGINE_DECISION_RECORD_SCHEMA,
                projectId,
                revision: history.length + 1,
                parentHash: last?.contentHash ?? null,
                decision,
                source: input.source,
                actor: input.actor,
                recordedAt: now()
            };
            this.store.record(ENGINE_DECISION_RECORD_KIND, projectId, null, { ...body, contentHash: hash(body) });
            return decision;
        };
        return this.store.inTransaction ? persist() : this.store.tx(persist);
    }

    view(projectId: string): EngineView {
        const decision = this.resolve(projectId);
        const selection = this.selectionFor(projectId);
        const defaults = this.defaults();
        return {
            schema: 'dm.workbench-engine.v1',
            projectId,
            entry: decision.entry,
            engine: decision.engine,
            origin: decision.origin,
            decision,
            badge: engineBadge(decision),
            billing: engineBillingPath(decision),
            roles: { selection, defaults, deviations: engineDeviations(selection, defaults) },
            revision: this.records(projectId).length
        };
    }

    /**
     * Prework / admission gate: the Flow about to dispatch must run under the engine this project
     * is decided to be. A custom Flow may not be admitted as classic and vice versa.
     */
    assertRunEngine(run: Run): EngineDecision {
        const decision = this.resolve(run.projectId);
        const frozen = run.flowConfig?.mode;
        if (frozen && frozen !== decision.engine)
            throw new DomainError('ENGINE_DECISION_MISMATCH', 409,
                '这个项目的引擎判定是 ' + decision.engine + '，但它冻结的流程是 ' + frozen + '；不会按另一种引擎派发。');
        return decision;
    }

    /** Budget/billing gate: a custom-only budget path may not run under a classic decision. */
    assertBillingPath(projectId: string, expected: EngineeringMode): EngineDecision {
        const decision = this.resolve(projectId);
        if (decision.engine !== expected)
            throw new DomainError(expected === 'custom' ? 'CUSTOM_BUDGET_REQUIRES_CUSTOM_ENGINE' : 'CLASSIC_BILLING_REQUIRES_CLASSIC_ENGINE', 409,
                '这个项目的引擎判定是 ' + decision.engine + '，与 ' + expected + ' 的预算路径不一致；不会按另一条计费路径预留。');
        return decision;
    }
}
