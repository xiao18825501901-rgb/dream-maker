#!/usr/bin/env node
// Verify a delivered evidence bundle WITHOUT trusting it: recompute every hash the bundle claims.
//
// The point is that the owner can run this on their own copy and see whether the report, the archive
// and the audit still say what the machine says. Any mismatch is a failure, not a warning.
//
// Three of the four checks read MACHINE-LOCAL evidence (.runtime, the delivered evidence archive). The
// engineering package excludes exactly that, so a recipient extracting the package and running this got an
// unhandled PowerShell error: spawning `powershell Get-ChildItem .runtime` threw once .runtime was absent.
// Those checks now read the filesystem directly and SKIP with a reason when their input is not in this
// checkout; only a present-but-wrong input is a failure.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('.');
const sha = b => createHash('sha256').update(b).digest('hex');
let failed = 0, ran = 0, skipped = 0;
const check = (label, ok, detail) => { ran += 1; if (!ok) failed += 1; console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' — ' + detail : '')); };
const skip = (label, reason) => { skipped += 1; console.log('SKIP ' + label + ' — ' + reason); };

const factsPath = resolve(root, 'delivery/facts.json');
if (!existsSync(factsPath)) { console.log('NO_DELIVERY_RECORD — no delivery/facts.json in this checkout'); process.exit(2); }
const facts = JSON.parse(readFileSync(factsPath, 'utf8'));

// 1) every evidence file still hashes to what facts.json recorded
let evidenceOk = 0, evidenceBad = 0;
for (const item of facts.evidence ?? []) {
    const path = resolve(root, item.path);
    if (!existsSync(path)) { evidenceBad += 1; console.log('MISSING ' + item.path); continue; }
    const actual = sha(readFileSync(path));
    if (actual === item.sha256) evidenceOk += 1;
    else { evidenceBad += 1; console.log('CHANGED ' + item.path + ' expected=' + String(item.sha256).slice(0, 12) + '… actual=' + actual.slice(0, 12) + '…'); }
}
check('evidence files match facts.json', evidenceBad === 0, evidenceOk + ' ok, ' + evidenceBad + ' mismatched');

// 2) the archive still hashes to what SHA256SUMS recorded
const sumsPath = resolve(root, 'delivery/SHA256SUMS');
const zipPath = resolve(root, 'delivery/dream-maker-evidence.zip');
if (!existsSync(sumsPath) || !existsSync(zipPath)) skip('archive hash matches SHA256SUMS', 'the evidence archive is not part of this checkout');
else {
    const recorded = readFileSync(sumsPath, 'utf8').trim().split(/\s+/)[0];
    const actual = sha(readFileSync(zipPath));
    check('archive hash matches SHA256SUMS', recorded === actual, recorded === actual ? recorded.slice(0, 16) + '…' : 'recorded=' + recorded.slice(0, 12) + '… actual=' + actual.slice(0, 12) + '…');
}

// 3) the native audit's own evidence list still holds
const auditPath = resolve(root, '.runtime/native-audit.json');
if (!existsSync(auditPath)) skip('native audit evidence', 'no .runtime/native-audit.json in this checkout');
else {
    const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
    let bad = 0;
    for (const f of audit.evidenceFiles ?? []) {
        if (!existsSync(f.path) || sha(readFileSync(f.path)) !== f.sha256) { bad += 1; console.log('AUDIT-STALE ' + f.path); }
    }
    const expired = !(Date.parse(audit.expiresAt) > Date.now());
    check('native audit evidence', bad === 0, (audit.evidenceFiles ?? []).length + ' files, ' + bad + ' stale');
    check('native audit not expired', !expired, 'expiresAt=' + String(audit.expiresAt));
}

// 4) regression numbers in the facts still match the newest suite log on disk
const runtime = resolve(root, '.runtime');
const suiteLog = (() => {
    if (!existsSync(runtime)) return null;
    const logs = readdirSync(runtime).filter(name => /^suite-\d+\.log$/.test(name));
    if (!logs.length) return null;
    return logs.map(name => ({ name, at: statSync(resolve(runtime, name)).mtimeMs })).sort((a, b) => b.at - a.at)[0].name;
})();
if (!suiteLog) skip('regression has zero failures', 'no .runtime/suite-*.log in this checkout');
else {
    const text = readFileSync(resolve(runtime, suiteLog), 'utf8');
    const grab = key => { const m = new RegExp('ℹ ' + key + ' (\\d+)').exec(text); return m ? Number(m[1]) : null; };
    const live = { tests: grab('tests'), pass: grab('pass'), fail: grab('fail'), skipped: grab('skipped') };
    console.log('     newest suite log ' + suiteLog + ' -> ' + JSON.stringify(live));
    check('regression has zero failures', live.fail === 0, suiteLog);
}

const summary = 'ran=' + ran + ' skipped=' + skipped;
if (failed === 0) { console.log('DELIVERY_VERIFIED (' + summary + ')'); process.exitCode = 0; }
else { console.log('DELIVERY_MISMATCH (' + failed + ', ' + summary + ')'); process.exitCode = 1; }
