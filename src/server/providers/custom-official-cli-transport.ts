import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DomainError, object} from '../security.js';

interface TransportInput {
    gatewayUrl: string;
    gatewayToken: string;
    model: string;
    prompt: string;
    maxOutputTokens: number;
    signal: AbortSignal;
    assertCurrent(): void;
}

// The native client sees a marker so file mentions and slash commands in role data stay inert.
// Build a fresh chat request and buffer the entire owner response before exposing any text to the CLI.
export async function startOfficialCliTransport(input: TransportInput) {
    const token = randomBytes(24).toString('hex');
    const marker = 'DreamFlow role packet ' + randomBytes(18).toString('hex');
    const abort = new AbortController();
    const signal = AbortSignal.any([input.signal, abort.signal]);
    let used = false;
    let responseId: string | undefined;
    let pending: Promise<void> | undefined;
    const server = createServer((req, res) => {
        if (used || req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer ' + token) {
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
                if (body.model !== input.model || body.stream !== true || !Array.isArray(body.messages) || body.messages.length > 64) throw new Error();
                let replacements = 0;
                function replaceMarker(text: string) {
                    return text.replaceAll(marker, () => { replacements++; return input.prompt; });
                }
                const messages = body.messages.map(raw => {
                    const msg = object(raw);
                    if (msg.role !== 'user' && msg.role !== 'system' && msg.role !== 'developer') throw new Error();
                    if (typeof msg.content === 'string') return {role: msg.role, content: msg.role === 'user' ? replaceMarker(msg.content) : msg.content};
                    if (!Array.isArray(msg.content)) throw new Error();
                    const content = msg.content.map(rawPart => {
                        const part = object(rawPart);
                        if (part.type !== 'text' || typeof part.text !== 'string') throw new Error();
                        return {type: 'text', text: msg.role === 'user' ? replaceMarker(part.text) : part.text};
                    });
                    return {role: msg.role, content};
                });
                if (replacements !== 1) throw new Error();
                signal.throwIfAborted();
                input.assertCurrent();
                const response = await fetch(input.gatewayUrl + '/chat/completions', {
                    method: 'POST', redirect: 'error', signal,
                    headers: {authorization: 'Bearer ' + input.gatewayToken, 'content-type': 'application/json'},
                    body: JSON.stringify({model: input.model, messages, max_tokens: input.maxOutputTokens, stream: false})
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
                const doc = object(JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(pieces))));
                if (doc.model !== input.model || typeof doc.id !== 'string' || !doc.id || !Array.isArray(doc.choices) || doc.choices.length !== 1) throw new Error();
                const choice = object(doc.choices[0]), message = object(choice.message);
                if (choice.finish_reason !== 'stop' || message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim() || message.tool_calls != null || message.function_call != null) throw new Error();
                input.assertCurrent();
                signal.throwIfAborted();
                responseId = doc.id;
                const chunk = (delta: object, finish_reason: string | null) => ({id: doc.id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: input.model, choices: [{index: 0, delta, finish_reason}]});
                const frames = [chunk({role: 'assistant', content: message.content}, null), {...chunk({}, 'stop'), usage: doc.usage}];
                res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'});
                res.end(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n');
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
