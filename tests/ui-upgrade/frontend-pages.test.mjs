// Shared production views with explicit synthetic inputs; this is frontend evidence only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {shell} from '../../dist/web/views.js';
import {DemoScenarioAdapter} from '../../dist/web/demo-api.js';
async function view(tab='work',project='sample-spec'){
 const adapter=new DemoScenarioAdapter();await adapter.init();
 const snapshot=await adapter.request('/projects/'+project),settings=await adapter.request('/config');
 return {mode:'public-demo',product:'dream-maker',screen:'project',projects:[snapshot.project],snapshot,settings,tab,busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:40,clash:null,draft:()=>'',hasDraft:()=>false};
}
function versions(v){
 const one=structuredClone(v.snapshot.spec),two=structuredClone(one);one.id='spec-ui-1';one.revision=1;one.hash='1'.repeat(64);one.brief='第一版：保存任务';two.id='spec-ui-2';two.revision=2;two.hash='2'.repeat(64);two.brief='第二版：增加日期';
 const rows=[one,two].map((snapshot,i)=>({id:'pv-'+(i+1),projectId:v.snapshot.project.id,revision:i+1,parentId:i?'pv-1':null,specHash:snapshot.hash,contentHash:String(i+3).repeat(64),origin:'COMPILED_SPEC',snapshot,source:{provenance:'CURRENT_PROJECT_INPUT'},createdAt:snapshot.createdAt,approval:i?null:{actor:'UI_TEST_ONLY',at:snapshot.createdAt}}));
 v.snapshot.spec=two;v.snapshot.project.specId=two.id;return rows;
}
test('project navigation exposes research, complete history, workbench, optional Laya and reports',async()=>{
 const html=shell(await view());for(const label of ['开源研究','方案历史','DreamFlow','Laya','审查报告','后续交流'])assert.ok(html.includes(label),label);
});
test('history shows frozen full versions, confirmation and differences without changing snapshots',async()=>{
 const v=await view('history'),items=versions(v),before=JSON.stringify(items);v.planHistory={items,selectedId:'pv-2',nextRevision:null};
 const html=shell(v);assert.match(html,/第二版：增加日期/);assert.match(html,/第一版：保存任务/);assert.match(html,/版本差异/);assert.match(html,/待确认/);assert.match(html,/已确认/);assert.equal(JSON.stringify(items),before);
});
test('historical text is escaped and never becomes a live approval control',async()=>{
 const v=await view('history'),items=versions(v);items[0].snapshot.brief='<img src=x onerror=alert(1)>';v.planHistory={items,selectedId:'pv-1',nextRevision:null};
 const html=shell(v);assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/data-action="approve"/);
});
test('research failure explains uncertainty and never declares that open source does not exist',async()=>{
 const v=await view('research');v.researchPanel={operations:[{id:'search-ui',projectId:v.snapshot.project.id,projectVersion:1,inputHash:'a'.repeat(64),keywords:['task list'],status:'COMPLETED',requestCount:1,at:new Date().toISOString(),result:{status:'UNAVAILABLE',results:[],snapshots:[],failures:[{platform:'github',stage:'SEARCH',code:'RATE_LIMITED'}]}}]};
 const html=shell(v);assert.match(html,/检索暂未完成/);assert.match(html,/限流|稍后/);assert.doesNotMatch(html,/没有开源项目|不存在开源|没有可复用项目/);
});
test('workbench displays dependencies and the actual single executor capacity',async()=>{
 const v=await view('flow','sample-review');v.dispatch={executorSlots:1,active:[],queued:[],quarantined:[]};
 const html=shell(v);assert.match(html,/任务依赖/);assert.match(html,/1 个执行器/);assert.match(html,/task-1/);assert.doesNotMatch(html,/多个执行器已连接|多执行器验证通过/);
});
test('Laya remains visible when absent and separates all three engineering roles',async()=>{
 const v=await view('laya');const html=shell(v);assert.match(html,/不需要安装 Laya/);for(const role of ['工程规划','执行器','审查'])assert.ok(html.includes(role),role);assert.match(html,/尚未核验|未连接|未启用/);
});
test('a missing reviewer result is an empty state rather than a successful review',async()=>{
 const v=await view('report');const html=shell(v);assert.match(html,/还没有本轮审查报告/);assert.doesNotMatch(html,/审查已通过|真实验收通过/);
});

