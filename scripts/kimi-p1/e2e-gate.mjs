#!/usr/bin/env node
/**
 * Drives the real planner1 interview to the ten-answer gate.
 * Every answer is synthetic and clearly labelled; this is a throwaway test project, NOT a user
 * specification. The assertions are: ten distinct questions, then the server-enforced waiting state.
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
if (!tokenFile) { console.error('usage: e2e-gate.mjs <tokenFile>'); process.exit(2); }
const dir = mkdtempSync(resolve(tmpdir(), 'dm-kimi-gate-'));
const config = structuredClone(defaults);
config.planner1.provider = 'kimi';
config.planner1.accountRef = 'local-plus';
config.planner1.model = 'kimi-code/kimi-for-coding';
config.kimi = { baseUrl: 'http://127.0.0.1:58631', timeoutMs: 180000, pollMs: 2000, tokenFile, enabled: true, workspace: '/opt/dream-maker-controller/kimi-work/empty' };
config.planner1.maxCallsPerProject = 40;
const parsed = parseConfig(config);
const store = new Store(resolve(dir, 'state.sqlite'));
const laya = new LayaBridge(() => parsed);
const model = new ModelProvider(() => parsed, process.cwd());
// A01: the same admission object guards both layers — this script cannot run without evidence.
const admission = loadKimiAdmission(process.env.DM_KIMI_ENTITLEMENT_FILE);
const runner = new KimiRunner(() => parsed, createKimiTransport({ baseUrl: parsed.kimi.baseUrl, tokenFile }), undefined, undefined, admission);
const instructions = readFileSync(resolve(process.cwd(), 'prompts/planner1.md'), 'utf8');
const interviews = new Interviews(store, model, laya, () => parsed, { runner, workspace: dir, instructions, admission });

const out = { questions: [], answers: 0, gate: null, errors: [], usage: [] };
try {
    const project = interviews.create('Kimi 十题门槛冒烟', '做一个记录每日学习任务的本地小工具', 'live');
    for (let i = 0; i < 11; i++) {
        let p;
        try {
            p = await interviews.next(project.id);
        }
        catch (error) {
            out.errors.push({ step: i, code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? '').slice(0, 120) });
            break;
        }
        const q = p.questions.at(-1);
        if (q && !p.answers.some(a => a.questionId === q.id)) {
            out.questions.push(String(q.topic ?? '').slice(0, 40));
            interviews.answer(project.id, q.id, 'SYNTHETIC_TEST_ANSWER 用于门槛验证，不代表真实需求。', false, store.project(project.id).version);
            out.answers++;
        }
        if (out.answers >= 10) {
            try {
                await interviews.next(project.id);
                out.gate = 'NOT_ENFORCED';
            }
            catch (error) {
                out.gate = error?.code ?? 'UNKNOWN';
            }
            break;
        }
    }
    out.project = { state: store.project(project.id).state, answered: store.project(project.id).answers.filter(a => a.status === 'answered').length, questions: store.project(project.id).questions.length };
    out.usage = store.records(project.id, 'UsageLedger').map(r => [r.data.inputTokens, r.data.outputTokens]);
    out.ok = out.questions.length === 10 && out.gate === 'TEN_ANSWER_GATE';
}
catch (error) {
    out.ok = false;
    out.fatal = String(error?.message ?? error).slice(0, 200);
}
finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 1);
