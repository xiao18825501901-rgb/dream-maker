import type {ExecutorRoleIdentity,Task} from '../shared/types.js';
import type {ViewState} from './views.js';
import {escapeHtml as e,label} from './contracts.js';
import {sourceTaskLabel,mergeRecoveryNotice} from './merge-recovery-view.js';
import type {DispatchWaitObservation} from '../shared/dispatch-status.js';
export interface DispatchView {
 executorSlots:number;
 active:{projectId:string;runId:string;kind:string;dispatchId?:string}[];
 queued:{projectId:string;runId:string;kind:string;dispatchId?:string;wait?:DispatchWaitObservation}[];
 quarantined:{projectId:string;runId:string;kind:string;dispatchId?:string}[];
}
export interface LayaSummaryView {turns?:number;receivedAdviceTurns?:number;influencedTurns?:number;fullyOff?:boolean;reason?:string;byRole?:Record<string,unknown>}
const state=(value:string,runState?:string)=>value==='running'&&['BLOCKED','CANCELLED','FAILED','PARTIAL'].includes(runState??'')?sourceTaskLabel(value,runState):({pending:'等待前置任务',running:'正在处理',implemented:'已制作，等待检查',done:'任务标记完成'}[value]??'状态尚未核验');
function dependencyList(tasks:Task[],runState?:string):string{
 const byId=new Map(tasks.map(task=>[task.id,task]));
 return `<ol class="dependency-list">${tasks.map((task,index)=>`<li data-key="task-${e(task.id)}"><span class="task-index" aria-hidden="true">${index+1}</span><div><h3>${e(task.title)}</h3><span class="pill">${state(task.status,runState)}</span><p>${task.dependsOn.length?'先完成：'+task.dependsOn.map(id=>e(byId.get(id)?.title??'尚未匹配的任务')).join('、'):'没有前置任务，可以先安排'}</p><details><summary>查看检查办法与任务标识</summary><p>任务：${e(task.id)}</p><ul>${task.acceptance.map(text=>`<li>${e(text)}</li>`).join('')}</ul></details></div></li>`).join('')}</ol>`;
}
function executorEvidence(roles:ExecutorRoleIdentity[]|undefined,tasks:Task[],runState?:string):string {
    if(!Array.isArray(roles)||!roles.length)return '';
    const byId=new Map(tasks.map(task=>[task.id,task])),shown=roles.slice(0,32);
    const tone=['READY_FOR_DELIVERY','ACCEPTED'].includes(runState??'')?'已完成独立记录':'已保留完成记录';
    return `<div class="executor-grid" aria-label="本轮执行器记录">${shown.map((role,index)=>{const details=[role.runner,role.authentication].filter(value=>typeof value==='string'&&value).map(value=>e(value)).join(' · ')||'运行身份已保存';return `<article class="role-status"><h3>执行器 ${index+1}</h3><span class="pill">${tone}</span><p>${e(role.taskId&&byId.get(role.taskId)?.title||'已领取制作任务')}</p><p>${e(role.model)} · ${e(role.provider)}</p><small>${details}</small></article>`;}).join('')}</div>${roles.length>shown.length?`<p class="hint">另有 ${roles.length-shown.length} 个执行器记录已保留；本页只展开前 ${shown.length} 个。</p>`:''}`;
}
function waitNotice(rows:DispatchView['queued'],synthetic:boolean):string {
 if(!rows.length)return '';
 const roles:Record<string,string>={planner2:'工程规划',executor:'制作任务',reviewer:'独立审查',verifier:'成果检查',route:'连接准备','data-runtime':'数据处理'};
 const gib=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=16*1024*1024?(value/1024).toFixed(1)+' GB':null;
 const checked=Date.now();let needsVerification=false;
 const items=rows.slice(0,6).map(row=>{
  const w=row.wait,role=roles[row.kind]??'待安排任务';let text='正在确认排队原因，请刷新工作台查看。';
  if(w?.scope==='RESOURCE_OBSERVATION_ONLY'){
   const time=Date.parse(w.sampledAt),fresh=Number.isFinite(time)&&checked-time>=-5000&&checked-time<=15000;
   if(!fresh){needsVerification=true;text='上次检测已过期，请刷新后重新确认排队原因。';}
   else{
    const available=gib(w.availableMemoryMiB),gap=gib(w.estimatedMemoryGapMiB);
    if(w.reason==='MEMORY')text='等待更多内存。'+(available?'检测时可用内存 '+available+'。':'')+(gap?'按当时预留估算，还差约 '+gap+'；资源变化后会重新计算。':'正在重新估算所需内存。');
    else if(w.reason==='CAPACITY')text='其他任务正在使用运行资源，请等待原队列安排。';
    else if(w.reason==='CONFLICT')text='等待另一个任务完成，避免同时修改相同内容。';
    else if(w.reason==='DEPENDENCIES')text='等待前置任务完成。';
    else if(w.reason==='CURRENT_FLOW'){needsVerification=true;text='正在核对当前方案和轮次，请查看本轮可执行操作。';}
    else if(w.reason==='CLEANUP'){needsVerification=true;text='上一次进程清理仍待核验，当前任务不会开始。';}
    else if(w.reason==='RESOURCE_RECHECK')text='正在重新检测可用运行资源。'+(available?'检测时可用内存 '+available+'。':'');
    else needsVerification=true;
   }
  }else needsVerification=true;
  return `<li><strong>${e(role)}</strong>：${e(text)}</li>`;
 });
 return `<section class="notice warning" role="status" aria-live="polite" aria-atomic="true" data-key="flow-resource-wait"><h3>本轮正在等待运行条件</h3>${synthetic?'<p>演示排队 · 合成资源条件，没有调用真实角色。</p>':''}<ul>${items.join('')}</ul>${rows.length>6?'<p>其他排队任务也已保留，可刷新工作台查看最新进度。</p>':''}<p>${needsVerification?'请先刷新或在本轮操作中核对条件；不会忽略未确认的问题。':'条件满足后原队列会继续，无需重复提交。'}排队信息不代表账号、模型或成果已经通过验收。</p></section>`;
}
export function flowWorkspace(v:ViewState):string{
 const snapshot=v.snapshot!,latest=snapshot.runs[0],run=latest?.specId===snapshot.project.specId&&!snapshot.spec?.stale?latest:undefined,planned=snapshot.spec?.projectPlan?.tasks??[],tasks:Task[]=run?.tasks??planned.map(task=>({...task,acceptance:[task.check],status:'pending'}));
 const dispatch=v.dispatch,active=dispatch?.active.filter(row=>row.projectId===snapshot.project.id&&row.runId===run?.id)??[],queued=dispatch?.queued.filter(row=>row.projectId===snapshot.project.id&&row.runId===run?.id)??[];
 const slots=dispatch&&Number.isInteger(dispatch.executorSlots)&&dispatch.executorSlots>=0?dispatch.executorSlots:null;
 const waiting=run&&['PLANNING','IMPLEMENTING','VERIFYING','REVIEWING','REPAIRING'].includes(run.state)?waitNotice(queued,v.mode==='public-demo'||v.presentation==='frontend-review'):'';
 const actualExecutors=executorEvidence(run?.executorRoleIdentities,tasks,run?.state);
 const preworkProblem=run?.reason?.startsWith('PREWORK_')===true;
 const preworkSummary=`<details class="notice${preworkProblem?' warning':''}" data-key="prework-summary"${preworkProblem?' open':''}><summary>开始前检查</summary><p>${preworkProblem?'有些交接条件目前无法确认，本轮不会安排新的制作。请核对方案、任务范围与检查办法。':run?.prework?'已保存本轮交接计划：这次要完成哪些内容、允许修改哪些文件，以及每项工作怎样证明完成。':'交接计划尚未保存。工程规划完成并通过检查后，才会安排制作；历史记录不会被补写成已通过。'}</p><p>交接计划不代表成果已经完成。仍需实际制作、成果检查和独立审查。</p><button type="button" data-action="tab" data-tab="help" class="secondary">查看使用帮助</button></details>`;
 const executors=actualExecutors||(slots!==null&&slots>0?`<div class="executor-grid" aria-label="执行器安排">${Array.from({length:Math.min(slots,16)},(_,i)=>`<article class="role-status"><h3>执行器 ${i+1}</h3><span class="pill">${v.mode==='public-demo'?'演示安排 · 未连接':'执行位 · 身份待逐项核验'}</span><p>从已满足依赖的任务中领取工作，写入范围须受控；不能覆盖其他执行器的修改。</p></article>`).join('')}</div>`:'');
 return `<section class="card"><div class="section-heading"><div><span class="eyebrow">分工清楚，进度可见</span><h2>DreamFlow 工作台</h2></div><button type="button" data-action="reload-panel" class="secondary">刷新工作台</button></div><p>${run?'本轮状态：'+e(label(run.state)):'还没有开始制作。下面是方案中的任务草案，确认方案后仍需单独批准制作。'}</p>${latest&&!run?'<p class="notice warning">已有历史轮次属于另一版方案；这里不把它显示为当前方案的进度。原报告和成果仍保留。</p>':''}
 <div class="flow-lanes"><section><span class="lane-step">01</span><h3>工程规划 · Planner</h3><p>把已确认的方案拆成有依赖关系的小任务。</p><span class="pill">${run?.state==='PLANNING'?'当前阶段':'职责说明'}</span></section><section><span class="lane-step">02</span><h3>执行器 · Executor</h3><p>按任务制作，保留源码与测试记录。</p><span class="pill">${slots===null?'容量尚未读取':slots+' 个执行器'+(v.mode==='public-demo'?' · 演示配置':' · 配置容量')}</span><p class="hint">${dispatch?active.filter(row=>row.kind==='executor').length+' 个当前执行任务；'+queued.filter(row=>row.kind==='executor').length+' 个排队任务。':'执行数量尚未读取；排队数量也保持未知。'}任务卡片数量不代表已连接多个运行器。</p></section><section><span class="lane-step">03</span><h3>审查 · Reviewer</h3><p>依据冻结方案、源码和原始测试记录检查成果。</p><span class="pill">${run?.state==='REVIEWING'?'当前阶段':'独立审查要求保留'}</span></section></div>
 ${preworkSummary}${waiting}${executors}${run?mergeRecoveryNotice(run,v.mode==='local'&&v.presentation!=='frontend-review'):''}${v.mode==='public-demo'?'<p class="notice warning">这是界面演示：分工、任务和状态均为合成内容，没有调用真实工程角色。</p>':''}
 <div class="actions"><button type="button" data-action="tab" data-tab="work">查看本轮可执行操作</button><button type="button" data-action="tab" data-tab="laya">了解可选的 Laya 辅助</button><button type="button" data-action="executor-info">如何增加执行器</button></div></section>
 <section class="card"><div class="section-heading"><h2>任务依赖</h2><span class="hint">先完成前置任务，再安排下一步</span></div>${tasks.length?dependencyList(tasks,run?.state):'<div class="empty"><h3>任务还没有拆分</h3><p>有了完整方案并开始本轮后，工程规划角色会安排任务。这里不会自行生成调度授权。</p></div>'}<p class="hint">“任务标记完成”仍需结合独立审查和本轮报告；不等于整个项目已经验收通过。</p></section>`;
}
export function layaPage(v:ViewState):string{
 const snapshot=v.snapshot,latest=snapshot?.runs[0],run=latest?.specId===snapshot?.project.specId&&!snapshot?.spec?.stale?latest:undefined,mode=v.settings?.config.laya.mode??'off',summary=run?v.layaSummary:undefined;
 const normal=run?.flowConfig?run.flowConfig.mode==='classic'&&!run.flowConfig.laya.enabled:run?.flowName==='dreamflow',enhanced=run?.flowConfig?run.flowConfig.mode==='classic'&&run.flowConfig.laya.enabled:run?.flowName==='dreamflow-laya';
 const effectiveMode=run?.flowConfig?.laya?.mode??mode;const modeText=effectiveMode==='off'?'本地 Laya 未启用。':effectiveMode==='shadow'?'当前配置为影子模式：只记录分类结果，不进入角色任务体；连接与实际参与仍需核验。':'当前配置为建议模式；连接和实际参与仍需核验。';const roleModeText=normal||effectiveMode==='off'?'未启用':effectiveMode==='shadow'?'影子记录 · 不进入角色任务':!enhanced?'本轮方式尚未核验':'辅助资格尚待核验';const selected=enhanced?'经典 DreamFlow · 已选择 Laya':normal?'经典 DreamFlow · 不使用 Laya':run?.flowConfig?.mode==='custom'||run?.flowName==='custom'?'完全自定义 · 不使用 Laya':run?'历史记录未保存工作方式':'本轮尚未开始';
 return `<section class="card"><span class="eyebrow">可选辅助，随时看得懂</span><h2>DreamFlow-Laya</h2><p>普通 DreamFlow 不需要安装 Laya，也能按原有条件制作。Laya 的建议不能批准方案、扩大权限或替代审查。</p><p class="notice">当前：${e(selected)}。${modeText}</p>
 <div class="comparison"><section><h3>普通 DreamFlow</h3><p>工程规划 → 执行器 → 独立审查。工程角色不使用 Laya。</p></section><section><h3>DreamFlow-Laya</h3><p>相同的制作流程，为三个工程角色提供受限建议；未就绪时不会假装启用成功。</p></section></div>
 <div class="laya-roles">${[['planner2','工程规划'],['executor','执行器'],['reviewer','独立审查']].map(([role,name])=>`<section class="role-status"><h3>${name}</h3><span class="pill">${roleModeText}</span><p>${summary?.byRole?.[role]?'本轮存在观测记录；建议是否采用与效果仍需分别核对。':'本轮没有可确认的角色辅助记录。'}</p></section>`).join('')}</div>
 ${summary?`<details><summary>查看本轮观测说明</summary><p>已记录角色回合：${e(summary.turns??'未知')}；收到建议：${e(summary.receivedAdviceTurns??'未知')}；建议送入已完成角色：${e(summary.influencedTurns??'未知')}。</p><p>这些数字不是效果对照，也不代表真实增强流程已经通过。</p></details>`:'<p class="hint">观测尚未连接。未安装或未运行时，这个入口仍保留。</p>'}
 <div class="actions"><button type="button" data-action="settings">查看 Laya 设置与准备方法</button><button type="button" data-action="tab" data-tab="spec">回到方案，选择本轮方式</button></div>${v.mode==='public-demo'?'<p class="notice warning">演示页面不会检测、安装或启动你的本地服务。</p>':''}</section>`;
}
