import type { AgentOutput, Config, Role, RolePolicy, ExecutionIdentity } from '../shared/types.js';
import { DomainError } from './security.js';

/** New Flows freeze this policy. Historical configuration is still readable, never rewritten. */
export const TARGET_ROLE_POLICY: RolePolicy = 'CODEX_DSH_V1';
export const CUSTOM_ROLE_POLICY:RolePolicy='CUSTOM_FROZEN_V1';
export function rolePolicyBinding(c: Config, policy: RolePolicy = TARGET_ROLE_POLICY) {
    if (!['CODEX_DSH_V1', 'LEGACY_CONFIGURED_V1'].includes(policy)) throw new DomainError('ROLE_POLICY_UNKNOWN', 409);
    const degraded = policy === 'LEGACY_CONFIGURED_V1' && c.independent?.enabled === true;
    const provider = degraded ? new URL(c.independent!.baseUrl).hostname === 'api.deepseek.com' ? 'deepseek-official' : 'openai-official' : 'openai';
    const model = degraded ? c.independent!.model : c.codex.model;
    return { rolePolicy: policy, planner2Mode: degraded ? 'api_key' as const : 'chatgpt_subscription' as const,
        independence: provider === 'deepseek-official' ? 'DEGRADED_SAME_VENDOR' as const : 'CROSS_VENDOR' as const,
        independentProvider: provider,
        models: { planner1: c.planner1.model, planner2: model, executor: c.dsh.model, reviewer: model } };
}
/** Adapter-owned evidence, never a model-written summary or an inferred configured ID. */
export function executionIdentity(role: Role, c: Config, out: AgentOutput): ExecutionIdentity {
    const identity = out.identity;
    if (!identity || !out.sessionId || !identity.model || identity.model !== out.model)
        throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED', 409);
    const expected = role === 'executor'
        ? { runner: 'DSH', provider: 'deepseek-official', authentication: 'API_KEY', model: c.dsh.model }
        : { runner: 'CODEX_CLI', provider: 'openai', authentication: 'CHATGPT_SUBSCRIPTION', model: c.codex.model };
    if (Object.entries(expected).some(([key, value]) => identity[key as keyof ExecutionIdentity] !== value))
        throw new DomainError('ROLE_EXECUTION_ROUTE_MISMATCH', 409);
    return { ...identity };
}
