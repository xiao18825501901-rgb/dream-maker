import test from 'node:test';
import assert from 'node:assert/strict';
import { siwcConnectionActions } from '../../dist/web/siwc-local.js';

test('a saved connected ChatGPT session is presented as reusable and does not ask for another connection', () => {
  const html = siwcConnectionActions({ statusAvailable: true, connected: true, sharing: true, state: 'SHARING_ENABLED', authorizing: false, busy: false });
  assert.doesNotMatch(html, /data-action="siwc-connect"/);
  assert.doesNotMatch(html, /data-action="siwc-reconsent"/);
  assert.match(html, /连接已保存/);
  assert.match(html, /自动复用/);
  assert.match(html, /data-action="siwc-disconnect"/);
});

test('only a disconnected or reauthorization-required session exposes the initial connect action', () => {
  const disconnected = siwcConnectionActions({ statusAvailable: true, connected: false, sharing: false, state: 'DISCONNECTED', authorizing: false, busy: false });
  assert.match(disconnected, /data-action="siwc-connect"/);
  assert.doesNotMatch(disconnected, /连接已保存/);
  const reauth = siwcConnectionActions({ statusAvailable: true, connected: false, sharing: false, state: 'REAUTH_REQUIRED', authorizing: false, busy: false });
  assert.match(reauth, /data-action="siwc-connect"/);
  const authorizing = siwcConnectionActions({ statusAvailable: true, connected: false, sharing: false, state: 'AUTHORIZING', authorizing: true, busy: false });
  assert.match(authorizing, /data-action="siwc-connect"/);
  assert.match(authorizing, /disabled/);
  const unavailable = siwcConnectionActions({ statusAvailable: true, connected: false, sharing: false, state: 'TEMPORARILY_UNAVAILABLE', authorizing: false, busy: false });
  assert.doesNotMatch(unavailable, /data-action="siwc-connect"/);
  assert.match(unavailable, /连接已保存/);
  assert.match(unavailable, /暂时无法读取/);
});

test('a connected account without plan scope asks only for the missing permission', () => {
  const html = siwcConnectionActions({ statusAvailable: true, connected: true, sharing: false, state: 'SIGNED_IN_NO_SHARING', authorizing: false, busy: false });
  assert.doesNotMatch(html, /data-action="siwc-connect"/);
  assert.match(html, /data-action="siwc-reconsent"/);
  assert.match(html, /授权套餐用量/);
});

test('an unreadable initial status never becomes a connect request', () => {
  const html = siwcConnectionActions({ statusAvailable: false, connected: false, sharing: false, state: 'DISCONNECTED', authorizing: false, busy: false });
  assert.doesNotMatch(html, /data-action="siwc-connect"/);
  assert.match(html, /连接保持不变/);
  assert.match(html, /不会因暂时错误自动重新登录/);
});
