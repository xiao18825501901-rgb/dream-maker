import { readFileSync } from 'node:fs';
import { DomainError } from './security.js';

/**
 * A01: the single Kimi admission authority.
 *
 * Every path that can spend Kimi membership quota asks THIS object before a request goes out —
 * the interview layer before it builds a prompt, and the runner immediately before its first
 * upstream call. Two layers, one authority: a caller cannot bypass the gate by constructing a
 * runner directly, because a runner without explicit evidence denies by default.
 *
 * The live account payload cannot express the Extra Usage toggle (`extraUsage: null` is absence of
 * a wallet record, not proof of "off"), so the only admissible OFF evidence is an explicit record
 * the owner wrote down: state OFF, a source, the account it belongs to, and an expiry. Anything
 * else — absent file, corrupt file, ON, UNKNOWN, expired, future-dated, another account — refuses
 * new inference.
 */
export type ExtraUsageEvidenceState = 'OFF' | 'ON' | 'UNKNOWN';

export interface KimiEntitlementEvidence {
    schema: 1;
    state: ExtraUsageEvidenceState;
    source: 'OBSERVED' | 'USER_ATTESTED';
    accountRef: string;
    observedAt: string;
    expiresAt: string;
    note?: string;
}

export interface KimiAdmissionSnapshot {
    state: ExtraUsageEvidenceState | 'ABSENT' | 'CORRUPT';
    source: string | null;
    accountRef: string | null;
    observedAt: string | null;
    expiresAt: string | null;
    allowsSend: boolean;
    reason: string;
}

export interface KimiAdmission {
    /** Scheduling layer: refuse before a prompt is even assembled. */
    assertMaySend(operation: string, at?: number): void;
    /** Runner layer, after the bound account is known: refuse a different account. */
    assertAccount(operation: string, accountRef: string): void;
    snapshot(at?: number): KimiAdmissionSnapshot;
}

const STATES: readonly string[] = ['OFF', 'ON', 'UNKNOWN'];
const SOURCES: readonly string[] = ['OBSERVED', 'USER_ATTESTED'];
/** Tolerated clock skew for `observedAt`: a record dated in the future is a different clock, not evidence. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function refuse(code: string, message: string): never {
    throw new DomainError(code, 409, message);
}

function parseInstant(value: unknown): number {
    if (typeof value !== 'string' || value.length === 0)
        return Number.NaN;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : Number.NaN;
}

function emptySnapshot(state: KimiAdmissionSnapshot['state'], reason: string): KimiAdmissionSnapshot {
    return { state, source: null, accountRef: null, observedAt: null, expiresAt: null, allowsSend: false, reason };
}

/** Evidence is validated once, at construction: a malformed record can never become a pass later. */
export function validateEvidence(raw: unknown): KimiEntitlementEvidence {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        refuse('KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT', 'Extra Usage 证据文件不是对象。');
    const r = raw as Record<string, unknown>;
    if (r.schema !== 1)
        refuse('KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT', 'Extra Usage 证据文件 schema 必须是 1。');
    const state = typeof r.state === 'string' ? r.state : '';
    if (!STATES.includes(state))
        refuse('KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT', 'Extra Usage 证据的 state 只能是 OFF/ON/UNKNOWN。');
    const source = typeof r.source === 'string' ? r.source : '';
    if (!SOURCES.includes(source))
        refuse('KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT', 'Extra Usage 证据的 source 只能是 OBSERVED/USER_ATTESTED。');
    if (typeof r.accountRef !== 'string' || r.accountRef.length === 0)
        refuse('KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT', 'Extra Usage 证据必须绑定 accountRef。');
    if (!Number.isFinite(parseInstant(r.observedAt)) || !Number.isFinite(parseInstant(r.expiresAt)))
        refuse('KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT', 'Extra Usage 证据的 observedAt/expiresAt 必须是 ISO 时间。');
    return {
        schema: 1,
        state: state as ExtraUsageEvidenceState,
        source: source as KimiEntitlementEvidence['source'],
        accountRef: r.accountRef,
        observedAt: r.observedAt as string,
        expiresAt: r.expiresAt as string,
        note: typeof r.note === 'string' ? r.note : undefined,
        ...(r.ownerWaived === true ? { ownerWaived: true } : {})
    } as KimiEntitlementEvidence;
}

/**
 * Fail-closed admission: the default for every runner that was not handed explicit evidence.
 * Used as the constructor default so no caller can accidentally bypass the gate.
 */
export function denyAllAdmission(reason = 'KIMI_EXTRA_USAGE_UNKNOWN'): KimiAdmission {
    const message = '没有可用的 Extra Usage 关闭证据；拒绝新的 Kimi 推理（未知不等同于关闭）。';
    return {
        assertMaySend: () => refuse(reason, message),
        assertAccount: () => refuse(reason, message),
        snapshot: () => emptySnapshot('ABSENT', reason)
    };
}

