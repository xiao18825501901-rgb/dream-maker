import test from 'node:test';
import assert from 'node:assert/strict';
import {addWizardItem,createWizard,wizardRoles} from '../../dist/web/custom-flow-state.js';
import {customWizardView} from '../../dist/web/custom-flow-view.js';
test('four-step configuration has honest scope, separate consent and no credential fields or third mode',()=>{
 const s=createWizard('p1',null);s.configuration.accounts[0].label='<img src=x onerror=bad()>';
 for(let step=0;step<4;step++){
  s.step=step;const html=customWizardView(s);assert.match(html,/尚未验证|没有开始制作/);assert.match(html,/aria-current="step"/);assert.match(html,/role="alert"|dialog-error/);
  assert.doesNotMatch(html,/<input[^>]+name="(?:apiKey|token|password|authorization)"/i);assert.doesNotMatch(html,/Copilot 快捷模式|<img/);
  if(step===0)assert.match(html,/&lt;img/);
  if(step===3){assert.match(html,/name="customConsent"[^>]*required/);assert.doesNotMatch(html,/name="customConsent"[^>]*checked/);}
 }
});
test('a saved official connection is described as reusable without claiming account or model qualification',()=>{
 const s=createWizard('p1',null);s.step=0;
 const html=customWizardView(s);
 assert.match(html,/已保存的官方连接会自动复用/);
 assert.match(html,/账户和模型资格仍需另行核验/);
 assert.doesNotMatch(html,/实际账户授权尚未连接/);
 assert.doesNotMatch(html,/账户意向[^<]*尚未连接/);
 assert.doesNotMatch(html,/data-action="siwc-connect"/);
});
test('new DeepSeek selection uses the official provider ID while a historical alias remains an explicit custom value',()=>{
 const s=createWizard('p1',null);s.step=0;assert.match(customWizardView(s),/<option value="deepseek-official"[^>]*>DeepSeek 官方 API/);
 s.configuration.accounts[0].provider='deepseek';const html=customWizardView(s);assert.match(html,/name="account-other-0" value="deepseek"/);assert.doesNotMatch(html,/<option value="deepseek-official" selected/);
 s.configuration.accounts[0].provider='deepseek-official';const official=customWizardView(s);assert.match(official,/OAuth 意向（此服务尚未接入）/);assert.match(official,/不会自动改用 API Key/);
});
test('a grouped role exposes its persisted initial-member choice and summary',()=>{
 const s=createWizard('p1',null);s.step=1;s.configuration.groups=[{id:'group-1',strategy:'failure_only',members:[
  {id:'member-1',provider:s.configuration.accounts[0].provider,model:'model-one',authRef:s.configuration.accounts[0].authRef,accountRef:s.configuration.accounts[0].accountRef,permissions:['source_read']},
  {id:'member-2',provider:s.configuration.accounts[0].provider,model:'model-two',authRef:s.configuration.accounts[0].authRef,accountRef:s.configuration.accounts[0].accountRef,permissions:['source_read']}
 ]}];s.configuration.roles.planner2.model={kind:'group',id:'group-1'};s.configuration.roles.planner2.selectedMemberId='member-2';
 const html=customWizardView(s);assert.match(html,/name="role-member-0"/);assert.match(html,/<option value="member-2" selected>/);assert.match(html,/本轮起始成员/);
 s.step=3;assert.match(customWizardView(s),/本轮起始成员.*member-2/);
});

test('selected Custom models have role-specific harness choices with stable stored IDs',()=>{
 const s=createWizard('p1',null);
 s.configuration.accounts[0].provider='string';
 assert.match(customWizardView(s),/<option value="string" selected>/);
 assert.match(customWizardView(s),/OAuth 意向（此服务尚未接入）/);
 s.step=1;s.configuration.roles.planner2.runtime='codex';s.configuration.roles.reviewer.runtime='claude';
 const html=customWizardView(s),select=i=>html.match(new RegExp('name="role-runtime-'+i+'">([^]*?)</select>'))[1];
 assert.match(select(0),/<option value="codex" selected>/);
 assert.match(select(2),/<option value="claude" selected>/);
 assert.doesNotMatch(select(1),/value="(?:claude|codex)"/);
});

