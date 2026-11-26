import type { ProjectPlan } from './project-plan.js';
import type {FlowConfigSnapshot} from './flow-configuration.js';
import { ROLE_WIRE_IDS, type RoleWireId } from './role-names.js';
// One source of truth: the wire ids live in role-names.ts with their display names, so
// ROLES and ROLE_WIRE_IDS can never drift apart.
export const ROLES = ROLE_WIRE_IDS;
export type Role = RoleWireId;
export type Mode = 'demo' | 'live';
export type ProductState = 'DRAFT' | 'INTERVIEWING' | 'AWAITING_INTERVIEW_DECISION' | 'REQUIREMENTS_REVIEW' | 'SPEC_REVIEW' | 'READY_TO_BUILD';
export type RunState = 'PLANNING' | 'IMPLEMENTING' | 'VERIFYING' | 'REVIEWING' | 'REPAIRING' | 'READY_FOR_DELIVERY' | 'ACCEPTED' | 'PAUSE_REQUESTED' | 'PAUSED' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'BLOCKED' | 'FAILED' | 'PARTIAL';
export type Phase = 'PLANNING' | 'IMPLEMENTING' | 'VERIFYING' | 'REVIEWING' | 'REPAIRING' | 'READY_FOR_DELIVERY';
export interface Question {
    id: string;
    topic: string;
    text: string;
    suggestion: string;
    source: 'DEMO_RULES' | 'MODEL';
    prerequisites: string[];
    createdAt: string;
    /** Absent only on preserved legacy questions. A newly generated question has exactly four. */
    options?: { id: string; label: string }[];
    allowMultiple?: boolean;
}
export interface Answer {
    id: string;
    questionId: string;
    text: string;
    status: 'answered' | 'skipped';
    revision: number;
    createdAt: string;
    optionIds?: string[];
    customText?: string;
    source?: 'USER_FREE_TEXT' | 'USER_OPTION_SELECTION' | 'USER_MIXED' | 'USER_SKIPPED';
}
/**
 * Seeker requirement draft document. Exactly the shape the pinned prompt-optimizer body asks the
 * model for, so the deterministic compiler can reuse it without a second translation step.
 */
