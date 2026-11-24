// OFFLINE original Store/NativeOwner/Dispatch, explicitly synthetic run/secret.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join,resolve,dirname} from 'node:path';
import {harness,ready,root} from '../helpers.mjs';import {NativeOwner} from '../../dist/server/native-owner.js';import {FlowProfiles} from '../../dist/server/flow-profiles.js';import {hash} from '../../dist/server/security.js';
import {EngineDispatch} from '../../dist/server/flow/dispatch.js';import {consumeMagpieAccountCustody} from '../../dist/server/magpie-account-custody.js';
import {currentProcessOwnership,withProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import {nativeReadiness} from '../../dist/server/providers/dsh.js';
import {DeepSeekGateway} from '../../dist/server/deepseek-gateway.js';
import {DomainError} from '../../dist/server/security.js';
const actor='local-session:'+'a'.repeat(64),secret='SYNTHETIC_M15_NOT_A_PROVIDER_KEY';
import {resolveCustomMagpieRoute} from '../../dist/server/flow/custom-magpie-catalog.js';
// These gateway tests start after role qualification; use the production route resolver on synthetic observations.
function observedSession(owner,model){
 owner.qualifiedCustomMagpieRoute=(session,input,actor)=>resolveCustomMagpieRoute(session.observation,input.role,actor);
 const account={authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',provider:'deepseek-official',authentication:'api_key',model,upstreamAccountRef:'deepseek-official/0123456789'};
 return {observation:{scope:'LOCAL_CONTROL_PROCESS_ONLY',address:'127.0.0.1:12345',epoch:'OFFLINE',accountCount:1,accounts:[account]},async close(){}};
}
async function rig(t,role='planner2',options={}){
 let owner,dispatcher;t.after(async()=>{await dispatcher?.close();await owner?.close();});const h=harness(t),{p,s}=await ready(h),reads=[];mkdirSync(join(h.dir,'config'));
 const ref=(name,v)=>{const path=join(h.dir,name),bytes=JSON.stringify(v);writeFileSync(path,bytes);return{path,sha256:hash(bytes)};},authority=ref('authority.json',{scopeId:'SYNTHETIC_M15',authorizationHash:'OFFLINE_ONLY',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});
 const manifest=ref('sources.json',{schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',secretEnv:h.config.dsh.keyEnv}]}),operatorPath=join(h.dir,'config/native-owner.local.json');writeFileSync(operatorPath,JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:h.dir,authority,customAccountSources:manifest,prices:{},maxOutputTokens:128,maxRequests:8}));
 owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,getSecret:name=>{reads.push(name);return secret;}});
 const runtime=options.runtime??'dsh',localModel=options.model??'deepseek-flash',
  a={provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE'},item=(id,write=false)=>({id,...a,runtime,model:{kind:'model',id:localModel},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}}),configuration={mode:'custom',laya:false,accounts:[a],roles:{planner2:item('planner2'),executors:[item('worker-one',true)],reviewer:item('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'SYNTHETIC_M15_PROFILE'),prepared=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);h.engine.launch=()=>{};const seed=h.engine.create(p.id,s.hash,true);h.store.release(p.id,seed.id);
 const phase=role==='planner2'?'PLANNING':role==='reviewer'?'REVIEWING':'IMPLEMENTING',run={...structuredClone(seed),id:prepared.flowConfig.runId,mode:'live',flowName:'custom',rolePolicy:'CUSTOM_FROZEN_V1',flowConfig:prepared.flowConfig,flowConfigHash:prepared.flowConfigHash,configFingerprint:prepared.flowConfig.configurationFingerprint,workspace:resolve(h.dir,'workspaces',prepared.flowConfig.runId),state:phase,phase,tasks:[{id:'one',title:'SYNTHETIC',dependsOn:[],requirementIds:[],acceptance:['OFFLINE'],status:'running'}]};
 h.store.insertRun(run);h.store.acquire(p.id,run.id);const project=h.store.project(p.id);project.mode='live';project.activeRunId=run.id;h.store.saveProject(project);
 const controller=new AbortController(),input={role,workspace:run.workspace,model:localModel,runId:run.id,specHash:s.hash,prompt:'OFFLINE_NO_MODEL',laya:{mode:'off',adoption:'off'},signal:controller.signal,...(role==='executor'?{taskId:'one',executorRoleId:'worker-one'}:{})};
 dispatcher=new EngineDispatch(h.store,{measure:()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:9216,sampledAt:new Date().toISOString()}),isCurrent:()=>true});
 const dispatch=fn=>dispatcher.run({projectId:p.id,runId:run.id,kind:role,mode:'live',signal:controller.signal,...(role==='executor'?{executorRoleId:'worker-one'}:{})},async ctl=>{try{return await fn();}finally{ctl.confirmCleanup();}});
 return{h,p,s,run,input,reads,owner,dispatch,controller,manifest,operatorPath,prepared,profile,closeWithOwner:replacement=>{owner=replacement;}};
}
for(const role of ['planner2','executor','reviewer'])test('active '+role+' account custody derives from frozen run without prebuild preparation or secret read',async t=>{
 const x=await rig(t,role),before={run:hash(x.h.store.run(x.run.id)),approvals:x.h.store.db.prepare('SELECT count(*) n FROM approvals').get().n};
 assert.throws(()=>x.owner.prepareCustomMagpieCustody({projectId:x.p.id,specHash:x.s.hash,profileHash:x.profile.contentHash,preparation:{identityHash:x.prepared.identityHash,contentHash:x.prepared.contentHash}}),{code:'FLOW_TERMINATION_REQUIRED'});
 await x.dispatch(()=>{const ticket=x.owner.prepareCustomRunMagpieCustody(x.input);assert.deepEqual(x.reads,[]);assert.equal(ticket.binding.flowConfigHash,x.run.flowConfigHash);assert.equal(JSON.stringify(ticket).includes(secret),false);const a=consumeMagpieAccountCustody(ticket.custody,ticket.binding)[0];assert.equal(a.authRef,'AUTH_ONE');assert.equal(a.key,secret);a.key='';assert.throws(()=>consumeMagpieAccountCustody(ticket.custody,ticket.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_INVALID'});});
 assert.deepEqual(x.reads,[x.h.config.dsh.keyEnv]);assert.equal(hash(x.h.store.run(x.run.id)),before.run);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM approvals').get().n,before.approvals);assert.equal(x.owner.budget.requests().length,0);assert.equal(x.h.store.records(x.p.id,'NativeProbeReceipt').length,0);
});
for(const role of ['planner2','executor','reviewer'])test('Custom product '+role+' cannot start without original qualified evidence or borrow Classic admission',async t=>{
 const x=await rig(t,role);assert.equal(typeof x.owner.custom,'function');
 await x.dispatch(async()=>{await assert.rejects(Promise.resolve().then(()=>x.owner.custom(x.input).run(x.input,()=>{})),{code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'});});
 assert.deepEqual(x.reads,[]);assert.equal(x.owner.budget.requests().length,0);
});
test('Custom product factory refuses an unowned role before credentials or process work',async t=>{
 const x=await rig(t);assert.equal(typeof x.owner.custom,'function');
 await assert.rejects(Promise.resolve().then(()=>x.owner.custom(x.input).run(x.input,()=>{})),{code:'NATIVE_REQUEST_BINDING_STALE'});assert.deepEqual(x.reads,[]);
});
for(const role of ['planner2','executor','reviewer'])test('qualified '+role+' product factory delegates to its original run custody lifetime',async t=>{
 const x=await rig(t,role);let starts=0;x.owner.assertCustomReady=()=>{};x.owner.requireUserBudget=()=>{};
 x.owner.withCustomRunMagpieControl=async input=>{starts++;assert.equal(input.role,role);assert.equal(input.runId,x.run.id);assert.equal(input.executorRoleId,x.input.executorRoleId);throw Object.assign(Error('OFFLINE_STOP_BEFORE_PROCESS'),{code:'OFFLINE_PROCESS_DENIED'});};
 await x.dispatch(async()=>{const runner=x.owner.custom(x.input);await assert.rejects(runner.run({...x.input,model:'FOREIGN'},()=>{}),{code:'CUSTOM_ROLE_BINDING_CHANGED'});assert.equal(starts,0);await assert.rejects(runner.run(x.input,()=>{}),{code:'OFFLINE_PROCESS_DENIED'});await assert.rejects(runner.run(x.input,()=>{}),{code:'CUSTOM_ROLE_TURN_ALREADY_USED'});});
 assert.equal(starts,1);assert.deepEqual(x.reads,[]);assert.equal(x.owner.budget.requests().length,0);
});
test('qualified DSH executor keeps an approved Pro model instead of rejecting it or falling back to Flash',async t=>{
 const x=await rig(t,'executor',{model:'deepseek-v4-pro'});let starts=0;
 x.owner.assertCustomReady=()=>{};x.owner.requireUserBudget=()=>{};
 x.owner.withCustomRunMagpieControl=async input=>{starts++;assert.equal(input.role,'executor');assert.equal(input.model,'deepseek-v4-pro');throw Object.assign(Error('OFFLINE_STOP_BEFORE_PROCESS'),{code:'OFFLINE_PROCESS_DENIED'});};
 await x.dispatch(()=>assert.rejects(x.owner.custom(x.input).run(x.input,()=>{}),{code:'OFFLINE_PROCESS_DENIED'}));
 assert.equal(starts,1);assert.deepEqual(x.reads,[]);assert.equal(x.owner.budget.requests().length,0);
});
test('non-Claude Custom text Magpie persists a failure receipt before returning',async t=>{
 const x=await rig(t,'reviewer',{runtime:'independent',model:'deepseek-v4-pro'});x.owner.assertCustomReady=()=>{};x.owner.requireUserBudget=()=>{};
 const session=observedSession(x.owner,'deepseek-v4-pro');
 x.owner.withCustomRunMagpieControl=async(args,consume)=>consume(session,{},args.signal);
 const receipt={id:'OFFLINE_REQUEST',upstream:'http://127.0.0.1:12345/v1/chat/completions',requestedModel:'deepseek-v4-pro',
  responseModelMatched:false,responseId:null,observedModel:null,finishReason:null,responseSha256:null,outputTextHash:null,
  completionObserved:false,minimalResponseVerified:false,protocolEventCount:3,protocolLastEventType:'content_block_stop',
  protocolLastEventDetail:'content_block_stop:OFFLINE',protocolFailureStage:'OBSERVE',toolArgumentFailureDetail:'TOOL_CALL_ARGUMENTS_TYPE',
  upstreamHttpStatus:200,upstreamContentType:'application/json',upstreamBodyShape:null,upstreamBodyBytes:null,upstreamBodySha256:null,
  upstreamBodyCode:null,upstreamRequestIdSha256:null,transportErrorCode:null,elapsedMs:12,elapsedMsCapped:false,
  networkFailureClass:null,automaticRetryAllowed:false,outcome:'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID',usage:null,
  reservedMicros:9658368,recordedAt:'2026-11-19T00:00:00.000Z'};
 const originalStart=DeepSeekGateway.prototype.start;
 t.mock.method(DeepSeekGateway.prototype,'receipts',()=>[structuredClone(receipt)]);
 t.mock.method(DeepSeekGateway.prototype,'start',async function(){await originalStart.call(this);throw new DomainError('OFFLINE_AFTER_GATEWAY_START',409);});
 const emitted=[];
 await x.dispatch(()=>assert.rejects(x.owner.custom(x.input).run(x.input,event=>emitted.push(event)),{code:'OFFLINE_AFTER_GATEWAY_START'}));
 const rows=x.h.store.records(x.p.id,'NativeBudgetReceipt');
 assert.equal(rows.length,1);assert.equal(rows[0].data.method,'dm/budget');
 assert.equal(rows[0].data.params.requests[0].toolArgumentFailureDetail,'TOOL_CALL_ARGUMENTS_TYPE');
 assert.equal(emitted.length,1);assert.deepEqual(emitted[0],rows[0].data);
 assert.deepEqual(x.reads,[]);assert.equal(x.owner.budget.requests().length,0);
});

// Magpie answers with its provider-qualified model spelling (`deepseek-official/deepseek-v4-pro`).
// The owner accepts that spelling only for the exact prepared Magpie route and must record the
// bare frozen role model; a mismatch is still a refusal.
test('a Magpie chat response records the bare role model behind its provider-qualified spelling',async t=>{
 const x=await rig(t,'reviewer',{runtime:'independent',model:'deepseek-v4-pro'});
 const {createServer}=await import('node:http');
 const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({id:'chatcmpl_offline_review',model:'deepseek-official/deepseek-v4-pro',
   choices:[{message:{content:'{"verdict":"PASS","findings":[]}'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:5}}));
 });});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 const address='http://127.0.0.1:'+server.address().port+'/v1';
 t.mock.method(DeepSeekGateway.prototype,'start',async()=>({url:address,token:'a'.repeat(64)}));
 t.mock.method(DeepSeekGateway.prototype,'close',async()=>{});
 t.mock.method(DeepSeekGateway.prototype,'receipts',()=>[]);
 const session=observedSession(x.owner,'deepseek-v4-pro');
 x.owner.withCustomRunMagpieControl=async(args,consume)=>consume(session,{},args.signal);
 const actor={id:'reviewer',provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',runtime:'independent',model:{kind:'model',id:'deepseek-v4-pro'},transport:'magpie',nativeException:false,permissions:['source_read'],budget:{currency:'CNY',maxMicros:1000000}};
 const runner=x.owner.customTextMagpie(x.input,actor,()=>{},'a'.repeat(64));
 const out=await x.dispatch(()=>runner.run(x.input,()=>{}));
 assert.equal(out.model,'deepseek-v4-pro');
 assert.equal(out.identity.model,'deepseek-v4-pro');
 assert.equal(out.identity.runner,'INDEPENDENT_API');
 assert.equal(out.sessionId,'chatcmpl_offline_review');
});
for(const role of ['planner2','reviewer'])test('original NativeOwner '+role+' preserves its single terminal tool before budget admission',async t=>{
 const x=await rig(t,role);x.owner.assertCustomReady=()=>{};x.owner.requireUserBudget=()=>{};
 const session=observedSession(x.owner,'deepseek-flash');
 x.owner.withCustomRunMagpieControl=async(args,consume)=>consume(session,{},args.signal);
 const original=DeepSeekGateway.prototype.start,observed=[];let priceReached=0;
 t.mock.method(DeepSeekGateway.prototype,'start',async function(){
  this.quote=()=>{priceReached++;throw new DomainError('OFFLINE_PRICE_BOUNDARY_REACHED',409);};
  const address=await original.call(this),name=role==='planner2'?'submit_engineering_plan':'submit_review';
  for(const tool of [name,'desk_write']){
   const response=await fetch(address.url+'/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':address.token},body:JSON.stringify({model:'deepseek-flash',max_tokens:128,messages:[{role:'user',content:'OFFLINE_NO_MODEL'}],tools:[{name:tool,input_schema:{type:'object'}}]})});
   observed.push({status:response.status,code:(await response.json()).error.code});
  }
  throw new DomainError('OFFLINE_NATIVE_GATEWAY_STOP',409);
 });
 await x.dispatch(()=>assert.rejects(x.owner.custom(x.input).run(x.input,()=>{}),{code:'OFFLINE_NATIVE_GATEWAY_STOP'}));
 assert.deepEqual(observed,[{status:409,code:'OFFLINE_PRICE_BOUNDARY_REACHED'},{status:400,code:'CUSTOM_SUPERVISION_TOOLSET_INVALID'}]);
 assert.equal(priceReached,1);assert.equal(x.owner.budget.requests().length,0);assert.deepEqual(x.reads,[]);
});
test('run custody refuses missing/foreign dispatch and mutated role, model, workspace or task before secrets',async t=>{
 const x=await rig(t);assert.throws(()=>x.owner.prepareCustomRunMagpieCustody(x.input),{code:'NATIVE_REQUEST_BINDING_STALE'});
 await x.dispatch(()=>{for(const changed of [{role:'reviewer'},{workspace:resolve(x.h.dir,'foreign')},{model:'foreign'},{taskId:'one'},{executorRoleId:'worker-one'},{specHash:'0'.repeat(64)}])assert.throws(()=>x.owner.prepareCustomRunMagpieCustody({...x.input,...changed}),{code:'NATIVE_REQUEST_BINDING_STALE'});});assert.deepEqual(x.reads,[]);
});
test('pause, source drift, config drift and dispatch completion invalidate an unconsumed run custody before secret reads',async t=>{
 for(const change of ['pause','source','config','settled']){const x=await rig(t);let ticket;await x.dispatch(()=>{ticket=x.owner.prepareCustomRunMagpieCustody(x.input);if(change==='settled')return;if(change==='pause'){const r=x.h.store.run(x.run.id);r.state='PAUSE_REQUESTED';x.h.store.saveRun(r);}else if(change==='source')writeFileSync(x.manifest.path,'{}');else x.h.config.limits.maxCalls++;assert.throws(()=>consumeMagpieAccountCustody(ticket.custody,ticket.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_STALE'});});if(change==='settled')assert.throws(()=>consumeMagpieAccountCustody(ticket.custody,ticket.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_STALE'});assert.deepEqual(x.reads,[]);}
});
test('caller mutation cannot redirect frozen run custody and original stop revokes it',async t=>{
 const x=await rig(t);await x.dispatch(()=>{const ticket=x.owner.prepareCustomRunMagpieCustody(x.input);x.input.specHash='0'.repeat(64);x.input.workspace=resolve(x.h.dir,'foreign');const a=consumeMagpieAccountCustody(ticket.custody,ticket.binding)[0];assert.equal(a.key,secret);a.key='';});
 const y=await rig(t);await y.dispatch(()=>{const ticket=y.owner.prepareCustomRunMagpieCustody(y.input);y.owner.stopRequests();assert.throws(()=>consumeMagpieAccountCustody(ticket.custody,ticket.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_INVALID'});});assert.deepEqual(y.reads,[]);
});
test('run control refuses missing pinned candidate before reading credentials or invoking its consumer',async t=>{
 const x=await rig(t);let callbacks=0;await x.dispatch(async()=>{await assert.rejects(x.owner.withCustomRunMagpieControl(x.input,async()=>{callbacks++;}),{code:'MAGPIE_CANDIDATE_BINDING_REQUIRED'});});assert.deepEqual(x.reads,[]);assert.equal(callbacks,0);assert.equal(x.owner.budget.requests().length,0);
});
test('a run custody cannot start a process under foreign ownership while its original dispatch is still active',async t=>{
 const x=await rig(t);await x.dispatch(()=>{const ticket=x.owner.prepareCustomRunMagpieCustody(x.input),original=currentProcessOwnership();return withProcessOwnership({...original,dispatchId:'foreign_dispatch'},()=>{assert.throws(()=>consumeMagpieAccountCustody(ticket.custody,ticket.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_STALE'});assert.deepEqual(x.reads,[]);});});
});
test('a Custom run cannot borrow the Classic policy to consume an already created custody',async t=>{
 const x=await rig(t);await x.dispatch(()=>{const ticket=x.owner.prepareCustomRunMagpieCustody(x.input),r=x.h.store.run(x.run.id);r.rolePolicy='CODEX_DSH_V1';x.h.store.saveRun(r);assert.throws(()=>consumeMagpieAccountCustody(ticket.custody,ticket.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_STALE'});assert.deepEqual(x.reads,[]);});
});

test('NativeOwner Custom qualification stays synchronous and cannot borrow Classic receipts or account custody',async t=>{
 const x=await rig(t),before=hash(x.h.store.run(x.run.id)),records=x.h.store.records(x.p.id).length;assert.equal(typeof x.owner.assertCustomReady,'function');
 assert.throws(()=>x.owner.assertCustomReady(x.prepared.flowConfig),{code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'});
 assert.deepEqual(x.reads,[]);assert.equal(x.owner.budget.requests().length,0);assert.equal(hash(x.h.store.run(x.run.id)),before);assert.equal(x.h.store.records(x.p.id).length,records);
});

async function bindingFixture(t){
 const x=await rig(t);await x.owner.close();const put=(path,body)=>{const p=join(x.h.dir,path);mkdirSync(dirname(p),{recursive:true});const bytes=Buffer.isBuffer(body)?body:typeof body==='string'?body:JSON.stringify(body);writeFileSync(p,bytes);return{path:p,sha256:hash(bytes)};};
 for(const path of ['dist/server/source.js','adapters/source.mjs','prompts/source.md','scripts/dsh-host.mjs'])put(path,'// SYNTHETIC M18 BINDING ONLY');
 for(const path of ['scripts/isolation/wsl-worker.py','scripts/isolation/wsl-resource-context.py'])put(path,readFileSync(join(root,path)));
 const module=put('sdk/lib/index.js','// SYNTHETIC SDK, NEVER EXECUTED'),candidate=put('candidate.exe','SYNTHETIC_NOT_AN_EXECUTABLE'),template=put('template.json',{sdkRoot:join(x.h.dir,'sdk'),hostModule:module.path,eventModule:module.path,hostScript:module.path,dshBin:module.path,verifierModule:module.path,profile:'sdk',patches:[],dependencyFiles:[],reasoningEffort:'off',maxTokens:128}),price=put('price.json',{provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_NO_INFERENCE',expiresAt:'2099-01-01T00:00:00Z',maxInputTokens:1048576,inputMissMicrosPerMillion:2,inputHitMicrosPerMillion:1,outputMicrosPerMillion:3}),proof=put('proof.txt','OFFLINE SYNTHETIC AUDIT, NOT ISOLATION EVIDENCE');
 const operator=JSON.parse(readFileSync(x.operatorPath));Object.assign(operator,{template,prices:{executor:price},sdkToolsModule:module.path,files:{modulePath:module.path,dependencies:[module],readPaths:['main.mjs'],writePaths:['main.mjs']},profileBinding:{sdkCommit:'OFFLINE',basePatch:module.path,sdkPatch:module.path,yamlModule:module.path,dependencies:[module]},probeExpiresAt:'2099-01-01T00:00:00Z'});writeFileSync(x.operatorPath,JSON.stringify(operator));
 x.h.config.codex.home='';x.h.config.codex.model='';x.h.config.dsh.modulePath=module.path;x.h.config.nativeAuditPath=join(x.h.dir,'audit.json');
 const audit={configurationHash:nativeReadiness(x.h.config).configurationHash,status:'LIVE_READY',osIsolationVerified:true,secretIsolationVerified:true,noImplicitLayaVerified:true,verifierImplemented:true,sandboxExecutionVerified:true,expiresAt:operator.probeExpiresAt,moduleSha256:module.sha256,evidenceFiles:[proof,module,template,price,operator.authority,{path:x.operatorPath,sha256:hash(readFileSync(x.operatorPath))}]};writeFileSync(x.h.config.nativeAuditPath,JSON.stringify(audit));
 // Explicit OFFLINE proof-service seam; no signing key, run creation, model or production permit.
 let key='SYNTHETIC_CREDENTIAL_GENERATION_ONE',captured;const reads=[];const owner=new NativeOwner({root:x.h.dir,store:x.h.store,getConfig:()=>x.h.config,getSecret:name=>{reads.push(name);return key;},magpieCandidate:candidate});
 // The original rig's owner hook precedes harness cleanup on Windows.
 x.closeWithOwner(owner);owner.customProofs={assertCustomReady:b=>{captured=structuredClone(b);},close:async()=>{}};
 const snapshot=structuredClone(x.prepared.flowConfig);const {customEngineeringFingerprint}=await import('../../dist/server/flow-configuration.js');snapshot.configurationFingerprint=customEngineeringFingerprint(x.h.config,snapshot.profile.contentHash);
 return{...x,owner,audit,template,snapshot,reads,captured:()=>captured,rotate:()=>{key='SYNTHETIC_CREDENTIAL_GENERATION_TWO';}};
}
test('Custom controller evidence binding follows credential generation and does not require Codex login settings',async t=>{
 const x=await bindingFixture(t);x.owner.assertCustomReady(x.snapshot);const first=x.captured();assert.equal(first.schema,'dream-maker.custom-probe-binding.v1');assert.equal(first.roles[0].runtime,'dsh');assert.equal(first.flowConfigHash,hash(x.snapshot));assert.doesNotMatch(JSON.stringify(first),/SYNTHETIC_CREDENTIAL_GENERATION/);
 x.rotate();x.owner.assertCustomReady(x.snapshot);assert.notEqual(x.captured().credentialHash,first.credentialHash);assert.equal(x.captured().runtimeHash,first.runtimeHash);assert.equal(x.owner.budget.requests().length,0);
});
test('unaudited Custom operator inputs are refused before reading selected model credentials',async t=>{
 const x=await bindingFixture(t);x.audit.evidenceFiles=x.audit.evidenceFiles.filter(f=>f.path!==x.template.path);writeFileSync(x.h.config.nativeAuditPath,JSON.stringify(x.audit));
 assert.throws(()=>x.owner.assertCustomReady(x.snapshot),{code:'NATIVE_BINDING_CHANGED'});assert.deepEqual(x.reads,[]);assert.equal(x.owner.budget.requests().length,0);
});


