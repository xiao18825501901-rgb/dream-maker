// Actual localhost HTTP/SQLite and fixed Demo only; never native role acceptance.
import test from 'node:test';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../../dist/server/http.js';
import { defaults } from '../../dist/server/config.js';
import { fixtureProjectPlan } from '../fixtures/full-project-plan.mjs';
import { root } from '../helpers.mjs';

const document=(mode='live')=>({schema:'dream-maker.user-plan.v1',name:'自带方案项目',mode,
 plan:fixtureProjectPlan([{id:'R1',text:'保存内容后重新打开仍可查看。',origin:'USER',sources:['USER_DOCUMENT']}])});
async function server(t,options={}){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
 const data=mkdtempSync(resolve(parent,'dreamflow-http-')),config=structuredClone(defaults);
 // Even an enabled, unavailable P1 must not be contacted or read on this entry.
 config.kimi.enabled=true;config.kimi.tokenFile=resolve(data,'nonexistent-p1-token');
 writeFileSync(resolve(data,'config.json'),JSON.stringify(config));let bridgeSpawns=0;
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),product:'dreamflow',port:0,demoDelayMs:0,...options,
  kimiBridgeSpawn:()=>{bridgeSpawns++;throw Error('P1_MUST_NOT_START');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,extra={})=>{
  const response=await fetch(app.origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 return {app,call,spawns:()=>bridgeSpawns};
}
test('standalone entry is server selected, authenticated and never initializes P1',async t=>{
 const {app,call,spawns}=await server(t);
 assert.match(await (await fetch(app.origin+'/')).text(),/DreamFlow/);
 assert.equal((await call('/product')).body.product,'dreamflow');
 assert.equal((await fetch(app.origin+'/api/product')).status,401);
 assert.equal(spawns(),0);
 const created=await call('/user-plans',{document:document()});assert.equal(created.status,200);
 const p=created.body.project;assert.equal(p.planner1Mode,'USER');assert.equal(p.state,'SPEC_REVIEW');
 assert.equal(p.planner1Binding,undefined);assert.equal(p.questions.length,0);assert.equal(p.answers.length,0);
 for(const action of ['next','finish','alternative'])assert.equal((await call(`/projects/${p.id}/${action}`,{})).body.error,'USER_PLANNER_REQUIRED');
 assert.equal((await call('/projects',{name:'wrong',idea:'wrong',mode:'demo'})).body.error,'USER_PLANNER_REQUIRED');
 assert.equal(app.store.records(p.id,'ModelAttempt').length,0);
 assert.equal((await call('/native/probes',{roles:['planner1']})).body.error,'USER_PLANNER_REQUIRED');
});
test('DreamFlow model directory requires a session and reads only the fixed local catalog',async t=>{
 const requests=[];
 const directory=createServer((req,res)=>{
  requests.push([req.method,req.url,req.headers.authorization]);
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({object:'list',data:[{object:'model',id:'p/m',owned_by:'p',native_endpoints:['/v1/messages']}]}));
 });
 await new Promise(resolve=>directory.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>directory.close(resolve)));
 const {app,call}=await server(t,{desktopMagpieCatalogPort:directory.address().port});
 assert.equal((await fetch(app.origin+'/api/magpie/models')).status,401);
 assert.equal((await call('/magpie/models?port=1')).status,400);
 assert.deepEqual(requests,[]);
 assert.deepEqual(await call('/magpie/models'),{status:200,body:{scope:'DESKTOP_METADATA_ONLY',models:[{id:'p/m',kind:'provider',provider:'p',protocols:['anthropic-messages']}]}});
 assert.deepEqual(requests,[['GET','/v1/models',undefined]]);
});
test('import grants no approval or process; its idempotency key binds the actual document',async t=>{
 const {app,call}=await server(t),doc=document(),key=crypto.randomUUID();
 const first=await call('/user-plans',{document:doc},{'idempotency-key':key});assert.equal(first.status,200);
 const replay=await call('/user-plans',{document:doc},{'idempotency-key':key});assert.deepEqual(replay,first);
 const {project:p,spec:s}=first.body;
 assert.equal(app.store.planVersion(s.id).approval,null);assert.equal(app.store.runs(p.id).length,0);
 assert.equal(app.store.approved(p.id,s.hash,'SPEC'),false);assert.equal(app.store.approved(p.id,s.hash,'BUILD'),false);
 assert.equal(s.projectPlan.research.status,'USER_IMPORTED_PLAN');
 assert.equal(s.projectPlan.inputBinding.inputHash.length,64);
 assert.deepEqual(s.acceptanceItems,doc.plan.acceptance.map(a=>({
  id:a.id,requirementIds:a.requirementIds,criterion:a.check,method:'manual',
  source:'USER_CONFIRMED',evidenceStatus:'NOT_RUN',
 })));
 assert.equal((await call(`/projects/${p.id}/build`,{specHash:s.hash,approved:true})).status,409);
 assert.equal((await call('/user-plans',{document:{...doc,name:'different'}},{'idempotency-key':key})).status,409);
});
test('imports reject credentials, authority fields, unsafe reuse and invalid coverage without partial projects',async t=>{
 const {app,call}=await server(t),cases=[];
 cases.push({...document(),approved:true});
 const secret=document();secret.plan.goal='sk-'+ 'a'.repeat(48);cases.push(secret);
 const unsafe=document();unsafe.plan.reuse={mode:'REUSE_COMPONENTS',selected:[{webUrl:'https://github.com/x/y',commit:'a'.repeat(40),snapshotHash:'b'.repeat(64),obligations:['MIT']}]};cases.push(unsafe);
 const cycle=document();cycle.plan.tasks[0].dependsOn=['T1'];cases.push(cycle);
 const missing=document();missing.plan.acceptance=[];cases.push(missing);
 for(const doc of cases){const result=await call('/user-plans',{document:doc});assert.ok(result.status>=400&&result.status<500,JSON.stringify(result));}
 assert.equal(app.store.projects().length,0);assert.equal(app.engine.jobs.size,0);
 assert.equal((await call('/user-plans',{document:document()},{'x-csrf-token':'bad'})).status,403);
});
test('standalone preserves approved versions and forbids revision until the current Flow formally ends',async t=>{
 const {app,call}=await server(t),doc=document('demo'),first=await call('/user-plans',{document:doc});assert.equal(first.status,200);
 let {project:p,spec:s}=first.body;
 assert.equal((await call(`/projects/${p.id}/approve`,{specHash:s.hash})).status,200);
 const saved=app.store.planVersion(s.id);assert.match(saved.approval.actor,/^local-session:/);
 const built=await call(`/projects/${p.id}/build`,{specHash:s.hash,approved:true,flowName:'classic'});assert.equal(built.status,200);
 const run=built.body.runs[0];await app.engine.settled(run.id);
 p=app.store.project(p.id);doc.plan.goal+=' 第二版';
 const update=()=>call(`/projects/${p.id}/user-plan`,{document:doc,version:p.version,parentId:s.id});
 assert.equal((await update()).body.error,'RUN_MUST_STOP_BEFORE_EDIT');
 const report=(await call(`/runs/${run.id}/report`)).body;
 assert.equal((await call(`/runs/${run.id}/conclude`,{choice:'ALTERNATIVE',reportHash:report.reportHash,constraint:'暂不安装额外组件'})).status,200);
 assert.equal(app.store.records(p.id,'FlowConclusion')[0].data.userConstraint,'暂不安装额外组件');
 p=app.store.project(p.id);const second=await update();assert.equal(second.status,200);
 assert.equal(second.body.spec.revision,2);assert.equal(second.body.project.state,'SPEC_REVIEW');
 assert.equal(second.body.status.laya.turns,0,'the new unstarted plan must not inherit old Flow advice statistics');
 assert.equal(app.engine.layaObservation(run.id).turns,4,'old Flow evidence remains available under its own identity');
 assert.deepEqual(app.store.planVersion(s.id),saved);assert.equal(app.store.planVersion(second.body.spec.id).approval,null);
 assert.equal(app.store.approved(p.id,s.hash,'DELIVERY'),false);
 assert.equal((await update()).status,409); // stale version/parent cannot append another revision.
 assert.equal(app.store.runs(p.id).length,1);
});
test('export/import uses the same complete format but never carries approvals or run evidence',async t=>{
 const {app,call}=await server(t),first=await call('/user-plans',{document:document()});assert.equal(first.status,200);
 const {project:p,spec:s}=first.body;
 await call(`/projects/${p.id}/approve`,{specHash:s.hash});
 const exported=await call(`/projects/${p.id}/plan-document`);assert.equal(exported.status,200);
 assert.equal(exported.body.schema,'dream-maker.user-plan.v1');assert.equal(exported.body.approval,undefined);
 const imported=await call('/user-plans',{document:exported.body});assert.equal(imported.status,200);
 assert.notEqual(imported.body.project.id,p.id);assert.equal(app.store.planVersion(imported.body.spec.id).approval,null);
 assert.equal(imported.body.spec.projectPlan.goal,s.projectPlan.goal);
 assert.equal(app.store.records(imported.body.project.id,'ModelAttempt').length,0);
});
test('the formal standalone entry serves its entire module graph and no model P1 entry',async t=>{
 const {app}=await server(t),pending=['dreamflow-app.js'],seen=new Set();
 while(pending.length){const name=pending.pop();if(seen.has(name))continue;seen.add(name);
  const response=await fetch(app.origin+'/'+name);assert.equal(response.status,200,name);const source=await response.text();
  for(const match of source.matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+\.js)['"]/g))pending.push(match[1]);
 }
 assert.ok(seen.has('ui.js')&&seen.has('user-plan-view.js')&&seen.size>8);
 for(const name of ['app.js','siwc-local.js','demo-entry.js','demo-api.js'])assert.equal((await fetch(app.origin+'/'+name)).status,404,name);
});
test('a near-limit accepted document can be exported and imported without controller fields',async t=>{
 const {call}=await server(t),doc=document();doc.plan.risks=Array.from({length:27},()=> 'r'.repeat(3900));doc.plan.unknowns=[''];
 const extra=109950-Buffer.byteLength(JSON.stringify(doc));assert.ok(extra>0&&extra<=4000);doc.plan.unknowns[0]='u'.repeat(extra);
 const first=await call('/user-plans',{document:doc});assert.equal(first.status,200);
 const exported=await call(`/projects/${first.body.project.id}/plan-document`);assert.equal(exported.status,200);
 assert.equal(exported.body.plan.inputBinding,undefined);
 assert.ok(Buffer.byteLength(JSON.stringify(exported.body))<=110000);
 assert.equal((await call('/user-plans',{document:exported.body})).status,200);
});
test('saving an unchanged user plan preserves the version and its existing approval',async t=>{
 const {app,call}=await server(t),first=await call('/user-plans',{document:document()});assert.equal(first.status,200);
 const {project:p,spec:s}=first.body;
 const approved=await call(`/projects/${p.id}/approve`,{specHash:s.hash});assert.equal(approved.status,200);
 const current=app.store.project(p.id),saved=app.store.planVersion(s.id),doc=(await call(`/projects/${p.id}/plan-document`)).body;
 const repeat=await call(`/projects/${p.id}/user-plan`,{document:doc,version:current.version,parentId:s.id});assert.equal(repeat.status,200);
 assert.equal(repeat.body.spec.id,s.id);assert.equal(repeat.body.project.version,current.version);assert.deepEqual(app.store.planVersion(s.id),saved);
 assert.equal(app.store.planVersions(p.id).length,1);
});
