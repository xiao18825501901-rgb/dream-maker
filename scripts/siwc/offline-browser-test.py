"""Real Chromium DOM interactions on about:blank, fake adapter and fake session only.
Managed URL navigation policy is never altered. This does NOT test real OAuth.
"""
from pathlib import Path
import json,re,datetime,traceback,os,shutil,sys
from playwright.sync_api import sync_playwright,expect
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[2];out=ROOT/'docs/siwc/evidence/runs'/('windows-dom-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));out.mkdir(parents=True,exist_ok=False)
checks=[];errors=[];requests=[];page=None
html=(ROOT/'dist/web/index.html').read_text(encoding='utf-8')
html=re.sub(r'<script[^>]*>.*?</script>','',html,flags=re.S)
html=re.sub(r'<link[^>]+>','',html)
html=html.replace('</head>','<style>'+(ROOT/'dist/web/style.css').read_text(encoding='utf-8')+'</style></head>')
html=html.replace('</body>','<div class="fixture-watermark">OFFLINE SIWC UI · FAKE AUTH · NO LIVE</div></body>')
def ok(name):checks.append({'name':name,'status':'PASS'})
try:
 with sync_playwright() as p:
  exe=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
  browser=p.chromium.launch(executable_path=exe,headless=True,args=['--no-sandbox'] if hasattr(os,'geteuid') and os.geteuid()==0 else [])
  page=browser.new_page(viewport={'width':1440,'height':900});page.set_default_timeout(10000)
  page.on('pageerror',lambda x:errors.append(str(x)));page.on('request',lambda x:requests.append(x.url))
  page.set_content(html)
  page.evaluate('''()=>{const bag=new Map();Object.defineProperty(window,'sessionStorage',{configurable:true,value:{getItem:k=>bag.get(k)||null,setItem:(k,v)=>bag.set(k,String(v)),removeItem:k=>bag.delete(k)}})}''')
  page.add_script_tag(content=(ROOT/'docs/siwc/evidence/offline-dom-bundle.js').read_text(encoding='utf-8'))
  page.evaluate('''async()=>{
   const m=window.siwcDomModules;
   let status={authMode:'siwc_plan',state:'DISCONNECTED',legal:{acknowledged:false},eligibility:'UNKNOWN',region:'UNKNOWN',session:{status:'disconnected',sharing:false},model:{slug:null,discovery:'NOT_RUN',inference:'NOT_RUN'},attempts:{state:'IDLE',id:null,startedAt:null},usage:{source:'CHATGPT_PLAN',tokens:'UNKNOWN',costUsd:'UNKNOWN',manageUrl:'https://chatgpt.com/settings/usage'},capability:{sdk:'UNAVAILABLE',osEncryption:'UNAVAILABLE',browserAuth:'USER_REQUIRED'}};
   const demo=new m['demo-api'].DemoScenarioAdapter();await demo.init();
   window.actionLog=[];
   const adapter={mode:'local',init:async()=>{},subscribe:demo.subscribe.bind(demo),dispose:()=>{},request:async(path,method='GET',body={})=>{
    if(path==='/planner1/siwc/status')return structuredClone(status);
    if(path==='/planner1/siwc/connect') {window.actionLog.push({path,body});status={...status,state:'AUTHORIZING',legal:{acknowledged:true},attempts:{state:'AUTHORIZING',id:'fixture-attempt',startedAt:'synthetic'}};return{attemptId:'fixture-attempt'};}
    if(path==='/planner1/siwc/cancel'){window.actionLog.push({path});status={...status,state:'DISCONNECTED',attempts:{state:'CANCELLED',id:'fixture-attempt',startedAt:'synthetic'}};return{state:'CANCEL_REQUESTED'};}
    if(path==='/planner1/siwc/profiles')return{profiles:[]};
    if(path==='/planner1/siwc/models')return{models:[]};
    return demo.request(path,method,body);
   },exportRun:demo.exportRun.bind(demo)};
   window.dmTest={adapter,status:()=>status};
   const siwc=new m['siwc-local'].SiwcLocalPanel(adapter);window.dmTest.ui=new m.ui.DreamMakerUI(adapter,siwc);await dmTest.ui.boot();
  }''')
  page.locator('.primary-nav [data-action="settings"]').click()
  expect(page.get_by_role('heading',name='使用 ChatGPT 套餐 · planner1')).to_be_visible();ok('UI01 genuine local settings panel rendered from separate plugin')
  expect(page.locator('#siwc-noncommercial')).to_be_visible();expect(page.get_by_role('button',name='Continue with ChatGPT')).to_be_visible()
  assert page.locator('select#auth-mode').input_value()=='api_key';ok('UI02 original API mode remains default')
  page.get_by_role('button',name='Continue with ChatGPT').click()
  expect(page.locator('.siwc-card [role=alert]')).to_contain_text('请先明确确认');assert page.evaluate('actionLog.length===0');ok('UI03 blocked consent cannot trigger OAuth action')
  page.locator('#siwc-noncommercial').check();page.get_by_role('button',name='Continue with ChatGPT').click()
  page.wait_for_function('actionLog.length===1');assert page.evaluate('actionLog[0].body.localNoncommercial===true')
  expect(page.locator('.siwc-card')).to_contain_text('AUTHORIZING');ok('UI04 explicit click creates fake-only request with license attestation')
  page.locator('.siwc-card [data-action="siwc-cancel"]').click();page.wait_for_function('actionLog.length===2')
  expect(page.locator('.siwc-card')).to_contain_text('DISCONNECTED');ok('UI05 cancel action does not claim OAuth verified')
  page.screenshot(path=str(out/'siwc-settings-offline.png'),full_page=True,animations='disabled');ok('UI06 screenshot recorded with fake-only watermark')
  page.set_viewport_size({'width':375,'height':850});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.screenshot(path=str(out/'siwc-settings-mobile-offline.png'),full_page=True,animations='disabled');ok('UI07 375px layout no horizontal page overflow')
  assert not errors and not requests,(errors,requests);ok('UI08 zero external requests, no uncaught errors in offline browser')
  browser.close()
except Exception as exc:
 checks.append({'name':'OFFLINE_UI_SUITE','status':'FAIL','error':str(exc),'trace':traceback.format_exc()})
 if page:
  try:page.screenshot(path=str(out/'offline-ui-failure.png'),full_page=True)
  except Exception:pass
report={'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'OFFLINE_DOM_WITH_FAKE_ADAPTER_ONLY','checks':checks,'pageErrors':errors,'networkRequests':requests,'browserPolicyModified':False}
(out/'offline-browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'checks':[{'name':x['name'],'status':x['status']} for x in checks],'pageErrors':errors,'networkRequests':requests},ensure_ascii=False))
raise SystemExit(1 if any(x['status']=='FAIL' for x in checks) else 0)
