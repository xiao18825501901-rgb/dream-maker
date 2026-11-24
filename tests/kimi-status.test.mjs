import test from 'node:test';
import assert from 'node:assert/strict';
import { kimiStatus } from '../dist/server/kimi-status.js';
import { createAuthFailureLog } from '../dist/server/kimi-auth-state.js';

// Read-only status surface. Synthetic inputs only; the point is what is NOT in the output.

const T0 = Date.parse('2026-10-18T00:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const OFF = () => ({ allowsSend: true, reason: 'OK', state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:u1', observedAt: iso(T0 - 60_000), expiresAt: iso(T0 + 3_600_000) });
const UNKNOWN = () => ({ ...OFF(), allowsSend: false, reason: 'KIMI_EXTRA_USAGE_UNKNOWN', state: 'UNKNOWN' });
const token = { accessToken: 'SECRET-ACCESS', refreshToken: 'SECRET-REFRESH', expiresAt: T0 + 1000, expiresIn: 3600, scope: 'kimi-code', tokenType: 'Bearer' };
const creds = (state, barrier = 'READY') => ({ barrier: () => barrier, current: () => state });

test('C05-S1 a restored credential never leaks the token through the status surface', () => {
    const status = kimiStatus({ admission: { snapshot: OFF }, credentials: creds({ status: 'OK', token, generation: 3, messageId: 'm3' }), now: T0 });
    const text = JSON.stringify(status);
    assert.equal(text.includes('SECRET-ACCESS'), false);
    assert.equal(text.includes('SECRET-REFRESH'), false);
    assert.equal(text.includes('accessToken'), false);
    assert.equal(text.includes('refreshToken'), false);
    assert.equal(status.credentials.expiresAt, token.expiresAt);
    assert.equal(status.inferenceAllowed, true);
});

test('C05-S2 an unproven Extra Usage blocks inference even with a perfect credential', () => {
    const status = kimiStatus({ admission: { snapshot: UNKNOWN }, credentials: creds({ status: 'OK', token, generation: 1, messageId: 'm1' }), now: T0 });
    assert.equal(status.inferenceAllowed, false);
    assert.equal(status.note, 'KIMI_EXTRA_USAGE_UNKNOWN');
});

test('C05-S3 a corrupt or revoked credential blocks inference and reports a fixed reason', () => {
    const corrupt = kimiStatus({ admission: { snapshot: OFF }, credentials: creds({ status: 'CORRUPT', reason: 'DECRYPT_FAILED' }), now: T0 });
    assert.equal(corrupt.inferenceAllowed, false);
    assert.equal(corrupt.credentials.reason, 'DECRYPT_FAILED');
    assert.equal(corrupt.note, 'KIMI_STORED_STATE_CORRUPT');

    const revoked = kimiStatus({ admission: { snapshot: OFF }, credentials: creds({ status: 'REVOKED', generation: 2, messageId: 'm2' }), now: T0 });
    assert.equal(revoked.inferenceAllowed, false);
    assert.equal(revoked.note, 'KIMI_CREDENTIAL_REVOKED');
});

test('C05-S4 a credential that has not been restored reports the barrier, not "logged out"', () => {
    const status = kimiStatus({ admission: { snapshot: OFF }, credentials: creds({ status: 'OK', token, generation: 1, messageId: 'm1' }, 'PENDING'), now: T0 });
    assert.equal(status.credentials.barrier, 'PENDING');
    assert.equal(status.note, 'KIMI_RESTORE_NOT_READY');
    assert.equal(status.inferenceAllowed, false);
});

