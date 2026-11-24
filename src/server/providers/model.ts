import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {assertPaidDispatchAllowed} from '../zero-usage.js';
import { DomainError, providerApiUrl, localProviderApiUrl, jsonFetch, object, hash, text, hasSecret, redact, registerCredentialEnv } from '../security.js';
import { purposeOfTask, skillForRequest } from '../skills.js';
import type { Config, Usage } from '../../shared/types.js';
import type { SiwcPlanner1Provider } from '../siwc/planner1-provider.js';
import { planner1Binding } from '../planner1-binding.js';
import type { NativeBudget, NativePrice,ProbeBudgetPermit } from '../native-budget.js';
import { LocalPlanner1Runtime } from '../local-planner1.js';
export type PaidRequestGuard = (route: { baseUrl: string; model: string; protocol: string; maxOutputTokens: number }) => {
    settle(usage: Record<string, unknown> | null, outcome: string): void;
    signal?:AbortSignal;
    ledgerRequestId?:string;
};
export function nativePlannerGuard(budget: NativeBudget, quote: () => NativePrice,permit?:ProbeBudgetPermit): PaidRequestGuard {
    return route => {
        const price = quote();
        const base=route.baseUrl.replace(/\/$/,''),responses=route.protocol==='openai-responses'&&base==='https://api.openai.com/v1';
        const chat=route.protocol==='chat-completions'&&['https://api.deepseek.com','https://api.deepseek.com/v1'].includes(base);
        if ((!responses&&!chat)||price.provider!==(responses?'openai-official':'deepseek-official')||price.model!==route.model)
            throw new DomainError('NATIVE_PRICE_ROUTE_MISMATCH', 409);
        const reservation = budget.reserve('planner1', price, route.maxOutputTokens,permit);
        return { ledgerRequestId:reservation.id,settle(usage, outcome) {
            const details = usage?.input_tokens_details as Record<string, unknown> | undefined;
            // Missing cache metadata is charged at the more expensive cache-miss rate.
            budget.settle(reservation.id, usage ? {
                inputTokens:(responses?usage.input_tokens:usage.prompt_tokens) as number, outputTokens:(responses?usage.output_tokens:usage.completion_tokens) as number,
                cacheHitTokens:(responses?details?.cached_tokens:usage.prompt_cache_hit_tokens)===undefined?0:(responses?details?.cached_tokens:usage.prompt_cache_hit_tokens) as number
            } : null, outcome);
        } };
    };
}
export interface Completion {
    data: Record<string, unknown>;
    usage: Usage;
    observation?:{
        runner:'LLM_API'|'LOCAL_HTTP';provider:'openai-official'|'deepseek-official'|'local-ollama';authentication:'API_KEY'|'NONE';
        model:string;protocol:string;responseId:string;status:'completed';
        ledgerRequestId:string|null;responseObjectHash:string;
    };
}
export class ModelProvider {
    constructor(private config: () => Config, private root: string, private request = jsonFetch, private paidGuard?: PaidRequestGuard, private siwc?: SiwcPlanner1Provider,
        private localPlanner1 = new LocalPlanner1Runtime(request)) { registerCredentialEnv(config().planner1.keyEnv); }
    private inFlight=0;
    get activeCalls():number { return this.inFlight; }
    async complete(payload: unknown, signal?: AbortSignal, onDelta?: (value:string)=>void): Promise<Completion> {
        this.inFlight++;
        try {return await this.completeInternal(payload,signal,onDelta);} finally {this.inFlight--;}
    }
    async probe(challenge:string,signal:AbortSignal):Promise<Completion>{
        if(!/^DM_PROBE_[a-f0-9]{32}$/.test(challenge))throw new DomainError('NATIVE_PROBE_CHALLENGE_INVALID',409);
        if(this.config().planner1.authMode==='siwc_plan')throw new DomainError('SIWC_PROBE_METADATA_REQUIRED',409);
        this.inFlight++;
        try{return await this.completeInternal({task:'minimum_probe',challenge},signal,undefined,challenge);}finally{this.inFlight--;}
    }
    private async completeInternal(payload: unknown, signal?: AbortSignal, onDelta?: (value:string)=>void,probe?:string): Promise<Completion> {
        // K02 route split: this class is the LEGACY api_key HTTP transport. A Kimi binding must be
        // served by the dedicated KimiRunner, so reaching this transport under a Kimi binding is a
        // route mismatch (fail closed), not a silent fallback to an HTTP client.
        const currentBinding=planner1Binding(this.config());
        if (currentBinding.provider === 'kimi')
            throw new DomainError('PLANNER1_RUNNER_ROUTE_MISMATCH', 409, '当前 planner1 绑定是 Kimi 专用运行器；旧 HTTP 客户端不得代替它执行推理。');
        const c = structuredClone(this.config().planner1),binding=hash(c);
        // Which built-in skill this request carries is decided by its purpose, never by guessing from
        // a task name: the complete-plan path sends project_plan and must load prompt-optimizer.
        const task = String(object(payload).task), purpose = purposeOfTask(object(payload).task), skill = skillForRequest(this.root, purpose);
        const skills = skill ? [{ id: skill.id, sha256: skill.sha256, purpose: skill.purpose }] : [];
        // THEIRS' per-task response contracts, stated once so both dispatch paths say the same thing:
        // a complete plan must not be mistaken for an optimizer summary, and the two chat-side rounds
        // carry their own exact JSON shapes.
        const taskNote = (task === 'project_plan' ? '\nFor project_plan, use the complete project_plan JSON shape requested by the controller. The optimizer summary-request fields do not replace that contract; preserve user requirements and provenance exactly.' : '') +
            (task === 'question_help' ? '\nFor question_help, return {"explanation":"..."}; explain the current question without creating a question or submitting an answer.' : '') +
            (task === 'review_feedback' ? '\nFor review_feedback, return JSON {summary:string,blockers:string[],options:string[],question:string,needsConfirmation:boolean}. Explain the supplied settled review without approving, accepting, submitting answers or starting work.' : '');
        if (c.authMode === 'siwc_plan') {
            if (!this.siwc) throw new DomainError('SIWC_PROVIDER_UNAVAILABLE',503);
            const content = JSON.stringify(payload);
            if (content.length>80000 || hasSecret(content)) throw new DomainError('SIWC_INPUT_UNSAFE',400);
            const instructions = readFileSync(resolve(this.root, 'prompts/planner1.md'), 'utf8') + (skill ? '\n\n' + skill.content : '') + taskNote;
            const out = await this.siwc.complete(payload,instructions,signal,onDelta);
            return { ...out, usage: { ...out.usage, ...(purpose ? { purpose } : {}), ...(skills.length ? { skills } : {}) } };
        }
        if (!c.model)
            throw new DomainError('PLANNER1_MODEL_REQUIRED', 409, '请在角色配置中填写账户真实可用的模型 ID。');
        const local=currentBinding.provider==='local';
        const key=local?'':process.env[c.keyEnv]??'';
        if (!local&&!key)
            throw new DomainError('PLANNER1_KEY_MISSING', 409, `请在启动服务的本地环境设置 ${c.keyEnv}；不要在聊天或界面粘贴明文 Key。`);
        const content = JSON.stringify(payload);
        if (content.length > 80000)
            throw new DomainError('PROMPT_INPUT_TOO_LARGE', 413);
        if (hasSecret(content))
            throw new DomainError('SECRET_IN_PROMPT', 400);

        const instructions = probe?'Return exactly this JSON object: '+JSON.stringify({probe})+'. No tools or other output.':
            readFileSync(resolve(this.root, 'prompts/planner1.md'), 'utf8') + (skill ? '\n\n' + skill.content : '') + taskNote;
        if(local)localProviderApiUrl(c.baseUrl,c.protocol);else providerApiUrl(c.baseUrl, c.protocol);
        const base = c.baseUrl.replace(/\/$/, '');
        const maxOutputTokens=probe?Math.min(c.maxOutputTokens,128):c.maxOutputTokens;
        // A local model at temperature 0 reproduces its previous answer verbatim, which the duplicate-question
        // gate then rejects forever: the interview stalls at question 2 with no way forward that is not a retry.
        // Sampling is only relaxed for the local loopback runtime; paid providers keep the default they publish.
        const localSampling = local ? { temperature: 0.8, top_p: 0.95, frequency_penalty: 0.4 } : {};
        const body = c.protocol === 'openai-responses' ? { model: c.model, instructions, input: content, max_output_tokens: maxOutputTokens, store: false, text: { format: { type: 'json_object' } }, ...localSampling } : { model: c.model, messages: [{ role: 'system', content: instructions }, { role: 'user', content }], max_tokens: maxOutputTokens, response_format: { type: 'json_object' }, ...localSampling };
        if(local)await this.localPlanner1.assertReady(c.model,signal);
        // A paid planning turn legitimately streams for minutes; the old 60 s ceiling aborted it mid-flight with
        // a bare TimeoutError. The pipeline already enforces its own 180 s deadline, so this bound matches it
        // instead of pre-empting a healthy request.
        const budgetMs=local?180000:180000;
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]) : AbortSignal.timeout(budgetMs);
        // Zero-usage deployments must fail before any reservation or network call.
        assertPaidDispatchAllowed(local);
        const ticket = local?undefined:this.paidGuard?.({ baseUrl: base, model: c.model, protocol: c.protocol, maxOutputTokens });
        if (!local&&!ticket) throw new DomainError('NATIVE_BUDGET_REQUIRED', 409, 'Paid API dispatch requires an authorized monetary reservation guard.');
        let result: Record<string, unknown>;
        try {
            const headers:Record<string,string>={'content-type':'application/json'};
            if(!local)headers.authorization=`Bearer ${key}`;
            result = await this.request(base + (c.protocol === 'openai-responses' ? '/responses' : '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), signal: ticket?.signal?AbortSignal.any([combined,ticket.signal]):combined });
        } catch (e) { ticket?.settle(null, 'FAILED_OR_DISCONNECTED'); throw e; }
        ticket?.settle(result.usage && typeof result.usage === 'object' ? result.usage as Record<string, unknown> : null, 'RESPONSE_RECEIVED');
        if(combined.aborted||ticket?.signal?.aborted)throw new DomainError('MODEL_REQUEST_CANCELLED',409);
        if(hash(this.config().planner1)!==binding)throw new DomainError('MODEL_CONFIG_CHANGED',409);
        if(c.protocol==='openai-responses'&&result.status!=='completed')throw new DomainError('MODEL_OUTPUT_INCOMPLETE',502);
        if(c.protocol==='chat-completions'){
            const choices=result.choices;
            if(!Array.isArray(choices)||choices.length!==1||object(choices[0]).finish_reason!=='stop'){
                // Name the observed finish reason on stderr: an operator facing "incomplete" cannot tell a
                // length cut from a filtered or empty answer, and the client-facing code must stay stable.
                const reason=Array.isArray(choices)&&choices.length?String(object(choices[0]).finish_reason??'none'):'no-choices';
                process.stderr.write('MODEL_FINISH_REASON '+JSON.stringify({model:String(object(result).model??''),finishReason:reason,count:Array.isArray(choices)?choices.length:0})+'\n');
                throw new DomainError('MODEL_OUTPUT_INCOMPLETE',502);
            }
        }
        if(result.model!==c.model)throw new DomainError('MODEL_ACTUAL_ROUTE_MISMATCH',502);
        if(typeof result.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(result.id)||hasSecret(result.id)||!local&&result.id.includes(key))throw new DomainError('MODEL_RESPONSE_ID_REQUIRED',502);
        let raw = '';
        if (c.protocol === 'openai-responses') {
            for (const out of Array.isArray(result.output) ? result.output : []) {
                const o = object(out);
                for (const part of Array.isArray(o.content) ? o.content : []) {
                    const p = object(part);
                    if (p.type === 'output_text' && typeof p.text === 'string')
                        raw += p.text;
                }
            }
            if (result.status && result.status !== 'completed')
                throw new DomainError('MODEL_OUTPUT_INCOMPLETE', 502);
        }
        else {
            const choices = result.choices as {
                message?: {
                    content?: string;
                };
                finish_reason?: string;
            }[];
            raw = choices?.[0]?.message?.content ?? '';
            if (choices?.[0]?.finish_reason === 'length')
                throw new DomainError('MODEL_OUTPUT_INCOMPLETE', 502);
        }
        // A model that fences its JSON or adds one sentence of preamble is answering correctly; failing
        // the whole turn on that teaches nothing. Take the outermost object only, never invent fields,
        // and keep MODEL_OUTPUT_NOT_JSON for text that holds no JSON object at all.
        const extractJsonObject = (text: string): string => {
            let t = text.trim();
            const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fence) t = fence[1].trim();
            const start = t.indexOf('{');
            if (start < 0) return t;
            let depth = 0, inString = false, escaped = false;
            for (let i = start; i < t.length; i++) {
                const c = t[i];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (c === '\\') escaped = true;
                    else if (c === '"') inString = false;
                    continue;
                }
                if (c === '"') { inString = true; continue; }
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
            }
            return t.slice(start);
        };
        let data: Record<string, unknown>;
        try {
            data = object(JSON.parse(redact(extractJsonObject(raw))));
        }
        catch {
            throw new DomainError('MODEL_OUTPUT_NOT_JSON', 502);
        }
        const usage = object(result.usage ?? {});
        const count = (...keys: string[]) => { for (const k of keys)
            if (typeof usage[k] === 'number' && Number.isSafeInteger(usage[k]) && Number(usage[k])>=0)
                return usage[k] as number; return null; };
        // The ledger has to say which Seeker request was paid for, and which pinned skill body came
        // with it; otherwise a question and a complete plan are indistinguishable charges.
        return { data, usage: { role: 'planner1', inputTokens: count('input_tokens', 'prompt_tokens'), outputTokens: count('output_tokens', 'completion_tokens'), costUsd: null, source: 'PROVIDER', requestId: result.id,
            ...(probe ? {} : purpose ? { purpose } : {}), ...(probe || !skills.length ? {} : { skills }) },
            observation:local?{runner:'LOCAL_HTTP',provider:'local-ollama',authentication:'NONE',
                model:result.model as string,protocol:c.protocol,responseId:result.id,status:'completed',ledgerRequestId:null,responseObjectHash:hash(result)}:
                {runner:'LLM_API',provider:new URL(c.baseUrl).hostname==='api.openai.com'?'openai-official':'deepseek-official',authentication:'API_KEY',
                model:result.model as string,protocol:c.protocol,responseId:result.id,status:'completed',ledgerRequestId:ticket?.ledgerRequestId??null,responseObjectHash:hash(result)} };
    }
    async models(): Promise<unknown> {
        if (planner1Binding(this.config()).provider === 'kimi')
            throw new DomainError('PLANNER1_RUNNER_ROUTE_MISMATCH', 409, '当前 planner1 绑定是 Kimi 专用运行器；模型目录必须来自该运行器，而不是旧 HTTP 客户端。');
        const c = this.config().planner1;
        if (c.authMode === 'siwc_plan') throw new DomainError('SIWC_USE_DEDICATED_MODEL_CATALOG',409);
        const local=planner1Binding(this.config()).provider==='local',key=local?'':process.env[c.keyEnv];
        if (!local&&!key)
            throw new DomainError('PLANNER1_KEY_MISSING', 409);
        if(local)localProviderApiUrl(c.baseUrl,c.protocol);else providerApiUrl(c.baseUrl, c.protocol);
        const data = await this.request(c.baseUrl.replace(/\/$/, '') + '/models', { headers: local?{}:{ authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
        return { models: (Array.isArray(data.data) ? data.data : []).map(x => { const o = object(x); return { id: text(o.id, 200), name: typeof o.name === 'string' ? o.name : o.id }; }), checkedAt: new Date().toISOString() };
    }
}
