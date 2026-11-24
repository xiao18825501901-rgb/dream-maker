import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KimiRunner, createKimiTransport } from '../dist/server/providers/kimi.js';
import { defaults, parseConfig } from '../dist/server/config.js';
import { createKimiAdmission } from '../dist/server/kimi-admission.js';
import { attachHttpStatus } from '../dist/server/kimi-auth-errors.js';

// Offline protocol tests for the planner1 runner. The transport is a fake, so no local
// server is contacted and no model is called; every fixture below is labelled synthetic.

// A01: the runner now refuses to send without explicit Extra Usage evidence. These protocol
// fixtures are about frames/cancelling/usage, so every runner here carries an OFF attestation for
// the same synthetic account; tests/kimi-admission.test.mjs owns the gate matrix itself.
const ALLOW = createKimiAdmission({
    schema: 1, state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:user_synthetic',
    observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
});
class AllowRunner extends KimiRunner {
    constructor(config, transport, clock, wait, admission = ALLOW) { super(config, transport, clock, wait, admission); }
}

const cfg = () => parseConfig(structuredClone(defaults));
const input = (over = {}) => ({ role: 'planner1', workspace: '/opt/w', prompt: 'p', model: 'kimi-code/kimi-for-coding', specHash: 'h', runId: 'r', laya: { adoption: 'off' }, signal: new AbortController().signal, ...over });
const okAuth = { code: 0, data: { models_ready: true, providers_count: 1 } };
const okSession = { code: 0, data: { id: 'session_synthetic_1' } };
const okPrompt = { code: 0, data: { prompt_id: 'msg_synthetic_1', status: 'running' } };
const turn = (state, frames, usage = { input_tokens: 12, output_tokens: 34 }) => ({ code: 0, data: { items: [{ state, steps: [{ frames, usage }] }] } });

const okUserinfo = { code: 0, data: { kind: 'ok', userInfo: { userId: 'user_synthetic', userLevelName: 'Plus' } } };
function rig(t, { auth = okAuth, userinfo = okUserinfo, session = okSession, prompt = okPrompt, turns = [], onCall } = {}) {
    const calls = [];
    let index = 0;
    const transport = async (path, init) => {
        calls.push({ path, method: init?.method ?? 'GET' });
        if (onCall) onCall(path, init);
        if (path === '/api/v1/auth') return auth;
        if (path === '/api/v1/oauth/userinfo') return userinfo;
        if (path === '/api/v1/sessions') return session;
        if (path.endsWith('/prompts')) return prompt;
        if (path.includes('/transcript')) return turns[Math.min(index++, turns.length - 1)] ?? turn('running', []);
        if (path.endsWith('/snapshot')) return { code: 0, data: { session: { usage: { input_tokens: 12, output_tokens: 34 } } } };
        throw new Error('unexpected path ' + path);
    };
    // A01 moved the Extra Usage gate into the runner. These protocol fixtures are about frames,
    // cancelling and usage, so they hand the runner an explicit OFF attestation for the same
    // synthetic account; the gate itself is covered by tests/kimi-admission.test.mjs.
    const admission = createKimiAdmission({
        schema: 1, state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:user_synthetic',
        observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    });
    return { calls, runner: new AllowRunner(cfg, transport, () => 0, async () => {}, admission) };
}

test('K03-K1 the runner refuses to dispatch without an authenticated provider', async t => {
    const { calls, runner } = rig(t, { auth: { code: 0, data: { models_ready: false, providers_count: 0 } } });
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_NOT_AUTHENTICATED' });
    assert.equal(calls.length, 1);
});

test('K03-K2 non-planner1 roles are refused before any transport call', async t => {
    const { calls, runner } = rig(t, {});
    await assert.rejects(runner.run(input({ role: 'planner2' }), () => {}), { code: 'KIMI_ROLE_DENIED' });
    assert.equal(calls.length, 0);
});

