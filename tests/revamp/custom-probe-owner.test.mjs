// OFFLINE NativeOwner admission seams only. No native audit, process, credentials or model proof.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {harness} from '../helpers.mjs';import {NativeOwner} from '../../dist/server/native-owner.js';
import {withProcessOwnership} from '../../dist/server/flow/process-ownership.js';import {hash} from '../../dist/server/security.js';
function fixture(t){
 const h=harness(t);let reads=0,starts=0;const owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,getSecret:()=>{reads++;throw Error('NO_SECRET_READ');}});t.after(()=>owner.close());
 const prep={role:'planner2',roleId:'planner2',bindingHash:hash('OFFLINE_BINDING'),configurationHash:hash('OFFLINE_CONFIG')},probeId='custom_probe_OFFLINE_OWNER';
 const selection={projectId:'OFFLINE_PROJECT',specHash:hash('OFFLINE_SPEC'),profileHash:hash('OFFLINE_PROFILE'),preparation:{identityHash:hash('OFFLINE_ID'),contentHash:hash('OFFLINE_PREP')}};
 const input={selection,preparation:prep,probeId,nonce:'DM_CUSTOM_PROBE_OFFLINE_OWNER',signal:new AbortController().signal};
 const scope={store:h.store,projectId:null,runId:null,dispatchId:'OFFLINE_DISPATCH',generation:'OFFLINE_GENERATION',mode:'live',acceptanceId:probeId};
 return{h,owner,input,scope,reads:()=>reads,starts:()=>starts,isolateAdmission(){owner.customProbePreparation=()=>prep;owner.configured=()=>({op:{},budget:{}});owner.customProofs={async close(){}};
  // The owner resolves the frozen selection before it picks a runtime; replace that store lookup
  // so this admission seam needs no real project, audit or account catalog.
  owner.customAccountSelection=()=>({prepared:{flowConfig:{runId:'OFFLINE_RUN',plan:{specHash:selection.specHash},laya:{enabled:false,mode:'off',roles:[]}}}});
  owner.customProbeBinding=()=>({roles:[{role:'planner2',roleId:'planner2',runtime:'dsh',provider:'deepseek-official',authentication:'API_KEY',model:'deepseek-flash',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'}]});
  owner.withCustomMagpieControl=async()=>{starts++;throw Object.assign(Error('OFFLINE_STOP_BEFORE_RUNTIME'),{code:'OFFLINE_RUNTIME_DENIED'});};},journal(patch={}){
  h.store.record('CustomRoleProbeIntent',null,null,{probeId,preparation:prep});h.store.record('DispatchGranted',null,null,{dispatchId:scope.dispatchId,generation:scope.generation,kind:'planner2',mode:'live',purpose:'CUSTOM_ROLE_PROBE',acceptanceId:probeId,...patch});
 }};
}
test('missing controller config cannot prepare Custom qualification or read secrets',t=>{
 const x=fixture(t);assert.throws(()=>x.owner.customProbePreparation(x.input.selection,'planner2'),{code:'NATIVE_OPERATOR_CONFIG_REQUIRED'});assert.equal(x.reads(),0);
 assert.throws(()=>x.owner.completeCustomRoleProbe(x.input,{attemptId:'UNTRUSTED',bindingHash:x.input.preparation.bindingHash,observation:{}}),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});
});

test('Custom qualification follows the frozen run leaving Laya off, not the Classic-wide switch',t=>{
 // One instance serves both modes: Classic may hold the global switch at advisory for its own runs
 // while every Custom snapshot is frozen to Laya off. The probe must read the snapshot, not the switch.
 const x=fixture(t);x.isolateAdmission();
 // The admission helper replaces the method under test; restore the real implementation and
 // keep only the store/audit collaborators stubbed.
 delete x.owner.customProbePreparation;
 x.h.config={...x.h.config,laya:{...x.h.config.laya,mode:'advisory'}};
 const prepared=x.owner.customProbePreparation(x.input.selection,'planner2');
 assert.equal(prepared.roleId,'planner2');
 // A snapshot that somehow tried to enable Laya for Custom is still refused.
 x.owner.customAccountSelection=()=>({prepared:{flowConfig:{runId:'OFFLINE_RUN',plan:{specHash:x.input.selection.specHash},laya:{enabled:true,mode:'advisory',roles:['planner2']}}}});
 assert.throws(()=>x.owner.customProbePreparation(x.input.selection,'planner2'),{code:'CUSTOM_LAYA_FORBIDDEN'});
 assert.equal(x.reads(),0);
});
test('Custom Owner requires original precise grant and role before starting account/runtime work',async t=>{
 for(const patch of [{purpose:'DSH_ENGINEERING_ACCEPTANCE'},{acceptanceId:'custom_probe_FOREIGN'},{kind:'reviewer'},{generation:'FOREIGN_GENERATION'},{mode:'demo'}]){
  const x=fixture(t);x.isolateAdmission();x.journal(patch);
  await assert.rejects(withProcessOwnership(x.scope,()=>x.owner.executeCustomRoleProbe(x.input,()=>{})),{code:'CUSTOM_PROBE_DISPATCH_REQUIRED'});assert.equal(x.starts(),0);assert.equal(x.reads(),0);
 }
});
test('interrupted Owner attempt remains durable and cannot be invoked twice under the same grant',async t=>{
 const x=fixture(t);x.isolateAdmission();x.journal();
 await assert.rejects(withProcessOwnership(x.scope,()=>x.owner.executeCustomRoleProbe(x.input,()=>{})),{code:'OFFLINE_RUNTIME_DENIED'});
 await assert.rejects(withProcessOwnership(x.scope,()=>x.owner.executeCustomRoleProbe(x.input,()=>{})),{code:'CUSTOM_PROBE_RECOVERY_REQUIRED'});
 assert.equal(x.starts(),1);assert.equal(x.reads(),0);assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeCustomProbeAttempt'").get().n,1);
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeCustomProbeReceipt'").get().n,0);
});
test('expired or missing Custom qualification expiry stops before audit, account or runtime work',t=>{
 for(const expiry of [undefined,'malformed','2020-01-01T00:00:00Z']){
  const x=fixture(t),role=(id,write=false)=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
  const snapshot={schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',plan:{versionId:'OFFLINE_PLAN',revision:1,contentHash:hash('PLAN'),specHash:hash('SPEC')},profile:{revision:1,contentHash:hash('PROFILE')},accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'}],roles:{planner2:role('planner2'),executors:[role('execA',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:1000000},timeZone:'Asia/Shanghai',laya:{enabled:false,mode:'off',roles:[]},magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:hash('OFFLINE_CONFIG')};
  x.owner.configured=()=>({op:{probeExpiresAt:expiry},budget:{}});
  assert.throws(()=>x.owner.customProbeBinding(snapshot),{code:'CUSTOM_PROBE_EXPIRY_REQUIRED'});assert.equal(x.reads(),0);
 }
});
async function stageFixture(t){
 const x=fixture(t),controller=new AbortController();x.input.signal=controller.signal;x.isolateAdmission();x.journal();let signed=0;
 x.owner.withCustomMagpieControl=async()=>({role:'planner2',roleId:'planner2',sessionId:'OFFLINE_SESSION',ledgerRequestIds:[]});
 const stage=await withProcessOwnership(x.scope,()=>x.owner.executeCustomRoleProbe(x.input,()=>{}));
 x.owner.customAccountSelection=()=>({prepared:{flowConfig:{}}});x.owner.customProbeBinding=()=>({});x.owner.customProofs={async close(){},issueCustom(){signed++;return{evidenceId:'OFFLINE_SIGNER_STUB'};}};
 return{...x,stage,controller,signed:()=>signed};
}
test('a cancelled original stage cannot be signed with a replacement signal',async t=>{
 const x=await stageFixture(t);x.controller.abort();
 assert.throws(()=>x.owner.completeCustomRoleProbe({...x.input,signal:new AbortController().signal},x.stage),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});assert.equal(x.signed(),0);
});
test('a terminal Custom result prevents late stage signing; a current stage is consumed once',async t=>{
 const x=await stageFixture(t);x.h.store.record('CustomRoleProbeResult',null,null,{probeId:x.input.probeId,status:'FAILED'});
 assert.throws(()=>x.owner.completeCustomRoleProbe(x.input,x.stage),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});assert.equal(x.signed(),0);
 const y=await stageFixture(t);assert.equal(y.owner.completeCustomRoleProbe(y.input,y.stage).evidenceId,'OFFLINE_SIGNER_STUB');assert.equal(y.signed(),1);
 assert.throws(()=>y.owner.completeCustomRoleProbe(y.input,y.stage),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});
});

