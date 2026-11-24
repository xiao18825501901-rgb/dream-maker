// Original local HTTP/Engine/Dispatch and actual Windows keeper. OFFLINE project and test capacity, not Native evidence.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {ready,root} from '../helpers.mjs';
import {fixedControllerCapacity,fixtureEntered} from '../fixtures/controller-capacity.mjs';import {hash} from '../../dist/server/security.js';

test('SQLite status uses original authenticated Engine read, coalesces requests and preserves delivered Flow without model authority',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'sqlite-status-http-'));
 const app=await createApp({root,data,configPath:join(data,'config.json'),port:0,paidRequestGuard:()=>{throw Error('MODEL_FORBIDDEN');}});let release;
 t.after(async()=>{release?.();await app.close();rmSync(data,{recursive:true,force:true});});
 const {p,s}=await ready({store:app.store,interviews:app.interviews,laya:app.laya,config:app.settings.value}),made=app.engine.create(p.id,s.hash,true);await app.engine.settled(made.id);
 const project=app.store.project(p.id);project.mode='live';app.store.saveProject(project);const run=app.store.run(made.id);run.mode='live';app.store.saveRun(run);fixedControllerCapacity(app.engine);
 const endpoint=app.origin+'/api/projects/'+p.id+'/sqlite-data';assert.equal((await fetch(endpoint)).status,401);
 const session=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json(),headers={cookie};
 assert.equal((await fetch(endpoint+'?path=C:/outside',{headers})).status,400);
 assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()},body:'{}'})).status,404);
 assert.ok(app.engine.sqliteData,'SQLITE_STATUS_NOT_CONNECTED_TO_ORIGINAL_ENGINE');const original=app.engine.sqliteData.readOwned.bind(app.engine.sqliteData),before=hash(app.store.run(run.id));let calls=0,entered;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});t.mock.method(app.engine.sqliteData,'readOwned',async(...args)=>{calls++;entered();await gate;return original(...args);});
 app.engine.nativeExecution={assertReady(){throw Error('MODEL_ADMISSION_FORBIDDEN_FOR_STATUS');},executor(){throw Error('EXECUTOR_FORBIDDEN');},codex(){throw Error('CODEX_FORBIDDEN');},async close(){}};
 const first=fetch(endpoint,{headers});await fixtureEntered(started,first,()=>release?.());const second=fetch(endpoint,{headers}),third=fetch(endpoint,{headers});
 const lifecycle=await (await fetch(app.origin+'/api/application/lifecycle',{headers})).json();assert.equal(lifecycle.active.engineJobs,1);assert.equal(lifecycle.currentRoundMayStillRun,true);
 const joined=Date.now();while(!app.store.records(p.id,'SqliteDataReadJoined').length&&Date.now()-joined<5000)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(app.store.records(p.id,'SqliteDataReadJoined').length);
 release();release=null;const [one,two,three]=await Promise.all([first,second,third]);assert.equal(one.status,200);assert.equal(two.status,200);assert.equal(three.status,200);const a=await one.json(),b=await two.json();assert.deepEqual(a,b);assert.deepEqual(a,await three.json());assert.equal(calls,1);assert.equal(a.schema,'dream-maker.sqlite-data.v1');assert.equal(a.revision,0);assert.equal(a.nativeExecutionGranted,false);assert.equal(app.store.records(p.id,'SqliteDataReadJoined').length,1);
 assert.equal(hash(app.store.run(run.id)),before);assert.equal(app.store.records(p.id,'ModelAttempt').length,0);assert.equal(app.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
 const requested=app.store.records(p.id,'SqliteDataReadRequested');assert.equal(requested.length,1);const finished=app.store.records(p.id,'DispatchFinished').filter(r=>r.data.dispatchId===requested[0].data.dispatchId);assert.equal(finished.length,1);assert.equal(finished[0].data.cleanupReturned,true);assert.equal(finished[0].data.outcome,'COMPLETED');assert.equal(app.engine.activeJobCount,0);
});
