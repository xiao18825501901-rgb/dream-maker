#!/usr/bin/env node
// One read-only checklist for a real four-role Live run. Every line is a fact measured now, not a claim.
// Prints BLOCKED for external limits (network/credentials) and TODO for missing local artefacts, so the
// next session starts from a concrete list instead of re-discovering it.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { Settings } from '../dist/server/config.js';
import { nativeReadiness } from '../dist/server/providers/dsh.js';
const root = resolve('.');
const args = process.argv.slice(2);
const rows = [];
const add = (state, name, detail) => { rows.push({ state, name, detail }); console.log(state.padEnd(8) + name + (detail ? ' — ' + detail : '')); };
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 60000 }).trim(); } catch { return ''; } };
const configPath = resolve(process.env.DM_CONFIG || resolve(root, 'config/local.json'));
const settings = new Settings(configPath);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const readiness = nativeReadiness(settings.value);

const head = sh('git', ['rev-parse', '--short', 'HEAD']);
const dirty = sh('git', ['status', '--porcelain']).length > 0;
add('OK', 'code', 'HEAD ' + head + (dirty ? ' (working tree has uncommitted changes)' : ' (clean)'));
add(readiness.ok ? 'OK' : 'TODO', 'readiness', readiness.ok ? 'reasons=[] hash=' + readiness.configurationHash.slice(0, 12) : 'reasons=' + readiness.reasons.join(','));

const auditPath = config.nativeAuditPath ? resolve(config.nativeAuditPath) : resolve(root, '.runtime/native-audit.json');
if (!existsSync(auditPath)) add('TODO', 'audit', 'missing: node scripts/native-audit.mjs');
else {
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  const expired = !(Date.parse(audit.expiresAt) > Date.now());
  add(expired ? 'TODO' : 'OK', 'audit', audit.status + ' checks=' + (audit.checks || []).length + ' expires=' + audit.expiresAt + (expired ? ' (EXPIRED: regenerate)' : ''));
}

const kimiPort = (() => { try { return new URL(config.kimi?.baseUrl ?? '').port; } catch { return ''; } })();
if (!kimiPort) add('BLOCKED', 'kimi', 'config.kimi.baseUrl is not a URL');
else {
  const code = sh('curl.exe', ['-s', '-m', '5', '-o', 'NUL', '-w', '%{http_code}', 'http://127.0.0.1:' + kimiPort + '/api/v1/auth']);
  add(['200', '401', '403'].includes(code) ? 'OK' : 'BLOCKED', 'kimi-server', 'port ' + kimiPort + ' -> HTTP ' + (code || '000') + (['200', '401', '403'].includes(code) ? '' : ' (down or bound to another port; see docs/kimi-p1/122)'));
}

