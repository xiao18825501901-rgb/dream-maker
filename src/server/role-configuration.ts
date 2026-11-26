/**
 * Per-project role configuration: the write contract behind the workbench's role editor.
 *
 * A write names one role and its model / harness / reasoning effort. The server answers in three
 * ways only: the combination is legal and stored (with the new engine decision), the caller's
 * revision is stale, or the combination is refused under its own named code. There is no silent
 * fallback to a default model, harness or effort anywhere in this file.
 *
 * Legality is decided against two registries the product already owns:
 *   - the protocol matrix in `shared/custom-magpie-protocol.ts` (which harness speaks which wire
 *     for which role), and
 *   - the reviewed build sets in `server/magpie-route.ts` (which exact executable may run it).
 * A digest-scoped lane must pass `supportsBuild(registry.buildHash)`; a product-route lane must
 * declare one of the wires the product route itself speaks.
 */
import type { Config } from '../shared/types.js';
import type { WorkbenchRole, RoleCatalogEntryView, RoleChoiceSet, RoleConfigSavedView, RoleOption, RoleProtocol, RoleRegistryModel, RoleRegistrySnapshot, RoleSelection } from '../shared/project-roles.js';
import { ROLE_PROTOCOLS, WORKBENCH_ROLES, OPEN_RUN_STATES } from '../shared/project-roles.js';
import { ENGINE_ROLES, ENGINE_REASONING_IDS, type EngineRole, type EngineRoleSet } from '../shared/engine-mode.js';
import { acceptsAlias, roleIconId, roleZhLabel } from '../shared/role-names.js';
import { customMagpieProtocol } from '../shared/custom-magpie-protocol.js';
import { additionalMagpieRoute } from './magpie-route.js';
import { BUILT_IN_SKILLS, skillsForRole } from './skills.js';
import { extensionCatalog } from './extensions.js';
import { DomainError, hash, integer, now, object, hasSecret } from './security.js';
import type { Store } from './store.js';
import { EngineModes, type EngineView } from './engine-mode.js';
import type { EngineReport } from '../shared/project-roles.js';

export const ROLE_CONFIGURATION_RECORD_KIND = 'ProjectRoleConfiguration';
export const ROLE_CONFIGURATION_SCHEMA = 'dm.project-role-configuration.v1';
const MAX_ROLE_REVISIONS = 64;

const HARNESS_LABELS: Readonly<Record<string, string>> = Object.freeze({
    'codex-app-server': 'Codex App Server',
    codex: 'Codex CLI',
    dsh: 'DSH',
    claude: 'Claude Code',
    opencode: 'OpenCode',
    cline: 'Cline',
    pi: 'Pi',
    independent: 'Independent API',
    'kimi-server': 'Kimi 本地服务',
    'http-api': '官方 HTTP API',
    'local-http': '本机 Ollama',
    'siwc-sdk': 'SIWC SDK'
});

/** Harnesses the product registers for each role. A harness outside this table is refused. */
export const ROLE_HARNESSES: Readonly<Record<EngineRole, readonly string[]>> = Object.freeze({
    planner1: Object.freeze(['kimi-server', 'http-api', 'local-http', 'siwc-sdk']),
    planner2: Object.freeze(['codex-app-server', 'codex', 'dsh', 'claude', 'opencode', 'cline', 'pi', 'independent']),
    executor: Object.freeze(['dsh', 'pi', 'claude', 'opencode', 'cline', 'codex']),
    reviewer: Object.freeze(['codex-app-server', 'codex', 'dsh', 'claude', 'opencode', 'cline', 'pi', 'independent'])
});

/** The wires a product-route lane speaks without a per-build digest. */
const PRODUCT_ROUTE_WIRES: Readonly<Record<string, readonly RoleProtocol[]>> = Object.freeze({
    'codex-app-server': Object.freeze(['openai-responses'] as RoleProtocol[]),
    dsh: Object.freeze(['anthropic-messages', 'chat-completions'] as RoleProtocol[]),
    'kimi-server': Object.freeze(['openai-responses', 'chat-completions'] as RoleProtocol[]),
    'http-api': Object.freeze(['openai-responses', 'chat-completions'] as RoleProtocol[]),
    'local-http': Object.freeze(['openai-responses', 'chat-completions'] as RoleProtocol[]),
    'siwc-sdk': Object.freeze(['openai-responses'] as RoleProtocol[])
});

