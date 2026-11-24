// The independent second provider: offline tests only. A loopback http server stands in for the
// provider so the transport, the payload shape, the thread continuity, the credential handling and the
// request cap are all exercised without a single token being spent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { roleRunner } from '../dist/server/engine.js';
import { IndependentRunner } from '../dist/server/providers/independent.js';
import { DomainError } from '../dist/server/security.js';
import { defaults } from '../dist/server/config.js';

const section = over => ({ ...defaults.independent, enabled: true, model: 'probe-model', protocol: 'chat-completions', keyEnv: 'DM_TEST_INDEPENDENT_KEY', maxOutputTokens: 128, maxRequests: 4, ...over });
// The product's default request function is jsonFetch, whose target allowlist deliberately refuses
// loopback test servers. Tests therefore inject a real-HTTP request of the same shape: the payload,
// the headers, the thread and the response parsing are all still exercised, and the allowlist keeps
// its own separate guard (tests/network-target.test.mjs).
const httpRequest = async (url, init) => {
    const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    const text = await response.text();
    if (!response.ok) throw new DomainError('UPSTREAM_HTTP_' + response.status, 502);
    return JSON.parse(text);
};
const runnerFor = config => new IndependentRunner(config, httpRequest);
const configWith = over => ({ ...structuredClone(defaults), independent: section(over) });

async function provider(handler) {
    const requests = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const parsed = body ? JSON.parse(body) : null;
            requests.push({ url: req.url, authorization: req.headers.authorization, body: parsed });
            const reply = handler(parsed, requests.length);
            res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(reply.body));
        });
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    const close = () => new Promise(done => {
        server.closeAllConnections();
        server.close(done);
    });
    return { baseUrl: 'http://127.0.0.1:' + port + '/v1', requests, close };
}

const input = over => ({ role: 'planner2', workspace: '.', prompt: 'plan it', model: 'ignored', specHash: 'a'.repeat(64), runId: 'run_test', laya: { role: 'planner2', mode: 'off', adoption: 'off' }, signal: new AbortController().signal, ...over });
const withKey = async (fn) => { process.env.DM_TEST_INDEPENDENT_KEY = 'test-key-value'; try { return await fn(); } finally { delete process.env.DM_TEST_INDEPENDENT_KEY; } };

test('a disabled provider refuses instead of quietly using another one', async () => {
    const runner = new IndependentRunner(() => ({ ...structuredClone(defaults), independent: { ...section({}), enabled: false } }));
    await assert.rejects(() => runner.run(input(), () => { }), { code: 'INDEPENDENT_PROVIDER_DISABLED' });
});

test('an enabled provider without a model or without a credential refuses by name', async () => {
    await assert.rejects(() => new IndependentRunner(() => configWith({ model: '' })).run(input(), () => { }), { code: 'INDEPENDENT_MODEL_REQUIRED' });
    await assert.rejects(() => new IndependentRunner(() => configWith({})).run(input(), () => { }), { code: 'INDEPENDENT_KEY_MISSING' });
});

