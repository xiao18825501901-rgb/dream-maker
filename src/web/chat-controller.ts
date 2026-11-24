import { LocalApiAdapter } from './local-api.js';
import { UiError } from './contracts.js';
import type { UiAdapter, PublicConfig } from './contracts.js';
import type { Project } from '../shared/types.js';
import type { FlowProfileVersion } from '../shared/flow-profile.js';
import type { ChatAction, ChatActionResult, ChatState, ChatPhase, ChatOption, ChatRole, ChatExtension } from './chat-types.js';
import { initialChatState, projectList, currentRun, currentQuestion, phaseFor, starsFor, messagesFor, rolesFor, requirementText, reviewFeedbackBinding, reviewFeedbackRecord, seekerApiSelected, type ChatSnapshot, type PresentationProject } from './chat-projection.js';

interface ChatServerCapabilities {schema:string;version:number;product:string;seeker:boolean;questionHelp:boolean;projectPresentation:boolean;reviewFeedback?:boolean}
interface Planner1ModelsResponse {schema:string;provider:string;source:'classic'|'custom';models:{id:string;label?:string;context?:number|null;output?:number|null;notes?:string;available?:boolean}[]}
/** Browser projection only: all persistence, calls, approvals and dispatch stay in the original Engine. */
/** One role's full option set: model/effort/harness plus the skills and plugins the server offers it. */
type RoleChoices = { models: ChatOption[]; efforts: ChatOption[]; harnesses: ChatOption[]; skills: ChatExtension[]; plugins: ChatExtension[]; selected: string[]; current: { harness: string; model: string; effort: string } };

