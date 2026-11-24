"""Interactive OFFLINE DOM tests on about:blank, with synthetic adapter and a memory storage fixture.
Not a proxy to a website, not an HTTP/local/Live E2E test. Browser policies remain untouched.
"""
from pathlib import Path
import json,re,os,shutil,traceback,datetime,sys,platform
from playwright.sync_api import sync_playwright,expect
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[2]
OUT=Path(os.environ.get('DM_UI_EVIDENCE_DIR',ROOT/'docs/ui-upgrade/evidence/runs'/('offline-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')))).resolve()
if not OUT.is_relative_to(ROOT/'docs/ui-upgrade/evidence'):raise SystemExit('Evidence must stay inside UI evidence directory')
OUT.mkdir(parents=True,exist_ok=True)
checks=[];errors=[];requests=[];phase='boot';browser=None
html=(ROOT/'dist/web/index.html').read_text(encoding='utf-8');html=re.sub(r'<script[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html)
html=html.replace('</head>','<style>'+(ROOT/'dist/web/style.css').read_text(encoding='utf-8')+'</style></head>')
html=html.replace('</body>','<div class="fixture-watermark">OFFLINE UI · 合成场景 · 非网络端到端测试</div></body>')
def ok(name,detail=''):checks.append({'name':name,'result':'PASS','detail':detail})
def idle(page):expect(page.locator('#app')).to_have_attribute('aria-busy','false')
def current(page):return page.evaluate('dmTest.ui.v.snapshot')
def run_state(page,state):expect(page.locator('.run-summary h2')).to_have_text(state)
def snap(page,name):
 page.evaluate('window.scrollTo(0,0)')
 page.screenshot(path=str(OUT/name),full_page=True,animations='disabled')
try:
 with sync_playwright() as pw:
  exe=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
  browser=pw.chromium.launch(**({'executable_path':exe} if exe else {}),headless=True,args=['--no-sandbox'] if hasattr(os,'geteuid') and os.geteuid()==0 else [])
  page=browser.new_page(viewport={'width':1440,'height':1040},device_scale_factor=1);page.set_default_timeout(7000)
  page.on('pageerror',lambda x:errors.append(str(x)));page.on('request',lambda x:requests.append(x.url))
  page.set_content(html)
  # about:blank has no real origin storage. This fixture tests serialization/restore only.
  page.evaluate("""()=>{const data=new Map();Object.defineProperty(window,'sessionStorage',{configurable:true,value:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)}});} """)
  page.add_script_tag(content=(ROOT/'.runtime/ui-offline/offline-test-bundle.js').read_text(encoding='utf-8'));page.evaluate('dmTest.start()')
  expect(page.locator('.project-card')).to_have_count(3);expect(page.locator('#error-box')).not_to_be_visible()
  ok('B01 shared public UI boots three explicitly synthetic scenarios')
  page.locator('#project-name').fill('我的中文灵感：<项目>');page.locator('#idea').fill('希望记录中文任务；请保留原话，不把模型建议当用户答案。')
  page.locator('#idea').dispatch_event('compositionstart');page.locator('#idea').press('Control+Enter')
  expect(page.locator('.project-card')).to_have_count(3)
  page.locator('#idea').dispatch_event('compositionend');page.locator('#new-project button[type=submit]').click();idle(page)
  expect(page.locator('#answer')).to_be_visible();pid=current(page)['project']['id'];ok('B02 IME composition does not submit; explicit create works')
  answer=page.locator('#answer');answer.fill('输入中的中文草稿，不应被后台事件破坏。')
  page.evaluate("window._draftNode=document.querySelector('#answer');_draftNode.focus();_draftNode.setSelectionRange(3,8);window._scrollY=scrollY;")
  page.evaluate("dmTest.adapter.request('/projects/'+dmTest.ui.v.snapshot.project.id+'/next','POST',{})")
  page.wait_for_function('dmTest.ui.v.events.length>0 && !dmTest.ui.refreshTimer')
  assert page.evaluate("document.querySelector('#answer')===_draftNode && _draftNode.value.includes('输入中的') && _draftNode.selectionStart===3 && _draftNode.selectionEnd===8 && document.activeElement===_draftNode && scrollY===_scrollY")
  ok('B03 event refresh preserves same textarea, Chinese draft, focus, selection and scroll')
  page.locator('.primary-nav [data-action=home]').click();page.locator(f'.project-card[data-id="{pid}"]').click();expect(page.locator('#answer')).to_have_value('输入中的中文草稿，不应被后台事件破坏。')
  ok('B04 switch away and reopen restores draft through scoped storage fixture')
  page.locator('#answer-form button[type=submit]').dblclick();idle(page)
  assert len(current(page)['project']['answers'])==1
  ok('B05 double click produces one answer write')
  for i in range(1,10):
   expect(page.locator('#answer')).to_be_visible();page.locator('#answer').fill('第'+str(i+1)+'个合成测试回答：保留中文、可恢复、可验证。');page.locator('#answer-form button[type=submit]').click();idle(page)
  expect(page.locator('#dm-dialog')).to_be_visible();s=current(page)
  assert s['project']['state']=='AWAITING_INTERVIEW_DECISION' and len(s['project']['questions'])==10 and not s['runs']
  ok('B06 ten valid answers open gate; no next question/build')
  assert page.evaluate("document.querySelector('#dm-dialog').contains(document.activeElement)")
  page.keyboard.press('Shift+Tab');assert page.evaluate("document.querySelector('#dm-dialog').contains(document.activeElement)")
  page.keyboard.press('Tab');assert page.evaluate("document.querySelector('#dm-dialog').contains(document.activeElement)")
  snap(page,'review2-gate-1440.png');ok('B07 native dialog traps keyboard focus')
  page.keyboard.press('Escape');expect(page.locator('#dm-dialog')).not_to_be_visible();assert current(page)['project']['state']=='AWAITING_INTERVIEW_DECISION'
  page.locator('[data-action=show-gate]').first.click();page.locator('#dm-dialog [data-action=review-answers]').click()
  expect(page.locator('#tab-answers')).to_have_attribute('aria-selected','true');page.locator('[data-action=edit-answer]').first.click()
  page.locator('#edited-answer').fill('修订：<img src=x onerror="window.XSS=1"> 只作为文本。')
  page.locator('#edit-answer-form button[type=submit]').click();idle(page);expect(page.locator('#dm-dialog')).not_to_be_visible()
  assert len(current(page)['project']['answers'])==10 and len(current(page)['project']['answerHistory'])==1
  assert page.evaluate('window.XSS===undefined && document.querySelectorAll(".history img").length===0')
  ok('B08 Escape has no decision; review/edit retains count; untrusted answer stays text')
  page.locator('[data-action=show-gate]').first.click();page.locator('#dm-dialog [data-action=continue]').click();idle(page)
  # Current tab was answers; next user-selected work tab exposes the question.
  page.locator('#tab-work').click();expect(page.locator('#answer')).to_be_visible()
  assert len(current(page)['project']['questions'])==11 and current(page)['project']['batchTarget']==20
  page.locator('[data-action=skip]').click();idle(page);assert len([a for a in current(page)['project']['answers'] if a['status']=='answered'])==10
  ok('B09 explicit continue opens next batch; skip is not a valid answer')
  page.locator('main [data-action=finish]').click();idle(page);expect(page.locator('[data-action=approve]')).to_be_visible()
  assert not current(page)['runs'];old=current(page)['spec']['hash']
  page.locator('#notes').fill('第一版只制作固定交互演示。');page.locator('#spec-notes button[type=submit]').click();idle(page)
  assert current(page)['spec']['hash']!=old and current(page)['project']['state']=='SPEC_REVIEW'
  page.locator('#spec-search').fill('REQ-002');expect(page.locator('.requirement')).to_have_count(1);page.locator('#spec-search').fill('')
  ok('B10 early finish and notes revision require fresh approval; requirement search works')
  page.locator('[data-action=approve]').click();idle(page);expect(page.locator('#build-form')).to_be_visible();assert not current(page)['runs']
  page.locator('#build-form button[type=submit]').click();assert not current(page)['runs']
  page.locator('[name=buildConsent]').check();page.locator('[name=demoFault]').check();page.locator('#build-form button[type=submit]').click();idle(page);run_state(page,'制定工程计划')
  ok('B11 confirming spec does not build; unchecked build consent prevents submission')
  page.locator('[data-action=pause]').click();idle(page);run_state(page,'已请求暂停 · 等待检查点')
  page.locator('[data-action=demo-step]').click();idle(page);run_state(page,'已暂停')
  page.locator('[data-action=resume]').click();idle(page);run_state(page,'制定工程计划')
  ok('B12 pause requested, paused and resume are distinct manual scenario states')
  for expected in ['执行制作','运行验证','返修中']:
   page.locator('[data-action=demo-step]').click();idle(page);run_state(page,expected)
  expect(page.locator('.finding')).to_have_count(1)
  snap(page,'review2-workspace-1440.png')
  ok('B13 explicit synthetic failure/repair issue includes evidence and severity')
  for value,label in [('FAILED','运行失败'),('PARTIAL','部分完成'),('BLOCKED','需要处理')]:
   page.locator('#scenario').select_option(value);idle(page);run_state(page,label);expect(page.locator('[data-action=demo-step]')).to_have_count(0)
  ok('B14 failed/partial/blocked do not automatically animate to completion')
  page.locator('#scenario').select_option('REPAIRING');idle(page)
  for expected in ['运行验证','独立审查','待验收']:
   page.locator('[data-action=demo-step]').click();idle(page);run_state(page,expected)
  page.locator('#tab-files').click();idle(page);expect(page.locator('.file-button')).to_have_count(2)
  page.locator('.file-button').first.click();idle(page);expect(page.locator('.file-content pre')).to_contain_text('不是由 Agent')
  rid=current(page)['runs'][0]['id'];record=page.evaluate("async()=>{const r=await dmTest.adapter.exportRun(dmTest.ui.v.snapshot.runs[0].id);return {name:r.filename,text:await r.blob.text()};}")
  assert record['name'].endswith('.json') and 'NOT live verification' in record['text']
  page.locator('[data-action=accept]').click();page.locator('#dm-dialog [data-action=confirm-accept]').click();idle(page);assert current(page)['runs'][0]['state']=='ACCEPTED'
  ok('B15 file viewer is text; export is synthetic JSON; explicit acceptance preserved','Download saving and frame navigation are not tested offline.')
  page.locator('#tab-logs').click();expect(page.locator('#event-log')).to_be_visible()
  page.evaluate("window._log=document.querySelector('#event-log');_log.scrollTop=0;window._logTop=_log.scrollTop;")
  page.evaluate("dmTest.adapter.selectScenario(dmTest.ui.v.snapshot.project.id,'REPAIRING')")
  page.wait_for_function('!dmTest.ui.refreshTimer');assert page.evaluate("document.querySelector('#event-log')===_log && _log.scrollTop===_logTop")
  page.locator('[data-action=latest]').click();assert page.evaluate('_log.scrollTop>=_logTop')
  ok('B16 event log retains user reading position; jump-to-latest is explicit')
  page.locator('#tab-work').focus();page.keyboard.press('ArrowRight');expect(page.locator('#tab-answers')).to_have_attribute('aria-selected','true');page.keyboard.press('End');expect(page.locator('#tab-files')).to_have_attribute('aria-selected','true');idle(page)
  ok('B17 keyboard tablist arrows and End preserve selected-tab semantics')
  # Wait a pending old GET; open another project before it resolves.
  page.evaluate("""()=>{const a=dmTest.adapter;window._originalRequest=a.request.bind(a);a.request=async function(path,...args){if(path==='/projects/sample-clarify'){const result=await _originalRequest(path,...args);return new Promise(resolve=>{window._resolveOld=()=>resolve(result);});}return _originalRequest(path,...args);};}""")
  page.locator('.project-link[data-id="sample-clarify"]').click()
  page.wait_for_function('typeof window._resolveOld === "function"')
  page.locator('.project-link[data-id="sample-review"]').click();expect(page.locator('.project-heading h1')).to_have_text('灵感收集盒')
  page.evaluate('_resolveOld()');expect(page.locator('.project-heading h1')).to_have_text('灵感收集盒');page.evaluate('()=>{dmTest.adapter.request=_originalRequest;}')
  ok('B18 delayed old-project response cannot replace newly selected project')
  page.locator('#scenario').select_option('IMPLEMENTING');idle(page);page.locator('[data-action=cancel]').click();expect(page.locator('#dm-dialog')).to_be_visible();page.locator('#dm-dialog [data-action=confirm-cancel]').click();idle(page)
  run_state(page,'已请求取消 · 等待清理');page.locator('[data-action=demo-step]').click();idle(page);run_state(page,'已取消');ok('B19 cancel confirmation, pending cleanup and cancelled distinct')
  page.locator('.primary-nav [data-action=settings]').click();expect(page.get_by_role('heading',name='真实连接留在本地。')).to_be_visible()
  assert page.locator('main input').count()==0;assert page.locator('main [data-action=models]').count()==0
  ok('B20 public settings are read-only: four roles, OFF/unconnected/degraded explanations, no secret entry')
  # Reopen retains data in fixture storage, not real browser navigation/storage E2E.
  page.evaluate('dmTest.restart()');expect(page.locator('.project-card')).to_have_count(4)
  page.locator(f'.project-card[data-id="{pid}"]').click();assert current(page)['spec']['notes']=='第一版只制作固定交互演示。'
  ok('B21 recreated UI/adapter restores synthetic data from memory storage fixture')
  page.locator('.primary-nav [data-action=home]').click();page.locator('#project-name').fill('200% 与移动布局检查');page.locator('#idea').fill('中文长文本'*180)
  for width in [1440,768,375]:
   page.set_viewport_size({'width':width,'height':980 if width>400 else 900});page.locator('#project-name').blur()
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(width,page.evaluate('document.documentElement.scrollWidth'))
   assert page.locator('#new-project button[type=submit]').is_visible()
   snap(page,f'review2-home-{width}.png')
  ok('B22 1440/768/375 layouts: no document overflow, main operations visible, long Chinese input')
  page.locator('[data-action=menu]').click();expect(page.locator('#dm-dialog')).to_be_visible();page.locator(f'#dm-dialog a[data-id="{pid}"]').click();expect(page.locator('#dm-dialog')).not_to_be_visible()
  expect(page.locator('.project-heading h1')).to_have_text('我的中文灵感：<项目>');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  ok('B23 mobile drawer navigates to a project and closes without background selection')
  page.locator('#tab-answers').click();page.locator('[data-action=edit-answer]').first.click();page.locator('#edited-answer').fill('再次修改，应让规格失效。');page.locator('#edit-answer-form button[type=submit]').click();idle(page)
  expect(page.locator('main .notice.warning').first).to_contain_text('规格已过期');assert current(page)['spec']['stale']
  ok('B24 editing answered requirements makes stale spec visible; not silently reused')
  page.locator('#tab-work').click();page.locator('main [data-action=finish]').click();idle(page);page.locator('[data-action=approve]').click();idle(page)
  # Reduced motion modal; inspect while open, ensure key decision unaffected.
  page.emulate_media(reduced_motion='reduce');page.locator('[data-action=team]').click()
  assert page.evaluate("parseFloat(getComputedStyle(document.querySelector('#dm-dialog')).transitionDuration)===0")
  expect(page.locator('#dm-dialog')).to_be_visible();page.locator('#dm-dialog [data-action=close-modal]').click()
  ok('B25 reduced-motion modal has zero transition duration and immediate focus return')
  page.set_viewport_size({'width':720,'height':520});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  ok('B26 200%-equivalent CSS viewport reflow (1440→720) retains operations','Equivalent layout viewport test, not native toolbar zoom or field performance data.')
  # Naming audit (a lightweight custom check, not a certified accessibility audit).
  violations=page.evaluate("""()=>[...document.querySelectorAll('button,input,textarea,select')].filter(e=>e.getClientRects().length&&e.type!=='hidden').filter(e=>!((e.getAttribute('aria-label')||'').trim()||e.getAttribute('aria-labelledby')||e.labels?.length||e.textContent.trim())).map(e=>e.outerHTML)""")
  assert not violations,violations;ok('B27 visible controls have labels/accessible names (custom audit)')
  assert not errors,errors;assert not requests,requests
  ok('B28 no uncaught page errors or network requests in offline public interaction suite')
  browser.close();browser=None
except Exception as e:
 checks.append({'name':'offline test sequence','result':'FAIL','detail':str(e),'traceback':traceback.format_exc()})
 if 'page' in locals():
  try:snap(page,'offline-failure.png')
  except:pass
finally:
 if browser:
  try:browser.close()
  except:pass
 result={'schema':'dream-maker.ui-dom-tests.v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'platform':platform.platform(),'scope':'OFFLINE_DOM; memory storage fixture; no HTTP navigation','checks':checks,'pageErrors':errors,'networkRequests':requests,'policyModified':False}
 (OUT/'browser-offline.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False,indent=2))

import sys
sys.exit(1 if any(c['result']=='FAIL' for c in checks) else 2 if any(c['result']=='BLOCKED' for c in checks) else 0)
