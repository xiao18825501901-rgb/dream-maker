import { DomainError, hash } from './security.js';
import type { Config } from '../shared/types.js';
import { LOCAL_PLANNER1_BASE_URL, LOCAL_PLANNER1_KEY_ENV, LOCAL_PLANNER1_PROTOCOL } from './local-planner1-contract.js';

/**
 * planner1 binding (K02).
 *
 * The upstream identity of the requirement-clarification role is modelled on
 * separate fields instead of the former protocol/authMode pair: provider,
 * runner, auth method, credential reference, account reference, model, policy
 * hash, protocol hash and binding version. A binding is *frozen* into a Live
 * project at creation so a later settings change cannot silently re-route an
 * existing project onto another account or billing path.
 *
 * Version 1 preserves the historical Kimi OAuth-only rule. An explicit,
 * confirmed version 2 selection may use the existing official HTTP API
 * adapters. Old API/SIWC bindings are never promoted by merely loading them.
 * OAuth support and API credentials are separate capabilities.
 */
export const PLANNER1_PROVIDERS = ['kimi', 'openai', 'deepseek', 'local', 'siwc'] as const;
export type Planner1Provider = typeof PLANNER1_PROVIDERS[number];
export type Planner1Runner = 'kimi-server' | 'http-api' | 'local-http' | 'siwc-sdk';
export type Planner1AuthMethod = 'oauth' | 'api_key' | 'none' | 'siwc_plan';

/** Historical default; explicit version 2 API selections are independent of it. */
export const ACTIVE_PLANNER1_PROVIDER: Planner1Provider = 'kimi';
/** Providers that must not dispatch, be selected or be auto-fallen-back to. */
export const RETIRED_PLANNER1_PROVIDERS: readonly Planner1Provider[] = ['openai', 'deepseek', 'siwc'];
/** Current binding schema version; bump when a stored binding needs migration. */
export const PLANNER1_BINDING_VERSION = 1;
/**
 * The Seeker route: planner1 answers through the official HTTP API on an api_key credential, and
 * the product attaches its two built-in skills (grillme for the interview, prompt-optimizer for the
 * requirements draft and the complete plan). It is a distinct frozen identity, not an upgrade of
 * version 1 (Kimi OAuth) or of the earlier version 2 API experiments: a project created on OAuth
 * keeps dispatching on OAuth, and a version 2 project keeps its old two-call behaviour.
 */
export const SEEKER_PLANNER1_BINDING_VERSION = 4;

export interface Planner1Binding {
    provider: Planner1Provider;
    runner: Planner1Runner;
    authMethod: Planner1AuthMethod;
    /** Environment variable name for an api_key binding; empty for OAuth. */
    credentialRef: string;
    /** Account reference required before real dispatch; empty means unbound. */
    accountRef: string;
    model: string;
    policyHash: string;
    protocolHash: string;
    bindingVersion: number;
}