export interface RequirementsDraftDocument {
    summary: string;
    assumptions: string[];
    conflicts: string[];
    implementation_guidance: string[];
    acceptance_candidates: string[];
    residual_risks: string[];
}
/** One immutable version of the user-editable requirements draft. */
export interface RequirementsDraft {
    id: string;
    projectId: string;
    version: number;
    parentId: string | null;
    /** MODEL = compiled by the optimizer request; USER = an owner edit. Only USER text can be frozen. */
    origin: 'MODEL' | 'USER';
    document: RequirementsDraftDocument;
    /** Original requirement text is retained verbatim; model additions stay AI_SUGGESTION. */
    requirements: { id: string; text: string; origin: 'USER' | 'AI_SUGGESTION' }[];
    sourceAnswerIds: string[];
    /** Hash of the interview input this draft was compiled from; a changed answer makes it stale. */
    inputHash: string;
    contentHash: string;
    at: string;
    actor: string;
}
/** Seeker's reading of a reviewer's terminal verdict. Advisory only: it never accepts a run. */
export interface SeekerReviewInterpretation {
    id: string;
    runId: string;
    projectId: string;
    specId: string;
    specHash: string;
    planVersionId: string | null;
    planVersionHash: string | null;
    workspace: string;
    treeHash: string | null;
    reviewRecordId: string;
    reviewRecordHash: string;
    verdict: 'PASS' | 'CHANGES_REQUESTED' | 'BLOCKED';
    blockers: string[];
    requirementsToReconfirm: string[];
    nextSteps: string[];
    requiresNewInterview: boolean;
    /** MODEL = a real Seeker turn; DEMO_RULES = a deterministic reading, never a model request. */
    source: 'MODEL' | 'DEMO_RULES';
    /** Always false: the seeker may explain, never accept on the owner's behalf. */
    autoAccept: false;
    at: string;
}
export interface Requirement {
    id: string;
    text: string;
    sourceAnswerIds: string[];
    sourceContext?: {kind:'USER_ALTERNATIVE_CONSTRAINT';runId:string};
    origin: 'USER' | 'AI_SUGGESTION' | 'DESIGN_ASSUMPTION';
    priority: 'must' | 'should';
    kind?: 'unclassified' | 'functional' | 'nonfunctional' | 'constraint' | 'out-of-scope';
    classificationOrigin?: 'USER_CONFIRMED';
}
export interface AcceptanceItem {
    id: string;
    requirementIds: string[];
    criterion: string;
    method: 'manual';
    source: 'USER_CONFIRMED';
    evidenceStatus: 'NOT_RUN';
}
export interface Spec {
    projectPlan?: ProjectPlan;
    userNotes?: string;
    id: string;
    projectId: string;
    revision: number;
    projectVersion: number;
    hash: string;
    brief: string;
    requirements: Requirement[];
    constraints: string[];
    assumptions: string[];
    outOfScope: string[];
    acceptance: string[];
    conflicts: string[];
    notes: string;
    masterPrompt: string;
    createdAt: string;
    stale: boolean;
    skillMode: 'SOURCE_ADAPTED';
    acceptanceItems?: AcceptanceItem[];
    semanticConfirmation?: { actor: 'USER'; at: string; previousSpecHash: string };
}
export interface Project {
    id: string;
    name: string;
    idea: string;
    mode: Mode;
    /** Absent on historical DM projects. USER plans never dispatch the interview model. */
    planner1Mode?: 'USER';
    /** New ordinary Live projects require an explicit user cap; historical records stay unchanged. */
    userSpendingRequired?:true;
    alternativeContext?: {runId:string;reasonCode:string|null;decision:'USER_REQUESTED_ALTERNATIVE';userConstraint:string;source:'EXPLICIT_LOCAL_SESSION'};
    alternativeConstraints?: {runId:string;text:string;source:'USER';at:string}[];
    /** Frozen at creation for Live projects. Legacy projects without this field mean api_key. */
    planner1AuthMode?: 'api_key' | 'siwc_plan';
    /**
     * K02: full planner1 binding frozen at creation for Live projects. The fields stay
     * separate (provider / runner / authMethod / model / policyHash / protocolHash /
     * bindingVersion) so a later settings change cannot re-route an existing project
     * onto another account or billing path. Legacy projects without this field are
     * read-only history; they are never silently rebound.
     */
    planner1Binding?: {
        provider: string;
        runner: string;
        authMethod: string;
        model: string;
        policyHash: string;
        protocolHash: string;
        bindingVersion: number;
        bindingHash: string;
    };
    /**
     * Seeker: the editable requirements draft ("需求稿"). The document itself lives in the
     * RequirementsDraft record so every version stays immutable; the project keeps the pointer
     * plus whether the owner confirmed that exact version. Absent on every historical project and
     * on the OAuth route, which never ran the draft stage.
     */
    requirementsDraft?: { recordId: string; version: number; contentHash: string; confirmed: { recordId: string; hash: string; at: string; actor: string } | null };
    version: number;
    state: ProductState;
    createdAt: string;
    updatedAt: string;
    questions: Question[];
    answers: Answer[];
    answerHistory: Answer[];
    batchTarget: number;
    interviewMode?: 'INITIAL' | 'ALTERNATIVE';
    batchSize?: 10 | 5;
    publicResearch?: { scope: 'PUBLIC_GENERIC_TERMS_ONLY'; actor: string; grantedAt: string };
    specId: string | null;
    activeRunId: string | null;
    warnings: string[];
}
export interface PlanVersion {
    id: string;
    projectId: string;
    revision: number;
    parentId: string | null;
    specHash: string;
    contentHash: string;
    origin: 'LEGACY_IMPORTED' | 'COMPILED_SPEC' | 'COMPLETE_PLAN';
    snapshot: Spec;
    source: { provenance: 'EXISTING_SPEC_BYTES' | 'CURRENT_PROJECT_INPUT'; idea?: string; name?: string; mode?:Mode; planner1Mode?:Project['planner1Mode']; userSpendingRequired?:true; questions?: Question[]; answers?: Answer[]; answerHistory?: Answer[];publicResearch?:Project['publicResearch']|null;planner1Binding?:Project['planner1Binding']|null;planner1AuthMode?:Project['planner1AuthMode']|null;alternativeContext?:Project['alternativeContext'];alternativeConstraints?:Project['alternativeConstraints'] };
    createdAt: string;
    approval: { actor: string; at: string } | null;
}
export interface Task {
    id: string;
    title: string;
    dependsOn: string[];
    requirementIds: string[];
    acceptance: string[];
    /** Exact source files or directory prefixes ending in '/'; absent on historical plans. */
    writePaths?: string[];
    /** Scheduler-satisfied work from a real parent run, never a new model completion. */
    inheritedFrom?: {runId:string;taskId:string};
    status: 'pending' | 'running' | 'implemented' | 'done';
}
export interface Finding {
    id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    evidence: string;
    status: 'open' | 'resolved';
}
export interface Run {
    /** Controller-owned append-only P2 handoff; absent on historical runs. */
    prework?: {recordId:string;contractId:string;digest:string};
    id: string;
    projectId: string;
    mode: Mode;
    version: number;
    specId: string;
    specHash: string;
    planVersionId?: string;
    planVersionHash?: string;
    /** Absent on historical Flows; never infer or rewrite their role provenance. */
    rolePolicy?: RolePolicy;
    roleIdentities?: Partial<Record<Role, ExecutionIdentity & { sessionId: string; requestId: string }>>;
    /** Custom Executor completions are per worker/turn; the singular executor entry is compatibility only. */
    executorRoleIdentities?: ExecutorRoleIdentity[];
    flowConclusion?: {recordId:string;sha256:string;at:string};
      /** Explicit bounded owner time approval; original createdAt/maxSeconds stay unchanged. */
      reviewWindow?: {recordId:string;sha256:string};
      reviewOnlyWindow?: {recordId:string;sha256:string};
    /** Owner disabled only the run's overall task deadline; counters and technical timeouts stay immutable. */
    taskDeadlineWaiver?: {recordId:string;sha256:string};
    /** Explicit additive Custom budget approval; frozen flowConfig and all old costs are retained. */
    customBudgetSupplement?: {recordId:string;sha256:string};
    /** A separately approved single evidence-only review; original call limits stay immutable. */
    reviewSupplement?: {recordId:string;sha256:string};
    /** Explicit bounded documentation successor; old model/counter evidence stays on the parent. */
    documentationContinuation?: {recordId:string;sha256:string};
    /** One audited extension of a consumed successor call budget; the original approval stays frozen. */
    documentationContinuationExtension?: {recordId:string;sha256:string};
    /** One exact verifier-failure recovery for a bounded code successor. */
    boundedCodeVerificationRecovery?: {recordId:string;sha256:string};
    /** One exact recovery when the reviewer account gate fired before any turn. */
    boundedCodeReviewRecovery?: {recordId:string;sha256:string};
    /** Zero-model recovery after a repair's tools settled but the final transport turn failed. */
    interruptedRepairVerification?: {recordId:string;sha256:string};
    pendingLeaseRelease?:boolean;
    /** Explicit execution choice; historical rows stay unbound rather than being relabeled. */
    flowName?:'classic'|'custom'|'dreamflow'|'dreamflow-laya';
    flowConfig?:FlowConfigSnapshot;
    flowConfigHash?:string;
    configFingerprint: string;
    state: RunState;
    phase: Phase;
    repairCount: number;
    maxRepairs: number;
    calls: number;
    maxCalls: number;
    createdAt: string;
    updatedAt: string;
    workspace: string;
    treeHash: string | null;
    tasks: Task[];
    findings: Finding[];
    plan: unknown;
    verification: Verification | null;
    review: Review | null;
    artifacts: string[];
    reason: string | null;
    failedFingerprints: string[];
    attempt: number;
    demoFault: boolean;
    maxSeconds: number;
    usage: Usage[];
    sessions: Record<string, string>;
}
export interface Usage {
    role: Role;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    source: 'PROVIDER' | 'UNKNOWN' | 'DEMO_NO_CLOUD';
    requestId: string;
    /**
     * Which planner1 (Seeker) request this charge belongs to: the grillme question, the
     * prompt-optimizer requirements draft, the complete plan, or the reviewer hand-back. Absent on
     * historical ledgers; those are never relabelled.
     */
    purpose?: string;
    /** Exactly which pinned skill body the request actually carried, with its registry hash. */
    skills?: { id: string; sha256: string; purpose: string }[];
}
export interface Verification {
    ok: boolean;
    exitCode: number | null;
    command: string[];
    stdout: string;
    stderr: string;
    treeHash: string;
    at: string;
    evidenceId: string;
}
export interface Review {
    verdict: 'PASS' | 'CHANGES_REQUESTED' | 'BLOCKED';
    findings: Finding[];
    source: 'DEMO_RULES' | 'CODEX' | 'DSH' | 'INDEPENDENT_API' | 'KIMI_SERVER' | 'CLAUDE_CODE' | 'OPENCODE_CLI' | 'CLINE_CLI';
    treeHash: string;
}
export interface Event {
    id: number;
    projectId: string | null;
    runId: string | null;
    type: string;
    payload: unknown;
    at: string;
}
export type LayaMode = 'off' | 'shadow' | 'advisory';
export interface LayaConfig {
    mode: LayaMode;
    roles: Record<Role, 'inherit' | 'off'>;
    baseUrl: string;
    portFile: string;
    timeoutMs: number;
    maxQueue: number;
    expectedRevision: string;
    requireTruncationMetadata: boolean;
}
export interface Config {
    version: 1;
    planner1: {
        protocol: 'openai-responses' | 'chat-completions';
        authMode: 'api_key' | 'siwc_plan';
        siwcModel: string;
        siwcProfileId: string;
        siwcNoncommercialAttested: boolean;
        baseUrl: string;
        model: string;
        keyEnv: string;
        maxOutputTokens: number;
        maxCallsPerProject: number;
        /**
         * K02: explicit upstream identity. When absent it is derived from the legacy
         * protocol/authMode/baseUrl fields, which always yields a RETIRED provider;
         * explicit v2 API, or a v3 fixed-loopback local Ollama binding. See
         * src/server/planner1-binding.ts.
         */
        provider?: 'kimi' | 'openai' | 'deepseek' | 'local' | 'siwc' | 'magpie';
        /** Account reference required before a real Kimi dispatch; empty = unbound. */
        accountRef?: string;
        /** Hash of the frozen runner policy (zero-tool agent profile and friends). */
        policyHash?: string;
        /** Hash of the frozen server protocol contract. */
        protocolHash?: string;
        /** Binding schema version, used by migration. */
        bindingVersion?: number;
    };
    codex: {
        command: string;
        args: string[];
        home: string;
        model: string;
        /**
         * K07: named permission profile bound on thread/start and turn/start. The legacy
         * `sandbox`/`sandboxPolicy` fields are never sent, so a named profile cannot be
         * overridden by a legacy parameter that the server would silently prefer.
         */
        permissionProfile?: string;
        /** Policy TOML whose bytes are hashed and reported with every Codex admission. */
        policyFile?: string;
        /** K07-B: 'stdio' (default, Windows) or 'wsl' (dedicated Linux CLI inside WSL). */
        transport?: 'stdio' | 'wsl';
        /** wsl.exe override, for the offline fake-transport test only. */
        wslCommand?: string;
        wslDistro?: string;
        /** Absolute POSIX path inside the distro used as the working directory. */
        wslCwdRoot?: string;
        /** Absolute POSIX path of the fixed Linux CLI. */
        wslBinary?: string;
        /** Isolated Linux CODEX_HOME (absolute POSIX path). */
        wslHome?: string;
    };
    dsh: {
        modulePath: string;
        model: string;
        keyEnv: string;
    };
    /**
     * Pi Agent CLI as a Custom-only executor harness. Disabled unless `cliPath` is an
     * absolute existing file; the runner refuses rather than falling back to DSH.
     * Its built-in shell/file tools stay disabled; only the DM tool broker is exposed.
     */
    pi?: {
        cliPath: string;
        timeoutMs?: number;
    };
    /** K03: loopback-only Kimi Code server driven by KimiRunner. */
    kimi?: {
        baseUrl: string;
        timeoutMs: number;
        pollMs: number;
        /** Absolute path of the isolated home's server.token (0600). Empty = runner unavailable. */
        tokenFile?: string;
        /** Route Kimi as the planner1 runner. Defaults to false so nothing changes by accident. */
        enabled?: boolean;
        /**
         * Linux-side workspace the Kimi server can see. Dream Maker runs on Windows while the
         * server runs inside WSL, so a Windows path cannot be used as the session cwd (observed:
         * 40409 "workspace root ... does not exist").
         */
        workspace?: string;
    };
    /**
     * A second, INDEPENDENT model provider used for planner2/reviewer: an OpenAI-compatible
     * /chat/completions endpoint reached through the same trusted transport as everything else.
     *
     * Why this exists: the two Codex roles are bound to a subscription CLI whose egress is refused
     * in this region, so the pair can never produce a real turn here. This section lets the product
     * itself drive those two roles against a different, separately billed provider, while keeping
     * their independence (different vendor from planner1's Kimi and from the executor's DeepSeek) and
     * keeping one session per role.
     *
     * Disabled by default. When enabled without a credential the runner REFUSES; it never falls back
     * to Codex, because a silent fallback would make the recorded provider a lie.
     */
    independent?: {
        enabled: boolean;
        /** OpenAI-compatible base, e.g. https://api.openai.com/v1 (no trailing path). */
        baseUrl: string;
        /**
         * '' means "infer from the host": api.openai.com speaks the Responses API, everything else the
         * classic chat-completions shape. It is explicit in the config because the two shapes have
         * different paths, different bodies and different usage field names.
         */
        protocol?: '' | 'openai-responses' | 'chat-completions';
        model: string;
        /** Name of the environment variable holding the key. The value never enters the config. */
        keyEnv: string;
        maxOutputTokens: number;
        /**
         * Hard per-process ceiling. The owner's uncapped authorization (HA-005) covers official
         * DeepSeek only, so this provider is always capped and always ledgered on its own terms.
         */
        maxRequests: number;
    };
    nativeAuditPath: string;
    clash: {
        enabled: boolean;
        configPath: string;
        selector: string;
        node: string;
          selectionPolicy: 'pinned' | 'current';
        expectedMode: 'rule' | 'global';
    };
    laya: LayaConfig;
    limits: {
        maxRepairs: number;
        maxCalls: number;
        maxSeconds: number;
        stepTimeoutMs: number;
        idleTimeoutMs: number;
    };
}
export interface LayaDecision {
    /** Controller-owned invocation binding; absent on historical records. Not model proof. */
    invocation?:{dispatchId:string;generation:string;taskId:string|null;sourceHash:string};
    role: Role;
    mode: LayaMode;
    adoption: 'off' | 'shadow' | 'advisory' | 'abstained' | 'fallback';
    label: string | null;
    reason: string;
    latencyMs: number;
    inputHash: string;
    modelRevision: string | null;
    confidence: number | null;
    cached: boolean;
    support?:{schema:'dream-maker.role-assistance.v1';runId:string;specHash:string;taskId:string|null;taskDataHash:string;sourceHash:string|null;authority:'ADVISORY_ONLY';coverage:'TASK_AND_BOUNDED_SOURCE_CONTEXT_NOT_FULL_REVIEW';guide:string|null};
}
export interface AgentInput {
    role: Role;
    workspace: string;
    prompt: string;
    model: string;
    specHash: string;
    runId: string;
    /** Controller-created assignment identity; never accepted as a path/permission from a model. */
    executorSliceId?: string;
    /** Original controller's frozen executor assignment; never selected by model HTTP data. */
    executorRoleId?:string;
    /** Original Engine task identity. It does not come from the model HTTP body. */
    taskId?:string;
    /** Repair rounds originate from the Engine's counted repair transition, not a model task. */
    repairRound?:number;
    laya: LayaDecision;
    signal: AbortSignal;
    outputSchema?: Record<string, unknown>;
}
export interface AgentOutput {
    text: string;
    sessionId: string;
    usage: Usage;
    /**
     * The model that actually produced this answer, as reported by the provider. It is recorded as evidence
     * of which vendor served the role, so it must not be inferred from configuration: the engine wrote
     * config.codex.model for every non-executor role, which recorded 'gpt-5.1-codex' for planner2/reviewer
     * turns that were really answered by deepseek-flash (run_ab915f0a570dd1c82964).
     */
    model?: string;
    identity?: ExecutionIdentity;
}
export type RolePolicy = 'CODEX_DSH_V1' | 'LEGACY_CONFIGURED_V1' | 'CUSTOM_FROZEN_V1';
export interface ExecutionIdentity {
    runner: 'CODEX_CLI' | 'DSH' | 'INDEPENDENT_API' | 'KIMI_SERVER' | 'CLAUDE_CODE' | 'PI_CLI' | 'OPENCODE_CLI' | 'CLINE_CLI';
    provider: string;
    authentication: 'CHATGPT_SUBSCRIPTION' | 'API_KEY' | 'MEMBER_SUBSCRIPTION';
    model: string;
    /** Adapter-owned Custom attribution. Historical/Classic identities are not backfilled. */
    runtime?:string;roleId?:string;authRef?:string;accountRef?:string;
    configurationHash?:string;routeHash?:string;
}
export interface ExecutorRoleIdentity extends ExecutionIdentity {
    sessionId:string;
    requestId:string;
    executorRoleId:string;
    taskId?:string;
    sliceId?:string;
    dispatchId:string;
    generation:string;
}
export interface Runner {
    run(input: AgentInput, onEvent: (event: unknown) => void): Promise<AgentOutput>;
}
