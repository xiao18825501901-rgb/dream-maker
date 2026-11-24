// Synthetic project inputs, real demo engine/verifier output. Not a live-agent evaluation.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Store } from '../dist/server/store.js';
import { defaults } from '../dist/server/config.js';
import { Interviews } from '../dist/server/interview.js';
import { LayaBridge } from '../dist/server/laya.js';
import { ModelProvider } from '../dist/server/providers/model.js';
import { Engine } from '../dist/server/engine.js';
const out = resolve(process.env.DM_EVIDENCE_DIR || `evidence/local/ui-${Date.now()}`);
mkdirSync(dirname(out), { recursive: true });
mkdirSync(out);
mkdirSync(resolve(out, 'screenshots'));
mkdirSync(resolve(out, 'runtime'));
const root = resolve('.'), dir = mkdtempSync(resolve(out, 'runtime/dream-ui-')), store = new Store(resolve(dir, 'db.sqlite')), config = structuredClone(defaults), laya = new LayaBridge(() => config), interview = new Interviews(store, new ModelProvider(() => config, root), laya, () => config), engine = new Engine(store, laya, () => config, root, dir, 0);
const settings = { config, keyStatus: { planner1: false, executor: false }, nativeStatus: 'NOT_VERIFIED' };
const fixture = () => { const project = store.project(p.id); return { project, spec: project.specId ? store.spec(project.specId) : null, runs: store.runs(p.id), records: store.records(p.id).slice(-100) }; };
const p = interview.create('我的学习任务板', '我想把每天的学习目标记录下来，添加、完成、删除，重新打开后还在。', 'demo');
const answers = ['先帮助我自己把学习任务安排清楚。', '大三计算机学生，晚间自习时使用。', '本地浏览器优先，不需要云端部署。', '添加任务，完成后打勾，删除不需要的内容。', '只保存任务名称和完成状态。', '刷新后不能丢失已保存任务。', '简洁清楚，常用操作不要隐藏。', '不自动公开、不购买、不发送私人资料。', '先不做账户、多人协作和云同步。', '添加、完成、刷新、删除的完整操作都能通过。'];
try {
    for (const answer of answers) {
        await interview.next(p.id);
        const project = store.project(p.id);
        interview.answer(p.id, project.questions.at(-1).id, answer);
    }
    const gate = fixture();
    await interview.finish(p.id);
    const spec = store.spec(store.project(p.id).specId);
    const specView = fixture();
    interview.approve(p.id, spec.hash);
    const r = engine.create(p.id, spec.hash, true, true);
    await engine.settled(r.id);
    const delivery = fixture();
    const all = { provenance: 'SYNTHETIC_INPUTS_REAL_DEMO_ENGINE_VERIFIER; UI injection only, not browser-server E2E', settings, projects: store.projects(), gate, spec: specView, delivery, events: store.events(p.id) };
    writeFileSync(resolve(out, 'ui-fixtures.json'), JSON.stringify(all, null, 2), { flag: 'wx' });
    writeFileSync(resolve(out, 'demo-verification.json'), JSON.stringify({ schema: 'dream-maker.demo-proof.v1', scope: 'DEMO_TEMPLATE_ONLY', specHash: spec.hash, sourceTreeHash: delivery.runs[0].treeHash, run: delivery.runs[0], evidence: store.records(p.id, 'Evidence'), events: store.events(p.id) }, null, 2), { flag: 'wx' });
    mkdirSync(resolve(out, 'deliveries'));
    writeFileSync(resolve(out, 'deliveries/Demo_Study_Board.zip'), engine.export(r.id), { flag: 'wx' });
    console.log('Created offline UI fixtures and actual demo verifier evidence; source files are from the fixed bundled template.');
}
finally {
    await engine.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
}
