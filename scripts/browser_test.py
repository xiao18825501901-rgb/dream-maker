"""Actual Chromium UI checks. No paid API, Codex, DSH or Laya model calls."""
from pathlib import Path
import contextlib, datetime, hashlib, json, os, platform, re, shutil, subprocess, sys, tempfile, traceback
from playwright.sync_api import sync_playwright, expect
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('DM_EVIDENCE_DIR') or ROOT/'evidence'/'local'/datetime.datetime.now(datetime.timezone.utc).strftime('browser-%Y%m%dT%H%M%S%fZ')).resolve()
OUT.mkdir(parents=True,exist_ok=False)
(OUT/'screenshots').mkdir();(OUT/'deliveries').mkdir();(OUT/'runtime').mkdir()
checks=[];browser_errors=[];console_errors=[];proc=None;browser=None

def stop_fixture():
    if proc and proc.poll() is None:
        proc.terminate()
        try:proc.wait(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()

def check(name,detail=''):
    checks.append({'name':name,'result':'PASS','detail':detail})

def snapshot(page):
    return page.evaluate('''async()=>{const id=new URLSearchParams(location.search).get('project');return await(await fetch('/api/projects/'+id)).json();}''')

try:
 with contextlib.ExitStack() as stack:
  data=stack.enter_context(tempfile.TemporaryDirectory(prefix='dream-browser-',dir=OUT/'runtime'))
  test_env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','LANG'}}
  proc=subprocess.Popen(['node',str(ROOT/'tests/fixtures/browser-server.mjs'),data],cwd=ROOT,env=test_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  stack.callback(stop_fixture)
  info=json.loads(proc.stdout.readline())
  with sync_playwright() as pw:
   executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
   browser=pw.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'] if hasattr(os,'geteuid') and os.geteuid()==0 else [])
   browser_version=browser.version
   page=browser.new_page(viewport={'width':1440,'height':1040},device_scale_factor=1)
   page.on('pageerror',lambda e:browser_errors.append(str(e)))
   page.on('console',lambda msg:console_errors.append(msg.text) if msg.type=='error' else None)
   page.goto(info['url']);expect(page.locator('#new-project')).to_be_visible()
   assert 'bootstrap=' not in page.url
   check('single-use session bootstrap and removal from address bar')
   page.screenshot(path=str(OUT/'screenshots/01-home.png'),full_page=True)
   page.locator('[name=projectName]').fill('我的学习任务板')
   page.locator('[name=idea]').fill('我想把每天的学习目标记录下来，可以添加、完成和删除，重新打开后还在。')
   page.locator('#new-project button[type=submit]').click()
   for i in range(10):
    expect(page.locator('#answer')).to_be_visible()
    expect(page.locator('#answer-form button[type=submit]')).to_be_enabled()
    page.locator('#answer').fill(['先面向我自己的学习任务。','只在我自己的电脑中使用。','本地浏览器优先。','添加一条任务，完成后打勾。','刷新之后保留任务。','不能重复创建提交过的任务。','简洁、易读，状态清楚。','不自动公开，不调用收费服务。','第一版不做团队和账户。','添加、完成、刷新、删除都能正常使用。'][i])
    page.locator('#answer-form button[type=submit]').click()
   expect(page.get_by_role('dialog')).to_be_visible()
   data1=snapshot(page);assert len(data1['project']['questions'])==10
   assert data1['project']['state']=='AWAITING_INTERVIEW_DECISION'
   assert len(data1['runs'])==0
   check('tenth answer hard gate; no eleventh question and no implicit build')
   page.screenshot(path=str(OUT/'screenshots/02-interview-gate.png'),full_page=True)
   page.reload();expect(page.get_by_role('dialog')).to_be_visible()
   assert len(snapshot(page)['project']['questions'])==10
   check('refresh restores selected project, answers and mandatory gate')
   page.get_by_role('button',name='回看 / 修改回答',exact=True).click()
   page.get_by_role('button',name='修改',exact=True).first.click()
   page.locator('[name=editedAnswer]').fill('先面向我自己，任务使用中文，不需要账户。')
   page.get_by_role('button',name='保存修改',exact=True).click()
   expect(page.get_by_role('dialog')).to_have_count(0)
   state=snapshot(page);assert len([a for a in state['project']['answers'] if a['status']=='answered'])==10
   assert len(state['project']['answerHistory'])==1
   check('answer editing preserves history without increasing confirmed count')
   page.get_by_role('button',name='当前工作',exact=True).click()
   page.get_by_role('button',name='选择下一步 →',exact=True).click()
   page.get_by_role('button',name='继续下一组十题',exact=True).click()
   expect(page.locator('#answer')).to_be_visible()
   assert len(snapshot(page)['project']['questions'])==11
   page.locator('#answer').fill('断网时仍能添加和完成本地任务。');page.locator('#answer-form button[type=submit]').click()
   expect(page.locator('#answer')).to_be_visible()
   page.get_by_role('button',name='结束提问，整理方案',exact=True).click()
   expect(page.get_by_role('button',name='确认并冻结这个方案',exact=True)).to_be_visible()
   state=snapshot(page);assert state['spec']['requirements'][1]['sourceAnswerIds'];assert len(state['runs'])==0
   check('continue enables next batch; early finish compiles traceable versioned spec')
   old_hash=state['spec']['hash'];page.locator('[name=notes]').fill('验收时确认中文任务内容完整保存。')
   page.get_by_role('button',name='保存为新规格版本',exact=True).click()
   expect(page.get_by_role('button',name='确认并冻结这个方案',exact=True)).to_be_visible()
   assert snapshot(page)['spec']['hash']!=old_hash
   check('editing spec creates new hash and requires renewed approval')
   semantic_before=snapshot(page)['spec']
   expect(page.locator('#semantics-form')).to_be_visible()
   expect(page.locator('#semantics-form button[type=submit]')).to_be_enabled()
   for req in semantic_before['requirements']:
    page.locator('[name="kind-'+req['id']+'"]').select_option('constraint' if req['id']=='R001' else 'functional')
    page.locator('[name="criterion-'+req['id']+'"]').fill('针对 '+req['id']+' 操作学习任务板，核对原文要求与实际结果。')
   page.locator('[name=semanticConsent]').check()
   page.get_by_role('button',name='确认分类与验收',exact=True).click()
   expect(page.locator('#semantics-editor')).to_contain_text('用户已确认')
   semantic_after=snapshot(page)['spec']
   assert semantic_after['hash']!=semantic_before['hash']
   assert [(r['id'],r['text'],r['sourceAnswerIds']) for r in semantic_after['requirements']]==[(r['id'],r['text'],r['sourceAnswerIds']) for r in semantic_before['requirements']]
   assert all(a['evidenceStatus']=='NOT_RUN' for a in semantic_after['acceptanceItems'])
   assert not snapshot(page)['runs']
   page.reload();expect(page.locator('#semantics-editor')).to_contain_text('用户已确认')
   assert page.locator('[name=kind-R001]').input_value()=='constraint'
   page.locator('#semantics-editor').screenshot(path=str(OUT/'screenshots/07-semantic-confirmation.png'))
   for width in [320,768,1024,1440]:
    page.set_viewport_size({'width':width,'height':900})
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1')
   page.set_viewport_size({'width':1440,'height':1040})
   check('user-confirmed semantic revision retains exact provenance, binds acceptance IDs and survives reload without building')
   page.get_by_role('button',name='确认并冻结这个方案',exact=True).click()
   expect(page.locator('#build-form')).to_be_visible()
   page.locator('[name=buildConsent]').check();page.locator('[name=demoFault]').check()
   page.locator('#build-form button[type=submit]').click()
   expect(page.get_by_role('button',name='在检查点暂停',exact=True)).to_be_visible()
   page.get_by_role('button',name='在检查点暂停',exact=True).click()
   expect(page.get_by_role('heading',name='已暂停',exact=True)).to_be_visible(timeout=10000)
   check('browser pause reaches a durable safe checkpoint')
   page.get_by_role('button',name='继续执行',exact=True).click()
   expect(page.get_by_role('heading',name='等待验收',exact=True)).to_be_visible(timeout=30000)
   state=snapshot(page);run=state['runs'][0]
   assert run['repairCount']==1 and run['verification']['exitCode']==0
   assert run['review']['source']=='DEMO_RULES'
   evidence=[r for r in state['records'] if r['kind']=='Evidence']
   assert [r['data']['code'] for r in evidence]==[1,0]
   assert run['calls']==5 and all(t['status']=='done' for t in run['tasks'])
   check('resume completes dependency-ordered tasks and a real FAIL→repair→PASS cycle','Two actual verifier subprocesses; 12 checks in passing run; simulated agent roles clearly labelled.')
   page.screenshot(path=str(OUT/'screenshots/03-delivery.png'),full_page=True)
   page.get_by_role('button',name='打开隔离预览',exact=True).click()
   expect(page.locator('iframe')).to_be_visible()
   frame=page.frame_locator('iframe')
   expect(frame.locator('#stats')).to_have_text('0 / 0 已完成')
   frame.locator('#title').fill('独立复现一个 Agent 工具调用')
   frame.get_by_role('button',name='添加任务',exact=True).click()
   checks.append({'name':'preview diagnostic after submit','result':'OBSERVED','detail':json.dumps({'error':frame.locator('#error').inner_text(),'input':frame.locator('#title').input_value(),'consoleErrors':console_errors},ensure_ascii=False)})
   expect(frame.locator('#tasks li')).to_have_count(1)
   frame.get_by_role('checkbox').check();expect(frame.locator('#stats')).to_have_text('1 / 1 已完成')
   actual_frame=page.frames[1]
   actual_frame.evaluate('location.reload()')
   expect(frame.locator('#stats')).to_have_text('1 / 1 已完成')
   check('separate-origin sample adds, completes and persists tasks across reload')
   page.locator('iframe').scroll_into_view_if_needed()
   page.screenshot(path=str(OUT/'screenshots/04-preview.png'),full_page=True)
   page.locator('iframe').screenshot(path=str(OUT/'screenshots/06-preview-frame.png'))
   frame.get_by_role('button',name='删除',exact=True).click();expect(frame.locator('#tasks li')).to_have_count(0)
   check('sample deletes tasks through real browser interaction')
   page.get_by_role('button',name='确认验收样例',exact=True).click()
   expect(page.get_by_role('heading',name='已验收',exact=True)).to_be_visible()
   with page.expect_download() as download:
    page.get_by_role('link',name='下载项目 ZIP ↓',exact=True).click()
   downloaded=download.value;downloaded.save_as(str(OUT/'deliveries/Demo_Study_Board.zip'))
   import zipfile
   with zipfile.ZipFile(OUT/'deliveries/Demo_Study_Board.zip') as z:
    assert z.testzip() is None
    manifest=json.loads(z.read('DREAM_MAKER_MANIFEST.json'));assert manifest['mode']=='demo' and manifest['status']=='ACCEPTED'
   check('explicit acceptance and downloadable ZIP with matching mode and status')
   page.get_by_role('button',name='灵感工坊',exact=True).click()
   page.locator('[name=projectName]').fill('取消动作验收');page.locator('[name=idea]').fill('仅用于检查停止功能。')
   page.locator('#new-project button[type=submit]').click();expect(page.locator('#answer')).to_be_visible()
   page.get_by_role('button',name='结束提问，整理方案',exact=True).click()
   page.get_by_role('button',name='确认并冻结这个方案',exact=True).click()
   page.locator('[name=buildConsent]').check();page.locator('#build-form button[type=submit]').click()
   expect(page.get_by_role('button',name='停止本次运行',exact=True)).to_be_visible()
   page.get_by_role('button',name='停止本次运行',exact=True).click()
   expect(page.locator('#toast')).to_contain_text('已停止')
   assert snapshot(page)['runs'][0]['state']=='CANCELLED'
   check('browser cancel stops owned worker and preserves existing project data')
   page.get_by_role('button',name='连接与设置',exact=True).click()
   expect(page.locator('#settings-form')).to_be_visible()
   page.get_by_role('button',name='查看只读诊断',exact=True).click()
   expect(page.locator('#diagnostics-output')).to_contain_text('NATIVE_AUDIT_REQUIRED')
   check('configuration diagnostics disclose unaudited native integrations without contacting paid services')
   page.set_viewport_size({'width':390,'height':844})
   page.get_by_role('button',name='灵感工坊',exact=True).click()
   assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1')
   page.screenshot(path=str(OUT/'screenshots/05-mobile.png'),full_page=True)
   check('390px responsive layout has no horizontal overflow')
   for width in [320,768,1024,1440]:
    page.set_viewport_size({'width':width,'height':900})
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1')
    check(str(width)+'px responsive layout has no horizontal overflow')
   assert not browser_errors,browser_errors
   assert not console_errors,console_errors
   check('no uncaught browser JavaScript errors')
   browser.close();browser=None
  proc.terminate();proc.wait(timeout=15)
except Exception as exc:
 checks.append({'name':'browser execution','result':'BLOCKED' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(exc) else 'FAIL','detail':re.sub(r'bootstrap=[a-f0-9]+','bootstrap=[REDACTED]',str(exc)),'traceback':re.sub(r'bootstrap=[a-f0-9]+','bootstrap=[REDACTED]',traceback.format_exc())})
 try:
  if 'page' in globals():page.screenshot(path=str(OUT/'screenshots/browser-failure.png'),full_page=True)
 except Exception:pass
finally:
 if browser:
  try:browser.close()
  except Exception:pass
 if proc and proc.poll() is None:
  proc.terminate()
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
 artifacts=[{'path':str(p.relative_to(OUT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for directory in ['screenshots','deliveries'] for p in sorted((OUT/directory).glob('*')) if p.is_file()]
 report={'schema':'dream-maker.browser-evidence.v1','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment':platform.platform()+'; real Chromium via Playwright','browserVersion':browser_version if 'browser_version' in globals() else None,'integrationScope':'OFFLINE_DEMO; actual browser/HTTP, not Codex/DSH/Laya live integration','artifacts':artifacts,'checks':checks,'browserErrors':browser_errors,'passed':sum(x['result']=='PASS' for x in checks),'failed':sum(x['result']=='FAIL' for x in checks),'blocked':sum(x['result']=='BLOCKED' for x in checks)}
 (OUT/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(report,ensure_ascii=False,indent=2))
 if report['failed'] or report['blocked']:raise SystemExit(1)
