// OFFLINE inherited-pipe/ledger integration. All key strings are synthetic test canaries.
import test from 'node:test';import assert from 'node:assert/strict';
import {Writable,PassThrough} from 'node:stream';import {resolve} from 'node:path';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {offlineCustomBudget,offlineCustomQualification} from '../fixtures/custom-budget.mjs';
import {MagpieAdmissionPipe} from '../../dist/server/magpie-control.js';
import {hash} from '../../dist/server/security.js';import {harness} from '../helpers.mjs';
import {cleanupUncertain} from '../../dist/server/cleanup-uncertainty.js';
const authority={scopeId:'OFFLINE_PIPE',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
const price=()=>({provider:'offline',model:'offline-model',currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1000,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
const route=()=>({runtime:'dsh',provider:'offline',protocol:'chat-completions',model:'offline-model',authentication:'api_key',accountRef:'account_offline',authRef:'auth_offline',upstreamAccountRef:'offline/0123456789'});
const routeHash=()=>{const {upstreamAccountRef,...selected}=route();return hash({...selected,upstreamAccountHash:hash(upstreamAccountRef)});};
const binding=()=>({schema:'dream-maker.native-request-binding.v1',projectId:'project_offline',runId:'run_offline',engineeringMode:'custom',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'dispatch_offline',generation:'owner_offline',role:'executor',roleId:'executor-1',work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null},bodyHash:'e'.repeat(64),routeHash:routeHash()});
const grant=(row,scope)=>({token:'3'.repeat(64),id:'grant_offline',epoch:'epoch_offline',projectId:scope.projectId,flowId:scope.runId,configurationHash:scope.configurationHash,bindingHash:hash(scope),routeHash:scope.routeHash,roleId:scope.roleId,role:scope.role,reservationId:row.id,...route(),upstreamKeyId:'key_offline',upstreamKey:'SYNTHETIC_SCOPED_KEY',method:'POST',path:'/v1/chat/completions',bodyHash:scope.bodyHash,expiresAtMs:Date.now()+30000});
const acknowledgement=raw=>{const {admission:a}=JSON.parse(raw);return{type:'admission',schema:'dream-maker.magpie-admission-ack.v2',epoch:a.epoch,id:a.id,reservationId:a.reservationId,controlHash:hash(raw),accepted:true};};
function fixture(t,onWrite,mode='custom',options={}){
 let channel,budget,finish;const done=new Promise(resolve=>finish=resolve);let writes=0,stops=0;
 t.after(async()=>{if(options.intentionalCleanupFailure){void channel?.close().catch(()=>{});finish();}else await channel?.close();budget?.close();});const h=harness(t);budget=new NativeBudget(resolve(h.dir,'pipe-budget.sqlite'),authority,undefined,undefined,'FULL_DM',offlineCustomBudget,offlineCustomQualification);const scope={...binding(),engineeringMode:mode},row=budget.reserve('executor',options.price??price(),128,undefined,scope),output=new PassThrough();
 const input=new Writable({write(chunk,_encoding,cb){writes++;const raw=chunk.toString().replace(/\n$/,'');try{onWrite({raw,output,budget,row,scope,cb});}catch(error){cb(error);}}});
 const transport={input,output,closed:done,stop:async()=>{stops++;if(options.stop)return options.stop();finish();}};
 channel=new MagpieAdmissionPipe(transport,budget,{epoch:'epoch_offline',binaryHash:'1'.repeat(64),ackTimeoutMs:options.ackTimeoutMs??100,cleanupTimeoutMs:20});
 return{budget,channel,scope,row,input,output,writes:()=>writes,stops:()=>stops,deliver:(signal,a=grant(row,scope))=>channel.grant(row.id,scope,a,signal)};
}

test('the original ledger intent is durable before any pipe byte and only the precise ack succeeds',async t=>{
 const x=fixture(t,({raw,output,budget,cb})=>{assert.equal(budget.requests()[0].routerAdmission.status,'INTENT');assert.equal(budget.requests()[0].routerAdmission.controlHash,hash(raw));const reply=JSON.stringify(acknowledgement(raw))+'\n';for(const char of reply)output.write(char);cb();},'custom',{ackTimeoutMs:5000});
 const result=await x.deliver();assert.equal(result.status,'ACKNOWLEDGED');assert.equal(x.writes(),1);const stored=JSON.stringify(x.budget.requests());assert.equal(stored.includes('SYNTHETIC_SCOPED_KEY'),false);assert.equal(stored.includes('3'.repeat(64)),false);assert.equal(x.budget.requests()[0].usageStatus,'PENDING');
});
test('a wrong epoch acknowledgement poisons that pipe and cannot be resent',async t=>{
 const x=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify({...acknowledgement(raw),epoch:'old_epoch'})+'\n');cb();});
 await assert.rejects(x.deliver(),{code:'NATIVE_ROUTER_ACK_MISMATCH'});assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');await assert.rejects(x.deliver());assert.equal(x.writes(),1);assert.equal(x.stops(),1);
});
test('a pipe error exposes no raw key and leaves an unknown nonreplayable intent',async t=>{
 const x=fixture(t,({cb})=>cb(Error('SYNTHETIC_SCOPED_KEY')));
 await assert.rejects(x.deliver(),error=>error.code==='MAGPIE_CONTROL_LOST'&&!error.message.includes('SYNTHETIC_SCOPED_KEY'));assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');assert.equal(x.writes(),1);
});
test('owner cancellation after a write stops its pipe without a second grant',async t=>{
 const controller=new AbortController(),x=fixture(t,({cb})=>{cb();queueMicrotask(()=>controller.abort());});
 await assert.rejects(x.deliver(controller.signal),{code:'MAGPIE_CONTROL_CANCELLED'});assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');assert.equal(x.writes(),1);assert.equal(x.stops(),1);
});
test('Classic, altered binding and unknown fields refuse before recording or sending',async t=>{
 const x=fixture(t,({cb})=>cb(),'classic');await assert.rejects(x.deliver(),{code:'CLASSIC_MAGPIE_FORBIDDEN'});assert.equal(x.writes(),0);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
 const y=fixture(t,({cb})=>cb());for(const a of [{...grant(y.row,y.scope),bodyHash:'0'.repeat(64)},{...grant(y.row,y.scope),verified:true},{...grant(y.row,y.scope),accountRef:'UNKNOWN'}])await assert.rejects(y.deliver(undefined,a),{code:'MAGPIE_CONTROL_GRANT_INVALID'});assert.equal(y.writes(),0);assert.equal(y.budget.requests()[0].routerAdmission,undefined);
});
test('a precise negative ack is stored as denied without a model result or retry',async t=>{
 const x=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify({...acknowledgement(raw),accepted:false})+'\n');cb();});assert.equal((await x.deliver()).status,'DENIED');assert.equal(x.budget.requests()[0].usageStatus,'PENDING');await assert.rejects(x.deliver(),{code:'NATIVE_ROUTER_INTENT_EXISTS'});assert.equal(x.writes(),1);
});
test('surplus control output cannot substitute an old or second acknowledgement',async t=>{
 const x=fixture(t,({raw,output,cb})=>{const line=JSON.stringify(acknowledgement(raw))+'\n';output.write(line+line);cb();});await assert.rejects(x.deliver(),{code:'MAGPIE_CONTROL_UNEXPECTED_OUTPUT'});assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');assert.equal(x.writes(),1);
});
test('lost acknowledgements reach a bounded timeout and never mint another intent',async t=>{
 const x=fixture(t,({cb})=>cb());await assert.rejects(x.deliver(),{code:'MAGPIE_CONTROL_TIMEOUT'});assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');assert.equal(x.writes(),1);assert.equal(x.stops(),1);
});

