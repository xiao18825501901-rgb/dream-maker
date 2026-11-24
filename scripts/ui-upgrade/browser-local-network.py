"""Process-scoped browser network observations. Loopback only, no paid calls or public navigation."""
from pathlib import Path
from urllib.parse import urlsplit
import contextlib,datetime,json,os,subprocess,sys,tempfile
from playwright.sync_api import sync_playwright,expect

sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/ui-upgrade/evidence/runs'/('network-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
OUT.mkdir(parents=True)
DATA=ROOT/'.runtime/ui-network';DATA.mkdir(parents=True,exist_ok=True)
checks=[];requests=[];responses=[];denied=[];violations=[];errors=[];proc=None
processes=[]
def passed(name,**data):checks.append({'name':name,'result':'PASS',**data})
def safe_url(url):
    parsed=urlsplit(url)
    return parsed.scheme+'://'+parsed.netloc+parsed.path
def stop():
    if proc and proc.poll() is None:
        proc.terminate()
        try:proc.wait(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
try:
    with contextlib.ExitStack() as resources:
        runtime=resources.enter_context(tempfile.TemporaryDirectory(prefix='network-',dir=DATA))
        env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','LANG']}
        proc=subprocess.Popen(['node',str(ROOT/'tests/fixtures/browser-server.mjs'),runtime],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        resources.callback(stop)
        info=json.loads(proc.stdout.readline())
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=os.environ['CHROMIUM_PATH'],headless=True)
            browser_cdp=browser.new_browser_cdp_session()
            processes=browser_cdp.send('SystemInfo.getProcessInfo')['processInfo']
            context=browser.new_context(viewport={'width':1440,'height':1040})
            def guard(route):
                target=urlsplit(route.request.url)
                if target.scheme=='http' and target.hostname=='127.0.0.1' and target.netloc==urlsplit(info['origin']).netloc:
                    route.continue_()
                else:
                    denied.append(safe_url(route.request.url));route.abort('blockedbyclient')
            context.route('**/*',guard)
            context.add_init_script("window.__csp=[];document.addEventListener('securitypolicyviolation',e=>__csp.push({directive:e.effectiveDirective,url:e.blockedURI}));")
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            cdp=context.new_cdp_session(page);cdp.send('Network.enable')
            cdp.on('Network.requestWillBeSent',lambda e:requests.append({'url':safe_url(e['request']['url']),'initiator':e['initiator']['type']}))
            cdp.on('Network.responseReceived',lambda e:responses.append({'url':safe_url(e['response']['url']),'remoteIPAddress':e['response'].get('remoteIPAddress'),'port':e['response'].get('remotePort')}))
            page.goto(info['url'],wait_until='domcontentloaded')
            expect(page.locator('#new-project')).to_be_visible()
            assert all(urlsplit(item['url']).hostname=='127.0.0.1' for item in requests),requests
            assert not denied,denied
            passed('formal UI graph and bootstrap loaded only from the owned loopback Node listener',nodePid=proc.pid)
            # CSP blocks these before transport; the route guard is a second fail-closed boundary.
            rejected=page.evaluate("async()=>{let rejected=[];for(const url of ['https://api.openai.com/v1/models','https://example.invalid/','http://[::1]:9/']){try{await fetch(url);rejected.push(false);}catch{rejected.push(true);}}return rejected;}")
            assert all(rejected),rejected
            violations=page.evaluate('__csp')
            assert len([v for v in violations if v['directive']=='connect-src'])==3,violations
            passed('browser direct model API, unknown external host and IPv6 listener denied by actual connect-src CSP')
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('#new-project')).to_be_visible()
            page.locator('#project-name').fill('出站网络关闭验收')
            page.locator('#idea').fill('在禁止公网请求的测试上下文中保存本地灵感。')
            page.locator('#new-project button[type=submit]').click()
            expect(page.locator('#answer')).to_be_visible()
            passed('local reload and project persistence work with public egress denied in this context')
            page.locator('.primary-nav [data-action=settings]').click()
            expect(page.locator('#settings-form')).to_be_visible()
            page.locator('[data-action=diagnostics]').click()
            expect(page.locator('#diagnostics-output')).to_contain_text('NATIVE_AUDIT_REQUIRED')
            passed('native readiness diagnostics stays local; no paid model or Laya request invoked')
            actual=[r for r in responses if r['remoteIPAddress']]
            assert actual and all(r['remoteIPAddress']=='127.0.0.1' for r in actual),actual
            assert not errors,errors
            page.screenshot(path=str(OUT/'local-network.png'),full_page=True)
            passed('observed browser HTTP response sockets terminate at 127.0.0.1',observedSockets=len(actual))
            browser.close()
except Exception as exc:
    checks.append({'name':'browser local-network sequence','result':'FAIL','detail':str(exc)})
finally:
    stop()
    report={'schema':'dream-maker.local-browser-network.v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'checks':checks,'browserProcesses':processes,'httpRequests':requests,'httpResponses':responses,'guardDenied':denied,
        'cspViolations':violations,'pageErrors':errors,'liveAgent':'NOT_RUN','policyModified':False,
        'scopeLimit':'CDP/browser request and HTTP socket observations; NOT OS-wide UDP/DNS/native-Agent egress certification. Public egress selectively denied; Playwright offline=true would also deny loopback.'}
    (OUT/'browser-local-network.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'checks':checks,'evidence':str(OUT/'browser-local-network.json')},ensure_ascii=False,indent=2))
    sys.exit(1 if any(c['result']=='FAIL' for c in checks) else 0)
