#!/usr/bin/env node
// Real-app smoke for the read-only status surface. Requires a running server and its one-time
// bootstrap token (printed by `node dist/server/main.js`). No model call is made.
const origin = process.argv[2];
const bootstrap = process.argv[3];
if (!origin || !bootstrap) {
    console.error('usage: node scripts/kimi-p1/status-smoke.mjs <origin> <bootstrap-token>');
    process.exit(2);
}
const login = await fetch(origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap }) });
if (!login.ok) { console.error('LOGIN_FAILED', login.status); process.exit(1); }
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const status = await fetch(origin + '/api/kimi/status', { headers: { cookie } });
const body = await status.json();
console.log(JSON.stringify({ status: status.status, body }, null, 1));
const text = JSON.stringify(body);
const leaked = ['accessToken', 'refreshToken', 'Bearer'].filter(k => text.includes(k));
if (leaked.length) { console.error('TOKEN_LEAK', leaked.join(',')); process.exit(1); }
if (body.inferenceAllowed !== false) { console.error('INFERENCE_NOT_BLOCKED'); process.exit(1); }
const anon = await fetch(origin + '/api/kimi/status');
if (anon.status !== 401) { console.error('ANON_NOT_REFUSED', anon.status); process.exit(1); }

// The diagnostics payload must carry the same three read-only states, and must not claim more.
const diagnostics = await (await fetch(origin + '/api/diagnostics', { headers: { cookie } })).json();
console.log('DIAGNOSTICS', JSON.stringify({ kimi: diagnostics.kimi?.note, laya: diagnostics.layaObservation?.reason, shadow: diagnostics.shadow?.mode }));
if (diagnostics.kimi?.inferenceAllowed !== false) { console.error('DIAG_INFERENCE_NOT_BLOCKED'); process.exit(1); }
if (diagnostics.layaObservation?.fullyOff !== false) { console.error('DIAG_LAYA_CLAIMED_OFF_WITHOUT_TURNS'); process.exit(1); }
if (diagnostics.shadow?.mode !== 'OFF') { console.error('DIAG_SHADOW_NOT_OFF', diagnostics.shadow?.mode); process.exit(1); }
if (JSON.stringify(diagnostics).includes('accessToken')) { console.error('DIAG_TOKEN_LEAK'); process.exit(1); }
console.log('SMOKE_OK');
