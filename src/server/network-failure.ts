import { createHash } from 'node:crypto';

export const REQUIRED_NETWORK_FAILURE_CLASSES = Object.freeze([
    'DNS_FAILURE',
    'TCP_CONNECTION_FAILURE',
    'TLS_HANDSHAKE_FAILURE',
    'PROXY_CONNECTION_RESET',
    'STREAM_INTERRUPTED',
    'HTTP_401_AUTHENTICATION_FAILED',
    'HTTP_403_PERMISSION_DENIED',
    'REGION_OR_POLICY_RESTRICTED',
    'HTTP_429_QUOTA_EXCEEDED',
    'MODEL_UNAVAILABLE',
    'INFERENCE_COMPLETED'
] as const);

export type RequiredNetworkFailureClass = typeof REQUIRED_NETWORK_FAILURE_CLASSES[number];
export type NetworkFailureClass =
    | RequiredNetworkFailureClass
    | 'HTTP_SUCCESS_NON_INFERENCE'
    | 'HTTP_CLIENT_REQUEST_REJECTED'
    | 'HTTP_5XX_UPSTREAM_FAILURE';
export type NetworkFailureContext = 'DIRECT' | 'PROXY' | 'RESPONSE' | 'UNKNOWN';
export type NetworkRetryPolicy =
    | 'NO_AUTOMATIC_RETRY'
    | 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION';

export interface NetworkFailureEvidence {
    classification: NetworkFailureClass;
    layer: 'HTTP' | 'TRANSPORT';
    context: NetworkFailureContext;
    httpStatus: number | null;
    requestIdSha256: string | null;
    retry: NetworkRetryPolicy;
    automaticRetryAllowed: boolean;
    recordedAt: string;
}

const maxDiagnosticBody = 64 * 1024;
const requestIdHash = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= 512
        ? createHash('sha256').update(value).digest('hex')
        : null;

function retryPolicy(classification: NetworkFailureClass, deliberateAbort = false): NetworkRetryPolicy {
    if(classification==='STREAM_INTERRUPTED'&&deliberateAbort)
        return 'NO_AUTOMATIC_RETRY';
    return ['DNS_FAILURE', 'TCP_CONNECTION_FAILURE', 'TLS_HANDSHAKE_FAILURE',
        'PROXY_CONNECTION_RESET', 'STREAM_INTERRUPTED', 'HTTP_5XX_UPSTREAM_FAILURE']
        .includes(classification)
        ? 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION'
        : 'NO_AUTOMATIC_RETRY';
}

function evidence(
    classification: NetworkFailureClass,
    layer: NetworkFailureEvidence['layer'],
    context: NetworkFailureContext,
    httpStatus: number | null,
    requestId: unknown,
    deliberateAbort = false
): NetworkFailureEvidence {
    const retry = retryPolicy(classification, deliberateAbort);
    return {
        classification,
        layer,
        context,
        httpStatus,
        requestIdSha256: requestIdHash(requestId),
        retry,
        automaticRetryAllowed: retry === 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION',
        recordedAt: new Date().toISOString()
    };
}

const networkFailureClasses = new Set<NetworkFailureClass>([
    ...REQUIRED_NETWORK_FAILURE_CLASSES,
    'HTTP_SUCCESS_NON_INFERENCE',
    'HTTP_CLIENT_REQUEST_REJECTED',
    'HTTP_5XX_UPSTREAM_FAILURE'
]);

function isHttpClassification(classification: NetworkFailureClass): boolean {
    return classification.startsWith('HTTP_') ||
        classification === 'REGION_OR_POLICY_RESTRICTED' ||
        classification === 'MODEL_UNAVAILABLE' ||
        classification === 'INFERENCE_COMPLETED';
}

