import { DomainError } from './security.js';

/**
 * C04: bounded retry for *safe* requests only.
 *
 * The rule this encodes: a read can be retried, a write cannot be "retried" — a second POST to a
 * model or refresh endpoint may already have been processed upstream, and re-sending it duplicates
 * reasoning or rotates a token chain twice. So retries apply to idempotent reads (GET/HEAD) and to
 * an explicit allow-list of transient conditions, never to POST.
 *
 * Delays are exponential with bounded jitter; `Retry-After` is honoured but capped, and the whole
 * loop is cancelled by the caller's AbortSignal so a user cancellation is not delayed by backoff.
 */
export interface RetryPolicy {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4000, jitterRatio: 0.2 };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

export interface RetryFailure {
    status?: number;
    retryAfterMs?: number;
    message?: string;
}

/** Everything the retry loop needs to know about a failure, without holding an exception type. */
export function isRetryable(method: string, failure: RetryFailure): boolean {
    if (!SAFE_METHODS.has(method.toUpperCase())) return false;
    if (typeof failure.status === 'number') return TRANSIENT_STATUS.has(failure.status);
    return /etimedout|econnreset|econnrefused|enotfound|socket hang up|network|fetch failed/i.test(failure.message ?? '');
}

export function retryDelayMs(attempt: number, policy: RetryPolicy, failure: RetryFailure, random: () => number = Math.random): number {
    const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
    const jitter = 1 + (random() * 2 - 1) * policy.jitterRatio;
    const computed = Math.max(0, Math.round(exponential * jitter));
    const requested = typeof failure.retryAfterMs === 'number' && Number.isFinite(failure.retryAfterMs)
        ? Math.max(0, failure.retryAfterMs)
        : undefined;
    // Honour the server, but never let it hold the loop longer than the policy ceiling.
    const delay = requested === undefined ? computed : Math.min(requested, policy.maxDelayMs);
    return Math.min(delay, policy.maxDelayMs);
}

export interface RetryOptions {
    method: string;
    signal?: AbortSignal;
    policy?: RetryPolicy;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Called after each failed attempt so the caller can record attempts without seeing payloads. */
    onAttemptFailed?: (attempt: number, failure: RetryFailure) => void;
}

export async function withBoundedRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
    const policy = options.policy ?? DEFAULT_RETRY_POLICY;
    const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const method = options.method.toUpperCase();
    let attempt = 0;
    for (;;) {
        if (options.signal?.aborted) throw new DomainError('RUN_CANCELLED', 409);
        attempt += 1;
        try {
            return await operation(attempt);
        }
        catch (error) {
            const failure: RetryFailure = {
                status: typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : undefined,
                retryAfterMs: typeof (error as { retryAfterMs?: unknown }).retryAfterMs === 'number' ? (error as { retryAfterMs: number }).retryAfterMs : undefined,
                message: typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : ''
            };
            options.onAttemptFailed?.(attempt, failure);
            // A non-idempotent call is never retried, whatever the failure looked like.
            if (!isRetryable(method, failure)) throw error;
            if (attempt >= policy.maxAttempts) {
                if (error instanceof DomainError) throw error;
                throw new DomainError('KIMI_RETRY_EXHAUSTED', 503, `安全只读请求重试 ${attempt} 次仍失败；不扩展到写请求。`);
            }
            const delay = retryDelayMs(attempt, policy, failure, options.random);
            if (delay > 0) {
                if (options.signal?.aborted) throw new DomainError('RUN_CANCELLED', 409);
                await sleep(delay);
            }
        }
    }
}