// Opt-in deep check: one real Kimi turn proves the UPSTREAM works, not just that the server answers.
// It is off by default because it spends a subscription turn; with --deep it also tells us whether an
// interview is worth starting at all.
if (args.includes('--deep') && kimiPort) {
  const config2 = config;
  try {
    const token = readFileSync(config2.kimi.tokenFile, 'utf8').trim();
    const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    const created = await (await fetch('http://127.0.0.1:' + kimiPort + '/api/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ metadata: { cwd: '/tmp' } }) })).json();
    const sid = created?.data?.id ?? created?.id;
    const accepted = await (await fetch('http://127.0.0.1:' + kimiPort + '/api/v1/sessions/' + sid + '/prompts', { method: 'POST', headers, body: JSON.stringify({ content: [{ type: 'text', text: 'Reply with exactly: OK' }], model: config2.planner1.model }) })).json();
    let state = '(none)';
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const t = await (await fetch('http://127.0.0.1:' + kimiPort + '/api/v1/sessions/' + sid + '/transcript?agent_id=main&page_size=1', { headers })).json();
      const item = (t?.data?.items ?? t?.items ?? [])[0] ?? {};
      state = item.state ?? '(none)';
      if (['completed', 'failed', 'cancelled', 'blocked'].includes(state)) break;
    }
    add(state === 'completed' ? 'OK' : 'BLOCKED', 'kimi-turn', 'raw server turn state=' + state + (state === 'completed' ? '' : ' (upstream: the server accepted the prompt but the model call failed)'));
  } catch (error) { add('BLOCKED', 'kimi-turn', 'deep check failed: ' + String(error?.message ?? error).slice(0, 120)); }
}

const openai = sh('curl.exe', ['-s', '-m', '8', '-o', 'NUL', '-w', '%{http_code}', 'https://api.openai.com/v1/models']);
const chatgpt = sh('curl.exe', ['-s', '-m', '8', '-o', 'NUL', '-w', '%{http_code}', 'https://chatgpt.com/backend-api/codex']);
add(['200', '401'].includes(openai) && ['200', '401', '403'].includes(chatgpt) ? 'OK' : 'BLOCKED', 'codex-egress', 'api.openai.com -> ' + (openai || '000') + ', chatgpt.com -> ' + (chatgpt || '000') + (openai === '403' ? ' (region block: planner2/reviewer cannot get a real turn)' : ''));

const codexHome = typeof config.codex?.home==='string' && config.codex.home ? resolve(config.codex.home) : resolve(root, '.runtime/codex-home');
const authPath = resolve(codexHome, 'auth.json');
if (!existsSync(authPath)) add('TODO', 'codex-login', 'no auth.json in the configured Codex home (owner runs codex login)');
else { const auth = JSON.parse(readFileSync(authPath, 'utf8')); add('OK', 'codex-login', 'auth_mode=' + auth.auth_mode + ' account_id=' + (auth.tokens?.account_id ? 'present' : 'absent')); }

const bin = config.codex?.wslBinary ?? '';
const distro = config.codex?.wslDistro ?? '';
if ((config.codex?.transport ?? 'stdio') === 'wsl') {
  const version = bin && distro ? sh('wsl.exe', ['-d', distro, '--exec', bin, '--version']) : '';
  add(/^codex-cli \d+\.\d+\.\d+/.test(version) ? 'OK' : 'BLOCKED', 'codex-cli', version ? version.split(String.fromCharCode(10))[0] : 'wsl --exec <binary> --version gave no version');
} else add('OK', 'codex-cli', 'stdio transport: ' + (config.codex?.command ?? '?') + ' ' + (config.codex?.args ?? []).join(' ').slice(0, 60));

const operatorPath = resolve(root, 'config/native-owner.local.json');
let oracles = {};
if (!existsSync(operatorPath)) add('TODO', 'operator-binding', 'missing config/native-owner.local.json');
else {
  const operator = JSON.parse(readFileSync(operatorPath, 'utf8'));
  oracles = operator.oracles ?? {};
  add('OK', 'operator-binding', 'maxRequests=' + operator.maxRequests + ' maxOutputTokens=' + operator.maxOutputTokens + ' oracles=' + Object.keys(oracles).length);
}
const storePath = resolve(root, '.runtime/dream-maker.sqlite');
if (existsSync(storePath)) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  const withSpec = [];
  const { undecidedRequirements } = await import('../dist/server/spec-decidability.js');
  for (const row of db.prepare('SELECT id, data FROM projects').all()) {
    const p = JSON.parse(String(row.data));
    if (!p.specId) continue;
    const spec = JSON.parse(String(db.prepare('SELECT data FROM specs WHERE id = ?').get(p.specId)?.data ?? '{}'));
    if (!spec.hash) continue;
    const approved = Boolean(db.prepare("SELECT 1 FROM approvals WHERE project_id = ? AND spec_hash = ? AND kind = 'SPEC'").get(row.id, spec.hash));
    const undecided = spec.hash ? undecidedRequirements(spec) : [];
    withSpec.push({ project: row.id, mode: p.mode, specHash: spec.hash, reqs: (spec.requirements ?? []).length, registered: !!oracles[spec.hash], approved, undecided });
  }
  db.close();
  for (const p of withSpec) {
    const parts = [p.mode, 'spec=' + p.specHash.slice(0, 10), 'reqs=' + p.reqs,
      'approved=' + (p.approved ? 'yes' : 'no'),
      'undecided=' + (p.undecided.length ? p.undecided.join(',') : '0'),
      'oracle=' + (p.registered ? 'yes' : 'no')];
    const ready = p.approved && p.registered && p.undecided.length === 0;
    const nextStep = ready ? 'READY_FOR_LIVE_BUILD' : (!p.undecided.length ? 'owner approves spec' : 'decide ' + p.undecided.join(',') + ' (see docs/132)');
    add(ready ? 'OK' : 'TODO', 'spec ' + p.project, parts.join(' ') + ' -> ' + nextStep);
  }
  if (withSpec.length === 0) add('TODO', 'oracle', 'no project with an approved spec');
}

