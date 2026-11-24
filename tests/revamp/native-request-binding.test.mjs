// OFFLINE ledger/HTTP integration, no model or user account. Formal ledgers are never opened.
import test from 'node:test';import assert from 'node:assert/strict';import{resolve}from'node:path';import{DatabaseSync}from'node:sqlite';
import{harness}from'../helpers.mjs';import{NativeBudget}from'../../dist/server/native-budget.js';import{DeepSeekGateway}from'../../dist/server/deepseek-gateway.js';import{hash,DomainError}from'../../dist/server/security.js';
const authority={scopeId:'OFFLINE_SCOPE',authorizationHash:'OFFLINE_AUTHORIZATION',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
const binding=()=>({schema:'dream-maker.native-request-binding.v1',projectId:'project_offline',runId:'run_offline',engineeringMode:'classic',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'dispatch_offline',generation:'dispatch_owner_offline',role:'executor',roleId:'executor-1',work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null},bodyHash:'e'.repeat(64),routeHash:'f'.repeat(64)});
function ledger(t){let budget;const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();budget?.close();});const h=harness(t),path=resolve(h.dir,'bound-budget.sqlite');budget=new NativeBudget(path,authority);return{h,path,budget,dispose:close=>cleanup.push(close)};}

test('binding is persisted atomically with the reservation, cloned, and retained by settlement',t=>{
 const {budget}=ledger(t),scope=binding(),row=budget.reserve('executor',price(),128,undefined,scope);scope.bodyHash='f'.repeat(64);
 assert.equal(row.binding.bodyHash,'e'.repeat(64));assert.deepEqual(budget.pendingBoundRequest(row.id,binding()).binding,binding());
 assert.throws(()=>budget.pendingBoundRequest(row.id,{...binding(),runId:'run_another'}),{code:'NATIVE_REQUEST_BINDING_MISMATCH'});
 assert.throws(()=>budget.pendingBoundRequest(row.id,{...binding(),routeHash:'0'.repeat(64)}),{code:'NATIVE_REQUEST_BINDING_MISMATCH'});
 budget.settle(row.id,{inputTokens:1,outputTokens:1,cacheHitTokens:0},'COMPLETE');assert.deepEqual(budget.requests()[0].binding,binding());assert.throws(()=>budget.pendingBoundRequest(row.id,binding()),{code:'NATIVE_REQUEST_NOT_PENDING'});
});

test('role confusion, secret/proof fields and malformed binding cannot consume a budget reservation',t=>{
 const {budget}=ledger(t);for(const scope of [{...binding(),role:'reviewer',roleId:'reviewer',work:{kind:'SUPERVISION'}},{...binding(),verified:true},{...binding(),configurationHash:'not-a-hash'},{...binding(),roleId:'planner2'},{...binding(),work:{kind:'TASK',taskIdHash:null,executorSliceId:null}},{...binding(),token:'OFFLINE_CANARY'}])assert.throws(()=>budget.reserve('executor',price(),128,undefined,scope),{code:'NATIVE_REQUEST_BINDING_INVALID'});
 assert.equal(budget.requests().length,0);
});

test('prototype-derived work kinds and hidden proof fields cannot create a malformed charged hold',t=>{
 const {budget}=ledger(t),work=Object.assign(Object.create({kind:'TASK'}),{taskIdHash:'d'.repeat(64),executorSliceId:null,verified:true});
 assert.throws(()=>budget.reserve('executor',price(),128,undefined,{...binding(),work}),{code:'NATIVE_REQUEST_BINDING_INVALID'});assert.equal(budget.requests().length,0);
});

