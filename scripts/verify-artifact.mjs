#!/usr/bin/env node
// Verify a DELIVERED artifact without trusting it: the run's workspace, the exported ZIP and the manifest
// inside that ZIP all have to agree, and the archive's own CRCs have to hold.
//
// Why a separate tool: the product's verify-delivery.mjs checks the evidence record (facts, audit, regression),
// and the delivered project ZIP was verified by hand each time with ad-hoc scripts. Section 7.11 of the owner's
// mandate asks for the artifact itself to be re-extracted and hash-checked, so that check belongs to the product.
// The archive-level logic lives in src/server/artifact-verify.ts so it can be tested without a store.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { treeHash } from '../dist/server/workspace.js';
import { verifyArtifactArchive } from '../dist/server/artifact-verify.js';
const root = resolve('.');
const sha = value => createHash('sha256').update(value).digest('hex');
const store = new DatabaseSync(resolve(root, '.runtime/dream-maker.sqlite'), { readOnly: true });
const wanted = process.argv[2] && !process.argv[2].startsWith('--') ? [process.argv[2]] : null;
const runs = store.prepare('SELECT id, data FROM runs ORDER BY rowid').all()
    .map(row => JSON.parse(String(row.data)))
    .filter(run => ['READY_FOR_DELIVERY', 'ACCEPTED'].includes(run.state))
    .filter(run => !wanted || wanted.includes(run.id));
store.close();
if (runs.length === 0) { console.log('NOTHING_TO_VERIFY'); process.exit(2); }

let failed = 0, skipped = 0, verified = 0;
const report = item => { if (!item.ok) failed += 1; console.log((item.ok ? 'OK   ' : 'FAIL ') + item.label + (item.detail ? ' — ' + item.detail : '')); };
for (const run of runs) {
    console.log('run ' + run.id + ' state=' + run.state);
    const tree = existsSync(run.workspace) ? treeHash(run.workspace) : null;
    report({ label: 'workspace matches the run treeHash', ok: tree === run.treeHash, detail: tree === run.treeHash ? String(tree).slice(0, 16) + '…' : 'run=' + String(run.treeHash).slice(0, 12) + '… workspace=' + String(tree).slice(0, 12) + '…' });
    const zipPath = resolve(root, '.runtime/delivery/dream-maker-live-' + run.id + '.zip');
    // A delivered run does not have to be exported: most demo runs never are. Only an archive that exists can
    // be wrong, so an absent one is reported and skipped instead of counted as a failure.
    if (!existsSync(zipPath)) { skipped += 1; console.log('SKIP no exported archive (export it with: node .runtime/export-run.mjs ' + run.id + ')'); continue; }
    const bytes = readFileSync(zipPath);
    console.log('     archive sha256=' + sha(bytes) + ' bytes=' + bytes.length);
    const result = verifyArtifactArchive(bytes, { id: run.id, specHash: run.specHash, treeHash: run.treeHash });
    result.checks.forEach(report);
    if (result.ok) verified += 1;
}
console.log((failed === 0 ? 'ARTIFACT_VERIFIED' : 'ARTIFACT_MISMATCH (' + failed + ')') + ' verified=' + verified + ' skipped=' + skipped);
process.exit(failed === 0 ? 0 : 1);
