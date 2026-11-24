/**
 * Zero-usage deployment switch.
 *
 * A package handed to someone who has not agreed to spend money must not be able to spend it,
 * even if a credential happens to be in the environment. `DM_ZERO_USAGE=1` makes every paid
 * dispatch fail closed with a named code, before any network call and before any reservation.
 *
 * It is deliberately a runtime check and not a config value: a config value can be edited by the
 * page, an environment variable cannot. Nothing about the local (loopback) path changes.
 */
import {DomainError} from './security.js';

const FLAG='DM_ZERO_USAGE';

export function zeroUsageEnabled(): boolean {
    const raw=process.env[FLAG];
    return raw==='1'||raw==='true';
}

/** Called by every path that would reach a metered provider. `local` is the loopback runtime. */
export function assertPaidDispatchAllowed(local: boolean): void {
    if(local)return;
    if(zeroUsageEnabled())
        throw new DomainError('ZERO_USAGE_DEPLOYMENT','409' as unknown as number,
            '这个包以零用量模式部署（DM_ZERO_USAGE=1）：任何付费模型调用都会被拒绝，不会发出网络请求也不会占用预算。需要付费能力时，显式去掉该环境变量并完成账户与探针流程。');
}

export const ZERO_USAGE_ENV=FLAG;
