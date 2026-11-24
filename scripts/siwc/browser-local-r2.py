"""Real loopback UI/HTTP SIWC gates. No SDK, OAuth, subscription or paid-inference success is claimed."""
from pathlib import Path
from urllib.parse import urlsplit
import contextlib,datetime,json,os,subprocess,sys,tempfile
from playwright.sync_api import sync_playwright,expect
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/siwc/evidence/runs'/('http-r2-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));OUT.mkdir(parents=True)
DATA=ROOT/'.runtime/siwc-browser';DATA.mkdir(parents=True,exist_ok=True)
checks=[];requests=[];denied=[];errors=[];proc=None
def stop():
 if proc and proc.poll() is None:
  proc.terminate()
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
def passed(name,**detail):checks.append({'name':name,'result':'PASS',**detail})
def idle(page):expect(page.locator('#app')).to_have_attribute('aria-busy','false',timeout=15000)
try:
 with contextlib.ExitStack() as resources:
  runtime=resources.enter_context(tempfile.TemporaryDirectory(prefix='r2-',dir=DATA))
  env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','LANG']}
  proc=subprocess.Popen(['node',str(ROOT/'tests/fixtures/browser-server.mjs'),runtime],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8');resources.callback(stop)
  info=json.loads(proc.stdout.readline())
  with sync_playwright() as pw:
   browser=pw.chromium.launch(executable_path=os.environ['CHROMIUM_PATH'],headless=True)
   context=browser.new_context(viewport={'width':1440,'height':1040})
   def guard(route):
    u=urlsplit(route.request.url)
    if u.scheme=='http' and u.netloc==urlsplit(info['origin']).netloc:route.continue_()
    else:denied.append(u.scheme+'://'+u.netloc+u.path);route.abort('blockedbyclient')
   context.route('**/*',guard)
   page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   page.on('request',lambda r:requests.append({'method':r.method,'origin':urlsplit(r.url).netloc,'path':urlsplit(r.url).path}))
   page.goto(info['url'],wait_until='domcontentloaded');expect(page.locator('#new-project')).to_be_visible()
   page.locator('.primary-nav [data-action=settings]').click()
   expect(page.locator('.siwc-card')).to_contain_text('UNAVAILABLE')
   expect(page.locator('#auth-mode')).to_have_value('api_key')
   passed('formal SIWC panel and status load from real local HTTP; original API mode remains selected')
   page.locator('[data-action=siwc-connect]').click()
   expect(page.locator('.siwc-card [role=alert]')).to_contain_text('请先明确确认')
   assert not [r for r in requests if r['method']=='POST' and r['path'].endswith('/siwc/connect')]
   passed('unchecked attestation cannot even dispatch an OAuth request')
   page.locator('#siwc-noncommercial').check()
   with page.expect_response(lambda r:r.url.endswith('/planner1/siwc/connect')) as result:
    page.locator('[data-action=siwc-connect]').click()
   response=result.value;assert response.status==503,response.status
   assert response.json()['error']=='SIWC_SDK_NOT_PINNED_OR_NOT_BUILT'
   expect(page.locator('.siwc-card [role=alert]')).to_contain_text('SIWC_SDK_NOT_PINNED_OR_NOT_BUILT')
   passed('actual authenticated connect fails closed before OAuth because official SDK is unavailable')
   page.locator('#auth-mode').select_option('siwc_plan')
   page.locator('#settings-form button[type=submit]').click();idle(page)
   page.locator('.primary-nav [data-action=home]').click()
   expect(page.locator('[name=siwcPlanConsent]')).to_be_visible()
   assert page.locator('[name=apiConsent]').count()==0
   passed('plan mode has separate project consent, not paid-API consent')
   page.locator('#project-name').fill('SIWC 真实门禁检查')
   page.locator('#idea').fill('SDK 缺失应阻塞访谈，不改为收费 API 或固定题库。')
   page.locator('#mode').select_option('live');page.locator('[name=siwcPlanConsent]').check()
   page.locator('#new-project button[type=submit]').click();idle(page)
   snapshot=page.evaluate("async()=>{const id=new URLSearchParams(location.search).get('project');return(await fetch('/api/projects/'+id)).json();}")
   assert snapshot['project']['planner1AuthMode']=='siwc_plan'
   assert snapshot['project']['mode']=='live' and not snapshot['project']['questions'] and not snapshot['runs']
   assert [r for r in snapshot['records'] if r['kind']=='ModelAttemptFailure']
   passed('real Live project persists bound SIWC mode and failed attempt with zero fallback question or engineering dispatch')
   page.reload(wait_until='domcontentloaded');expect(page.locator('.project-heading')).to_be_visible()
   page.locator('.primary-nav [data-action=home]').click()
   page.locator('#project-name').fill('独立 Demo 不受 SDK 缺失影响');page.locator('#idea').fill('仅检查本地访谈门槛。')
   page.locator('#new-project button[type=submit]').click();idle(page)
   for i in range(10):
    expect(page.locator('#answer')).to_be_visible();page.locator('#answer').fill('本地测试回答 '+str(i+1))
    page.locator('#answer-form button[type=submit]').click();idle(page)
   expect(page.locator('#dm-dialog')).to_be_visible()
   passed('independent fixed Demo still reaches ten-answer server gate in SIWC global mode')
   assert not denied and not errors,(denied,errors)
   assert all(r['origin']==urlsplit(info['origin']).netloc for r in requests)
   page.screenshot(path=str(OUT/'siwc-http-r2.png'),full_page=True)
   passed('all observed UI requests remain loopback; no browser OAuth, native agent or model inference started',nodePid=proc.pid)
   browser.close()
except Exception as exc:checks.append({'name':'real HTTP SIWC boundary sequence','result':'FAIL','detail':str(exc)})
finally:
 stop()
 report={'schema':'dream-maker.siwc-r2-local-browser.v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':checks,
  'requests':requests,'denied':denied,'pageErrors':errors,'oauth':'NOT_RUN','planInference':'NOT_RUN','sdk':'UNAVAILABLE','policyModified':False}
 (OUT/'siwc-http-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps({'checks':checks,'evidence':str(OUT/'siwc-http-browser.json')},ensure_ascii=False,indent=2))
 sys.exit(1 if any(c['result']=='FAIL' for c in checks) else 0)
