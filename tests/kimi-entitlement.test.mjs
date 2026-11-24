import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeQuota, classifyExtraUsage, assertExtraUsageGate } from '../dist/server/kimi-entitlement.js';

// G04: the upstream payload cannot express the Extra Usage toggle, so absence is UNKNOWN and
// stops new reasoning. Only an explicit boolean may declare OFF.

test('K04-E1 the live shape with extraUsage null is UNKNOWN, never OFF', () => {
    // Observed on the real server: {"kind":"ok","quota":{"usages":{},"extraUsage":null}}
    const summary = summarizeQuota({ kind: 'ok', quota: { usages: {}, extraUsage: null } });
    assert.equal(summary.extraUsage, 'UNKNOWN');
    assert.deepEqual(summary.limits, []);
    assert.match(summary.extraUsageReason, /NO_WALLET_RECORD/);
    assert.throws(() => assertExtraUsageGate(summary), { code: 'KIMI_EXTRA_USAGE_UNKNOWN' });
});

test('K04-E2 the real Plus shape with quota limits still cannot prove OFF', () => {
    const summary = summarizeQuota({ kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.1 }, monthTotal: {}, monthCode: {} }, extraUsage: null } });
    assert.deepEqual(summary.limits, ['limit5h', 'monthCode', 'monthTotal']);
    assert.equal(summary.extraUsage, 'UNKNOWN');
    assert.throws(() => assertExtraUsageGate(summary), { code: 'KIMI_EXTRA_USAGE_UNKNOWN' });
});

test('K04-E3 cap and balance fields alone are still UNKNOWN', () => {
    const decided = classifyExtraUsage({ extraUsage: { balanceCents: 500, totalCents: 500, monthlyChargeLimitEnabled: false, monthlyChargeLimitCents: 0, monthlyUsedCents: 0, currency: 'CNY' } });
    assert.equal(decided.state, 'UNKNOWN');
    assert.match(decided.reason, /ONLY_CAP_OR_BALANCE/);
});

test('K04-E4 only an explicit boolean decides, and ON is refused as well', () => {
    assert.equal(classifyExtraUsage({ extraUsage: { enabled: false } }).state, 'OFF');
    assert.equal(classifyExtraUsage({ extraUsage: { enabled: true } }).state, 'ON');
    assert.equal(classifyExtraUsage({ quota: { extraUsage: { enabled: false } } }).state, 'OFF');
    assert.doesNotThrow(() => assertExtraUsageGate({ limits: ['limit5h'], extraUsage: 'OFF', extraUsageReason: 'ACCOUNT_REPORTS_DISABLED' }));
    assert.throws(() => assertExtraUsageGate({ limits: [], extraUsage: 'ON', extraUsageReason: 'ACCOUNT_REPORTS_ENABLED' }), { code: 'KIMI_EXTRA_USAGE_ENABLED' });
});

test('K04-E5 a missing payload never passes the gate', () => {
    for (const payload of [undefined, null, {}, { kind: 'error', message: 'not logged in' }]) {
        const summary = summarizeQuota(payload);
        assert.equal(summary.extraUsage, 'UNKNOWN', JSON.stringify(payload));
        assert.throws(() => assertExtraUsageGate(summary), { code: 'KIMI_EXTRA_USAGE_UNKNOWN' });
    }
});