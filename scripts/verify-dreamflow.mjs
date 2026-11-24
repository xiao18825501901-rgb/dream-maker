#!/usr/bin/env node
// Verify the four headline DreamFlow requirements against a running instance.
//   node scripts/verify-dreamflow.mjs --base http://127.0.0.1:4317 --bootstrap <token>
// Token: read it from the server log (UTF-16LE) or pass DM_BOOTSTRAP.
// Read-only unless --flip <pid> <wireRole> <harness> is given.

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const base = arg('base', 'http://127.0.0.1:4317');
// The bootstrap token is single-use: either mint a session with it here, or reuse a live
// cookie with --cookie "name=value" --csrf <token>.
const token = arg('bootstrap', process.env.DM_BOOTSTRAP || '');
let cookie = arg('cookie', '');
let csrf = arg('csrf', '');
if (!cookie) {
  if (!token) {
    console.log('FAIL: pass --bootstrap <token> (single use) or --cookie "name=value" --csrf <token>');
    process.exit(2);
  }
  const session = await fetch(base + '/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrap: token }),
  });
  if (session.status !== 200) {
    console.log('FAIL: session ' + session.status + ' (the bootstrap token may already be consumed)');
    process.exit(2);
  }
  cookie = (session.headers.getSetCookie ? session.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  csrf = (await session.json().catch(() => ({}))).csrf;
}
const H = () => ({ cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' });

const get = async (p) => (await fetch(base + p, { headers: H() })).json();
const engine = (pid) => get('/api/projects/' + encodeURIComponent(pid) + '/engine');

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  if (!ok) failed++;
};

const list = await get('/api/projects');
const projects = list.projects || [];
check('project list', projects.length > 0, projects.length + ' projects');

// 1. A never-touched project defaults to classic with Laya on.
const fresh = projects.find((p) => p.id && p.id.startsWith('project_2edf0cac29')) || projects[0];
const e1 = await engine(fresh.id);
check('default engine is classic', e1.engine === 'classic', fresh.id + ' engine=' + e1.engine);
check('origin is PRODUCT_DEFAULT or HISTORICAL_FROZEN',
  ['PRODUCT_DEFAULT', 'HISTORICAL_FROZEN'].includes(e1.origin), 'origin=' + e1.origin);
check('Laya is ON in classic', e1.badge && e1.badge.laya === 'ON', 'badge.laya=' + (e1.badge || {}).laya);
check('billing layer is classic-laya',
  e1.billing && e1.billing.layer === 'classic-laya', 'layer=' + (e1.billing || {}).layer);

// 2. Custom projects report custom, and their badge turns Laya off.
const customs = [];
for (const p of projects) {
  const e = await engine(p.id).catch(() => null);
  if (e && e.engine === 'custom') customs.push({ id: p.id, e });
}
check('at least one custom project exists', customs.length > 0, customs.length + ' custom');
if (customs[0]) {
  const c = customs[0].e;
  check('custom origin is USER_OVERRIDE', c.origin === 'USER_OVERRIDE', 'origin=' + c.origin);
  check('custom turns Laya off', c.badge && c.badge.laya === 'OFF', 'badge.laya=' + (c.badge || {}).laya);
}

// 3. Optional: flip one role's harness through the real write endpoint.
const flip = process.argv.indexOf('--flip');
if (flip > 0) {
  const pid = process.argv[flip + 1], wire = process.argv[flip + 2], harness = process.argv[flip + 3];
  const roles = await get('/api/projects/' + encodeURIComponent(pid) + '/roles');
  const row = (roles.roles || []).find((r) => r.role === wire);
  if (!row) {
    check('flip target exists', false, wire);
  } else {
    // Older projects may still carry a model id that is no longer registered; fall back to the
    // first catalog model so the harness change itself can still be exercised.
    const models = (row.choices && row.choices.models) || [];
    const usable = models.some((m) => m.id === row.selection.model)
      ? row.selection.model
      : (models.find((m) => m.available !== false) || models[0] || {}).id;
    const key = 'verify-' + Date.now();
    const res = await fetch(base + '/api/studio/roles/' + encodeURIComponent(wire) + '/config', {
      method: 'POST',
      headers: Object.assign(H(), { 'idempotency-key': key }),
      body: JSON.stringify({
        projectId: pid,
        revision: row.revision,
        operation: key,
        selection: {
          model: usable,
          harness,
          effort: row.selection.effort || 'default',
          skills: row.selection.skills || [],
          plugins: row.selection.plugins || [],
        },
      }),
    });
    const body = await res.text();
    check('flip write accepted', res.status === 200, 'POST ' + res.status + ' ' + body.slice(0, 200));
    const after = await engine(pid);
    check('flip switched project to custom', after.engine === 'custom', 'engine=' + after.engine);
    const recheck = await get('/api/projects/' + encodeURIComponent(pid) + '/roles');
    const now = (recheck.roles || []).find((r) => r.role === wire);
    check('flip persisted on the role', now && now.selection.harness === harness,
      wire + '.harness=' + (now || {}).selection?.harness);
  }
}

// 4. Optional: write the product defaults back and confirm classic returns.
const restoreAt = process.argv.indexOf('--restore');
if (restoreAt > 0) {
  const pid = process.argv[restoreAt + 1];
  const cfg = await get('/api/config');
  const c = cfg.config || {};
  const plan = [
    ['planner', 'planner2', { harness: 'codex-app-server', model: c.codex.model }],
    ['executor', 'executor', { harness: 'dsh', model: c.dsh.model }],
    ['reviewer', 'reviewer', { harness: 'codex-app-server', model: c.codex.model }],
  ];
  for (const [catalogRole, wire, want] of plan) {
    const roles = await get('/api/projects/' + encodeURIComponent(pid) + '/roles');
    const row = (roles.roles || []).find((r) => r.role === catalogRole);
    if (!row) { check('restore target ' + wire, false, 'not in catalog'); continue; }
    const key = 'restore-' + wire + '-' + Date.now();
    const res = await fetch(base + '/api/studio/roles/' + encodeURIComponent(wire) + '/config', {
      method: 'POST',
      headers: Object.assign(H(), { 'idempotency-key': key }),
      body: JSON.stringify({
        projectId: pid, revision: row.revision, operation: key,
        selection: { model: want.model, harness: want.harness, effort: 'default',
                     skills: (row.selection || {}).skills || [], plugins: (row.selection || {}).plugins || [] },
      }),
    });
    check('restore ' + wire, res.status === 200, 'POST ' + res.status);
  }
  const back = await engine(pid);
  check('restore returns classic', back.engine === 'classic', 'engine=' + back.engine);
  check('restore returns Laya ON', back.badge && back.badge.laya === 'ON', 'laya=' + (back.badge || {}).laya);
  check('restore clears deviations', ((back.decision || {}).reasons || []).length === 0,
    JSON.stringify((back.decision || {}).reasons || []).slice(0, 120));
}
console.log(failed === 0 ? 'ALL PASS' : failed + ' CHECK(S) FAILED');
process.exit(failed === 0 ? 0 : 1);
