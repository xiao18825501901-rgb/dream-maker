import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const [dreamMakerUrl, dreamFlowUrl, outputArg] = process.argv.slice(2);
if (!dreamMakerUrl || !dreamFlowUrl || !outputArg) {
  throw new Error('usage: hallmark-browser-audit.mjs <dream-maker-url> <dream-flow-url> <output-dir>');
}

const puppeteerRoot = process.env.HALLMARK_PUPPETEER;
const chromePath = process.env.CHROME_PATH;
if (!puppeteerRoot || !chromePath) {
  throw new Error('HALLMARK_PUPPETEER and CHROME_PATH are required');
}

const requireFromTool = createRequire(resolve(puppeteerRoot, 'package.json'));
const puppeteer = requireFromTool('puppeteer-core');
const output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const shots = resolve(output, 'shots');
mkdirSync(shots, { recursive: true });

const report = {
  schema: 'dream-maker.hallmark-browser-audit.v1',
  evidenceClass: 'REAL_BROWSER_LOCAL_HTTP_DEMO_UI_NOT_LIVE_AGENT',
  startedAt: new Date().toISOString(),
  products: {},
  checks: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  httpErrors: [],
  layoutFailures: [],
};

const safeName = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const redactUrl = value => value.replace(/bootstrap=[^&#]+/g, 'bootstrap=[redacted]');
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function waitForIdle(page) {
  await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false', { timeout: 20000 });
  await sleep(150);
}

async function capture(page, product, name, checks = report.checks) {
  await waitForIdle(page);
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const path = resolve(shots, `${product}-${String(checks.length + 1).padStart(2, '0')}-${safeName(name)}.png`);
  await page.screenshot({ path, fullPage: true });
  const facts = await page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const svgs = [...document.querySelectorAll('svg')].filter(visible);
    const badSvg = svgs.filter(svg => {
      const style = getComputedStyle(svg);
      return style.fill !== 'none' || style.stroke === 'none';
    }).length;
    const unnamedButtons = [...document.querySelectorAll('button')].filter(visible).filter(button =>
      !(button.getAttribute('aria-label') || button.textContent || '').trim()).length;
    const navLabels = [...document.querySelectorAll('button.nav-button > span')].filter(visible).map(span => {
      const rect = span.getBoundingClientRect();
      return { text: span.textContent.trim(), width: Math.round(rect.width), fontSize: getComputedStyle(span).fontSize };
    });
    const layoutFailures = [];
    for (const badge of document.querySelectorAll('.project-heading > .pill')) {
      if (!visible(badge)) continue;
      const probe = badge.cloneNode(true);
      Object.assign(probe.style, { position: 'fixed', width: 'max-content', maxWidth: 'none', visibility: 'hidden' });
      document.body.append(probe);
      const expected = Math.min(probe.getBoundingClientRect().width, innerWidth - 40);
      const width = badge.getBoundingClientRect().width;
      probe.remove();
      if (width + 1 < expected) layoutFailures.push({ kind: 'PINCHED_PROJECT_STATUS', width, expected });
    }
    for (const id of ['user-runtime', 'user-data']) {
      const control = document.getElementById(id);
      const label = document.querySelector(`label[for="${id}"]`);
      if (!control || !label || !visible(control)) continue;
      const inputBox = control.getBoundingClientRect(), labelBox = label.getBoundingClientRect();
      if (Math.abs(inputBox.left - labelBox.left) > 1 || inputBox.top + 1 < labelBox.bottom) {
        layoutFailures.push({ kind: 'DETACHED_FORM_LABEL', id });
      }
    }
    for (const value of document.querySelectorAll('.context-rail .metrics dd')) {
      if (visible(value) && value.getBoundingClientRect().width < 120) {
        layoutFailures.push({ kind: 'CRUSHED_RAIL_TEXT', width: value.getBoundingClientRect().width });
      }
    }
    for (const button of [...document.querySelectorAll('button')].filter(visible)) {
      const box = button.getBoundingClientRect();
      if (box.height < 43.5) layoutFailures.push({ kind: 'SMALL_ACTION_TARGET', action: button.dataset.action || button.type, height: box.height });
    }
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      const box = dialog.getBoundingClientRect();
      if (box.left < -1 || box.right > innerWidth + 1 || box.top < -1 || box.bottom > innerHeight + 1 || dialog.scrollWidth > dialog.clientWidth + 1) {
        layoutFailures.push({ kind: 'DIALOG_OUTSIDE_VIEWPORT' });
      }
    }
    return {
      url: location.pathname,
      title: document.querySelector('main h1')?.textContent?.trim() || '',
      viewport: { width: innerWidth, height: innerHeight },
      scroll: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      },
      svg: { count: svgs.length, bad: badSvg },
      unnamedButtons,
      navLabels,
      layoutFailures,
    };
  });
  checks.push({ product, name, path, ...facts });
  report.layoutFailures.push(...facts.layoutFailures.map(failure => ({ product, name, viewport: facts.viewport, ...failure })));
  if (facts.viewport.width >= 768) {
    await page.setViewport({ width: 320, height: 812, deviceScaleFactor: 1 });
    await capture(page, product, `${name}-narrow`, checks);
    await page.setViewport({ ...facts.viewport, deviceScaleFactor: 1 });
  }
}

