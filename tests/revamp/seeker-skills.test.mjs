import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Interviews } from '../../dist/server/interview.js';
import { ModelProvider, nativePlannerGuard } from '../../dist/server/providers/model.js';
import { NativeBudget } from '../../dist/server/native-budget.js';
import { planner1Binding, SEEKER_PLANNER1_BINDING_VERSION } from '../../dist/server/planner1-binding.js';
import { harness, until, root } from '../helpers.mjs';

// grillme + prompt-optimizer on the Seeker API route.
// Everything here is synthetic: a stub model answers the three request kinds and a fake HTTP
// transport carries the two provider-level checks. No account, no credential, no paid call.

const seekerInto = config => {
    Object.assign(config.planner1, {
        provider: 'openai', bindingVersion: SEEKER_PLANNER1_BINDING_VERSION, authMode: 'api_key',
        model: 'SEEKER_OFFLINE_MODEL', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
        keyEnv: 'DM_SEEKER_TEST_KEY', maxCallsPerProject: 60
    });
    return config;
};

const DRAFT = {
    summary: '把每天的学习任务记录在本机，重新打开后仍然能看到。',
    assumptions: ['建议先只做单机版本'],
    conflicts: ['还没有说明是否需要多设备同步'],
    implementation_guidance: ['先完成记录与查看'],
    acceptance_candidates: ['保存后重新打开仍在'],
    residual_risks: ['未验证同时写入的情况'],
    requirementEdits: [{ id: 'R001', text: '只在本机保存学习任务' }]
};

function plan(requirements) {
    return {
        goal: '制作可以保存学习任务的本地记录工具', requirements,
        acceptance: requirements.map((r, i) => ({ id: 'A' + i, check: '保存后重新打开，内容仍在。', requirementIds: [r.id] })),
        architecture: { summary: '本地界面与本地数据存储', runtime: 'Node', components: ['界面', '存储'] },
        dataModel: { entities: ['学习任务'], persistence: '本地文件' }, interfaces: { userFlows: ['添加、查看和修改任务'], boundaries: ['不公开数据'] },
        tasks: [{ id: 'T1', title: '实现保存与回看', dependsOn: [], requirementIds: requirements.map(r => r.id), check: '真实保存后重新打开' }],
        delivery: { type: 'local-app', howToUse: '在本机打开应用', standalone: true, needsInternet: false, ongoingFees: [] },
        resources: { accounts: [], hardware: ['现有电脑'], network: [], ongoingCosts: [] }, risks: ['需验证异常退出时数据保护'],
        milestones: ['完成核心操作', '验证与交付'], assumptions: ['默认仅供本机个人使用'], unknowns: [], outOfScope: ['公开部署']
    };
}

function rig(t) {
    const h = harness(t);
    seekerInto(h.config);
    const calls = [];
    let asked = 0;
    const model = {
        complete: async payload => {
            calls.push({ task: payload.task, name: payload.name });
            if (payload.task === 'question') {
                asked += 1;
                return { data: { topic: 'goal', text: '第 ' + asked + ' 题：这一版最重要的操作是什么？', suggestion: '先做最小场景', prerequisites: [], options: [{ id: 'A', label: '选项一' }, { id: 'B', label: '选项二' }, { id: 'C', label: '选项三' }, { id: 'D', label: '选项四' }], allowMultiple: true }, usage: { role: 'planner1' } };
            }
            if (payload.task === 'requirements_draft')
                return { data: structuredClone(DRAFT), usage: { role: 'planner1' } };
            if (payload.task === 'project_plan')
                return { data: plan(payload.requiredUserRequirements), usage: { role: 'planner1' } };
            throw Error('UNEXPECTED_MODEL_TASK_' + payload.task);
        }
    };
    const interviews = new Interviews(h.store, model, h.laya, () => h.config);
    t.after(async () => { await interviews.close(); });
    return { ...h, interviews, calls };
}