const EFFORT_LABELS: Readonly<Record<string, string>> = Object.freeze({ default: '默认', low: '低', medium: '中', high: '高' });
const SKILL_OPTIONS_BY_ROLE: Readonly<Record<WorkbenchRole, readonly RoleOption[]>> = Object.freeze({
    seeker: Object.freeze(skillsForRole('seeker').map(id => Object.freeze({ id, label: id }))),
    planner: Object.freeze(skillsForRole('planner').map(id => Object.freeze({ id, label: id }))),
    executor: Object.freeze(skillsForRole('executor').map(id => Object.freeze({ id, label: id }))),
    reviewer: Object.freeze(skillsForRole('reviewer').map(id => Object.freeze({ id, label: id })))
});
const EFFORT_OPTIONS: readonly RoleOption[] = Object.freeze(ENGINE_REASONING_IDS.map(id => Object.freeze({ id, label: EFFORT_LABELS[id] ?? id })));

const WORKBENCH_TO_WIRE: Readonly<Record<WorkbenchRole, EngineRole>> = Object.freeze({
    seeker: 'planner1' as EngineRole,
    planner: 'planner2' as EngineRole,
    executor: 'executor' as EngineRole,
    reviewer: 'reviewer' as EngineRole
});

const DIGEST = /^[a-f0-9]{64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const text = (input: unknown, max: number): string => {
    if (typeof input !== 'string') throw new DomainError('ROLE_CONFIG_INPUT_INVALID', 400, '角色配置的字段必须是字符串。');
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > max || trimmed.includes('\0') || hasSecret(trimmed))
        throw new DomainError('ROLE_CONFIG_INPUT_INVALID', 400, '角色配置的字段为空、过长或包含凭据样式的内容。');
    return trimmed;
};

/** Inbound role spelling ("seeker" / "planner" / "planner2" / "评审" …) to the workbench id. */
export function workbenchRole(input: unknown): { wire: EngineRole; role: WorkbenchRole } {
    const wire = acceptsAlias(input);
    if (!wire || !(ENGINE_ROLES as readonly string[]).includes(wire))
        throw new DomainError('ROLE_CONFIG_ROLE_UNKNOWN', 400, '未知的角色名；不会把它当作任何已有角色。');
    const role = roleIconId(wire);
    if (!role) throw new DomainError('ROLE_CONFIG_ROLE_UNKNOWN', 400, '未知的角色名；不会把它当作任何已有角色。');
    return { wire: wire as EngineRole, role: role as WorkbenchRole };
}

/** The product-route registry: the lanes this product ships, with the wires each one speaks. */
export function configurationRoleRegistry(config: Config): RoleRegistrySnapshot {
    const models: RoleRegistryModel[] = [];
    const add = (id: string, protocols: readonly RoleProtocol[]): void => {
        if (!id || models.some(existing => existing.id === id)) return;
        models.push(Object.freeze({ id, protocols: Object.freeze([...protocols]) }));
    };
    if (config.codex.model) add(config.codex.model, ['openai-responses']);
    if (config.dsh.model) add(config.dsh.model, ['anthropic-messages', 'chat-completions']);
    if (config.planner1.model) add(config.planner1.model, [config.planner1.protocol === 'chat-completions' ? 'chat-completions' : 'openai-responses']);
    if (config.independent?.enabled && config.independent.model)
        add(config.independent.model, [config.independent.protocol === 'chat-completions' ? 'chat-completions' : 'openai-responses']);
    return Object.freeze({
        schema: 'dm.role-registry.v1' as const,
        source: 'PRODUCT_CONFIGURATION' as const,
        buildScope: 'PRODUCT_ROUTE' as const,
        buildHash: hash({ codex: config.codex.model, dsh: config.dsh.model, planner1: config.planner1.model, independent: config.independent?.model ?? '' }),
        models: Object.freeze(models)
    });
}

