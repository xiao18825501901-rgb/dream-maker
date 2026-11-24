import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RETRY_POLICY, isRetryable, retryDelayMs, withBoundedRetry } from '../dist/server/kimi-retry.js';

// C04 offline tests. No Kimi, no network: the operation under test is a local function, and the
// sleep is injected so the suite never waits.

const policy = { ...DEFAULT_RETRY_POLICY };
const noSleep = () => Promise.resolve();

test('C04-R1 only safe reads are retryable, and only on transient conditions', () => {
    assert.equal(isRetryable('GET', { status: 503 }), true);
    assert.equal(isRetryable('get', { status: 429 }), true);
    assert.equal(isRetryable('POST', { status: 503 }), false);
    assert.equal(isRetryable('POST', { message: 'fetch failed' }), false);
    assert.equal(isRetryable('GET', { status: 404 }), false);
    assert.equal(isRetryable('GET', { status: 401 }), false);
    assert.equal(isRetryable('GET', { message: 'ECONNRESET' }), true);
});

test('C04-R2 backoff grows exponentially, is capped, and honours Retry-After within the ceiling', () => {
    assert.equal(retryDelayMs(1, policy, {}, () => 0.5), 500);
    assert.equal(retryDelayMs(2, policy, {}, () => 0.5), 1000);
    assert.equal(retryDelayMs(3, policy, {}, () => 0.5), 2000);
    assert.equal(retryDelayMs(9, policy, {}, () => 0.5), policy.maxDelayMs);
    assert.equal(retryDelayMs(1, policy, { retryAfterMs: 10 }, () => 0.5), 10);
    assert.equal(retryDelayMs(1, policy, { retryAfterMs: 99_999 }, () => 0.5), policy.maxDelayMs);
});

test('C04-R3 jitter stays inside the configured band', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const delay = retryDelayMs(1, policy, {}, () => r);
        assert.ok(delay >= 400 && delay <= 600, 'delay ' + delay + ' outside band');
    }
});

test('C04-R4 a transient GET is retried up to the policy limit and then stops', async () => {
    let attempts = 0;
    await assert.rejects(
        withBoundedRetry(async () => { attempts += 1; const e = new Error('down'); e.status = 503; throw e; }, { method: 'GET', sleep: noSleep }),
        { code: 'KIMI_RETRY_EXHAUSTED' }
    );
    assert.equal(attempts, policy.maxAttempts);
});

test('C04-R5 a POST is never retried, whatever the failure looks like', async () => {
    let attempts = 0;
    await assert.rejects(
        withBoundedRetry(async () => { attempts += 1; const e = new Error('down'); e.status = 503; throw e; }, { method: 'POST', sleep: noSleep }),
        /down/
    );
    assert.equal(attempts, 1);
});

test('C04-R6 a GET that recovers on a later attempt succeeds and reports attempts', async () => {
    let attempts = 0;
    const failures = [];
    const value = await withBoundedRetry(async () => {
        attempts += 1;
        if (attempts < 3) { const e = new Error('flaky'); e.status = 502; throw e; }
        return 'ok';
    }, { method: 'GET', sleep: noSleep, onAttemptFailed: (n, f) => failures.push([n, f.status]) });
    assert.equal(value, 'ok');
    assert.equal(attempts, 3);
    assert.deepEqual(failures, [[1, 502], [2, 502]]);
});

test('C04-R7 cancellation wins over backoff', async () => {
    const controller = new AbortController();
    let attempts = 0;
    await assert.rejects(withBoundedRetry(async () => {
        attempts += 1;
        controller.abort();
        const e = new Error('down'); e.status = 503; throw e;
    }, { method: 'GET', signal: controller.signal, sleep: noSleep }), { code: 'RUN_CANCELLED' });
    assert.equal(attempts, 1);
});

test('C04-R8 a 401/403 is surfaced immediately and is not mistaken for a transient error', async () => {
    for (const status of [401, 403]) {
        let attempts = 0;
        await assert.rejects(withBoundedRetry(async () => { attempts += 1; const e = new Error('denied'); e.status = status; throw e; }, { method: 'GET', sleep: noSleep }), /denied/);
        assert.equal(attempts, 1, 'status ' + status + ' must not be retried');
    }
});
test('C04-R9 the transport retries a safe GET and never retries a POST', async () => {
    const { createKimiTransport } = await import('../dist/server/providers/kimi.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'dm-kimi-retry-'));
    const tokenFile = resolve(dir, 'server.token');
    writeFileSync(tokenFile, 'synthetic-management-token');
    try {
        const seen = [];
        let n = 0;
        const flaky = async (url, init) => {
            seen.push(init.method);
            n += 1;
            if (n < 3) { const e = new Error('down'); e.status = 503; throw e; }
            return { code: 0, data: { ok: true } };
        };
        const transport = createKimiTransport({ baseUrl: 'http://127.0.0.1:1', tokenFile, fetchImpl: flaky });
        const body = await transport('/api/v1/auth');
        assert.deepEqual(body, { code: 0, data: { ok: true } });
        assert.equal(seen.length, 3, 'a transient GET is retried up to the policy limit');
        assert.deepEqual(seen, ['GET', 'GET', 'GET']);

        const posts = [];
        let m = 0;
        const writeFails = async (url, init) => {
            posts.push(init.method);
            m += 1;
            const e = new Error('down'); e.status = 503; throw e;
        };
        const writeTransport = createKimiTransport({ baseUrl: 'http://127.0.0.1:1', tokenFile, fetchImpl: writeFails });
        await assert.rejects(writeTransport('/api/v1/sessions', { method: 'POST', body: {} }), /down/);
        assert.equal(posts.length, 1, 'a POST is single-shot even on a transient error');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
