import test from 'node:test';
import assert from 'node:assert/strict';
import {FrontendReviewAdapter} from '../../dist/web/frontend-review-api.js';
import {userPlanFromFields} from '../../dist/web/user-plan-view.js';

async function adapter(product='dream-maker') {
  const a=new FrontendReviewAdapter(product);await a.init();return a;
}
test('review adapter cannot use real connections, credentials or switch to Live',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('network forbidden');};
  try {const a=await adapter();assert.equal(a.presentation,'frontend-review');assert.equal(a.mode,'public-demo');
    for(const path of ['/diagnostics/models','/kimi/login','/clash/verify','/demo-finish'])await assert.rejects(a.request(path,'POST',{}));
    await assert.rejects(a.request('/projects','POST',{name:'x',idea:'x',mode:'live'}));
    await assert.rejects(a.request('/config','PUT',{apiKey:'not-a-secret'}));
    assert.equal(calls,0);
  } finally {globalThis.fetch=original;}
});
test('zero-answer finish produces an explicitly synthetic full plan and immutable history',async()=>{
 const a=await adapter(),p=await a.request('/projects','POST',{name:'零回答',idea:'我的长想法',mode:'demo'});
 const done=await a.request('/projects/'+p.project.id+'/finish','POST',{notes:''});
 assert.equal(done.project.answers.length,0);assert.ok(done.spec.projectPlan);assert.match(done.spec.constraints.join(' '),/演示/);
 const history=await a.request('/projects/'+p.project.id+'/plans?afterRevision=0&limit=50');assert.equal(history.plans.length,1);assert.equal(history.plans[0].approval,null);
 history.plans[0].snapshot.brief='mutated';assert.notEqual((await a.request('/projects/'+p.project.id+'/plans')).plans[0].snapshot.brief,'mutated');
});
test('confirmation and build remain separate and research makes no verified-source claim',async()=>{
 const a=await adapter(),s=await a.request('/projects/sample-spec');
 const approved=await a.request('/projects/sample-spec/approve','POST',{specHash:s.spec.hash});assert.equal(approved.runs.length,0);
 const history=await a.request('/projects/sample-spec/plans');assert.ok(history.plans.at(-1).approval);
 const research=await a.request('/projects/sample-spec/research');assert.equal(research.operations[0].result.status,'UNAVAILABLE');
 assert.equal(research.operations[0].result.snapshots.length,0);
});
test('ordinary budget requires explicit confirmation and matching revision without real ledger mutation',async()=>{
 const a=await adapter(),before=await a.request('/onboarding');
 const limits={CNY:'12.5',USD:'0'};
 await assert.rejects(a.request('/onboarding/budget','POST',{limits,revision:before.fees.userBudget.revision}));
 await a.request('/onboarding/budget','POST',{limits,revision:before.fees.userBudget.revision,confirmed:true});
 const after=await a.request('/onboarding');assert.equal(after.fees.userBudget.limits.CNY,12500000);assert.equal(after.modelCalls,0);
 await assert.rejects(a.request('/onboarding/budget','POST',{limits,revision:before.fees.userBudget.revision,confirmed:true}));
 assert.deepEqual(after.fees.existingScope,before.fees.existingScope);
});
test('standalone plan input avoids interview and preserves earlier revisions',async()=>{
 const a=await adapter('dreamflow');assert.equal((await a.request('/product')).product,'dreamflow');
 const fields={projectName:'用户方案',mode:'demo',goal:'记录任务',requirements:'添加任务',acceptance:'添加后可看到',architecture:'本机页面',tasks:'制作页面',delivery:'本机使用'};
 const document=userPlanFromFields(key=>fields[key]??'',()=>false),s=await a.request('/user-plans','POST',{document});
 assert.equal(s.project.planner1Mode,'USER');assert.equal(s.project.questions.length,0);assert.ok(s.spec.projectPlan);
 assert.deepEqual(s.spec.requirements.map(r=>r.text),['添加任务']);assert.deepEqual(s.spec.acceptance,['添加后可看到']);assert.doesNotMatch(s.spec.masterPrompt,/十题门槛/);
 await assert.rejects(a.request('/projects/'+s.project.id+'/next','POST',{}));
 const history=await a.request('/projects/'+s.project.id+'/plans');assert.equal(history.plans.length,1);
});
test('reports and maintenance demonstrations never grant acceptance or restore authority',async()=>{
 const a=await adapter(),s=await a.request('/projects/sample-review'),report=await a.request('/runs/'+s.runs[0].id+'/report');
 assert.equal(report.technicalRequirementsMet,false);assert.equal(report.userAccepted,false);assert.match(report.summary.title,/演示/);
 await assert.rejects(a.request('/maintenance/snapshots','POST',{confirmed:true}));
 await assert.rejects(a.request('/projects/sample-spec/data/restore','POST',{confirmed:true}));
 assert.equal((await a.request('/application/lifecycle')).state,'RUNNING');
});
test('an active simulated Flow cannot rewrite its frozen plan before a separate conclusion',async()=>{
 const a=await adapter(),s=await a.request('/projects/sample-review');
 await assert.rejects(a.request('/projects/sample-review/finish','POST',{}));
 assert.equal((await a.request('/projects/sample-review')).spec.id,s.spec.id);
 const report=await a.request('/runs/'+s.runs[0].id+'/report');
 await a.request('/runs/'+s.runs[0].id+'/conclude','POST',{choice:'ALTERNATIVE',reportHash:report.reportHash});
 const alternate=await a.request('/projects/sample-review/alternative','POST',{constraint:'不安装额外工具'});
 assert.equal(alternate.project.batchSize,5);assert.equal(alternate.spec.stale,true);
 const next=await a.request('/projects/sample-review/finish','POST',{});assert.equal(next.spec.revision,s.spec.revision+1);
});