/** The DM-only Magpie registry: models and their declared surface come from the desktop catalog. */
export function magpieRoleRegistry(catalog: { models: readonly { id: string; protocols: readonly RoleProtocol[] }[] }, buildHash: string): RoleRegistrySnapshot {
    if (!DIGEST.test(buildHash)) throw new DomainError('ROLE_CONFIG_REGISTRY_REQUIRED', 409, 'Magpie 构建摘要无效；不会用它校验构建集。');
    return Object.freeze({
        schema: 'dm.role-registry.v1' as const,
        source: 'DESKTOP_MAGPIE_CATALOG' as const,
        buildScope: 'REVIEWED_BINARY_DIGEST' as const,
        buildHash,
        models: Object.freeze(catalog.models.map(model => Object.freeze({ id: model.id, protocols: Object.freeze([...model.protocols]) })))
    });
}

/** Strict readback of an injected registry; a fixture cannot smuggle an unknown shape in. */
export function readRoleRegistry(raw: unknown): RoleRegistrySnapshot {
    const fail = (): never => { throw new DomainError('ROLE_CONFIG_REGISTRY_REQUIRED', 409); };
    try {
        const value = object(raw);
        const keys = ['schema', 'source', 'buildScope', 'buildHash', 'models'];
        if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
        if (value.schema !== 'dm.role-registry.v1') return fail();
        if (!['PRODUCT_CONFIGURATION', 'DESKTOP_MAGPIE_CATALOG', 'TEST_FIXTURE'].includes(String(value.source))) return fail();
        if (!['PRODUCT_ROUTE', 'REVIEWED_BINARY_DIGEST'].includes(String(value.buildScope))) return fail();
        if (typeof value.buildHash !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value.buildHash)) return fail();
        if (!Array.isArray(value.models) || value.models.length > 256) return fail();
        const models: RoleRegistryModel[] = [];
        for (const row of value.models) {
            const model = object(row);
            const modelKeys = ['id', 'protocols'];
            if (Reflect.ownKeys(model).length !== modelKeys.length || modelKeys.some(key => !Object.hasOwn(model, key))) return fail();
            if (typeof model.id !== 'string' || !REF.test(model.id)) return fail();
            if (!Array.isArray(model.protocols) || model.protocols.length > ROLE_PROTOCOLS.length) return fail();
            const protocols: RoleProtocol[] = [];
            for (const protocol of model.protocols) {
                if (!(ROLE_PROTOCOLS as readonly string[]).includes(String(protocol))) return fail();
                if (!protocols.includes(protocol as RoleProtocol)) protocols.push(protocol as RoleProtocol);
            }
            models.push(Object.freeze({ id: model.id, protocols: Object.freeze(protocols) }));
        }
        return Object.freeze({
            schema: 'dm.role-registry.v1' as const,
            source: value.source as RoleRegistrySnapshot['source'],
            buildScope: value.buildScope as RoleRegistrySnapshot['buildScope'],
            buildHash: value.buildHash,
            models: Object.freeze(models)
        });
    } catch (error) {
        if (error instanceof DomainError && error.code === 'ROLE_CONFIG_REGISTRY_REQUIRED') throw error;
        return fail();
    }
}

export interface RoleCombination {
    readonly role: EngineRole;
    readonly harness: string;
    readonly model: string;
    readonly effort: string;
    readonly registry: RoleRegistrySnapshot;
}

/**
 * One combination, decided once. Returns the resolved wire, or throws the named code:
 *   ROLE_CONFIG_HARNESS_NOT_REGISTERED_FOR_ROLE  — this harness cannot work this role
 *   ROLE_CONFIG_MODEL_UNKNOWN                    — the model is not in the registered catalog
 *   ROLE_CONFIG_PROTOCOL_UNSUPPORTED             — the model declares no wire this harness speaks
 *   ROLE_CONFIG_BUILD_NOT_REGISTERED             — a Magpie lane whose exact build is not reviewed
 *   ROLE_CONFIG_EFFORT_INVALID                   — reasoning strength outside the served set
 */
