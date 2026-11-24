// Offline controller authority tests; no DSH model call or OS acceptance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutorTools } from '../dist/server/executor-tools.js';
import { harness, ready } from './helpers.mjs';
import { mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from '../dist/server/security.js';
import { treeHash } from '../dist/server/workspace.js';
import {captureSource} from '../dist/server/review-packet.js';
import {installPrework} from '../dist/server/prework/runtime.js';
import {ExecutorSlices} from '../dist/server/flow/executor-slices.js';
const archon='C:/Users/Hp/Documents/Archon_Astra_DSH_Source_Package/Archon_Astra_DSH_Source_Package';
// Explicit synthetic prework seed for low-level file authority tests only.
function offlinePrework(h,r,s){
 if(!r.tasks.length)r.tasks=[{id:'OFFLINE_FILE_TASK',title:'synthetic file fixture',status:'pending',dependsOn:[],requirementIds:s.requirements.map(x=>x.id),acceptance:['offline file authority'],writePaths:['main.mjs','src/']}];
 if(!h.store.records(r.projectId,'SourceSnapshot').some(x=>x.runId===r.id&&x.data.stage==='BASELINE'))h.store.record('SourceSnapshot',r.projectId,r.id,captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'BASELINE'));
 delete r.prework;r.treeHash=treeHash(r.workspace);h.store.saveRun(r);installPrework(h.store,r.id);
}
async function rig(t){
 const h=harness(t),{p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);
 await h.engine.cancel(r.id);await h.engine.settled(r.id);
 // Explicit offline seed, NEVER native readiness or Live approval.
 const run=h.store.run(r.id);run.state='IMPLEMENTING';run.phase='IMPLEMENTING';h.store.saveRun(run);h.store.acquire(p.id,r.id);
 const project=h.store.project(p.id);project.activeRunId=r.id;h.store.saveProject(project);
 mkdirSync(run.workspace,{recursive:true});writeFileSync(resolve(run.workspace,'main.mjs'),'console.log(1);\n');
 offlinePrework(h,run,s);
 const module=resolve(archon,'dist/provider/file-tools.js'),io=resolve(archon,'dist/core/io.js');
 const binding={modulePath:module,dependencies:[{path:module,sha256:hash(readFileSync(module))},{path:io,sha256:hash(readFileSync(io))}],readPaths:['main.mjs','src'],writePaths:['main.mjs','src']};
 const tools=await createExecutorTools(h.store,()=>h.config,r.id,binding,{run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}});
 return{h,run,tools,p,s,binding};
}

test('a planned delivery file outside the native policy is refused before any tool or model dispatch',async t=>{
 const f=await rig(t),run=f.h.store.run(f.run.id),before=treeHash(run.workspace),policy=structuredClone(f.binding);
 run.tasks=[{id:'SCRIPT',title:'script',status:'pending',dependsOn:[],requirementIds:[],acceptance:[],writePaths:['main.mjs']},
  {id:'DOC',title:'Chinese instructions',status:'pending',dependsOn:['SCRIPT'],requirementIds:[],acceptance:[],writePaths:['README.md']}];
 f.h.store.saveRun(run);const records=f.h.store.records(f.p.id).length;let kernelCalls=0;
 await assert.rejects(createExecutorTools(f.h.store,()=>f.h.config,run.id,f.binding,{run:async()=>{kernelCalls++;}}),{code:'EXECUTOR_FILE_POLICY_DENIED'});
 assert.equal(kernelCalls,0);assert.equal(f.h.store.records(f.p.id).length,records);assert.equal(treeHash(run.workspace),before);
 assert.deepEqual(f.binding,policy);assert.equal(existsSync(resolve(run.workspace,'README.md')),false);
});

test('read permission and a single allowed file cannot authorize a wider planned write directory',async t=>{
 const f=await rig(t),run=f.h.store.run(f.run.id);
 run.tasks=[{id:'DOC',title:'documentation',status:'pending',dependsOn:[],requirementIds:[],acceptance:[],writePaths:['docs/']}];f.h.store.saveRun(run);
 const policy={...f.binding,readPaths:['docs'],writePaths:['docs/approved.md']};
 await assert.rejects(createExecutorTools(f.h.store,()=>f.h.config,run.id,policy,{run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}}),{code:'EXECUTOR_FILE_POLICY_DENIED'});
 assert.equal(existsSync(resolve(run.workspace,'docs')),false);
});