test('K03-K3 a completed turn returns the answer text and provider usage', async t => {
    const events = [];
    const { runner } = rig(t, { turns: [turn('completed', [{ kind: 'thinking', text: 'secret reasoning' }, { kind: 'text', role: 'assistant', text: '{"ok":true}' }])] });
    const out = await runner.run(input(), e => events.push(e));
    assert.equal(out.text, '{"ok":true}');
    assert.equal(out.sessionId, 'session_synthetic_1');
    assert.equal(out.usage.inputTokens, 12);
    assert.equal(out.usage.outputTokens, 34);
    assert.equal(out.usage.costUsd, null);
    assert.equal(JSON.stringify(out).includes('secret reasoning'), false);
    assert.ok(events.some(e => e.method === 'dm/kimiAccepted'));
    assert.ok(events.some(e => e.method === 'dm/kimiCompletion'));
});

test('K03-K4 any tool frame is a zero-tool policy violation', async t => {
    const { runner } = rig(t, { turns: [turn('completed', [{ kind: 'tool', name: 'Bash' }, { kind: 'text', role: 'assistant', text: 'x' }])] });
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_TOOL_EVENT_VIOLATION' });
});

test('K03-K5 failed, cancelled and blocked terminals never produce text', async t => {
    for (const state of ['failed', 'cancelled', 'blocked', 'interrupted']) {
        const { runner } = rig(t, { turns: [turn(state, [{ kind: 'text', role: 'assistant', text: 'partial' }])] });
        await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_TURN_NOT_COMPLETED' }, state);
    }
});

test('K03-K6 an empty answer is an error, not a success', async t => {
    const { runner } = rig(t, { turns: [turn('completed', [{ kind: 'text', role: 'assistant', text: '   ' }])] });
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_EMPTY_OUTPUT' });
});

test('K03-K7 a non-zero business code is refused even at HTTP level success', async t => {
    const { runner } = rig(t, { prompt: { code: 40113, msg: 'model unresolved' } });
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_API_ERROR' });
});

test('K03-K8 cancellation before dispatch and during polling both surface RUN_CANCELLED', async t => {
    const aborted = new AbortController();
    aborted.abort();
    const first = rig(t, {});
    await assert.rejects(first.runner.run(input({ signal: aborted.signal }), () => {}), { code: 'RUN_CANCELLED' });
    const controller = new AbortController();
    const calls = [];
    const runner = new AllowRunner(cfg, async (path, init) => {
        calls.push(path);
        if (path === '/api/v1/auth') return okAuth;
        if (path === '/api/v1/oauth/userinfo') return okUserinfo;
        if (path === '/api/v1/sessions') return okSession;
        if (path.endsWith('/prompts')) return okPrompt;
        controller.abort();
        return turn('running', []);
    }, () => 0, async () => {});
    await assert.rejects(runner.run(input({ signal: controller.signal }), () => {}), { code: 'RUN_CANCELLED' });
});

test('K03-K9 the loopback base URL is validated by config parsing', () => {
    const bad = structuredClone(defaults);
    bad.kimi = { baseUrl: 'https://api.kimi.com/coding/v1', timeoutMs: 1000, pollMs: 100 };
    assert.throws(() => parseConfig(bad));
    const good = structuredClone(defaults);
    assert.match(String(parseConfig(good).kimi.baseUrl), /^http:\/\/127\.0\.0\.1:58631\/?$/);
});

