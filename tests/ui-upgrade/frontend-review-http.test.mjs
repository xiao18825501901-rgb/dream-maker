import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createReviewServer} from '../../scripts/ui-upgrade/serve-frontend-review.mjs';

test('loopback review server serves the real shared view graph and refuses controller access',async t=>{
 const app=await createReviewServer({product:'dream-maker',port:0});t.after(()=>app.close());
 const home=await fetch(app.url),html=await home.text();assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy'),/connect-src 'none'/);
  // The review home is derived from the served dist home page: the review entry replaces the chat
  // entry, the chat stylesheet is swapped for the legacy cascade, and no business controller is ever
  // reachable from it. The chat entry must not survive the rewrite.
  assert.match(html,/src="\/frontend-review-app\.js"/,"review home mounts the review entry");
  assert.doesNotMatch(html,/chat-entry\.js/,"review home drops the chat entry");
  assert.match(html,/本地前端导览/,"review home carries the review title");
 assert.doesNotMatch(html,/src="\/app\.js"/);assert.doesNotMatch(html,/src="\/chat-controller\.js"/);
 const visited=new Set();async function graph(path){if(visited.has(path))return;visited.add(path);const res=await fetch(app.url+path.slice(1));assert.equal(res.status,200,path);const source=await res.text();for(const match of source.matchAll(/^\s*(?:import\s+(?:[^\n;]*?\sfrom\s*)?|export\s+[^\n;]*?\sfrom\s*)['"]([^'"]+)['"]/gm)){const url=new URL(match[1],app.url+path.slice(1));assert.equal(url.origin,new URL(app.url).origin);await graph(url.pathname);}}
 await graph('/frontend-review-app.js');assert.ok(visited.has('/ui.js'));assert.ok(visited.has('/views.js'));assert.ok(visited.has('/frontend-review-api.js'));assert.ok(!visited.has('/local-api.js'));
 for(const path of ['api/config','api/projects','local-api.js','app.js','demo-entry.js','.runtime/server.lock','server/main.js','frontend-review-flow-app.js','chat-entry.js','chat-shell.js','chat-controller.js','chat-shell.css'])assert.equal((await fetch(app.url+path)).status,404,path);
 assert.equal((await fetch(app.url,{method:'POST'})).status,405);assert.equal((await fetch(app.url,{headers:{Origin:'https://foreign.invalid'}})).status,403);
 for(const path of ['sample.css','sample.js'])assert.equal((await fetch(app.url+path)).headers.get('cross-origin-resource-policy'),'cross-origin');
 assert.equal((await fetch(app.url+'ui.js')).headers.get('cross-origin-resource-policy'),'same-origin');
});
test('standalone review is a separate compile entry with independent synthetic state',async t=>{
 const app=await createReviewServer({product:'dreamflow',port:0});t.after(()=>app.close());
 assert.equal(app.product,'dreamflow');
 const home=await fetch(app.url);assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy'),/connect-src 'none'/);
 // The two reviews are separate compile entries: selecting one never serves the other's bootstrap.
 assert.equal((await fetch(app.url+'frontend-review-app.js')).status,404);
 const entry=await fetch(app.url+'frontend-review-flow-app.js');assert.equal(entry.status,200);assert.match(entry.headers.get('content-type'),/javascript/);
 assert.match(await entry.text(),/new DreamMakerUI\(new FrontendReviewAdapter\('dreamflow'\),\s*undefined,\s*'dreamflow'\)\.boot\(\)/);
 assert.equal((await fetch(app.url+'frontend-review-api.js')).status,200);assert.equal((await fetch(app.url+'local-api.js')).status,404);
});