test('an explicitly allowed missing file can be inspected and created with its empty expected hash',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 const missing=await f.tools.dispatch('executor','desk_read',{path:'src/new.txt'},signal);
 assert.deepEqual(missing,{exists:false,content:'',sha256:''});
 await f.tools.dispatch('executor','desk_write',{path:'src/new.txt',content:'new permitted file\n',expected_sha:missing.sha256},signal);
 assert.equal(readFileSync(resolve(f.run.workspace,'src/new.txt'),'utf8'),'new permitted file\n');
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'README.md'},signal));
 assert.equal(existsSync(resolve(f.run.workspace,'README.md')),false);
});
test('a controller slice writes only its own declared files and later canonical repair follows the merge checkpoint',async t=>{
 const f=await rig(t),run=f.h.store.run(f.run.id);run.tasks=[{id:'S',title:'scope',status:'pending',dependsOn:[],requirementIds:f.s.requirements.map(x=>x.id),acceptance:['exact bytes'],writePaths:['main.mjs']}];run.treeHash=treeHash(run.workspace);f.h.store.saveRun(run);
 offlinePrework(f.h,run,f.s);const slices=new ExecutorSlices(f.h.store,f.h.dir),wave=slices.prepare(run.id),a=wave.assignments[0],current=f.h.store.run(run.id);current.tasks[0].status='running';f.h.store.saveRun(current);
 const scoped=await createExecutorTools(f.h.store,()=>f.h.config,run.id,f.binding,{run:async()=>{throw Error('NO_OS_CALL');}},a.id),signal=new AbortController().signal;
 await assert.rejects(scoped.dispatch('executor','desk_write',{path:'src/other.mjs',content:'outside scope',expected_sha:''},signal),{code:'PREWORK_SCOPE_INVALID'});
 const read=await scoped.dispatch('executor','desk_read',{path:'main.mjs'},signal);await scoped.dispatch('executor','desk_write',{path:'main.mjs',content:'console.log(99);\n',expected_sha:read.sha256},signal);
 assert.equal(readFileSync(resolve(run.workspace,'main.mjs'),'utf8'),'console.log(1);\n');slices.seal(run.id,a.id);
 await assert.rejects(scoped.dispatch('executor','desk_read',{path:'main.mjs'},signal),{code:'EXECUTOR_SLICE_CLOSED'});
 slices.merge(run.id,wave.id,signal,()=>{},(r,sourceHash)=>{r.treeHash=sourceHash;r.state=r.phase='REPAIRING';r.tasks[0].status='implemented';});
 const repair=await createExecutorTools(f.h.store,()=>f.h.config,run.id,f.binding,{run:async()=>{throw Error('NO_OS_CALL');}});
 assert.equal((await repair.dispatch('executor','desk_read',{path:'main.mjs'},signal)).content,'console.log(99);\n');
});

test('a task slice refuses its ninth tool before intent or write, including after controller reconstruction',async t=>{
 const f=await rig(t),run=f.h.store.run(f.run.id);
 run.tasks=[{id:'S',title:'one bounded task',status:'pending',dependsOn:[],requirementIds:f.s.requirements.map(x=>x.id),acceptance:['bounded tools'],writePaths:['main.mjs','src/']}];
 run.treeHash=treeHash(run.workspace);f.h.store.saveRun(run);
 offlinePrework(f.h,run,f.s);const slices=new ExecutorSlices(f.h.store,f.h.dir),wave=slices.prepare(run.id),assignment=wave.assignments[0],current=f.h.store.run(run.id);
 current.tasks[0].status='running';f.h.store.saveRun(current);
 const kernel={run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}},signal=new AbortController().signal;
 const scoped=await createExecutorTools(f.h.store,()=>f.h.config,run.id,f.binding,kernel,assignment.id);
 for(let i=0;i<8;i++)assert.equal((await scoped.dispatch('executor','desk_read',{path:'main.mjs'},signal)).content,'console.log(1);\n');
 const reopened=await createExecutorTools(f.h.store,()=>f.h.config,run.id,f.binding,kernel,assignment.id);
 await assert.rejects(reopened.dispatch('executor','desk_write',{path:'src/ninth.mjs',content:'must not be written',expected_sha:''},signal),{code:'EXECUTOR_TASK_TOOL_LIMIT'});
 assert.equal(existsSync(resolve(assignment.workspace,'src/ninth.mjs')),false);
 assert.equal(f.h.store.records(f.p.id,'ToolIntent').filter(r=>r.runId===run.id&&r.data.sliceId===assignment.id).length,8);
});
test('reused file tools require current executor, frozen approvals and active writer lease',async t=>{
 const f=await rig(t);const read=await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},new AbortController().signal);
 assert.equal(read.content,'console.log(1);\n');assert.equal(read.sha256,hash(read.content));
 await assert.rejects(f.tools.dispatch('reviewer','desk_write',{path:'main.mjs',content:'changed',expected_sha:read.sha256},new AbortController().signal),{code:'EXECUTOR_ROLE_REQUIRED'});
 f.h.store.release(f.run.projectId,f.run.id);
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs'},new AbortController().signal),{code:'WORKSPACE_LEASE_LOST'});
});