test('a real loopback round trip returns text, usage and the provider session id', async () => {
    const fake = await provider(() => ({ body: { id: 'chatcmpl-1', model: 'probe-model', choices: [{ message: { content: '{"keys":["a"],"titles":["A"],"notes":"n"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } } }));
    try {
        const runner = runnerFor(() => configWith({ baseUrl: fake.baseUrl }));
        const events = [];
        const out = await withKey(() => runner.run(input(), event => events.push(event)));
        assert.equal(out.text, '{"keys":["a"],"titles":["A"],"notes":"n"}');
        assert.equal(out.sessionId, 'chatcmpl-1');
        // The role identity recorded for a turn must be the model that answered it. The engine used to write
        // config.codex.model for every non-executor role, so planner2/reviewer turns answered by this provider
        // were recorded as 'gpt-5.1-codex' (run_ab915f0a570dd1c82964).
        assert.equal(out.model, 'probe-model');
        assert.deepEqual({ in: out.usage.inputTokens, out: out.usage.outputTokens, source: out.usage.source }, { in: 11, out: 7, source: 'PROVIDER' });
        assert.equal(fake.requests.length, 1);
        assert.equal(fake.requests[0].url, '/v1/chat/completions');
        assert.equal(fake.requests[0].authorization, 'Bearer test-key-value');
        assert.equal(fake.requests[0].body.model, 'probe-model');
        assert.equal(fake.requests[0].body.max_tokens, 128, 'a chat-completions endpoint gets the token field and no stream flag mismatch');
        assert.equal(fake.requests[0].body.messages[0].role, 'system');
        assert.equal(fake.requests[0].body.messages[1].content, 'plan it');
        const event = events.find(one => one.method === 'dm/independent');
        assert.equal(event.params.authentication, 'API_KEY');
        assert.equal(event.params.provider, 'openai-compatible');
        assert.ok(!JSON.stringify(events).includes('test-key-value'), 'the key never reaches an event');
    } finally { await fake.close(); }
});

test('the second turn keeps the conversation, and the request cap is enforced', async () => {
    const fake = await provider(() => ({ body: { id: 'chatcmpl-2', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }));
    process.env.DM_TEST_INDEPENDENT_KEY = 'test-key-value';
    try {
        const capped = runnerFor(() => configWith({ baseUrl: fake.baseUrl, maxRequests: 1 }));
        await capped.run(input(), () => { });
        await assert.rejects(() => capped.run(input({ prompt: 'again' }), () => { }), { code: 'INDEPENDENT_REQUEST_CAP_REACHED' });
        const thread = runnerFor(() => configWith({ baseUrl: fake.baseUrl, maxRequests: 4 }));
        await thread.run(input(), () => { });
        await thread.run(input({ prompt: 'again' }), () => { });
        const messages = fake.requests.at(-1).body.messages;
        assert.equal(messages.length, 4, 'system + first user + first assistant + second user');
        assert.equal(messages[2].role, 'assistant');
        assert.equal(messages[3].content, 'again');
    } finally { delete process.env.DM_TEST_INDEPENDENT_KEY; await fake.close(); }
});

test('the planner2 system contract requires coherent tasks of at most eight executor tool calls', async () => {
    const fake = await provider(() => ({ body: {
        id: 'chatcmpl-granularity',
        choices: [{ message: { content: '{"tasks":[{"id":"T1","title":"slice","dependsOn":[],"requirementIds":["R1"],"acceptance":["check"]}]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
    } }));
    try {
        const runner = runnerFor(() => configWith({ baseUrl: fake.baseUrl }));
        await withKey(() => runner.run(input(), () => {}));
        const contract = fake.requests[0].body.messages[0].content;
        assert.match(contract, /one executor turn can finish in at most 8 tool calls/);
        assert.match(contract, /split broad setup, data, UI, integration and verification work/);
        assert.match(contract, /mega-task/);
    } finally { await fake.close(); }
});

test('both independent supervision contracts say that tools are unavailable', async () => {
    const fake = await provider(() => ({ body: {
        id: 'chatcmpl-no-tools',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
    } }));
    try {
        const runner = runnerFor(() => configWith({ baseUrl: fake.baseUrl, maxRequests: 4 }));
        for (const role of ['planner2', 'reviewer'])
            await withKey(() => runner.run(input({ role, prompt: role }), () => {}));
        assert.equal(fake.requests.length, 2);
        for (const request of fake.requests) {
            const contract = request.body.messages[0].content;
            assert.match(contract, /No tools are available in this role/);
            assert.match(contract, /never emit tool calls/);
            assert.equal(request.body.tools, undefined);
        }
    } finally { await fake.close(); }
});

// The empty-after-length ladder has no other coverage, and it is the mechanism that unblocked the reviewer:
// run_a0ec14050b0822eb9236 answered two 16000-token attempts with reasoning only, and the same packet came
// back at 32000 in 67 s. It must climb, stay bounded, and count every attempt against the per-process cap.
test('an empty answer that ran out of budget climbs 16000 then 32000, and stops there', async () => {
    const fake = await provider((body, n) => n < 3
        ? ({ body: { id: 'chatcmpl-empty-' + n, choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 9, completion_tokens: 0 } } })
        : ({ body: { id: 'chatcmpl-ok', model: 'probe-model', choices: [{ message: { content: '{"verdict":"PASS","findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 7 } } }));
    process.env.DM_TEST_INDEPENDENT_KEY = 'test-key-value';
    try {
        const runner = runnerFor(() => configWith({ baseUrl: fake.baseUrl, maxRequests: 8 }));
        const events = [];
        const out = await withKey(() => runner.run(input(), event => events.push(event)));
        assert.equal(out.text, '{"verdict":"PASS","findings":[]}');
        assert.deepEqual(fake.requests.map(r => r.body.max_tokens), [128, 16000, 32000], 'the ladder is 16000 then 32000, never the config value again');
        assert.deepEqual(events.filter(e => e.method === 'dm/independentRetry').map(e => e.params.maxTokens), [16000, 32000]);
    } finally { delete process.env.DM_TEST_INDEPENDENT_KEY; await fake.close(); }
});

test('the ladder is bounded: an answer that stays empty fails instead of climbing forever', async () => {
    const fake = await provider((body, n) => ({ body: { id: 'chatcmpl-still-empty-' + n, choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 9, completion_tokens: 0 } } }));
    process.env.DM_TEST_INDEPENDENT_KEY = 'test-key-value';
    try {
        const runner = runnerFor(() => configWith({ baseUrl: fake.baseUrl, maxRequests: 8 }));
        await assert.rejects(() => withKey(() => runner.run(input(), () => { })), { code: 'INDEPENDENT_RESPONSE_EMPTY' });
        assert.deepEqual(fake.requests.map(r => r.body.max_tokens), [128, 16000, 32000], 'exactly three attempts, then a refusal');
    } finally { delete process.env.DM_TEST_INDEPENDENT_KEY; await fake.close(); }
});

test('the retries are counted against the request cap instead of overrunning it', async () => {
    const fake = await provider((body, n) => ({ body: { id: 'chatcmpl-cap-' + n, choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 9, completion_tokens: 0 } } }));
    process.env.DM_TEST_INDEPENDENT_KEY = 'test-key-value';
    try {
        // 1 initial attempt + 1 rung fits; the second rung has to be refused by the cap, not spent.
        const runner = runnerFor(() => configWith({ baseUrl: fake.baseUrl, maxRequests: 2 }));
        await assert.rejects(() => withKey(() => runner.run(input(), () => { })), { code: 'INDEPENDENT_REQUEST_CAP_REACHED' });
        assert.equal(fake.requests.length, 2, 'no third request escapes the cap');
    } finally { delete process.env.DM_TEST_INDEPENDENT_KEY; await fake.close(); }
});

test('an empty answer cannot dispatch its larger retry after the caller cancels', async () => {
    const controller = new AbortController();
    let calls = 0;
    const runner = new IndependentRunner(
        () => configWith({ maxRequests: 8 }),
        async () => {
            calls += 1;
            controller.abort();
            return {
                id: 'chatcmpl-cancelled',
                choices: [{ message: { content: '' }, finish_reason: 'length' }],
                usage: { prompt_tokens: 9, completion_tokens: 0 }
            };
        },
        () => 'test-key-value'
    );
    await assert.rejects(
        () => runner.run(input({ signal: controller.signal }), () => {}),
        { code: 'RUN_CANCELLED' }
    );
    assert.equal(calls, 1, 'cancellation must stop the paid retry before dispatch');
});

test('the larger retry keeps the original signal and reports its classified failure', async () => {
    const controller = new AbortController();
    const signals = [];
    const failure = {
        classification: 'STREAM_INTERRUPTED',
        layer: 'TRANSPORT',
        context: 'RESPONSE',
        httpStatus: null,
        requestIdSha256: null,
        retry: 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION',
        automaticRetryAllowed: true,
        recordedAt: new Date().toISOString()
    };
    const runner = new IndependentRunner(
        () => configWith({ maxRequests: 8 }),
        async (_url, init) => {
            signals.push(init.signal);
            if (signals.length === 1) {
                return {
                    id: 'chatcmpl-empty',
                    choices: [{ message: { content: '' }, finish_reason: 'length' }],
                    usage: { prompt_tokens: 9, completion_tokens: 0 }
                };
            }
            throw Object.assign(new Error('stream interrupted'), {
                code: 'UPSTREAM_INTERRUPTED',
                networkFailure: failure
            });
        },
        () => 'test-key-value'
    );
    const events = [];
    await assert.rejects(
        () => runner.run(input({ signal: controller.signal }), event => events.push(event)),
        error => error.networkFailure?.classification === 'STREAM_INTERRUPTED'
    );
    assert.equal(signals.length, 2);
    assert.equal(signals[0], controller.signal);
    assert.equal(signals[1], controller.signal, 'the bounded retry keeps the original cancellation signal');
    const event = events.find(one => one.method === 'dm/independentFailure');
    assert.equal(event.params.networkFailureClass, 'STREAM_INTERRUPTED');
    assert.equal(event.params.retry, 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION');
});
test('the Responses shape is chosen for api.openai.com and reads its own usage fields', async () => {
    const fake = await provider(() => ({ body: { id: 'resp_1', model: 'gpt-test', status: 'completed', output: [{ content: [{ text: '{"ok":true}' }] }], usage: { input_tokens: 5, output_tokens: 9 } } }));
    try {
        const runner = runnerFor(() => configWith({ baseUrl: fake.baseUrl, protocol: 'openai-responses' }));
        const out = await withKey(() => runner.run(input({ role: 'reviewer' }), () => { }));
        assert.equal(out.text, '{"ok":true}');
        assert.equal(out.usage.inputTokens, 5);
        assert.equal(out.usage.outputTokens, 9);
        assert.equal(fake.requests[0].url, '/v1/responses');
        assert.equal(fake.requests[0].body.max_output_tokens, 128);
        assert.ok(Array.isArray(fake.requests[0].body.input));
    } finally { await fake.close(); }
});

test('role-bound transport keeps planner2 and reviewer request evidence separate', async () => {
    const calls = [];
    let fallbackCalls = 0;
    const response = role => ({
        id: 'chatcmpl-' + role,
        model: 'probe-model',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
    const requestForRole = role => {
        assert.ok(['planner2', 'reviewer'].includes(role));
        return async url => {
            calls.push({ role, url });
            return response(role);
        };
    };
    const runner = new IndependentRunner(
        () => configWith({}),
        async () => { fallbackCalls += 1; throw new Error('ROLE_BOUND_TRANSPORT_BYPASSED'); },
        () => 'test-key-value',
        requestForRole
    );
    await runner.run(input({ role: 'planner2' }), () => {});
    await runner.run(input({ role: 'reviewer' }), () => {});
    assert.deepEqual(calls.map(call => call.role), ['planner2', 'reviewer']);
    assert.equal(fallbackCalls, 0);
});

test('the larger retry stays on the same role-bound transport', async () => {
    const calls = [];
    let fallbackCalls = 0;
    const runner = new IndependentRunner(
        () => configWith({ maxRequests: 8 }),
        async () => {
            fallbackCalls += 1;
            throw new Error('ROLE_BOUND_RETRY_BYPASSED');
        },
        () => 'test-key-value',
        role => async () => {
            calls.push(role);
            return calls.length === 1
                ? {
                    id: 'chatcmpl-empty',
                    choices: [{ message: { content: '' }, finish_reason: 'length' }],
                    usage: { prompt_tokens: 9, completion_tokens: 0 }
                }
                : {
                    id: 'chatcmpl-retried',
                    choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 9, completion_tokens: 3 }
                };
        }
    );
    const result = await runner.run(input({ role: 'reviewer' }), () => {});
    assert.equal(result.text, '{"ok":true}');
    assert.deepEqual(calls, ['reviewer', 'reviewer']);
    assert.equal(fallbackCalls, 0);
});

test('an upstream 401 is reported as itself, not as an empty answer', async () => {
    const fake = await provider(() => ({ status: 401, body: { error: { code: 'invalid_api_key' } } }));
    try {
        const runner = runnerFor(() => configWith({ baseUrl: fake.baseUrl }));
        const events = [];
        await withKey(() => assert.rejects(() => runner.run(input(), event => events.push(event)), error => error instanceof DomainError));
        assert.equal(events.find(one => one.method === 'dm/independentFailure').params.code, 'UPSTREAM_HTTP_401');
    } finally { await fake.close(); }
});

test('role dispatch: the executor never moves, the two Codex roles move only when enabled and wired', () => {
    const executor = { run: async () => ({ text: 'e', sessionId: 's', usage: {} }) };
    const codex = { run: async () => ({ text: 'c', sessionId: 's', usage: {} }) };
    const independent = { run: async () => ({ text: 'i', sessionId: 's', usage: {} }) };
    const enabled = configWith({});
    const off = { ...structuredClone(defaults), independent: { ...section({}), enabled: false } };
    assert.equal(roleRunner('executor', enabled, { executor: () => executor, codex: () => codex, independent }), executor);
    assert.equal(roleRunner('planner2', enabled, { executor: () => executor, codex: () => codex, independent }, 'LEGACY_CONFIGURED_V1'), independent);
    assert.equal(roleRunner('reviewer', enabled, { executor: () => executor, codex: () => codex, independent }, 'LEGACY_CONFIGURED_V1'), independent);
    assert.equal(roleRunner('planner2', off, { executor: () => executor, codex: () => codex, independent }), codex);
    assert.equal(roleRunner('planner1', enabled, { executor: () => executor, codex: () => codex, independent }), codex, 'planner1 stays on its own binding');
    assert.throws(() => roleRunner('planner2', enabled, { executor: () => executor, codex: () => codex }, 'LEGACY_CONFIGURED_V1'), { code: 'INDEPENDENT_RUNNER_REQUIRED' });
});

// A reasoning model on the chat wire can spend the whole output budget on its reasoning and answer
// with an empty content string (measured on deepseek-v4-pro: 8192 completion tokens, 8192 reasoning
// tokens, zero content). `reasoning_effort` is the upstream's own lever for that; it must only be
// sent when a caller explicitly asks for it, so every other provider keeps its exact old body.
test('a chat-completions body carries reasoning_effort only when the caller set one', async () => {
    const fake = await provider(() => ({ body: { id: 'chatcmpl-effort', model: 'probe-model', choices: [{ message: { content: '{"verdict":"PASS","findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } } }));
    try {
        const plain = new IndependentRunner(() => configWith({ baseUrl: fake.baseUrl }), httpRequest, () => 'test-key-value');
        await plain.run(input({ role: 'reviewer' }), () => { });
        assert.equal(Object.hasOwn(fake.requests[0].body, 'reasoning_effort'), false, 'an unset effort must not appear in the request body');

        for (const effort of ['low', 'medium', 'high']) {
            const runner = new IndependentRunner(() => configWith({ baseUrl: fake.baseUrl }), httpRequest, () => 'test-key-value', undefined, effort);
            await runner.run(input({ role: 'reviewer' }), () => { });
            assert.equal(fake.requests.at(-1).body.reasoning_effort, effort);
        }
    } finally { await fake.close(); }
});

test('the responses wire keeps its own reasoning envelope and never mixes in reasoning_effort', async () => {
    const requests = [];
    const request = async (url, init) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return { id: 'resp-1', model: 'probe-model', output_text: '{"verdict":"PASS","findings":[]}', output: [{ content: [{ type: 'output_text', text: '{"verdict":"PASS","findings":[]}' }] }], usage: { input_tokens: 4, output_tokens: 2 } };
    };
    const runner = new IndependentRunner(
        () => ({ ...structuredClone(defaults), independent: section({ baseUrl: 'https://provider.invalid/v1', protocol: 'openai-responses' }) }),
        request,
        () => 'test-key-value',
        undefined,
        'high'
    );
    await runner.run(input({ role: 'reviewer' }), () => { });
    assert.equal(requests[0].url, 'https://provider.invalid/v1/responses');
    assert.equal(Object.hasOwn(requests[0].body, 'reasoning_effort'), false);
    assert.deepEqual(requests[0].body.reasoning, { effort: 'minimal' });
});
