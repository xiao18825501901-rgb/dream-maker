// Actual local HTTP consent boundary with an offline plan reader, not Live verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {harness,root} from './helpers.mjs';
import {createApp} from '../dist/server/http.js';
import {DomainError} from '../dist/server/security.js';
test('oracle approval needs local session, CSRF, exact frozen hashes and explicit consent; never grants build',async t=>{
 let app;t.after(()=>app?.close());const h=harness(t),planHash='a'.repeat(64);
 const native={assertReady:()=>{throw new DomainError('OFFLINE_FACTORY_NOT_LIVE');},executor:()=>{throw Error('MUST_NOT_RUN');},verify:async()=>{throw Error('MUST_NOT_RUN');},close:async()=>{},
  verifierPlan:(_pid,specHash)=>({sha256:planHash,plan:{schema:'OFFLINE_PLAN_READER',specHash,cases:[]}})};
 app=await createApp({root,data:resolve(h.dir,'http'),configPath:resolve(h.dir,'http-config.json'),port:0,demoDelayMs:0,nativeExecution:native});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf;
 async function request(path,body,extra={}){const method=body===undefined?'GET':'POST';const r=await fetch(app.origin+path,{method,headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...extra},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
 const p=(await request('/api/projects',{name:'OFFLINE_ORACLE_CONSENT',idea:'Test explicit controller oracle consent only.',mode:'demo'})).body.project;
 const spec=(await request(`/api/projects/${p.id}/finish`,{summarize:false})).body.spec;
 const endpoint=`/api/projects/${p.id}/native-verifier`;
 assert.equal((await request(endpoint)).body.sha256,planHash);
 assert.equal((await request(endpoint+'/approve',{specHash:spec.hash,planHash,approved:true},{'x-csrf-token':'wrong'})).status,403);
 assert.equal((await request(endpoint+'/approve',{specHash:spec.hash,planHash,approved:false})).status,403);
 assert.equal((await request(endpoint+'/approve',{specHash:spec.hash,planHash:'b'.repeat(64),approved:true})).status,409);
 assert.equal(app.store.approved(p.id,spec.hash,'VERIFIER'),false);
 assert.equal((await request(endpoint+'/approve',{specHash:spec.hash,planHash,approved:true})).status,200);
 assert.equal(app.store.approved(p.id,spec.hash,'VERIFIER'),true);
 assert.equal(app.store.approved(p.id,spec.hash,'SPEC'),false);assert.equal(app.store.approved(p.id,spec.hash,'BUILD'),false);
 assert.equal(app.store.runs().length,0);
 assert.equal(app.store.records(p.id,'VerifierApproval')[0].data.planHash,planHash);
});
