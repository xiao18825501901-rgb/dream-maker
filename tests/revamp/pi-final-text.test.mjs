// Pi 的最终文本必须取自"最后一带有文本的 assistant 消息"，不是"最后一条消息"。
// 一个先用工具、后作答的回合，最后一条消息常常只有 tool_use 块；旧逻辑在这种回合上
// 报 PI_OUTPUT_SCHEMA，而回合其实已经产生了完整答案。
import test from 'node:test';
import assert from 'node:assert/strict';

// 与 providers/pi.ts 中同一套选取规则保持一致的最小实现，用于锁住语义。
const textOf = (message) => {
  const blocks = message && message.content;
  return Array.isArray(blocks)
    ? blocks.filter((b) => b && typeof b === 'object' && b.type === 'text').map((b) => String(b.text ?? '')).join('')
    : '';
};
const answeringOf = (messages) => [...messages].reverse().find((m) => textOf(m).trim() !== '');

test('a tool-only last message still yields the earlier final answer', () => {
  const messages = [
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done: wrote three files' }] },
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'tool_use', name: 'read', input: {} }] },
  ];
  assert.equal(textOf(messages[1]), '');
  assert.equal(textOf(answeringOf(messages)), 'done: wrote three files');
});

test('text blocks are concatenated when one message carries several', () => {
  const messages = [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }];
  assert.equal(textOf(answeringOf(messages)), 'ab');
});

test('a turn with no text at all still has no answer, so the guard must still fire', () => {
  const messages = [{ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'tool_use', name: 'read', input: {} }] }];
  assert.equal(answeringOf(messages), undefined);
  assert.equal(textOf(answeringOf(messages)), '');
});

test('whitespace-only text does not count as an answer', () => {
  const messages = [
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '  ' }] },
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'real' }] },
  ];
  assert.equal(textOf(answeringOf(messages)), 'real');
});
