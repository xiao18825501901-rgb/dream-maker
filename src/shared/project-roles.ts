/**
 * Workbench wire contracts: role configuration, star answers, question explanations.
 *
 * These types are the server half of the three call points the Studio page speaks; the wire
 * contract, the routes and the error codes are written down in `docs/STUDIO_BACKEND_CONTRACTS.md`.
 * The page renders whatever the server returns; it never computes an engine decision, a freeze
 * state or a star status for itself. Everything that cannot be proven is named as an error code
 * instead of being defaulted.
 */
import type { EngineBadge, EngineBillingPath, EngineDecision, EngineDeviation, EngineRoleSet } from './engine-mode.js';

/** Role ids as the workbench shows them: the product names, never a second storage scheme. */
export type WorkbenchRole = 'seeker' | 'planner' | 'executor' | 'reviewer';
export const WORKBENCH_ROLES: readonly WorkbenchRole[] = ['seeker', 'planner', 'executor', 'reviewer'];

export interface RoleOption {
    readonly id: string;
    readonly label: string;
    /** False when the option is real but this deployment cannot dispatch it yet. */
    readonly available?: boolean;
    readonly reason?: string;
}

/** One role's saved selection. `skills` / `plugins` only ever hold server-supplied ids. */
export interface RoleSelection {
    readonly model: string;
    readonly effort: string;
    readonly harness: string;
    readonly skills: readonly string[];
    readonly plugins: readonly string[];
}

/** The only choices the page may offer, all server-supplied. */
export interface RoleChoiceSet {
    readonly models: readonly RoleOption[];
    readonly efforts: readonly RoleOption[];
    readonly harnesses: readonly RoleOption[];
}

export interface RoleCatalogEntryView {
    readonly role: WorkbenchRole;
    readonly label: string;
    readonly skills: readonly RoleOption[];
    readonly plugins: readonly RoleOption[];
    readonly choices: RoleChoiceSet;
    readonly selection: RoleSelection;
    readonly revision: number;
}

/** Wire protocols a harness can speak. Declared per model, never per request. */
export type RoleProtocol = 'chat-completions' | 'openai-responses' | 'anthropic-messages';
export const ROLE_PROTOCOLS: readonly RoleProtocol[] = ['chat-completions', 'openai-responses', 'anthropic-messages'];

export interface RoleRegistryModel {
    readonly id: string;
    /** The model's declared surface. A harness can only run a model whose surface it speaks. */
    readonly protocols: readonly RoleProtocol[];
}

/**
 * Where a build's registration lives. `PRODUCT_ROUTE` lanes are the product's own Codex / DSH /
 * Seeker routes, whose evidence is the shipped product rather than a per-run CLI digest;
 * `REVIEWED_BINARY_DIGEST` lanes are the DM-only Magpie CLI legs, whose evidence is the exact
 * reviewed digest in the `magpie-route.ts` build sets.
 */
export type RoleRegistryBuildScope = 'PRODUCT_ROUTE' | 'REVIEWED_BINARY_DIGEST';
export type RoleRegistrySource = 'PRODUCT_CONFIGURATION' | 'DESKTOP_MAGPIE_CATALOG' | 'TEST_FIXTURE';

export interface RoleRegistrySnapshot {
    readonly schema: 'dm.role-registry.v1';
    readonly source: RoleRegistrySource;
    readonly buildScope: RoleRegistryBuildScope;
    /** Exact executable digest for a reviewed binary lane; the product route identity otherwise. */
    readonly buildHash: string;
    readonly models: readonly RoleRegistryModel[];
}

/** Every error a role-configuration write can answer with. No code is silently downgraded. */
export type RoleConfigErrorCode =
    | 'ROLE_CONFIG_INPUT_INVALID'
    | 'ROLE_CONFIG_ROLE_UNKNOWN'
    | 'ROLE_CONFIG_REGISTRY_REQUIRED'
    | 'ROLE_CONFIG_HARNESS_NOT_REGISTERED_FOR_ROLE'
    | 'ROLE_CONFIG_MODEL_UNKNOWN'
    | 'ROLE_CONFIG_PROTOCOL_UNSUPPORTED'
    | 'ROLE_CONFIG_BUILD_NOT_REGISTERED'
    | 'ROLE_CONFIG_EFFORT_INVALID'
    | 'ROLE_CONFIG_SKILL_UNKNOWN'
    | 'ROLE_CONFIG_PLUGIN_UNKNOWN'
    | 'ROLE_CONFIG_REVISION_CONFLICT'
    | 'ROLE_CONFIG_HISTORY_LIMIT'
    | 'ROLE_CONFIG_FROZEN_BY_RUN'
    | 'ROLE_CONFIG_SECRET';

