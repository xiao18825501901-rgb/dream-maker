// OFFLINE control-protocol tests with synthetic replies and the original ledger.
import test from 'node:test';import assert from 'node:assert/strict';
import {Writable,PassThrough} from 'node:stream';import {resolve} from 'node:path';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {offlineCustomBudget,offlineCustomQualification} from '../fixtures/custom-budget.mjs';
import {MagpieAdmissionPipe} from '../../dist/server/magpie-control.js';
import {magpieRouteHash} from '../../dist/server/magpie-route.js';
import {hash} from '../../dist/server/security.js';import {harness} from '../helpers.mjs';
const authority={scopeId:'OFFLINE_CREDENTIAL_PIPE',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
const route=()=>({runtime:'dsh',provider:'deepseek-official',protocol:'chat-completions',model:'deepseek-flash',authentication:'api_key',accountRef:'account_one',authRef:'auth_one',upstreamAccountRef:'deepseek-official/0123456789'});
const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_SYNTHETIC_PRICE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
const binding=()=>({schema:'dream-maker.native-request-binding.v1',projectId:'project_synthetic',runId:'run_synthetic',engineeringMode:'custom',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'dispatch_synthetic',generation:'owner_synthetic',role:'executor',roleId:'executor-1',work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null},bodyHash:'e'.repeat(64),routeHash:magpieRouteHash(route())});
const draft=(row,scope)=>({token:'3'.repeat(64),id:'grant_synthetic',epoch:'epoch_synthetic',projectId:scope.projectId,flowId:scope.runId,configurationHash:scope.configurationHash,bindingHash:hash(scope),routeHash:scope.routeHash,roleId:scope.roleId,role:scope.role,reservationId:row.id,...route(),method:'POST',path:'/v1/chat/completions',bodyHash:scope.bodyHash,expiresAtMs:Date.now()+30000});
const syntheticSecret='sk-magpie-key-'+'f'.repeat(48);
const issued=(raw,accepted=true)=>{const {request:a}=JSON.parse(raw);return{type:'issued',schema:'dream-maker.magpie-issued-key.v1',epoch:a.epoch,id:a.id,reservationId:a.reservationId,controlHash:hash(raw),accepted,...(accepted?{upstreamKeyId:'d'.repeat(24),upstreamKey:syntheticSecret,expiresAtMs:Date.now()+120000}:{})};};
function fixture(t,onWrite,options={}){
 let channel,budget,finish;const done=new Promise(r=>finish=r),output=new PassThrough();let writes=0,stops=0,last;
 t.after(async()=>{await channel?.close();budget?.close();});
 const h=harness(t);
 budget=new NativeBudget(resolve(h.dir,'credential-budget.sqlite'),authority,undefined,undefined,'FULL_DM',offlineCustomBudget,offlineCustomQualification);
 const scope={...binding(),engineeringMode:options.mode??'custom'},row=budget.reserve('executor',options.price??price(),128,undefined,scope);
 const input=new Writable({write(chunk,_encoding,cb){writes++;last=chunk.toString().replace(/\n$/,'');try{onWrite({raw:last,output,budget,row,scope,cb});}catch(error){cb(error);}}});
 channel=new MagpieAdmissionPipe({input,output,closed:done,stop:async()=>{stops++;finish();}},budget,{epoch:'epoch_synthetic',binaryHash:'1'.repeat(64),ackTimeoutMs:options.ackTimeoutMs??100});
 return{channel,budget,scope,row,output,prepare:(signal,a=draft(row,scope))=>channel.prepare(row.id,scope,a,signal),draft:()=>draft(row,scope),last:()=>last,writes:()=>writes,stops:()=>stops};
}
test('prepare uses the exact original pending hold then grant retains the original durable intent',async t=>{
 let observed;
 const x=fixture(t,({raw,output,budget,cb})=>{
  const msg=JSON.parse(raw);
  if(msg.type==='issue'){observed=msg.request;assert.equal(budget.requests()[0].routerAdmission,undefined);output.write(JSON.stringify(issued(raw))+'\n');}
  else{const a=msg.admission;assert.equal(budget.requests()[0].routerAdmission.status,'INTENT');output.write(JSON.stringify({type:'admission',schema:'dream-maker.magpie-admission-ack.v2',epoch:a.epoch,id:a.id,reservationId:a.reservationId,controlHash:hash(raw),accepted:true})+'\n');}
  cb();
 },{ackTimeoutMs:5000}); // This successful SQLite/pipe path uses the production window; deadline counterexamples keep 100ms.
 const grant=await x.prepare();assert.equal(grant.upstreamKey,syntheticSecret);assert.equal(grant.upstreamKeyId,'d'.repeat(24));
 assert.equal(observed.maxInputTokens,x.row.price.maxInputTokens);assert.equal(observed.maxOutputTokens,x.row.maxOutputTokens);
 assert.equal(observed.upstreamKey,undefined);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
 assert.equal((await x.channel.grant(x.row.id,x.scope,grant)).status,'ACKNOWLEDGED');
 const rows=JSON.stringify(x.budget.requests());assert.equal(rows.includes(syntheticSecret),false);assert.equal(rows.includes('3'.repeat(64)),false);assert.equal(x.budget.requests()[0].usageStatus,'PENDING');
 await assert.rejects(x.prepare(),{code:'MAGPIE_ISSUANCE_EXISTS'});assert.equal(x.writes(),2);
});
test('Classic, foreign routes and caller limits refuse before an issuance byte',async t=>{
 const classic=fixture(t,({cb})=>cb(),{mode:'classic'});await assert.rejects(classic.prepare(),{code:'CLASSIC_MAGPIE_FORBIDDEN'});assert.equal(classic.writes(),0);
 for(const edit of [{provider:'other'},{model:'other'}]){const x=fixture(t,({cb})=>cb(),{price:{...price(),...edit}});await assert.rejects(x.prepare(),{code:'MAGPIE_CONTROL_BUDGET_MISMATCH'});assert.equal(x.writes(),0);}
 const x=fixture(t,({cb})=>cb());let reads=0;const accessor=x.draft();Object.defineProperty(accessor,'authRef',{enumerable:true,get(){reads++;return'auth_one';}});
 for(const d of [{...x.draft(),maxOutputTokens:999999},{...x.draft(),upstreamKey:syntheticSecret},{...x.draft(),authRef:'another'},accessor])await assert.rejects(x.prepare(undefined,d),{code:'MAGPIE_CONTROL_GRANT_INVALID'});
 assert.equal(reads,0);assert.equal(x.writes(),0);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
});
test('a mismatched issuance reply closes the pipe without inventing a router or model result',async t=>{
 const x=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify({...issued(raw),controlHash:'0'.repeat(64)})+'\n');cb();});
 await assert.rejects(x.prepare(),e=>e.code==='MAGPIE_ISSUANCE_ACK_INVALID'&&e.cause?.category==='ACK_BINDING');assert.equal(x.stops(),1);assert.equal(x.budget.requests()[0].usageStatus,'PENDING');assert.equal(x.budget.requests()[0].routerAdmission,undefined);await assert.rejects(x.prepare());assert.equal(x.writes(),1);
});
test('issuance expiry accepts only a bounded clock-skew window and still rejects overlong keys',async t=>{
 const early=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify({...issued(raw),expiresAtMs:Date.now()-1})+'\n');cb();});
 await assert.rejects(early.prepare(),e=>e.code==='MAGPIE_ISSUANCE_ACK_INVALID'&&e.cause?.category==='ACK_EXPIRY_BEFORE_REQUEST');
 const skewed=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify({...issued(raw),expiresAtMs:Date.now()+124000})+'\n');cb();});
 const grant=await skewed.prepare();assert.equal(grant.upstreamKey,syntheticSecret);
 const late=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify({...issued(raw),expiresAtMs:Date.now()+600000})+'\n');cb();});
 await assert.rejects(late.prepare(),e=>e.code==='MAGPIE_ISSUANCE_ACK_INVALID'&&e.cause?.category==='ACK_EXPIRY_TOO_FAR');
 assert.equal(late.budget.requests()[0].routerAdmission,undefined);
});
test('a known issuance denial has no secret or model result and cannot be resent for that hold',async t=>{
 const x=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify(issued(raw,false))+'\n');cb();});
 await assert.rejects(x.prepare(),{code:'MAGPIE_ISSUANCE_DENIED'});assert.equal(x.budget.requests()[0].routerAdmission,undefined);assert.equal(x.budget.requests()[0].usageStatus,'PENDING');await assert.rejects(x.prepare(),{code:'MAGPIE_ISSUANCE_EXISTS'});assert.equal(x.writes(),1);
});
test('lost or cancelled issuance acknowledgements close once and are never retried',async t=>{
 const x=fixture(t,({cb})=>cb());await assert.rejects(x.prepare(),{code:'MAGPIE_CONTROL_TIMEOUT'});await assert.rejects(x.prepare());assert.equal(x.writes(),1);assert.equal(x.stops(),1);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
 const cancel=new AbortController(),y=fixture(t,({cb})=>{cb();queueMicrotask(()=>cancel.abort());});
 await assert.rejects(y.prepare(cancel.signal),{code:'MAGPIE_CONTROL_CANCELLED'});assert.equal(y.writes(),1);assert.equal(y.stops(),1);assert.equal(y.budget.summary().inFlight,1);
});
test('issuance and grant share one bounded pending exchange',async t=>{
 const x=fixture(t,({cb})=>cb());const waiting=x.prepare();
 await assert.rejects(x.prepare(),{code:'MAGPIE_CONTROL_BUSY'});
 await assert.rejects(x.channel.grant(x.row.id,x.scope,{...x.draft(),upstreamKeyId:'d'.repeat(24),upstreamKey:syntheticSecret}),{code:'MAGPIE_CONTROL_BUSY'});
 x.output.write(JSON.stringify(issued(x.last()))+'\n');await waiting;assert.equal(x.writes(),1);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
});
test('credential replies reject extra fields and cannot disclose raw transport errors',async t=>{
  const x=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify({...issued(raw),verified:true})+'\n');cb();});await assert.rejects(x.prepare(),e=>e.code==='MAGPIE_ISSUANCE_ACK_INVALID'&&e.cause?.category==='ACK_SHAPE');
 const y=fixture(t,({cb})=>cb(Error('SYNTHETIC_PRIVATE_CREDENTIAL_ERROR')));await assert.rejects(y.prepare(),e=>e.code==='MAGPIE_CONTROL_LOST'&&!e.message.includes('SYNTHETIC_PRIVATE_CREDENTIAL_ERROR'));assert.equal(y.stops(),1);
});
test('an issuance reply cannot hide a permanently unfinished write from the deadline',async t=>{
 let release,timer;
 const x=fixture(t,({raw,output,cb})=>{release=cb;output.write(JSON.stringify(issued(raw))+'\n');});
 const operation=x.prepare().then(()=> 'UNEXPECTED_SUCCESS',e=>e.code);
 const result=await Promise.race([operation,new Promise(r=>{timer=setTimeout(()=>r('EXTERNAL_TIMEOUT'),700);})]).finally(()=>clearTimeout(timer));
 release();await operation;
 assert.equal(result,'MAGPIE_CONTROL_TIMEOUT');assert.equal(x.stops(),1);assert.equal(x.budget.requests()[0].routerAdmission,undefined);assert.equal(x.budget.requests()[0].usageStatus,'PENDING');
});
test('a late exact issuance reply is refused even before the event loop can run its timer',async t=>{
 const x=fixture(t,({raw,output,cb})=>{const end=Date.now()+160;while(Date.now()<end){}output.write(JSON.stringify(issued(raw))+'\n');cb();});
 const d={...x.draft(),expiresAtMs:Date.now()+120};
 const result=await x.prepare(undefined,d).then(()=> 'UNEXPECTED_SUCCESS',e=>e.code);
 assert.equal(result,'MAGPIE_CONTROL_TIMEOUT');assert.equal(x.stops(),1);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
});