function validAttachedEvidence(candidate: unknown): candidate is NetworkFailureEvidence {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        return false;
    const evidence = candidate as Partial<NetworkFailureEvidence>;
    if (typeof evidence.classification !== 'string' ||
        !networkFailureClasses.has(evidence.classification as NetworkFailureClass))
        return false;
    const classification = evidence.classification as NetworkFailureClass;
    const retryMatches = evidence.retry === retryPolicy(classification) ||
        classification === 'STREAM_INTERRUPTED' && evidence.retry === 'NO_AUTOMATIC_RETRY';
    if (!['HTTP', 'TRANSPORT'].includes(String(evidence.layer)) ||
        !['DIRECT', 'PROXY', 'RESPONSE', 'UNKNOWN'].includes(String(evidence.context)) ||
        !retryMatches ||
        evidence.automaticRetryAllowed !== (evidence.retry === 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION') ||
        typeof evidence.recordedAt !== 'string' ||
        !Number.isFinite(Date.parse(evidence.recordedAt)))
        return false;
    if (!(evidence.httpStatus === null ||
        Number.isInteger(evidence.httpStatus) && Number(evidence.httpStatus) >= 100 && Number(evidence.httpStatus) <= 599))
        return false;
    if (!(evidence.requestIdSha256 === null ||
        typeof evidence.requestIdSha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.requestIdSha256)))
        return false;
    const httpClassification = isHttpClassification(classification);
    if (httpClassification !== (evidence.layer === 'HTTP') ||
        evidence.layer === 'HTTP' && evidence.context !== 'RESPONSE')
        return false;
    if (evidence.layer === 'TRANSPORT')
        return evidence.httpStatus === null;
    if (evidence.httpStatus === null)
        return false;
    const httpStatus = evidence.httpStatus as number;
    if (classification === 'HTTP_401_AUTHENTICATION_FAILED')
        return httpStatus === 401;
    if (classification === 'HTTP_403_PERMISSION_DENIED' || classification === 'REGION_OR_POLICY_RESTRICTED')
        return httpStatus === 403;
    if (classification === 'HTTP_429_QUOTA_EXCEEDED')
        return httpStatus === 429;
    if (classification === 'MODEL_UNAVAILABLE')
        return [400, 404, 410].includes(httpStatus);
    if (classification === 'HTTP_5XX_UPSTREAM_FAILURE')
        return httpStatus >= 500;
    if (classification === 'HTTP_CLIENT_REQUEST_REJECTED')
        return (httpStatus >= 100 && httpStatus < 200) ||
            (httpStatus >= 300 && httpStatus < 500);
    return httpStatus >= 200 && httpStatus < 300;
}

function attachedNetworkFailure(error: unknown): NetworkFailureEvidence | null {
    let current = error;
    try {
        for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
            const candidate = Object.getOwnPropertyDescriptor(current, 'networkFailure')?.value;
            if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                // Capture only the fixed scalar schema, once. Never execute getters
                // during validation/cloning or retain extra exception/header fields.
                const keys = ['classification', 'layer', 'context', 'httpStatus',
                    'requestIdSha256', 'retry', 'automaticRetryAllowed', 'recordedAt'] as const;
                const entries = keys.map(key => [key, Object.getOwnPropertyDescriptor(candidate, key)] as const);
                if (entries.every(([, field]) => field && Object.hasOwn(field, 'value') &&
                    (field.value === null || ['string', 'number', 'boolean'].includes(typeof field.value)))) {
                    const snapshot = Object.fromEntries(entries.map(([key, field]) => [key, field!.value]));
                    if (validAttachedEvidence(snapshot)) return snapshot;
                }
            }
            current = Object.getOwnPropertyDescriptor(current, 'cause')?.value;
        }
    } catch {
        return null;
    }
    return null;
}

function policyRestricted(body: string): boolean {
    const bounded = body.slice(0, maxDiagnosticBody);
    return /unsupported_country_region_territory/i.test(bounded) ||
        /country,\s*region,\s*or\s*territory\s+not\s+supported/i.test(bounded) ||
        /not\s+supported\s+in\s+(?:your\s+)?country,?\s*region,?\s*or\s*territory/i.test(bounded);
}

function modelUnavailable(body: string): boolean {
    const bounded = body.slice(0, maxDiagnosticBody);
    return /(?:model_not_found|model\s+is\s+unavailable|model\s+not\s+available|invalid_model)/i.test(bounded);
}

