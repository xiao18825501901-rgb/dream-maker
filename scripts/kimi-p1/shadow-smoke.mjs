#!/usr/bin/env node
// Real-app smoke for the SHADOW seam: the mirror must see engine events, and what it sees must stay
// redacted (kinds and ids only). No model call, demo mode only.
const origin = process.argv[2];
const bootstrap = process.argv[3];
if (!origin || !bootstrap) { console.error('usage: node scripts/kimi-p1/shadow-smoke.mjs <origin> <bootstrap-token>'); process.exit(2); }

const login = await fetch(origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap }) });
if (!login.ok) { console.error('LOGIN_FAILED', login.status); process.exit(1); }
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const csrf = (await login.json()).csrf;
const call = async (path, body) => {
    const res = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, 'content-type': 'application/json', ...(body === undefined ? {} : { 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() }) },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
};

const before = await call('/api/orca/shadow');
console.log('BEFORE', JSON.stringify({ status: before.status, mode: before.body.mode, accepted: before.body.stats?.accepted }));
if (before.body.mode !== 'SHADOW') { console.error('MODE_NOT_SHADOW', before.body.mode); process.exit(1); }

const created = await call('/api/projects', { name: 'SHADOW_SMOKE', idea: 'Prove the observation seam sees engine events without any model call.', mode: 'demo' });
if (created.status !== 200) { console.error('CREATE_FAILED', created.status, JSON.stringify(created.body).slice(0, 120)); process.exit(1); }

const after = await call('/api/orca/shadow');
const accepted = after.body.stats?.accepted ?? 0;
console.log('AFTER', JSON.stringify({ accepted, dropped: after.body.stats?.dropped, sample: (after.body.recent ?? []).slice(-3).map(e => e.kind) }));
if (!(accepted > (before.body.stats?.accepted ?? 0))) { console.error('NO_EVENTS_MIRRORED'); process.exit(1); }

// A08 pre-work: the project snapshot carries the same three read-only states.
const project = await call('/api/projects/' + created.body.project.id);
const status = project.body?.status;
console.log('PROJECT_STATUS', JSON.stringify({ kimi: status?.kimi?.note, inferenceAllowed: status?.kimi?.inferenceAllowed, laya: status?.laya?.reason, shadow: status?.shadow?.mode, recent: status?.shadow?.recent }));
if (!Array.isArray(status?.shadow?.recent) || status.shadow.recent.length === 0) { console.error('PROJECT_STATUS_SHADOW_RECENT_MISSING'); process.exit(1); }
if (status?.kimi?.inferenceAllowed !== false) { console.error('PROJECT_STATUS_INFERENCE_NOT_BLOCKED'); process.exit(1); }
if (status?.laya?.fullyOff !== false) { console.error('PROJECT_STATUS_LAYA_CLAIMED_OFF'); process.exit(1); }
if (status?.shadow?.mode !== 'SHADOW') { console.error('PROJECT_STATUS_SHADOW_MODE', status?.shadow?.mode); process.exit(1); }

const text = JSON.stringify(after.body);
for (const forbidden of ['prompt', 'sk-', 'C:\\']) {
    if (text.includes(forbidden)) { console.error('SHADOW_LEAK', forbidden); process.exit(1); }
}
// The detail may only carry FIELD NAMES: the demo project's own values must not appear in it.
const detail = (after.body.recent ?? []).map(e => e.detail).join('|');
if (/demo|SHADOW_SMOKE|project_/.test(detail)) { console.error('SHADOW_DETAIL_HAS_VALUES', detail); process.exit(1); }
console.log('DETAIL', JSON.stringify(detail));
console.log('SMOKE_OK');