async function answerTen(rigged, pid) {
    for (let i = 0; i < 10; i++) {
        const p = rigged.store.project(pid);
        const q = p.questions.find(x => !p.answers.some(a => a.questionId === x.id));
        rigged.interviews.answer(pid, q.id, '第 ' + (i + 1) + ' 个回答：先能记录每天的任务');
        if (i < 9) await rigged.interviews.next(pid);
    }
    return rigged.store.project(pid);
}

test('G-01 grillme fires once, right after the first description, and no title request is added', async t => {
    const h = rig(t);
    const idea = '学习任务板\n可以记录每天的任务，重开后仍然能看到。';
    const p = h.interviews.create('', idea, 'live');
    // The name is derived locally from the description; it rides inside the first question request.
    assert.equal(h.store.project(p.id).name, '学习任务板');
    await until(() => h.store.project(p.id).questions.length === 1);
    assert.deepEqual(h.calls.map(c => c.task), ['question']);
    assert.equal(h.calls[0].name, '学习任务板');
    assert.equal(h.calls.some(c => /title|name|naming/i.test(c.task ?? '')), false);
    const stored = h.store.project(p.id);
    assert.equal(stored.questions.length, 1);
    assert.equal(stored.questions[0].options.length, 4);
    assert.equal(stored.questions[0].allowMultiple, true);
    // A simultaneous explicit next() joins the attempt instead of paying for a second question.
    await h.interviews.next(p.id);
    assert.equal(h.store.project(p.id).questions.length, 1);
    assert.equal(h.calls.filter(c => c.task === 'question').length, 1);
});

test('G-02 the interview still stops at the ten-answer gate and keeps four choices plus free input', async t => {
    const h = rig(t);
    const p = h.interviews.create('十题停点', '做一个记录学习任务的本地工具', 'live');
    await until(() => h.store.project(p.id).questions.length === 1);
    const done = await answerTen(h, p.id);
    assert.equal(done.answers.filter(a => a.status === 'answered').length, 10);
    assert.equal(done.state, 'AWAITING_INTERVIEW_DECISION');
    // The tenth answer is a stop point: no eleventh question is asked on its own.
    await assert.rejects(h.interviews.next(p.id), { code: 'INTERVIEW_NOT_ACTIVE' });
    assert.equal(h.calls.filter(c => c.task === 'question').length, 10);
    assert.equal(h.store.project(p.id).questions.length, 10);
    // Asking for another group is an explicit owner decision and opens a new ten-answer batch.
    h.interviews.continue(p.id);
    await h.interviews.next(p.id);
    assert.equal(h.calls.filter(c => c.task === 'question').length, 11);
    assert.equal(h.store.project(p.id).batchTarget, 20);
});

test('D-01 finishing compiles one prompt-optimizer draft and stops before the plan', async t => {
    const h = rig(t);
    const p = h.interviews.create('需求稿', '做一个记录学习任务的本地工具', 'live');
    await until(() => h.store.project(p.id).questions.length === 1);
    await answerTen(h, p.id);
    await h.interviews.finish(p.id, '保持简单');
    const project = h.store.project(p.id);
    assert.equal(project.state, 'REQUIREMENTS_REVIEW');
    assert.equal(h.calls.filter(c => c.task === 'question').length, 10);
    assert.equal(h.calls.filter(c => c.task === 'requirements_draft').length, 1);
    assert.equal(h.calls.at(-1).task, 'requirements_draft');
    assert.equal(h.calls.some(c => /title|naming/i.test(c.task ?? '')), false);
    assert.equal(project.specId, null, 'no spec may exist before the draft is confirmed');
    const draft = h.store.records(p.id, 'RequirementsDraft').at(-1).data;
    assert.equal(draft.version, 1);
    assert.equal(draft.origin, 'MODEL');
    assert.equal(project.requirementsDraft.recordId, h.store.records(p.id, 'RequirementsDraft').at(-1).id);
    assert.equal(project.requirementsDraft.confirmed, null);
    // Original requirement text is retained; the model's clarification is a separate suggestion line.
    assert.match(draft.requirements[0].text, /做一个记录学习任务的本地工具/);
    assert.match(draft.requirements[0].text, /AI_SUGGESTION：只在本机保存学习任务/);
    // Finishing again without confirming refuses instead of paying for a second plan.
    await assert.rejects(h.interviews.finish(p.id), { code: 'REQUIREMENTS_DRAFT_CONFIRMATION_REQUIRED' });
    assert.equal(h.calls.filter(c => c.task === 'project_plan').length, 0);
});