export function validateRoleCombination(input: RoleCombination): RoleProtocol | null {
    if (!(ENGINE_REASONING_IDS as readonly string[]).includes(input.effort))
        throw new DomainError('ROLE_CONFIG_EFFORT_INVALID', 400, '推理强度不在服务端提供的选项内；不会回落到默认强度。');
    const registered = ROLE_HARNESSES[input.role];
    if (!registered.includes(input.harness))
        throw new DomainError('ROLE_CONFIG_HARNESS_NOT_REGISTERED_FOR_ROLE', 400, input.harness + ' 不能担任 ' + input.role + '；不会换成另一种 harness。');
    // The product default carries a bare id (`deepseek-flash`) while the catalog registers the
    // provider-qualified one (`deepseek/deepseek-flash`). Accept either spelling so a project can be
    // written back to its default selection — without that, classic is a one-way door.
    const bare = (id: string): string => String(id).split('/').pop() ?? String(id);
    const model = input.registry.models.find(candidate => candidate.id === input.model)
        ?? input.registry.models.find(candidate => bare(candidate.id) === bare(input.model));
    if (!model)
        throw new DomainError('ROLE_CONFIG_MODEL_UNKNOWN', 400, input.model + ' 不在本机已登记的模型目录里；不会用默认模型代替。');
    if (!model.protocols.length)
        throw new DomainError('ROLE_CONFIG_PROTOCOL_UNSUPPORTED', 400, input.model + ' 没有声明任何协议面；无法为它选线。');
    const productWires = PRODUCT_ROUTE_WIRES[input.harness];
    if (productWires) {
        const own = productWires.find(wire => model.protocols.includes(wire));
        if (own) return own;
        if (input.registry.buildScope === 'PRODUCT_ROUTE')
            throw new DomainError('ROLE_CONFIG_PROTOCOL_UNSUPPORTED', 400, '模型 ' + input.model + ' 声明的协议面（' + model.protocols.join('/') + '）与 ' + input.harness + ' 能说的线路（' + productWires.join('/') + '）没有交集；不会换成别的线路。');
    }
    if (input.registry.buildScope === 'PRODUCT_ROUTE') {
        const wires = PRODUCT_ROUTE_WIRES[input.harness];
        if (!wires) throw new DomainError('ROLE_CONFIG_HARNESS_NOT_REGISTERED_FOR_ROLE', 400, input.harness + ' 不是产品自有线路，需要已登记构建集。');
        const resolved = wires.find(wire => model.protocols.includes(wire));
        if (!resolved)
            throw new DomainError('ROLE_CONFIG_PROTOCOL_UNSUPPORTED', 400, '模型 ' + input.model + ' 声明的协议面（' + model.protocols.join('/') + '）与 ' + input.harness + ' 能说的线路（' + wires.join('/') + '）没有交集。');
        return resolved;
    }
    if (input.role === 'planner1')
        throw new DomainError('ROLE_CONFIG_HARNESS_NOT_REGISTERED_FOR_ROLE', 400, 'Magpie 线路不承载 Seeker 角色。');
    const resolved = customMagpieProtocol(input.role, input.harness, model.protocols);
    if (!resolved)
        throw new DomainError('ROLE_CONFIG_PROTOCOL_UNSUPPORTED', 400, '模型 ' + input.model + ' 声明的协议面（' + model.protocols.join('/') + '）在 ' + input.harness + ' 上不承载 ' + input.role + '。');
    const capabilities = input.registry.models.flatMap(entry => entry.protocols.map(protocol => ({ model: entry.id, protocol })));
    const route = additionalMagpieRoute(input.role, { runtime: input.harness, authentication: 'api_key', protocol: resolved, model: input.model }, capabilities);
    if (!route)
        throw new DomainError('ROLE_CONFIG_PROTOCOL_UNSUPPORTED', 400, '没有为 ' + input.harness + ' / ' + input.model + ' 解析出任何已审核线路。');
    if (!route.supportsBuild(input.registry.buildHash))
        throw new DomainError('ROLE_CONFIG_BUILD_NOT_REGISTERED', 409, '这一组合需要构建 ' + input.harness + ' 的已审核摘要，当前摘要不在登记集内；不会按未审核构建派发。');
    // `additionalMagpieRoute` types its protocol as the widened wire name; it comes from the same
    // three-value table this module validates against, so this is a narrowing, not a coercion.
    return route.protocol as RoleProtocol;
}