test('unexpected partial output before a grant closes the pipe before any reservation intent or write',async t=>{
 const x=fixture(t,({cb})=>cb());x.output.write('{"type":');await assert.rejects(x.deliver(),{code:'MAGPIE_CONTROL_UNEXPECTED_OUTPUT'});assert.equal(x.writes(),0);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
});
test('trailing partial output cannot be hidden behind an otherwise valid acknowledgement',async t=>{
 const x=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify(acknowledgement(raw))+'\n{');cb();});await assert.rejects(x.deliver(),{code:'MAGPIE_CONTROL_UNEXPECTED_OUTPUT'});assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');
});

test('a stuck owned-process cleanup is bounded and does not reopen the unknown session',async t=>{
 const x=fixture(t,({cb})=>cb(),'custom',{intentionalCleanupFailure:true,stop:()=>new Promise(()=>{})});let timer;
 const outcome=await Promise.race([x.deliver().then(()=>({code:'UNEXPECTED_SUCCESS'}),error=>({code:error.code})),new Promise(resolve=>{timer=setTimeout(()=>resolve({code:'EXTERNALLY_TIMED_OUT'}),600);})]).finally(()=>clearTimeout(timer));
 assert.equal(outcome.code,'PROCESS_CLEANUP_UNPROVEN');assert.equal(cleanupUncertain(outcome),true,'the original Engine must retain its cleanup gate');assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');await assert.rejects(x.deliver());assert.equal(x.writes(),1);
});
test('a rejected cleanup cannot disclose its raw error through grant or close',async t=>{
 const x=fixture(t,({cb})=>cb(),'custom',{intentionalCleanupFailure:true,stop:()=>Promise.reject(Error('SYNTHETIC_STOP_KEY'))});
 for(const action of [()=>x.deliver(),()=>x.channel.close()])await assert.rejects(action(),error=>error.code==='PROCESS_CLEANUP_UNPROVEN'&&!error.message.includes('SYNTHETIC_STOP_KEY'));
 assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');assert.equal(x.writes(),1);
});

test('combined ledger and cleanup failures retain the original cleanup gate and a safe ledger diagnosis',async t=>{
 const x=fixture(t,({cb})=>cb(),'custom',{intentionalCleanupFailure:true,stop:()=>Promise.reject(Error('SYNTHETIC_STOP_KEY'))});
 t.mock.method(x.budget,'markRouterAdmissionUnknown',()=>{throw Error('SYNTHETIC_LEDGER_KEY');});
 await assert.rejects(x.deliver(),error=>cleanupUncertain(error)&&error.message==='MAGPIE_LEDGER_RESULT_UNCERTAIN');assert.equal(x.budget.requests()[0].routerAdmission.status,'INTENT');assert.equal(x.budget.requests()[0].usageStatus,'PENDING');assert.equal(x.budget.summary().inFlight,1);await assert.rejects(x.deliver());assert.equal(x.writes(),1);
});

