import type { SiwcLocalPanel } from './siwc-local.js';
import type { Project, PlanVersion, Event as RunEvent } from '../shared/types.js';
import type { UiAdapter, Snapshot, PublicConfig, ClashStatus } from './contracts.js';
import { escapeHtml as e, UiError, semanticPayload, readVerifierPlan } from './contracts.js';
import { patchHtml, DraftStore, downloadBlob } from './dom.js';
import { shell, gateContent, roles, verifierContent, type ViewState } from './views.js';
import { PreviewStorageBridge,ManagedPreviewBridge } from './preview.js';
import {readManagedData,managedDataErrorMessage,managedImportConfirmation,readManagedRestorePlan,managedRestoreConfirmation} from './managed-data-view.js';
import {readJsonData,jsonDataErrorMessage,jsonEditorContent,jsonExecuteConfirmation,readJsonRestorePlan,jsonRestoreConfirmation} from './json-data-view.js';
import {sqliteStatusBinding,sameSqliteStatusBinding,readSqliteStatus,sqliteStatusContent,sqliteStatusLoading,sqliteStatusFailure,readSqliteRestorePlan,sqliteRestoreConfirmation,readSqliteRecoveryPlan,sqliteRecoverySection,sqliteRecoveryConfirmation} from './sqlite-status-view.js';
import type {SqliteDataRestorePlan,SqliteDataRecoveryPlan,SqliteDataRecoveryCandidate} from '../shared/sqlite-data.js';
import type {JsonDataRestorePlan} from '../shared/json-data.js';
import {readRegisteredBackups,readRegisteredExtraction,registeredBackupError,registeredBackupConfirmation} from './registered-backup-view.js';
import type {DemoTask} from '../shared/demo-tasks.js';
import type {ManagedDataRestorePlan,ManagedDataOperationView} from '../shared/managed-data.js';
import { summarizeKimiStatus, summarizeBridgeDurability } from './kimi-status-summary.js';
import { summarizeNativeReadiness } from './native-readiness-summary.js';
import { planningStageMessage } from './project-plan-view.js';
import { flowReportContent, type FlowReportData, type HelpTopic } from './flow-help-view.js';
import type { Product } from '../shared/product.js';
import type {SetupSnapshot} from '../shared/onboarding.js';
import { userPlanFromFields,userPlanEditor } from './user-plan-view.js';
import { budgetConfirmation,budgetErrorMessage } from './setup-view.js';
import {maintenanceConfirmation,maintenanceErrorMessage} from './maintenance-view.js';
import type {MaintenanceStatus,RestoreRehearsal} from '../shared/maintenance.js';
import {lifecycleConfirmation,readLifecycleStatus} from './lifecycle-view.js';
import type {ResearchPanelState} from './research-view.js';
import type {DispatchView} from './flow-workspace-view.js';
import {friendlyUiError} from './plain-ui-error.js';
import {planner1ChoiceForm,loadLocalPlanner1Check,localPlanner1CheckResult} from './planner1-choice-view.js';
import {CustomFlowWizard} from './custom-flow-controller.js';
import {tourPages} from './frontend-guidance-view.js';
import {readNetworkContexts,readCodexMetadataObservation} from './network-context-view.js';
import {readMagpieCheck} from './magpie-check-view.js';
import {readMergeRecoveryPreview,readMergeRecoveryResult,mergeRecoveryConfirmation,mergeRecoveryError} from './merge-recovery-view.js';
import type {MergeRecoveryPreview,MergeRecoveryChoice} from '../shared/merge-recovery.js';
import {readExecutorCheckpointPreview,readExecutorCheckpointResult,executorCheckpointConfirmation,executorCheckpointError} from './executor-checkpoint-view.js';
import type {ExecutorCheckpointPreview} from '../shared/executor-checkpoint.js';
import {reviewPreparationBinding,reviewPreparationRequest,readReviewPreparationResult,reviewPreparationConfirmation,reviewPreparationError,type ReviewPreparationBinding} from './review-preparation-view.js';
import {reviewWindowBinding,reviewWindowRequest,readReviewWindowResult,reviewWindowConfirmation,type ReviewWindowBinding} from './review-window-view.js';
import {reviewSupplementBinding,sameReviewSupplementBinding,readReviewSupplementPreview,reviewSupplementRequest,readReviewSupplementResult,readReviewSupplementSnapshot,reviewSupplementConfirmation,reviewSupplementError,type ReviewSupplementPreview} from './review-supplement-view.js';
import {readLayaProbe} from './laya-probe-view.js';
const canReadSiwcStatus = (settings:PublicConfig) =>
  settings.planner1Retired !== true && settings.planner1Binding?.runner === 'siwc-sdk';
