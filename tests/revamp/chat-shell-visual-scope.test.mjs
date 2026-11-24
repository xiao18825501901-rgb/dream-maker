import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../src/web/chat-shell.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../../src/web/chat-shell.ts', import.meta.url), 'utf8');

/** Everything above this marker is the delivered package; everything below is my addition. */
const MARKER = '/* ===== Seeker 工作台补充';
const cut = css.indexOf(MARKER);
const head = cut > 0 ? css.slice(0, cut) : '';
const tail = cut > 0 ? css.slice(cut) : '';
// Comments are stripped before parsing, otherwise a leading comment rides on the next selector.
const stripComments = (text) => text.replace(/\/\*[^]*?\*\//g, '');
/** Innermost rules only: @media / @keyframes wrappers have nested braces, so they never match. */
const rulesOf = (text) => [...stripComments(text).matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(match => ({ selector: match[1].trim(), body: match[2] }));
const headRules = rulesOf(head);
const tailRules = rulesOf(tail);
const roleClass = /\.dc-message-(?:planner|executor|reviewer)\b/;
const DF = '[data-product="df"]';

test('the delivered stylesheet above my addition is untouched, so DM keeps the shipped look', () => {
  assert.ok(cut > 0, 'the addition marker must exist');
  assert.match(head, /\.dc-message-planner \.dc-message-body\{color:#4d667a;font-weight:500;/);
  assert.match(head, /\.dc-message-executor \.dc-message-body\{font-size:13px;color:#75634e;/);
  assert.match(head, /\.dc-message-reviewer \.dc-message-body\{font-size:14px;/);
  // No rule that existed before my addition mentions the new classes.
  assert.doesNotMatch(head, /dc-stage-|dc-star-pit/);
  // And every pre-existing role rule is still unscoped (it applies in DM).
  const shippedRoleRules = headRules.filter(rule => roleClass.test(rule.selector));
  assert.ok(shippedRoleRules.length >= 3);
  for (const rule of shippedRoleRules) assert.equal(rule.selector.startsWith(DF), false, rule.selector);
});

test('every role-typography rule I added is scoped to [data-product="df"]', () => {
  const roleRules = tailRules.filter(rule => roleClass.test(rule.selector));
  assert.equal(roleRules.length, 3);
  for (const rule of roleRules) assert.ok(rule.selector.startsWith(DF + ' '), rule.selector);
  // The unscoped part of my addition never touches the three role bodies, so DM is unchanged.
  const unscoped = tailRules.filter(rule => !rule.selector.startsWith(DF));
  for (const rule of unscoped) assert.doesNotMatch(rule.selector, roleClass);
  assert.ok(unscoped.length >= 10);
});

test('the DF visual layer is exactly six scoped rules: three message bodies and three stage bubbles', () => {
  const scoped = tailRules.filter(rule => rule.selector.startsWith(DF));
  assert.equal(scoped.length, 6);
  const stage = scoped.filter(rule => rule.selector.includes('.dc-stage-bubble'));
  assert.equal(stage.length, 3);
  for (const rule of stage) assert.match(rule.selector, /\[data-stage="(?:planner|executor|reviewer)"\]$/);
  const bodies = scoped.filter(rule => rule.selector.includes('.dc-message-body'));
  assert.equal(bodies.length, 3);
});

test('the stage strip and the empty star pit are product-neutral, so both products render them', () => {
  const track = tailRules.find(rule => rule.selector === '.dc-stage-track');
  assert.ok(track, 'strip container style missing');
  assert.match(track.body, /display:flex/);
  const bubble = tailRules.find(rule => rule.selector === '.dc-stage-bubble');
  assert.ok(bubble, 'bubble style missing');
  const pit = tailRules.find(rule => rule.selector === '.dc-star-pit');
  assert.ok(pit, 'star pit style missing');
  assert.match(pit.body, /border-radius:50%/);
  assert.match(pit.body, /dashed/);
  for (const state of ['done', 'active', 'blocked', 'paused', 'pending']) {
    assert.ok(tailRules.some(rule => rule.selector === '.dc-stage-bubble[data-state="' + state + '"]'), 'missing state ' + state);
  }
});

test('the shell wires the strip and the pit instead of the removed single bubble', () => {
  assert.match(shell, /import \{ stageStripMarkup \} from '\.\/chat-stages\.js';/);
  assert.match(shell, /dc-phase-strip" role="status" aria-live="polite">\$\{stageStripMarkup\(state,\{activeDetail:CHAT_PHASE_LABELS\[state\.phase\]\}\)\}/);
  assert.doesNotMatch(shell, /dc-phase-bubble/);
  assert.doesNotMatch(shell, /const stageRole=/);
  assert.match(shell, /\$\{active\?'<span class="dc-star-pit" aria-hidden="true"><\/span>':chatIcon\('star'\)\}/);
  assert.match(shell, /crafted:'已制作',verified:'已验证',reviewed:'已审查'/);
});
