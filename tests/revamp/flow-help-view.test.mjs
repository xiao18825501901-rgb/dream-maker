import test from 'node:test';
import assert from 'node:assert/strict';
import { flowReportContent,helpPage } from '../../dist/web/flow-help-view.js';
import { flowWorkspace } from '../../dist/web/flow-workspace-view.js';
import { shell } from '../../dist/web/views.js';
import { harness,ready } from '../helpers.mjs';
test('plain report offers four bounded choices without treating technical completion as user acceptance',()=>{
 const html=flowReportContent({evidenceClass:'OFFLINE_DEMO_NOT_LIVE_AGENT',technicalRequirementsMet:true,userAccepted:false,verifiedCount:1,remainingCount:0,
 summary:{title:'本轮已达到约定的技术要求',planLabel:'本轮依据的方案 v1',completedLabel:'已经完成 1 项工作',remainingLabel:'还差 0 项工作',blockers:[],nextLabel:'查看成果，再决定是否接受'}});
 assert.match(html,/固定 Demo/);assert.match(html,/尚未接受/);
 for(const choice of ['HANDLE','HELP','ALTERNATIVE','SAVE'])assert.match(html,new RegExp('data-choice="'+choice+'"'));
 assert.doesNotMatch(html,/data-action="confirm-accept"|data-action="build"/);
});
test('help is an independent readable page; untrusted messages are encoded, with no install or login side effect',()=>{
 const html=helpPage({GENERAL:{title:'<img src=x>',what:'未确认',impact:'进度保留',steps:['查看报告'],alternative:'可以不处理'}});
 assert.match(html,/<h1>遇到问题，先保住进度。/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
 assert.match(html,/不会替你登录、购买/);assert.match(html,/data-action="settings"/);
});

test('report uses authoritative call accounting; missing or inconsistent totals are never guessed from records',()=>{
 const report={evidenceClass:'NATIVE',technicalRequirementsMet:false,userAccepted:false,verifiedCount:1,remainingCount:1,summary:{title:'本轮报告',planLabel:'方案 v1',completedLabel:'保留已有成果',remainingLabel:'等待复审',blockers:[],nextLabel:'查看'}};
 const usage={originalCalls:13,originalMaxCalls:13,supplementalReviewCalls:1,totalCalls:14};
 const render=v=>flowReportContent({...report,callAccounting:v});
 assert.match(render(usage),/原工程调用 13 \/ 13；补充复审已用 1 次；总调用 14 次/);
 assert.match(render({...usage,supplementalReviewCalls:0,totalCalls:13}),/补充复审已用 0 次；总调用 13 次/);
 for(const v of [undefined,null,{...usage,totalCalls:13},{...usage,supplementalReviewCalls:'1'},{...usage,originalCalls:-1},{...usage,originalMaxCalls:12},{...usage,totalCalls:Number.MAX_SAFE_INTEGER+1}]){
  assert.doesNotMatch(render(v),/补充复审已用/);assert.match(render(v),/调用用量暂未核清/);
 }
});
test('report and DreamFlow workspace show every independent executor instead of only the last one',()=>{
 const summary={title:'本轮报告',planLabel:'方案 v1',completedLabel:'保留已有成果',remainingLabel:'等待复审',blockers:[],nextLabel:'查看'};
 const executorRoles=[
  {executorRoleId:'worker-one',taskId:'TASK_A',model:'MODEL_ONE',provider:'provider-one',runner:'DSH'},
  {executorRoleId:'worker-two',taskId:'TASK_B',model:'MODEL_TWO',provider:'provider-two',runner:'DSH'}
 ];
 const report=flowReportContent({evidenceClass:'NATIVE',technicalRequirementsMet:false,userAccepted:false,verifiedCount:0,remainingCount:2,summary,executorRoles});
 assert.match(report,/执行器 1/);
 assert.match(report,/MODEL_ONE/);
 assert.match(report,/执行器 2/);
 assert.match(report,/MODEL_TWO/);
 assert.doesNotMatch(report,/worker-one|worker-two|TASK_A|TASK_B/);

 const run={id:'OFFLINE_RUN',specId:'OFFLINE_SPEC',state:'REVIEWING',tasks:executorRoles.map((role,index)=>({
  id:role.taskId,title:index?'整理中文说明':'制作离线工具',dependsOn:[],requirementIds:['R1'],acceptance:['离线检查'],status:'implemented'
 })),executorRoleIdentities:executorRoles};
 const workspace=flowWorkspace({
  mode:'local',product:'dream-maker',
  snapshot:{project:{id:'OFFLINE_PROJECT',specId:'OFFLINE_SPEC'},spec:{stale:false},runs:[run]},
  dispatch:{executorSlots:2,active:[],queued:[],quarantined:[]}
 });
 assert.match(workspace,/MODEL_ONE/);
 assert.match(workspace,/MODEL_TWO/);
 assert.match(workspace,/制作离线工具/);
 assert.match(workspace,/整理中文说明/);
 const executorSection=workspace.match(/<div class="executor-grid" aria-label="本轮执行器记录">[\s\S]*?<\/div>/)?.[0]??'';
 assert.ok(executorSection);
 assert.doesNotMatch(executorSection,/worker-one|worker-two|TASK_A|TASK_B/);
});
test('after choosing another route, the old delivered Flow cannot mask the current interview or next plan',async t=>{
 const h=harness(t),{p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);await h.engine.conclude(r.id,'ALTERNATIVE','offline-actor');
 const next=h.interviews.alternative(p.id,'不愿安装新组件');
 const v={mode:'local',screen:'project',projects:[next],snapshot:{project:next,spec:null,runs:h.store.runs(p.id),records:[]},settings:null,tab:'work',busy:false,error:'',events:[],connection:'connected',railClosed:false,files:[],fileName:'',fileText:'',previewUrl:'',specSearch:'',logLimit:40,clash:null,draft:()=>'',hasDraft:()=>false};
 let html=shell(v);
 assert.match(html,/aria-current="step"><span>02<\/span>澄清/);
 assert.match(html,/role is-current" data-key="role-planner1"/);
 assert.doesNotMatch(html,/data-action="accept"/);
 await h.interviews.finish(p.id,'',false);v.snapshot.project=h.store.project(p.id);v.snapshot.spec=h.store.spec(v.snapshot.project.specId);html=shell(v);
 assert.match(html,/data-action="approve"/);assert.doesNotMatch(html,/data-action="accept"/);
});