test('K03-K10 the transport reads the bearer from the token file and never returns it', async t => {
    const dir = mkdtempSync(resolve(tmpdir(), 'dm-kimi-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const tokenFile = resolve(dir, 'server.token');
    writeFileSync(tokenFile, 'SYNTHETIC_MANAGEMENT_TOKEN_VALUE\n');
    const seen = [];
    const fetchImpl = async (url, init) => {
        seen.push({ url, init });
        return { code: 0, data: { ok: true } };
    };
    const transport = createKimiTransport({ baseUrl: 'http://127.0.0.1:58631/', tokenFile, fetchImpl });
    const body = await transport('/api/v1/auth');
    assert.deepEqual(body, { code: 0, data: { ok: true } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'http://127.0.0.1:58631/api/v1/auth');
    assert.equal(seen[0].init.headers.authorization, 'Bearer SYNTHETIC_MANAGEMENT_TOKEN_VALUE');
    assert.equal(JSON.stringify(body).includes('SYNTHETIC_MANAGEMENT_TOKEN_VALUE'), false);
});

test('K03-K11 the transport refuses a missing token, a short token and a non-api path', async t => {
    const dir = mkdtempSync(resolve(tmpdir(), 'dm-kimi-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const missing = createKimiTransport({ baseUrl: 'http://127.0.0.1:1', tokenFile: resolve(dir, 'absent'), fetchImpl: async () => ({}) });
    await assert.rejects(missing('/api/v1/auth'), { code: 'KIMI_SERVER_TOKEN_MISSING' });
    const short = resolve(dir, 'short.token');
    writeFileSync(short, 'abc');
    const weak = createKimiTransport({ baseUrl: 'http://127.0.0.1:1', tokenFile: short, fetchImpl: async () => ({}) });
    await assert.rejects(weak('/api/v1/auth'), { code: 'KIMI_SERVER_TOKEN_MISSING' });
    const good = resolve(dir, 'good.token');
    writeFileSync(good, 'SYNTHETIC_MANAGEMENT_TOKEN_VALUE');
    const guarded = createKimiTransport({ baseUrl: 'http://127.0.0.1:1', tokenFile: good, fetchImpl: async () => ({}) });
    await assert.rejects(guarded('/openapi.json'), { code: 'KIMI_PATH_DENIED' });
    await assert.rejects(guarded('http://evil.example/api/v1/auth'), { code: 'KIMI_PATH_DENIED' });
});

test('K03-K12 kimi stays disabled and token-less by default', () => {
    const c = parseConfig(structuredClone(defaults));
    assert.equal(c.kimi.enabled, false);
    assert.equal(c.kimi.tokenFile, '');
});
test('K03-K13 an empty userinfo is refused even when models_ready is true', async t => {
    // Observed on this machine: after a restart models_ready stayed true while userinfo was empty
    // and the turn failed with "No token for kimi-code".
    const { runner } = rig(t, { userinfo: { code: 0, data: { kind: 'ok', userInfo: {} } } });
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_ACCOUNT_NOT_BOUND' });
    const { calls, runner: r2 } = rig(t, { userinfo: { code: 0, data: { kind: 'ok' } } });
    await assert.rejects(r2.run(input(), () => {}), { code: 'KIMI_ACCOUNT_NOT_BOUND' });
});
test('K03-K15 billable input adds cache reads to the uncached input', async t => {
    const snapshot = { code: 0, data: { session: { usage: { input_tokens: 0, output_tokens: 157, cache_read_tokens: 1487 } } } };
    const runner = new AllowRunner(cfg, async path => {
        if (path === '/api/v1/auth') return okAuth;
        if (path === '/api/v1/oauth/userinfo') return okUserinfo;
        if (path === '/api/v1/sessions') return okSession;
        if (path.endsWith('/prompts')) return okPrompt;
        if (path.endsWith('/snapshot')) return snapshot;
        if (path.includes('/transcript')) return turn('completed', [{ kind: 'text', role: 'assistant', text: 'ok' }], {});
        throw new Error('unexpected ' + path);
    }, () => 0, async () => {});
    const events = [];
    const out = await runner.run(input(), e => events.push(e));
    assert.equal(out.usage.inputTokens, 1487);
    assert.equal(out.usage.outputTokens, 157);
    const completion = events.find(e => e.method === 'dm/kimiCompletion');
    assert.equal(completion.params.rawInputTokens, 0);
    assert.equal(completion.params.cacheReadTokens, 1487);
    assert.equal(completion.params.billableInputTokens, 1487);
});

test('K03-K14 token counts come from the session snapshot when the step usage lacks them', async t => {
    const { runner } = rig(t, { turns: [turn('completed', [{ kind: 'text', role: 'assistant', text: '{"ok":1}' }], {})] });
    const out = await runner.run(input(), () => {});
    assert.equal(out.usage.inputTokens, 12);
    assert.equal(out.usage.outputTokens, 34);
    assert.equal(out.usage.costUsd, null);
});
test('K03-K16 a cancellation during the poll interval is noticed before the next request', async t => {
    const controller = new AbortController();
    const calls = [];
    const runner = new AllowRunner(cfg, async (path) => {
        calls.push(path);
        if (path === '/api/v1/auth') return okAuth;
        if (path === '/api/v1/oauth/userinfo') return okUserinfo;
        if (path === '/api/v1/sessions') return okSession;
        if (path.endsWith('/prompts')) return okPrompt;
        if (path.includes('/transcript')) return turn('running', []);
        throw new Error('unexpected ' + path);
    }, () => 0, async () => { controller.abort(); });
    await assert.rejects(runner.run(input({ signal: controller.signal }), () => {}), { code: 'RUN_CANCELLED' });
    assert.equal(calls.filter(p => p.includes('/transcript')).length, 0, 'no transcript request after the cancel');
});
test('K03-K17 the session is archived after a completed run, and archiving failure is invisible', async t => {
    const archived = [];
    const runner = new AllowRunner(cfg, async (path, init) => {
        if (path === '/api/v1/auth') return okAuth;
        if (path === '/api/v1/oauth/userinfo') return okUserinfo;
        if (path === '/api/v1/sessions') return okSession;
        if (path.endsWith('/prompts')) return okPrompt;
        if (path.includes('/transcript')) return turn('completed', [{ kind: 'text', role: 'assistant', text: 'ok' }]);
        if (path.endsWith('/snapshot')) return { code: 0, data: { session: { usage: {} } } };
        if (path.endsWith(':archive')) { archived.push(path); return { code: 0 }; }
        throw new Error('unexpected ' + path);
    }, () => 0, async () => {});
    const out = await runner.run(input(), () => {});
    assert.equal(out.text, 'ok');
    assert.deepEqual(archived, ['/api/v1/sessions/session_synthetic_1:archive']);
});

test('K03-K18 an archive failure never replaces the real result or error', async t => {
    const runner = new AllowRunner(cfg, async (path) => {
        if (path === '/api/v1/auth') return okAuth;
        if (path === '/api/v1/oauth/userinfo') return okUserinfo;
        if (path === '/api/v1/sessions') return okSession;
        if (path.endsWith('/prompts')) return okPrompt;
        if (path.includes('/transcript')) return turn('completed', [{ kind: 'text', role: 'assistant', text: 'ok' }]);
        if (path.endsWith('/snapshot')) return { code: 0, data: { session: { usage: {} } } };
        if (path.endsWith(':archive')) throw new Error('archive exploded');
        throw new Error('unexpected ' + path);
    }, () => 0, async () => {});
    const out = await runner.run(input(), () => {});
    assert.equal(out.text, 'ok');
});
test('K03-K19 each run creates exactly one session and submits exactly one prompt', async t => {
    // Pins the structural premise behind reading only the newest transcript page: the runner must
    // never attach to a pre-existing session, and never submit a second prompt to the same one.
    const { calls, runner } = rig(t, { turns: [turn('completed', [{ kind: 'text', role: 'assistant', text: 'ok' }])] });
    const out = await runner.run(input(), () => {});
    assert.equal(out.sessionId, 'session_synthetic_1');
    assert.equal(calls.filter(c => c.path === '/api/v1/sessions' && c.method === 'POST').length, 1);
    assert.equal(calls.filter(c => c.path === '/api/v1/sessions/session_synthetic_1/prompts' && c.method === 'POST').length, 1);
});
// C02: the runner now attributes a real transport status by layer. A 401 observed on the model turn
// or on the local management bearer must not read as "the Kimi account needs a new login".
// Superseded by C02-K17/K18: a turn 401 is now first given the server's lazy-refresh chance, so the
// single-observation case no longer terminates on the first read. The layer assertion moved there.
test('C02-K15 a 401 on the local management bearer is L2, not a Kimi account reauth', async t => {
    const { calls, runner } = rig(t, { auth: attachHttpStatus({}, 401, '/api/v1/auth') });
    await assert.rejects(runner.run(input(), () => {}), err => {
        assert.equal(err.code, 'KIMI_AUTH_UNKNOWN');
        assert.match(err.message, /\[L2_MANAGEMENT_AUTH\]/);
        return true;
    });
    assert.equal(calls.length, 1, 'the refusal happens on the first call, before any session write');
});
test('C02-K16 a 429 on the turn stays transient and keeps the credential', async t => {
    const { runner } = rig(t, { turns: [attachHttpStatus({}, 429, '/api/v1/sessions/session_synthetic_1/transcript')] });
    await assert.rejects(runner.run(input(), () => {}), err => {
        assert.equal(err.code, 'KIMI_AUTH_TRANSIENT');
        assert.match(err.message, /\[L4_TURN\]/);
        return true;
    });
});
test('C02-K17 a single rejected transcript read is tolerated and the turn still completes', async t => {
    const events = [];
    const rejected = attachHttpStatus({}, 401, '/api/v1/sessions/session_synthetic_1/transcript');
    const done = turn('completed', [{ kind: 'text', role: 'assistant', text: '{"ok":true}' }]);
    const { runner } = rig(t, { turns: [rejected, done] });
    const out = await runner.run(input(), e => events.push(e));
    assert.equal(out.text, '{"ok":true}');
    assert.ok(events.some(e => e.method === 'dm/kimiAuthRetry'), 'the retry is observable, not silent');
    assert.equal(events.filter(e => e.method === 'dm/kimiAuthRetry').length, 1);
});
test('C02-K18 a transcript that stays rejected becomes a real reauth only after the retries', async t => {
    const rejected = attachHttpStatus({}, 401, '/api/v1/sessions/session_synthetic_1/transcript');
    const { calls, runner } = rig(t, { turns: [rejected] });
    await assert.rejects(runner.run(input(), () => {}), err => {
        assert.equal(err.code, 'KIMI_REAUTH_REQUIRED');
        assert.match(err.message, /\[L4_TURN\]/);
        return true;
    });
    // auth + userinfo + session + prompt + three transcript reads
    assert.equal(calls.filter(c => c.path.includes('/transcript')).length, 3);
});
// The upstream token adapter deletes its in-memory token without telling the controller
// (`remove()` sends no frame), so a "logout" on the Kimi side leaves our durable record behind.
// That is not silent: the next turn must end in a *classified* reauth, never a healthy state.
test('C02-K20 an upstream-only logout still ends as a classified reauth, not a silent success', async t => {
    const { runner } = rig(t, { userinfo: attachHttpStatus({}, 401, '/api/v1/oauth/userinfo') });
    await assert.rejects(runner.run(input(), () => {}), err => {
        assert.equal(err.code, 'KIMI_REAUTH_REQUIRED');
        assert.match(err.message, /\[L3_OAUTH\]/, 'the rejection is attributed to the grant, which is where it happened');
        return true;
    });
});
test('C02-K21 the same rejection on the management endpoint stays local and blames nobody', async t => {
    const { runner } = rig(t, { auth: attachHttpStatus({}, 401, '/api/v1/auth') });
    await assert.rejects(runner.run(input(), () => {}), err => {
        assert.equal(err.code, 'KIMI_AUTH_UNKNOWN');
        assert.match(err.message, /\[L2_MANAGEMENT_AUTH\]/);
        return true;
    });
});
// C02: the runner must hand the classified failure to the status sink, otherwise the product keeps
// claiming "can reason" after the server refused a call.
test('C02-K22 a classified turn failure reaches the auth-failure sink', async t => {
    const seen = [];
    const rejected = attachHttpStatus({}, 401, '/api/v1/sessions/session_synthetic_1/transcript');
    const { runner: plain } = rig(t, { turns: [rejected] });
    // Rebuild the same runner with the sink injected as the seventh argument.
    const admission = createKimiAdmission({ schema: 1, state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:user_synthetic', observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const transport = async (path) => {
        if (path === '/api/v1/auth') return okAuth;
        if (path === '/api/v1/oauth/userinfo') return okUserinfo;
        if (path === '/api/v1/sessions') return okSession;
        if (path.endsWith('/prompts')) return okPrompt;
        if (path.includes('/transcript')) return rejected;
        if (path.endsWith('/snapshot')) return { code: 0, data: { session: { usage: {} } } };
        if (path.includes(':archive')) return { code: 0, data: {} };
        throw new Error('unexpected path ' + path);
    };
    const runner = new KimiRunner(cfg, transport, () => 0, async () => {}, admission, undefined, f => seen.push(f));
    await assert.rejects(runner.run(input(), () => {}));
    assert.equal(seen.length, 1, 'one classified failure, recorded once');
    assert.equal(seen[0].code, 'KIMI_REAUTH_REQUIRED');
    assert.match(String(seen[0].message), /\[L4_TURN\]/);
    void plain;
});
test('C02-K23 a rejection is reported once, and a later successful turn retires it', async t => {
    let transcriptReads = 0;
    const rejected = attachHttpStatus({}, 401, '/api/v1/sessions/session_synthetic_1/transcript');
    const done = turn('completed', [{ kind: 'text', role: 'assistant', text: '{"ok":true}' }]);
    const transport = async (path) => {
        if (path === '/api/v1/auth') return okAuth;
        if (path === '/api/v1/oauth/userinfo') return okUserinfo;
        if (path === '/api/v1/sessions') return okSession;
        if (path.endsWith('/prompts')) return okPrompt;
        if (path.includes('/transcript')) {
            transcriptReads += 1;
            return transcriptReads <= 3 ? rejected : done;   // three reads = the bounded retry budget
        }
        if (path.endsWith('/snapshot')) return { code: 0, data: { session: { usage: { input_tokens: 1, output_tokens: 1 } } } };
        if (path.includes(':archive')) return { code: 0, data: {} };
        throw new Error('unexpected path ' + path);
    };
    const admission = createKimiAdmission({ schema: 1, state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:user_synthetic', observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const log = [];
    const runner = new KimiRunner(cfg, transport, () => 0, async () => {}, admission, undefined, f => log.push(f));
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_REAUTH_REQUIRED' });
    assert.equal(log.length, 1);
    assert.equal(log[0].code, 'KIMI_REAUTH_REQUIRED');
    const out = await runner.run(input(), () => {});
    assert.equal(out.text, '{"ok":true}');
    assert.equal(log.length, 2);
    assert.equal(log[1], null, 'a completed turn retires the earlier rejection');
});
// A response stream that dies halfway must become a rejected call, never an unhandled 'error'.
test('C02-K24 a response aborted mid-body rejects as a transport failure', async t => {
    const { createServer } = await import('node:http');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"code":0,"data":{');
        setTimeout(() => res.destroy(), 20);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => server.close(r)));
    const dir = mkdtempSync(resolve(tmpdir(), 'dm-kimi-abort-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const tokenFile = resolve(dir, 'server.token');
    writeFileSync(tokenFile, 'SYNTHETIC_MANAGEMENT_TOKEN_VALUE\n');
    const transport = createKimiTransport({ baseUrl: 'http://127.0.0.1:' + server.address().port, tokenFile });
    await assert.rejects(transport('/api/v1/auth'), err => {
        assert.ok(typeof err.code === 'string', 'the rejection carries a code, not a bare event');
        return true;
    });
});
