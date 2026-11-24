import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DomainError, object} from '../security.js';

interface MessagesTransportInput {
    gatewayUrl: string;
    gatewayToken: string;
    model: string;
    prompt: string;
    maxOutputTokens: number;
    signal: AbortSignal;
    assertCurrent(): void;
}

const loopback = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}(?:\/v1)?\/?$/;
const deny = (): never => { throw new DomainError('CUSTOM_OFFICIAL_CLI_UNVERIFIED', 409); };
const markerPrefix = 'DreamFlow role packet ';

/** Text-only view of one native Messages content value. Every other block type is refused. */
function textContent(raw: unknown): {text: string; array: boolean} | undefined {
    if (typeof raw === 'string') return {text: raw, array: false};
    if (!Array.isArray(raw) || raw.length > 256) return undefined;
    let text = '';
    for (const value of raw) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const part = value as Record<string, unknown>;
        if (part.type !== 'text' || typeof part.text !== 'string') return undefined;
        text += part.text;
    }
    return {text, array: true};
}

// The native client sees a marker so file mentions and slash commands in role data stay inert.
// Buffer the entire owner answer, then expose only synthesised text frames to the CLI.
export async function startOfficialCliMessagesTransport(input: MessagesTransportInput) {
    if (typeof input.gatewayUrl !== 'string' || !loopback.test(input.gatewayUrl)) return deny();
    const token = randomBytes(24).toString('hex');
    const marker = markerPrefix + randomBytes(18).toString('hex');
    const abort = new AbortController();
    const signal = AbortSignal.any([input.signal, abort.signal]);
    let used = false;
    let responseId: string | undefined;
    let pending: Promise<void> | undefined;
    const server = createServer((req, res) => {
        if (used || req.method !== 'POST' || req.url !== '/v1/messages' ||
            req.headersDistinct['x-api-key']?.length !== 1 || req.headersDistinct['x-api-key']?.[0] !== token ||
            req.headersDistinct.authorization !== undefined) {
            res.writeHead(403).end();
            return;
        }
        used = true;
        pending = (async () => {
            try {
                const chunks: Buffer[] = [];
                let bytes = 0;
                for await (const chunk of req) {
                    bytes += chunk.length;
                    if (bytes > 262144) throw new Error();
                    chunks.push(chunk);
                }
                const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                if (body.model !== input.model || body.stream !== true) throw new Error();
                if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64) throw new Error();
                if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) throw new Error();
                const system = body.system === undefined ? undefined : textContent(body.system);
                if (body.system !== undefined && (!system || !system.text.trim())) throw new Error();
                // OpenCode 1.19.6 re-quotes the frozen prompt, so the marker arrives wrapped in
                // double quotes; both forms denote the same single frozen slot and count once.
                const quotedMarker = '"' + marker + '"';
                let replacements = 0;
                const replaceMarker = (value: string) => value
                    .replaceAll(quotedMarker, () => { replacements++; return input.prompt; })
                    .replaceAll(marker, () => { replacements++; return input.prompt; });
                const messages = body.messages.map(raw => {
                    const msg = object(raw);
                    if (msg.role !== 'user' && msg.role !== 'assistant') throw new Error();
                    const content = textContent(msg.content);
                    if (!content) throw new Error();
                    if (msg.role !== 'user') return {role: msg.role, content: content.array ? [{type: 'text', text: content.text}] : content.text};
                    const replaced = replaceMarker(content.text);
                    return {role: msg.role, content: content.array ? [{type: 'text', text: replaced}] : replaced};
                });
                if (replacements !== 1) throw new Error();
                const payload: Record<string, unknown> = {model: input.model, messages, max_tokens: input.maxOutputTokens, stream: false};
                if (system) payload.system = system.array ? [{type: 'text', text: system.text}] : system.text;
                signal.throwIfAborted();
                input.assertCurrent();
                const response = await fetch(input.gatewayUrl.replace(/\/+$/, '') + '/messages', {
                    method: 'POST', redirect: 'error', signal,
                    headers: {'x-api-key': input.gatewayToken, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
                    body: JSON.stringify(payload)
                });
                if (!response.ok) { await response.body?.cancel(); throw new Error(); }
                const reader = response.body?.getReader();
                if (!reader) throw new Error();
                const pieces: Uint8Array[] = [];
                let length = 0;
                try {
                    while (true) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        length += chunk.value.length;
                        if (length > 2_000_000) { await reader.cancel(); throw new Error(); }
                        pieces.push(chunk.value);
                    }
                } finally { reader.releaseLock(); }
                const doc = object(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(pieces))));
                if (doc.type !== 'message' || doc.model !== input.model || typeof doc.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(doc.id)) throw new Error();
                if (!Array.isArray(doc.content) || doc.content.length > 256) throw new Error();
                let text = '';
                for (const raw of doc.content) {
                    const part = object(raw);
                    if (part.type !== 'text' || typeof part.text !== 'string') throw new Error();
                    text += part.text;
                }
                if (!text.trim() || !['end_turn', 'stop'].includes(String(doc.stop_reason))) throw new Error();
                const usage = doc.usage == null ? {} : object(doc.usage);
                const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
                input.assertCurrent();
                signal.throwIfAborted();
                responseId = doc.id;
                const frames = [
                    {type: 'message_start', message: {id: doc.id, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: count(usage.input_tokens), output_tokens: 0}}},
                    {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
                    {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text}},
                    {type: 'content_block_stop', index: 0},
                    {type: 'message_delta', delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: count(usage.output_tokens)}},
                    {type: 'message_stop'}
                ];
                res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'});
                res.end(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''));
            } catch {
                if (!res.headersSent) res.writeHead(502);
                res.end();
            }
        })();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new DomainError('MODEL_GATEWAY_BINDING_INVALID');
    return {url: 'http://127.0.0.1:' + address.port + '/v1', token, marker, responseId: () => responseId,
        async close() {
            abort.abort();
            const closed = once(server, 'close');
            server.close();
            server.closeAllConnections();
            await Promise.all([closed, pending]);
        }
    };
}
