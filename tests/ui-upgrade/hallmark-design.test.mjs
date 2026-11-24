import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shell } from '../../dist/web/views.js';
import { userPlanHome } from '../../dist/web/user-plan-view.js';
import { DemoScenarioAdapter } from '../../dist/web/demo-api.js';

const state = async () => {
  const adapter = new DemoScenarioAdapter();
  await adapter.init();
  const snapshot = await adapter.request('/projects/sample-spec');
  const settings = await adapter.request('/config');
  return {
    mode: 'public-demo', product: 'dream-maker', screen: 'home', projects: [snapshot.project],
    snapshot: null, settings, tab: 'work', busy: false, error: '', events: [], connection: 'closed',
    railClosed: false, fileName: '', fileText: '', files: [], previewUrl: '', previewScope: '',
    diagnostics: '', specSearch: '', logLimit: 40, clash: null, draft: () => '', hasDraft: () => false
  };
};

test('the chat entry keeps the Hallmark sheet order on its compatibility branch without replacing business entries',()=>{
  for(const file of ['index.html','dreamflow.html']){
    const html = readFileSync(`src/web/${file}`, 'utf8');
    // The served page is now the chat shell: exactly one local sheet and one module entry.
    assert.equal((html.match(/<link[^>]*href="\/chat-shell\.css"/g)||[]).length,1,`${file} links the chat sheet once`);
    assert.match(html,/<script type="module" src="\/chat-entry\.js"><\/script>/,`${file} mounts the chat entry`);
    for(const legacy of ['/style.css','/tokens.css','/base.css','/hallmark.css'])assert.equal(html.includes(legacy),false,`${file} no longer inlines ${legacy}`);
    assert.doesNotMatch(html,/src="\/(?:app|dreamflow-app)\.js"/,`${file} no longer inlines a business controller`);
  }
  // The compatibility branch still appends the four sheets in their original order and still mounts the
  // real business entries, so the chat shell neither replaced nor retired the Hallmark chain.
  const entry = readFileSync('src/web/chat-entry.ts', 'utf8');
  const order = ['/style.css','/tokens.css','/base.css','/hallmark.css'].map(name => entry.indexOf(`'${name}'`));
  assert.ok(order.every((value,index) => value >= 0 && (index === 0 || value > order[index - 1])), 'legacy sheet order');
  assert.match(entry,/if\(document\.documentElement\.dataset\.product==='dreamflow'\)void import\('\.\/dreamflow-app\.js'\);else void import\('\.\/app\.js'\);/);
  const base = readFileSync('src/web/base.css', 'utf8');
  assert.match(base, /html,\s*body\s*\{\s*overflow-x:\s*clip;/);
  assert.match(base, /svg\s*\{[^}]*fill:\s*none;[^}]*stroke:\s*currentColor;/s);
  for(const file of ['tokens.css','base.css','hallmark.css']){
    assert.match(readFileSync(`src/web/${file}`,'utf8'), /^\/\* Hallmark ·/);
  }
  const hallmark = readFileSync('src/web/hallmark.css', 'utf8');
  assert.match(hallmark, /button\.nav-button > span\s*\{[^}]*width:\s*auto;[^}]*flex:\s*1 1 auto;/s);
  assert.match(hallmark, /button\.text-button\s*\{[^}]*font-size:\s*var\(--text-sm\);/s);
  assert.match(hallmark, /\.top-actions \.text-button\s*\{[^}]*font-size:\s*var\(--text-sm\);/s);
  assert.match(hallmark, /\.sidebar-foot > \.micro,[\s\S]*?font-size:\s*var\(--text-sm\);/);
  assert.match(hallmark, /\.empty\s*\{[^}]*padding:\s*var\(--space-xl\) var\(--space-md\);/s);
  assert.match(hallmark, /\.flow-entry-panel\s*\{[^}]*max-height:\s*calc\(100dvh - 7rem\);[^}]*overflow:\s*auto;/s);
});

test('the redesigned shell uses real SVG icons and keeps every navigation action',async()=>{
  const html = shell(await state()).replaceAll('&lt;','<').replaceAll('&gt;','>');
  for(const action of ['home','new','settings','team','rail']) assert.match(html, new RegExp(`data-action="${action}"`));
  assert.match(html, /<svg viewBox="0 0 24 24"/);
  for(const glyph of ['▦','⚙','＋','◇','☰']) assert.equal(html.includes(glyph), false, glyph);
});

test('standalone DreamFlow uses a split planning workbench without changing form contracts',async()=>{
  const html = userPlanHome({ ...(await state()), product: 'dreamflow', mode: 'local' });
  assert.match(html, /class="flow-intake-grid"/);
  assert.match(html, /id="user-plan-form"/);
  assert.match(html, /id="user-plan-import"/);
  assert.ok(html.indexOf('id="user-plan-import"') < html.indexOf('id="user-plan-form"'), 'import stays discoverable before the long intake form');
  for(const name of ['projectName','goal','requirements','acceptance','approach','runtime','data','steps','use','accounts','fees','mode']) {
    assert.match(html, new RegExp(`name="${name}"`), name);
  }
  assert.doesNotMatch(html, /kimiConsent|type="password"/);
});

test('Hallmark navigation has no decorative arrow suffix and records its renamed home heading',async()=>{
  const html=shell(await state());
  assert.doesNotMatch(html,/了解本地集成版 →|管理连接 →/);
  assert.match(readFileSync('src/web/hallmark.css','utf8'),/reworded "今天，你想做点什么？" to "新建一个项目"/);
});

test('a retired planner1 path is explained without mounting the live SIWC status panel',async()=>{
  const base = await state();
  const settings = {
    ...base.settings,
    planner1Retired: true,
    planner1Binding: {
      provider: 'siwc', runner: 'siwc-sdk', authMethod: 'siwc_plan', accountRef: '',
      model: 'legacy-model', policyHash: '', protocolHash: '', bindingVersion: 1,
    },
  };
  const html = shell({ ...base, mode: 'local', screen: 'settings', settings });
  assert.match(html, /旧套餐连接路径已退役/);
  assert.doesNotMatch(html, /id="siwc-local-panel"/);
});
