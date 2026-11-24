// Actual localhost/SQLite shutdown with delayed manager boundaries. No models/native roles or fees.
import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {root,until} from '../helpers.mjs';
import {DomainError} from '../../dist/server/security.js';
const deferred=()=>{let resolve;const promise=new Promise(ok=>{resolve=ok;});return {promise,resolve};};
async function setup(t,nativeOwnerBuilder,allowFailedClose=false){const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'application-close-'));
 const denied=()=>{throw Error('NO_NATIVE_ROLES_IN_CLOSE_TEST');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),port:0,...(nativeOwnerBuilder?{nativeOwnerBuilder}:{nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}})});
 t.after(async()=>{if(allowFailedClose){await Promise.allSettled([app.close()]);if(app.store.db.isOpen)app.store.close();}else await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();return {app,data,cookie,csrf};
}

test('application close finishes an open event stream with a shutdown event and complete HTTP framing',async t=>{
 const {app,cookie}=await setup(t),p=app.interviews.create('关闭事件流','只核对本机连接关闭。','demo');let response,wire='';
 let done;const ended=new Promise(r=>done=r),opened=new Promise((resolveOpened,reject)=>{
  const client=request(app.origin+'/api/projects/'+p.id+'/events',{headers:{cookie}},res=>{response=res;res.on('data',chunk=>{wire+=chunk.toString();});res.on('end',()=>done('end'));res.on('aborted',()=>done('aborted'));res.on('error',()=>done('error'));resolveOpened();});client.on('error',reject);client.end();
 });await opened;await app.close();const end=await ended;
 assert.equal(end,'end','graceful close must not truncate an event stream');assert.equal(response.complete,true);assert.match(wire,/event: application-stopping\ndata: \{"reason":"APPLICATION_STOPPING"\}\n\n/);
});

test('a cleanup rejection is captured immediately while a slow event stream is still draining',async t=>{
 const {app,cookie}=await setup(t,undefined,true),p=app.interviews.create('事件流关闭背压','检查关闭时保留清理不明，不调用模型。','demo');
 app.server.on('request',(req,res)=>{if(req.url.endsWith('/events')){const end=res.end.bind(res);res.end=(...args)=>{setTimeout(()=>end(...args),80);return res;};}});
 const opened=new Promise((resolveOpened,reject)=>{const client=request(app.origin+'/api/projects/'+p.id+'/events',{headers:{cookie}},res=>{res.on('data',()=>{});res.on('error',()=>{});resolveOpened();});client.on('error',reject);client.end();});await opened;
 const original=app.interviews.close.bind(app.interviews);app.interviews.close=async()=>{await original();throw Error('OFFLINE_MANAGER_CLEANUP_UNCERTAIN');};
 await assert.rejects(app.close(),{code:'APPLICATION_CLOSE_UNCERTAIN'});assert.equal(app.store.db.isOpen,true);
});
test('all managers begin closing together and an already-open request cannot commit after close starts',async t=>{
 const {app,data,cookie,csrf}=await setup(t),hold=deferred(),entered=deferred(),originalInterview=app.interviews.close.bind(app.interviews),originalEngine=app.engine.close.bind(app.engine);let engineBegan=false;
 app.interviews.close=async()=>{entered.resolve();await hold.promise;await originalInterview();};app.engine.close=async options=>{engineBegan=true;await originalEngine(options);};
 const body=JSON.stringify({name:'关闭后不得新增',idea:'延迟请求主体必须被阻止',mode:'demo'}),ready=deferred(),outcome=deferred();
 const client=request(app.origin+'/api/projects',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),'content-type':'application/json','content-length':Buffer.byteLength(body),expect:'100-continue'}},res=>{res.resume();res.on('end',()=>outcome.resolve({status:res.statusCode}));});
 client.on('continue',()=>ready.resolve());client.on('error',()=>outcome.resolve({transportClosed:true}));client.setTimeout(5000,()=>client.destroy());client.flushHeaders();await ready.promise;
 let closing,beganBeforeP1,observed;
 try{closing=app.close();await entered.promise;await new Promise(ok=>setImmediate(ok));beganBeforeP1=engineBegan;client.end(body);observed=await outcome.promise;}
 finally{hold.resolve();await closing;client.destroy();}
 assert.equal(beganBeforeP1,true,'executor cancellation must not wait behind a slow P1 cleanup');assert.notEqual(observed.status,200);
 const db=new DatabaseSync(resolve(data,'dream-maker.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM projects').get().n,0);}finally{db.close();}
});
test('repeated close calls share one operation rather than closing database and managers twice',async t=>{
 const {app}=await setup(t),hold=deferred(),original=app.interviews.close.bind(app.interviews);let calls=0;app.interviews.close=async()=>{calls++;await hold.promise;await original();};
 const first=app.close(),second=app.close();const same=first===second;hold.resolve();await Promise.allSettled([first,second]);assert.equal(same,true);assert.equal(calls,1);
});

