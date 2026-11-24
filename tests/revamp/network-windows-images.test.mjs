// Classification only, not permission/role qualification or launching desktop binaries.
import test from 'node:test';import assert from 'node:assert/strict';import * as observer from '../../dist/server/network-context-observer.js';
test('development Codex includes the actual desktop-managed bin directory without borrowing product Codex',()=>{
 assert.equal(typeof observer.isDevelopmentCodexImage,'function');
 assert.equal(observer.isDevelopmentCodexImage('C:\\Users\\Hp\\AppData\\Local\\OpenAI\\Codex\\bin\\22cfb1d302613eae\\codex.exe'),true);
 assert.equal(observer.isDevelopmentCodexImage('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1_x64__p2\\app\\Codex.exe'),true);
 assert.equal(observer.isDevelopmentCodexImage('F:\\DreamMakerSuite\\runtime\\codex\\codex.exe'),false);
 assert.equal(observer.isDevelopmentCodexImage('C:\\OtherProject\\codex.exe'),false);
});
