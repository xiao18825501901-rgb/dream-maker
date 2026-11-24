import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createApp } from '../dist/server/http.js';
import { ModelProvider } from '../dist/server/providers/model.js';
import { defaults } from '../dist/server/config.js';
import { jsonFetch } from '../dist/server/security.js';
import { harness, root } from './helpers.mjs';
import { createServer } from 'node:http';

test('local service refuses public-demo entries and serves only the formal UI graph', async t => {
  const parent=resolve(root,'.runtime/local-only-tests'); mkdirSync(parent,{recursive:true});
  const dir=mkdtempSync(resolve(parent,'http-'));
  const app = await createApp({ root, data: dir, configPath: resolve(dir,'config.json'), port: 0 });
  t.after(async () => { await app.close(); rmSync(dir,{recursive:true,force:true}); });
  for (const name of ['demo-entry.js','demo-api.js','../ui-release/public/index.html','sample/sample.html'])
    assert.equal((await fetch(app.origin + '/' + name)).status,404,name);
  for (const name of ['','app.js','chat-entry.js','chat-shell.js','chat-shell.css','local-api.js','views.js','style.css'])
    assert.equal((await fetch(app.origin + '/' + name)).status,200,name);
  const response = await fetch(app.origin), html = await response.text();
  // The formal entry is the chat shell now; app.js stays served for its ?ui=legacy branch, and the
  // page itself still loads nothing from outside this loopback origin.
  assert.match(html, /src="\/chat-entry\.js"/);
  assert.match(html, /href="\/chat-shell\.css"/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /src="\/app\.js"/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
});

test('provider/protocol mismatch refuses credentials before invoking transport', async () => {
  const c=structuredClone(defaults);
  c.planner1.baseUrl='https://api.deepseek.com';
  c.planner1.model='offline-not-a-model';
  c.planner1.keyEnv='DM_OFFLINE_ROUTE_KEY';
  process.env.DM_OFFLINE_ROUTE_KEY='OFFLINE_DUMMY_VALUE';
  let calls=0;
  try {
    const model=new ModelProvider(()=>c,root,async()=>{calls++;return {data:[]};});
    await assert.rejects(model.models(),{code:'API_PROVIDER_PROTOCOL_MISMATCH'});
    assert.equal(calls,0);
  } finally { delete process.env.DM_OFFLINE_ROUTE_KEY; }
});

test('normal JSON transport refuses unknown URL, numeric-IP and proxy destinations without a socket', async () => {
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('No network permitted in this unit test');};
  try {
    for (const url of ['https://example.invalid/','http://2130706433/health','http://[::1]/health',
      'http://127.0.0.1/anything','https://api.openai.com.evil.invalid/v1/models',
      'https://api.openai.com/v1/search','https://api.deepseek.com/chat/completions?target=elsewhere'])
      await assert.rejects(jsonFetch(url,{}),{code:'NETWORK_TARGET_DENIED'},url);
    assert.equal(calls,0);
  } finally { globalThis.fetch=original; }
});

test('real loopback redirect cannot redirect JSON transport to the public network',async t=>{
  const requests=[];
  const server=createServer((req,res)=>{requests.push(req.url);res.writeHead(302,{location:'https://example.invalid/no-access'});res.end();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  await assert.rejects(jsonFetch(`http://127.0.0.1:${server.address().port}/health`,{}));
  assert.deepEqual(requests,['/health']);
});
