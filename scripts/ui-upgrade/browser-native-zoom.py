"""Dedicated native tabs.setZoom check in an owned fresh profile. No policy changes."""
from pathlib import Path
import datetime,json,math,os,subprocess,sys,tempfile
from playwright.sync_api import sync_playwright,expect
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/ui-upgrade/evidence/runs'/('native-zoom-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
OUT.mkdir(parents=True)
DATA=ROOT/'.runtime/ui-native-zoom';DATA.mkdir(parents=True,exist_ok=True)
report={'scope':'REAL_HTTP_NATIVE_ZOOM_DIAGNOSTIC','policyModified':False,'modelCalls':0,'results':[]}
with tempfile.TemporaryDirectory(prefix='own-',dir=DATA) as data:
    env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','LANG']}
    proc=subprocess.Popen(['node',str(ROOT/'tests/fixtures/browser-server.mjs'),data],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
    try:
        info=json.loads(proc.stdout.readline())
        with sync_playwright() as pw:
            profile=Path(data)/'profile';(profile/'Default').mkdir(parents=True)
            extension=ROOT/'scripts/ui-upgrade/zoom-probe'
            browser=pw.chromium.launch_persistent_context(str(profile),executable_path=os.environ['CHROMIUM_PATH'],headless=True,no_viewport=True,args=['--window-size=1440,1040','--load-extension='+str(extension)],ignore_default_args=['--disable-extensions'])
            page=browser.pages[0];page.goto(info['url'],wait_until='domcontentloaded')
            expect(page.locator('#new-project')).to_be_visible()
            worker=browser.service_workers[0] if browser.service_workers else browser.wait_for_event('serviceworker',timeout=10000)
            actual_zoom=worker.evaluate('origin=>self.zoomOwnedTab(origin)',info['origin'])
            page.wait_for_function('devicePixelRatio>1.9')
            metrics=page.evaluate('({dpr:devicePixelRatio,width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,cssZoom:getComputedStyle(document.documentElement).zoom})')
            report['results'].append({'name':'native Chrome tabs.setZoom 200% without viewport emulation','result':'PASS' if actual_zoom==2 and abs(metrics['dpr']-2)<.01 and metrics['scroll']<=metrics['width']+1 else 'FAIL','metrics':metrics,'tabsZoom':actual_zoom,'profile':'DEDICATED_TEMPORARY','pageCssZoomChanged':False})
            page.screenshot(path=str(OUT/'native-zoom.png'),full_page=True)
            browser.close()
    except Exception as exc:report['results'].append({'result':'FAIL','detail':str(exc)})
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:proc.wait(timeout=12)
            except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
(OUT/'native-zoom.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(0 if all(r['result']=='PASS' for r in report['results']) else 1)
