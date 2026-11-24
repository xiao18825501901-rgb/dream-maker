import test from 'node:test';
import assert from 'node:assert/strict';
import { readVerifierPlan, escapeHtml } from '../../dist/web/contracts.js';
import { verifierContent } from '../../dist/web/views.js';

const hash='a'.repeat(64),sha256='b'.repeat(64);
const fixture=()=>({sha256,plan:{schema:'dream-maker.cli-verifier.v1',specHash:hash,cases:[{
 id:'case1',requirementIds:['R1'],acceptanceIds:['A1'],runtime:'node',entry:'main.mjs',args:['--count','2'],
 stdin:'<input>',expectedExitCode:0,expectedStdout:'<img onerror="bad">\n'
}]}});
test('oracle view retains exact inputs, expectations, requirements and hash without HTML execution',()=>{
 const plan=readVerifierPlan(fixture(),hash),html=verifierContent(plan);
 for(const value of ['R1','A1','关联验收项','main.mjs','--count',sha256,hash,escapeHtml(JSON.stringify(fixture().plan.cases[0].stdin)),escapeHtml(JSON.stringify(fixture().plan.cases[0].expectedStdout))])assert.ok(html.includes(value),value);
 assert.doesNotMatch(html,/<img|checked|buildConsent/);
 assert.match(html,/name="verifierConsent"[^>]*required/);
 assert.match(html,/id="native-verifier-form"/);
});
test('oracle response rejects stale spec, missing fields and malformed cases before consent',()=>{
 for(const alter of [x=>x.plan.specHash='c'.repeat(64),x=>x.sha256='invalid',x=>x.plan.cases=[],x=>delete x.plan.cases[0].stdin,x=>x.plan.cases[0].runtime='shell',x=>x.plan.cases[0].args=[1],x=>x.plan.cases[0].acceptanceIds=[],x=>x.plan.cases[0].acceptanceIds=['A1','A1'],x=>x.plan.cases[0].acceptanceIds=['bad id']]){
  const x=fixture();alter(x);assert.throws(()=>readVerifierPlan(x,hash),{code:'VERIFIER_PLAN_INVALID'});
 }
});
test('oracle view supports every approved JSON, prefix, regex, stderr and fixture expectation',()=>{
 const variants=[
  {expectedJson:{total:3,category:'餐饮'},label:'预期 JSON 结果'},
  {expectedStdoutPrefix:'USAGE',label:'预期标准输出前缀'},
  {expectedStdoutMatch:'^TICKED water \\d{4}-\\d{2}-\\d{2}\\n$',label:'预期标准输出正则'},
 ];
 for(const variant of variants){
  const x=fixture(),base=x.plan.cases[0];
  delete base.expectedStdout;
  Object.assign(base,variant,{expectedExitCode:1,expectedStderrMatch:'第 1 条记录：金额必须为整数。',fixtures:{'input.json':'{"amount":3}'}});
  const plan=readVerifierPlan(x,hash),html=verifierContent(plan);
  assert.match(html,new RegExp(variant.label));
  assert.ok(html.includes('预期标准错误正则'));
  assert.ok(html.includes('预置文件'));
  assert.ok(html.includes('input.json'));
  assert.ok(html.includes('A1'));
 }
});
test('oracle response refuses ambiguous, invalid or unsafe expectation forms',()=>{
 const alters=[
  x=>x.plan.cases[0].expectedStdoutPrefix='OK',
  x=>{delete x.plan.cases[0].expectedStdout;x.plan.cases[0].expectedStdoutMatch='(unclosed';},
  x=>{delete x.plan.cases[0].expectedStdout;x.plan.cases[0].expectedStdoutMatch='x'.repeat(301);},
  x=>{delete x.plan.cases[0].expectedStdout;x.plan.cases[0].expectedJson=Infinity;},
  x=>x.plan.cases[0].expectedStderrMatch='[',
  x=>{x.plan.cases[0].expectedStderr='x';x.plan.cases[0].expectedStderrPrefix='x';},
  x=>x.plan.cases[0].fixtures={},
  x=>x.plan.cases[0].fixtures={'../escape':'x'},
 ];
 for(const alter of alters){const x=fixture();alter(x);assert.throws(()=>readVerifierPlan(x,hash),{code:'VERIFIER_PLAN_INVALID'});}
});