export interface RoleConfigurationRevision {
    readonly schema: typeof ROLE_CONFIGURATION_SCHEMA;
    readonly projectId: string;
    readonly revision: number;
    readonly parentHash: string | null;
    readonly roles: Readonly<Record<EngineRole, RoleSelection>>;
    readonly updatedAt: string;
    readonly updatedBy: string;
    readonly operationHash: string;
    readonly contentHash: string;
}

const EMPTY_SELECTION = (): RoleSelection => Object.freeze({ model: '', effort: '', harness: '', skills: Object.freeze([]) as readonly string[], plugins: Object.freeze([]) as readonly string[] });

function readRevision(raw: unknown, projectId: string, expected: number, parentHash: string | null): RoleConfigurationRevision {
    const fail = (): never => { throw new DomainError('ROLE_CONFIG_INTEGRITY_FAILED', 409); };
    try {
        const value = object(raw);
        const keys = ['schema', 'projectId', 'revision', 'parentHash', 'roles', 'updatedAt', 'updatedBy', 'operationHash', 'contentHash'];
        if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
        if (value.schema !== ROLE_CONFIGURATION_SCHEMA || value.projectId !== projectId) return fail();
        if (Number(value.revision) !== expected || value.parentHash !== parentHash) return fail();
        if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return fail();
        if (typeof value.updatedBy !== 'string' || !/^local-session:[a-f0-9]{64}$/.test(value.updatedBy)) return fail();
        if (typeof value.operationHash !== 'string' || !DIGEST.test(value.operationHash)) return fail();
        const roles = object(value.roles);
        if (Reflect.ownKeys(roles).length !== ENGINE_ROLES.length || ENGINE_ROLES.some(role => !Object.hasOwn(roles, role))) return fail();
        const parsed = {} as Record<EngineRole, RoleSelection>;
        for (const role of ENGINE_ROLES) {
            const selection = object(roles[role]);
            const selectionKeys = ['model', 'effort', 'harness', 'skills', 'plugins'];
            if (Reflect.ownKeys(selection).length !== selectionKeys.length || selectionKeys.some(key => !Object.hasOwn(selection, key))) return fail();
            if (typeof selection.model !== 'string' || typeof selection.effort !== 'string' || typeof selection.harness !== 'string') return fail();
            const list = (input: unknown): string[] => {
                if (!Array.isArray(input) || input.length > 32) throw new DomainError('ROLE_CONFIG_INTEGRITY_FAILED', 409);
                return input.map(item => {
                    if (typeof item !== 'string' || item.length > 200) throw new DomainError('ROLE_CONFIG_INTEGRITY_FAILED', 409);
                    return item;
                });
            };
            parsed[role] = Object.freeze({ model: selection.model, effort: selection.effort, harness: selection.harness, skills: Object.freeze(list(selection.skills)) as readonly string[], plugins: Object.freeze(list(selection.plugins)) as readonly string[] });
        }
        const { contentHash, ...body } = value;
        if (typeof contentHash !== 'string' || contentHash !== hash(body)) return fail();
        return Object.freeze({ ...(body as Omit<RoleConfigurationRevision, 'contentHash'>), contentHash }) as RoleConfigurationRevision;
    } catch (error) {
        if (error instanceof DomainError && error.code === 'ROLE_CONFIG_INTEGRITY_FAILED') throw error;
        return fail();
    }
}

/**
 * The append-only chain of one project, validated revision by revision.
 *
 * Exported because the Flow compile step reads the same history the workbench writes: one reader
 * means a chain the workbench would refuse can never be compiled into a run either.
 */
export function roleConfigurationHistory(store: Store, projectId: string): RoleConfigurationRevision[] {
    store.project(projectId);
    const rows = store.records(projectId, ROLE_CONFIGURATION_RECORD_KIND);
    if (rows.length > MAX_ROLE_REVISIONS) throw new DomainError('ROLE_CONFIG_HISTORY_LIMIT', 409);
    const out: RoleConfigurationRevision[] = [];
    let parentHash: string | null = null;
    for (const row of rows) {
        const revision = readRevision(row.data, projectId, out.length + 1, parentHash);
        parentHash = revision.contentHash;
        out.push(revision);
    }
    return out;
}

/** The project's latest saved revision, or null when it never saved one. */
export function currentRoleConfiguration(store: Store, projectId: string): RoleConfigurationRevision | null {
    return roleConfigurationHistory(store, projectId).at(-1) ?? null;
}