function failureDispositionFixture(t,patch={}){
 const x=fixture(t),probeId='custom_probe_OFFLINE_NO_EFFECT',preparation={...x.input.preparation},dispatchId='dispatch_OFFLINE_NO_EFFECT',generation='dispatch_owner_OFFLINE_NO_EFFECT',selectionHash=hash({selection:x.input.selection,roleId:'planner2'});
 const intent={probeId,operationHash:hash('OFFLINE_OPERATION'),selectionHash,preparation,purpose:'MINIMUM_ROLE_ONLY',automaticRetry:false,at:'2026-11-07T00:00:00.000Z'};
 const attempt={probeId,bindingHash:preparation.bindingHash,role:'planner2',roleId:'planner2',dispatchId,generation,nonce:'DM_CUSTOM_PROBE_OFFLINE_NO_EFFECT'};
 const grant={dispatchId,kind:'planner2',mode:'live',cleanupReturned:false,purpose:'CUSTOM_ROLE_PROBE',acceptanceId:probeId,generation,at:'2026-11-07T00:00:01.000Z'};
 const finished={dispatchId,outcome:'NATIVE_PRICE_ROUTE_MISMATCH',cleanupReturned:true,purpose:'CUSTOM_ROLE_PROBE',acceptanceId:probeId,generation,at:'2026-11-07T00:00:02.000Z'};
 const budgetReceipt={probeId,roleId:'planner2',event:{method:'dm/budget',params:{requests:[]}}};
 const result={probeId,status:'FAILED',code:'NATIVE_PRICE_ROUTE_MISMATCH',automaticRetry:false,at:'2026-11-07T00:00:03.000Z'};
 x.h.store.record('CustomRoleProbeIntent',null,null,intent);
 x.h.store.record('DispatchGranted',null,null,grant);
 x.h.store.record('NativeCustomProbeAttempt',null,null,attempt);
 x.h.store.record('NativeBudgetReceipt',null,null,budgetReceipt);
 x.h.store.record('DispatchFinished',null,null,finished);
 x.h.store.record('CustomRoleProbeResult',null,null,result);
 let ledger=[];
 x.owner.configured=()=>({op:{},budget:{requests:()=>ledger}});
 return{...x,probeId,intent,attempt,grant,finished,budgetReceipt,result,setLedger:value=>ledger=value};
}

