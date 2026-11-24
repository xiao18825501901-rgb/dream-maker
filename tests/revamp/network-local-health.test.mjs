// Real localhost sockets plus synthetic controller data, no model or account qualification.
import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:net';import{once}from'node:events';
import{NetworkContextsService,networkContextsSnapshot}from'../../dist/server/network-contexts.js';
const config={codex:{transport:'wsl'},clash:{enabled:false}},at='2026-11-03T00:00:00Z';
const observations=()=>({windows:{available:true,systemProxyEnabled:true,loopbackProxy:true,developmentCodexRunning:true,magpieRunning:false},wsl:{available:false,codexLoginRunning:false,codexServerRunning:false,proxyPresent:false,account:{mode:'UNKNOWN',fingerprint:null},rejections:[]},controller:{available:true,selectors:2,nodes:17},dshHistory:null});
const tls=(state='NOT_TESTED',target='api.openai.com:443')=>({state,target,protocol:state==='TLS_HANDSHAKE_COMPLETED'?'TLSv1.3':null,authorized:state==='TLS_HANDSHAKE_COMPLETED',alpn:state==='TLS_HANDSHAKE_COMPLETED'?'http/1.1':null,elapsedMs:state==='TLS_HANDSHAKE_COMPLETED'?25:null,selectedNode:null,selectionMatchesExpected:null,nodeChainMatched:false,errorClass:null,httpRequestSent:false,modelCalls:0});
test('development Codex and managed Magpie remain separate from the original four environments',()=>{
 const s=networkContextsSnapshot(config,observations(),at);assert.deepEqual(s.contexts.map(x=>x.id),['windows-browser','wsl-codex-login','codex-app-server','dsh-executor']);assert.deepEqual(s.additionalContexts.map(x=>x.id),['development-codex','magpie-gateway']);
 assert.equal(s.additionalContexts[0].connection.state,'OBSERVED');assert.equal(s.contexts[2].connection.state,'UNAVAILABLE');for(const row of [...s.contexts,...s.additionalContexts]){assert.equal(row.stability.state,'NOT_TESTED');assert.notEqual(row.service.state,'VERIFIED');}
});
test('an unattributed DeepSeek transport request is never presented as a verified DSH role route',()=>{
 const request={
  schema:'dream-maker.routed-request-observation.v1',at,startedAt:at,completedAt:at,
  process:'DM_CONTROLLED_TRANSPORT',targetHost:'api.deepseek.com',method:'POST',
  selectionPolicy:'current',selectedNode:'fixture-node',expectedNode:'fixture-node',
  httpStatus:200,classification:'INFERENCE_COMPLETED',automaticRetryAllowed:false,
  requestIdSha256:'a'.repeat(64),elapsedMs:25
 };
 const s=networkContextsSnapshot(config,{...observations(),latestRoutedRequests:{openAi:null,deepSeek:request}},at),dsh=s.contexts.find(row=>row.id==='dsh-executor');
 assert.equal(s.latestDeepSeekRoutedRequest?.classification,'INFERENCE_COMPLETED');
 assert.equal(dsh?.path.state,'NOT_VERIFIED');
 assert.equal(dsh?.routing?.observed.state,'NOT_VERIFIED');
 assert.equal(dsh?.routing?.expected.state,'DM_ROUTE_DISABLED');
 assert.match(dsh?.path.summary??'',/不能证明|未.*归属|无法.*归属/);
 assert.notEqual(dsh?.service.state,'VERIFIED');
});
test('a newer DeepSeek request cannot hide OpenAI policy evidence and failed TCP cannot certify TLS',()=>{
 const base={schema:'dream-maker.routed-request-observation.v1',at,startedAt:at,completedAt:at,process:'DM_CONTROLLED_TRANSPORT',method:'POST',selectionPolicy:'current',selectedNode:'fixture-node',expectedNode:'fixture-node',automaticRetryAllowed:false,requestIdSha256:null,elapsedMs:12};
 const deepSeek={...base,targetHost:'api.deepseek.com',httpStatus:200,classification:'INFERENCE_COMPLETED'};
 for(const [classification,httpStatus] of [['REGION_OR_POLICY_RESTRICTED',403],['TCP_CONNECTION_FAILURE',null]]){
  const openAi={...base,targetHost:'api.openai.com',httpStatus,classification};
  const s=networkContextsSnapshot(config,{...observations(),latestRoutedRequest:deepSeek,latestRoutedRequests:{openAi,deepSeek}},at);
  assert.equal(s.latestRoutedRequest.targetHost,'api.deepseek.com');
  assert.equal(s.openAi.serviceEligibility.state,httpStatus===403?'POLICY_BLOCKED':'NOT_VERIFIED');
  assert.equal(s.openAi.networkReachability.state,httpStatus===null?'UNREACHABLE':'TLS_REACHABLE');
  assert.notEqual(s.openAi.authentication.state,'AUTHENTICATED');
 }
});
test('newer Codex authentication failure does not inherit older API inference eligibility',()=>{
 const later='2026-11-03T00:01:00Z';
 const api={schema:'dream-maker.routed-request-observation.v1',at,startedAt:at,completedAt:at,process:'DM_CONTROLLED_TRANSPORT',targetHost:'api.openai.com',method:'POST',selectionPolicy:'current',selectedNode:'fixture-node',expectedNode:'fixture-node',httpStatus:200,classification:'INFERENCE_COMPLETED',automaticRetryAllowed:false,requestIdSha256:null,elapsedMs:12};
 const codex={schema:'dream-maker.codex-request-path.v1',at:later,startedAt:later,completedAt:later,role:'reviewer',method:'turn/start',targetHost:null,targetPort:443,path:'PROCESS_ROUTE_NOT_OBSERVED',processPid:42,processIdentitySha256:null,sourcePortSha256:null,proxyEndpoint:null,selectedNode:null,expectedNode:null,chains:[],classification:'HTTP_401_AUTHENTICATION_FAILED',httpStatus:401,requestIdSha256:null,automaticRetryAllowed:false};
 const s=networkContextsSnapshot({...config,codex:{transport:'stdio'}},{...observations(),latestRoutedRequests:{openAi:api,deepSeek:null},latestCodexRequest:codex},later);
 assert.equal(s.openAi.authentication.state,'FAILED');
 assert.equal(s.openAi.serviceEligibility.state,'NOT_VERIFIED');
 assert.equal(s.openAi.inference.state,'FAILED');
});
test('local probe has six actual TCP samples and never certifies a model, WSL route or WebSocket',async()=>{
 const {observeLocalProxyHealth}=await import('../../dist/server/network-local-health.js');const server=createServer(s=>s.end());server.listen(0,'127.0.0.1');await once(server,'listening');let controllerReads=0;
  try{const h=await observeLocalProxyHealth({proxyUrl:'http://127.0.0.1:'+server.address().port,controller:{version:async()=>{controllerReads++;return{version:'SYNTHETIC'};}},signal:new AbortController().signal,tlsProbe:async()=>tls('TLS_HANDSHAKE_COMPLETED'),codexTlsProbe:async()=>tls('TLS_HANDSHAKE_COMPLETED','chatgpt.com:443'),codexControlTlsProbes:{'ws.chatgpt.com':async()=>tls('TLS_HANDSHAKE_COMPLETED','ws.chatgpt.com:443'),'codex-cloud-backend.chatgpt.com':async()=>tls('TLS_HANDSHAKE_COMPLETED','codex-cloud-backend.chatgpt.com:443'),'codex-cloud-environments.chatgpt.com':async()=>tls('TLS_HANDSHAKE_COMPLETED','codex-cloud-environments.chatgpt.com:443')},deepSeekTlsProbe:async()=>tls('TLS_HANDSHAKE_COMPLETED','api.deepseek.com:443')},async()=>{});assert.equal(h.samples.length,6);assert.equal(h.state,'SHORT_WINDOW_OK');assert.equal(controllerReads,2);assert.equal(h.scope,'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP');assert.equal(h.websocket,'NOT_TESTED');assert.equal(h.modelCalls,0);assert.equal(h.oauthAttempts,0);assert.equal(h.openAiTls.state,'TLS_HANDSHAKE_COMPLETED');assert.equal(h.codexTls.state,'TLS_HANDSHAKE_COMPLETED');assert.equal(h.codexTls.target,'chatgpt.com:443');assert.deepEqual(h.codexControlTlsProbes.map(x=>x.target),['ws.chatgpt.com:443','codex-cloud-backend.chatgpt.com:443','codex-cloud-environments.chatgpt.com:443']);assert.ok(h.codexControlTlsProbes.every(x=>x.httpRequestSent===false&&x.modelCalls===0));assert.equal(h.deepSeekTls.state,'TLS_HANDSHAKE_COMPLETED');assert.equal(h.deepSeekTls.target,'api.deepseek.com:443');}
 finally{await new Promise(r=>server.close(r));}
});
test('API and Codex-login endpoints are checked independently without an HTTP request',async()=>{
  const {observeLocalProxyHealth}=await import('../../dist/server/network-local-health.js');const server=createServer(s=>s.end());server.listen(0,'127.0.0.1');await once(server,'listening');let apiCalls=0,codexCalls=0;
  try{
    const h=await observeLocalProxyHealth({
      proxyUrl:'http://127.0.0.1:'+server.address().port,
      controller:{version:async()=>({version:'SYNTHETIC'})},
      signal:new AbortController().signal,
      tlsProbe:async()=>{apiCalls++;return tls('TLS_HANDSHAKE_COMPLETED','api.openai.com:443');},
      codexTlsProbe:async()=>{codexCalls++;return tls('TLS_FAILED','chatgpt.com:443');}
    },async()=>{});
    assert.equal(apiCalls,1);assert.equal(codexCalls,1);
    assert.equal(h.openAiTls.state,'TLS_HANDSHAKE_COMPLETED');
    assert.equal(h.codexTls.state,'TLS_FAILED');
    assert.equal(h.codexTls.httpRequestSent,false);
    assert.equal(h.codexTls.modelCalls,0);
  }finally{await new Promise(r=>server.close(r));}
});
test('TLS probe CONNECT authorities are the requested API, login and control hosts',async()=>{
  const {probeOpenAiTls,probeCodexTls,probeCodexControlTls,probeDeepSeekTls}=await import('../../dist/server/clash-transport.js');
  const authorities=[];const server=createServer(socket=>{
    socket.once('data',chunk=>{authorities.push(chunk.toString('latin1').split('\r\n',1)[0]);socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');});
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const input={proxyUrl:'http://127.0.0.1:'+server.address().port,controller:{traceConnection:async()=>({chains:[],inboundPortMatched:false})},configuredNode:null,signal:AbortSignal.timeout(5000)};
  try{
    await assert.rejects(probeOpenAiTls(input));await assert.rejects(probeCodexTls(input));await assert.rejects(probeDeepSeekTls(input));
    await assert.rejects(probeCodexControlTls(input,'ws.chatgpt.com'));
    await assert.rejects(probeCodexControlTls(input,'codex-cloud-backend.chatgpt.com'));
    await assert.rejects(probeCodexControlTls(input,'codex-cloud-environments.chatgpt.com'));
    assert.equal(authorities.length,6);
    assert.match(authorities[0],/^CONNECT api[.]openai[.]com:443 HTTP\/1[.]1$/);
    assert.match(authorities[1],/^CONNECT chatgpt[.]com:443 HTTP\/1[.]1$/);
    assert.match(authorities[2],/^CONNECT api[.]deepseek[.]com:443 HTTP\/1[.]1$/);
    assert.match(authorities[3],/^CONNECT ws[.]chatgpt[.]com:443 HTTP\/1[.]1$/);
    assert.match(authorities[4],/^CONNECT codex-cloud-backend[.]chatgpt[.]com:443 HTTP\/1[.]1$/);
    assert.match(authorities[5],/^CONNECT codex-cloud-environments[.]chatgpt[.]com:443 HTTP\/1[.]1$/);
  }finally{await new Promise(r=>server.close(r));}
});
test('a closed local port is a connection failure, not a regional-policy verdict',async()=>{
 const {observeLocalProxyHealth}=await import('../../dist/server/network-local-health.js');const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
 const h=await observeLocalProxyHealth({proxyUrl:'http://127.0.0.1:'+port,controller:{version:async()=>{throw Error('PRIVATE_CANARY');}},signal:new AbortController().signal},async()=>{});assert.equal(h.state,'INTERRUPTED');assert.ok(h.samples.every(x=>x.state==='REFUSED'));assert.doesNotMatch(JSON.stringify(h),/PRIVATE_CANARY|POLICY_BLOCKED/);
});
test('local probe rejects remote targets and aborts without silently retrying',async()=>{
 const {observeLocalProxyHealth}=await import('../../dist/server/network-local-health.js');const controller={version:async()=>({version:'SYNTHETIC'})},a=new AbortController();a.abort();await assert.rejects(observeLocalProxyHealth({proxyUrl:'http://127.0.0.1:7890',controller,signal:a.signal}),e=>e.code==='NETWORK_CHECK_CANCELLED');for(const proxyUrl of ['https://example.com','http://192.168.1.1:7890','http://user:password@127.0.0.1:7890'])await assert.rejects(observeLocalProxyHealth({proxyUrl,controller,signal:new AbortController().signal}),e=>e.code==='NETWORK_LOCAL_TARGET_REQUIRED');
});
test('local stability is shared only as a limited observation and is discarded after configuration changes',async()=>{
  let current=structuredClone(config),checks=0;const health={schema:'dream-maker.local-proxy-health.v1',scope:'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP',startedAt:at,completedAt:at,state:'SHORT_WINDOW_OK',address:'127.0.0.1:7890',controller:'READABLE',samples:Array.from({length:6},()=>({at,state:'CONNECTED',elapsedMs:1})),websocket:'NOT_TESTED',modelCalls:0,oauthAttempts:0,networkSettingsChanged:false,openAiTls:tls('TLS_HANDSHAKE_COMPLETED')};
  const service=new NetworkContextsService(()=>current,async()=>observations(),Date.now,async()=>{checks++;return health;});assert.equal(typeof service.diagnose,'function');await service.diagnose();const s=await service.snapshot();assert.equal(s.localProxyHealth.state,'SHORT_WINDOW_OK');assert.equal(s.openAi.networkReachability.state,'TLS_REACHABLE');assert.equal(s.openAi.authentication.state,'NOT_VERIFIED');assert.equal(s.contexts[1].path.state,'NOT_VERIFIED');assert.equal(s.contexts[1].stability.state,'NOT_TESTED');current={...current,clash:{enabled:true}};assert.equal((await service.snapshot()).localProxyHealth,undefined);assert.equal(checks,1);await service.close();
});
test('closing the original service cancels and joins its current local connectivity check',async()=>{
 let entered,done=false;const started=new Promise(r=>entered=r),service=new NetworkContextsService(()=>config,async()=>observations(),Date.now,async(_c,signal)=>{entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));done=true;throw Object.assign(Error('CLOSED'),{code:'NETWORK_CHECK_CANCELLED'});});assert.equal(typeof service.diagnose,'function');const p=service.diagnose();await started;const rejected=assert.rejects(p);await service.close();await rejected;assert.equal(done,true);await assert.rejects(service.diagnose(),e=>e.code==='NETWORK_CONTEXTS_CLOSED');
});
test('an in-place endpoint change, including change-and-restore during sampling, cannot certify the old path',async()=>{
  const health={schema:'dream-maker.local-proxy-health.v1',scope:'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP',startedAt:at,completedAt:at,state:'SHORT_WINDOW_OK',address:'127.0.0.1:7890',controller:'READABLE',samples:Array.from({length:6},()=>({at,state:'CONNECTED',elapsedMs:1})),websocket:'NOT_TESTED',modelCalls:0,oauthAttempts:0,networkSettingsChanged:false,openAiTls:tls()};
 for(const restore of [false,true]){let endpoint='a'.repeat(64);const service=new NetworkContextsService(()=>config,async()=>observations(),Date.now,async()=>{endpoint=restore?'a'.repeat(64):'b'.repeat(64);return{...health,endpointFingerprint:restore?'b'.repeat(64):'a'.repeat(64)};},()=>endpoint);await assert.rejects(service.diagnose(),e=>e.code==='NETWORK_CONFIGURATION_CHANGED');assert.equal((await service.snapshot()).localProxyHealth,undefined);await service.close();}
});
test('metadata collected under old settings cannot be relabeled as the new check configuration',async()=>{
  let current=structuredClone(config),release,entered;const gate=new Promise(r=>release=r),entry=new Promise(r=>entered=r),health={schema:'dream-maker.local-proxy-health.v1',scope:'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP',startedAt:at,completedAt:at,state:'SHORT_WINDOW_OK',address:'127.0.0.1:7890',controller:'READABLE',samples:Array.from({length:6},()=>({at,state:'CONNECTED',elapsedMs:1})),websocket:'NOT_TESTED',modelCalls:0,oauthAttempts:0,networkSettingsChanged:false,openAiTls:tls()};
  const service=new NetworkContextsService(()=>current,async()=>{entered();await gate;return observations();},Date.now,async()=>health),oldRead=service.snapshot();
  await entry;
  const check=await service.diagnose();
  current=structuredClone(config);
  current.clash={enabled:true};
  const combined=service.snapshotForCheck(check),rejected=assert.rejects(combined,e=>e.code==='NETWORK_CONFIGURATION_CHANGED');release();await oldRead;await rejected;await service.close();
});
const selectedHealth=node=>({
  schema:'dream-maker.local-proxy-health.v1',scope:'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP',startedAt:at,completedAt:at,
  state:'SHORT_WINDOW_OK',address:'127.0.0.1:7890',controller:'READABLE',
  samples:Array.from({length:6},()=>({at,state:'CONNECTED',elapsedMs:1})),
  websocket:'NOT_TESTED',modelCalls:0,oauthAttempts:0,networkSettingsChanged:false,
  openAiTls:{...tls('TLS_HANDSHAKE_COMPLETED'),selectedNode:node,selectionMatchesExpected:true,nodeChainMatched:true}
});
const selectedObservations=node=>{
  const value=observations();
  value.controller={available:true,selectors:2,nodes:17,selectionPolicy:'current',configuredSelector:'selector',configuredNode:null,selectedNode:node,selectionMatchesExpected:null};
  return value;
};
test('a selector change invalidates the previous TLS health even when the Clash files are unchanged',async()=>{
  let node='user-node-a',now=Date.parse(at);
  const current={...structuredClone(config),clash:{enabled:true,selectionPolicy:'current'}};
  const service=new NetworkContextsService(()=>current,async()=>selectedObservations(node),()=>now,async()=>selectedHealth('user-node-a'));
  await service.diagnose();
  assert.equal((await service.snapshot()).localProxyHealth.openAiTls.selectedNode,'user-node-a');
  node='user-node-b';now+=16000;
  const changed=await service.snapshot();
  assert.equal(changed.localProxyHealth,undefined);
  assert.equal(changed.openAi.networkReachability.state,'NOT_TESTED');
  assert.match(changed.openAi.networkReachability.summary,/节点.*变化|旧.*作废|重新检查/);
  await service.close();
});
test('a check result cannot be projected after the user changes selection',async()=>{
  let node='user-node-a';
  const current={...structuredClone(config),clash:{enabled:true,selectionPolicy:'current'}};
  const service=new NetworkContextsService(()=>current,async()=>selectedObservations(node),()=>Date.parse(at),async()=>selectedHealth('user-node-a'));
  const check=await service.diagnose();
  node='user-node-b';
  await assert.rejects(service.snapshotForCheck(check),e=>e.code==='NETWORK_CONFIGURATION_CHANGED');
  await service.close();
});
test('a replayed check hides its TLS health when the controller now selects another node',async()=>{
  const current={...structuredClone(config),clash:{enabled:true,selectionPolicy:'current'}};
  const service=new NetworkContextsService(()=>current,async()=>selectedObservations('user-node-b'),()=>Date.parse(at),async()=>selectedHealth('user-node-a'));
  const raw=networkContextsSnapshot(current,selectedObservations('user-node-a'),at);
  raw.localProxyHealth=selectedHealth('user-node-a');
  raw.configurationFingerprint=(await service.snapshot()).configurationFingerprint;
  const replay=await service.replayCheck(raw);
  assert.equal(replay.localProxyHealth,undefined);
  assert.equal(replay.openAi.networkReachability.state,'NOT_TESTED');
  await service.close();
});
test('a pre-existing metadata read cannot certify the node selected after the probe',async()=>{
  let node='user-node-a',release,entered,reads=0;
  const gate=new Promise(resolve=>{release=resolve;}),entry=new Promise(resolve=>{entered=resolve;});
  const current={...structuredClone(config),clash:{enabled:true,selectionPolicy:'current'}};
  const service=new NetworkContextsService(()=>current,async()=>{
    reads++;
    const selected=node;
    if(reads===1){entered();await gate;}
    return selectedObservations(selected);
  },()=>Date.parse(at),async()=>selectedHealth(node));
  const oldRead=service.snapshot();
  await entry;
  node='user-node-b';
  const check=await service.diagnose(),projected=service.snapshotForCheck(check);
  release();
  await oldRead;
  const result=await projected;
  assert.equal(result.controller.selectedNode,'user-node-b');
  assert.equal(result.localProxyHealth.openAiTls.selectedNode,'user-node-b');
  assert.equal(reads,2);
  await service.close();
});
test('a TLS failure before node association remains visible instead of being misreported as a selector change',async()=>{
  const node='user-node-a',current={...structuredClone(config),clash:{enabled:true,selectionPolicy:'current'}};
  const health=selectedHealth(node);
  health.openAiTls={...tls('TLS_FAILED'),target:'api.openai.com:443',errorClass:'TLS_HANDSHAKE_FAILED'};
  const service=new NetworkContextsService(()=>current,async()=>selectedObservations(node),()=>Date.parse(at),async()=>health);
  await service.diagnose();
  const snapshot=await service.snapshot();
  assert.equal(snapshot.localProxyHealth?.openAiTls.state,'TLS_FAILED');
  assert.equal(snapshot.localProxyHealth?.openAiTls.errorClass,'TLS_HANDSHAKE_FAILED');
  assert.equal(snapshot.openAi.networkReachability.state,'UNREACHABLE');
  assert.doesNotMatch(snapshot.openAi.networkReachability.summary,/节点.*变化|旧结果已作废/);
  await service.close();
});
test('a TLS success without node association is not promoted to current-node reachability',async()=>{
  const node='user-node-a',current={...structuredClone(config),clash:{enabled:true,selectionPolicy:'current'}};
  const health=selectedHealth(node);
  health.openAiTls={...tls('TLS_HANDSHAKE_COMPLETED'),target:'api.openai.com:443'};
  const service=new NetworkContextsService(()=>current,async()=>selectedObservations(node),()=>Date.parse(at),async()=>health);
  await service.diagnose();
  const snapshot=await service.snapshot();
  assert.equal(snapshot.localProxyHealth?.openAiTls.state,'TLS_HANDSHAKE_COMPLETED');
  assert.equal(snapshot.localProxyHealth?.openAiTls.selectedNode,null);
  assert.equal(snapshot.openAi.networkReachability.state,'TCP_REACHABLE_ONLY');
  assert.match(snapshot.openAi.networkReachability.summary,/关联|路径|节点/);
  await service.close();
});
