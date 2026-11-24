import type {Store} from './store.js';import type {Config} from '../shared/types.js';
import type {RegisteredAccountSource,AccountSourceChoices,RegisterAccountSource} from '../shared/registered-account-sources.js';
import {DomainError,object,hash,id,now,hasSecret} from './security.js';
import type {CustomFlowConfigSnapshot} from '../shared/flow-configuration.js';
import {customAccountReferences,type ControllerAccountSource} from './custom-account-sources.js';
import {NO_ACCOUNT_PROBE_AUTHORITY,type AccountProbeAuthority} from './account-verification.js';
const sourceId='CONTROLLER_DSH_SESSION' as const;
interface Definition {sourceId:typeof sourceId;configurationHash:string;secretEnv:string}
interface SourceRecord {schema:'dream-maker.account-source-record.v1';id:string;sourceId:typeof sourceId;configurationHash:string;authRef:string;accountRef:string;provider:'deepseek-official';authentication:'api_key';label:string;createdAt:string;actor:string;scope:'SOURCE_SELECTION_ONLY';accountVerified:false;modelVerified:false;executionGranted:false;contentHash:string}
interface SelectionRecord {schema:'dream-maker.account-source-selection.v1';operationHash:string;requestHash:string;actor:string;registeredSourceId:string;sourceHash:string;createdAt:string;scope:'SOURCE_SELECTION_ONLY';contentHash:string}
const fail=(code='CUSTOM_ACCOUNT_SOURCE_INTEGRITY'):never=>{throw new DomainError(code,409);};
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const actorValid=(v:unknown)=>typeof v==='string'&&/^local-session:[a-f0-9]{64}$/.test(v);
function exact(raw:unknown,keys:string[]){const v=object(raw),d=Object.getOwnPropertyDescriptors(v);if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!Object.hasOwn(d[k],'value')))return fail();return v;}
export function accountSourceInput(raw:unknown):RegisterAccountSource {
 try{const v=exact(raw,['sourceId','label','confirmed']);if(v.sourceId!==sourceId||v.confirmed!==true||typeof v.label!=='string'||!v.label.trim()||v.label.length>60||/[\x00-\x1f\x7f]/.test(v.label)||hasSecret(v.label)||/\b(?:Bearer\s|gh[opusr]_|github_pat_|eyJ[A-Za-z0-9_-]+\.)|-----BEGIN/i.test(v.label))return fail();return{sourceId,label:v.label.trim(),confirmed:true};}
 catch{return fail('CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID');}
}
/** Source identity is a nonsecret reference definition, independent of model/operator audit. */
export function dshAccountSourceDefinition(config:Config['dsh']):Definition {
 const secretEnv=config.keyEnv;if(typeof secretEnv!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(secretEnv))return fail('CUSTOM_ACCOUNT_SOURCE_CONFIG_REQUIRED');
 return{sourceId,secretEnv,configurationHash:hash({schema:'dream-maker.controller-dsh-source.v1',sourceId,provider:'deepseek-official',authentication:'api_key',secretEnv})};
}
function readSource(raw:unknown):SourceRecord {
 try{const v=exact(raw,['schema','id','sourceId','configurationHash','authRef','accountRef','provider','authentication','label','createdAt','actor','scope','accountVerified','modelVerified','executionGranted','contentHash']);const{contentHash,...body}=v;
  if(v.schema!=='dream-maker.account-source-record.v1'||v.sourceId!==sourceId||typeof v.id!=='string'||!/^account_source_[a-f0-9]{20}$/.test(v.id)||typeof v.authRef!=='string'||!/^controller_auth_[a-f0-9]{20}$/.test(v.authRef)||typeof v.accountRef!=='string'||!/^controller_account_[a-f0-9]{20}$/.test(v.accountRef)||!digest(v.configurationHash)||v.provider!=='deepseek-official'||v.authentication!=='api_key'||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||!actorValid(v.actor)||v.scope!=='SOURCE_SELECTION_ONLY'||v.accountVerified!==false||v.modelVerified!==false||v.executionGranted!==false||hash(body)!==contentHash||hasSecret(JSON.stringify(v)))return fail();
  accountSourceInput({sourceId,label:v.label,confirmed:true});return v as unknown as SourceRecord;
 }catch{return fail();}
}
function view(v:SourceRecord,definition:Definition,authority:AccountProbeAuthority):RegisteredAccountSource{
 const value:RegisteredAccountSource={schema:'dream-maker.registered-account-source.v1',id:v.id,sourceId:v.sourceId,authRef:v.authRef,accountRef:v.accountRef,provider:v.provider,authentication:v.authentication,label:v.label,configurationHash:v.configurationHash,contentHash:v.contentHash,status:v.configurationHash===definition.configurationHash?'SELECTED_UNVERIFIED':'SOURCE_STALE',accountVerified:authority.verified({authRef:v.authRef,accountRef:v.accountRef,provider:v.provider,authentication:v.authentication}),modelVerified:false,executionGranted:false};
 publicProjection(v,definition);publicProjection(value,definition);return value;
}
function publicProjection(value:unknown,definition:Definition):void {
 const body=JSON.stringify(value);if(body.toLowerCase().includes(definition.secretEnv.toLowerCase())||hasSecret(body))return fail('CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID');
}
function readSelection(raw:string):SelectionRecord {
 try{if(raw.length>4096)return fail();const v=exact(JSON.parse(raw),['schema','operationHash','requestHash','actor','registeredSourceId','sourceHash','createdAt','scope','contentHash']),{contentHash,...body}=v;
  if(v.schema!=='dream-maker.account-source-selection.v1'||!digest(v.operationHash)||!digest(v.requestHash)||!actorValid(v.actor)||typeof v.registeredSourceId!=='string'||!/^account_source_[a-f0-9]{20}$/.test(v.registeredSourceId)||!digest(v.sourceHash)||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||v.scope!=='SOURCE_SELECTION_ONLY'||hash(body)!==contentHash||hasSecret(raw))return fail();
  return v as unknown as SelectionRecord;
 }catch{return fail();}
}
/** Only new, exact public metadata kinds in the original Store; no credential or approval storage. */
export class RegisteredAccountSources {
 constructor(private store:Store,private authority:AccountProbeAuthority=NO_ACCOUNT_PROBE_AUTHORITY){}
 private rows():SourceRecord[]{
  const rows=this.store.db.prepare("SELECT data FROM records WHERE project_id IS NULL AND run_id IS NULL AND kind='CustomAccountSourceRegistered' ORDER BY rowid LIMIT 129").all();if(rows.length>128)return fail('CUSTOM_ACCOUNT_SOURCE_REGISTRATION_LIMIT');
  const values=rows.map(r=>{try{return readSource(JSON.parse(String(r.data)));}catch{return fail();}});for(const key of ['id','authRef','accountRef','configurationHash'] as const)if(new Set(values.map(v=>v[key])).size!==values.length)return fail();return values;
 }
 list(definition:Definition):AccountSourceChoices{return{schema:'dream-maker.account-source-choices.v1',choices:[{sourceId,label:'本机 DSH 专用 API 凭据来源',provider:'deepseek-official',authentication:'api_key',accountVerified:false}],sources:this.rows().map(v=>view(v,definition,this.authority))};}
 forProfile(snapshot:CustomFlowConfigSnapshot,definition:Definition):{accounts:ControllerAccountSource[];contentHash:string}{
  const {magpie}=customAccountReferences(snapshot),accounts:ControllerAccountSource[]=[],bindings:string[]=[];
  for(const row of this.rows()){
   const selected=snapshot.accounts.find(a=>magpie.has(a.authRef)&&a.authRef===row.authRef);if(!selected)continue;
   if(selected.accountRef!==row.accountRef||selected.provider!==row.provider||selected.authentication!==row.authentication)return fail('CUSTOM_ACCOUNT_SOURCE_MISMATCH');
   if(row.configurationHash!==definition.configurationHash)return fail('CUSTOM_ACCOUNT_SOURCE_STALE');
   accounts.push({provider:row.provider,authentication:row.authentication,authRef:row.authRef,accountRef:row.accountRef,secretEnv:definition.secretEnv});bindings.push(row.contentHash);
  }
  return{accounts,contentHash:hash(bindings.sort())};
 }
 register(raw:unknown,definition:Definition,actor:string,operationHash:string):RegisteredAccountSource {
  const input=accountSourceInput(raw);if(!actorValid(actor)||!digest(operationHash)||input.label.toLowerCase().includes(definition.secretEnv.toLowerCase()))return fail('CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID');
  return this.store.tx(()=>{
   const rows=this.rows(),requestHash=hash(input),receipts=this.store.db.prepare("SELECT data FROM records WHERE project_id IS NULL AND run_id IS NULL AND kind='CustomAccountSourceSelection' ORDER BY rowid LIMIT 2049").all().map(r=>readSelection(String(r.data)));
   if(receipts.length>2048)return fail('CUSTOM_ACCOUNT_SOURCE_REGISTRATION_LIMIT');if(new Set(receipts.map(r=>r.operationHash)).size!==receipts.length)return fail();
   const receipt=receipts.find(r=>r.operationHash===operationHash);
   if(receipt){
    if(receipt.requestHash!==requestHash||receipt.actor!==actor)return fail('IDEMPOTENCY_KEY_REUSED');
    const saved=rows.find(r=>r.id===receipt.registeredSourceId&&r.contentHash===receipt.sourceHash);if(!saved)return fail();if(saved.configurationHash!==definition.configurationHash)return fail('CUSTOM_ACCOUNT_SOURCE_STALE');return view(saved,definition,this.authority);
   }
   if(receipts.length>=2048)return fail('CUSTOM_ACCOUNT_SOURCE_REGISTRATION_LIMIT');
   let saved=rows.find(r=>r.configurationHash===definition.configurationHash);
   if(!saved){if(rows.length>=128)return fail('CUSTOM_ACCOUNT_SOURCE_REGISTRATION_LIMIT');const body={schema:'dream-maker.account-source-record.v1' as const,id:id('account_source'),sourceId,configurationHash:definition.configurationHash,authRef:id('controller_auth'),accountRef:id('controller_account'),provider:'deepseek-official' as const,authentication:'api_key' as const,label:input.label,createdAt:now(),actor,scope:'SOURCE_SELECTION_ONLY' as const,accountVerified:false as const,modelVerified:false as const,executionGranted:false as const};saved=readSource({...body,contentHash:hash(body)});publicProjection(saved,definition);this.insert('CustomAccountSourceRegistered',saved);}
   const body={schema:'dream-maker.account-source-selection.v1',operationHash,requestHash,actor,registeredSourceId:saved.id,sourceHash:saved.contentHash,createdAt:now(),scope:'SOURCE_SELECTION_ONLY'},receiptBody={...body,contentHash:hash(body)};publicProjection(receiptBody,definition);this.insert('CustomAccountSourceSelection',receiptBody);return view(saved,definition,this.authority);
  });
 }
 private insert(kind:'CustomAccountSourceRegistered'|'CustomAccountSourceSelection',data:unknown){
  // This exact public projection is validated against the selected value and fixed formats.
  // Generic text logging would enumerate unrelated environment credentials during this operation.
  const body=JSON.stringify(data);if(hasSecret(body))return fail('CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID');
  this.store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(id('rec'),kind,null,null,body,now());
 }
}
