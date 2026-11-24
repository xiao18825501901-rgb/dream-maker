"""OFFLINE DOM controller tests. Synthetic plans, no HTTP/model/Live acceptance."""
from pathlib import Path
import datetime, json, os, shutil, sys, traceback
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/ui-upgrade/evidence/runs' / ('verifier-offline-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
OUT.mkdir(parents=True, exist_ok=False)
sys.stdout.reconfigure(encoding='utf-8')
checks, errors, requests = [], [], []
status = 'FAIL'

def passed(name):
    checks.append({'name': name, 'result': 'PASS'})

def idle(page):
    expect(page.locator('#app')).to_have_attribute('aria-busy', 'false')

try:
    with sync_playwright() as pw:
        exe = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
        browser = pw.chromium.launch(**({'executable_path': exe} if exe else {}), headless=True)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1040})
            page.set_default_timeout(8000)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('request', lambda r: requests.append(r.url))
            page.set_content('<html data-dm-ui-fixture><head></head><body><div id="app"></div><div id="toast" hidden></div></body></html>')
            page.add_style_tag(content=(ROOT/'dist/web/style.css').read_text(encoding='utf-8'))
            page.evaluate("""()=>{for(const name of ['sessionStorage','localStorage']){const data=new Map();Object.defineProperty(window,name,{configurable:true,value:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)}});}}""")
            page.add_script_tag(content=(ROOT/'.runtime/ui-offline/offline-test-bundle.js').read_text(encoding='utf-8'))
            page.evaluate("""async()=>{
              const m=dmTest.modules,a=new m['demo-api'].DemoScenarioAdapter();await a.init();
              let s=await a.request('/projects','POST',{name:'OFFLINE 验收计划夹具',idea:'纯合成界面测试',mode:'demo'});
              s=await a.request('/projects/'+s.project.id+'/finish','POST',{});
              s.spec.hash='a'.repeat(64);s.project.mode='live';
              window.fixture={s,settings:await a.request('/config'),posts:[],reject:false,defer:false};
              fixture.plan={sha256:'b'.repeat(64),plan:{schema:'dream-maker.cli-verifier.v1',specHash:s.spec.hash,cases:[{id:'case1',requirementIds:['R1'],runtime:'node',entry:'main.mjs',args:['--count','2'],stdin:'<input>\\n',expectedExitCode:0,expectedStdout:'<img onerror="window.XSS=1">\\n'+ 'long '.repeat(100)}]}};
              const adapter={mode:'local',init:async()=>{},dispose:()=>{},subscribe:()=>()=>{},request:async(path,method,body)=>{
                if(path.endsWith('/native-verifier/approve')){fixture.posts.push(body);if(fixture.reject)throw new m.contracts.UiError('TRUSTED_VERIFIER_PLAN_CHANGED','计划已改变');return {...body};}
                if(path.endsWith('/native-verifier')){if(fixture.defer)return new Promise(resolve=>{fixture.resolve=()=>resolve(structuredClone(fixture.plan));});return structuredClone(fixture.plan);}
                if(path==='/projects')return {projects:[fixture.s.project]};
                return structuredClone(fixture.s);
              }};
              fixture.ui=new m.ui.DreamMakerUI(adapter);
              fixture.render=()=>fixture.ui.renderFixture({screen:'project',projects:[fixture.s.project],snapshot:structuredClone(fixture.s),settings:fixture.settings,tab:'spec',gateDismissed:true});fixture.render();
            }""")
            launch = page.locator('[data-action=native-verifier]')
            launch.click(); idle(page)
            expect(page.locator('#native-verifier-form')).to_be_visible()
            expect(page.locator('#dm-dialog')).to_contain_text('main.mjs')
            assert page.evaluate('window.XSS===undefined && document.querySelectorAll("#dm-dialog img").length===0')
            passed('exact oracle fields render as text, without HTML execution')
            page.locator('#native-verifier-form button[type=submit]').click()
            assert page.evaluate('fixture.posts.length') == 0
            assert page.evaluate('document.querySelector("#dm-dialog").contains(document.activeElement)')
            page.keyboard.press('Shift+Tab'); page.keyboard.press('Tab')
            assert page.evaluate('document.querySelector("#dm-dialog").contains(document.activeElement)')
            passed('unchecked consent refuses approval; dialog retains keyboard focus')
            for width in [320, 768, 1024, 1440]:
                page.set_viewport_size({'width': width, 'height': 1040})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                assert page.evaluate('(()=>{const d=document.querySelector("#dm-dialog");return d.scrollWidth<=d.clientWidth+1;})()')
                page.screenshot(path=str(OUT/('oracle-'+str(width)+'.png')), full_page=True)
            passed('oracle dialog has no horizontal overflow at 320/768/1024/1440')
            page.locator('[name=verifierConsent]').check()
            page.locator('#native-verifier-form button[type=submit]').dblclick(); idle(page)
            expect(page.locator('#dm-dialog')).not_to_be_visible()
            assert page.evaluate('fixture.posts.length') == 1
            assert page.evaluate('fixture.posts[0].specHash===fixture.s.spec.hash && fixture.posts[0].planHash===fixture.plan.sha256 && fixture.posts[0].approved===true')
            assert page.evaluate('fixture.s.runs.length===0 && fixture.s.project.state==="SPEC_REVIEW"')
            passed('one bound consent POST, no implicit spec/build grant or run')
            launch.click(); idle(page)
            page.evaluate("fixture.reject=true")
            page.locator('[name=verifierConsent]').check(); page.locator('#native-verifier-form button[type=submit]').click(); idle(page)
            expect(page.locator('#dialog-error')).to_contain_text('TRUSTED_VERIFIER_PLAN_CHANGED')
            expect(page.locator('#dm-dialog')).to_be_visible()
            expect(page.locator('[name=verifierConsent]')).to_be_enabled()
            assert page.evaluate('fixture.posts.length') == 2
            passed('server changed-plan rejection stays explicit, never retries approval')
            page.evaluate("fixture.s.spec.stale=true;fixture.render()")
            expect(page.locator('#dm-dialog')).not_to_be_visible(); expect(launch).to_be_disabled()
            passed('stale specification closes consent and disables plan action')
            page.evaluate("fixture.s.spec.stale=false;fixture.defer=true;fixture.render()")
            launch.click(); page.wait_for_function('typeof fixture.resolve==="function"')
            page.locator('#tab-answers').click(); page.evaluate('fixture.resolve()'); idle(page)
            expect(page.locator('#dm-dialog')).not_to_be_visible()
            passed('delayed plan cannot reopen consent after tab navigation')
            page.evaluate("fixture.defer=false;fixture.plan.plan.specHash='c'.repeat(64);fixture.render()")
            launch.click(); idle(page)
            expect(page.locator('#error-box')).to_contain_text('VERIFIER_PLAN_INVALID')
            expect(page.locator('#dm-dialog')).not_to_be_visible()
            passed('response spec mismatch refuses consent')
            page.evaluate("fixture.ui.v.mode='public-demo';fixture.ui.render()")
            expect(launch).to_have_count(0)
            passed('public Demo view contains no native plan action')
            assert not errors and not requests
            passed('zero page errors and zero browser network requests')
            status = 'PASS'
        finally:
            browser.close()
except Exception:
    errors.append(traceback.format_exc())
finally:
    result = {'status': status, 'evidence': 'OFFLINE_DOM_SYNTHETIC_NOT_LIVE', 'checks': checks, 'errors': errors, 'requests': requests, 'paidRequests': 0}
    (OUT/'browser-verifier-offline.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'status': status, 'checks': len(checks), 'evidence': str(OUT)}, ensure_ascii=False))
    if status != 'PASS':
        print('\n'.join(errors))
        sys.exit(1)
