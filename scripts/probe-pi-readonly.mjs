// Physical, loopback-only probe of the read-only Pi lane.
//
// It runs the installed Pi 1.5.0 through the real PiRunner, the real DM tool broker and the
// read-only tool set (desk_read/desk_search) against a synthetic Responses upstream on 127.0.0.1.
// Nothing leaves loopback and nothing is billed: the receipt list below is synthetic, so this
// probe measures the CLI's own behaviour (argv, session, JSONL, tool round, POST count), NOT the
// owned Magpie's reservation/settlement. Use it as process evidence; the lane's build digest is
// only registered after the owned-Magpie turn, which needs the reviewed Go control plane.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiRunner } from '../dist/server/providers/pi.js';
import { PI_READ_ONLY_TOOLS } from '../dist/server/flow/pi-native-wire.js';

const cli = process.env.DM_TEST_PI_CLI;
if (!cli) { console.error('DM_TEST_PI_CLI is not set; point it at the installed Pi bundle (dist/bundle/cli.js).'); process.exit(2); }
const role = process.argv[2] === 'reviewer' ? 'reviewer' : 'planner2';
const root = mkdtempSync(join(tmpdir(), 'dm-pi-readonly-probe-'));
const workspace = join(root, 'workspace');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'SPEC.md'), 'The product must sum two integers and print the result' + String.fromCharCode(10));
writeFileSync(process.argv[3] ? join(workspace, 'README.md') : join(workspace, 'SOURCES.md'), 'source fixture' + String.fromCharCode(10));

const posts = [], toolCalls = [];
let seq = 0;
const frame = (type, body) => 'event: ' + type + String.fromCharCode(10) + 'data: ' + JSON.stringify({ type, sequence_number: seq++, ...body }) + String.fromCharCode(10, 10);
const declaration = (name, required) => ({ type: 'function', name, description: name + ' (Dream Maker controlled project tool)',
    parameters: { type: 'object', required, properties: Object.fromEntries(required.map(k => [k, { type: 'string' }])) } });

/** One answer, either a read call or the final text, in the Responses SSE shape. */
function answer(res, body, round) {
    posts.push({ round, tools: (body.tools ?? []).map(t => t.name), input: body.input });
    const model = 'deepseek-flash', id = 'resp_' + round, itemId = 'fc_probe_' + round, created = { object: 'response', id, model, status: 'in_progress', output: [], usage: null };
    let out = frame('response.created', { response: created });
    const wantRead = round === 1;
    if (wantRead) {
        const call = { type: 'function_call', id: itemId, call_id: 'call_' + round, name: 'desk_read' };
        out += frame('response.output_item.added', { output_index: 0, item: { ...call, status: 'in_progress', arguments: '' } });
        out += frame('response.function_call_arguments.delta', { item_id: itemId, output_index: 0, delta: JSON.stringify({ path: 'SPEC.md' }) });
        out += frame('response.function_call_arguments.done', { item_id: itemId, output_index: 0, arguments: JSON.stringify({ path: 'SPEC.md' }) });
        out += frame('response.output_item.done', { output_index: 0, item: { ...call, status: 'completed', arguments: JSON.stringify({ path: 'SPEC.md' }) } });
        out += frame('response.completed', { response: { object: 'response', id, model, status: 'completed',
            output: [{ ...call, status: 'completed', arguments: JSON.stringify({ path: 'SPEC.md' }) }],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 } } } });
    } else {
        const text = role === 'reviewer'
            ? 'REVIEW: verdict=pass; the spec asks for one integer sum and the source fixture agrees.'
            : 'PLAN: 1) read the spec; 2) sum the two integers; 3) verify the printed result.';
        const part = { type: 'output_text', text: '', annotations: [] };
        out += frame('response.output_item.added', { output_index: 0, item: { type: 'message', role: 'assistant', id: itemId, status: 'in_progress', content: [] } });
        out += frame('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part });
        out += frame('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text });
        out += frame('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text });
        out += frame('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: { ...part, text } });
        const item = { type: 'message', role: 'assistant', id: itemId, status: 'completed', content: [{ ...part, text }] };
        out += frame('response.output_item.done', { output_index: 0, item });
        out += frame('response.completed', { response: { object: 'response', id, model, status: 'completed', output: [item],
            usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160, input_tokens_details: { cached_tokens: 0 } } } });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(out);
    // Synthetic receipt list: this probe measures the CLI, not the Magpie ledger.
    receipts.push({ id: 'receipt_' + round, outcome: 'COMPLETE', completionObserved: true, observedModel: model });
}

const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/tools') {
        toolCalls.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(body.name === 'desk_read'
            ? { path: body.args.path, exists: true, sha256: 'a'.repeat(64), content: 'The product must sum two integers and print the result' }
            : { matches: [] }));
    }
    if (!req.url.startsWith('/v1/responses') && !req.url.startsWith('/v1')) { res.writeHead(404); return res.end(); }
    answer(res, body, posts.length + 1);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const receipts = [];
const runner = new PiRunner(() => ({ pi: { cliPath: cli, timeoutMs: 120000 } }), root,
    async () => ({ url: 'http://127.0.0.1:' + port + '/v1', token: 'g'.repeat(64), close: async () => {}, receipts: () => receipts }),
    { role, roleId: role, model: 'deepseek-flash', provider: 'deepseek-official', protocol: 'openai-responses',
        maxOutputTokens: 4096, tools: [...PI_READ_ONLY_TOOLS], assertCurrent: () => {} },
    async () => ({ url: 'http://127.0.0.1:' + port + '/tools', token: 't'.repeat(64), close: async () => {} }));
const input = { role, workspace, model: 'deepseek-flash', specHash: 'a'.repeat(64), runId: 'run_probe',
    prompt: role === 'reviewer' ? 'Review the workspace and answer with REVIEW: verdict=...' : 'Read SPEC.md and answer with a PLAN',
    signal: new AbortController().signal,
    laya: { role, mode: 'off', adoption: 'off', label: null, reason: 'OFFLINE_PROBE', latencyMs: 0, inputHash: 'b'.repeat(64), modelRevision: null, confidence: null, cached: false } };
let out;
try {
    out = await runner.run(input, () => {});
} finally {
    await new Promise(resolve => server.close(resolve));
}
const report = {
    scope: 'PROCESS_LEVEL_LOOPBACK_NOT_MAGPIE_METERED', role, cli,
    upstreamPosts: posts.length, postsByRound: posts.map(p => ({ round: p.round, tools: p.tools })),
    toolsDeclared: posts.length ? posts[0].tools : [], writeToolDeclared: posts.some(p => p.tools.some(t => ['desk_write', 'desk_edit', 'desk_run'].includes(t))),
    toolCalls: toolCalls.map(c => c.name), sessionId: out.sessionId, model: out.model, text: out.text,
    usageRole: out.usage.role, requestId: out.usage.requestId, paidMicros: 0
};
try { (await import('node:fs')).writeFileSync('.runtime/pi-bodies.json', JSON.stringify(posts.map(p => p.input ? p : p), null, 1)); } catch {}
console.log(JSON.stringify(report, null, 1));
