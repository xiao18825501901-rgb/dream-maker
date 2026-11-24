import { RpcPeer,RpcChildError } from './rpc.js';
import { codexLaunch, codexEnv,assertCodexTransportRoute,wslProxyEnvironment,type CodexProxyEnvironmentEvidence,type WslProxyBinding } from './codex-transport.js';
import { childEnv, DomainError } from '../security.js';
import type { Config } from '../../shared/types.js';
import { OwnedCodexSession } from './codex-owned.js';
import type { CodexMetadataObservation, CodexMetadataBucket, CodexMetadataMethod } from '../../shared/codex-metadata.js';
import type { ClashService } from '../clash-service.js';
import { resolveWslProxyBinding } from './codex-wsl-proxy.js';

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const bool = (v: unknown) => typeof v === 'boolean' ? v : null;
const safeId = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:/+-]{1,160}$/.test(v) ? v : null;
type MetadataEnvironment = (extra: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
export interface CodexMetadataReport {
    schema: 'dream-maker.codex-metadata.v1';
    at: string;
    transport: 'stdio' | 'wsl';
    route: CodexProxyEnvironmentEvidence;
    account: { type: string | null };
    configuredModel: string;
    models: { id: string | null; model: string | null }[];
    configuredModelListed: boolean;
    catalogComplete: boolean;
    quota: { ordinaryUsageAllowed: boolean | null; buckets: CodexMetadataBucket[] };
    errors: { method: CodexMetadataMethod; code: string; category: string }[];
    actualServedModel: 'NOT_VERIFIED';
    modelTurnsRequested: 0;
    cleanupReturned: boolean;
    processEvidence?: Record<string, unknown>;
}
function failureCategory(error: unknown) {
    if(error instanceof RpcChildError)return error.evidence.failureCategories.filter(v=>v!=='DSH_HOST_TIMEOUT').join('|')||'UNCLASSIFIED';
    const message = error instanceof Error ? error.message : '';
    // Categorize inside the trusted boundary; never return an authentication response/message.
    const tests: [string, RegExp][] = [['AUTH_EXPIRED', /expired|refresh_token_reused|refresh token/i], ['AUTH_REQUIRED', /not logged|login required|sign.in|authentication required/i],
        ['AUTH_TOKEN', /token|credential/i], ['NETWORK', /connect|network|dns|timed? ?out|request failed|error sending request/i], ['UNSUPPORTED', /unknown variant|unknown field|invalid params|unsupported|not implemented|method not found/i],
        ['FORBIDDEN', /forbidden|403/i], ['UNAUTHORIZED', /unauthorized|401/i], ['ACCOUNT', /account/i]];
    return tests.filter(([, re]) => re.test(message)).map(([name]) => name).join('|') || 'UNCLASSIFIED';
}
/** Inventory only: the only RPC methods here cannot create a thread or model turn. No auth data leaves this boundary. */
export async function readCodexMetadata(config: Config, workspace: string, controlledEnvironment?: MetadataEnvironment, signal?:AbortSignal): Promise<CodexMetadataReport> {
    // A metadata process is still a network client. When CFW routing is enabled it must
    // receive the exact lease-bound environment from ClashService, not whatever proxy
    // variables happened to exist in the caller's process.
    if(config.clash.enabled&&typeof controlledEnvironment!=='function')
        throw new DomainError('CODEX_CONTROLLED_ENVIRONMENT_REQUIRED',409);
    let environment=controlledEnvironment?controlledEnvironment(codexEnv(config)):childEnv(codexEnv(config));
    let wslProxy:WslProxyBinding|undefined;
    if((config.codex.transport??'stdio')==='wsl'&&config.clash.enabled){
        wslProxy=await resolveWslProxyBinding(config,workspace,environment,signal);
        environment={...environment,...wslProxyEnvironment(wslProxy)};
    }
    const route=assertCodexTransportRoute(config,environment);
    const owned=(config.codex.transport??'stdio')==='wsl'?new OwnedCodexSession(config,workspace,workspace,wslProxy):undefined;
    const launch = owned?.launch??codexLaunch(config, workspace,{wslProxy});
    const args = [...launch.args];
    const server = args.lastIndexOf('app-server');
    if (server < 0) throw new DomainError('CODEX_APP_SERVER_REQUIRED', 409);
    // A dedicated file-backed home cannot fall through to the owner's daily keychain credentials.
    if(!owned)args.splice(server, 0, '-c', 'cli_auth_credentials_store="file"');
    const peer = new RpcPeer(launch.command, args, { cwd: launch.cwd ?? workspace, env: environment }, 12000);
    const report: CodexMetadataReport = { schema: 'dream-maker.codex-metadata.v1', at: new Date().toISOString(), transport: launch.transport, route,
        account: { type: null as string | null }, configuredModel: config.codex.model,
        models: [] as {id: string | null; model: string | null}[], configuredModelListed: false, catalogComplete: false,
        quota: {ordinaryUsageAllowed: null, buckets: []},
        errors: [], actualServedModel: 'NOT_VERIFIED', modelTurnsRequested: 0, cleanupReturned: false };
    const read = async (method: CodexMetadataMethod, params: Record<string, unknown>) => {
        try { return await peer.request(method, params); }
        catch (error) { report.errors.push({method, code: error instanceof DomainError ? error.code : 'CODEX_METADATA_UNAVAILABLE', category: failureCategory(error)}); return {}; }
    };
    try {
        await peer.request('initialize', {clientInfo: {name: 'dream_maker_readonly_inventory', version: '0.1.0'}, capabilities: {experimentalApi: true}});
        peer.notify('initialized', {});
        await owned?.pin();
        report.account.type = safeId(obj((await read('account/read', {refreshToken: false})).account).type);
        const listed = await read('model/list', {limit: 100, includeHidden: true});
        if (Array.isArray(listed.data)) report.models = listed.data.slice(0, 100).map(v => ({id: safeId(obj(v).id), model: safeId(obj(v).model)}));
        report.configuredModelListed = report.models.some(v => v.model === config.codex.model);
        report.catalogComplete = Array.isArray(listed.data) && listed.nextCursor == null;
        const quota = await read('account/rateLimits/read', {});
        report.quota.ordinaryUsageAllowed = bool(quota.ordinaryUsageAllowed);
        report.quota.buckets = [quota.rateLimits, ...Object.values(obj(quota.rateLimitsByLimitId))].filter(v => v && typeof v === 'object').slice(0, 24).map(value => {
            const b = obj(value), credits = obj(b.credits);
            return {limitId: safeId(b.limitId), spendControlReached: bool(b.spendControlReached), hasCredits: bool(credits.hasCredits), unlimitedCredits: bool(credits.unlimited)};
        });
    } catch (error) { report.errors.push({method: 'initialize', code: error instanceof DomainError ? error.code : 'CODEX_METADATA_UNAVAILABLE', category: failureCategory(error)}); }
    finally { if(owned)await owned.finish(peer);else await peer.finish();report.cleanupReturned = true;report.processEvidence=owned?.cleanupEvidence; }
    return report;
}

/** CFW is a process boundary, not just an HTTP-fetch setting. A metadata inventory
 * may start Codex only while the same selector lease supplies its child environment. */
export async function readCodexMetadataWithRoute(
    config: Config,
    workspace: string,
    clash: Pick<ClashService, 'withRun' | 'childEnvironment'>,
    signal: AbortSignal,
    reader = readCodexMetadata
): Promise<CodexMetadataReport> {
    if (!config.clash.enabled) return reader(config, workspace);
    return clash.withRun('codex-metadata-inventory', signal, () =>
        reader(config, workspace, extra => clash.childEnvironment(extra), signal)
    );
}

export interface CodexMetadataProjectionContext {
    configurationFingerprint: string | null;
    currentConfiguration: boolean;
    controller: CodexMetadataObservation['controller'];
}

export function codexMetadataObservation(
    report: CodexMetadataReport,
    context: CodexMetadataProjectionContext
): CodexMetadataObservation {
    const accountType = report.account.type === 'chatgpt' ? 'chatgpt' :
        report.account.type === 'apiKey' ? 'apiKey' : 'unknown';
    const accountObserved = accountType !== 'unknown';
    const usage = report.quota.ordinaryUsageAllowed === null ? 'UNKNOWN' :
        report.quota.ordinaryUsageAllowed ? 'ALLOWED' : 'RESTRICTED';
    const modelListed = report.models.length === 0 && report.errors.some(error => error.method === 'model/list') ?
        null : report.configuredModelListed;
    const routeState = report.route.path === 'CHILD_ENV_MATCH' ?
        'CFW_LEASE_BOUND_CHILD_ENVIRONMENT' :
        report.route.path === 'UNMANAGED_ENV_PRESENT' ? 'UNMANAGED_ENV_PRESENT' : 'DM_ROUTE_DISABLED';
    const blockedByUsage = usage === 'RESTRICTED';
    const blockedByModel = modelListed === false;
    const metadataClean = report.cleanupReturned && report.modelTurnsRequested === 0;
    const dispatchGate = !metadataClean ? 'UNKNOWN' :
        blockedByUsage ? 'BLOCKED_BY_USAGE' :
        blockedByModel ? 'BLOCKED_BY_MODEL' :
        usage === 'ALLOWED' && modelListed === true ? 'NOT_BLOCKED_BY_METADATA' : 'UNKNOWN';
    return {
        schema: 'dream-maker.codex-metadata-observation.v1',
        observedAt: report.at,
        currentConfiguration: context.currentConfiguration,
        configurationFingerprint: context.configurationFingerprint,
        route: {
            state: routeState,
            proxyEndpoint: report.route.proxyEndpoint,
            environmentFingerprint: report.route.proxyFingerprint
        },
        controller: context.controller,
        account: {
            state: accountObserved ? 'OBSERVED' : 'UNKNOWN',
            type: accountType,
            authentication: accountObserved ? 'AUTHENTICATED_METADATA_ONLY' : 'NOT_VERIFIED'
        },
        model: {
            configured: report.configuredModel,
            listed: modelListed,
            catalogComplete: report.catalogComplete,
            actualServedModel: 'NOT_VERIFIED'
        },
        usage: {
            ordinaryUsageAllowed: report.quota.ordinaryUsageAllowed,
            state: usage,
            buckets: report.quota.buckets.map(bucket => ({
                limitId: bucket.limitId,
                spendControlReached: bucket.spendControlReached,
                hasCredits: bucket.hasCredits,
                unlimitedCredits: bucket.unlimitedCredits
            }))
        },
        serviceEligibility: usage === 'RESTRICTED' ? {
            state: 'USAGE_RESTRICTED',
            summary: '官方账户元数据明确显示当前普通 Codex 使用受限；这不是新的地区拒绝，也不能派发模型回合。'
        } : {
            state: 'NOT_VERIFIED',
            summary: '元数据读取没有证明当前账户具有真实项目或模型回合资格；实际派发仍由原账户与预算门禁判断。'
        },
        inference: {
            state: 'NOT_RUN',
            summary: '本次只读取账户、模型目录和额度元数据；没有创建 thread/turn，也没有模型推理。'
        },
        dispatchGate: {
            state: dispatchGate,
            summary: dispatchGate === 'BLOCKED_BY_USAGE' ?
                '账户元数据已阻止普通 Codex 派发；不得重复请求或切换节点绕过。' :
                dispatchGate === 'BLOCKED_BY_MODEL' ?
                    '当前配置模型不在官方返回的模型目录中；不会静默切换模型。' :
                    dispatchGate === 'NOT_BLOCKED_BY_METADATA' ?
                        '元数据没有发现阻止项，但不等于服务资格或真实推理已通过；原派发门禁仍须执行。' :
                        '元数据尚未形成可派发结论；保持未知，不把网络可达当成模型可用。'
        },
        errors: report.errors.map(error => ({
            method: error.method,
            code: error.code,
            category: error.category
        })),
        modelTurnsRequested: 0,
        cleanupReturned: report.cleanupReturned
    };
}