async function clickAction(page, action) {
  const selector = `[data-action="${action}"]`;
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.click(selector);
  await waitForIdle(page);
}

async function captureNavigation(page, product) {
  for (const [action, name] of [
    ['settings', 'settings'],
    ['setup', 'setup'],
    ['fees', 'fees'],
    ['maintenance', 'maintenance'],
    ['help', 'help'],
  ]) {
    await clickAction(page, action);
    await capture(page, product, name);
  }
  await clickAction(page, 'home');
  await capture(page, product, 'home-with-project');
}

async function openProduct(browser, url, product) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push({ product, text: message.text() });
  });
  page.on('pageerror', error => report.pageErrors.push({ product, text: String(error) }));
  page.on('requestfailed', request => report.requestFailures.push({
    product,
    path: request.url().replace(/bootstrap=[^&#]+/g, 'bootstrap=[redacted]'),
    failure: request.failure()?.errorText || 'unknown',
    benignNavigationAbort: request.failure()?.errorText === 'net::ERR_ABORTED' &&
      new URL(request.url()).pathname.endsWith('/events'),
  }));
  page.on('response', async response => {
    if (response.status() < 400) return;
    let body = '';
    try {
      body = (await response.text()).slice(0, 600);
    } catch {
      body = '[unavailable]';
    }
    report.httpErrors.push({
      product,
      status: response.status(),
      method: response.request().method(),
      path: redactUrl(response.url()),
      body,
    });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#app[aria-busy="false"]', { timeout: 20000 });
  await waitForIdle(page);
  return page;
}

async function auditDreamMaker(browser, url) {
  const product = 'dream-maker';
  const page = await openProduct(browser, url, product);
  await capture(page, product, 'home');

  await page.focus('#project-name');
  await page.keyboard.press('Tab');
  const focusProbe = await page.evaluate(() => {
    const element = document.activeElement;
    const style = element instanceof Element ? getComputedStyle(element) : null;
    return { tag: element?.tagName || '', id: element?.id || '', outline: style?.outlineStyle || '' };
  });
  report.checks.push({ product, name: 'keyboard-focus-probe', ...focusProbe });

  await page.type('#project-name', 'Hallmark 验收项目');
  await page.type('#idea', '记录中文任务，完成后仍能在刷新后回看。');
  await page.select('#mode', 'demo');
  await page.click('#new-project button[type=submit]');
  await page.waitForSelector('#answer', { visible: true, timeout: 20000 });
  await capture(page, product, 'grill-me');

  for (let index = 1; index <= 10; index += 1) {
    await page.type('#answer', `第 ${index} 个回答：使用本地保存，状态清楚，结果可以验证。`);
    await page.click('#answer-form button[type=submit]');
    await waitForIdle(page);
  }
  await page.waitForSelector('#dm-dialog [data-action="finish"]', { visible: true, timeout: 20000 });
  await capture(page, product, 'interview-decision');
  await page.click('#dm-dialog [data-action="finish"]');
  await waitForIdle(page);
  await capture(page, product, 'project-spec');

  for (const [tab, name] of [
    ['answers', 'answers'],
    ['research', 'research'],
    ['spec', 'spec'],
    ['history', 'history'],
    ['flow', 'dreamflow'],
    ['laya', 'laya'],
    ['report', 'reviewer-report'],
    ['followup', 'followup'],
    ['files', 'delivery'],
    ['logs', 'logs'],
  ]) {
    await page.click(`#tab-${tab}`);
    await waitForIdle(page);
    await capture(page, product, name);
  }

  await captureNavigation(page, product);
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 1 });
  await capture(page, product, 'home-mobile');
  await page.close();
}

async function fillUserPlan(page) {
  await page.type('#project-name', 'Hallmark 方案工作台验收');
  const values = new Map([
    ['#user-goal', '制作一个可离线保存的中文任务清单。'],
    ['#user-requirements', '新增任务\n完成任务\n刷新后保留'],
    ['#user-acceptance', '打开页面可新增任务\n完成后有明确状态\n刷新后任务仍在'],
    ['#user-approach', '本地页面\n本地持久化\n固定样例数据'],
    ['#user-runtime', 'Windows 本机浏览器'],
    ['#user-data', '浏览器本地保存，不连接云端。'],
    ['#user-steps', '整理要求\n制作页面\n核对数据保存'],
    ['#user-use', '双击本地启动脚本，在浏览器中使用。'],
  ]);
  for (const [selector, value] of values) {
    await page.type(selector, value);
  }
  await page.select('#user-plan-mode', 'demo');
}

async function auditDreamFlow(browser, url) {
  const product = 'dreamflow';
  const page = await openProduct(browser, url, product);
  await capture(page, product, 'home');
  await fillUserPlan(page);
  await capture(page, product, 'plan-form-filled');

  const projectNameBefore = await page.$eval('#project-name', input => input.value);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForIdle(page);
  const projectNameAfter = await page.$eval('#project-name', input => input.value);
  report.checks.push({
    product,
    name: 'draft-survives-reload',
    expected: projectNameBefore,
    actual: projectNameAfter,
    preserved: projectNameBefore === projectNameAfter,
  });

  await page.click('#user-plan-form button[type=submit]');
  await page.waitForSelector('.project-heading', { visible: true, timeout: 20000 });
  await capture(page, product, 'project-work');
  for (const [tab, name] of [
    ['spec', 'spec'],
    ['history', 'history'],
    ['flow', 'dreamflow'],
    ['laya', 'laya'],
    ['report', 'reviewer-report'],
    ['followup', 'followup'],
    ['files', 'delivery'],
    ['logs', 'logs'],
  ]) {
    await page.click(`#tab-${tab}`);
    await waitForIdle(page);
    await capture(page, product, name);
  }

  await captureNavigation(page, product);
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 1 });
  await capture(page, product, 'home-mobile');
  await page.close();
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  userDataDir: resolve(output, 'chrome-profile'),
});