test('NativeOwner proves a price-route refusal never reserved or sent a model request',t=>{
 const x=failureDispositionFixture(t);
 assert.equal(typeof x.owner.customProbeFailureDisposition,'function');
 assert.equal(x.owner.customProbeFailureDisposition(x.probeId),true);
});

test('no-effect proof fails closed on receipts, ledger rows, cleanup gaps, duplicate attempts or model sessions',t=>{
 for(const sabotage of [
  x=>x.h.store.record('NativeCustomProbeReceipt',null,null,{payload:{probeId:x.probeId}}),
  x=>x.setLedger([{id:'OFFLINE_PAID',customProbe:{probeId:x.probeId}}]),
  x=>x.h.store.db.prepare('UPDATE records SET data=json_set(data,\'$.cleanupReturned\',false) WHERE kind=\'DispatchFinished\' AND json_extract(data,\'$.dispatchId\')=?').run(x.attempt.dispatchId),
  x=>x.h.store.record('NativeCustomProbeAttempt',null,null,x.attempt),
  x=>x.h.store.record('AgentSession',null,null,{role:'planner2',dispatchId:x.attempt.dispatchId,generation:x.attempt.generation}),
  x=>x.h.store.record('CustomRoleProbeIntent',null,null,{...x.intent,probeId:'custom_probe_OFFLINE_SECOND',operationHash:hash('SECOND'),at:'2026-11-07T00:00:04.000Z'})
 ]){
  const x=failureDispositionFixture(t);
  sabotage(x);
  assert.equal(x.owner.customProbeFailureDisposition(x.probeId),false);
 }
});

