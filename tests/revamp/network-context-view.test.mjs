// Presentation/escaping only. These observations do not qualify a role or route.
import test from 'node:test';import assert from 'node:assert/strict';
import{networkContextsPanel,readNetworkContexts,readCodexMetadataObservation}from'../../dist/web/network-context-view.js';
import{networkContextsSnapshot}from'../../dist/server/network-contexts.js';
const snapshot=()=>networkContextsSnapshot({codex:{transport:'wsl'},clash:{enabled:false}},{windows:{available:true,systemProxyEnabled:true,loopbackProxy:true},wsl:{available:true,codexLoginRunning:false,codexServerRunning:false,proxyPresent:false,account:{mode:'CHATGPT',fingerprint:'a'.repeat(16)},rejections:[{at:'2026-11-03T00:00:00Z',httpStatus:403,reason:'REGION_UNSUPPORTED',requestId:'abcdef…-TST'}]},controller:{available:true,selectors:2,nodes:17},dshHistory:null},'2026-11-03T00:00:00Z');
test('settings presents all four separate environments, unknown path and recorded refusal in plain Chinese',()=>{const value=readNetworkContexts(snapshot()),html=networkContextsPanel({networkContexts:value});for(const name of ['Windows 浏览器','WSL Codex 登录','Codex app-server','DSH 执行器'])assert.ok(html.includes(name));assert.match(html,/历史登录.*拒绝/);assert.match(html,/读取本机状态/);assert.match(html,/切换.*节点.*不能.*资格/);assert.doesNotMatch(html,/data-action="(?:login|clash-verify|clash-recover|clash-select|clash-node)"|POLICY_BLOCKED|SCOPE_BLOCKED/);assert.match(html,/没有.*登录|不会.*登录/);});
test('empty, pending and failed reads have distinct feedback without an invented successful connection',()=>{assert.match(networkContextsPanel({}),/尚未读取/);assert.match(networkContextsPanel({networkLoading:true}),/正在读取/);assert.match(networkContextsPanel({networkError:'本机状态未读取'}),/本机状态未读取/);assert.doesNotMatch(networkContextsPanel({}),/全部已连接|全部正常/);});
test('local short-check announces its bounded TCP and TLS scope without claiming no external probe',()=>{
 const loading=networkContextsPanel({networkLoading:true,networkTesting:true});
  assert.match(loading,/到已有代理及模型目标域的 TCP\/TLS/);
  assert.match(loading,/OpenAI API、ChatGPT 登录域与 DeepSeek Executor API/);
 assert.match(loading,/不发送 HTTP、认证头或模型请求/);
 assert.doesNotMatch(loading,/没有发起外网探测/);
 assert.doesNotMatch(loading,/没有发起外部网络探测/);
});
test('stale settings and untrusted text are explicit and escaped',()=>{const s=snapshot();s.currentConfiguration=false;s.contexts[0].connection.summary='<img src=x onerror=alert(1)>';const html=networkContextsPanel({networkContexts:s});assert.match(html,/设置.*变化|旧设置/);assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));});
test('dashboard shows wildcard listener scope and owner relation without granting eligibility',()=>{
 const s=snapshot();
 s.controller.proxyListener={state:'NON_LOOPBACK',mixedPort:7890,bindings:['WILDCARD'],ownerMatchesController:true,allowLan:true,bindAddress:'*'};
 const html=networkContextsPanel({networkContexts:readNetworkContexts(s)});
 assert.match(html,/代理监听/);
 assert.match(html,/通配/);
 assert.match(html,/同一.*进程|同一 CFW 进程/);
 assert.match(html,/不会修改|不代表.*外部.*可访问/);
 assert.equal(readNetworkContexts(s).openAi.authentication.state,'NOT_VERIFIED');
 assert.throws(()=>readNetworkContexts({...s,controller:{...s.controller,proxyListener:{...s.controller.proxyListener,bindings:['PUBLIC']}}}));
});
test('incomplete or reordered helper rows cannot silently become a valid current snapshot',()=>{const s=snapshot();assert.throws(()=>readNetworkContexts({...s,contexts:s.contexts.slice(1)}));assert.throws(()=>readNetworkContexts({...s,automaticLogin:true}));assert.throws(()=>readNetworkContexts({...s,contexts:[...s.contexts].reverse()}));assert.throws(()=>readNetworkContexts({...s,eligibilityPolicy:{...s.eligibilityPolicy,automaticRegionSwitch:true}}));assert.throws(()=>readNetworkContexts({...s,eligibilityPolicy:{...s.eligibilityPolicy,proxyChangeIsEligibilityEvidence:true}}));});
test('six context cards and explicit local short-check never label per-role external stability as verified',()=>{
 const s=readNetworkContexts(snapshot()),html=networkContextsPanel({networkContexts:s});for(const name of ['开发 Codex','Magpie 专属网关','稳定性','尚未核验此进程','短测本地连接'])assert.ok(html.includes(name));assert.match(html,/data-action="network-test"/);assert.throws(()=>readNetworkContexts({...s,additionalContexts:[...s.additionalContexts].reverse()}));
  const at='2026-11-03T00:00:00Z',control=target=>({state:'TLS_HANDSHAKE_COMPLETED',target:target+':443',protocol:'TLSv1.3',authorized:true,alpn:'http/1.1',elapsedMs:26,selectedNode:'fixture-node',selectionMatchesExpected:true,nodeChainMatched:true,errorClass:null,httpRequestSent:false,modelCalls:0}),h={schema:'dream-maker.local-proxy-health.v1',scope:'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP',startedAt:at,completedAt:at,state:'SHORT_WINDOW_OK',address:'127.0.0.1:7890',controller:'READABLE',samples:Array.from({length:6},()=>({at,state:'CONNECTED',elapsedMs:1})),websocket:'NOT_TESTED',modelCalls:0,oauthAttempts:0,networkSettingsChanged:false,openAiTls:{state:'TLS_HANDSHAKE_COMPLETED',target:'api.openai.com:443',protocol:'TLSv1.3',authorized:true,alpn:'http/1.1',elapsedMs:25,selectedNode:'fixture-node',selectionMatchesExpected:true,nodeChainMatched:true,errorClass:null,httpRequestSent:false,modelCalls:0},codexTls:{state:'TLS_HANDSHAKE_COMPLETED',target:'chatgpt.com:443',protocol:'TLSv1.3',authorized:true,alpn:'http/1.1',elapsedMs:30,selectedNode:'fixture-node',selectionMatchesExpected:true,nodeChainMatched:true,errorClass:null,httpRequestSent:false,modelCalls:0},codexControlTlsProbes:[control('ws.chatgpt.com'),control('codex-cloud-backend.chatgpt.com'),control('codex-cloud-environments.chatgpt.com')],deepSeekTls:{state:'TLS_HANDSHAKE_COMPLETED',target:'api.deepseek.com:443',protocol:'TLSv1.3',authorized:true,alpn:'http/1.1',elapsedMs:28,selectedNode:'fixture-node',selectionMatchesExpected:true,nodeChainMatched:true,errorClass:null,httpRequestSent:false,modelCalls:0}};
  const value=readNetworkContexts({...s,localProxyHealth:h,openAi:{...s.openAi,networkReachability:{state:'TLS_REACHABLE',summary:'TLS handshake only'}}}),view=networkContextsPanel({networkContexts:value});assert.match(view,/没有发送认证头或模型请求/);assert.match(view,/没有核验各 Agent/);for(const change of [{modelCalls:1},{websocket:'VERIFIED'},{address:'evil.example:7890'},{state:'SHORT_WINDOW_OK',controller:'UNAVAILABLE'},{openAiTls:{...h.openAiTls,httpRequestSent:true}},{openAiTls:{...h.openAiTls,modelCalls:1}}])assert.throws(()=>readNetworkContexts({...s,localProxyHealth:{...h,...change}}));
  assert.match(view,/OpenAI API TLS/);assert.match(view,/ChatGPT 登录域 TLS/);assert.match(view,/Codex WebSocket 控制域 TLS/);assert.match(view,/Codex 云端后端 TLS/);assert.match(view,/Codex 云端环境 TLS/);assert.match(view,/ws[.]chatgpt[.]com:443/);assert.match(view,/codex-cloud-backend[.]chatgpt[.]com:443/);assert.match(view,/codex-cloud-environments[.]chatgpt[.]com:443/);assert.match(view,/WebSocket 会话仍未测试/);assert.match(view,/DeepSeek Executor API TLS/);assert.match(view,/api[.]openai[.]com:443/);assert.match(view,/chatgpt[.]com:443/);assert.match(view,/api[.]deepseek[.]com:443/);
  for(const change of [
    {codexTls:{...h.codexTls,target:'api.openai.com:443'}},
    {codexTls:{...h.codexTls,httpRequestSent:true}},
    {deepSeekTls:{...h.deepSeekTls,target:'chatgpt.com:443'}},
    {deepSeekTls:{...h.deepSeekTls,modelCalls:1}},
    {openAiTls:{...h.openAiTls,target:'chatgpt.com:443'}},
    {codexControlTlsProbes:[...h.codexControlTlsProbes,control('ws.chatgpt.com')]},
    {codexControlTlsProbes:[control('ws.chatgpt.com'),control('ws.chatgpt.com'),control('codex-cloud-backend.chatgpt.com')]},
    {codexControlTlsProbes:[{...control('ws.chatgpt.com'),httpRequestSent:true}]}
  ])assert.throws(()=>readNetworkContexts({...s,localProxyHealth:{...h,...change}}));
});
test('latest controlled request shows route, status and retry boundary without exposing request identifiers',()=>{
 const s=snapshot();s.latestRoutedRequest={schema:'dream-maker.routed-request-observation.v1',at:'2026-11-03T00:00:00Z',startedAt:'2026-11-03T00:00:00Z',completedAt:'2026-11-03T00:00:00Z',process:'DM_CONTROLLED_TRANSPORT',role:'planner1',targetHost:'api.openai.com',method:'POST',selectionPolicy:'current',selectedNode:'fixture-node',expectedNode:'fixture-node',httpStatus:403,classification:'REGION_OR_POLICY_RESTRICTED',automaticRetryAllowed:false,requestIdSha256:'e'.repeat(64),elapsedMs:20};
 const html=networkContextsPanel({networkContexts:readNetworkContexts(s)});for(const text of ['最近一次受控外部请求','Seeker','api.openai.com','REGION_OR_POLICY_RESTRICTED','禁止自动重试'])assert.ok(html.includes(text));assert.doesNotMatch(html,new RegExp('e'.repeat(64)));assert.throws(()=>readNetworkContexts({...s,latestRoutedRequest:{...s.latestRoutedRequest,role:'unknown'}}));
});
test('latest Codex request shows the request-level CFW chain and observed control hosts without upgrading route evidence',()=>{
 const s=snapshot();s.latestCodexRequest={schema:'dream-maker.codex-request-path.v1',at:'2026-11-03T00:00:00Z',startedAt:'2026-11-03T00:00:00Z',completedAt:'2026-11-03T00:00:00Z',role:'reviewer',method:'turn/start',targetHost:'chatgpt.com',targetPort:443,path:'REQUEST_ROUTE_VERIFIED',processPid:4242,processIdentitySha256:'a'.repeat(64),sourcePortSha256:'b'.repeat(64),proxyEndpoint:'127.0.0.1:7890',selectedNode:'fixture-node',expectedNode:'fixture-node',chains:['fixture-node','fixture-group'],classification:'INFERENCE_COMPLETED',httpStatus:200,requestIdSha256:'c'.repeat(64),automaticRetryAllowed:false};
 s.latestCodexRequest={...s.latestCodexRequest,targetHosts:['chatgpt.com','ws.chatgpt.com','codex-cloud-backend.chatgpt.com'],sourcePortCount:3};
 const html=networkContextsPanel({networkContexts:readNetworkContexts(s)});for(const text of ['最近一次 Codex app-server 请求路径','Reviewer','chatgpt.com','ws.chatgpt.com','codex-cloud-backend.chatgpt.com','fixture-node','fixture-node → fixture-group','INFERENCE_COMPLETED','请求级历史记录','回合编号摘要（不是 HTTP 请求 ID）','根进程启动身份及最多 64 个已核验后代进程','观察到控制通道主机','不证明 WebSocket 会话认证或持续稳定','开始时间','结束时间'])assert.ok(html.includes(text));assert.match(html,/不会把父进程、同名 PID 或未归属连接当成路径证据/);assert.doesNotMatch(html,/请求编号摘要/);assert.doesNotMatch(html,new RegExp('c'.repeat(64)));assert.equal(readNetworkContexts(s).latestCodexRequest?.path,'REQUEST_ROUTE_VERIFIED');assert.throws(()=>readNetworkContexts({...s,latestCodexRequest:{...s.latestCodexRequest,processIdentitySha256:'NOT_A_HASH'}}));assert.throws(()=>readNetworkContexts({...s,latestCodexRequest:{...s.latestCodexRequest,automaticRetryAllowed:true}}));
});
test('a direct process-tree connection is shown as an explicit CFW bypass, never as an unknown success',()=>{
 const s=snapshot();s.latestCodexRequest={schema:'dream-maker.codex-request-path.v1',at:'2026-11-10T00:00:01Z',startedAt:'2026-11-10T00:00:00Z',completedAt:'2026-11-10T00:00:01Z',role:'planner2',method:'turn/start',targetHost:null,targetPort:443,targetHosts:[],sourcePortCount:0,path:'DIRECT_ROUTE_OBSERVED',processPid:4242,processIdentitySha256:'a'.repeat(64),sourcePortSha256:null,proxyEndpoint:'127.0.0.1:7890',selectedNode:null,expectedNode:'fixture-node',chains:[],classification:'NOT_OBSERVED',httpStatus:null,requestIdSha256:null,automaticRetryAllowed:false};
 const value=readNetworkContexts(s),html=networkContextsPanel({networkContexts:value});
 assert.equal(value.latestCodexRequest.path,'DIRECT_ROUTE_OBSERVED');
 for(const text of ['DIRECT_ROUTE_OBSERVED','绕过 CFW','开始时间','结束时间','进程 PID','进程启动身份摘要'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/REQUEST_ROUTE_VERIFIED/);
});
test('Codex account metadata keeps restricted usage and model inference in separate states',()=>{
 const value=readCodexMetadataObservation({
  schema:'dream-maker.codex-metadata-observation.v1',observedAt:'2026-11-10T08:00:00.000Z',currentConfiguration:true,
  configurationFingerprint:'a'.repeat(64),
  route:{state:'DM_ROUTE_DISABLED',proxyEndpoint:null,environmentFingerprint:null},
  controller:{selectionPolicy:'current',selectedNode:'fixture-node',expectedNode:'fixture-node'},
  account:{state:'OBSERVED',type:'chatgpt',authentication:'AUTHENTICATED_METADATA_ONLY'},
  model:{configured:'gpt-6-sol',listed:true,catalogComplete:true,actualServedModel:'NOT_VERIFIED'},
  usage:{ordinaryUsageAllowed:false,state:'RESTRICTED',buckets:[]},
  serviceEligibility:{state:'USAGE_RESTRICTED',summary:'普通使用受限'},
  inference:{state:'NOT_RUN',summary:'没有发起模型推理'},
  dispatchGate:{state:'BLOCKED_BY_USAGE',summary:'账户元数据阻止普通派发'},
  errors:[],modelTurnsRequested:0,cleanupReturned:true
 });
 const html=networkContextsPanel({codexMetadata:value});
 for(const text of ['Codex 账户与套餐','普通使用许可受限','USAGE_RESTRICTED','NOT_RUN','没有创建 thread/turn','没有发起模型推理'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/全部正常|模型可用|<strong>COMPLETED<\/strong>/);
 assert.throws(()=>readCodexMetadataObservation({...value,usage:{...value.usage,ordinaryUsageAllowed:true}}),/CODEX_METADATA_OBSERVATION_INVALID/);
 assert.throws(()=>readCodexMetadataObservation({...value,modelTurnsRequested:1}),/CODEX_METADATA_OBSERVATION_INVALID/);
});
test('a failed Codex metadata refresh hides the previous result instead of presenting it as current',()=>{
 const value=readCodexMetadataObservation({
  schema:'dream-maker.codex-metadata-observation.v1',observedAt:'2026-11-10T08:00:00.000Z',currentConfiguration:true,
  configurationFingerprint:'a'.repeat(64),
  route:{state:'DM_ROUTE_DISABLED',proxyEndpoint:null,environmentFingerprint:null},
  controller:{selectionPolicy:'current',selectedNode:'fixture-node',expectedNode:'fixture-node'},
  account:{state:'OBSERVED',type:'chatgpt',authentication:'AUTHENTICATED_METADATA_ONLY'},
  model:{configured:'gpt-6-sol',listed:true,catalogComplete:true,actualServedModel:'NOT_VERIFIED'},
  usage:{ordinaryUsageAllowed:false,state:'RESTRICTED',buckets:[]},
  serviceEligibility:{state:'USAGE_RESTRICTED',summary:'普通使用受限'},
  inference:{state:'NOT_RUN',summary:'没有发起模型推理'},
  dispatchGate:{state:'BLOCKED_BY_USAGE',summary:'账户元数据阻止普通派发'},
  errors:[],modelTurnsRequested:0,cleanupReturned:true
 });
 const html=networkContextsPanel({
  codexMetadata:value,
  codexMetadataError:'当前结果未读取完整；上次结果已隐藏，不能作为本次证据。'
 });
 assert.doesNotMatch(html,/data-key="codex-metadata"/);
 assert.doesNotMatch(html,/已读取当前 Codex 账户元数据/);
 assert.match(html,/上次结果已隐藏/);
});

test('transport matrix keeps network, eligibility, role and four-role evidence separate',()=>{
 const s=readNetworkContexts(snapshot());
 const metadata=readCodexMetadataObservation({
  schema:'dream-maker.codex-metadata-observation.v1',observedAt:'2026-11-10T08:00:00.000Z',currentConfiguration:true,
  configurationFingerprint:'a'.repeat(64),
  route:{state:'CFW_LEASE_BOUND_CHILD_ENVIRONMENT',proxyEndpoint:'127.0.0.1:7890',environmentFingerprint:'b'.repeat(64)},
  controller:{selectionPolicy:'current',selectedNode:'fixture-node',expectedNode:'fixture-node'},
  account:{state:'OBSERVED',type:'chatgpt',authentication:'AUTHENTICATED_METADATA_ONLY'},
  model:{configured:'gpt-6-sol',listed:true,catalogComplete:true,actualServedModel:'NOT_VERIFIED'},
  usage:{ordinaryUsageAllowed:false,state:'RESTRICTED',buckets:[]},
  serviceEligibility:{state:'USAGE_RESTRICTED',summary:'账户普通使用受限'},
  inference:{state:'NOT_RUN',summary:'没有发起模型推理'},
  dispatchGate:{state:'BLOCKED_BY_USAGE',summary:'账户元数据阻止普通派发'},
  errors:[],modelTurnsRequested:0,cleanupReturned:true
 });
 const html=networkContextsPanel({networkContexts:s,codexMetadata:metadata});
 for(const id of ['CFW_LOCAL_CONTROLLER','CFW_NODE_CHAIN','WINDOWS_CODEX_TRANSPORT','WINDOWS_CODEX_PLANNER2','WINDOWS_CODEX_REVIEWER','OPENAI_API_TRANSPORT','OPENAI_SERVICE_ELIGIBILITY','OPENAI_INFERENCE','DSH_EXTERNAL_TRANSPORT','MAGPIE_EXTERNAL_TRANSPORT','KIMI_EXTERNAL_TRANSPORT','DREAMMAKER_FOUR_ROLE_LIVE'])assert.ok(html.includes(id),id);
 assert.match(html,/WINDOWS_CODEX_PLANNER2[\s\S]*BLOCKED_BY_USAGE/);
 assert.match(html,/OPENAI_INFERENCE[\s\S]*NOT_RUN/);
 assert.match(html,/DREAMMAKER_FOUR_ROLE_LIVE[\s\S]*NOT_VERIFIED/);
 assert.match(html,/网络可达 ≠ 认证成功 ≠ 服务资格通过 ≠ 模型调用成功/);
});
