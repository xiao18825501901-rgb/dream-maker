import test from 'node:test';
import assert from 'node:assert/strict';
import { harness,bindOfflineApi } from '../helpers.mjs';
import { Interviews } from '../../dist/server/interview.js';
import { ProjectResearch } from '../../dist/server/research/project-research.js';
import { compileSpec } from '../../dist/server/compile.js';
function plan(requirements){return {
 goal:'制作可以保存内容的本地记录工具',requirements,
 acceptance:requirements.map((r,i)=>({id:'A'+i,check:'保存内容并重新打开，确认内容仍在。',requirementIds:[r.id]})),
 architecture:{summary:'本地界面与本地数据存储',runtime:'Node',components:['界面','存储']},
 dataModel:{entities:['记录'],persistence:'本地文件'},interfaces:{userFlows:['添加、查看和修改记录'],boundaries:['不公开数据']},
 tasks:[{id:'T1',title:'实现保存与回看',dependsOn:[],requirementIds:requirements.map(r=>r.id),check:'真实保存后重新打开'}],
 delivery:{type:'local-app',howToUse:'在本机打开应用',standalone:true,needsInternet:false,ongoingFees:[]},
 resources:{accounts:[],hardware:['现有电脑'],network:[],ongoingCosts:[]},risks:['需验证异常退出时数据保护'],
 milestones:['完成核心操作','验证与交付'],assumptions:['默认仅供本机个人使用'],unknowns:[],outOfScope:['公开部署'],
 research:{status:'SEARCHED_WITHIN_BOUNDS',sourceRefs:[{webUrl:'https://FORGED.invalid'}]},
 reuse:{mode:'ADAPT_PROJECT',selected:[{webUrl:'https://FORGED.invalid'}]}
};}
function rig(t,extra={}){
 const h=harness(t);bindOfflineApi(h.config);const calls=[];let sourceCalls=0;
 const research=new ProjectResearch(h.store,h.dir,async url=>{sourceCalls++;return Response.json(new URL(url).hostname==='api.github.com'?{items:[],incomplete_results:false}:[]);});
 const model={complete:async(payload,signal)=>{
  calls.push(payload.task);if(extra.complete)return extra.complete(payload,signal);
  if(payload.task==='research_intent')return{data:{keywords:['notes','offline']},usage:{role:'planner1',costUsd:0,source:'OFFLINE_TEST'}};
  if(payload.task==='project_plan')return{data:plan(payload.requiredUserRequirements),usage:{role:'planner1',costUsd:0,source:'OFFLINE_TEST'}};
  throw Error('UNEXPECTED_MODEL_TASK_'+payload.task);
 }};
 const interviews=new Interviews(h.store,model,h.laya,()=>h.config,undefined,undefined,research);
 return{...h,interviews,research,calls,sourceCalls:()=>sourceCalls};
}
test('zero-answer finish creates a complete unapproved plan and truthfully records missing public-search consent',async t=>{
 const h=rig(t);const p=h.interviews.create('自主方案','保存我的本地记录。','live');
 try{
  await h.interviews.finish(p.id,'',true);const current=h.store.project(p.id),s=h.store.spec(current.specId);
  assert.deepEqual(h.calls,['project_plan']);assert.equal(h.sourceCalls(),0);
  assert.equal(s.projectPlan.research.status,'UNAVAILABLE');assert.equal(s.projectPlan.reuse.mode,'IMPLEMENT_ORIGINAL');
  assert.deepEqual(s.projectPlan.reuse.selected,[]);assert.equal(s.projectPlan.requirements[0].text,p.idea);
  assert.equal(current.state,'SPEC_REVIEW');assert.equal(h.store.planHead(p.id).origin,'COMPLETE_PLAN');
  assert.equal(h.store.planHead(p.id).approval,null);assert.equal(h.store.runs(p.id).length,0);
 }finally{await h.research.close();}
});
test('finish actually researches before the P1 plan and overrides model-invented source and reuse claims',async t=>{
 const h=rig(t);const p=h.interviews.create('公开选型','制作本地记录工具。','live',true,'LOCAL_TEST_ACTOR');
 try{
  await h.interviews.finish(p.id,'保持简单',true);const s=h.store.spec(h.store.project(p.id).specId);
  assert.deepEqual(h.calls,['research_intent','project_plan']);assert.equal(h.sourceCalls(),2);
  assert.equal(s.projectPlan.research.status,'SEARCHED_WITHIN_BOUNDS');assert.deepEqual(s.projectPlan.research.sourceRefs,[]);
  assert.equal(s.projectPlan.reuse.mode,'IMPLEMENT_ORIGINAL');assert.doesNotMatch(JSON.stringify(s.projectPlan),/FORGED/);
  const operations=h.store.records(p.id,'PlanningOperation');assert.equal(operations.at(-1).data.state,'DRAFT_SAVED');assert.equal(operations.at(-1).data.draftId,s.id);
  assert.ok(s.masterPrompt.includes('完整项目方案'));assert.equal(h.store.planVersions(p.id).length,1);
 }finally{await h.research.close();}
});
test('a model cannot erase original requirements or freeze a partial architecture as a complete plan',async t=>{
 const h=rig(t,{complete:async payload=>({data:{...plan(payload.requiredUserRequirements??[]),requirements:[]},usage:{role:'planner1',costUsd:0,source:'OFFLINE_TEST'}})});
 const p=h.interviews.create('拒绝改写','必须保留这段原始要求。','live');
 try{await assert.rejects(h.interviews.finish(p.id,'',true));assert.equal(h.store.project(p.id).specId,null);assert.equal(h.store.planVersions(p.id).length,0);assert.equal(h.store.records(p.id,'PlanningOperation').at(-1).data.state,'STOPPED_RECONCILE_BEFORE_RETRY');}finally{await h.research.close();}
});
test('a valid long original description is preserved rather than truncated to the standalone kit limit',async t=>{
 const h=rig(t),idea='这段需求必须完整保存。'.repeat(500),p=h.interviews.create('长描述',idea,'live');
 try{await h.interviews.finish(p.id,'',true);const s=h.store.spec(h.store.project(p.id).specId);assert.equal(s.projectPlan.requirements[0].text,idea);assert.equal(s.requirements[0].text,idea);}finally{await h.research.close();}
});
test('simultaneous finish requests cannot duplicate P1 calls or drafts',async t=>{
 let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const h=rig(t,{complete:async payload=>{entered();await gate;return{data:plan(payload.requiredUserRequirements),usage:{role:'planner1',costUsd:0,source:'OFFLINE_TEST'}};}});
 const p=h.interviews.create('去重','本地记录工具。','live');
 try{const first=h.interviews.finish(p.id,'',true);await started;await assert.rejects(h.interviews.finish(p.id,'',true),{code:'PLANNING_ALREADY_RUNNING'});release();await first;assert.deepEqual(h.calls,['project_plan']);assert.equal(h.store.planVersions(p.id).length,1);}finally{release();await h.research.close();}
});
test('a changed input rejects a late full P1 plan before its snapshot transaction',async t=>{
 let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const h=rig(t,{complete:async payload=>{entered();await gate;return{data:plan(payload.requiredUserRequirements),usage:{role:'planner1',costUsd:0,source:'OFFLINE_TEST'}};}});
 const p=h.interviews.create('过期结果','本地记录工具。','live');
 try{const outcome=h.interviews.finish(p.id,'',true).then(()=>null,e=>e);await started;const changed=h.store.project(p.id);changed.idea+=' 加上新限制。';h.store.saveProject(changed);release();assert.equal((await outcome).code,'PLANNING_INPUT_STALE_OR_FLOW_ACTIVE');assert.equal(h.store.project(p.id).specId,null);assert.equal(h.store.planVersions(p.id).length,0);}finally{release();await h.research.close();}
});
test('cancelled or uncertain P1 work cannot be silently retried as another charged planning task',async t=>{
 let entered;const started=new Promise(r=>entered=r);
 const h=rig(t,{complete:async(_payload,signal)=>new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(Error('interrupted')),{once:true});})});
 const p=h.interviews.create('取消规划','本地记录工具。','live');
 try{const outcome=h.interviews.finish(p.id,'',true).then(()=>null,e=>e);await started;await h.interviews.cancelPlanning(p.id);assert.ok(await outcome);assert.equal(h.store.planVersions(p.id).length,0);await assert.rejects(h.interviews.finish(p.id,'',true),{code:'PLANNING_RECONCILIATION_REQUIRED'});assert.equal(h.calls.length,1);}finally{await h.research.close();}
});
test('the legacy summarize=false flag cannot disable complete P1 planning for a Live project',async t=>{
 const h=rig(t),p=h.interviews.create('禁止捷径','本地记录工具。','live');
 try{await h.interviews.finish(p.id,'',false);assert.deepEqual(h.calls,['project_plan']);assert.equal(h.store.planHead(p.id).origin,'COMPLETE_PLAN');}finally{await h.research.close();}
});
test('an old compiled-only spec cannot enter a new Live run even if a legacy confirmation exists',async t=>{
 const h=rig(t),p=h.interviews.create('旧规格需升级','本地记录工具。','live'),s=compileSpec(p,1);
 try{h.store.tx(()=>{h.store.saveSpec(s);p.specId=s.id;p.state='READY_TO_BUILD';h.store.saveProject(p);h.store.approve(p.id,s.hash,'SPEC','LOCAL_TEST_ACTOR');});
  assert.throws(()=>h.engine.create(p.id,s.hash,true),{code:'COMPLETE_PROJECT_PLAN_REQUIRED'});assert.equal(h.store.runs(p.id).length,0);
 }finally{await h.research.close();}
});
test('unchanged planning inputs do not create another model call or version; a real notes update does',async t=>{
 const h=rig(t),p=h.interviews.create('真实更新才改版','本地记录工具。','live');
 try{
  await h.interviews.finish(p.id,'原始补充',true);const first=h.store.planHead(p.id);h.interviews.approve(p.id,first.specHash);
  await h.interviews.finish(p.id,'原始补充',true);assert.equal(h.calls.length,1);assert.equal(h.store.planVersions(p.id).length,1);
  await h.interviews.finish(p.id,'新的使用条件',true);assert.equal(h.calls.length,2);assert.equal(h.store.planVersions(p.id).length,2);
  const second=h.store.planHead(p.id);assert.equal(second.snapshot.userNotes,'新的使用条件');assert.equal(second.approval,null);assert.ok(h.store.planVersion(first.id).approval);
 }finally{await h.research.close();}
});
test('recovery proves an already-saved immutable draft before closing an uncertain journal, without another model call',async t=>{
 const h=rig(t),p=h.interviews.create('已保存结果对账','本地记录工具。','live');
 try{
  await h.interviews.finish(p.id,'保留补充原话',true);const s=h.store.spec(h.store.project(p.id).specId),last=h.store.records(p.id,'PlanningOperation').at(-1).data;
  // Simulated process interruption after the draft transaction and before the final journal append.
  h.store.record('PlanningOperation',p.id,null,{...last,state:'SAVING_UNAPPROVED_PLAN'});
  const recovered=h.interviews.reconcilePlanning(p.id);assert.equal(recovered.status,'DRAFT_RECOVERED');
  assert.equal(h.store.records(p.id,'PlanningOperation').at(-1).data.draftId,s.id);assert.equal(h.calls.length,1);
  assert.equal(h.store.planHead(p.id).approval,null);assert.equal(h.store.records(p.id,'PlanningInput')[0].data.notes,'保留补充原话');
  h.store.record('PlanningOperation',p.id,null,{...last,state:'SAVING_UNAPPROVED_PLAN',inputHash:'f'.repeat(64)});
  assert.equal(h.interviews.reconcilePlanning(p.id).status,'NO_RECOVERABLE_DRAFT');
 }finally{await h.research.close();}
});