export function classifyNetworkResponse(input: {
    status: number;
    body?: string;
    requestId?: string | null;
}): NetworkFailureEvidence {
    const status = input.status;
    if (status >= 200 && status < 300)
        return evidence('HTTP_SUCCESS_NON_INFERENCE', 'HTTP', 'RESPONSE', status, input.requestId);
    if (status === 401)
        return evidence('HTTP_401_AUTHENTICATION_FAILED', 'HTTP', 'RESPONSE', status, input.requestId);
    if (status === 403) {
        return evidence(
            policyRestricted(input.body ?? '')
                ? 'REGION_OR_POLICY_RESTRICTED'
                : 'HTTP_403_PERMISSION_DENIED',
            'HTTP',
            'RESPONSE',
            status,
            input.requestId
        );
    }
    if (status === 429)
        return evidence('HTTP_429_QUOTA_EXCEEDED', 'HTTP', 'RESPONSE', status, input.requestId);
    if ([400, 404, 410].includes(status) && modelUnavailable(input.body ?? ''))
        return evidence('MODEL_UNAVAILABLE', 'HTTP', 'RESPONSE', status, input.requestId);
    return evidence(
        status >= 500
            ? 'HTTP_5XX_UPSTREAM_FAILURE'
            : 'HTTP_CLIENT_REQUEST_REJECTED',
        'HTTP',
        'RESPONSE',
        status,
        input.requestId
    );
}

/** A successful HTTP read is inference completion only for an inference endpoint. */
export function classifyRoutedResponse(input: {
    status: number;
    body?: string;
    requestId?: string | null;
    target: string;
    inferenceRequest: boolean;
    payload?: unknown;
    contentType?: string;
}): NetworkFailureEvidence {
    if (input.status >= 200 && input.status < 300) {
        return evidence(
            input.inferenceRequest && completedInferenceEvidence(input)
                ? 'INFERENCE_COMPLETED'
                : 'HTTP_SUCCESS_NON_INFERENCE',
            'HTTP',
            'RESPONSE',
            input.status,
            input.requestId
        );
    }
    return classifyNetworkResponse(input);
}

type InferenceWire = 'responses' | 'chat-completions' | 'anthropic-messages';

function inferenceWire(target: string): InferenceWire | null {
    try {
        const url = new URL(target);
        if (url.protocol !== 'https:') return null;
        if (url.hostname === 'api.openai.com' && url.pathname === '/v1/responses')
            return 'responses';
        if (url.hostname === 'api.deepseek.com' &&
            ['/chat/completions', '/v1/chat/completions'].includes(url.pathname))
            return 'chat-completions';
        if (url.hostname === 'api.deepseek.com' && url.pathname === '/anthropic/v1/messages')
            return 'anthropic-messages';
    } catch {
        return null;
    }
    return null;
}

function completedPayload(wire: InferenceWire, payload: unknown): boolean {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const value = payload as Record<string, unknown>;
    if (wire === 'responses')
        return value.object === 'response' && value.status === 'completed';
    if (wire === 'chat-completions') {
        const choices = Array.isArray(value.choices) ? value.choices : [];
        if (choices.length !== 1 || !choices[0] || typeof choices[0] !== 'object' ||
            Array.isArray(choices[0]))
            return false;
        const finish = (choices[0] as Record<string, unknown>).finish_reason;
        return typeof finish === 'string' &&
            ['stop', 'tool_calls', 'function_call'].includes(finish);
    }
    return value.type === 'message' && typeof value.stop_reason === 'string' &&
        ['end_turn', 'tool_use', 'stop_sequence'].includes(value.stop_reason);
}

function completedStream(wire: InferenceWire, body: string): boolean {
    if (wire === 'responses')
        return /(?:^|\r?\n)event:\s*response[.]completed(?:\r?\n|$)/.test(body) ||
            /"type"\s*:\s*"response[.]completed"/.test(body);
    if (wire === 'chat-completions')
        return /(?:^|\r?\n)data:\s*\[DONE\]\s*(?:\r?\n|$)/.test(body) &&
            /"finish_reason"\s*:\s*"(?:stop|tool_calls|function_call)"/.test(body);
    return /(?:^|\r?\n)event:\s*message_stop(?:\r?\n|$)/.test(body) ||
        /"type"\s*:\s*"message_stop"/.test(body);
}

