export const NETWORK_CONTEXT_IDS=['windows-browser','wsl-codex-login','codex-app-server','dsh-executor'] as const;
export const ADDITIONAL_NETWORK_CONTEXT_IDS=['development-codex','magpie-gateway'] as const;
export type NetworkContextId=typeof NETWORK_CONTEXT_IDS[number]|typeof ADDITIONAL_NETWORK_CONTEXT_IDS[number];
export type NetworkObservationState='OBSERVED'|'NOT_RUNNING'|'UNAVAILABLE'|'NOT_CHECKED';
export type NetworkPathState='NOT_VERIFIED'|'CONFIGURED_ONLY'|'SCOPE_BLOCKED'|'HISTORICAL_RESPONSE';
export type NetworkServiceState='NOT_VERIFIED'|'POLICY_BLOCKED'|'UNVERIFIED_HISTORY';
export interface NetworkEvidenceItem {kind:'LOCAL_METADATA'|'LOGIN_REJECTION'|'STORED_HISTORY'|'CODEX_START_EVENT';at:string|null;summary:string;requestId:string|null}
export interface NetworkContextRow {
 id:NetworkContextId;title:string;runtime:string;
 connection:{state:NetworkObservationState;summary:string};path:{state:NetworkPathState;summary:string};
 service:{state:NetworkServiceState;summary:string};evidence:NetworkEvidenceItem[];
 stability?:{state:'NOT_TESTED';summary:string};
 routing?:{
  expected:{state:'DM_ROUTE_DISABLED'|'CONTROLLED_PROXY_EXPECTED'|'EXTERNAL_OR_UNMANAGED'|'WSL_SCOPE_BLOCKED';summary:string};
  observed:{state:'NOT_VERIFIED'|'CHILD_ENV_VERIFIED'|'PROCESS_EXISTS_ONLY'|'REQUEST_ROUTE_VERIFIED';summary:string};
 };
}
export interface OpenAiStatus {
 networkReachability:{state:'NOT_TESTED'|'TCP_REACHABLE_ONLY'|'TLS_REACHABLE'|'UNREACHABLE';summary:string};
 authentication:{state:'NOT_VERIFIED'|'AUTHENTICATED'|'FAILED';summary:string};
 serviceEligibility:{state:'NOT_VERIFIED'|'ELIGIBLE'|'POLICY_BLOCKED';summary:string};
 inference:{state:'NOT_RUN'|'FAILED'|'COMPLETED';summary:string};
}
export interface OpenAiTlsProbe {
 state:'NOT_TESTED'|'TLS_HANDSHAKE_COMPLETED'|'CONNECT_REJECTED'|'TLS_FAILED'|'TIMEOUT'|'CANCELLED'|'FAILED';
  target:
   'api.openai.com:443'|
   'chatgpt.com:443'|
   'api.deepseek.com:443'|
   'ws.chatgpt.com:443'|
   'codex-cloud-backend.chatgpt.com:443'|
   'codex-cloud-environments.chatgpt.com:443';
 protocol:string|null;authorized:boolean;alpn:string|null;elapsedMs:number|null;
 selectedNode:string|null;selectionMatchesExpected:boolean|null;nodeChainMatched:boolean;
 errorClass:string|null;httpRequestSent:false;modelCalls:0;
}
export type ProxyListenerBinding='LOOPBACK'|'WILDCARD'|'OTHER';
export interface ProxyListenerObservation {
 state:'LOOPBACK_ONLY'|'NON_LOOPBACK'|'MIXED'|'UNAVAILABLE';
 mixedPort:number|null;
 bindings:ProxyListenerBinding[];
 ownerMatchesController:boolean|null;
 allowLan:boolean|null;
 bindAddress:string|null;
}
/** A bounded TCP-only observation from the dedicated WSL NAT namespace.
 * Success never proves proxy use, CONNECT/TLS, account eligibility or inference. */