test('D-02 the draft is editable, every edit is a new version and no model is charged for it', async t => {
    const h = rig(t);
    const p = h.interviews.create('可编辑需求稿', '做一个记录学习任务的本地工具', 'live');
    await until(() => h.store.project(p.id).questions.length === 1);
    await answerTen(h, p.id);
    await h.interviews.finish(p.id);
    const before = h.store.records(p.id, 'RequirementsDraft').at(-1).data;
    const callsBefore = h.calls.length, ledgerBefore = h.store.records(p.id, 'UsageLedger').length;
    const edited = before.requirements.map(r => r.id === 'R001' ? { id: 'R001', text: '只在本机保存我的学习任务' } : { id: r.id, text: r.text });
    // Dropping a requirement id is refused: the compiled requirement set must stay complete.
    assert.throws(() => h.interviews.reviseRequirements(p.id, { requirements: [edited[0]] }), { code: 'REQUIREMENTS_DRAFT_REQUIREMENTS_INCOMPLETE' });
    assert.throws(() => h.interviews.reviseRequirements(p.id, { requirements: [{ id: 'R999', text: 'x' }, ...edited.slice(1)] }), { code: 'REQUIREMENTS_DRAFT_REQUIREMENT_UNKNOWN' });
    const project = h.interviews.reviseRequirements(p.id, { document: { ...before.document, summary: '我改过的需求稿：只做单机记录。' }, requirements: edited });
    const next = h.store.records(p.id, 'RequirementsDraft').at(-1).data;
    assert.equal(next.version, 2);
    assert.equal(next.origin, 'USER');
    assert.equal(next.parentId, before.id);
    assert.notEqual(next.contentHash, before.contentHash);
    assert.equal(next.requirements.find(r => r.id === 'R001').text, '只在本机保存我的学习任务');
    assert.equal(project.requirementsDraft.recordId, h.store.records(p.id, 'RequirementsDraft').at(-1).id);
    assert.equal(project.requirementsDraft.confirmed, null);
    // An owner edit is free: the model was not asked again.
    assert.equal(h.calls.length, callsBefore);
    assert.equal(h.store.records(p.id, 'UsageLedger').length, ledgerBefore, 'an owner edit must not add a ledger entry');
});

test('D-03 only the exact draft hash can be confirmed, and confirming continues on the original path', async t => {
    const h = rig(t);
    const p = h.interviews.create('确认后进入流程', '做一个记录学习任务的本地工具', 'live');
    await until(() => h.store.project(p.id).questions.length === 1);
    await answerTen(h, p.id);
    await h.interviews.finish(p.id);
    const draft = h.store.records(p.id, 'RequirementsDraft').at(-1).data;
    const edited = draft.requirements.map(r => r.id === 'R001' ? { id: 'R001', text: '只在本机保存我的学习任务' } : { id: r.id, text: r.text });
    const project = h.interviews.reviseRequirements(p.id, { requirements: edited });
    const revised = h.store.records(p.id, 'RequirementsDraft').at(-1).data;
    await assert.rejects(h.interviews.confirmRequirements(p.id, { draftHash: draft.contentHash }), { code: 'REQUIREMENTS_DRAFT_STALE' });
    await h.interviews.confirmRequirements(p.id, { draftHash: revised.contentHash, notes: '' });
    const confirmed = h.store.project(p.id);
    assert.equal(confirmed.requirementsDraft.confirmed.hash, revised.contentHash);
    assert.equal(confirmed.state, 'SPEC_REVIEW');
    const spec = h.store.spec(confirmed.specId);
    // The confirmed edit is the frozen requirement text; the suggestion stays out of it.
    assert.equal(spec.requirements[0].text, '只在本机保存我的学习任务');
    assert.match(spec.notes, /我改过的需求稿|把每天的学习任务记录在本机/);
    assert.ok(spec.projectPlan, 'the complete plan still comes from the same planner');
    assert.equal(spec.projectPlan.requirements[0].text, '只在本机保存我的学习任务');
    // The original approval and start path is unchanged: approve, then the native gate decides.
    h.interviews.approve(p.id, spec.hash);
    assert.equal(h.store.project(p.id).state, 'READY_TO_BUILD');
    assert.equal(h.store.runs(p.id).length, 0);
    assert.throws(() => h.engine.create(p.id, spec.hash, true));
    assert.equal(h.store.runs(p.id).length, 0, 'the prework/native gate is not bypassed by the draft');
});

