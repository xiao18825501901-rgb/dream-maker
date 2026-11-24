import type {CustomFlowConfigSnapshot} from '../shared/flow-configuration.js';
import type {CustomAccountSourcesView} from '../shared/custom-account-sources.js';
import {DomainError,hash,object,registerCredentialEnv,hasSecret,withExplicitSecretInspection} from './security.js';
import {NO_ACCOUNT_PROBE_AUTHORITY,type AccountProbeAuthority} from './account-verification.js';
import {isIP} from 'node:net';
export type AccountProtocol='chat-completions'|'openai-responses'|'anthropic-messages';
export interface AccountCapability {model:string;protocol:AccountProtocol;endpoint:string}
export interface ControllerAccountSource {provider:string;capabilities?:AccountCapability[];authentication:'api_key';authRef:string;accountRef:string;secretEnv:string;model?:string;models?:string[];endpoint?:{protocol:'anthropic-messages';baseUrl:string}}
const fail=():never=>{throw new DomainError('CUSTOM_ACCOUNT_SOURCES_INVALID',409);};
function exact(raw:unknown,keys:string[]):Record<string,unknown>{
 const fields=Object.getOwnPropertyDescriptors(object(raw));
 if(Reflect.ownKeys(fields).length!==keys.length||keys.some(k=>!fields[k]?.enumerable||!Object.hasOwn(fields[k],'value')))return fail();
 return Object.fromEntries(keys.map(k=>[k,fields[k].value]));
}
export function stringMessagesEndpoint(raw:unknown):{protocol:'anthropic-messages';baseUrl:string}{
 const endpoint=exact(raw,['protocol','baseUrl']);
 if(endpoint.protocol!=='anthropic-messages'||typeof endpoint.baseUrl!=='string'||/\s/.test(endpoint.baseUrl))return fail();
 const url=new URL(endpoint.baseUrl),host=url.hostname.toLowerCase().replace(/\.$/,'');
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||isIP(host.replace(/^\[|\]$/g,''))||!host.includes('.')||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local'))return fail();
 return {protocol:'anthropic-messages',baseUrl:endpoint.baseUrl};
}
function boundedList(value:unknown,max:number):unknown[]{
 if(!Array.isArray(value)||value.length>max)return fail();
 const fields=Object.getOwnPropertyDescriptors(value as object);
 if(Reflect.ownKeys(fields).length!==value.length+1)return fail();
 return Array.from({length:value.length},(_,i)=>{const d=fields[String(i)];if(!d?.enumerable||!Object.hasOwn(d,'value'))return fail();return d.value;});
}
const endpointSuffix={'chat-completions':'/chat/completions','openai-responses':'/responses','anthropic-messages':'/messages'} as const;
const deepseekEndpoints:Partial<Record<AccountProtocol,string>>={'chat-completions':'https://api.deepseek.com/v1/chat/completions','anthropic-messages':'https://api.deepseek.com/anthropic/v1/messages'};
/** The private operator pins the complete upstream URL for each account/model/wire. */
export function accountCapabilities(provider:unknown,raw:unknown):AccountCapability[]{
 if(typeof provider!=='string'||!/^[a-z][a-z0-9-]{0,62}$/.test(provider)||provider==='unknown')return fail();
 const entries=boundedList(raw,64),seen=new Set<string>();if(!entries.length)return fail();
 return entries.map(entry=>{
  const {model,protocol,endpoint}=exact(entry,['model','protocol','endpoint']);
  if(typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(model)||model.includes('://')||typeof protocol!=='string'||!Object.hasOwn(endpointSuffix,protocol)||typeof endpoint!=='string'||endpoint.length>512)return fail();
  const wire=protocol as AccountProtocol,identity=model+'|'+wire;
  if(seen.has(identity)||provider==='deepseek-official'&&deepseekEndpoints[wire]!==endpoint)return fail();
  let url:URL;try{url=new URL(endpoint);}catch{return fail();}
  if(url.protocol!=='https:'||url.href!==endpoint||url.port||url.username||url.password||url.search||url.hash||!url.hostname.includes('.')||isIP(url.hostname)||!url.hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||/\.(?:local|localhost|internal)$/.test(url.hostname)||!/^\/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]+$/.test(url.pathname)||!url.pathname.endsWith(endpointSuffix[wire]))return fail();
  seen.add(identity);return {model,protocol:wire,endpoint};
 });
}
/** A private operator Ref selects this manifest. Browser profiles cannot select secret names. */
function sources(raw:unknown,dshKeyEnv:string):ControllerAccountSource[]{
 try{
  const v=exact(raw,['schema','accounts']);if(v.schema!=='dream-maker.custom-account-sources.v1'&&v.schema!=='dream-maker.custom-account-sources.v2')return fail();
  return validateAccountSourceList(v.accounts,dshKeyEnv,v.schema==='dream-maker.custom-account-sources.v2'?'explicit':'legacy');
 }catch{return fail();}
}
/** Only checked controller metadata leaves this boundary. Credential lookup is a later operation. */
export function publicAccountIdentities(manifest:unknown|undefined,dshKeyEnv:string,registered:import('../shared/registered-account-sources.js').RegisteredAccountSource[]){
 const configured=manifest===undefined?[]:sources(manifest,dshKeyEnv);
 const entries=configured.filter(source=>source.capabilities);
 const envNames=[dshKeyEnv,...configured.map(source=>source.secretEnv)].map(name=>name.toLowerCase());
 for(const row of registered.filter(source=>source.status==='SELECTED_UNVERIFIED')){
  const collision=entries.find(source=>source.authRef===row.authRef||source.accountRef===row.accountRef);
  if(collision){
   if(collision.authRef!==row.authRef||collision.accountRef!==row.accountRef||collision.provider!==row.provider||collision.authentication!==row.authentication||collision.secretEnv!==dshKeyEnv)return fail();
   continue;
  }
  // An explicit v2 credential has one pinned identity. A second registry alias for it cannot dispatch.
  if(configured.some(source=>source.capabilities&&source.secretEnv===dshKeyEnv))continue;
  const {provider,authentication,authRef,accountRef}=row;
  entries.push({provider,authentication,authRef,accountRef,secretEnv:dshKeyEnv});
 }
 return entries.map(({provider,authentication,authRef,accountRef})=>{
  const identity={provider,authentication,authRef,accountRef},text=JSON.stringify(identity);
  if(hasSecret(text)||envNames.some(name=>text.toLowerCase().includes(name)))return fail();
  return identity;
 });
}
/** Normalized internal lists can combine a private manifest and a registered legacy account. */
export function validateAccountSourceList(raw:unknown,dshKeyEnv:string,format:'legacy'|'explicit'|'mixed'='mixed'):ControllerAccountSource[]{
 try{
  const refs=new Set<string>(),accounts=new Set<string>(),names=new Set<string>();
  const entries=boundedList(raw,format==='legacy'?8:32);
  if(format==='mixed'&&entries.length>8&&!entries.some(entry=>Object.hasOwn(object(entry),'capabilities')))return fail();
  return entries.map(raw=>{
   const probe=Object.getOwnPropertyDescriptors(object(raw)),hasModel=Object.hasOwn(probe,'model'),hasModels=Object.hasOwn(probe,'models'),hasEndpoint=Object.hasOwn(probe,'endpoint');
   if(hasModel&&(!probe.model.enumerable||!Object.hasOwn(probe.model,'value')))return fail();
   if(hasModels&&(!probe.models.enumerable||!Object.hasOwn(probe.models,'value')))return fail();
   const explicit=Object.hasOwn(probe,'capabilities');
   if(format==='legacy'&&explicit||format==='explicit'&&!explicit||explicit&&(hasModel||hasModels||hasEndpoint))return fail();
   const keys=['provider','authentication','authRef','accountRef','secretEnv',...(explicit?['capabilities']:[]),...(hasModel?['model']:[]),...(hasModels?['models']:[]),...(hasEndpoint?['endpoint']:[])];
   const a=exact(raw,keys),ref=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v)&&!['UNKNOWN','NOT_VERIFIED'].includes(v.toUpperCase());
   if(hasModel&&(typeof a.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(a.model)))return fail();
   if(hasModels){
    // One provider credential may name the small model set it is allowed to serve.
    if(!Array.isArray(a.models)||a.models.length>8||a.models.length<1)return fail();
    const seen=new Set<string>();
    for(const model of a.models){
     if(typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(model)||seen.has(model))return fail();
     seen.add(model);
    }
   }
   if(!explicit&&!['deepseek-official','string'].includes(String(a.provider))||a.authentication!=='api_key'||!ref(a.authRef)||!ref(a.accountRef)||typeof a.secretEnv!=='string'||
    !(a.provider==='deepseek-official'&&a.secretEnv===dshKeyEnv&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(a.secretEnv)||/^DM_CUSTOM_[A-Z0-9_]{1,48}_API_KEY$/.test(a.secretEnv)))return fail();
   if(explicit){
    if(a.provider!=='deepseek-official'&&a.secretEnv.toUpperCase()===dshKeyEnv.toUpperCase())return fail();
    a.capabilities=accountCapabilities(a.provider,a.capabilities);
   }else if(a.provider==='string'){
    // The endpoint is part of the controller's hashed private manifest, never a
    // browser-selected URL. Metadata admission does not authorize network access.
    if(!hasEndpoint||!hasModels||a.secretEnv===dshKeyEnv)return fail();
    if([...(a.models as string[]),...(hasModel?[String(a.model)]:[])].some(model=>!/^claude-[A-Za-z0-9_.-]+$/.test(model)))return fail();
    a.endpoint=stringMessagesEndpoint(a.endpoint);
   }else if(hasEndpoint)return fail();
   if(refs.has(String(a.authRef))||accounts.has(String(a.accountRef))||names.has(a.secretEnv.toUpperCase()))return fail();refs.add(String(a.authRef));accounts.add(String(a.accountRef));names.add(a.secretEnv.toUpperCase());
   return a as unknown as ControllerAccountSource;
  });
 }catch{return fail();}
}
/** Pure metadata selection, then explicit controller-only reads. No provider/runner is contacted. */
export function customAccountReferences(snapshot:CustomFlowConfigSnapshot){const used=new Set<string>(),magpie=new Set<string>();
 const roles=[snapshot.roles.planner2,...snapshot.roles.executors,snapshot.roles.reviewer];
 for(const role of roles){
  const group=role.model.kind==='group'?snapshot.groups.find(g=>g.id===role.model.id):undefined;
  const member=group?.members.find(candidate=>candidate.id===role.selectedMemberId);
  if(group&&(!role.selectedMemberId||!member))return fail();
  const authRef=member?.authRef??role.authRef;
  used.add(authRef);
  // This account remains bound to the official CLI. Magpie receives its request,
  // while API-key custody only receives accounts for which it must resolve a key.
  const subscription=role===snapshot.roles.planner2&&role.runtime==='codex'&&(member?.provider??role.provider)==='openai'&&
   snapshot.accounts.some(a=>a.authRef===authRef&&a.authentication==='oauth');
  if(role.transport==='magpie'&&!subscription)magpie.add(authRef);
 }
 return{used,magpie};
}
export function resolveCustomAccountSources(snapshot:CustomFlowConfigSnapshot,manifest:unknown|undefined,dshKeyEnv:string,registered?:{accounts:ControllerAccountSource[];contentHash:string}):ControllerAccountSource[]{
 const configured=manifest===undefined?[]:sources(manifest,dshKeyEnv);if(!registered?.accounts.length)return configured;
 const selected=sources({schema:'dream-maker.custom-account-sources.v1',accounts:registered.accounts},dshKeyEnv),{used}=customAccountReferences(snapshot);
 // Fully validate old metadata first. Unused legacy aliases may refer to the same source;
 // two selected independent account identities may not silently share a credential.
 // A registered ref can name the same credential already pinned in v2. Keep its
 // explicit authority only when every credential identity field agrees.
 const remaining=selected.filter(current=>!configured.some(source=>source.capabilities&&
  source.provider===current.provider&&source.authentication===current.authentication&&source.authRef===current.authRef&&
  source.accountRef===current.accountRef&&source.secretEnv===current.secretEnv));
 const retained=configured.filter(old=>old.capabilities||!remaining.some(current=>
  hash(old)===hash(current)||old.secretEnv===current.secretEnv&&!used.has(old.authRef)));
 return validateAccountSourceList([...retained,...remaining],dshKeyEnv);
}
export function observeCustomAccountSources(snapshot:CustomFlowConfigSnapshot,manifest:unknown|undefined,manifestHash:string|null,dshKeyEnv:string,getSecret:(name:string)=>string|undefined,registered?:{accounts:ControllerAccountSource[];contentHash:string},authority:AccountProbeAuthority=NO_ACCOUNT_PROBE_AUTHORITY):CustomAccountSourcesView {
 const catalog=resolveCustomAccountSources(snapshot,manifest,dshKeyEnv,registered),{used,magpie}=customAccountReferences(snapshot);
 // Parse the complete manifest before the first credential lookup, including unused entries.
 for(const source of catalog)registerCredentialEnv(source.secretEnv);
 const selectedSecrets:string[]=[];
 try{const accounts=snapshot.accounts.filter(a=>used.has(a.authRef)).map(account=>{
  const view={authRef:account.authRef,accountRef:account.accountRef,provider:account.provider,authentication:account.authentication};
  const status=(status:CustomAccountSourcesView['accounts'][number]['status'])=>({...view,status});
  if(snapshot.privacy.deniedProviders.includes(account.provider))return status('POLICY_DENIED');
  if(!magpie.has(account.authRef))return status('NATIVE_RUNTIME_MANAGED');
  if(account.authentication!=='api_key')return status('AUTHENTICATION_NOT_SUPPORTED');
  const source=catalog.find(s=>s.authRef===account.authRef);
  if(account.provider!=='deepseek-official'&&account.provider!=='string'&&!source?.capabilities)return status('PROVIDER_NOT_SUPPORTED');
  if(!source)return status('SOURCE_NOT_CONFIGURED');
  if(source.accountRef!==account.accountRef||source.provider!==account.provider||source.authentication!==account.authentication)return status('SOURCE_MISMATCH');
  let key:unknown;try{key=getSecret(source.secretEnv);}catch{return status('SOURCE_UNAVAILABLE');}
  if(key===undefined||key==='')return status('SECRET_MISSING');
  if(typeof key==='string')selectedSecrets.push(key);
  const valid=typeof key==='string'&&/^[\x21-\x7e]{8,512}$/.test(key);key=undefined;
  return status(valid?'AVAILABLE_UNVERIFIED':'SECRET_INVALID');
 });
 const result:CustomAccountSourcesView={schema:'dream-maker.custom-account-sources-observation.v1',projectId:snapshot.projectId,flowConfigHash:hash(snapshot),sourceManifestHash:manifestHash,...(registered?.accounts.length?{sourceBindingHash:registered.contentHash}:{}),accounts,accountVerified:authority.verifiedEveryMetered(accounts),modelVerified:false,runtimeStarted:false,executionGranted:false};
 if(withExplicitSecretInspection(selectedSecrets,()=>hasSecret(JSON.stringify(result))))throw new DomainError('CUSTOM_ACCOUNT_SECRET_IN_OBSERVATION',409);
 return result;
 }finally{selectedSecrets.fill('');}
}