export interface WslProxyReachability {
 schema:'dream-maker.wsl-proxy-reachability.v1';
 state:'NOT_TESTED'|'TCP_REACHABLE_ONLY'|'CONNECTION_REFUSED'|'TIMEOUT'|'UNREACHABLE';
 gateway:string|null;
 port:number|null;
 elapsedMs:number|null;
 routeSource:'WSL_DEFAULT_ROUTE';
 networkPayloadBytes:0;
 httpRequests:0;
 tlsHandshakes:0;
 modelCalls:0;
 filesWritten:0;
}
export type WslProxyTlsTargetHost='api.openai.com'|'chatgpt.com';
/** A dedicated diagnostic helper, not a WSL Codex request. The source address
 * and ephemeral port are used for CFW correlation and replaced by a hash before
 * reaching the HTTP/UI projection. */
export interface WslProxyTlsObservation {
 schema:'dream-maker.wsl-proxy-tls-observation.v1';
 state:'NOT_TESTED'|'CONNECT_AND_TLS_COMPLETED'|'PROXY_CONNECT_REJECTED'|'TLS_HANDSHAKE_FAILED'|'TIMEOUT'|'UNREACHABLE';
 targetHost:WslProxyTlsTargetHost;
 targetPort:443;
 gateway:string|null;
 proxyPort:number|null;
 protocol:string|null;
 alpn:string|null;
 authorized:boolean;
 elapsedMs:number|null;
 cipher:string|null;
 errorClass:string|null;
 sourcePortSha256:string|null;
 selectedNode:string|null;
 expectedNode:string|null;
 selectionMatchesExpected:boolean|null;
 nodeChainMatched:boolean;
 chains:string[];
 proxyConnectRequests:0|1;
 proxyControlBytes:number;
 originHttpRequests:0;
 modelCalls:0;
 filesWritten:0;
}
export type RoutedRequestRole='planner1'|'planner2'|'executor'|'reviewer';
export const CODEX_CONTROL_TARGET_HOSTS=Object.freeze([
 'ws.chatgpt.com',
 'codex-cloud-backend.chatgpt.com',
 'codex-cloud-environments.chatgpt.com'
] as const);
export const CODEX_REQUEST_TARGETS=Object.freeze([
 'api.openai.com',
 'chatgpt.com',
 'ab.chatgpt.com',
 ...CODEX_CONTROL_TARGET_HOSTS
] as const);
export type CodexControlTargetHost=typeof CODEX_CONTROL_TARGET_HOSTS[number];
export type CodexRequestTargetHost=typeof CODEX_REQUEST_TARGETS[number];
export interface RoutedRequestObservation {
 schema:'dream-maker.routed-request-observation.v1';
 at:string;startedAt:string;completedAt:string;
 process:'DM_CONTROLLED_TRANSPORT';role?:RoutedRequestRole;targetHost:string;method:'GET'|'POST';
 selectionPolicy:'pinned'|'current';selectedNode:string;expectedNode:string;
 httpStatus:number|null;
 classification:'DNS_FAILURE'|'TCP_CONNECTION_FAILURE'|'TLS_HANDSHAKE_FAILURE'|'PROXY_CONNECTION_RESET'|'STREAM_INTERRUPTED'|'HTTP_401_AUTHENTICATION_FAILED'|'HTTP_403_PERMISSION_DENIED'|'REGION_OR_POLICY_RESTRICTED'|'HTTP_429_QUOTA_EXCEEDED'|'MODEL_UNAVAILABLE'|'HTTP_SUCCESS_NON_INFERENCE'|'HTTP_CLIENT_REQUEST_REJECTED'|'INFERENCE_COMPLETED'|'HTTP_5XX_UPSTREAM_FAILURE';
 automaticRetryAllowed:boolean;requestIdSha256:string|null;elapsedMs:number;
}
export type CodexRequestPathState='REQUEST_ROUTE_VERIFIED'|'DIRECT_ROUTE_OBSERVED'|'PROCESS_ROUTE_NOT_OBSERVED'|'PROCESS_IDENTITY_UNVERIFIED'|'CONNECTION_AMBIGUOUS'|'NODE_MISMATCH'|'CFW_UNAVAILABLE'|'ROUTE_DISABLED';
export type CodexRequestClassification=RoutedRequestObservation['classification']|'NOT_OBSERVED';
/** A bounded observation for one DM-owned Codex app-server turn. Raw request IDs,
 * headers, command lines and CFW metadata outside this allowlist are not persisted. */
