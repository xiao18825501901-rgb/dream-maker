// OFFLINE injected observations over actual local authenticated HTTP. No real account or model.
import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import{join}from'node:path';
import{createApp}from'../../dist/server/http.js';import{defaults}from'../../dist/server/config.js';import{root}from'../helpers.mjs';
const observations=()=>({windows:{available:true,systemProxyEnabled:true,loopbackProxy:true,dshRunning:false},wsl:{available:false,codexLoginRunning:false,codexServerRunning:false,proxyPresent:false,account:{mode:'UNKNOWN',fingerprint:null},rejections:[]},controller:{available:true,selectors:2,nodes:17},dshHistory:null});
async function fixture(t,product,controls={}){const temp=join(root,'.runtime/test-temp');mkdirSync(temp,{recursive:true});const data=mkdtempSync(join(temp,'network-http-'));const config=structuredClone(defaults);controls.configure?.(config);writeFileSync(join(data,'config.json'),JSON.stringify(config));let reads=0,modelCalls=0;
  let checks=0;const app=await createApp({root,data,configPath:join(data,'config.json'),port:0,product,paidRequestGuard:()=>{modelCalls++;throw Error('NO_MODELS');},networkCollector:async()=>{reads++;await controls.metadata?.();return{...observations(),controller:controls.controller?controls.controller():observations().controller};},networkHealthProbe:async()=>{checks++;controls.probe?.(checks);const at=new Date().toISOString(),selectedNode=controls.selectedNode?.()??null;return{schema:'dream-maker.local-proxy-health.v1',scope:'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP',startedAt:at,completedAt:at,state:checks===1?'SHORT_WINDOW_OK':'INTERRUPTED',address:'127.0.0.1:7890',controller:'READABLE',samples:Array.from({length:6},()=>({at,state:checks===1?'CONNECTED':'RESET',elapsedMs:1})),websocket:'NOT_TESTED',modelCalls:0,oauthAttempts:0,networkSettingsChanged:false,openAiTls:{state:checks===1?'TLS_HANDSHAKE_COMPLETED':'TLS_FAILED',target:'api.openai.com:443',protocol:checks===1?'TLSv1.3':null,authorized:checks===1,alpn:checks===1?'http/1.1':null,elapsedMs:25,selectedNode,selectionMatchesExpected:selectedNode?true:null,nodeChainMatched:Boolean(selectedNode),errorClass:checks===1?null:'TLS_HANDSHAKE_FAILED',httpRequestSent:false,modelCalls:0}};}});
 t.after(async()=>{await app.close();rmSync(data,{force:true,recursive:true});});return{app,data,reads:()=>reads,models:()=>modelCalls,checks:()=>checks};}
