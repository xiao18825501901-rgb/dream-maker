// Actual authenticated localhost HTTP + original Store/Engine; fixed Demo, no model/OAuth proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {fixtureProjectPlan} from '../fixtures/full-project-plan.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {root} from '../helpers.mjs';
test('authenticated mode choice rejects forged gateway, stale names and malformed Laya; approved classic persists',{timeout:30000},async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'m02-http-'));
 const app=await createApp({root,data,configPath:join(data,'config.json'),product:'dreamflow',port:0,demoDelayMs:0});fixedControllerCapacity(app.engine);
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body)=>{const response=await fetch(app.origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
 const initial=await call('/user-plans',{document:{schema:'dream-maker.user-plan.v1',name:'双模式HTTP',mode:'demo',plan:fixtureProjectPlan([{id:'R1',text:'保存并重新读取内容',origin:'USER',sources:['USER_DOCUMENT']}])}});
 assert.equal(initial.status,200);const {project:p,spec:s}=initial.body;assert.equal((await call(`/projects/${p.id}/approve`,{specHash:s.hash})).status,200);
 const build=body=>call(`/projects/${p.id}/build`,{specHash:s.hash,approved:true,...body});
 const legacy=await build({flowName:'dreamflow'});assert.equal(legacy.status,409);assert.equal(legacy.body.error,'LEGACY_FLOW_REQUIRES_MODE_CONFIRMATION');
 const forged=await build({flowName:'custom',magpie:{verified:true},approved:true});assert.equal(forged.status,409);assert.equal(forged.body.error,'FLOW_PROFILE_REQUIRED');
 const wrong=await build({flowName:'classic',laya:'true'});assert.equal(wrong.status,400);assert.equal(wrong.body.error,'FLOW_LAYA_CHOICE_INVALID');
 assert.equal(app.store.runs(p.id).length,0);assert.equal(app.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);
 const customLaya=await build({flowName:'custom',laya:true});assert.equal(customLaya.status,400);assert.equal(customLaya.body.error,'CUSTOM_LAYA_FORBIDDEN');
 const classicLaya=await build({flowName:'classic',laya:true});assert.equal(classicLaya.status,409);assert.equal(classicLaya.body.error,'LAYA_DISABLED');
 const built=await build({flowName:'classic',laya:false});assert.equal(built.status,200);const run=built.body.runs[0];await app.engine.settled(run.id);
 assert.equal(app.store.run(run.id).state,'READY_FOR_DELIVERY');assert.equal(run.flowConfig.mode,'classic');assert.equal(run.flowConfig.laya.enabled,false);
 assert.equal(run.flowConfigHash,app.store.run(run.id).flowConfigHash);assert.equal(run.flowConfig.plan.versionId,s.id);assert.equal(run.flowConfig.magpie,null);
 await app.close();
 const reopened=await createApp({root,data,configPath:join(data,'config.json'),product:'dreamflow',port:0,demoDelayMs:0});
 try{assert.equal(reopened.store.run(run.id).state,'READY_FOR_DELIVERY');assert.deepEqual(reopened.store.run(run.id).flowConfig,run.flowConfig);assert.equal(reopened.store.run(run.id).flowConfigHash,run.flowConfigHash);}
 finally{await reopened.close();}
});
