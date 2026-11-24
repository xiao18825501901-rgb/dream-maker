const origin = process.argv[2] ?? 'http://127.0.0.1:4317';
const boot = process.argv[3];
if (!boot) { console.error('usage: diag-check.mjs <origin> <bootstrap>'); process.exit(2); }
const login = await fetch(origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: boot }) });
if (!login.ok) { console.error('LOGIN_FAILED', login.status); process.exit(1); }
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const d = await (await fetch(origin + '/api/diagnostics', { headers: { cookie } })).json();
console.log('BRIDGE', JSON.stringify(d.bridge));
console.log('KIMI', d.kimi?.note, '| LAYA', d.layaObservation?.reason, '| SHADOW', d.shadow?.mode);
const ok = d.bridge?.topology === 'off' && d.bridge?.running === false && d.bridge?.error === null;
console.log(ok ? 'DIAG_OK' : 'DIAG_UNEXPECTED');
process.exit(ok ? 0 : 1);
