"""Fresh real-HTTP UI fault/accessibility checks. Fixed Demo only, no model calls."""
from pathlib import Path
import datetime
import json
import math
import os
import platform
import subprocess
import sys
import tempfile
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/ui-upgrade/evidence/runs' / ('boundaries-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
OUT.mkdir(parents=True)
DATA = ROOT / '.runtime/ui-browser-boundaries'
DATA.mkdir(parents=True, exist_ok=True)
checks, console, failures, page_errors = [], [], [], []
proc = None


def passed(name, **detail):
    checks.append({'name': name, 'result': 'PASS', **detail})


def idle(page):
    expect(page.locator('#app')).to_have_attribute('aria-busy', 'false', timeout=15000)


def state(page):
    return page.evaluate("async()=>{const id=new URLSearchParams(location.search).get('project');return await (await fetch('/api/projects/'+id)).json();}")


def create(page, name):
    page.locator('.primary-nav [data-action=home]').click()
    page.locator('#project-name').fill(name)
    page.locator('#idea').fill('中文任务与持久化；这是固定 Demo 验收数据。')
    page.locator('#new-project button[type=submit]').click()
    idle(page)
    expect(page.locator('#answer')).to_be_visible()
    return state(page)['project']['id']


def stop():
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=12)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


try:
    with tempfile.TemporaryDirectory(prefix='http-', dir=DATA) as runtime:
        env = {k: v for k, v in os.environ.items() if k.upper() in ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG']}
        proc = subprocess.Popen(['node', str(ROOT / 'tests/fixtures/browser-server.mjs'), runtime], cwd=ROOT,
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            info = json.loads(proc.stdout.readline())
            with sync_playwright() as pw:
                browser = pw.chromium.launch(executable_path=os.environ['CHROMIUM_PATH'], headless=True)
                context = browser.new_context(viewport={'width': 1440, 'height': 1040})
                page = context.new_page()
                page.set_default_timeout(12000)
                page.on('console', lambda m: console.append(m.text) if m.type == 'error' else None)
                page.on('pageerror',lambda error:page_errors.append(str(error)))
                page.on('requestfailed', lambda r: failures.append({'url': r.url.split('#')[0], 'failure': r.failure}))
                page.goto(info['url'], wait_until='domcontentloaded')
                for width in [320, 375, 768, 1024, 1440]:
                    page.set_viewport_size({'width': width, 'height': 980})
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                    expect(page.locator('#new-project button[type=submit]')).to_be_visible()
                    page.screenshot(path=str(OUT / f'http-home-{width}.png'), full_page=True)
                passed('real HTTP layouts at 320/375/768/1024/1440 preserve primary controls')
                page.keyboard.press('Tab')
                assert page.evaluate('document.activeElement!==document.body')
                passed('keyboard focus reaches a named control')

                sse = []
                def drop_first(route):
                    sse.append(route.request.url)
                    if len(sse) == 1:
                        route.abort('connectionreset')
                    else:
                        route.continue_()
                page.route('**/events?after=0', drop_first)
                first = create(page, '输入法与重连')
                page.locator('#tab-logs').click()
                expect(page.get_by_text('事件流已连接', exact=True)).to_be_visible(timeout=15000)
                assert len(sse) >= 2
                passed('real EventSource reconnects after a scoped injected connection reset', attempts=len(sse))
                page.unroute('**/events?after=0', drop_first)
                page.locator('#tab-work').click()
                page.locator('#answer').fill('中文组合输入草稿')
                page.locator('#answer').dispatch_event('compositionstart')
                page.locator('#answer').press('Control+Enter')
                assert len(state(page)['project']['answers']) == 0
                page.locator('#answer').dispatch_event('compositionend')
                page.reload(wait_until='domcontentloaded')
                expect(page.locator('#answer')).to_have_value('中文组合输入草稿')
                passed('IME composition does not submit; actual sessionStorage restores Chinese draft')
                page.locator('#answer-form button[type=submit]').click()
                idle(page)
                assert state(page)['project']['answers'][0]['text'] == '中文组合输入草稿'

                second = create(page, '迟到响应不得覆盖')
                page.locator('.primary-nav [data-action=home]').click()
                held = []
                def hold(route):
                    held.append(route)
                page.route('**/api/projects/' + first, hold)
                page.locator(f'.project-card[data-id="{first}"]').click()
                page.wait_for_timeout(100)
                assert held
                page.locator('.primary-nav [data-action=home]').click()
                page.locator(f'.project-card[data-id="{second}"]').click()
                expect(page.locator('.project-heading h1')).to_have_text('迟到响应不得覆盖')
                for route in held:
                    route.continue_()
                page.unroute('**/api/projects/' + first, hold)
                page.wait_for_timeout(500)
                expect(page.locator('.project-heading h1')).to_have_text('迟到响应不得覆盖')
                passed('delayed real HTTP read for previous project cannot replace selected project')

                page.locator('main [data-action=finish]').click()
                idle(page)
                page.locator('[data-action=approve]').click()
                idle(page)
                assert state(page)['project']['state'] == 'READY_TO_BUILD'
                page.locator('#tab-answers').click()
                # The first project has a real saved answer; revise it after its own approval.
                page.locator('.primary-nav [data-action=home]').click()
                page.locator(f'.project-card[data-id="{first}"]').click()
                page.locator('main [data-action=finish]').click()
                idle(page)
                page.locator('[data-action=approve]').click()
                idle(page)
                page.locator('#tab-answers').click()
                page.locator('[data-action=edit-answer]').first.click()
                page.locator('#edited-answer').fill('修订真实 HTTP 中已保存的原话')
                page.locator('#edit-answer-form button[type=submit]').click()
                idle(page)
                revised=state(page)
                assert revised['spec'] is None and revised['project']['specId'] is None and revised['project']['state'] == 'INTERVIEWING'
                passed('answer revision invalidates frozen specification and prior approval on server')

                page.emulate_media(reduced_motion='reduce')
                page.set_viewport_size({'width':768,'height':1040})
                page.locator('[data-action=team]').click()
                expect(page.locator('#dm-dialog')).to_be_visible()
                assert page.evaluate("parseFloat(getComputedStyle(document.querySelector('#dm-dialog')).transitionDuration)===0")
                page.keyboard.press('Tab')
                assert page.evaluate("document.querySelector('#dm-dialog').contains(document.activeElement)")
                page.locator('#dm-dialog [data-action=close-modal]').click()
                passed('real HTTP reduced-motion dialog has no transition and retains keyboard focus')
                page.set_viewport_size({'width':1440,'height':1040})

                cancel = create(page, '取消检查')
                page.locator('main [data-action=finish]').click()
                idle(page)
                page.locator('[data-action=approve]').click()
                idle(page)
                page.locator('[name=buildConsent]').check()
                page.locator('#build-form button[type=submit]').click()
                idle(page)
                page.locator('[data-action=cancel]').click()
                page.locator('#dm-dialog [data-action=confirm-cancel]').click()
                idle(page)
                expect(page.locator('.run-summary h2')).to_have_text('已取消', timeout=15000)
                assert state(page)['runs'][0]['state'] == 'CANCELLED'
                passed('cancel awaits real owned-worker cleanup without deleting project')

                create(page, '失败门禁检查')
                page.locator('.primary-nav [data-action=settings]').click()
                expect(page.locator('#settings-form')).to_be_visible()
                page.locator('[name=maxRepairs]').fill('0')
                page.locator('#settings-form button[type=submit]').click()
                idle(page)
                page.locator('.primary-nav [data-action=home]').click()
                page.locator('.project-card').filter(has_text='失败门禁检查').click()
                page.locator('main [data-action=finish]').click()
                idle(page)
                page.locator('[data-action=approve]').click()
                idle(page)
                page.locator('[name=buildConsent]').check()
                page.locator('[name=demoFault]').check()
                page.locator('#build-form button[type=submit]').click()
                idle(page)
                expect(page.locator('.run-summary h2')).to_have_text('需要处理', timeout=30000)
                assert state(page)['runs'][0]['reason'] == 'REPAIR_LIMIT'
                passed('real verifier failure plus zero repair budget stays blocked, not accepted')
                own_session=context.storage_state()
                browser.close()

                # Dedicated temporary profile and browser-native zoom API, no policy override.
                profile = Path(runtime) / 'zoom-profile'
                (profile / 'Default').mkdir(parents=True)
                extension=ROOT/'scripts/ui-upgrade/zoom-probe'
                zoom = pw.chromium.launch_persistent_context(str(profile), executable_path=os.environ['CHROMIUM_PATH'],
                    headless=True,no_viewport=True,args=['--window-size=1440,1040','--load-extension='+str(extension)],ignore_default_args=['--disable-extensions'])
                zoom.add_cookies(own_session['cookies'])
                zp = zoom.pages[0]
                zp.goto(info['origin'], wait_until='domcontentloaded')
                expect(zp.locator('#new-project')).to_be_visible()
                worker=zoom.service_workers[0] if zoom.service_workers else zoom.wait_for_event('serviceworker',timeout=10000)
                actual_zoom=worker.evaluate('origin=>self.zoomOwnedTab(origin)',info['origin'])
                zp.wait_for_function('devicePixelRatio>1.9')
                metrics = zp.evaluate('({dpr:devicePixelRatio,width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert actual_zoom==2 and abs(metrics['dpr']-2) < .01, metrics
                assert metrics['scroll'] <= metrics['width']+1, metrics
                zp.screenshot(path=str(OUT/'http-native-zoom-200.png'), full_page=True)
                passed('Chrome native 200% tabs zoom verified with DPR 2 and no horizontal overflow', metrics=metrics,tabsZoom=actual_zoom)
                zoom.close()
                assert not page_errors,page_errors
                assert all('net::ERR_CONNECTION_RESET' in item for item in console),console
                assert all('/events?' in item['url'] and item['failure'] in ['net::ERR_CONNECTION_RESET','net::ERR_ABORTED'] for item in failures),failures
                passed('only intentional SSE reset and subscription closure errors observed; no uncaught JS')
        finally:
            stop()
except Exception as exc:
    checks.append({'name':'HTTP boundary sequence','result':'FAIL','detail':str(exc)})
finally:
    stop()
    report = {'schema':'dream-maker.ui-http-boundaries.v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'platform':platform.platform(),'checks':checks,'consoleErrors':console,'requestFailures':failures,'pageErrors':page_errors,
              'injectedFault':'one EventSource connection reset only','policyModified':False,'liveAgent':'NOT_RUN'}
    (OUT/'browser-http-boundaries.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    sys.exit(1 if any(c['result']=='FAIL' for c in checks) else 0)
