import type {CustomRoleCheckView} from '../shared/custom-role-check.js';
import type {InspectCustomAccountSources} from '../shared/custom-account-sources.js';
import type {CustomRoleProfile} from '../shared/flow-profile.js';
import {UiError,newId,escapeHtml as e,type UiAdapter} from './contracts.js';
import {readAccountCheckPreparation,sameAccountCheckSelection} from './magpie-account-check-view.js';
interface Drafts {get(key:string):string;set(key:string,value:string):boolean;delete(key:string):void;getRequired?(key:string):string;setRequired?(key:string,value:string):boolean;deleteRequired?(key:string,expectedValue?:string):boolean;withRequiredLock?<T>(key:string,work:()=>Promise<T>):Promise<T>}
export interface RoleCheckContext {projectId:string;specHash:string;profileHash:string;current():boolean}
interface Pending {schema:'dream-maker.custom-role-pending.v1';requestId:string;selection:InspectCustomAccountSources;configurationHash:string;roleId:string}
const fail=(message='角色记录未能完整核对。原设置和待核对记录保留，没有重新执行。'):never=>{throw new UiError('CUSTOM_CONFIGURATION_INVALID',message);};
function waitFor<T>(invoke:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
 const stopped=()=>new UiError('NETWORK_UNCERTAIN','已停止等待页面响应，原调用记录仍保留；请读取原记录核对，不要重复执行。');
 if(signal?.aborted)return Promise.reject(stopped());const work=invoke();if(!signal)return work;
 return new Promise<T>((resolve,reject)=>{const abort=()=>{cleanup();reject(stopped());},cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});work.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});if(signal.aborted)abort();});
}
function exact(raw:unknown,keys:string[]):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();const d=Object.getOwnPropertyDescriptors(raw);
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!Object.hasOwn(d[k],'value')))return fail();
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function selection(raw:unknown):InspectCustomAccountSources{
 const v=exact(raw,['projectId','specHash','profileHash','preparation']),p=exact(v.preparation,['identityHash','contentHash']);
 if(typeof v.projectId!=='string'||!v.projectId||!digest(v.specHash)||!digest(v.profileHash)||!digest(p.identityHash)||!digest(p.contentHash))return fail();
 return{projectId:v.projectId,specHash:v.specHash,profileHash:v.profileHash,preparation:{identityHash:p.identityHash,contentHash:p.contentHash}};
}
export function readCustomRoleCheck(raw:unknown,expected:InspectCustomAccountSources,roleId:string,configurationHash:string):CustomRoleCheckView{
 const v=exact(raw,['schema','projectId','role','roleId','selection','configurationHash','status','checkedAt','evidenceId','model','executionGranted','fourRoleLive']);
 if(v.schema!=='dream-maker.custom-role-check.v1'||v.projectId!==expected.projectId||v.roleId!==roleId||!['planner2','executor','reviewer'].includes(String(v.role))||!sameAccountCheckSelection(selection(v.selection),expected)||v.configurationHash!==configurationHash||!digest(v.configurationHash)||v.executionGranted!==false||v.fourRoleLive!=='NOT_RUN')return fail();
 if(!['NOT_RUN','RUNNING','PASSED_MINIMUM','FAILED','FAILED_NO_EFFECT','UNCERTAIN','NOT_CURRENT','NOT_ADMITTED'].includes(String(v.status)))return fail();
 if(v.checkedAt!==null&&(typeof v.checkedAt!=='string'||v.checkedAt.length>40||!Number.isFinite(Date.parse(v.checkedAt))||new Date(v.checkedAt).toISOString()!==v.checkedAt))return fail();
 if(v.status==='PASSED_MINIMUM'){
  if(!v.checkedAt||typeof v.evidenceId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(v.evidenceId)||typeof v.model!=='string'||!(/^[A-Za-z0-9_.:/-]{1,200}$/).test(v.model))return fail();
 }else if(v.evidenceId!==null||v.model!==null||v.status==='NOT_RUN'&&v.checkedAt!==null)return fail();
 return structuredClone(v) as unknown as CustomRoleCheckView;
}
const sameContext=(s:InspectCustomAccountSources,c:RoleCheckContext)=>s.projectId===c.projectId&&s.specHash===c.specHash&&s.profileHash===c.profileHash;
/** Form protocol only. All dispatch, signature, spending and cleanup authority stays in Engine. */
export class CustomRoleChecks {
 private views=new Map<string,CustomRoleCheckView>();
 private recovery?:CustomRoleCheckView;private waitController?:AbortController;
 constructor(private adapter:Pick<UiAdapter,'request'>,private drafts:Drafts){}
 cancelWait():void{this.waitController?.abort();}
 reset():void{this.cancelWait();this.views.clear();this.recovery=undefined;}
 private async withWait<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.waitController)return fail('已有一次读取或验证尚待核对，请先关闭旧等待。');
  const controller=new AbortController();this.waitController=controller;const timer=setTimeout(()=>controller.abort(),450000);
  try{return await waitFor(()=>work(controller.signal),controller.signal);}
  finally{clearTimeout(timer);if(this.waitController===controller)this.waitController=undefined;}
 }
 private key(pid:string){return'custom-role-pending:'+pid;}
 private retained(pid:string):string{return this.drafts.getRequired?.(this.key(pid))||this.drafts.get(this.key(pid));}
 private pending(pid:string):Pending|null{
  const raw=this.retained(pid);if(!raw)return null;if(raw.length>5000)return fail();
  let value;try{value=JSON.parse(raw);}catch{return fail();}
  const v=exact(value,['schema','requestId','selection','configurationHash','roleId']),s=selection(v.selection);
  if(v.schema!=='dream-maker.custom-role-pending.v1'||typeof v.requestId!=='string'||!(/^[a-f0-9-]{36}$/).test(v.requestId)||s.projectId!==pid||!digest(v.configurationHash)||typeof v.roleId!=='string'||!(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/).test(v.roleId))return fail();
  return{schema:v.schema,requestId:v.requestId,selection:s,configurationHash:v.configurationHash,roleId:v.roleId};
 }
 private async status(c:RoleCheckContext,roleId:string,s:InspectCustomAccountSources,configurationHash:string,requestId?:string,signal?:AbortSignal,alreadyLocked=false){
  const raw=await waitFor(()=>this.adapter.request('/projects/'+encodeURIComponent(c.projectId)+'/flow-role-status','POST',{specHash:s.specHash,profileHash:s.profileHash,preparation:s.preparation,roleId,...(requestId?{requestId}:{})}),signal);
  if(!c.current())return;
  const view=readCustomRoleCheck(raw,s,roleId,configurationHash);
  this.views.set(roleId,view);
  if(requestId&&(view.status==='PASSED_MINIMUM'||view.status==='FAILED'||view.status==='FAILED_NO_EFFECT'||view.status==='NOT_ADMITTED')){
   const settle=async()=>{if(!c.current()||signal?.aborted)return;const pending=this.pending(c.projectId);if(pending&&pending.roleId===roleId&&requestId===pending.requestId&&sameAccountCheckSelection(pending.selection,s)&&pending.configurationHash===configurationHash){
    if(!this.drafts.deleteRequired?.(this.key(c.projectId),JSON.stringify(pending)))return fail('原结果已经读取，但本机待核对记录尚未清理；没有重新调用模型。');this.drafts.delete(this.key(c.projectId));
   }};
   if(alreadyLocked)await settle();else if(this.drafts.withRequiredLock)await this.drafts.withRequiredLock(this.key(c.projectId),settle);else return fail('原记录已读取，但浏览器暂不能安全核清待办；原引用保留。');
  }
  return view;
 }
 async read(c:RoleCheckContext,roleId:string):Promise<void>{
  return this.withWait(signal=>this.readOnce(c,roleId,signal));
 }
 private async readOnce(c:RoleCheckContext,roleId:string,signal:AbortSignal):Promise<void>{
  if(!c.current())return;const pending=this.pending(c.projectId);
  if(pending){
   if(pending.roleId!==roleId)return fail('上一次角色验证尚未核清，请先读取那个角色的记录。没有开始新的调用。');
   await this.status(c,roleId,pending.selection,pending.configurationHash,pending.requestId,signal);return;
  }
  const prepared=readAccountCheckPreparation(await waitFor(()=>this.adapter.request('/projects/'+encodeURIComponent(c.projectId)+'/flow-preparation','POST',{specHash:c.specHash,profileHash:c.profileHash}),signal),c.projectId,c.specHash,c.profileHash);
  if(!c.current())return;await this.status(c,roleId,prepared.selection,prepared.flowConfigHash,undefined,signal);
 }
 async probe(c:RoleCheckContext,roleId:string,confirmed:boolean):Promise<void>{
  if(!this.drafts.withRequiredLock)return fail('浏览器暂不能安全保留本次验证，请先核对本地存储与浏览器支持。没有调用模型。');
  try{await this.drafts.withRequiredLock(this.key(c.projectId),()=>this.withWait(signal=>this.probeOnce(c,roleId,confirmed,signal)));}
  catch(error){if((error as {code?:unknown})?.code==='REQUIRED_DRAFT_LOCK_UNAVAILABLE')return fail('另一个页面可能正在核对或验证此项目，请先读取原记录。不会并发重复调用。');throw error;}
 }
 private async probeOnce(c:RoleCheckContext,roleId:string,confirmed:boolean,signal:AbortSignal):Promise<void>{
  const prior=this.views.get(roleId);
  if(!c.current()||!prior||!sameContext(prior.selection,c)||!['NOT_RUN','FAILED_NO_EFFECT'].includes(prior.status)||this.retained(c.projectId))return fail('请先读取本角色的记录。结果不明、已验证或存在未核清副作用时，不会重复调用。');
  if(confirmed!==true)return fail('请单独确认这一次角色最小调用及费用范围；这不批准制作项目。');
  const pending:Pending={schema:'dream-maker.custom-role-pending.v1',requestId:newId(),selection:structuredClone(prior.selection),configurationHash:prior.configurationHash,roleId};
  const body=JSON.stringify(pending);if(!this.drafts.setRequired?.(this.key(c.projectId),body)||this.drafts.getRequired?.(this.key(c.projectId))!==body)return fail('未能可靠保存调用前的核对记录，没有发送模型请求。');
  const s=pending.selection;
  const raw=await waitFor(()=>this.adapter.request<{scope:unknown;executionGranted:unknown;fourRoleLive:unknown}>('/projects/'+encodeURIComponent(c.projectId)+'/flow-role-probe','POST',{specHash:s.specHash,profileHash:s.profileHash,preparation:s.preparation,roleId,requestId:pending.requestId,confirmed:true}),signal);
  if(!c.current())return;
  if(raw.scope!=='MINIMUM_ROLE_ONLY'||raw.executionGranted!==false||raw.fourRoleLive!=='NOT_RUN')return fail();
  await this.status(c,roleId,s,pending.configurationHash,pending.requestId,signal,true);
 }
 async readPending(projectId:string,current:()=>boolean):Promise<void>{
  return this.withWait(signal=>this.readPendingOnce(projectId,current,signal));
 }
 private async readPendingOnce(projectId:string,current:()=>boolean,signal:AbortSignal):Promise<void>{
  if(!current())return;const pending=this.pending(projectId);if(!pending)return fail('没有找到可以核对的原调用引用。不会开始新的请求。');
  const result=await this.status({...pending.selection,current},pending.roleId,pending.selection,pending.configurationHash,pending.requestId,signal);if(current()&&!signal.aborted&&result)this.recovery=result;
 }
 panel(c:RoleCheckContext|null,roles:CustomRoleProfile[],enabled:boolean,pending=false,projectId=c?.projectId):string{
  let retained=false,unavailable=false;try{retained=!!projectId&&!!this.retained(projectId);}catch{unavailable=true;}
   const messages:Record<CustomRoleCheckView['status'],string>={NOT_RUN:'尚未进行本角色调用。',RUNNING:'正在排队或验证，请稍后只读取记录。',PASSED_MINIMUM:'最小模型响应已通过；尚未制作或审查项目。',FAILED:'上次验证失败，记录或费用可能已产生；请先核对问题，不会自动重试。',FAILED_NO_EFFECT:'控制端已确认上次在发请求前失败，没有发出模型请求，也没有产生模型费用；可以重新确认一次。',UNCERTAIN:'上次结果或清理尚未核清，不会重复请求。',NOT_CURRENT:'账户来源、模型或运行环境有变化，旧验证已失效；请先重新读取记录并单独确认。没有重新调用模型。',NOT_ADMITTED:'原请求未获受理，没有启动此角色；原请求已关闭，不会迟到执行。解决前置问题后，请重新读取记录并单独确认。'};
  const recovered=this.recovery,recovery=recovered&&recovered.projectId===projectId&&(!c||!sameContext(recovered.selection,c))?`<div><p>原调用的核对结果如下。当前未保存草稿保留，没有获得制作许可。</p><p role="status">${e(messages[recovered.status])}</p></div>`:'';
  return `<section class="notice" aria-label="逐角色最小验证"><h4>分别验证工程角色</h4><p>每次只验证一个角色能否真实回应，不运行项目工具、不批准制作，也不表示四角色联动完成。会使用已明确配置的账户和费用上限；未来修改账户或模型后须重新核对。</p>${recovery}${retained?`<p role="status">有一次角色调用尚待核对。新草稿会保留，请先核对原操作；没有自动重发。</p><button type="button" name="roleRecoveryRead" data-action="custom-role-recover" ${pending?'disabled':''}>核对上次角色调用（不调用模型）</button>`:''}${unavailable?'<p role="status">浏览器暂不能可靠读取验证记录，真实调用保持关闭。请先核对浏览器存储空间与本地会话。</p>':''}${!enabled?'<p>先保存设置、确认项目方案并核对本机交接。当前示例组合为 OpenAI 订阅规划、DSH 制作和独立 API 审查；其他尚未接入的组合不会被启用。具体账户、模型、运行器和权限仍由原服务逐项核对。</p>':''}${roles.map((r,i)=>{
   const value=this.views.get(r.id),v=c&&value&&sameContext(value.selection,c)?value:undefined,title=i===0?'工程规划助手':i===roles.length-1?'独立审查助手':'制作助手 '+i;
   const ready=enabled&&!pending&&!retained&&!unavailable&&(v?.status==='NOT_RUN'||v?.status==='FAILED_NO_EFFECT');
   return `<fieldset class="custom-item"><legend>${e(title)}</legend><p>${e(r.provider)} · ${e(r.model.id)} · ${e(r.runtime)} · 配置上限 ${e(String(r.budget.maxMicros/1000000))} ${e(r.budget.currency)}</p><p role="status">${e(v?messages[v.status]:'请先读取本角色的验证记录。')}</p><div class="actions wrap"><button type="button" data-action="custom-role-read" data-role-id="${e(r.id)}" ${!c||pending?'disabled':''}>读取${e(title)}记录（不调用模型）</button></div><label class="check"><input type="checkbox" name="roleConsent-${e(r.id)}" data-role-allowed="${ready?'true':'false'}" ${ready?'':'disabled'}>我确认只调用一次此角色的已选模型；费用沿用已批准范围，不开始制作项目。</label><button type="button" data-action="custom-role-probe" data-role-id="${e(r.id)}" ${ready?'':'disabled'}>验证${e(title)}（真实模型调用）</button></fieldset>`;
  }).join('')}</section>`;
 }
}