for(const product of ['dream-maker','dreamflow'])test(product+' authenticates a passive four-environment read without creating roles, projects or approvals',async t=>{
 const x=await fixture(t,product),url=x.app.origin+'/api/network/contexts';assert.equal((await fetch(url)).status,401);assert.equal(x.reads(),0);
 const login=await fetch(x.app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:x.app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0];
 const r=await fetch(url,{headers:{cookie}});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const v=await r.json();assert.equal(v.scope,'PASSIVE_LOCAL_METADATA_NO_LOGIN_OR_INFERENCE');assert.equal(v.contexts.length,4);assert.equal(v.retry.allowed,false);
 await fetch(url,{headers:{cookie}});assert.equal(x.reads(),1);assert.equal(x.models(),0);assert.equal(x.app.store.projects().length,0);assert.equal(x.app.store.runs().length,0);assert.equal(x.app.store.db.prepare('SELECT count(*) AS n FROM approvals').get().n,0);
 assert.equal((await fetch(url,{headers:{cookie,origin:'https://untrusted.invalid'}})).status,403);
});
test('a completed check replays its own evidence after a newer check and process restart',async t=>{
 let second;t.after(()=>second?.close());const x=await fixture(t,'dream-maker');
 async function session(app){const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();return{cookie,'x-csrf-token':csrf,'content-type':'application/json'};}
 const headers=await session(x.app),check=async(app,key,auth)=>{const response=await fetch(app.origin+'/api/network/local-check',{method:'POST',headers:{...auth,'idempotency-key':key},body:'{}'});assert.equal(response.status,200);return response.json();};
 const first=await check(x.app,'check-one',headers),next=await check(x.app,'check-two',headers);assert.equal(first.localProxyHealth.state,'SHORT_WINDOW_OK');assert.equal(next.localProxyHealth.state,'INTERRUPTED');assert.deepEqual((await check(x.app,'check-one',headers)).localProxyHealth,first.localProxyHealth);assert.equal(x.checks(),2);
 await x.app.close();second=await createApp({root,data:x.data,configPath:join(x.data,'config.json'),port:0,networkCollector:async()=>observations(),networkHealthProbe:async()=>{throw Error('MUST_NOT_RERUN');}});const fresh=await session(second);assert.deepEqual((await check(second,'check-one',fresh)).localProxyHealth,first.localProxyHealth);await second.close();second=undefined;
});
test('overlapping metadata collection cannot replace K1 evidence with a later K2 result',{timeout:15000},async t=>{
 let release,entered,second;const gate=new Promise(r=>release=r),entry=new Promise(r=>entered=r),nextProbe=new Promise(r=>second=r);t.after(()=>release());
 const x=await fixture(t,'dream-maker',{metadata:async()=>{entered();await gate;},probe:n=>{if(n===2)second();}}),login=await fetch(x.app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:x.app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const check=key=>fetch(x.app.origin+'/api/network/local-check',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json','idempotency-key':key},body:'{}'}).then(async r=>{assert.equal(r.status,200);return r.json();});
 const a=check('overlap-one');await entry;const b=check('overlap-two');await nextProbe;release();const[first,next]=await Promise.all([a,b]);assert.equal(first.localProxyHealth.state,'SHORT_WINDOW_OK');assert.equal(next.localProxyHealth.state,'INTERRUPTED');
});
test('an idempotent replay cannot restore TLS health after the CFW selection changes or the process restarts',async t=>{
 let node='user-node-a',second;t.after(()=>second?.close());
 const controls={configure(config){config.clash={...config.clash,enabled:true,selectionPolicy:'current'};},controller:()=>({available:true,selectors:2,nodes:17,selectionPolicy:'current',configuredSelector:'selector',configuredNode:null,selectedNode:node,selectionMatchesExpected:null}),selectedNode:()=>node};
 const x=await fixture(t,'dream-maker',controls);
 async function session(app){const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();return{cookie,'x-csrf-token':csrf,'content-type':'application/json'};}
 const check=async(app,auth)=>{const response=await fetch(app.origin+'/api/network/local-check',{method:'POST',headers:{...auth,'idempotency-key':'selection-sensitive-check'},body:'{}'});assert.equal(response.status,200);return response.json();};
 const auth=await session(x.app),first=await check(x.app,auth);
 assert.equal(first.localProxyHealth.openAiTls.selectedNode,'user-node-a');
 node='user-node-b';
 const changed=await check(x.app,auth);
 assert.equal(changed.localProxyHealth,undefined);
 assert.equal(changed.controller.selectedNode,'user-node-b');
 assert.match(changed.openAi.networkReachability.summary,/旧结果已作废|重新检查/);
 await x.app.close();
 second=await createApp({root,data:x.data,configPath:join(x.data,'config.json'),port:0,networkCollector:controls.controller?async()=>({...observations(),controller:controls.controller()}):async()=>observations(),networkHealthProbe:async()=>{throw Error('MUST_NOT_RERUN_HEALTH_AFTER_RESTART');}});
 const replay=await check(second,await session(second));
 assert.equal(replay.localProxyHealth,undefined);
 assert.equal(replay.controller.selectedNode,'user-node-b');
 await second.close();second=undefined;
});
for(const product of ['dream-maker','dreamflow'])test(product+' local short-check requires original authentication, CSRF and idempotency without role dispatch',async t=>{
 const x=await fixture(t,product),url=x.app.origin+'/api/network/local-check';assert.equal((await fetch(url,{method:'POST'})).status,401);assert.equal(x.checks(),0);
 const login=await fetch(x.app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:x.app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 assert.equal((await fetch(url,{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})).status,403);
 const headers={cookie,'x-csrf-token':csrf,'content-type':'application/json','idempotency-key':'local-only-check'};
 assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({url:'https://outside.invalid'})})).status,400);assert.equal(x.checks(),0);
  for(let i=0;i<2;i++){const response=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(response.status,200);const v=await response.json();assert.equal(v.localProxyHealth.scope,'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP');assert.equal(v.openAi.networkReachability.state,'TLS_REACHABLE');assert.equal(v.openAi.authentication.state,'NOT_VERIFIED');assert.equal(v.additionalContexts.length,2);assert.equal(v.contexts[1].service.state,'NOT_VERIFIED');}
 assert.equal(x.checks(),1);assert.equal(x.models(),0);assert.equal(x.app.store.projects().length,0);assert.equal(x.app.store.runs().length,0);
});
