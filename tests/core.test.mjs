import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harness, ready, sleep, until, root, bindKimi } from './helpers.mjs';
import { validatePlan, validateReview } from '../dist/server/engine.js';
import { files, put, get, treeHash, zip } from '../dist/server/workspace.js';
import { DomainError, hash, within, childEnv, redact, publicApiUrl, loopbackUrl } from '../dist/server/security.js';
import { parseConfig, defaults } from '../dist/server/config.js';
import { nativeReadiness } from '../dist/server/providers/dsh.js';
async function parkedRun(t) {
    const h = harness(t);
    const { p, s } = await ready(h);
    const created = h.engine.create(p.id, s.hash, true);
    h.engine.pause(created.id);
    await h.engine.settled(created.id);
    return { h, p, s, run: h.store.run(created.id) };
}
test('ten distinct confirmed answers stop before question eleven', async (t) => { const h = harness(t), p = h.interviews.create('十题', '测试十题状态', 'demo'); for (let i = 0; i < 10; i++) {
    await h.interviews.next(p.id);
    const q = h.store.project(p.id).questions.at(-1);
    h.interviews.answer(p.id, q.id, '真实回答 ' + i);
} const pp = h.store.project(p.id); assert.equal(pp.state, 'AWAITING_INTERVIEW_DECISION'); assert.equal(pp.questions.length, 10); await assert.rejects(h.interviews.next(p.id), { code: 'INTERVIEW_NOT_ACTIVE' }); h.interviews.continue(p.id); await h.interviews.next(p.id); assert.equal(h.store.project(p.id).questions.length, 11); assert.equal(h.store.project(p.id).batchTarget, 20); });
test('skipped answers do not count; editing keeps revision and invalidates frozen spec', async (t) => { const h = harness(t), p = h.interviews.create('修订', '灵感', 'demo'); await h.interviews.next(p.id); let q = h.store.project(p.id).questions[0]; h.interviews.answer(p.id, q.id, '', true); await h.interviews.next(p.id); let q2 = h.store.project(p.id).questions[1]; h.interviews.answer(p.id, q2.id, '原回答'); await h.interviews.finish(p.id); let spec = h.store.spec(h.store.project(p.id).specId); assert.equal(spec.requirements.length, 2); h.interviews.approve(p.id, spec.hash); h.interviews.answer(p.id, q2.id, '修改后的回答'); const pp = h.store.project(p.id); assert.equal(pp.answerHistory.length, 1); assert.equal(pp.answers.find(a => a.questionId === q2.id).revision, 2); assert.equal(pp.specId, null); assert.equal(h.store.spec(spec.id).stale, true); assert.equal(h.store.approved(p.id, spec.hash, 'SPEC'), false); });
test('unanswered question is reused instead of regenerated', async (t) => { const h = harness(t), p = h.interviews.create('复用', '灵感', 'demo'); await h.interviews.next(p.id); await h.interviews.next(p.id); assert.equal(h.store.project(p.id).questions.length, 1); });
test('early interview stop preserves uncertainty and raw source', async (t) => { const h = harness(t), p = h.interviews.create('少题', '<script>alert(1)</script> 保留原文', 'demo'); await h.interviews.finish(p.id); const s = h.store.spec(h.store.project(p.id).specId); assert.equal(s.requirements[0].text, p.idea); assert.match(s.assumptions.join(' '), /提前结束/); assert.match(s.masterPrompt, /<script>alert\(1\)<\/script>/); assert.equal(h.store.project(p.id).state, 'SPEC_REVIEW'); assert.equal(h.store.runs().length, 0); });
test('stale answer version is rejected without mutation', async (t) => { const h = harness(t), p = h.interviews.create('版本', '灵感', 'demo'); await h.interviews.next(p.id); const pp = h.store.project(p.id); assert.throws(() => h.interviews.answer(p.id, pp.questions[0].id, 'x', false, 1), { code: 'STALE_PROJECT_VERSION' }); assert.equal(h.store.project(p.id).answers.length, 0); });
test('idempotency replays response, rejects key substitution and uncertain retries', async (t) => { const h = harness(t); let calls = 0; const f = async () => ({ n: ++calls }); assert.deepEqual(await h.store.once('k', { a: 1 }, f), { n: 1 }); assert.deepEqual(await h.store.once('k', { a: 1 }, f), { n: 1 }); await assert.rejects(h.store.once('k', { a: 2 }, f), { code: 'IDEMPOTENCY_KEY_REUSED' }); await assert.rejects(h.store.once('fail', {}, async () => { throw new Error('unknown effect'); })); await assert.rejects(h.store.once('fail', {}, f), { code: 'REQUEST_RESULT_UNCERTAIN' }); assert.equal(calls, 1); });
test('SQLite transaction rollback preserves state', async (t) => { const h = harness(t); assert.throws(() => h.store.tx(() => { h.store.event(null, null, 'rollback', {}); throw new Error('rollback'); })); assert.equal(h.store.db.prepare('select count(*) n from events').get().n, 0); });
test('spec hash and explicit build consent are both enforced', async (t) => { const h = harness(t), { p, s } = await ready(h); assert.throws(() => h.engine.create(p.id, s.hash, false), { code: 'BUILD_APPROVAL_REQUIRED' }); assert.throws(() => h.engine.create(p.id, 'bad-hash', true), { code: 'SPEC_APPROVAL_STALE' }); assert.equal(h.store.runs().length, 0); });
test('a retired planner1 cannot create a Live project at all', async (t) => { const h = harness(t); assert.throws(() => h.interviews.create('retired', 'idea', 'live'), { code: 'PLANNER1_PROVIDER_RETIRED' }); assert.equal(h.store.projects().length, 0); });
test('live agent execution fails closed before workspace or dispatch', async (t) => { const h = harness(t); bindKimi(h.config); const { p, s } = await ready(h, 'live'); assert.throws(() => h.engine.create(p.id, s.hash, true), { code: 'NATIVE_INTEGRATION_BLOCKED' }); assert.equal(h.store.runs().length, 0); assert.equal(nativeReadiness(h.config).ok, false); });
test('demo executes a real trusted verifier and uses separate role sessions', async (t) => { const h = harness(t), { p, s } = await ready(h), run = h.engine.create(p.id, s.hash, true); await h.engine.settled(run.id); const r = h.store.run(run.id); assert.equal(r.state, 'READY_FOR_DELIVERY'); assert.equal(r.verification.exitCode, 0); assert.match(r.verification.stdout, /"checks":12/); assert.equal(r.review.source, 'DEMO_RULES'); assert.notEqual(r.sessions.planner2, r.sessions.reviewer); assert.equal(r.calls, 4); assert.ok(r.tasks.every(x => x.status === 'done')); assert.ok(h.store.records(p.id, 'Evidence').length === 1); h.engine.accept(r.id); assert.equal(h.store.run(r.id).state, 'ACCEPTED'); assert.equal(h.store.owns(p.id, r.id), false); });
test('injected demo defect fails verifier then repairs and retests', async (t) => { const h = harness(t), { p, s } = await ready(h), run = h.engine.create(p.id, s.hash, true, true); await h.engine.settled(run.id); const r = h.store.run(run.id), e = h.store.records(p.id, 'Evidence'); assert.equal(r.repairCount, 1); assert.equal(r.state, 'READY_FOR_DELIVERY'); assert.equal(e.length, 2); assert.equal(e[0].data.code, 1); assert.equal(e[1].data.code, 0); assert.ok(r.findings.every(f => f.status === 'resolved')); });
test('repair limit releases the settled writer lease while uncertain blocks keep it', async (t) => {
    const h = harness(t);
    h.config.limits.maxRepairs = 0;
    const { p, s } = await ready(h), r = h.engine.create(p.id, s.hash, true, true);
    await h.engine.settled(r.id);
    assert.equal(h.store.run(r.id).reason, 'REPAIR_LIMIT');
    assert.equal(h.store.run(r.id).state, 'BLOCKED');
    assert.equal(h.store.owns(p.id, r.id), false);
    assert.throws(() => h.engine.accept(r.id), { code: 'ACCEPTANCE_GATES_NOT_MET' });
    await assert.rejects(h.engine.resume(r.id, true), { code: 'BUDGET_OR_REPAIR_LIMIT_REQUIRES_NEW_RUN' });

    const replacement = h.engine.create(p.id, s.hash, true, false);
    await h.engine.settled(replacement.id);
    assert.equal(h.store.run(replacement.id).state, 'READY_FOR_DELIVERY');
});
// A delivered run used to keep its writer lease until the owner accepted or cancelled it. Two demo runs from
// 2026-10-18 sat in READY_FOR_DELIVERY holding theirs, so neither project could start another build (every
// create answered WORKSPACE_BUSY) until each was cancelled by hand. Delivery is not a write, and acceptance
// must still be possible after the release.
test('a delivered run releases its lease, acceptance still works, and the project can build again', async (t) => {
 const h = harness(t), { p, s } = await ready(h), first = h.engine.create(p.id, s.hash, true);
 await h.engine.settled(first.id);
 assert.equal(h.store.run(first.id).state, 'READY_FOR_DELIVERY');
 assert.equal(h.store.owns(p.id, first.id), false);
 const accepted = h.engine.accept(first.id);
 assert.equal(accepted.state, 'ACCEPTED');
 const second = h.engine.create(p.id, s.hash, true);
 await h.engine.settled(second.id);
 assert.equal(h.store.run(second.id).state, 'READY_FOR_DELIVERY');
 assert.notEqual(second.id, first.id);
});
test('cancelling the newest flow restores the prior stable delivery', async (t) => {
 const h = harness(t), { p, s } = await ready(h), first = h.engine.create(p.id, s.hash, true);
 await h.engine.settled(first.id);
 h.engine.accept(first.id);
 const second = h.engine.create(p.id, s.hash, true);
 await h.engine.settled(second.id);
 assert.equal(h.store.project(p.id).activeRunId, second.id);
 await h.engine.cancel(second.id);
 assert.equal(h.store.run(second.id).state, 'CANCELLED');
 assert.equal(h.store.project(p.id).activeRunId, first.id);
 assert.equal(h.store.project(p.id).state, 'READY_TO_BUILD');
});
test('recovery repairs a legacy cancelled active-run pointer without changing history', async (t) => {
 const h = harness(t), { p, s } = await ready(h), first = h.engine.create(p.id, s.hash, true);
 await h.engine.settled(first.id);
 h.engine.accept(first.id);
 const second = h.engine.create(p.id, s.hash, true);
 await h.engine.settled(second.id);
 await h.engine.cancel(second.id);
 const beforeRuns = h.store.runs(p.id).map(run => structuredClone(run));
 const stale = h.store.project(p.id);
 stale.activeRunId = second.id;
 h.store.saveProject(stale);
 h.engine.recover();
 assert.equal(h.store.project(p.id).activeRunId, first.id);
 assert.deepEqual(h.store.runs(p.id).map(run => structuredClone(run)), beforeRuns);
 assert.ok(h.store.events(p.id).some(event => event.type === 'project.active-run.recovered' && event.runId === second.id));
});
test('acceptance is refused when the frozen tree changed, even with the lease released', async (t) => {
 const h = harness(t), { p, s } = await ready(h), run = h.engine.create(p.id, s.hash, true);
 await h.engine.settled(run.id);
 writeFileSync(resolve(h.store.run(run.id).workspace, 'tamper.txt'), 'x');
 assert.throws(() => h.engine.accept(run.id), { code: 'EXTERNAL_WORKSPACE_CHANGE' });
});

