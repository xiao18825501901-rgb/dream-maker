import {DomainError} from './security.js';
import {readDesktopMagpieCatalog} from './flow/custom-magpie-catalog.js';

/**
 * Seeker model catalog.
 *
 * The browser may pick a model, but it may not invent one. Two sources are
 * possible, and they never blend:
 *
 * - classic: the official HTTP API route of planner1-binding (OpenAI Responses
 *   or DeepSeek chat-completions). Only names this build already registers
 *   elsewhere are listed; the picker is not a place to try a guessed ID.
 * - custom: the local Magpie /v1/models catalog, filtered by the model's
 *   owned_by prefix (for example packyapi/* or deepseek/*). A transport error
 *   is propagated as its DomainError code; an unreachable Magpie is never
 *   disguised as an empty catalog.
 */
export type Planner1ModelSource = 'classic' | 'custom';
export interface Planner1ModelEntry {
    id: string;
    label: string;
    context: number | null;
    output: number | null;
    notes: string;
    available: boolean;
}
export interface Planner1ModelCatalog {
    schema: 'dream-maker.planner1-models.v1';
    provider: string;
    source: Planner1ModelSource;
    models: Planner1ModelEntry[];
}
interface RegisteredModel {
    id: string;
    label: string;
    context: number | null;
    output: number | null;
    notes: string;
}
/**
 * Registered official names only. Provenance for the metadata:
 * - deepseek-flash: DeepSeek official ID in docs/local-binding/evidence/deepseek-models.json;
 *   the 1,048,576 context comes from docs/official-prices/deepseek-flash-cny-20261013.json.
 * - deepseek-v4-pro: registered in src/server/flow/custom-role-identity.ts CUSTOM_ROLE_MODELS.
 * - gpt-6-luna: registered in src/server/providers/codex-magpie-catalog.ts;
 *   context_window 272000 comes from that same reviewed catalog.
 * Unknown context/output stays null instead of being guessed.
 */
const CLASSIC: Readonly<Record<'deepseek' | 'openai', readonly RegisteredModel[]>> = Object.freeze({
    deepseek: Object.freeze([
        {id:'deepseek-flash', label:'DeepSeek V4.1 Flash', context:1048576, output:8192,
         notes:'已登记 DeepSeek 官方 chat-completions 模型；输出上限按本机已登记的 8192 保守展示，实际派发仍受价格与预算门禁。'},
        {id:'deepseek-v4-pro', label:'DeepSeek V4 Pro', context:null, output:null,
         notes:'已登记 DeepSeek 官方 chat-completions 模型；上下文与输出上限未登记，实际派发仍受价格与预算门禁。'}
    ]),
    openai: Object.freeze([
        {id:'gpt-6-luna', label:'GPT-6 Luna', context:272000, output:null,
         notes:'已登记 OpenAI Responses 模型（Codex 目录 context_window=272000）；输出上限由当前配置管理。'}
    ])
});
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SEEKER_PROTOCOLS = new Set(['chat-completions', 'openai-responses']);
export function planner1ClassicModels(provider: string): Planner1ModelEntry[] {
    if (!(provider in CLASSIC)) throw new DomainError('PLANNER1_MODEL_PROVIDER_UNKNOWN', 400, `未知的 Seeker 官方 API 服务商：${provider.slice(0, 80)}。`);
    return (CLASSIC[provider as 'deepseek' | 'openai']).map(model => ({...model, available:true}));
}
/** Read-only catalog. It calls no model and spends no budget. */
export async function planner1ModelCatalog(input: {provider:string;source?:string;port?:number;signal?:AbortSignal}): Promise<Planner1ModelCatalog> {
    const provider = input.provider;
    if (!PROVIDER.test(provider)) throw new DomainError('PLANNER1_MODEL_PROVIDER_INVALID', 400, 'provider 必须是不含路径分隔符的已登记服务商标识。');
    const source = input.source ?? 'classic';
    if (source !== 'classic' && source !== 'custom') throw new DomainError('PLANNER1_MODEL_SOURCE_INVALID', 400);
    if (source === 'classic') return {schema:'dream-maker.planner1-models.v1', provider, source, models: planner1ClassicModels(provider)};
    const catalog = await readDesktopMagpieCatalog(input.port ?? 3425, input.signal);
    const models = catalog.models.filter(model => model.provider === provider).map(model => {
        const protocols = model.protocols;
        const available = protocols.some(protocol => SEEKER_PROTOCOLS.has(protocol));
        return {
            id: model.id,
            label: model.id,
            context: null,
            output: null,
            notes: available
                ? `桌面 Magpie 目录 · 协议 ${protocols.join('/')}`
                : `桌面 Magpie 模型未声明 Seeker 可用的 chat-completions/openai-responses 协议（${protocols.join('/') || '无'}）。`,
            available
        };
    });
    return {schema:'dream-maker.planner1-models.v1', provider, source:'custom', models};
}