export class RoleConfigurations {
    constructor(
        private readonly store: Store,
        private readonly config: () => Config,
        private readonly engines: EngineModes,
        /** Trusted registry snapshot, or null when this process has no reviewed one. */
        private readonly registry: () => RoleRegistrySnapshot | null,
        /** Instance root used for user-installed skills/plugins; absent means built-ins only. */
        private readonly root = ''
    ) { }

    defaults(): Readonly<Record<EngineRole, RoleSelection>> {
        const defaults = this.engines.defaults();
        return Object.freeze(Object.fromEntries(ENGINE_ROLES.map(role => [role, Object.freeze({
            model: defaults[role].model === 'UNSET_MODEL' ? '' : defaults[role].model,
            effort: defaults[role].reasoning,
            harness: defaults[role].harness,
            skills: Object.freeze([]) as readonly string[],
            plugins: Object.freeze([]) as readonly string[]
        })])) as Readonly<Record<EngineRole, RoleSelection>>);
    }

    revisions(projectId: string): RoleConfigurationRevision[] {
        return roleConfigurationHistory(this.store, projectId);
    }

    current(projectId: string): RoleConfigurationRevision | null {
        return this.revisions(projectId).at(-1) ?? null;
    }

    /** The engine-facing view of the stored configuration: defaults for anything never written. */
    engineSelection(projectId: string): EngineRoleSet {
        const current = this.current(projectId);
        const defaults = this.engines.defaults();
        if (!current) return defaults;
        const out = {} as Record<EngineRole, { harness: string; model: string; reasoning: string }>;
        for (const role of ENGINE_ROLES) {
            const stored = current.roles[role];
            const fallback = defaults[role];
            out[role] = Object.freeze({
                harness: stored.harness || fallback.harness,
                model: stored.model || fallback.model,
                reasoning: stored.effort || fallback.reasoning
            });
        }
        return Object.freeze(out) as EngineRoleSet;
    }

    /** Effective selection for one role, defaults filled in field by field. */
    selection(projectId: string, role: WorkbenchRole): RoleSelection {
        const wire = WORKBENCH_TO_WIRE[role];
        const current = this.current(projectId);
        const defaults = this.defaults()[wire];
        if (!current) return defaults;
        const stored = current.roles[wire];
        return Object.freeze({
            model: stored.model || defaults.model,
            effort: stored.effort || defaults.effort,
            harness: stored.harness || defaults.harness,
            skills: stored.skills.length ? stored.skills : defaults.skills,
            plugins: stored.plugins.length ? stored.plugins : defaults.plugins
        });
    }

    /**
     * Built-in options plus whatever the user dropped into <root>/.runtime/extensions/. A malformed
     * manifest never widens the catalog: extensionCatalog() skips the bad entry and reports it.
     */
    private userOptions(role: WorkbenchRole, kind: 'skills' | 'plugins', builtIn: readonly RoleOption[]): readonly RoleOption[] {
        if (!this.root) return builtIn;
        const { entries } = extensionCatalog(this.root, role, kind);
        if (!entries.length) return builtIn;
        const seen = new Set(builtIn.map(o => o.id));
        const extra = entries.filter(e => !seen.has(e.id)).map(e => Object.freeze({ id: e.id, label: e.label }) as RoleOption);
        return Object.freeze([...builtIn, ...extra]);
    }