test('a repair request needs the original ledger round and cannot borrow its hold after that round advances',t=>{
 const {budget}=ledger(t),scope={...binding(),work:{kind:'REPAIR',round:1,inputHash:'1'.repeat(64)}};
 assert.equal(budget.repairRevision(scope.runId),0);assert.throws(()=>budget.reserve('executor',price(),128,undefined,scope),{code:'NATIVE_REPAIR_BINDING_MISMATCH'});assert.equal(budget.requests().length,0);
 budget.repair(scope.runId);const row=budget.reserve('executor',price(),128,undefined,scope);assert.equal(budget.pendingBoundRequest(row.id,scope).binding.work.round,1);budget.repair(scope.runId);
 assert.throws(()=>budget.pendingBoundRequest(row.id,scope),{code:'NATIVE_REPAIR_BINDING_MISMATCH'});budget.settle(row.id,null,'UNKNOWN');assert.deepEqual(budget.requests()[0].binding.work,scope.work);assert.equal(budget.requests()[0].chargedMicros,row.reservedMicros);
});

test('historical unbound rows keep their exact bytes and cannot be borrowed as a scoped hold',t=>{
 const {path,budget,dispose}=ledger(t),old=budget.reserve('executor',price(),128);budget.settle(old.id,{inputTokens:1,outputTokens:1,cacheHitTokens:0},'COMPLETE');const db=new DatabaseSync(path,{readOnly:true});dispose(()=>db.close());const before=db.prepare('SELECT data FROM requests WHERE id=?').get(old.id).data;
 const next=budget.reserve('executor',price(),128,undefined,binding());assert.ok(next.binding);assert.equal(db.prepare('SELECT data FROM requests WHERE id=?').get(old.id).data,before);assert.throws(()=>budget.pendingBoundRequest(old.id,binding()));
});

test('a restarted controller retains scoped unknown cost and never reuses the old pending hold',t=>{
 const {path,budget,dispose}=ledger(t),first=budget.reserve('executor',price(),128,undefined,binding());budget.close();const reopened=new NativeBudget(path,authority);dispose(()=>reopened.close());const row=reopened.requests()[0];assert.equal(row.usageStatus,'UNKNOWN');assert.equal(row.chargedMicros,row.reservedMicros);assert.deepEqual(row.binding,binding());assert.throws(()=>reopened.pendingBoundRequest(first.id,binding()),{code:'NATIVE_REQUEST_NOT_PENDING'});
});

test('a bound pending hold cannot be handed to a router after its fixed price expires',t=>{
 const {budget}=ledger(t),quoted=price(),row=budget.reserve('executor',quoted,128,undefined,binding());t.mock.timers.enable({apis:['Date'],now:Date.parse(quoted.expiresAt)+1});
 assert.throws(()=>budget.pendingBoundRequest(row.id,binding()),{code:'NATIVE_PRICE_EXPIRED'});assert.equal(budget.requests().length,1);assert.equal(budget.requests()[0].usageStatus,'PENDING');
});

async function gateway(t,makeBinding){const {budget,dispose}=ledger(t);let calls=0,sent='';const gateway=new DeepSeekGateway(budget,price,'OFFLINE_KEY',128,2,async(_url,options)=>{calls++;sent=options.body;return new Response(JSON.stringify({id:'offline-response',model:'deepseek-flash',choices:[{index:0,message:{content:'OFFLINE'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'content-type':'application/json'}});},'chat-completions',true,undefined,makeBinding);dispose(()=>gateway.close());const route=await gateway.start();return{budget,calls:()=>calls,sent:()=>sent,request:()=>fetch(route.url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+route.token,'content-type':'application/json'},body:JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'OFFLINE'}],max_tokens:128,tools:[{type:'function',function:{name:'NEVER_RUN'}}],tool_choice:'auto'})})};}
test('the actual normalized upstream body is bound before the original gateway reserves or sends',async t=>{
 const x=await gateway(t,bodyHash=>({...binding(),bodyHash})),response=await x.request();assert.equal(response.status,200,await response.text());assert.equal(x.calls(),1);const row=x.budget.requests()[0];assert.equal(row.binding.bodyHash,hash(x.sent()));assert.deepEqual(JSON.parse(x.sent()).tools,[]);assert.equal('tool_choice'in JSON.parse(x.sent()),false);
});
test('a stale Engine context refuses the next inner request before reserving or calling the provider',async t=>{
 const x=await gateway(t,()=>{throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);}),response=await x.request();assert.equal(response.status,409);assert.equal(x.budget.requests().length,0);assert.equal(x.calls(),0);
});
