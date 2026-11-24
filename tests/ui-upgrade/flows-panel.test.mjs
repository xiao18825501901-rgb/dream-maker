// "拆出两个板块" is only true if the product shows them. The settings screen is where the Laya config
// lives, so the two flow blocks sit next to it -- rendered from the server-resolved payload, never from
// a second copy of the rule in the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shell } from '../../dist/web/views.js';
import { defaults } from '../../dist/server/config.js';
import {flowCatalog} from '../../dist/server/flows.js';

const flows = () => flowCatalog(structuredClone(defaults));

const settingsView = (extra = {}) => ({
    mode: 'local', screen: 'settings', projects: [], snapshot: null,
    settings: { config: structuredClone(defaults), keyStatus: { planner1: false, executor: false }, nativeStatus: 'NOT_VERIFIED', flows: flows(), ...extra },
    tab: 'work', busy: false, error: '', events: [], connection: 'closed', railClosed: false,
    files: [], fileName: '', logLimit: 200
});

test('the settings screen shows both execution blocks with their own status', () => {
    const html = shell(settingsView());
    assert.match(html, /data-key="flows"/, 'the flow panel exists');
    assert.match(html, /经典 DreamFlow/);
    assert.match(html, /完全自定义 DreamFlow/);
    assert.match(html, /data-flow="classic"/);
    assert.match(html, /data-flow="custom"/);
    // A blocked flow must show the reason, not just a coloured pill.
    assert.match(html, /原始入口授权与路由隔离尚未验证/);
    // The pill states a flow permission, not a promise that a Live run would start now.
    assert.match(html, /尚未连接/);
    assert.match(html, /模式配置可用/);
    assert.doesNotMatch(html, /Live 可跑/);
    // planner1 belongs to Dream Maker, not to either flow.
    assert.doesNotMatch(html, /角色 planner1/);
});

test('a payload without flows renders no empty block instead of a card full of blanks', () => {
    const html = shell(settingsView({ flows: undefined }));
    assert.doesNotMatch(html, /data-key="flows"/);
    assert.doesNotMatch(html, /DreamFlow-Laya（带 Laya）/);
});

test('the flow panel stays out of the public demo, which has no local flows', () => {
    const html = shell({ ...settingsView(), mode: 'public-demo' });
    assert.doesNotMatch(html, /data-key="flows"/);
});