test('new Classic tools share the Engine fingerprint while P1 remains independent',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 assert.equal(f.run.flowName,'classic');f.h.config.planner1.model='changed-independent-p1';
 assert.equal((await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal)).content,'console.log(1);\n');
 f.h.config.codex.model='changed-engineering-model';
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal),{code:'RUN_CONFIG_CHANGED'});
});
test('stale content, secret/path escalation and phase changes refuse mutation',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 const read=await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal);
 writeFileSync(resolve(f.run.workspace,'main.mjs'),'outside edit\n');
 await assert.rejects(f.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'new',expected_sha:read.sha256},signal));
 await assert.rejects(f.tools.dispatch('executor','desk_write',{path:'../auth.json',content:'x',expected_sha:''},signal));
 await assert.rejects(f.tools.dispatch('executor','desk_write',{path:'src/x.txt',content:'sk-SYNTHETIC_TOOL_SECRET',expected_sha:''},signal),{code:'SECRET_IN_TOOL_INPUT'});
 const r=f.h.store.run(f.run.id);r.state='REVIEWING';f.h.store.saveRun(r);
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal),{code:'EXECUTOR_PHASE_NOT_ACTIVE'});
});
test('tool command never falls back to host shell and cancellation blocks before dispatch',async t=>{
 const f=await rig(t);
 await assert.rejects(f.tools.dispatch('executor','powershell',{command:'whoami'},new AbortController().signal),{code:'EXECUTOR_TOOL_DENIED'});
 await assert.rejects(f.tools.dispatch('executor','desk_run',{runtime:'sh',entry:'main.sh',args:[],stdin:''},new AbortController().signal));
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs'},AbortSignal.abort()),{code:'RUN_CANCELLED'});
});
test('authorized read-modify-write commits exact bytes and records source-bound result',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 const before=await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal);
 const write=await f.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'console.log(42);\n',expected_sha:before.sha256},signal);
 assert.equal(write.sha256,hash('console.log(42);\n'));
 assert.equal(readFileSync(resolve(f.run.workspace,'main.mjs'),'utf8'),'console.log(42);\n');
 assert.ok(f.h.store.records(f.p.id,'ToolResult').some(r=>r.data.status==='COMPLETE'));
});
test('lost lease at final commit prevents rename rather than reporting after unauthorized write',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 const before=await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal);
 const tx=f.h.store.tx.bind(f.h.store);f.h.store.tx=fn=>{f.h.store.release(f.run.projectId,f.run.id);return tx(fn);};
 await assert.rejects(f.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'new',expected_sha:before.sha256},signal),{code:'WORKSPACE_LEASE_LOST'});
 assert.equal(readFileSync(resolve(f.run.workspace,'main.mjs'),'utf8'),before.content);
});
test('raw whitespace edit and latest configuration binding are preserved',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 await f.tools.dispatch('executor','desk_write',{path:'src/test.txt',content:'  before  \n',expected_sha:''},signal);
 const before=await f.tools.dispatch('executor','desk_read',{path:'src/test.txt'},signal);
 await f.tools.dispatch('executor','desk_edit',{path:'src/test.txt',old_text:'  before  ',new_text:'  after  ',expected_sha:before.sha256},signal);
 assert.equal(readFileSync(resolve(f.run.workspace,'src/test.txt'),'utf8'),'  after  \n');
 f.h.config.limits.maxCalls++;
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal),{code:'RUN_CONFIG_CHANGED'});
});

test('controller rejects undeclared arguments before intent or side effect',async t=>{
 const f=await rig(t);
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs',role:'reviewer'},new AbortController().signal),{code:'INVALID_TOOL_ARGUMENTS'});
 assert.equal(f.h.store.records(f.p.id,'ToolIntent').filter(r=>r.runId===f.run.id).length,0);
});

