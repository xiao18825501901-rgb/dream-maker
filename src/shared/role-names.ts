/**
 * Role display metadata, plus the single inbound alias normalizer.
 *
 * TWO NAMES, ONE ID
 * -----------------
 * The wire id is frozen: 'planner1' / 'planner2' already live in the exported evidence
 * files, the SQLite ledger, the persisted config, the route paths and the error codes.
 * Rewriting the id would break every one of those historical records, so it stays.
 *
 * What changed is the name a person reads:
 *
 *     planner1 -> Seeker    the role that collects and confirms your plan
 *     planner2 -> Planner   the role that turns the confirmed plan into tasks
 *     executor -> Executor  unchanged
 *     reviewer -> Reviewer  unchanged
 *
 * This file is display data and pure functions only: no clock, no filesystem, no
 * network, no mutable state. The server and the browser import the same copy, so a
 * page and a log line cannot disagree about what a role is called.
 */

/** The frozen storage identifiers. Order is the historical product order. */
export const ROLE_WIRE_IDS = ['planner1', 'planner2', 'executor', 'reviewer'] as const;
export type RoleWireId = typeof ROLE_WIRE_IDS[number];

/** Icon ids in the shared browser sprite (see uiIcon in src/web/views.ts). */
export type RoleIconId = 'seeker' | 'planner' | 'executor' | 'reviewer';

/**
 * The three visual identifiers a DreamFlow (DF) surface may use for a role: a short
 * badge, a CSS tone token (rendered as the class suffix `is-<tone>`) and the lane
 * number on the DF work board.
 */
export interface RoleDreamflowVisuals {
    readonly badge: string;
    readonly tone: string;
    readonly lane: string;
}

export interface RoleDisplayMetadata {
    /** Frozen storage/wire identifier. Never rendered as a display name. */
    readonly wireId: RoleWireId;
    /** English name shown to people. */
    readonly displayName: string;
    /** Chinese label. The rename did not change it. */
    readonly zhLabel: string;
    /** Icon id in the shared sprite. */
    readonly iconId: RoleIconId;
    /** DF's three visual identifiers. */
    readonly dreamflow: RoleDreamflowVisuals;
    /** Extra spellings accepted from an operator, on top of wire id / display name / label. */
    readonly aliases: readonly string[];
}

const entry = (input: RoleDisplayMetadata): RoleDisplayMetadata => Object.freeze({
    ...input,
    dreamflow: Object.freeze({ ...input.dreamflow }),
    aliases: Object.freeze([...input.aliases])
});

/** Display metadata by stable wire id. Total over {@link RoleWireId}. */
export const ROLE_METADATA: Readonly<Record<RoleWireId, RoleDisplayMetadata>> = Object.freeze({
    planner1: entry({
        wireId: 'planner1',
        displayName: 'Seeker',
        zhLabel: '需求澄清',
        iconId: 'seeker',
        dreamflow: { badge: 'SK', tone: 'seeker', lane: '00' },
        aliases: ['seeker', 'seeker1', 'p1']
    }),
    planner2: entry({
        wireId: 'planner2',
        displayName: 'Planner',
        zhLabel: '工程规划',
        iconId: 'planner',
        dreamflow: { badge: 'PL', tone: 'planner', lane: '01' },
        // 'planner' alone is the current product name of planner2, never of planner1.
        aliases: ['planner', 'p2']
    }),
    executor: entry({
        wireId: 'executor',
        displayName: 'Executor',
        zhLabel: '执行制作',
        iconId: 'executor',
        dreamflow: { badge: 'EX', tone: 'executor', lane: '02' },
        aliases: ['exec']
    }),
    reviewer: entry({
        wireId: 'reviewer',
        displayName: 'Reviewer',
        zhLabel: '独立审查',
        iconId: 'reviewer',
        dreamflow: { badge: 'RV', tone: 'reviewer', lane: '03' },
        aliases: ['review']
    })
});

/** Case-insensitive, separator-insensitive form of one accepted spelling. */
function aliasKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 64) return null;
    // Spaces, underscores, hyphens, dots and the middle dot are formatting, not
    // identity: 'Planner 2', 'planner_2' and 'planner-2' are the same request.
    const key = trimmed.toLowerCase().replace(/[\s_\-\u00b7\u2014.]+/g, '');
    if (key.length === 0 || /[\u0000-\u001f\u007f]/.test(key)) return null;
    return key;
}

const ALIAS_TABLE: ReadonlyMap<string, RoleWireId> = (() => {
    const table = new Map<string, RoleWireId>();
    for (const wireId of ROLE_WIRE_IDS) {
        const metadata = ROLE_METADATA[wireId];
        for (const candidate of [wireId, metadata.displayName, metadata.zhLabel, ...metadata.aliases]) {
            const key = aliasKey(candidate);
            // First writer wins, so a stable wire id can never be shadowed by an alias.
            if (key && !table.has(key)) table.set(key, wireId);
        }
    }
    return table;
})();