export function createKimiAdmission(evidence: KimiEntitlementEvidence | undefined, clock: () => number = () => Date.now()): KimiAdmission {
    if (!evidence)
        return denyAllAdmission();
    // Defense in depth: `loadKimiAdmission` validates before it gets here, but this constructor is
    // reachable directly and TypeScript types do not exist at runtime. Without this, a hand-built
    // record with an unknown `state` would fall through every branch below and ALLOW sends — the one
    // failure direction this gate must never have. Refuse instead, with the validation's own code.
    let trusted: KimiEntitlementEvidence;
    try { trusted = validateEvidence(evidence); }
    catch (error) { return denyAllAdmission((error as { code?: string }).code ?? 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT'); }
    // Owner waiver: the owner may explicitly accept the Extra Usage risk instead of asserting the switch is
    // off (they did so on 2026-10-28). That is a DIFFERENT statement from OFF and is recorded as such: the
    // evidence keeps state=UNKNOWN and carries ownerWaived=true plus the owner's own words, so nothing here
    // claims the switch is closed. The expiry still applies, so a waiver cannot silently outlive its window.
    const waived = (trusted as { ownerWaived?: unknown }).ownerWaived === true && trusted.state !== 'OFF';
    const check = (operation: string, at: number): void => {
        if (trusted.state === 'ON' && !waived)
            refuse('KIMI_EXTRA_USAGE_ENABLED', `账户启用了 Extra Usage 余额扣费；未获授权，停止推理（${operation}）。`);
        if (trusted.state === 'UNKNOWN' && !waived)
            refuse('KIMI_EXTRA_USAGE_UNKNOWN', `Extra Usage 状态未知；停止新的会员计费推理（${operation}）。`);
        const observed = parseInstant(trusted.observedAt), expires = parseInstant(trusted.expiresAt);
        if (observed > at + FUTURE_SKEW_MS)
            refuse('KIMI_EXTRA_USAGE_EVIDENCE_INVALID', 'Extra Usage 证据的时间晚于本机时钟，不可采信。');
        if (expires <= at)
            refuse('KIMI_EXTRA_USAGE_EVIDENCE_EXPIRED', `Extra Usage 证据已过期，需重新确认后才可推理（${operation}）。`);
    };
    return {
        assertMaySend: (operation, at = clock()) => check(operation, at),
        assertAccount: (operation, accountRef) => {
            check(operation, clock());
            if (accountRef.length === 0)
                refuse('KIMI_ACCOUNT_MISMATCH', '当前没有已绑定账户；拒绝推理。');
            if (accountRef !== trusted.accountRef)
                refuse('KIMI_ACCOUNT_MISMATCH', `Extra Usage 证据属于另一个账户代数；拒绝推理（${operation}）。`);
        },
        snapshot: (at = clock()) => {
            const expired = parseInstant(trusted.expiresAt) <= at;
            let reason = 'OK';
            try { check('snapshot', at); }
            catch (error) { reason = (error as { code?: string }).code ?? 'KIMI_EXTRA_USAGE_UNKNOWN'; }
            return {
                state: trusted.state,
                source: trusted.source,
                accountRef: trusted.accountRef,
                observedAt: trusted.observedAt,
                expiresAt: trusted.expiresAt,
                allowsSend: reason === 'OK' && !expired,
                reason
            };
        }
    };
}

/**
 * Load the owner-written evidence file. A missing path is UNKNOWN (deny); a corrupt file is also a
 * deny, but reported as CORRUPT so the UI can tell "never attested" from "bad file".
 */
export function loadKimiAdmission(path: string | undefined, read: (p: string) => string = p => readFileSync(p, 'utf8')): KimiAdmission {
    if (!path)
        return denyAllAdmission();
    let text: string;
    try { text = read(path); }
    catch { return denyAllAdmission(); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch {
        const reason = 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT';
        return {
            assertMaySend: () => refuse(reason, 'Extra Usage 证据文件不是合法 JSON；拒绝新推理。'),
            assertAccount: () => refuse(reason, 'Extra Usage 证据文件不是合法 JSON；拒绝新推理。'),
            snapshot: () => emptySnapshot('CORRUPT', reason)
        };
    }
    try { return createKimiAdmission(validateEvidence(parsed)); }
    catch (error) {
        const code = (error as { code?: string }).code ?? 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT';
        return {
            assertMaySend: () => refuse(code, 'Extra Usage 证据文件不合法；拒绝新推理。'),
            assertAccount: () => refuse(code, 'Extra Usage 证据文件不合法；拒绝新推理。'),
            snapshot: () => emptySnapshot('CORRUPT', code)
        };
    }
}