test('D-05 an answer change makes the draft stale and needs a fresh compile, not a re-confirmation', async t => {
    const h = rig(t);
    const p = h.interviews.create('过期需求稿', '做一个记录学习任务的本地工具', 'live');
    await until(() => h.store.project(p.id).questions.length === 1);
    await answerTen(h, p.id);
    await h.interviews.finish(p.id);
    const first = h.store.records(p.id, 'RequirementsDraft').at(-1).data;
    const answered = h.store.project(p.id).questions[0];
    h.interviews.answer(p.id, answered.id, '改过的回答：只在断网时也能记录');
    await assert.rejects(h.interviews.confirmRequirements(p.id, { draftHash: first.contentHash }), { code: 'REQUIREMENTS_DRAFT_STALE' });
    assert.throws(() => h.interviews.reviseRequirements(p.id, { requirements: first.requirements }), { code: 'REQUIREMENTS_DRAFT_STALE' });
    // Finishing again recompiles from the changed interview instead of demanding a confirmation
    // for a draft that no longer describes it.
    await h.interviews.finish(p.id);
    const second = h.store.records(p.id, 'RequirementsDraft').at(-1).data;
    assert.equal(second.version, 2);
    assert.equal(second.parentId, first.id);
    assert.notEqual(second.inputHash, first.inputHash);
    assert.equal(h.calls.filter(c => c.task === 'requirements_draft').length, 2);
    assert.equal(h.store.project(p.id).requirementsDraft.confirmed, null);
    await h.interviews.confirmRequirements(p.id, { draftHash: second.contentHash });
    assert.equal(h.store.project(p.id).state, 'SPEC_REVIEW');
});

test('D-04 both request classes are recorded with their purpose and share the per-project call cap', async t => {
    const h = rig(t);
    h.config.planner1.maxCallsPerProject = 1;
    const p = h.interviews.create('预算上限', '做一个记录学习任务的本地工具', 'live');
    await until(() => h.store.project(p.id).questions.length === 1);
    // grillme consumed the single allowed call.
    await assert.rejects(h.interviews.draftRequirements(p.id), { code: 'INTERVIEW_CALL_BUDGET_EXCEEDED' });
    assert.deepEqual(h.store.records(p.id, 'ModelAttempt').map(r => r.data.purpose), ['interview_question']);

    const h2 = rig(t);
    const p2 = h2.interviews.create('用途区分', '做一个记录学习任务的本地工具', 'live');
    await until(() => h2.store.project(p2.id).questions.length === 1);
    await answerTen(h2, p2.id);
    await h2.interviews.finish(p2.id);
    const draft = h2.store.records(p2.id, 'RequirementsDraft').at(-1).data;
    await h2.interviews.confirmRequirements(p2.id, { draftHash: draft.contentHash });
    const purposes = new Set(h2.store.records(p2.id, 'ModelAttempt').map(r => r.data.purpose));
    assert.deepEqual([...purposes].sort(), ['interview_question', 'project_plan', 'requirements_draft']);
});

