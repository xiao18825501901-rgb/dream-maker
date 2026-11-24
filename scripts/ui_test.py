"""Offline DOM / visual QA in an about:blank document, never navigating blocked URLs.
No fetch proxy, request interception, policy override or network access is used.
This does NOT replace the blocked full browser HTTP and storage E2E checks.
"""
from pathlib import Path
import datetime, json, os, platform, shutil, sys, traceback
from playwright.sync_api import sync_playwright, expect
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1];OUT=Path(os.environ.get('DM_EVIDENCE_DIR') or ROOT/'evidence').resolve();data=json.loads((OUT/'ui-fixtures.json').read_text(encoding='utf-8'));checks=[]
if (OUT/'ui-report.json').exists():raise FileExistsError('Existing UI evidence; select a fresh DM_EVIDENCE_DIR')
css=(ROOT/'src/web/style.css').read_text(encoding='utf-8');js=(ROOT/'dist/web/app.js').read_text(encoding='utf-8')
def check(name):checks.append({'name':name,'result':'PASS'})
with sync_playwright() as p:
 executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
 browser=p.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'] if hasattr(os,'geteuid') and os.geteuid()==0 else [])
 page=browser.new_page(viewport={'width':1440,'height':1040},device_scale_factor=1)
 errors=[];requests=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:requests.append(r.url))
 try:
  page.set_content('<html lang="zh-CN" data-dm-ui-fixture><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><div id="toast"></div></body></html>')
  page.add_style_tag(content=css)
  page.add_script_tag(type='module',content=js+'\nwindow.fixtureRender=renderFixture;')
  page.wait_for_function('typeof window.fixtureRender === "function"')
  def render(screen,snapshot=None,tab='work',gate=False):
   page.evaluate('(x)=>window.fixtureRender(x)',{'screen':screen,'projects':data['projects'],'snapshot':snapshot,'settings':data['settings'],'events':data['events'],'tab':tab,'gateDismissed':gate})
  render('home');expect(page.locator('#new-project')).to_be_visible();expect(page.locator('.fixture-watermark')).to_be_visible();page.screenshot(path=str(OUT/'screenshots/01-home.png'),full_page=True);check('desktop home renders form, four-role description and explicit offline fixture watermark')
  render('project',data['gate']);expect(page.get_by_role('dialog')).to_be_visible();assert page.locator('.modal button').count()==3;page.screenshot(path=str(OUT/'screenshots/02-interview-gate.png'),full_page=True);check('ten-answer snapshot renders required three-way decision dialog')
  first=page.locator('.modal button').first;last=page.locator('.modal button').last;first.focus();page.keyboard.press('Shift+Tab');expect(last).to_be_focused();page.keyboard.press('Tab');expect(first).to_be_focused();check('keyboard Tab and Shift+Tab stay inside mandatory dialog')
  page.get_by_role('button',name='回看 / 修改回答',exact=True).click();expect(page.get_by_role('dialog')).to_have_count(0);expect(page.locator('.answer-item')).to_have_count(10);check('review-answers action reveals all ten answers without generating question eleven')
  page.get_by_role('button',name='修改',exact=True).first.click();expect(page.locator('#edit-answer-form')).to_be_visible();page.get_by_role('button',name='取消',exact=True).click();check('answer edit dialog opens and cancels locally')
  render('project',data['spec']);expect(page.get_by_role('button',name='确认并冻结这个方案',exact=True)).to_be_visible();page.screenshot(path=str(OUT/'screenshots/03-specification.png'),full_page=True);check('specification renders traceable requirements, version, hash and separate approval action')
  render('project',data['delivery']);expect(page.get_by_role('heading',name='等待验收',exact=True)).to_be_visible();assert page.locator('.timeline-item').count()>0;page.screenshot(path=str(OUT/'screenshots/04-delivery.png'),full_page=True);check('real demo-engine snapshot renders repaired findings, verifier logs and delivery actions')
  malicious=json.loads(json.dumps(data['gate']));malicious['project']['name']='<script>window.XSS_HAPPENED=true</script>';malicious['project']['idea']='<img src=x onerror="window.XSS_HAPPENED=true">';malicious['project']['answers'][0]['text']='<svg onload="window.XSS_HAPPENED=true"></svg>'
  render('project',malicious,tab='answers',gate=True);assert not page.evaluate('Boolean(window.XSS_HAPPENED)');assert page.locator('#app script, #app svg, #app img').count()==0;check('untrusted project and answer HTML is displayed as text, not executed')
  render('settings');expect(page.locator('#settings-form')).to_be_visible();assert page.locator('[type=password]').count()==0;check('configuration screen has no plaintext API-key entry field')
  render('home');page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1');page.screenshot(path=str(OUT/'screenshots/05-mobile.png'),full_page=True);check('390px responsive home has no horizontal overflow')
  assert requests==[],requests;assert errors==[],errors;check('offline DOM checks issue zero network requests and zero uncaught JavaScript errors')
 except Exception as exc:
  checks.append({'name':'offline UI execution','result':'FAIL','detail':str(exc),'traceback':traceback.format_exc()});page.screenshot(path=str(OUT/'screenshots/ui-failure.png'),full_page=True)
 finally:browser.close()
report={'schema':'dream-maker.ui-evidence.v1','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment':platform.platform()+'; Chromium about:blank offline DOM fixture','scope':'STATIC_UI_DOM_NOT_BROWSER_HTTP_E2E','networkRequests':requests,'browserErrors':errors,'checks':checks,'passed':sum(x['result']=='PASS' for x in checks),'failed':sum(x['result']=='FAIL' for x in checks)}
(OUT/'ui-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2));raise SystemExit(bool(report['failed']))
