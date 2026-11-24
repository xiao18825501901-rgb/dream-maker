import type {CustomFlowProfile,CustomRoleProfile,FlowProfileVersion} from '../shared/flow-profile.js';
import {UiError,newId} from './contracts.js';
export interface CustomWizard {
 schema:'dream-maker.custom-wizard-draft.v1';projectId:string;baseRevision:number;baseHash:string|null;step:number;
 configuration:CustomFlowProfile;money:{project:string;roles:Record<string,string>};
 /** Legacy embedded attempts remain readable; new attempts use a bounded, project-owned reference. */
 pendingAttempt?:{baseRevision:number;key:string}|{baseRevision:number;configuration:CustomFlowProfile};
}
export type WizardItem='account'|'executor'|'group'|'member';
function error(message:string):never {throw new UiError('CUSTOM_CONFIGURATION_INVALID',message);}
export const wizardRoles=(s:CustomWizard)=>[s.configuration.roles.planner2,...s.configuration.roles.executors,s.configuration.roles.reviewer];
export const roleTitle=(s:CustomWizard,r:CustomRoleProfile)=>r.id==='planner2'?'工程规划':r.id==='reviewer'?'独立审查':'执行器 '+(s.configuration.roles.executors.findIndex(x=>x.id===r.id)+1);
export function amountText(value:number):string {const n=BigInt(value);return String(n/1000000n)+(n%1000000n?'.'+String(n%1000000n).padStart(6,'0').replace(/0+$/,''):'');}
export function moneyMicros(value:string):number {
 if(!/^\d{1,7}(?:\.\d{1,6})?$/.test(value))return error('金额请填写非负数字，最多六位小数；不要使用逗号或科学计数法。');
 const [whole,part='']=value.split('.'),n=BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0'));
 if(n>1000000000000n)return error('金额超过本机配置允许的上限。');return Number(n);
}
const freshAccount=()=>{const id=newId();return {provider:'github',authentication:'oauth' as const,authRef:'dm-auth-'+id,accountRef:'dm-account-'+id,label:'待连接的 GitHub 账户'};};
function role(id:string,account:CustomFlowProfile['accounts'][number],write:boolean,dreamflow=false):CustomRoleProfile {
 return {id,provider:account.provider,authentication:account.authentication,authRef:account.authRef,accountRef:account.accountRef,runtime:dreamflow?'dsh':'copilot-sdk',model:{kind:'model',id:''},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:0}};
}
export function createWizard(projectId:string,version:Pick<FlowProfileVersion,'projectId'|'revision'|'contentHash'|'configuration'>|null,dreamflow=false):CustomWizard {
 const account=freshAccount();
 const configuration:CustomFlowProfile=version?structuredClone(version.configuration):{mode:'custom',laya:false,accounts:[account],roles:{planner2:role('planner2',account,false,dreamflow),executors:[role('executor-1',account,true,dreamflow)],reviewer:role('reviewer',account,false,dreamflow)},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:0},timeZone:'Asia/Shanghai'};
 const state:CustomWizard={schema:'dream-maker.custom-wizard-draft.v1',projectId,baseRevision:version?.revision??0,baseHash:version?.contentHash??null,step:0,configuration,money:{project:amountText(configuration.budget.maxMicros),roles:{}}};
 for(const r of wizardRoles(state))state.money.roles[r.id]=amountText(r.budget.maxMicros);return state;
}
const numbered=(used:string[],prefix:string,max:number)=>{for(let i=1;i<=max;i++)if(!used.includes(prefix+i))return prefix+i;return error('已达到本机允许的数量，请先减少配置。');};
export function addWizardItem(s:CustomWizard,kind:WizardItem,index=0,dreamflow=false):void {
 const c=s.configuration;
 if(kind==='account'){if(c.accounts.length>=128)error('账户意向已达128项。');c.accounts.push(freshAccount());}
 if(kind==='executor'){if(c.roles.executors.length>=64)error('执行器已达64个。');const id=numbered(wizardRoles(s).map(r=>r.id),'executor-',64),r=role(id,c.accounts[0],true,dreamflow);r.budget.currency=c.budget.currency;c.roles.executors.push(r);s.money.roles[id]='0';}
 if(kind==='group'){if(c.groups.length>=16)error('备用组已达16组。');const a=c.accounts[0];c.groups.push({id:numbered(c.groups.map(g=>g.id),'group-',16),strategy:'failure_only',members:[{id:'member-1',provider:a.provider,model:'',authRef:a.authRef,accountRef:a.accountRef,permissions:['source_read']}]});}
 if(kind==='member'){const g=c.groups[index];if(!g||g.members.length>=24)error('备用组不存在或已达24个成员。');const a=c.accounts[0];g.members.push({id:numbered(g.members.map(m=>m.id),'member-',24),provider:a.provider,model:'',authRef:a.authRef,accountRef:a.accountRef,permissions:['source_read']});}
}
export function removeWizardItem(s:CustomWizard,kind:WizardItem,index:number,member=0):void {
 const c=s.configuration;
 if(kind==='account'){const a=c.accounts[index];if(!a||c.accounts.length<=1||wizardRoles(s).some(r=>r.authRef===a.authRef)||c.groups.some(g=>g.members.some(m=>m.authRef===a.authRef)))error('此账户仍被角色或备用组使用，请先调整选择。');c.accounts.splice(index,1);}
 if(kind==='executor'){if(c.roles.executors.length<=1||!c.roles.executors[index])error('至少保留一个执行器。');delete s.money.roles[c.roles.executors[index].id];c.roles.executors.splice(index,1);}
 if(kind==='group'){const g=c.groups[index];if(!g||wizardRoles(s).some(r=>r.model.kind==='group'&&r.model.id===g.id))error('此备用组仍被角色使用，请先改选模型。');c.groups.splice(index,1);}
 if(kind==='member'){const g=c.groups[index],removed=g?.members[member];if(!g||g.members.length<=1||!removed)error('每个备用组至少保留一个成员。');g.members.splice(member,1);for(const r of wizardRoles(s))if(r.model.kind==='group'&&r.model.id===g.id&&r.selectedMemberId===removed.id)delete r.selectedMemberId;}
}
const value=(data:Pick<FormData,'get'>,key:string,fallback:string)=>{const x=data.get(key);return x===null?fallback:String(x);};
const split=(text:string)=>[...new Set(text.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean))];
export interface DesktopModel {id:string;provider:string;kind:'provider'|'alias';protocols:string[]}
export function catalogModelId(row:DesktopModel,provider:string):string|undefined {
 if(row.kind!=='provider'||row.provider!==provider||!row.id.startsWith(provider+'/'))return;
 const model=row.id.slice(provider.length+1);
 return ref(model,true)?model:undefined;
}
function selectedModel(data:Pick<FormData,'get'>,field:string,manual:string,provider:string,catalog?:readonly DesktopModel[]):string {
 if(!catalog)return manual;
 const id=data.get(field);
 if(!id)return manual;
 const row=catalog.find(entry=>entry.id===id),model=row&&catalogModelId(row,provider);
 if(!model)error('所选目录条目与当前账户的模型服务不匹配，请重新选择。');
 return model;
}
/** Clone first: a failed field edit cannot replace the last safe in-memory or stored draft. */
export function applyWizardFields(state:CustomWizard,data:Pick<FormData,'get'>,catalog?:readonly DesktopModel[]):CustomWizard {
 const s=structuredClone(state),c=s.configuration;
 if(s.step===0)c.accounts.forEach((a,i)=>{
  const before={...a},selected=value(data,'account-provider-'+i,a.provider),other=value(data,'account-other-'+i,a.provider);
  a.provider=selected==='other'?other.trim():selected;a.authentication=value(data,'account-auth-'+i,a.authentication) as typeof a.authentication;a.label=value(data,'account-label-'+i,a.label??a.provider).trim();
  if(a.provider!==before.provider||a.authentication!==before.authentication){
    for(const r of wizardRoles(s))if(r.authRef===a.authRef){r.provider=a.provider;r.authentication=a.authentication;r.model={kind:'model',id:''};delete r.selectedMemberId;}
   for(const g of c.groups)for(const m of g.members)if(m.authRef===a.authRef){m.provider=a.provider;m.model='';}
  }
 });
 if(s.step===1)wizardRoles(s).forEach((r,i)=>{
  const account=c.accounts.find(a=>a.authRef===value(data,'role-account-'+i,r.authRef));if(!account)error('请为每个角色选择一个已列出的账户意向。');
  const changed=r.authRef!==account.authRef;r.provider=account.provider;r.authentication=account.authentication;r.authRef=account.authRef;r.accountRef=account.accountRef;
  const runtime=value(data,'role-runtime-'+i,r.runtime);r.runtime=(runtime==='other'?value(data,'role-runtime-other-'+i,r.runtime):runtime).trim();
  const kind=value(data,'role-kind-'+i,r.model.kind);r.model=changed?{kind:'model',id:''}:{kind:kind as 'model'|'group',id:value(data,kind==='group'?'role-group-'+i:'role-model-'+i,r.model.id).trim()};
  if(!changed&&r.model.kind==='model'&&value(data,'role-transport-'+i,r.transport)==='magpie')r.model.id=selectedModel(data,'role-catalog-'+i,r.model.id,r.provider,catalog);
  if(r.model.kind==='group'){
    const group=c.groups.find(g=>g.id===r.model.id),submitted=data.get('role-member-'+i),member=submitted===null?(r.selectedMemberId??''):String(submitted);
   if(member&&group?.members.some(m=>m.id===member))r.selectedMemberId=member;else delete r.selectedMemberId;
  }else delete r.selectedMemberId;
  r.transport=value(data,'role-transport-'+i,r.transport) as typeof r.transport;r.nativeException=r.transport==='native'&&data.get('role-native-'+i)==='on';
  r.permissions=r.id==='planner2'||r.id==='reviewer'||data.get('role-write-'+i)!=='on'?['source_read']:['source_read','source_write'];
 });
 if(s.step===2){
  const currency=value(data,'profile-currency',c.budget.currency) as 'CNY'|'USD';c.budget.currency=currency;s.money.project=value(data,'profile-budget',s.money.project).trim();c.timeZone=value(data,'profile-timezone',c.timeZone).trim();
  wizardRoles(s).forEach((r,i)=>{r.budget.currency=currency;s.money.roles[r.id]=value(data,'role-budget-'+i,s.money.roles[r.id]).trim();});
  c.privacy.deniedProviders=split(value(data,'denied-providers',c.privacy.deniedProviders.join(', ')));c.privacy.deniedDataLabels=split(value(data,'denied-labels',c.privacy.deniedDataLabels.join(', ')));
  c.groups.forEach((g,i)=>{g.strategy=value(data,'group-strategy-'+i,g.strategy) as typeof g.strategy;g.members.forEach((m,j)=>{
   const a=c.accounts.find(a=>a.authRef===value(data,`member-account-${i}-${j}`,m.authRef));if(!a)error('备用模型的账户意向已改变，请重新选择。');
   const changed=m.authRef!==a.authRef;
   m.provider=a.provider;m.authRef=a.authRef;m.accountRef=a.accountRef;
   m.model=changed&&catalog?'':selectedModel(data,`member-catalog-${i}-${j}`,value(data,`member-model-${i}-${j}`,m.model).trim(),a.provider,catalog);
   m.permissions=[];if(data.get(`member-read-${i}-${j}`)==='on')m.permissions.push('source_read');if(data.get(`member-write-${i}-${j}`)==='on')m.permissions.push('source_write');
  });});
 }
 assertDraftSafe(s);return s;
}
function ref(v:unknown,model=false):boolean{return typeof v==='string'&&(model?/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/:/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/).test(v)&&!v.includes('://');}
function assertDraftSafe(value:unknown):void {
 let serialized:string;try{serialized=JSON.stringify(value);}catch{return error('配置草稿无法保存，请保留当前输入后重新核对。');}
 if(new TextEncoder().encode(serialized).length>120000)error('配置草稿过大，请减少角色或备用模型。');
 if(/(?:\b(?:sk|dsk)-[A-Za-z0-9_-]{8,}|\bgh[opusr]_[A-Za-z0-9_]+|\bgithub_pat_[A-Za-z0-9_]+|\bBearer\s|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN .*PRIVATE KEY-----)/i.test(serialized))error('这里不能保存密钥或登录信息；请删除误填内容，账户授权须单独进行。');
 const visit=(v:unknown,depth:number)=>{if(depth>12)error('配置层级无效。');if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(['__proto__','prototype','constructor'].includes(k)||/^(api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|client[_-]?secret|private[_-]?key)$/i.test(k))error('配置中不能保存凭据。');visit(x,depth+1);}};visit(value,0);
}
export function validateWizardStep(s:CustomWizard,step=s.step):void {
 assertDraftSafe(s);const c=s.configuration;
 if(!c.accounts.length||c.accounts.length>128||c.accounts.some(a=>!ref(a.provider)||!['oauth','api_key'].includes(a.authentication)||!ref(a.authRef)||!ref(a.accountRef)||a.label!==undefined&&(!a.label.trim()||a.label.length>60||/[\x00-\x1f\x7f]/.test(a.label))))error('请填写有效的模型服务、认证方式和账户称呼；这里不接收网址或密钥。');
 if(step>=1){
  if(c.roles.executors.length<1||c.roles.executors.length>64)error('请保留1至64个执行器。');
  for(const r of wizardRoles(s)){
   if(!ref(r.runtime)||!ref(r.model.id,r.model.kind==='model'))error('请为每个角色填写计划使用的模型和运行器，不能填写运行文件路径。');
   if(r.model.kind==='group'){
    const group=c.groups.find(g=>g.id===r.model.id);
    if(!group)error('请选择已有备用组，或改为指定模型。');
    if(!r.selectedMemberId||!group.members.some(m=>m.id===r.selectedMemberId))error('使用备用组的角色必须明确选择本轮起始成员，不能默认使用第一个候选。');
   }else if(r.selectedMemberId!==undefined)error('指定模型的角色不能同时携带备用组成员选择。');
   if(r.transport==='native'&&(!r.nativeException||r.model.kind!=='model'))error('原生路径例外需要单独确认，并指定一个模型。');
  }
 }
 if(step>=2)wizardConfiguration(s);
}
export function wizardConfiguration(s:CustomWizard):CustomFlowProfile {
 validateWizardStep(s,1);const c=structuredClone(s.configuration),cap=moneyMicros(s.money.project);c.budget.maxMicros=cap;
 if(!['CNY','USD'].includes(c.budget.currency))error('请选择人民币或美元。');
 for(const r of [c.roles.planner2,...c.roles.executors,c.roles.reviewer]){r.budget.maxMicros=moneyMicros(s.money.roles[r.id]);r.budget.currency=c.budget.currency;if(r.budget.maxMicros>cap)error('每个角色的费用上限不能高于项目配置上限。');
  if(c.privacy.deniedProviders.includes(r.provider))error('当前选择包含已禁止的模型服务，请调整账户或隐私限制。');}
 try{new Intl.DateTimeFormat('zh-CN',{timeZone:c.timeZone});}catch{return error('时区无效，请使用例如 Asia/Shanghai。');}
 for(const g of c.groups){
  const users=[c.roles.planner2,...c.roles.executors,c.roles.reviewer].filter(r=>r.model.kind==='group'&&r.model.id===g.id);
  if(!users.length)error('有备用组尚未分配给角色，请先分配或移除。');
  if(!g.members.length||g.members.length>24||g.members.some(m=>!ref(m.model,true)||!c.accounts.some(a=>a.authRef===m.authRef&&a.accountRef===m.accountRef&&a.provider===m.provider)||c.privacy.deniedProviders.includes(m.provider)||users.some(r=>m.permissions.some(p=>!r.permissions.includes(p)))))error('请核对备用组的模型、账户范围与读写权限；规划和审查不能获得写权限。');
 }
 if(new TextEncoder().encode(JSON.stringify(c)).length>100000)error('配置超过本地保存上限，请减少候选模型或执行器；原草稿保留。');return c;
}
/** UI-only projection of the explicitly selected group member. It never grants execution. */
export function resolvedWizardRole(s:CustomWizard,r:CustomRoleProfile):CustomRoleProfile {
 if(r.model.kind==='model'){const out=structuredClone(r);delete out.selectedMemberId;return out;}
 const group=s.configuration.groups.find(g=>g.id===r.model.id),member=group?.members.find(m=>m.id===r.selectedMemberId),account=member&&s.configuration.accounts.find(a=>a.provider===member.provider&&a.authRef===member.authRef&&a.accountRef===member.accountRef);
 if(!member||!account)error('请先为使用备用组的角色明确选择本轮起始成员。');
 return{...structuredClone(r),provider:member.provider,authentication:account.authentication,authRef:member.authRef,accountRef:member.accountRef,model:{kind:'model',id:member.model},permissions:[...member.permissions],selectedMemberId:member.id};
}
export function serializeWizard(s:CustomWizard):string {assertDraftSafe(s);return JSON.stringify(s);}
export function restoreWizard(raw:string,projectId:string):CustomWizard|null {
 try{
  // Recover the editable draft independently from a damaged/oversized historical snapshot.
  if(raw.length>512000)return null;const s=JSON.parse(raw) as CustomWizard,pending=s.pendingAttempt;delete s.pendingAttempt;
  if(s.schema!=='dream-maker.custom-wizard-draft.v1'||s.projectId!==projectId||!Number.isInteger(s.step)||s.step<0||s.step>3||!Number.isInteger(s.baseRevision)||s.baseRevision<0||s.baseRevision>128||!(s.baseHash===null||/^[a-f0-9]{64}$/.test(s.baseHash)))return null;
  const c=s.configuration;if(c.mode!=='custom'||c.laya!==false||!Array.isArray(c.accounts)||!Array.isArray(c.roles.executors)||!Array.isArray(c.groups)||c.groups.length>16||c.roles.executors.length>64||c.accounts.length>128||!Array.isArray(c.privacy.deniedProviders)||!Array.isArray(c.privacy.deniedDataLabels))return null;
  if(wizardRoles(s).some(r=>!r||!ref(r.id)||typeof r.model?.id!=='string'||r.selectedMemberId!==undefined&&!ref(r.selectedMemberId)||typeof r.runtime!=='string'||!Array.isArray(r.permissions)||!r.budget)||c.groups.some(g=>!ref(g.id)||!Array.isArray(g.members)||g.members.length>24||g.members.some(m=>!m||typeof m.model!=='string'||!Array.isArray(m.permissions))))return null;
  if(typeof s.money.project!=='string'||wizardRoles(s).some(r=>typeof s.money.roles[r.id]!=='string'))return null;
  validateWizardStep(s,0);
  if(pending){
   try{
    if(!Number.isInteger(pending.baseRevision)||pending.baseRevision<0||pending.baseRevision>128)throw Error('PENDING_BASE_INVALID');
    if('key' in pending){if(typeof pending.key!=='string'||pending.key.length>180)throw Error('PENDING_KEY_INVALID');s.pendingAttempt={baseRevision:pending.baseRevision,key:pending.key};}
    else {
     const check=createWizard(projectId,{projectId,revision:pending.baseRevision,contentHash:'0'.repeat(64),configuration:pending.configuration});
     if(!restoreWizard(serializeWizard(check),projectId)||!sameConfiguration(wizardConfiguration(check),pending.configuration))throw Error('PENDING_CONFIGURATION_INVALID');
     s.pendingAttempt={baseRevision:pending.baseRevision,configuration:pending.configuration};
    }
    assertDraftSafe(s);
   }catch{s.pendingAttempt={baseRevision:s.baseRevision,key:'unverified-pending-snapshot'};}
  }
  return s;
 }catch{return null;}
}
export function readFlowProfile(raw:unknown,projectId:string):FlowProfileVersion|null {
 const response=raw as {current?:FlowProfileVersion|null};if(!response||!Object.hasOwn(response,'current'))error('本地配置响应不完整，请重新读取。');
 const v=response.current;if(v===null)return null;
 if(!v||v.schema!=='dream-maker.custom-profile-version.v1'||v.projectId!==projectId||!Number.isInteger(v.revision)||v.revision<1||v.revision>128||!/^[a-f0-9]{64}$/.test(v.contentHash)||v.scope!=='CONFIGURATION_ONLY'||v.serviceIdentity!=='NOT_VERIFIED'||v.executionGranted!==false)error('本地配置版本无法核对，尚未替换草稿。');
 const state=createWizard(projectId,v);if(!restoreWizard(serializeWizard(state),projectId))error('本地配置内容无法核对，尚未替换草稿。');wizardConfiguration(state);return structuredClone(v);
}
export function sameConfiguration(a:CustomFlowProfile,b:CustomFlowProfile):boolean {
 const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
 return canonical(a)===canonical(b);
}
