import { existsSync, readFileSync, writeFileSync, mkdirSync,openSync,fsyncSync,closeSync,renameSync,unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROLES, type Config } from '../shared/types.js';
import { normalizeRoleAliasKeys } from '../shared/role-names.js';
import { object, text, integer, choose, publicApiUrl, localProviderApiUrl, magpieProviderApiUrl, loopbackUrl, DomainError, hasSecret, registerCredentialEnv,id } from './security.js';
import { planner1Binding, planner1BindingHash, assertPlanner1Selectable, isRetiredProvider, SEEKER_PLANNER1_BINDING_VERSION, MAGPIE_PLANNER1_BASE_URL, MAGPIE_PLANNER1_PROTOCOL } from './planner1-binding.js';
import { flowCatalog } from './flows.js';
import { LOCAL_PLANNER1_BASE_URL, LOCAL_PLANNER1_KEY_ENV, LOCAL_PLANNER1_PROTOCOL } from './local-planner1-contract.js';
// Clash route: DreamMaker only reads the CURRENT user's CFW top-level routing fields (controller + secret + mixed port).
const defaultClashPath = resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.config', 'clash', 'config.yaml');
export const defaults: Config = { version: 1, clash: { enabled: false, configPath: defaultClashPath, selector: '', node: '', selectionPolicy: 'pinned', expectedMode: 'rule' }, planner1: { authMode: 'api_key', siwcModel: '', siwcProfileId: '', siwcNoncommercialAttested: false, protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: '', keyEnv: 'OPENAI_API_KEY', maxOutputTokens: 2200, maxCallsPerProject: 60, accountRef: '', policyHash: '', protocolHash: '', bindingVersion: 1 }, codex: { command: 'codex', args: ['app-server'], home: '', model: '', permissionProfile: '', policyFile: '', transport: 'stdio', wslCommand: '', wslDistro: '', wslCwdRoot: '', wslBinary: '', wslHome: '' }, dsh: { modulePath: '', model: 'deepseek-flash', keyEnv: 'DEEPSEEK_API_KEY' }, kimi: { baseUrl: 'http://127.0.0.1:58631', timeoutMs: 180000, pollMs: 2000, tokenFile: '', enabled: false, workspace: '' }, nativeAuditPath: '', laya: { mode: 'off', roles: { planner1: 'inherit', planner2: 'inherit', executor: 'inherit', reviewer: 'inherit' }, baseUrl: 'http://127.0.0.1:8765', portFile: '', timeoutMs: 5000, maxQueue: 16, expectedRevision: '', requireTruncationMetadata: true }, limits: { maxRepairs: 3, maxCalls: 30, maxSeconds: 600, stepTimeoutMs: 120000, idleTimeoutMs: 120000 }, independent: { enabled: false, baseUrl: 'https://api.openai.com/v1', model: '', protocol: '', keyEnv: 'OPENAI_API_KEY', maxOutputTokens: 1024, maxRequests: 8 } };
export function parseConfig(raw: unknown): Config {
    const v = object(raw), p = object(v.planner1), c = object(v.codex), d = object(v.dsh), clash = object(v.clash ?? defaults.clash), l = object(v.laya), limits = object(v.limits), roles = object(l.roles), ind = object(v.independent ?? defaults.independent);
    if (v.version !== 1)
        throw new DomainError('CONFIG_VERSION_UNSUPPORTED');
    const declaredPlanner1Provider=p.provider===undefined?undefined:choose(p.provider,['kimi','openai','deepseek','local','siwc','magpie']);
    if(declaredPlanner1Provider==='magpie')magpieProviderApiUrl(text(p.baseUrl,200),text(p.protocol,100));
    else if(declaredPlanner1Provider==='local')localProviderApiUrl(text(p.baseUrl,200),text(p.protocol,100));
    else publicApiUrl(text(p.baseUrl, 200));
    // The independent provider is a public API too: no loopback, no file URL, no credentials in it.
    publicApiUrl(text(ind.baseUrl ?? 'https://api.openai.com/v1', 200));
    loopbackUrl(text(l.baseUrl, 200));
    const clashSection: Config['clash'] = { enabled: clash.enabled === true, configPath: text(clash.configPath ?? defaultClashPath, 1000), selector: text(clash.selector ?? '', 512, true), node: text(clash.node ?? '', 512, true), selectionPolicy: choose(clash.selectionPolicy ?? 'pinned', ['pinned', 'current']) as Config['clash']['selectionPolicy'], expectedMode: choose(clash.expectedMode ?? 'rule', ['rule', 'global']) };
    const result: Config = { version: 1, clash: clashSection, planner1: { authMode: choose(p.authMode ?? 'api_key', ['api_key', 'siwc_plan']), siwcModel: text(p.siwcModel ?? '', 128, true), siwcProfileId: text(p.siwcProfileId ?? '', 120, true), siwcNoncommercialAttested: p.siwcNoncommercialAttested === true, protocol: choose(p.protocol, ['openai-responses', 'chat-completions']), baseUrl: text(p.baseUrl, 200), model: text(p.model, 100, true), keyEnv: text(p.keyEnv, 80), maxOutputTokens: integer(p.maxOutputTokens, 128, 64000), maxCallsPerProject: integer(p.maxCallsPerProject, 1, 1000), provider: p.provider === undefined ? undefined : choose(p.provider, ['kimi', 'openai', 'deepseek', 'local', 'siwc']) as Config['planner1']['provider'], accountRef: text(p.accountRef ?? '', 200, true), policyHash: text(p.policyHash ?? '', 128, true), protocolHash: text(p.protocolHash ?? '', 128, true), bindingVersion: integer(p.bindingVersion ?? 1, 1, 1000) }, codex: { command: text(c.command, 500), args: (c.args as unknown[]).map(x => text(x, 500)), home: text(c.home, 500, true), model: text(c.model, 100, true), permissionProfile: text(c.permissionProfile ?? '', 120, true), policyFile: text(c.policyFile ?? '', 500, true), transport: choose(c.transport ?? 'stdio', ['stdio', 'wsl']) as 'stdio' | 'wsl', wslCommand: text(c.wslCommand ?? '', 300, true), wslDistro: text(c.wslDistro ?? '', 60, true), wslCwdRoot: text(c.wslCwdRoot ?? '', 400, true), wslBinary: text(c.wslBinary ?? '', 400, true), wslHome: text(c.wslHome ?? '', 400, true) }, dsh: { modulePath: text(d.modulePath, 500, true), model: text(d.model, 100), keyEnv: text(d.keyEnv, 80) }, kimi: (() => { const k = object(v.kimi ?? {}); return { baseUrl: String(loopbackUrl(text(k.baseUrl ?? 'http://127.0.0.1:58631', 200) as string)), timeoutMs: integer(k.timeoutMs ?? 180000, 1000, 600000), pollMs: integer(k.pollMs ?? 2000, 100, 30000), tokenFile: text(k.tokenFile ?? '', 500, true), enabled: k.enabled === true, workspace: text(k.workspace ?? '', 500, true) }; })(), nativeAuditPath: text(v.nativeAuditPath, 500, true), laya: { mode: choose(l.mode, ['off', 'shadow', 'advisory']), roles: Object.fromEntries(ROLES.map(role => [role, choose(roles[role], ['inherit', 'off'])])) as Config['laya']['roles'], baseUrl: text(l.baseUrl, 200), portFile: text(l.portFile, 500, true), timeoutMs: integer(l.timeoutMs, 100, 30000), maxQueue: integer(l.maxQueue, 1, 100), expectedRevision: text(l.expectedRevision, 100, true), requireTruncationMetadata: l.requireTruncationMetadata !== false }, limits: { maxRepairs: integer(limits.maxRepairs, 0, 10), maxCalls: integer(limits.maxCalls, 1, 200), maxSeconds: integer(limits.maxSeconds, 10, 21600), stepTimeoutMs: integer(limits.stepTimeoutMs, 1000, 1800000), idleTimeoutMs: integer(limits.idleTimeoutMs ?? 120000, 10000, 900000) }, independent: { enabled: ind.enabled === true, baseUrl: text(ind.baseUrl ?? 'https://api.openai.com/v1', 200), model: text(ind.model ?? '', 100, true), protocol: (ind.protocol === undefined || ind.protocol === '' ? '' : choose(ind.protocol, ['openai-responses', 'chat-completions'])) as '' | 'openai-responses' | 'chat-completions', keyEnv: text(ind.keyEnv ?? 'OPENAI_API_KEY', 80), maxOutputTokens: integer(ind.maxOutputTokens ?? 1024, 128, 16000), maxRequests: integer(ind.maxRequests ?? 8, 1, 100) } };
    for (const n of [result.planner1.keyEnv, result.dsh.keyEnv, result.independent?.keyEnv ?? ''].filter(Boolean)) registerCredentialEnv(n);
    result.pi = (() => { const pi = object(v.pi ?? {}); return { cliPath: text(pi.cliPath ?? '', 500, true), timeoutMs: integer(pi.timeoutMs ?? 900000, 30000, 3600000) }; })();
    if (hasSecret(JSON.stringify(result)))
        throw new DomainError('SECRET_IN_CONFIG');
    return result;
}
export class Settings {
    value: Config;
    constructor(public path: string) { this.value = existsSync(path) ? parseConfig(JSON.parse(readFileSync(path, 'utf8'))) : structuredClone(defaults); }
    public() {
        const binding = planner1Binding(this.value);
        // The trusted CFW config path never leaves the process; the browser only sees the routing selection.
        const { configPath: _trustedClashPath, ...clash } = this.value.clash;
        return {
            config: { ...this.value, clash },
            keyStatus: { planner1: binding.authMethod === 'api_key' ? !!process.env[this.value.planner1.keyEnv] : false, executor: !!process.env[this.value.dsh.keyEnv] },
            planner1Binding: binding,
            planner1BindingHash: planner1BindingHash(binding),
            planner1Retired: isRetiredProvider(binding.provider,binding.bindingVersion),
            planner1RetiredReason: isRetiredProvider(binding.provider,binding.bindingVersion) ? `${binding.provider} 的旧绑定已退役并保留为历史；请明确选择新的方案助手连接，不会自动使用旧计费路径。` : null,
            // The two flows after the frozen spec, resolved by the one server-side resolver so the
            // browser never re-implements the rule that decides whether Laya is actually attached.
            flows: flowCatalog(this.value),
            nativeStatus: 'NOT_VERIFIED'
        };
    }
    private persist(value=this.value) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary=this.path+'.'+id('pending'),fd=openSync(temporary,'wx',0o600);
        try{try{writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,this.path);}
        finally{if(existsSync(temporary))unlinkSync(temporary);}
    }
    /** Explicit provider/authentication consent. No credential value, account scan or model request. */
    selectPlanner1(raw:unknown){
        const input=object(raw);
        if(Object.keys(input).some(key=>!['provider','authentication','model','confirmed','route'].includes(key)))throw new DomainError('PLANNER1_SELECTION_FIELDS_INVALID',400);
        if(input.confirmed!==true)throw new DomainError('PLANNER1_SELECTION_CONFIRMATION_REQUIRED',403);
        // 'seeker_api' selects the Seeker API route (binding version 4): official HTTP API on an api_key
        // credential, with the two built-in skills. 'legacy_api' keeps the earlier version 2 route so an
        // existing configuration is never silently promoted.
        const route=choose(input.route??'legacy_api',['legacy_api','seeker_api']);
        const provider=choose(input.provider,['kimi','openai','deepseek','local','magpie']),authentication=choose(input.authentication,['oauth','api_key','none']);
        if(authentication!==(provider==='kimi'?'oauth':provider==='local'||provider==='magpie'?'none':'api_key'))throw new DomainError('PLANNER1_OFFICIAL_AUTH_UNAVAILABLE',409);
        const current=planner1Binding(this.value),next=structuredClone(this.value);
        next.planner1.provider=provider;next.planner1.model=text(input.model,100);
        if(hasSecret(next.planner1.model))throw new DomainError('PLANNER1_SELECTION_CONTAINS_SECRET',400);
        next.planner1.authMode='api_key'; // Legacy field; actual OAuth/API identity is in planner1Binding.
        if(provider==='magpie'){
            next.planner1.bindingVersion=3;
            next.planner1.protocol=MAGPIE_PLANNER1_PROTOCOL;
            next.planner1.baseUrl=MAGPIE_PLANNER1_BASE_URL;
            // No credential is involved, but the field is a non-empty name by contract; it simply
            // never resolves to a secret for this route.
            next.planner1.keyEnv='MAGPIE_PLANNER1_NO_KEY';
        }else if(provider==='local'){
            next.planner1.bindingVersion=3;
            next.planner1.protocol=LOCAL_PLANNER1_PROTOCOL;
            next.planner1.baseUrl=LOCAL_PLANNER1_BASE_URL;
            next.planner1.keyEnv=LOCAL_PLANNER1_KEY_ENV;
        }else if(provider!=='kimi'){
            next.planner1.bindingVersion=route==='seeker_api'?SEEKER_PLANNER1_BINDING_VERSION:2;
            next.planner1.protocol=provider==='openai'?'openai-responses':'chat-completions';
            next.planner1.baseUrl=provider==='openai'?'https://api.openai.com/v1':'https://api.deepseek.com';
            next.planner1.keyEnv=current.provider===provider&&current.authMethod==='api_key'?this.value.planner1.keyEnv:provider==='openai'?'OPENAI_API_KEY':this.value.dsh.keyEnv;
        }else next.planner1.bindingVersion=1;
        const parsed=parseConfig(next);assertPlanner1Selectable(current,planner1Binding(parsed),true);
        // Preserve previous in-memory state if the filesystem refuses persistence.
        this.persist(parsed);
        this.value=parsed;registerCredentialEnv(parsed.planner1.keyEnv);return this.public();
    }
    attestSiwcNoncommercial(): void {
        const next=structuredClone(this.value);next.planner1.siwcNoncommercialAttested=true;
        this.persist(next);this.value=next;
    }
    selectSiwcProfile(profileId: string): void {
        const next=structuredClone(this.value);
        next.planner1.siwcProfileId = text(profileId, 120);
        next.planner1.siwcModel = '';
        this.persist(next);this.value=next;
    }
    selectSiwcModel(model: string, profileId: string): void {
        if (!this.value.planner1.siwcProfileId || this.value.planner1.siwcProfileId !== profileId) throw new DomainError('SIWC_PROFILE_CHANGED', 409);
        const next=structuredClone(this.value);next.planner1.siwcModel = text(model, 128);
        this.persist(next);this.value=next;
    }
    updateUI(raw: unknown) {
        const v = object(raw), next = structuredClone(this.value);
        // UI cannot choose executables, adapters, credentials, filesystem roots or endpoints.
        // A body may spell this block with the role's product name ("seeker"); the stored
        // field stays planner1, so old clients and already-persisted config are untouched.
        const plannerBlock = v.planner1 === undefined ? v.seeker : v.planner1;
        if (plannerBlock) {
            const p = object(plannerBlock);
            next.planner1.model = text(p.model, 100, true);
            // K02: the browser may name a provider, but only an active one can be selected.
            if (p.provider !== undefined)
                next.planner1.provider = choose(p.provider, ['kimi', 'openai', 'deepseek', 'local', 'siwc']) as Config['planner1']['provider'];
            if (p.authMode !== undefined) next.planner1.authMode = choose(p.authMode, ['api_key', 'siwc_plan']);
            const protocol = choose(p.protocol, ['openai-responses', 'chat-completions']);
            if (protocol !== next.planner1.protocol)
                next.planner1.keyEnv = protocol === 'openai-responses' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY';
            next.planner1.protocol = protocol;
            next.planner1.baseUrl = next.planner1.protocol === 'openai-responses' ? 'https://api.openai.com/v1' : 'https://api.deepseek.com';
        }
        // K02: the retired OpenAI/SIWC planner1 paths must leave the active selection. Switching
        // *into* one is refused here; an already-retired binding may still be edited in place so
        // existing local configuration stays readable. Either way it can never dispatch.
        assertPlanner1Selectable(planner1Binding(this.value), planner1Binding(next));
        if (v.codexModel !== undefined)
            next.codex.model = text(v.codexModel, 100, true);
        // Only the public routing choice is writable here. configPath is trusted server state: it is
        // never accepted from the browser, so a PUT can enable a route but cannot redirect the controller.
        if (v.clash) {
            const c = object(v.clash);
            next.clash.enabled = c.enabled === true;
            next.clash.selector = text(c.selector ?? '', 512, true);
            next.clash.node = text(c.node ?? '', 512, true);
            next.clash.selectionPolicy = choose(c.selectionPolicy ?? next.clash.selectionPolicy ?? 'pinned', ['pinned', 'current']) as Config['clash']['selectionPolicy'];
            next.clash.expectedMode = choose(c.expectedMode ?? next.clash.expectedMode, ['rule', 'global']);
        }
        if (v.laya) {
            const l = object(v.laya);
            next.laya.mode = choose(l.mode, ['off', 'shadow', 'advisory']);
            // Keys may arrive as Seeker/Planner; the config keeps the stable wire ids.
            const rr = normalizeRoleAliasKeys(object(l.roles)) ?? {};
            for (const role of ROLES)
                next.laya.roles[role] = choose(rr[role], ['inherit', 'off']);
        }
        if (v.limits)
            next.limits = object(v.limits) as unknown as Config['limits'];
        const parsed=parseConfig(next);
        this.persist(parsed);this.value=parsed;
        return this.public();
    }
}