let auditFailure;
try {
  await auditDreamMaker(browser, dreamMakerUrl);
  await auditDreamFlow(browser, dreamFlowUrl);
} catch (error) {
  auditFailure = error;
  report.failure = { name: error.name, message: redactUrl(error.message) };
} finally {
  await browser.close();
}

report.finishedAt = new Date().toISOString();
report.summary = {
  captures: report.checks.filter(check => check.path).length,
  horizontalOverflows: report.checks.filter(check => check.scroll?.horizontalOverflow).length,
  badSvgs: report.checks.filter(check => check.svg?.bad).length,
  unnamedButtons: report.checks.filter(check => check.unnamedButtons).length,
  consoleErrors: report.consoleErrors.length,
  pageErrors: report.pageErrors.length,
  requestFailures: report.requestFailures.length,
  criticalRequestFailures: report.requestFailures.filter(failure => !failure.benignNavigationAbort).length,
  httpErrors: report.httpErrors.length,
  layoutFailures: report.layoutFailures.length,
};
const interactionFailures = report.checks.filter(check =>
  (check.name === 'draft-survives-reload' && !check.preserved) ||
  (check.name === 'keyboard-focus-probe' && check.outline !== 'solid'));
report.result = auditFailure || interactionFailures.length ||
  ['horizontalOverflows', 'badSvgs', 'unnamedButtons', 'consoleErrors', 'pageErrors', 'criticalRequestFailures', 'httpErrors', 'layoutFailures'].some(key => report.summary[key] > 0)
  ? 'FAIL' : 'PASS';
writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ result: report.result, ...report.summary }));
if (report.result !== 'PASS') process.exitCode = 1;