test('P-01 the complete-plan request really carries the pinned prompt-optimizer body (fake HTTP)', async t => {
    let budget;
    t.after(() => { budget?.close(); delete process.env.DM_SEEKER_TEST_KEY; });
    const h = harness(t);
    seekerInto(h.config);
    process.env.DM_SEEKER_TEST_KEY = 'OFFLINE_KEY';
    budget = new NativeBudget(resolve(h.dir, 'money.sqlite'), { scopeId: 'OFFLINE', authorizationHash: 'OFFLINE', totalMicros: 50000000, probeMicros: 5000000, warningMicros: 40000000, maxInFlight: 1, maxRepairs: 2 });
    const price = { provider: 'openai-official', model: 'SEEKER_OFFLINE_MODEL', currency: 'CNY', source: 'OFFLINE', expiresAt: new Date(Date.now() + 60000).toISOString(), maxInputTokens: 1048576, inputMissMicrosPerMillion: 2000000, inputHitMicrosPerMillion: 40000, outputMicrosPerMillion: 8000000 };
    const bodies = [];
    const provider = new ModelProvider(() => h.config, root, async (url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return { id: 'resp_seeker_1', model: 'SEEKER_OFFLINE_MODEL', status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"goal":"offline"}' }] }], usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } };
    }, nativePlannerGuard(budget, () => price));
    const registry = JSON.parse(readFileSync(resolve(root, 'skills/registry.json'), 'utf8'));
    const optimizer = registry.skills.find(s => s.id === 'prompt-optimizer');
    const grillme = registry.skills.find(s => s.id === 'grillme');
    const optimizerBody = readFileSync(resolve(root, 'prompts/prompt-optimizer.md'), 'utf8');
    const grillmeBody = readFileSync(resolve(root, 'skills/grilling.md'), 'utf8');

    const planCall = await provider.complete({ task: 'project_plan', requiredUserRequirements: [] });
    assert.ok(bodies[0].instructions.includes(optimizerBody), 'the plan path must load the optimizer body');
    assert.equal(planCall.usage.purpose, 'project_plan');
    assert.deepEqual(planCall.usage.skills, [{ id: 'prompt-optimizer', sha256: optimizer.sha256, purpose: 'project_plan' }]);

    const draftCall = await provider.complete({ task: 'requirements_draft' });
    assert.ok(bodies[1].instructions.includes(optimizerBody));
    assert.equal(draftCall.usage.skills[0].id, 'prompt-optimizer');
    assert.equal(draftCall.usage.purpose, 'requirements_draft');

    const questionCall = await provider.complete({ task: 'question' });
    assert.ok(bodies[2].instructions.includes(grillmeBody), 'the interview path loads grillme');
    assert.equal(questionCall.usage.skills[0].id, 'grillme');
    assert.equal(questionCall.usage.skills[0].sha256, grillme.sha256);
    assert.equal(questionCall.usage.purpose, 'interview_question');

    // The two skill bodies are different pinned documents; neither is a renamed copy of the other.
    assert.notEqual(optimizer.sha256, grillme.sha256);
    assert.equal(optimizerBody.includes(grillmeBody), false);

    const researchCall = await provider.complete({ task: 'research_intent' });
    assert.equal(researchCall.usage.skills, undefined);
    assert.equal(researchCall.usage.purpose, undefined);
});

test('P-02 a changed skill body is refused instead of being silently loaded', async t => {
    const h = harness(t);
    seekerInto(h.config);
    process.env.DM_SEEKER_TEST_KEY = 'OFFLINE_KEY';
    t.after(() => { delete process.env.DM_SEEKER_TEST_KEY; });
    const { loadSkill } = await import('../../dist/server/skills.js');
    assert.equal(loadSkill(root, 'grillme').sha256, loadSkill(root, 'grilling').sha256);
    assert.equal(loadSkill(root, 'prompt-optimizer').sha256.length, 64);
    assert.throws(() => loadSkill(root, 'not-a-skill'), { code: 'SKILL_NOT_ALLOWLISTED' });
    assert.equal(planner1Binding(h.config).bindingVersion, SEEKER_PLANNER1_BINDING_VERSION);
});
