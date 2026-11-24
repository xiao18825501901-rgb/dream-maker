import test from 'node:test';
import assert from 'node:assert/strict';
import { workStatusFor, WORK_STATUS_LABEL, workStatusClass } from '../../dist/web/chat-work-status.js';

const base = {
  answered: true, answerRevision: 1, taskCount: 2, tasksDone: 2, tasksRunning: 0,
  runBlocked: false, verificationMatchesSource: false, reviewPassedOnSource: false, closeoutComplete: false
};
const status = (patch) => workStatusFor({ ...base, ...patch }).status;

test('the seven product states each have one label and one css class', () => {
  assert.deepEqual(WORK_STATUS_LABEL.pending, '未开始');
  assert.deepEqual(WORK_STATUS_LABEL.working, '进行中');
  assert.deepEqual(WORK_STATUS_LABEL.crafted, '已制作');
  assert.deepEqual(WORK_STATUS_LABEL.verified, '已验证');
  assert.deepEqual(WORK_STATUS_LABEL.reviewed, '已审查');
  assert.deepEqual(WORK_STATUS_LABEL.blocked, '受阻');
  assert.deepEqual(WORK_STATUS_LABEL.changed, '需求变更');
  assert.equal(workStatusClass('crafted'), 'is-crafted');
});

test('no evidence means no promotion: crafted needs every task of the run closed', () => {
  assert.equal(status({ taskCount: 0, tasksDone: 0 }), 'answered');
  assert.equal(status({ taskCount: 2, tasksDone: 1 }), 'answered');
  assert.equal(status({ taskCount: 2, tasksDone: 2 }), 'crafted');
});

test('becoming verified needs the verifier to pass on the exact source the run holds', () => {
  assert.equal(status({ verificationMatchesSource: false }), 'crafted');
  assert.equal(status({ verificationMatchesSource: true }), 'verified');
  // A verifier result from another tree cannot promote the star.
  assert.equal(status({ taskCount: 2, tasksDone: 1, verificationMatchesSource: true }), 'answered');
});

test('becoming reviewed needs a PASS review on that same source', () => {
  assert.equal(status({ verificationMatchesSource: true, reviewPassedOnSource: true }), 'reviewed');
  assert.equal(status({ verificationMatchesSource: true, reviewPassedOnSource: false }), 'verified');
  // A review without a matching verifier cannot skip a rank.
  assert.equal(status({ verificationMatchesSource: false, reviewPassedOnSource: true }), 'crafted');
});

test('only the existing closeout rule reaches done, and it outranks every new state', () => {
  assert.equal(status({ closeoutComplete: true }), 'done');
  assert.equal(status({ closeoutComplete: true, tasksRunning: 1 }), 'done');
  assert.equal(status({ closeoutComplete: false, reviewPassedOnSource: true, verificationMatchesSource: true }), 'reviewed');
});

test('the pre-existing priorities are untouched', () => {
  assert.equal(status({ answered: false }), 'pending');
  assert.equal(status({ answerRevision: 3, tasksDone: 0, taskCount: 0 }), 'changed');
  assert.equal(status({ tasksRunning: 1, tasksDone: 1 }), 'working');
  assert.equal(status({ runBlocked: true, tasksRunning: 0 }), 'blocked');
  assert.equal(status({ runBlocked: true, tasksRunning: 1 }), 'working');
  assert.equal(status({ runBlocked: true, taskCount: 0, tasksDone: 0 }), 'answered');
});

test('every status carries a reason that does not promise more than the evidence', () => {
  const reviewed = workStatusFor({ ...base, verificationMatchesSource: true, reviewPassedOnSource: true });
  assert.match(reviewed.reason, /最终接受/);
  const crafted = workStatusFor(base);
  assert.match(crafted.reason, /还没有验证结论/);
  const pending = workStatusFor({ ...base, answered: false });
  assert.equal(pending.reason, '这题还没有回答。');
});
