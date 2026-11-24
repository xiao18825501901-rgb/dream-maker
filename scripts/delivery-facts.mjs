import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Settings } from '../dist/server/config.js';
import { nativeReadiness } from '../dist/server/providers/dsh.js';
const root = resolve('.');
const out = resolve(root, 'delivery');
mkdirSync(out, { recursive: true });
const sha = v => createHash('sha256').update(v).digest('hex');
const gitOut = args => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };
const settings = new Settings(resolve(root, 'config/local.json'));
const readiness = nativeReadiness(settings.value);
const auditPath = resolve(root, '.runtime/native-audit.json');
const audit = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')) : null;
const store = new DatabaseSync(resolve(root, '.runtime/dream-maker.sqlite'), { readOnly: true });
const kind = 'NativeProbeReceipt';
const rows = store.prepare('SELECT id, data, at FROM records WHERE kind = ? ORDER BY rowid DESC LIMIT 40').all(kind);
const receipts = [];
for (const row of rows) {
  try {
    const env = JSON.parse(String(row.data));
    const p = env.payload || {};
    const o = p.observation || {};
    receipts.push({ id: row.id, at: row.at, role: p.role, model: o.model, runner: o.runner, authentication: o.authentication, generation: o.credentialGeneration ?? null, signature: String(env.signature || '').slice(0, 16), bindingHash: sha(JSON.stringify(p.binding || {})) });
  } catch {}
}
store.close();
const ledger = new DatabaseSync(resolve(root, '.runtime/controller/native-budget.sqlite'), { readOnly: true });
const scope = ledger.prepare('SELECT phase, repairs FROM scope').get();
const authority = JSON.parse(String(ledger.prepare('SELECT authority FROM scope WHERE id = 1').get().authority));
const reqs = ledger.prepare('SELECT data FROM requests ORDER BY rowid').all().map(r => { const d = JSON.parse(String(r.data)); return { role: d.role, outcome: d.outcome, usageStatus: d.usageStatus, reservedMicros: d.reservedMicros, chargedMicros: d.chargedMicros, currency: d.price?.currency ?? 'CNY' }; });
const hist = ledger.prepare('SELECT at, fromMode, toMode FROM authority_history').all();
ledger.close();
// Two providers bill in two currencies now. The headline figure stays the CNY total it has always been,
// and every other currency is reported separately instead of being added into a meaningless sum.
const currencyOf = r => String(r.currency ?? 'CNY');
const chargedByCurrency = reqs.reduce((out, r) => { const c = currencyOf(r); out[c] = (out[c] || 0) + (Number(r.chargedMicros) || 0); return out; }, {});
const charged = chargedByCurrency.CNY || 0;
// The evidence list is DERIVED, not hand-listed. It used to be a literal array written on 2026-10-20, and by
// 2026-10-30 it no longer covered a single document that actually attested the delivery (the run records, the
// fixes, the authority changes) while still failing on edits to files it did list. Deriving it from the
// directories that hold the record keeps the manifest honest as the record grows.
const evidenceDirs = ['docs/continuation', 'docs/kimi-p1', 'delivery'];
const evidenceExtra = ['FILE_MANIFEST.json', 'config/codex-agent-readonly.toml', 'config/codex-agent-windows-readonly.toml'];
const walkEvidence = dir => {
    const out = [];
    let entries = [];
    try { entries = readdirSync(resolve(root, dir), { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        const rel = dir + '/' + entry.name;
        if (entry.isDirectory()) { out.push(...walkEvidence(rel)); continue; }
        if (!entry.isFile() || !/\.(md|json)$/i.test(entry.name)) continue;
        if (statSync(resolve(root, rel)).size > 512 * 1024) continue;
        out.push(rel);
    }
    return out;
};
const files = [...new Set([...evidenceDirs.flatMap(walkEvidence), ...evidenceExtra])].sort();
const evidence = files.map(rel => { const p = resolve(root, rel); const b = existsSync(p) ? readFileSync(p) : null; return { path: rel, present: !!b, bytes: b ? b.length : 0, sha256: b ? sha(b) : null }; });
const suiteLogs = (() => { try { return readdirSync(resolve(root, '.runtime')).filter(n => /^suite-\d+\.log$/.test(n)); } catch { return []; } })();
const newestSuite = suiteLogs.map(n => ({ n, t: statSync(resolve(root, '.runtime', n)).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.n;
const suiteLog = newestSuite ? resolve(root, '.runtime', newestSuite) : resolve(root, '.runtime/suite-none.log');
const suiteLines = existsSync(suiteLog) ? readFileSync(suiteLog, 'utf8').split(String.fromCharCode(10)).filter(l => l.includes('ℹ tests') || l.includes('ℹ pass') || l.includes('ℹ fail') || l.includes('ℹ skipped')).map(l => l.replace('ℹ ', '')) : [];
const facts = { schema: 'dream-maker.delivery.facts.v1', generatedAt: new Date().toISOString(), head: gitOut(['rev-parse', 'HEAD']), clean: gitOut(['status', '--porcelain']).length === 0, readiness: { ok: readiness.ok, reasons: readiness.reasons, configurationHash: readiness.configurationHash }, audit: audit ? { status: audit.status, expiresAt: audit.expiresAt, checks: (audit.checks || []).map(c => c.name), evidenceFiles: (audit.evidenceFiles || []).length } : null, phase: scope ? scope.phase : null, repairs: scope ? scope.repairs : null, receipts, ledger: { requests: reqs.length, chargedMicros: charged, chargedByCurrency, authorityMode: authority.mode, authorityHistory: hist, detail: reqs }, suite: suiteLines, evidence };
writeFileSync(resolve(out, 'facts.json'), JSON.stringify(facts, null, 2) + String.fromCharCode(10));
console.log(JSON.stringify({ receipts: receipts.map(r => r.role + ':' + r.authentication + ':gen' + r.generation), phase: facts.phase, requests: reqs.length, chargedCny: (charged / 1e6).toFixed(2), chargedByCurrency: Object.fromEntries(Object.entries(chargedByCurrency).map(([c, v]) => [c, (Number(v) / 1e6).toFixed(2)])), audit: facts.audit ? facts.audit.status + '/' + facts.audit.checks.length : null, suite: suiteLines }));
