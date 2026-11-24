import {seedOfflinePlannerIdentity} from '../fixtures/offline-prework.mjs';
// OFFLINE regression from R5's actual rejected P2 plan. No native/model/account qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {harness,ready} from '../helpers.mjs';
import {validatePlan} from '../../dist/server/engine.js';
import {validateWritePaths} from '../../dist/server/flow/executor-slices.js';
import {DomainError,hash} from '../../dist/server/security.js';

const task=(id,ids,writePaths)=>({id,title:id,dependsOn:[],requirementIds:ids,acceptance:['OFFLINE_OBSERVABLE_CHECK'],writePaths});
const forbidden=[[],['../outside'],['.git/'],['node_modules/'],['.env'],['src/*'],['a','A']];

test('plan boundary classifies rejected scopes without weakening the executor write guard',()=>{
 for(const scope of forbidden){
  assert.throws(()=>validateWritePaths(scope),{code:'EXECUTOR_WRITE_SCOPE_INVALID'});
  assert.throws(()=>validatePlan({tasks:[task('T1',['R001'],scope)]},['R001']),{code:'PLAN_WRITE_SCOPE_INVALID'});
 }
 assert.deepEqual(validatePlan({tasks:[task('T1',['R001'],['main.mjs'])]},['R001'])[0].writePaths,['main.mjs']);
});

test('frozen project tasks cannot be omitted or have their dependency contract changed',()=>{
 const frozen=[
  {id:'T001',title:'Implement main.mjs',dependsOn:[],requirementIds:['R001'],check:'CLI works'},
  {id:'T002',title:'Write README.md',dependsOn:['T001'],requirementIds:['R002'],check:'README exists'},
 ];
 assert.throws(()=>validatePlan({tasks:[task('T001',['R001'],['main.mjs']),task('EXTRA',['R002'],['notes.md'])]},['R001','R002'],frozen),{code:'PLAN_PROJECT_TASK_OMITTED'});
 assert.throws(()=>validatePlan({tasks:[task('T001',['R001'],['main.mjs']),{...task('T002',['R002'],['README.md']),dependsOn:[]}]},['R001','R002'],frozen),{code:'PLAN_PROJECT_TASK_CHANGED'});
 assert.deepEqual(
  validatePlan({tasks:[task('T001',['R001'],['main.mjs']),{...task('T002',['R002'],['README.md']),dependsOn:['T001']}]},['R001','R002'],frozen).map(value=>value.id),
  ['T001','T002'],
 );
});

async function rig(t){
 const h=harness(t),{p,s}=await ready(h);
 // Isolated controller-loop seam: no live admission is supplied or bypassed in the product.
 // Suppress launch and provide explicit offline role outputs to test only planning corrections.
 h.engine.launch=()=>{};const created=h.engine.create(p.id,s.hash,true),run=h.store.run(created.id);
 run.mode='live';h.store.saveRun(run);seedOfflinePlannerIdentity(h,run.id);
 const ids=s.requirements.map(x=>x.id),implementation=task('T1',ids,['main.mjs']);
 const rejected={tasks:[implementation,{...task('T5',ids,[]),title:'控制器验收与独立审查',dependsOn:['T1']}]};
 return{h,s,run,rejected,corrected:{tasks:[implementation]},specBefore:hash(h.store.spec(s.id))};
}

test('Classic feeds an empty-scope controller task back once, then dispatches only a corrected implementation',async t=>{
 const x=await rig(t),prompts=[];let executor=0;
 x.h.engine.role=async(_run,role,prompt)=>{
  if(role==='planner2'){prompts.push(prompt);return structuredClone(prompts.length===1?x.rejected:x.corrected);}
  if(role==='executor'){executor++;throw new DomainError('OFFLINE_STOP_BEFORE_EXECUTOR_MODEL',409);}
  throw Error('UNEXPECTED_OFFLINE_ROLE');
 };
 await x.h.engine.loop(x.run.id,new AbortController().signal);
 assert.equal(prompts.length,2);assert.equal(executor,1);
 assert.match(prompts[1],/PLAN_WRITE_SCOPE_INVALID/);
 const current=x.h.store.run(x.run.id);
 assert.equal(current.phase,'IMPLEMENTING');assert.equal(current.reason,'OFFLINE_STOP_BEFORE_EXECUTOR_MODEL');
 assert.deepEqual(current.tasks.map(t=>t.id),['T1']);
 assert.equal(hash(x.h.store.spec(x.s.id)),x.specBefore);
 assert.equal(x.h.store.records(x.run.projectId,'Review').length,0);
 assert.equal(x.h.store.records(x.run.projectId,'Evidence').length,0);
});

test('a second invalid plan stops without executing or granting an empty write scope',async t=>{
 const x=await rig(t);let plans=0,executor=0;
 x.h.engine.role=async(_run,role)=>{if(role==='planner2'){plans++;return structuredClone(x.rejected);}executor++;throw Error('MUST_NOT_DISPATCH');};
 await x.h.engine.loop(x.run.id,new AbortController().signal);
 assert.equal(plans,2);assert.equal(executor,0);
 const current=x.h.store.run(x.run.id);assert.equal(current.state,'BLOCKED');assert.equal(current.phase,'PLANNING');
 assert.equal(current.reason,'PLAN_WRITE_SCOPE_INVALID');assert.deepEqual(current.tasks,[]);assert.equal(current.repairCount,0);
});

