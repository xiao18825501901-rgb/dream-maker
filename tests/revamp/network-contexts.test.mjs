// OFFLINE observation assembly and untrusted local log tests; no login, controller mutation or model.
import test from 'node:test';import assert from 'node:assert/strict';
import * as network from '../../dist/server/network-contexts.js';
const at='2026-11-03T00:00:00.000Z';
const config={codex:{transport:'wsl',wslDistro:'DreamMaker-Acceptance-F-20261101-R2'},clash:{enabled:false}};
const inputs=()=>({windows:{available:true,systemProxyEnabled:true,loopbackProxy:true},wsl:{available:true,codexLoginRunning:false,codexServerRunning:false,proxyPresent:false,account:{mode:'CHATGPT',fingerprint:'a'.repeat(16)},rejections:[{at,httpStatus:403,reason:'REGION_UNSUPPORTED',requestId:'abcdef…-HKG'}]},controller:{available:true,selectors:2,nodes:17,configuredSelector:'性价比机场',configuredNode:'🇸🇬 新加坡2',selectedNode:'🇸🇬 新加坡1',selectionMatchesExpected:false},dshHistory:null});

test('four environments are separate, and Windows proxy configuration cannot certify the WSL route',()=>{
 const s=network.networkContextsSnapshot(config,inputs(),at);assert.deepEqual(s.contexts.map(x=>x.id),['windows-browser','wsl-codex-login','codex-app-server','dsh-executor']);
 assert.equal(s.contexts[0].path.state,'CONFIGURED_ONLY');assert.equal(s.contexts[1].path.state,'NOT_VERIFIED');assert.equal(s.contexts[2].path.state,'NOT_VERIFIED');assert.equal(s.retry.allowed,false);assert.equal(s.automaticLogin,false);
 assert.equal(s.controller.configuredNode,'🇸🇬 新加坡2');assert.equal(s.controller.selectedNode,'🇸🇬 新加坡1');assert.equal(s.controller.selectionMatchesExpected,false);
 assert.deepEqual(Object.keys(s.openAi).sort(),['authentication','inference','networkReachability','serviceEligibility']);
 assert.equal(s.openAi.networkReachability.state,'NOT_TESTED');assert.equal(s.openAi.authentication.state,'NOT_VERIFIED');assert.equal(s.openAi.serviceEligibility.state,'NOT_VERIFIED');assert.equal(s.openAi.inference.state,'NOT_RUN');
});

test('a recorded regional denial blocks the Codex scope without claiming a route or another vendor is verified',()=>{
 const s=network.networkContextsSnapshot(config,inputs(),at);
 assert.equal(s.contexts[1].service.state,'POLICY_BLOCKED');assert.equal(s.contexts[2].service.state,'POLICY_BLOCKED');assert.equal(s.contexts[3].service.state,'NOT_VERIFIED');assert.equal(s.account.state,'CACHED_UNVERIFIED');
 assert.deepEqual(s.eligibilityPolicy,{automaticRegionSwitch:false,proxyChangeIsEligibilityEvidence:false,remediation:'OFFICIAL_ELIGIBILITY_ONLY'});
 const generic=inputs();generic.wsl.rejections=[{at,httpStatus:403,reason:'FORBIDDEN_UNKNOWN',requestId:null}];assert.equal(network.networkContextsSnapshot(config,generic,at).contexts[1].service.state,'NOT_VERIFIED');
});

