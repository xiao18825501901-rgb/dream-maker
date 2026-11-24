#!/usr/bin/env node
// Real-app smoke for the Laya OFF claim. Two facts are checked:
//  1. before any run, the summary refuses to claim off (zero turns is not proof);
//  2. after a demo run, the summary counts the real role turns.
const origin = process.argv[2];
const bootstrap = process.argv[3];
if (!origin || !bootstrap) { console.error('usage: node scripts/kimi-p1/laya-smoke.mjs <origin> <bootstrap-token>'); process.exit(2); }

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
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
};

const before = await call('/api/laya/observation');
console.log('BEFORE', JSON.stringify(before.body));
if (before.body?.turns !== 0 || before.body?.fullyOff !== false || before.body?.reason !== 'NO_TURNS_OBSERVED') {
    console.error('ZERO_TURNS_WAS_TREATED_AS_PROOF');
    process.exit(1);
}

const created = await call('/api/projects', { name: 'LAYA_OFF_SMOKE', idea: 'Prove Laya off is observed per real role turn, not inferred from a zero-request init.', mode: 'demo' });
if (created.status !== 200) { console.error('CREATE_FAILED', created.status, JSON.stringify(created.body).slice(0, 140)); process.exit(1); }
const pid = created.body.project.id;

const fin = await call('/api/projects/' + pid + '/finish', { summarize: false });
if (fin.status !== 200) { console.error('FINISH_FAILED', fin.status, JSON.stringify(fin.body).slice(0, 140)); process.exit(1); }
const specHash = fin.body.spec.hash;
const approve = await call('/api/projects/' + pid + '/approve', { specHash, approved: true });
if (approve.status !== 200) { console.error('APPROVE_FAILED', approve.status, JSON.stringify(approve.body).slice(0, 140)); process.exit(1); }
// `/build` requires an explicit approval flag IN THE BODY (the route reads input.approved === true);
// sending only specHash is refused with BUILD_APPROVAL_REQUIRED, which is the gate working.
const build = await call('/api/projects/' + pid + '/build', { specHash, approved: true });
console.log('BUILD', build.status, JSON.stringify(build.body).slice(0, 200));

// A demo run is local and bounded; give it a moment, then read the coverage summary.
for (let i = 0; i < 30; i++) {
    const current = await call('/api/laya/observation');
    if ((current.body?.turns ?? 0) > 0) {
        console.log('AFTER', JSON.stringify(current.body));
        if (current.body.fullyOff !== true) { console.error('TURNS_NOT_ALL_OFF'); process.exit(1); }
        console.log('SMOKE_OK');
        process.exit(0);
    }
    await new Promise(r => setTimeout(r, 500));
}
console.error('NO_TURNS_RECORDED_AFTER_BUILD');
process.exit(1);
