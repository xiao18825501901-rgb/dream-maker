import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KimiRunner } from '../dist/server/providers/kimi.js';
import { createKimiAdmission, denyAllAdmission, loadKimiAdmission, validateEvidence } from '../dist/server/kimi-admission.js';
import { defaults, parseConfig } from '../dist/server/config.js';

// A01: Extra Usage admission. Every case here is offline and synthetic — no local Kimi server is
// contacted. The counter in `rig` IS the assertion: when the gate refuses, the number of upstream
// transport calls must be exactly zero, which is the property the owner asked for ("UNKNOWN 下所有
// 模型入口调用数为 0").

const cfg = () => parseConfig(structuredClone(defaults));
const input = (over = {}) => ({ role: 'planner1', workspace: '/opt/w', prompt: 'p', model: 'kimi-code/kimi-for-coding', specHash: 'h', runId: 'r', laya: { adoption: 'off' }, signal: new AbortController().signal, ...over });
const T0 = Date.parse('2026-10-18T00:00:00.000Z');
const at = () => T0;
const iso = ms => new Date(ms).toISOString();
const evidence = (over = {}) => ({ schema: 1, state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:user_synthetic', observedAt: iso(T0 - 60_000), expiresAt: iso(T0 + 3_600_000), ...over });

const okAuth = { code: 0, data: { models_ready: true, providers_count: 1 } };
const okUserinfo = { code: 0, data: { kind: 'ok', userInfo: { userId: 'user_synthetic', userLevelName: 'Plus' } } };
const okSession = { code: 0, data: { id: 'session_synthetic_1' } };
const okPrompt = { code: 0, data: { prompt_id: 'msg_synthetic_1', status: 'running' } };
const doneTurn = { code: 0, data: { items: [{ state: 'completed', steps: [{ frames: [{ kind: 'text', role: 'assistant', text: '{"ok":true}' }], usage: { input_tokens: 1, output_tokens: 2 } }] }] } };

function rig(admission, { userinfo = okUserinfo } = {}) {
    const calls = [];
    const transport = async (path, init) => {
        calls.push({ path, method: init?.method ?? 'GET' });
        if (path === '/api/v1/auth') return okAuth;
        if (path === '/api/v1/oauth/userinfo') return userinfo;
        if (path === '/api/v1/sessions') return okSession;
        if (path.endsWith('/prompts')) return okPrompt;
        if (path.includes('/transcript')) return doneTurn;
        if (path.endsWith('/snapshot')) return { code: 0, data: { session: { usage: { input_tokens: 1, output_tokens: 2 } } } };
        if (path.endsWith(':archive')) return { code: 0, data: {} };
        throw new Error('unexpected path ' + path);
    };
    return { calls, runner: new KimiRunner(cfg, transport, () => 0, async () => {}, admission) };
}

test('A01-1 a runner with no admission at all refuses before the first transport call', async () => {
    const { calls, runner } = rig(undefined);
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_EXTRA_USAGE_UNKNOWN' });
    assert.equal(calls.length, 0);
});

test('A01-2 state ON refuses with zero upstream calls', async () => {
    const { calls, runner } = rig(createKimiAdmission(evidence({ state: 'ON' }), at));
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_EXTRA_USAGE_ENABLED' });
    assert.equal(calls.length, 0);
});

test('A01-3 state UNKNOWN refuses with zero upstream calls', async () => {
    const { calls, runner } = rig(createKimiAdmission(evidence({ state: 'UNKNOWN' }), at));
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_EXTRA_USAGE_UNKNOWN' });
    assert.equal(calls.length, 0);
});

test('A01-4 expired evidence refuses with zero upstream calls', async () => {
    const { calls, runner } = rig(createKimiAdmission(evidence({ expiresAt: iso(T0 - 1) }), at));
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_EXTRA_USAGE_EVIDENCE_EXPIRED' });
    assert.equal(calls.length, 0);
});

test('A01-5 evidence dated in the future is not trusted', async () => {
    const admission = createKimiAdmission(evidence({ observedAt: iso(T0 + 60 * 60 * 1000) }), at);
    assert.throws(() => admission.assertMaySend('t'), { code: 'KIMI_EXTRA_USAGE_EVIDENCE_INVALID' });
});

test('A01-6 a different account generation is refused before the session is created', async () => {
    // The account check can only run after userinfo, so exactly two calls (auth + userinfo) are
    // allowed; no session, no prompt, no transcript.
    const { calls, runner } = rig(createKimiAdmission(evidence({ accountRef: 'kimi:someone_else' }), at), { userinfo: { code: 0, data: { kind: 'ok', userInfo: { userId: 'user_synthetic', userLevelName: 'Plus' } } } });
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_ACCOUNT_MISMATCH' });
    assert.deepEqual(calls.map(c => c.path), ['/api/v1/auth', '/api/v1/oauth/userinfo']);
});

test('A01-7 an unbound account is refused even with valid evidence', async () => {
    const { calls, runner } = rig(createKimiAdmission(evidence(), at), { userinfo: { code: 0, data: { kind: 'ok', userInfo: {} } } });
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_ACCOUNT_NOT_BOUND' });
    assert.equal(calls.length, 2);
});

test('A01-8 explicit OFF evidence for the matching account lets the run proceed', async () => {
    const { calls, runner } = rig(createKimiAdmission(evidence(), at));
    const out = await runner.run(input(), () => {});
    assert.equal(out.text, '{"ok":true}');
    assert.ok(calls.some(c => c.path === '/api/v1/sessions' && c.method === 'POST'));
    assert.ok(calls.some(c => c.path.endsWith('/prompts')));
});

test('A01-9 a missing evidence file denies; a corrupt one denies and says so', () => {
    const missing = loadKimiAdmission('C:/definitely/not/here/kimi-entitlement.json');
    assert.throws(() => missing.assertMaySend('t'), { code: 'KIMI_EXTRA_USAGE_UNKNOWN' });
    assert.equal(missing.snapshot(at()).state, 'ABSENT');

    const corrupt = loadKimiAdmission('x.json', () => 'not json at all');
    assert.throws(() => corrupt.assertMaySend('t'), { code: 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT' });
    assert.equal(corrupt.snapshot(at()).state, 'CORRUPT');
});

test('A01-10 a well-formed file loads, and schema violations are rejected', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'dm-kimi-admis-'));
    try {
        const ok = resolve(dir, 'ok.json');
        writeFileSync(ok, JSON.stringify(evidence(), null, 2));
        const loaded = loadKimiAdmission(ok);
        assert.equal(loaded.snapshot(at()).allowsSend, true);
        assert.doesNotThrow(() => loaded.assertMaySend('t', at()));

        assert.throws(() => validateEvidence({ ...evidence(), schema: 2 }), { code: 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT' });
        assert.throws(() => validateEvidence({ ...evidence(), state: 'off' }), { code: 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT' });
        assert.throws(() => validateEvidence({ ...evidence(), source: 'MODEL_SAID_SO' }), { code: 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT' });
        assert.throws(() => validateEvidence({ ...evidence(), accountRef: '' }), { code: 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT' });
        assert.throws(() => validateEvidence({ ...evidence(), expiresAt: 'tomorrow' }), { code: 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A01-11 denyAllAdmission is the documented default and reports its reason', () => {
    const d = denyAllAdmission();
    assert.throws(() => d.assertMaySend('t'), { code: 'KIMI_EXTRA_USAGE_UNKNOWN' });
    assert.equal(d.snapshot(at()).allowsSend, false);
    assert.equal(d.snapshot(at()).reason, 'KIMI_EXTRA_USAGE_UNKNOWN');
});

test('A01-12 the snapshot never leaks into a pass after expiry', () => {
    const admission = createKimiAdmission(evidence({ expiresAt: iso(T0 + 1000) }), () => T0 + 5000);
    assert.equal(admission.snapshot().allowsSend, false);
    assert.equal(admission.snapshot().reason, 'KIMI_EXTRA_USAGE_EVIDENCE_EXPIRED');
    assert.throws(() => admission.assertMaySend('t'), { code: 'KIMI_EXTRA_USAGE_EVIDENCE_EXPIRED' });
});
// A01 defense in depth: `loadKimiAdmission` validates before constructing, but the low-level
// constructor is reachable directly and runtime types do not exist. A hand-built record must not be
// able to talk the gate into allowing a send — least of all with an unknown `state`.
test('A01-A1 the low-level constructor cannot be fed evidence validation would refuse', () => {
    const refused = (over) => {
        const a = createKimiAdmission(evidence(over));
        const snap = a.snapshot(at());
        assert.equal(snap.allowsSend, false, JSON.stringify(over));
        return snap;
    };
    assert.equal(refused({ state: 'garbage' }).reason, 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT', 'an unknown state must fail closed');
    assert.equal(refused({ state: 'off' }).reason, 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT', 'the state vocabulary is exact');
    assert.equal(refused({ source: 'BECAUSE_I_SAID_SO' }).reason, 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT');
    assert.equal(refused({ accountRef: 42 }).reason, 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT');
    assert.equal(refused({ accountRef: '' }).reason, 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT');
    assert.equal(refused({ observedAt: 'yesterday' }).reason, 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT');
    assert.equal(refused({ expiresAt: undefined }).reason, 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT');
    assert.equal(refused({ schema: 2 }).reason, 'KIMI_EXTRA_USAGE_EVIDENCE_CORRUPT');
    // And a well-formed record still passes, so the guard is not a blanket refusal.
    assert.equal(createKimiAdmission(evidence()).snapshot(at()).allowsSend, true);
});