    /** Every choice the page may offer, resolved by the server for this project. */
    catalog(projectId: string): RoleCatalogEntryView[] {
        const revision = this.current(projectId)?.revision ?? 0;
        const registry = this.registry();
        // DreamFlow has no Seeker: `POST /api/projects` already refuses with USER_PLANNER_REQUIRED
        // for it, yet this catalog still listed a seeker entry, so the API described a role the
        // product does not have. The entry is not merely hidden client-side - it is not offered.
        const roles: readonly WorkbenchRole[] = this.engines.entry(projectId) === 'DF'
            ? WORKBENCH_ROLES.filter(role => role !== 'seeker')
            : WORKBENCH_ROLES;
        return roles.map<RoleCatalogEntryView>(role => {
            const wire = WORKBENCH_TO_WIRE[role];
            // A harness the product ships keeps its own wire. Any other harness is real but needs a
            // build whose lane set accepts this exact image; naming a lane is not opening it, so the
            // page is told plainly which of the two it is looking at.
            const model0 = this.selection(projectId, role).model;
            const laneDispatchable = (harness: string): boolean => {
                if (PRODUCT_ROUTE_WIRES[harness]) return true;
                if (!registry || registry.buildScope !== 'REVIEWED_BINARY_DIGEST') return false;
                const capabilities = (registry.models ?? []).flatMap(entry => entry.protocols.map(protocol => ({ model: entry.id, protocol })));
                for (const protocol of ['anthropic-messages', 'openai-responses', 'chat-completions'] as const) {
                    const probe = additionalMagpieRoute(wire, { runtime: harness, authentication: 'api_key', protocol, model: model0 }, capabilities);
                    if (probe && probe.supportsBuild(registry.buildHash)) return true;
                }
                return false;
            };
            const harnesses: RoleOption[] = ROLE_HARNESSES[wire].map(harness => Object.freeze(laneDispatchable(harness)
                ? { id: harness, label: HARNESS_LABELS[harness] ?? harness, available: true }
                : { id: harness, label: HARNESS_LABELS[harness] ?? harness, available: false, reason: '这条运行器线路存在，但当前构建还没通过它的物理验收；选中会被拒绝。' }));
            const models: RoleOption[] = (registry?.models ?? []).map(model => Object.freeze(model.protocols.length
                ? { id: model.id, label: model.id, available: true } as RoleOption
                : { id: model.id, label: model.id, available: false, reason: '这个模型没有声明任何协议面，无法为它选线。' } as RoleOption));
            const choices: RoleChoiceSet = Object.freeze({ models: Object.freeze(models), efforts: EFFORT_OPTIONS, harnesses: Object.freeze(harnesses) });
            return Object.freeze({
                role,
                label: roleZhLabel(wire) ?? role,
                skills: this.userOptions(role, 'skills', SKILL_OPTIONS_BY_ROLE[role]),
                plugins: this.userOptions(role, 'plugins', Object.freeze([]) as readonly RoleOption[]),
                choices,
                selection: this.selection(projectId, role),
                revision
            });
        });
    }

