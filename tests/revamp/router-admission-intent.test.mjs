// OFFLINE original-ledger recovery tests. No product model or user credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {offlineCustomBudget,offlineCustomQualification} from '../fixtures/custom-budget.mjs';
import {harness} from '../helpers.mjs';
const authority={scopeId:'OFFLINE_ROUTER',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1000,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
const binding=()=>({schema:'dream-maker.native-request-binding.v1',projectId:'project_offline',runId:'run_offline',engineeringMode:'custom',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'dispatch_offline',generation:'owner_offline',role:'executor',roleId:'executor-1',work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null},bodyHash:'e'.repeat(64),routeHash:'f'.repeat(64)});
const intent=()=>({schema:'dream-maker.magpie-grant-intent.v1',admissionId:'grant-offline',epoch:'epoch-offline',binaryHash:'1'.repeat(64),controlHash:'2'.repeat(64),expiresAtMs:Date.now()+30000});
const ack=(row,input,accepted=true)=>({type:'admission',schema:'dream-maker.magpie-admission-ack.v2',epoch:input.epoch,id:input.admissionId,reservationId:row.id,controlHash:input.controlHash,accepted});
function setup(t){
 let budget;const close=[];t.after(()=>{for(const fn of close.reverse())fn();budget?.close();});
 const h=harness(t),path=resolve(h.dir,'router-budget.sqlite');
 const open=()=>new NativeBudget(path,authority,undefined,undefined,'FULL_DM',offlineCustomBudget,offlineCustomQualification);
 budget=open();return{budget,path,open,dispose:fn=>close.push(fn)};
}

