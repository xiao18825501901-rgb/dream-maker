import type { Project, Run, Spec } from '../shared/types.js';
import type { Snapshot, PublicConfig } from './contracts.js';
import type { FlowProfileVersion } from '../shared/flow-profile.js';
import type { ChatState, ChatRole, ChatRoleConfig, ChatQuestion, ChatMessage, ChatPhase, ChatProject, ChatOption } from './chat-types.js';
import { workStatusFor } from './chat-work-status.js';

/** Names change only in the view. Persisted role IDs, signatures and historical evidence do not. */
export const STORAGE_ROLE = {seeker:'planner1',planner:'planner2',executor:'executor',reviewer:'reviewer'} as const;
export interface ChatFeedbackBinding {runId:string;runVersion:number;specHash:string;reviewHash:string;projectVersion:number}
export interface ChatSnapshot extends Snapshot {
 chat?:{editable:boolean;reviewFeedbackReady?:boolean;presentation?:{pinned:boolean;archived:boolean;revision:number;nameEdited:boolean};
  reviewFeedbackBinding?:ChatFeedbackBinding|null;reviewFeedback?:Snapshot['records'][number]|null;
  preworkCloseout?:{contractId:string;treeHash:string;coverageReached:boolean;requirementIds:string[]}|null};
}
export interface PresentationProject extends Project {presentation?:{pinned:boolean;archived:boolean}}
export function projectList(rows:PresentationProject[]):ChatProject[]{
 return rows.map(p=>({id:p.id,title:p.name,product:p.planner1Mode==='USER'?'df':'dm',pinned:p.presentation?.pinned===true,archived:p.presentation?.archived===true,updatedAt:p.updatedAt,subtitle:p.mode==='demo'?'本地规则演示':undefined}));
}
export function currentRun(s:Snapshot):Run|null {
 const r=s.runs.find(r=>r.id===s.project.activeRunId)??s.runs.find(r=>r.specId===s.spec?.id&&r.specHash===s.spec?.hash);
 return r&&s.spec&&!s.spec.stale&&r.specId===s.spec.id&&r.specHash===s.spec.hash?r:null;
}
export function currentQuestion(s:Snapshot){return s.project.state==='INTERVIEWING'?s.project.questions.find(q=>!s.project.answers.some(a=>a.questionId===q.id))??null:null;}
export function reviewFeedbackBinding(s:ChatSnapshot):ChatFeedbackBinding|null {
 const r=currentRun(s),b=s.chat?.reviewFeedbackBinding;
 return r?.review&&r.treeHash&&r.review.treeHash===r.treeHash&&b&&b.runId===r.id&&b.runVersion===r.version&&b.specHash===r.specHash&&b.projectVersion===s.project.version&&/^[a-f0-9]{64}$/.test(b.reviewHash)?b:null;
}
export function reviewFeedbackRecord(s:ChatSnapshot):Snapshot['records'][number]|null {
 const b=reviewFeedbackBinding(s);if(!b)return null;
 const records=[...(s.chat?.reviewFeedback?[s.chat.reviewFeedback]:[]),...s.records];
 return records.find(row=>{
  if(row.kind!=='SeekerReviewFeedback'||row.runId!==b.runId||!row.data||typeof row.data!=='object')return false;
  const d=row.data as Record<string,unknown>;
  return !(s.project.mode==='live'&&d.source!=='MODEL')&&Object.entries(b).every(([key,value])=>d[key]===value);
 })??null;
}
export function phaseFor(s:Snapshot):ChatPhase {
 const r=currentRun(s);
 if(r){
  const phases:Record<string,ChatPhase>={PLANNING:'planning',IMPLEMENTING:'executing',REPAIRING:'executing',VERIFYING:'verifying',REVIEWING:'reviewing',READY_FOR_DELIVERY:'ready',ACCEPTED:'accepted',BLOCKED:'blocked',FAILED:'blocked',PARTIAL:'blocked',PAUSED:'paused',PAUSE_REQUESTED:'paused',CANCEL_REQUESTED:'cancelling',CANCELLED:'paused'};
  return phases[r.state]??'flow';
 }
 if(s.project.state==='SPEC_REVIEW'||s.project.state==='READY_TO_BUILD')return 'awaiting_confirmation';
 if(s.project.state==='INTERVIEWING'||s.project.state==='AWAITING_INTERVIEW_DECISION')return 'awaiting_answer';
 return 'idle';
}
export function requirementText(spec:Spec|null):string {
 if(!spec)return '';
 const p=spec.projectPlan;
 return [spec.brief||p?.goal||'需求确认', '', '具体要求', ...spec.requirements.map(r=>`${r.id} · ${r.text}`), '', '完成标准', ...(p?.acceptance.map(a=>`${a.id} · ${a.check}`)??spec.acceptance),
  ...(spec.constraints.length?['','约束',...spec.constraints]:[]),...(spec.assumptions.length?['','待核对的假设',...spec.assumptions]:[]),...(spec.outOfScope.length?['','本轮范围之外',...spec.outOfScope]:[]),...(spec.conflicts.length?['','需要解决的冲突',...spec.conflicts]:[])].join('\n');
}
/** No "done" from a filled answer or implemented task. Match the exact accepted/verified source. */
export function starsFor(s:ChatSnapshot):ChatQuestion[]{
 const r=currentRun(s),closeout=s.chat?.preworkCloseout;
 const verified=!!(r?.prework&&['READY_FOR_DELIVERY','ACCEPTED'].includes(r.state)&&r.treeHash&&r.verification?.ok&&r.verification.treeHash===r.treeHash&&r.review?.verdict==='PASS'&&r.review.treeHash===r.treeHash&&closeout?.coverageReached&&closeout.contractId===r.prework.contractId&&closeout.treeHash===r.treeHash);
 return s.project.questions.map(q=>{
  const a=s.project.answers.find(a=>a.questionId===q.id),reqs=a?s.spec?.requirements.filter(x=>x.sourceAnswerIds.includes(a.id))??[]:[];
  const ids=reqs.map(x=>x.id),tasks=r?.tasks.filter(t=>ids.some(id=>t.requirementIds.includes(id)))??[];
  const allCovered=ids.length>0&&ids.every(id=>tasks.some(t=>t.requirementIds.includes(id)));
  const done=verified&&allCovered&&ids.every(id=>closeout!.requirementIds.includes(id))&&tasks.length>0&&tasks.every(t=>t.status==='done');
  // Additive work rank: the four states above keep their precedence; the three new ranks only
  // apply when every task of the run is closed, and each one re-tests the fact below it.
  const work=workStatusFor({answered:!!a,answerRevision:a?.revision??0,taskCount:tasks.length,
   tasksDone:tasks.filter(t=>t.status==='done').length,tasksRunning:tasks.filter(t=>t.status==='running').length,
   runBlocked:r?.state==='BLOCKED',verificationMatchesSource:!!(r?.verification?.ok&&r.treeHash&&r.verification.treeHash===r.treeHash),
   reviewPassedOnSource:!!(r?.review?.verdict==='PASS'&&r.treeHash&&r.review.treeHash===r.treeHash),closeoutComplete:done});
  let status:ChatQuestion['status']=!a?'pending':a.revision>1?'changed':'answered';
  let evidenceLabel=!a?'当前问题':!ids.length?'已保存回答 · 尚未关联工作包':'已保存回答 · 尚未验证';
  if(done){status='done';evidenceLabel=r!.state==='ACCEPTED'?'相关工作已验证并接受':'相关工作已验证 · 待用户接受';}
  else if(tasks.some(t=>t.status==='running')){status='working';evidenceLabel='相关工作正在执行';}
  else if(r?.state==='BLOCKED'&&tasks.length){status='blocked';evidenceLabel='相关工作受阻 · '+(r.reason??'等待处理');}
  else if(work.status==='reviewed'){status='reviewed';evidenceLabel=work.reason;}
  else if(work.status==='verified'){status='verified';evidenceLabel=work.reason;}
  else if(work.status==='crafted'){status='crafted';evidenceLabel=work.reason;}
  return {id:q.id,text:q.text,answer:a?.text,choices:q.options,allowMultiple:q.allowMultiple,revision:a?.revision??0,status,requirementIds:ids,evidenceLabel};
 });
}
export function messagesFor(s:ChatSnapshot,product:'dm'|'df'):ChatMessage[]{
 const messages:ChatMessage[]=[{id:'idea-'+s.project.id,role:'user',text:s.project.idea,at:s.project.createdAt}];
 const active=currentQuestion(s);
 if(product==='dm')for(const q of s.project.questions){
  // The current question has its own answer card; it must not appear twice.
  if(q.id===active?.id)continue;
  messages.push({id:q.id,role:'seeker',text:q.text,at:q.createdAt,badge:'Grill Me'});
  const a=s.project.answers.find(a=>a.questionId===q.id);
  if(a)messages.push({id:a.id,role:'user',text:a.status==='skipped'?'这题暂时跳过':a.text,at:a.createdAt,badge:a.revision>1?'已修订 · v'+a.revision:undefined});
 }
 const r=currentRun(s);
 if(r){
  if(r.tasks.length)messages.push({id:r.id+'-plan',role:'planner',title:'本轮工程计划',text:r.tasks.map(t=>`${t.id} · ${t.title}\n${t.dependsOn.length?'依赖 '+t.dependsOn.join('、'):'可独立开始'}`).join('\n\n'),badge:r.roleIdentities?.planner2?.model??'工程规划'});
  if(r.prework)messages.push({id:r.id+'-prework',role:'system',title:'Prework 交接已建立',text:'工作包、路径范围与验收要求已由原 Engine 保存。合同 '+r.prework.contractId,kind:'activity'});
  const started=r.tasks.filter(t=>t.status!=='pending');
  if(started.length)messages.push({id:r.id+'-work',role:'executor',title:'工作区进展',text:started.map(t=>`${t.id} · ${t.title} — ${t.status==='running'?'进行中':t.status==='done'?'已收口':'已制作，等待核验'}`).join('\n'),badge:r.roleIdentities?.executor?.model??'受控执行'});
  if(r.verification)messages.push({id:r.id+'-verify',role:'system',title:r.verification.ok?'验证通过':'验证未通过',text:'验证依据已绑定工作区版本。'+(r.verification.treeHash===r.treeHash?'与当前源码摘要一致。':'与当前源码摘要不同，需要重新核对。'),kind:'activity'});
  if(r.review)messages.push({id:r.id+'-review',role:'reviewer',title:r.review.verdict==='PASS'?'审查通过':r.review.verdict==='CHANGES_REQUESTED'?'需要修订':'审查受阻',text:r.review.findings.length?r.review.findings.map(f=>`${f.severity} · ${f.description}\n${f.evidence}`).join('\n\n'):'本轮没有报告未解决的问题。最终接受仍由你决定。',badge:r.roleIdentities?.reviewer?.model??'独立审查',kind:'result'});
  const feedback=product==='dm'?reviewFeedbackRecord(s):null;
  if(feedback){const rec=feedback;
   const d=rec.data as Record<string,unknown>,f=(d.feedback??d) as Record<string,unknown>;
   const list=(v:unknown)=>Array.isArray(v)?v.filter(x=>typeof x==='string').join('\n'):'';
   messages.push({id:rec.id,role:'seeker',title:'本轮结果与下一步',text:[f.summary,list(f.blockers),list(f.options),f.question].filter(x=>typeof x==='string'&&x).join('\n\n'),badge:'基于独立审查',at:rec.at});
  }
 }
 return messages;
}
export function emptyRoles():Record<ChatRole,ChatRoleConfig>{
 const make=(role:ChatRole,harness:string):ChatRoleConfig=>({role,model:'',reasoning:'default',harness,models:[],reasoningLevels:[{id:'default',label:'由当前运行器管理',available:true}],harnesses:[{id:harness,label:harness,available:true}],extensions:[],selectedExtensions:[]});
 return {seeker:make('seeker','api'),planner:make('planner','codex'),executor:make('executor','dsh'),reviewer:make('reviewer','codex')};
}
/** Whether the stored planner1 binding may start a Live project from the workbench. Version 4 is the
 *  seeker_api route — the one that actually carries grillme and prompt-optimizer. A legacy version-2
 *  binding still opens old projects but cannot feed the new skills, so it must not start a new one. */