test('new DreamFlow roles use a supported harness and saved runtime IDs survive reopening',()=>{
 const wizard=createWizard('p1',null,true);
 addWizardItem(wizard,'executor',0,true);
 assert.deepEqual(wizardRoles(wizard).map(role=>role.runtime),['dsh','dsh','dsh','dsh']);
 wizard.step=1;
 assert.doesNotMatch(customWizardView(wizard,{dreamflow:true}),/<option value="(?:copilot-sdk|codex-app-server)"/);
 const previous=createWizard('p1',null);
 const version={projectId:'p1',revision:1,contentHash:'a'.repeat(64),configuration:previous.configuration};
 const restored=createWizard('p1',version,true);
 assert.equal(restored.configuration.roles.planner2.runtime,'copilot-sdk');
 restored.step=1;
 assert.match(customWizardView(restored,{dreamflow:true}),/name="role-runtime-other-0" value="copilot-sdk"/);
});

test('DreamFlow can choose the exact discovered provider on the account step',()=>{
 const wizard=createWizard('p1',null);
 const rows=[{id:'deepseek/deepseek-flash',provider:'deepseek',kind:'provider',protocols:[]},
  {id:'deepseek/deepseek-v4-pro',provider:'deepseek',kind:'provider',protocols:[]},
  {id:'group/cheap',provider:'alias-owner',kind:'alias',protocols:[]}];
 const options=customWizardView(wizard,{dreamflow:true,magpieModels:rows}).split('name="account-provider-0">')[1].split('</select>')[0];
 assert.equal(options.match(/value="deepseek"/g)?.length,1);
 assert.match(options,/value="deepseek-official"/);
 assert.doesNotMatch(options,/alias-owner/);
 assert.doesNotMatch(customWizardView(wizard,{magpieModels:rows}),/value="deepseek"|custom-read-models/);
});

test('DreamFlow shows the declared wire for each API-key role without losing incompatible catalog entries',()=>{
 const state=createWizard('p1',null,true);state.step=1;
 const {planner2,executors,reviewer}=state.configuration.roles;
 planner2.runtime='codex';executors[0].runtime='pi';reviewer.runtime='claude';
 for(const actor of [planner2,executors[0],reviewer])actor.authentication='api_key';
 const rows=[{id:'github/model',provider:'github',kind:'provider',protocols:['chat-completions','openai-responses']}];
 const html=customWizardView(state,{dreamflow:true,magpieModels:rows});
 const options=index=>html.split('name="role-catalog-'+index+'">')[1].split('</select>')[0];
 assert.match(options(0),/value="github\/model"[^>]*>github\/model · openai-responses</);
 assert.match(options(1),/github\/model · chat-completions</);
 assert.match(options(2),/github\/model · chat-completions（经 Magpie 转换，需核验账户与构建）</);
 rows[0].protocols=['openai-responses'];planner2.runtime='opencode';reviewer.runtime='cline';
 const converted=customWizardView(state,{dreamflow:true,magpieModels:rows});
 assert.equal(converted.split('github/model · openai-responses（经 Magpie 转换，需核验账户与构建）').length-1,2);
 assert.match(converted,/github\/model · openai-responses（Pi 原生工具协议，需核验 Magpie 构建与账户）</);
 rows[0].protocols=['anthropic-messages'];
 assert.match(customWizardView(state,{dreamflow:true,magpieModels:rows}),/github\/model · anthropic-messages（Pi 原生工具协议，需核验 Magpie 构建与账户）</);
});

test('DreamFlow Custom lists native harnesses by role and displays exact Magpie discovery IDs',()=>{
 const s=createWizard('p1',null);s.step=1;
 const html=customWizardView(s,{dreamflow:true,magpieModels:[{id:'github/model',provider:'github',kind:'provider',protocols:['chat-completions']},{id:'other/model',provider:'other',kind:'provider',protocols:[]},{id:'group/cheap',provider:'github',kind:'alias',protocols:[]}]});
 const select=i=>html.match(new RegExp('name="role-runtime-'+i+'">([^]*?)</select>'))[1];
 for(const runtime of ['claude','opencode','cline']){
  assert.match(select(0),new RegExp('value="'+runtime+'"'));
  assert.match(select(2),new RegExp('value="'+runtime+'"'));
  assert.doesNotMatch(select(1),new RegExp('value="'+runtime+'"'));
 }
 assert.match(select(1),/value="pi"/);
 assert.match(html,/data-action="custom-read-models"/);
 const choices=html.split('name="role-catalog-1">')[1].split('</select>')[0];
 assert.ok(choices.includes('>github/model</option>'));
 assert.ok(!choices.includes('other/model')&&!choices.includes('group/cheap'));
 assert.ok(html.includes('<li>other/model · other'));
 assert.ok(html.includes('<li>group/cheap · github · 别名'));
 const legacy=customWizardView(s);
 assert.match(legacy,/>DSH</);assert.match(html,/>DeepSeek Harness（DSH）</);
 assert.doesNotMatch(legacy,/custom-read-models|role-catalog|DeepSeek Harness|value="(?:opencode|cline|independent|pi)"/);
});

