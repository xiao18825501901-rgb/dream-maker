import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { defaults } from '../../dist/server/config.js';

const suite = 'F:/DreamMakerSuite';
const root = join(suite, 'worktrees/kimi-p1-v1');
const stamp = Date.now();
const evidence = join(suite, `evidence/M107/browser-laya-probe-${stamp}`);
const data = join(suite, `temp/M107-browser-laya-${stamp}`);
const profile = join(suite, `temp/M107-browser-profile-${stamp}`);
await mkdir(evidence, { recursive: true });
await mkdir(data, { recursive: true });
await mkdir(profile, { recursive: true });

const { chromium } = await import(pathToFileURL(join(suite, 'runtime/browser-tools/node_modules/playwright/index.mjs')).href);
const checks = [];
const requests = [];
const consoleErrors = [];
const pageErrors = [];
const apiResponses = [];
let appProcess;
let browser;
let laya;

const passed = name => checks.push({ name, result: 'PASS' });
const waitForExit = child => new Promise(resolve => {
  if (child.exitCode !== null) return resolve();
  child.once('exit', resolve);
  child.kill();
});

try {
  laya = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, status: 'ok', cookie: 'MUST_NOT_RENDER' }));
    } else if (req.url === '/info') {
      res.end(JSON.stringify({
        revision: 'browser-fixture-revision',
        tokenizer: 'browser-fixture-tokenizer',
        device: 'cpu',
        Authorization: 'Bearer MUST_NOT_RENDER'
      }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve, reject) => {
    laya.once('error', reject);
    laya.listen(0, '127.0.0.1', resolve);
  });
  const config = structuredClone(defaults);
  config.laya.baseUrl = `http://127.0.0.1:${laya.address().port}`;
  config.laya.mode = 'off';
  config.laya.expectedRevision = 'browser-fixture-revision';
  await writeFile(join(data, 'config.json'), JSON.stringify(config));

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE'].includes(key.toUpperCase())));
  Object.assign(env, {
    TEMP: join(suite, 'temp'),
    TMP: join(suite, 'temp'),
    TMPDIR: join(suite, 'temp')
  });
  appProcess = spawn(process.execPath, [join(root, 'tests/fixtures/browser-server.mjs'), data], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const startup = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('APP_START_TIMEOUT')), 20000);
    appProcess.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      const line = stdout.split(/\r?\n/).find(Boolean);
      if (!line) return;
      try {
        const value = JSON.parse(line);
        clearTimeout(timer);
        resolve(value);
      } catch {
        // Keep collecting until the complete first JSON line arrives.
      }
    });
    appProcess.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    appProcess.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`APP_EXITED_${code}:${stderr}`));
    });
  });

  browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--disable-background-networking', '--no-first-run', `--disk-cache-dir=${join(profile, 'cache')}`],
    env
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, acceptDownloads: false });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === new URL(startup.origin).origin ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('response', response => {
    if (!response.url().includes('/api/')) return;
    void response.text().then(text => apiResponses.push({
      method: response.request().method(),
      path: new URL(response.url()).pathname,
      status: response.status(),
      body: text.slice(0, 1000)
    })).catch(() => {});
  });
  await page.goto(startup.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.locator('#new-project').waitFor({ state: 'visible', timeout: 20000 });
  if (page.url().includes('bootstrap=')) throw new Error('BOOTSTRAP_REMAINED_IN_URL');
  passed('正式本地页面完成会话引导且未把一次性口令留在地址栏');

  await page.locator('[data-action=settings]').first().click();
  await page.locator('details.advanced-settings > summary').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('details.advanced-settings > summary').click();
  await page.getByRole('heading', { name: '可选本地 Laya' }).waitFor({ state: 'visible', timeout: 15000 });
  passed('设置页可打开可选 Laya 区域');

  const probeButton = page.locator('[data-action=laya-probe]');
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-action=laya-probe]');
    const app = document.querySelector('#app');
    return button instanceof HTMLButtonElement && !button.disabled && app?.getAttribute('aria-busy') === 'false';
  }, null, { timeout: 15000 });
  await probeButton.evaluate(element => {
    globalThis.__dmLayaProbeClicks = 0;
    element.addEventListener('click', () => { globalThis.__dmLayaProbeClicks += 1; });
  });
  await page.evaluate(() => {
    document.addEventListener('click', event => {
      globalThis.__dmLayaClickObservation = {
        defaultPrevented: event.defaultPrevented,
        ariaBusyAtEnd: document.querySelector('#app')?.getAttribute('aria-busy')
      };
    });
  });
  await probeButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const result = page.locator('[data-key=laya-probe-result]');
  try {
    await result.getByText('服务已响应', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  } catch (error) {
    const clicks = await page.evaluate(() => globalThis.__dmLayaProbeClicks);
    const observation = await page.evaluate(() => globalThis.__dmLayaClickObservation);
    throw new Error(`LAYA_PANEL_NOT_UPDATED:clicks=${clicks}:observation=${JSON.stringify(observation)}:${(await result.innerText().catch(() => '')).slice(0, 1200)}:${JSON.stringify(apiResponses)}:${String(error)}`);
  }
  await result.getByText('HTTP 可达', { exact: false }).waitFor({ state: 'visible', timeout: 15000 });
  await result.getByText('browser-fixture-revision', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  await result.getByText('与当前预期一致', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const text = await result.innerText();
  if (text.includes('MUST_NOT_RENDER') || text.includes('Authorization') || text.includes('cookie'))
    throw new Error('RAW_SERVICE_FIELDS_RENDERED');
  passed('页面只显示安全摘要、revision 对账和 HTTP-only 边界');

  const screenshot = join(evidence, 'laya-settings-probe.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  const unexpectedConsoleErrors = consoleErrors.filter(message => !message.includes('409 (Conflict)'));
  if (pageErrors.length || unexpectedConsoleErrors.length) throw new Error('BROWSER_PAGE_ERRORS');
  if (JSON.stringify([...requests].sort()) !== JSON.stringify(['/health', '/info']))
    throw new Error(`UNEXPECTED_LAYA_REQUESTS:${JSON.stringify(requests)}`);
  passed('真实浏览器触发且仅触发本机 /health 与 /info');

  const screenshotSha256 = createHash('sha256').update(await readFile(screenshot)).digest('hex');
  await writeFile(join(evidence, 'report.json'), JSON.stringify({
    schema: 'dream-maker.laya-probe-browser.v1',
    status: 'PASS_BROWSER_HTTP_LOOPBACK_ONLY_NOT_MODEL_QUALITY',
    recordedAt: new Date().toISOString(),
    urlOrigin: startup.origin,
    checks,
    requests,
    apiResponses,
    consoleErrors,
    pageErrors,
    screenshot,
    screenshotSha256,
    modelCalls: 0,
    oauthAttempts: 0,
    networkSettingsChanged: false
  }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence, screenshot, screenshotSha256 }));
  await context.close();
} catch (error) {
  await writeFile(join(evidence, 'report.json'), JSON.stringify({
    schema: 'dream-maker.laya-probe-browser.v1',
    status: 'FAIL',
    recordedAt: new Date().toISOString(),
    checks,
    requests,
    apiResponses,
    consoleErrors,
    pageErrors,
    error: String(error?.message ?? error),
    modelCalls: 0,
    oauthAttempts: 0,
    networkSettingsChanged: false
  }, null, 2));
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (appProcess) await waitForExit(appProcess);
  if (laya) await new Promise(resolve => laya.close(resolve));
  await rm(data, { recursive: true, force: true }).catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
