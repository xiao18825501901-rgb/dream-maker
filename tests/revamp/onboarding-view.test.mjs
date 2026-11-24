// Offline view contract; actual browser and real account gates remain separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shell } from '../../dist/web/views.js';
import { setupSnapshot } from '../../dist/server/onboarding.js';
import { defaults } from '../../dist/server/config.js';
function state(product='dream-maker',step=0){
 const config=structuredClone(defaults);
 const setup=setupSnapshot({product,config,keyPresent:false,probe:{},budget:{status:'HISTORY_ONLY',mode:'UNCAPPED',requests:2,maxRequests:10,byCurrency:{CNY:{committedMicros:1230000}}},safetyReady:false});
 return {product,mode:'local',screen:'setup',setup,setupStep:step,projects:[],snapshot:null,settings:{config,keyStatus:{planner1:false,executor:false},nativeStatus:'NOT_VERIFIED'},tab:'work',busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:40,clash:null,draft:()=>'',hasDraft:()=>false};
}
test('setup has five accessible steps and does not confuse installed tools with valid accounts',()=>{
 const html=shell(state());assert.match(html,/使用准备/);assert.match(html,/aria-label="准备步骤"/);assert.match(html,/aria-current="step"/);
 assert.match(html,/工具与角色/);assert.match(html,/账户与额度/);assert.match(html,/费用控制/);assert.match(html,/本机与可选助手/);assert.match(html,/核对下一步/);
 assert.match(html,/尚未/);assert.doesNotMatch(html,/全部准备完成|已连接成功/);
});
test('legacy uncapped history is separate from ordinary user defaults and secrets are never requested',()=>{
 const html=shell(state('dream-maker',2));assert.match(html,/历史开发/);assert.match(html,/普通用户/);assert.match(html,/1\.23/);
 assert.match(html,/自动充值/);assert.doesNotMatch(html,/type="password"|name="apiKey"|name="token"|购买订阅|自动开通/);
});
test('standalone setup acknowledges the user P1 and asks no Kimi login',()=>{
 const html=shell(state('dreamflow',1));assert.match(html,/由你提供/);assert.match(html,/不需要需求访谈账户/);
 assert.doesNotMatch(html,/登录 Kimi|name="kimiConsent"/);
});
test('local Planner 1 setup is neither a Kimi login nor a cloud API-key role',()=>{
 const config=structuredClone(defaults);
 Object.assign(config.planner1,{provider:'local',bindingVersion:3,authMode:'api_key',protocol:'chat-completions',baseUrl:'http://127.0.0.1:11434/v1',keyEnv:'DM_LOCAL_PLANNER1_NO_KEY',model:'qwen2.5:7b'});
 const setup=setupSnapshot({product:'dream-maker',config,keyPresent:false,probe:{},budget:{status:'HISTORY_ONLY',mode:'UNCAPPED',requests:2,maxRequests:10,byCurrency:{CNY:{committedMicros:1230000}}},safetyReady:false});
 const p1=setup.roles.find(role=>role.role==='planner1');
 assert.equal(p1.provider,'local-ollama');assert.equal(p1.runner,'LOCAL_HTTP');assert.equal(p1.targetModel,'qwen2.5:7b');
 assert.equal(p1.installation.state,'CONFIGURED_UNVERIFIED');assert.equal(p1.authentication.state,'NOT_REQUIRED');assert.equal(p1.quota.state,'UNKNOWN');
 assert.match(p1.authentication.message,/不要求.*API Key/);assert.doesNotMatch(p1.quota.message,/Kimi/);
});
test('available accounting exposes explicit per-currency limits, with zero stopping that paid currency',()=>{
 const view=state('dreamflow',2);view.setup.fees.userBudgetAvailable=true;
 view.setup.fees.userBudget={configured:true,unlimited:false,revision:2,limits:{CNY:3000000,USD:0},baselineRequests:2,startedAt:'2026-11-01T00:00:00.000Z',basis:'FUTURE_REQUESTS_SINCE_EXPLICIT_ACTIVATION',byCurrency:{CNY:{committedMicros:500000,reservedMicros:1000000,remainingMicros:1500000,exceeded:false},USD:{committedMicros:0,reservedMicros:0,remainingMicros:0,exceeded:false}}};
 const html=shell(view);assert.match(html,/id="budget-limit-form"/);assert.match(html,/name="budgetCNY"/);assert.match(html,/name="budgetUSD"/);
 assert.match(html,/0 表示停止/);assert.match(html,/1\.5/);assert.match(html,/保留.*累计|不会清零/);assert.doesNotMatch(html,/额度尚未设置/);
});
test('budget confirmation names both limits and never preselects consent or claims a model run',async()=>{
 const {budgetConfirmation}=await import('../../dist/web/setup-view.js');
 const html=budgetConfirmation({CNY:'3.000001',USD:'0'});
 assert.match(html,/3\.000001/);assert.match(html,/name="budgetConsent"/);assert.doesNotMatch(html,/\schecked(?:\s|>|=)/);assert.match(html,/不会开始/);
 assert.doesNotMatch(budgetConfirmation({CNY:'<img src=x>',USD:'0'}),/<img/);
});

test('an explicitly uncapped currency is labelled as unlimited while the other currency remains disabled',async()=>{
 const {feesContent,budgetConfirmation}=await import('../../dist/web/setup-view.js'),view=state('dreamflow',2);
 view.setup.fees.userBudgetAvailable=true;view.setup.fees.userBudget={configured:true,unlimited:true,revision:4,limits:{CNY:null,USD:0},baselineRequests:2,startedAt:'2026-11-01T00:00:00.000Z',basis:'FUTURE_REQUESTS_SINCE_EXPLICIT_ACTIVATION',byCurrency:{CNY:{committedMicros:49741824,reservedMicros:0,remainingMicros:null,exceeded:false},USD:{committedMicros:0,reservedMicros:0,remainingMicros:0,exceeded:false}}};
 const html=feesContent(view.setup);assert.match(html,/人民币上限[^<]*<\/dt><dd>不限额/);assert.match(html,/value="不限额"/);
 assert.match(html,/49\.741824/);assert.match(html,/美元上限[^<]*<\/dt><dd>0/);assert.doesNotMatch(html,/NaN|Infinity/);
 const confirmation=budgetConfirmation({CNY:'unlimited',USD:'0'});assert.match(confirmation,/人民币[^<]*不限额/);
 assert.match(confirmation,/美元[^<]*0/);assert.doesNotMatch(confirmation,/\schecked(?:\s|>|=)/);
});
test('budget refusal explains preserved limits and an actionable next step in ordinary language',async()=>{
 const {budgetErrorMessage}=await import('../../dist/web/setup-view.js');
 assert.match(budgetErrorMessage('USER_BUDGET_ABOVE_AUTHORITY'),/原限额保持不变.*返回修改/);assert.match(budgetErrorMessage('USER_BUDGET_PENDING_REQUESTS'),/等待.*原限额保持不变/);
 assert.match(budgetErrorMessage('USER_BUDGET_REVISION_CONFLICT'),/刷新.*没有覆盖/);assert.equal(budgetErrorMessage('NOT_A_BUDGET_ERROR'),undefined);
});
