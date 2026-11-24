import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { archonBindingStatus } from '../dist/server/archon-status.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const fixture = (over = {}) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'dm-archon-'));
    const hostScript = resolve(dir, 'dsh-node-host.mjs'), hostModule = resolve(dir, 'node-host-client.js');
    writeFileSync(hostScript, 'host script bytes\n');
    writeFileSync(hostModule, 'host module bytes\n');
    const templatePath = resolve(dir, 'template.json');
    writeFileSync(templatePath, JSON.stringify({ hostScript, hostModule }));
    const operatorPath = resolve(dir, 'native-owner.json');
    writeFileSync(operatorPath, JSON.stringify({ schema: 'dream-maker.native-owner.v1', template: { path: templatePath } }));
    const auditPath = resolve(dir, 'native-audit.json');
    const audit = {
        status: 'LIVE_READY',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        evidenceFiles: [{ path: hostScript, sha256: sha('host script bytes\n') }, { path: hostModule, sha256: sha('host module bytes\n') }],
        ...over.audit
    };
    writeFileSync(auditPath, JSON.stringify(audit));
    return { dir, operatorPath, auditPath, hostScript, hostModule, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test('a binding whose host files match a live audit is reported as bound, not as unverified', (t) => {
    const f = fixture(); t.after(f.cleanup);
    const status = archonBindingStatus(f.operatorPath, f.auditPath);
    assert.equal(status.status, 'ARCHON_NATIVE_BOUND');
    assert.equal(status.hostScript.bound, true);
    assert.equal(status.hostModule.bound, true);
    assert.equal(status.audit.expired, false);
});

test('the same diagnostics say unverified when the host bytes stop matching the audit', (t) => {
    const f = fixture(); t.after(f.cleanup);
    writeFileSync(f.hostScript, 'edited after the audit\n');
    const status = archonBindingStatus(f.operatorPath, f.auditPath);
    assert.equal(status.status, 'ARCHON_NATIVE_UNVERIFIED');
    assert.match(status.reason, /host script is not the file the audit recorded/);
});

test('an expired or non-live audit cannot claim the binding is installed', (t) => {
    const expired = fixture({ audit: { expiresAt: new Date(Date.now() - 1000).toISOString() } }); t.after(expired.cleanup);
    assert.equal(archonBindingStatus(expired.operatorPath, expired.auditPath).status, 'ARCHON_NATIVE_UNVERIFIED');
    const stale = fixture({ audit: { status: 'NOT_LIVE_READY' } }); t.after(stale.cleanup);
    const status = archonBindingStatus(stale.operatorPath, stale.auditPath);
    assert.equal(status.status, 'ARCHON_NATIVE_UNVERIFIED');
    assert.match(status.reason, /not LIVE_READY/);
});

test('a missing operator binding or audit is named instead of guessed', () => {
    const status = archonBindingStatus(resolve(tmpdir(), 'dm-absent-operator.json'), resolve(tmpdir(), 'dm-absent-audit.json'));
    assert.equal(status.status, 'ARCHON_NATIVE_UNVERIFIED');
    assert.match(status.reason, /operator binding absent/);
});
