import test from 'node:test';
import assert from 'node:assert/strict';
import { stageTimeline, stageSequence, stageLabel, stageDisplayName, phaseStage, activeStageBubble, stageStripMarkup, STAGE_STATE_LABEL } from '../../dist/web/chat-stages.js';

const t = (minutes) => '2026-11-21T09:' + String(minutes).padStart(2, '0') + ':00.000Z';
const stages = (rows) => rows.map(row => row.stage);

test('the strip shows all five stages in the order they really happened, not the enum order', () => {
  const rows = stageTimeline({
    product: 'dm', phase: 'flow', phaseAt: t(5),
    messages: [
      { role: 'reviewer', at: t(30) },
      { role: 'executor', at: t(10) },
      { role: 'planner', at: t(20) },
      { role: 'seeker', at: t(0) }
    ]
  });
  assert.deepEqual(stages(rows), ['seeker', 'dreamflow', 'executor', 'planner', 'reviewer']);
  assert.deepEqual(rows.map(row => row.at), [t(0), t(5), t(10), t(20), t(30)]);
  assert.equal(rows.find(row => row.current).stage, 'dreamflow');
  assert.equal(rows.find(row => row.state === 'active').stage, 'dreamflow');
});

test('bubble text comes from the shared role names, never from a literal in the shell', () => {
  assert.equal(stageDisplayName('seeker'), 'Seeker');
  assert.equal(stageDisplayName('planner'), 'Planner');
  assert.equal(stageDisplayName('executor'), 'Executor');
  assert.equal(stageDisplayName('reviewer'), 'Reviewer');
  assert.equal(stageDisplayName('dreamflow'), 'DreamFlow');
  assert.equal(stageLabel('seeker'), 'Seeker 探寻中');
  assert.equal(stageLabel('dreamflow'), 'DreamFlow 流转中');
  assert.equal(stageLabel('planner'), 'Planner 规划中');
  assert.equal(stageLabel('executor'), 'Executor 执行中');
  assert.equal(stageLabel('reviewer'), 'Reviewer 审查中');
  const labels = stageTimeline({ product: 'dm', phase: 'idle', messages: [] }).map(row => row.label);
  assert.deepEqual(labels, ['Seeker 探寻中', 'DreamFlow 流转中', 'Planner 规划中', 'Executor 执行中', 'Reviewer 审查中']);
  for (const label of labels) assert.doesNotMatch(label, /planner1|planner2/);
});

test('DF has no seeker segment at all, even when seeker evidence leaks in', () => {
  assert.deepEqual(stageSequence('df'), ['dreamflow', 'planner', 'executor', 'reviewer']);
  assert.deepEqual(stageSequence('dm'), ['seeker', 'dreamflow', 'planner', 'executor', 'reviewer']);
  const rows = stageTimeline({ product: 'df', phase: 'planning', phaseAt: t(5), messages: [{ role: 'seeker', at: t(0) }, { role: 'planner', at: t(5) }] });
  assert.deepEqual(stages(rows), ['dreamflow', 'planner', 'executor', 'reviewer']);
  assert.equal(rows[0].label, 'DreamFlow 流转中');
  assert.equal(rows[1].state, 'active');
  assert.doesNotMatch(JSON.stringify(rows), /seeker/i);
});

test('a stage with no timestamp never sorts in front of a stage that already ran', () => {
  const rows = stageTimeline({ product: 'dm', phase: 'planning', phaseAt: t(50), messages: [{ role: 'planner', at: t(50) }] });
  assert.deepEqual(stages(rows), ['seeker', 'dreamflow', 'planner', 'executor', 'reviewer']);
  assert.equal(rows.find(row => row.stage === 'seeker').state, 'pending');
  assert.equal(rows.find(row => row.stage === 'planner').state, 'active');
  assert.equal(rows.find(row => row.stage === 'planner').at, t(50));
});

test('an interview with questions proves the seeker stage without any message timestamp', () => {
  const rows = stageTimeline({ product: 'dm', phase: 'awaiting_answer', messages: [], questions: [{ id: 'q1' }] });
  assert.deepEqual(stages(rows), ['seeker', 'dreamflow', 'planner', 'executor', 'reviewer']);
  assert.equal(rows[0].state, 'active');
  assert.equal(rows[0].at, '');
});

test('a blocked flow marks the furthest stage reached and keeps the rest pending', () => {
  const rows = stageTimeline({
    product: 'dm', phase: 'blocked',
    messages: [{ role: 'seeker', at: t(0) }, { role: 'planner', at: t(30) }]
  });
  const byStage = Object.fromEntries(rows.map(row => [row.stage, row.state]));
  assert.deepEqual(byStage, { seeker: 'done', dreamflow: 'done', planner: 'blocked', executor: 'pending', reviewer: 'pending' });
  assert.equal(rows.some(row => row.state === 'active'), false);
});

