"""Real local HTTP + browser UI E2E; never bypasses managed browser policy.
Requires Python Playwright and a permitted Chromium installation. No model/API spending.
"""
from pathlib import Path
import json, os, re, shutil, subprocess, tempfile, datetime,sys,platform,zipfile,hashlib
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[2]
sys.stdout.reconfigure(encoding='utf-8')
OUT=Path(os.environ.get('DM_UI_EVIDENCE_DIR',ROOT/'docs/ui-upgrade/evidence/runs'/('local-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')))).resolve()
if not OUT.is_relative_to(ROOT/'docs/ui-upgrade/evidence'):raise SystemExit('Evidence must stay inside UI evidence directory')
OUT.mkdir(parents=True,exist_ok=True)
checks=[]; errors=[];console_errors=[];request_errors=[];proc=None

def passed(name): checks.append({'name':name,'result':'PASS'})
def state(page):
 return page.evaluate("async()=>{const id=new URLSearchParams(location.search).get('project');return await (await fetch('/api/projects/'+id)).json();}")
def idle(page): expect(page.locator('#app')).to_have_attribute('aria-busy','false',timeout=15000)
def stop():
 if proc and proc.poll() is None:
  proc.terminate()
  try: proc.wait(timeout=12)
  except subprocess.TimeoutExpired: proc.kill();proc.wait(timeout=5)