test('current selection mode normalizes an empty legacy fixed-node field',()=>{
 const input=inputs();input.controller={available:true,selectors:2,nodes:17,selectionPolicy:'current',configuredSelector:'性价比机场',configuredNode:'',selectedNode:'🇸🇬 新加坡1',selectionMatchesExpected:null};
 const s=network.networkContextsSnapshot({...config,clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.controller.configuredNode,null);
 assert.equal(s.controller.selectionPolicy,'current');
 assert.equal(s.controller.selectedNode,'🇸🇬 新加坡1');
 assert.equal(s.controller.selectionMatchesExpected,null);
});

test('controller projection keeps observed listener exposure separate from route reachability',()=>{
 const input=inputs();
 input.windows.proxyListener={
  state:'NON_LOOPBACK',
  mixedPort:7890,
  bindings:['WILDCARD'],
  ownerMatchesController:true,
  allowLan:true,
  bindAddress:'*'
 };
 const s=network.networkContextsSnapshot({...config,clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.deepEqual(s.controller.proxyListener,{
  state:'NON_LOOPBACK',
  mixedPort:7890,
  bindings:['WILDCARD'],
  ownerMatchesController:true,
  allowLan:true,
  bindAddress:'*'
 });
 assert.equal(s.openAi.networkReachability.state,'NOT_TESTED');
});

test('DM Magpie expects the controlled CFW lease but never promotes launch configuration to an observed upstream route',()=>{
 const on=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},inputs(),at),row=on.additionalContexts.find(x=>x.id==='magpie-gateway');
 assert.equal(row.routing.expected.state,'CONTROLLED_PROXY_EXPECTED');assert.equal(row.routing.observed.state,'NOT_VERIFIED');assert.match(row.routing.expected.summary,/CFW/);assert.match(row.path.summary,/没有.*上游请求|尚无.*上游请求/);
 const off=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:false}},inputs(),at),disabled=off.additionalContexts.find(x=>x.id==='magpie-gateway');
 assert.equal(disabled.routing.expected.state,'DM_ROUTE_DISABLED');assert.equal(disabled.routing.observed.state,'NOT_VERIFIED');
});

test('stored DSH response history never becomes current tool capability or Codex evidence',()=>{
 const input=inputs();input.dshHistory={at,model:'deepseek-flash',provider:'deepseek-official'};
 const s=network.networkContextsSnapshot(config,input,at);assert.equal(s.contexts[3].service.state,'UNVERIFIED_HISTORY');assert.match(s.contexts[3].service.summary,/未验签/);assert.equal(s.contexts[1].evidence.some(x=>x.kind==='STORED_HISTORY'),false);
});

test('a stored receipt without signature verification is never presented as a confirmed model response',()=>{
 const input=inputs();input.dshHistory={at,model:'deepseek-flash',provider:'deepseek-official'};
 const row=network.networkContextsSnapshot(config,input,at).contexts[3];assert.equal(row.service.state,'UNVERIFIED_HISTORY');assert.match(row.service.summary,/未验签|没有验签/);
});

test('WSL route refusal remains visible even when a controller and stored response are available',()=>{
 const s=network.networkContextsSnapshot({...config,clash:{enabled:true}},inputs(),at);assert.equal(s.contexts[1].path.state,'SCOPE_BLOCKED');assert.equal(s.contexts[2].path.state,'SCOPE_BLOCKED');assert.equal(s.controller.state,'OBSERVED');
});

test('a WSL login rejection cannot become a Windows app-server policy verdict',()=>{
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'}},inputs(),at);
 assert.equal(s.contexts[2].service.state,'NOT_VERIFIED');assert.equal(s.contexts[2].evidence.length,0);
});

test('a recorded Windows Codex start event verifies only the child environment',()=>{
 const input=inputs();input.codexPaths=[{at,role:'planner2',transport:'stdio',path:'CHILD_ENV_MATCH',proxyEndpoint:'127.0.0.1:7890',proxyFingerprint:'b'.repeat(64)}];
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true}},input,at);
 assert.equal(s.contexts[2].routing.observed.state,'CHILD_ENV_VERIFIED');
 assert.equal(s.contexts[2].service.state,'NOT_VERIFIED');
 assert.equal(s.openAi.authentication.state,'NOT_VERIFIED');
 assert.equal(s.openAi.inference.state,'NOT_RUN');
 assert.equal(s.contexts[2].evidence[0].kind,'CODEX_START_EVENT');
});

