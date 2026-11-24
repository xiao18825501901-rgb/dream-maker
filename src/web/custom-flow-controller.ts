import type {FlowProfileVersion} from '../shared/flow-profile.js';
import type {UiAdapter} from './contracts.js';
import {UiError,newId} from './contracts.js';
import {friendlyUiError} from './plain-ui-error.js';
import {customWizardView} from './custom-flow-view.js';
import {readPublicAccountIdentities,readRegisteredAccountSource,attachRegisteredAccountSource} from './registered-account-sources.js';
import {readMagpieAccountCheck,readMagpieAccountRecovery,readAccountCheckPreparation,sameAccountCheckSelection} from './magpie-account-check-view.js';
import type {MagpieAccountCheckView,MagpieAccountRecoveryView} from '../shared/magpie-account-check.js';
import {CustomRoleChecks,type RoleCheckContext} from './custom-role-check.js';
import {createWizard,restoreWizard,serializeWizard,readFlowProfile,sameConfiguration,applyWizardFields,validateWizardStep,wizardConfiguration,addWizardItem,removeWizardItem,wizardRoles,resolvedWizardRole,type DesktopModel,type CustomWizard} from './custom-flow-state.js';
interface Drafts {get(key:string):string;set(key:string,value:string):boolean;delete(key:string):void}
interface Hooks {dreamflow?:boolean;active(projectId:string):boolean;show(html:string,focusName?:string):void;error(message:string):void;saved(version:FlowProfileVersion):void;specHash?:(projectId:string)=>string|null}
/** Frontend form ownership only. All configuration/dispatch authority stays in the original server. */
export class CustomFlowWizard {
 state:CustomWizard|null=null;projectId:string|null=null;needsRecheck=false;
 private generation=0;private pending=false;private latest:FlowProfileVersion|null=null;private conflict=false;private notice='';private errorMessage='';private invalidDraft=false;
 private accountCheckNeedsRead=true;private accountCheckView?:MagpieAccountCheckView;
 private accountRecoveryView?:MagpieAccountRecoveryView;
 private roleChecks:CustomRoleChecks;
 private accountIdentities?:ReturnType<typeof readPublicAccountIdentities>;
 private storedDraft='';
 private magpieModels?:DesktopModel[];
 private fields(state:CustomWizard,data:Pick<FormData,'get'>){return applyWizardFields(state,data,this.hooks.dreamflow?(this.magpieModels??[]):undefined);}
 constructor(private adapter:Pick<UiAdapter,'request'>,private drafts:Drafts,private hooks:Hooks){this.roleChecks=new CustomRoleChecks(adapter,drafts);}
 private key(pid=this.projectId!){return 'custom-profile:'+pid;}
 private previousKey(){return 'custom-profile-previous:'+this.projectId!;}
 private current(ticket:number,pid:string){return ticket===this.generation&&this.projectId===pid&&this.hooks.active(pid);}
 private writeDraft(value:CustomWizard){const bytes=serializeWizard(value);if(!this.drafts.set(this.key(),bytes))throw new UiError('CUSTOM_CONFIGURATION_INVALID','草稿空间不足，输入仍在页面中，请先减少配置或保留当前内容。');this.storedDraft=bytes;}
 private saveDraft(){if(this.state)this.writeDraft(this.state);}
 private render(focusName?:string){
  if(!this.state)return;
  let roleCheckHtml='';
  // An incomplete group selection must remain editable. Back/reload cannot be
  // blocked merely because the optional role-check panel cannot resolve it yet.
  try{roleCheckHtml=this.roleChecks.panel(this.roleContext(),wizardRoles(this.state).map(r=>resolvedWizardRole(this.state!,r)),this.roleCheckEnabled(),this.pending,this.projectId!);}catch{}
  this.hooks.show(customWizardView(this.state,{dreamflow:this.hooks.dreamflow,magpieModels:this.magpieModels,accountIdentities:this.accountIdentities,pending:this.pending,needsRecheck:this.needsRecheck,locked:this.invalidDraft,notice:this.notice,previous:!!this.drafts.get(this.previousKey()),accountCheck:{saved:this.canCheckAccounts(),needsRead:this.accountCheckNeedsRead,view:this.accountCheckView,recovery:this.accountRecoveryView},roleCheckHtml,...(this.conflict?{conflict:this.latest}:{})}),focusName);
  this.hooks.error(this.errorMessage);
 }
 private roleContext():RoleCheckContext|null{
  if(!this.canCheckAccounts()||!this.state||!this.latest)return null;
  const ticket=this.generation,pid=this.projectId!,specHash=this.hooks.specHash!(pid)!,profileHash=this.latest.contentHash,snapshot=serializeWizard(this.state);
  return{projectId:pid,specHash,profileHash,current:()=>this.current(ticket,pid)&&!!this.state&&serializeWizard(this.state)===snapshot&&this.drafts.get(this.key())===snapshot&&this.hooks.specHash?.(pid)===specHash};
 }
 private roleCheckEnabled():boolean{
  if(!this.canCheckAccounts()||!this.state||this.accountCheckNeedsRead||this.accountCheckView?.status!=='PASSED')return false;
  const s=this.accountCheckView.selection;
  return !!s&&s.specHash===this.hooks.specHash?.(this.projectId!)&&s.profileHash===this.latest?.contentHash;
 }
 async checkRole(data:Pick<FormData,'get'>,roleId:string,execute=false):Promise<void>{
  if(!this.state||this.pending||this.invalidDraft)return;const ticket=this.generation,pid=this.projectId!;
  try{
   const next=this.fields(this.state,data);this.writeDraft(next);this.state=next;
   if(!wizardRoles(next).some(r=>r.id===roleId))throw new UiError('CUSTOM_CONFIGURATION_INVALID','角色已经改变，请重新核对已保存的配置。');
   const context=this.roleContext();if(!context)throw new UiError('CUSTOM_CONFIGURATION_INVALID','请先保存当前配置并确认项目方案，再读取角色记录。');
   if(execute&&!this.roleCheckEnabled())throw new UiError('CUSTOM_CONFIGURATION_INVALID','请先读取并完成已选来源的本机交接，核对真实账户、模型和费用。');
   this.pending=true;this.errorMessage='';this.render();
   if(execute)await this.roleChecks.probe(context,roleId,data.get('roleConsent-'+roleId)==='on');else await this.roleChecks.read(context,roleId);
   if(context.current())this.notice='角色记录已读取；最小验证不代表项目制作、项目审查或四角色联动已经完成。';
  }catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render('roleConsent-'+roleId);}}
 }
 async readPendingRole():Promise<void>{
  if(!this.state||this.pending)return;const ticket=this.generation,pid=this.projectId!;this.pending=true;this.errorMessage='';this.render();
  try{await this.roleChecks.readPending(pid,()=>this.current(ticket,pid));if(this.current(ticket,pid))this.notice='只读取了原角色调用记录，新草稿保留，没有重新调用模型。';}
  catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render('roleRecoveryRead');}}
 }
 private canCheckAccounts():boolean {
  const s=this.state,v=this.latest;if(!s||!v||this.invalidDraft||this.needsRecheck||s.baseRevision!==v.revision||s.baseHash!==v.contentHash||!this.hooks.specHash?.(this.projectId!))return false;
  try{return sameConfiguration(wizardConfiguration(s),v.configuration)&&wizardRoles(s).length>0;}catch{return false;}
 }
 private failed(error:unknown){this.errorMessage=error instanceof UiError&&error.code==='CUSTOM_CONFIGURATION_INVALID'?error.message:friendlyUiError(error);this.hooks.error(this.errorMessage);}
 private ownedAttemptKey(key:string):boolean {
  const prefix='custom-profile-attempt:'+this.projectId+':';return key.startsWith(prefix)&&/^[a-f0-9-]{36}$/.test(key.slice(prefix.length));
 }
 private attempt():{baseRevision:number;configuration:FlowProfileVersion['configuration']}|null {
  const pending=this.state?.pendingAttempt;if(!pending||pending.baseRevision!==this.state?.baseRevision)return null;
  if('configuration' in pending)return pending;
  try{
   if(!this.ownedAttemptKey(pending.key))return null;const raw=this.drafts.get(pending.key);if(raw.length>110000)return null;
   const value=JSON.parse(raw);if(value.schema!=='dream-maker.custom-wizard-attempt.v1'||value.projectId!==this.projectId||value.baseRevision!==pending.baseRevision)return null;
   const check=createWizard(this.projectId!,{projectId:this.projectId!,revision:pending.baseRevision,contentHash:'0'.repeat(64),configuration:value.configuration});
   if(!restoreWizard(serializeWizard(check),this.projectId!)||!sameConfiguration(wizardConfiguration(check),value.configuration))return null;
   return {baseRevision:pending.baseRevision,configuration:value.configuration};
  }catch{return null;}
 }
 private retireSnapshot(pending:CustomWizard['pendingAttempt']):void {
  if(pending&&'key' in pending&&this.ownedAttemptKey(pending.key))this.drafts.delete(pending.key);
 }
 private clearAttempt():void {
  if(!this.state)return;const pending=this.state.pendingAttempt,candidate=structuredClone(this.state);delete candidate.pendingAttempt;
  this.writeDraft(candidate);this.state=candidate;this.retireSnapshot(pending);
 }
 private persistAttempt(configuration:FlowProfileVersion['configuration'],baseRevision:number):void {
  if(!this.state)return;
  const key='custom-profile-attempt:'+this.projectId+':'+newId(),candidate=structuredClone(this.state);candidate.pendingAttempt={baseRevision,key};
  // Validate the small draft before replacing active state. The exact submitted snapshot is separate.
  const draft=serializeWizard(candidate),attempt=JSON.stringify({schema:'dream-maker.custom-wizard-attempt.v1',projectId:this.projectId,baseRevision,configuration});
  try{if(!this.drafts.set(key,attempt)||!this.drafts.set(this.key(),draft))throw new UiError('CUSTOM_CONFIGURATION_INVALID','保存前的核对快照未能保留，没有提交请求；当前输入仍可编辑。');}
  catch(error){this.drafts.delete(key);throw error;}
  this.state=candidate;
 }
 private resolveAttempt(version:FlowProfileVersion,closeWhenUnchanged:boolean):void {
  let unchanged=false;
  try{const attempt=this.attempt();unchanged=!!this.state&&!!attempt&&sameConfiguration(wizardConfiguration(this.state),attempt.configuration);}catch{/* Incomplete newer edits must also be retained. */}
  if(!this.state)return;
  const pending=this.state.pendingAttempt,candidate=unchanged?createWizard(this.projectId!,version):structuredClone(this.state);
  candidate.baseRevision=version.revision;candidate.baseHash=version.contentHash;delete candidate.pendingAttempt;
  this.writeDraft(candidate);this.state=candidate;this.retireSnapshot(pending);
  if(unchanged&&closeWhenUnchanged){this.drafts.delete(this.key());this.hooks.saved(version);return;}
  this.latest=version;this.needsRecheck=false;this.conflict=false;this.errorMessage='';
  this.notice=unchanged?'上次配置已在本机保存，结果已核清；不会重新登录账户或开始制作。':'上次配置已保存；之后修改的内容仍是未保存草稿，没有被丢弃或自动提交。';
 }
 cancel(){this.roleChecks.cancelWait();this.generation++;this.pending=false;this.projectId=null;this.state=null;this.latest=null;this.conflict=false;this.needsRecheck=false;this.invalidDraft=false;this.accountCheckNeedsRead=true;this.accountCheckView=undefined;this.accountRecoveryView=undefined;}
 async open(pid:string):Promise<void> {
  this.roleChecks.reset();this.magpieModels=undefined;this.accountIdentities=undefined;
  const ticket=++this.generation;this.projectId=pid;this.state=null;this.pending=true;this.needsRecheck=false;this.conflict=false;this.notice='';this.errorMessage='';this.invalidDraft=false;
  this.accountCheckNeedsRead=true;this.accountCheckView=undefined;this.accountRecoveryView=undefined;
  this.hooks.show('<h2 id="dialog-title">正在读取自定义配置</h2><p>只读取本机保存的版本；不会登录、调用模型或开始制作。</p><button type="button" data-action="custom-close">先返回项目</button>');
  try{
   const latest=readFlowProfile(await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/flow-profile'),pid);if(!this.current(ticket,pid))return;
   const raw=this.drafts.get(this.key()),restored=restoreWizard(raw,pid);this.storedDraft=raw;this.invalidDraft=!!raw&&!restored;
   this.latest=latest;this.state=restored??createWizard(pid,latest,this.hooks.dreamflow);
   if(this.invalidDraft){this.conflict=true;this.needsRecheck=true;this.notice='保留的草稿无法完整读取。现在只显示本机已保存版本，旧草稿尚未覆盖；载入前会先保留原文副本。';return;}
   const attempt=this.attempt();
   if(attempt&&latest?.revision===attempt.baseRevision+1&&sameConfiguration(latest.configuration,attempt.configuration)){
    this.resolveAttempt(latest,false);
   }else{
    this.conflict=this.state.baseRevision!==(latest?.revision??0)||this.state.baseHash!==(latest?.contentHash??null);
    this.needsRecheck=!!this.state.pendingAttempt||this.conflict;
    if(this.conflict)this.notice='服务器已有不同版本。原草稿保留，载入新版本需要你明确选择。';
   }
  }catch(error){if(this.current(ticket,pid)){this.hooks.show('<h2 id="dialog-title">自定义配置暂未读出</h2><p>旧草稿保留，没有开始制作。请先核对本机服务。</p><button type="button" data-action="custom-reload">重新读取</button><button type="button" data-action="custom-close">返回项目</button>');this.failed(error);}}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render();}}
 }
 update(data:Pick<FormData,'get'>,rerender=false,focusName?:string):void {
  if(!this.state||this.pending||this.invalidDraft)return;
  try{
   if(this.accountIdentities&&this.state.step===0&&this.drafts.get(this.key())!==this.storedDraft)throw new UiError('CUSTOM_CONFIGURATION_INVALID','另一页面已修改账户草稿，请重新打开后选择来源。');
   const next=this.fields(this.state,data);this.state=next;this.saveDraft();this.errorMessage='';this.hooks.error('');if(rerender)this.render(focusName);
  }
  catch(error){this.failed(error);}
 }
 async readAccountIdentities():Promise<void>{
  if(!this.hooks.dreamflow||this.state?.step!==0||this.pending||this.invalidDraft)return;
  const ticket=this.generation,pid=this.projectId!,snapshot=serializeWizard(this.state),stored=this.storedDraft;
  this.pending=true;this.accountIdentities=undefined;this.render();
  try{
   const response=await this.adapter.request('/account-sources?identities=1');
   if(!this.current(ticket,pid))return;
   if(!this.state||serializeWizard(this.state)!==snapshot||this.drafts.get(this.key())!==stored)throw new UiError('CUSTOM_CONFIGURATION_INVALID','账户草稿已变化，请重新打开后选择来源。');
   this.accountIdentities=readPublicAccountIdentities(response);this.errorMessage='';
   this.notice=this.accountIdentities.length?'请选择对应的模型服务及 API Key，再选用该账户的来源。':'';
  }catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render();}}
 }
 attachAccountIdentity(data:Pick<FormData,'get'>,index:number,target:string,targetAccount:string,authRef:string,accountRef:string):void{
  if(!this.hooks.dreamflow||this.state?.step!==0||this.pending||this.invalidDraft)return;
  try{
   const source=this.accountIdentities?.find(row=>row.authRef===authRef&&row.accountRef===accountRef);
   const account=this.state.configuration.accounts[index];
   if(!source||!account||account.authRef!==target||account.accountRef!==targetAccount||this.drafts.get(this.key())!==this.storedDraft)throw new UiError('CUSTOM_CONFIGURATION_INVALID','账户或草稿已变化，请重新读取后选择来源。');
   const next=attachRegisteredAccountSource(this.fields(this.state,data),index,source);
   this.writeDraft(next);this.state=next;this.notice='已选用登记来源，账户和模型仍待核验。';this.errorMessage='';this.render('account-label-'+index);
  }catch(error){this.failed(error);}
 }
 async bindDshSource(data:Pick<FormData,'get'>,index:number):Promise<void>{
  if(!this.state||this.pending||this.invalidDraft)return;const ticket=this.generation,pid=this.projectId!;
  try{
   const next=this.fields(this.state,data),account=next.configuration.accounts[index];
   if(!account||account.provider!=='deepseek-official'||account.authentication!=='api_key')throw new UiError('CUSTOM_CONFIGURATION_INVALID','请先明确选择 DeepSeek 官方 API 和 API Key；不会替换 OAuth 意向。');
   if(data.get('sourceConsent-'+index)!=='on')throw new UiError('CUSTOM_CONFIGURATION_INVALID','请先确认使用这台电脑的 DSH 专用凭据来源。');
   this.writeDraft(next);this.state=next;const snapshot=serializeWizard(next);this.pending=true;this.errorMessage='';this.render();
   const response=await this.adapter.request('/account-sources','POST',{sourceId:'CONTROLLER_DSH_SESSION',label:account.label||'我的 DSH 专用来源',confirmed:true});
   if(!this.current(ticket,pid))return;
   if(!this.state||serializeWizard(this.state)!==snapshot||this.drafts.get(this.key())!==snapshot)throw new UiError('CUSTOM_CONFIGURATION_INVALID','来源已登记，但草稿已在另一处更新；没有覆盖，请重新打开核对。');
   const result=response&&typeof response==='object'&&!Array.isArray(response)?response as Record<string,unknown>:{};
   const source=readRegisteredAccountSource(result.source),candidate=attachRegisteredAccountSource(this.state,index,source);
   this.writeDraft(candidate);this.state=candidate;this.notice='已选择本机凭据来源；账户和模型仍未验证，没有开始制作。此处仍是草稿，最后还需确认保存配置。';
  }catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render('account-label-'+index);}}
 }
 async readAccountCheck():Promise<void>{
  if(!this.state||this.pending||this.invalidDraft)return;const ticket=this.generation,pid=this.projectId!;this.pending=true;this.accountRecoveryView=undefined;this.render();
  try{const result=readMagpieAccountCheck(await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/flow-account-check'),pid);if(!this.current(ticket,pid))return;
   const recovery=result.status==='UNCERTAIN'?readMagpieAccountRecovery(await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/flow-account-recovery'),pid):undefined;
   if(!this.current(ticket,pid))return;this.accountCheckView=result;this.accountRecoveryView=recovery;this.accountCheckNeedsRead=result.status==='UNCERTAIN'&&!(recovery?.status==='RECOVERED'&&!recovery.restartRequired);this.errorMessage='';}
  catch(error){if(this.current(ticket,pid)){this.accountCheckNeedsRead=true;this.failed(error);}}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render('accountCheckConsent');}}
 }
 async recoverAccountCheck(data:Pick<FormData,'get'>):Promise<void>{
  const recovery=this.accountRecoveryView;if(!this.state||this.pending||this.invalidDraft||this.accountCheckView?.status!=='UNCERTAIN'||recovery?.status!=='REQUIRED'||recovery.reason==='EVIDENCE_MISSING'||!recovery.targetHash)return;
  const ticket=this.generation,pid=this.projectId!,target=recovery.targetHash;
  try{
   if(data.get('accountRecoveryConsent')!=='on')throw new UiError('CUSTOM_CONFIGURATION_INVALID','请单独允许只读核对组件关闭证据；这不会重新执行任务或调用模型。');
   this.pending=true;this.accountRecoveryView=undefined;this.accountCheckNeedsRead=true;this.errorMessage='';this.render();
   const result=readMagpieAccountRecovery(await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/flow-account-recovery','POST',{expectedTargetHash:target,confirmed:true}),pid);
   if(!this.current(ticket,pid))return;if(result.status!=='RECOVERED'||result.targetHash!==target)throw new UiError('CUSTOM_CONFIGURATION_INVALID','关闭证据尚未对应本次记录，请先重新读取历史。');
   this.accountRecoveryView=result;this.accountCheckNeedsRead=result.restartRequired;this.notice='只核清了组件关闭；原交接没有补写成功，没有重新执行任务或调用模型。';
  }catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render('accountRecoveryConsent');}}
 }
 async readMagpieModels(data:Pick<FormData,'get'>):Promise<void>{
  if(!this.hooks.dreamflow||!this.state||![0,1,2].includes(this.state.step)||this.pending||this.invalidDraft)return;
  const ticket=this.generation,pid=this.projectId!;
  try{
   const next=this.fields(this.state,data);this.writeDraft(next);this.state=next;
   this.pending=true;this.errorMessage='';this.render();
   this.magpieModels=undefined;
   const catalog=await this.adapter.request<{scope:string;models:DesktopModel[]}>('/magpie/models');
   if(!this.current(ticket,pid))return;
   if(catalog.scope!=='DESKTOP_METADATA_ONLY'||!Array.isArray(catalog.models)||catalog.models.some(row=>!row||typeof row.id!=='string'||typeof row.provider!=='string'||!['provider','alias'].includes(row.kind)||!Array.isArray(row.protocols)||row.protocols.some(protocol=>typeof protocol!=='string')))throw new UiError('CUSTOM_CONFIGURATION_INVALID','桌面 Magpie 返回了无法读取的模型目录。');
   this.magpieModels=catalog.models;
  }catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render();}}
 }
 async recommendMember(data:Pick<FormData,'get'>,roleId:string):Promise<void>{
  if(!this.hooks.dreamflow||!this.state||this.pending||this.invalidDraft)return;
  const ticket=this.generation,pid=this.projectId!;
  try{
   const next=this.fields(this.state,data);this.writeDraft(next);this.state=next;
   const context=this.roleContext(),actor=wizardRoles(next).find(r=>r.id===roleId),group=next.configuration.groups.find(g=>actor?.model.kind==='group'&&g.id===actor.model.id),selected=group?.members.find(m=>m.id===actor?.selectedMemberId);
   if(!context||!actor||!group||!selected)throw new UiError('CUSTOM_CONFIGURATION_INVALID','请先保存备用组及起始成员，并确认项目方案。');
   const {specHash,profileHash}=context;this.pending=true;this.errorMessage='';this.render();
   const path='/projects/'+encodeURIComponent(pid),prepared=readAccountCheckPreparation(await this.adapter.request(path+'/flow-preparation','POST',{specHash,profileHash}),pid,specHash,profileHash);
   const assertCurrent=()=>{if(!context.current())throw new UiError('CUSTOM_CONFIGURATION_INVALID','草稿或方案已更新，请重新读取后选择。');};assertCurrent();
   const result=await this.adapter.request<{scope:string;profileHash:string;flowConfigHash:string;roleId:string;groupId:string;memberId:string;reserveMicros:number;currency:string;expiresAtMs:number}>(path+'/flow-member-recommendation','POST',{specHash,profileHash,preparation:prepared.selection.preparation,roleId,confirmed:true});
   assertCurrent();const member=group.members.find(m=>m.id===result?.memberId);
   if(!member||member.authRef!==selected.authRef||member.accountRef!==selected.accountRef||member.provider!==selected.provider||result.scope!=='CONFIGURATION_ONLY'||result.profileHash!==profileHash||result.flowConfigHash!==prepared.flowConfigHash||result.roleId!==roleId||result.groupId!==group.id||result.currency!==actor.budget.currency||!Number.isSafeInteger(result.reserveMicros)||result.reserveMicros<=0||result.reserveMicros>actor.budget.maxMicros||!Number.isSafeInteger(result.expiresAtMs)||result.expiresAtMs<=Date.now())throw new UiError('CUSTOM_CONFIGURATION_INVALID','推荐与当前账户、报价或配置版本不符，请重新读取。');
   const draft=structuredClone(next);wizardRoles(draft).find(r=>r.id===roleId)!.selectedMemberId=member.id;this.writeDraft(draft);this.state=draft;
   this.notice='草稿已选 '+member.model+'，单次请求预留估算 '+result.reserveMicros/1000000+' '+result.currency+'。保存时请确认成员。';
  }catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render();}}
 }
 async checkAccounts(data:Pick<FormData,'get'>):Promise<void>{
  if(!this.state||this.pending||this.invalidDraft)return;const ticket=this.generation,pid=this.projectId!;
  try{
   const next=this.fields(this.state,data);this.writeDraft(next);this.state=next;
   if(!this.canCheckAccounts())throw new UiError('CUSTOM_CONFIGURATION_INVALID','请先保存当前配置并确认项目方案。账户和运行器资格由原服务逐项核对。');
   if(this.accountCheckNeedsRead||this.accountCheckView?.status==='UNCERTAIN'&&!(this.accountRecoveryView?.status==='RECOVERED'&&!this.accountRecoveryView.restartRequired))throw new UiError('CUSTOM_CONFIGURATION_INVALID','请先读取上次交接状态；结果未核清或本机服务尚待重开时，不会重复启动。');
   if(data.get('accountCheckConsent')!=='on')throw new UiError('CUSTOM_CONFIGURATION_INVALID','请单独确认检查已选来源的本机交接；这不会调用模型或开始制作。');
   const specHash=this.hooks.specHash!(pid)!,profileHash=this.latest!.contentHash,snapshot=serializeWizard(next);this.pending=true;this.errorMessage='';this.render();
   const prepared=readAccountCheckPreparation(await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/flow-preparation','POST',{specHash,profileHash}),pid,specHash,profileHash);
   if(!this.current(ticket,pid))return;
   const unchanged=()=>!!this.state&&serializeWizard(this.state)===snapshot&&this.drafts.get(this.key())===snapshot&&this.hooks.specHash?.(pid)===specHash;
   if(!unchanged())throw new UiError('CUSTOM_CONFIGURATION_INVALID','草稿或方案已更新；没有启动交接检查，也没有覆盖较新的内容。请重新打开核对。');
   this.accountCheckNeedsRead=true;this.accountRecoveryView=undefined;const raw=await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/flow-account-check','POST',{specHash,profileHash,preparation:prepared.selection.preparation,confirmed:true});
   if(!this.current(ticket,pid))return;
   if(!unchanged())throw new UiError('CUSTOM_CONFIGURATION_INVALID','检查记录需要重新读取；草稿或方案已有更新，没有覆盖较新的内容。');
   const result=readMagpieAccountCheck(raw,pid);if(!result.selection||!sameAccountCheckSelection(result.selection,prepared.selection)||result.flowConfigHash!==prepared.flowConfigHash)throw new UiError('CUSTOM_CONFIGURATION_INVALID','检查记录与本次已保存选择无法对应，请先读取历史。');
   this.accountCheckView=result;this.accountCheckNeedsRead=result.status==='UNCERTAIN';this.errorMessage='';this.notice='这里只核对来源的本机交接；账户和模型仍未验证，没有开始制作。';
  }catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render('accountCheckConsent');}}
 }
 edit(action:string,data:Pick<FormData,'get'>,index=0,member=0,roleIndex=0):void {
  if(!this.state||this.pending||this.invalidDraft)return;
  try{
   const next=this.fields(this.state,data);
   if(action==='back'){next.step=Math.max(0,next.step-1);if(!this.needsRecheck)this.notice='';}
   else if(action==='account-help'){this.notice='官方登录完成后会保存在受保护的账户来源中，后续重新打开向导、产品重启或继续使用同一账户时都会复用。只有会话失效、被撤销或切换账户时才需要重新授权；网络超时、代理故障或服务重启不会被当作登录失效。';}
   else if(action==='previous'){
    const old=restoreWizard(this.drafts.get(this.previousKey()),this.projectId!);if(!old)throw new UiError('CUSTOM_CONFIGURATION_INVALID','没有找到本页保留的旧草稿。');
    this.state=old;this.conflict=old.baseRevision!==(this.latest?.revision??0)||old.baseHash!==(this.latest?.contentHash??null);this.needsRecheck=this.conflict||!!old.pendingAttempt;this.notice='正在查看保留的旧草稿，没有覆盖服务器版本。';this.render();return;
   }else if(action.startsWith('add-')){
    const kind=action.slice(4) as 'account'|'executor'|'group'|'member';if(!['account','executor','group','member'].includes(kind))return;
    addWizardItem(next,kind,index,this.hooks.dreamflow);
    if(kind==='group'){const r=wizardRoles(next)[roleIndex],g=next.configuration.groups.at(-1)!;if(!r)throw new UiError('CUSTOM_CONFIGURATION_INVALID','角色已改变，请重新打开本页。');r.model={kind:'group',id:g.id};r.selectedMemberId=g.members[0].id;g.members[0].permissions=[...r.permissions];}
   }else if(action.startsWith('remove-')){
    const kind=action.slice(7) as 'account'|'executor'|'group'|'member';if(!['account','executor','group','member'].includes(kind))return;removeWizardItem(next,kind,index,member);
   }else return;
   this.state=next;this.saveDraft();this.errorMessage='';this.render();
  }catch(error){this.failed(error);}
 }
 async submit(data:Pick<FormData,'get'>):Promise<void> {
  if(!this.state||this.pending||this.invalidDraft||this.needsRecheck&&this.state.step===3)return;
  const ticket=this.generation,pid=this.projectId!;
  try{
   this.state=this.fields(this.state,data);this.saveDraft();this.errorMessage='';
   if(this.state.step<3){validateWizardStep(this.state);this.state.step++;if(!this.needsRecheck)this.notice='';this.saveDraft();this.render();return;}
   if(data.get('customConsent')!=='on')throw new UiError('CUSTOM_CONFIGURATION_INVALID','请先核对并明确确认配置范围。');
   const configuration=wizardConfiguration(this.state),baseRevision=this.state.baseRevision;
   this.persistAttempt(configuration,baseRevision);this.pending=true;this.render();
   try{
    const value=readFlowProfile(await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/flow-profile','POST',{configuration,expectedRevision:baseRevision,confirmed:true}),pid);
    if(!this.current(ticket,pid))return;
    if(!value||value.revision!==baseRevision+1||!sameConfiguration(value.configuration,configuration))throw new UiError('CUSTOM_CONFIGURATION_INVALID','返回版本与本次选择无法对应，请先读取保存结果。');
    this.clearAttempt();this.drafts.delete(this.key());this.hooks.saved(value);
   }catch(error){if(this.current(ticket,pid)){this.needsRecheck=true;this.notice='保存结果尚未核清。请先读取本地保存状态，不要直接重复提交。';this.render();this.failed(error);}}
  }catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render();}}
 }
 async recheck():Promise<void> {
  if(!this.state||this.pending||this.invalidDraft)return;const ticket=this.generation,pid=this.projectId!;this.pending=true;this.render();
  try{
   const latest=readFlowProfile(await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/flow-profile'),pid);if(!this.current(ticket,pid))return;
   this.latest=latest;const attempt=this.attempt();
   if(attempt&&latest?.revision===attempt.baseRevision+1&&sameConfiguration(latest.configuration,attempt.configuration)){this.resolveAttempt(latest,true);return;}
   this.conflict=this.state.baseRevision!==(latest?.revision??0)||this.state.baseHash!==(latest?.contentHash??null);
   this.needsRecheck=this.conflict;
   if(!this.conflict){this.clearAttempt();this.notice='本地保存版本未更新。草稿保留，请核对后再明确保存；没有自动重发。';}
   else this.notice='本地已有其他配置版本。原草稿保留，请核对后再选择是否载入。';
  }catch(error){if(this.current(ticket,pid)){this.needsRecheck=true;this.failed(error);}}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render();}}
 }
 async loadLatest():Promise<void> {
  if(!this.state||this.pending)return;const ticket=this.generation,pid=this.projectId!;this.pending=true;this.render();
  try{
   const latest=readFlowProfile(await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/flow-profile'),pid);if(!this.current(ticket,pid))return;
   const previous=this.invalidDraft?this.drafts.get(this.key()):serializeWizard(this.state),candidate=createWizard(pid,latest,this.hooks.dreamflow);
   if(!this.drafts.set(this.previousKey(),previous))throw new UiError('CUSTOM_CONFIGURATION_INVALID','旧草稿未能另存，当前没有替换你的输入。');
   this.writeDraft(candidate);this.latest=latest;this.state=candidate;this.invalidDraft=false;this.needsRecheck=false;this.conflict=false;this.errorMessage='';this.notice='已载入最新保存版本。旧草稿原文已保留；可读取的内容可通过“查看保留草稿”回看。';
  }catch(error){if(this.current(ticket,pid))this.failed(error);}
  finally{if(this.current(ticket,pid)){this.pending=false;this.render();}}
 }
}
