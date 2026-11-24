#!/usr/bin/env node
/**
 * Real end-to-end for the in-repo planner1 runner.
 *
 * Runs KimiRunner (dist/server/providers/kimi.js) against the loopback Kimi server that lives in
 * the dedicated WSL distro, using the management bearer copied to a temporary Windows file that
 * is deleted by the caller. It prints a JSON summary and never prints the bearer.
 *
 * Usage: node scripts/kimi-p1/e2e-planner1.mjs <tokenFile> [baseUrl]
 */
import { KimiRunner, createKimiTransport } from '../../dist/server/providers/kimi.js';
import { loadKimiAdmission } from '../../dist/server/kimi-admission.js';

const tokenFile = process.argv[2];
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:58631';
if (!tokenFile) {
    console.error('usage: e2e-planner1.mjs <tokenFile> [baseUrl]');
    process.exit(2);
}

const config = {
    version: 1,
    kimi: { baseUrl, timeoutMs: 180000, pollMs: 2000, tokenFile, enabled: true },
    planner1: { provider: 'kimi', model: 'kimi-code/kimi-for-coding' }
};

const events = [];
// A01: no run without owner-written Extra Usage OFF evidence for this account.
const admission = loadKimiAdmission(process.env.DM_KIMI_ENTITLEMENT_FILE);
const runner = new KimiRunner(() => config, createKimiTransport({ baseUrl, tokenFile }), undefined, undefined, admission);
const started = Date.now();
let summary;
try {
    const result = await runner.run({
        role: 'planner1',
        workspace: '/opt/dream-maker-controller/kimi-work/empty',
        prompt: 'Reply with exactly this JSON object and nothing else: {"token":"DM_E2E_OK"}',
        model: 'kimi-code/kimi-for-coding',
        specHash: 'e2e',
        runId: 'e2e',
        laya: { role: 'planner1', mode: 'off', adoption: 'off', label: null, reason: 'e2e', latencyMs: 0, inputHash: '', modelRevision: null, confidence: null, cached: false },
        signal: AbortSignal.timeout(180000)
    }, event => events.push(event));
    summary = { ok: true, seconds: Math.round((Date.now() - started) / 1000), text: result.text, sessionId: result.sessionId, usage: result.usage, receipt: result.receipt ?? null, events: events.map(e => e?.method ?? 'unknown') };
}
catch (error) {
    summary = { ok: false, seconds: Math.round((Date.now() - started) / 1000), code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? error).slice(0, 200) };
}
console.log(JSON.stringify(summary, null, 1));
process.exit(summary.ok ? 0 : 1);