const ledgerPath = resolve(root, '.runtime/controller/native-budget.sqlite');
if (existsSync(ledgerPath)) {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  const scope = db.prepare('SELECT phase FROM scope').get();
  const reqs = db.prepare('SELECT data FROM requests').all().map(r => JSON.parse(String(r.data)));
  const charged = reqs.reduce((n, r) => n + (Number(r.chargedMicros) || 0), 0);
  db.close();
  add(scope?.phase === 'REPRESENTATIVE' ? 'OK' : 'TODO', 'budget', 'phase=' + String(scope?.phase) + ' requests=' + reqs.length + ' chargedCNY=' + (charged / 1e6).toFixed(2));
}

// Probe gate: use the running app when it owns the controller lease, otherwise the receipt store.
let gate = null;
try {
  const session = JSON.parse(readFileSync(resolve(root, '.runtime/session.json'), 'utf8'));
  const response = await fetch('http://127.0.0.1:4317/api/native/probes', { headers: { cookie: session.cookie } });
  if (response.ok) gate = await response.json();
} catch { }
if (gate && gate.roles) {
  const valid = Object.keys(gate.roles).filter(r => gate.roles[r].valid);
  add(valid.length === 4 ? 'OK' : 'TODO', 'probe-gate', 'phase=' + gate.phase + ' valid=[' + valid.join(',') + ']' + (valid.length === 4 ? '' : ' (missing: ' + Object.keys(gate.roles).filter(r => !gate.roles[r].valid).join(',') + ')'));
} else {
  // "app not answering" was the message even while the app answered 200 on /, because the real cause was
  // a missing or stale .runtime/session.json. Distinguish the two: a wrong cause costs a whole debugging
  // round, which is the same failure this file exists to prevent.
  let up = false;
  try { up = (await fetch('http://127.0.0.1:4317/', { signal: AbortSignal.timeout(3000) })).status === 200; } catch { }
  const hasSession = existsSync(resolve(root, '.runtime/session.json'));
  const stored = (() => {
    try {
      const db = new DatabaseSync(resolve(root, '.runtime', 'dream-maker.sqlite'), { readOnly: true });
      const rows = db.prepare("SELECT data FROM records WHERE kind='NativeProbeReceipt'").all();
      const roles = new Set();
      for (const row of rows) { try { const p = JSON.parse(String(row.data)).payload; if (p?.role) roles.add(p.role); } catch { } }
      db.close();
      return [...roles].sort().join(',') || 'none';
    } catch { return 'unreadable'; }
  })();
  add('TODO', 'probe-gate', !up
    ? 'app not answering on 4317; start it and read GET /api/native/probes'
    : (hasSession ? 'app is up but the stored session was refused; reopen the app URL' : 'app is up but this script has no session cookie (.runtime/session.json absent)')
      + ' — receipts on disk for: ' + stored + ' (validity needs GET /api/native/probes from the logged-in app)');
}

const blocked = rows.filter(r => r.state !== 'OK');
console.log('');
if (blocked.length === 0) console.log('LIVE_PREFLIGHT_READY — every precondition measured OK');
else {
  console.log('LIVE_PREFLIGHT_NOT_READY (' + blocked.length + ')');
  for (const r of blocked) console.log('  ' + r.state + ' ' + r.name + ': ' + r.detail);
}
process.exitCode = blocked.length === 0 ? 0 : 1;
