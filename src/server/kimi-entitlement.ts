import { DomainError, object } from './security.js';

/**
 * Kimi entitlement gate (G04).
 *
 * The live server returns `quota.extraUsage: null` when there is no booster wallet record, and
 * that is NOT proof that "Extra Usage" billing is switched off — the upstream schema cannot
 * express the toggle. So absence is treated as UNKNOWN and blocks new paid-plan reasoning, which
 * is exactly the rule this project runs on: unknown means stop.
 *
 * Only an explicit boolean on the account payload may declare OFF.
 */
export type ExtraUsageState = 'OFF' | 'ON' | 'UNKNOWN';

export interface QuotaSummary {
    limits: string[];
    extraUsage: ExtraUsageState;
    extraUsageReason: string;
}

export function classifyExtraUsage(quota: unknown): { state: ExtraUsageState; reason: string } {
    const q = object(quota ?? {});
    // Accept either the quota wrapper itself or the full { quota: {...} } response.
    const wallet = q.extraUsage !== undefined ? q.extraUsage : object(q.quota ?? {}).extraUsage;
    if (wallet === undefined || wallet === null)
        return { state: 'UNKNOWN', reason: 'NO_WALLET_RECORD：没有余额池记录，不等于开关关闭' };
    const w = object(wallet);
    if (w.enabled === true)
        return { state: 'ON', reason: 'ACCOUNT_REPORTS_ENABLED' };
    if (w.enabled === false)
        return { state: 'OFF', reason: 'ACCOUNT_REPORTS_DISABLED' };
    // A monthly cap flag describes the cap, not whether the wallet may be charged at all.
    return { state: 'UNKNOWN', reason: 'ONLY_CAP_OR_BALANCE_FIELDS_PRESENT' };
}

export function summarizeQuota(payload: unknown): QuotaSummary {
    const data = object(payload ?? {});
    const quota = object(data.quota ?? data);
    const usages = object(quota.usages ?? {});
    const decided = classifyExtraUsage(quota.extraUsage);
    return { limits: Object.keys(usages).sort(), extraUsage: decided.state, extraUsageReason: decided.reason };
}

/**
 * Gate for any reasoning that would spend membership quota under a paid fallback. UNKNOWN and ON
 * both stop; only an explicit OFF allows the caller to proceed, and the caller still has to hold
 * its own budget/authority before dispatching.
 */
export function assertExtraUsageGate(summary: QuotaSummary): void {
    if (summary.extraUsage === 'UNKNOWN')
        throw new DomainError('KIMI_EXTRA_USAGE_UNKNOWN', 409, '无法证明 Extra Usage 处于关闭状态；停止新的会员计费推理。');
    if (summary.extraUsage === 'ON')
        throw new DomainError('KIMI_EXTRA_USAGE_ENABLED', 409, '账户启用了 Extra Usage 余额扣费；未获授权，停止推理。');
}