/** The engine judgement a write or a read returns, so the badge and the gates share one answer. */
export interface EngineReport {
    readonly decision: EngineDecision;
    readonly badge: EngineBadge;
    readonly billing: EngineBillingPath;
    readonly roles: {
        readonly selection: EngineRoleSet;
        readonly defaults: EngineRoleSet;
        readonly deviations: readonly EngineDeviation[];
    };
}

export interface RoleConfigSavedView {
    readonly role: WorkbenchRole;
    readonly revision: number;
    readonly selection: RoleSelection;
    readonly savedAt: string;
    /** Resolved wire of the accepted combination; null only for a role with no wire (Seeker HTTP). */
    readonly protocol: RoleProtocol | null;
    readonly engine: EngineReport;
}

/** Run states in which a project's configuration is in use and may not be edited. */
export const OPEN_RUN_STATES: readonly string[] = [
    'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'REPAIRING',
    'PAUSE_REQUESTED', 'PAUSED', 'CANCEL_REQUESTED'
];

/** The seven work states a star may show, exactly as the workbench renders them. */
export type StarStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'CRAFTED' | 'VERIFIED' | 'REVIEWED' | 'BLOCKED' | 'CHANGED';
export const STAR_STATUSES: readonly StarStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'CRAFTED', 'VERIFIED', 'REVIEWED', 'BLOCKED', 'CHANGED'];

/**
 * Why a star answer cannot be edited right now. The server enforces every one of them; a
 * disabled control in the page is a courtesy, never the gate.
 */
export type StarFreezeReason =
    | 'RUN_IN_PROGRESS'
    | 'RUN_PAUSED'
    | 'WORKSPACE_LEASE_HELD'
    | 'RESULT_UNKNOWN'
    | 'DELIVERY_NOT_SETTLED'
    | 'DF_WORK_IN_PROGRESS';
export const STAR_FREEZE_REASONS: readonly StarFreezeReason[] = [
    'RUN_IN_PROGRESS', 'RUN_PAUSED', 'WORKSPACE_LEASE_HELD', 'RESULT_UNKNOWN', 'DELIVERY_NOT_SETTLED', 'DF_WORK_IN_PROGRESS'
];

export interface StarHistoryEntry {
    readonly revision: number;
    readonly answer: string;
    readonly status: 'answered' | 'skipped';
    readonly at: string;
}

export interface StarAnswerView {
    readonly starId: string;
    readonly question: string;
    readonly answer: string;
    readonly answeredAt: string;
    readonly status: StarStatus;
    readonly taskId: string | null;
    readonly taskTitle: string;
    readonly revision: number;
    /** Every earlier answer of this star, newest last. */
    readonly history: readonly StarHistoryEntry[];
    readonly editable: boolean;
    readonly frozenBy: readonly StarFreezeReason[];
    readonly engine: EngineReport;
}

export interface StarEditSavedView {
    readonly starId: string;
    readonly revision: number;
    readonly answer: string;
    readonly status: StarStatus;
    readonly updatedAt: string;
    readonly engine: EngineReport;
    /** What the edit invalidated: the dependent draft, the spec pointer and the approvals. */
    readonly superseded: {
        readonly draftInvalidated: boolean;
        readonly specId: string | null;
        readonly approvalsRevoked: boolean;
    };
}

/** One turn of the explanation conversation. The context lives beside the answer, never in it. */
export interface StarExplainTurn {
    readonly role: 'user' | 'model';
    readonly text: string;
}

export interface StarExplainView {
    readonly sessionId: string;
    readonly reply: string;
    /** True when the explainer will accept no further turn for this question. */
    readonly ended: boolean;
    /** True when the owner had already answered, so this reply changed nothing. */
    readonly superseded: boolean;
    readonly turns: number;
    readonly remainingCalls: number;
}

export interface StarExplainSessionView {
    readonly sessionId: string;
    readonly starId: string;
    readonly question: string;
    readonly turns: readonly StarExplainTurn[];
    readonly answerRevision: number | null;
    readonly superseded: boolean;
    readonly ended: boolean;
    readonly at: string;
}
