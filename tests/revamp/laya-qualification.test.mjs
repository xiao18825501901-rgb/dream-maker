import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../../dist/server/config.js';
import { assertLayaQualification, layaQualificationBinding } from '../../dist/server/laya-qualification.js';

const hash = () => 'a'.repeat(64);
const cfg = (laya = {}) => {
    const c = structuredClone(defaults);
    c.laya = { ...c.laya, mode: 'advisory', ...laya };
    return c;
};
const binding = (config) => layaQualificationBinding('/root', config, hash);
const evidence = () => ({
    inputHash: 'b'.repeat(64), adoption: 'advisory', label: 'plan', latencyMs: 12, confidence: 0.7, modelRevision: null, cached: false,
});
const record = (config) => ({
    schema: 'dream-maker.laya-qualification.v1', status: 'QUALIFIED', protocol: 'dm-bridge-v1',
    baseUrl: 'http://127.0.0.1:8765', mode: 'advisory', roles: ['planner2', 'executor', 'reviewer'],
    sourceHash: binding(config).sourceHash, configurationHash: binding(config).configurationHash,
    modelRevision: null, roleEvidence: { planner2: evidence(), executor: evidence(), reviewer: evidence() },
    causalModelInfluence: 'NOT_CLAIMED', issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});

test('a complete record bound to the current source and config is accepted', () => {
    const config = cfg();
    const out = assertLayaQualification(record(config), { binding: binding(config), config });
    assert.equal(out.status, 'QUALIFIED');
});

test('any source, config, origin or revision drift is refused', () => {
    const config = cfg();
    const wrongSource = { ...record(config), sourceHash: 'c'.repeat(64) };
    const wrongConfig = { ...record(config), configurationHash: 'd'.repeat(64) };
    const wrongOrigin = { ...record(config), baseUrl: 'http://127.0.0.1:8766' };
    const wrongMode = { ...record(config), mode: 'shadow' };
    for (const bad of [wrongSource, wrongConfig, wrongOrigin, wrongMode]) {
        assert.throws(() => assertLayaQualification(bad, { binding: binding(config), config }), (e) => e.code === 'NATIVE_LAYA_QUALIFICATION_REQUIRED');
    }
});

test('an abstained, cached or missing role forward cannot qualify the enhanced path', () => {
    const config = cfg();
    for (const patch of [
        { adoption: 'abstained' },
        { cached: true },
        { adoption: 'off' },
        { label: null },
    ]) {
        const bad = record(config);
        bad.roleEvidence.reviewer = { ...bad.roleEvidence.reviewer, ...patch };
        assert.throws(() => assertLayaQualification(bad, { binding: binding(config), config }), (e) => e.code === 'NATIVE_LAYA_QUALIFICATION_REQUIRED');
    }
});

test('an expired record is refused', () => {
    const config = cfg();
    const bad = { ...record(config), expiresAt: new Date(Date.now() - 1000).toISOString() };
    assert.throws(() => assertLayaQualification(bad, { binding: binding(config), config }), (e) => e.code === 'NATIVE_LAYA_QUALIFICATION_REQUIRED');
});

test('a pinned expected revision must match the recorded forward', () => {
    const strict = cfg({ expectedRevision: 'rev-1' });
    assert.throws(() => assertLayaQualification(record(strict), { binding: binding(strict), config: strict }), (e) => e.code === 'NATIVE_LAYA_QUALIFICATION_REQUIRED');
    const ok = record(strict);
    for (const role of ['planner2', 'executor', 'reviewer']) ok.roleEvidence[role] = { ...ok.roleEvidence[role], modelRevision: 'rev-1' };
    assert.equal(assertLayaQualification(ok, { binding: binding(strict), config: strict }).modelRevision, null);
});
