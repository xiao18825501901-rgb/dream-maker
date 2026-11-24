import { DomainError, jsonFetch, hash, redact, text, object } from '../security.js';
import type { AgentInput, AgentOutput, Config, Runner, Usage } from '../../shared/types.js';

// A second, INDEPENDENT model provider for the two roles that are otherwise bound to the Codex
// subscription CLI. Requests go through the injected trusted transport (in the app that is the Clash
// transport, so the run's selector lease and its exit verification apply), the conversation is kept per
// role, and no tools are exposed: a planner/reviewer turn is text in, text out.
//
// Two wire shapes, because they are not interchangeable: OpenAI's Responses API (api.openai.com) and
// the classic OpenAI-compatible chat-completions shape (every other vendor). The shape decides the path,
// the request body and the usage field names, so it is configuration, not a guess made at runtime.
//
// Deliberate non-behaviours:
// - disabled is disabled: an enabled-but-unconfigured section throws instead of quietly using Codex,
//   because a silent fallback would make the provider recorded in a receipt a lie;
// - the credential is read from the environment at call time and never stored, logged or echoed;
// - requests are counted and capped in-process (maxRequests), because the owner's uncapped
//   authorization covers official DeepSeek only.

export type IndependentRequest = (url: string, init: RequestInit, maxBytes?: number) => Promise<Record<string, unknown>>;
export type IndependentRole = 'planner2' | 'reviewer';
export type IndependentReasoningEffort = 'low' | 'medium' | 'high';

type Wire = 'openai-responses' | 'chat-completions';
const wireFor = (baseUrl: string, declared: '' | Wire | undefined): Wire => {
    if (declared === 'openai-responses' || declared === 'chat-completions') return declared;
    try { return new URL(baseUrl).hostname === 'api.openai.com' ? 'openai-responses' : 'chat-completions'; }
    catch { return 'chat-completions'; }
};

// The role contract has to live here, because the engine's planner2/reviewer prompts carry the SPEC, not
// the schema it validates. Two rules learned the hard way:
//  1. an instruction that imposes a shape unconditionally breaks the minimum probe, which asks for a bare
//     nonce and got {"response":"DM_PROBE_..."} instead — so every contract ends with 'unless the user
//     message asks for a different exact output, obey the user message';
//  2. without a contract the planning turn returns prose and the run dies as
//     AGENT_STRUCTURED_OUTPUT_INVALID, which is what the first live run did.
const ROLE_INSTRUCTION: Record<string, string> = {
    planner2: [
        'You are the second planner of a small engineering team.',
        'No tools are available in this role; never emit tool calls.',
        'For a planning turn reply with ONE JSON object and nothing else — no prose, no markdown fences:',
        '{"tasks":[{"id":"T1","title":"what to build","dependsOn":[],"requirementIds":["R001"],"acceptance":["how this task is checked"]}]}',
        'Rules: ids are unique short strings; dependsOn references earlier ids and must be acyclic; requirementIds must only use ids from the spec; every requirement id must appear in at least one task; acceptance is non-empty.',
        'Each task must be one coherent, independently verifiable slice that one executor turn can finish in at most 8 tool calls; split broad setup, data, UI, integration and verification work instead of producing a mega-task.',
        'If the user message asks for a different exact output (for example to return a single token), obey the user message instead.'
    ].join(' '),
    reviewer: [
        'You are the independent reviewer of a small engineering team.',
        'No tools are available in this role; never emit tool calls.',
        'For a review turn reply with ONE JSON object and nothing else — no prose, no markdown fences:',
        '{"verdict":"PASS","findings":[]}',
        'Acceptance items marked USER_CONFIRMED are the binding requirements. Material labelled AI_SUGGESTION, 假设 or DESIGN_ASSUMPTION was never accepted by the owner: it is not a requirement, so disagreeing with it is not a finding. When the acceptance items and a suggestion conflict, the acceptance items win.',
        'verdict is PASS, CHANGES_REQUESTED or BLOCKED. A PASS must carry zero findings. Each finding is {"id":"F1","severity":"critical|high|medium|low","description":"...","evidence":"..."} with unique ids. Judge only the material in the user message; do not invent tests you did not see.',
        'If the user message asks for a different exact output (for example to return a single token), obey the user message instead.'
    ].join(' '),
};

const str = (value: unknown): string => typeof value === 'string' ? value : '';
const int = (value: unknown): number | null => Number.isInteger(value) ? Number(value) : null;