test('the original pending reservation records one nonsecret grant intent before dispatch',t=>{
 const {budget}=setup(t),scope=binding(),row=budget.reserve('executor',price(),128,undefined,scope),input=intent();
 const saved=budget.beginRouterAdmission(row.id,scope,input);input.controlHash='9'.repeat(64);saved.status='UNKNOWN';
 const stored=budget.requests()[0].routerAdmission;
 assert.equal(stored.status,'INTENT');assert.equal(stored.controlHash,'2'.repeat(64));assert.equal(budget.requests().length,1);
 assert.throws(()=>budget.beginRouterAdmission(row.id,scope,intent()),{code:'NATIVE_ROUTER_INTENT_EXISTS'});
 assert.equal('token'in stored,false);assert.equal('upstreamKey'in stored,false);
});
test('Classic, unbound, wrong body, malformed and settled requests cannot get a Magpie grant',t=>{
 const {budget}=setup(t),classic={...binding(),runId:'run_offline_classic',engineeringMode:'classic'},old=budget.reserve('executor',price(),128,undefined,classic);
 assert.throws(()=>budget.beginRouterAdmission(old.id,classic,intent()),{code:'CLASSIC_MAGPIE_FORBIDDEN'});budget.settle(old.id,null,'OFFLINE_END');
 const scope=binding(),row=budget.reserve('executor',price(),128,undefined,scope);
 assert.throws(()=>budget.beginRouterAdmission(row.id,{...scope,bodyHash:'0'.repeat(64)},intent()),{code:'NATIVE_REQUEST_BINDING_MISMATCH'});
 for(const input of [{...intent(),token:'OFFLINE_CANARY'},{...intent(),verified:true},{...intent(),controlHash:'invalid'},Object.assign(Object.create({epoch:'epoch-offline'}),{...intent(),epoch:undefined})])assert.throws(()=>budget.beginRouterAdmission(row.id,scope,input),{code:'NATIVE_ROUTER_INTENT_INVALID'});
 assert.equal(budget.requests()[1].routerAdmission,undefined);budget.settle(row.id,null,'OFFLINE_END');assert.throws(()=>budget.beginRouterAdmission(row.id,scope,intent()),{code:'NATIVE_REQUEST_NOT_PENDING'});
});
test('a delayed, oversized or price-outliving grant is refused without modifying the pending hold',t=>{
 const {budget}=setup(t),scope=binding(),quote=price(),row=budget.reserve('executor',quote,128,undefined,scope);
 for(const expiresAtMs of [Date.now()-1,Date.now()+120001,Date.parse(quote.expiresAt)+1])assert.throws(()=>budget.beginRouterAdmission(row.id,scope,{...intent(),expiresAtMs}),{code:'NATIVE_ROUTER_INTENT_INVALID'});
 assert.equal(budget.requests()[0].routerAdmission,undefined);assert.equal(budget.requests()[0].usageStatus,'PENDING');
});
test('only the precise versioned acknowledgement decides its persisted intent, once',t=>{
 const {budget}=setup(t),scope=binding(),row=budget.reserve('executor',price(),128,undefined,scope),input=intent();budget.beginRouterAdmission(row.id,scope,input);
 for(const reply of [{type:'admission',accepted:true},{...ack(row,input),epoch:'previous-epoch'},{...ack(row,input),id:'other-grant'},{...ack(row,input),reservationId:'other-reservation'},{...ack(row,input),controlHash:'0'.repeat(64)},{...ack(row,input),accepted:'true'},{...ack(row,input),verified:true}])assert.throws(()=>budget.acknowledgeRouterAdmission(row.id,scope,reply),{code:'NATIVE_ROUTER_ACK_MISMATCH'});
 assert.equal(budget.requests()[0].routerAdmission.status,'INTENT');const saved=budget.acknowledgeRouterAdmission(row.id,scope,ack(row,input));assert.equal(saved.status,'ACKNOWLEDGED');
 assert.throws(()=>budget.acknowledgeRouterAdmission(row.id,scope,ack(row,input)),{code:'NATIVE_ROUTER_INTENT_ALREADY_DECIDED'});assert.equal(budget.requests()[0].usageStatus,'PENDING');
});
test('a negative acknowledgement does not qualify or resend a request',t=>{
 const {budget}=setup(t),scope=binding(),row=budget.reserve('executor',price(),128,undefined,scope),input=intent();budget.beginRouterAdmission(row.id,scope,input);
 assert.equal(budget.acknowledgeRouterAdmission(row.id,scope,ack(row,input,false)).status,'DENIED');assert.equal(budget.requests()[0].usageStatus,'PENDING');
 assert.throws(()=>budget.beginRouterAdmission(row.id,scope,intent()),{code:'NATIVE_ROUTER_INTENT_EXISTS'});assert.equal(budget.requests().length,1);
});
test('lost acknowledgements remain unknown across restart and keep the full original cost',t=>{
 const {budget,path,open,dispose}=setup(t),scope=binding(),row=budget.reserve('executor',price(),128,undefined,scope),input=intent();budget.beginRouterAdmission(row.id,scope,input);
 assert.throws(()=>budget.markRouterAdmissionUnknown(row.id,'0'.repeat(64)),{code:'NATIVE_ROUTER_ACK_MISMATCH'});budget.markRouterAdmissionUnknown(row.id,input.controlHash);assert.equal(budget.requests()[0].routerAdmission.status,'UNKNOWN');
 budget.close();const restarted=open();dispose(()=>restarted.close());const saved=restarted.requests()[0];assert.equal(saved.routerAdmission.status,'UNKNOWN');assert.equal(saved.usageStatus,'UNKNOWN');assert.equal(saved.chargedMicros,row.reservedMicros);
 assert.throws(()=>restarted.beginRouterAdmission(row.id,scope,intent()),{code:'NATIVE_REQUEST_NOT_PENDING'});
});
test('an unacknowledged durable intent is recovered as unknown without backfilling old request rows',t=>{
 const {budget,path,open,dispose}=setup(t),old=budget.reserve('executor',price(),128);budget.settle(old.id,null,'OLD_UNKNOWN');
 const scope=binding(),row=budget.reserve('executor',price(),128,undefined,scope);budget.beginRouterAdmission(row.id,scope,intent());const db=new DatabaseSync(path,{readOnly:true});dispose(()=>db.close());const bytes=db.prepare('SELECT data FROM requests WHERE id=?').get(old.id).data;
 budget.close();const restarted=open();dispose(()=>restarted.close());assert.equal(restarted.requests()[1].routerAdmission.status,'UNKNOWN');assert.equal(db.prepare('SELECT data FROM requests WHERE id=?').get(old.id).data,bytes);
});

test('owner-close settlement before restart cannot leave delivery metadata waiting for a lost ack',t=>{
 const {budget,open,dispose}=setup(t),scope=binding(),row=budget.reserve('executor',price(),128,undefined,scope);budget.beginRouterAdmission(row.id,scope,intent());
 budget.settle(row.id,null,'OWNER_CLOSE_UNKNOWN');const before=budget.requests()[0];assert.equal(before.usageStatus,'UNKNOWN');budget.close();
 const restarted=open();dispose(()=>restarted.close());const saved=restarted.requests()[0];assert.equal(saved.routerAdmission.status,'UNKNOWN');assert.equal(saved.outcome,before.outcome);assert.equal(saved.chargedMicros,before.chargedMicros);assert.deepEqual(saved.binding,before.binding);
});
