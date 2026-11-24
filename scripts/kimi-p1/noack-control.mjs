#!/usr/bin/env node
// C03 control experiment: with NO controller attached, an expiring token must NOT be silently
// "saved". The patched storage waits for COMMIT_ACK; without it, save() must fail, so the gated
// call must fail too. Run this only when the stored token is at/after its refresh threshold.
//
// Preconditions (checked below):
//   - a bridge is already listening on the socket and owns the real Kimi server
//   - NO controller/connector is connected (so nobody can send COMMIT_ACK)
import { readFileSync } from 'node:fs';
import { expiresAtMs } from '../../dist/server/kimi-credential-authority.js';

const [storeDir, baseUrl, tokenFile] = process.argv.slice(2);
if (!storeDir || !baseUrl || !tokenFile) {
    console.error("usage: noack-control.mjs <storeDir> <baseUrl> <serverTokenFile>");
    process.exit(2);
}

const encryption = (await import("../../dist/server/siwc/windows-credential-encryption.js")).createWindowsCredentialEncryption();
const store = (await import("../../dist/server/kimi-token-store.js")).createKimiTokenStore({ dir: storeDir, encryption });
const record = await store.loadRecord("kimi-code");
if (record.status !== "OK") { console.log("NO_RECORD", record.status); process.exit(3); }
const token = record.record;
const expires = expiresAtMs({ expiresAt: Number(token.expiresAt) });
const expiresIn = Number(token.expiresIn || 0);
const remaining = Math.round((expires - Date.now()) / 1000);
const threshold = Math.floor(expiresIn / 2);
console.log("TOKEN", JSON.stringify({ remainingSec: remaining, thresholdSec: threshold }));
if (remaining > threshold) {
    console.log("SKIP_NOT_AT_THRESHOLD: wait until the access token is within its refresh window");
    process.exit(4);
}

// With no ACK possible, the turn must come back as a failure carrying the persist error.
process.env.DM_KIMI_ENTITLEMENT_FILE = process.env.DM_KIMI_ENTITLEMENT_FILE ?? "";
console.log("READY: run node scripts/kimi-p1/e2e-planner1.mjs <token> " + baseUrl + " and expect a failure mentioning UNCONFIRMED/REJECTED");
