import test from 'node:test';
import assert from 'node:assert/strict';
import { KimiRunner } from '../dist/server/providers/kimi.js';
import { createKimiAdmission } from '../dist/server/kimi-admission.js';
import { createKimiCredentialAuthority } from '../dist/server/kimi-credential-authority.js';
import { defaults, parseConfig } from '../dist/server/config.js';

// C03/C04 wiring: the runner consults the durable credential authority before its first upstream
// byte. Offline and synthetic — the transport below only counts calls.

const cfg = () => parseConfig(structuredClone(defaults));
const input = (over = {}) => ({ role: 'planner1', workspace: '/opt/w', prompt: 'p', model: 'kimi-code/kimi-for-coding', specHash: 'h', runId: 'r', laya: { adoption: 'off' }, signal: new AbortController().signal, ...over });
const ALLOW = createKimiAdmission({
    schema: 1, state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:user_synthetic',
    observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
});
const token = () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, expiresIn: 3600, scope: 'kimi-code', tokenType: 'Bearer' });

function store(record = null, opts = {}) {
    let value = record;
    return {
        async save(_n, v) { if (opts.failWrite) throw new Error('disk'); value = structuredClone(v); },
        async load() { return value ?? undefined; },
        async loadRecord() {
            if (opts.corrupt) return { status: 'CORRUPT', reason: 'DECRYPT_FAILED' };
            if (opts.throwRead) throw new Error('EIO');
            return value == null ? { status: 'MISSING' } : { status: 'OK', record: structuredClone(value) };
        },
        async remove() { value = null; },
        async list() { return value ? ['kimi-code'] : []; }
    };
}
function rig(credentials) {
    const calls = [];
    const transport = async path => {
        calls.push(path);
        throw new Error('transport must not be reached: ' + path);
    };
    return { calls, runner: new KimiRunner(cfg, transport, () => 0, async () => {}, ALLOW, credentials) };
}

test('C04-1 a runner with an un-restored authority refuses before any upstream call', async () => {
    const credentials = createKimiCredentialAuthority({ store: store() });
    const { calls, runner } = rig(credentials);
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_RESTORE_NOT_READY' });
    assert.equal(calls.length, 0);
});

test('C04-2 a corrupt durable record is reported as corrupt, never as "log in"', async () => {
    const credentials = createKimiCredentialAuthority({ store: store(null, { corrupt: true }) });
    await credentials.restore();
    const { calls, runner } = rig(credentials);
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_STORED_STATE_CORRUPT' });
    assert.equal(calls.length, 0);
});

test('C04-3 a revoked credential refuses inference without touching the network', async () => {
    const s = store();
    const first = createKimiCredentialAuthority({ store: s });
    await first.restore();
    await first.commit({ token: token(), generation: 1, messageId: 'm1' });
    await first.revoke({ generation: 2, messageId: 'm2' });
    const credentials = createKimiCredentialAuthority({ store: s });
    const state = await credentials.restore();
    assert.equal(state.status, 'REVOKED');
    const { calls, runner } = rig(credentials);
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_CREDENTIAL_REVOKED' });
    assert.equal(calls.length, 0);
});

test('C04-4 a valid restored record lifts the barrier and the run proceeds to the transport', async () => {
    const s = store();
    const first = createKimiCredentialAuthority({ store: s });
    await first.restore();
    await first.commit({ token: token(), generation: 1, messageId: 'm1' });
    const credentials = createKimiCredentialAuthority({ store: s });
    await credentials.restore();
    const { calls, runner } = rig(credentials);
    // The fake transport throws on first contact, which proves the gate let the run through.
    await assert.rejects(runner.run(input(), () => {}), /transport must not be reached/);
    assert.ok(calls.length >= 1);
    assert.equal(calls[0], '/api/v1/auth');
});

test('C04-5 a missing durable record still allows the one-time login path (barrier ready, MISSING)', async () => {
    const credentials = createKimiCredentialAuthority({ store: store() });
    const state = await credentials.restore();
    assert.equal(state.status, 'MISSING');
    const { calls, runner } = rig(credentials);
    await assert.rejects(runner.run(input(), () => {}), /transport must not be reached/);
    assert.equal(calls[0], '/api/v1/auth');
});

test('C04-6 the admission gate still wins over the credential barrier (no reasoning on UNKNOWN Extra Usage)', async () => {
    const credentials = createKimiCredentialAuthority({ store: store() });
    await credentials.restore();
    const calls = [];
    const runner = new KimiRunner(cfg, async p => { calls.push(p); throw new Error('no'); }, () => 0, async () => {});
    await assert.rejects(runner.run(input(), () => {}), { code: 'KIMI_EXTRA_USAGE_UNKNOWN' });
    assert.equal(calls.length, 0);
});
test('C04-7 an upstream login with no durable record never reaches a session or a prompt', async () => {
    // The durable store is empty while the Kimi server may still hold a live token in memory.
    // Dispatching on it spends quota through a credential that cannot survive a restart.
    const store = {
        async save() { }, async load() { return undefined; },
        async loadRecord() { return { status: 'MISSING' }; },
        async remove() { }, async list() { return []; }
    };
    const authority = createKimiCredentialAuthority({ store, clock: () => 1_700_000_000_000 });
    await authority.restore();
    assert.equal(authority.current().status, 'MISSING');
    const seen = [];
    const transport = async (path) => {
        seen.push(path);
        if (path === '/api/v1/auth') return { code: 0, data: { models_ready: true, providers_count: 1 } };
        if (path === '/api/v1/oauth/userinfo') return { code: 0, data: { kind: 'ok', userInfo: { userId: 'user_synthetic', userLevelName: 'Plus' } } };
        return { code: 0, data: {} };
    };
    const admission = createKimiAdmission({ schema: 1, state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:user_synthetic', observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const runner = new KimiRunner(() => parseConfig(structuredClone(defaults)), transport, () => Date.now(), async () => {}, admission, authority);
    await assert.rejects(runner.run({ role: 'planner1', workspace: '/opt/w', prompt: 'p', model: 'kimi-code/kimi-for-coding', specHash: 'h', runId: 'r', laya: { adoption: 'off' }, signal: new AbortController().signal }, () => {}), { code: 'KIMI_CREDENTIALS_MISSING' });
    // The login path is still allowed to *query* the upstream (C04-5), but nothing may be written:
    // no session, no prompt, no billed turn on an unpersisted credential.
    assert.deepEqual(seen, ['/api/v1/auth', '/api/v1/oauth/userinfo'], JSON.stringify(seen));
});
