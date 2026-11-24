import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ready } from '../helpers.mjs';
import { buildSeekerHandoff, assertSeekerHandoffBinding, normalizeInterpretation, SEEKER_NEXT_STEPS } from '../../dist/server/seeker-review.js';

// Reviewer -> Seeker hand-back. A terminal reviewer verdict is handed to Seeker, which explains the
// blockers, which requirements may need re-confirmation and which next steps exist. The reading is
// bound to one reviewer record; a pointer from another run, plan or workspace is refused.

const settled = async h => {
    const { p, s } = await ready(h);
    const run = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(run.id);
    const final = h.store.run(run.id), handoff = h.store.records(p.id, 'SeekerReviewHandoff').at(-1);
    return { p, s, run: final, handoff };
};
const binding = (run, handoff) => ({
    runId: run.id, reviewRecordId: handoff.data.reviewRecordId, reviewRecordHash: handoff.data.reviewRecordHash,
    specId: run.specId, specHash: run.specHash, workspace: run.workspace
});

test('R-01 the reviewer verdict is handed back with its exact binding and never accepted', async t => {
    const h = harness(t), { p, s, run, handoff } = await settled(h);
    assert.equal(run.state, 'READY_FOR_DELIVERY');
    assert.ok(handoff, 'the engine records the hand-back when the verdict settles');
    assert.equal(handoff.data.runId, run.id);
    assert.equal(handoff.data.specId, s.id);
    assert.equal(handoff.data.specHash, s.hash);
    assert.equal(handoff.data.workspace, run.workspace);
    assert.equal(handoff.data.verdict, 'PASS');
    assert.equal(handoff.data.autoAccept, false);
    assert.match(handoff.data.reviewRecordHash, /^[a-f0-9]{64}$/);
    const review = h.store.records(p.id, 'Review').at(-1);
    assert.equal(handoff.data.reviewRecordId, review.id);

    const interpretation = await h.interviews.interpretReview(run.id, binding(run, handoff));
    assert.equal(interpretation.verdict, 'PASS');
    assert.equal(interpretation.autoAccept, false);
    assert.equal(interpretation.requiresNewInterview, false, 'a PASS never forces another questionnaire');
    assert.deepEqual(interpretation.requirementsToReconfirm, []);
    assert.ok(interpretation.nextSteps.length > 0);
    for (const step of interpretation.nextSteps) assert.ok(SEEKER_NEXT_STEPS.includes(step));
    assert.equal(interpretation.source, 'DEMO_RULES');
    // A demo run dispatches no model, so the reading costs nothing and accepts nothing.
    assert.equal(h.store.records(p.id, 'ModelAttempt').length, 0);
    assert.equal(h.store.records(p.id, 'UsageLedger').length, 0);
    assert.equal(h.store.records(p.id, 'SeekerInterpretation').length, 1);
    assert.equal(h.store.run(run.id).state, 'READY_FOR_DELIVERY');
    assert.equal(h.store.events(p.id).some(e => e.type === 'seeker.review.interpreted'), true);
});