test('a request-level Codex route verifies the actual CFW chain and completed turn without upgrading a different role',()=>{
 const input=inputs();
 input.latestCodexRequest={schema:'dream-maker.codex-request-path.v1',at,startedAt:at,completedAt:at,role:'reviewer',method:'turn/start',targetHost:'chatgpt.com',targetPort:443,path:'REQUEST_ROUTE_VERIFIED',processPid:4242,processIdentitySha256:'a'.repeat(64),sourcePortSha256:'b'.repeat(64),proxyEndpoint:'127.0.0.1:7890',selectedNode:'🇸🇬 新加坡1',expectedNode:'🇸🇬 新加坡1',chains:['🇸🇬 新加坡1','性价比机场'],classification:'INFERENCE_COMPLETED',httpStatus:200,requestIdSha256:'c'.repeat(64),automaticRetryAllowed:false};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.contexts[2].routing.observed.state,'REQUEST_ROUTE_VERIFIED');
 assert.equal(s.contexts[2].path.state,'HISTORICAL_RESPONSE');
 assert.equal(s.openAi.authentication.state,'AUTHENTICATED');
 assert.equal(s.openAi.serviceEligibility.state,'ELIGIBLE');
 assert.equal(s.openAi.inference.state,'COMPLETED');
 assert.equal(s.latestCodexRequest.targetHost,'chatgpt.com');
});
test('a request-level direct socket blocks the CFW path and stays separate from account and inference evidence',()=>{
 const input=inputs();
 input.latestCodexRequest={schema:'dream-maker.codex-request-path.v1',at,startedAt:at,completedAt:at,role:'planner2',method:'turn/start',targetHost:null,targetHosts:[],targetPort:443,sourcePortCount:0,path:'DIRECT_ROUTE_OBSERVED',processPid:4242,processIdentitySha256:'a'.repeat(64),sourcePortSha256:null,proxyEndpoint:'127.0.0.1:7890',selectedNode:null,expectedNode:'🇸🇬 新加坡1',chains:[],classification:'NOT_OBSERVED',httpStatus:null,requestIdSha256:null,automaticRetryAllowed:false};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.contexts[2].path.state,'SCOPE_BLOCKED');
 assert.equal(s.contexts[2].routing.observed.state,'NOT_VERIFIED');
 assert.match(s.contexts[2].path.summary,/非回环直连/);
 assert.equal(s.openAi.authentication.state,'NOT_VERIFIED');
 assert.equal(s.openAi.inference.state,'NOT_RUN');
 assert.equal(s.retry.allowed,false);
});

test('a completed Codex turn never invents an unobserved HTTP status',()=>{
 const input=inputs();
 input.latestCodexRequest={schema:'dream-maker.codex-request-path.v1',at,startedAt:at,completedAt:at,role:'reviewer',method:'turn/start',targetHost:'chatgpt.com',targetPort:443,path:'REQUEST_ROUTE_VERIFIED',processPid:4242,processIdentitySha256:'a'.repeat(64),sourcePortSha256:'b'.repeat(64),proxyEndpoint:'127.0.0.1:7890',selectedNode:'🇸🇬 新加坡1',expectedNode:'🇸🇬 新加坡1',chains:['🇸🇬 新加坡1','性价比机场'],classification:'INFERENCE_COMPLETED',httpStatus:null,requestIdSha256:'c'.repeat(64),automaticRetryAllowed:false};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.openAi.networkReachability.state,'TLS_REACHABLE');
 assert.doesNotMatch(s.openAi.networkReachability.summary,/HTTP 200|收到 HTTP/);
 assert.match(s.openAi.networkReachability.summary,/未观察到.*HTTP 状态码/);
 assert.equal(s.openAi.authentication.state,'AUTHENTICATED');
 assert.equal(s.openAi.serviceEligibility.state,'ELIGIBLE');
 assert.equal(s.openAi.inference.state,'COMPLETED');
});

test('a request-level regional policy denial remains blocked and cannot be retried by changing node',()=>{
 const input=inputs();
 input.latestCodexRequest={schema:'dream-maker.codex-request-path.v1',at,startedAt:at,completedAt:at,role:'planner2',method:'turn/start',targetHost:'chatgpt.com',targetPort:443,path:'REQUEST_ROUTE_VERIFIED',processPid:4242,processIdentitySha256:'a'.repeat(64),sourcePortSha256:'b'.repeat(64),proxyEndpoint:'127.0.0.1:7890',selectedNode:'🇸🇬 新加坡1',expectedNode:'🇸🇬 新加坡1',chains:['🇸🇬 新加坡1','性价比机场'],classification:'REGION_OR_POLICY_RESTRICTED',httpStatus:403,requestIdSha256:'c'.repeat(64),automaticRetryAllowed:false};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.openAi.serviceEligibility.state,'POLICY_BLOCKED');
 assert.equal(s.openAi.inference.state,'FAILED');
 assert.equal(s.retry.allowed,false);
 assert.match(s.contexts[2].routing.observed.summary,/请求级/);
});

