#!/usr/bin/env node
// Register a project's trusted CLI verifier plan (the 'oracle') with the native operator binding.
//
// Why this exists: NativeOwner.verifierPlan reads ONLY config/native-owner.local.json's `oracles` map.
// Nothing in the product writes it, so the Live verification step would always stop at
// TRUSTED_VERIFIER_PLAN_REQUIRED. The plan itself must stay operator-authored (it encodes what the
// delivered CLI must do), so this script validates and registers it - it never invents cases.
//
// usage: node scripts/native-oracles.mjs --plan <file.json> [--project <id>] [--register]
//        node scripts/native-oracles.mjs --list
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateVerifierPlan } from '../dist/server/wsl-verifier.js';
import { DomainError, hasSecret } from '../dist/server/security.js';

const root = resolve('.');
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const sha = value => createHash('sha256').update(value).digest('hex');
// The two paths are flags so the registration logic can be exercised against a copy of the store
// without touching the real operator binding or the real projects.
const operatorPath = resolve(root, flag('operator') ?? 'config/native-owner.local.json');
if (!existsSync(operatorPath)) { console.log('REFUSED NATIVE_OPERATOR_CONFIG_REQUIRED'); process.exit(2); }
const operator = JSON.parse(readFileSync(operatorPath, 'utf8'));
const oracleRoot = resolve(operator.oracleRoot);
const storePath = resolve(root, flag('store') ?? '.runtime/dream-maker.sqlite');

function projects() {
  if (!existsSync(storePath)) return [];
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, data FROM projects').all();
    return rows.map(row => {
      const p = JSON.parse(String(row.data));
      const spec = p.specId ? JSON.parse(String(db.prepare('SELECT data FROM specs WHERE id = ?').get(p.specId)?.data ?? '{}')) : null;
      return { id: row.id, name: p.name, mode: p.mode, specHash: spec?.hash ?? null, stale: spec?.stale === true,
        requirements: (spec?.requirements ?? []).map(r => r.id),
        acceptance: (spec?.acceptanceItems ?? []).map(item => ({ id: String(item.id), requirementIds: (item.requirementIds ?? []).map(String) })) };
    });
  } finally { db.close(); }
}

if (args.includes('--list')) {
  console.log('registered oracles: ' + JSON.stringify(Object.keys(operator.oracles ?? {})));
  for (const p of projects()) console.log('  project ' + p.id + ' mode=' + p.mode + ' specHash=' + (p.specHash ?? '-') + ' reqs=' + p.requirements.length + ' registered=' + String(!!(operator.oracles ?? {})[p.specHash]));
  process.exit(0);
}

const planPath = flag('plan');
if (!planPath) { console.log('usage: node scripts/native-oracles.mjs --plan <file.json> [--project <id>] [--register] | --list'); process.exit(2); }
const planBytes = readFileSync(resolve(root, planPath));
if (hasSecret(planBytes.toString('utf8'))) { console.log('REFUSED SECRET_IN_ORACLE'); process.exit(2); }
const plan = JSON.parse(planBytes.toString('utf8'));
const wanted = flag('project');
const known = projects().filter(p => (wanted ? p.id === wanted : true) && p.specHash);
if (known.length === 0) { console.log('REFUSED NO_PROJECT_WITH_SPEC' + (wanted ? ' (' + wanted + ')' : '')); process.exit(2); }
const target = known.find(p => p.specHash === plan.specHash);
if (!target) { console.log('REFUSED ORACLE_SPEC_NOT_KNOWN: plan.specHash is not any project spec on this machine'); process.exit(2); }
if (target.stale) { console.log('REFUSED SPEC_STALE'); process.exit(2); }
try { validateVerifierPlan(plan, target.specHash, target.requirements, target.acceptance); }
catch (error) { const code = error instanceof DomainError ? error.code : String(error?.message ?? error); console.log('REFUSED ' + code); process.exit(2); }
const planHash = sha(planBytes);
console.log('VALID planHash=' + planHash + ' specHash=' + target.specHash + ' requirements=' + target.requirements.join(','));
if (!args.includes('--register')) { console.log('DRY_RUN (add --register to write the operator binding)'); process.exit(0); }
mkdirSync(oracleRoot, { recursive: true, mode: 0o700 });
const relativePath = target.specHash + '.json';
const destination = resolve(oracleRoot, relativePath);
if (existsSync(destination) && sha(readFileSync(destination)) !== planHash) { console.log('REFUSED ORACLE_ALREADY_REGISTERED_WITH_DIFFERENT_BYTES: delete it deliberately first'); process.exit(2); }
copyFileSync(resolve(root, planPath), destination);
const written = readFileSync(destination);
operator.oracles = { ...(operator.oracles ?? {}), [target.specHash]: { relativePath, sha256: sha(written) } };
writeFileSync(operatorPath, JSON.stringify(operator, null, 2) + String.fromCharCode(10), { mode: 0o600 });
console.log('REGISTERED ' + basename(destination) + ' sha256=' + sha(written));
console.log('NEXT: the operator binding changed, so the audit no longer matches it.');
console.log('      run: node scripts/native-audit.mjs   (then the owner approves with POST /api/projects/<id>/native-verifier/approve)');