test('a paused flow reads as paused, not as blocked and not as working', () => {
  const rows = stageTimeline({
    product: 'dm', phase: 'paused',
    messages: [{ role: 'seeker', at: t(0) }, { role: 'executor', at: t(30) }]
  });
  const byStage = Object.fromEntries(rows.map(row => [row.stage, row.state]));
  assert.equal(byStage.executor, 'paused');
  assert.equal(rows.some(row => row.state === 'blocked'), false);
  assert.equal(rows.some(row => row.state === 'active'), false);
});

test('a delivered or accepted flow shows every stage done', () => {
  for (const phase of ['ready', 'accepted']) {
    const rows = stageTimeline({ product: 'dm', phase, messages: [] });
    assert.deepEqual(rows.map(row => row.state), ['done', 'done', 'done', 'done', 'done']);
    assert.equal(activeStageBubble({ product: 'dm', phase, messages: [] }), null);
  }
});

test('idle shows the whole sequence as pending work', () => {
  const rows = stageTimeline({ product: 'dm', phase: 'idle', messages: [] });
  assert.deepEqual(rows.map(row => row.state), ['pending', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(rows.map(row => row.at), ['', '', '', '', '']);
});

test('prework and verifying stay inside the executor stage instead of claiming a stage that has not started', () => {
  for (const phase of ['prework', 'executing', 'verifying']) {
    assert.equal(phaseStage(phase), 'executor');
    const rows = stageTimeline({ product: 'dm', phase, phaseAt: t(40), messages: [{ role: 'planner', at: t(30) }] });
    assert.equal(rows.find(row => row.stage === 'executor').state, 'active');
    assert.equal(rows.find(row => row.stage === 'executor').at, t(40));
    assert.equal(rows.find(row => row.stage === 'reviewer').state, 'pending');
  }
  assert.equal(phaseStage('review_feedback'), 'seeker');
  assert.equal(phaseStage('flow'), 'dreamflow');
  assert.equal(phaseStage('unknown-phase'), null);
});

test('an unknown phase claims no stage and still reports what really ran', () => {
  const rows = stageTimeline({ product: 'dm', phase: 'unknown-phase', messages: [{ role: 'seeker', at: t(0) }] });
  assert.equal(rows.some(row => row.state === 'active'), false);
  assert.equal(rows.find(row => row.stage === 'seeker').state, 'done');
  assert.equal(activeStageBubble({ product: 'dm', phase: 'unknown-phase', messages: [] }), null);
});

test('the strip markup is product-neutral: DM and DF differ only by the missing seeker bubble', () => {
  const fixture = {
    phase: 'planning', phaseAt: t(20),
    messages: [{ role: 'seeker', at: t(0) }, { role: 'planner', at: t(20) }]
  };
  const dm = stageStripMarkup({ product: 'dm', ...fixture }, { activeDetail: 'Planner 规划中' });
  const df = stageStripMarkup({ product: 'df', ...fixture }, { activeDetail: 'Planner 规划中' });
  // Same input, same styling hooks: nothing in the strip is product-specific.
  assert.doesNotMatch(dm, /data-product/);
  assert.doesNotMatch(df, /data-product/);
  // Compare the bubbles, not the string: DF is DM with exactly the seeker bubble removed.
  const bubbles = (html) => [...html.matchAll(/data-stage="([a-z]+)" data-state="([a-z]+)"/g)].map(match => match[1] + ':' + match[2]);
  // Only stages that really started are shown: executor and reviewer have no evidence yet.
  assert.deepEqual(bubbles(dm), ['seeker:done', 'dreamflow:done', 'planner:active']);
  assert.deepEqual(bubbles(df), ['dreamflow:done', 'planner:active']);
  assert.deepEqual(bubbles(df), bubbles(dm).filter(entry => !entry.startsWith('seeker:')));
  // Same wrapper, same class names: only the bubbles differ.
  assert.equal(dm.slice(0, dm.indexOf('<span class="dc-stage-bubble"')), df.slice(0, df.indexOf('<span class="dc-stage-bubble"')));
  assert.ok(dm.endsWith('</div>') && df.endsWith('</div>'));
});
test('the strip carries state for css, marks the current stage and keeps the precise phase wording', () => {
  const html = stageStripMarkup(
    { product: 'dm', phase: 'verifying', phaseAt: t(40), messages: [{ role: 'planner', at: t(30) }] },
    { activeDetail: '验证器核验中' }
  );
  assert.match(html, /role="list" aria-label="本轮阶段"/);
  assert.match(html, /data-stage="executor" data-state="active" aria-current="step" aria-label="验证器核验中 · 进行中"/);
  assert.match(html, /data-stage="planner" data-state="done"/);
  // A stage that has not started yet is not rendered at all.
  assert.doesNotMatch(html, /data-stage="reviewer"/);
  assert.match(html, /<span class="dc-stage-text">Executor 执行中<\/span>/);
  assert.match(html, /<time class="dc-stage-time">/);
  assert.equal(STAGE_STATE_LABEL.pending, '未开始');
  assert.equal(STAGE_STATE_LABEL.paused, '已暂停');
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1);
});
