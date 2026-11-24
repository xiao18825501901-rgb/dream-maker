#!/usr/bin/env node
// A01: write the owner's Extra Usage evidence file.
//
// This tool never contacts the network and never starts a model. It only records what the OWNER
// observed on the official subscription page, together with the account it belongs to and an
// expiry. Without such a record (or with ON/UNKNOWN/expired evidence) every Kimi reasoning entry
// point refuses to send.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
    const i = args.indexOf('--' + name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = name => args.includes('--' + name);

const state = (flag('state') ?? '').toUpperCase();
const accountRef = flag('account-ref') ?? '';
const source = (flag('source') ?? 'user-attested').toUpperCase().replace(/-/g, '_');
const hours = Number(flag('hours') ?? '24');
const out = resolve(flag('out') ?? 'runtime/kimi-entitlement.json');

if (!['OFF', 'ON', 'UNKNOWN'].includes(state)) {
    console.error('usage: node scripts/kimi-p1/attest-extra-usage.mjs --state OFF|ON|UNKNOWN --account-ref kimi:<userId> [--source user-attested|observed] [--hours 24] [--out path] [--i-confirm-owner-attestation]');
    process.exit(2);
}
if (!accountRef.startsWith('kimi:')) {
    console.error('--account-ref must look like kimi:<userId>; the evidence is bound to one account generation.');
    process.exit(2);
}
if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    console.error('--hours must be between 1 and 168.');
    process.exit(2);
}
if (state === 'OFF' && !has('i-confirm-owner-attestation')) {
    console.error('Writing OFF evidence allows membership-quota reasoning. Re-run with --i-confirm-owner-attestation only if you personally verified, on the official subscription page, that Extra Usage is switched OFF.');
    process.exit(3);
}

const at = Date.now();
// Owner waiver: "run anyway, I accept the Extra Usage risk". This is deliberately NOT recorded as OFF —
// the evidence keeps state UNKNOWN and says who waived it and why, so no reader can mistake a waiver for a
// confirmation that the switch is closed. Expiry still applies.
const waive = has('waive-owner-risk');
if (waive && !has('i-confirm-owner-attestation')) {
    console.error('--waive-owner-risk additionally requires --i-confirm-owner-attestation; a waiver is still an owner decision.');
    process.exit(3);
}
const record = {
    schema: 1,
    ...(waive ? { ownerWaived: true } : {}),
    state: waive ? 'UNKNOWN' : state,
    source: source === 'OBSERVED' ? 'OBSERVED' : 'USER_ATTESTED',
    accountRef,
    observedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + hours * 3600_000).toISOString(),
    note: flag('note') ?? (waive ? 'OWNER WAIVED the Extra Usage evidence requirement; this is not a confirmation that the switch is off' : 'owner-written; extraUsage:null upstream is NOT proof of OFF')
};
writeFileSync(out, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ written: out, state: record.state, source: record.source, accountRef: record.accountRef, expiresAt: record.expiresAt }, null, 2));