test('unknown dispatch counts are not shown as zero',async()=>{
 const v=await view('flow','sample-review');const html=shell(v);assert.match(html,/执行数量尚未读取/);assert.doesNotMatch(html,/0 个当前执行任务/);
});
test('a historical run is explicitly separated from the current plan workbench',async()=>{
 const v=await view('flow','sample-review');v.snapshot.project.specId='new-plan';const html=shell(v);assert.match(html,/历史轮次/);assert.doesNotMatch(html,/本轮状态：返修中/);
});
test('standalone DreamFlow navigation starts from a user plan without interview stages',async()=>{
 const v=await view();v.product='dreamflow';v.snapshot.project.planner1Mode='USER';const html=shell(v);assert.doesNotMatch(html,/>回答记录<|>澄清<|>灵感<|>后续交流</);assert.match(html,/你的方案|方案/);
});
test('frontend review exposes safe exit, plain Help and complete settings without secret fields',async()=>{
 const v=await view();v.presentation='frontend-review';v.screen='settings';let html=shell(v);assert.match(html,/data-action="application-exit"/);for(const word of ['本地模型','已有网络工具','存储位置','更新'])assert.ok(html.includes(word),word);assert.doesNotMatch(html,/type="password"/);
 v.screen='help';html=shell(v);assert.match(html,/我看不懂，请换一种说法/);
});
test('followup preserves a draft while the general conversation connection is unavailable',async()=>{
 const v=await view('followup');v.draft=key=>key.startsWith('followup:')?'这是我的中文问题':'';
 const html=shell(v);assert.match(html,/这是我的中文问题/);assert.match(html,/我无法解决/);assert.match(html,/换一种办法/);assert.match(html,/尚未连接|尚未接通/);
});
test('fees are a separate page with unknown amounts and both currencies kept separate',async()=>{
 const v=await view();v.screen='fees';v.setup={schema:'dream-maker.setup.v1',product:'dream-maker',requiredRoles:[],roles:[],optionalLaya:{required:false,availableToChoose:true,configuredMode:'off',actualService:'NOT_CHECKED'},safety:{state:'UNKNOWN',message:'尚未核验'},fees:{ordinaryUserDefault:{configured:false,unlimited:false,automaticRecharge:false,extraUsage:false},existingScope:{status:'UNAVAILABLE',mode:null,requests:null,maxRequests:null,byCurrency:{}},userBudgetAvailable:false,note:'未知费用不会显示为免费。'},automaticActions:false,modelCalls:0,fullFlowAcceptance:'NOT_RUN'};
 const html=shell(v);assert.match(html,/费用管理/);assert.match(html,/人民币记录/);assert.match(html,/美元记录/);assert.match(html,/未知/);assert.match(html,/不会.*清零|不会.*你的默认设置/);
});
test('ordinary errors explain next steps without displaying codes, paths or provider details',async()=>{
 const {friendlyUiError}=await import('../../dist/web/plain-ui-error.js');
 for(const code of ['WORKSPACE_LOCATION_CHANGED','STORAGE_ROOT_CHANGED','RELOCATED_WORKSPACE_CHANGED','RUN_CONFIG_CHANGED','MODEL_HTTP_ERROR','UNKNOWN_INTERNAL_CODE']){
  const text=friendlyUiError({code,message:'internal '+code+' C:\\private\\file https://provider.example/token'});
  assert.doesNotMatch(text,/WORKSPACE_|STORAGE_|INTERNAL_|C:\\|https:|provider\.example/);assert.match(text,/[\u3400-\u9fff]/);
 }
});
