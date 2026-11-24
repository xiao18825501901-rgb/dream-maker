import type { UiAdapter, Snapshot, PublicConfig, ConnectionState, BrowserConfig } from './contracts.js';
import { UiError, newId } from './contracts.js';
import type { Project, Spec, Run, Event as RunEvent } from '../shared/types.js';
const stamp = () => new Date().toISOString();
const clone = <T>(v:T):T => JSON.parse(JSON.stringify(v)) as T;
const QUESTIONS = [
 ['目标用户','谁会使用这个项目？','例如：想把课程任务安排清楚的大学生。'],
 ['核心用途','它最需要帮你解决哪一件事？','先选一个最重要的问题，其他功能可以以后再做。'],
 ['第一步','用户打开项目后，第一步应该做什么？','例如：直接添加今天的一项任务。'],
 ['运行平台','你希望主要在哪种设备上使用？','例如：电脑浏览器优先，同时能在手机上查看。'],
 ['输入内容','用户需要提供哪些信息？','例如：任务名称、课程名称与截止日期。'],
 ['成功标准','什么结果会让你觉得第一版已经有用？','请用可观察的行为描述，而不是“很好用”。'],
 ['数据保存','关闭页面后，哪些内容需要保留？','例如：任务状态与截止日期，不需要同步账户。'],
 ['边界情况','你最不希望出现哪种错误？','例如：刷新后刚输入的任务丢失。'],
 ['明确取舍','有哪些功能这次可以先不做？','例如：协作、自动日历同步和复杂统计。'],
 ['验收办法','你会怎样亲自检查它能正常使用？','例如：添加、完成、刷新、删除一条任务。'],
 ['布局偏好','哪些信息需要始终看得见？','例如：当前任务与下一步，不必同时展示全部日志。'],
 ['空状态','没有内容时，希望页面怎样引导你？','例如：给一个可编辑的例子。'],
 ['撤销修改','哪些操作需要确认或撤销？','例如：删除任务前确认。'],
 ['可访问性','是否有键盘操作或文字大小的偏好？','例如：主要操作可用 Tab 到达。'],
 ['错误恢复','失败时希望保留什么？','例如：草稿和已提交的内容。'],
 ['成果形式','你希望怎样拿到最终成果？','例如：源码与清楚的运行说明。'],
 ['使用频率','通常一次会处理多少条内容？','例如：每天十条以内。'],
 ['隐私范围','哪些信息不应该离开设备？','这里是 UI 演示；请勿输入真实凭据与个人敏感内容。'],
 ['版本迭代','第一版之后最希望增加什么？','将扩展想法和本期必需功能分开。'],
 ['最后核对','还有哪条原始要求不能遗漏？','用自己的话补充；不确定可以跳过。']
];
function config(): PublicConfig {
 const c:BrowserConfig = {version:1,planner1:{authMode:'api_key',siwcModel:'',siwcProfileId:'',siwcNoncommercialAttested:false,protocol:'openai-responses',baseUrl:'',model:'未连接',keyEnv:'',maxOutputTokens:4096,maxCallsPerProject:50},codex:{command:'',args:[],home:'',model:'未连接'},dsh:{modulePath:'',model:'DeepSeek V4.1 Flash（目标，未连接）',keyEnv:''},nativeAuditPath:'',clash:{enabled:false,selector:'',node:'',selectionPolicy:'current',expectedMode:'rule'},laya:{mode:'off',roles:{planner1:'inherit',planner2:'inherit',executor:'inherit',reviewer:'inherit'},baseUrl:'',portFile:'',timeoutMs:2000,maxQueue:4,expectedRevision:'',requireTruncationMetadata:true},limits:{maxRepairs:3,maxCalls:20,maxSeconds:600,stepTimeoutMs:60000,idleTimeoutMs:120000}};
 return {config:c,keyStatus:{planner1:false,executor:false},nativeStatus:'UI_DEMO_NOT_CONNECTED'};
}
/** Explicit synthetic interaction model. Does NOT call /api, localhost, Laya, an agent, or a paid provider. */
export class DemoScenarioAdapter implements UiAdapter {
 readonly mode = 'public-demo' as const;
 protected data = new Map<string,Snapshot>();
 private seq=0;
 private listeners = new Set<{pid:string; fn:(e:RunEvent)=>void}>();
 protected settings=config();
 protected readonly storageKey:string='dream-maker.ui-demo.v2';
 async init():Promise<void> {
  try { const saved=JSON.parse(sessionStorage.getItem(this.storageKey)||'null');
   if(saved?.version===2 && Array.isArray(saved.projects) && saved.projects.length<=30){
    for(const s of saved.projects) if(s?.project?.mode==='demo' && typeof s.project.id==='string' && Array.isArray(s.project.questions) && Array.isArray(s.project.answers) && Array.isArray(s.runs)) this.data.set(s.project.id,s);
   }
  } catch { /* Disabled storage uses in-memory state. */ }
  if(this.data.size) {this.seq=Math.max(0,...[...this.data.values()].flatMap(s=>s.records.map(r=>Number(r.id.replace('record-',''))||0)));return;}
  const a=this.create('课程任务板','把分散的课程任务集中起来，让我每天知道先做什么。','sample-clarify');
  for(let i=0;i<2;i++){this.next(a.project); this.answer(a,{questionId:a.project.questions[i].id,text:['大学生，尤其是同时学习多门课程的人。','快速看清本周需要完成的任务。'][i],version:a.project.version});}
  this.next(a.project);
  const b=this.create('专注计时器','一个不打扰的番茄钟，支持工作与休息切换。','sample-spec'); this.finish(b,'第一版不做账户同步。');
  const c=this.create('灵感收集盒','把一闪而过的点子保存成可以继续完善的项目。','sample-review');this.finish(c,'本项目为合成的审查场景，不是真实生成物。');c.project.state='READY_TO_BUILD';this.makeRun(c,true);this.setScenario(c,'REPAIRING');this.persist();
 }
 protected create(name:string,idea:string,id='demo-'+newId()):Snapshot {
  const p:Project={id,name,idea,mode:'demo',version:1,state:'INTERVIEWING',createdAt:stamp(),updatedAt:stamp(),questions:[],answers:[],answerHistory:[],batchTarget:10,specId:null,activeRunId:null,warnings:['UI_DEMO_SYNTHETIC：数据、问题、计划和验证均为演示，不代表真实 Agent。']};
  const s:Snapshot={project:p,spec:null,runs:[],records:[]};this.data.set(id,s);return s;
 }
 protected next(p:Project):void {
  if(p.state!=='INTERVIEWING') throw new UiError('INTERVIEW_WAITING','先选择结束或继续，不能自动问下一题。',409);
  if(p.questions.some(q=>!p.answers.some(a=>a.questionId===q.id)))return;
  const n=p.questions.length, template=QUESTIONS[n%QUESTIONS.length];
  p.questions.push({id:p.id+'-q'+(n+1),topic:template[0],text:template[1],suggestion:template[2],source:'DEMO_RULES',prerequisites:n ? [p.questions[n-1].id] : [],createdAt:stamp()});p.version++;
 }
 private answer(s:Snapshot,body:Record<string,unknown>):void {
  const p=s.project;
  if(body.version!==p.version) throw new UiError('VERSION_CONFLICT','项目已变化，请刷新后核对回答。',409);
  if(!p.questions.some(q=>q.id===body.questionId))throw new UiError('QUESTION_NOT_FOUND','问题不存在。',404);
  const text=String(body.text??'').trim();if(!body.skip && !text)throw new UiError('ANSWER_REQUIRED','请写下回答，或选择暂时跳过。',400);
  const old=p.answers.find(a=>a.questionId===body.questionId);
  if(old){p.answerHistory.push(clone(old));old.text=text;old.status=body.skip ? 'skipped' : 'answered';old.revision++;}
  else p.answers.push({id:p.id+'-a'+(p.answers.length+1),questionId:String(body.questionId),text,status:body.skip?'skipped':'answered',revision:1,createdAt:stamp()});
  p.version++;if(s.spec)s.spec.stale=true;
  p.state=p.answers.filter(a=>a.status==='answered').length>=p.batchTarget ? 'AWAITING_INTERVIEW_DECISION':'INTERVIEWING';
 }
 protected finish(s:Snapshot,notes:string):void {
  const p=s.project, rev=(s.spec?.revision||0)+1;
  const requirements:Spec['requirements']=[{id:'REQ-001',text:p.idea,sourceAnswerIds:[],origin:'USER',priority:'must'},...p.answers.filter(a=>a.status==='answered').map((a,i)=>({id:'REQ-'+String(i+2).padStart(3,'0'),text:a.text,sourceAnswerIds:[a.id],origin:'USER' as const,priority:'must' as const}))];
  const s0:Spec={id:p.id+'-spec-'+rev,projectId:p.id,revision:rev,projectVersion:p.version,hash:'d'.repeat(48)+rev.toString(16).padStart(16,'0'),brief:p.idea,requirements,constraints:['这是浏览器内 UI 演示，不调用任何真实 Agent。'],assumptions:['演示默认：本地单用户，第一版只验证交互。'],outOfScope:['本演示不提供真实代码生成、云端部署或模型连接。'],acceptance:['演示访谈的十题门槛可操作。','确认规格与批准构建分别完成。','成果明确标记为固定样例。'],conflicts:[],notes,masterPrompt:'',createdAt:stamp(),stale:false,skillMode:'SOURCE_ADAPTED'};
  s0.masterPrompt=`# UI 演示任务包（非真实工程指令）\n\n## 原始想法\n${p.idea}\n\n## 要求\n${requirements.map(r=>r.id+': '+r.text).join('\n')}\n\n## 补充说明\n${notes}\n\n## 边界\n${s0.constraints.join('\n')}\n\n规格标识为合成数据，不是源码验收哈希。`;
  s.spec=s0;p.specId=s0.id;p.state='SPEC_REVIEW';p.version++;
 }
 private makeRun(s:Snapshot,fault:boolean):void {
  if(!s.spec||s.spec.stale||s.project.state!=='READY_TO_BUILD')throw new UiError('SPEC_APPROVAL_REQUIRED','请先确认当前规格，再单独批准构建。',409);
  const r:Run={id:'demo-run-'+newId(),projectId:s.project.id,mode:'demo',version:1,specId:s.spec.id,specHash:s.spec.hash,configFingerprint:'UI_DEMO_SYNTHETIC',state:'PLANNING',phase:'PLANNING',repairCount:0,maxRepairs:3,calls:0,maxCalls:20,createdAt:stamp(),updatedAt:stamp(),workspace:'演示虚拟工作区（非本机路径）',treeHash:null,tasks:[{id:'task-1',title:'整理交互和数据边界',dependsOn:[],requirementIds:['REQ-001'],acceptance:['合成计划，仅供界面展示'],status:'pending'},{id:'task-2',title:'制作固定学习任务板样例',dependsOn:['task-1'],requirementIds:['REQ-001'],acceptance:['不是根据灵感生成的项目'],status:'pending'},{id:'task-3',title:'验证场景与审查反馈',dependsOn:['task-2'],requirementIds:['REQ-001'],acceptance:['演示状态，不是运行过的测试'],status:'pending'}],findings:[],plan:{source:'UI_DEMO_SYNTHETIC'},verification:null,review:null,artifacts:[],reason:null,failedFingerprints:[],attempt:1,demoFault:fault,maxSeconds:600,usage:[],sessions:{}};
  s.runs.unshift(r);s.project.activeRunId=r.id;
 }
 protected setScenario(s:Snapshot,state:string):void {
  const r=s.runs[0];if(!r)throw new UiError('RUN_REQUIRED','先在演示中批准构建。');
  const allowed=['PLANNING','IMPLEMENTING','VERIFYING','REVIEWING','REPAIRING','READY_FOR_DELIVERY','ACCEPTED','PAUSE_REQUESTED','PAUSED','CANCEL_REQUESTED','CANCELLED','BLOCKED','FAILED','PARTIAL'];
  if(!allowed.includes(state))throw new UiError('INVALID_SCENARIO','未知演示场景。');
  r.state=state as Run['state'];r.version++;r.updatedAt=stamp();
  if(['PLANNING','IMPLEMENTING','VERIFYING','REVIEWING','REPAIRING','READY_FOR_DELIVERY'].includes(state))r.phase=state as Run['phase'];
  r.reason=['BLOCKED','FAILED','PARTIAL'].includes(state)?'合成场景：模拟验证失败或依赖不可用。未运行真实工具。':null;
  r.tasks.forEach((t,i)=>t.status=state==='PLANNING'?'pending':state==='IMPLEMENTING'?(i===0?'implemented':i===1?'running':'pending'):'implemented');
  if(state==='REPAIRING') {r.findings=[{id:'demo-finding-1',severity:'high',description:'合成缺陷：刷新后任务状态未保留。',evidence:'演示位置：sample.js / 保存逻辑；这不是实测发现。',status:'open'}];r.repairCount=1;}
  if(['READY_FOR_DELIVERY','ACCEPTED'].includes(state)){
   r.tasks.forEach(t=>t.status='done');r.findings.forEach(f=>f.status='resolved');r.treeHash='UI_DEMO_SYNTHETIC_NOT_A_SOURCE_HASH';r.artifacts=['README.md','sample.html'];
   r.verification={ok:true,exitCode:null,command:[],stdout:'UI_DEMO_SYNTHETIC：演示已完成态，没有执行测试命令。',stderr:'',treeHash:r.treeHash,at:stamp(),evidenceId:'synthetic-evidence'};
   r.review={verdict:'PASS',findings:r.findings,source:'DEMO_RULES',treeHash:r.treeHash};
  }
 }
 protected persist():void { try{sessionStorage.setItem(this.storageKey,JSON.stringify({version:2,projects:[...this.data.values()]}));}catch{/* Memory mode remains functional. */} }
 protected notify(s:Snapshot,type:string):void {
  s.project.updatedAt=stamp();
  const e:RunEvent={id:++this.seq,projectId:s.project.id,runId:s.runs[0]?.id??null,type:'UI_DEMO_'+type,payload:{source:'UI_DEMO_SYNTHETIC',state:s.runs[0]?.state??s.project.state},at:stamp()};
  s.records.push({id:'record-'+this.seq,kind:'UiDemoEvent',runId:e.runId,data:e.payload,at:e.at});
  s.records=s.records.slice(-300);this.persist();
  for(const l of this.listeners)if(l.pid===s.project.id)l.fn(clone(e));
 }
 async request<T>(path:string,method='GET',body:unknown={}):Promise<T> {
  const b=(body||{}) as Record<string,unknown>;let result:unknown;
  if(path==='/config'){
   if(method==='PUT')throw new UiError('DEMO_SETTINGS_READONLY','公开演示不保存真实模型配置，也不接收凭据。'); result=this.settings;
  }else if(path==='/diagnostics')result={mode:'UI_DEMO_SYNTHETIC',networkCalls:0,native:'NOT_CONNECTED',laya:'OFF',usage:'UNKNOWN',note:'此项是演示边界说明，不是本机诊断结果。'};
  else if(path.startsWith('/diagnostics/'))throw new UiError('DEMO_NO_CONNECTION','公开演示不探测账户或本机。请在本地集成版完成诊断。');
  else if(path==='/projects'){
   if(method==='POST'){
    if(b.mode!=='demo')throw new UiError('DEMO_ONLY','公开构建不支持 Live。');
    const name=String(b.name||'').trim(),idea=String(b.idea||'').trim();if(!name||!idea)throw new UiError('INPUT_REQUIRED','请填写项目名称与灵感。');
    if(name.length>120||idea.length>12000||this.data.size>=30)throw new UiError('DEMO_LIMIT','演示内容已达到本页限制。请简化输入。');
    result=this.create(name,idea);this.persist();
   }else result={projects:[...this.data.values()].map(s=>s.project).reverse()};
  }else{
   const route=path.match(/^\/projects\/([^/]+)(?:\/(\w+))?$/),runRoute=path.match(/^\/runs\/([^/]+)\/(\w+)(?:\?(.*))?$/);
   if(route){const s=this.data.get(decodeURIComponent(route[1]));if(!s)throw new UiError('PROJECT_NOT_FOUND','演示项目不存在。',404);
    const action=route[2];
    if(action&&method!=='POST')throw new UiError('METHOD_DENIED','写操作需要明确提交。',405);
    if(action==='next')this.next(s.project);
    else if(action==='answer')this.answer(s,b);
    else if(action==='continue'){if(s.project.state!=='AWAITING_INTERVIEW_DECISION')throw new UiError('NOT_AT_GATE','当前不在十题节点。',409);s.project.batchTarget+=10;s.project.state='INTERVIEWING';s.project.version++;this.next(s.project);}
    else if(action==='finish')this.finish(s,String(b.notes||''));
    else if(action==='approve'){if(!s.spec||s.spec.stale||b.specHash!==s.spec.hash)throw new UiError('SPEC_CHANGED','规格已变更，请重新整理。',409);s.project.state='READY_TO_BUILD';}
    else if(action==='build'){if(b.approved!==true)throw new UiError('BUILD_APPROVAL_REQUIRED','请单独批准构建。',403);if(b.specHash!==s.spec?.hash)throw new UiError('SPEC_CHANGED','规格已变化。',409);this.makeRun(s,b.demoFault===true);}
    else if(action)throw new UiError('NOT_SUPPORTED','演示未支持此操作。',404);
    if(action)this.notify(s,action.toUpperCase());result=s;
   }else if(runRoute){
    const s=[...this.data.values()].find(s=>s.runs.some(r=>r.id===runRoute[1]));if(!s)throw new UiError('RUN_NOT_FOUND','演示运行不存在。',404);const r=s.runs.find(r=>r.id===runRoute[1])!,action=runRoute[2];
    if(r.id!==s.runs[0].id&&['pause','resume','cancel','accept'].includes(action))throw new UiError('STALE_RUN','此演示运行不是当前运行。',409);
    if(['pause','resume','cancel','accept'].includes(action)&&method!=='POST')throw new UiError('METHOD_DENIED','控制操作需要明确提交。',405);
    if(action==='pause'){if(!['PLANNING','IMPLEMENTING','VERIFYING','REVIEWING','REPAIRING'].includes(r.state))throw new UiError('INVALID_STATE','此状态不能暂停。',409);this.setScenario(s,'PAUSE_REQUESTED');}
    else if(action==='resume'){if(r.state!=='PAUSED')throw new UiError('INVALID_STATE','运行尚未暂停。',409);this.setScenario(s,r.phase);}
    else if(action==='cancel'){if(['READY_FOR_DELIVERY','ACCEPTED','CANCELLED'].includes(r.state))throw new UiError('INVALID_STATE','此状态不可取消。',409);this.setScenario(s,'CANCEL_REQUESTED');}
    else if(action==='accept'){if(r.state!=='READY_FOR_DELIVERY')throw new UiError('NOT_READY','尚未到达待验收状态。',409);this.setScenario(s,'ACCEPTED');}
    else if(action==='preview'){if(!['READY_FOR_DELIVERY','ACCEPTED'].includes(r.state))throw new UiError('NOT_READY','固定样例尚未就绪。',409);return {url:'./sample.html',scope:'UI_DEMO_FIXED_SAMPLE'} as T;}
    else if(action==='files'){const name=new URLSearchParams(runRoute[3]||'').get('path');return (name?{path:name,content:name==='README.md'?'# 固定 UI 样例\n\n本文件不是由 Agent 按灵感生成的项目。页面中所有计划、检查与结果都是合成演示数据。':'<!-- UI_DEMO_SYNTHETIC: fixed study-board preview, not generated code. -->\n<main><h1>学习任务板 · 固定演示</h1></main>'}:{files:[{path:'README.md',bytes:162},{path:'sample.html',bytes:150}]}) as T;}
    else throw new UiError('NOT_SUPPORTED','演示不支持该操作。',404);
    this.notify(s,action.toUpperCase());result=s;
   }else throw new UiError('NOT_SUPPORTED','演示没有该接口，也不会改向本机请求。',404);
  }
  return clone(result) as T;
 }
 subscribe(pid:string,fn:(e:RunEvent)=>void,onState:(s:ConnectionState)=>void):()=>void {const l={pid,fn};this.listeners.add(l);onState('connected');return()=>{this.listeners.delete(l);onState('closed');};}
 async advanceScenario(pid:string):Promise<Snapshot>{
  const s=this.data.get(pid);if(!s||!s.runs[0])throw new UiError('RUN_REQUIRED','请先批准演示构建。');const r=s.runs[0];
  let next: string;
  if(r.state==='PAUSE_REQUESTED')next='PAUSED';else if(r.state==='CANCEL_REQUESTED')next='CANCELLED';
  else if(r.state==='PLANNING')next='IMPLEMENTING';else if(r.state==='IMPLEMENTING')next='VERIFYING';
  else if(r.state==='VERIFYING')next=r.demoFault && !r.repairCount?'REPAIRING':'REVIEWING';
  else if(r.state==='REPAIRING'){r.findings.forEach(f=>f.status='resolved');r.repairCount=Math.max(1,r.repairCount);next='VERIFYING';}
  else if(r.state==='REVIEWING')next='READY_FOR_DELIVERY';else throw new UiError('SCENARIO_STOPPED','当前场景需要你的操作，不能继续自动推进。');
  this.setScenario(s,next);this.notify(s,'STEP');return clone(s);
 }
 async selectScenario(pid:string,state:string):Promise<Snapshot>{const s=this.data.get(pid);if(!s)throw new UiError('PROJECT_NOT_FOUND','演示项目不存在。');this.setScenario(s,state);this.notify(s,'SCENARIO_SELECTED');return clone(s);}
 async exportRun(id:string):Promise<{blob:Blob;filename:string}>{const s=[...this.data.values()].find(s=>s.runs.some(r=>r.id===id));if(!s||!['READY_FOR_DELIVERY','ACCEPTED'].includes(s.runs.find(r=>r.id===id)!.state))throw new UiError('NOT_READY','演示记录尚未就绪。');return{blob:new Blob([JSON.stringify({notice:'UI_DEMO_SYNTHETIC. NOT an AI-generated project. NOT live verification.',snapshot:s},null,2)],{type:'application/json'}),filename:'dream-maker-UI-DEMO-records.json'};}
 dispose():void{this.listeners.clear();}
}
