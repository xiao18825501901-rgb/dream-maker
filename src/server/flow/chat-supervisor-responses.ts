import { DomainError } from '../security.js';
import type { CodexPlannerStream } from './codex-planner-stream.js';
import { paidCodexResponsesBody, type PaidCodexResponsesLimits } from './paid-codex-responses.js';

type SupervisorLimits = Pick<PaidCodexResponsesLimits, 'model' | 'prompt' | 'instructions' | 'maxOutputTokens'>;
type CompletedResponses = NonNullable<ReturnType<CodexPlannerStream['observe']>>;

function invalidRequest(): never {
    throw new DomainError('RESPONSES_REQUEST_INVALID', 400);
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return invalidRequest();
    return value as Record<string, unknown>;
}

/** Accept the private CLI bridge's buffered Chat request. CLI-generated context stays local. */
export function chatSupervisorResponsesBody(raw: unknown, limits: SupervisorLimits): Record<string, unknown> {
    const body = fields(raw, ['model', 'messages', 'max_tokens', 'stream']);
    if (!limits.model || !limits.prompt || !limits.instructions || body.model !== limits.model || body.stream !== false ||
        !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 64 ||
        typeof body.max_tokens !== 'number' || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1) return invalidRequest();

    let promptFound = false;
    for (const rawMessage of body.messages) {
        const message = fields(rawMessage, ['role', 'content']);
        if (message.role !== 'user' && message.role !== 'developer' && message.role !== 'system') return invalidRequest();
        const parts = typeof message.content === 'string' ? [message.content] : message.content;
        if (!Array.isArray(parts) || !parts.length) return invalidRequest();
        for (const part of parts) {
            let text: unknown = part;
            if (typeof message.content !== 'string') {
                const block = fields(part, ['type', 'text']);
                if (block.type !== 'text') return invalidRequest();
                text = block.text;
            }
            if (typeof text !== 'string') return invalidRequest();
            if (message.role !== 'user') continue;
            const start = text.indexOf(limits.prompt);
            if (start < 0) continue;
            if (promptFound || text.indexOf(limits.prompt, start + 1) >= 0) return invalidRequest();
            promptFound = true;
        }
    }
    if (!promptFound) return invalidRequest();
    return paidCodexResponsesBody({
        model: limits.model, stream: true, store: false, max_output_tokens: body.max_tokens,
        input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: limits.prompt}]}],
    }, limits);
}

/** Call with the selected route's validated terminal result after consuming the full SSE stream. */
export function chatSupervisorCompletion(result: CompletedResponses, model: string) {
    if (!model || typeof result.id !== 'string' || !/^[-A-Za-z0-9_]{1,200}$/.test(result.id) || typeof result.text !== 'string' || !result.text.trim())
        throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID', 502);
    if (result.usageLimitExceeded) throw new DomainError('MODEL_GATEWAY_USAGE_LIMIT_EXCEEDED', 502);
    const usage = result.usage;
    if (!usage || ![usage.inputTokens, usage.outputTokens, usage.cacheHitTokens].every(n => Number.isSafeInteger(n) && n >= 0) ||
        usage.cacheHitTokens > usage.inputTokens || !Number.isSafeInteger(usage.inputTokens + usage.outputTokens))
        throw new DomainError('NATIVE_USAGE_UNKNOWN', 502);
    return {
        id: result.id, object: 'chat.completion', model,
        choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: result.text}}],
        usage: {
            prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens,
            prompt_tokens_details: {cached_tokens: usage.cacheHitTokens}, prompt_cache_hit_tokens: usage.cacheHitTokens,
        },
    };
}
