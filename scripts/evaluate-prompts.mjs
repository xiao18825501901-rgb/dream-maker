// Mechanical contract evaluation only, never a measured LLM-quality result.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../dist/server/store.js';
import { defaults } from '../dist/server/config.js';
import { ModelProvider } from '../dist/server/providers/model.js';
import { Interviews } from '../dist/server/interview.js';
import { LayaBridge } from '../dist/server/laya.js';
const source = JSON.parse(readFileSync('eval/prompt-cases.json', 'utf8')), store = new Store(':memory:'), config = structuredClone(defaults), interview = new Interviews(store, new ModelProvider(() => config, process.cwd()), new LayaBridge(() => config), () => config), results = [];
try {
    for (const c of source.cases) {
        try {
            const p = interview.create(c.id, c.idea, 'demo');
            await interview.next(p.id);
            const q = store.project(p.id).questions[0];
            interview.answer(p.id, q.id, c.answer);
            await interview.finish(p.id);
            const s = store.spec(store.project(p.id).specId);
            assert.equal(s.requirements[0].text, c.idea);
            assert.match(s.requirements[1].text, new RegExp(c.answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            assert.ok(s.masterPrompt.includes(c.idea) && s.masterPrompt.includes(c.answer));
            assert.ok(s.constraints.some(x => x.includes('凭据')));
            assert.ok(s.assumptions.some(x => x.includes('提前结束')));
            assert.ok(s.requirements[1].sourceAnswerIds.length === 1);
            results.push({ caseId: c.id, split: c.split, result: 'PASS', scope: 'SOURCE_RETENTION_AND_BOUNDARIES' });
        }
        catch (e) {
            results.push({ caseId: c.id, split: c.split, result: 'FAIL', reason: e.message });
        }
    }
}
finally {
    store.close();
}
const report = { schema: 'dream-maker.prompt-eval.v1', recordedAt: new Date().toISOString(), provenance: source.provenance, implementation: 'deterministic compiler with SOURCE_ADAPTED skills', modelQualityEvaluation: 'NOT_RUN', semanticConflictDetection: 'NOT_PROVEN_BY_STATIC_TEST', cloudCalls: 0, cases: results };
const output = resolve(process.env.DM_PROMPT_EVIDENCE || `evidence/local/prompt-${Date.now()}.json`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (results.some(x => x.result === 'FAIL'))
    process.exitCode = 1;
