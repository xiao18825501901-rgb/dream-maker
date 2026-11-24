import {DemoScenarioAdapter} from './demo-api.js';
import {UiError} from './contracts.js';
import type {Snapshot} from './contracts.js';
import type {PlanVersion,Project} from '../shared/types.js';
import type {Product} from '../shared/product.js';
import type {ProjectPlan} from '../shared/project-plan.js';
import type {LifecycleStatus} from '../shared/lifecycle.js';
import {reviewPlan,reviewSetup,reviewNotice,reviewHelp} from './frontend-review-data.js';
const clone=<T>(v:T):T=>structuredClone(v),now=()=>new Date().toISOString();
/** Compile-time-only browser demonstration. No controller, model, credential or network adapter. */
export class FrontendReviewAdapter extends DemoScenarioAdapter {
 readonly presentation='frontend-review' as const;
 protected readonly storageKey:string;
 private history=new Map<string,PlanVersion[]>();
 private setup;
 private concluded=new Set<string>();
 private lifecycle:LifecycleStatus={schema:'dream-maker.lifecycle.v1',state:'RUNNING',scope:'CONTROLLER_OWNED_WORK_ONLY',automaticResume:false,browserCloseStopsWork:false,currentRoundMayStillRun:false,changedAt:now(),lastChoice:null,code:null,active:{engineJobs:0,interviews:0,modelCalls:0,queued:0,grants:0,quarantined:0}};
 constructor(private product:Product='dream-maker'){super();this.storageKey='dream-maker.frontend-review.v1.'+product;this.setup=reviewSetup(product);}
 async init():Promise<void>{
  await super.init();
  try{const saved=JSON.parse(sessionStorage.getItem(this.storageKey+'.history')??'null');if(Array.isArray(saved))for(const [id,rows] of saved)if(typeof id==='string'&&Array.isArray(rows))this.history.set(id,rows);const concluded=JSON.parse(sessionStorage.getItem(this.storageKey+'.concluded')??'[]');if(Array.isArray(concluded))for(const id of concluded)if(typeof id==='string')this.concluded.add(id);}catch{/* Current session still works. */}
  for(const s of this.data.values()){
   if(this.product==='dreamflow')s.project.planner1Mode='USER';
   if(s.spec){s.spec.projectPlan??=reviewPlan(s);this.remember(s);}
   for(const r of s.runs){r.verification=null;r.review=null;if(s.project.id==='sample-review'&&!r.reason)r.state='PARTIAL';r.reason=reviewNotice;}
   this.decorate(s);
  }
  const versions=this.data.get('sample-spec')!;
  if((this.history.get(versions.project.id)?.length??0)<3){
   this.history.get(versions.project.id)![0].approval={actor:'UI_REVIEW_SIMULATED_USER',at:now()};
   this.finish(versions,'演示 v2：补充本地保存与文件导出。');this.finish(versions,'演示 v3：保留导出，补充小白帮助与恢复说明。');
  }
  if(!this.data.has('sample-delivery')){
   const delivery=this.create('成果交付示例','查看固定样例预览、下载与单独接受。不是实际制作成果。','sample-delivery');this.finish(delivery,reviewNotice);delivery.project.state='READY_TO_BUILD';
   await super.request('/projects/sample-delivery/build','POST',{approved:true,specHash:delivery.spec!.hash});this.setScenario(delivery,'READY_FOR_DELIVERY');
  }
  this.persist();
 }
 protected next(p:Project):void{
  if(p.planner1Mode==='USER')throw new UiError('USER_PLAN_NO_INTERVIEW','独立 DreamFlow 由你提供方案，不需要访谈。');
  super.next(p);const q=p.questions.at(-1);if(!q)return;
  const choices:Record<string,string[]>={'目标用户':['自己使用','家人或朋友','学习小组','工作团队'],'核心用途':['记录和整理','查询和检索','提醒与跟进','制作和导出'],'运行平台':['Windows 电脑','电脑浏览器','手机浏览器','多个设备'],'数据保存':['仅保存在本机','可以导出文件','需要修改历史','暂不确定'],'明确取舍':['先完成最重要的用途','先保证离线可用','先做容易上手的界面','先保留未来扩展空间']};
  q.options=(choices[q.topic]??['以简单易用为主','以保留数据为主','先做最小可用版本','暂不确定，交给方案建议']).map((label,i)=>({id:'choice-'+(i+1),label}));q.allowMultiple=false;
 }
 protected finish(s:Snapshot,notes:string):void{if(s.runs.some(r=>!this.concluded.has(r.id)))throw new UiError('FLOW_NOT_CONCLUDED','先结束当前轮次，旧方案和成果会保留。');super.finish(s,notes);s.spec!.projectPlan=reviewPlan(s);this.remember(s);}
 protected setScenario(s:Snapshot,state:string):void{super.setScenario(s,state);const r=s.runs[0];r.verification=null;r.review=null;}
 protected persist():void{super.persist();try{sessionStorage.setItem(this.storageKey+'.history',JSON.stringify([...this.history]));sessionStorage.setItem(this.storageKey+'.concluded',JSON.stringify([...this.concluded]));}catch{/* No sensitive data. */}}
 private remember(s:Snapshot):void{
  const spec=s.spec;if(!spec)return;const rows=this.history.get(s.project.id)??[];if(!rows.some(r=>r.id===spec.id))rows.push({id:spec.id,projectId:s.project.id,revision:spec.revision,parentId:rows.at(-1)?.id??null,specHash:spec.hash,contentHash:'UI_REVIEW_NOT_A_CONTENT_HASH',origin:'COMPLETE_PLAN',snapshot:clone(spec),source:{provenance:'CURRENT_PROJECT_INPUT',name:s.project.name,idea:s.project.idea},createdAt:spec.createdAt,approval:null});this.history.set(s.project.id,rows);
 }
 private decorate(s:Snapshot):Snapshot {s.project.warnings=[reviewNotice];s.flowOptions=[];return s;}
 private planDocument(s:Snapshot){return {schema:'dream-maker.user-plan.v1',name:s.project.name,mode:'demo',plan:s.spec?.projectPlan};}
 async request<T>(path:string,method='GET',body:unknown={}):Promise<T>{
  const b=(body??{}) as Record<string,unknown>,url=new URL(path,'http://review.invalid'),parts=url.pathname.split('/').filter(Boolean),pid=parts[0]==='projects'?decodeURIComponent(parts[1]??''):'',s=this.data.get(pid),action=parts.slice(2).join('/');let value:unknown;
  if(path==='/product')value={product:this.product};
  else if(path==='/onboarding'&&method==='GET')value=this.setup;
  else if(path==='/onboarding/budget'&&method==='POST'){
   const budget=this.setup.fees.userBudget!;if(b.confirmed!==true)throw new UiError('USER_BUDGET_SETUP_REQUIRED','请明确确认演示限额。');if(b.revision!==budget.revision)throw new UiError('USER_BUDGET_REVISION_CONFLICT','');
   const limits=b.limits as Record<string,unknown>|undefined;const parse=(currency:string)=>{const v=limits?.[currency];if(typeof v!=='string'||!/^\d{1,7}(\.\d{1,6})?$/.test(v))throw new UiError('USER_BUDGET_INVALID','');return Math.round(Number(v)*1000000);};
   budget.limits={CNY:parse('CNY'),USD:parse('USD')};budget.configured=true;budget.revision++;budget.startedAt??=now();for(const c of ['CNY','USD'] as const)budget.byCurrency[c].remainingMicros=budget.limits[c];value=this.setup;
  }else if(path==='/help')value={topics:reviewHelp};
  else if(path==='/diagnostics')value={dispatch:{executorSlots:2,active:[],queued:[],quarantined:[]},note:reviewNotice};
  else if(path==='/maintenance'&&method==='GET')value={schema:'dream-maker.maintenance.v1',scope:'APPLICATION_STATE_ONLY',completeProjectBackup:false,snapshots:[],usage:{bytes:0,limitBytes:0,snapshots:0,rehearsals:0},modelsCalled:0,automaticResume:false};
  else if(path==='/application/lifecycle'){
   if(method==='POST'){
    if(b.confirmed!==true||!['PAUSE','BACKGROUND_CURRENT_WORK'].includes(String(b.choice)))throw new UiError('CONFIRM_REQUIRED','请确认演示选择。');
    this.lifecycle={...this.lifecycle,state:b.choice==='PAUSE'?'PAUSED':'RUNNING',lastChoice:b.choice as 'PAUSE'|'BACKGROUND_CURRENT_WORK',changedAt:now()};
   }value=this.lifecycle;
  }else if(path==='/user-plans'&&method==='POST'||s&&action==='user-plan'&&method==='POST'){
   const doc=b.document as {schema?:string;name?:string;mode?:string;plan?:ProjectPlan}|undefined;
   if(!doc||doc.schema!=='dream-maker.user-plan.v1'||doc.mode!=='demo'||typeof doc.name!=='string'||!doc.name.trim()||doc.name.length>120||!this.validPlan(doc.plan))throw new UiError('USER_PLAN_FORMAT_INVALID','请提供完整的演示方案。');
   if(s&&(!s.runs.every(r=>this.concluded.has(r.id))||b.version!==s.project.version||b.parentId!==s.spec?.id))throw new UiError('STALE_PLAN_PARENT','先结束当前轮次，再修订方案。');
   const target=s??this.create(doc.name,doc.plan.goal);target.project.planner1Mode='USER';target.project.name=doc.name;target.project.idea=doc.plan.goal;this.finish(target,reviewNotice);target.spec!.projectPlan=clone(doc.plan);target.spec!.projectPlan.inputBinding={inputHash:'UI_REVIEW_NOT_EVIDENCE',interviewRevision:0,projectRevision:target.project.version};
   target.spec!.requirements=doc.plan.requirements.map(r=>({id:r.id,text:r.text,origin:r.origin==='ASSUMPTION'?'DESIGN_ASSUMPTION':r.origin,priority:'must',sourceAnswerIds:[]}));
   target.spec!.acceptance=doc.plan.acceptance.map(a=>a.check);target.spec!.assumptions=clone(doc.plan.assumptions);target.spec!.outOfScope=clone(doc.plan.outOfScope);target.spec!.masterPrompt=reviewNotice+'\n\n'+JSON.stringify(doc.plan,null,2);
   const rows=this.history.get(target.project.id)!;rows[rows.length-1].snapshot=clone(target.spec!);this.decorate(target);this.notify(target,'USER_PLAN');value=target;
  }else if(s&&action==='plans'&&method==='GET'){
   const after=Number(url.searchParams.get('afterRevision')??0),rows=(this.history.get(pid)??[]).filter(r=>r.revision>after);value={plans:rows.slice(0,50),nextRevision:rows.length>50?rows[49].revision:null};
  }else if(s&&action==='research'&&method==='GET')value={operations:[{id:'review-research',projectId:pid,status:'COMPLETED',requestCount:0,at:now(),result:{status:'UNAVAILABLE',results:[],snapshots:[],failures:[]}}],reviewCandidates:[{name:'任务整理工具示例',description:'虚构候选，用于查看页面。没有仓库或许可结论。',fit:'示例：具备列表和筛选，接近项目目标。',changes:'示例：改成中文操作，增加本地保存和导出。',limits:'固定来源、许可、依赖、安全和运行条件都尚未连接。'}]};
  else if(s&&action==='plan-document'&&method==='GET')value=this.planDocument(s);
  else if(s&&action==='alternative'&&method==='POST'){
   if(!s.runs[0]||!this.concluded.has(s.runs[0].id))throw new UiError('FLOW_NOT_CONCLUDED','先正式结束当前轮次。');
   s.project.interviewMode='ALTERNATIVE';s.project.batchSize=5;s.project.batchTarget=s.project.answers.filter(a=>a.status==='answered').length+5;s.project.state='INTERVIEWING';s.project.version++;if(s.spec)s.spec.stale=true;this.next(s.project);this.notify(s,'ALTERNATIVE');value=s;
  }else if(parts[0]==='runs'&&parts[2]==='report'){
   const target=[...this.data.values()].find(item=>item.runs.some(r=>r.id===parts[1]));if(!target)throw new UiError('RUN_NOT_FOUND','');value=this.report(target);
  }else if(parts[0]==='runs'&&parts[2]==='conclude'&&method==='POST'){
   const target=[...this.data.values()].find(item=>item.runs[0]?.id===parts[1]);if(!target||b.reportHash!=='UI_REVIEW_REPORT_'+parts[1]||!['HANDLE','HELP','ALTERNATIVE','SAVE'].includes(String(b.choice)))throw new UiError('FLOW_REPORT_REQUIRED','');this.concluded.add(parts[1]);this.notify(target,'CONCLUDED');value=target;
  }else{
   if(s&&action==='answer'&&Array.isArray(b.optionIds)&&!String(b.text??'').trim()){const q=s.project.questions.find(q=>q.id===b.questionId);b.text=q?.options?.filter(o=>(b.optionIds as unknown[]).includes(o.id)).map(o=>o.label).join('；')??'';}
   value=await super.request(path,method,b);
   if(s&&action==='approve'){const row=this.history.get(pid)?.at(-1);if(row)row.approval={actor:'UI_REVIEW_SIMULATED_USER',at:now()};}
   if(s)this.decorate(s);this.persist();
  }
  return clone(value) as T;
 }
 private validPlan(value:unknown):value is ProjectPlan{
  if(!value||typeof value!=='object'||JSON.stringify(value).length>100000)return false;
  const p=value as ProjectPlan;const text=(v:unknown)=>typeof v==='string',list=(v:unknown)=>Array.isArray(v)&&v.length<=100&&v.every(text);
  return text(p.goal)&&!!p.goal.trim()&&Array.isArray(p.requirements)&&p.requirements.every(r=>text(r.id)&&text(r.text)&&list(r.sources))&&Array.isArray(p.acceptance)&&p.acceptance.every(a=>text(a.check)&&list(a.requirementIds))&&!!p.architecture&&text(p.architecture.summary)&&text(p.architecture.runtime)&&list(p.architecture.components)&&!!p.dataModel&&list(p.dataModel.entities)&&text(p.dataModel.persistence)&&!!p.interfaces&&list(p.interfaces.userFlows)&&list(p.interfaces.boundaries)&&Array.isArray(p.tasks)&&p.tasks.every(t=>text(t.id)&&text(t.title)&&list(t.dependsOn)&&list(t.requirementIds)&&text(t.check))&&!!p.delivery&&text(p.delivery.howToUse)&&typeof p.delivery.standalone==='boolean'&&typeof p.delivery.needsInternet==='boolean'&&list(p.delivery.ongoingFees)&&!!p.resources&&list(p.resources.accounts)&&list(p.resources.hardware)&&list(p.resources.network)&&list(p.resources.ongoingCosts)&&[p.risks,p.milestones,p.assumptions,p.unknowns,p.outOfScope].every(list)&&!!p.research&&p.research.status==='USER_IMPORTED_PLAN'&&Array.isArray(p.research.sourceRefs)&&p.research.sourceRefs.length===0&&!!p.reuse&&p.reuse.mode==='IMPLEMENT_ORIGINAL'&&Array.isArray(p.reuse.selected)&&p.reuse.selected.length===0;
 }
 private report(s:Snapshot){return {reportHash:'UI_REVIEW_REPORT_'+s.runs[0].id,evidenceClass:'UI_FRONTEND_REVIEW_SYNTHETIC',technicalRequirementsMet:false,userAccepted:false,verifiedCount:0,remainingCount:3,summary:{title:'本轮报告 · 前端演示',planLabel:'演示方案 v'+s.spec?.revision,completedLabel:'已保存界面示例与方案草稿',remainingLabel:'真实制作、测试和审查尚未运行',blockers:[{title:'真实工程角色尚未连接',explanation:'这份内容由界面演示提供，不是模型审查结论。',impact:'不能据此宣布业务完成。'}],nextLabel:'可以体验查看成果、处理问题或换一种办法。'}};}
}