test('a different canonical account, protocol, runtime or authentication cannot borrow the pending route',async t=>{
 const x=fixture(t,({cb})=>cb());for(const edit of [{upstreamAccountRef:'offline/another-account'},{runtime:'copilot-sdk'},{authentication:'oauth'},{protocol:'openai-responses',path:'/v1/responses'},{authRef:'another-auth'},{accountRef:'another-alias'}])await assert.rejects(x.deliver(undefined,{...grant(x.row,x.scope),...edit}),{code:'MAGPIE_CONTROL_GRANT_INVALID'});assert.equal(x.writes(),0);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
});

test('accessor and non-enumerable account fields cannot change the serialized grant after validation',async t=>{
 const x=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify(acknowledgement(raw))+'\n');cb();});let reads=0;
 const changing=grant(x.row,x.scope);Object.defineProperty(changing,'upstreamAccountRef',{enumerable:true,get(){reads++;return reads===1?'offline/0123456789':'offline/another';}});
 const hidden=grant(x.row,x.scope);Object.defineProperty(hidden,'upstreamAccountRef',{enumerable:false,value:'offline/0123456789'});
 for(const value of [changing,hidden])await assert.rejects(x.deliver(undefined,value),{code:'MAGPIE_CONTROL_GRANT_INVALID'});
 assert.equal(reads,0);assert.equal(x.writes(),0);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
});

test('an expiration object cannot execute code while the original ledger validates a grant',async t=>{
 const x=fixture(t,({cb})=>cb());let reads=0;const input=grant(x.row,x.scope);input.expiresAtMs={valueOf(){reads++;return Date.now()+10000;}};
 await assert.rejects(x.deliver(undefined,input),{code:'MAGPIE_CONTROL_GRANT_INVALID'});assert.equal(reads,0);assert.equal(x.writes(),0);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
});

test('only original ledger limits enter the control frame, never caller budget claims',async t=>{
 let observed;
 const x=fixture(t,({raw,output,row,cb})=>{
  observed=JSON.parse(raw).admission;
  output.write(JSON.stringify(acknowledgement(raw))+'\n');cb();
 });
 await assert.rejects(x.deliver(undefined,{...grant(x.row,x.scope),maxOutputTokens:999999}),{code:'MAGPIE_CONTROL_GRANT_INVALID'});
 assert.equal(x.writes(),0);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
 assert.equal((await x.deliver()).status,'ACKNOWLEDGED');
 assert.equal(observed.maxInputTokens,x.row.price.maxInputTokens);
 assert.equal(observed.maxOutputTokens,x.row.maxOutputTokens);
});

test('a route cannot borrow a differently priced provider or model hold',async t=>{
 for(const edit of [{provider:'another-provider'},{model:'another-model'}]){
  const x=fixture(t,({raw,output,cb})=>{output.write(JSON.stringify(acknowledgement(raw))+'\n');cb();},'custom',{price:{...price(),...edit}});
  await assert.rejects(x.deliver(),{code:'MAGPIE_CONTROL_BUDGET_MISMATCH'});
  assert.equal(x.writes(),0);assert.equal(x.budget.requests()[0].routerAdmission,undefined);
 }
});
test('a grant reply cannot hide an unfinished write from timeout or owned cleanup failure',async t=>{
 for(const cleanupFails of [false,true]){
  let release,timer;
  const x=fixture(t,({raw,output,cb})=>{release=cb;output.write(JSON.stringify(acknowledgement(raw))+'\n');},'custom',cleanupFails?{intentionalCleanupFailure:true,stop:()=>Promise.reject(Error('SYNTHETIC_STOP_KEY'))}:{});
  const operation=x.deliver().then(()=> 'UNEXPECTED_SUCCESS',e=>e.code);
  const result=await Promise.race([operation,new Promise(r=>{timer=setTimeout(()=>r('EXTERNAL_TIMEOUT'),700);})]).finally(()=>clearTimeout(timer));
  release();await operation;
  assert.equal(result,cleanupFails?'PROCESS_CLEANUP_UNPROVEN':'MAGPIE_CONTROL_TIMEOUT');assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');assert.equal(x.stops(),1);
 }
});
test('a late exact grant reply cannot clear an overdue exchange timer',async t=>{
 const x=fixture(t,({raw,output,cb})=>{const end=Date.now()+160;while(Date.now()<end){}output.write(JSON.stringify(acknowledgement(raw))+'\n');cb();});
 const result=await x.deliver().then(()=> 'UNEXPECTED_SUCCESS',e=>e.code);
 assert.equal(result,'MAGPIE_CONTROL_TIMEOUT');assert.equal(x.budget.requests()[0].routerAdmission.status,'UNKNOWN');assert.equal(x.stops(),1);
});
