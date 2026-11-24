// Real loopback HTTP/SQLite, synthetic imported plan and built-in Demo only.
// No owner bootstrap, Native identity, account, model call or formal database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {defaults} from '../../dist/server/config.js';
import {fixtureProjectPlan} from '../fixtures/full-project-plan.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {root} from '../helpers.mjs';

for(const product of ['dream-maker','dreamflow'])test(`PW ${product} HTTP handoff survives restart without P1 or model authority`,{timeout:90000},async t=>{
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
 const data=mkdtempSync(resolve(parent,'prework-http-')),configPath=resolve(data,'config.json');
 writeFileSync(configPath,JSON.stringify(defaults));let paid=0,p1=0,app;
 const start=async()=>{
  app=await createApp({root,data,configPath,product,port:0,demoDelayMs:0,
   paidRequestGuard:()=>{paid++;throw Error('MODEL_FORBIDDEN');},
   kimiBridgeSpawn:()=>{p1++;throw Error('P1_FORBIDDEN');}});
  fixedControllerCapacity(app.engine); // Explicit test pool; never Native resource qualification.
  const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  return async(path,body)=>{
   const response=await fetch(app.origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
   const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  };
 };
 t.after(async()=>{if(app)await app.close();rmSync(data,{recursive:true,force:true});});
 let call=await start();assert.equal((await fetch(app.origin+'/api/projects')).status,401);
 const document={schema:'dream-maker.user-plan.v1',name:'合成开始前检查',mode:'demo',plan:fixtureProjectPlan([{id:'R1',text:'保存后可重新查看',origin:'USER',sources:['USER_DOCUMENT']}])};
 const first=await call('/user-plans',{document}),pid=first.project.id;
 assert.equal(first.project.questions.length,0);assert.equal(first.project.planner1Mode,'USER');
 await call(`/projects/${pid}/approve`,{specHash:first.spec.hash});
 const created=await call(`/projects/${pid}/build`,{specHash:first.spec.hash,approved:true,flowName:'classic'}),rid=created.runs[0].id;
 await app.engine.settled(rid);const current=await call(`/projects/${pid}`),run=current.runs.find(r=>r.id===rid);
 assert.equal(run.state,'READY_FOR_DELIVERY',run.reason);assert.ok(run.prework?.contractId);
 for(const kind of ['PreworkContract','PreworkPackageResult','PreworkCloseout'])assert.ok(app.store.records(pid,kind).some(r=>r.runId===rid),kind);
 const closeout=app.store.records(pid,'PreworkCloseout').find(r=>r.runId===rid);
 assert.equal(closeout.data.scope,'SYNTHETIC_DEMO_NOT_LIVE');
 const records=app.store.records(pid,'PreworkContract');
 await app.close();app=undefined;call=await start();
 const reopened=await call(`/projects/${pid}`),saved=reopened.runs.find(r=>r.id===rid);
 assert.equal(saved.state,'READY_FOR_DELIVERY');assert.deepEqual(saved.prework,run.prework);
 assert.deepEqual(app.store.records(pid,'PreworkContract'),records);
 assert.equal(app.store.records(pid,'PreworkCloseout').length,1);
 assert.equal(paid,0);assert.equal(p1,0);
});
