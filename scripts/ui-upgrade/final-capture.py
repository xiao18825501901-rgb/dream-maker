"""Final SELF_REVIEW captures. Offline DOM + explicit synthetic adapter, no navigation."""
from pathlib import Path
import re,json,shutil,os,datetime
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[2]; out=root/'docs/ui-upgrade/evidence'
html=(root/'dist/web/index.html').read_text()
html=re.sub(r'<script[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html)
html=html.replace('</head>','<style>'+(root/'dist/web/style.css').read_text()+'</style></head>')
html=html.replace('</body>','<div class="fixture-watermark">OFFLINE UI · 合成场景 · 非联网验收</div></body>')
shots=[]
with sync_playwright() as pw:
 exe=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
 browser=pw.chromium.launch(**({'executable_path':exe} if exe else {}),headless=True,args=['--no-sandbox'] if hasattr(os,'geteuid') and os.geteuid()==0 else [])
 page=browser.new_page(viewport={'width':1440,'height':1040},device_scale_factor=1); errors=[];requests=[]
 page.on('pageerror',lambda x:errors.append(str(x)));page.on('request',lambda x:requests.append(x.url))
 page.set_content(html);page.add_script_tag(content=(out/'offline-test-bundle.js').read_text());page.evaluate('dmTest.start()')
 def shot(name,width=1440,height=1040):
  page.set_viewport_size({'width':width,'height':height});page.evaluate('window.scrollTo(0,0)')
  expect(page.locator('#toast')).not_to_be_visible()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.screenshot(path=str(out/name),full_page=True,animations='disabled');shots.append({'file':name,'width':width,'height':height})
 expect(page.locator('.project-card')).to_have_count(3);shot('final-home-1440.png');shot('final-home-768.png',768,980)
 page.locator('.project-card[data-id="sample-clarify"]').click();expect(page.locator('#answer')).to_be_visible();shot('final-interview-1440.png');shot('final-interview-375.png',375,900)
 page.set_viewport_size({'width':1440,'height':1040});page.locator('.primary-nav [data-action=home]').click();page.locator('.project-card[data-id="sample-review"]').click();expect(page.locator('.finding')).to_have_count(1);shot('final-workspace-1440.png')
 page.locator('#tab-spec').click();expect(page.locator('.spec-section').first).to_be_visible();shot('final-spec-1440.png')
 page.locator('.primary-nav [data-action=home]').click();page.locator('#project-name').fill('我的创作日记');page.locator('#idea').fill('我想把每天的小灵感记下来，慢慢做成自己的作品。');page.locator('#new-project button[type=submit]').click()
 for i in range(10):
  expect(page.locator('#app')).to_have_attribute('aria-busy','false');expect(page.locator('#answer')).to_be_visible();page.locator('#answer').fill(['我自己使用，先做一个轻量的网页。','整理零散灵感，保留创作的来龙去脉。','需要记录、搜索和按主题分类。','我会在电脑和手机上使用。','先保留简洁的本地体验。','每条灵感有标题、笔记和日期。','不需要分享和多人协作。','中文优先，步骤要清楚。','能够可靠保存，并找回旧记录。','第一版只把最重要的功能做扎实。'][i]);page.locator('#answer-form button[type=submit]').click()
 expect(page.locator('#dm-dialog')).to_be_visible();shot('final-gate-1440.png');shot('final-gate-375.png',375,900)
 assert not errors and not requests
 browser.close()
(out/'final-captures.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'OFFLINE_DOM_SELF_REVIEW','screenshots':shots,'pageErrors':errors,'networkRequests':requests},ensure_ascii=False,indent=2))
print('Final captures:',len(shots),'OFFLINE_DOM_SELF_REVIEW')
