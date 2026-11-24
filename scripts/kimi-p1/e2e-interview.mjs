#!/usr/bin/env node
/**
 * Real planner1 interview smoke test against the loopback Kimi server.
 * It drives the actual Interviews path (not a raw prompt) and asserts the product-shaped result.
 * Uses at most MAX_CALLS model turns so quota consumption stays bounded and explicit.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../../dist/server/store.js';
import { Interviews } from '../../dist/server/interview.js';
import { LayaBridge } from '../../dist/server/laya.js';
import { ModelProvider } from '../../dist/server/providers/model.js';
import { KimiRunner, createKimiTransport } from '../../dist/server/providers/kimi.js';
import { loadKimiAdmission } from '../../dist/server/kimi-admission.js';
import { defaults, parseConfig } from '../../dist/server/config.js';

const tokenFile = process.argv[2];
const MAX_CALLS = Number(process.argv[3] ?? 1);
if (!tokenFile) { console.error('usage: e2e-interview.mjs <tokenFile> [maxCalls]'); process.exit(2); }

const dir = mkdtempSync(resolve(tmpdir(), 'dm-kimi-interview-'));
const config = structuredClone(defaults);
config.planner1.provider = 'kimi';
config.planner1.accountRef = 'local-plus';
config.planner1.model = 'kimi-code/kimi-for-coding';
config.kimi = { baseUrl: 'http://127.0.0.1:58631', timeoutMs: 180000, pollMs: 2000, tokenFile, enabled: true, workspace: '/opt/dream-maker-controller/kimi-work/empty' };
const parsed = parseConfig(config);
const store = new Store(resolve(dir, 'state.sqlite'));
const laya = new LayaBridge(() => parsed);
const model = new ModelProvider(() => parsed, process.cwd());
// A01: the same admission object guards both layers — this script cannot run without evidence.
const admission = loadKimiAdmission(process.env.DM_KIMI_ENTITLEMENT_FILE);
const runner = new KimiRunner(() => parsed, createKimiTransport({ baseUrl: parsed.kimi.baseUrl, tokenFile }), undefined, undefined, admission);
const instructions = readFileSync(resolve(process.cwd(), 'prompts/planner1.md'), 'utf8');
const interviews = new Interviews(store, model, laya, () => parsed, { runner, workspace: dir, instructions, admission });

const summary = { maxCalls: MAX_CALLS, questions: [], errors: [] };
try {
    const project = interviews.create('Kimi 访谈冒烟', '做一个记录每日学习任务的本地小工具', 'live');
    let calls = 0;
    while (calls < MAX_CALLS) {
        try {
            const p = await interviews.next(project.id);
            calls++;
            const q = p.questions.at(-1);
            summary.questions.push({ id: q?.id, topic: q?.topic, text: String(q?.text ?? '').slice(0, 160), source: q?.source, total: p.questions.length });
        }
        catch (error) {
            summary.errors.push({ code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? error).slice(0, 160) });
            break;
        }
    }
    summary.project = { id: project.id, state: store.project(project.id).state, questions: store.project(project.id).questions.length };
    summary.ledger = store.records(project.id, 'UsageLedger').map(r => r.data);
    summary.attempts = store.records(project.id, 'ModelAttempt').map(r => r.data.providerId ?? null);
    summary.failures = store.records(project.id, 'ModelAttemptFailure').map(r => r.data.code ?? null);
    summary.ok = summary.errors.length === 0 && summary.questions.length > 0;
}
catch (error) {
    summary.ok = false;
    summary.fatal = String(error?.message ?? error).slice(0, 200);
}
finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(summary, null, 1));
process.exit(summary.ok ? 0 : 1);