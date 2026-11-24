// Upgrade an existing read-only project snapshot in a NEW directory; never open the live database writable.
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Store } from '../../dist/server/store.js';
import { within } from '../../dist/server/security.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const input = within(root, '.runtime/revamp-20261101/project-before.sqlite');
const suffix = new Date().toISOString().replace(/[^0-9T]/g, '');
const output = within(root, `.runtime/revamp-20261101/migration-check-${suffix}`);
assert.ok(!existsSync(output), 'refuse to overwrite an earlier migration proof');
mkdirSync(output, { recursive: false });
const tables = ['projects', 'specs', 'runs', 'approvals', 'workspace_leases', 'events', 'records', 'requests'];
function fingerprints(db) {
    return Object.fromEntries(tables.map(table => {
        const hash = createHash('sha256'); let rows = 0;
        // table is a controller-owned constant, never input or model output.
        for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) {
            hash.update(JSON.stringify(row) + '\n'); rows++;
        }
        return [table, { rows, sha256: hash.digest('hex') }];
    }));
}
const source = new DatabaseSync(input, { readOnly: true });
let before;
try {
    assert.equal(source.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    before = fingerprints(source);
    await backup(source, resolve(output, 'upgraded.sqlite'));
} finally { source.close(); }
const migrated = new Store(resolve(output, 'upgraded.sqlite'));
let report;
try {
    const after = fingerprints(migrated.db);
    assert.deepEqual(after, before, 'all original business rows must retain identical bytes');
    assert.equal(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const versions = Number(migrated.db.prepare('SELECT COUNT(*) n FROM plan_versions').get().n);
    assert.equal(versions, before.specs.rows);
    assert.equal(migrated.db.prepare('SELECT COUNT(*) n FROM plan_version_approvals').get().n, 0);
    for (const row of migrated.db.prepare('SELECT id FROM specs').all()) migrated.spec(row.id);
    report = { schema: 'dream-maker.plan-migration-proof.v1', at: new Date().toISOString(),
        scope: 'REAL_EXISTING_DATABASE_COPY_ONLY_NOT_LIVE_ROLE_ACCEPTANCE',
        source: '.runtime/revamp-20261101/project-before.sqlite', businessTables: after,
        schemaVersion: migrated.db.prepare('SELECT MAX(version) n FROM schema_versions').get().n,
        importedVersions: versions, fabricatedVersionApprovals: 0, integrity: 'ok', result: 'PASS' };
} finally { migrated.close(); }
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ result: report.result, output, importedVersions: report.importedVersions, preservedTables: tables.length }));