function completedInferenceEvidence(input: {
    target: string;
    body?: string;
    payload?: unknown;
    contentType?: string;
}): boolean {
    const wire = inferenceWire(input.target);
    if (!wire) return false;
    if (input.payload !== undefined)
        return completedPayload(wire, input.payload);
    const body = input.body ?? '';
    if (!body) return false;
    if ((input.contentType ?? '').toLowerCase().includes('text/event-stream'))
        return completedStream(wire, body);
    try {
        return completedPayload(wire, JSON.parse(body));
    } catch {
        return false;
    }
}

export function isInferenceTarget(target: string): boolean {
    return inferenceWire(target) !== null;
}

function errorCode(error: unknown): string | null {
    let current = error;
    try {
        for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
            const value = current as Record<string, unknown>;
            if (typeof value.code === 'string' && value.code.length <= 128)
                return value.code;
            current = value.cause;
        }
    } catch {
        return null;
    }
    return null;
}

function errorName(error: unknown): string | null {
    let current = error;
    try {
        for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
            const value = current as Record<string, unknown>;
            if (typeof value.name === 'string' && value.name.length <= 128)
                return value.name;
            current = value.cause;
        }
    } catch {
        return null;
    }
    return null;
}

export function classifyNetworkFailure(input: {
    error: unknown;
    context?: NetworkFailureContext;
    httpStatus?: number | null;
    requestId?: string | null;
}): NetworkFailureEvidence {
    const attached = attachedNetworkFailure(input.error);
    if (attached) return attached;
    const code = errorCode(input.error)?.toUpperCase() ?? '';
    const name = errorName(input.error) ?? '';
    const context = input.context ?? 'UNKNOWN';
    const httpStatus = input.httpStatus ?? null;
    if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'DNS_FAILURE'].includes(code))
        return evidence('DNS_FAILURE', 'TRANSPORT', context, httpStatus, input.requestId);
    if (/TLS|CERT|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code))
        return evidence('TLS_HANDSHAKE_FAILURE', 'TRANSPORT', context, httpStatus, input.requestId);
    if (/^CLASH_PROXY_(?:CONNECT_TIMEOUT|CONNECT_REJECTED|CONNECT_PROTOCOL_ERROR|AUTH_REJECTED)$/.test(code))
        return evidence('TCP_CONNECTION_FAILURE', 'TRANSPORT', 'PROXY', httpStatus, input.requestId);
    if (code.startsWith('CLASH_PROXY_'))
        return evidence('PROXY_CONNECTION_RESET', 'TRANSPORT', 'PROXY', httpStatus, input.requestId);
    if (['CLASH_REQUEST_ABORTED', 'ABORT_ERR'].includes(code) || /^AbortError$/i.test(name))
        return evidence('STREAM_INTERRUPTED', 'TRANSPORT', context, httpStatus, input.requestId, true);
    if (['UPSTREAM_INTERRUPTED',
        'CLASH_PROVIDER_NETWORK_ERROR', 'CLASH_PROVIDER_TIMEOUT',
        'MODEL_GATEWAY_DISCONNECTED', 'MODEL_GATEWAY_STREAM_INCOMPLETE', 'UND_ERR_SOCKET',
        'UND_ERR_BODY_TIMEOUT'].includes(code) || context === 'RESPONSE' && code === 'ECONNRESET')
        return evidence('STREAM_INTERRUPTED', 'TRANSPORT', context, httpStatus, input.requestId);
    if (context === 'PROXY' && ['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(code))
        return evidence('PROXY_CONNECTION_RESET', 'TRANSPORT', context, httpStatus, input.requestId);
    return evidence('TCP_CONNECTION_FAILURE', 'TRANSPORT', context, httpStatus, input.requestId);
}
