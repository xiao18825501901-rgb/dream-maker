import {
 CODEX_CONTROL_TARGET_HOSTS,
 CODEX_REQUEST_TARGETS,
 type NetworkContextsSnapshot,
 type NetworkContextRow,
 type CodexRequestPathObservation,
 type OpenAiTlsProbe
} from '../shared/network-contexts.js';
import { readCodexMetadataObservation, type CodexMetadataObservation } from '../shared/codex-metadata.js';
import {escapeHtml as e} from './contracts.js';
import {roleDisplayName} from '../shared/role-names.js';

const ids=['windows-browser','wsl-codex-login','codex-app-server','dsh-executor'];
// A person reads the product name; the payload keeps the stable wire id.
const roleLabel=(role:string)=>roleDisplayName(role)??role;
const observed:Record<NetworkContextRow['connection']['state'],string>={OBSERVED:'已取得本机信息',NOT_RUNNING:'未发现专属进程',UNAVAILABLE:'未取得信息',NOT_CHECKED:'尚未检查'};
const paths:Record<NetworkContextRow['path']['state'],string>={NOT_VERIFIED:'路径尚未核验',CONFIGURED_ONLY:'仅确认已有配置',SCOPE_BLOCKED:'缺少专用路径核验',HISTORICAL_RESPONSE:'只有历史响应'};
const services:Record<NetworkContextRow['service']['state'],string>={NOT_VERIFIED:'服务资格尚未确认',POLICY_BLOCKED:'历史登录被政策拒绝',UNVERIFIED_HISTORY:'已保存记录 · 本次未验签'};
const routedClasses=new Set(['DNS_FAILURE','TCP_CONNECTION_FAILURE','TLS_HANDSHAKE_FAILURE','PROXY_CONNECTION_RESET','STREAM_INTERRUPTED','HTTP_401_AUTHENTICATION_FAILED','HTTP_403_PERMISSION_DENIED','REGION_OR_POLICY_RESTRICTED','HTTP_429_QUOTA_EXCEEDED','MODEL_UNAVAILABLE','HTTP_SUCCESS_NON_INFERENCE','HTTP_CLIENT_REQUEST_REJECTED','INFERENCE_COMPLETED','HTTP_5XX_UPSTREAM_FAILURE']);
const routedRoles=new Set(['planner1','planner2','executor','reviewer']);
const codexPathStates=new Set(['REQUEST_ROUTE_VERIFIED','DIRECT_ROUTE_OBSERVED','PROCESS_ROUTE_NOT_OBSERVED','PROCESS_IDENTITY_UNVERIFIED','CONNECTION_AMBIGUOUS','NODE_MISMATCH','CFW_UNAVAILABLE','ROUTE_DISABLED']);
const codexClasses=new Set([...routedClasses,'NOT_OBSERVED']);
const codexTargetHosts=new Set<string>(CODEX_REQUEST_TARGETS);
const routeExpected:Record<NonNullable<NetworkContextRow['routing']>['expected']['state'],string>={DM_ROUTE_DISABLED:'DM 受控路由未启用',CONTROLLED_PROXY_EXPECTED:'预期使用 CFW 受控代理',EXTERNAL_OR_UNMANAGED:'由外部进程自行决定',WSL_SCOPE_BLOCKED:'WSL 路径被门禁阻塞'};
const routeObserved:Record<NonNullable<NetworkContextRow['routing']>['observed']['state'],string>={NOT_VERIFIED:'尚未核验实际路径',CHILD_ENV_VERIFIED:'已核验子进程环境',PROCESS_EXISTS_ONLY:'仅发现进程，不足以证明路径',REQUEST_ROUTE_VERIFIED:'已记录请求级节点关联'};
const safeText=(v:unknown,max=400):v is string=>typeof v==='string'&&v.length<=max;
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^20\d\d-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
const validRouted=(r:NetworkContextsSnapshot['latestRoutedRequest']):boolean=>r!==undefined&&r!==null&&r.schema==='dream-maker.routed-request-observation.v1'&&[r.at,r.startedAt,r.completedAt].every(timestamp)&&r.process==='DM_CONTROLLED_TRANSPORT'&&(r.role===undefined||routedRoles.has(r.role))&&safeText(r.targetHost,253)&&['GET','POST'].includes(r.method)&&['pinned','current'].includes(r.selectionPolicy)&&safeText(r.selectedNode,512)&&safeText(r.expectedNode,512)&&(r.httpStatus===null||Number.isSafeInteger(r.httpStatus))&&routedClasses.has(r.classification)&&typeof r.automaticRetryAllowed==='boolean'&&(r.requestIdSha256===null||/^[a-f0-9]{64}$/.test(r.requestIdSha256))&&Number.isSafeInteger(r.elapsedMs);
const codexHosts=(r:CodexRequestPathObservation):string[]=>Array.isArray(r.targetHosts)?r.targetHosts:r.targetHost===null?[]:[r.targetHost];
const codexSourcePortCount=(r:CodexRequestPathObservation):number=>Number.isSafeInteger(r.sourcePortCount)?r.sourcePortCount:r.sourcePortSha256===null?0:1;
const validCodexRequest=(r:NetworkContextsSnapshot['latestCodexRequest']):boolean=>{
 if(r===undefined||r===null||r.schema!=='dream-maker.codex-request-path.v1'||![r.at,r.startedAt,r.completedAt].every(timestamp)||Date.parse(r.completedAt)<Date.parse(r.startedAt)||!['planner2','reviewer'].includes(r.role)||r.method!=='turn/start'||(r.targetHost!==null&&!codexTargetHosts.has(r.targetHost))||r.targetPort!==443||!codexPathStates.has(r.path)||(r.processPid!==null&&(!Number.isSafeInteger(r.processPid)||r.processPid<1))||![r.processIdentitySha256,r.sourcePortSha256,r.requestIdSha256].every(x=>x===null||/^[a-f0-9]{64}$/.test(x))||(r.proxyEndpoint!==null&&!/^127[.]0[.]0[.]1:[1-9][0-9]{0,4}$/.test(r.proxyEndpoint))||![r.selectedNode,r.expectedNode].every(x=>x===null||safeText(x,512))||!Array.isArray(r.chains)||r.chains.length>64||r.chains.some(x=>!safeText(x,512))||!codexClasses.has(r.classification)||(r.httpStatus!==null&&(!Number.isSafeInteger(r.httpStatus)||r.httpStatus<100||r.httpStatus>599))||r.automaticRetryAllowed!==false)return false;
 const hosts=codexHosts(r),portCount=codexSourcePortCount(r);
 if(hosts.length>CODEX_REQUEST_TARGETS.length||hosts.some(host=>!codexTargetHosts.has(host))||new Set(hosts).size!==hosts.length||!Number.isSafeInteger(portCount)||portCount<0||portCount>64)return false;
 return r.path!=='REQUEST_ROUTE_VERIFIED'||(r.targetHost!==null&&hosts.includes(r.targetHost)&&portCount>0&&r.processPid!==null&&r.processIdentitySha256!==null&&r.sourcePortSha256!==null&&r.proxyEndpoint!==null&&r.selectedNode!==null&&r.expectedNode!==null&&r.chains.length>0);
};
const validTlsProbe=(h:unknown,target:OpenAiTlsProbe['target']):h is OpenAiTlsProbe=>{
 const v=h as OpenAiTlsProbe;
 return Boolean(v)&&['NOT_TESTED','TLS_HANDSHAKE_COMPLETED','CONNECT_REJECTED','TLS_FAILED','TIMEOUT','CANCELLED','FAILED'].includes(v.state)&&v.target===target&&(v.protocol===null||safeText(v.protocol,32))&&typeof v.authorized==='boolean'&&(v.alpn===null||safeText(v.alpn,32))&&(v.elapsedMs===null||Number.isSafeInteger(v.elapsedMs)&&v.elapsedMs>=0&&v.elapsedMs<=60000)&&(v.selectedNode===null||safeText(v.selectedNode,200))&&(v.selectionMatchesExpected===null||typeof v.selectionMatchesExpected==='boolean')&&typeof v.nodeChainMatched==='boolean'&&(v.errorClass===null||/^[A-Z0-9_]{1,80}$/.test(v.errorClass))&&v.httpRequestSent===false&&v.modelCalls===0;
};
const validProxyListener=(raw:unknown):boolean=>{
 const v=raw as Record<string,unknown>;
 return Boolean(v)&&['LOOPBACK_ONLY','NON_LOOPBACK','MIXED','UNAVAILABLE'].includes(String(v.state))&&
  (v.mixedPort===null||Number.isSafeInteger(v.mixedPort)&&Number(v.mixedPort)>=1&&Number(v.mixedPort)<=65535)&&
  Array.isArray(v.bindings)&&v.bindings.length<=8&&v.bindings.every(value=>['LOOPBACK','WILDCARD','OTHER'].includes(String(value)))&&
  (v.ownerMatchesController===null||typeof v.ownerMatchesController==='boolean')&&
  (v.allowLan===null||typeof v.allowLan==='boolean')&&
  (v.bindAddress===null||safeText(v.bindAddress,255));
};
const validWslProxyReachability=(raw:unknown):boolean=>{
 const v=raw as Record<string,unknown>;
 return Boolean(v)&&v.schema==='dream-maker.wsl-proxy-reachability.v1'&&
  ['NOT_TESTED','TCP_REACHABLE_ONLY','CONNECTION_REFUSED','TIMEOUT','UNREACHABLE'].includes(String(v.state))&&
  (v.gateway===null||typeof v.gateway==='string'&&/^(?:10(?:[.]\d{1,3}){3}|172[.](?:1[6-9]|2\d|3[01])(?:[.]\d{1,3}){2}|192[.]168(?:[.]\d{1,3}){2})$/.test(v.gateway))&&
  (v.port===null||Number.isSafeInteger(v.port)&&Number(v.port)>=1&&Number(v.port)<=65535)&&
  (v.elapsedMs===null||Number.isSafeInteger(v.elapsedMs)&&Number(v.elapsedMs)>=0&&Number(v.elapsedMs)<=5000)&&
  v.routeSource==='WSL_DEFAULT_ROUTE'&&v.networkPayloadBytes===0&&v.httpRequests===0&&v.tlsHandshakes===0&&v.modelCalls===0&&v.filesWritten===0&&
  (v.state!=='TCP_REACHABLE_ONLY'||v.gateway!==null&&v.port!==null&&v.elapsedMs!==null);
};
const validWslProxyTls=(raw:unknown):boolean=>{
 const v=raw as Record<string,unknown>;
 return Boolean(v)&&v.schema==='dream-maker.wsl-proxy-tls-observation.v1'&&
  ['NOT_TESTED','CONNECT_AND_TLS_COMPLETED','PROXY_CONNECT_REJECTED','TLS_HANDSHAKE_FAILED','TIMEOUT','UNREACHABLE'].includes(String(v.state))&&
  ['api.openai.com','chatgpt.com'].includes(String(v.targetHost))&&v.targetPort===443&&
  (v.gateway===null||typeof v.gateway==='string'&&/^(?:10(?:[.]\d{1,3}){3}|172[.](?:1[6-9]|2\d|3[01])(?:[.]\d{1,3}){2}|192[.]168(?:[.]\d{1,3}){2})$/.test(v.gateway))&&
  (v.proxyPort===null||Number.isSafeInteger(v.proxyPort)&&Number(v.proxyPort)>=1&&Number(v.proxyPort)<=65535)&&
  (v.protocol===null||['TLSv1.2','TLSv1.3'].includes(String(v.protocol)))&&(v.alpn===null||v.alpn==='http/1.1')&&typeof v.authorized==='boolean'&&
  (v.elapsedMs===null||Number.isSafeInteger(v.elapsedMs)&&Number(v.elapsedMs)>=0&&Number(v.elapsedMs)<=30000)&&
  (v.cipher===null||safeText(v.cipher,100))&&(v.errorClass===null||/^[A-Z0-9_]{1,80}$/.test(String(v.errorClass)))&&
  (v.sourcePortSha256===null||/^[a-f0-9]{64}$/.test(String(v.sourcePortSha256)))&&
  (v.selectedNode===null||safeText(v.selectedNode,512))&&(v.expectedNode===null||safeText(v.expectedNode,512))&&
  (v.selectionMatchesExpected===null||typeof v.selectionMatchesExpected==='boolean')&&typeof v.nodeChainMatched==='boolean'&&
  Array.isArray(v.chains)&&v.chains.length<=64&&v.chains.every(value=>safeText(value,512))&&
  (v.proxyConnectRequests===0||v.proxyConnectRequests===1)&&Number.isSafeInteger(v.proxyControlBytes)&&Number(v.proxyControlBytes)>=0&&Number(v.proxyControlBytes)<=16384&&
  v.originHttpRequests===0&&v.modelCalls===0&&v.filesWritten===0;
};
export function readNetworkContexts(raw:unknown):NetworkContextsSnapshot{
 const v=raw as NetworkContextsSnapshot;
 if(!v||v.schema!=='dream-maker.network-contexts.v1'||v.scope!=='PASSIVE_LOCAL_METADATA_NO_LOGIN_OR_INFERENCE'||!timestamp(v.observedAt)||typeof v.currentConfiguration!=='boolean'||v.cacheMs!==15000||v.automaticLogin!==false||v.externalProbes!==false||v.networkSettingsChanged!==false||v.retry?.allowed!==false||v.retry.reason!=='NO_NEW_ELIGIBILITY_EVIDENCE'||
   !v.eligibilityPolicy||Object.keys(v.eligibilityPolicy).length!==3||v.eligibilityPolicy.automaticRegionSwitch!==false||v.eligibilityPolicy.proxyChangeIsEligibilityEvidence!==false||v.eligibilityPolicy.remediation!=='OFFICIAL_ELIGIBILITY_ONLY'||
   !v.controller||!Object.hasOwn(observed,v.controller.state)||typeof v.controller.dmRoutingEnabled!=='boolean'||!['pinned','current'].includes(v.controller.selectionPolicy)||![v.controller.selectors,v.controller.nodes].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=10000)||
   ![v.controller.configuredSelector,v.controller.configuredNode,v.controller.selectedNode].every(x=>x===null||safeText(x,200))||v.controller.selectionMatchesExpected!==null&&typeof v.controller.selectionMatchesExpected!=='boolean'||v.controller.proxyListener!==undefined&&!validProxyListener(v.controller.proxyListener)||
   !v.openAi||!['NOT_TESTED','TCP_REACHABLE_ONLY','TLS_REACHABLE','UNREACHABLE'].includes(v.openAi.networkReachability?.state)||!safeText(v.openAi.networkReachability?.summary)||
   !['NOT_VERIFIED','AUTHENTICATED','FAILED'].includes(v.openAi.authentication?.state)||!safeText(v.openAi.authentication?.summary)||
   !['NOT_VERIFIED','ELIGIBLE','POLICY_BLOCKED'].includes(v.openAi.serviceEligibility?.state)||!safeText(v.openAi.serviceEligibility?.summary)||
   !['NOT_RUN','FAILED','COMPLETED'].includes(v.openAi.inference?.state)||!safeText(v.openAi.inference?.summary)||
   v.latestRoutedRequest!==undefined&&!validRouted(v.latestRoutedRequest)||v.latestDeepSeekRoutedRequest!==undefined&&!validRouted(v.latestDeepSeekRoutedRequest)||v.latestCodexRequest!==undefined&&!validCodexRequest(v.latestCodexRequest)||v.wslProxyReachability!==undefined&&!validWslProxyReachability(v.wslProxyReachability)||
   v.wslProxyTls!==undefined&&(!Array.isArray(v.wslProxyTls)||v.wslProxyTls.length>2||v.wslProxyTls.some(value=>!validWslProxyTls(value)))||
   !v.account||!['CACHED_UNVERIFIED','UNKNOWN'].includes(v.account.state)||!['CHATGPT','UNKNOWN'].includes(v.account.mode)||v.account.fingerprint!==null&&!/^[a-f0-9]{16,64}$/.test(v.account.fingerprint)||!Array.isArray(v.contexts)||v.contexts.length!==4)throw Error('NETWORK_CONTEXTS_INVALID');
  for(const [i,r] of v.contexts.entries())if(!r||r.id!==ids[i]||!safeText(r.title,80)||!safeText(r.runtime,160)||!r.connection||!r.path||!r.service||!Object.hasOwn(observed,r.connection.state)||!Object.hasOwn(paths,r.path.state)||!Object.hasOwn(services,r.service.state)||![r.connection.summary,r.path.summary,r.service.summary].every(x=>safeText(x))||!Array.isArray(r.evidence)||r.evidence.length>4||r.evidence.some(x=>!x||!['LOCAL_METADATA','LOGIN_REJECTION','STORED_HISTORY','CODEX_START_EVENT'].includes(x.kind)||x.at!==null&&!timestamp(x.at)||!safeText(x.summary)||x.requestId!==null&&!/^[a-f0-9]{4,8}…(?:-[A-Z]{3})?$/.test(x.requestId))||
  r.routing!==undefined&&(!r.routing?.expected||!r.routing?.observed||!Object.hasOwn(routeExpected,r.routing.expected.state)||!Object.hasOwn(routeObserved,r.routing.observed.state)||!safeText(r.routing.expected.summary)||!safeText(r.routing.observed.summary)))throw Error('NETWORK_CONTEXTS_INVALID');
 if(v.additionalContexts!==undefined){
  if(!Array.isArray(v.additionalContexts)||v.additionalContexts.length!==2)throw Error('NETWORK_CONTEXTS_INVALID');
  for(const [i,r]of v.additionalContexts.entries())if(!r||r.id!==['development-codex','magpie-gateway'][i]||!safeText(r.title,80)||!safeText(r.runtime,160)||!r.connection||!r.path||!r.service||!Object.hasOwn(observed,r.connection.state)||!Object.hasOwn(paths,r.path.state)||!Object.hasOwn(services,r.service.state)||![r.connection.summary,r.path.summary,r.service.summary].every(x=>safeText(x))||!Array.isArray(r.evidence)||r.evidence.length!==0||
   r.routing!==undefined&&(!r.routing?.expected||!r.routing?.observed||!Object.hasOwn(routeExpected,r.routing.expected.state)||!Object.hasOwn(routeObserved,r.routing.observed.state)||!safeText(r.routing.expected.summary)||!safeText(r.routing.observed.summary)))throw Error('NETWORK_CONTEXTS_INVALID');
 }
 for(const row of [...v.contexts,...v.additionalContexts??[]])if(row.stability!==undefined&&(row.stability.state!=='NOT_TESTED'||!safeText(row.stability.summary)))throw Error('NETWORK_CONTEXTS_INVALID');
 const h=v.localProxyHealth;
 if(v.configurationFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(v.configurationFingerprint)||h?.endpointFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(h.endpointFingerprint))throw Error('NETWORK_CONTEXTS_INVALID');
   if(h!==undefined&&(h.schema!=='dream-maker.local-proxy-health.v1'||h.scope!=='LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP'||!timestamp(h.startedAt)||!timestamp(h.completedAt)||Date.parse(h.completedAt)<Date.parse(h.startedAt)||!['SHORT_WINDOW_OK','INTERRUPTED'].includes(h.state)||!/^((127\.0\.0\.1)|(localhost)|(\[::1\])):[1-9][0-9]{0,4}$/.test(h.address)||!['READABLE','UNAVAILABLE'].includes(h.controller)||!Array.isArray(h.samples)||h.samples.length!==6||h.samples.some(s=>!timestamp(s.at)||!['CONNECTED','REFUSED','RESET','TIMEOUT','UNAVAILABLE'].includes(s.state)||!Number.isSafeInteger(s.elapsedMs)||s.elapsedMs<0||s.elapsedMs>60000)||h.websocket!=='NOT_TESTED'||h.modelCalls!==0||h.oauthAttempts!==0||h.networkSettingsChanged!==false||
    !validTlsProbe(h.openAiTls,'api.openai.com:443')||h.codexTls!==undefined&&!validTlsProbe(h.codexTls,'chatgpt.com:443')||
    h.codexControlTlsProbes!==undefined&&(!Array.isArray(h.codexControlTlsProbes)||h.codexControlTlsProbes.length!==CODEX_CONTROL_TARGET_HOSTS.length||h.codexControlTlsProbes.some((probe,index)=>!validTlsProbe(probe,`${CODEX_CONTROL_TARGET_HOSTS[index]}:443`)))||
    h.deepSeekTls!==undefined&&!validTlsProbe(h.deepSeekTls,'api.deepseek.com:443')||
   h.state==='SHORT_WINDOW_OK'&&(h.controller!=='READABLE'||h.samples.some(s=>s.state!=='CONNECTED'))))throw Error('NETWORK_CONTEXTS_INVALID');
 return structuredClone(v);
}
interface PanelState {
  networkContexts?:NetworkContextsSnapshot;
  networkLoading?:boolean;
  networkTesting?:boolean;
  networkError?:string;
  codexMetadata?:CodexMetadataObservation;
  codexMetadataLoading?:boolean;
  codexMetadataError?:string;
}
const time=(at:string)=>`<time datetime="${e(at)}">${e(new Date(at).toLocaleString('zh-CN',{hour12:false}))}</time>`;
const tlsState:Record<OpenAiTlsProbe['state'],string>={
 NOT_TESTED:'尚未检查',TLS_HANDSHAKE_COMPLETED:'CONNECT/TLS 已建立，未发送 HTTP',CONNECT_REJECTED:'本地代理拒绝 CONNECT',
 TLS_FAILED:'TLS 握手失败',TIMEOUT:'连接超时',CANCELLED:'检查已取消',FAILED:'检查失败'
};
const codexControlLabel=(target:string):string=>{
 if(target==='ws.chatgpt.com:443')return 'Codex WebSocket 控制域 TLS';
 if(target==='codex-cloud-backend.chatgpt.com:443')return 'Codex 云端后端 TLS';
 if(target==='codex-cloud-environments.chatgpt.com:443')return 'Codex 云端环境 TLS';
 return 'Codex 官方控制通道 TLS';
};
const tlsLine=(label:string,probe:OpenAiTlsProbe):string=>`<p><strong>${e(label)}：${e(tlsState[probe.state])}</strong> · <code>${e(probe.state)}</code> · ${e(probe.target)} · ${probe.elapsedMs===null?'耗时未取得':e(String(probe.elapsedMs))+' ms'} · ${probe.authorized?'证书校验通过':'证书未验证'}${probe.errorClass?` · 错误分类：<code>${e(probe.errorClass)}</code>`:''}</p><p>${probe.selectedNode?`连接关联节点：${e(probe.selectedNode)}；${probe.selectionMatchesExpected===null?'无法比较':probe.selectionMatchesExpected?'与 DM 期望节点一致':'与 DM 期望节点不一致，未自动切换'}。`:'未取得此 TLS 连接的实际节点关联，不能把控制器当前节点当作本次请求节点。'}</p>`;
const listenerLabel:Record<NonNullable<NetworkContextsSnapshot['controller']['proxyListener']>['state'],string>={
 LOOPBACK_ONLY:'仅本机回环监听',NON_LOOPBACK:'包含通配或其他非回环地址',MIXED:'同时包含回环与非回环地址',UNAVAILABLE:'未取得监听信息'
};
const listenerBinding=(value:'LOOPBACK'|'WILDCARD'|'OTHER'):string=>value==='LOOPBACK'?'本机回环':value==='WILDCARD'?'通配地址':'其他非回环地址';
const wslProxyLabel:Record<NonNullable<NetworkContextsSnapshot['wslProxyReachability']>['state'],string>={
 NOT_TESTED:'尚未检查',TCP_REACHABLE_ONLY:'仅 TCP 可达',CONNECTION_REFUSED:'连接被拒绝',TIMEOUT:'连接超时',UNREACHABLE:'不可达或未取得默认路由'
};
const wslTlsLabel:Record<NonNullable<NetworkContextsSnapshot['wslProxyTls']>[number]['state'],string>={
 NOT_TESTED:'尚未检查',CONNECT_AND_TLS_COMPLETED:'CONNECT 与 TLS 已完成',PROXY_CONNECT_REJECTED:'CFW 拒绝 CONNECT',
 TLS_HANDSHAKE_FAILED:'TLS 校验失败',TIMEOUT:'连接超时',UNREACHABLE:'代理路径不可达'
};
const wslTlsTarget=(target:'api.openai.com'|'chatgpt.com'):string=>target==='api.openai.com'?'WSL 到 OpenAI API':'WSL 到 Codex 登录域';
const codexMetadataRouteEnglish:Record<CodexMetadataObservation['route']['state'],string>={
 CFW_LEASE_BOUND_CHILD_ENVIRONMENT:'CFW 租约约束的 Windows 子进程',
 DM_ROUTE_DISABLED:'DM 受控路由未启用',
 UNMANAGED_ENV_PRESENT:'发现未受控代理环境'
};
const codexMetadataUsageEnglish:Record<CodexMetadataObservation['usage']['state'],string>={
 ALLOWED:'普通使用许可未显示受限',
 RESTRICTED:'普通使用许可受限',
 UNKNOWN:'普通使用许可未知'
};
const codexMetadataGateEnglish:Record<CodexMetadataObservation['dispatchGate']['state'],string>={
 BLOCKED_BY_USAGE:'账户元数据阻止普通派发',
 BLOCKED_BY_MODEL:'模型目录阻止派发',
 NOT_BLOCKED_BY_METADATA:'元数据未发现阻止项',
 UNKNOWN:'派发条件未知'
};
type TransportState='PASS'|'OBSERVED'|'NOT_VERIFIED'|'NOT_RUN'|'BLOCKED_BY_USAGE'|'POLICY_BLOCKED'|'FAILED'|'UNAVAILABLE';
const transportStateLabel:Record<TransportState,string>={
 PASS:'已取得该项独立证据',OBSERVED:'已观察，仍不能升级',NOT_VERIFIED:'尚未核验',NOT_RUN:'本轮未运行',
 BLOCKED_BY_USAGE:'账户普通使用受限',POLICY_BLOCKED:'地区或政策拒绝',FAILED:'失败',UNAVAILABLE:'当前不可用'
};
function transportMatrix(v:PanelState):Array<{id:string;title:string;state:TransportState;summary:string}>{
 const s=v.networkContexts,m=v.codexMetadata,health=s?.localProxyHealth;
 const path=s?.latestCodexRequest?.path;
 const roleState=(role:'planner2'|'reviewer'):{state:TransportState;summary:string}=>{
  if(m?.dispatchGate.state==='BLOCKED_BY_USAGE')return{state:'BLOCKED_BY_USAGE',summary:'账户元数据明确阻止新的普通模型回合；没有用其他角色或网络成功替代。'};
  if(m?.dispatchGate.state==='BLOCKED_BY_MODEL')return{state:'FAILED',summary:'当前账户模型目录阻止派发；未切换模型或账户。'};
  const request=s?.latestCodexRequest;
  if(request?.role===role&&request.path==='REQUEST_ROUTE_VERIFIED'&&request.classification==='INFERENCE_COMPLETED')
   return{state:'PASS',summary:'找到该角色的一次请求级路径和推理完成历史；不代表另一角色或未来回合通过。'};
  return{state:'NOT_VERIFIED',summary:'没有该独立会话的当前真实回合证据；初始化、登录缓存或网络可达不能替代。'};
 };
 const magpie=s?.additionalContexts?.find(row=>row.id==='magpie-gateway')?.routing?.observed.state==='REQUEST_ROUTE_VERIFIED';
 return[
  {id:'CFW_LOCAL_CONTROLLER',title:'CFW 本地控制器',state:s?.controller.state==='OBSERVED'?'PASS':s?'UNAVAILABLE':'NOT_VERIFIED',summary:s?.controller.state==='OBSERVED'?'已读取现有 CFW 控制器与节点目录；没有修改选择器。':'尚未取得当前控制器元数据。'},
  {id:'CFW_NODE_CHAIN',title:'CFW 节点连接链',state:health&&[health.openAiTls,health.codexTls,health.deepSeekTls].filter(Boolean).some(probe=>probe?.state==='TLS_HANDSHAKE_COMPLETED'&&probe.nodeChainMatched&&probe.selectionMatchesExpected!==false)?'PASS':'NOT_VERIFIED',summary:'仅当 CONNECT/TLS 与该次实际节点链唯一关联时才记为通过；TLS 可达不等于账户资格。'},
  {id:'WINDOWS_CODEX_TRANSPORT',title:'Windows Codex 传输',state:path==='REQUEST_ROUTE_VERIFIED'?'PASS':path==='DIRECT_ROUTE_OBSERVED'?'FAILED':'NOT_VERIFIED',summary:path==='REQUEST_ROUTE_VERIFIED'?'最近一次 DM 管理的 Windows Codex 请求已关联到 CFW 回环端口和实际节点。':path==='DIRECT_ROUTE_OBSERVED'?'观察到绕过预期 CFW 路径的直连，不能作为受控传输证据。':'尚无 DM 管理的 Windows Codex 请求级路径证据。'},
  {id:'WINDOWS_CODEX_PLANNER2',title:'Windows Codex Planner',...roleState('planner2')},
  {id:'WINDOWS_CODEX_REVIEWER',title:'Windows Codex Reviewer',...roleState('reviewer')},
  {id:'OPENAI_API_TRANSPORT',title:'OpenAI API 传输',state:health?.openAiTls.state==='TLS_HANDSHAKE_COMPLETED'?'PASS':'NOT_VERIFIED',summary:'只验证 DM 到 api.openai.com:443 的 CONNECT/TLS；没有向源站发送认证头或推理。'},
  {id:'OPENAI_SERVICE_ELIGIBILITY',title:'OpenAI 服务资格',state:m?.serviceEligibility.state==='USAGE_RESTRICTED'?'BLOCKED_BY_USAGE':s?.openAi.serviceEligibility.state==='POLICY_BLOCKED'?'POLICY_BLOCKED':s?.openAi.serviceEligibility.state==='ELIGIBLE'?'PASS':'NOT_VERIFIED',summary:m?.serviceEligibility.summary??s?.openAi.serviceEligibility.summary??'账户、地区、模型权限和服务资格尚未核验。'},
  {id:'OPENAI_INFERENCE',title:'OpenAI 真实推理',state:s?.openAi.inference.state==='COMPLETED'?'PASS':s?.openAi.inference.state==='FAILED'?'FAILED':'NOT_RUN',summary:m?.inference.summary??s?.openAi.inference.summary??'本轮没有发送 OpenAI 模型推理。'},
  {id:'DSH_EXTERNAL_TRANSPORT',title:'DSH 外部传输',state:s?.latestDeepSeekRoutedRequest?.role==='executor'?'PASS':'NOT_VERIFIED',summary:'只有 DSH 本地工具进程对应的 Windows 模型网关外部请求具备 Executor 角色和 CFW 节点关联时才通过。'},
  {id:'MAGPIE_EXTERNAL_TRANSPORT',title:'Magpie 外部传输',state:magpie?'PASS':'NOT_VERIFIED',summary:'本地控制通道保持回环直连；只有 DM 专属 Magpie 的外部提供商请求取得实际节点关联时才通过。'},
  {id:'KIMI_EXTERNAL_TRANSPORT',title:'Kimi 外部传输',state:'NOT_VERIFIED',summary:'Kimi 本地控制通道保持回环直连；WSL 外部请求需要当前私有网关子环境证据和实际请求级关联，环境变量存在本身不算通过。'},
  {id:'DREAMMAKER_FOUR_ROLE_LIVE',title:'Dream Maker 四角色真实联动',state:'NOT_VERIFIED',summary:'仅当 P1、P2、DSH、Reviewer 同一真实项目均完成并保留独立身份、费用、验证和审查证据时才通过。网络、登录或单角色成功不能替代。'}
 ];
}
const codexMetadataSection=(m:CodexMetadataObservation):string=>`<section class="notice" data-key="codex-metadata"><h3>Codex 账户与套餐（只读元数据）</h3>
 <p><strong>${m.account.state==='OBSERVED'?'已读取当前 Codex 账户元数据':'未读取到账户'}</strong> · ${time(m.observedAt)} · ${m.currentConfiguration?'仍是当前网络设置':'网络设置或节点已变化，结果已过期'}</p>
 <dl>
  <dt>连接租约</dt><dd>${e(codexMetadataRouteEnglish[m.route.state])}${m.controller?.selectedNode?` · 当前节点 ${e(m.controller.selectedNode)}`:''}</dd>
  <dt>账户认证</dt><dd>${m.account.state==='OBSERVED'?`已观察账户类型 ${e(m.account.type)}；只证明元数据读取成功，不是模型资格`:e('未取得账户')}</dd>
  <dt>模型目录</dt><dd>${m.model.listed===null?'未取得目录结论':m.model.listed?'当前配置模型在目录中':'当前配置模型不在目录中'}${m.model.catalogComplete?' · 目录已完整返回':' · 目录未确认完整'}</dd>
  <dt>普通使用许可</dt><dd>${e(codexMetadataUsageEnglish[m.usage.state])}${m.usage.ordinaryUsageAllowed===null?'':' · ordinaryUsageAllowed='+e(String(m.usage.ordinaryUsageAllowed))}</dd>
  <dt>服务资格</dt><dd>${e(m.serviceEligibility.state)} · ${e(m.serviceEligibility.summary)}</dd>
  <dt>最近模型推理</dt><dd><strong>${e(m.inference.state)}</strong> · ${e(m.inference.summary)}</dd>
  <dt>是否允许派发</dt><dd><strong>${e(codexMetadataGateEnglish[m.dispatchGate.state])}</strong> · ${e(m.dispatchGate.summary)}</dd>
 </dl>
 ${m.errors.length?`<details><summary>脱敏元数据错误 · ${m.errors.length} 项</summary><ul>${m.errors.map(error=>`<li>${e(error.method)} · ${e(error.code)} · ${e(error.category)}</li>`).join('')}</ul></details>`:''}
 <p>本次只调用 initialize、account/read、model/list 和 account/rateLimits/read；没有创建 thread/turn、没有 OAuth、没有读取认证文件，也没有发起模型推理。网络可达、账户可读取、服务资格和推理完成仍是四个独立结论。</p>
 </section>`;