function hostOf(baseUrl: string): string {
    try {
        return new URL(baseUrl).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}

function deriveProvider(config: Config): Planner1Provider {
    const declared = config.planner1.provider;
    if (declared !== undefined && (PLANNER1_PROVIDERS as readonly string[]).includes(declared))
        return declared as Planner1Provider;
    // Legacy configuration without an explicit provider: derive it from the
    // fields that actually routed the request, so an old file cannot be read as
    // something other than the retired path it really used.
    if (config.planner1.authMode === 'siwc_plan')
        return 'siwc';
    if (hostOf(config.planner1.baseUrl) === 'api.deepseek.com')
        return 'deepseek';
    return 'openai';
}

export function planner1Binding(config: Config): Planner1Binding {
    const p = config.planner1;
    const provider = deriveProvider(config);
    const runner: Planner1Runner = provider === 'kimi' ? 'kimi-server' : provider === 'local' ? 'local-http' : provider === 'siwc' ? 'siwc-sdk' : 'http-api';
    const authMethod: Planner1AuthMethod = provider === 'kimi' ? 'oauth' : provider === 'local' ? 'none' : provider === 'siwc' ? 'siwc_plan' : 'api_key';
    const version=p.bindingVersion??PLANNER1_BINDING_VERSION;
    if(version===SEEKER_PLANNER1_BINDING_VERSION&&!(provider==='openai'||provider==='deepseek'))
        throw new DomainError('PLANNER1_PROVIDER_ROUTE_MISMATCH',409);
    if((version===2||version===SEEKER_PLANNER1_BINDING_VERSION)&&(provider==='openai'||provider==='deepseek')){
        const base=p.baseUrl.replace(/\/$/,'');
        if(p.authMode!=='api_key'||provider==='openai'&&(base!=='https://api.openai.com/v1'||p.protocol!=='openai-responses')
            ||provider==='deepseek'&&(!['https://api.deepseek.com','https://api.deepseek.com/v1'].includes(base)||p.protocol!=='chat-completions'))
            throw new DomainError('PLANNER1_PROVIDER_ROUTE_MISMATCH',409);
    }
    if(version===3&&provider==='local'&&(p.baseUrl.replace(/\/$/,'')!==LOCAL_PLANNER1_BASE_URL||p.protocol!==LOCAL_PLANNER1_PROTOCOL||p.keyEnv!==LOCAL_PLANNER1_KEY_ENV))
        throw new DomainError('PLANNER1_PROVIDER_ROUTE_MISMATCH',409);
    return {
        provider,
        runner,
        authMethod,
        credentialRef: authMethod === 'api_key' ? p.keyEnv : authMethod==='none'?LOCAL_PLANNER1_KEY_ENV:'',
        accountRef: provider === 'kimi' ? (p.accountRef ?? '') : provider==='local'?'LOCAL_DEVICE':version===2||version===SEEKER_PLANNER1_BINDING_VERSION?'UNKNOWN':'',
        model: provider === 'siwc' ? p.siwcModel : p.model,
        policyHash: provider === 'kimi' ? (p.policyHash ?? '') : '',
        protocolHash: provider === 'kimi' ? (p.protocolHash ?? '') : version===2||version===3||version===SEEKER_PLANNER1_BINDING_VERSION?hash({baseUrl:p.baseUrl,protocol:p.protocol}):'',
        bindingVersion: version
    };
}

export function isRetiredProvider(provider: string,version=1): boolean {
    if((version===2||version===SEEKER_PLANNER1_BINDING_VERSION)&&(provider==='openai'||provider==='deepseek'))return false;
    return (RETIRED_PLANNER1_PROVIDERS as readonly string[]).includes(provider);
}

/** Stable fingerprint of the identity fields; not a secret hash. */
export function planner1BindingHash(binding: Planner1Binding): string {
    return hash({
        provider: binding.provider,
        runner: binding.runner,
        authMethod: binding.authMethod,
        credentialRef: binding.credentialRef,
        accountRef: binding.accountRef,
        model: binding.model,
        policyHash: binding.policyHash,
        protocolHash: binding.protocolHash,
        bindingVersion: binding.bindingVersion
    });
}

/**
 * Execution gate. Every production dispatch of planner1 must pass through it:
 * no provider selection, no factory and no fallback may reach a retired
 * upstream, and an unknown provider must fail closed.
 */
export function assertPlanner1DispatchAllowed(binding: Planner1Binding, purpose = 'planner1_dispatch'): void {
    if (!(PLANNER1_PROVIDERS as readonly string[]).includes(binding.provider))
        throw new DomainError('PLANNER1_PROVIDER_UNKNOWN', 409, `未知的 planner1 上游（${purpose}）：不会尝试其他计费路径。`);
    if(![1,2,3,SEEKER_PLANNER1_BINDING_VERSION].includes(binding.bindingVersion))throw new DomainError('PLANNER1_BINDING_VERSION_UNSUPPORTED',409);
    if (isRetiredProvider(binding.provider,binding.bindingVersion))
        throw new DomainError('PLANNER1_PROVIDER_RETIRED', 409, `planner1 上游 ${binding.provider} 已退役，不能用于新的推理（${purpose}）。旧项目可读历史，但不会自动回退到该账户。`);
    const api=(binding.bindingVersion===2||binding.bindingVersion===SEEKER_PLANNER1_BINDING_VERSION)
        &&(binding.provider==='openai'||binding.provider==='deepseek')&&binding.runner==='http-api'&&binding.authMethod==='api_key';
    const local=binding.bindingVersion===3&&binding.provider==='local'&&binding.runner==='local-http'&&binding.authMethod==='none';
    if (!api&&!local&&(binding.runner !== 'kimi-server' || binding.authMethod !== 'oauth'))
        throw new DomainError('PLANNER1_RUNNER_NOT_ACTIVE', 409, `planner1 运行器 ${binding.runner}/${binding.authMethod} 不是当前活动路线（${purpose}）。`);
}

/**
 * Selection gate for settings/UI edits. Switching *into* a retired provider is
 * refused; an already-retired binding may still be edited in place so existing
 * local configuration stays readable (it can never dispatch either way).
 */
export function assertPlanner1Selectable(current: Planner1Binding, next: Planner1Binding,explicitSelection=false): void {
    if(!explicitSelection&&(current.bindingVersion!==1||next.bindingVersion!==1)
        &&(['provider','runner','authMethod','credentialRef','accountRef','protocolHash'] as const).some(key=>current[key]!==next[key]))
        throw new DomainError('PLANNER1_SELECTION_CONFIRMATION_REQUIRED',409);
    if (!isRetiredProvider(next.provider,next.bindingVersion))
        return;
    const unchanged = current.provider === next.provider && current.authMethod === next.authMethod;
    if (!unchanged)
        throw new DomainError('PLANNER1_PROVIDER_RETIRED', 409, `${next.provider} 已退役：请明确选择 Kimi、官方 API 或本机 Ollama，不会自动沿用旧计费路径。`);
}