test('source writes by a planner remain fatal and never enter the shape-correction path',async t=>{
 const x=await rig(t);let plans=0;
 x.h.engine.role=async(_run,role)=>{assert.equal(role,'planner2');plans++;writeFileSync(resolve(x.run.workspace,'planner-write.txt'),'OFFLINE_UNAUTHORIZED_WRITE');return structuredClone(x.rejected);};
 await x.h.engine.loop(x.run.id,new AbortController().signal);
 assert.equal(plans,1);assert.equal(x.h.store.run(x.run.id).reason,'PLANNER_WROTE_SOURCE');
 assert.equal(readFileSync(resolve(x.run.workspace,'planner-write.txt'),'utf8'),'OFFLINE_UNAUTHORIZED_WRITE');
});

// R17: a real P2 turn issued one read-only code-mode tool call (`exec` -> list_mcp_resources, output
// was an empty resource list) instead of the JSON plan. The data-only guard refuses any non-message
// item, which is correct, but the refusal has no side effect and the run still owned one correction
// attempt. Blocking on the first occurrence burned the whole dispatch.
test('Classic feeds an unexpected-tool planning refusal back once, then accepts the corrected plan',async t=>{
 const x=await rig(t),prompts=[];let executor=0;
 x.h.engine.role=async(_run,role,prompt)=>{
  if(role==='planner2'){
   prompts.push(prompt);
   if(prompts.length===1)throw new DomainError('CODEX_UNEXPECTED_TOOL',409);
   return structuredClone(x.corrected);
  }
  if(role==='executor'){executor++;throw new DomainError('OFFLINE_STOP_BEFORE_EXECUTOR_MODEL',409);}
  throw Error('UNEXPECTED_OFFLINE_ROLE');
 };
 await x.h.engine.loop(x.run.id,new AbortController().signal);
 assert.equal(prompts.length,2);assert.equal(executor,1);
 assert.match(prompts[1],/CODEX_UNEXPECTED_TOOL/);
 const current=x.h.store.run(x.run.id);
 assert.equal(current.phase,'IMPLEMENTING');assert.equal(current.reason,'OFFLINE_STOP_BEFORE_EXECUTOR_MODEL');
 assert.deepEqual(current.tasks.map(t=>t.id),['T1']);
 assert.equal(hash(x.h.store.spec(x.s.id)),x.specBefore);
});

test('a repeated unexpected-tool refusal stops the run instead of retrying forever',async t=>{
 const x=await rig(t);let plans=0,executor=0;
 x.h.engine.role=async(_run,role)=>{if(role==='planner2'){plans++;throw new DomainError('CODEX_UNEXPECTED_TOOL',409);}executor++;throw Error('MUST_NOT_DISPATCH');};
 await x.h.engine.loop(x.run.id,new AbortController().signal);
 assert.equal(plans,2);assert.equal(executor,0);
 const current=x.h.store.run(x.run.id);
 assert.equal(current.state,'BLOCKED');assert.equal(current.phase,'PLANNING');
 assert.equal(current.reason,'CODEX_UNEXPECTED_TOOL');assert.deepEqual(current.tasks,[]);assert.equal(current.repairCount,0);
});

test('planner sees the actual approved version and controller responsibilities without changing the frozen proposal',async t=>{
 const x=await rig(t);let prompt='';
 x.h.engine.role=async(_run,role,value)=>{assert.equal(role,'planner2');prompt=value;throw new DomainError('OFFLINE_CAPTURE_PROMPT_ONLY',409);};
 await x.h.engine.loop(x.run.id,new AbortController().signal);
 assert.match(prompt,/APPROVED PLAN VERSION/);assert.ok(prompt.includes(x.h.store.planVersion(x.s.id).contentHash));
 assert.match(prompt,/non-empty writePaths/);assert.match(prompt,/controller-owned verification and independent review are not executor tasks/i);
 assert.equal(hash(x.h.store.spec(x.s.id)),x.specBefore);
});

test('Classic rejects an omitted frozen project task before Prework and corrects it once',async t=>{
 const x=await rig(t),ids=x.s.requirements.map(value=>value.id);
 const spec=structuredClone(x.s);
 spec.projectPlan={tasks:[{id:'T1',title:'Implement main.mjs',dependsOn:[],requirementIds:ids,check:'main.mjs exists'},{id:'T002',title:'Write README.md',dependsOn:['T1'],requirementIds:[ids[0]],check:'README.md exists'}]};
 const originalSpec=x.h.store.spec.bind(x.h.store);
 x.h.store.spec=id=>id===spec.id?spec:originalSpec(id);
 const prompts=[];
 x.h.engine.role=async(_run,role,prompt)=>{
  if(role==='planner2'){
   prompts.push(prompt);
   const tasks=[task('T1',ids,['main.mjs'])];
   if(prompts.length===2)tasks.push({...task('T002',[ids[0]],['README.md']),dependsOn:['T1']});
   return{tasks};
  }
  if(role==='executor')throw new DomainError('OFFLINE_STOP_BEFORE_EXECUTOR_MODEL',409);
  throw Error('UNEXPECTED_OFFLINE_ROLE');
 };
 await x.h.engine.loop(x.run.id,new AbortController().signal);
 assert.equal(prompts.length,2);
 assert.match(prompts[0],/FROZEN PROJECT TASKS/);
 assert.match(prompts[0],/T002/);
 assert.match(prompts[1],/PLAN_PROJECT_TASK_OMITTED/);
 assert.deepEqual(x.h.store.run(x.run.id).tasks.map(value=>value.id),['T1','T002']);
 assert.ok(x.h.store.run(x.run.id).prework);
});