/**
 * Normalize one inbound role spelling to the stable wire id.
 *
 * Accepts the wire id, the display name (Seeker/Planner/...), the Chinese label and the
 * documented aliases, in any case, with or without spaces/underscores/hyphens. Returns
 * null for anything else, so an unknown name is never silently coerced into a real role.
 */
export function acceptsAlias(input: unknown): RoleWireId | null {
    const key = aliasKey(input);
    if (!key) return null;
    return ALIAS_TABLE.get(key) ?? null;
}

/** True only for the frozen storage ids, with no alias resolution. */
export function isRoleWireId(input: unknown): input is RoleWireId {
    return typeof input === 'string' && (ROLE_WIRE_IDS as readonly string[]).includes(input);
}

/** Metadata for a stable wire id. */
export function roleMetadata(wireId: RoleWireId): RoleDisplayMetadata {
    return ROLE_METADATA[wireId];
}

/** English display name for a wire id or any accepted alias; null when unknown. */
export function roleDisplayName(input: unknown): string | null {
    const wireId = acceptsAlias(input);
    return wireId ? ROLE_METADATA[wireId].displayName : null;
}

/** Chinese label for a wire id or any accepted alias; null when unknown. */
export function roleZhLabel(input: unknown): string | null {
    const wireId = acceptsAlias(input);
    return wireId ? ROLE_METADATA[wireId].zhLabel : null;
}

/** Icon id for a wire id or any accepted alias; null when unknown. */
export function roleIconId(input: unknown): RoleIconId | null {
    const wireId = acceptsAlias(input);
    return wireId ? ROLE_METADATA[wireId].iconId : null;
}

/** Heading label: "Seeker · 需求澄清". */
export function roleDisplayLabel(wireId: RoleWireId): string {
    const metadata = ROLE_METADATA[wireId];
    return metadata.displayName + ' · ' + metadata.zhLabel;
}

/**
 * The stable id and the display name together, for a payload that has to stay readable
 * by old consumers and legible to a person at the same time.
 */
export function roleProjection(wireId: RoleWireId): { role: RoleWireId; displayName: string; zhLabel: string } {
    const metadata = ROLE_METADATA[wireId];
    return { role: wireId, displayName: metadata.displayName, zhLabel: metadata.zhLabel };
}

/**
 * Normalize a list of inbound role names (HTTP body array, CLI list). Every entry must
 * resolve; duplicates collapse in first-seen order. Returns null when any entry is
 * unknown or the input is not an array, so the caller can answer 400 instead of guessing.
 */
export function normalizeRoleList(input: unknown): RoleWireId[] | null {
    if (!Array.isArray(input)) return null;
    const out: RoleWireId[] = [];
    for (const item of input) {
        const wireId = acceptsAlias(item);
        if (!wireId) return null;
        if (!out.includes(wireId)) out.push(wireId);
    }
    return out;
}

/**
 * Normalize the keys of an inbound object that is keyed by role name (for example
 * `laya.roles`). Stable wire ids win over their aliases regardless of key order; keys
 * that are not role names are dropped, matching the previous ignore-unknown behaviour.
 * Returns null when the input is not a plain object.
 */
export function normalizeRoleAliasKeys(input: unknown): Partial<Record<RoleWireId, unknown>> | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const source = input as Record<string, unknown>;
    const out: Partial<Record<RoleWireId, unknown>> = {};
    for (const wireId of ROLE_WIRE_IDS) {
        if (Object.hasOwn(source, wireId)) out[wireId] = source[wireId];
    }
    for (const [key, value] of Object.entries(source)) {
        if (isRoleWireId(key)) continue;
        const wireId = acceptsAlias(key);
        if (wireId && !Object.hasOwn(out, wireId)) out[wireId] = value;
    }
    return out;
}

/**
 * Rename a request-body field that is spelled with a role's product name:
 * `seeker` -> `planner1`, `planner` -> `planner2`. Only a field whose whole name is
 * the current display name is renamed, and a stable wire-id field is never overwritten.
 * Everything else is copied untouched, so this can sit in front of the existing
 * per-route validators without changing their contract.
 */
export function normalizeRoleFields(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };
    for (const [key, value] of Object.entries(source)) {
        if (isRoleWireId(key)) continue;
        const wireId = acceptsAlias(key);
        if (!wireId || Object.hasOwn(source, wireId)) continue;
        if (aliasKey(key) !== aliasKey(ROLE_METADATA[wireId].displayName)) continue;
        out[wireId] = value;
    }
    return out;
}