test('top-level dispatch budget stops at boundary', async (t) => { const h = harness(t); h.config.limits.maxCalls = 1; const { p, s } = await ready(h), r = h.engine.create(p.id, s.hash, true); await h.engine.settled(r.id); assert.equal(h.store.run(r.id).calls, 1); assert.equal(h.store.run(r.id).reason, 'RUN_CALL_BUDGET_EXCEEDED'); });
test('pause and immediate resume at a checkpoint do not lose the worker', async (t) => { const h = harness(t, 60), { p, s } = await ready(h), r = h.engine.create(p.id, s.hash, true); h.engine.pause(r.id); await h.engine.settled(r.id); assert.equal(h.store.run(r.id).state, 'PAUSED'); await h.engine.resume(r.id); await h.engine.settled(r.id); assert.equal(h.store.run(r.id).state, 'READY_FOR_DELIVERY'); });
test('cancel an active worker releases only its lease', async (t) => { const h = harness(t, 300), { p, s } = await ready(h), r = h.engine.create(p.id, s.hash, true); await sleep(25); await h.engine.cancel(r.id); assert.equal(h.store.run(r.id).state, 'CANCELLED'); assert.equal(h.store.owns(p.id, r.id), false); assert.equal(h.engine.jobs.size, 0); assert.equal(h.store.records(p.id, 'Evidence').length, 0); });
test('single writer prevents simultaneous runs and spec edits', async (t) => { const h = harness(t, 300), { p, s } = await ready(h), r = h.engine.create(p.id, s.hash, true); assert.throws(() => h.engine.create(p.id, s.hash, true), { code: 'WORKSPACE_BUSY' }); await assert.rejects(h.interviews.finish(p.id), { code: 'RUN_MUST_STOP_BEFORE_EDIT' }); await h.engine.cancel(r.id); });
test('cancellation during an active run never writes a delivery', async (t) => {
    // G07: cancel racing the end of a run must leave the run CANCELLED, not delivered.
    const h = harness(t, 300), { p, s } = await ready(h), run = h.engine.create(p.id, s.hash, true);
    await sleep(40);
    await h.engine.cancel(run.id);
    await h.engine.settled(run.id);
    const final = h.store.run(run.id);
    assert.equal(final.state, 'CANCELLED');
    assert.notEqual(final.state, 'READY_FOR_DELIVERY');
    assert.equal(h.store.owns(p.id, run.id), false);
    assert.deepEqual(final.artifacts, []);
    const types = h.store.events(p.id).map(e => String(e.type));
    assert.equal(types.some(x => /delivery/i.test(x)), false, 'no delivery event on a cancelled run: ' + types.join(','));
    // Cancellation releases the lease too, and delivery is no longer guarded by a writer lease: the refusal
    // now comes from the delivery gates, which is the condition that actually matters here.
    assert.throws(() => h.engine.accept(run.id), { code: 'ACCEPTANCE_GATES_NOT_MET' });
});
// Delivery is not a write, so the writer lease is released the moment a run reaches READY_FOR_DELIVERY.
// Keeping it pinned the project: two demo runs from 2026-10-18 still held theirs, and every later build of
// those projects answered WORKSPACE_BUSY until each was cancelled by hand. Acceptance therefore reads the
// frozen artifact instead of demanding a writer, and the frozen-tree check is what guards it.
test('a delivered run releases its lease and can still be accepted', async (t) => {
    const h = harness(t), { p, s } = await ready(h), run = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(run.id);
    assert.equal(h.store.run(run.id).state, 'READY_FOR_DELIVERY');
    assert.equal(h.store.owns(p.id, run.id), false, 'delivery releases the writer lease');
    assert.equal(h.engine.accept(run.id).state, 'ACCEPTED');
});
test('a delivered run no longer blocks the next build of its project', async (t) => {
    const h = harness(t), { p, s } = await ready(h), first = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(first.id);
    assert.equal(h.store.owns(p.id, first.id), false);
    const second = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(second.id);
    assert.notEqual(second.id, first.id);
    assert.equal(h.store.run(second.id).state, 'READY_FOR_DELIVERY');
    // The earlier delivery is untouched by the newer run, and still waits for the owner.
    assert.equal(h.store.run(first.id).state, 'READY_FOR_DELIVERY');
});
test('recovery releases a lease still pinned by an already delivered run', async (t) => {
    const h = harness(t), { p, s } = await ready(h), run = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(run.id);
    h.store.acquire(p.id, run.id);
    assert.equal(h.store.owns(p.id, run.id), true);
    h.engine.recover();
    assert.equal(h.store.owns(p.id, run.id), false);
    assert.equal(h.store.run(run.id).state, 'READY_FOR_DELIVERY');
});
test('external source change invalidates acceptance and export', async (t) => { const h = harness(t), { p, s } = await ready(h), r = h.engine.create(p.id, s.hash, true); await h.engine.settled(r.id); writeFileSync(resolve(r.workspace, 'board.mjs'), 'external writer'); assert.throws(() => h.engine.accept(r.id), { code: 'EXTERNAL_WORKSPACE_CHANGE' }); assert.throws(() => h.engine.export(r.id), { code: 'ARTIFACT_SOURCE_CHANGED' }); });
test('restart marks uncertain effects blocked without releasing lease', async (t) => { const h = harness(t, 300), { p, s } = await ready(h), r = h.engine.create(p.id, s.hash, true); h.engine.pause(r.id); await h.engine.settled(r.id); const stored = h.store.run(r.id); stored.state = 'IMPLEMENTING'; stored.phase = 'IMPLEMENTING'; h.store.saveRun(stored); h.engine.recover(); assert.equal(h.store.run(r.id).reason, 'WORKER_RESTART_RESULT_UNCERTAIN'); assert.equal(h.store.owns(p.id, r.id), true); });
test('plan DAG validates dependencies and complete requirement coverage', () => { const tasks = [{ id: 'a', title: 'A', dependsOn: [], requirementIds: ['R1'], acceptance: ['works'] }, { id: 'b', title: 'B', dependsOn: ['a'], requirementIds: ['R2'], acceptance: ['works'] }]; assert.equal(validatePlan({ tasks }, ['R1', 'R2']).length, 2); assert.throws(() => validatePlan({ tasks }, ['R1', 'R2', 'R3']), { code: 'PLAN_REQUIREMENT_OMITTED' }); tasks[0].dependsOn = ['b']; assert.throws(() => validatePlan({ tasks }, ['R1', 'R2']), { code: 'PLAN_CYCLE' }); });
test('malformed plan and review cannot masquerade as PASS', () => { assert.throws(() => validatePlan({ tasks: [{ id: 'x' }] }, []), { code: 'PLAN_SCHEMA_INVALID' }); assert.throws(() => validateReview({ verdict: 'PASS', findings: [{ id: 'f', severity: 'high', description: 'bug', evidence: 'test' }] }, 'CODEX', 'h'), { code: 'REVIEW_PASS_WITH_FINDINGS' }); assert.throws(() => validateReview({ verdict: 'ok', findings: [] }, 'CODEX', 'h'), { code: 'REVIEW_SCHEMA_INVALID' }); });
test('path traversal, Windows ADS and symlinks are denied', async (t) => { const h = harness(t), dir = resolve(h.dir, 'ws'); mkdirSync(dir); for (const path of ['../secret', '/etc/passwd', '..\\secret', 'a:stream'])
    assert.throws(() => within(dir, path)); symlinkSync(h.dir, resolve(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => within(dir, 'link/secret'), { code: 'SYMLINK_DENIED' }); assert.throws(() => files(dir), { code: 'WORKSPACE_SYMLINK_DENIED' }); });
test('artifact SHA-256 hashes raw bytes and ZIP passes independent CRC inspection', async (t) => { const h = harness(t), dir = resolve(h.dir, 'ws'); mkdirSync(dir); put(dir, 'hello.txt', '你好\n'); const bytes = get(dir, 'hello.txt'); assert.equal(files(dir)[0].sha256, createHash('sha256').update(bytes).digest('hex')); const archive = zip([{ path: 'hello.txt', data: bytes }]), file = resolve(h.dir, 'a.zip'); writeFileSync(file, archive); const r = spawnSync('python', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read("hello.txt").decode()=="你好\\n"', file], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); assert.throws(() => zip([{ path: '../x', data: bytes }])); assert.throws(() => zip([{ path: 'a', data: bytes }, { path: 'a', data: bytes }])); });
test('keys do not enter controller evidence or child environment', async (t) => { const h = harness(t), key = 'synthetic-sensitive-test-value'; process.env.DM_TEST_SECRET = key; t.after(() => delete process.env.DM_TEST_SECRET); h.store.record('Evidence', null, null, { stdout: key }); const raw = h.store.db.prepare('select data from records').get().data; assert.equal(raw.includes(key), false); assert.equal(childEnv().DM_TEST_SECRET, undefined); assert.throws(() => h.interviews.create('title', key, 'demo'), { code: 'SECRET_IN_IDEA' }); assert.equal(redact('dsk-abcdefghijk'), '[REDACTED]'); });
test('provider and Laya endpoint policies reject wrong hosts', () => { publicApiUrl('https://api.openai.com/v1'); loopbackUrl('http://127.0.0.1:8765'); for (const x of ['http://api.openai.com', 'https://evil.example/v1', 'https://api.openai.com@evil.example', 'https://api.openai.com/v1/../admin'])
    assert.throws(() => publicApiUrl(x)); assert.throws(() => loopbackUrl('http://0.0.0.0:8765')); assert.throws(() => loopbackUrl('http://localhost:8765')); });
test('changing a native audit configuration invalidates its fingerprint', () => { const c = structuredClone(defaults), a = nativeReadiness(c); c.laya.mode = 'shadow'; assert.notEqual(nativeReadiness(c).configurationHash, a.configurationHash); assert.ok(a.reasons.includes('NATIVE_AUDIT_REQUIRED')); });
test('invalid configuration bounds cannot be silently accepted', () => { const c = structuredClone(defaults); c.limits.maxCalls = -1; assert.throws(() => parseConfig(c), { code: 'INVALID_INTEGER' }); });

// Stage B lesson: pointing the public "independent" provider at the DM loopback gateway would
// bypass account/budget admission, so parsing must keep refusing it. A dedicated loopback runner
// is the supported path; relaxing this rule is not.
test('the independent provider cannot be repointed at loopback', () => {
    for (const baseUrl of ['http://127.0.0.1:4317/v1', 'http://localhost:4317/v1', 'http://[::1]:4317/v1', 'http://0.0.0.0/v1'])
        assert.throws(() => parseConfig({ ...structuredClone(defaults), independent: { ...defaults.independent, enabled: true, baseUrl } }), undefined, baseUrl);
    const ok = structuredClone(defaults);
    ok.independent = { ...ok.independent, enabled: true, baseUrl: 'https://api.openai.com/v1' };
    assert.equal(parseConfig(ok).independent.baseUrl, 'https://api.openai.com/v1');
});
test('wall-time budget aborts an in-flight step and remains BLOCKED, not user-cancelled', async (t) => { const h = harness(t, 250); h.config.limits.maxSeconds = 0.08; const { p, s } = await ready(h), r = h.engine.create(p.id, s.hash, true); await h.engine.settled(r.id); assert.equal(h.store.run(r.id).state, 'BLOCKED'); assert.equal(h.store.run(r.id).reason, 'RUN_WALL_TIME_BUDGET_EXCEEDED'); assert.ok(h.store.owns(p.id, r.id)); });
test('artifact content endpoint never exposes sensitive filenames or embedded keys', async (t) => { const h = harness(t), dir = resolve(h.dir, 'ws'); mkdirSync(dir); put(dir, '.env', 'EXAMPLE=not-a-key'); assert.throws(() => get(dir, '.env'), { code: 'SENSITIVE_ARTIFACT_DENIED' }); put(dir, 'plain.txt', 'dsk-syntheticexample'); assert.throws(() => get(dir, 'plain.txt'), { code: 'SECRET_IN_ARTIFACT' }); });
test('cross-project Flows share bounded executor slots and keep independent cancellation', async (t) => { const h = harness(t, 250), a = await ready(h), b = await ready(h); const first = h.engine.create(a.p.id, a.s.hash, true), second = h.engine.create(b.p.id, b.s.hash, true); assert.equal(h.engine.jobs.size, 2); assert.equal(h.engine.dispatchStatus().executorSlots, 2); await h.engine.cancel(first.id); assert.equal(h.store.run(first.id).state, 'CANCELLED'); assert.notEqual(h.store.run(second.id).state, 'CANCELLED'); await h.engine.cancel(second.id); });
test('changing configuration invalidates a paused run instead of switching models silently', async (t) => { const h = harness(t, 150), { p, s } = await ready(h), r = h.engine.create(p.id, s.hash, true); h.engine.pause(r.id); await h.engine.settled(r.id); h.config.codex.model = 'changed'; await assert.rejects(h.engine.resume(r.id), { code: 'RUN_CONFIG_CHANGED' }); await h.engine.cancel(r.id); });
test('planner2 receives the eight-call slice contract in the engine plan prompt', async (t) => {
    const h = harness(t);
    let planPrompt = '';
    const original = h.engine.role;
    h.engine.role = async function (run, role, prompt, signal) {
        if (role === 'planner2') planPrompt = prompt;
        return original.call(this, run, role, prompt, signal);
    };
    const { p, s } = await ready(h);
    const run = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(run.id);
    assert.match(planPrompt, /TASK GRANULARITY/);
    assert.match(planPrompt, /at most 8 tool calls/);
    assert.match(planPrompt, /Split broad setup, data, UI, integration and verification work/);
});
test('a transient executor failure continues only when the workspace is unchanged and reserves another call', async (t) => {
    const { h, run } = await parkedRun(t);
    h.store.tx(() => {
        const current = h.store.run(run.id);
        current.calls = 1;
        current.maxCalls = 2;
        h.store.saveRun(current);
    });
    const prompts = [];
    const runner = { run: async input => {
        prompts.push(input.prompt);
        if (prompts.length === 1) throw new DomainError('DSH_HOST_TIMEOUT', 504);
        return { text: 'continued', sessionId: 'segment-session', usage: { role: 'executor', inputTokens: null, outputTokens: null, costUsd: null, source: 'UNKNOWN', requestId: 'segment-response' } };
    } };
    const input = { role: 'executor', workspace: run.workspace, prompt: 'first segment', model: 'deepseek-flash', specHash: run.specHash, runId: run.id, laya: { role: 'executor', mode: 'off', adoption: 'off' }, signal: new AbortController().signal };
    const output = await h.engine.executorSegmented(run, input, runner, 'original task', { adoption: 'off' }, () => {});
    const current = h.store.run(run.id);
    assert.equal(output.text, 'continued');
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /SEGMENT 2\/3/);
    assert.match(prompts[1], /at most 8 tool calls/);
    assert.equal(current.calls, 2);
    assert.equal(h.store.records(run.projectId, 'ExecutorSegment').length, 1);
});
test('a transient executor failure is final when it may have changed the workspace', async (t) => {
    const { h, run } = await parkedRun(t);
    let attempts = 0;
    const runner = { run: async () => {
        attempts++;
        put(run.workspace, 'partial-work.txt', 'uncertain side effect');
        throw new DomainError('RPC_REQUEST_TIMEOUT', 504);
    } };
    const input = { role: 'executor', workspace: run.workspace, prompt: 'first segment', model: 'deepseek-flash', specHash: run.specHash, runId: run.id, laya: { role: 'executor', mode: 'off', adoption: 'off' }, signal: new AbortController().signal };
    await assert.rejects(h.engine.executorSegmented(run, input, runner, 'original task', { adoption: 'off' }, () => {}), { code: 'RPC_REQUEST_TIMEOUT' });
    assert.equal(attempts, 1);
    assert.equal(h.store.records(run.projectId, 'ExecutorSegment').length, 0);
});
test('executor segmentation reserves each continuation and stops before exceeding the call budget', async (t) => {
    const { h, run } = await parkedRun(t);
    h.store.tx(() => {
        const current = h.store.run(run.id);
        current.calls = 1;
        current.maxCalls = 2;
        h.store.saveRun(current);
    });
    let attempts = 0;
    const runner = { run: async () => {
        attempts++;
        throw new DomainError('DSH_HOST_TIMEOUT', 504);
    } };
    const input = { role: 'executor', workspace: run.workspace, prompt: 'first segment', model: 'deepseek-flash', specHash: run.specHash, runId: run.id, laya: { role: 'executor', mode: 'off', adoption: 'off' }, signal: new AbortController().signal };
    await assert.rejects(h.engine.executorSegmented(run, input, runner, 'original task', { adoption: 'off' }, () => {}), { code: 'RUN_CALL_BUDGET_EXCEEDED' });
    assert.equal(attempts, 2);
    assert.equal(h.store.run(run.id).calls, 2);
});
test('an explicit reviewer block releases the settled writer lease and requires a replacement run', async (t) => {
    const { h, run } = await parkedRun(t);
    h.engine.blockAndRelease(run.id, 'run.blocked', 'REVIEW_BLOCKED');
    assert.equal(h.store.run(run.id).state, 'BLOCKED');
    assert.equal(h.store.run(run.id).reason, 'REVIEW_BLOCKED');
    assert.equal(h.store.owns(run.projectId, run.id), false);
    assert.throws(() => h.engine.accept(run.id), { code: 'ACCEPTANCE_GATES_NOT_MET' });
    await assert.rejects(h.engine.resume(run.id, true), { code: 'BUDGET_OR_REPAIR_LIMIT_REQUIRES_NEW_RUN' });
});
test('an uncertain runner transport failure keeps its writer lease even after the repair limit', async (t) => {
    const { h, run } = await parkedRun(t);
    h.store.tx(() => {
        const current = h.store.run(run.id);
        current.maxRepairs = 0;
        h.store.saveRun(current);
    });
    h.engine.repair(run.id, 'RUNNER_RPC_ERROR', false);
    assert.equal(h.store.run(run.id).state, 'BLOCKED');
    assert.equal(h.store.run(run.id).reason, 'REPAIR_LIMIT');
    assert.equal(h.store.owns(run.projectId, run.id), true);
});
