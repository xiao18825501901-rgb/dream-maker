import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Development-only bundler. The generated HTML has no module loader dependency,
// external fonts, CDN, server, fetch, model API, credentials or production state.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== '--output')) {
  throw new Error('Usage: node scripts/build-chat-preview.mjs [--output path/to/DM_DF_Chat_UI_Preview.html]');
}
const output = argv[1] ? resolve(process.cwd(), argv[1]) : resolve(root, 'preview/DM_DF_Chat_UI_Preview.html');
// Each module carries the specifier the bundle must answer, because some live outside
// src/web: chat-stages imports ../shared/role-names.js.
const modules = [
  { name: 'chat-types', source: 'src/web/chat-types.ts', specifier: './chat-types.js' },
  { name: 'dom', source: 'src/web/dom.ts', specifier: './dom.js' },
  { name: 'role-names', source: 'src/shared/role-names.ts', specifier: '../shared/role-names.js' },
  { name: 'chat-stages', source: 'src/web/chat-stages.ts', specifier: './chat-stages.js' },
  { name: 'chat-shell', source: 'src/web/chat-shell.ts', specifier: './chat-shell.js' },
  { name: 'chat-demo', source: 'src/web/chat-demo.ts', specifier: './chat-demo.js' },
];
const moduleNames = modules.map(item => item.name);
const manifest = { schema: 'dream-maker.chat-preview.v1', evidence: 'SYNTHETIC_UI_ONLY', modelCalls: 0, files: [] };
const hash = value => createHash('sha256').update(value).digest('hex');
const factories = modules.map(({ name, source, specifier }) => {
  const text = readFileSync(resolve(root, source), 'utf8');
  manifest.files.push({ path: source, sha256: hash(text) });
  const compiled = ts.transpileModule(text, {
    fileName: `${name}.ts`,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, removeComments: true, sourceMap: false },
    reportDiagnostics: true,
  });
  const errors = compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
  const imports = [...compiled.outputText.matchAll(/require\(["']([^"']+)["']\)/g)].map(match => match[1]);
  for (const imported of imports) if (!modules.some(item => imported === item.specifier)) {
    throw new Error(`Preview has an unexpected dependency: ${source} -> ${imported}`);
  }
  return `${JSON.stringify(specifier)}: function(module, exports, require) {\n${compiled.outputText}\n}`;
});
const script = `(() => {
  'use strict';
  const factories = {${factories.join(',\n')}};
  const cache = Object.create(null);
  function require(id) {
    if (!Object.hasOwn(factories, id)) throw new Error('Unknown local preview module');
    if (cache[id]) return cache[id].exports;
    const module = {exports:{}};
    cache[id] = module;
    factories[id](module, module.exports, require);
    return module.exports;
  }
  const {mountChatShell} = require('./chat-shell.js');
  const {createChatDemo} = require('./chat-demo.js');
  let shell;
  const product = new URLSearchParams(location.search).get('product') === 'df' ? 'df' : 'dm';
  const controller = createChatDemo(state => shell.render(state), product);
  shell = mountChatShell(document.getElementById('app'), controller);
  controller.start();
  window.addEventListener('pagehide', () => {controller.dispose(); shell.destroy();}, {once:true});
})();`;
if (/\b(fetch|EventSource|XMLHttpRequest|WebSocket)\s*\(/.test(script)) throw new Error('The standalone preview must not perform network requests.');
const css = readFileSync(resolve(root, 'src/web/chat-shell.css'), 'utf8');
manifest.files.push({ path: 'src/web/chat-shell.css', sha256: hash(css) });
// HTML parsers recognize end tags even inside JS/CSS strings. Escape them before
// embedding; all application text continues to be escaped by the shared view.
const safeScript = script.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const safeCss = css.replace(/<\/style/gi, '<\\/style');
const metadata = JSON.stringify(manifest).replace(/</g, '\\u003c');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'">
<title>Dream Maker / DreamFlow · 离线交互演示</title><link rel="icon" href="data:,">
<style>${safeCss}</style></head><body><div id="app"></div><noscript>请启用 JavaScript 体验离线交互。此文件不调用模型、不连接服务，也不修改真实项目。</noscript>
<script type="application/json" id="dm-preview-provenance">${metadata}</script>
<script>${safeScript}</script></body></html>\n`;
mkdirSync(dirname(output), {recursive:true});
writeFileSync(output, html);
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(html), sha256: hash(html), modules: moduleNames, network: 'DISABLED_BY_CSP', evidence: manifest.evidence }));