export interface FixtureData { screen:'home'|'project'|'settings'; projects:Project[]; snapshot:Snapshot|null; settings:PublicConfig; events?:RunEvent[]; tab?:string; gateDismissed?:boolean }
const writes=new Set(['next','skip','finish','continue','approve','pause','resume','cancel','confirm-cancel','accept','confirm-accept','demo-step','models','laya-probe','native-verifier','clash-verify','clash-recover','conclude-flow','json-load','json-edit','json-execute','json-export','merge-recovery','executor-checkpoint','sqlite-recovery']);
writes.add('review-preparation');
writes.add('review-supplement');
/** Shared controller for local and public builds. The injected adapter is selected by the entry file only. */
export class DreamMakerUI {
 private networkSeq=0;
 private codexMetadataSeq=0;
 private magpieSeq=0;
 private readonly app:HTMLElement;
 private readonly dialog:HTMLDialogElement;
 private readonly drafts:DraftStore;
 private epoch=0;
 private listSeq=0;
 private readSeq=0;
 private panelSeq=0;
 private pendingRefresh=false;
 private stopStream:(()=>void)|null=null;
 private refreshTimer:ReturnType<typeof setTimeout>|null=null;
 private flowRefreshTimer:ReturnType<typeof setTimeout>|null=null;
 private flowExpiryTimer:ReturnType<typeof setTimeout>|null=null;
 private panelAbort:AbortController|null=null;
 private flowNeedsInitialRead=false;
 private toastTimer:ReturnType<typeof setTimeout>|null=null;
 private modalCleanup:ReturnType<typeof setTimeout>|null=null;
 private composing=false;
 private gateDismissed=false;
 private modalKind='';
 private modalSeq=0;
 private verifierBinding:{pid:string;specHash:string;planHash:string}|null=null;
 private flowReportBinding:{runId:string;reportHash:string}|null=null;
 private userPlanBinding:{pid:string;parentId:string;version:number;draftKey:string}|null=null;
 private userBudgetBinding:{revision:number;limits:{CNY:string;USD:string}}|null=null;
 private maintenanceBinding:{kind:'create'|'rehearse';id:string}|null=null;
 private managedImportBinding:{pid:string;runId:string;treeHash:string;tasks:DemoTask[]}|null=null;
 private managedRestoreBinding:ManagedDataRestorePlan|null=null;
 private sqliteRestoreBinding:SqliteDataRestorePlan|null=null;
 private sqliteRecoveryPlan:SqliteDataRecoveryPlan|null=null;
 private sqliteRecoveryBinding:{plan:SqliteDataRecoveryPlan;candidate:SqliteDataRecoveryCandidate}|null=null;
 private jsonBinding:{pid:string;runId:string;treeHash:string;revision:number;draftKey:string;kind:'edit'|'execute'}|null=null;
 private jsonRestoreBinding:JsonDataRestorePlan|null=null;
 private registeredBinding:{kind:'create'|'extract';id:string}|null=null;
 private mergeBinding:{pid:string;preview:MergeRecoveryPreview}|null=null;
 private checkpointBinding:{pid:string;preview:ExecutorCheckpointPreview}|null=null;
 private reviewPreparation:ReviewPreparationBinding|null=null;
 private reviewWindow:ReviewWindowBinding|null=null;
 private reviewSupplement:ReviewSupplementPreview|null=null;
 private customWizard:CustomFlowWizard|undefined;
 private modalReturn:HTMLElement|null=null;
 private life=new AbortController();
 private disposed=false;
 private v:ViewState;
 private previewStorage=new PreviewStorageBridge(()=>localStorage,location.origin);
 private managedPreview=new ManagedPreviewBridge({read:(rid,tree)=>this.adapter.request('/runs/'+encodeURIComponent(rid)+'/data?treeHash='+encodeURIComponent(tree)),write:(rid,tree,tasks,revision)=>this.adapter.request('/runs/'+encodeURIComponent(rid)+'/data','POST',{treeHash:tree,tasks,expectedRevision:revision})},location.origin,data=>{if(this.v.screen==='project'&&this.v.snapshot?.project.id===data.projectId){this.v.previewData=data;this.render();}});
 constructor(private adapter:UiAdapter,private siwcPanel?:SiwcLocalPanel,private product:Product='dream-maker'){
  this.app=document.getElementById('app')!;
  // Bounded JSON can expand considerably when formatted. Oversize drafts are rejected whole.
  this.drafts=new DraftStore('dream-maker.ui-drafts.v2.'+adapter.mode+(adapter.presentation?'.'+adapter.presentation:'')+(product==='dream-maker'?'':'.'+product),512000);
  this.v={product,presentation:adapter.presentation,mode:adapter.mode,screen:'home',projects:[],snapshot:null,settings:null,tab:'work',busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:40,clash:null,draft:key=>this.drafts.get(key),hasDraft:key=>this.drafts.has(key)};
  this.dialog=document.createElement('dialog');this.dialog.id='dm-dialog';this.dialog.className='dialog t-modal';this.dialog.setAttribute('aria-labelledby','dialog-title');document.body.append(this.dialog);
  const opts={signal:this.life.signal};
  document.addEventListener('click',ev=>{if(this.owned(ev.target))this.click(ev);},opts);
  document.addEventListener('submit',ev=>{if(this.owned(ev.target))this.submit(ev);},opts);
  document.addEventListener('input',ev=>{if(this.owned(ev.target))this.input(ev);},opts);
  document.addEventListener('change',ev=>{if(this.owned(ev.target))this.change(ev);},opts);
  document.addEventListener('compositionstart',ev=>{if(this.owned(ev.target))this.composing=true;},opts);
  document.addEventListener('compositionend',ev=>{if(this.owned(ev.target)){this.composing=false;this.input(ev);}},opts);
  document.addEventListener('keydown',ev=>this.key(ev),opts);
  window.addEventListener('popstate',()=>{void this.routeFromUrl().catch(err=>{this.v.error=this.errorText(err);this.render();});},opts);
  window.addEventListener('message',event=>{this.previewStorage.receive(event);void this.managedPreview.receive(event);},opts);
  window.addEventListener('pagehide',ev=>{if(ev.persisted)this.disconnect();else this.dispose();},opts);
  window.addEventListener('pageshow',ev=>{if(ev.persisted)void this.routeFromUrl().catch(err=>{this.v.error=this.errorText(err);this.render();});},opts);
  this.dialog.addEventListener('cancel',ev=>{ev.preventDefault();if(this.modalKind==='gate')this.gateDismissed=true;this.closeDialog();},opts);
 }
 private owned(target:EventTarget|null):boolean{return target instanceof Node&&(this.app.contains(target)||this.dialog.contains(target));}
 async boot():Promise<void>{
  try{await this.adapter.init();if(this.product==='dreamflow'&&(await this.adapter.request<{product:Product}>('/product')).product!=='dreamflow')throw new UiError('PRODUCT_ENTRY_MISMATCH','请从独立 DreamFlow 的本机启动入口进入。');this.v.settings=await this.adapter.request<PublicConfig>('/config');await this.list();await this.routeFromUrl();this.render();}
  catch(err){this.v.error=this.errorText(err);this.render();if(this.adapter.mode==='local')this.showDialog('login',`<span class="eyebrow">LOCAL SESSION</span><h2 id="dialog-title">请从本机启动终端进入。</h2><p>使用终端显示的一次性登录链接。链接失效或服务重启时，请重新获取；不要把它分享给别人。</p><p class="notice warning">${e(this.v.error)}</p><button type="button" data-action="close-modal">关闭说明</button>`);}
 }
 private errorText(err:unknown):string {return err instanceof UiError?reviewSupplementError(err.code)??reviewPreparationError(err.code)??executorCheckpointError(err.code)??mergeRecoveryError(err.code)??registeredBackupError(err.code)??jsonDataErrorMessage(err.code)??managedDataErrorMessage(err.code)??budgetErrorMessage(err.code)??maintenanceErrorMessage(err.code)??friendlyUiError(err):friendlyUiError(err);}
 private async list():Promise<void>{const seq=++this.listSeq;const data=await this.adapter.request<{projects:Project[]}>('/projects');if(seq===this.listSeq)this.v.projects=data.projects;}
 private url():void {try{const q=new URLSearchParams();q.set('ui','legacy');if(this.v.screen==='project'&&this.v.snapshot){q.set('project',this.v.snapshot.project.id);q.set('tab',this.v.tab);}else if(this.v.screen==='settings'||this.v.screen==='help'||this.v.screen==='setup'||this.v.screen==='fees'||this.v.screen==='maintenance')q.set('view',this.v.screen);history.replaceState(null,'','/'+(q.size?'?'+q.toString():''));}catch{/* about:blank fixture has no origin; never used as network verification. */}}
 private async routeFromUrl():Promise<void>{const query=new URLSearchParams(location.search),pid=query.get('project');if(pid){const tab=query.get('tab');await this.open(pid,['work','answers','research','spec','history','flow','laya','report','followup','logs','files'].includes(tab||'')?tab!:'work');if(['work','answers','research','spec','history','flow','laya','report','followup','logs','files'].includes(tab||'')){this.v.tab=tab!;if(tab==='files')await this.loadFiles();else await this.loadProjectPanel();this.url();this.render();}}else if(query.get('view')==='settings')await this.settings();else if(query.get('view')==='help')await this.help();else if(query.get('view')==='setup'&&this.prepAvailable())await this.setup();else if(query.get('view')==='fees'&&this.prepAvailable())await this.setup('fees');else if(query.get('view')==='maintenance'&&this.prepAvailable())await this.maintenance();else this.home();}
 private cancelPanelRead():void{
  this.panelSeq++;this.panelAbort?.abort();this.panelAbort=null;
  if(this.flowRefreshTimer)clearTimeout(this.flowRefreshTimer);this.flowRefreshTimer=null;
  if(this.flowExpiryTimer)clearTimeout(this.flowExpiryTimer);this.flowExpiryTimer=null;
  this.flowNeedsInitialRead=false;this.v.panelLoading=false;this.v.dispatch=undefined;
 }
 private clearPanels():void{this.cancelPanelRead();this.v.panelError='';this.v.planHistory=undefined;this.v.researchPanel=undefined;this.v.dispatch=undefined;this.v.layaSummary=undefined;this.v.flowReport=undefined;}
 private disconnect():void{this.clearPanels();this.previewStorage.clear();this.managedPreview.clear();this.v.previewProtocol=undefined;this.v.previewData=undefined;this.v.jsonData=undefined;this.siwcPanel?.detach();this.stopStream?.();this.stopStream=null;if(this.refreshTimer)clearTimeout(this.refreshTimer);this.refreshTimer=null;this.readSeq++;}
 private async loadProjectPanel(append=false):Promise<void>{
  const snapshot=this.v.snapshot,tab=this.v.tab;if(!snapshot||this.v.screen!=='project'||!['history','research','flow','laya','report'].includes(tab))return;
  if(tab==='flow'&&this.v.panelLoading)return;
  const controller=tab==='flow'?new AbortController():null;if(controller){
   if(this.flowRefreshTimer)clearTimeout(this.flowRefreshTimer);this.flowRefreshTimer=null;
   this.panelAbort=controller;this.flowNeedsInitialRead=false;
  }
  const token=++this.panelSeq,epoch=this.epoch,pid=snapshot.project.id,rid=snapshot.runs[0]?.id,specId=snapshot.project.specId;
  const current=()=>!this.disposed&&token===this.panelSeq&&epoch===this.epoch&&this.v.screen==='project'&&this.v.tab===tab&&this.v.snapshot?.project.id===pid&&this.v.snapshot.project.specId===specId&&this.v.snapshot.runs[0]?.id===rid;
  this.v.panelLoading=true;this.v.panelError='';this.render();
  try{
   if(tab==='history'){
    const prior=this.v.planHistory,after=append?prior?.nextRevision:0;if(append&&(after===null||after===undefined))return;
    const result=await this.adapter.request<{plans:PlanVersion[];nextRevision:number|null}>('/projects/'+encodeURIComponent(pid)+'/plans?afterRevision='+after+'&limit=50');
    if(!Array.isArray(result.plans)||result.plans.some(row=>row.projectId!==pid||!row.snapshot||!Number.isInteger(row.revision)))throw new UiError('PLAN_HISTORY_INVALID','方案历史暂时无法核对，原版本没有改动。');
    if(!current())return;const rows=append?[...(prior?.items??[]),...result.plans]:result.plans,items=[...new Map(rows.map(row=>[row.id,row])).values()];
    this.v.planHistory={items,selectedId:prior?.selectedId&&items.some(row=>row.id===prior.selectedId)?prior.selectedId:items.at(-1)?.id??'',nextRevision:result.nextRevision};
   }else if(tab==='research'){
    const result=await this.adapter.request<ResearchPanelState>('/projects/'+encodeURIComponent(pid)+'/research');if(!Array.isArray(result.operations))throw new UiError('RESEARCH_STATUS_INVALID','研究记录暂时无法读取；这不表示不存在适合的项目。');if(current())this.v.researchPanel=result;
   }else if(tab==='flow'){
    const path=this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'?'/dispatch':'/diagnostics';
    const result=await this.adapter.request<{dispatch?:DispatchView}>(path,'GET',undefined,controller?.signal);if(current()){this.v.dispatch=result.dispatch;this.scheduleFlowExpiry();}
   }else if(tab==='laya'){
    if(current())this.v.layaSummary=snapshot.status?.laya??undefined;
   }else if(tab==='report'&&rid){
    const result=await this.adapter.request<FlowReportData>('/runs/'+encodeURIComponent(rid)+'/report');if(!result.summary||typeof result.reportHash!=='string')throw new UiError('REPORT_INVALID','本轮报告尚未核对，没有生成新的审查结论。');if(current())this.v.flowReport=result;
   }
  }catch(error){if(current()){if(tab==='flow'){this.v.dispatch=undefined;if(this.flowExpiryTimer)clearTimeout(this.flowExpiryTimer);this.flowExpiryTimer=null;}if(tab==='report')this.v.flowReport=undefined;this.v.panelError=error instanceof UiError&&error.code==='FLOW_NOT_SETTLED'?'本轮还在处理，正式结束后才能读取报告。':this.adapter.mode==='public-demo'?'这项演示数据尚未连接；不会转向本机或模型接口。':this.errorText(error);}}
  finally{if(this.panelAbort===controller)this.panelAbort=null;if(current()){this.v.panelLoading=false;this.render();this.scheduleFlowRefresh();}}
 }
 private flowRefreshEligible():boolean{
  const snapshot=this.v.snapshot,run=snapshot?.runs[0];
  if(this.disposed||this.v.panelError||this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.screen!=='project'||this.v.tab!=='flow'||
   !snapshot||!run||run.specId!==snapshot.project.specId||snapshot.spec?.stale||!['PLANNING','IMPLEMENTING','VERIFYING','REVIEWING','REPAIRING'].includes(run.state)||
   !(this.flowNeedsInitialRead||this.v.dispatch?.queued.some(row=>row.projectId===snapshot.project.id&&row.runId===run.id)))return false;
  return true;
 }
 private scheduleFlowRefresh():void{
  // SSE events and the timer share one queue; events cannot reset or bypass its interval.
  if(this.v.panelLoading)return;
  if(!this.flowRefreshEligible()){if(this.flowRefreshTimer)clearTimeout(this.flowRefreshTimer);this.flowRefreshTimer=null;return;}
  if(this.flowRefreshTimer)return;
  const epoch=this.epoch,pid=this.v.snapshot!.project.id;
  this.flowRefreshTimer=setTimeout(()=>{
   this.flowRefreshTimer=null;if(epoch!==this.epoch||this.v.snapshot?.project.id!==pid||!this.flowRefreshEligible())return;
   if(this.v.busy||this.composing||this.dialog.open||this.v.panelLoading){this.scheduleFlowRefresh();return;}
   void this.loadProjectPanel();
  },3000);
 }
 private scheduleFlowExpiry():void{
  if(this.flowExpiryTimer)clearTimeout(this.flowExpiryTimer);this.flowExpiryTimer=null;
  if(this.disposed||this.v.screen!=='project'||this.v.tab!=='flow')return;
  const snapshot=this.v.snapshot,run=snapshot?.runs[0],now=Date.now();
  const expires=this.v.dispatch?.queued.filter(row=>row.projectId===snapshot?.project.id&&row.runId===run?.id)
   .slice(0,6).map(row=>Date.parse(row.wait?.sampledAt??''))
   .filter(time=>Number.isFinite(time)&&time<=now+5000&&time+15001>now).map(time=>time+15001)??[];
  if(!expires.length)return;
  this.flowExpiryTimer=setTimeout(()=>{this.flowExpiryTimer=null;this.render();this.scheduleFlowExpiry();},Math.min(...expires)-now);
 }
 private focusPage():void{if(!this.dialog.open){this.app.querySelector<HTMLElement>('#main-content')?.focus({preventScroll:true});window.scrollTo(0,0);}}
 private home():void{this.epoch++;this.disconnect();this.closeDialog();this.v.screen='home';this.v.error='';this.url();this.render();this.focusPage();}
 private async help():Promise<void>{const token=++this.epoch;this.disconnect();this.closeDialog();const data=await this.adapter.request<{topics:Record<string,HelpTopic>}>('/help');if(token!==this.epoch)return;this.v.helpTopics=data.topics;this.v.screen='help';this.v.error='';this.url();this.render();this.focusPage();}
 private prepAvailable():boolean{return this.adapter.mode==='local'||this.adapter.presentation==='frontend-review';}
 private async setup(screen:'setup'|'fees'='setup'):Promise<void>{
  if(!this.prepAvailable()||(['setup','fees'].includes(this.v.screen)&&this.v.setupLoading))return;
  const token=++this.epoch;this.disconnect();this.closeDialog();this.v.screen=screen;this.v.setupLoading=true;this.v.error='';this.url();this.render();this.focusPage();
  try{const data=await this.adapter.request<SetupSnapshot>('/onboarding');if(token!==this.epoch)return;
   if(data.schema!=='dream-maker.setup.v1'||data.product!==this.product||!Array.isArray(data.roles)||data.fullFlowAcceptance!=='NOT_RUN')throw new UiError('SETUP_STATUS_INVALID','准备状态暂时无法读取，请稍后刷新；没有开始任何任务。');
   this.v.setup=data;
  }catch(error){if(token===this.epoch)this.v.error=this.errorText(error);}
  finally{if(token===this.epoch){this.v.setupLoading=false;this.render();}}
 }
 private async maintenance():Promise<void>{
  if(!this.prepAvailable())return;const token=++this.epoch;this.disconnect();this.closeDialog();this.v.screen='maintenance';this.v.registeredBackups=undefined;this.v.error='';this.url();this.render();this.focusPage();
  try{const [value,lifecycle,,registered]=await Promise.all([this.adapter.request<MaintenanceStatus>('/maintenance'),this.adapter.request('/application/lifecycle'),this.list(),this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'?this.adapter.request('/maintenance/registered-backups'):Promise.resolve(undefined)]);if(token!==this.epoch)return;if(value.schema!=='dream-maker.maintenance.v1'||value.scope!=='APPLICATION_STATE_ONLY'||value.completeProjectBackup!==false||value.automaticResume!==false||!Array.isArray(value.snapshots))throw new UiError('MAINTENANCE_STATUS_INVALID','维护范围暂时无法核对，没有创建或恢复副本。');this.v.maintenance=value;this.v.lifecycle=readLifecycleStatus(lifecycle);this.v.registeredBackups=registered===undefined?undefined:readRegisteredBackups(registered);}
  catch(error){if(token===this.epoch)this.v.error=this.errorText(error);}finally{if(token===this.epoch)this.render();}
 }
 private async lifecycleChoice():Promise<void>{
  if(!this.prepAvailable())return;this.v.lifecycle=undefined;this.showDialog('lifecycle',lifecycleConfirmation());const seq=this.modalSeq;
  const value=readLifecycleStatus(await this.adapter.request('/application/lifecycle'));this.v.lifecycle=value;
  if(!this.disposed&&this.modalKind==='lifecycle'&&this.modalSeq===seq)this.showDialog('lifecycle',lifecycleConfirmation(value));
 }
 private async settings():Promise<void>{const token=++this.epoch;this.disconnect();this.closeDialog();const settings=await this.adapter.request<PublicConfig>('/config');if(token!==this.epoch)return;this.v.settings=settings;this.v.clash=this.adapter.mode==='local'?await this.adapter.request<ClashStatus>('/clash'):null;if(canReadSiwcStatus(settings))await this.siwcPanel?.load();else this.siwcPanel?.detach();if(token!==this.epoch)return;this.networkSeq++;this.v.networkLoading=false;this.v.networkContexts=undefined;this.v.networkError='';this.codexMetadataSeq++;this.v.codexMetadataLoading=false;this.v.codexMetadata=undefined;this.v.codexMetadataError='';this.magpieSeq++;this.v.magpieLoading=false;this.v.magpieTesting=false;this.v.magpieCheck=undefined;this.v.magpieError='';this.v.magpieNeedsRead=true;this.v.screen='settings';this.v.error='';this.url();this.render();this.focusPage();void this.readMagpie();}
 private async readMagpie(run=false):Promise<void>{
  if(this.v.screen!=='settings'||this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.magpieLoading||this.v.busy||run&&(this.v.magpieNeedsRead||this.v.magpieCheck?.status==='UNCERTAIN'))return;
  const token=this.epoch,seq=++this.magpieSeq,current=()=>!this.disposed&&token===this.epoch&&seq===this.magpieSeq&&this.v.screen==='settings';
  this.v.magpieLoading=true;this.v.magpieTesting=run;this.v.magpieError='';this.render();
  try{const result=readMagpieCheck(await this.adapter.request('/magpie/checks',run?'POST':'GET',run?{confirmed:true}:undefined));if(current()){this.v.magpieCheck=result;this.v.magpieNeedsRead=false;}}
  catch{if(current()){this.v.magpieNeedsRead=true;this.v.magpieError='检查结果还未读取完整。请先查看上次记录，勿盲目重复启动；没有因此批准模型调用。';}}
  finally{if(current()){this.v.magpieLoading=false;this.v.magpieTesting=false;this.render();}}
 }
 private async readNetwork(testLocal=false):Promise<void>{
  if(this.disposed||this.v.screen!=='settings'||this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.networkLoading||this.v.busy)return;
  const token=this.epoch,seq=++this.networkSeq,current=()=>!this.disposed&&token===this.epoch&&seq===this.networkSeq&&this.v.screen==='settings';
  this.v.networkLoading=true;this.v.networkTesting=testLocal;this.v.networkError='';this.render();
  try{const value=readNetworkContexts(await this.adapter.request(testLocal?'/network/local-check':'/network/contexts',testLocal?'POST':'GET',testLocal?{}:undefined));if(current())this.v.networkContexts=value;}
  catch{if(current())this.v.networkError='本机状态还未读取完整。已有记录保留；没有发起登录、模型调用或网络修改。';}
  finally{if(current()){this.v.networkLoading=false;this.v.networkTesting=false;this.render();}}
 }
 private async readCodexMetadata():Promise<void>{
  if(this.disposed||this.v.screen!=='settings'||this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.codexMetadataLoading||this.v.busy)return;
  const token=this.epoch,seq=++this.codexMetadataSeq,current=()=>!this.disposed&&token===this.epoch&&seq===this.codexMetadataSeq&&this.v.screen==='settings';
  this.v.codexMetadataLoading=true;this.v.codexMetadataError='';this.render();
  try{const value=readCodexMetadataObservation(await this.adapter.request('/network/codex-metadata','POST',{}));if(current())this.v.codexMetadata=value;}
  catch{if(current()){this.v.codexMetadata=undefined;this.v.codexMetadataError='账户与套餐元数据未读取完整。没有发起模型推理、登录或网络修改；上次结果已隐藏，不能作为本次证据。';}}
  finally{if(current()){this.v.codexMetadataLoading=false;this.render();}}
 }
 private async open(pid:string,tab='work'):Promise<void>{
  const token=++this.epoch;this.disconnect();this.closeDialog();
  const s=await this.adapter.request<Snapshot>('/projects/'+encodeURIComponent(pid));if(token!==this.epoch)return;
  this.v.snapshot=s;this.v.screen='project';this.v.tab=tab;this.v.events=[];this.v.error='';this.v.fileName='';this.v.fileText='';this.v.files=[];this.v.previewUrl='';this.v.specSearch='';this.gateDismissed=false;this.url();
  this.v.planningMessage=planningStageMessage(s.planning?.at(-1)?.state??'');
  this.stopStream=this.adapter.subscribe(pid,event=>{
   if(token!==this.epoch||this.v.snapshot?.project.id!==pid)return;
   if(this.v.events.some(x=>x.id===event.id))return;
   this.v.events.push(event);this.v.events=this.v.events.slice(-300);
   if(event.type==='planning.status'&&event.payload&&typeof event.payload==='object'){
    const state=(event.payload as {state?:unknown}).state;
    if(typeof state==='string'){this.v.planningMessage=planningStageMessage(state);this.render();}
   }
   if(!this.refreshTimer)this.refreshTimer=setTimeout(()=>{this.refreshTimer=null;if(!this.v.busy)void this.refreshSnapshot(pid,token);else this.pendingRefresh=true;},120);
   if(this.v.tab==='logs')this.render();
  },state=>{if(token===this.epoch){this.v.connection=state;this.render();}});this.render();this.focusPage();
 }
 private async refreshSnapshot(pid:string,token=this.epoch):Promise<void>{
  const seq=++this.readSeq;
  try{const s=await this.adapter.request<Snapshot>('/projects/'+encodeURIComponent(pid));
   if(token!==this.epoch||seq!==this.readSeq||this.v.snapshot?.project.id!==pid||this.v.busy)return;
   if(s.project.version<this.v.snapshot.project.version)return;
   const changed=s.project.specId!==this.v.snapshot.project.specId||s.runs[0]?.id!==this.v.snapshot.runs[0]?.id;
   this.v.snapshot=s;this.v.error='';if(changed){this.v.jsonData=undefined;this.clearPanels();if(this.v.tab==='flow'){this.flowNeedsInitialRead=true;this.scheduleFlowRefresh();}else void this.loadProjectPanel();}else if(this.v.tab==='flow')this.scheduleFlowRefresh();else if(this.v.tab==='laya')this.v.layaSummary=s.status?.laya??undefined;this.render();
  }catch(err){if(token===this.epoch){this.v.error=this.errorText(err);this.render();}}
 }
 private async mutate(action:string,body:unknown={},pid=this.v.snapshot?.project.id):Promise<Snapshot>{
  if(!pid)throw new UiError('NO_PROJECT','请先选择项目。');
  const token=this.epoch;this.readSeq++;
  const s=await this.adapter.request<Snapshot>('/projects/'+encodeURIComponent(pid)+'/'+action,'POST',body);
  this.readSeq++;if(token===this.epoch&&this.v.snapshot?.project.id===pid)this.v.snapshot=s;await this.list();return s;
 }
 private async nextIfNeeded(s:Snapshot):Promise<Snapshot>{if(s.project.state==='INTERVIEWING'&&!s.project.questions.some(q=>!s.project.answers.some(a=>a.questionId===q.id)))return this.mutate('next',{},s.project.id);return s;}
 private async control(action:string,body:unknown={}):Promise<void>{const r=this.v.snapshot?.runs[0];if(!r)return;const token=this.epoch;this.readSeq++;const s=await this.adapter.request<Snapshot>('/runs/'+encodeURIComponent(r.id)+'/'+action,'POST',body);this.readSeq++;if(token===this.epoch&&this.v.snapshot?.project.id===r.projectId)this.v.snapshot=s;}
 private async projectSqliteStatus():Promise<void>{
  if(this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.screen!=='project')return;
  const binding=sqliteStatusBinding(this.v.snapshot);if(!binding)return;const token=this.epoch,back=this.app.querySelector<HTMLElement>('[data-action=sqlite-status]');
  this.sqliteRecoveryPlan=null;this.showDialog('sqlite-status',sqliteStatusLoading());if(back)this.modalReturn=back;const seq=this.modalSeq;
  const current=()=>token===this.epoch&&seq===this.modalSeq&&this.modalKind==='sqlite-status'&&this.v.screen==='project'&&this.v.snapshot?.project.id===binding.projectId;
  try{
   const value=readSqliteStatus(await this.adapter.request('/projects/'+encodeURIComponent(binding.projectId)+'/sqlite-data'),binding.projectId);if(!current())return;
   if(!sameSqliteStatusBinding(sqliteStatusBinding(this.v.snapshot),binding)){this.showDialog('sqlite-status',sqliteStatusFailure('SQLITE_DATA_READ_CHANGED'));return;}
   let recovery:SqliteDataRecoveryPlan|null=null;
   if(value.usage.pending){
    recovery=readSqliteRecoveryPlan(await this.adapter.request('/projects/'+encodeURIComponent(binding.projectId)+'/sqlite-data/recovery'),binding.projectId);
    if(!current())return;
    if(recovery.candidates.length!==value.usage.pending)throw new UiError('SQLITE_DATA_RECOVERY_CHANGED','待核清记录刚刚发生变化，请重新核对。');
   }
   this.sqliteRecoveryPlan=recovery;
   this.showDialog('sqlite-status',sqliteStatusContent(value)+sqliteRecoverySection(recovery));
  }catch(error){if(current())this.showDialog('sqlite-status',sqliteStatusFailure(error instanceof UiError?error.code:''));}
 }
 private async projectData(kind:'read'|'edit'|'execute'):Promise<void>{
  const r=this.v.snapshot?.runs[0],token=this.epoch;
  if(this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.screen!=='project'||r?.mode!=='live'||!r.treeHash||!['READY_FOR_DELIVERY','ACCEPTED'].includes(r.state))return;
  const data=readJsonData(await this.adapter.request('/runs/'+encodeURIComponent(r.id)+'/json-data?treeHash='+encodeURIComponent(r.treeHash)),r.projectId);
  if(token!==this.epoch||this.v.snapshot?.runs[0]?.id!==r.id||this.v.snapshot.runs[0].treeHash!==r.treeHash)return;
  this.v.jsonData=data;if(kind==='read'){this.toast('已读取本机数据版本 '+data.revision+'；没有执行程序。');return;}
  // Include the shown revision in the draft identity; never silently rebase an old draft.
  const draftKey='json-data:'+r.projectId+':'+r.id+':'+r.treeHash+':'+data.revision;
  this.showDialog(kind==='edit'?'json-edit':'json-execute',kind==='edit'?jsonEditorContent(data,this.drafts.get(draftKey),draftKey):jsonExecuteConfirmation(data));
  this.jsonBinding={pid:r.projectId,runId:r.id,treeHash:r.treeHash,revision:data.revision,draftKey,kind};
 }
 private async act(work:()=>Promise<void>):Promise<void>{if(this.v.busy)return;const token=this.epoch;this.v.busy=true;this.v.error='';this.render();try{await work();}catch(err){if(token===this.epoch){this.v.error=this.errorText(err);const alert=this.dialog.querySelector('#dialog-error');if(alert)alert.textContent=this.v.error;}else this.toast('先前页面的操作未完成，请返回该项目核对。');}finally{this.v.busy=false;this.render();if(this.pendingRefresh&&this.v.screen==='project'&&this.v.snapshot){this.pendingRefresh=false;void this.refreshSnapshot(this.v.snapshot.project.id);}}}
 private render():void {
  if(this.disposed)return;
  if(this.modalKind==='custom-flow'&&this.customWizard?.projectId&&(this.v.screen!=='project'||this.v.snapshot?.project.id!==this.customWizard.projectId))this.closeDialog();
  if(this.mergeBinding&&(this.v.screen!=='project'||this.v.snapshot?.project.id!==this.mergeBinding.pid||this.v.snapshot.runs[0]?.id!==this.mergeBinding.preview.runId||this.v.snapshot.runs[0]?.mergeRecoveryRequired!==true))this.closeDialog();
  if(this.checkpointBinding&&(this.v.screen!=='project'||this.v.snapshot?.project.id!==this.checkpointBinding.pid||this.v.snapshot.runs[0]?.id!==this.checkpointBinding.preview.runId||this.v.snapshot.runs[0]?.version!==this.checkpointBinding.preview.runVersion||this.v.snapshot.runs[0]?.executorCheckpointRequired!==true))this.closeDialog();
  if(this.jsonBinding&&(this.v.screen!=='project'||this.v.snapshot?.project.id!==this.jsonBinding.pid||this.v.snapshot.runs[0]?.id!==this.jsonBinding.runId||this.v.snapshot.runs[0]?.treeHash!==this.jsonBinding.treeHash))this.closeDialog();
  if(this.userPlanBinding&&(this.v.screen!=='project'||this.v.snapshot?.project.id!==this.userPlanBinding.pid||this.v.snapshot.project.specId!==this.userPlanBinding.parentId))this.closeDialog();
  if(this.verifierBinding&&(this.v.screen!=='project'||this.v.snapshot?.project.id!==this.verifierBinding.pid||this.v.snapshot.spec?.stale||this.v.snapshot.spec?.hash!==this.verifierBinding.specHash))this.closeDialog();
  // Reconciliation preserves control nodes instead of replacing the application tree on SSE.
  patchHtml(this.app,shell(this.v));
  this.previewStorage.bind(this.app.querySelector<HTMLIFrameElement>('iframe'));
  this.managedPreview.bind(this.app.querySelector<HTMLIFrameElement>('iframe'));
  if(this.v.screen==='settings')this.siwcPanel?.attach(this.app.querySelector<HTMLElement>('#siwc-local-panel'));
  this.app.setAttribute('aria-busy',String(this.v.busy));
  for(const b of [...this.app.querySelectorAll<HTMLButtonElement>('button'),...this.dialog.querySelectorAll<HTMLButtonElement>('button')])if((b.type==='submit'&&!b.closest('#followup-draft-form'))||writes.has(b.dataset.action||''))b.disabled=this.v.busy||(b.dataset.action==='native-verifier'&&!!this.v.snapshot?.spec?.stale)||(b.closest('#custom-flow-form')!==null&&this.customWizard?.state?.step===3&&this.customWizard.needsRecheck===true);
  if(this.v.busy)for(const control of [...this.app.querySelectorAll<HTMLInputElement>('form input,form select,form textarea'),...this.dialog.querySelectorAll<HTMLInputElement>('form input,form select,form textarea')])if(!control.closest('#followup-draft-form'))control.disabled=true;
  for(const control of this.dialog.querySelectorAll<HTMLInputElement>('#native-verifier-form input,#user-plan-revision textarea,#budget-confirm-form input,#maintenance-choice-form input,#lifecycle-choice-form input,#managed-import-form input,#managed-restore-form input,#sqlite-restore-form input,#sqlite-recovery-form input,#json-editor-form input,#json-editor-form textarea,#json-execute-form input,#json-restore-form input,#registered-backup-form input,#merge-recovery-form input,#executor-checkpoint-form input,#custom-flow-form input,#custom-flow-form select,#custom-flow-form textarea'))control.disabled=this.v.busy||control.dataset.roleAllowed==='false';
  if(this.v.screen==='project'&&this.v.tab==='work'&&this.v.snapshot?.project.state==='AWAITING_INTERVIEW_DECISION'&&!this.gateDismissed&&!this.dialog.open)this.showDialog('gate',gateContent(this.v));
 }
 private toast(message:string):void{const t=document.getElementById('toast');if(!t)return;if(this.toastTimer)clearTimeout(this.toastTimer);t.textContent=(this.adapter.presentation==='frontend-review'?'演示：':'')+message;t.hidden=false;this.toastTimer=setTimeout(()=>{t.hidden=true;},4000);}
 private showDialog(kind:string,content:string):void{
  if(kind!=='custom-flow')this.customWizard?.cancel();
  this.modalSeq++;this.dialog.dataset.kind=kind;
  if(kind!=='native-verifier')this.verifierBinding=null;
  if(kind!=='user-budget')this.userBudgetBinding=null;
  if(kind!=='maintenance')this.maintenanceBinding=null;
  if(kind!=='managed-import')this.managedImportBinding=null;
  if(kind!=='managed-restore')this.managedRestoreBinding=null;
  if(kind!=='sqlite-restore')this.sqliteRestoreBinding=null;
  if(!['sqlite-status','sqlite-recovery'].includes(kind))this.sqliteRecoveryPlan=null;
  if(kind!=='sqlite-recovery')this.sqliteRecoveryBinding=null;
  if(!['json-edit','json-execute'].includes(kind))this.jsonBinding=null;
  if(kind!=='json-restore')this.jsonRestoreBinding=null;
  if(kind!=='registered-backup')this.registeredBinding=null;
  if(kind!=='merge-recovery')this.mergeBinding=null;
  if(kind!=='executor-checkpoint')this.checkpointBinding=null;
  if(kind!=='review-preparation')this.reviewPreparation=null;
  if(kind!=='review-window')this.reviewWindow=null;
  if(kind!=='review-supplement')this.reviewSupplement=null;
  if(this.modalCleanup)clearTimeout(this.modalCleanup);this.modalCleanup=null;
  if(!this.dialog.open)this.modalReturn=document.activeElement instanceof HTMLElement?document.activeElement:null;this.modalKind=kind;
  this.dialog.classList.remove('is-closing','is-open');this.dialog.innerHTML=`<div class="dialog-surface">${this.adapter.presentation==='frontend-review'?'<p class="notice warning">前端导览演示 · 尚未连接真实制作，不操作账户、真实文件或费用。</p>':''}${content}<p id="dialog-error" class="dialog-error" role="alert"></p></div>`;
  if(!this.dialog.open)this.dialog.showModal();
  this.dialog.querySelector<HTMLElement>('textarea,input:not([type=hidden]),button,a')?.focus();
  if(this.dialog.querySelector('#dialog-description'))this.dialog.setAttribute('aria-describedby','dialog-description');else this.dialog.removeAttribute('aria-describedby');
  requestAnimationFrame(()=>{if(this.dialog.open)this.dialog.classList.add('is-open');});
 }
 private closeDialog():void{
  this.customWizard?.cancel();
  this.modalSeq++;
  this.verifierBinding=null;
  this.flowReportBinding=null;
  this.checkpointBinding=null;
  this.reviewPreparation=null;
  this.reviewWindow=null;
  this.reviewSupplement=null;
  this.userPlanBinding=null;
  this.userBudgetBinding=null;
  this.maintenanceBinding=null;
  this.managedImportBinding=null;this.managedRestoreBinding=null;
  this.sqliteRestoreBinding=null;
  this.sqliteRecoveryPlan=null;this.sqliteRecoveryBinding=null;
  this.jsonBinding=null;this.jsonRestoreBinding=null;
  this.registeredBinding=null;
  this.mergeBinding=null;
  if(!this.dialog.open)return;this.dialog.classList.remove('is-open');this.dialog.classList.add('is-closing');this.dialog.close();this.modalKind='';
  const ms=matchMedia('(prefers-reduced-motion: reduce)').matches?0:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur'))||150;
  this.modalCleanup=setTimeout(()=>{this.dialog.classList.remove('is-closing');this.modalCleanup=null;},ms);
  const back=this.modalReturn?.isConnected?this.modalReturn:this.app.querySelector<HTMLElement>('[role=tab][aria-selected=true]')||this.app.querySelector<HTMLElement>('#main-content');back?.focus({preventScroll:true});this.modalReturn=null;
 }
 private input(ev:Event):void{
  const t=ev.target;if(!(t instanceof HTMLInputElement||t instanceof HTMLTextAreaElement))return;
  if(t.form?.id==='custom-flow-form'){if(t.name!=='customConsent')this.customWizard?.update(new FormData(t.form));return;}
  if(t.dataset.draft&&!this.drafts.set(t.dataset.draft,t instanceof HTMLInputElement&&t.type==='checkbox'?String(t.checked):t.value))this.toast('输入过长，本次草稿未另存。编辑框中的全文保留，请先复制需要的内容。');
  if(t.name==='specSearch'&&!this.composing){this.v.specSearch=t.value;this.render();}
 }
 private change(ev:Event):void{
  const t=ev.target;
  if(t instanceof HTMLSelectElement&&t.form?.id==='custom-flow-form'){this.customWizard?.update(new FormData(t.form),true,t.name);return;}
  if(t instanceof HTMLSelectElement&&t.name==='p1ChoiceProvider'&&t.form?.id==='planner1-choice-form'){
   const form=t.form,model=form.querySelector<HTMLInputElement>('[name=p1ChoiceModel]');if(!model)return;
   this.drafts.set('p1-choice-model:'+(form.dataset.currentChoice??''),model.value);form.dataset.currentChoice=t.value;
   model.value=this.drafts.get('p1-choice-model:'+t.value);model.dataset.draft='p1-choice-model:'+t.value;
   const consent=form.querySelector<HTMLInputElement>('[name=p1ChoiceConsent]');if(consent)consent.checked=false;
   return;
  }
  if(t instanceof HTMLInputElement&&t.name==='jsonImportFile'&&t.files?.[0]){
   const file=t.files[0],binding=this.jsonBinding,seq=this.modalSeq;if(!binding||binding.kind!=='edit'||this.v.busy)return;
   void this.act(async()=>{if(file.size>100000)throw new UiError('JSON_DATA_PAYLOAD_LIMIT','');const value=await file.text();let parsed;try{parsed=JSON.parse(value);}catch{throw new UiError('JSON_DATA_INVALID','');}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new UiError('JSON_DATA_INVALID','');
    if(this.jsonBinding!==binding||this.modalSeq!==seq)return;this.drafts.set(binding.draftKey,value);const editor=this.dialog.querySelector<HTMLTextAreaElement>('#json-document');if(editor){editor.value=value;editor.focus();}});return;
  }
  if(t instanceof HTMLSelectElement&&t.dataset.draft)this.drafts.set(t.dataset.draft,t.value);
  if(t instanceof HTMLInputElement&&t.name==='flowName'&&t.checked&&t.dataset.draft){this.drafts.set(t.dataset.draft,t.value);this.render();return;}
  if(t instanceof HTMLInputElement&&t.name==='planFile'&&t.files?.[0]){const file=t.files[0];void this.act(async()=>{if(file.size>110000)throw new UiError('USER_PLAN_TOO_LARGE','方案文件过大，请使用完整方案导出格式。');const content=await file.text();JSON.parse(content);this.drafts.set('user-plan:document',content);});return;}
  if(t instanceof HTMLInputElement&&t.name==='optionId'){
   const p=this.v.snapshot?.project,q=p?.questions.find(q=>!p.answers.some(a=>a.questionId===q.id));
   if(p&&q)this.drafts.set('choices:'+p.id+':'+q.id,[...t.form!.querySelectorAll<HTMLInputElement>('[name=optionId]:checked')].map(i=>i.value).join(','));
  }
  if(t instanceof HTMLSelectElement&&t.name==='scenario'&&t.value&&this.adapter.selectScenario){const state=t.value;t.value='';void this.act(async()=>{const pid=this.v.snapshot!.project.id,token=this.epoch,s=await this.adapter.selectScenario!(pid,state);if(token===this.epoch)this.v.snapshot=s;});}
 }
 private field(form:HTMLFormElement,name:string):string{return String(new FormData(form).get(name)??'');}
 private async editUserPlan(note=''):Promise<void>{
  const p=this.v.snapshot?.project;if(!p?.specId)throw new UiError('COMPLETE_PROJECT_PLAN_REQUIRED','请先从方案工作台填写或导入完整方案；旧访谈原文会保留。');
  const token=this.epoch,parentId=p.specId,version=p.version,draftKey='user-plan:revision:'+p.id;
  if(!note){const saved=this.v.snapshot?.records.filter(row=>row.runId===p.activeRunId&&['FlowConclusion','FlowFollowup'].includes(row.kind)).at(-1)?.data as {userConstraint?:unknown}|undefined;if(typeof saved?.userConstraint==='string')note=saved.userConstraint;}
  const doc=await this.adapter.request('/projects/'+encodeURIComponent(p.id)+'/plan-document');
  if(token!==this.epoch||this.v.snapshot?.project.specId!==parentId)return;
  this.showDialog('user-plan',userPlanEditor(doc,this.drafts.get(draftKey),note,draftKey));this.userPlanBinding={pid:p.id,parentId,version,draftKey};
 }
 private submit(ev:Event):void{
  ev.preventDefault();if(this.composing)return;const f=ev.target as HTMLFormElement;
  if(f.id==='followup-draft-form'&&this.v.screen==='project'&&this.v.snapshot){this.drafts.set('followup:'+this.v.snapshot.project.id,String(new FormData(f).get('followupNote')??''));this.toast('问题草稿已保留在当前浏览器会话中，尚未发送给模型。');return;}
  if(this.v.busy)return;
  if(f.id==='custom-flow-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'){
   const data=new FormData(f);void this.act(()=>this.customFlow().submit(data));return;
  }
  if(f.id==='planner1-choice-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.product!=='dreamflow'){
   const data=new FormData(f),choice=String(data.get('p1ChoiceProvider')),parts=choice.split(':');
    if(!['kimi:oauth','openai:api_key','deepseek:api_key','local:none'].includes(choice)||!data.has('p1ChoiceConsent'))return;
   const token=this.epoch,seq=this.modalSeq,body={provider:parts[0],authentication:parts[1],model:String(data.get('p1ChoiceModel')??''),confirmed:true};
    void this.act(async()=>{const settings=await this.adapter.request<PublicConfig>('/planner1/selection','POST',body);if(token!==this.epoch)return;this.v.settings=settings;if(seq===this.modalSeq)this.closeDialog();this.toast(parts[0]==='local'?'本地选择已保存；请重新打开设置并完成本机与模型检查。':'选择已保存，尚未验证账户、模型或额度，没有开始调用。');});return;
  }
  if(f.id==='review-supplement-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='project'){
   const binding=this.reviewSupplement,token=this.epoch;if(!binding||!new FormData(f).has('reviewSupplementConsent'))return;
   if(!sameReviewSupplementBinding(reviewSupplementBinding(this.v.snapshot),binding)){this.showDialog('review-supplement','<h2 id="dialog-title">项目状态已变化</h2><p>请返回项目刷新，再重新核对补充复审条件。没有保存新的批准。</p><button type="button" data-action="close-modal">返回项目</button>');this.reviewSupplement=null;return;}
   this.reviewSupplement=null;this.showDialog('review-supplement','<h2 id="dialog-title">正在保存一次复审批准</h2><p>正在核对同一份成果与记录；不会调用模型或接受成果。</p><button type="button" data-action="close-modal">先返回项目</button>');
   const seq=this.modalSeq,current=()=>token===this.epoch&&this.v.screen==='project'&&this.v.snapshot?.project.id===binding.projectId&&this.v.snapshot.runs[0]?.id===binding.runId;
   this.readSeq++;void this.act(async()=>{try{
    const raw=await this.adapter.request('/runs/'+encodeURIComponent(binding.runId)+'/review-supplement','POST',reviewSupplementRequest(binding));if(!current())return;
    const ack=readReviewSupplementResult(raw,binding);this.readSeq++;const snapshot=await this.adapter.request<Snapshot>('/projects/'+encodeURIComponent(binding.projectId));this.readSeq++;if(!current())return;
    if(this.v.snapshot!.project.version>snapshot.project.version||this.v.snapshot!.runs[0].version>(snapshot.runs.find(r=>r.id===binding.runId)?.version??-1))throw new UiError('REVIEW_SUPPLEMENT_RESPONSE_INVALID','');
    this.v.snapshot=readReviewSupplementSnapshot(snapshot,binding,ack);this.v.error='';
    if(seq===this.modalSeq&&this.modalKind==='review-supplement'){this.closeDialog();const closedSeq=this.modalSeq;requestAnimationFrame(()=>{if(current()&&this.modalSeq===closedSeq&&!this.dialog.open&&!this.v.busy)this.focusPage();});this.toast('一次复审批准已保存，流程仍暂停；尚未调用模型或接受成果。');}
   }catch(error){if(current()&&seq===this.modalSeq&&this.modalKind==='review-supplement'){this.showDialog('review-supplement','<h2 id="dialog-title">复审批准尚未核清</h2><p>已有文件和费用记录保留。请返回项目刷新，暂不要重复提交或接受成果。</p><button type="button" data-action="close-modal">返回项目</button>');throw error;}}});return;
  }
  if(f.id==='review-window-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='project'){
   const binding=this.reviewWindow,token=this.epoch,form=new FormData(f);if(!binding||!form.has('reviewWindowConsent'))return;
   const body=reviewWindowRequest(binding,Number(form.get('reviewWindowSeconds')));this.reviewWindow=null;
   this.showDialog('review-window','<h2 id="dialog-title">正在核对继续时间</h2><p>正在检查现有文件和旧进程；不会调用模型。</p><button type="button" data-action="close-modal">先返回项目</button>');
   const seq=this.modalSeq,current=()=>token===this.epoch&&this.v.screen==='project'&&this.v.snapshot?.project.id===binding.projectId&&this.v.snapshot.runs[0]?.id===binding.runId;
   this.readSeq++;void this.act(async()=>{try{
    const raw=await this.adapter.request('/runs/'+encodeURIComponent(binding.runId)+'/review-window','POST',body);
    if(!current())return;this.readSeq++;this.v.snapshot=readReviewWindowResult(raw,binding);this.v.error='';
    if(seq===this.modalSeq&&this.modalKind==='review-window'){this.closeDialog();const closedSeq=this.modalSeq;
     requestAnimationFrame(()=>{if(current()&&this.modalSeq===closedSeq&&!this.dialog.open&&!this.v.busy)this.focusPage();});
     this.toast('继续时间已保存；请先核对材料，之后另行继续审查。');}
   }catch(error){if(current()&&seq===this.modalSeq&&this.modalKind==='review-window'){
    this.showDialog('review-window','<h2 id="dialog-title">继续时间尚未确认</h2><p>现有文件与费用记录保留。请返回项目刷新，暂不要重复提交。</p><button type="button" data-action="close-modal">返回项目</button>');throw error;
   }}});return;
  }
  if(f.id==='review-preparation-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='project'){
   const binding=this.reviewPreparation,token=this.epoch;if(!binding||!new FormData(f).has('reviewPreparationConsent'))return;
   this.reviewPreparation=null;this.showDialog('review-preparation','<h2 id="dialog-title">正在核对审查材料</h2><p>请等待本地服务检查文件、测试与旧进程；不会调用模型或接受成果。</p><button type="button" data-action="close-modal">先返回项目</button>');
   const seq=this.modalSeq,current=()=>token===this.epoch&&this.v.screen==='project'&&this.v.snapshot?.project.id===binding.projectId&&this.v.snapshot.runs[0]?.id===binding.runId;
   this.readSeq++;void this.act(async()=>{try{
    const raw=await this.adapter.request('/runs/'+encodeURIComponent(binding.runId)+'/prepare-review','POST',reviewPreparationRequest(binding));
    if(!current())return;this.readSeq++;this.v.snapshot=readReviewPreparationResult(raw,binding);this.v.error='';
    if(seq===this.modalSeq&&this.modalKind==='review-preparation'){
     this.closeDialog();const closedSeq=this.modalSeq;
     requestAnimationFrame(()=>{if(current()&&this.modalSeq===closedSeq&&!this.dialog.open&&!this.v.busy)this.focusPage();});
     this.toast('材料已核对，流程保持暂停；没有自动调用模型或接受成果。');
    }
   }catch(error){if(current()&&seq===this.modalSeq&&this.modalKind==='review-preparation'){
    this.showDialog('review-preparation','<h2 id="dialog-title">核对结果尚未确认</h2><p>原文件、测试和费用记录保留。请返回项目刷新状态，暂不要重复提交或接受成果。</p><button type="button" data-action="close-modal">返回项目</button>');throw error;
   }}});return;
  }
  if(f.id==='executor-checkpoint-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='project'){
   const binding=this.checkpointBinding,token=this.epoch;if(!binding||!new FormData(f).has('checkpointConsent'))return;
   this.checkpointBinding=null;this.showDialog('executor-checkpoint','<h2 id="dialog-title">正在核对并保留文件</h2><p>请等待本地服务检查旧进程和工具记录；没有调用模型或确认任务完成。</p><button type="button" data-action="close-modal">先返回项目</button>');
   const seq=this.modalSeq,current=()=>token===this.epoch&&this.v.screen==='project'&&this.v.snapshot?.project.id===binding.pid&&this.v.snapshot.runs[0]?.id===binding.preview.runId;
   void this.act(async()=>{try{
    const result=readExecutorCheckpointResult(await this.adapter.request('/runs/'+encodeURIComponent(binding.preview.runId)+'/executor-checkpoint','POST',{confirmed:true,previewHash:binding.preview.previewHash}),binding.preview);
    if(!current())return;this.readSeq++;const snapshot=await this.adapter.request<Snapshot>('/projects/'+encodeURIComponent(binding.pid));this.readSeq++;if(!current())return;
    const recovered=snapshot.runs.find(run=>run.id===binding.preview.runId);
    if(snapshot.project.id!==binding.pid||snapshot.project.version<this.v.snapshot!.project.version||recovered?.state!=='PAUSED'||recovered.version!==result.runVersion||recovered.executorCheckpointRequired!==false||binding.preview.tasks.some(task=>recovered.tasks.find(t=>t.id===task.taskId)?.status!=='pending'))throw new UiError('EXECUTOR_CHECKPOINT_RESPONSE_INVALID','');
    this.v.snapshot=snapshot;this.v.error='';if(seq===this.modalSeq&&this.modalKind==='executor-checkpoint'){this.closeDialog();this.toast('已保留文件并准备未完成任务，流程保持暂停；没有开始新的制作。');}
   }catch(error){if(current()&&seq===this.modalSeq&&this.modalKind==='executor-checkpoint'){
    this.showDialog('executor-checkpoint','<h2 id="dialog-title">准备结果还没有核清</h2><p>现有文件与副本保留。请返回项目刷新状态，再核对下一步；不能直接重复提交或开始制作。</p><button type="button" data-action="close-modal">返回项目</button>');throw error;
   }}});return;
  }
  if(f.id==='merge-recovery-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='project'){
   const binding=this.mergeBinding,token=this.epoch,data=new FormData(f),choice=data.get('mergeChoice');
   if(!binding||binding.pid!==this.v.snapshot?.project.id||binding.preview.runId!==this.v.snapshot.runs[0]?.id||!data.has('mergeConsent')||!['KEEP_FILES_AND_END','RESTORE_BASE_AND_END'].includes(String(choice)))return;
   this.mergeBinding=null;this.showDialog('merge-recovery','<h2 id="dialog-title">正在核对并处理文件</h2><p>请等待本地服务核对旧进程、保留副本与当前源码；尚未宣告恢复完成。</p><button type="button" data-action="close-modal">先返回项目</button>');
   const sequence=this.modalSeq,current=()=>token===this.epoch&&this.v.screen==='project'&&this.v.snapshot?.project.id===binding.pid&&this.v.snapshot.runs[0]?.id===binding.preview.runId;
   void this.act(async()=>{
    try{readMergeRecoveryResult(await this.adapter.request('/runs/'+encodeURIComponent(binding.preview.runId)+'/merge-recovery','POST',{choice,previewHash:binding.preview.previewHash,expectedHash:binding.preview.source.currentHash,confirmed:true}),binding.preview,choice as MergeRecoveryChoice);
     if(!current())return;
     // Unlike periodic refresh, a completed explicit operation must refresh while act() is busy.
     // Apply only to the original page, then leave any subsequently opened dialog alone.
     this.readSeq++;const snapshot=await this.adapter.request<Snapshot>('/projects/'+encodeURIComponent(binding.pid));this.readSeq++;
     if(!current())return;
     const recovered=snapshot.runs.find(run=>run.id===binding.preview.runId);
     if(snapshot.project.id!==binding.pid||snapshot.project.version<this.v.snapshot!.project.version||recovered?.state!=='CANCELLED'||recovered.mergeRecoveryRequired!==false)throw new UiError('MERGE_RECOVERY_RESPONSE_INVALID','');
     this.v.snapshot=snapshot;this.v.error='';
     if(sequence===this.modalSeq&&this.modalKind==='merge-recovery'){this.closeDialog();this.toast(choice==='KEEP_FILES_AND_END'?'当前文件与恢复副本已保留，旧轮次已结束；尚未通过制作审查。':'已还原合并前源码并保留副本，旧轮次已结束；没有开始下一轮。');}
    }catch(error){if(current()&&sequence===this.modalSeq&&this.modalKind==='merge-recovery'){this.showDialog('merge-recovery','<h2 id="dialog-title">本次恢复还没有核清</h2><p>现有文件和副本保留。请重新检查当前状态，再选择处理方式；不会自动重做或继续制作。</p><button type="button" data-action="merge-recovery">重新核对文件</button><button type="button" data-action="close-modal">先返回项目</button>');throw error;}}
   });return;
  }
  if(f.id==='registered-backup-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='maintenance'){
   const binding=this.registeredBinding,token=this.epoch;if(!binding||!new FormData(f).has('registeredConsent'))return;this.v.registeredExtraction=undefined;
   void this.act(async()=>{const value=await this.adapter.request<Record<string,unknown>>('/maintenance/registered-backups'+(binding.kind==='extract'?'/'+encodeURIComponent(binding.id)+'/extract':''),'POST',{confirmed:true});
    if(binding.kind==='create'&&(value.schema!=='dream-maker.registered-backup.v2'||value.scope!=='REGISTERED_STATE_AND_PROJECT_FILES'||value.completeProjectBackup!==false||typeof value.id!=='string'||!/^snapshot_[a-f0-9]{32}$/.test(value.id)))throw new UiError('REGISTERED_BACKUP_STATUS_INVALID','');
    if(token!==this.epoch)return;if(binding.kind==='extract')this.v.registeredExtraction=readRegisteredExtraction(value,binding.id);this.closeDialog();await this.maintenance();this.toast(binding.kind==='create'?'本机副本已创建，包含已登记成果；凭据和未知外部数据不在范围。':'文件已提取到新目录；没有覆盖原工作数据或开始运行。');});return;
  }
  if((f.id==='json-editor-form'||f.id==='json-execute-form')&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='project'){
   const binding=this.jsonBinding,token=this.epoch;if(!binding||binding.pid!==this.v.snapshot?.project.id||binding.runId!==this.v.snapshot.runs[0]?.id||!new FormData(f).has('jsonConsent'))return;
   const content=this.field(f,'jsonDocument');
   void this.act(async()=>{
    const base='/runs/'+encodeURIComponent(binding.runId)+'/json-data';let value;
    if(binding.kind==='execute')value=await this.adapter.request(base+'/execute','POST',{treeHash:binding.treeHash,expectedRevision:binding.revision,confirmed:true});
    else{let document;try{document=JSON.parse(content);}catch{throw new UiError('JSON_DATA_INVALID','');}
     value=await this.adapter.request(base+(binding.revision?'':'/import'),'POST',binding.revision?{treeHash:binding.treeHash,expectedRevision:binding.revision,document}:{treeHash:binding.treeHash,document,confirmed:true});}
    const data=readJsonData(value,binding.pid);if(token!==this.epoch)return;this.v.jsonData=data;if(binding.kind==='edit')this.drafts.delete(binding.draftKey);this.closeDialog();this.toast('项目数据已核对并保存，当前版本 '+data.revision+'。没有发起模型请求。');
   });return;
  }
  if(f.id==='json-restore-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='maintenance'){
   const binding=this.jsonRestoreBinding,token=this.epoch;if(!binding||!new FormData(f).has('jsonConsent'))return;
   void this.act(async()=>{const current=readJsonData(await this.adapter.request('/projects/'+encodeURIComponent(binding.projectId)+'/json-data/restore','POST',{snapshotId:binding.snapshotId,rehearsalId:binding.rehearsalId,expectedRevision:binding.target.revision,confirmed:true}),binding.projectId);
    if(token!==this.epoch)return;this.v.managedRestoreResult={projectId:binding.projectId,revision:current.revision,at:new Date().toISOString()};this.closeDialog();await this.maintenance();this.toast('项目业务数据已恢复为新版本；没有修改源码或启动运行。');});return;
  }
  if(f.id==='review-confirm-form'&&this.adapter.presentation==='frontend-review'){
   if(!new FormData(f).has('reviewConsent'))return;this.showDialog('review-data','<h2 id="dialog-title">操作体验已完成</h2><p>没有创建备份、恢复数据、迁移文件或生成核验回执。真实接入后，仍要检查数据范围、一致性和恢复结果。</p><button type="button" data-action="close-modal">返回维护页</button>');return;
  }
  if(f.id==='review-preferences-form'&&this.adapter.presentation==='frontend-review'){
   const choice=new FormData(f).get('reviewPlanner');if(!['cloud','local'].includes(String(choice)))return;this.drafts.set('review-planner',String(choice));this.closeDialog();this.toast('已保留本页选择；本地模型尚未连接，没有下载或切换真实角色。');return;
  }
  if(f.id==='lifecycle-choice-form'&&this.prepAvailable()){
   const data=new FormData(f),choice=data.get('exitChoice');if(!data.has('exitConsent')||!['PAUSE','BACKGROUND_CURRENT_WORK'].includes(String(choice)))return;
   this.v.lifecycle=undefined;this.showDialog('lifecycle',lifecycleConfirmation());const seq=this.modalSeq;
   void this.act(async()=>{const value=readLifecycleStatus(await this.adapter.request('/application/lifecycle','POST',{choice,confirmed:true}));this.v.lifecycle=value;if(!this.disposed&&this.modalKind==='lifecycle'&&this.modalSeq===seq)this.showDialog('lifecycle',lifecycleConfirmation(value));});
  }else if(f.id==='managed-import-form'&&this.adapter.mode==='local'&&this.v.screen==='project'){
   const binding=this.managedImportBinding,token=this.epoch;if(!binding||binding.pid!==this.v.snapshot?.project.id||!new FormData(f).has('managedConsent'))return;
   void this.act(async()=>{const old=this.previewStorage.legacySnapshot();if(JSON.stringify(old.tasks)!==JSON.stringify(binding.tasks))throw new UiError('MANAGED_DATA_LEGACY_CHANGED','');
    const result=readManagedData(await this.adapter.request('/runs/'+encodeURIComponent(binding.runId)+'/data/import','POST',{treeHash:binding.treeHash,tasks:binding.tasks,confirmed:true}),binding.pid);
    if(token!==this.epoch)return;this.v.previewData=result;this.closeDialog();this.toast('已复制到本机数据版本；旧浏览器副本保留，旧预览不会自动改用新数据。');});
  }else if(f.id==='sqlite-recovery-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='project'){
   const binding=this.sqliteRecoveryBinding,token=this.epoch;if(!binding||!new FormData(f).has('sqliteRecoveryConsent'))return;
   void this.act(async()=>{
    const current=sqliteStatusBinding(this.v.snapshot);
    if(!current||current.projectId!==binding.plan.projectId)throw new UiError('SQLITE_DATA_RECOVERY_CHANGED','项目状态已变化，请返回项目重新核对。');
    const value=readSqliteStatus(await this.adapter.request('/projects/'+encodeURIComponent(current.projectId)+'/sqlite-data/recovery','POST',{operationHash:binding.candidate.operationHash,confirmed:true}),current.projectId);
    if(!value.operation||value.operation.hash!==binding.candidate.operationHash||value.operation.appliedRevision!==binding.candidate.expectedRevision+1)
     throw new UiError('SQLITE_DATA_RECOVERY_CHANGED','恢复结果与原记录不一致，请重新核对保存状态。');
    if(token!==this.epoch)return;
    this.closeDialog();await this.projectSqliteStatus();
    if(token!==this.epoch)return;
    this.toast('已核对实际镜像并恢复为新的数据库版本；没有重跑模型、制作或审查。');
   });return;
  }else if(f.id==='sqlite-restore-form'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='maintenance'){
   const binding=this.sqliteRestoreBinding,token=this.epoch;if(!binding||!new FormData(f).has('sqliteConsent'))return;this.v.sqliteRestoreResult=undefined;
   void this.act(async()=>{const value=readSqliteStatus(await this.adapter.request('/projects/'+encodeURIComponent(binding.projectId)+'/sqlite-data/restore','POST',{snapshotId:binding.snapshotId,rehearsalId:binding.rehearsalId,expectedRevision:binding.target.revision,confirmed:true}),binding.projectId);
    if(!value.operation||value.operation.appliedRevision!==value.revision)throw new UiError('SQLITE_DATA_CONFLICT','');
    if(token!==this.epoch)return;this.v.sqliteRestoreResult={projectId:binding.projectId,revision:value.revision,at:new Date().toISOString()};this.closeDialog();await this.maintenance();this.toast('项目数据库已生成新的历史版本；应用数据库、源码和审批记录未被覆盖。');});
  }else if(f.id==='managed-restore-form'&&this.adapter.mode==='local'&&this.v.screen==='maintenance'){
   const binding=this.managedRestoreBinding,token=this.epoch;if(!binding||!new FormData(f).has('managedConsent'))return;this.v.managedRestoreResult=undefined;
   void this.act(async()=>{const value=await this.adapter.request<ManagedDataOperationView>('/projects/'+encodeURIComponent(binding.projectId)+'/data/restore','POST',{snapshotId:binding.snapshotId,rehearsalId:binding.rehearsalId,expectedRevision:binding.target.revision,confirmed:true});const current=readManagedData(value,binding.projectId);
    if(!value.operation||value.operation.appliedRevision!==current.revision)throw new UiError('MANAGED_DATA_CONFLICT','');
    if(token!==this.epoch)return;this.v.managedRestoreResult={projectId:binding.projectId,revision:current.revision,at:new Date().toISOString()};this.closeDialog();await this.maintenance();this.toast('仅任务数据已写入新版本；源码、批准和费用记录保留。');});
  }else if(f.id==='maintenance-choice-form'&&this.prepAvailable()&&this.v.screen==='maintenance'){
   const binding=this.maintenanceBinding,token=this.epoch;if(!binding||!new FormData(f).has('maintenanceConsent'))return;
   this.v.maintenanceResult=undefined;this.v.managedRestoreResult=undefined;this.v.sqliteRestoreResult=undefined;
   void this.act(async()=>{const value=await this.adapter.request<Record<string,unknown>>(binding.kind==='create'?'/maintenance/snapshots':'/maintenance/snapshots/'+encodeURIComponent(binding.id)+'/rehearse','POST',{confirmed:true});
    if(binding.kind==='rehearse'&&(value.scope!=='READONLY_RESTORE_REHEARSAL_ONLY'||value.engineStarted!==false))throw new UiError('MAINTENANCE_STATUS_INVALID','演练范围尚未确认，请核对已有副本，没有自动重试。');
    if(binding.kind==='create'&&(value.scope!=='APPLICATION_STATE_ONLY'||value.completeProjectBackup!==false))throw new UiError('MAINTENANCE_STATUS_INVALID','备份范围尚未确认，请刷新记录，没有自动重试。');
    if(token!==this.epoch)return;if(binding.kind==='rehearse')this.v.maintenanceResult=value as unknown as RestoreRehearsal;this.closeDialog();await this.maintenance();this.toast(binding.kind==='create'?'控制端状态副本已创建；项目业务文件不在此范围。':'只读演练已核对；没有覆盖工作数据或启动运行。');});
  }else if(f.id==='budget-limit-form'&&this.prepAvailable()&&['setup','fees'].includes(this.v.screen)){
   const current=this.v.setup?.fees.userBudget;if(!current||!this.v.setup?.fees.userBudgetAvailable)return;
   const submitted=new FormData(f),limits={CNY:String(submitted.get('budgetCNY')??'').trim(),USD:String(submitted.get('budgetUSD')??'').trim()};
   this.showDialog('user-budget',budgetConfirmation(limits));this.userBudgetBinding={revision:current.revision,limits};
  }else if(f.id==='budget-confirm-form'&&this.prepAvailable()&&['setup','fees'].includes(this.v.screen)){
   const binding=this.userBudgetBinding,token=this.epoch;if(!binding||!new FormData(f).has('budgetConsent'))return;
   void this.act(async()=>{await this.adapter.request('/onboarding/budget','POST',{limits:binding.limits,revision:binding.revision,confirmed:true});
    if(token!==this.epoch)return;this.drafts.delete('setup-budget:CNY');this.drafts.delete('setup-budget:USD');this.closeDialog();await this.setup(this.v.screen==='fees'?'fees':'setup');this.toast('限额已保存；已重新读取当前账本，没有开始任务。');});
  }else if(['user-plan-form','user-plan-import','user-plan-revision'].includes(f.id)){
   const binding=this.userPlanBinding,token=this.epoch,submitted=new FormData(f);
   void this.act(async()=>{let document:unknown;try{document=f.id==='user-plan-form'?userPlanFromFields(k=>String(submitted.get(k)??''),k=>submitted.has(k)):JSON.parse(String(submitted.get('document')??''));}catch{throw new UiError('USER_PLAN_FORMAT_INVALID','方案内容无法读取；输入已保留，请检查文件格式。');}
    if(f.id==='user-plan-revision'&&(!binding||binding.pid!==this.v.snapshot?.project.id))throw new UiError('STALE_PLAN_PARENT','请重新打开当前方案后再修订。');
    const s=await this.adapter.request<Snapshot>(f.id==='user-plan-revision'?'/projects/'+encodeURIComponent(binding!.pid)+'/user-plan':'/user-plans','POST',f.id==='user-plan-revision'?{document,version:binding!.version,parentId:binding!.parentId}:{document});
    if(token!==this.epoch)return;this.closeDialog();await this.list();await this.open(s.project.id);this.v.tab='spec';this.url();this.drafts.delete(f.id==='user-plan-revision'?binding!.draftKey:'user-plan:document');this.toast('方案已保存，尚未确认或开始制作。');});
  }else if(f.id==='new-project'){
   const body={name:this.field(f,'projectName').trim(),idea:this.field(f,'idea').trim(),mode:this.field(f,'mode'),apiConsent:new FormData(f).has('apiConsent'),siwcPlanConsent:new FormData(f).has('siwcPlanConsent'),kimiConsent:new FormData(f).has('kimiConsent'),localConsent:new FormData(f).has('localConsent'),publicResearch:new FormData(f).has('publicResearch')};const token=this.epoch;
   void this.act(async()=>{let s=await this.adapter.request<Snapshot>('/projects','POST',body);this.drafts.delete('projectName');this.drafts.delete('idea');await this.list();if(token!==this.epoch)return;await this.open(s.project.id);s=await this.nextIfNeeded(this.v.snapshot!);if(this.v.snapshot?.project.id===s.project.id)this.v.snapshot=s;});
  }else if(f.id==='answer-form'){
   const p=this.v.snapshot!.project,q=p.questions.find(q=>!p.answers.some(a=>a.questionId===q.id));if(!q)return;
   const text=this.field(f,'answer'),optionIds=new FormData(f).getAll('optionId').map(String);void this.act(async()=>{let s=await this.mutate('answer',{questionId:q.id,text,optionIds,version:p.version},p.id);this.drafts.delete('answer:'+p.id+':'+q.id);this.drafts.delete('choices:'+p.id+':'+q.id);this.gateDismissed=false;await this.nextIfNeeded(s);});
  }else if(f.id==='edit-answer-form'){
   const p=this.v.snapshot!.project,qid=this.field(f,'questionId'),text=this.field(f,'editedAnswer'),token=this.epoch;void this.act(async()=>{await this.mutate('answer',{questionId:qid,text,version:p.version},p.id);this.drafts.delete('edit:'+p.id+':'+qid);if(token!==this.epoch)return;this.gateDismissed=true;this.v.tab='answers';this.closeDialog();this.toast('回答已修改；旧规格与确认需要重新核对。');});
  }else if(f.id==='semantics-form'&&this.adapter.mode==='local'&&this.v.snapshot?.spec){
   const pid=this.v.snapshot.project.id,token=this.epoch;
   const body=semanticPayload(this.v.snapshot.spec,name=>this.field(f,name),new FormData(f).has('semanticConsent'));
   void this.act(async()=>{await this.mutate('semantics',body,pid);if(token===this.epoch)this.toast('已保存分类与验收；新规格需要重新确认。');});
  }else if(f.id==='native-verifier-form'&&this.adapter.mode==='local'){
   const binding=this.verifierBinding,token=this.epoch;
   if(!binding||this.v.snapshot?.project.mode!=='live'||this.v.snapshot.project.id!==binding.pid||this.v.snapshot.spec?.stale||this.v.snapshot.spec?.hash!==binding.specHash||!new FormData(f).has('verifierConsent'))return;
   void this.act(async()=>{
    const result=await this.adapter.request<{specHash:string;planHash:string;approved:boolean}>('/projects/'+encodeURIComponent(binding.pid)+'/native-verifier/approve','POST',{specHash:binding.specHash,planHash:binding.planHash,approved:true});
    if(token!==this.epoch)return;
    if(result.specHash!==binding.specHash||result.planHash!==binding.planHash||result.approved!==true)throw new UiError('VERIFIER_APPROVAL_UNCERTAIN','服务端确认不匹配，请重新核对；未自动重试。');
    if(this.verifierBinding===binding){this.closeDialog();this.toast('验收计划已确认；测试尚未执行，构建仍需单独批准。');}
    this.pendingRefresh=true;
   });
  }else if(f.id==='spec-notes'){
   const pid=this.v.snapshot!.project.id,notes=this.field(f,'notes');void this.act(async()=>{await this.mutate('finish',{notes,summarize:false},pid);this.drafts.delete('notes:'+pid);this.toast('已生成新规格；旧确认失效。');});
  }else if(f.id==='build-form'){
   const body={specHash:this.v.snapshot!.spec!.hash,approved:new FormData(f).has('buildConsent'),demoFault:new FormData(f).has('demoFault'),...(this.adapter.mode==='local'?{flowName:this.field(f,'flowName'),laya:new FormData(f).has('flowLaya')}:{})},token=this.epoch;void this.act(async()=>{await this.mutate('build',body);if(token!==this.epoch)return;this.v.tab='work';this.url();});
  }else if(f.id==='settings-form'){
   const roles=Object.fromEntries(['planner1','planner2','executor','reviewer'].map(r=>[r,r==='planner1'&&this.product==='dreamflow'?this.v.settings?.config.laya.roles.planner1:this.field(f,'laya_'+r)]));
   const managedPlanner1=['kimi','local'].includes(this.v.settings?.planner1Binding?.provider??this.v.settings?.config.planner1.provider??'');
   const body={...(this.product==='dreamflow'||managedPlanner1?{}:{planner1:{protocol:this.field(f,'protocol'),model:this.field(f,'p1Model'),authMode:this.field(f,'authMode')}}),codexModel:this.field(f,'codexModel'),clash:{enabled:new FormData(f).has('clashEnabled'),selector:this.field(f,'clashSelector'),node:this.field(f,'clashNode'),selectionPolicy:this.field(f,'clashSelectionPolicy'),expectedMode:this.field(f,'clashExpectedMode')},laya:{mode:this.field(f,'layaMode'),roles},limits:{maxRepairs:Number(this.field(f,'maxRepairs')),maxCalls:Number(this.field(f,'maxCalls')),maxSeconds:Number(this.field(f,'maxSeconds')),stepTimeoutMs:Number(this.field(f,'stepTimeoutMs')),idleTimeoutMs:Number(this.field(f,'idleTimeoutMs'))}};
    void this.act(async()=>{this.v.settings=await this.adapter.request<PublicConfig>('/config','PUT',body);this.networkSeq++;this.v.networkLoading=false;if(this.v.networkContexts)this.v.networkContexts.currentConfiguration=false;this.codexMetadataSeq++;this.v.codexMetadataLoading=false;if(this.v.codexMetadata)this.v.codexMetadata.currentConfiguration=false;this.v.clash=await this.adapter.request<ClashStatus>('/clash');if(canReadSiwcStatus(this.v.settings))await this.siwcPanel?.load();else this.siwcPanel?.detach();this.toast('设置已保存；不会自动连接或切换到收费调用。');});
  }
 }
 private async loadFiles():Promise<void>{const r=this.v.snapshot?.runs[0];if(!r)return;const token=this.epoch;const data=await this.adapter.request<{files:{path:string;bytes:number}[]}>('/runs/'+encodeURIComponent(r.id)+'/files');if(token===this.epoch&&this.v.snapshot?.runs[0]?.id===r.id){this.v.files=data.files;this.render();}}
 private async copy(text:string):Promise<void>{try{await navigator.clipboard.writeText(text);this.toast('已复制。');}catch{this.toast('浏览器不允许自动复制，请在文本区选择后手动复制。');}}
 private customFlow():CustomFlowWizard {
  return this.customWizard??=new CustomFlowWizard(this.adapter,this.drafts,{
   dreamflow:this.product==='dreamflow',
   active:pid=>!this.disposed&&this.modalKind==='custom-flow'&&this.v.screen==='project'&&this.v.snapshot?.project.id===pid,
   show:(html,focusName)=>{this.showDialog('custom-flow',html);const form=this.dialog.querySelector<HTMLFormElement>('#custom-flow-form'),control=focusName?form?.elements.namedItem(focusName):null;if(control instanceof HTMLElement)control.focus();else this.dialog.querySelector<HTMLElement>('#custom-step-title')?.focus();},
   error:message=>{const target=this.dialog.querySelector('#custom-form-error')??this.dialog.querySelector('#dialog-error');if(target)target.textContent=message;},
   saved:value=>{this.closeDialog();this.toast('自定义配置 v'+value.revision+' 已保存；账户与模型尚未验证，没有开始制作。');},
   specHash:pid=>{const current=this.v.snapshot;return current?.project.id===pid&&current.project.state==='READY_TO_BUILD'&&!current.spec?.stale?current.spec?.hash??null:null;}
  });
 }
 private click(ev:MouseEvent):void{
  const b=(ev.target as Element)?.closest<HTMLElement>('[data-action]');if(!b||!this.owned(b))return;
  if(b instanceof HTMLAnchorElement&&(ev.ctrlKey||ev.metaKey||ev.shiftKey||ev.button!==0))return;
  ev.preventDefault();const action=b.dataset.action!;
  if(action==='network-read'){void this.readNetwork();return;}
  if(action==='magpie-read'){void this.readMagpie();return;}
  if(action==='magpie-check'){void this.readMagpie(true);return;}
  if(action==='network-test'){void this.readNetwork(true);return;}
  if(action==='codex-metadata-read'){void this.readCodexMetadata();return;}
  if(action==='custom-close'){this.closeDialog();return;}
  if(action==='custom-configure'){
   if(this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.busy||this.v.screen!=='project'||!this.v.snapshot)return;
   const pid=this.v.snapshot.project.id;void this.act(()=>this.customFlow().open(pid));return;
  }
  if(action.startsWith('custom-')){
   if(this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.busy||this.modalKind!=='custom-flow')return;
   const wizard=this.customFlow(),form=this.dialog.querySelector<HTMLFormElement>('#custom-flow-form');
   if(action==='custom-read-account-identities'&&form){void this.act(()=>wizard.readAccountIdentities());return;}
   if(action==='custom-attach-account-identity'&&form){wizard.attachAccountIdentity(new FormData(form),Number(b.dataset.index),b.dataset.target??'',b.dataset.targetAccount??'',b.dataset.source??'',b.dataset.sourceAccount??'');return;}
   if(action==='custom-bind-dsh-source'&&form){const fields=new FormData(form);void this.act(()=>wizard.bindDshSource(fields,Number(b.dataset.index??0)));return;}
   if(action==='custom-read-models'&&form){const fields=new FormData(form);void this.act(()=>wizard.readMagpieModels(fields));return;}
   if(action==='custom-recommend-member'&&form){const fields=new FormData(form);void this.act(()=>wizard.recommendMember(fields,b.dataset.roleId??''));return;}
   if(action==='custom-account-read'){void this.act(()=>wizard.readAccountCheck());return;}
   if(action==='custom-account-check'&&form){const fields=new FormData(form);void this.act(()=>wizard.checkAccounts(fields));return;}
   if(action==='custom-account-recover'&&form){const fields=new FormData(form);void this.act(()=>wizard.recoverAccountCheck(fields));return;}
   if((action==='custom-role-read'||action==='custom-role-probe')&&form){const fields=new FormData(form);void this.act(()=>wizard.checkRole(fields,b.dataset.roleId??'',action==='custom-role-probe'));return;}
   if(action==='custom-role-recover'){void this.act(()=>wizard.readPendingRole());return;}
   if(action==='custom-recheck'){void this.act(()=>wizard.recheck());return;}
   if(action==='custom-load-latest'){void this.act(()=>wizard.loadLatest());return;}
   if(action==='custom-reload'&&wizard.projectId){const pid=wizard.projectId;void this.act(()=>wizard.open(pid));return;}
   if(form)wizard.edit(action.slice(7),new FormData(form),Number(b.dataset.index??0),Number(b.dataset.member??0),Number(b.dataset.role??0));return;
  }
  if(action==='review-supplement'){
   if(this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.busy||this.v.screen!=='project')return;
   const binding=reviewSupplementBinding(this.v.snapshot),token=this.epoch;if(!binding)return;
   this.reviewSupplement=null;this.showDialog('review-supplement','<h2 id="dialog-title">正在核对补充复审条件</h2><p>只读取材料、原审查与运行记录，不调用模型。</p><button type="button" data-action="close-modal">返回项目</button>');const seq=this.modalSeq;
   const current=()=>token===this.epoch&&seq===this.modalSeq&&this.modalKind==='review-supplement'&&this.v.screen==='project'&&this.v.snapshot?.project.id===binding.projectId&&this.v.snapshot.runs[0]?.id===binding.runId;
   void this.act(async()=>{try{const raw=await this.adapter.request('/runs/'+encodeURIComponent(binding.runId)+'/review-supplement');if(!current())return;
    if(!sameReviewSupplementBinding(reviewSupplementBinding(this.v.snapshot),binding))throw new UiError('REVIEW_SUPPLEMENT_RESPONSE_INVALID','');
    const preview=readReviewSupplementPreview(raw,binding);this.showDialog('review-supplement',reviewSupplementConfirmation(preview));this.reviewSupplement=preview;
   }catch(error){if(current()){this.showDialog('review-supplement','<h2 id="dialog-title">补充复审条件还未核清</h2><p>当前尚不能保存新的复审批准。已有文件与记录保留，请返回项目查看报告并刷新状态。</p><button type="button" data-action="close-modal">返回项目</button>');throw error;}}});return;
  }
  if(action==='review-window'){
   if(this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.busy||this.v.screen!=='project')return;
   const binding=reviewWindowBinding(this.v.snapshot);if(!binding)return;
   this.showDialog('review-window',reviewWindowConfirmation());this.reviewWindow=binding;return;
  }
  if(action==='review-preparation'){
   if(this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.busy||this.v.screen!=='project')return;
   const binding=reviewPreparationBinding(this.v.snapshot);if(!binding)return;
   this.showDialog('review-preparation',reviewPreparationConfirmation());this.reviewPreparation=binding;return;
  }
  if(action==='executor-checkpoint'){
   if(this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.busy||this.v.screen!=='project')return;
   const r=this.v.snapshot?.runs[0],pid=this.v.snapshot?.project.id,token=this.epoch;if(!r?.executorCheckpointRequired||!pid)return;
   this.checkpointBinding=null;this.showDialog('executor-checkpoint','<h2 id="dialog-title">正在检查已写文件</h2><p>只读取任务副本和操作记录；不会调用模型、修改源码或接受成果。</p><button type="button" data-action="close-modal">返回项目</button>');const seq=this.modalSeq;
   void this.act(async()=>{try{const view=readExecutorCheckpointPreview(await this.adapter.request('/runs/'+encodeURIComponent(r.id)+'/executor-checkpoint'),r.id);if(token!==this.epoch||seq!==this.modalSeq||this.modalKind!=='executor-checkpoint')return;this.showDialog('executor-checkpoint',executorCheckpointConfirmation(view));this.checkpointBinding={pid,preview:view};}
   catch(error){if(token===this.epoch&&seq===this.modalSeq&&this.modalKind==='executor-checkpoint'){this.showDialog('executor-checkpoint','<h2 id="dialog-title">任务文件还没有核清</h2><p>请保留原文件与副本，先核对工具操作和进程状态。没有获得继续制作的许可。</p><button type="button" data-action="close-modal">返回项目</button>');throw error;}}});return;
  }
  if(action==='merge-recovery'){
   if(this.adapter.mode!=='local'||this.adapter.presentation==='frontend-review'||this.v.busy||this.v.screen!=='project')return;
   const r=this.v.snapshot?.runs[0],pid=this.v.snapshot?.project.id,token=this.epoch;if(!r?.mergeRecoveryRequired||!pid)return;
   this.mergeBinding=null;this.showDialog('merge-recovery','<h2 id="dialog-title">正在检查未完成合并</h2><p>只读取源码与副本；不会修改文件、启动角色或发起模型请求。</p><button type="button" data-action="close-modal">返回项目</button>');const seq=this.modalSeq;
   void this.act(async()=>{try{const value=readMergeRecoveryPreview(await this.adapter.request('/runs/'+encodeURIComponent(r.id)+'/merge-recovery'),r.id);if(token!==this.epoch||seq!==this.modalSeq||this.modalKind!=='merge-recovery')return;this.showDialog('merge-recovery',mergeRecoveryConfirmation(value));this.mergeBinding={pid,preview:value};}catch(error){if(token===this.epoch&&seq===this.modalSeq&&this.modalKind==='merge-recovery'){this.showDialog('merge-recovery','<h2 id="dialog-title">文件检查还没有完成</h2><p>没有获得恢复许可。请保留原目录与副本，核对后再处理。</p><button type="button" data-action="merge-recovery">重新核对文件</button><button type="button" data-action="close-modal">先返回项目</button>');throw error;}}});return;
  }
  if(action==='tour-page'&&this.adapter.presentation==='frontend-review'){
   const page=tourPages[Number(b.dataset.page)];if(!page||this.v.busy)return;
   void this.act(async()=>{
    if('project' in page){await this.open(page.project,page.tab);if(page.tab==='files')await this.loadFiles();else await this.loadProjectPanel();}
    else if(page.view==='home')this.home();
    else if(page.view==='standalone'){
     if(this.product==='dreamflow')this.home();else this.showDialog('help','<h2 id="dialog-title">独立 DreamFlow</h2><p>在另一个本地页面，由你填写或导入完整方案，不需要访谈。两个导览有独立的草稿与示例。</p><a href="http://127.0.0.1:4329/" target="_blank" rel="noopener">打开独立 DreamFlow 导览</a><button type="button" data-action="close-modal">返回</button>');
    }else if(page.view==='settings')await this.settings();else if(page.view==='help')await this.help();else if(page.view==='maintenance')await this.maintenance();else await this.setup(page.view==='fees'?'fees':'setup');
    this.toast(page.description);this.focusPage();
   });return;
  }
  if(action==='help-rephrase'){this.v.helpSimple=!this.v.helpSimple;this.render();this.focusPage();return;}
  if(action==='planner1-choice'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.product!=='dreamflow'&&this.v.settings){
   const provider=this.v.settings.planner1Binding?.provider??this.v.settings.config.planner1.provider??'openai',choice=provider==='kimi'?'kimi:oauth':provider==='local'?'local:none':provider==='deepseek'?'deepseek:api_key':'openai:api_key';
   this.showDialog('planner1-choice',planner1ChoiceForm(this.v.settings,this.drafts.has('p1-choice-model:'+choice)?this.drafts.get('p1-choice-model:'+choice):undefined));return;
  }
  if(action==='planner1-local-check'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.product!=='dreamflow'&&this.v.settings){
   const form=(b as HTMLButtonElement).form;
   if(!form||!new FormData(form).has('p1ChoiceConsent'))return;
   if(this.v.settings.planner1Binding?.provider!=='local'){
    this.showDialog('planner1-local','<h2 id="dialog-title">请先保存本地选择</h2><p>本机检查只针对已经明确保存的 Ollama 配置，不会猜测或自动替换其他模型。</p><button type="button" data-action="close-modal">返回</button>');return;
   }
   const token=this.epoch,seq=this.modalSeq;
   void this.act(async()=>{const result=await loadLocalPlanner1Check(this.adapter);if(token!==this.epoch)return;if(seq===this.modalSeq)this.showDialog('planner1-local',localPlanner1CheckResult(result));this.toast('本地方案助手已完成一次真实最小调用；其他角色仍需分别核验。');});return;
  }
  if(action==='setting-explain'){
   const explanations:Record<string,[string,string]>={local:['本地模型的使用条件','本地 Ollama 只代表方案助手可以在这台电脑运行。先核对模型来源、许可、硬件和已安装模型，再完成一次真实最小调用。其他角色、网络和项目依赖仍分别核验；能力不足时不会自动改用云端。'],network:['已有网络工具','只读发现获准组件，再分别核验选择、实际请求和恢复。没有证据时保持未连接；不改共享设置。'],laya:['普通流程与 Laya 辅助','普通流程无需 Laya；增强方式为工程规划、执行器和审查提供建议。没有安装也能查看，配置开关不能替代实际参与证据。'],update:['应用更新','当前保持本机运行，不自动下载更新。以后更新也要先备份，核对来源、兼容性和恢复方式。']};
   const info=explanations[b.dataset.topic??''];if(info)this.showDialog('help',`<h2 id="dialog-title">${e(info[0])}</h2><p>${e(info[1])}</p><button type="button" data-action="close-modal">知道了</button>`);return;
  }
  if(action==='review-preferences'&&this.adapter.presentation==='frontend-review'){
   this.showDialog('review-preferences',`<h2 id="dialog-title">体验选择方案助手</h2><form id="review-preferences-form"><fieldset><legend>仅保存本页偏好，不改变真实配置</legend>${[['cloud','已确认云端路线'],['local','可选本地模型 · 尚未接入']].map(([id,title])=>`<label class="check"><input type="radio" name="reviewPlanner" value="${id}" ${(this.drafts.get('review-planner')||'cloud')===id?'checked':''} required>${title}</label>`).join('')}</fieldset><div class="actions"><button type="submit">保存演示偏好</button><button type="button" data-action="close-modal">取消</button></div></form>`);return;
  }
  if(this.adapter.presentation==='frontend-review'&&(action==='review-data'||action==='maintenance-create'||action==='maintenance-rehearse')){
   const topic=b.dataset.topic??'backup',copy:Record<string,[string,string]>={backup:['备份范围 · 演示','真实操作应保留方案、审批、业务数据和费用账本，并说明未包含的内容。当前不会创建任何副本。'],restore:['恢复步骤 · 演示','先核验副本、一致性和目标版本，再明确确认恢复范围。当前不会覆盖真实数据，也不会生成恢复证明。'],migrate:['迁移位置 · 演示','本工程已切换 F 盘。再次迁移仍应先复制、完整核对，再切换与重启验证；删除旧副本须单独同意。当前不会移动文件。']};
   const [title,body]=copy[topic]??copy.backup;this.showDialog('review-data',`<h2 id="dialog-title">${title}</h2><p>${body}</p><form id="review-confirm-form"><label class="check"><input type="checkbox" name="reviewConsent" required>我了解这只是界面操作演示，不会修改真实数据。</label><div class="actions"><button type="submit">确认体验此步骤</button><button type="button" data-action="close-modal">取消</button></div></form>`);return;
  }
  if(action==='cancel-planning'){
   const pid=this.v.snapshot?.project.id;if(!pid)return;
   void this.adapter.request('/projects/'+encodeURIComponent(pid)+'/planning/cancel','POST',{}).then(()=>this.toast('已停止派发；调用结果需按当前记录核对。')).catch(err=>{this.v.error=this.errorText(err);this.render();});return;
  }
  if(action==='clear-answer-choices'){
   const p=this.v.snapshot?.project,q=p?.questions.find(q=>!p.answers.some(a=>a.questionId===q.id));
   for(const input of this.app.querySelectorAll<HTMLInputElement>('#answer-form [name=optionId]'))input.checked=false;
   if(p&&q)this.drafts.delete('choices:'+p.id+':'+q.id);
   return;
  }
  if((writes.has(action)||action==='scenario')&&this.v.busy)return;
  if(action==='edit-user-plan'){void this.act(()=>this.editUserPlan());return;}
  if(action==='export-plan'){void this.act(async()=>{const p=this.v.snapshot?.project;if(!p)return;const doc=await this.adapter.request('/projects/'+encodeURIComponent(p.id)+'/plan-document');downloadBlob(new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}),'dreamflow-plan.json');});return;}
  if(action==='sqlite-status'){
   if(this.v.busy){this.toast('前一次操作仍在核对，请稍候；没有重复发起请求。');return;}
   void this.act(()=>this.projectSqliteStatus());return;
  }
  if(action==='sqlite-recovery'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='project'){
   if(this.v.busy)return;
   const plan=this.sqliteRecoveryPlan,candidate=plan?.candidates.find(value=>value.operationHash===b.dataset.operation),project=this.v.snapshot?.project;
   if(!plan||!candidate||!project||!sqliteStatusBinding(this.v.snapshot)){this.toast('这条保存记录已经变化，请重新核对保存状态。');return;}
   this.showDialog('sqlite-recovery',sqliteRecoveryConfirmation(plan,candidate,project.name));
   this.sqliteRecoveryBinding={plan,candidate};return;
  }
  if(['json-load','json-edit','json-execute'].includes(action)&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'){
   void this.act(()=>this.projectData(action==='json-load'?'read':action==='json-edit'?'edit':'execute'));return;
  }
  if(action==='json-export'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'){
   const data=this.v.jsonData;if(data&&data.projectId===this.v.snapshot?.project.id)downloadBlob(new Blob([JSON.stringify(data.document,null,2)],{type:'application/json'}),'dream-maker-data-v'+data.revision+'.json');return;
  }
  if(action.startsWith('siwc-')&&this.siwcPanel&&this.v.screen==='settings'){void this.siwcPanel.act(action,this.app);return;}
  if(action==='home'){this.home();return;}
  if(action==='fees'&&this.prepAvailable()){void this.setup('fees');return;}
  if(action==='setup'&&this.prepAvailable()){void this.setup();return;}
  if((action==='application-exit'||action==='lifecycle-read')&&this.prepAvailable()){void this.act(()=>this.lifecycleChoice());return;}
  if((action==='maintenance'||action==='refresh'&&this.v.screen==='maintenance')&&this.prepAvailable()){void this.maintenance();return;}
  if(['registered-create','registered-extract'].includes(action)&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='maintenance'){
   if(this.v.busy||!this.v.registeredBackups)return;const kind=action==='registered-create'?'create':'extract',id=kind==='extract'?b.dataset.id??'':'';
   if(kind==='extract'&&!this.v.registeredBackups.items.some(item=>item.id===id&&item.integrity==='NOT_RECHECKED'))return;
   this.showDialog('registered-backup',registeredBackupConfirmation(kind,id));this.registeredBinding={kind,id};return;
  }
  if(action==='managed-data-import'&&this.adapter.mode==='local'&&this.v.screen==='project'&&this.v.previewProtocol===1){
   void this.act(async()=>{const r=this.v.snapshot?.runs[0],token=this.epoch;if(!r?.treeHash)return;const current=readManagedData(await this.adapter.request('/runs/'+encodeURIComponent(r.id)+'/data?treeHash='+encodeURIComponent(r.treeHash)),r.projectId);if(current.revision)throw new UiError('MANAGED_DATA_ALREADY_EXISTS','');const old=this.previewStorage.legacySnapshot();
    if(token!==this.epoch)return;this.showDialog('managed-import',managedImportConfirmation(old.tasks.length,r.id));this.managedImportBinding={pid:r.projectId,runId:r.id,treeHash:r.treeHash,tasks:old.tasks};});return;
  }
  if(action==='sqlite-data-restore'&&this.adapter.mode==='local'&&this.adapter.presentation!=='frontend-review'&&this.v.screen==='maintenance'){
   const pid=this.app.querySelector<HTMLSelectElement>('#sqlite-restore-project')?.value,result=this.v.maintenanceResult,token=this.epoch;
   const project=this.v.projects.find(p=>p.id===pid);if(!pid||!result||!project||project.mode!=='live')return;this.v.sqliteRestoreResult=undefined;
   void this.act(async()=>{const value=await this.adapter.request('/maintenance/snapshots/'+encodeURIComponent(result.snapshotId)+'/rehearsals/'+encodeURIComponent(result.id)+'/projects/'+encodeURIComponent(pid)+'/sqlite-data');
    const plan=readSqliteRestorePlan(value,pid,result.snapshotId,result.id);if(token!==this.epoch)return;this.showDialog('sqlite-restore',sqliteRestoreConfirmation(plan,project.name));this.sqliteRestoreBinding=plan;});return;
  }
  if(action==='managed-data-restore'&&this.adapter.mode==='local'&&this.v.screen==='maintenance'){
   const pid=this.app.querySelector<HTMLSelectElement>('#managed-data-project')?.value,result=this.v.maintenanceResult,token=this.epoch;
   const project=this.v.projects.find(p=>p.id===pid);if(!pid||!result||!project)return;this.v.managedRestoreResult=undefined;
   void this.act(async()=>{const value=await this.adapter.request('/maintenance/snapshots/'+encodeURIComponent(result.snapshotId)+'/rehearsals/'+encodeURIComponent(result.id)+'/projects/'+encodeURIComponent(pid)+'/'+(project.mode==='live'?'json-data':'data'));
    if(token!==this.epoch)return;
    if(project.mode==='live'){const plan=readJsonRestorePlan(value,pid,result.snapshotId,result.id);this.showDialog('json-restore',jsonRestoreConfirmation(plan,project.name));this.jsonRestoreBinding=plan;}
    else{const plan=readManagedRestorePlan(value,pid,result.snapshotId,result.id);this.showDialog('managed-restore',managedRestoreConfirmation(plan,project.name));this.managedRestoreBinding=plan;}});return;
  }
  if(['maintenance-create','maintenance-rehearse'].includes(action)&&this.prepAvailable()&&this.v.screen==='maintenance'){
   const kind=action==='maintenance-create'?'create':'rehearse',id=kind==='create'?'':b.dataset.id??'';
   if(!this.v.maintenance||kind==='rehearse'&&!this.v.maintenance.snapshots.some(item=>item.id===id&&item.status==='RECORDED_NOT_RECHECKED'))return;
   this.showDialog('maintenance',maintenanceConfirmation(kind,id));this.maintenanceBinding={kind,id};return;
  }
  if(action==='setup-step'&&this.v.screen==='setup'){const step=Number(b.dataset.step);if(Number.isInteger(step)&&step>=0&&step<5){this.v.setupStep=step;this.render();this.focusPage();}return;}
  if(action==='help'&&this.prepAvailable()){void this.act(()=>this.help());return;}
  if(action==='new'){this.home();this.app.querySelector<HTMLInputElement>('#project-name')?.focus();return;}
  if(action==='settings'){const task=this.settings(),token=this.epoch;void task.catch(err=>{if(token===this.epoch){this.v.error=this.errorText(err);this.render();}});return;}
  if(action==='open'){const task=this.open(b.dataset.id!),token=this.epoch;void task.catch(err=>{if(token===this.epoch){this.v.error=this.errorText(err);this.render();}});return;}
  if(action==='tab'){this.cancelPanelRead();this.v.panelError='';this.v.tab=b.dataset.tab!;this.gateDismissed=true;this.closeDialog();this.url();this.render();if(this.v.tab==='files')void this.act(()=>this.loadFiles());else void this.loadProjectPanel();return;}
  if(action==='reload-panel'||action==='more-versions'){void this.loadProjectPanel(action==='more-versions');return;}
  if(action==='select-version'){if(this.v.planHistory?.items.some(row=>row.id===b.dataset.version)){this.v.planHistory.selectedId=b.dataset.version!;this.render();}return;}
  if(action==='download-version'){const version=this.v.planHistory?.items.find(row=>row.id===b.dataset.version);if(version)downloadBlob(new Blob([JSON.stringify(version,null,2)],{type:'application/json'}),'dream-maker-plan-v'+version.revision+'.json');else this.toast('这一版尚未读取，请先刷新方案历史。');return;}
  if(action==='executor-info'){this.showDialog('help','<h2 id="dialog-title">关于多个执行器</h2><p>当前已连接的执行容量以工作台为准。增加、绑定多个运行器的设置尚未接通；任务卡片数量不会自动变成运行器数量。</p><p>你可以先查看现有任务与依赖，未连接时不会派发额外模型请求。</p><button type="button" data-action="close-modal">知道了</button>');return;}
  if(action==='followup-unavailable'){this.showDialog('help','<h2 id="dialog-title">先保留你的问题</h2><p>现在还没有可以正式结束的制作轮次。问题草稿会保留，你可以先查看帮助；本页不会编造助手回复或自动改方案。</p><button type="button" data-action="close-modal">返回草稿</button>');return;}
  if(action==='rail'){this.v.railClosed=!this.v.railClosed;this.render();return;}
  if(action==='team'){this.showDialog('team',`<h2 id="dialog-title">四角色与运行边界</h2>${roles(this.v)}<button type="button" data-action="close-modal">返回工作区</button>`);return;}
  if(action==='menu'){this.showDialog('menu',`<h2 id="dialog-title">项目导航</h2><nav class="drawer-nav"><button type="button" data-action="home">项目空间</button><button type="button" data-action="settings">连接与设置</button>${this.prepAvailable()?'<button type="button" data-action="setup">使用准备</button><button type="button" data-action="fees">费用管理</button><button type="button" data-action="maintenance">数据与维护</button><button type="button" data-action="help">帮助</button>':''}${this.v.projects.map(p=>`<a href="/?project=${encodeURIComponent(p.id)}" data-action="open" data-id="${e(p.id)}">${e(p.name)}</a>`).join('')}</nav><button type="button" data-action="close-modal">关闭导航</button>`);return;}
  if(action==='local-help'){this.showDialog('help','<span class="eyebrow">LOCAL EDITION</span><h2 id="dialog-title">由你决定什么时候开始。</h2><p>当前工作台只在这台电脑运行，保存方案与查看状态不会自行开始制作。</p><p>确认方案、批准本轮制作和最终接受成果，是三个独立决定。真实制作需要相应的工程账户、额度和安全检查；页面上的配置名称不表示已经连接成功。</p><p>固定 Demo 只检验界面和控制流程，不能替代真实成果。关闭或取消任务时，以本地服务确认的状态为准。</p><button type="button" class="primary" data-action="close-modal">知道了</button>');return;}
  if(action==='close-modal'){if(this.modalKind==='gate')this.gateDismissed=true;this.closeDialog();return;}
  if(action==='show-gate'){this.gateDismissed=false;this.showDialog('gate',gateContent(this.v));return;}
  if(action==='review-answers'){this.gateDismissed=true;this.v.tab='answers';this.closeDialog();this.url();this.render();return;}
  if(action==='edit-answer'){
   const p=this.v.snapshot!.project,q=p.questions.find(q=>q.id===b.dataset.id)!,a=p.answers.find(a=>a.questionId===q.id)!;
   const draftKey='edit:'+p.id+':'+q.id;
   this.showDialog('edit',`<h2 id="dialog-title">修改原始回答</h2><p>${e(q.text)}</p><form id="edit-answer-form"><input name="questionId" type="hidden" value="${e(q.id)}"><label for="edited-answer">你的回答</label><textarea id="edited-answer" name="editedAnswer" data-draft="${e(draftKey)}" rows="5" maxlength="8000" required>${e(this.drafts.has(draftKey)?this.drafts.get(draftKey):a.text)}</textarea><p class="hint">保存后旧规格、相关审批需要重新核对。</p><div class="actions"><button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">保存修改</button></div></form>`);return;
  }
  if(action==='cancel'){this.showDialog('cancel','<h2 id="dialog-title">取消这次运行？</h2><p>已保存的需求与证据保留。取消请求不等于进程已经停止；等待服务端确认清理结果。</p><div class="actions"><button type="button" data-action="close-modal">保留运行</button><button type="button" class="danger-outline" data-action="confirm-cancel">确认取消运行</button></div>');return;}
  if(action==='accept'){this.showDialog('accept',`<h2 id="dialog-title">接受当前成果？</h2><p>${this.adapter.mode==='public-demo'?'接受的是固定 UI 演示成果，不是生成项目或真实测试结论。':'请先核对文件与当前版本的验证结果。本按钮不替代业务验收。'}</p><div class="actions"><button type="button" data-action="close-modal">继续检查</button><button type="button" class="primary" data-action="confirm-accept">确认接受</button></div>`);return;}
  if(action==='copy-prompt'){void this.copy(this.v.snapshot?.spec?.masterPrompt||'');return;}
  if(action==='copy-file'){void this.copy(this.v.fileText);return;}
  if(action==='more-logs'){this.v.logLimit+=40;this.render();return;}
  if(action==='latest'){const log=this.app.querySelector('#event-log');if(log)log.scrollTop=log.scrollHeight;return;}
  void this.act(async()=>{
   if(action==='native-verifier'&&this.adapter.mode==='local'&&this.v.snapshot?.project.mode==='live'&&this.v.snapshot.spec&&!this.v.snapshot.spec.stale){
    const pid=this.v.snapshot.project.id,specHash=this.v.snapshot.spec.hash,token=this.epoch,modalSeq=this.modalSeq;
    const raw=await this.adapter.request('/projects/'+encodeURIComponent(pid)+'/native-verifier');
    if(token!==this.epoch||modalSeq!==this.modalSeq||this.v.screen!=='project'||this.v.snapshot?.project.id!==pid||this.v.snapshot.spec?.stale||this.v.snapshot.spec?.hash!==specHash)return;
    const plan=readVerifierPlan(raw,specHash);this.showDialog('native-verifier',verifierContent(plan));this.verifierBinding={pid,specHash,planHash:plan.sha256};
   }else if(action==='flow-report'){
    const r=this.v.snapshot?.runs[0],token=this.epoch;if(!r)return;
    const report=await this.adapter.request<FlowReportData>('/runs/'+encodeURIComponent(r.id)+'/report');
    if(token!==this.epoch||this.v.snapshot?.runs[0]?.id!==r.id)return;
    const draftKey='alternative:'+r.id;this.showDialog('flow-report',flowReportContent(report,{key:draftKey,value:this.drafts.get(draftKey)},this.product==='dreamflow'||this.v.snapshot?.project.planner1Mode==='USER'));this.flowReportBinding={runId:r.id,reportHash:report.reportHash};
   }else if(action==='conclude-flow'){
    const binding=this.flowReportBinding,choice=b.dataset.choice,token=this.epoch,constraint=this.dialog.querySelector<HTMLTextAreaElement>('#alternative-constraint')?.value??'';
    if(!binding||this.v.snapshot?.runs[0]?.id!==binding.runId||!['HANDLE','HELP','ALTERNATIVE','SAVE'].includes(choice??''))throw new UiError('FLOW_REPORT_REQUIRED','请先核对当前本轮报告。');
    await this.control('conclude',{choice,reportHash:binding.reportHash,constraint});if(token!==this.epoch)return;this.closeDialog();
    if(choice==='ALTERNATIVE'){if(this.product==='dreamflow'||this.v.snapshot?.project.planner1Mode==='USER')await this.editUserPlan(constraint);else{await this.mutate('alternative',{constraint});this.drafts.delete('alternative:'+binding.runId);this.v.tab='work';this.url();}}
    else if(choice==='HELP'||choice==='HANDLE')await this.help();
    else this.toast('本轮报告已保存，旧方案和成果保留。没有启动新任务。');
   }else if(action==='refresh'){await this.list();if(this.v.snapshot&&this.v.screen==='project'){const pid=this.v.snapshot.project.id,token=this.epoch,s=await this.adapter.request<Snapshot>('/projects/'+encodeURIComponent(pid));if(token===this.epoch)this.v.snapshot=s;}else this.v.settings=await this.adapter.request<PublicConfig>('/config');}
   else if(action==='next'){const s=await this.mutate('next');this.v.snapshot?.project.id===s.project.id&&(this.v.snapshot=s);}
   else if(action==='skip'){const p=this.v.snapshot!.project,q=p.questions.find(q=>!p.answers.some(a=>a.questionId===q.id))!;let s=await this.mutate('answer',{questionId:q.id,text:'',skip:true,version:p.version});this.drafts.delete('answer:'+p.id+':'+q.id);this.drafts.delete('choices:'+p.id+':'+q.id);await this.nextIfNeeded(s);}
   else if(action==='continue'){const token=this.epoch;this.closeDialog();this.gateDismissed=false;const s=await this.mutate('continue');await this.nextIfNeeded(s);if(token===this.epoch){this.v.tab='work';this.url();}}
   else if(action==='finish'){const pid=this.v.snapshot!.project.id,token=this.epoch;this.closeDialog();await this.mutate('finish',{notes:this.drafts.get('notes:'+pid)},pid);if(token!==this.epoch)return;this.v.tab='spec';this.gateDismissed=true;this.url();}
   else if(action==='approve')await this.mutate('approve',{specHash:this.v.snapshot!.spec!.hash});
   else if(action==='pause'||action==='resume')await this.control(action);
   else if(action==='confirm-cancel'){await this.control('cancel');this.closeDialog();}
   else if(action==='confirm-accept'){await this.control('accept');this.closeDialog();}
   else if(action==='demo-step'&&this.adapter.advanceScenario){const pid=this.v.snapshot!.project.id,token=this.epoch,s=await this.adapter.advanceScenario(pid);if(token===this.epoch)this.v.snapshot=s;}
   else if(action==='clash-refresh'){this.v.clash=await this.adapter.request<ClashStatus>('/clash');this.v.diagnostics=JSON.stringify(this.v.clash,null,2);}
   else if(action==='clash-verify'){const result=await this.adapter.request('/clash/verify','POST',{});this.v.clash=await this.adapter.request<ClashStatus>('/clash');this.v.diagnostics=JSON.stringify(result,null,2);this.toast('节点验证完成，原选择已恢复。');}
   else if(action==='clash-recover'){const result=await this.adapter.request('/clash/recover','POST',{});this.v.clash=await this.adapter.request<ClashStatus>('/clash');this.v.diagnostics=JSON.stringify(result,null,2);this.toast('恢复核对完成。');}
   else if(action==='files-refresh')await this.loadFiles();
   else if(action==='file'){const r=this.v.snapshot!.runs[0],token=this.epoch,data=await this.adapter.request<{path:string;content:string}>('/runs/'+encodeURIComponent(r.id)+'/files?path='+encodeURIComponent(b.dataset.path!));if(token===this.epoch){this.v.fileName=data.path;this.v.fileText=data.content;}}
   else if(action==='preview'){
    const r=this.v.snapshot!.runs[0],token=this.epoch,data=await this.adapter.request<{url:string;scope:string;treeHash?:string;dataProtocol?:1|2}>('/runs/'+encodeURIComponent(r.id)+'/preview');
    if(token!==this.epoch)return;
    if(this.adapter.mode==='public-demo'){if(data.scope!=='UI_DEMO_FIXED_SAMPLE'||data.url!=='./sample.html')throw new UiError('PREVIEW_DENIED','演示预览来源不匹配。');this.v.previewUrl='/sample.html';}
    else{const u=new URL(data.url);if(data.scope!=='TRUSTED_DEMO_SEPARATE_ORIGIN'||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.origin===location.origin||data.treeHash!==r.treeHash||![1,2].includes(data.dataProtocol??0))throw new UiError('PREVIEW_DENIED','现有安全预览不支持该来源；未放宽 iframe 权限。');
     const current=readManagedData(await this.adapter.request('/runs/'+encodeURIComponent(r.id)+'/data?treeHash='+encodeURIComponent(r.treeHash!)),r.projectId);if(token!==this.epoch)return;
     this.previewStorage.clear();this.managedPreview.clear();this.v.previewData=current;this.v.previewProtocol=data.dataProtocol;
     this.v.previewUrl=data.dataProtocol===1?this.previewStorage.prepare(u.href,r.id,r.treeHash!):this.managedPreview.prepare(u.href,r.id,r.treeHash!);}
    this.v.previewScope=data.scope;
   }else if(action==='export'){const r=this.v.snapshot!.runs[0],data=await this.adapter.exportRun(r.id);downloadBlob(data.blob,data.filename);this.toast('已向浏览器提交下载；实际保存结果以浏览器为准。');}
    else if(action==='laya-probe'){
     const token=this.epoch;
     this.v.layaProbe=undefined;this.v.layaProbeError='';try{const data=await this.adapter.request('/diagnostics/laya','POST',{});if(token!==this.epoch)return;const result=readLayaProbe(data);this.v.layaProbe=result;this.v.layaProbeError='';if(result.ok)this.toast('本机 Laya 已响应；这不代表分类质量或角色参与。');else this.v.layaProbeError='本机检查结果无法安全核对；没有把它当成连接或模型质量证明。';}catch(error){if(token===this.epoch)this.v.layaProbeError=this.errorText(error);}return;
    }else if(['diagnostics','models'].includes(action)){
     const path=action==='diagnostics'?'/diagnostics':'/diagnostics/models';
    const data=await this.adapter.request(path,action==='diagnostics'?'GET':'POST',action==='diagnostics'?undefined:{});
    // A07: the Kimi credential state gets one honest line above the raw diagnostics. A gate that is
    // closed must never read as "log in again", so the wording comes from the tested summary module.
    let kimi='';
    if(action==='diagnostics'){
     try{
      const status=await this.adapter.request<Parameters<typeof summarizeKimiStatus>[0]>('/kimi/status');
      const s=summarizeKimiStatus(status);
      kimi='[Kimi] '+s.headline+' — '+s.detail+(s.needsLogin?'（需要本人授权）':'')+String.fromCharCode(10,10);
     }catch(error){
      kimi='[Kimi] 状态不可用（'+String((error as Error).message||'').slice(0,60)+'）'+String.fromCharCode(10,10);
     }
    }
    let bridge='';
    if(action==='diagnostics'){
     try{
      const b=summarizeBridgeDurability((data as {bridge?:Parameters<typeof summarizeBridgeDurability>[0]}).bridge);
      bridge='[通道] '+b.headline+' — '+b.detail+String.fromCharCode(10,10);
     }catch{/* the raw payload below is still shown */}
    }
    let live='';
    if(action==='diagnostics'){
     try{
      const n=summarizeNativeReadiness((data as {native?:Parameters<typeof summarizeNativeReadiness>[0]}).native);
      live='[Live] '+n.headline+' — '+n.detail+String.fromCharCode(10,10);
     }catch{/* the raw payload below is still shown */}
    }
     this.v.diagnostics=kimi+bridge+live+JSON.stringify(data,null,2);
   }
  });
 }
 private key(ev:KeyboardEvent):void{
  if(!this.owned(ev.target))return;
  if(this.dialog.open&&ev.key==='Tab'){
   const items=[...this.dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not([type=hidden]):not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(x=>x.getClientRects().length>0);
   const i=items.indexOf(document.activeElement as HTMLElement);
   if(items.length&&(ev.shiftKey&&i<=0||!ev.shiftKey&&(i===items.length-1||i<0))){ev.preventDefault();items[ev.shiftKey?items.length-1:0].focus();}return;
  }
  if(this.composing||ev.isComposing||ev.keyCode===229)return;
  if((ev.ctrlKey||ev.metaKey)&&ev.key==='Enter'){
   const t=ev.target;if(t instanceof HTMLTextAreaElement&&t.form){ev.preventDefault();t.form.requestSubmit();}return;
  }
  const target=ev.target as HTMLElement;
  if(target.getAttribute('role')==='tab'&&['ArrowLeft','ArrowRight','Home','End'].includes(ev.key)){
   const tabs=[...this.app.querySelectorAll<HTMLButtonElement>('[role=tab]')],i=tabs.indexOf(target as HTMLButtonElement),n=ev.key==='Home'?0:ev.key==='End'?tabs.length-1:(i+(ev.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;ev.preventDefault();tabs[n].click();tabs[n].focus();
  }
 }
 renderFixture(data:FixtureData):void{if(!document.documentElement.hasAttribute('data-dm-ui-fixture'))throw new Error('Fixture marker required');Object.assign(this.v,{screen:data.screen,projects:data.projects,snapshot:data.snapshot,settings:data.settings,events:data.events||[],tab:data.tab||'work'});this.gateDismissed=data.gateDismissed||false;this.render();const mark=document.createElement('div');mark.className='fixture-watermark';mark.textContent='OFFLINE UI FIXTURE · 无浏览器网络联调';this.app.prepend(mark);}
 dispose():void{if(this.disposed)return;this.disposed=true;this.customWizard?.cancel();this.disconnect();if(this.toastTimer)clearTimeout(this.toastTimer);if(this.modalCleanup)clearTimeout(this.modalCleanup);this.life.abort();this.siwcPanel?.detach();this.adapter.dispose();this.dialog.remove();}
}