export class ChatLiveController {
 state:ChatState=initialChatState();
 private snapshot:ChatSnapshot|null=null;
 private profile:FlowProfileVersion|null=null;
 private config:PublicConfig|null=null;
 private serverCaps:ChatServerCapabilities|null=null;
 private serverProduct='dream-maker';
 private stopEvents:(()=>void)|null=null;
 private readGeneration=0;
 private disposed=false;
 private mutationInFlight=false;
 private mutatingPhase:ChatPhase|null=null;
 private uncertain=false;
 private refreshing=false;
 private refreshQueued:{pid:string;generation:number}|null=null;
 private snapshotSequence=0;
 private appliedSequence=0;
 private reviewRefreshTimer:ReturnType<typeof setTimeout>|null=null;
 private reviewReadCounts=new Map<string,number>();
 private questionDraft='';
 private files:{id:string;name:string;text:string;size:number}[]=[];
 private readonly feedbackRequested=new Set<string>();
 private readonly seekerCatalog=new Map<string,ChatOption[]>();
 constructor(private paint:(state:ChatState)=>void,private api:UiAdapter=new LocalApiAdapter(),private navigate=(url:string)=>location.assign(url)){}
 private render(){if(!this.disposed)this.paint(this.state);}
 async boot(){
  try{
   await this.api.init();
   const results=await Promise.all([this.api.request<{product:string}>('/product'),this.api.request<PublicConfig>('/config'),this.api.request<ChatServerCapabilities>('/chat/capabilities')]);
   this.serverProduct=results[0].product;this.config=results[1];this.serverCaps=results[2];
   if(this.serverCaps.schema!=='dream-maker.chat-capabilities.v1')throw new UiError('CHAT_SERVER_VERSION','当前服务尚未接入对话界面，请更新相应源码后重新构建。');
   this.state.product=this.serverProduct==='dreamflow'?'df':'dm';
   this.state.connected=true;this.state.evidence='live';this.state.loading=false;
   await this.list();
   const pid=new URLSearchParams(location.search).get('project');
   if(pid)await this.open(pid);else this.blank();
  }catch(error){this.state.loading=false;this.state.connected=false;this.state.phase='error';this.state.error=this.error(error);this.render();}
 }
 private error(error:unknown):string {
  return error instanceof Error?error.message:'操作未完成，请读取当前状态后继续。';
 }
 /** A read failure is retryable. An unreadable write response is not proof of failure. */
 private async write<T>(path:string,body:unknown):Promise<T>{
  try{return await this.api.request<T>(path,'POST',body);}
  catch(error){
   if(error instanceof UiError&&['NETWORK_UNCERTAIN','INVALID_JSON','UNEXPECTED_CONTENT_TYPE'].includes(error.code)){
    this.uncertain=true;
    this.state.notice='有一项写入结果尚未确认。可以刷新查看真实记录；请到完整工作台核对该操作，不会自动再次提交。';
   }
   throw error;
  }
 }
 private clearReviewRefresh(){if(this.reviewRefreshTimer!==null)clearTimeout(this.reviewRefreshTimer);this.reviewRefreshTimer=null;}
 private async list(){const data=await this.api.request<{projects:PresentationProject[]}>('/chat/projects');this.state.projects=projectList(data.projects);}
 private blank(){
  this.stopEvents?.();this.stopEvents=null;this.clearReviewRefresh();this.refreshQueued=null;this.readGeneration++;this.snapshot=null;this.profile=null;this.files=[];this.questionDraft='';
  this.state={...initialChatState(),product:this.state.product,projects:this.state.projects,loading:false,connected:true,evidence:'live',roles:rolesFor(this.config,null,null,this.seekerCatalog),capabilities:{...initialChatState().capabilities,send:true,configureRoles:this.state.product==='dm',extensions:true,attachments:true,rename:true,pin:true,archive:true},legacyHref:'/?ui=legacy'};
  if(this.state.product==='df')this.state.notice='你负责需求方案。导入已有方案，或打开详细方案编辑器；工程环节由 Planner、Executor、Reviewer 接力。';
  else if(!this.apiSelected())this.state.notice='新项目使用 Seeker API。点右下 Seeker 选择服务和模型；密钥由本机设置管理。已有 OAuth 项目保持原绑定。';
  history.replaceState(null,'',location.pathname);this.render();
 }
 private apiSelected(){return seekerApiSelected(this.config);}
 /** Read-only Seeker picker source. The server reads its registry or the local Magpie
  * /v1/models; this call never spends a model request. Switching provider refetches. */
 async seekerModels(provider:string):Promise<ChatOption[]>{
  const selected=String(provider||'').trim();
  if(selected!=='deepseek'&&selected!=='openai')throw new UiError('SEEKER_PROVIDER_UNSUPPORTED','Seeker 当前只接入 DeepSeek 与 OpenAI 官方 API。');
  const data=await this.api.request<Planner1ModelsResponse>('/planner1/models?provider='+encodeURIComponent(selected));
  if(data?.schema!=='dream-maker.planner1-models.v1'||!Array.isArray(data.models))throw new UiError('SEEKER_MODELS_INVALID','模型目录响应无效，请刷新后重试。');
  const options:ChatOption[]=[],seen=new Set<string>();
  for(const row of data.models){
   if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id))continue;
   seen.add(row.id);options.push({id:row.id,label:typeof row.label==='string'&&row.label?row.label:row.id,available:row.available!==false});
  }
  const current=this.state.roles.seeker.provider===selected?this.state.roles.seeker.model:'';
  if(current&&!seen.has(current))options.push({id:current,label:current+' · 当前绑定',available:true});
  this.seekerCatalog.set(selected,options);
  this.state.roles={...this.state.roles,seeker:{...this.state.roles.seeker,models:options,modelEditable:false}};
  this.render();return options;
 }
 private async open(pid:string){
  this.stopEvents?.();this.stopEvents=null;this.clearReviewRefresh();this.refreshQueued=null;
  const generation=++this.readGeneration,sequence=++this.snapshotSequence;
  const [s,profile]=await Promise.all([this.api.request<ChatSnapshot>('/projects/'+encodeURIComponent(pid)),this.api.request<{current:FlowProfileVersion|null}>('/projects/'+encodeURIComponent(pid)+'/flow-profile')]);
  if(generation!==this.readGeneration||this.disposed)return;
  if(this.serverProduct==='dreamflow'&&s.project.planner1Mode!=='USER')throw new UiError('DM_INSTANCE_REQUIRED','这个项目包含 Seeker 需求探寻，请在 Dream Maker 中打开。');
  this.appliedSequence=sequence;this.profile=profile.current;this.snapshot=s;this.files=[];this.questionDraft='';this.state.product=s.project.planner1Mode==='USER'?'df':'dm';
  this.apply(s);history.replaceState(null,'',location.pathname+'?project='+encodeURIComponent(pid));
  this.stopEvents=this.api.subscribe(pid,()=>{void this.refreshFromEvent(pid,generation);},status=>{
   if(generation!==this.readGeneration||this.disposed)return;
   this.state.connected=status==='connected';
   if(status==='reconnecting')this.state.notice='正在恢复连接；保留当前记录，不重复发送任务。';
   if(status==='connected'){if(!this.uncertain)this.state.notice=null;void this.refreshFromEvent(pid,generation);}
   this.render();
  });
  this.render();this.maybeExplainReview();
 }
 private apply(s:ChatSnapshot){
  this.snapshot=s;const p=s.project,r=currentRun(s),editable=s.chat?.editable===true;
  const q=currentQuestion(s);
  const dm=this.state.product==='dm';
  const followup=dm&&!!r?.review&&s.chat?.reviewFeedbackReady===true;
  const seekerPending=this.mutationInFlight&&['seeking','optimizing'].includes(this.mutatingPhase??'');
  this.state={...this.state,projectId:p.id,title:p.name,evidence:p.mode==='demo'?'demo':'live',questions:dm?starsFor(s):[],activeQuestionId:dm?q?.id:null,messages:messagesFor(s,this.state.product),phase:this.mutatingPhase??phaseFor(s),phaseDetail:r?.reason??undefined,phaseAt:r?.updatedAt??p.updatedAt,locked:!editable,lockReason:!editable?'本轮方案与配置已经冻结。问题和回答可以查看，安全结束本轮后才能修订。':undefined,roles:rolesFor(this.config,s,this.profile,this.seekerCatalog),requirements:s.spec?{text:requirementText(s.spec),revision:s.spec.revision,confirmed:p.state==='READY_TO_BUILD'}:null,requirementVersion:s.spec?'v'+s.spec.revision:undefined,runId:r?.id,engineeringMode:r?(r.flowName==='custom'?'custom':'classic'):this.profile?.projectId===p.id?'custom':'classic',interviewDecisionRequired:p.state==='AWAITING_INTERVIEW_DECISION',legacyHref:'/?ui=legacy&project='+encodeURIComponent(p.id),capabilities:{send:editable,answers:dm&&editable&&!!q,editAnswers:dm&&editable,help:dm&&editable&&!!q&&this.serverCaps?.questionHelp===true,confirm:editable&&!!s.spec&&!s.spec.stale&&!r,configureRoles:dm&&editable&&!p.planner1Binding,extensions:false,attachments:false,rename:editable&&this.serverCaps?.projectPresentation===true,pin:this.serverCaps?.projectPresentation===true,archive:this.serverCaps?.projectPresentation===true,cancel:seekerPending||this.mutatingPhase!=='review_feedback'&&!!r&&!followup&&!['READY_FOR_DELIVERY','ACCEPTED','CANCELLED','FAILED','PARTIAL'].includes(r.state),finishInterview:dm&&editable&&['INTERVIEWING','AWAITING_INTERVIEW_DECISION'].includes(p.state),followup,reason:'工程角色请在完整工作台配置；未接入的技能或插件不能当作已具备执行能力。'}};
   void this.syncEngineMode(p.id);
  // Preserve real project choice and immutable binding; never replace it with a browser preference.
  this.state.roles.seeker.frozen=!!p.planner1Binding||!editable;
  if(p.planner1Binding){this.state.roles.seeker.model=p.planner1Binding.model;this.state.roles.seeker.provider=p.planner1Binding.provider;this.state.roles.seeker.authLabel=p.planner1Binding.authMethod==='api_key'?'API Key · 当前项目绑定':'历史认证 · 当前项目绑定';}
 }
   /** One role's full option set: model/effort/harness plus the skills and plugins the server offers it. */
  async roleChoices(pid:string):Promise<Record<string,RoleChoices>|null>{
   try{
    const cat=await this.api.request<{roles:{role:string;checks?:unknown;skills?:ChatExtension[];plugins?:ChatExtension[];selection?:{skills?:string[];plugins?:string[];harness?:string;model?:string;effort?:string};choices:{models:ChatOption[];efforts:{id:string;label:string}[];harnesses:{id:string;label:string}[]}}[]}>('/projects/'+encodeURIComponent(pid)+'/roles');
    const out:Record<string,RoleChoices>={};
    for(const row of cat.roles)out[row.role]= {models:row.choices.models,efforts:row.choices.efforts.map(x=>({id:x.id,label:x.label,available:true})),harnesses:row.choices.harnesses.map(x=>({id:x.id,label:x.label,available:true})),skills:(row.skills??[]).map(x=>({...x,available:x.available!==false,kind:'skill' as const,description:x.description??'Skills'})),plugins:(row.plugins??[]).map(x=>({...x,available:x.available!==false,kind:'plugin' as const,description:x.description??'插件'})),selected:[...(row.selection?.skills??[]),...(row.selection?.plugins??[])],current:{harness:String(row.selection?.harness??''),model:String(row.selection?.model??''),effort:String(row.selection?.effort??'')}};
    return out;
   }catch{return null;}
  }
   private acceptRead(s:ChatSnapshot,pid:string,generation:number,sequence:number){
  if(this.disposed||generation!==this.readGeneration||this.state.projectId!==pid||sequence<this.appliedSequence)return false;
  const prior=this.snapshot;
  if(prior?.project.id===pid&&(s.project.version<prior.project.version||s.runs.some(r=>prior.runs.some(old=>old.id===r.id&&old.version>r.version))||(s.chat?.presentation?.revision??0)<(prior.chat?.presentation?.revision??0)))return false;
  this.appliedSequence=sequence;this.apply(s);this.render();return true;
 }
 private async refreshFromEvent(pid:string,generation:number){
  if(this.disposed||generation!==this.readGeneration)return;
  this.refreshQueued={pid,generation};
  if(this.refreshing||this.mutationInFlight)return;
  this.refreshing=true;
  try{
   while(this.refreshQueued&&!this.mutationInFlight&&!this.disposed){
    const next=this.refreshQueued;this.refreshQueued=null;
    if(next.generation!==this.readGeneration||next.pid!==this.state.projectId)continue;
    const sequence=++this.snapshotSequence;
    try{const s=await this.api.request<ChatSnapshot>('/projects/'+encodeURIComponent(next.pid));if(this.acceptRead(s,next.pid,next.generation,sequence))this.maybeExplainReview();}
    catch(error){if(next.generation===this.readGeneration){this.state.error=this.error(error);this.render();}}
   }
  }finally{this.refreshing=false;}
 }
 private maybeExplainReview(){
  const s=this.snapshot,r=s?currentRun(s):null;
  if(!s||!r?.review||this.state.product!=='dm'||!this.serverCaps?.reviewFeedback||this.mutationInFlight||this.uncertain||r.mode==='demo')return;
  // Engine cleanup can settle just after its final phase event. Re-read a bounded
  // number of times; these reads do not retry a model turn or infer a released lease.
  if(!s.chat?.reviewFeedbackReady){
   const key=r.id+':'+r.version,count=this.reviewReadCounts.get(key)??0;
   if(['READY_FOR_DELIVERY','ACCEPTED','CANCELLED','FAILED','PARTIAL','BLOCKED'].includes(r.state)&&count<3&&this.reviewRefreshTimer===null){
    const pid=s.project.id,generation=this.readGeneration;this.reviewReadCounts.set(key,count+1);
    this.reviewRefreshTimer=setTimeout(()=>{this.reviewRefreshTimer=null;void this.refreshFromEvent(pid,generation);},250*(count+1));
   }
   return;
  }
  const binding=reviewFeedbackBinding(s);if(!binding)return;
  const key=JSON.stringify(binding);
  if(reviewFeedbackRecord(s)||this.feedbackRequested.has(key))return;
  this.feedbackRequested.add(key);
  // One bounded attempt per observed review. A lost response does not trigger an automatic retry.
  void this.withMutation('review_feedback',async()=>{await this.write('/projects/'+encodeURIComponent(s.project.id)+'/review-feedback',{runId:r.id,version:s.project.version});await this.reload();}).catch(()=>{});
 }
  /** The engine mode is the server's answer, never a local toggle: keep the page honest. */
  private async syncEngineMode(pid:string){
    try{
      const e=await this.api.request<{engine?:string}>('/projects/'+encodeURIComponent(pid)+'/engine');
      const mode=e&&e.engine==='custom'?'custom':'classic';
      if(this.state.projectId!==pid||this.state.engineeringMode===mode)return;
      this.state={...this.state,engineeringMode:mode};this.render();
    }catch{}
  }
 private async reload(){if(!this.state.projectId)return;const pid=this.state.projectId,generation=this.readGeneration,sequence=++this.snapshotSequence,s=await this.api.request<ChatSnapshot>('/projects/'+encodeURIComponent(pid));if(this.acceptRead(s,pid,generation,sequence))this.maybeExplainReview();}
 private needProject():ChatSnapshot{if(!this.snapshot)throw new UiError('PROJECT_REQUIRED','请先打开一个项目。');return this.snapshot;}
 private async postSnapshot(suffix:string,body:unknown){const s=this.needProject(),pid=s.project.id,generation=this.readGeneration;const result=await this.write<ChatSnapshot>('/projects/'+encodeURIComponent(pid)+'/'+suffix,body);if(generation===this.readGeneration&&pid===this.state.projectId){this.appliedSequence=++this.snapshotSequence;this.apply(result);}return result;}
 private async withMutation(phase:ChatPhase|null,work:()=>Promise<void|ChatActionResult>):Promise<void|ChatActionResult>{
  if(this.mutationInFlight)throw new UiError('ACTION_IN_PROGRESS','当前操作仍在进行，请等待结果或使用停止。');
  if(this.uncertain)throw new UiError('RESULT_UNCERTAIN','上次写入结果尚未确认。请打开完整工作台核对记录后再继续；不会重放该请求。');
  this.mutationInFlight=true;this.appliedSequence=++this.snapshotSequence;this.mutatingPhase=phase;this.state.busy=true;this.state.error=null;if(phase)this.state.phase=phase;
  if(this.snapshot&&['seeking','optimizing'].includes(phase??''))this.state.capabilities.cancel=true;
  if(phase==='review_feedback')this.state.capabilities.cancel=false;
  this.render();
  try{return await work();}catch(error){this.state.error=this.error(error);throw error;}
  finally{this.mutationInFlight=false;this.mutatingPhase=null;this.state.busy=false;if(this.snapshot)this.apply(this.snapshot);this.render();if(this.refreshQueued)void this.refreshFromEvent(this.refreshQueued.pid,this.refreshQueued.generation);this.maybeExplainReview();}
 }
 async dispatch(a:ChatAction):Promise<void|ChatActionResult>{
  try{
   if(a.type==='settings-open'||a.type==='help-open'){this.navigate('/?ui=legacy&view='+(a.type==='settings-open'?'settings':'help'));return;}
   if(a.type==='mode-toggle'){if(this.mutationInFlight)throw new UiError('ACTION_IN_PROGRESS','当前请求尚未收束，请先等待结果。');this.state.engineeringMode=this.state.engineeringMode==='classic'?'custom':'classic';this.render();return;}    if(a.type==='engineering-settings-open'){this.navigate(this.state.projectId?'/?ui=legacy&project='+encodeURIComponent(this.state.projectId)+'&tab=flow':'/?ui=legacy&view=settings');return;}
   if(a.type==='product-switch'){
    if(this.mutationInFlight)throw new UiError('ACTION_IN_PROGRESS','当前请求尚未收束，请先等待结果。');
    if(a.product==='dm'&&this.serverProduct==='dreamflow')throw new UiError('DM_INSTANCE_REQUIRED','独立 DreamFlow 不运行 Seeker。请从 Dream Maker 图标打开需求探寻，已有工程运行会继续保留。');
    this.state.product=a.product;this.blank();return;
   }
   if(a.type==='project-new'){if(this.mutationInFlight)throw new UiError('ACTION_IN_PROGRESS','当前请求尚未收束。');this.blank();return;}
   if(a.type==='project-select'){if(this.mutationInFlight)throw new UiError('ACTION_IN_PROGRESS','当前请求尚未收束。');await this.open(a.id);return;}
   if(a.type==='refresh'){
    await this.list();
    if(this.snapshot){
     if(this.mutationInFlight)this.refreshQueued={pid:this.snapshot.project.id,generation:this.readGeneration};
     else{
      const pid=this.snapshot.project.id,generation=this.readGeneration;
      const profile=await this.api.request<{current:FlowProfileVersion|null}>('/projects/'+encodeURIComponent(pid)+'/flow-profile');
      if(generation===this.readGeneration&&pid===this.state.projectId)this.profile=profile.current;
      await this.reload();
     }
    }else if(!this.state.connected)await this.boot();
    this.render();return;
   }
   if(a.type==='attachments-add'){
    if(this.snapshot)throw new UiError('ATTACHMENT_SCOPE','当前方案已有版本。请通过下一版需求编辑加入材料，冻结运行不接收新附件。');
    for(const file of a.files){
     if(file.size>64000||!/[.](txt|md|json)$/i.test(file.name))throw new UiError('ATTACHMENT_FORMAT','当前接入支持 64 KB 以内的 TXT、Markdown 和方案 JSON。图片、PDF 与二进制附件仍待受控存储接线。');
     if(this.files.length>=5)throw new UiError('ATTACHMENT_LIMIT','一次最多添加五份文本材料。');
     const text=await file.text();if(text.includes('\u0000'))throw new UiError('ATTACHMENT_FORMAT','此文件不是可用的纯文本。');
     const id=crypto.randomUUID();this.files.push({id,name:file.name,text,size:file.size});this.state.attachments.push({id,name:file.name,size:file.size,status:'selected',detail:'随下一次提交进入需求；尚未上传'});
    }
    this.render();return;
   }
   if(a.type==='attachment-remove'){this.files=this.files.filter(f=>f.id!==a.id);this.state.attachments=this.state.attachments.filter(f=>f.id!==a.id);this.render();return;}
   if(a.type==='cancel'){
    const s=this.needProject(),r=currentRun(s);
    // Cancellation must remain available while a model operation is pending.
    if(this.mutatingPhase==='review_feedback')throw new UiError('READ_ONLY_ANALYSIS_PENDING','当前正在解释审查结果，不会取消已经完成的工程运行。');
    if(this.mutationInFlight&&['seeking','optimizing'].includes(this.mutatingPhase??''))await this.write('/projects/'+encodeURIComponent(s.project.id)+'/planning/cancel',{});
    else if(r)await this.write('/runs/'+encodeURIComponent(r.id)+'/cancel',{});
    else await this.write('/projects/'+encodeURIComponent(s.project.id)+'/planning/cancel',{});
    await this.reload();return;
   }
   if(a.type==='question-help')return await this.withMutation('seeking',async()=>{
    const s=this.needProject();if(!this.state.capabilities.help)throw new UiError('QUESTION_HELP_UNAVAILABLE','当前问题帮助不可用，或本轮已冻结。');
    const result=await this.write<{explanation:string}>('/projects/'+encodeURIComponent(s.project.id)+'/question-help',{questionId:a.questionId,text:a.text,version:s.project.version});return{text:result.explanation};
   });
   if(a.type==='project-rename'||a.type==='project-archive'||a.type==='project-restore'||a.type==='project-pin')return await this.withMutation(null,async()=>{
    const selected=await this.api.request<ChatSnapshot>('/projects/'+encodeURIComponent(a.id));
    const body={version:selected.project.version,...(a.type==='project-rename'?{name:a.title}:a.type==='project-pin'?{pinned:a.pinned}:{archived:a.type==='project-archive'})};
    await this.write('/projects/'+encodeURIComponent(a.id)+'/presentation',body);await this.list();if(a.id===this.state.projectId)await this.reload();
   });
   if(a.type==='role-configure')return await this.withMutation(null,async()=>{
    if(a.role!=='seeker'){
      // The verified runner is sealed: the three engineering roles open for inspection only. Turning the
      // switch off is the single, explicit way to unlock edits.
      // Classic is the default, not a veto: choosing another harness or model is exactly how a
      // project leaves classic, and leaving classic is what turns Laya off. The write does that.
      const pid=this.state.projectId;if(!pid)throw new UiError('PROJECT_REQUIRED','请先建立项目，再配置工程角色。');
      const wire=a.role==='planner'?'planner2':a.role;
      const catalog=await this.api.request<{roles:{role:string;revision:number;selection:{skills:string[];plugins:string[]}}[]}>('/projects/'+encodeURIComponent(pid)+'/roles');
      // The catalog names roles after the workbench (planner), the wire after the engine (planner2).
      const catalogRole=a.role==="planner"?"planner":a.role;
      const entry=catalog.roles.find(row=>row.role===catalogRole);
      if(!entry)throw new UiError('ROLE_CONFIG_UNKNOWN','没有找到这个角色的当前配置。');
      await this.write('/studio/roles/'+wire+'/config',{projectId:pid,revision:entry.revision,selection:{model:a.model??'',effort:a.reasoning??'default',harness:a.harness??'',skills:entry.selection.skills,plugins:entry.selection.plugins}});
      await this.open(pid);return;
     }
     
     
    if(this.snapshot?.project.planner1Binding)throw new UiError('PROJECT_BINDING_FROZEN','此项目已绑定账户与模型。请选择新聊天再配置 API，或保留原绑定继续。');
    if(!a.model)throw new UiError('SEEKER_MODEL_REQUIRED','请先从模型目录选择要使用的模型。');
    if(!['openai','deepseek'].includes(a.provider??'')||a.harness!=='api'||a.reasoning!=='default')throw new UiError('SEEKER_API_SELECTION','请选择当前支持的官方 API；推理强度目前由原服务端协议管理。');
    // The workbench is the Seeker surface: save the binding on the seeker_api route (version 4), so the
    // project is created with the two built-in skills. Saving without `route` would silently fall back to
    // the legacy version-2 binding, which cannot run grillme or prompt-optimizer.
    await this.write('/planner1/selection',{provider:a.provider,authentication:'api_key',model:a.model,confirmed:true,route:'seeker_api'});
    this.config=await this.api.request<PublicConfig>('/config');this.state.roles=rolesFor(this.config,this.snapshot,this.profile,this.seekerCatalog);
    if(!this.apiSelected())throw new UiError('SEEKER_API_NOT_PERSISTED','服务端没有把选择保存为可发送的 API 绑定，请重新读取配置。');
    this.state.notice='Seeker API 选择已保存。实际连接与调用费用仍受账户、资格和预算检查。';
   });
   if(a.type==='role-restore-defaults')return await this.withMutation(null,async()=>{
     // The way back to classic: write the product defaults for the three engineering roles. The engine
     // then re-derives itself, because the selection hash equals the defaults hash again.
     const pid=this.state.projectId;if(!pid)throw new UiError('PROJECT_REQUIRED','请先建立项目，再恢复默认配置。');
     const cfg=await this.api.request<{config:{codex:{model:string};dsh:{model:string}}}>('/config');
     const c=cfg&&cfg.config;if(!c)throw new UiError('CONFIG_UNAVAILABLE','读取本机默认配置失败。');
     const plan:[string,string,'codex'|'dsh'][]=[['planner','planner2','codex'],['executor','executor','dsh'],['reviewer','reviewer','codex']];
     for(const [catalogRole,wire,lane] of plan){
       const roles=await this.api.request<{roles:{role:string;revision:number;selection?:{skills?:string[];plugins?:string[]}}[]}>('/projects/'+encodeURIComponent(pid)+'/roles');
       const entry=(roles.roles||[]).find(row=>row.role===catalogRole);
       if(!entry)continue;
       const model=lane==='codex'?c.codex.model:c.dsh.model;
       await this.write('/studio/roles/'+wire+'/config',{projectId:pid,revision:entry.revision,selection:{model,effort:'default',harness:lane==='codex'?'codex-app-server':'dsh',skills:(entry.selection&&entry.selection.skills)||[],plugins:(entry.selection&&entry.selection.plugins)||[]}});
     }
     await this.open(pid);
    });
   if(a.type==='role-extensions')return await this.withMutation(null,async()=>{
      // Classic is the default, not a veto: writing a role configuration is how a project leaves it.
     const pid=this.state.projectId;if(!pid)throw new UiError('PROJECT_REQUIRED','请先建立项目，再配置角色能力。');
     const wire=a.role==='planner'?'planner2':a.role;
     const catalog=await this.api.request<{roles:{role:string;revision:number;skills?:ChatExtension[];plugins?:ChatExtension[];selection:{model:string;effort:string;harness:string;skills:string[];plugins:string[]}}[]}>('/projects/'+encodeURIComponent(pid)+'/roles');
     const catalogRole=a.role==="planner"?"planner":a.role;
     const entry=catalog.roles.find(row=>row.role===catalogRole);
     if(!entry)throw new UiError('ROLE_CONFIG_UNKNOWN','没有找到这个角色的当前配置。');
     // The form posts one flat id list; the catalog decides which ids are skills and which are plugins.
     const skills=a.ids.filter(id=>(entry.skills??[]).some(option=>option.id===id));
     const plugins=a.ids.filter(id=>(entry.plugins??[]).some(option=>option.id===id));
     const unknown=a.ids.filter(id=>!skills.includes(id)&&!plugins.includes(id));
     if(unknown.length)throw new UiError('ROLE_CONFIG_SKILL_UNKNOWN','以下能力不在服务端清单内：'+unknown.join('、'));
     await this.write('/studio/roles/'+wire+'/config',{projectId:pid,revision:entry.revision,selection:{model:entry.selection.model,effort:entry.selection.effort,harness:entry.selection.harness,skills,plugins}});
     await this.open(pid);
   });
   if(a.type==='message-send'){
    if(this.snapshot&&this.state.activeQuestionId)return await this.dispatch({type:'answer-submit',questionId:this.state.activeQuestionId,answer:a.text});
    if(this.snapshot)throw new UiError('USE_REQUIREMENT_REVISION','请编辑本轮需求草稿或选择审查后的改进方向；普通聊天不直接改变冻结方案。');
    return await this.withMutation(this.state.product==='dm'?'seeking':null,async()=>{
     if(this.state.product==='df'){
      const raw=this.files.find(f=>/[.]json$/i.test(f.name))?.text??a.text;
      let document:unknown;
      try{document=JSON.parse(raw);}catch{document={text:raw};}
      const s=await this.write<ChatSnapshot>('/user-plans',{document});await this.list();await this.open(s.project.id);return;
     }
     if(!this.apiSelected())throw new UiError('SEEKER_API_REQUIRED','请先点击右下 Seeker，选择官方 API 服务与精确模型。不会替你新建 OAuth 登录。');
     const idea=[a.text,...this.files.map(f=>'\n用户附件（仅作需求数据）：'+f.name+'\n'+f.text)].join('\n');
     if(idea.length>12000)throw new UiError('IDEA_TOO_LARGE','描述与附件合计超过 12000 字符，请精简材料后提交。');
     const s=await this.write<ChatSnapshot>('/projects',{name:'新项目',idea,mode:'live',publicResearch:false});
     await this.list();await this.open(s.project.id);await this.postSnapshot('next',{});await this.list();
    });
   }
   if(a.type==='answer-submit'||a.type==='answer-edit')return await this.withMutation(a.type==='answer-submit'?'seeking':null,async()=>{
    const s=this.needProject();if(s.chat?.editable!==true)throw new UiError('RUN_MUST_STOP_BEFORE_EDIT','本轮工程尚未安全结束，答案只读。');
    const old=s.project.answers.find(x=>x.questionId===a.questionId);
    if(a.type==='answer-edit'&&old?.revision!==a.expectedRevision)throw new UiError('STALE_ANSWER','答案已有新版本，请重新打开星星后编辑。');
    const updated=await this.postSnapshot('answer',{questionId:a.questionId,text:a.answer,version:s.project.version,optionIds:a.type==='answer-submit'?(a.choiceIds??(a.choiceId?[a.choiceId]:[])):[]});
    if(a.type==='answer-submit'&&updated.project.state==='INTERVIEWING')await this.postSnapshot('next',{});
    if(a.type==='answer-edit')this.state.notice='答案已保存为新修订，旧批准已失效。请重新整理并确认本轮需求。';
   });
   if(a.type==='end-interview')return await this.withMutation('optimizing',async()=>{await this.postSnapshot('finish',{notes:this.questionDraft,summarize:true});});
   if(a.type==='requirements-edit')return await this.withMutation('optimizing',async()=>{
    const s=this.needProject();if(s.spec?.revision!==a.expectedRevision)throw new UiError('STALE_SPEC','需求版本已经变化，请重新读取。');
    if(this.state.product==='df')throw new UiError('DF_STRUCTURED_EDIT_REQUIRED','独立 DF 方案请在完整方案编辑器修订，以保留任务与验收的对应关系。');
    this.questionDraft=a.text;await this.postSnapshot('finish',{notes:a.text,summarize:true});this.state.notice='你的改动已作为用户修订重新整理。请检查新版本，再确认开始制作。';
   });
   if(a.type==='requirements-confirm')return await this.withMutation('flow',async()=>{
    const s=this.needProject();if(!s.spec||s.spec.revision!==a.expectedRevision||s.chat?.editable!==true)throw new UiError('STALE_SPEC','方案不是当前可确认版本，请刷新后核对。');
    if(a.text!==requirementText(s.spec))throw new UiError('UNSAVED_REQUIREMENT_EDITS','你修改了需求。请先保存并查看整理后的新版本，再确认开始。');
    if(currentRun(s))throw new UiError('RUN_ALREADY_EXISTS','当前方案已经有运行，请查看或恢复原运行。');
    const flowName=this.state.engineeringMode,laya=flowName==='classic'&&this.config?.config.laya.mode==='advisory';
    // Reuse a known SPEC approval after an explicitly failed preflight. Never
    // infer a failed build from a lost response or silently approve another hash.
    const approved=s.project.state==='READY_TO_BUILD'?s:await this.postSnapshot('approve',{specHash:s.spec.hash});
    if(approved.spec?.hash!==s.spec.hash)throw new UiError('STALE_SPEC','确认期间方案发生变化，请重新核对。');
    // This button explicitly authorizes these two existing operations, never budget increases or final acceptance.
    await this.postSnapshot('build',{specHash:s.spec.hash,approved:true,flowName,laya});
   });
   if(a.type==='review-followup')return await this.withMutation('seeking',async()=>{
    const s=this.needProject(),r=currentRun(s);if(this.state.product!=='dm'||!r?.review||s.chat?.reviewFeedbackReady!==true)throw new UiError('REVIEW_NOT_SETTLED','先等待审查及工作区收口，再确认新的需求方向。');
    const report=await this.api.request<{reportHash:string}>('/runs/'+encodeURIComponent(r.id)+'/report');
    await this.write('/runs/'+encodeURIComponent(r.id)+'/conclude',{choice:'ALTERNATIVE',reportHash:report.reportHash,constraint:a.text});
    await this.postSnapshot('alternative',{constraint:a.text});await this.postSnapshot('next',{});
   });
   if(a.type==='demo-step')throw new UiError('NO_DEMO_IN_LIVE','本机连接不使用演示事件推进。');
  }catch(error){this.state.error=this.error(error);this.render();throw error;}
 }
 dispose(){this.disposed=true;this.clearReviewRefresh();this.refreshQueued=null;this.stopEvents?.();this.api.dispose();}
}
