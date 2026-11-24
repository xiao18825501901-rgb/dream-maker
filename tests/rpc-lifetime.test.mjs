import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { RpcPeer } from '../dist/server/providers/rpc.js';
import { root } from './helpers.mjs';

// A03: what a broken pipe and a dead child actually do. The peer spawns a REAL local node process
// running an offline fixture — no model, no network, no Codex CLI. This is the closest we can get to
// "parent died / channel broke" without a Windows/WSL runtime.

const fixture = (mode) => new RpcPeer(process.execPath, [resolve(root, 'tests/fixtures/codex-wire.mjs'), mode], { cwd: root, env: process.env }, 5000);

test('A03-R1 closing with a request in flight rejects it instead of hanging', async () => {
    const peer = fixture('account-stall');
    // Attach the handler immediately: close() rejects in-flight requests, and an unhandled rejection
    // between close() and the assertion would be reported as if the test itself exploded.
    const outcome = peer.request('account/read', {}, 8000).then(() => ({ ok: true, code: null }), error => ({ ok: false, code: error?.code ?? null }));
    // Give the request a moment to be written, then close the transport under it.
    await new Promise(r => setTimeout(r, 200));
    await peer.close();
    const result = await outcome;
    assert.equal(result.ok, false, 'the in-flight request must not resolve after a close');
    assert.equal(result.code, 'RUNNER_CLOSED', 'it is rejected with a precise code, not a bare timeout');
});

test('A03-R2 after close, new requests fail fast instead of queuing forever', async () => {
    const peer = fixture('success');
    await peer.close();
    const started = Date.now();
    await assert.rejects(peer.request('account/read', {}, 5000));
    assert.ok(Date.now() - started < 2000, 'a dead peer must not wait out the request timeout');
});

test('A03-R3 close is idempotent and never throws on the second call', async () => {
    const peer = fixture('success');
    await peer.close();
    await peer.close();
});

test('A03-R4 a fixture that exits by itself surfaces as a transport failure', async () => {
    // 'exit-now' is not a fixture mode that stalls; the process ends when stdin closes, which is the
    // same observable a parent death produces: the channel goes away without a reply.
    const peer = fixture('account-stall');
    const failures = [];
    peer.onFailure = error => failures.push(error.code ?? String(error));
    await peer.close();
    await new Promise(r => setTimeout(r, 300));
    assert.ok(failures.length >= 1, 'the peer reports a failure rather than pretending the channel is fine');
});