test('a persisted controlled OpenAI request separates successful inference from passive reachability',()=>{
 const input=inputs();input.latestRoutedRequest={schema:'dream-maker.routed-request-observation.v1',at,startedAt:at,completedAt:at,process:'DM_CONTROLLED_TRANSPORT',targetHost:'api.openai.com',method:'POST',selectionPolicy:'current',selectedNode:'🇸🇬 新加坡1',expectedNode:'🇸🇬 新加坡1',httpStatus:200,classification:'INFERENCE_COMPLETED',automaticRetryAllowed:false,requestIdSha256:'c'.repeat(64),elapsedMs:123};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.latestRoutedRequest.classification,'INFERENCE_COMPLETED');
 assert.equal(s.openAi.authentication.state,'AUTHENTICATED');
 assert.equal(s.openAi.serviceEligibility.state,'ELIGIBLE');
 assert.equal(s.openAi.inference.state,'COMPLETED');
});

test('a successful non-inference OpenAI request never grants authentication or inference',()=>{
 const input=inputs();input.latestRoutedRequest={schema:'dream-maker.routed-request-observation.v1',at,startedAt:at,completedAt:at,process:'DM_CONTROLLED_TRANSPORT',targetHost:'api.openai.com',method:'GET',selectionPolicy:'current',selectedNode:'🇸🇬 新加坡1',expectedNode:'🇸🇬 新加坡1',httpStatus:200,classification:'HTTP_SUCCESS_NON_INFERENCE',automaticRetryAllowed:false,requestIdSha256:'c'.repeat(64),elapsedMs:123};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.openAi.networkReachability.state,'TLS_REACHABLE');
 assert.equal(s.openAi.authentication.state,'NOT_VERIFIED');
 assert.equal(s.openAi.serviceEligibility.state,'NOT_VERIFIED');
 assert.equal(s.openAi.inference.state,'NOT_RUN');
});

test('a persisted policy denial stays blocked and never enables retry',()=>{
 const input=inputs();input.latestRoutedRequest={schema:'dream-maker.routed-request-observation.v1',at,startedAt:at,completedAt:at,process:'DM_CONTROLLED_TRANSPORT',targetHost:'api.openai.com',method:'POST',selectionPolicy:'current',selectedNode:'🇸🇬 新加坡1',expectedNode:'🇸🇬 新加坡1',httpStatus:403,classification:'REGION_OR_POLICY_RESTRICTED',automaticRetryAllowed:false,requestIdSha256:'d'.repeat(64),elapsedMs:80};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.openAi.serviceEligibility.state,'POLICY_BLOCKED');
 assert.equal(s.openAi.inference.state,'FAILED');
 assert.equal(s.retry.allowed,false);
});

test('an unattributed DeepSeek transport response never certifies the DSH role',()=>{
 const input=inputs();const deepSeek={schema:'dream-maker.routed-request-observation.v1',at,startedAt:at,completedAt:at,process:'DM_CONTROLLED_TRANSPORT',targetHost:'api.deepseek.com',method:'POST',selectionPolicy:'current',selectedNode:'🇸🇬 新加坡1',expectedNode:'🇸🇬 新加坡1',httpStatus:200,classification:'INFERENCE_COMPLETED',automaticRetryAllowed:false,requestIdSha256:'f'.repeat(64),elapsedMs:321};
 input.latestRoutedRequests={openAi:null,deepSeek};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.contexts[3].path.state,'NOT_VERIFIED');
 assert.equal(s.contexts[3].routing.observed.state,'NOT_VERIFIED');
 assert.equal(s.contexts[3].service.state,'NOT_VERIFIED');
 assert.equal(s.latestDeepSeekRoutedRequest.classification,'INFERENCE_COMPLETED');
});

