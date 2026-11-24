// OFFLINE signature/journal fixtures only. Fresh test key; never formal proof or model evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes,createHmac} from 'node:crypto';
import {harness} from '../helpers.mjs';import {NativeProbes} from '../../dist/server/native-probes.js';import {canonical,hash} from '../../dist/server/security.js';
import {EngineDispatch} from '../../dist/server/flow/dispatch.js';import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
async function fixture(t){
 const h=harness(t),key=randomBytes(32),actor=(role,roleId=role)=>({role,roleId,runtime:'dsh',provider:'deepseek-official',authentication:'API_KEY',model:'deepseek-flash',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'}),binding={schema:'dream-maker.custom-probe-binding.v1',flowConfigHash:hash('OFFLINE_FLOW'),sourceBindingHash:hash('OFFLINE_SOURCE'),credentialHash:hash('OFFLINE_CREDENTIAL_GENERATION'),runtimeHash:hash('OFFLINE_RUNTIME'),authorizationHash:hash('OFFLINE_AUTHORITY'),expiresAt:new Date(Date.now()+60000).toISOString(),roles:[actor('planner2'),actor('executor','execA'),actor('reviewer')]},ledger=[];
 const probes=new NativeProbes({store:h.store,key,current:()=>{throw Error('CLASSIC_BINDING_MUST_NOT_BE_READ');},ledger:()=>ledger,invoke:async()=>{throw Error('NO_MODEL_ALLOWED');}});t.after(()=>probes.close());
 const insert=(kind,data)=>h.store.record(kind,null,null,data),seed=(actor,change={},publish=true,originalScope)=>{
  const probeId='custom_probe_OFFLINE_'+actor.roleId,dispatchId=originalScope?.dispatchId??'OFFLINE_DISPATCH_'+actor.roleId,generation=originalScope?.generation??'OFFLINE_GENERATION',nonce='DM_CUSTOM_PROBE_'+actor.roleId;
  const attemptId=insert('NativeCustomProbeAttempt',{probeId,bindingHash:hash(binding),role:actor.role,roleId:actor.roleId,dispatchId,generation,nonce});
  const dispatch={dispatchId,generation,kind:actor.role,mode:'live',purpose:'CUSTOM_ROLE_PROBE',acceptanceId:probeId,...(actor.role==='executor'?{executorRoleId:actor.roleId}:{})};
  if(!originalScope){insert('DispatchGranted',dispatch);insert('DispatchFinished',{...dispatch,outcome:'COMPLETED',cleanupReturned:true});}
  const id='OFFLINE_PAID_'+actor.roleId,routeHash=hash('OFFLINE_ROUTE_'+actor.roleId),context={schema:'dream-maker.custom-probe-budget.v1',probeId,bindingHash:hash(binding),projectId:'offline_project',runId:'offline_prepared_run',configurationHash:binding.flowConfigHash,planVersionHash:hash('OFFLINE_PLAN'),specHash:hash('OFFLINE_SPEC'),role:actor.role,roleId:actor.roleId,routeHash,dispatchId,generation,flowBudget:{currency:'CNY',maxMicros:2000000},roleBudget:{currency:'CNY',maxMicros:1000000}};
  const requestBinding={schema:'dream-maker.native-request-binding.v1',projectId:context.projectId,runId:context.runId,engineeringMode:'custom',configurationHash:context.configurationHash,planVersionHash:context.planVersionHash,specHash:context.specHash,role:context.role,roleId:context.roleId,routeHash,dispatchId,generation,bodyHash:hash('OFFLINE_BODY'),work:{kind:'QUALIFICATION',probeId,bindingHash:context.bindingHash}};
  ledger.push({id,role:actor.role,price:{provider:actor.provider,model:actor.model},usageStatus:'UNKNOWN',outcome:'COMPLETE',customProbe:context,binding:requestBinding,customBudget:{schema:'dream-maker.custom-request-budget.v1',projectId:context.projectId,runId:context.runId,configurationHash:context.configurationHash,roleId:actor.roleId,flow:context.flowBudget,role:context.roleBudget}});
  const payload={schema:'dream-maker.custom-minimum-role-probe.v1',binding,at:new Date().toISOString(),attemptId,probeId,dispatchId,generation,nonce,observation:{...actor,runner:'DSH',responseId:'OFFLINE_RESPONSE_'+actor.roleId,responseHash:hash('OFFLINE_RESPONSE'),sessionId:'OFFLINE_SESSION_'+actor.roleId,routeHash,paidFallback:false,ledgerRequestIds:[id],cleanupReturned:true,reply:nonce},...change};
  if(!publish)return{attemptId,observation:payload.observation};
  const envelope={payload,signature:createHmac('sha256',key).update(canonical(payload)).digest('hex')};return insert('NativeCustomProbeReceipt',envelope);
 };
 return{h,probes,binding,ledger,seed,insert,key};
}
test('Custom readiness verifies exact independently signed roles without Classic, model calls or approval writes',async t=>{
 const x=await fixture(t);assert.equal(typeof x.probes.assertCustomReady,'function');for(const actor of x.binding.roles)x.seed(actor);const before=x.h.store.db.prepare('SELECT count(*) n FROM records').get().n;
 x.probes.assertCustomReady(x.binding);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM records').get().n,before);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM approvals').get().n,0);
});
test('route-bound readiness matches the selected executor and still requires every other role',async t=>{
 const x=await fixture(t),second={...x.binding.roles[1],roleId:'execB'};x.binding.roles.push(second);
 const ready=(roleId,routeHash)=>x.probes.assertCustomReady(x.binding,{roleId,routeHash});
 const route=roleId=>hash('OFFLINE_ROUTE_'+roleId),missing={code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'};
 for(const actor of x.binding.roles.slice(0,-1))x.seed(actor);
 assert.throws(()=>ready('execA',route('execA')),missing);
 x.seed(second);ready('execA',route('execA'));ready('execB',route('execB'));
 assert.throws(()=>ready('execA',route('execB')),missing);
 assert.throws(()=>ready('execA',hash('rotated route')),missing);
 assert.throws(()=>ready('executor',route('execA')),missing);
 assert.throws(()=>ready('unknown',route('execA')),missing);
 assert.throws(()=>ready('execA',''),missing);
 x.ledger.find(entry=>entry.customProbe.roleId==='execA').outcome='PENDING';
 assert.throws(()=>ready('execA',route('execA')),missing);
 x.binding.roles.push({...second});
 assert.throws(()=>ready('execB',route('execB')),{code:'CUSTOM_PROBE_BINDING_INVALID'});
});
test('signed Custom readback exposes its exact original physical probe identity',async t=>{const x=await fixture(t),evidenceId=x.seed(x.binding.roles[0]),out=x.probes.customEvidence(x.binding,'planner2',evidenceId);assert.equal(out.probeId,'custom_probe_OFFLINE_planner2');});
test('Claude signature requires matching transport, harness and one completed reviewer request',async t=>{
 const x=await fixture(t),actor=x.binding.roles[2];
 Object.assign(actor,{runtime:'claude',provider:'string',model:'claude-sonnet-5',transport:'magpie'});
 const {observation,attemptId}=x.seed(actor,{},false);
 const good={...observation,runner:'CLAUDE_CODE'};
 for(const change of [{runner:'DSH'},{transport:'native'},{ledgerRequestIds:[]}]){
  assert.throws(()=>x.probes.issueCustom(x.binding,attemptId,{...good,...change}),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});
 }
 const signed=x.probes.issueCustom(x.binding,attemptId,good);
 assert.deepEqual(x.probes.customEvidence(x.binding,'reviewer',signed.evidenceId),signed);
});

