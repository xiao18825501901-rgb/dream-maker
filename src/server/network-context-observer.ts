import {lstatSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {Config} from '../shared/types.js';
import type {ProxyListenerObservation,WslProxyTlsObservation} from '../shared/network-contexts.js';
import type {Store} from './store.js';
import type {ClashService} from './clash-service.js';
import {readCodexRequestPathObservation,readProxyListenerObservation,readRoutedRequestObservation,readWslProxyReachability,type CodexPathObservation,type LocalNetworkObservations,type LoginRejection} from './network-contexts.js';
import type {RoutedRequestObservation} from '../shared/network-contexts.js';
import {capture} from './process.js';
import {childEnv,DomainError,hash} from './security.js';
import {verifyProbeCustodyEnvironment} from './probe-custody-scope.js';
import {cleanupUncertain} from './cleanup-uncertainty.js';

const WSL='DreamMaker-Acceptance-F-20261101-R2',HOME='/opt/dream-maker-controller/codex-home-p2';
const BINARY='/opt/dream-maker-controller/codex-0.162.0/launcher/package/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const WSL_TLS_TARGETS=['api.openai.com','chatgpt.com'] as const;
type WslTlsTarget=typeof WSL_TLS_TARGETS[number];
type WslTlsReadiness={schema:'dream-maker.wsl-proxy-tls-readiness.v1';stage:'READY';targetHost:WslTlsTarget;targetPort:443;gateway:string;proxyPort:number;sourceAddress:string;sourcePort:number};
type WslTlsHelperObservation={
 schema:'dream-maker.wsl-proxy-tls-helper-observation.v1';
 state:WslProxyTlsObservation['state'];targetHost:WslTlsTarget;targetPort:443;
 gateway:string|null;proxyPort:number|null;protocol:string|null;alpn:string|null;authorized:boolean;
 elapsedMs:number|null;errorClass:string|null;cipher?:string|null;
 proxyConnectRequests:0|1;proxyControlBytes:number;originHttpRequests:0;modelCalls:0;filesWritten:0;
};
const emptyWsl=():LocalNetworkObservations['wsl']=>({available:false,codexLoginRunning:false,codexServerRunning:false,proxyPresent:false,account:{mode:'UNKNOWN',fingerprint:null},rejections:[],logRead:'UNAVAILABLE'});
const emptyWindows=():LocalNetworkObservations['windows']=>({available:false,systemProxyEnabled:false,loopbackProxy:false,dshRunning:false,codexServerRunning:false});
const unavailableListener=():ProxyListenerObservation=>({state:'UNAVAILABLE',mixedPort:null,bindings:[],ownerMatchesController:null,allowLan:null,bindAddress:null});
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^20\d\d-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
const privateGateway=(v:unknown):v is string=>typeof v==='string'&&/^(?:10(?:[.]\d{1,3}){3}|172[.](?:1[6-9]|2\d|3[01])(?:[.]\d{1,3}){2}|192[.]168(?:[.]\d{1,3}){2})$/.test(v);
function readWslTlsReadiness(raw:unknown):WslTlsReadiness|null{
 const v=raw as Record<string,unknown>;
 if(!v||v.schema!=='dream-maker.wsl-proxy-tls-readiness.v1'||v.stage!=='READY'||
  !['api.openai.com','chatgpt.com'].includes(String(v.targetHost))||v.targetPort!==443||
  !privateGateway(v.gateway)||!Number.isSafeInteger(v.proxyPort)||Number(v.proxyPort)<1||Number(v.proxyPort)>65535||
  !privateGateway(v.sourceAddress)||!Number.isSafeInteger(v.sourcePort)||Number(v.sourcePort)<1||Number(v.sourcePort)>65535)return null;
 return structuredClone(v) as unknown as WslTlsReadiness;
}
function readWslTlsHelperObservation(raw:unknown):WslTlsHelperObservation|null{
 const v=raw as Record<string,unknown>;
 if(!v||v.schema!=='dream-maker.wsl-proxy-tls-helper-observation.v1'||
  !['CONNECT_AND_TLS_COMPLETED','PROXY_CONNECT_REJECTED','TLS_HANDSHAKE_FAILED','TIMEOUT','UNREACHABLE'].includes(String(v.state))||
  !['api.openai.com','chatgpt.com'].includes(String(v.targetHost))||v.targetPort!==443||
  v.gateway!==null&&!privateGateway(v.gateway)||v.proxyPort!==null&&(!Number.isSafeInteger(v.proxyPort)||Number(v.proxyPort)<1||Number(v.proxyPort)>65535)||
  v.protocol!==null&&!['TLSv1.2','TLSv1.3'].includes(String(v.protocol))||v.alpn!==null&&v.alpn!=='http/1.1'||typeof v.authorized!=='boolean'||
  v.elapsedMs!==null&&(!Number.isSafeInteger(v.elapsedMs)||Number(v.elapsedMs)<0||Number(v.elapsedMs)>30000)||
  v.errorClass!==null&&(typeof v.errorClass!=='string'||!/^[A-Z0-9_]{1,80}$/.test(v.errorClass))||
  v.cipher!==undefined&&v.cipher!==null&&(typeof v.cipher!=='string'||v.cipher.length<1||v.cipher.length>100)||
  ![0,1].includes(Number(v.proxyConnectRequests))||!Number.isSafeInteger(v.proxyControlBytes)||Number(v.proxyControlBytes)<0||Number(v.proxyControlBytes)>16384||
  v.originHttpRequests!==0||v.modelCalls!==0||v.filesWritten!==0)return null;
 return structuredClone(v) as unknown as WslTlsHelperObservation;
}
function helperObservationFromLines(stdout:string):WslTlsHelperObservation|null{
 const lines=stdout.split(/\r?\n/).filter(Boolean),tail=lines.at(-1);
 if(!tail)return null;
 try{return readWslTlsHelperObservation(JSON.parse(tail));}catch{return null;}
}
/** Project fixed helper output is still untrusted. Never forward raw fields or errors. */
export function readNetworkObserverProjection(input:unknown):LocalNetworkObservations['wsl']{
 const v=input as Record<string,unknown>;
 if(!v||v.schema!=='dream-maker.network-local-observer.v1'||v.available!==true||v.networkRequests!==0||v.loginAttempts!==0||v.filesWritten!==0||
    !['codexLoginRunning','codexServerRunning','proxyPresent'].every(k=>typeof v[k]==='boolean')||!Array.isArray(v.rejections)||v.rejections.length>4)throw new DomainError('NETWORK_OBSERVATION_INVALID',502);
 const a=v.account as Record<string,unknown>,rejections:LoginRejection[]=[];
 if(!a||!['CHATGPT','UNKNOWN'].includes(String(a.mode))||a.fingerprint!==null&&(typeof a.fingerprint!=='string'||!/^[a-f0-9]{16}$/.test(a.fingerprint)))throw new DomainError('NETWORK_OBSERVATION_INVALID',502);
 for(const item of v.rejections){
  const r=item as Record<string,unknown>;
  if(!r||!timestamp(r.at)||!['REGION_UNSUPPORTED','FORBIDDEN_UNKNOWN','TRANSPORT_ERROR'].includes(String(r.reason))||
   (r.reason==='TRANSPORT_ERROR'?r.httpStatus!==0:r.httpStatus!==403)||r.requestId!==null&&(typeof r.requestId!=='string'||!/^[a-f0-9]{6}…(?:-[A-Z]{3})?$/.test(r.requestId)))throw new DomainError('NETWORK_OBSERVATION_INVALID',502);
  rejections.push({at:r.at,httpStatus:Number(r.httpStatus),reason:r.reason as LoginRejection['reason'],requestId:r.requestId as string|null});
 }
 return {available:true,codexLoginRunning:v.codexLoginRunning===true,codexServerRunning:v.codexServerRunning===true,proxyPresent:v.proxyPresent===true,
  account:{mode:a.mode as 'CHATGPT'|'UNKNOWN',fingerprint:a.fingerprint as string|null},rejections,logRead:v.logRead==='OBSERVED'?'OBSERVED':'UNAVAILABLE'};
}

const developerImagePattern=String.raw`(?:\\windowsapps\\openai\.codex_|\\appdata\\local\\openai\\codex\\bin\\[a-f0-9]{16,64}\\codex\.exe$)`;
export function isDevelopmentCodexImage(value:unknown):boolean{return typeof value==='string'&&new RegExp(developerImagePattern,'i').test(value.replaceAll('/','\\'));}
const WINDOWS_SCRIPT=String.raw`$ErrorActionPreference='Stop'
$dmInput=[Console]::In.ReadToEnd()|ConvertFrom-Json
$dmRoot=[IO.Path]::GetFullPath($dmInput.root).Replace('/','\').ToLowerInvariant();$dmSuite='f:\dreammakersuite\'
if(!$dmRoot.StartsWith($dmSuite)){throw 'SCOPE_DENIED'}
$dmProxy=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$dmDsh=$false;$dmCodex=$false;$dmDeveloper=$false;$dmMagpie=$false
foreach($dmProcess in Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='codex.exe' OR Name='dream-maker-magpie.exe'"){
 $dmImage=([string]$dmProcess.ExecutablePath).Replace('/','\').ToLowerInvariant();$dmArgs=([string]$dmProcess.CommandLine).Replace('/','\').ToLowerInvariant()
 if($dmImage -match '${developerImagePattern}'){$dmDeveloper=$true}
 if(!$dmImage.StartsWith($dmSuite)){continue}
 if($dmImage.EndsWith('\dream-maker-magpie.exe') -and $dmImage.Contains('\.runtime\magpie-controls\')){$dmMagpie=$true}
 if($dmArgs.Contains($dmRoot+'\adapters\archon-dsh-native.mjs') -or ($dmArgs.Contains('f:\dreammakersuite\runtime\archon-controller-dm-') -and $dmArgs.Contains('\dsh-node-host.mjs'))){$dmDsh=$true}
 if($dmArgs.Contains($dmSuite) -and $dmArgs.Contains('app-server') -and ($dmImage.EndsWith('\codex.exe') -or $dmArgs.Contains('\@openai\codex\bin\codex.js'))){$dmCodex=$true}
}
[pscustomobject]@{available=$true;systemProxyEnabled=($dmProxy.ProxyEnable -eq 1);loopbackProxy=([string]$dmProxy.ProxyServer -match 'localhost|127\.0\.0\.1');dshRunning=$dmDsh;codexServerRunning=$dmCodex;developmentCodexRunning=$dmDeveloper;magpieRunning=$dmMagpie}|ConvertTo-Json -Compress`;

const WINDOWS_LISTENER_SCRIPT=String.raw`$ErrorActionPreference='Stop'
$dmInput=[Console]::In.ReadToEnd()|ConvertFrom-Json
$dmMixed=[int]$dmInput.mixedPort;$dmController=[int]$dmInput.controllerPort
if($dmMixed -lt 1 -or $dmMixed -gt 65535 -or $dmController -lt 1 -or $dmController -gt 65535){throw 'PORT_DENIED'}
$dmMixedRows=@(Get-NetTCPConnection -State Listen -LocalPort $dmMixed -ErrorAction Stop)
$dmControllerRows=@(Get-NetTCPConnection -State Listen -LocalPort $dmController -ErrorAction Stop)
if($dmMixedRows.Count -eq 0 -or $dmControllerRows.Count -eq 0){
 [pscustomobject]@{available=$false;mixedPort=$dmMixed;bindings=@();ownerMatchesController=$null}|ConvertTo-Json -Compress
 exit 0
}
$dmBindings=@($dmMixedRows|ForEach-Object{
 $dmAddress=([string]$_.LocalAddress).Trim()
 if($dmAddress -in @('127.0.0.1','::1','[::1]')){'LOOPBACK'}
 elseif($dmAddress -in @('0.0.0.0','::','[::]','*')){'WILDCARD'}
 else{'OTHER'}
}|Sort-Object -Unique)
$dmMixedPids=@($dmMixedRows|ForEach-Object{[int]$_.OwningProcess}|Sort-Object -Unique)
$dmControllerPids=@($dmControllerRows|ForEach-Object{[int]$_.OwningProcess}|Sort-Object -Unique)
$dmSameOwner=$dmMixedPids.Count -eq 1 -and $dmControllerPids.Count -eq 1 -and $dmMixedPids[0] -eq $dmControllerPids[0]
$dmOwnerMatches=$false
if($dmSameOwner){
 $dmProcess=Get-CimInstance Win32_Process -Filter ("ProcessId="+$dmMixedPids[0]) -ErrorAction Stop
 $dmName=([string]$dmProcess.Name).ToLowerInvariant()
 $dmOwnerMatches=$dmName -in @('clash-win64.exe','clash-meta.exe','clash.exe','mihomo.exe')
}
[pscustomobject]@{available=$true;mixedPort=$dmMixed;bindings=$dmBindings;ownerMatchesController=$dmOwnerMatches}|ConvertTo-Json -Compress`;

function storedDshHistory(store:Store):LocalNetworkObservations['dshHistory']{
 const rows=store.db.prepare("SELECT data FROM records WHERE kind='NativeProbeReceipt' AND project_id IS NULL AND run_id IS NULL ORDER BY rowid DESC LIMIT 32").all();
 for(const row of rows){if(typeof row.data!=='string'||row.data.length>262144)continue;try{const p=JSON.parse(row.data).payload,o=p?.observation;
  if(p.role==='executor'&&o?.runner==='DSH'&&o.provider==='deepseek-official'&&o.model==='deepseek-flash'&&timestamp(p.at))return{at:p.at,model:o.model,provider:o.provider};
 }catch{/* Invalid stored history is never qualification. */}}
 return null;
}

function storedRoutedRequests(store:Store){
 const rows=store.db.prepare("SELECT payload FROM events WHERE type='network.routed-request' ORDER BY rowid DESC LIMIT 64").all();
 let latest:RoutedRequestObservation|null=null,openAi:RoutedRequestObservation|null=null,deepSeek:RoutedRequestObservation|null=null;
 for(const row of rows){
  if(typeof row.payload!=='string'||row.payload.length>32768)continue;
  try{
   const value=readRoutedRequestObservation(JSON.parse(row.payload));
   if(!value)continue;
   latest??=value;
   if(value.targetHost==='api.openai.com')openAi??=value;
   if(value.targetHost==='api.deepseek.com')deepSeek??=value;
   if(latest&&openAi&&deepSeek)break;
  }catch{/* Invalid stored diagnostics never become current evidence. */}
 }
 return{latest,openAi,deepSeek};
}

function storedCodexRequests(store:Store){
 const rows=store.db.prepare("SELECT payload FROM events WHERE type='network.codex-request' ORDER BY rowid DESC LIMIT 64").all();
 for(const row of rows){
  if(typeof row.payload!=='string'||row.payload.length>32768)continue;
  try{const value=readCodexRequestPathObservation(JSON.parse(row.payload));if(value)return value;}catch{/* Invalid request diagnostics never become current evidence. */}
 }
 return null;
}

function storedCodexPaths(store:Store):CodexPathObservation[]{
 const seen=new Set<string>(),paths:CodexPathObservation[]=[];
 const rows=store.db.prepare("SELECT at,payload FROM events WHERE type='agent.event' AND payload LIKE '%dm/codexNetworkPath%' ORDER BY rowid DESC LIMIT 64").all();
 for(const row of rows){
  if(typeof row.payload!=='string'||row.payload.length>262144||!timestamp(row.at))continue;
  let event:Record<string,unknown>;try{event=JSON.parse(row.payload);}catch{continue;}
  if(event.method!=='dm/codexNetworkPath')continue;
  const p=event.params as Record<string,unknown>,role=String(p?.role??''),transport=String(p?.transport??''),path=String(p?.path??'');
  if(!['planner2','reviewer'].includes(role)||!['stdio','wsl'].includes(transport)||
     !['CHILD_ENV_MATCH','DM_ROUTE_DISABLED','UNMANAGED_ENV_PRESENT'].includes(path)||seen.has(role))continue;
  if(path==='CHILD_ENV_MATCH'){
   const privateGateway=/^(?:10(?:[.]\d{1,3}){3}|172[.](?:1[6-9]|2\d|3[01])(?:[.]\d{1,3}){2}|192[.]168(?:[.]\d{1,3}){2}):[1-9][0-9]{0,4}$/;
   const loopback=/^127[.]0[.]0[.]1:[1-9][0-9]{0,4}$/;
   if(typeof p.proxyEndpoint!=='string'||(transport==='wsl'?!privateGateway.test(p.proxyEndpoint):!loopback.test(p.proxyEndpoint))||
      typeof p.proxyFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(p.proxyFingerprint))continue;
  }else if(p.proxyEndpoint!==null||p.proxyFingerprint!==null)continue;
  seen.add(role);paths.push({
   at:row.at,role:role as CodexPathObservation['role'],transport:transport as CodexPathObservation['transport'],
   path:path as CodexPathObservation['path'],proxyEndpoint:p.proxyEndpoint as string|null,proxyFingerprint:p.proxyFingerprint as string|null
  });
  if(paths.length===2)break;
 }
 return paths;
}

/** Local metadata only. The original transport and native admission gates are not changed. */
export function createLocalNetworkCollector(options:{root:string;store:Store;clash:ClashService},dependencies={capture,verifyEnvironment:verifyProbeCustodyEnvironment}){
 const root=resolve(options.root),powershell=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 return async(config:Config,signal:AbortSignal):Promise<LocalNetworkObservations>=>{
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(20000)]);
  const windows=async()=>{if(process.platform!=='win32')return emptyWindows();const r=await dependencies.capture(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',WINDOWS_SCRIPT],{cwd:root,env:childEnv(),input:JSON.stringify({root}),signal:bounded,timeoutMs:10000,maxBytes:8192});
   if(r.code!==0)return emptyWindows();const v=JSON.parse(r.stdout);if(!v||!['available','systemProxyEnabled','loopbackProxy','dshRunning','codexServerRunning'].every(k=>typeof v[k]==='boolean'))return emptyWindows();
   return {available:v.available===true,systemProxyEnabled:v.systemProxyEnabled===true,loopbackProxy:v.loopbackProxy===true,dshRunning:v.dshRunning===true,codexServerRunning:v.codexServerRunning===true,developmentCodexRunning:v.developmentCodexRunning===true,magpieRunning:v.magpieRunning===true};};
  const proxyListener=async(controller:LocalNetworkObservations['controller']):Promise<ProxyListenerObservation>=>{
   if(process.platform!=='win32'||!controller.available||!Number.isInteger(controller.mixedPort)||!Number.isInteger(controller.controllerPort))return unavailableListener();
   try{
    const r=await dependencies.capture(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',WINDOWS_LISTENER_SCRIPT],{
     cwd:root,env:childEnv(),input:JSON.stringify({mixedPort:controller.mixedPort,controllerPort:controller.controllerPort}),
     signal:bounded,timeoutMs:8000,maxBytes:4096
    });
    if(r.code!==0)return unavailableListener();
    const v=JSON.parse(r.stdout) as Record<string,unknown>;
    if(v.available!==true||!Array.isArray(v.bindings)||v.bindings.length===0||v.bindings.length>8||
       v.bindings.some(value=>!['LOOPBACK','WILDCARD','OTHER'].includes(String(value)))||typeof v.ownerMatchesController!=='boolean')return unavailableListener();
    const bindings=v.bindings as ProxyListenerObservation['bindings'];
    const loopback=bindings.includes('LOOPBACK'),nonLoopback=bindings.some(value=>value!=='LOOPBACK');
    const state=loopback&&nonLoopback?'MIXED':loopback?'LOOPBACK_ONLY':'NON_LOOPBACK';
    return readProxyListenerObservation({
     state,mixedPort:controller.mixedPort,bindings,ownerMatchesController:v.ownerMatchesController,
     allowLan:controller.allowLan??null,bindAddress:controller.bindAddress??null
    });
   }catch{return unavailableListener();}
  };
  const wslProxyReachability=async(controller:LocalNetworkObservations['controller'])=>{
   // The TCP-only capability check is independent from the selected Codex
   // transport. It is still limited to the dedicated acceptance distro and
   // never reads its credentials, sends HTTP/TLS, or claims proxy use.
   if(process.platform!=='win32'||!config.clash.enabled||config.codex.wslDistro!==WSL||
      !Number.isInteger(controller.mixedPort))return null;
   try{
    const path=join(root,'scripts/isolation/wsl-proxy-reachability.py'),info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>24576)throw new DomainError('NETWORK_WSL_PROXY_HELPER_DENIED',409);
    const source=readFileSync(path,'utf8');
    if(Buffer.byteLength(source)>24576)throw new DomainError('NETWORK_WSL_PROXY_HELPER_DENIED',409);
    const r=await dependencies.capture(join(process.env.SystemRoot??'C:/Windows','System32/wsl.exe'),
     ['-d',WSL,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-I','-c',source],
     {cwd:root,env:childEnv(),input:JSON.stringify({port:controller.mixedPort}),timeoutMs:5000,maxBytes:4096});
    if(r.code!==0)return null;
    return readWslProxyReachability(JSON.parse(r.stdout));
   }catch{return null;}
  };
  const wslProxyTlsReachability=async(controller:LocalNetworkObservations['controller'],signal:AbortSignal):Promise<WslProxyTlsObservation[]>=>{
   if(process.platform!=='win32'||!config.clash.enabled||config.codex.wslDistro!==WSL||
      !Number.isInteger(controller.mixedPort)||!Number.isInteger(controller.controllerPort))return [];
   try{
    const path=join(root,'scripts/isolation/wsl-proxy-reachability.py'),info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>32768)throw new DomainError('NETWORK_WSL_PROXY_HELPER_DENIED',409);
    const source=readFileSync(path,'utf8');
    if(Buffer.byteLength(source)>32768)throw new DomainError('NETWORK_WSL_PROXY_HELPER_DENIED',409);
    const expectedNode=typeof controller.selectedNode==='string'?controller.selectedNode:
     typeof controller.configuredNode==='string'?controller.configuredNode:null;
    const observe=async(targetHost:WslTlsTarget):Promise<WslProxyTlsObservation>=>{
     const observed:{readiness:WslTlsReadiness|null;association:Promise<{chains:string[];rule:string|null;inboundPortMatched:boolean}|{errorCode:string}>|null}={readiness:null,association:null};
     let line='';
     const consume=(chunk:string)=>{
      line+=chunk;
      let end;
      while((end=line.indexOf('\n'))>=0){
       const value=line.slice(0,end).trim();line=line.slice(end+1);
       if(!value)continue;
       let parsed:unknown;
       try{parsed=JSON.parse(value);}catch{continue;}
       const next=readWslTlsReadiness(parsed);
       if(next&&next.targetHost===targetHost&&observed.readiness===null){
        observed.readiness=next;
        observed.association=options.clash.traceConnection({
         sourceAddress:next.sourceAddress,sourcePort:next.sourcePort,proxyPort:next.proxyPort,
         targetHost:next.targetHost,targetPort:443
        },signal).then(value=>({chains:value.chains,rule:value.rule,inboundPortMatched:value.inboundPortMatched}))
         .catch(error=>({errorCode:typeof (error as {code?:unknown})?.code==='string'?String((error as {code:string}).code):'CFW_ASSOCIATION_FAILED'}));
       }
      }
     };
     const r=await dependencies.capture(join(process.env.SystemRoot??'C:/Windows','System32/wsl.exe'),
      ['-d',WSL,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-I','-c',source],
      {cwd:root,env:childEnv(),input:JSON.stringify({port:controller.mixedPort,targetHost}),timeoutMs:10000,maxBytes:16384,onStdout:consume});
     const helper=r.code===0?helperObservationFromLines(r.stdout):null;
     if(!helper)return {
      schema:'dream-maker.wsl-proxy-tls-observation.v1',state:'UNREACHABLE',targetHost,targetPort:443,
      gateway:null,proxyPort:controller.mixedPort??null,protocol:null,alpn:null,authorized:false,elapsedMs:null,cipher:null,
      errorClass:'PROBE_PROCESS_FAILED',sourcePortSha256:null,selectedNode:null,expectedNode,
      selectionMatchesExpected:null,nodeChainMatched:false,chains:[],proxyConnectRequests:0,proxyControlBytes:0,
      originHttpRequests:0,modelCalls:0,filesWritten:0
     };
     const currentReadiness=observed.readiness;
     const pendingAssociation=observed.association;
     const associated=helper.state==='CONNECT_AND_TLS_COMPLETED'&&pendingAssociation?await pendingAssociation:null;
     const chains=associated&&'chains'in associated?associated.chains:[];
     const selectedNode=chains[0]??null;
     const associationError=associated&&'errorCode'in associated?associated.errorCode:
      helper.state==='CONNECT_AND_TLS_COMPLETED'&&!currentReadiness?'CFW_ASSOCIATION_UNAVAILABLE':helper.errorClass;
     return {
      schema:'dream-maker.wsl-proxy-tls-observation.v1',state:helper.state,targetHost,targetPort:443,
      gateway:helper.gateway,proxyPort:helper.proxyPort,protocol:helper.protocol,alpn:helper.alpn,authorized:helper.authorized,
      elapsedMs:helper.elapsedMs,cipher:helper.cipher??null,errorClass:associationError,
      sourcePortSha256:currentReadiness?hash(`${currentReadiness.sourceAddress}\0${currentReadiness.sourcePort}`):null,
      selectedNode,expectedNode,selectionMatchesExpected:expectedNode&&selectedNode?expectedNode===selectedNode:null,
      nodeChainMatched:Boolean(expectedNode&&chains.includes(expectedNode)),chains,
      proxyConnectRequests:helper.proxyConnectRequests,proxyControlBytes:helper.proxyControlBytes,
      originHttpRequests:0,modelCalls:0,filesWritten:0
     };
    };
    return await Promise.all(WSL_TLS_TARGETS.map(observe));
   }catch(error){
    if(cleanupUncertain(error))throw error;
    return [];
   }
  };
  const wsl=async()=>{if(process.platform!=='win32'||config.codex.transport!=='wsl'||config.codex.wslDistro!==WSL||config.codex.wslHome!==HOME||config.codex.wslBinary!==BINARY||config.codex.wslCommand&&config.codex.wslCommand!=='wsl.exe')return emptyWsl();
   await dependencies.verifyEnvironment(bounded);bounded.throwIfAborted();
   const path=join(root,'scripts/isolation/network-context-observer.py'),info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>24576)throw new DomainError('NETWORK_OBSERVER_SCOPE_DENIED',409);
   const source=readFileSync(path,'utf8');if(Buffer.byteLength(source)>24576)throw new DomainError('NETWORK_OBSERVER_SCOPE_DENIED',409);
   // Once Linux starts, ordinary application close joins its bounded natural completion.
   // Killing only wsl.exe on abort is not proof that the Linux read-only helper has exited.
   let r;try{r=await dependencies.capture(join(process.env.SystemRoot??'C:/Windows','System32/wsl.exe'),['-d',WSL,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-I','-c',source],{cwd:root,env:childEnv(),timeoutMs:8000,maxBytes:8192});}
   catch(error){if(error instanceof DomainError&&error.code==='EXECUTABLE_NOT_AVAILABLE')return emptyWsl();throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500,'PASSIVE_WSL_OBSERVER_EXIT_UNPROVEN');}
   if(r.code!==0)return emptyWsl();return readNetworkObserverProjection(JSON.parse(r.stdout));};
  const controller=async()=>{
   const v=await options.clash.inspect(bounded);
    const configuredSelector=typeof v.configured?.selector==='string'&&v.configured.selector?v.configured.selector:null;
    const configuredNode=typeof v.configured?.node==='string'&&v.configured.node?v.configured.node:null;
   const configured=(v.configured??{}) as {selectionPolicy?:'pinned'|'current'};
   const selectionPolicy=configured.selectionPolicy==='current'?'current' as const:'pinned' as const;
   const selectedNode=v.selectors.find(selector=>selector.name===configuredSelector)?.now||null;
   const controllerMetadata=v.controller as {mixedPort?:unknown;allowLan?:unknown;bindAddress?:unknown;controllerPort?:unknown}|null|undefined;
   return {available:'controller' in v&&!!v.controller,selectors:v.selectors.length,nodes:v.nodes.length,selectionPolicy,configuredSelector,configuredNode,selectedNode,
    mixedPort:Number.isInteger(controllerMetadata?.mixedPort)?Number(controllerMetadata?.mixedPort):null,
    controllerPort:Number.isInteger(controllerMetadata?.controllerPort)?Number(controllerMetadata?.controllerPort):null,
    allowLan:typeof controllerMetadata?.allowLan==='boolean'?controllerMetadata.allowLan:null,
    bindAddress:typeof controllerMetadata?.bindAddress==='string'?controllerMetadata.bindAddress:null,
    selectionMatchesExpected:selectionPolicy==='current'?null:configuredNode&&selectedNode?configuredNode===selectedNode:null};
  };
  const reads=await Promise.allSettled([windows(),wsl(),controller()]);
  for(const r of reads)if(r.status==='rejected'&&cleanupUncertain(r.reason))throw r.reason;
  if(signal.aborted)throw new DomainError('NETWORK_CONTEXTS_CLOSED',409);
  const windowsValue=reads[0].status==='fulfilled'?reads[0].value as LocalNetworkObservations['windows']:emptyWindows();
  const controllerValue=reads[2].status==='fulfilled'?reads[2].value as LocalNetworkObservations['controller']:{available:false,selectors:0,nodes:0};
  const wslValue=reads[1].status==='fulfilled'?reads[1].value as LocalNetworkObservations['wsl']:emptyWsl();
  windowsValue.proxyListener=await proxyListener(controllerValue);
  if(signal.aborted)throw new DomainError('NETWORK_CONTEXTS_CLOSED',409);
  const wslProxy=await wslProxyReachability(controllerValue);
  if(signal.aborted)throw new DomainError('NETWORK_CONTEXTS_CLOSED',409);
  const wslProxyTls=wslProxy?.state==='TCP_REACHABLE_ONLY'?await wslProxyTlsReachability(controllerValue,bounded):[];
  if(signal.aborted)throw new DomainError('NETWORK_CONTEXTS_CLOSED',409);
  const routed=storedRoutedRequests(options.store);
  const latestCodexRequest=storedCodexRequests(options.store);
  return {windows:windowsValue,wsl:wslValue,
   controller:controllerValue,
   dshHistory:storedDshHistory(options.store),codexPaths:storedCodexPaths(options.store),latestRoutedRequest:routed.latest,
   latestRoutedRequests:{openAi:routed.openAi,deepSeek:routed.deepSeek},latestCodexRequest,
   ...(wslProxy?{wslProxyReachability:wslProxy}:{}),...(wslProxyTls.length?{wslProxyTls}:{})};
 };
}