function gatewayFailureDispositionFixture(t){
 const x=fixture(t),probeId='custom_probe_OFFLINE_GATEWAY_REJECT',preparation={...x.input.preparation},dispatchId='dispatch_OFFLINE_GATEWAY_REJECT',generation='dispatch_owner_OFFLINE_GATEWAY_REJECT',selectionHash=hash({selection:x.input.selection,roleId:'planner2'});
 const admissionId='admission_OFFLINE_GATEWAY_REJECT',createdAt='2026-11-07T00:00:00.500Z',finishedAt='2026-11-07T00:00:02.000Z',resultAt='2026-11-07T00:00:02.100Z',binary=Buffer.from('OFFLINE_MAGPIE'),binaryHash=hash(binary);
 const intent={probeId,operationHash:hash('OFFLINE_OPERATION'),selectionHash,preparation,purpose:'MINIMUM_ROLE_ONLY',automaticRetry:false,at:'2026-11-07T00:00:00.000Z'};
 const attempt={probeId,bindingHash:preparation.bindingHash,role:'planner2',roleId:'planner2',dispatchId,generation,nonce:'DM_CUSTOM_PROBE_OFFLINE_GATEWAY_REJECT'};
 const grant={dispatchId,kind:'planner2',mode:'live',cleanupReturned:false,purpose:'CUSTOM_ROLE_PROBE',acceptanceId:probeId,generation,at:'2026-11-07T00:00:00.100Z'};
 const receipt={id:'OFFLINE_LEDGER_REQUEST',role:'planner2',usageStatus:'UNKNOWN',outcome:'MODEL_GATEWAY_UPSTREAM_FAILURE',createdAt,
  binding:{schema:'dream-maker.native-request-binding.v1',projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',engineeringMode:'custom',configurationHash:hash('OFFLINE_CONFIG'),planVersionHash:hash('OFFLINE_PLAN'),specHash:hash('OFFLINE_SPEC'),dispatchId,generation,role:'planner2',roleId:'planner2',work:{kind:'QUALIFICATION',probeId,bindingHash:preparation.bindingHash},bodyHash:hash('OFFLINE_BODY'),routeHash:hash('OFFLINE_ROUTE')},
  customProbe:{schema:'dream-maker.custom-probe-budget.v1',probeId,bindingHash:preparation.bindingHash,dispatchId,generation,role:'planner2',roleId:'planner2'},
  routerAdmission:{schema:'dream-maker.magpie-grant-intent.v1',admissionId,epoch:'dm_OFFLINE',binaryHash,status:'ACKNOWLEDGED',createdAt}};
 const budgetReceipt={probeId,roleId:'planner2',event:{method:'dm/budget',params:{requests:[receipt]}}};
 const finished={dispatchId,outcome:'RUNNER_RPC_ERROR',cleanupReturned:true,purpose:'CUSTOM_ROLE_PROBE',acceptanceId:probeId,generation,at:finishedAt};
 const result={probeId,status:'FAILED',code:'RUNNER_RPC_ERROR',automaticRetry:false,at:resultAt};
 x.h.store.record('CustomRoleProbeIntent',null,null,{...intent,probeId:'custom_probe_OFFLINE_PRIOR',operationHash:hash('OFFLINE_PRIOR_OPERATION'),preparation:{...preparation,bindingHash:hash('OFFLINE_PRIOR_BINDING')},at:'2026-11-06T23:59:59.000Z'});
 x.h.store.record('CustomRoleProbeIntent',null,null,intent);
 x.h.store.record('DispatchGranted',null,null,grant);
 x.h.store.record('NativeCustomProbeAttempt',null,null,attempt);
 x.h.store.record('NativeBudgetReceipt',null,null,{probeId,roleId:'planner2',event:{method:'dm/event',params:{event:{type:'ready'}}}});
 x.h.store.record('NativeBudgetReceipt',null,null,{probeId,roleId:'planner2',event:{method:'dm/event',params:{event:{type:'status'}}}});
 x.h.store.record('NativeBudgetReceipt',null,null,budgetReceipt);
 x.h.store.record('DispatchFinished',null,null,finished);
 x.h.store.record('CustomRoleProbeResult',null,null,result);
 const usageDirectory=join(x.h.dir,'.runtime/magpie-controls/owned-OFFLINE/data');
 mkdirSync(usageDirectory,{recursive:true});
 const binaryPath=join(x.h.dir,'.runtime/magpie-controls/owned-OFFLINE/dream-maker-magpie.exe');
 writeFileSync(binaryPath,binary);
 const usage={t:'2026-11-07T00:00:00.700Z',agent:'DreamMaker-Dedicated-Magpie',provider:'',callerKeyId:'offline-key',callerKeyName:`Dream Maker ${admissionId}`,model:'',in:0,out:0,cache_read:0,cache_write:0,ms:0,status:503,err:'this gateway key is held to a limit, but magpie Key limits plugin is not serving it, so nothing was sent',err_type:'gateway_key_limit_off',ep:'/v1/messages',rejected:true};
 const usagePath=join(usageDirectory,'usage.jsonl');
 writeFileSync(usagePath,JSON.stringify(usage)+'\n');
 let ledger=[receipt];
 x.owner.configured=()=>({op:{},budget:{requests:()=>ledger}});
 return{...x,probeId,admissionId,receipt,budgetReceipt,binary,binaryPath,usage,usagePath,setLedger:value=>ledger=value,writeUsage:value=>writeFileSync(usagePath,JSON.stringify(value)+'\n'),writeBinary:value=>writeFileSync(binaryPath,value)};
}

test('an acknowledged gateway rejection with matching zero-token usage evidence is provably pre-upstream',t=>{
 const x=gatewayFailureDispositionFixture(t);
 assert.equal(x.owner.customProbeFailureDisposition(x.probeId),true);
});

test('gateway rejection no-effect proof fails closed on mismatched ledger or upstream usage evidence',t=>{
 for(const sabotage of [
  x=>x.writeUsage({...x.usage,status:500}),
  x=>x.writeUsage({...x.usage,rejected:false}),
  x=>x.writeUsage({...x.usage,in:1}),
  x=>x.writeUsage({...x.usage,callerKeyName:'Dream Maker admission_FOREIGN'}),
  x=>x.writeUsage({...x.usage,t:'2026-11-08T00:00:00.700Z'}),
  x=>x.writeBinary(Buffer.from('DIFFERENT_MAGPIE')),
  x=>x.setLedger([{...x.receipt,outcome:'COMPLETE'}]),
  x=>x.setLedger([{...x.receipt,routerAdmission:{...x.receipt.routerAdmission,status:'PENDING'}}]),
  x=>x.h.store.record('NativeBudgetReceipt',null,null,x.budgetReceipt),
 ]){
  const x=gatewayFailureDispositionFixture(t);
  sabotage(x);
  assert.equal(x.owner.customProbeFailureDisposition(x.probeId),false);
 }
});

test('Magpie Reviewer preparation rejects the Executor quote before dispatch and accepts its own CNY quote',t=>{
 const x=fixture(t);x.isolateAdmission();delete x.owner.customProbePreparation;
 x.owner.customProbeBinding=()=>({roles:[{role:'reviewer',roleId:'reviewer',runtime:'claude',transport:'magpie',authentication:'API_KEY',provider:'string',model:'claude-sonnet-5'}]});
 const ref={};x.owner.customPriceRef=role=>{assert.equal(role,'reviewer');return ref};
 const price={provider:'deepseek-official',model:'deepseek-reasoner',currency:'CNY',expiresAt:'2099-01-01T00:00:00Z',maxInputTokens:1048576,inputMissMicrosPerMillion:2,inputHitMicrosPerMillion:1,outputMicrosPerMillion:3};
 x.owner.readRef=actual=>{assert.equal(actual,ref);return price};
 const prepare=()=>x.owner.customProbePreparation(x.input.selection,'reviewer');
 assert.throws(prepare,{code:'NATIVE_PRICE_ROUTE_MISMATCH'});
 Object.assign(price,{provider:'string',model:'claude-sonnet-5',currency:'USD'});
 assert.throws(prepare,{code:'NATIVE_PRICE_ROUTE_MISMATCH'});
 price.currency='CNY';assert.equal(prepare().role,'reviewer');assert.equal(x.starts(),0);
});

test('Custom metered probes select the exact provider and model quote before legacy role fallbacks',t=>{
 const x=fixture(t);x.isolateAdmission();delete x.owner.customProbePreparation;
 const priceRef=(name,provider,model)=>{
  const path=join(x.h.dir,name);
  const bytes=JSON.stringify({provider,model,currency:'CNY',source:'OFFLINE_PRICE',expiresAt:'2099-01-01T00:00:00Z',maxInputTokens:1048576,inputMissMicrosPerMillion:2,inputHitMicrosPerMillion:1,outputMicrosPerMillion:3});
  writeFileSync(path,bytes);return {path,sha256:hash(bytes)};
 };
 const executor=priceRef('executor.json','deepseek-official','deepseek-flash');
 const pro=priceRef('pro.json','deepseek-official','deepseek-v4-pro');
 const legacyReviewer=priceRef('legacy-reviewer.json','string','claude-sonnet-5');
 const op={prices:{executor,reviewer:legacyReviewer},customModelPrices:{'deepseek-official/deepseek-v4-pro':pro}};
 x.owner.configured=()=>({op,budget:{}});
 const actor={role:'reviewer',roleId:'reviewer',runtime:'independent',transport:'magpie',authentication:'API_KEY',provider:'deepseek-official',model:'deepseek-v4-pro'};
 x.owner.customProbeBinding=()=>({roles:[actor]});
 const prepare=()=>x.owner.customProbePreparation(x.input.selection,'reviewer');
 assert.equal(prepare().role,'reviewer');
 assert.deepEqual(x.owner.customPriceRef('planner2',actor.provider,actor.model),pro);
 assert.deepEqual(x.owner.customPriceRef('executor',actor.provider,actor.model),pro);
 assert.deepEqual(x.owner.customPriceRef('executor',actor.provider,'deepseek-flash'),executor);
 assert.deepEqual(x.owner.customPriceRef('reviewer','string','claude-sonnet-5'),legacyReviewer);
 assert.deepEqual(x.owner.customPriceRef('planner2',actor.provider,'deepseek-flash'),executor);
 op.customModelPrices['deepseek-official/deepseek-v4-pro']=executor;
 assert.throws(prepare,{code:'NATIVE_PRICE_ROUTE_MISMATCH'});
 op.customModelPrices['deepseek-official/deepseek-v4-pro']=pro;
 writeFileSync(pro.path,'{}');
 assert.throws(prepare,{code:'NATIVE_BINDING_CHANGED'});
 assert.equal(x.starts(),0);
 assert.equal(x.reads(),0);
});
