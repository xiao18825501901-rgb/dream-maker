#!/usr/bin/env node
/**
 * Real flow smoke: ten Kimi questions, ten synthetic answers, then a real spec summary call.
 * The answers are synthetic and labelled; this is a throwaway project, not a user specification.
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
if (!tokenFile) { console.error('usage: e2e-flow.mjs <tokenFile>'); process.exit(2); }
const dir = mkdtempSync(resolve(tmpdir(), 'dm-kimi-flow-'));
const config = structuredClone(defaults);
config.planner1.provider = 'kimi';
config.planner1.accountRef = 'local-plus';
config.planner1.model = 'kimi-code/kimi-for-coding';
config.planner1.maxCallsPerProject = 40;
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

const out = { topics: [], errors: [], spec: null, usageTotals: null, ok: false };
try {
    const project = interviews.create('Kimi 真实流程冒烟', '做一个记录每日学习任务的本地小工具', 'live');
    for (let i = 0; i < 12; i++) {
        const p = await interviews.next(project.id);
        const q = p.questions.at(-1);
        if (!q || p.answers.some(a => a.questionId === q.id)) continue;
        out.topics.push(String(q.topic ?? '').slice(0, 30));
        interviews.answer(project.id, q.id, 'SYNTHETIC_TEST_ANSWER：用于流程验证，不代表真实需求。', false, store.project(project.id).version);
        if (out.topics.length >= 10) break;
    }
    const finished = await interviews.finish(project.id, '', true);
    const spec = store.spec(finished.specId);
    out.spec = {
        id: spec.id,
        hash: spec.hash,
        revision: spec.revision,
        requirements: spec.requirements.length,
        firstRequirement: String(spec.requirements[0]?.text ?? '').slice(0, 120),
        origins: [...new Set(spec.requirements.map(r => r.origin))],
        assumptions: spec.assumptions.length,
        conflicts: spec.conflicts.length,
        acceptanceItems: (spec.acceptanceItems ?? []).length,
        projectState: store.project(project.id).state,
        stale: spec.stale
    };
    const usage = store.records(project.id, 'UsageLedger').map(r => r.data);
    out.usageTotals = { calls: usage.length, input: usage.reduce((a, u) => a + (u.inputTokens ?? 0), 0), output: usage.reduce((a, u) => a + (u.outputTokens ?? 0), 0), costUsd: usage.every(u => u.costUsd === null) ? 'ALL_NULL_AS_UNKNOWN' : 'MIXED' };
    out.ok = out.topics.length === 10 && out.spec.requirements > 0 && out.spec.projectState === 'SPEC_REVIEW';
}
catch (error) {
    out.errors.push({ code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? error).slice(0, 200) });
}
finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 1);