test('C05-S5 missing authorities are reported as such, never as allowed', () => {
    assert.equal(kimiStatus({ now: T0 }).inferenceAllowed, false);
    assert.equal(kimiStatus({ now: T0 }).note, 'NO_ADMISSION_AUTHORITY');
    assert.equal(kimiStatus({ admission: { snapshot: OFF }, now: T0 }).note, 'NO_CREDENTIAL_AUTHORITY');
    assert.equal(kimiStatus({ admission: { snapshot: OFF }, credentials: creds({ status: 'MISSING' }), now: T0 }).note, 'KIMI_CREDENTIALS_MISSING');
});
// C02: the durable record can still read OK right after the server refused us. A proven L3 rejection
// must show up as such; anything less certain must not become a verdict.
test('C02-S10 a runtime L3 rejection outranks an OK record', () => {
    const base = { admission: { snapshot: () => ({ state: 'OFF', allowsSend: true, reason: 'OK' }) }, credentials: { barrier: () => 'READY', current: () => ({ status: 'OK', token: { accessToken: 'a', refreshToken: 'r', expiresAt: 1_700_000_000_000, expiresIn: 60, scope: 's', tokenType: 'Bearer' }, generation: 3, messageId: 'm' }) } };
    const clean = kimiStatus({ ...base, now: 1 });
    assert.equal(clean.note, 'OK');
    assert.equal(clean.lastAuthFailure, null);
    const rejected = kimiStatus({ ...base, now: 1, lastAuthFailure: { class: 'REAUTH_REQUIRED', layer: 'L3_OAUTH', code: 'KIMI_REAUTH_REQUIRED', atMs: 2 } });
    assert.equal(rejected.note, 'KIMI_GRANT_REJECTED_AT_RUNTIME');
    assert.equal(rejected.credentials.state, 'OK', 'the record itself is untouched');
    const unproven = kimiStatus({ ...base, now: 1, lastAuthFailure: { class: 'OAUTH_FLOW_FAILED_UNKNOWN', layer: 'L4_TURN', code: 'KIMI_AUTH_UNKNOWN', atMs: 2 } });
    assert.equal(unproven.note, 'OK', 'an unproven failure never rewrites the verdict');
});
// C02: a stale rejection must be retired once a turn succeeds, otherwise re-authorising changes
// nothing on screen and the product keeps demanding a login that already happened.
test('C02-S12 the failure record is retired by a successful turn', () => {
    const log = createAuthFailureLog(() => 7);
    log.record({ code: 'KIMI_REAUTH_REQUIRED', message: '[L3_OAUTH] x' });
    assert.deepEqual(log.last(), { class: 'REAUTH_REQUIRED', layer: 'L3_OAUTH', code: 'KIMI_REAUTH_REQUIRED', atMs: 7 });
    log.record({ code: 'KIMI_TOOL_EVENT_VIOLATION', message: 'not auth' });
    assert.notEqual(log.last(), null, 'a non-auth error neither creates nor clears the record');
    log.record(null);
    assert.equal(log.last(), null, 'a successful turn retires the record');
    log.record({ code: 'KIMI_AUTH_COMMIT_UNCERTAIN', message: '[L3_OAUTH] y' });
    assert.equal(log.last().class, 'AUTH_COMMIT_UNCERTAIN');
    log.clear();
    assert.equal(log.last(), null);
});
test('C02-S13 a failure older than the current record is superseded by that login', () => {
    const token = { accessToken: 'a', refreshToken: 'r', expiresAt: 1_700_000_000_000, expiresIn: 60, scope: 's', tokenType: 'Bearer' };
    const admission = { snapshot: () => ({ state: 'OFF', allowsSend: true, reason: 'OK' }) };
    const recordAt = (savedAtMs) => ({ barrier: () => 'READY', current: () => ({ status: 'OK', token, generation: 4, messageId: 'm4', savedAtMs }) });
    const failure = { class: 'REAUTH_REQUIRED', layer: 'L3_OAUTH', code: 'KIMI_REAUTH_REQUIRED', atMs: 1_000 };
    // The record was written AFTER the failure: the owner has re-authorised, so the note is clean.
    const after = kimiStatus({ admission, credentials: recordAt(2_000), lastAuthFailure: failure, now: 1 });
    assert.equal(after.note, 'OK');
    assert.equal(after.lastAuthFailure, null, 'the superseded failure is not reported');
    // The record predates the failure: the rejection is the newer fact.
    const before = kimiStatus({ admission, credentials: recordAt(500), lastAuthFailure: failure, now: 1 });
    assert.equal(before.note, 'KIMI_GRANT_REJECTED_AT_RUNTIME');
    // No timestamp on either side: keep the conservative reading.
    const unknown = kimiStatus({ admission, credentials: recordAt(null), lastAuthFailure: failure, now: 1 });
    assert.equal(unknown.note, 'KIMI_GRANT_REJECTED_AT_RUNTIME');
});