export function seekerApiSelected(config:Pick<PublicConfig,'planner1Binding'|'planner1Retired'>|null|undefined):boolean{
 return config?.planner1Binding?.authMethod==='api_key'&&config.planner1Binding.bindingVersion===4&&!config.planner1Retired;
}
export function rolesFor(settings:PublicConfig|null,s:Snapshot|null,profile:FlowProfileVersion|null=null,catalogs?:ReadonlyMap<string,ChatOption[]>):Record<ChatRole,ChatRoleConfig>{
 const roles=emptyRoles();if(!settings)return roles;
 const cfg=settings.config,r=s?currentRun(s):null;
 // The picker reads GET /api/planner1/models; rolesFor only projects the fetched options and
 // keeps the exact current binding selected, so no browser guess becomes a dispatchable model.
 const seekerModel=settings.planner1Binding?.model??cfg.planner1.model,seekerProvider=settings.planner1Binding?.provider??cfg.planner1.provider??'deepseek',seekerModels=catalogs?.get(seekerProvider)??[];
 roles.seeker={...roles.seeker,model:seekerModel,provider:seekerProvider,modelEditable:false,models:seekerModel&&!seekerModels.some(option=>option.id===seekerModel)?[...seekerModels,{id:seekerModel,label:seekerModel+' · 当前绑定',available:true}]:[...seekerModels],providers:[{id:'deepseek',label:'DeepSeek 官方 API',available:true},{id:'openai',label:'OpenAI 官方 API',available:true}],providerLabel:settings.planner1Binding?.provider??'API 服务',authLabel:settings.planner1Binding?.authMethod==='api_key'?'API Key · 按实际调用计费':'历史连接 · 新项目请选 API',extensions:[{id:'grillme',kind:'skill',label:'Grill Me',description:'逐题澄清需求；保留用户原话与版本。',available:true,required:true},{id:'prompt-optimizer',kind:'skill',label:'Prompt Optimizer',description:'将已确认回答整理为完整需求草稿。',available:true,required:true}],selectedExtensions:['grillme','prompt-optimizer']};
 for(const role of ['planner','executor','reviewer'] as const){
  const old=STORAGE_ROLE[role];const identity=r?.roleIdentities?.[old];
  const model=identity?.model??(role==='executor'?cfg.dsh.model:cfg.codex.model);
  const harness=role==='executor'?'dsh':'codex';
  roles[role]={...roles[role],model,models:model?[{id:model,label:model+' · 已配置',available:true}]:[],harness,providerLabel:identity?.provider??(role==='executor'?'DSH':'Codex'),authLabel:identity?.authentication??(role==='executor'?'API Key':'官方原生认证'),frozen:true,extensions:[],harnesses:[{id:harness,label:harness,available:true},...(['claude','pi','opencode','cline','codex'] as const).filter(x=>x!==harness).map(id=>({id,label:({claude:'Claude Code',pi:'Pi Agent',opencode:'opencode',cline:'Cline',codex:'Codex CLI'} as Record<string,string>)[id]??id,available:true}))]};
 }
 const f=r?.flowConfig??(s&&profile?.projectId===s.project.id?profile.configuration:null);
 if(f){
  for(const role of ['planner','executor','reviewer'] as const){
   const row=role==='planner'?f.roles.planner2:role==='executor'?f.roles.executors[0]:f.roles.reviewer;
   if(!row)continue;
   const model=typeof row.model==='string'?row.model:row.model.id;
   roles[role]={...roles[role],model,harness:row.runtime,providerLabel:row.provider,authLabel:row.authentication,models:[{id:model,label:model+(r?' · 本轮冻结':' · 已确认配置，尚未运行'),available:true}],harnesses:[{id:row.runtime,label:row.runtime,available:true}],frozen:true};
  }
 }
 return roles;
}
export function initialChatState():ChatState {
 return {product:'dm',engineeringMode:'classic',evidence:'offline',loading:true,connected:false,busy:false,title:'新项目',projects:[],projectId:null,messages:[],phase:'idle',questions:[],locked:false,roles:emptyRoles(),capabilities:{send:false,answers:false,editAnswers:false,help:false,confirm:false,configureRoles:false,extensions:false,attachments:false,rename:false,archive:false,pin:false,cancel:false},attachments:[],legacyHref:'/?ui=legacy'};
}
