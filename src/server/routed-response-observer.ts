import type { RoutedRequestObservation, RoutedRequestRole } from '../shared/network-contexts.js';
import {
    classifyNetworkFailure,
    classifyRoutedResponse,
    isInferenceTarget,
    type NetworkFailureEvidence
} from './network-failure.js';
import { hash } from './security.js';

const diagnosticBodyBytes = 64 * 1024;

export interface RoutedResponseObservationInput {
    response: Response;
    target: string;
    method: string;
    selectionPolicy: 'pinned' | 'current';
    selectedNode: string;
    expectedNode: string;
    role?: RoutedRequestRole;
    startedAt: string;
    started: number;
    record?: (observation: RoutedRequestObservation) => void;
}

function requestId(response: Response): string | null {
    try {
        const value = response.headers.get('x-request-id') ?? response.headers.get('request-id');
        return typeof value === 'string' && value.length <= 512 ? value : null;
    } catch {
        return null;
    }
}

function targetHost(target: string): string | null {
    try {
        const host = new URL(target).hostname;
        return /^[a-z0-9.-]{1,253}$/i.test(host) ? host : null;
    } catch {
        return null;
    }
}

function responseEvidence(response: Response, body: string, target: string): NetworkFailureEvidence {
    return classifyRoutedResponse({
        status: response.status,
        body,
        requestId: requestId(response),
        target,
        inferenceRequest: isInferenceTarget(target),
        contentType: response.headers.get('content-type') ?? ''
    });
}

/**
 * Pass through a response without changing its bytes or backpressure. Only the
 * bounded diagnostic prefix is inspected; the body, headers and raw request ID
 * never enter the persisted observation.
 */
export function observeRoutedResponse(input: RoutedResponseObservationInput): Response {
    if (!input.record) return input.response;
    const host = targetHost(input.target);
    if (!host) return input.response;

    const source = input.response.body;
    const startedAt = input.startedAt;
    const started = input.started;
    const method = String(input.method).toUpperCase() === 'POST' ? 'POST' : 'GET';
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let finished = false;
    let bytes = 0;
    const prefix: Buffer[] = [];
    let tail = Buffer.alloc(0);

    const finish = (failure: NetworkFailureEvidence) => {
        if (finished) return;
        finished = true;
        try {
            input.record?.({
                schema: 'dream-maker.routed-request-observation.v1',
                at: new Date().toISOString(),
                startedAt,
                completedAt: new Date().toISOString(),
                process: 'DM_CONTROLLED_TRANSPORT',
                ...(input.role ? { role: input.role } : {}),
                targetHost: host,
                method,
                selectionPolicy: input.selectionPolicy,
                selectedNode: input.selectedNode.slice(0, 512),
                expectedNode: input.expectedNode.slice(0, 512),
                httpStatus: failure.httpStatus,
                classification: failure.classification,
                automaticRetryAllowed: failure.automaticRetryAllowed,
                requestIdSha256: failure.requestIdSha256,
                elapsedMs: Math.min(300000, Math.max(0, Math.floor(performance.now() - started)))
            });
        } catch {
            // Diagnostics never replace the caller's response or transport error.
        }
    };
    const diagnosticText = () => {
        const contentType = (input.response.headers.get('content-type') ?? '').toLowerCase();
        return (contentType.includes('text/event-stream') ? tail : Buffer.concat(prefix)).toString('utf8');
    };
    const completed = () => finish(responseEvidence(input.response, diagnosticText(), input.target));
    const interrupted = (error: unknown) => finish((error as { networkFailure?: NetworkFailureEvidence })?.networkFailure ??
        classifyNetworkFailure({
            error: error ?? { code: 'UPSTREAM_INTERRUPTED' },
            context: 'RESPONSE',
            httpStatus: input.response.status,
            requestId: requestId(input.response)
        }));
    const failedBeforeBody = () => {
        if (!input.response.ok) finish(responseEvidence(input.response, '', input.target));
        else finish(classifyNetworkFailure({
            error: { code: 'MODEL_GATEWAY_STREAM_INCOMPLETE' },
            context: 'RESPONSE',
            httpStatus: input.response.status,
            requestId: requestId(input.response)
        }));
    };

    if (!source) {
        failedBeforeBody();
        return input.response;
    }
    try {
        reader = source.getReader();
    } catch {
        failedBeforeBody();
        return input.response;
    }

    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const next = await reader!.read();
                if (next.done) {
                    completed();
                    controller.close();
                    return;
                }
                const value = next.value;
                tail = Buffer.concat([tail, Buffer.from(value)]).subarray(-diagnosticBodyBytes);
                if (bytes < diagnosticBodyBytes) {
                    const part = value.byteLength > diagnosticBodyBytes - bytes
                        ? value.subarray(0, diagnosticBodyBytes - bytes)
                        : value;
                    prefix.push(Buffer.from(part));
                    bytes += part.byteLength;
                }
                controller.enqueue(value);
            } catch (error) {
                interrupted(error);
                controller.error(error);
            }
        },
        async cancel(reason) {
            if (!finished) interrupted(reason);
            await reader!.cancel(reason).catch(() => {});
        }
    });
    return new Response(body, {
        status: input.response.status,
        statusText: input.response.statusText,
        headers: input.response.headers
    });
}