test('persistent tool limit does not reset when controller binding is reconstructed',async t=>{
 const f=await rig(t);
 for(let i=0;i<128;i++){
  const sourceHash=treeHash(f.run.workspace);
  const intent=f.h.store.record('ToolIntent',f.p.id,f.run.id,{tool:'desk_read',sourceHash});
  f.h.store.record('ToolResult',f.p.id,f.run.id,{intentId:intent,status:'COMPLETE',sourceHash});
 }
 const reopened=await createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,{run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}});
 await assert.rejects(reopened.dispatch('executor','desk_read',{path:'main.mjs'},new AbortController().signal),{code:'EXECUTOR_TOOL_LIMIT'});
});

// A repair turn could not touch the workspace once the flat 128-call budget was spent while implementing:
// run_7ed78beaa126a811a1f3 answered every tool call with EXECUTOR_TOOL_LIMIT and was blocked with the fix
// it needed still undone. The allowance now grows with the run's substantive repair count.
test('a repair turn gets its own tool allowance instead of inheriting an exhausted one',async t=>{
 const f=await rig(t);
 for(let i=0;i<128;i++){
  const sourceHash=treeHash(f.run.workspace);
  const intent=f.h.store.record('ToolIntent',f.p.id,f.run.id,{tool:'desk_read',sourceHash});
  f.h.store.record('ToolResult',f.p.id,f.run.id,{intentId:intent,status:'COMPLETE',sourceHash});
 }
 const unchanged=await createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,{run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}});
 await assert.rejects(unchanged.dispatch('executor','desk_read',{path:'main.mjs'},new AbortController().signal),{code:'EXECUTOR_TOOL_LIMIT'});
 const repaired=f.h.store.run(f.run.id);repaired.repairCount=1;f.h.store.saveRun(repaired);
 const tools=await createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,{run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}});
 const read=await tools.dispatch('executor','desk_read',{path:'main.mjs'},new AbortController().signal);
 assert.equal(read.content,'console.log(1);\n');
});

// The base allowance is per PLAN, not a flat 128: an eight-task plan had already spent 128 calls at six tasks
// (run_14c86e9a9ad51c0ff495) and would have starved the last two.
test('the tool allowance scales with how many tasks the plan declared', async t => {
 const f=await rig(t);
 for(let i=0;i<128;i++){
  const sourceHash=treeHash(f.run.workspace);
  const intent=f.h.store.record('ToolIntent',f.p.id,f.run.id,{tool:'desk_read',sourceHash});
  f.h.store.record('ToolResult',f.p.id,f.run.id,{intentId:intent,status:'COMPLETE',sourceHash});
 }
 const one=await createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,{run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}});
 await assert.rejects(one.dispatch('executor','desk_read',{path:'main.mjs'},new AbortController().signal),{code:'EXECUTOR_TOOL_LIMIT'});
 const planned=f.h.store.run(f.run.id);
 planned.tasks=Array.from({length:8},(_,i)=>({id:'T'+(i+1),title:'t',dependsOn:i?['T'+i]:[],requirementIds:f.s.requirements.map(x=>x.id),acceptance:['x'],writePaths:['main.mjs'],status:'pending'}));
 f.h.store.saveRun(planned);offlinePrework(f.h,planned,f.s);
 const scaled=await createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,{run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}});
 const read=await scaled.dispatch('executor','desk_read',{path:'main.mjs'},new AbortController().signal);
 assert.equal(read.content,'console.log(1);\n','an eight-task plan gets 320 calls, so 128 spent is not the end');
});

test('post-write evidence failure freezes current and reopened sessions without blind replay',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 const before=await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal);
 const event=f.h.store.event.bind(f.h.store);
 f.h.store.event=(...args)=>{if(args[2]==='executor.tool.completed')throw Error('SYNTHETIC_JOURNAL_FAILURE');return event(...args);};
 await assert.rejects(f.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'changed\n',expected_sha:before.sha256},signal));
 assert.equal(readFileSync(resolve(f.run.workspace,'main.mjs'),'utf8'),'changed\n');
 assert.ok(f.h.store.records(f.p.id,'ToolResult').some(r=>r.data.status==='UNKNOWN_EFFECT'));
 await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal),{code:'TOOL_RECOVERY_REQUIRED'});
 await assert.rejects(createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,{run:async()=>{}}),{code:'TOOL_RECOVERY_REQUIRED'});
});

