import type { Config, LayaDecision } from '../shared/types.js';
import { DomainError, hash, object } from './security.js';

/**
 * Controller-owned Classic Laya enhancement qualification.
 *
 * The historical Live path refused any Laya-on state because its receipts were measured against a
 * Laya-OFF baseline. This record is the explicit replacement: it is issued only after every
 * engineering role answered a real forward through the local bridge, and it is bound to the exact
 * source tree, Laya configuration and protocol. It never grants a role, a budget or a verdict.
 */
export const LAYA_QUALIFICATION_SCHEMA = 'dream-maker.laya-qualification.v1';
export const LAYA_QUALIFICATION_ROLES = ['planner2', 'executor', 'reviewer'] as const;
export type LayaQualificationRole = typeof LAYA_QUALIFICATION_ROLES[number];

export interface LayaQualificationBinding {
    sourceHash: string;
    configurationHash: string;
}

export interface LayaQualificationRoleEvidence {
    inputHash: string;
    adoption: string;
    label: string | null;
    latencyMs: number;
    confidence: number | null;
    modelRevision: string | null;
    cached: boolean;
}

export interface LayaQualification {
    schema: typeof LAYA_QUALIFICATION_SCHEMA;
    status: 'QUALIFIED';
    protocol: 'dm-bridge-v1';
    baseUrl: string;
    mode: 'advisory';
    roles: LayaQualificationRole[];
    sourceHash: string;
    configurationHash: string;
    modelRevision: string | null;
    roleEvidence: Record<LayaQualificationRole, LayaQualificationRoleEvidence>;
    causalModelInfluence: 'NOT_CLAIMED';
    issuedAt: string;
    expiresAt: string;
}

const HEX64 = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function loopbackOrigin(value: string): string | null {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null;
        if (url.username || url.password || url.search || url.hash) return null;
        if (!['', '/'].includes(url.pathname)) return null;
        return url.origin;
    } catch {
        return null;
    }
}

/** Fail closed on any drift. Unknown or partial shapes are never treated as a valid qualification. */
export function assertLayaQualification(raw: unknown, expected: {
    binding: LayaQualificationBinding;
    config: Config;
    now?: number;
}): LayaQualification {
    const fail = (): never => {
        throw new DomainError('NATIVE_LAYA_QUALIFICATION_REQUIRED', 409);
    };
    if (!isRecord(raw)) return fail();
    const value = raw;
    const laya = expected.config.laya;
    const expectedOrigin = loopbackOrigin(laya.baseUrl);
    if (!expectedOrigin) return fail();
    if (value.schema !== LAYA_QUALIFICATION_SCHEMA || value.status !== 'QUALIFIED' ||
        value.protocol !== 'dm-bridge-v1' || value.mode !== 'advisory' ||
        value.causalModelInfluence !== 'NOT_CLAIMED') return fail();
    if (typeof value.sourceHash !== 'string' || value.sourceHash !== expected.binding.sourceHash) return fail();
    if (typeof value.configurationHash !== 'string' || value.configurationHash !== expected.binding.configurationHash) return fail();
    if (value.baseUrl !== expectedOrigin) return fail();
    if (laya.mode !== 'advisory') return fail();
    if (!Array.isArray(value.roles) || value.roles.length !== LAYA_QUALIFICATION_ROLES.length) return fail();
    if (!LAYA_QUALIFICATION_ROLES.every(role => (value.roles as unknown[]).includes(role))) return fail();
    if (typeof value.issuedAt !== 'string' || !Number.isFinite(Date.parse(value.issuedAt))) return fail();
    if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) return fail();
    if (Date.parse(value.expiresAt) <= (expected.now ?? Date.now())) return fail();
    const evidence = object(value.roleEvidence ?? {}) as Record<string, unknown>;
    for (const role of LAYA_QUALIFICATION_ROLES) {
        const row = evidence[role];
        if (!isRecord(row)) return fail();
        if (typeof row.inputHash !== 'string' || !HEX64.test(row.inputHash)) return fail();
        // A forward that abstained proved the transport, not a usable advisory label.
        if (row.adoption !== 'advisory' || row.cached !== false) return fail();
        if (typeof row.label !== 'string' || !row.label) return fail();
        if (!Number.isFinite(row.latencyMs) || Number(row.latencyMs) < 0) return fail();
        if (row.confidence !== null && !Number.isFinite(row.confidence)) return fail();
        if (row.modelRevision !== null && typeof row.modelRevision !== 'string') return fail();
        if (laya.expectedRevision && row.modelRevision !== laya.expectedRevision) return fail();
    }
    return value as unknown as LayaQualification;
}

export function qualificationEvidence(decisions: Record<LayaQualificationRole, LayaDecision>): Record<LayaQualificationRole, LayaQualificationRoleEvidence> {
    const out = {} as Record<LayaQualificationRole, LayaQualificationRoleEvidence>;
    for (const role of LAYA_QUALIFICATION_ROLES) {
        const decision = decisions[role];
        out[role] = {
            inputHash: decision.inputHash,
            adoption: decision.adoption,
            label: decision.label,
            latencyMs: decision.latencyMs,
            confidence: decision.confidence,
            modelRevision: decision.modelRevision,
            cached: decision.cached,
        };
    }
    return out;
}

/**
 * One fingerprint rule for the enhanced Classic path: the compiled controller, the adapters and the
 * prompts that actually execute, plus the Laya section itself. A prompt or Laya edit invalidates the
 * qualification instead of silently reusing an older forward.
 */
export function layaQualificationBinding(root: string, config: Config, hashes: (path: string) => string): LayaQualificationBinding {
    const source = {
        server: hashes(root + '/dist/server'),
        adapters: hashes(root + '/adapters'),
        prompts: hashes(root + '/prompts'),
    };
    return {
        sourceHash: hash(source),
        configurationHash: hash({ source, laya: config.laya, codex: { model: config.codex.model, transport: config.codex.transport ?? 'stdio' }, dsh: { model: config.dsh.model, modulePath: config.dsh.modulePath } }),
    };
}
