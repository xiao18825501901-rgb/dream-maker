"""Offline Chromium visual inspection only. Does not claim HTTP/browser E2E."""
import json, pathlib, re, sys
from playwright.sync_api import sync_playwright, expect
root=pathlib.Path(__file__).resolve().parents[2]
out=root/'docs/ui-upgrade/evidence'
html=(root/'dist/web/index.html').read_text()
html=re.sub(r'<script[^>]*>.*?</script>','',html,flags=re.S)
html=re.sub(r'<link[^>]+>','',html)
html=html.replace('</head>','<style>'+(root/'dist/web/style.css').read_text()+'</style></head>')
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':1040},device_scale_factor=1)
 errors=[]
 page.on('pageerror',lambda x:errors.append(str(x)))
 page.set_default_timeout(5000)
 page.set_content(html)
 page.add_script_tag(content=(out/'offline-test-bundle.js').read_text())
 page.evaluate('dmTest.start()')
 expect(page.locator('#new-project')).to_be_visible()
 page.screenshot(path=str(out/'review1-home-1440.png'),full_page=True)
 page.locator('.project-card[data-id="sample-clarify"]').click()
 expect(page.locator('#answer')).to_be_visible()
 page.screenshot(path=str(out/'review1-interview-1440.png'),full_page=True)
 page.set_viewport_size({'width':375,'height':900})
 page.screenshot(path=str(out/'review1-interview-375.png'),full_page=True)
 print(json.dumps({'errors':errors,'domOverflow':page.evaluate('document.documentElement.scrollWidth>innerWidth')},ensure_ascii=False))
 browser.close()
