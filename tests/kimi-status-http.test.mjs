// HTTP surface for the Kimi status endpoint: authenticated, read-only, token-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { harness, root } from './helpers.mjs';
import { createApp } from '../dist/server/http.js';
import { DomainError } from '../dist/server/security.js';

test('C05-H1 /api/kimi/status is authenticated, read-only and never returns a token', async t => {
    let app;
    t.after(() => app?.close());
    const h = harness(t);
    const native = {
        assertReady: () => { throw new DomainError('OFFLINE_FACTORY_NOT_LIVE'); },
        executor: () => { throw Error('MUST_NOT_RUN'); },
        verify: async () => { throw Error('MUST_NOT_RUN'); },
        close: async () => {}
    };
    app = await createApp({ root, data: resolve(h.dir, 'http'), configPath: resolve(h.dir, 'http-config.json'), port: 0, demoDelayMs: 0, nativeExecution: native });

    const login = await fetch(app.origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: app.bootstrap }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const authed = await fetch(app.origin + '/api/kimi/status', { headers: { cookie } });
    assert.equal(authed.status, 200);
    const body = await authed.json();
    // Kimi is disabled in this fixture: no admission authority, no credential authority, no inference.
    assert.equal(body.inferenceAllowed, false);
    assert.equal(body.admission, null);
    assert.equal(body.credentials, null);
    assert.equal(body.note, 'NO_ADMISSION_AUTHORITY');
    const text = JSON.stringify(body);
    for (const forbidden of ['accessToken', 'refreshToken', 'SECRET', 'Bearer']) assert.equal(text.includes(forbidden), false);

    // The endpoint is part of the authenticated surface: no session means no answer.
    const anon = await fetch(app.origin + '/api/kimi/status');
    assert.ok(anon.status === 401 || anon.status === 403, 'anonymous access must be refused, got ' + anon.status);
});