test('an authenticated read already awaiting status finishes before the application database closes',async t=>{
 const entered=deferred(),hold=deferred();let readFailure,readFinished=false,nativeDisposed=false;
 const denied=()=>{throw Error('NO_NATIVE_ROLES_IN_CLOSE_TEST');};
 const {app,cookie}=await setup(t,({store})=>({assertReady:denied,executor:denied,verify:denied,paidGuard:denied,async close(){nativeDisposed=true;},async probeStatus(){
  entered.resolve();await hold.promise;
  try{assert.equal(nativeDisposed,false,'native account storage must remain available until awaiting handlers settle');store.projects();readFinished=true;return {roles:[]};}catch(error){readFailure=error;throw error;}
 }}));
 const reading=fetch(app.origin+'/api/native/probes',{headers:{cookie}}).then(response=>response.text(),()=>undefined);let closing,closed=false,premature;
 try{await entered.promise;closing=app.close().then(()=>{closed=true;});await new Promise(ok=>setImmediate(ok));premature=closed;}
 finally{hold.resolve();await reading;await closing;}
 assert.equal(premature,false,'closing sockets must not close SQLite underneath an awaited API handler');assert.equal(readFailure,undefined);assert.equal(readFinished,true);assert.equal(nativeDisposed,true);
});

test('manager cleanup uncertainty preserves the database and refuses a successful close result',async t=>{
 const {app}=await setup(t,undefined,true),original=app.interviews.close.bind(app.interviews);app.interviews.close=async()=>{await original();throw Error('OFFLINE_CLEANUP_UNKNOWN');};
 await assert.rejects(app.close(),{code:'APPLICATION_CLOSE_UNCERTAIN'});
 assert.equal(app.store.db.isOpen,true,'uncertain manager ownership must not lose its journal underneath it');assert.deepEqual(app.store.projects(),[]);
});

test('closing cancels the current native probe and cannot dispatch its next requested role',async t=>{
 const entered=deferred(),hold=deferred(),calls=[];let signal,admissionStopped=false;const denied=()=>{throw Error('NO_NATIVE_ROLES_IN_CLOSE_TEST');};
 const {app,cookie,csrf}=await setup(t,()=>({assertReady:denied,executor:denied,verify:denied,paidGuard:denied,stopRequests(){admissionStopped=true;},async close(){},async probe(role,abort){calls.push(role);signal=abort;entered.resolve();await hold.promise;return {};}}));
 const request=fetch(app.origin+'/api/native/probes',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),'content-type':'application/json'},body:JSON.stringify({roles:['planner2','executor']})}).then(response=>response.text(),()=>undefined);let closing,aborted,stopped;
 try{await entered.promise;closing=app.close();await new Promise(ok=>setImmediate(ok));aborted=signal.aborted;stopped=admissionStopped;}
 finally{hold.resolve();await request;await closing;}
 assert.equal(aborted,true,'the actual HTTP probe must receive the shutdown cancellation signal');assert.equal(stopped,true);assert.deepEqual(calls,['planner2']);
});

test('an HTTP cleanup-uncertain result is retained through a later pause and application close',async t=>{
 const denied=()=>{throw Error('NO_NATIVE_ROLES_IN_CLOSE_TEST');};const {app,cookie,csrf}=await setup(t,()=>({assertReady:denied,executor:denied,verify:denied,paidGuard:denied,async close(){},async probeStatus(){throw new DomainError('PROCESS_CLEANUP_UNPROVEN',409);}}),true);
 const failure=await fetch(app.origin+'/api/native/probes',{headers:{cookie}});assert.equal((await failure.json()).error,'PROCESS_CLEANUP_UNPROVEN');
 const pause=await fetch(app.origin+'/api/application/lifecycle',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),'content-type':'application/json'},body:JSON.stringify({choice:'PAUSE',confirmed:true})});assert.equal(pause.status,200);await pause.json();
 const state=await until(async()=>{const response=await fetch(app.origin+'/api/application/lifecycle',{headers:{cookie}}),value=await response.json();return value.state!=='PAUSE_REQUESTED'&&value;});
 assert.equal(state.state,'PAUSE_UNCERTAIN');await assert.rejects(app.close(),{code:'APPLICATION_CLOSE_UNCERTAIN'});assert.equal(app.store.db.isOpen,true);
});