export class IndependentRunner implements Runner {
    private readonly threads = new Map<string, { id: string; turns: { role: string; content: string }[] }>();
    private requests = 0;
    constructor(
        private config: () => Config,
        private request: IndependentRequest = jsonFetch,
        private secret?: (name: string) => string | undefined,
        private requestForRole?: (role: IndependentRole) => IndependentRequest,
        private reasoningEffort?: IndependentReasoningEffort
    ) { }
    /** Requests actually sent, so a caller reports cap usage instead of assuming it. */
    get requestCount(): number { return this.requests; }
    private section() {
        const section = this.config().independent;
        if (!section || section.enabled !== true) throw new DomainError('INDEPENDENT_PROVIDER_DISABLED', 409, '第二个独立模型未启用；启用前不会用别的 provider 顶替这两个角色。');
        if (!section.model) throw new DomainError('INDEPENDENT_MODEL_REQUIRED', 409, '启用独立模型必须指定 model。');
        return section;
    }
    private key(name: string): string {
        const value = this.secret?.(name) ?? process.env[name];
        if (!value) throw new DomainError('INDEPENDENT_KEY_MISSING', 409, '独立模型的凭据不在环境里（' + name + '）；不会回退到 Codex。');
        return value;
    }
    private body(wire: Wire, section: NonNullable<Config['independent']>, turns: { role: string; content: string }[], maxTokens?: number): Record<string, unknown> {
        const budget = maxTokens ?? section.maxOutputTokens;
        if (wire === 'openai-responses')
            // gpt-5-class models spend output budget on reasoning before they emit text: with the default
            // effort a small budget comes back 'incomplete' with zero output tokens (observed twice on
            // 2026-10-20/23). Minimal effort is what makes a short answer actually arrive.
            return { model: section.model, input: turns.map(turn => ({ role: turn.role === 'system' ? 'system' : turn.role, content: turn.content })), max_output_tokens: section.maxOutputTokens, reasoning: { effort: 'minimal' } };
        return { model: section.model, messages: turns, max_tokens: budget, stream: false,
            ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}) };
    }
    private read(wire: Wire, data: Record<string, unknown>): { content: string; responseId: string; model: string; inputTokens: number | null; outputTokens: number | null; finish: string } {
        if (wire === 'openai-responses') {
            const output = Array.isArray(data.output) ? data.output as { content?: { text?: unknown }[] }[] : [];
            const joined = output.flatMap(part => part.content ?? []).map(part => str(part.text)).join('');
            const usage = object(data.usage ?? {});
            return { content: str(data.output_text) || joined, responseId: str(data.id), model: str(data.model),
                inputTokens: int(usage.input_tokens), outputTokens: int(usage.output_tokens), finish: str(data.status) };
        }
        const choice = (Array.isArray(data.choices) ? data.choices : [])[0] as { message?: { content?: unknown }; finish_reason?: unknown } | undefined;
        const usage = object(data.usage ?? {});
        return { content: str(choice?.message?.content), responseId: str(data.id), model: str(data.model),
            inputTokens: int(usage.prompt_tokens), outputTokens: int(usage.completion_tokens), finish: str(choice?.finish_reason) };
    }
    async run(input: AgentInput, onEvent: (event: unknown) => void): Promise<AgentOutput> {
        const section = this.section(), key = this.key(section.keyEnv);
        const request = input.role === 'planner2' || input.role === 'reviewer'
            ? this.requestForRole?.(input.role) ?? this.request
            : this.request;
        if (this.requests >= section.maxRequests) throw new DomainError('INDEPENDENT_REQUEST_CAP_REACHED', 409, '独立模型的本进程请求上限已用尽（' + section.maxRequests + '）。');
        // A MINIMUM PROBE is not a role turn: it asks for a bare nonce to prove the wire works. Imposing the
        // role's JSON contract there made the model answer {"tasks":[...]} or {"response":"DM_PROBE_..."} and
        // the receipt was refused. The contract applies to real turns only, and the flag is already carried
        // on the input by the owner that builds the probe.
        const contract = input.laya?.reason === 'MINIMUM_PROBE' ? '' : (ROLE_INSTRUCTION[input.role] ?? ''),
            wire = wireFor(section.baseUrl, section.protocol),
            thread = this.threads.get(input.role) ?? { id: '', turns: contract ? [{ role: 'system', content: contract }] : [] };
        thread.turns.push({ role: 'user', content: input.prompt });
        const url = section.baseUrl.replace(/\/$/, '') + (wire === 'openai-responses' ? '/responses' : '/chat/completions');
        const requestOnce = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
            try {
                return await request(url, {
                    method: 'POST',
                    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: input.signal
                });
            } catch (error) {
            const code = error instanceof DomainError ? error.code : 'INDEPENDENT_TRANSPORT_ERROR';
            const failure=(error as {networkFailure?:{classification:string;retry:string;requestIdSha256:string|null}})?.networkFailure;
            onEvent({ method: 'dm/independentFailure', params: { role: input.role, model: section.model, wire, code,
                ...(failure?{networkFailureClass:failure.classification,retry:failure.retry,requestIdSha256:failure.requestIdSha256}:{}) } });
            if (error instanceof DomainError) throw error;
            const wrapped = new DomainError(code, 502, redact(String((error as Error)?.message ?? error)).slice(0, 300));
            throw failure ? Object.assign(wrapped, { networkFailure: failure }) : wrapped;
            }
        };
        this.requests += 1;
        let data = await requestOnce(this.body(wire, section, thread.turns));
        if (input.signal.aborted) {
            throw new DomainError('RUN_CANCELLED', 409);
        }
        let observed = this.read(wire, data);
        // A reasoning model can burn the whole output budget on analysis and return an empty `content`
        // with finish_reason 'length' — observed on run_b0efb56576c636b40155 (planner2, 2026-10-29) with
        // maxOutputTokens 8192, and again on run_a0ec14050b0822eb9236 (reviewer, 2026-10-30) where the
        // 16000 retry was ALSO consumed by reasoning: that run's review packet is 215 KB (~67k input
        // tokens) and the same packet answered at 32000 in 67 s with 10463 reasoning tokens. So the ladder
        // climbs, and it is bounded: strictly increasing budgets, at most one attempt per rung, and every
        // attempt counted against the per-process request cap the owner set.
        const RETRY_BUDGETS = [16000, 32000];
        for (const budget of RETRY_BUDGETS) {
            if (observed.content.trim() !== '' || wire !== 'chat-completions' || observed.finish !== 'length' || section.maxOutputTokens >= budget)
                break;
            if (this.requests >= section.maxRequests)
                throw new DomainError('INDEPENDENT_REQUEST_CAP_REACHED', 409, '独立模型的本进程请求上限已用尽（' + section.maxRequests + '）。');
            this.requests += 1;
            const retryBody = this.body(wire, section, thread.turns, budget);
            onEvent({ method: 'dm/independentRetry', params: { role: input.role, model: section.model, wire, reason: 'EMPTY_AFTER_LENGTH', maxTokens: budget } });
            const retryData = await requestOnce(retryBody);
            observed = this.read(wire, retryData);
            if (input.signal.aborted) {
                throw new DomainError('RUN_CANCELLED', 409);
            }
        }
        // Models sometimes wrap a perfectly good JSON object in prose or a ```json fence. Stripping that is
        // formatting, not content: the object still has to pass the caller's validator unchanged, and a reply
        // with no object in it is still an empty/failed answer.
        if (observed.content.trim() !== '') {
            const fenced = observed.content.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '').trim();
            const candidate = fenced.startsWith('{') || fenced.startsWith('[') ? fenced : observed.content.trim();
            if (candidate !== observed.content.trim()) { try { JSON.parse(candidate); observed.content = candidate; } catch { /* keep the original */ } }
        }
        if (observed.content.trim() === '') throw new DomainError('INDEPENDENT_RESPONSE_EMPTY', 502, '独立模型返回空内容（finish=' + (observed.finish || 'unknown') + '）。');
        thread.id = observed.responseId || thread.id;
        thread.turns.push({ role: 'assistant', content: observed.content });
        this.threads.set(input.role, thread);
        const usage: Usage = { role: input.role, inputTokens: observed.inputTokens, outputTokens: observed.outputTokens, costUsd: null,
            source: observed.inputTokens === null && observed.outputTokens === null ? 'UNKNOWN' : 'PROVIDER', requestId: observed.responseId };
        onEvent({ method: 'dm/independent', params: { role: input.role, model: observed.model || section.model, wire, provider: 'openai-compatible', authentication: 'API_KEY',
            responseId: observed.responseId, requestIndex: this.requests, finishReason: observed.finish, outputHash: hash(observed.content.trim()) } });
        return { text: observed.content, sessionId: observed.responseId || 'independent_' + hash(input.role + input.runId).slice(0, 16), usage, model: observed.model || section.model };
    }
}
