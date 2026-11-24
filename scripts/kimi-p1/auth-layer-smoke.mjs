// C02 real-runtime proof: the attribution must work through the REAL loopback HTTP transport, not
// only through an injected fake. A local server answers with real status codes; no model is called.
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KimiRunner, createKimiTransport } from '../../dist/server/providers/kimi.js';
import { defaults, parseConfig } from '../../dist/server/config.js';
import { createKimiAdmission } from '../../dist/server/kimi-admission.js';

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

function serve(behaviour) {
    const server = createServer((req, res) => {
        const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        const url = req.url ?? '';
        const forced = behaviour(url, req.method ?? 'GET');
        if (forced) return send(forced.status, forced.body);
        if (url === '/api/v1/auth') return send(200, { code: 0, data: { models_ready: true, providers_count: 1 } });
        if (url === '/api/v1/oauth/userinfo') return send(200, { code: 0, data: { kind: 'ok', userInfo: { userId: 'user_synthetic', userLevelName: 'Plus' } } });
        if (url === '/api/v1/sessions') return send(200, { code: 0, data: { id: 'session_synthetic_1' } });
        if (url.endsWith('/prompts')) return send(200, { code: 0, data: { prompt_id: 'msg_synthetic_1', status: 'running' } });
        // A clean turn must complete on the first poll, otherwise the no-op wait spins until the
        // configured timeout and the smoke run looks like a hang.
        if (url.includes('/transcript')) return send(200, { code: 0, data: { items: [{ state: 'completed', steps: [{ frames: [{ kind: 'text', role: 'assistant', text: '{"ok":true}' }], usage: { input_tokens: 3, output_tokens: 4 } }] }] } });
        return send(404, { code: 40400, msg: 'not found' });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const dir = mkdtempSync(resolve(tmpdir(), 'dm-c02-'));
const tokenFile = resolve(dir, 'server.token');
writeFileSync(tokenFile, 'SYNTHETIC_MANAGEMENT_TOKEN_VALUE\n');
const admission = createKimiAdmission({
    schema: 1, state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:user_synthetic',
    observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
});

async function drive(behaviour) {
    const server = await serve(behaviour);
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const transport = createKimiTransport({ baseUrl, tokenFile });
    const runner = new KimiRunner(() => parseConfig(structuredClone(defaults)), transport, () => Date.now(), async () => {}, admission);
    const input = { role: 'planner1', workspace: '/opt/w', prompt: 'p', model: 'kimi-code/kimi-for-coding', specHash: 'h', runId: 'r', laya: { adoption: 'off' }, signal: new AbortController().signal };
    try {
        await runner.run(input, () => {});
        return { ok: true, never: true };
    } catch (error) {
        return { ok: false, code: error.code, status: error.status, message: error.message };
    } finally {
        await new Promise(r => server.close(r));
    }
}

// A persistent 401 on the turn is retried twice (the server's own lazy refresh gets its chance)
// and only then escalates — and it stays on L4.
let transcriptReads = 0;
const turn401 = await drive(url => {
    if (!url.includes('/transcript')) return null;
    transcriptReads += 1;
    return { status: 401, body: { code: 40101, msg: 'unauthorized' } };
});
check('persistent turn 401 retries, then escalates on L4', turn401.code === 'KIMI_REAUTH_REQUIRED' && String(turn401.message).includes('[L4_TURN]') && transcriptReads === 3, JSON.stringify(turn401) + ' reads=' + transcriptReads);

// A single rejected read must not cost the user a login: the retry absorbs it.
let flaky = 0;
const absorbed = await drive(url => {
    if (!url.includes('/transcript')) return null;
    flaky += 1;
    return flaky === 1 ? { status: 401, body: { code: 40101, msg: 'unauthorized' } } : null;
});
check('a one-off rejected read is absorbed by the retry', absorbed.ok === true, JSON.stringify(absorbed) + ' reads=' + flaky);

const bearer401 = await drive(url => url === '/api/v1/auth' ? { status: 401, body: { code: 40100, msg: 'bad management token' } } : null);
check('management 401 is L2, not a Kimi reauth', bearer401.code === 'KIMI_AUTH_UNKNOWN' && String(bearer401.message).includes('[L2_MANAGEMENT_AUTH]'), JSON.stringify(bearer401));

const turn429 = await drive(url => url.includes('/transcript') ? { status: 429, body: { code: 42900, msg: 'slow down' } } : null);
check('turn 429 is transient and keeps the credential', turn429.code === 'KIMI_AUTH_TRANSIENT' && String(turn429.message).includes('[L4_TURN]'), JSON.stringify(turn429));

const turn403 = await drive(url => url.includes('/transcript') ? { status: 403, body: { code: 40300, msg: 'not available in your region' } } : null);
check('region 403 is policy, not a user fault', turn403.code === 'KIMI_AUTH_REGION', JSON.stringify(turn403));

const clean = await drive(() => null);
check('a healthy turn is unaffected by the new status carrier', clean.ok === true, JSON.stringify(clean));

rmSync(dir, { recursive: true, force: true });
const failed = results.filter(r => !r.ok);
console.log('C02_SMOKE ' + (failed.length === 0 ? 'OK' : 'FAILED') + ' ' + results.length + ' checks');
if (failed.length > 0) process.exitCode = 1;