test('secret-bearing isolated command output is refused rather than returned to runtime',async t=>{
 const f=await rig(t);
 const tools=await createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,{run:async()=>({stdout:'sk-SYNTHETIC_TOOL_SECRET'})});
 await assert.rejects(tools.dispatch('executor','desk_run',{runtime:'node',entry:'main.mjs',args:[],stdin:''},new AbortController().signal),{code:'SECRET_IN_TOOL_OUTPUT'});
});

test('two controller handles share the same persistent active-intent fence',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 let entered,finish;const started=new Promise(r=>entered=r),waiting=new Promise(r=>finish=r);
 const another=await createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,{run:async()=>{entered();await waiting;return{stdout:'ok'};}});
 const pending=another.dispatch('executor','desk_run',{runtime:'node',entry:'main.mjs',args:[],stdin:''},signal);
 await started;
 try{await assert.rejects(f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal),{code:'TOOL_RECOVERY_REQUIRED'});}
 finally{finish();await pending;}
});

test('exact edit treats dollar replacement tokens as literal source bytes',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 const before=await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal);
 await f.tools.dispatch('executor','desk_edit',{path:'main.mjs',old_text:'console.log(1);',new_text:'$& $$ $` $\u0027',expected_sha:before.sha256},signal);
 assert.equal(readFileSync(resolve(f.run.workspace,'main.mjs'),'utf8'),'$& $$ $` $\u0027\n');
});

test('desk_edit safely restores redundant JSON quote escapes from a unique read result',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 await f.tools.dispatch('executor','desk_write',{path:'src/test.txt',content:'错误：不支持的参数：["--file"]。\n',expected_sha:''},signal);
 const before=await f.tools.dispatch('executor','desk_read',{path:'src/test.txt'},signal);
 await f.tools.dispatch('executor','desk_edit',{
  path:'src/test.txt',
  old_text:'错误：不支持的参数：[\\"--file\\"]。',
  new_text:'错误：不支持的参数：\\"--file\\" \\"records.json\\"。',
  expected_sha:before.sha256
 },signal);
 assert.equal(readFileSync(resolve(f.run.workspace,'src/test.txt'),'utf8'),'错误：不支持的参数："--file" "records.json"。\n');
});

test('normalized JSON quote display still cannot authorize an ambiguous edit',async t=>{
 const f=await rig(t),signal=new AbortController().signal,line='错误：不支持的参数：["--file"]。\n';
 await f.tools.dispatch('executor','desk_write',{path:'src/test.txt',content:line+line,expected_sha:''},signal);
 const before=await f.tools.dispatch('executor','desk_read',{path:'src/test.txt'},signal);
 await assert.rejects(f.tools.dispatch('executor','desk_edit',{
  path:'src/test.txt',old_text:'错误：不支持的参数：[\\"--file\\"]。',new_text:'changed',expected_sha:before.sha256
 },signal),{code:'STALE_OR_AMBIGUOUS_EDIT'});
 assert.equal(readFileSync(resolve(f.run.workspace,'src/test.txt'),'utf8'),line+line);
});

test('reconstruction binds the persisted source checkpoint instead of blessing external edits',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 const before=await f.tools.dispatch('executor','desk_read',{path:'main.mjs'},signal);
 await f.tools.dispatch('executor','desk_write',{path:'main.mjs',content:'approved change\n',expected_sha:before.sha256},signal);
 const kernel={run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}};
 const reopened=await createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,kernel);
 assert.equal((await reopened.dispatch('executor','desk_read',{path:'main.mjs'},signal)).content,'approved change\n');
 writeFileSync(resolve(f.run.workspace,'main.mjs'),'outside restart edit\n');
 await assert.rejects(createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,kernel),{code:'EXTERNAL_WORKSPACE_CHANGE'});
});

test('unknown sandbox cleanup freezes dispatch and cannot be relabeled no effect',async t=>{
 const f=await rig(t),signal=new AbortController().signal;
 const tools=await createExecutorTools(f.h.store,()=>f.h.config,f.run.id,f.binding,{run:async()=>{throw Error('SYNTHETIC_CLEANUP_UNKNOWN');}});
 await assert.rejects(tools.dispatch('executor','desk_run',{runtime:'node',entry:'main.mjs',args:[],stdin:''},signal));
 assert.ok(f.h.store.records(f.p.id,'ToolResult').some(r=>r.data.status==='UNKNOWN_EFFECT'));
 await assert.rejects(tools.dispatch('executor','desk_read',{path:'main.mjs'},signal),{code:'TOOL_RECOVERY_REQUIRED'});
});
