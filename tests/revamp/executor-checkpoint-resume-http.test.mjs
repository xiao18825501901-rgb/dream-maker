// Actual loopback HTTP/SQLite with an explicitly OFFLINE interrupted-task fixture. No model dispatch.
// The resume endpoint leaves a retained checkpoint through the original Engine; it never merges,
// seals, accepts or calls a model, and a repeated key replays the recorded recovery.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {checkpointReasons} from '../../dist/server/flow/executor-slices.js';
import {interruptedTask} from '../fixtures/interrupted-task.mjs';import {root,until} from '../helpers.mjs';
async function setup(t,product='dream-maker'){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'checkpoint-resume-http-'));let nativeCalls=0;
 const denied=()=>{nativeCalls++;throw Error('NO_MODEL_AUTHORITY_IN_CHECKPOINT_RESUME_TEST');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),product,port:0,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const f=await interruptedTask(t,{h:{...app,dir:data,config:app.settings.value}});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,headers={})=>{const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:body?JSON.stringify(body):undefined});return{status:response.status,body:await response.json()};};
 return{...f,app,call,path:'/runs/'+f.run.id+'/executor-checkpoint/resume',nativeCalls:()=>nativeCalls};
}
test('the resume endpoint reuses one reason set and refuses everything but the documented checkpoint block',async t=>{
 assert.deepEqual([...checkpointReasons].sort(),['EXECUTOR_SLICE_RESULT_UNCERTAIN','EXECUTOR_TASK_TOOL_LIMIT','PROCESS_CLEANUP_UNPROVEN','USER_BUDGET_LIMIT','WORKER_RESTART_RESULT_UNCERTAIN']);
 const {app,call,path,run}=await setup(t),before={run:app.store.run(run.id),records:app.store.records(run.projectId).length};
 assert.equal((await fetch(app.origin+'/api'+path,{method:'POST',headers:{'content-type':'application/json'},body:'{"confirmed":true}'})).status,401);
 const csrf=await call(path,{confirmed:true},{'x-csrf-token':'bad'});assert.equal(csrf.status,403);assert.equal(csrf.body.error,'CSRF_DENIED');
 const key=await call(path,{confirmed:true},{'idempotency-key':''});assert.equal(key.status,400);assert.equal(key.body.error,'IDEMPOTENCY_KEY_REQUIRED');
 const consent=await call(path,{});assert.equal(consent.status,403);assert.equal(consent.body.error,'EXECUTOR_CHECKPOINT_CONSENT_REQUIRED');
 const extra=await call(path,{confirmed:true,path:'untrusted'});assert.equal(extra.status,400);assert.equal(extra.body.error,'EXECUTOR_CHECKPOINT_INPUT_INVALID');
 assert.deepEqual(app.store.run(run.id),before.run);assert.equal(app.store.records(run.projectId).length,before.records);
});
test('a run that is not BLOCKED is refused, and nothing is resumed',async t=>{
 const {app,call,path,run}=await setup(t),paused=app.store.run(run.id);paused.state='PAUSED';app.store.saveRun(paused);
 const response=await call(path,{confirmed:true});
 assert.equal(response.status,409);assert.equal(response.body.error,'EXECUTOR_CHECKPOINT_RESUME_NOT_BLOCKED');
 assert.equal(app.store.records(run.projectId,'ExecutorCheckpointResumed').length,0);assert.equal(app.store.owns(run.projectId,run.id),true);
});
test('a block outside the shared reason set is refused and keeps its reason',async t=>{
 const {app,call,path,run}=await setup(t),other=app.store.run(run.id);other.reason='RUN_CALL_BUDGET_EXCEEDED';app.store.saveRun(other);
 const response=await call(path,{confirmed:true});
 assert.equal(response.status,409);assert.equal(response.body.error,'EXECUTOR_CHECKPOINT_RESUME_NOT_RECOVERABLE');
 assert.equal(app.store.run(run.id).reason,'RUN_CALL_BUDGET_EXCEEDED');assert.equal(app.store.records(run.projectId,'ExecutorCheckpointResumed').length,0);
});
test('an unknown run is refused by the original Store lookup',async t=>{
 const {call}=await setup(t);
 const response=await call('/runs/run_0000000000000000/executor-checkpoint/resume',{confirmed:true});
 assert.equal(response.status,404);assert.equal(response.body.error,'RUN_NOT_FOUND');
});
test('a run that is not the active run of its project is refused',async t=>{
 const {app,call,path,run}=await setup(t),project=app.store.project(run.projectId);project.activeRunId=null;app.store.saveProject(project);
 const response=await call(path,{confirmed:true});
 assert.equal(response.status,409);assert.equal(response.body.error,'EXECUTOR_CHECKPOINT_RESUME_NOT_ACTIVE');
});
test('without the retained wave record there is nothing to resume',async t=>{
 const {app,call,path,run}=await setup(t);
 app.store.db.prepare("DELETE FROM records WHERE kind='ExecutorWavePrepared' AND run_id=?").run(run.id);
 const response=await call(path,{confirmed:true});
 assert.equal(response.status,409);assert.equal(response.body.error,'EXECUTOR_CHECKPOINT_RESUME_NOT_RETAINED');
 assert.equal(app.store.records(run.projectId,'ExecutorCheckpointResumed').length,0);
});
test('the same custody the preview reads still decides: a changed wave manifest is refused',async t=>{
 const {app,call,path,run,wave}=await setup(t),manifest=resolve(wave.directory,'wave.json');
 writeFileSync(manifest,readFileSync(manifest,'utf8').replace('executor_wave','executor_wavX'));
 const response=await call(path,{confirmed:true});
 assert.equal(response.status,409);assert.equal(response.body.error,'EXECUTOR_SLICE_BINDING_CHANGED');
 assert.equal(app.store.records(run.projectId,'ExecutorCheckpointResumed').length,0);
});
test('a recoverable checkpoint resumes the frozen Flow and records exactly that',async t=>{
 const {app,call,path,run}=await setup(t),before=app.store.run(run.id),key=crypto.randomUUID();
 const response=await call(path,{confirmed:true},{'idempotency-key':key}),result=response.body;
 assert.equal(response.status,200);
 assert.equal(result.schema,'dream-maker.executor-checkpoint-resume-result.v1');assert.equal(result.runId,run.id);
 assert.equal(result.reason,'EXECUTOR_SLICE_RESULT_UNCERTAIN');assert.deepEqual(result.taskIds,['A']);assert.deepEqual(result.waveTaskIds,['A','B']);
 assert.equal(result.state,'IMPLEMENTING');assert.equal(result.phase,'IMPLEMENTING');assert.equal(result.attempt,before.attempt+1);assert.equal(result.runVersion,before.version+1);
 assert.equal(result.replayed,false);assert.equal(result.modelsCalled,0);assert.equal(result.automaticResume,false);assert.equal(result.taskCompletionAssumed,false);
 const records=app.store.records(run.projectId,'ExecutorCheckpointResumed');assert.equal(records.length,1);
 assert.deepEqual([records[0].data.runId,records[0].data.reason,records[0].data.taskIds],[run.id,'EXECUTOR_SLICE_RESULT_UNCERTAIN',['A']]);
 assert.match(String(records[0].data.at),/^\d{4}-\d{2}-\d{2}T/);assert.equal(records[0].data.modelsCalled,0);assert.equal(records[0].data.automaticResume,false);
 const events=app.store.events(run.projectId).filter(event=>event.type==='run.executor.checkpoint.resumed');assert.equal(events.length,1);
 assert.equal(events[0].payload.state,'IMPLEMENTING');assert.equal(events[0].payload.reason,null);assert.equal(events[0].payload.attempt,before.attempt+1);
 assert.equal(app.store.owns(run.projectId,run.id),true);
 assert.doesNotMatch(JSON.stringify(app.store.db.prepare('SELECT response FROM requests').all()),/EXECUTOR_SLICE_RESULT_UNCERTAIN|taskIds/);
 await until(()=>app.store.run(run.id).version>result.runVersion,6000);
});
test('the same idempotency key replays the recorded recovery; a new key cannot resume twice',async t=>{
 const {app,call,path,run}=await setup(t),key=crypto.randomUUID();
 const first=await call(path,{confirmed:true},{'idempotency-key':key}),second=await call(path,{confirmed:true},{'idempotency-key':key});
 assert.equal(first.status,200);assert.equal(second.status,200);assert.equal(second.body.replayed,true);
 assert.deepEqual(second.body.taskIds,first.body.taskIds);assert.deepEqual(second.body.waveTaskIds,first.body.waveTaskIds);
 assert.equal(second.body.attempt,first.body.attempt);assert.equal(second.body.runVersion,first.body.runVersion);
 assert.equal(app.store.records(run.projectId,'ExecutorCheckpointResumed').length,1);
 assert.equal(app.store.events(run.projectId).filter(event=>event.type==='run.executor.checkpoint.resumed').length,1);
 const third=await call(path,{confirmed:true});
 assert.equal(third.status,409);assert.ok(['EXECUTOR_CHECKPOINT_RESUME_NOT_BLOCKED','EXECUTOR_CHECKPOINT_RESUME_NOT_RECOVERABLE'].includes(third.body.error));
 assert.equal(app.store.records(run.projectId,'ExecutorCheckpointResumed').length,1);
});
for(const product of ['dream-maker','dreamflow'])test('the '+product+' resume stays inside the frozen plan, for explicit offline evidence only',async t=>{
 const {app,call,path,run}=await setup(t,product),before=app.store.run(run.id);
 const response=await call(path,{confirmed:true});
 assert.equal(response.status,200);assert.equal(response.body.schema,'dream-maker.executor-checkpoint-resume-result.v1');
 assert.equal(app.store.run(run.id).tasks.filter(task=>task.status==='done').length,0);
 assert.equal(app.store.records(run.projectId,'ExecutorMergeApplied').length,0);
 assert.equal(app.store.records(run.projectId,'ExecutorWavePrepared').filter(row=>row.data.checkpointOrigin!==undefined).length,0);
 assert.equal(app.store.run(run.id).plan??null,before.plan??null);
});