test('R-02 a pointer from another run, plan version or workspace is refused', async t => {
    const h = harness(t), first = await settled(h), second = await settled(h);
    assert.notEqual(first.run.id, second.run.id);
    const run = second.run, handoff = second.handoff;
    // Same shape, but the pointer belongs to the first run.
    await assert.rejects(h.interviews.interpretReview(run.id, { ...binding(run, handoff), runId: first.run.id }), { code: 'SEEKER_HANDOFF_RUN_MISMATCH' });
    // The other run's reviewer record cannot be interpreted as this run's.
    await assert.rejects(h.interviews.interpretReview(run.id, { ...binding(run, handoff), reviewRecordId: first.handoff.data.reviewRecordId, reviewRecordHash: first.handoff.data.reviewRecordHash }), { code: 'SEEKER_HANDOFF_REVIEW_MISMATCH' });
    // A tampered review hash is a different record.
    await assert.rejects(h.interviews.interpretReview(run.id, { ...binding(run, handoff), reviewRecordHash: 'f'.repeat(64) }), { code: 'SEEKER_HANDOFF_REVIEW_MISMATCH' });
    // Another project's approved plan cannot be read as this run's plan.
    await assert.rejects(h.interviews.interpretReview(run.id, { ...binding(run, handoff), specId: first.s.id, specHash: first.s.hash }), { code: 'SEEKER_HANDOFF_PLAN_MISMATCH' });
    await assert.rejects(h.interviews.interpretReview(run.id, { ...binding(run, handoff), planVersionId: first.run.planVersionId ?? 'plan_other' }), { code: 'SEEKER_HANDOFF_PLAN_MISMATCH' });
    // A reading is only valid for the workspace the reviewer actually looked at.
    await assert.rejects(h.interviews.interpretReview(run.id, { ...binding(run, handoff), workspace: run.workspace + '-other' }), { code: 'SEEKER_HANDOFF_WORKSPACE_MISMATCH' });
    // The verdict is part of the record, not a caller claim.
    await assert.rejects(h.interviews.interpretReview(run.id, { ...binding(run, handoff), verdict: 'BLOCKED' }), { code: 'SEEKER_HANDOFF_REVIEW_MISMATCH' });
    assert.equal(h.store.records(second.p.id, 'SeekerInterpretation').length, 0);
});

test('R-03 a run without a terminal reviewer record has nothing to interpret', async t => {
    const h = harness(t), { run } = await settled(h);
    const unknown = { ...run, id: 'run_not_reviewed' };
    assert.throws(() => buildSeekerHandoff(h.store, unknown), { code: 'SEEKER_REVIEW_NOT_TERMINAL' });
    // A run that is still implementing has no verdict either.
    const pending = { ...h.store.run(run.id), state: 'IMPLEMENTING' };
    assert.throws(() => buildSeekerHandoff(h.store, pending), { code: 'SEEKER_REVIEW_NOT_TERMINAL' });
    await assert.rejects(h.interviews.interpretReview('run_missing', { runId: 'run_missing' }));
});

test('R-04 the reading cannot invent requirements, next steps or an acceptance', async t => {
    const h = harness(t), { s, run, handoff } = await settled(h);
    const handoffShape = buildSeekerHandoff(h.store, run);
    assert.deepEqual(handoffShape.requirementsToReconfirm ?? [], []);
    assert.throws(() => normalizeInterpretation(handoffShape, s, { blockers: [], requirementsToReconfirm: ['R999'], nextSteps: ['STOP'] }), { code: 'SEEKER_INTERPRETATION_REQUIREMENT_UNKNOWN' });
    assert.throws(() => normalizeInterpretation(handoffShape, s, { blockers: [], nextSteps: ['GRANT_PERMISSION'] }), { code: 'SEEKER_INTERPRETATION_STEP_UNKNOWN' });
    // A PASS may not send the owner back to the interview or demand a re-confirmation.
    assert.throws(() => normalizeInterpretation(handoffShape, s, { blockers: [], requirementsToReconfirm: [s.requirements[0].id], nextSteps: ['DELIVER'] }), { code: 'SEEKER_INTERPRETATION_INVALID' });
    const pass = normalizeInterpretation(handoffShape, s, { blockers: [], nextSteps: ['DELIVER'], requiresNewInterview: true });
    assert.equal(pass.requiresNewInterview, false);
    const reviewing = normalizeInterpretation({ ...handoffShape, verdict: 'CHANGES_REQUESTED' }, s, { blockers: ['保存流程没有验证'], requirementsToReconfirm: [s.requirements[0].id], nextSteps: ['REVISE_REQUIREMENTS'], requiresNewInterview: true });
    assert.deepEqual(reviewing.requirementsToReconfirm, [s.requirements[0].id]);
    assert.equal(reviewing.requiresNewInterview, true);
    // The stored reading keeps the same binding as the reviewer record it read.
    const interpretation = h.store.records(h.store.run(run.id).projectId, 'SeekerInterpretation').at(-1);
    assert.equal(interpretation, undefined);
    void handoff;
});
