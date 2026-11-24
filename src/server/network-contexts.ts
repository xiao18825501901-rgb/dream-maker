import type {Config} from '../shared/types.js';
import {
 CODEX_CONTROL_TARGET_HOSTS,
 CODEX_REQUEST_TARGETS,
 type NetworkContextsSnapshot,
 type NetworkContextRow,
 type NetworkEvidenceItem,
 type LocalProxyHealth,
 type RoutedRequestObservation,
 type CodexRequestPathObservation,
 type ProxyListenerObservation,
 type WslProxyReachability,
 type WslProxyTlsObservation
} from '../shared/network-contexts.js';
import {hash,DomainError} from './security.js';

export interface LoginRejection {at:string;httpStatus:number;reason:'REGION_UNSUPPORTED'|'FORBIDDEN_UNKNOWN'|'TRANSPORT_ERROR';requestId:string|null}
export interface CodexPathObservation {
 at:string;role:'planner2'|'reviewer';transport:'stdio'|'wsl';
 path:'CHILD_ENV_MATCH'|'DM_ROUTE_DISABLED'|'UNMANAGED_ENV_PRESENT';
 proxyEndpoint:string|null;proxyFingerprint:string|null;
}
export interface LocalNetworkCheck {configurationFingerprint:string;health:LocalProxyHealth}
export interface LocalNetworkObservations {
 windows:{available:boolean;systemProxyEnabled:boolean;loopbackProxy:boolean;dshRunning?:boolean;codexServerRunning?:boolean;developmentCodexRunning?:boolean;magpieRunning?:boolean;proxyListener?:ProxyListenerObservation};
 wsl:{available:boolean;codexLoginRunning:boolean;codexServerRunning:boolean;proxyPresent:boolean;
  account:{mode:'CHATGPT'|'UNKNOWN';fingerprint:string|null};rejections:LoginRejection[];logRead?:'OBSERVED'|'UNAVAILABLE'};
 controller:{available:boolean;selectors:number;nodes:number;selectionPolicy?:'pinned'|'current';configuredSelector?:string|null;configuredNode?:string|null;selectedNode?:string|null;selectionMatchesExpected?:boolean|null;
  mixedPort?:number|null;controllerPort?:number|null;allowLan?:boolean|null;bindAddress?:string|null};
 dshHistory:{at:string;model:string;provider:string}|null;
 codexPaths?:CodexPathObservation[];
 latestRoutedRequest?:RoutedRequestObservation|null;
 latestRoutedRequests?:{openAi:RoutedRequestObservation|null;deepSeek:RoutedRequestObservation|null};
 latestCodexRequest?:CodexRequestPathObservation|null;
 wslProxyReachability?:WslProxyReachability|null;
 wslProxyTls?:WslProxyTlsObservation[]|null;
}
const stamp=(v:string):string|null=>/^20\d\d-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))?v:null;
const maskedId=(v:string|null)=>typeof v==='string'&&/^[a-f0-9]{4,8}…(?:-[A-Z]{3})?$/.test(v)?v:null;
const routedClassifications=new Set<RoutedRequestObservation['classification']>([
 'DNS_FAILURE','TCP_CONNECTION_FAILURE','TLS_HANDSHAKE_FAILURE','PROXY_CONNECTION_RESET','STREAM_INTERRUPTED',
 'HTTP_401_AUTHENTICATION_FAILED','HTTP_403_PERMISSION_DENIED','REGION_OR_POLICY_RESTRICTED','HTTP_429_QUOTA_EXCEEDED',
 'MODEL_UNAVAILABLE','HTTP_SUCCESS_NON_INFERENCE','HTTP_CLIENT_REQUEST_REJECTED','INFERENCE_COMPLETED',
 'HTTP_5XX_UPSTREAM_FAILURE'
]);
const routedRoles=new Set(['planner1','planner2','executor','reviewer']);
const codexPathStates=new Set<CodexRequestPathObservation['path']>([
 'REQUEST_ROUTE_VERIFIED','DIRECT_ROUTE_OBSERVED','PROCESS_ROUTE_NOT_OBSERVED','PROCESS_IDENTITY_UNVERIFIED','CONNECTION_AMBIGUOUS','NODE_MISMATCH','CFW_UNAVAILABLE','ROUTE_DISABLED'
]);
const codexClassifications=new Set<CodexRequestPathObservation['classification']>([
 ...routedClassifications,'NOT_OBSERVED'
]);
const safeName=(value:unknown,max=512):value is string=>typeof value==='string'&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const codexTargetHosts=new Set<string>(CODEX_REQUEST_TARGETS);
const unavailableProxyListener=():ProxyListenerObservation=>({
 state:'UNAVAILABLE',mixedPort:null,bindings:[],ownerMatchesController:null,allowLan:null,bindAddress:null
});
const notTestedWslProxy=():WslProxyReachability=>({
 schema:'dream-maker.wsl-proxy-reachability.v1',state:'NOT_TESTED',gateway:null,port:null,elapsedMs:null,routeSource:'WSL_DEFAULT_ROUTE',
 networkPayloadBytes:0,httpRequests:0,tlsHandshakes:0,modelCalls:0,filesWritten:0
});
export function readWslProxyReachability(raw:unknown):WslProxyReachability{
 if(raw===null||raw===undefined)return notTestedWslProxy();
 const v=raw as Record<string,unknown>;
 if(!v||v.schema!=='dream-maker.wsl-proxy-reachability.v1'||
  !['NOT_TESTED','TCP_REACHABLE_ONLY','CONNECTION_REFUSED','TIMEOUT','UNREACHABLE'].includes(String(v.state))||
  v.gateway!==null&&(typeof v.gateway!=='string'||!/^(?:10(?:[.]\d{1,3}){3}|172[.](?:1[6-9]|2\d|3[01])(?:[.]\d{1,3}){2}|192[.]168(?:[.]\d{1,3}){2})$/.test(v.gateway))||
  v.port!==null&&(!Number.isSafeInteger(v.port)||Number(v.port)<1||Number(v.port)>65535)||
  v.elapsedMs!==null&&(!Number.isSafeInteger(v.elapsedMs)||Number(v.elapsedMs)<0||Number(v.elapsedMs)>5000)||
  v.routeSource!=='WSL_DEFAULT_ROUTE'||v.networkPayloadBytes!==0||v.httpRequests!==0||v.tlsHandshakes!==0||v.modelCalls!==0||v.filesWritten!==0||
  v.state==='TCP_REACHABLE_ONLY'&&(v.gateway===null||v.port===null||v.elapsedMs===null))
  throw new DomainError('NETWORK_WSL_PROXY_OBSERVATION_INVALID',502);
 return structuredClone(v) as unknown as WslProxyReachability;
}
export function readWslProxyTlsObservation(raw:unknown):WslProxyTlsObservation{
 const v=raw as Record<string,unknown>;
 if(!v||v.schema!=='dream-maker.wsl-proxy-tls-observation.v1'||
  !['NOT_TESTED','CONNECT_AND_TLS_COMPLETED','PROXY_CONNECT_REJECTED','TLS_HANDSHAKE_FAILED','TIMEOUT','UNREACHABLE'].includes(String(v.state))||
  !['api.openai.com','chatgpt.com'].includes(String(v.targetHost))||v.targetPort!==443||
  v.gateway!==null&&(typeof v.gateway!=='string'||!/^(?:10(?:[.]\d{1,3}){3}|172[.](?:1[6-9]|2\d|3[01])(?:[.]\d{1,3}){2}|192[.]168(?:[.]\d{1,3}){2})$/.test(v.gateway))||
  v.proxyPort!==null&&(!Number.isSafeInteger(v.proxyPort)||Number(v.proxyPort)<1||Number(v.proxyPort)>65535)||
  v.protocol!==null&&!['TLSv1.2','TLSv1.3'].includes(String(v.protocol))||
  v.alpn!==null&&v.alpn!=='http/1.1'||typeof v.authorized!=='boolean'||
  v.elapsedMs!==null&&(!Number.isSafeInteger(v.elapsedMs)||Number(v.elapsedMs)<0||Number(v.elapsedMs)>30000)||
  v.cipher!==null&&!safeName(v.cipher,100)||
  v.errorClass!==null&&(typeof v.errorClass!=='string'||!/^[A-Z0-9_]{1,80}$/.test(v.errorClass))||
  v.sourcePortSha256!==null&&(typeof v.sourcePortSha256!=='string'||!/^[a-f0-9]{64}$/.test(v.sourcePortSha256))||
  v.selectedNode!==null&&!safeName(v.selectedNode)||v.expectedNode!==null&&!safeName(v.expectedNode)||
  v.selectionMatchesExpected!==null&&typeof v.selectionMatchesExpected!=='boolean'||
  typeof v.nodeChainMatched!=='boolean'||!Array.isArray(v.chains)||v.chains.length>64||v.chains.some(value=>!safeName(value))||
  ![0,1].includes(Number(v.proxyConnectRequests))||
  !Number.isSafeInteger(v.proxyControlBytes)||Number(v.proxyControlBytes)<0||Number(v.proxyControlBytes)>16384||
  v.originHttpRequests!==0||v.modelCalls!==0||v.filesWritten!==0||
  v.state==='CONNECT_AND_TLS_COMPLETED'&&(v.gateway===null||v.proxyPort===null||v.protocol===null||v.authorized!==true||v.sourcePortSha256===null||Number(v.proxyConnectRequests)!==1))
  throw new DomainError('NETWORK_WSL_PROXY_TLS_OBSERVATION_INVALID',502);
 return {
  schema:'dream-maker.wsl-proxy-tls-observation.v1',
  state:v.state as WslProxyTlsObservation['state'],
  targetHost:v.targetHost as WslProxyTlsObservation['targetHost'],
  targetPort:443,
  gateway:v.gateway as string|null,
  proxyPort:v.proxyPort as number|null,
  protocol:v.protocol as string|null,
  alpn:v.alpn as string|null,
  authorized:v.authorized as boolean,
  elapsedMs:v.elapsedMs as number|null,
  cipher:v.cipher as string|null,
  errorClass:v.errorClass as string|null,
  sourcePortSha256:v.sourcePortSha256 as string|null,
  selectedNode:v.selectedNode as string|null,
  expectedNode:v.expectedNode as string|null,
  selectionMatchesExpected:v.selectionMatchesExpected as boolean|null,
  nodeChainMatched:v.nodeChainMatched as boolean,
  chains:[...(v.chains as string[])],
  proxyConnectRequests:Number(v.proxyConnectRequests) as 0|1,
  proxyControlBytes:Number(v.proxyControlBytes),
  originHttpRequests:0,
  modelCalls:0,
  filesWritten:0
 };
}
export function readProxyListenerObservation(raw:unknown):ProxyListenerObservation{
 if(raw===null||raw===undefined)return unavailableProxyListener();
 const v=raw as Record<string,unknown>;
 if(!v||!['LOOPBACK_ONLY','NON_LOOPBACK','MIXED','UNAVAILABLE'].includes(String(v.state))||
  v.mixedPort!==null&&(!Number.isSafeInteger(v.mixedPort)||Number(v.mixedPort)<1||Number(v.mixedPort)>65535)||
  !Array.isArray(v.bindings)||v.bindings.length>8||v.bindings.some(value=>!['LOOPBACK','WILDCARD','OTHER'].includes(String(value)))||
  v.ownerMatchesController!==null&&typeof v.ownerMatchesController!=='boolean'||
  v.allowLan!==null&&typeof v.allowLan!=='boolean'||
  v.bindAddress!==null&&!safeName(v.bindAddress,255))throw new DomainError('NETWORK_PROXY_LISTENER_OBSERVATION_INVALID',502);
 return {
  state:v.state as ProxyListenerObservation['state'],
  mixedPort:v.mixedPort as number|null,
  bindings:[...(v.bindings as ProxyListenerObservation['bindings'])],
  ownerMatchesController:v.ownerMatchesController as boolean|null,
  allowLan:v.allowLan as boolean|null,
  bindAddress:v.bindAddress as string|null
 };
}
export function readCodexRequestPathObservation(raw:unknown):CodexRequestPathObservation|null{
 if(raw===null||raw===undefined)return null;
 const v=raw as Record<string,unknown>;
 const hashes=[v.processIdentitySha256,v.sourcePortSha256,v.requestIdSha256];
 const targetHosts=v.targetHosts===undefined
  ?(v.targetHost===null?[]:[v.targetHost])
  :v.targetHosts;
 const sourcePortCount=v.sourcePortCount===undefined
  ?(v.sourcePortSha256===null?0:1)
  :v.sourcePortCount;
 const normalizedSourcePortCount=typeof sourcePortCount==='number'?sourcePortCount:Number.NaN;
 if(!v||v.schema!=='dream-maker.codex-request-path.v1'||
  ![v.at,v.startedAt,v.completedAt].every(value=>typeof value==='string'&&stamp(value)!==null)||Date.parse(String(v.completedAt))<Date.parse(String(v.startedAt))||
  !['planner2','reviewer'].includes(String(v.role))||v.method!=='turn/start'||v.targetPort!==443||
   v.targetHost!==null&&!codexTargetHosts.has(String(v.targetHost))||
   !Array.isArray(targetHosts)||targetHosts.length>CODEX_REQUEST_TARGETS.length||
   targetHosts.some(value=>typeof value!=='string'||!codexTargetHosts.has(value))||
   new Set(targetHosts).size!==targetHosts.length||
   !Number.isSafeInteger(normalizedSourcePortCount)||normalizedSourcePortCount<0||normalizedSourcePortCount>64||
  !codexPathStates.has(v.path as CodexRequestPathObservation['path'])||
  v.processPid!==null&&(!Number.isSafeInteger(v.processPid)||Number(v.processPid)<1)||
  hashes.some(value=>value!==null&&(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)))||
  v.proxyEndpoint!==null&&(typeof v.proxyEndpoint!=='string'||!/^127[.]0[.]0[.]1:[1-9][0-9]{0,4}$/.test(v.proxyEndpoint))||
  ![v.selectedNode,v.expectedNode].every(value=>value===null||safeName(value))||
  !Array.isArray(v.chains)||v.chains.length>64||v.chains.some(value=>!safeName(value))||
  !codexClassifications.has(v.classification as CodexRequestPathObservation['classification'])||
  v.httpStatus!==null&&(!Number.isInteger(v.httpStatus)||Number(v.httpStatus)<100||Number(v.httpStatus)>599)||
  v.automaticRetryAllowed!==false)throw new DomainError('NETWORK_CODEX_REQUEST_OBSERVATION_INVALID',502);
 if(v.path==='REQUEST_ROUTE_VERIFIED'&&(v.targetHost===null||targetHosts.length===0||!targetHosts.includes(v.targetHost)||normalizedSourcePortCount<1||v.processPid===null||v.processIdentitySha256===null||v.sourcePortSha256===null||v.proxyEndpoint===null||v.selectedNode===null||v.expectedNode===null||(v.chains as unknown[]).length===0))
  throw new DomainError('NETWORK_CODEX_REQUEST_OBSERVATION_INVALID',502);
 return {
  schema:'dream-maker.codex-request-path.v1',
  at:v.at as string,
  startedAt:v.startedAt as string,
  completedAt:v.completedAt as string,
  role:v.role as CodexRequestPathObservation['role'],
  method:'turn/start',
  targetHost:v.targetHost as CodexRequestPathObservation['targetHost'],
  targetPort:443,
   targetHosts:[...targetHosts] as CodexRequestPathObservation['targetHosts'],
   sourcePortCount:normalizedSourcePortCount,
  path:v.path as CodexRequestPathObservation['path'],
  processPid:v.processPid as number|null,
  processIdentitySha256:v.processIdentitySha256 as string|null,
  sourcePortSha256:v.sourcePortSha256 as string|null,
  proxyEndpoint:v.proxyEndpoint as string|null,
  selectedNode:v.selectedNode as string|null,
  expectedNode:v.expectedNode as string|null,
  chains:[...(v.chains as string[])],
  classification:v.classification as CodexRequestPathObservation['classification'],
  httpStatus:v.httpStatus as number|null,
  requestIdSha256:v.requestIdSha256 as string|null,
  automaticRetryAllowed:false
 };
}
export function readRoutedRequestObservation(raw:unknown):RoutedRequestObservation|null{
 if(raw===null||raw===undefined)return null;
 const v=raw as Record<string,unknown>;
 if(!v||v.schema!=='dream-maker.routed-request-observation.v1'||![v.at,v.startedAt,v.completedAt].every(value=>typeof value==='string'&&stamp(value)!==null)||
  v.process!=='DM_CONTROLLED_TRANSPORT'||typeof v.targetHost!=='string'||!/^[a-z0-9.-]{1,253}$/i.test(v.targetHost)||
  v.role!==undefined&&!routedRoles.has(String(v.role))||
  !['GET','POST'].includes(String(v.method))||!['pinned','current'].includes(String(v.selectionPolicy))||
  !['selectedNode','expectedNode'].every(key=>typeof v[key]==='string'&&(v[key] as string).length<=512)||
  v.httpStatus!==null&&(!Number.isInteger(v.httpStatus)||Number(v.httpStatus)<100||Number(v.httpStatus)>599)||
  !routedClassifications.has(v.classification as RoutedRequestObservation['classification'])||typeof v.automaticRetryAllowed!=='boolean'||
  v.requestIdSha256!==null&&(typeof v.requestIdSha256!=='string'||!/^[a-f0-9]{64}$/.test(v.requestIdSha256))||
  !Number.isSafeInteger(v.elapsedMs)||Number(v.elapsedMs)<0||Number(v.elapsedMs)>300000)throw new DomainError('NETWORK_REQUEST_OBSERVATION_INVALID',502);
 return structuredClone(v) as unknown as RoutedRequestObservation;
}
/** Observations explain blockers; this object never grants Engine, route, budget or model authority. */
export function networkContextsSnapshot(config:Config,input:LocalNetworkObservations,at:string):NetworkContextsSnapshot{
 const wsl=config.codex.transport==='wsl',observed=input.wsl,region=wsl&&observed.rejections.some(r=>r.httpStatus===403&&r.reason==='REGION_UNSUPPORTED');
 const configuredSelector=typeof input.controller.configuredSelector==='string'&&input.controller.configuredSelector?input.controller.configuredSelector.slice(0,200):(config.clash.selector||null);
 const configuredNode=typeof input.controller.configuredNode==='string'&&input.controller.configuredNode?input.controller.configuredNode.slice(0,200):(config.clash.node||null);
 const selectedNode=typeof input.controller.selectedNode==='string'&&input.controller.selectedNode?input.controller.selectedNode.slice(0,200):null;
 const selectionPolicy=input.controller.selectionPolicy??config.clash.selectionPolicy??'pinned';
 const selectionMatchesExpected=typeof input.controller.selectionMatchesExpected==='boolean'?input.controller.selectionMatchesExpected:
  selectionPolicy==='current'?null:configuredNode&&selectedNode?configuredNode===selectedNode:null;
 const denial:NetworkContextRow['service']=region?{state:'POLICY_BLOCKED',summary:'此专用环境最近登录收到地区政策拒绝。当前账户资格仍未确认，条件未变不重复登录。'}:
  {state:'NOT_VERIFIED',summary:'尚无当前账户、套餐及模型资格证明。已有缓存不代表真实角色可用。'};
 const loginEvidence:NetworkEvidenceItem[]=(wsl?observed.rejections:[]).slice(-4).map(r=>({kind:'LOGIN_REJECTION',at:stamp(r.at),requestId:maskedId(r.requestId),
  summary:r.httpStatus===403&&r.reason==='REGION_UNSUPPORTED'?'已有令牌交换日志明确记录地区不支持的拒绝。':r.reason==='TRANSPORT_ERROR'?'已有日志记录传输失败；未据此推断地区或账户政策。':'已有请求被拒绝，具体政策原因尚未确认。'}));
 const latestOpenAiRequest=readRoutedRequestObservation(input.latestRoutedRequests?.openAi??(input.latestRoutedRequest?.targetHost==='api.openai.com'?input.latestRoutedRequest:null));
 const latestDeepSeekRequest=readRoutedRequestObservation(input.latestRoutedRequests?.deepSeek??(input.latestRoutedRequest?.targetHost==='api.deepseek.com'?input.latestRoutedRequest:null));
 const latestRoutedRequest=readRoutedRequestObservation(input.latestRoutedRequest??latestOpenAiRequest??latestDeepSeekRequest);
 const latestCodexRequest=wsl?null:readCodexRequestPathObservation(input.latestCodexRequest);
 const wslProxyReachability=readWslProxyReachability(input.wslProxyReachability);
 const wslProxyTls=Array.isArray(input.wslProxyTls)&&input.wslProxyTls.length<=2?
  input.wslProxyTls.map(readWslProxyTlsObservation):
  [];
 const wslLoginTls=wslProxyTls.find(value=>value.targetHost==='chatgpt.com')??null;
 const wslApiTls=wslProxyTls.find(value=>value.targetHost==='api.openai.com')??null;
 const wslTlsEvidence:NetworkEvidenceItem[]=wslProxyTls.map(value=>({
  kind:'LOCAL_METADATA',at,
  requestId:null,
  summary:`专用 WSL 诊断到 ${value.targetHost}:443：${value.state}${value.protocol?` / ${value.protocol}`:''}${value.selectedNode?` / 节点“${value.selectedNode}”`:''}${value.nodeChainMatched?' / 当前用户节点链一致':''}；没有源站 HTTP、认证头或模型请求，不是实际 WSL Codex 进程证据。`
 }));
 const codexIsLatest=!!latestCodexRequest&&(!latestOpenAiRequest||Date.parse(latestCodexRequest.completedAt)>=Date.parse(latestOpenAiRequest.completedAt));
 const routeBlocked=config.clash.enabled&&selectionPolicy==='pinned'&&selectionMatchesExpected===false;
 const currentTransport=config.codex.transport??'stdio';
 const latestCodexPath=(input.codexPaths??[])
  .filter(item=>item.transport===currentTransport&&stamp(item.at))
  .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
 const codexPath:NetworkContextRow['path']=latestCodexRequest?.path==='REQUEST_ROUTE_VERIFIED'?{
  state:'HISTORICAL_RESPONSE',
  summary:`最近一次 ${latestCodexRequest.role} 的真实 turn/start 已关联到 ${latestCodexRequest.targetHost??'未取得目标'}、CFW 节点“${latestCodexRequest.selectedNode??'未取得'}”及同一连接链；这是历史请求证据，不证明当前进程、账户或未来请求持续可用。`
 }:latestCodexRequest?.path==='DIRECT_ROUTE_OBSERVED'?{
  state:'SCOPE_BLOCKED',
  summary:`最近一次 ${latestCodexRequest.role} 的真实 turn/start 在 DM 管理的进程树中观察到非回环直连；该请求不能作为经过 CFW 的路径证据，DM 不自动重试或切换节点。`
 }:
  latestCodexRequest?{
   state:'NOT_VERIFIED',
   summary:`最近一次 ${latestCodexRequest.role} 的真实 turn/start 未能完成请求级路径关联，状态为 ${latestCodexRequest.path}；没有使用 PID、系统代理或其他角色记录替代。`
  }:
  wsl&&config.clash.enabled?{state:'SCOPE_BLOCKED',summary:wslLoginTls?.state==='CONNECT_AND_TLS_COMPLETED'?
   `专用 WSL 诊断已达到 CFW，并完成到 Codex 登录域的 CONNECT/TLS${wslLoginTls.selectedNode?`，关联节点“${wslLoginTls.selectedNode}”`:''}；但仍未取得实际 WSL Codex 子进程的环境或请求级路径，原派发门禁继续关闭。`:
   '现有 Windows 网络设置尚未通过此 Linux 运行环境的路径核验；原派发门禁仍关闭。'}:
  routeBlocked?{state:'SCOPE_BLOCKED',summary:'CFW 当前所选节点与固定节点配置不一致；本次不修改共享选择器，也不宣称 Agent 已走期望路径。'}:
  config.clash.enabled?{state:'CONFIGURED_ONLY',summary:selectionPolicy==='current'?'DM 跟随你在 CFW 中当前选择的节点，不自动切换；Windows Codex 子进程预期继承同一回环代理，但被动进程元数据不能证明实际路径。':'DM 已选择固定 CFW 节点；Windows Codex 子进程预期继承同一回环代理，但被动进程元数据不能证明实际路径。'}:
  {state:'NOT_VERIFIED',summary:wsl?'没有此 Linux 程序到模型服务的连接关联证据；未把 Windows 代理当作它的路径。':'DM 受控路由未启用；无法从系统代理或进程存在推断此 Codex 进程实际走哪条路径。'};
 const expectedFor=(id:string):NetworkContextRow['routing']=>{
  if(id==='wsl-codex-login'||id==='codex-app-server'&&wsl)return{
   expected:{state:'WSL_SCOPE_BLOCKED',summary:'专用 WSL 诊断已证明此命名空间可到 Windows CFW，但尚未把该代理安全绑定到实际 Codex 子进程。'},
   observed:{state:'NOT_VERIFIED',summary:wslProxyTls.length?
    `已完成 ${wslProxyTls.filter(value=>value.state==='CONNECT_AND_TLS_COMPLETED').length}/2 个固定目标的诊断 CONNECT/TLS；这些不是 WSL Codex 自身请求，不能证明其代理环境、账户或推理。`:
    '未取得此 Linux 进程的代理环境与实际出口关联。'}
  };
  if(id==='windows-browser')return{expected:{state:'EXTERNAL_OR_UNMANAGED',summary:'浏览器是否使用系统代理由用户浏览器和 Windows 设置决定。'},observed:{state:'NOT_VERIFIED',summary:'未读取浏览器进程的实际连接链。'}};
  if(id==='development-codex')return{expected:{state:'EXTERNAL_OR_UNMANAGED',summary:'此组件的上游路径不由当前 Codex 子进程环境替代。'},observed:{state:'NOT_VERIFIED',summary:'没有归属于该进程的当前连接记录。'}};
  if(id==='magpie-gateway')return config.clash.enabled?{
   expected:{state:'CONTROLLED_PROXY_EXPECTED',summary:'DM 专属 Magpie 启动时预期继承当前 CFW lease 的同一回环代理；不会读取或控制其他 Magpie。'},
   observed:{state:'NOT_VERIFIED',summary:routeBlocked?'CFW 当前选择与固定节点不一致，不能把启动环境当作实际上游路径。':'尚未取得归属于 DM 专属 Magpie 的上游请求级节点关联；启动环境不等于出口证明。'}
  }:{
   expected:{state:'DM_ROUTE_DISABLED',summary:'DM 受控路由未启用；专属 Magpie 不借用 Windows Codex 的环境或系统代理推断。'},
   observed:{state:'NOT_VERIFIED',summary:'没有归属于该进程的当前连接记录。'}
  };
  if(id==='dsh-executor'){
   if(routeBlocked)return{expected:{state:'CONTROLLED_PROXY_EXPECTED',summary:'预期由 DM 的 CFW 租约提供同一受控出口。'},observed:{state:'NOT_VERIFIED',summary:'CFW 当前选择与固定节点不一致，旧请求记录不能证明本次路径。'}};
   const expected=config.clash.enabled?{state:'CONTROLLED_PROXY_EXPECTED' as const,summary:'DSH 工具进程只连接本机模型网关；网关的外部请求预期按 executor 角色使用 DM 的 CFW 租约。'}:
    {state:'DM_ROUTE_DISABLED' as const,summary:'DM 受控路由未启用；DSH 路径未作推断。'};
   if(latestDeepSeekRequest?.role==='executor'&&config.clash.enabled)return{
    expected,
    observed:{state:'REQUEST_ROUTE_VERIFIED',summary:`最近一次 executor 归属的受控 DeepSeek 请求使用了节点“${latestDeepSeekRequest.selectedNode}”；这是历史路径证据，不证明当前 DSH 进程、账户资格或推理能力。`}
   };
   return{expected,observed:{state:'NOT_VERIFIED',summary:'尚无归属于 DSH executor 的请求级节点关联。'}};
  }
   if(id==='codex-app-server'&&latestCodexRequest){
    const expected=config.clash.enabled?{state:'CONTROLLED_PROXY_EXPECTED' as const,summary:'预期由 DM 的 CFW lease 注入同一 HTTP/HTTPS/ALL 受控代理；WSL 路径必须先发现可验证的私有网关，并由进程级连接观察核验实际出口。'}:
      {state:'DM_ROUTE_DISABLED' as const,summary:'DM 受控路由当前未启用；历史记录不能证明新请求仍使用该路径。'};
    if(latestCodexRequest.path==='REQUEST_ROUTE_VERIFIED')return{
     expected,
     observed:{state:'REQUEST_ROUTE_VERIFIED',summary:`请求级证据：最近一次 ${latestCodexRequest.role} turn/start 的源端口已唯一关联到 DM 管理的 app-server，目标 ${latestCodexRequest.targetHost}，实际节点“${latestCodexRequest.selectedNode??'未取得'}”，连接链 ${latestCodexRequest.chains.join(' → ')}。网络路径、认证、服务资格和推理结果仍分别判断。`}
    };
    return{expected,observed:{state:'NOT_VERIFIED',summary:`最近一次 ${latestCodexRequest.role} turn/start 的路径状态为 ${latestCodexRequest.path}；没有借用 PID 存在或其他角色连接作为证明。`}};
   }
   if(id==='codex-app-server'&&latestCodexPath){
    if(latestCodexPath.path==='CHILD_ENV_MATCH')return{
     expected:{state:'CONTROLLED_PROXY_EXPECTED',summary:'预期由 DM 的 CFW lease 注入同一 HTTP/HTTPS/ALL 受控代理。'},
     observed:{state:'CHILD_ENV_VERIFIED',summary:`最近一次真实启动记录（${latestCodexPath.role}）确认子进程收到一致的受控${latestCodexPath.transport==='wsl'?' WSL 网关':'回环'}代理环境；仍未证明 CONNECT、账户、资格或推理成功。`}
    };
    if(latestCodexPath.path==='UNMANAGED_ENV_PRESENT')return{
     expected:{state:'CONTROLLED_PROXY_EXPECTED',summary:'配置要求使用受控 CFW 路由。'},
     observed:{state:'NOT_VERIFIED',summary:`最近一次真实启动记录（${latestCodexPath.role}）发现未受管代理变量；未被当作受控路径证明。`}
    };
   }
   if(config.clash.enabled){
    const observed=input.windows.codexServerRunning?{
     state:'PROCESS_EXISTS_ONLY' as const,
     summary:'发现 Codex app-server 进程，但尚未找到与当前源码和配置匹配的真实启动路径记录。'
    }:{
     state:'NOT_VERIFIED' as const,
     summary:'尚未找到与当前源码和配置匹配的真实子进程启动事件。'
    };
    return{expected:{state:'CONTROLLED_PROXY_EXPECTED',summary:'预期由 DM 的 CFW lease 注入同一 HTTP/HTTPS/ALL 回环代理。'},observed};
   }
   return{expected:{state:'DM_ROUTE_DISABLED',summary:'DM 未启用受控 CFW 路由，继续使用进程自身或系统默认网络。'},observed:{state:'NOT_VERIFIED',summary:latestCodexPath?`最近一次启动记录为 ${latestCodexPath.path}；受控路由当前关闭，不能用旧记录证明新设置。`:'未启用受控路由，因此不能宣称它经过或绕过 CFW。'}};
 };
 const contexts:NetworkContextRow[]=[{
  id:'windows-browser',title:'Windows 浏览器',runtime:'由你操作的本机浏览器',
  connection:{state:input.windows.available?'OBSERVED':'UNAVAILABLE',summary:input.windows.available?'已读取本机代理设置；没有控制或重新登录浏览器。':'暂时无法读取浏览器所处系统的网络设置。'},
  path:{state:input.windows.available&&input.windows.systemProxyEnabled?'CONFIGURED_ONLY':'NOT_VERIFIED',summary:input.windows.systemProxyEnabled?'系统代理已配置；未证明某次浏览器授权用了哪条连接。':'未取得浏览器授权请求的具体路径证据。'},
  service:{state:'NOT_VERIFIED',summary:'浏览器能打开网页，不代表后台角色获得服务资格。'},evidence:[]
 },{
  id:'wsl-codex-login',title:'WSL Codex 登录',runtime:wsl?'DM 专用 Linux CLI 登录环境':'当前未选择 Linux 登录环境',
  connection:{state:!wsl?'NOT_CHECKED':!observed.available?'UNAVAILABLE':observed.codexLoginRunning?'OBSERVED':'NOT_RUNNING',summary:!wsl||!observed.available?'未取得当前专用登录环境的进程状态。':observed.codexLoginRunning?'发现专用 CLI 登录进程；本次只读检查没有发起登录。':'当前没有观测到专用登录进程；不会自动启动。'},
  path:{...codexPath},service:{...denial},evidence:[...wslTlsEvidence,...loginEvidence].slice(-4)
 },{
  id:'codex-app-server',title:'Codex app-server',runtime:wsl?'DM 管理的 Linux 工程角色进程':'DM 管理的 Windows 工程角色进程',
  connection:{state:wsl?observed.available?(observed.codexServerRunning?'OBSERVED':'NOT_RUNNING'):'UNAVAILABLE':input.windows.available?(input.windows.codexServerRunning?'OBSERVED':'NOT_RUNNING'):'UNAVAILABLE',summary:(wsl?observed.codexServerRunning:input.windows.codexServerRunning)?'发现专用 app-server 进程；没有创建模型会话。':'没有当前已连接的证明；本次没有派发任务或创建模型会话。'},
   path:{...codexPath},service:{...denial},evidence:[
    ...(latestCodexRequest?[{
     kind:'STORED_HISTORY' as const,at:stamp(latestCodexRequest.at),
     summary:`最近一次 ${latestCodexRequest.role} 的请求级记录：路径 ${latestCodexRequest.path}，目标 ${latestCodexRequest.targetHost??'未取得'}，HTTP ${latestCodexRequest.httpStatus??'未收到响应'}，分类 ${latestCodexRequest.classification}${latestCodexRequest.selectedNode?`，节点“${latestCodexRequest.selectedNode}”`:''}；原始端口和请求编号未保存。`,
     requestId:latestCodexRequest.requestIdSha256?latestCodexRequest.requestIdSha256.slice(0,8)+'…':null
    }]:[]),
    ...(latestCodexPath?[{
     kind:'CODEX_START_EVENT' as const,at:stamp(latestCodexPath.at),
     summary:`最近一次 ${latestCodexPath.role} 启动记录：${latestCodexPath.path==='CHILD_ENV_MATCH'?'子进程代理环境一致':latestCodexPath.path==='UNMANAGED_ENV_PRESENT'?'发现未受管代理环境':'DM 受控路由未启用'}；此记录不证明账户或模型成功。`,
     requestId:null
    }]:[]),
    ...(wslApiTls?[{
     kind:'LOCAL_METADATA' as const,at:stamp(at),requestId:null,
     summary:`专用 WSL 诊断到 api.openai.com:443：${wslApiTls.state}${wslApiTls.selectedNode?` / 节点“${wslApiTls.selectedNode}”`:''}；不是产品 app-server 请求，认证、服务资格和推理仍未知。`
    }]:[]),
    ...loginEvidence.map(e=>({...e,summary:'同一专用登录环境的历史观察：'+e.summary}))
   ].slice(-4)
 },{
  id:'dsh-executor',title:'DSH 执行器',runtime:'DM 管理的本机 DSH 工具进程与受控模型网关',
  connection:{state:input.windows.available?(input.windows.dshRunning?'OBSERVED':'NOT_RUNNING'):'UNAVAILABLE',summary:input.windows.dshRunning?'发现 DM 专属执行器进程；进程存在不代表模型连接正常。':'未发现 DM 专属执行器进程，或未取得进程信息；历史响应另列。'},
   path:routeBlocked?{state:'SCOPE_BLOCKED',summary:'CFW 选择器与固定节点配置不一致；本轮不修改共享节点，也不声称 DSH 已走配置路径。'}:
     latestDeepSeekRequest?.role==='executor'?{state:'HISTORICAL_RESPONSE',summary:`最近一次 executor 归属的受控 DeepSeek 请求已关联到节点“${latestDeepSeekRequest.selectedNode}”；这是历史传输记录，不证明当前 DSH 进程、账户、服务资格或工具制作能力。`}:
     {state:'NOT_VERIFIED',summary:latestDeepSeekRequest?'最近看到一条受控 DeepSeek 外部请求，但记录中没有 DSH executor 角色归属；它不能证明 DSH 使用该节点。':'尚无本次请求的路径关联；其他角色或其他时间的成功不作替代。'},
    service:{state:'NOT_VERIFIED',summary:'当前版本的工具制作资格仍需单独核验。'},
   evidence:latestDeepSeekRequest?[{kind:'STORED_HISTORY',at:stamp(latestDeepSeekRequest.at),requestId:latestDeepSeekRequest.requestIdSha256?latestDeepSeekRequest.requestIdSha256.slice(0,8)+'…':null,summary:latestDeepSeekRequest.role==='executor'?`executor 归属的历史传输记录：${latestDeepSeekRequest.targetHost} / ${latestDeepSeekRequest.classification} / ${latestDeepSeekRequest.selectedNode||'节点未取得'}；只证明该次受控路径，不验证当前 DSH 进程或模型资格。`:`未归属于 DSH 的传输记录：${latestDeepSeekRequest.targetHost} / ${latestDeepSeekRequest.classification} / ${latestDeepSeekRequest.selectedNode||'节点未取得'}；不能据此验证 DSH 角色。`}]:[]
 }];
 if(latestCodexRequest){
  const codex=contexts[2];
  if(latestCodexRequest.classification==='REGION_OR_POLICY_RESTRICTED'){
   codex.service={state:'POLICY_BLOCKED',summary:'最近一次真实 Codex turn/start 明确收到地区或服务政策限制；不会切换节点、账户或身份重试。'};
  }else if(latestCodexRequest.classification==='INFERENCE_COMPLETED'){
   codex.service={state:'UNVERIFIED_HISTORY',summary:'最近一次真实 Codex turn 已完成；这证明该次会话在当时可推理，但不等于永久账户资格或当前进程仍在线。'};
  }else if(latestCodexRequest.classification!=='NOT_OBSERVED'){
   codex.service={state:'NOT_VERIFIED',summary:`最近一次真实 Codex turn 未完成，分类为 ${latestCodexRequest.classification}；没有据此推断其他角色或账户状态。`};
  }
 }
 const history=input.dshHistory;
 if(history?.model==='deepseek-flash'&&history.provider==='deepseek-official'&&stamp(history.at)){
  const dsh=contexts[3];dsh.service={state:'UNVERIFIED_HISTORY',summary:'找到已保存的 DSH 记录；本次未验签，不将它当作真实响应、当前连接或工具制作资格。'};
  dsh.evidence=[{kind:'STORED_HISTORY',at:stamp(history.at),requestId:null,summary:'数据库保存了 deepseek-flash / deepseek-official 记录；此只读检查没有验证收据签名。'}];
 }
 const fingerprint=wsl?observed.account.fingerprint:null;
 const additionalContexts:NetworkContextRow[]=[{
  id:'development-codex',title:'开发 Codex',runtime:'当前开发用桌面程序，独立于产品工程角色',
  connection:{state:input.windows.available?(input.windows.developmentCodexRunning?'OBSERVED':'NOT_RUNNING'):'UNAVAILABLE',summary:'仅观察开发程序进程；DM 不控制它的登录、重试或网络。'},
  path:{state:'NOT_VERIFIED',summary:'系统代理或一次连接报错不能证明具体节点；没有借用产品角色的路径证据。'},
  service:{state:'NOT_VERIFIED',summary:'开发程序的会话不能代替产品 Codex 的账户与角色资格。'},evidence:[]
 },{
  id:'magpie-gateway',title:'Magpie 专属网关',runtime:'DM 专属进程；不读取或控制其他 Magpie',
  connection:{state:input.windows.available?(input.windows.magpieRunning?'OBSERVED':'NOT_RUNNING'):'UNAVAILABLE',summary:'只观察 DM 专属程序。未启动、无账户或无请求时，不把它显示成模型已接通。'},
  path:{state:'NOT_VERIFIED',summary:config.clash.enabled?'新的 DM 专属 Magpie 启动会要求继承同一受控回环代理；目前尚无本次上游请求证据，不能把进程或启动环境当作出口证明。':'本地网关控制通道与提供商请求路径分别核验；目前没有本次外部请求证据。'},
  service:{state:'NOT_VERIFIED',summary:'安全入口检查不代表真实账户、模型、Agent 或四角色可用。'},evidence:[]
 }];
 for(const row of [...contexts,...additionalContexts]){
  row.stability={state:'NOT_TESTED',summary:'尚无属于此进程的持续连接证据。本地代理短测不能替代它的外部连接。'};
  row.routing=expectedFor(row.id);
 }
 const snapshot:NetworkContextsSnapshot={schema:'dream-maker.network-contexts.v1',observedAt:at,currentConfiguration:true,cacheMs:15000,scope:'PASSIVE_LOCAL_METADATA_NO_LOGIN_OR_INFERENCE',automaticLogin:false,externalProbes:false,networkSettingsChanged:false,
  eligibilityPolicy:{automaticRegionSwitch:false,proxyChangeIsEligibilityEvidence:false,remediation:'OFFICIAL_ELIGIBILITY_ONLY'},
  controller:{state:input.controller.available?'OBSERVED':'UNAVAILABLE',dmRoutingEnabled:config.clash.enabled,selectionPolicy,selectors:input.controller.selectors,nodes:input.controller.nodes,configuredSelector,configuredNode,selectedNode,selectionMatchesExpected,
   proxyListener:readProxyListenerObservation(input.windows.proxyListener)},
  account:{state:wsl&&observed.account.mode==='CHATGPT'?'CACHED_UNVERIFIED':'UNKNOWN',mode:wsl?observed.account.mode:'UNKNOWN',fingerprint:typeof fingerprint==='string'&&/^[a-f0-9]{16,64}$/.test(fingerprint)?fingerprint:null},
  openAi:{
   networkReachability:{state:'NOT_TESTED',summary:'尚未执行不发推理请求的 OpenAI TCP/TLS 连通检查；本地到 CFW 可达不能替代。'},
   authentication:{state:'NOT_VERIFIED',summary:'没有本次 OpenAI 凭据验证证据；Codex 缓存或控制器可读不代表 API 认证成功。'},
   serviceEligibility:{state:'NOT_VERIFIED',summary:'账户、套餐、模型与地区服务资格仍需官方核验；切换节点不改变资格。'},
   inference:{state:'NOT_RUN',summary:'本轮没有发起 OpenAI 模型推理。'}
  },
  contexts,additionalContexts,wslProxyReachability,...(wslProxyTls.length?{wslProxyTls}:{}),retry:{allowed:false,reason:'NO_NEW_ELIGIBILITY_EVIDENCE'}};
 if(latestDeepSeekRequest)snapshot.latestDeepSeekRoutedRequest=latestDeepSeekRequest;
 if(latestRoutedRequest)snapshot.latestRoutedRequest=latestRoutedRequest;
 if(latestOpenAiRequest&&!codexIsLatest){
   snapshot.openAi.networkReachability=latestOpenAiRequest.httpStatus===null?
    {state:'UNREACHABLE',summary:'最近一次受控 OpenAI 请求未取得 HTTP 响应；没有据此声称 TLS 可达或账户有效。'}:
    {state:'TLS_REACHABLE',summary:'最近一次受控 OpenAI HTTP 请求收到了上游响应；这证明当时网络到达服务，不代表后续请求或账户持续有效。'};
   if(latestOpenAiRequest.classification==='INFERENCE_COMPLETED'){
    snapshot.openAi.authentication={state:'AUTHENTICATED',summary:'最近一次受控 OpenAI 请求成功完成，证明该次请求的认证有效。'};
    snapshot.openAi.serviceEligibility={state:'ELIGIBLE',summary:'最近一次受控 OpenAI 请求成功完成，证明该次请求在当时的账户与服务条件下可用；不代表地区或未来资格永久不变。'};
    snapshot.openAi.inference={state:'COMPLETED',summary:'已记录最近一次受控 OpenAI 请求完成。'};
   }else if(latestOpenAiRequest.classification==='HTTP_SUCCESS_NON_INFERENCE'){
    snapshot.openAi.inference={state:'NOT_RUN',summary:'最近一次受控 OpenAI HTTP 请求成功，但没有可核验的推理完成证据；它可能不是推理请求，或模型响应不完整。没有据此声称模型推理成功。'};
   }else if(latestOpenAiRequest.classification==='HTTP_401_AUTHENTICATION_FAILED'){
    snapshot.openAi.authentication={state:'FAILED',summary:'最近一次受控 OpenAI 请求返回认证失败；没有据此重试或切换账户。'};
    snapshot.openAi.inference={state:'FAILED',summary:'最近一次受控 OpenAI 请求因认证失败而未完成。'};
   }else if(latestOpenAiRequest.classification==='REGION_OR_POLICY_RESTRICTED'){
    snapshot.openAi.serviceEligibility={state:'POLICY_BLOCKED',summary:'最近一次受控 OpenAI 请求明确返回地区或服务政策限制；不会切换节点或身份重试。'};
    snapshot.openAi.inference={state:'FAILED',summary:'最近一次受控 OpenAI 请求被服务政策拒绝，模型没有完成。'};
   }else{
    snapshot.openAi.inference={state:'FAILED',summary:`最近一次受控 OpenAI 请求失败：${latestOpenAiRequest.classification}。`};
   }
 }
 if(latestCodexRequest){
  snapshot.latestCodexRequest=latestCodexRequest;
  if(codexIsLatest){
   if(latestCodexRequest.httpStatus!==null)snapshot.openAi.networkReachability={state:'TLS_REACHABLE',summary:'最近一次 Codex 请求记录了上游 HTTP 响应；账户认证、服务资格与模型完成仍分别核对。'};
   if(latestCodexRequest.classification==='INFERENCE_COMPLETED'){
    snapshot.openAi.networkReachability={state:'TLS_REACHABLE',summary:latestCodexRequest.httpStatus===null?
     '最近一次真实 Codex app-server 回合已完成，证明当时到达服务并完成推理；未观察到可核验的原始 HTTP 状态码，因此不补造。':
     `最近一次真实 Codex app-server 回合收到了 OpenAI 上游 HTTP ${latestCodexRequest.httpStatus} 响应；这证明当时请求到达服务，不代表后续请求仍可用。`};
    snapshot.openAi.authentication={state:'AUTHENTICATED',summary:'最近一次真实 Codex app-server turn 已完成，证明该次会话的 ChatGPT 订阅认证有效。'};
    snapshot.openAi.serviceEligibility={state:'ELIGIBLE',summary:'最近一次真实 Codex app-server turn 已完成，证明该次会话在当时具有实际推理资格；不代表地区或未来资格永久不变。'};
    snapshot.openAi.inference={state:'COMPLETED',summary:'最近一次真实 Codex app-server turn 已在独立会话中完成。'};
   }else if(latestCodexRequest.classification==='REGION_OR_POLICY_RESTRICTED'){
    snapshot.openAi.serviceEligibility={state:'POLICY_BLOCKED',summary:'最近一次真实 Codex app-server 请求明确返回地区或服务政策限制；不切换节点、不伪造身份、不自动重试。'};
    snapshot.openAi.inference={state:'FAILED',summary:'最近一次真实 Codex app-server turn 被服务政策拒绝，模型没有完成。'};
   }else if(latestCodexRequest.classification==='HTTP_401_AUTHENTICATION_FAILED'){
    snapshot.openAi.authentication={state:'FAILED',summary:'最近一次真实 Codex app-server 请求返回认证失败；没有据此切换账户。'};
    snapshot.openAi.inference={state:'FAILED',summary:'最近一次真实 Codex app-server turn 因认证失败而未完成。'};
   }else if(latestCodexRequest.classification!=='NOT_OBSERVED'){
    snapshot.openAi.inference={state:'FAILED',summary:`最近一次真实 Codex app-server turn 未完成，分类为 ${latestCodexRequest.classification}。网络路径与账户资格分别判断。`};
   }
  }
 }
 return snapshot;
}
/** At most one local collection is active. Cached results retain their actual observation time. */
export class NetworkContextsService {
 private pending?:Promise<{key:string;value:NetworkContextsSnapshot}>;
 private cached?:{key:string;value:NetworkContextsSnapshot;completed:number};
 private stop=new AbortController();private closing?:Promise<void>;
 private checking?:Promise<LocalNetworkCheck>;private health?:{key:string;value:LocalProxyHealth};
 constructor(private getConfig:()=>Config,private collect:(c:Config,signal:AbortSignal)=>Promise<LocalNetworkObservations>,private clock=()=>Date.now(),private probe?:(c:Config,signal:AbortSignal)=>Promise<LocalProxyHealth>,private endpointIdentity?:()=>string){}
 private key(c:Config,endpoint=this.endpointIdentity?.()){return hash({codex:c.codex,clash:c.clash,dsh:c.dsh,localEndpointIdentity:endpoint??null});}
 private healthSelectionState(snapshot:NetworkContextsSnapshot,health:LocalProxyHealth):'CURRENT'|'STALE'|'UNASSOCIATED'{
  if(!this.getConfig().clash.enabled)return 'CURRENT';
  if(snapshot.controller.state!=='OBSERVED')return 'UNASSOCIATED';
  const expected=snapshot.controller.selectionPolicy==='current'?snapshot.controller.selectedNode:snapshot.controller.configuredNode;
  if(expected===null)return 'UNASSOCIATED';
  const tlsProbes=[health.openAiTls,health.codexTls,health.deepSeekTls,...(health.codexControlTlsProbes??[])].filter((value):value is LocalProxyHealth['openAiTls']=>value!==undefined);
  if(tlsProbes.some(value=>value.selectionMatchesExpected===false||value.selectedNode!==null&&value.selectedNode!==expected))return 'STALE';
  return health.openAiTls.selectedNode===null?'UNASSOCIATED':'CURRENT';
 }
 private applyHealth(snapshot:NetworkContextsSnapshot,health:LocalProxyHealth,announceInvalid:boolean):NetworkContextsSnapshot{
  const selectionState=this.healthSelectionState(snapshot,health);
  if(selectionState==='STALE'){
   delete snapshot.localProxyHealth;
   if(announceInvalid){
    const probes=[health.openAiTls,health.codexTls,health.deepSeekTls,...(health.codexControlTlsProbes??[])].filter((value):value is LocalProxyHealth['openAiTls']=>value!==undefined);
    const observedNode=probes.map(value=>value.selectedNode).find(value=>value!==null);
    const checked=observedNode?`节点“${observedNode}”`:'一个未记录的节点';
    const current=snapshot.controller.selectedNode?`节点“${snapshot.controller.selectedNode}”`:'当前未取得节点';
    snapshot.openAi.networkReachability={state:'NOT_TESTED',summary:`最近一次本机 TLS 检查针对${checked}，但 CFW 当前选择已变为${current}；旧结果已作废，请重新检查。`};
   }
   return snapshot;
  }
  snapshot.localProxyHealth=structuredClone(health);
  if(snapshot.localProxyHealth.openAiTls.state==='TLS_HANDSHAKE_COMPLETED'&&selectionState==='UNASSOCIATED')snapshot.openAi.networkReachability={state:'TCP_REACHABLE_ONLY',summary:'本机完成了到 api.openai.com:443 的 TLS 握手，但没有取得这条连接与当前 CFW 节点的关联；网络可达，预期路径仍未核验。'};
  else if(snapshot.localProxyHealth.openAiTls.state==='TLS_HANDSHAKE_COMPLETED')snapshot.openAi.networkReachability={state:'TLS_REACHABLE',summary:'本机经已有 CFW 完成了到 api.openai.com:443 的 TLS 握手；没有发送 HTTP 请求。账户认证、服务资格和模型推理仍未验证。'};
  else if(snapshot.localProxyHealth.openAiTls.state!=='NOT_TESTED')snapshot.openAi.networkReachability={state:'UNREACHABLE',summary:'本机短测未完成到 api.openai.com:443 的 TLS 握手；这不等于账户或地区资格结论。'};
  return snapshot;
 }
 private view(value:NetworkContextsSnapshot,key:string):NetworkContextsSnapshot{
  const current=structuredClone(value);current.configurationFingerprint=key;current.currentConfiguration=key===this.key(this.getConfig());
  if(this.health?.key===key)this.applyHealth(current,this.health.value,true);
  return current;
 }
 /** Return the same completed check after replay/restart, with currentness recomputed. */
 async replayCheck(raw:unknown):Promise<NetworkContextsSnapshot>{
  const value=raw as NetworkContextsSnapshot;
  if(!value||value.schema!=='dream-maker.network-contexts.v1'||!value.localProxyHealth||value.localProxyHealth.schema!=='dream-maker.local-proxy-health.v1'||typeof value.configurationFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.configurationFingerprint))throw new DomainError('NETWORK_CHECK_RESULT_UNAVAILABLE',409);
  const current=await this.readSnapshot(true),replay=structuredClone(value);
  replay.currentConfiguration=value.configurationFingerprint===this.key(this.getConfig());
  replay.controller=structuredClone(current.controller);
  if(!replay.currentConfiguration){
   delete replay.localProxyHealth;
   replay.openAi.networkReachability={state:'NOT_TESTED',summary:'网络设置已经变化；旧检查结果不能作为当前网络证据，请重新检查。'};
   return replay;
  }
  return this.applyHealth(replay,replay.localProxyHealth!,true);
 }
 async snapshotForCheck(check:LocalNetworkCheck):Promise<NetworkContextsSnapshot>{
  const snapshot=await this.readSnapshot(true);
  if(!snapshot.currentConfiguration||snapshot.configurationFingerprint!==check.configurationFingerprint||check.configurationFingerprint!==this.key(this.getConfig()))throw new DomainError('NETWORK_CONFIGURATION_CHANGED',409);
  if(this.healthSelectionState(snapshot,check.health)==='STALE')throw new DomainError('NETWORK_CONFIGURATION_CHANGED',409);
  return this.applyHealth({...snapshot},check.health,false);
 }
 /** Force one fresh passive observation. It never grants role or model authority. */
 refresh():Promise<NetworkContextsSnapshot>{return this.readSnapshot(true);}
 diagnose():Promise<LocalNetworkCheck>{
  if(this.stop.signal.aborted)return Promise.reject(new DomainError('NETWORK_CONTEXTS_CLOSED',409));
  if(!this.probe)return Promise.reject(new DomainError('NETWORK_LOCAL_CHECK_UNAVAILABLE',409));
  if(!this.checking){const config=structuredClone(this.getConfig()),endpoint=this.endpointIdentity?.(),key=this.key(config,endpoint);this.checking=(async()=>{const value=await this.probe!(config,this.stop.signal);if(this.stop.signal.aborted)throw new DomainError('NETWORK_CONTEXTS_CLOSED',409);if(key!==this.key(this.getConfig())||endpoint!==undefined&&value.endpointFingerprint!==endpoint)throw new DomainError('NETWORK_CONFIGURATION_CHANGED',409);this.health={key,value:structuredClone(value)};return{configurationFingerprint:key,health:structuredClone(value)};})().finally(()=>{this.checking=undefined;});}
  return this.checking;
 }
 private async readSnapshot(forceRefresh:boolean):Promise<NetworkContextsSnapshot>{
  if(this.stop.signal.aborted)throw new DomainError('NETWORK_CONTEXTS_CLOSED',409);
  const config=structuredClone(this.getConfig()),key=this.key(config),now=this.clock();
  if(!forceRefresh&&this.cached?.key===key&&now-this.cached.completed>=0&&now-this.cached.completed<15000)return this.view(this.cached.value,key);
  if(forceRefresh&&this.pending)await this.pending;
  if(!this.pending)this.pending=(async()=>{const input=await this.collect(config,this.stop.signal);if(this.stop.signal.aborted)throw new DomainError('NETWORK_CONTEXTS_CLOSED',409);const value=networkContextsSnapshot(config,input,new Date(this.clock()).toISOString()),entry={key,value};this.cached={...entry,completed:this.clock()};return entry;})().finally(()=>{this.pending=undefined;});
  const entry=await this.pending;
  return this.view(entry.value,entry.key);
 }
 snapshot():Promise<NetworkContextsSnapshot>{return this.readSnapshot(false);}
 close():Promise<void>{if(this.closing)return this.closing;this.stop.abort();return this.closing=(async()=>{const results=await Promise.allSettled([this.pending,this.checking]);for(const result of results)if(result.status==='rejected'&&!['NETWORK_CONTEXTS_CLOSED','NETWORK_CHECK_CANCELLED'].includes(String(result.reason?.code)))throw result.reason;})();}
}
