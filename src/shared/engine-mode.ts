/**
 * DM / DF entries and the classic/custom engine decision.
 *
 * The product has two entries (DM = Dream Maker, DF = DreamFlow) inside one application.
 * Each entry keeps its own project list, and each project is either `classic` (the shipped
 * route, with Laya attached) or `custom` (the DM-only Magpie route, with per-project role
 * configuration and Prework).
 *
 * The decision is derived in exactly one place (`src/server/engine-mode.ts`) from exactly one
 * input: the project's role configuration compared with the product defaults, or — for a
 * project that already ran — the configuration the project actually ran under. Every other
 * reader (DB readback, API payload, badge, Prework gate, budget path) reads that result; none
 * of them re-derives the rule.
 *
 * Conservative rule, stated once and applied everywhere: any role field that differs from its
 * product default — including reasoning strength ("effort") alone — makes the project `custom`.
 * The owner's wording is "用户改了非默认配置即 custom", and this file is that sentence.
 */
import type { EngineeringMode } from './flow-configuration.js';

/** The two product entries. Each one lists only its own projects. */
export type EngineEntry = 'DM' | 'DF';
export const ENGINE_ENTRIES: readonly EngineEntry[] = ['DM', 'DF'];

/**
 * Role ids are the frozen wire ids (`src/shared/role-names.ts`); the workbench shows their
 * product names (seeker / planner / executor / reviewer) and never a second id scheme.
 */
export type EngineRole = 'planner1' | 'planner2' | 'executor' | 'reviewer';
export const ENGINE_ROLES: readonly EngineRole[] = ['planner1', 'planner2', 'executor', 'reviewer'];
/** The three roles that execute a Flow. The planner1 (Seeker) role asks the questions. */
export type EngineExecutionRole = Exclude<EngineRole, 'planner1'>;
export const ENGINE_EXECUTION_ROLES: readonly EngineExecutionRole[] = ['planner2', 'executor', 'reviewer'];

/** The three configurable fields of one role. */
export type EngineField = 'harness' | 'model' | 'reasoning';
export const ENGINE_FIELDS: readonly EngineField[] = ['harness', 'model', 'reasoning'];

/** Reasoning strength ids the server offers; `default` is the product default for every role. */
export const ENGINE_REASONING_IDS = ['default', 'low', 'medium', 'high'] as const;
export type EngineReasoning = (typeof ENGINE_REASONING_IDS)[number];
export const ENGINE_DEFAULT_REASONING: EngineReasoning = 'default';

/** One role's effective selection. The defaults always carry a value; empty is not "unset". */
export interface EngineRoleSelection {
    readonly harness: string;
    readonly model: string;
    readonly reasoning: string;
}
export type EngineRoleSet = Readonly<Record<EngineRole, EngineRoleSelection>>;

export type EngineDeviationCode =
    | 'HARNESS_DEVIATES_FROM_DEFAULT'
    | 'MODEL_DEVIATES_FROM_DEFAULT'
    | 'REASONING_DEVIATES_FROM_DEFAULT';

/** Exactly which role and field moved away from the product default. */
export interface EngineDeviation {
    readonly role: EngineRole;
    readonly field: EngineField;
    readonly code: EngineDeviationCode;
    /** The value the project asks for. */
    readonly configured: string;
    /** The product default it replaced. */
    readonly fallback: string;
}

/**
 * Where the answer came from. `RECORDED` is an already-persisted decision, i.e. the Store is the
 * truth; `HISTORICAL_FROZEN` is a project that already ran, judged by the configuration it ran
 * under, so a later change of the defaults can never re-flag an old ACCEPTED project.
 */
export type EngineDecisionOrigin = 'PRODUCT_DEFAULT' | 'USER_OVERRIDE' | 'HISTORICAL_FROZEN' | 'RECORDED';

export interface EngineDecision {
    readonly schema: 'dm.engine-decision.v1';
    readonly engine: EngineeringMode;
    readonly origin: EngineDecisionOrigin;
    readonly entry: EngineEntry;
    readonly reasons: readonly EngineDeviation[];
    /** Digest of the effective role selection the decision was taken from. */
    readonly selectionHash: string;
    /** Digest of the product defaults that selection was compared with. */
    readonly defaultsHash: string;
    /** Set only for `HISTORICAL_FROZEN`: the Flow whose frozen configuration decided it. */
    readonly historicalRunId: string | null;
}
export const ENGINE_DECISION_SCHEMA = 'dm.engine-decision.v1' as const;

/** The one badge shape the workbench renders. It reports the decision; it never re-decides. */
export interface EngineBadge {
    readonly engine: EngineeringMode;
    readonly label: string;
    readonly laya: 'ON' | 'OFF';
    readonly magpie: 'DM_ONLY' | 'NOT_APPLICABLE';
    readonly prework: 'REQUIRED';
}

/** Which budget and billing path the engine decision selects. One reader, one answer. */
export interface EngineBillingPath {
    readonly engine: EngineeringMode;
    readonly layer: 'classic-laya' | 'custom-magpie';
    readonly payee: 'LAYA_SUBSCRIPTION_ROUTE' | 'MAGPIE_CUSTOM_ROUTE';
    readonly budgetSource: 'CLASSIC_RUN_LIMITS' | 'CUSTOM_FLOW_BUDGET';
}