export function networkContextsPanel(v:PanelState):string{
 const s=v.networkContexts;
 return `<section class="card network-contexts" aria-labelledby="network-contexts-title" data-key="network-contexts"><h2 id="network-contexts-title">连接状态与路径证据</h2>
 <p>分别查看开发 Codex、浏览器、WSL 登录、产品 Codex、DSH 和专属 Magpie。配置、路径、稳定性和服务资格独立判断；不会登录、调用模型或修改网络。</p>
 <div class="actions"><button type="button" data-action="network-read" ${v.networkLoading?'disabled':''}>读取本机状态</button><button type="button" data-action="network-test" ${v.networkLoading?'disabled':''}>${v.networkTesting?'正在短测本地连接…':'短测本地连接（不调用模型）'}</button><button type="button" data-action="codex-metadata-read" ${v.codexMetadataLoading?'disabled':''}>${v.codexMetadataLoading?'正在读取账户元数据…':'核对 Codex 账户与套餐（不发推理）'}</button></div>
 <p role="status" aria-live="polite">${v.networkError?e(v.networkError):v.networkLoading?(v.networkTesting?'正在检查本机到已有代理及模型目标域的 TCP/TLS（OpenAI API、ChatGPT 登录域与 DeepSeek Executor API 分别核验），通常约需半分钟；不发送 HTTP、认证头或模型请求。':'正在读取本机信息；没有发起外部网络探测。'):s?'读取完成，真实网络路径仍须分别核验。':'尚未读取本机状态。'}</p>
 <p role="status" aria-live="polite">${v.codexMetadataError?e(v.codexMetadataError):v.codexMetadataLoading?'正在读取已有的专用 Codex 账户/套餐元数据；不登录、不创建模型回合。':v.codexMetadata?'账户元数据已取得；请分别查看认证、资格和推理状态。':'尚未核对 Codex 账户与套餐元数据。'}</p>
 ${v.codexMetadata&&!v.codexMetadataError?codexMetadataSection(v.codexMetadata):''}
 <section class="notice" data-key="transport-matrix"><h3>网络、资格与真实运行状态清单</h3><p>以下项目始终分开记录。任何一项通过都不会自动升级其他项目。</p><dl>${transportMatrix(v).map(row=>`<dt data-transport="${e(row.id)}">${e(row.title)}</dt><dd><strong>${e(transportStateLabel[row.state])}</strong><p>${e(row.summary)}</p><details><summary>高级诊断标识</summary><code>${e(row.id)}: ${e(row.state)}</code></details></dd>`).join('')}</dl><p>网络可达 ≠ 认证成功 ≠ 服务资格通过 ≠ 模型调用成功；TLS、HTTP 200、登录缓存或节点变化都不能替代真实推理。</p></section>
 ${s?`${s.currentConfiguration?'':'<p class="notice">设置已变化，以下来自旧设置；请重新读取，不能作为新设置的证明。</p>'}
 <p>记录时间：${time(s.observedAt)}。15 秒内重复读取会保留同一次记录时间。</p>
 <p>已有网络控制器：${s.controller.state==='OBSERVED'?'可读取':'未取得信息'}；DM 网络接入：${s.controller.dmRoutingEnabled?(s.controller.selectionPolicy==='current'?'跟随当前选择，路径仍待核验':'固定节点模式，路径仍待核验'):'未开启'}。</p>
 <p>CFW 选择器：${s.controller.configuredSelector?e(s.controller.configuredSelector):'未配置选择器'}；当前选择：${s.controller.selectedNode?e(s.controller.selectedNode):'未取得'}；${s.controller.selectionPolicy==='current'?'DM 使用你此刻选择的节点，不会自动切换':`固定节点：${s.controller.configuredNode?e(s.controller.configuredNode):'未配置'}；${s.controller.selectionMatchesExpected===null?'无法比较':s.controller.selectionMatchesExpected?'与 DM 固定配置一致':'与 DM 固定配置不一致，未自动切换'}`}。</p>
 ${s.controller.proxyListener?`<p data-key="cfw-proxy-listener"><strong>CFW 代理监听：${e(listenerLabel[s.controller.proxyListener.state])}</strong>${s.controller.proxyListener.mixedPort?` · 端口 ${e(String(s.controller.proxyListener.mixedPort))}`:''}${s.controller.proxyListener.bindings.length?` · ${e(s.controller.proxyListener.bindings.map(listenerBinding).join('、'))}`:''}。${s.controller.proxyListener.ownerMatchesController===true?'控制器与代理监听由同一 CFW 进程持有。':s.controller.proxyListener.ownerMatchesController===false?'控制器与代理监听未确认由同一进程持有，不能当作完整 CFW 路径。':'监听所有权尚未确认。'}${s.controller.proxyListener.allowLan===true||s.controller.proxyListener.bindings.includes('WILDCARD')?' 共享 CFW 已配置允许局域网或使用通配地址；DM 不会修改它，也不代表外部主机一定能够访问。':' 未发现通配监听。'}${s.controller.proxyListener.bindAddress!==null?` 配置绑定地址为 ${e(s.controller.proxyListener.bindAddress)}。`:''}</p>`:''}
 ${s.wslProxyReachability?`<p data-key="wsl-proxy-reachability"><strong>WSL 到 Windows CFW：${e(wslProxyLabel[s.wslProxyReachability.state])}</strong>${s.wslProxyReachability.gateway&&s.wslProxyReachability.port?` · ${e(s.wslProxyReachability.gateway)}:${e(String(s.wslProxyReachability.port))}`:''}${s.wslProxyReachability.elapsedMs!==null?` · ${e(String(s.wslProxyReachability.elapsedMs))} ms`:''}。${s.wslProxyReachability.state==='TCP_REACHABLE_ONLY'?'这里只完成了一次不含数据的 TCP 连接，没有发送 HTTP、开始 TLS 或调用模型；它不能证明 WSL Codex 实际使用了该代理，也不能证明账户或服务地区资格。':'没有取得可用的 WSL 到 Windows 代理 TCP 证据。'}</p>`:''}
 ${s.wslProxyTls?.length?`<section class="notice" data-key="wsl-proxy-tls"><h3>专用 WSL 经现有 CFW 的 OpenAI 目标检查</h3>${s.wslProxyTls.map(value=>`<p data-key="wsl-proxy-tls-${e(value.targetHost)}"><strong>${e(wslTlsTarget(value.targetHost))}：${e(wslTlsLabel[value.state])}</strong>${value.protocol?` · ${e(value.protocol)}`:''}${value.elapsedMs!==null?` · ${e(String(value.elapsedMs))} ms`:''}${value.errorClass?` · 错误分类：<code>${e(value.errorClass)}</code>`:''}。${value.state==='CONNECT_AND_TLS_COMPLETED'?(value.selectedNode?`CFW 唯一关联到节点“${e(value.selectedNode)}”${value.selectionMatchesExpected===null?'，但 DM 当前选择未知':value.selectionMatchesExpected?'，与用户当前选择一致':'，与用户当前选择不一致，未自动切换'}；连接链 ${value.chains.length?e(value.chains.join(' → ')):'未取得'}。`:'TLS 已完成，但没有取得这次诊断连接到 CFW 当前节点的唯一关联；不能把控制器当前节点当作实际路径。'):'没有完成可关联的代理 CONNECT/TLS 检查。'}</p>`).join('')}<p>这些是 DM 专用诊断进程的一次性证据：固定目标、仅发送代理 CONNECT、没有向目标发送源站 HTTP、认证头或模型请求。它能证明此 WSL 网络命名空间到 CFW 及目标 TLS 的能力，不能替代 WSL Codex 实际进程的环境、请求日志、账户资格或推理结果。</p></section>`:''}
 <section class="notice" data-key="openai-status"><h3>OpenAI 四项独立状态</h3><dl>
 <dt>网络可达</dt><dd>${e(s.openAi.networkReachability.state)}<p>${e(s.openAi.networkReachability.summary)}</p></dd>
 <dt>认证成功</dt><dd>${e(s.openAi.authentication.state)}<p>${e(s.openAi.authentication.summary)}</p></dd>
 <dt>服务资格</dt><dd>${e(s.openAi.serviceEligibility.state)}<p>${e(s.openAi.serviceEligibility.summary)}</p></dd>
 <dt>最近推理</dt><dd>${e(s.openAi.inference.state)}<p>${e(s.openAi.inference.summary)}</p></dd></dl></section>
 ${s.latestRoutedRequest?`<section class="notice" data-key="latest-routed-request"><h3>最近一次受控外部请求</h3><p><strong>${s.latestRoutedRequest.role?`${e(roleLabel(s.latestRoutedRequest.role))} · `:''}${e(s.latestRoutedRequest.method)} ${e(s.latestRoutedRequest.targetHost)}</strong></p><dl><dt>运行角色</dt><dd>${s.latestRoutedRequest.role?e(roleLabel(s.latestRoutedRequest.role)):'未标注；不借用其他角色身份'}</dd><dt>开始时间</dt><dd>${time(s.latestRoutedRequest.startedAt)}</dd><dt>结束时间</dt><dd>${time(s.latestRoutedRequest.completedAt)}</dd><dt>实际关联节点</dt><dd>${e(s.latestRoutedRequest.selectedNode||'未取得')}</dd><dt>HTTP 状态</dt><dd>${s.latestRoutedRequest.httpStatus===null?'未收到响应':e(String(s.latestRoutedRequest.httpStatus))}</dd><dt>分类</dt><dd>${e(s.latestRoutedRequest.classification)}</dd><dt>耗时</dt><dd>${e(String(s.latestRoutedRequest.elapsedMs))} ms</dd><dt>自动重试</dt><dd>${s.latestRoutedRequest.automaticRetryAllowed?'仅可在确认请求无副作用后重试':'禁止自动重试'}</dd></dl>${s.latestRoutedRequest.requestIdSha256?`<p>请求编号摘要：<code>${e(s.latestRoutedRequest.requestIdSha256.slice(0,16))}…</code></p>`:''}</section>`:''}
  ${s.latestCodexRequest?`<section class="notice" data-key="latest-codex-request"><h3>最近一次 Codex app-server 请求路径</h3><p><strong>${e(roleLabel(s.latestCodexRequest.role))} · turn/start · ${e(s.latestCodexRequest.targetHost??'目标未取得')}</strong></p><dl><dt>路径核验</dt><dd>${e(s.latestCodexRequest.path)}</dd><dt>开始时间</dt><dd>${time(s.latestCodexRequest.startedAt)}</dd><dt>结束时间</dt><dd>${time(s.latestCodexRequest.completedAt)}</dd><dt>进程 PID</dt><dd>${s.latestCodexRequest.processPid===null?'未取得':e(String(s.latestCodexRequest.processPid))}</dd><dt>进程启动身份摘要</dt><dd>${s.latestCodexRequest.processIdentitySha256?`<code>${e(s.latestCodexRequest.processIdentitySha256.slice(0,16))}…</code>`:'未取得'}</dd><dt>实际 CFW 节点</dt><dd>${e(s.latestCodexRequest.selectedNode??'未取得')}</dd><dt>连接链</dt><dd>${s.latestCodexRequest.chains.length?e(s.latestCodexRequest.chains.join(' → ')):'未取得'}</dd><dt>观察到控制通道主机</dt><dd>${(()=>{const hosts=codexHosts(s.latestCodexRequest!);return hosts.length?e(hosts.join('、')):'未取得';})()} · ${e(String(codexSourcePortCount(s.latestCodexRequest)))} 个源端口摘要</dd><dt>分类</dt><dd>${e(s.latestCodexRequest.classification)}</dd><dt>HTTP 状态</dt><dd>${s.latestCodexRequest.httpStatus===null?'应用协议未提供可核验的原始状态码':e(String(s.latestCodexRequest.httpStatus))}</dd><dt>自动重试</dt><dd>禁止自动重试；地区政策拒绝不会通过换节点规避</dd></dl>${s.latestCodexRequest.path==='DIRECT_ROUTE_OBSERVED'?'<p class="notice" role="alert"><strong>检测到绕过 CFW 的直连。</strong> 这次请求不能作为受控网络路径证据；DM 不会把本地代理可达、账户缓存或这次结果混为同一条路径。</p>':''}<p>进程归属由根进程启动身份及最多 64 个已核验后代进程共同确定；不会把父进程、同名 PID 或未归属连接当成路径证据。</p><p>这是请求级历史记录。即使路径已核验，也只有在分类为 INFERENCE_COMPLETED 时才表示该次模型回合完成；不会把网络可达、登录缓存或 PID 存在当成账户资格。观察到控制通道主机不证明 WebSocket 会话认证或持续稳定。</p>${s.latestCodexRequest.requestIdSha256?`<p>回合编号摘要（不是 HTTP 请求 ID）：<code>${e(s.latestCodexRequest.requestIdSha256.slice(0,16))}…</code></p>`:''}</section>`:''}
   ${s.localProxyHealth?`<section class="notice" data-key="local-proxy-health"><h3>本地连接短测</h3><p><strong>${s.localProxyHealth.state==='SHORT_WINDOW_OK'?'这个短窗口内，本地代理连接可达':'短测发现本地代理连接问题'}</strong> · ${e(s.localProxyHealth.address)}</p><p>完成时间：${time(s.localProxyHealth.completedAt)}。六次 TCP 连接中 ${s.localProxyHealth.samples.filter(x=>x.state==='CONNECTED').length} 次接通；控制器${s.localProxyHealth.controller==='READABLE'?'可读取':'未读取完整'}。</p>${tlsLine('OpenAI API TLS',s.localProxyHealth.openAiTls)}${s.localProxyHealth.codexTls?tlsLine('ChatGPT 登录域 TLS',s.localProxyHealth.codexTls):'<p><strong>ChatGPT 登录域 TLS：旧记录未包含独立检查</strong> · 请重新短测，不能拿 OpenAI API 的结果代替。</p>'}${s.localProxyHealth.codexControlTlsProbes?`${s.localProxyHealth.codexControlTlsProbes.map(probe=>tlsLine(codexControlLabel(probe.target),probe)).join('')}<p><strong>WebSocket 会话仍未测试</strong> · 上述检查仅验证 CONNECT/TLS 和节点链；不证明 WebSocket 会话认证或持续稳定。</p>`:'<p><strong>Codex 官方控制通道 TLS：旧记录未包含检查</strong> · 请重新短测；不能用普通 Codex 或 OpenAI API TLS 结果代替。</p>'}${s.localProxyHealth.deepSeekTls?tlsLine('DeepSeek Executor API TLS',s.localProxyHealth.deepSeekTls):'<p><strong>DeepSeek Executor API TLS：旧记录未包含独立检查</strong> · 请重新短测，不能用 OpenAI 结果代替。</p>'}<p>仅完成 CONNECT/TLS 或不含 HTTP 的无副作用检查，没有发送认证头或模型请求。TCP/TLS 可达不等于账户认证、服务资格或模型调用成功；没有核验各 Agent 的长连接和 WebSocket，有写入的任务不能盲目重跑。</p></section>`:''}
 <div class="network-context-list">${[...s.contexts,...s.additionalContexts??[]].map(row=>`<article class="network-context-row" data-key="network-${e(row.id)}"><h3>${e(row.title)}</h3><p class="muted">${e(row.runtime)}</p><dl>
 <dt>本机观察</dt><dd><strong>${e(observed[row.connection.state])}</strong><p>${e(row.connection.summary)}</p></dd>
 <dt>请求路径</dt><dd><strong>${e(paths[row.path.state])}</strong><p>${e(row.path.summary)}</p></dd>
 ${row.routing?`<dt>预期连接</dt><dd><strong>${e(routeExpected[row.routing.expected.state])}</strong><p>${e(row.routing.expected.summary)}</p></dd><dt>已观察连接</dt><dd><strong>${e(routeObserved[row.routing.observed.state])}</strong><p>${e(row.routing.observed.summary)}</p></dd>`:''}
 <dt>稳定性</dt><dd><strong>尚未核验此进程的持续连接</strong><p>${e(row.stability?.summary??'本地配置或短时可达不能证明长期稳定。')}</p></dd>
 <dt>服务资格</dt><dd><strong>${e(services[row.service.state])}</strong><p>${e(row.service.summary)}</p></dd></dl>
 <p class="hint"><strong>最近问题：</strong>${row.evidence.some(item=>item.kind==='LOGIN_REJECTION')?'已保存登录拒绝记录；请展开查看时间及原因，当前资格仍未确认。':'尚无可归属于此环境的故障记录；不根据其他程序的报错推断。'}</p>
 ${row.evidence.length?`<details><summary>查看脱敏记录 · ${row.evidence.length} 项</summary><ul>${row.evidence.map(item=>`<li>${item.at?time(item.at):'时间未确认'} · ${e(item.summary)}${item.requestId?`<br>请求编号（已缩略）：${e(item.requestId)}`:''}</li>`).join('')}</ul></details>`:'<p class="hint">尚无可归属于此环境的请求记录；没有借用其他角色的成功。</p>'}</article>`).join('')}</div>
 <details><summary>账户缓存与登录处理</summary><p>${s.account.state==='CACHED_UNVERIFIED'?'发现专用 ChatGPT 账户缓存；未确认当前账户、套餐或模型资格。':'没有取得可核验的专用账户信息。'}</p>${s.account.fingerprint?`<p>本机匿名指纹：<code>${e(s.account.fingerprint)}</code></p>`:''}<p>没有新的合法服务条件时，保持登录暂停。切换 Clash 节点或代理不能改变账户或地区服务资格，也不会被当作恢复 403 的证据；地区或账户政策拒绝需要官方核查。这里不会提供自动切换地区或自动重试操作。</p></details>`:''}</section>`;
}

export { readCodexMetadataObservation };