try:
 temporary=ROOT/'.runtime/ui-browser-data';temporary.mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory(prefix='dm-ui-local-e2e-',dir=temporary) as data:
  child_env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','LANG']}
  proc=subprocess.Popen(['node',str(ROOT/'tests/fixtures/browser-server.mjs'),data],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',env=child_env)
  info=json.loads(proc.stdout.readline())
  try:
   with sync_playwright() as pw:
    exe=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
    browser=pw.chromium.launch(**({'executable_path':exe} if exe else {}),headless=True,args=['--no-sandbox'] if hasattr(os,'geteuid') and os.geteuid()==0 else [])
    page=browser.new_page(viewport={'width':1440,'height':1040});page.set_default_timeout(12000)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m:console_errors.append(m.text) if m.type=='error' else None)
    page.on('requestfailed',lambda r:request_errors.append({'path':r.url.split('#')[0],'failure':r.failure}))
    page.goto(info['url'],wait_until='domcontentloaded',timeout=12000)
    expect(page.locator('#new-project')).to_be_visible();assert 'bootstrap=' not in page.url
    passed('session bootstrap consumed and removed; new UI loads from real server')
    page.locator('#project-name').fill('本地 UI 流程验收');page.locator('#idea').fill('记录中文学习任务，完成与删除，刷新后保留。')
    page.locator('#new-project button[type=submit]').click();idle(page)
    for i in range(10):
     expect(page.locator('#answer')).to_be_visible();page.locator('#answer').fill('第'+str(i+1)+'个回答：本地、清楚、可验证。')
     page.locator('#answer-form button[type=submit]').click();idle(page)
    expect(page.locator('#dm-dialog')).to_be_visible();s=state(page)
    assert s['project']['state']=='AWAITING_INTERVIEW_DECISION' and len(s['project']['questions'])==10 and not s['runs']
    passed('ten answers hard gate; no implicit eleventh question or build')
    page.reload(wait_until='domcontentloaded');expect(page.locator('#dm-dialog')).to_be_visible()
    passed('reload restores selected project and gate')
    page.locator('#dm-dialog [data-action=review-answers]').click()
    page.locator('[data-action=edit-answer]').first.click();page.locator('#edited-answer').fill('修订原始回答，不增加题数。')
    page.locator('#edit-answer-form button[type=submit]').click();idle(page);expect(page.locator('#dm-dialog')).not_to_be_visible()
    assert len(state(page)['project']['answers'])==10
    passed('answer edit retains count and modal closes')
    page.locator('[data-action=show-gate]').first.click();page.locator('#dm-dialog [data-action=continue]').click();idle(page)
    expect(page.locator('#answer')).to_be_visible();assert len(state(page)['project']['questions'])==11
    page.locator('main [data-action=finish]').click();idle(page)
    expect(page.locator('[data-action=approve]')).to_be_visible();s=state(page);assert not s['runs']
    old=s['spec']['hash'];page.locator('#notes').fill('验收时检查中文任务与数据保存。');page.locator('#spec-notes button[type=submit]').click();idle(page)
    assert state(page)['spec']['hash']!=old
    passed('continue, early finish, traceable new spec version; no build')
    before=state(page);raw=[r['text'] for r in before['spec']['requirements']]
    page.locator('#semantics-editor > summary').click()
    for r in before['spec']['requirements']:
     page.locator('#kind-'+r['id']).select_option('functional')
     page.locator('#criterion-'+r['id']).fill('添加中文任务并确认刷新后仍能回看。')
    page.locator('[name=semanticConsent]').check();page.locator('#semantics-form button[type=submit]').click();idle(page)
    classified=state(page)
    assert [r['text'] for r in classified['spec']['requirements']]==raw
    assert all(r['kind']=='functional' for r in classified['spec']['requirements'])
    assert all(a['evidenceStatus']=='NOT_RUN' for a in classified['spec']['acceptanceItems'])
    assert classified['project']['state']=='SPEC_REVIEW' and not classified['runs']
    passed('latest core classification/criteria confirmation retains original text and requires new approval')
    page.locator('[data-action=approve]').click();idle(page);expect(page.locator('#build-form')).to_be_visible()
    page.locator('[name=buildConsent]').check();page.locator('[name=demoFault]').check();page.locator('#build-form button[type=submit]').click();idle(page)
    expect(page.locator('[data-action=pause]')).to_be_visible();page.locator('[data-action=pause]').click();idle(page)
    expect(page.locator('.run-summary h2')).to_have_text('已暂停',timeout=15000)
    passed('pause request reaches backend safe checkpoint')
    page.locator('[data-action=resume]').click();idle(page)
    expect(page.locator('.run-summary h2')).to_have_text('待验收',timeout=45000)
    s=state(page);assert s['runs'][0]['repairCount']==1 and s['runs'][0]['verification']['ok']
    run=s['runs'][0]
    assert run['calls']==5 and all(t['status']=='done' for t in run['tasks'])
    assert run['review']['source']=='DEMO_RULES'
    assert [r['data']['code'] for r in s['records'] if r['kind']=='Evidence']==[1,0]
    passed('real fixed-demo verifier fails, repairs, passes; independent of UI animation')
    page.locator('#tab-files').click();idle(page);page.locator('[data-action=preview]').click();idle(page)
    expect(page.locator('iframe')).to_be_visible();frame=page.frame_locator('iframe')
    expect(frame.locator('#stats')).to_have_text('0 / 0 已完成')
    frame.locator('#title').fill('复验界面与服务端');frame.get_by_role('button',name='添加任务',exact=True).click()
    checks.append({'name':'preview runtime observation','result':'OBSERVED','sandbox':page.locator('iframe').get_attribute('sandbox'),'error':frame.locator('#error').inner_text(),'stats':frame.locator('#stats').inner_text()})
    expect(frame.locator('#tasks li')).to_have_count(1);frame.get_by_role('checkbox').check()
    expect(frame.locator('#stats')).to_have_text('1 / 1 已完成')
    page.frames[1].evaluate('location.reload()');expect(frame.locator('#stats')).to_have_text('1 / 1 已完成')
    frame.get_by_role('button',name='删除',exact=True).click();expect(frame.locator('#tasks li')).to_have_count(0)
    passed('existing separate-origin preview adds, completes, persists and deletes')
    page.locator('[data-action=accept]').click();page.locator('#dm-dialog [data-action=confirm-accept]').click();idle(page)
    with page.expect_download() as d:page.locator('[data-action=export]').click()
    download=d.value;assert download.suggested_filename.endswith('.zip')
    destination=OUT/'Demo_Study_Board.zip';download.save_as(str(destination))
    with zipfile.ZipFile(destination) as archive:
     assert archive.testzip() is None
     manifest=json.loads(archive.read('DREAM_MAKER_MANIFEST.json'))
     assert manifest['mode']=='demo' and manifest['status']=='ACCEPTED'
    checks.append({'name':'explicit acceptance then actual ZIP content and integrity','result':'PASS','bytes':destination.stat().st_size,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest()})
    page.screenshot(path=str(OUT/'local-browser-final.png'),full_page=True)
    assert not errors and not console_errors,(errors,console_errors);passed('no uncaught JS or console errors in real local workflow')
    browser.close()
  finally: stop()
except Exception as exc:
 detail=re.sub(r'bootstrap=[^\s"\']+','bootstrap=[REDACTED]',str(exc))
 checks.append({'name':'local browser execution','result':'BLOCKED' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in detail else 'FAIL','detail':detail})
finally:
 stop()
 report={'schema':'dream-maker.ui-browser-local.v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'platform':platform.platform(),'checks':checks,'errors':errors,'consoleErrors':console_errors,'requestErrors':request_errors,'policyModified':False,'evidenceClass':'REAL_BROWSER_HTTP_FIXED_DEMO_NOT_LIVE_AGENT'}
 (OUT/'browser-local.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(report,ensure_ascii=False,indent=2))

import sys
sys.exit(1 if any(c['result']=='FAIL' for c in checks) else 2 if any(c['result']=='BLOCKED' for c in checks) else 0)