test('original signer publishes Custom evidence only after settled request and DispatchFinished, with stable replay',async t=>{
 const x=await fixture(t);assert.equal(typeof x.probes.issueCustom,'function');
 for(const actor of x.binding.roles){const material=x.seed(actor,{},false),out=x.probes.issueCustom(x.binding,material.attemptId,material.observation);
  assert.equal(out.roleId,actor.roleId);assert.equal(out.source,'REAL_MODEL_RESPONSE');assert.deepEqual(x.probes.issueCustom(x.binding,material.attemptId,material.observation),out);
 }
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeCustomProbeReceipt'").get().n,3);x.probes.assertCustomReady(x.binding);
 assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM runs').get().n,0);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM approvals').get().n,0);
});
test('Custom signer cannot publish before original cleanup or with unsettled fees',async t=>{
 for(const defect of ['cleanup','pending','role','binding']){const x=await fixture(t);assert.equal(typeof x.probes.issueCustom,'function');const material=x.seed(x.binding.roles[0],{},false);
  if(defect==='cleanup')x.h.store.db.prepare("DELETE FROM records WHERE kind='DispatchFinished'").run();
  if(defect==='pending')x.ledger[0].usageStatus='PENDING';if(defect==='role')material.observation.role='reviewer';if(defect==='binding')x.binding.credentialHash=hash('CHANGED');
  assert.throws(()=>x.probes.issueCustom(x.binding,material.attemptId,material.observation),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});
  assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeCustomProbeReceipt'").get().n,0);
 }
});
test('Custom signer rejects different replay, duplicate role sessions and closed custody',async t=>{
 const x=await fixture(t);assert.equal(typeof x.probes.issueCustom,'function');const first=x.seed(x.binding.roles[0],{},false);x.probes.issueCustom(x.binding,first.attemptId,first.observation);
 assert.throws(()=>x.probes.issueCustom(x.binding,first.attemptId,{...first.observation,responseHash:hash('CHANGED')}),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});
 const second=x.seed(x.binding.roles[1],{},false);second.observation.sessionId=first.observation.sessionId;
 assert.throws(()=>x.probes.issueCustom(x.binding,second.attemptId,second.observation),{code:'CUSTOM_ROLE_SESSIONS_REUSED'});
 await x.probes.close();assert.throws(()=>x.probes.issueCustom(x.binding,second.attemptId,second.observation),{code:'NATIVE_PROBES_CLOSED'});
});
test('one physical probe cannot be signed through an alias attempt record',async t=>{
 const x=await fixture(t),m=x.seed(x.binding.roles[0],{},false);x.probes.issueCustom(x.binding,m.attemptId,m.observation);
 const original=JSON.parse(x.h.store.db.prepare('SELECT data FROM records WHERE id=?').get(m.attemptId).data),alias=x.insert('NativeCustomProbeAttempt',original);
 assert.throws(()=>x.probes.issueCustom(x.binding,alias,{...m.observation,sessionId:'OFFLINE_FOREIGN_SESSION',responseHash:hash('FOREIGN')}),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeCustomProbeReceipt'").get().n,1);
});
test('Custom issuance replay remains exact after more than 256 unrelated receipt records',async t=>{
 const x=await fixture(t),m=x.seed(x.binding.roles[0],{},false),first=x.probes.issueCustom(x.binding,m.attemptId,m.observation);
 for(let i=0;i<260;i++)x.insert('NativeCustomProbeReceipt',{untrusted:'OFFLINE_UNRELATED_'+i});
 assert.deepEqual(x.probes.issueCustom(x.binding,m.attemptId,m.observation),first);
 assert.deepEqual(x.probes.customEvidence(x.binding,'planner2',first.evidenceId),first);
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeCustomProbeReceipt'").get().n,261);
});
test('a foreign finish purpose or probe identity cannot authorize Custom issuance',async t=>{
 for(const patch of [{purpose:'DSH_ENGINEERING_ACCEPTANCE'},{acceptanceId:'custom_probe_FOREIGN'}]){const x=await fixture(t),m=x.seed(x.binding.roles[0],{},false);
  const row=x.h.store.db.prepare("SELECT id,data FROM records WHERE kind='DispatchFinished'").get();x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data),...patch}),row.id);
  assert.throws(()=>x.probes.issueCustom(x.binding,m.attemptId,m.observation),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});
 }
});
test('the actual original Dispatch journal can issue all roles after cleanup without fixture finish fields',async t=>{
 const x=await fixture(t),dispatch=new EngineDispatch(x.h.store,{isCurrent:()=>true,measure:()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:8192,sampledAt:new Date().toISOString()})});
 try{for(const actor of x.binding.roles){const material=await dispatch.run({projectId:null,runId:null,kind:actor.role,mode:'live',purpose:'CUSTOM_ROLE_PROBE',acceptanceId:'custom_probe_OFFLINE_'+actor.roleId,signal:new AbortController().signal,...(actor.role==='executor'?{executorRoleId:actor.roleId}:{})},async control=>{const result=x.seed(actor,{},false,currentProcessOwnership());control.confirmCleanup();return result;});
   const receipt=x.probes.issueCustom(x.binding,material.attemptId,material.observation);assert.equal(receipt.roleId,actor.roleId);
  }x.probes.assertCustomReady(x.binding);
 }finally{await dispatch.close();}
});
test('role sessions remain independent after unrelated receipts push the first role out of recent history',async t=>{
 const x=await fixture(t);x.seed(x.binding.roles[0]);for(let i=0;i<260;i++)x.insert('NativeCustomProbeReceipt',{untrusted:'OFFLINE_UNRELATED_'+i});
 const m=x.seed(x.binding.roles[1],{},false);m.observation.sessionId='OFFLINE_SESSION_planner2';
 assert.throws(()=>x.probes.issueCustom(x.binding,m.attemptId,m.observation),{code:'CUSTOM_ROLE_SESSIONS_REUSED'});
});
test('Classic signatures, ledger completion and unsigned Custom labels cannot qualify a role',async t=>{
 const x=await fixture(t);assert.equal(typeof x.probes.assertCustomReady,'function');x.insert('NativeProbeReceipt',{payload:{schema:'dream-maker.minimum-role-probe.v1'},signature:'a'.repeat(64)});
 x.insert('NativeCustomProbeReceipt',{payload:{schema:'dream-maker.custom-minimum-role-probe.v1',binding:x.binding},signature:'a'.repeat(64)});assert.throws(()=>x.probes.assertCustomReady(x.binding),{code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'});
});
for(const key of ['flowConfigHash','sourceBindingHash','credentialHash','runtimeHash','authorizationHash'])test('Custom evidence cannot survive '+key+' drift',async t=>{
 const x=await fixture(t);assert.equal(typeof x.probes.assertCustomReady,'function');for(const actor of x.binding.roles)x.seed(actor);x.binding[key]=hash('CHANGED');assert.throws(()=>x.probes.assertCustomReady(x.binding),{code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'});
});
test('Custom proof requires its exact settled paid request and original completed cleanup journal',async t=>{
 for(const defect of ['pending','role','route','purpose','cleanup']){const x=await fixture(t);assert.equal(typeof x.probes.assertCustomReady,'function');for(const actor of x.binding.roles)x.seed(actor);
  if(defect==='pending')x.ledger[0].usageStatus='PENDING';if(defect==='role')x.ledger[0].customProbe.roleId='reviewer';if(defect==='route')x.ledger[0].customProbe.routeHash=hash('FOREIGN');
  if(defect==='purpose')x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.purpose','DSH_ENGINEERING_ACCEPTANCE') WHERE kind='DispatchGranted'").run();
  if(defect==='cleanup')x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.cleanupReturned',json('false')) WHERE kind='DispatchFinished'").run();
  assert.throws(()=>x.probes.assertCustomReady(x.binding),{code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'});
 }
});
test('Custom planner and reviewer cannot reuse one SDK session, even with valid signatures',async t=>{
 const x=await fixture(t);assert.equal(typeof x.probes.assertCustomReady,'function');for(const actor of x.binding.roles){if(actor.role!=='reviewer')x.seed(actor);else x.seed(actor,{observation:{...actor,runner:'DSH',responseId:'OFFLINE_RESPONSE_reviewer',responseHash:hash('OFFLINE_RESPONSE'),sessionId:'OFFLINE_SESSION_planner2',routeHash:hash('OFFLINE_ROUTE_reviewer'),paidFallback:false,ledgerRequestIds:['OFFLINE_PAID_reviewer'],cleanupReturned:true,reply:'DM_CUSTOM_PROBE_reviewer'}});}
 assert.throws(()=>x.probes.assertCustomReady(x.binding),{code:'CUSTOM_ROLE_SESSIONS_REUSED'});
});
test('Custom executor qualification cannot borrow another executor dispatch grant',async t=>{
 const x=await fixture(t);for(const actor of x.binding.roles)x.seed(actor);x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.executorRoleId','execB') WHERE kind='DispatchGranted' AND json_extract(data,'$.kind')='executor'").run();
 assert.throws(()=>x.probes.assertCustomReady(x.binding),{code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'});
});

// OFFLINE: API-key harnesses must prove every paid Magpie request, not borrow subscription evidence.
for(const runtime of ['codex','independent'])test(runtime+' API-key qualification verifies its complete paid request set',async t=>{
 const x=await fixture(t),actor=x.binding.roles[0];actor.runtime=runtime;actor.model='deepseek-v4-pro';
 const m=x.seed(actor,{},false);m.observation.runner=runtime==='codex'?'CODEX':'INDEPENDENT_API';
 const extra=structuredClone(x.ledger[0]);extra.id+='SECOND';x.ledger.push(extra);m.observation.ledgerRequestIds.push(extra.id);
 const issued=x.probes.issueCustom(x.binding,m.attemptId,m.observation);
 assert.equal(x.probes.customEvidence(x.binding,actor.roleId,issued.evidenceId).evidenceId,issued.evidenceId);
});
async function includedSubscriptionProbe(t){
 const x=await fixture(t),actor=x.binding.roles[0];
 Object.assign(actor,{runtime:'codex',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:'gpt-6-luna',transport:'magpie'});
 const material=x.seed(actor,{},false);material.observation.runner='CODEX';
 Object.assign(x.ledger[0],{usageStatus:'KNOWN',outcome:'COMPLETE',reservedMicros:0,chargedMicros:0,
  price:{provider:'openai',model:'gpt-6-luna',billing:'CHATGPT_INCLUDED',source:'CODEX_INCLUDED_QUOTA'}});
 return{x,actor,material};
}
test('Codex subscription through Magpie accepts one zero-cost included-quota request without weakening paid-route proof',async t=>{
 const {x,actor,material}=await includedSubscriptionProbe(t);
 const issued=x.probes.issueCustom(x.binding,material.attemptId,material.observation);
 assert.equal(issued.roleId,actor.roleId);assert.equal(x.probes.customEvidence(x.binding,actor.roleId,issued.evidenceId).evidenceId,issued.evidenceId);
});
for(const defect of ['charged','reserved','billing','source','pending','duplicate'])test('Codex subscription through Magpie refuses '+defect+' request evidence',async t=>{
 const {x,material}=await includedSubscriptionProbe(t),request=x.ledger[0];
 if(defect==='charged')request.chargedMicros=1;
 if(defect==='reserved')request.reservedMicros=1;
 if(defect==='billing')request.price.billing='METERED';
 if(defect==='source')request.price.source='CALLER_QUOTE';
 if(defect==='pending')request.usageStatus='PENDING';
 if(defect==='duplicate'){const extra=structuredClone(request);extra.id+='SECOND';x.ledger.push(extra);material.observation.ledgerRequestIds.push(extra.id);}
 assert.throws(()=>x.probes.issueCustom(x.binding,material.attemptId,material.observation),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});
});
for(const defect of ['missing','pending','failed','foreign','duplicate','omitted','overflow'])test('paid Custom qualification refuses '+defect+' request evidence',async t=>{
 const x=await fixture(t),actor=x.binding.roles[0];actor.runtime='codex';actor.model='deepseek-v4-pro';
 const m=x.seed(actor,{},false);m.observation.runner='CODEX';
 if(defect==='missing')x.ledger.length=0;
 if(defect==='pending')x.ledger[0].usageStatus='PENDING';
 if(defect==='failed')x.ledger[0].outcome='MODEL_GATEWAY_UPSTREAM_FAILURE';
 if(defect==='foreign')x.ledger[0].customProbe.generation='FOREIGN';
 if(defect==='duplicate')m.observation.ledgerRequestIds.push(m.observation.ledgerRequestIds[0]);
 if(defect==='omitted'){const r=structuredClone(x.ledger[0]);r.id+='HIDDEN';x.ledger.push(r);}
 if(defect==='overflow')for(let i=0;i<4;i++){const r=structuredClone(x.ledger[0]);r.id+='EXTRA'+i;x.ledger.push(r);m.observation.ledgerRequestIds.push(r.id);}
 assert.throws(()=>x.probes.issueCustom(x.binding,m.attemptId,m.observation),{code:'CUSTOM_PROBE_ISSUANCE_UNVERIFIED'});
});