    save(projectId: string, input: { role: unknown; revision: unknown; selection: unknown }, actor: string, operationHash: string): RoleConfigSavedView {
        if (!/^local-session:[a-f0-9]{64}$/.test(actor)) throw new DomainError('ROLE_CONFIG_INPUT_INVALID', 400, '缺少本地会话身份；不会记录这次配置写入。');
        if (!DIGEST.test(operationHash)) throw new DomainError('ROLE_CONFIG_INPUT_INVALID', 400, '缺少操作摘要。');
        const { wire, role } = workbenchRole(input.role);
        const expectedRevision = integer(Number(input.revision), 0, MAX_ROLE_REVISIONS);
        const raw = object(input.selection);
        const selection: RoleSelection = Object.freeze({
            model: raw.model === undefined || raw.model === '' ? '' : text(raw.model, 200),
            effort: text(raw.effort, 40),
            harness: text(raw.harness, 200),
            skills: readIdList(raw.skills, 'ROLE_CONFIG_SKILL_UNKNOWN'),
            plugins: readIdList(raw.plugins, 'ROLE_CONFIG_PLUGIN_UNKNOWN')
        });
        // Built-ins are fixed; user-installed ids are whatever the extension manifest offers this role.
        // A built-in is only offered to the roles it applies to (the interview skills belong to the
        // Seeker), so the write path checks the same rule the picker shows. Without that, the
        // catalog said one thing and a hand-written request could attach grillme to the executor.
        const userSkills = this.root ? new Set(extensionCatalog(this.root, role, 'skills').entries.map(e => e.id)) : new Set<string>();
        for (const skill of selection.skills) {
            if (userSkills.has(skill)) continue;
            if (!BUILT_IN_SKILLS.includes(skill as (typeof BUILT_IN_SKILLS)[number]))
                throw new DomainError('ROLE_CONFIG_SKILL_UNKNOWN', 400, '技能 ' + skill + ' 不在服务端提供的清单内。');
            if (!skillsForRole(role).includes(skill as (typeof BUILT_IN_SKILLS)[number]))
                throw new DomainError('ROLE_CONFIG_SKILL_NOT_FOR_ROLE', 400, '技能 ' + skill + ' 不适用于 ' + role + '；不会替它换一个角色。');
        }
        const userPlugins = this.root ? new Set(extensionCatalog(this.root, role, 'plugins').entries.map(e => e.id)) : new Set<string>();
        for (const plugin of selection.plugins)
            if (!userPlugins.has(plugin))
                throw new DomainError('ROLE_CONFIG_PLUGIN_UNKNOWN', 400, '插件 ' + plugin + ' 不在服务端提供的清单内。');
        const registry = this.registry();
        if (!registry) throw new DomainError('ROLE_CONFIG_REGISTRY_REQUIRED', 409, '本机还没有可核对的模型协议面与构建集快照；这次写入没有被接受，也没有回落到默认值。');
        const resolved = validateRoleCombination({ role: wire, harness: selection.harness, model: selection.model, effort: selection.effort, registry });
        const write = (): RoleConfigSavedView => {
            const history = this.revisions(projectId);
            const replay = history.find(revision => revision.operationHash === operationHash);
            if (replay) return this.savedView(projectId, role, replay, null);
            if (history.length >= MAX_ROLE_REVISIONS) throw new DomainError('ROLE_CONFIG_HISTORY_LIMIT', 409);
            if ((history.at(-1)?.revision ?? 0) !== expectedRevision)
                throw new DomainError('ROLE_CONFIG_REVISION_CONFLICT', 409, '页面读到的角色配置已经被改过；请刷新后再改。');
            if (this.store.runs(projectId).some(run => OPEN_RUN_STATES.includes(run.state)))
                throw new DomainError('ROLE_CONFIG_FROZEN_BY_RUN', 409, '这个项目还有未结束的运行；角色配置在运行时冻结，不会被改掉。');
            const base = history.at(-1);
            const roles = {} as Record<EngineRole, RoleSelection>;
            for (const roleName of ENGINE_ROLES) roles[roleName] = base ? base.roles[roleName] : this.defaults()[roleName];
            roles[wire] = selection;
            const body = {
                schema: ROLE_CONFIGURATION_SCHEMA,
                projectId,
                revision: history.length + 1,
                parentHash: base?.contentHash ?? null,
                roles: Object.freeze(roles),
                updatedAt: now(),
                updatedBy: actor,
                operationHash
            };
            const stored = { ...body, contentHash: hash(body) };
            this.store.record(ROLE_CONFIGURATION_RECORD_KIND, projectId, null, stored);
            this.engines.record(projectId, { source: 'ROLE_CONFIG_CHANGED', actor, ignoreHistory: true });
            // The returned badge is the same readback the Store now serves, not a locally built copy.
            return this.savedView(projectId, role, readRevision(stored, projectId, body.revision, body.parentHash), resolved);
        };
        return this.store.inTransaction ? write() : this.store.tx(write);
    }

    private savedView(projectId: string, role: WorkbenchRole, revision: RoleConfigurationRevision, protocol: RoleProtocol | null, engine = this.engines.view(projectId)): RoleConfigSavedView {
        return Object.freeze({
            role,
            revision: revision.revision,
            selection: Object.freeze({ ...revision.roles[WORKBENCH_TO_WIRE[role]] }),
            savedAt: revision.updatedAt,
            protocol,
            engine: reportOf(engine)
        });
    }
}

function readIdList(input: unknown, code: string): readonly string[] {
    if (input === undefined) return Object.freeze([]) as readonly string[];
    if (!Array.isArray(input) || input.length > 32) throw new DomainError(code, 400, '技能/插件清单必须是列表。');
    const out: string[] = [];
    for (const item of input) {
        if (typeof item !== 'string' || !item.trim() || item.length > 200 || hasSecret(item))
            throw new DomainError(code, 400, '技能/插件 id 无效。');
        if (!out.includes(item.trim())) out.push(item.trim());
    }
    return Object.freeze(out) as readonly string[];
}

export function reportOf(view: EngineView): EngineReport {
    return Object.freeze({ decision: view.decision, badge: view.badge, billing: view.billing, roles: view.roles });
}