export interface CodexRequestPathObservation {
    schema:'dream-maker.codex-request-path.v1';
    at:string;startedAt:string;completedAt:string;
    role:'planner2'|'reviewer';method:'turn/start';targetHost:CodexRequestTargetHost|null;
    targetHosts:CodexRequestTargetHost[];targetPort:443;sourcePortCount:number;
    path:CodexRequestPathState;
    processPid:number|null;processIdentitySha256:string|null;sourcePortSha256:string|null;
    proxyEndpoint:string|null;selectedNode:string|null;expectedNode:string|null;chains:string[];
    classification:CodexRequestClassification;httpStatus:number|null;
    requestIdSha256:string|null;automaticRetryAllowed:false;
}
export interface LocalProxyHealth {
 schema:'dream-maker.local-proxy-health.v1';scope:'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP';startedAt:string;completedAt:string;
 state:'SHORT_WINDOW_OK'|'INTERRUPTED';address:string;controller:'READABLE'|'UNAVAILABLE';
 samples:{at:string;state:'CONNECTED'|'REFUSED'|'RESET'|'TIMEOUT'|'UNAVAILABLE';elapsedMs:number}[];
 websocket:'NOT_TESTED';modelCalls:0;oauthAttempts:0;networkSettingsChanged:false;
 openAiTls:OpenAiTlsProbe;
  /** The Codex login host is checked separately from the API host. Older persisted
   * observations may omit it, but a new no-HTTP check always records both. */
  codexTls?:OpenAiTlsProbe;
  /** Official Codex control-plane targets. CONNECT/TLS only; no WebSocket
   * upgrade, authentication or long-lived session is implied. */
  codexControlTlsProbes?:OpenAiTlsProbe[];
  /** The executor gateway's provider leg is checked independently from OpenAI. */
  deepSeekTls?:OpenAiTlsProbe;
 endpointFingerprint?:string;
}
export interface NetworkContextsSnapshot {
 schema:'dream-maker.network-contexts.v1';observedAt:string;currentConfiguration:boolean;cacheMs:number;
 scope:'PASSIVE_LOCAL_METADATA_NO_LOGIN_OR_INFERENCE';automaticLogin:false;externalProbes:false;networkSettingsChanged:false;
 eligibilityPolicy:{automaticRegionSwitch:false;proxyChangeIsEligibilityEvidence:false;remediation:'OFFICIAL_ELIGIBILITY_ONLY'};
 controller:{state:NetworkObservationState;dmRoutingEnabled:boolean;selectionPolicy:'pinned'|'current';selectors:number;nodes:number;
  configuredSelector:string|null;configuredNode:string|null;selectedNode:string|null;selectionMatchesExpected:boolean|null;
  proxyListener?:ProxyListenerObservation};
 account:{state:'CACHED_UNVERIFIED'|'UNKNOWN';mode:'CHATGPT'|'UNKNOWN';fingerprint:string|null};
 openAi:OpenAiStatus;
 contexts:NetworkContextRow[];retry:{allowed:false;reason:'NO_NEW_ELIGIBILITY_EVIDENCE'};
 additionalContexts?:NetworkContextRow[];localProxyHealth?:LocalProxyHealth;latestRoutedRequest?:RoutedRequestObservation;
 latestDeepSeekRoutedRequest?:RoutedRequestObservation;
    latestCodexRequest?:CodexRequestPathObservation;
 wslProxyReachability?:WslProxyReachability;
 wslProxyTls?:WslProxyTlsObservation[];
 configurationFingerprint?:string;
}
