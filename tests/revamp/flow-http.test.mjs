// Same-origin HTTP integration with Demo execution only. No real agents or approval substitution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../../dist/server/http.js';
import { ready,root } from '../helpers.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
test('report/help are authenticated; concluding a Flow retains CSRF, session actor and independent acceptance',async t=>{
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'flow-http-'));
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),port:0,demoDelayMs:0});
 fixedControllerCapacity(app.engine); // OFFLINE Demo HTTP fixture; real Native resource gates are unchanged.
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,extra={})=>{
  const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...extra},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
 };
 assert.equal((await fetch(app.origin+'/api/help')).status,401);
 const help=await call('/help');assert.equal(help.status,200);assert.ok(help.body.topics.ACCOUNT_ACTION.steps.length);
 const {p,s}=await ready({interviews:app.interviews,store:app.store}),r=app.engine.create(p.id,s.hash,true);await app.engine.settled(r.id);
 assert.equal((await fetch(app.origin+`/api/runs/${r.id}/report`)).status,401);
 const report=(await call(`/runs/${r.id}/report`)).body;assert.equal(report.userAccepted,false);
 assert.equal((await call(`/runs/${r.id}/conclude`,{choice:'HELP'},{'x-csrf-token':'wrong'})).status,403);
 assert.equal((await call(`/runs/${r.id}/conclude`,{choice:'HELP',reportHash:'0'.repeat(64)})).status,409);
 assert.equal((await call(`/runs/${r.id}/conclude`,{choice:'HELP',reportHash:report.reportHash,actor:'FORGED_MODEL'})).status,200);
 const row=app.store.records(p.id,'FlowConclusion')[0];assert.match(row.data.actor,/^local-session:[a-f0-9]{64}$/);
 assert.equal(app.store.approved(p.id,s.hash,'DELIVERY'),false);
 assert.equal(app.store.run(r.id).state,'READY_FOR_DELIVERY');
 assert.equal(app.store.runs(p.id).length,1);
});
