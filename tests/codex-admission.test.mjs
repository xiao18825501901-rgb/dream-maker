// OFFLINE wire tests; this child is not Codex and never makes model requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {CodexRunner} from '../dist/server/providers/codex.js';
import {RpcPeer} from '../dist/server/providers/rpc.js';
import {harness,root} from './helpers.mjs';
function setup(t,mode='success'){
 const h=harness(t),c=h.config,policyFile=resolve(h.dir,'codex-role-policy.toml');
 writeFileSync(policyFile,readFileSync(resolve(root,'config/codex-agent-windows-readonly.toml'),'utf8').replaceAll('dream-maker-source-read','fixture-source-read'));
 c.codex={command:process.execPath,args:[resolve(root,'tests/fixtures/codex-wire.mjs'),mode],home:h.dir,model:'fixture-not-a-model',permissionProfile:'fixture-source-read',policyFile};// Spawning a child per case is contention-sensitive: a 1s step timeout made the
// quota-denied case flake into CODEX_TURN_TIMEOUT under the full parallel suite. The
// assertion is unchanged; only the deadline is realistic for a loaded machine.
// The stall case needs a short deadline; every other case only needs one long enough not to lose the
// CPU race in the full parallel suite (4s again flaked at 610 tests). Assertions are unchanged.
c.limits.stepTimeoutMs=mode==='account-stall'?4000:12000;
 const input={workspace:h.dir,prompt:'supplied frozen data only',model:c.codex.model,specHash:'fixture',runId:'fixture',role:'planner2',laya:{adoption:'off'},signal:new AbortController().signal};
 return {h,input,c,runner:new CodexRunner(()=>c,root),calls:()=>readFileSync(resolve(h.dir,'codex-fixture-requests.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x).method)};
}
for(const [mode,code,turnStarted] of [
 ['api-account','CODEX_SUBSCRIPTION_ACCOUNT_REQUIRED',false],
 ['model-not-listed','CODEX_MODEL_NOT_LISTED',false],
 ['quota-null','CODEX_INCLUDED_USAGE_UNAVAILABLE',false],['quota-denied','CODEX_INCLUDED_USAGE_UNAVAILABLE',false],
 ['spend-unknown','CODEX_INCLUDED_USAGE_UNAVAILABLE',false],['credits-unknown','CODEX_PAID_CREDITS_NOT_AUTHORIZED',false],
 ['spend-control','CODEX_INCLUDED_USAGE_UNAVAILABLE',false],['paid-credits','CODEX_PAID_CREDITS_NOT_AUTHORIZED',false],['unlimited-credits','CODEX_PAID_CREDITS_NOT_AUTHORIZED',false],
 ['bucket-denied','CODEX_INCLUDED_USAGE_UNAVAILABLE',false],['second-read-denied','CODEX_INCLUDED_USAGE_UNAVAILABLE',false],
 ['wrong-model','CODEX_ACTUAL_ROUTE_MISMATCH',false],['wrong-provider','CODEX_ACTUAL_ROUTE_MISMATCH',false],
 ['paid-tier','CODEX_ACTUAL_ROUTE_MISMATCH',false],['malformed-thread','CODEX_THREAD_ID_MISSING',false],
 ['wrong-cwd','CODEX_THREAD_POLICY_MISMATCH',false],['wrong-approval','CODEX_THREAD_POLICY_MISMATCH',false],
 // Null, wrong or non-read-only acknowledged profiles remain blocked. Provenance is the
 // pinned controller policy supplied on thread/start, not an invented child source field.
 ['profile-null','CODEX_ACTIVE_PERMISSION_PROFILE_MISSING',false],['profile-wrong','CODEX_ACTIVE_PERMISSION_PROFILE_MISMATCH',false],['profile-parent-missing','CODEX_PERMISSION_PROFILE_PARENT_MISMATCH',false],
 ['sandbox-writable','CODEX_THREAD_POLICY_MISMATCH',false],['sandbox-network','CODEX_THREAD_POLICY_MISMATCH',false],
 ['missing-turn','CODEX_TURN_ID_MISSING',true],['tool-use','CODEX_UNEXPECTED_TOOL',true],['quota-update','CODEX_INCLUDED_USAGE_UNAVAILABLE',true],['account-update','CODEX_SUBSCRIPTION_ACCOUNT_REQUIRED',true]
 ,['malformed-turn','CODEX_TURN_ID_MISSING',true],['client-request','CODEX_CLIENT_REQUEST_DENIED',true],['preack-flood','CODEX_PREACK_EVENT_LIMIT',true],['account-stall','CODEX_TURN_TIMEOUT',false]
])test('Codex admission refuses '+mode+' without paid fallback',async t=>{
 const f=setup(t,mode);await assert.rejects(f.runner.run(f.input,()=>{}),{code});const calls=f.calls();assert.equal(calls.includes('turn/start'),turnStarted);assert.equal(calls.filter(x=>x==='turn/start').length,turnStarted?1:0);
});
test('Codex refuses to dispatch without a named permission profile or a readable policy file',async t=>{
 const f=setup(t),c=f.c;
 const noProfile={...c,codex:{...c.codex,permissionProfile:''}};
 await assert.rejects(new CodexRunner(()=>noProfile,root).run(f.input,()=>{}),{code:'CODEX_PERMISSION_PROFILE_REQUIRED'});
 const missingPolicy={...c,codex:{...c.codex,policyFile:resolve(f.h.dir,'absent-policy.toml')}};
 await assert.rejects(new CodexRunner(()=>missingPolicy,root).run(f.input,()=>{}),{code:'CODEX_POLICY_FILE_MISSING'});
 assert.equal(existsSync(resolve(f.h.dir,'codex-fixture-requests.jsonl')),false);
});
test('Codex completed evidence and usage bind exact acknowledged thread/turn; no foreign output',async t=>{
 const f=setup(t),events=[],out=await f.runner.run(f.input,e=>events.push(e));
 assert.equal(JSON.parse(out.text).verdict,'PASS');assert.equal(out.usage.inputTokens,null);assert.equal(out.usage.requestId,'turn-1');
 assert.equal(f.calls().filter(m=>m==='account/rateLimits/read').length,2);
 const event=events.find(e=>e.method==='dm/codexCompletion');assert.ok(event);assert.equal(event.params.threadId,out.sessionId);assert.equal(event.params.turnId,'turn-1');assert.equal(event.params.model,'fixture-not-a-model');assert.equal(event.params.paidFallback,false);
 assert.doesNotMatch(JSON.stringify(events),/FOREIGN_OUTPUT|99999/);
});

test('Codex passes an explicit structured-output contract to turn/start',async t=>{
 const f=setup(t),outputSchema={type:'object',required:['verdict','findings']};
 await f.runner.run({...f.input,outputSchema},()=>{});
 const request=readFileSync(resolve(f.h.dir,'codex-fixture-requests.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x)).find(x=>x.method==='turn/start');
 assert.deepEqual(request.outputSchema,outputSchema);
});

test('Codex cold initialization gets a dedicated bounded allowance without widening other preparation steps',async t=>{
 const f=setup(t),events=[];f.c.limits.stepTimeoutMs=120000;
 await f.runner.run(f.input,event=>events.push(event));
 const initialize=events.find(event=>event.method==='dm/codexPreparation'&&event.params.method==='initialize'&&event.params.status==='STARTED');
 const thread=events.find(event=>event.method==='dm/codexPreparation'&&event.params.method==='thread/start'&&event.params.status==='STARTED');
 assert.equal(initialize?.params.timeoutMs,90000);
 assert.equal(thread?.params.timeoutMs,30000);
});

test('Codex preparation allows slow initialization within the existing step deadline and records safe timings',async t=>{
 const f=setup(t,'initialize-slow'),events=[];f.c.limits.stepTimeoutMs=25000;
 const out=await f.runner.run(f.input,event=>events.push(event));
 assert.equal(JSON.parse(out.text).verdict,'PASS');assert.equal(f.calls().filter(method=>method==='turn/start').length,1);
 const initialization=events.filter(event=>event.method==='dm/codexPreparation'&&event.params.method==='initialize');
 assert.deepEqual(initialization.map(event=>event.params.status),['STARTED','COMPLETED']);
 assert.ok(initialization[1].params.elapsedMs>=11000);
 assert.equal(initialization[0].params.timeoutMs,25000);
 for(const event of events.filter(event=>event.method==='dm/codexPreparation')){
  assert.ok(Object.keys(event.params).every(key=>['role','method','status','timeoutMs','elapsedMs','code'].includes(key)));
  assert.doesNotMatch(JSON.stringify(event),/accountFingerprint|requiresOpenaiAuth|"rateLimits"\s*:|fixture-private|fixture-thread/);
 }
});

test('Codex thread preparation uses the bounded preparation allowance instead of a fixed short timeout',async t=>{
 const f=setup(t),events=[];f.c.limits.stepTimeoutMs=30000;
 const request=RpcPeer.prototype.request;
 t.mock.method(RpcPeer.prototype,'request',function(method,...args){
  if(method!=='thread/start')return request.call(this,method,...args);
  return new Promise((resolve,reject)=>setTimeout(()=>Promise.resolve(request.call(this,method,...args)).then(resolve,reject),11000));
 });
 const out=await f.runner.run(f.input,event=>events.push(event));
 assert.equal(JSON.parse(out.text).verdict,'PASS');
 const preparation=events.find(event=>event.method==='dm/codexPreparation'&&event.params.method==='thread/start'&&event.params.status==='STARTED');
 assert.equal(preparation?.params.timeoutMs,30000);
});

test('Codex slow preparation still obeys the original whole-step deadline before a model turn',async t=>{
 const f=setup(t,'initialize-stall'),events=[];f.c.limits.stepTimeoutMs=1500;
 await assert.rejects(f.runner.run(f.input,event=>events.push(event)),{code:'CODEX_TURN_TIMEOUT'});
 const calls=existsSync(resolve(f.h.dir,'codex-fixture-requests.jsonl'))?f.calls():[];
 assert.equal(calls.includes('turn/start'),false);
 const started=events.find(event=>event.method==='dm/codexPreparation'&&event.params.status==='STARTED');
 assert.equal(started?.params.timeoutMs,1500);
});

test('Codex preparation deadline includes waiting before the peer request timer starts',async t=>{
 const f=setup(t),events=[];f.c.limits.stepTimeoutMs=45000;
 const request=RpcPeer.prototype.request;let delayed;
 // OFFLINE boundary control: readiness may still be pending before RpcPeer starts its timer.
 // Keep the delay finite so a failed assertion cannot leave an unresolved test operation.
 t.mock.method(RpcPeer.prototype,'request',function(method,...args){
   if(method!=='thread/start')return request.call(this,method,...args);
   delayed=new Promise(resolve=>setTimeout(resolve,32000)).then(()=>request.call(this,method,...args));
  return delayed;
 });
 t.after(async()=>{if(delayed)await delayed.catch(()=>{});});
 await assert.rejects(f.runner.run(f.input,event=>events.push(event)),{code:'RPC_REQUEST_TIMEOUT'});
 const failure=events.find(event=>event.method==='dm/codexPreparation'&&event.params.method==='thread/start'&&event.params.status==='FAILED');
 assert.equal(failure?.params.code,'RPC_REQUEST_TIMEOUT');
 const started=events.find(event=>event.method==='dm/codexPreparation'&&event.params.method==='thread/start'&&event.params.status==='STARTED');
 assert.equal(started?.params.timeoutMs,30000);
 const calls=existsSync(resolve(f.h.dir,'codex-fixture-requests.jsonl'))?f.calls():[];
 assert.equal(calls.includes('turn/start'),false);
});
test('controller policy refuses widening, unknown sections and duplicate assignments before launch',async t=>{
 const f=setup(t),base=readFileSync(f.c.codex.policyFile,'utf8');
 for(const text of [base.replace('enabled = false','enabled = true'),base.replace('":root" = "deny"','":root" = "read"'),base.replace('extends = ":read-only"','extends = ":workspace"'),base+'\n[model_providers.foreign]\nbase_url = "https://example.invalid"\n',base+'\nenabled = false\n']){
  writeFileSync(f.c.codex.policyFile,text);
  await assert.rejects(f.runner.run(f.input,()=>{}),{code:'CODEX_POLICY_FILE_INVALID'});
 }
 assert.equal(existsSync(resolve(f.h.dir,'codex-fixture-requests.jsonl')),false);
});
test('policy replacement after admission refuses the model turn and keeps the original identity gate',async t=>{
 const f=setup(t);await assert.rejects(f.runner.run(f.input,e=>{if(e.method==='dm/codexAdmission')writeFileSync(f.c.codex.policyFile,'CHANGED');}),{code:'CODEX_POLICY_FILE_CHANGED'});
 assert.equal(f.calls().includes('turn/start'),false);
});
test('fixed role policy refuses absolute drive and temporary-directory read exceptions before launch',async t=>{
 const f=setup(t),base=readFileSync(f.c.codex.policyFile,'utf8');
 for(const path of ['C:/','/tmp','/etc','/opt/dream-maker-controller/codex-0.162.0/launcher/package/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex']){
  writeFileSync(f.c.codex.policyFile,base.replace('[permissions.fixture-source-read.filesystem.\":workspace_roots\"]',JSON.stringify(path)+' = "read"\n\n[permissions.fixture-source-read.filesystem.\":workspace_roots\"]'));
  await assert.rejects(f.runner.run(f.input,()=>{}),{code:'CODEX_POLICY_FILE_INVALID'});
 }
 assert.equal(existsSync(resolve(f.h.dir,'codex-fixture-requests.jsonl')),false);
});
test('Codex cannot complete a role from a foreign thread or after cancellation',async t=>{
 const f=setup(t,'wrong-thread');await assert.rejects(f.runner.run(f.input,()=>{}),{code:'CODEX_TURN_TIMEOUT'});
 const next=setup(t);const abort=new AbortController();abort.abort();await assert.rejects(next.runner.run({...next.input,signal:abort.signal},()=>{}),{code:'RUN_CANCELLED'});
});
test('cancellation after admission stops before model dispatch and retains its cause',async t=>{
 const f=setup(t),abort=new AbortController();await assert.rejects(f.runner.run({...f.input,signal:abort.signal},e=>{if(e.method==='dm/codexAdmission')abort.abort();}),{code:'RUN_CANCELLED'});assert.equal(f.calls().includes('turn/start'),false);
});