test('an executor-attributed DeepSeek request proves only the controlled path, not DSH service or inference authority',()=>{
 const input=inputs();const deepSeek={schema:'dream-maker.routed-request-observation.v1',at,startedAt:at,completedAt:at,process:'DM_CONTROLLED_TRANSPORT',role:'executor',targetHost:'api.deepseek.com',method:'POST',selectionPolicy:'current',selectedNode:'🇸🇬 新加坡1',expectedNode:'🇸🇬 新加坡1',httpStatus:200,classification:'INFERENCE_COMPLETED',automaticRetryAllowed:false,requestIdSha256:'f'.repeat(64),elapsedMs:321};
 input.latestRoutedRequests={openAi:null,deepSeek};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.contexts[3].path.state,'HISTORICAL_RESPONSE');
 assert.equal(s.contexts[3].routing.observed.state,'REQUEST_ROUTE_VERIFIED');
 assert.equal(s.contexts[3].service.state,'NOT_VERIFIED');
 assert.equal(s.openAi.inference.state,'NOT_RUN');
 assert.match(s.contexts[3].routing.observed.summary,/executor/);
 assert.match(s.contexts[3].path.summary,/不证明当前 DSH/);
});

test('another role cannot be relabelled as the DSH executor',()=>{
 const input=inputs();const deepSeek={schema:'dream-maker.routed-request-observation.v1',at,startedAt:at,completedAt:at,process:'DM_CONTROLLED_TRANSPORT',role:'planner2',targetHost:'api.deepseek.com',method:'POST',selectionPolicy:'current',selectedNode:'🇸🇬 新加坡1',expectedNode:'🇸🇬 新加坡1',httpStatus:200,classification:'INFERENCE_COMPLETED',automaticRetryAllowed:false,requestIdSha256:'f'.repeat(64),elapsedMs:321};
 input.latestRoutedRequests={openAi:null,deepSeek};
 const s=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true,selectionPolicy:'current'}},input,at);
 assert.equal(s.contexts[3].path.state,'NOT_VERIFIED');
 assert.equal(s.contexts[3].routing.observed.state,'NOT_VERIFIED');
 assert.equal(s.contexts[3].service.state,'NOT_VERIFIED');
});

test('a stale transport event or unmanaged proxy record cannot certify the current Codex path',()=>{
 const wrongTransport={...inputs(),codexPaths:[{at,role:'reviewer',transport:'wsl',path:'DM_ROUTE_DISABLED',proxyEndpoint:null,proxyFingerprint:null}]};
 const a=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true}},wrongTransport,at);
 assert.equal(a.contexts[2].routing.observed.state,'NOT_VERIFIED');
 const unmanaged={...inputs(),codexPaths:[{at,role:'planner2',transport:'stdio',path:'UNMANAGED_ENV_PRESENT',proxyEndpoint:null,proxyFingerprint:null}]};
 const b=network.networkContextsSnapshot({...config,codex:{transport:'stdio'},clash:{enabled:true}},unmanaged,at);
 assert.equal(b.contexts[2].routing.observed.state,'NOT_VERIFIED');
 assert.match(b.contexts[2].routing.observed.summary,/未受管/);
});

test('overlapping reads share one bounded inspection and retain the original observation time',async()=>{
 let finish,calls=0,now=Date.parse(at);const pending=new Promise(r=>{finish=r;}),service=new network.NetworkContextsService(()=>config,async()=>{calls++;return pending;},()=>now);
 const a=service.snapshot(),b=service.snapshot();assert.equal(calls,1);finish(inputs());const [x,y]=await Promise.all([a,b]);assert.equal(x.observedAt,y.observedAt);now+=1000;assert.equal((await service.snapshot()).observedAt,x.observedAt);assert.equal(calls,1);
});

test('an inspection finishing after a setting change is explicitly stale and cannot certify the new setting',async()=>{
 let current=structuredClone(config),finish;const pending=new Promise(r=>{finish=r;}),service=new network.NetworkContextsService(()=>current,()=>pending,()=>Date.parse(at));
 const read=service.snapshot();current={...current,clash:{enabled:true}};finish(inputs());assert.equal((await read).currentConfiguration,false);
});

test('application close cancels and joins the local collector, and later reads cannot restart it',async()=>{
 let started,aborted=false;const entry=new Promise(r=>{started=r;});const service=new network.NetworkContextsService(()=>config,async(_c,signal)=>{started();await new Promise(r=>signal.addEventListener('abort',()=>{aborted=true;r();},{once:true}));return inputs();});
 const read=service.snapshot();await entry;const rejected=assert.rejects(read,e=>e.code==='NETWORK_CONTEXTS_CLOSED');await service.close();await rejected;assert.equal(aborted,true);await assert.rejects(service.snapshot(),e=>e.code==='NETWORK_CONTEXTS_CLOSED');
});
