import type {RegisteredAccountSource,PublicAccountIdentity} from '../shared/registered-account-sources.js';
import type {CustomWizard} from './custom-flow-state.js';import {wizardRoles} from './custom-flow-state.js';import {UiError} from './contracts.js';
const fail=(message='来源结果未能完整核对；原草稿保留，请重新读取。'):never=>{throw new UiError('CUSTOM_CONFIGURATION_INVALID',message);};
export function readRegisteredAccountSource(raw:unknown):RegisteredAccountSource {
 const keys=['schema','id','sourceId','authRef','accountRef','provider','authentication','label','configurationHash','contentHash','status','accountVerified','modelVerified','executionGranted'];
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();const fields=Object.getOwnPropertyDescriptors(raw);
 if(Reflect.ownKeys(fields).length!==keys.length||keys.some(k=>!fields[k]?.enumerable||!Object.hasOwn(fields[k],'value')))return fail();
 const v=raw as Record<string,unknown>,digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 if(v.schema!=='dream-maker.registered-account-source.v1'||v.sourceId!=='CONTROLLER_DSH_SESSION'||typeof v.id!=='string'||!/^account_source_[a-f0-9]{20}$/.test(v.id)||typeof v.authRef!=='string'||!/^controller_auth_[a-f0-9]{20}$/.test(v.authRef)||typeof v.accountRef!=='string'||!/^controller_account_[a-f0-9]{20}$/.test(v.accountRef)||v.provider!=='deepseek-official'||v.authentication!=='api_key'||typeof v.label!=='string'||!v.label.trim()||v.label.length>60||!digest(v.configurationHash)||!digest(v.contentHash)||v.status!=='SELECTED_UNVERIFIED'||typeof v.accountVerified!=='boolean'||v.modelVerified!==false||v.executionGranted!==false)return fail();
 return structuredClone(v) as unknown as RegisteredAccountSource;
}
export function readPublicAccountIdentities(raw:unknown):PublicAccountIdentity[]{
 if(!raw||typeof raw!=='object'||Object.keys(raw).length!==1||!('sources' in raw)||!Array.isArray(raw.sources)||raw.sources.length>160)return fail();
 const auth=new Set<string>(),accounts=new Set<string>();
 const ref=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v)&&!['UNKNOWN','NOT_VERIFIED'].includes(v.toUpperCase());
 return raw.sources.map((row:unknown)=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==4)return fail();
  const {provider,authentication,authRef,accountRef}=row as Record<string,unknown>;
  if(typeof provider!=='string'||!/^[a-z][a-z0-9-]{0,62}$/.test(provider)||provider==='unknown'||authentication!=='api_key'||!ref(authRef)||!ref(accountRef)||auth.has(authRef)||accounts.has(accountRef))return fail();
  auth.add(authRef);accounts.add(accountRef);return {provider,authentication,authRef,accountRef};
 });
}
/** Change references only in an unsaved draft. Models, permissions and budgets stay as selected. */
export function attachRegisteredAccountSource(state:CustomWizard,index:number,source:PublicAccountIdentity):CustomWizard {
 const a=state.configuration.accounts[index];if(!a||a.provider!==source.provider||a.authentication!==source.authentication)return fail('账户意向已变化；来源没有自动应用，请重新核对。');
 if(state.configuration.accounts.some((other,i)=>i!==index&&(other.authRef===source.authRef||other.accountRef===source.accountRef)))return fail('同一来源已经在此方案中。请让角色共用现有账户，不要重复添加。');
 const next=structuredClone(state),account=next.configuration.accounts[index];account.authRef=source.authRef;account.accountRef=source.accountRef;
 for(const role of wizardRoles(next))if(role.authRef===a.authRef&&role.accountRef===a.accountRef&&role.provider===a.provider&&role.authentication===a.authentication){role.authRef=source.authRef;role.accountRef=source.accountRef;}
 for(const group of next.configuration.groups)for(const member of group.members)if(member.authRef===a.authRef&&member.accountRef===a.accountRef&&member.provider===a.provider){member.authRef=source.authRef;member.accountRef=source.accountRef;}
 return next;
}
