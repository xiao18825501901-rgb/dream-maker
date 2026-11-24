// Actual authenticated local HTTP. OFFLINE status-reader fixture, never Native/model proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {createApp} from '../../dist/server/http.js';
test('lightweight dispatch status requires auth and never performs account/probe readiness work',async t=>{
 const root=resolve('.'),parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
 const data=mkdtempSync(resolve(parent,'dispatch-status-http-'));
 assert.ok(!relative(parent,data).startsWith('..'));
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),port:0,demoDelayMs:0});
 const original=app.engine.dispatchStatus.bind(app.engine),readiness=app.engine.executionReadiness;
 t.after(async()=>{app.engine.dispatchStatus=original;app.engine.executionReadiness=readiness;await app.close();rmSync(data,{recursive:true,force:true});});
 const status=original();status.queued.push({projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',kind:'executor',dispatchId:'OFFLINE_DISPATCH',wait:{scope:'RESOURCE_OBSERVATION_ONLY',reason:'MEMORY',sampledAt:new Date().toISOString(),availableMemoryMiB:1536,estimatedMemoryGapMiB:1024}});
 app.engine.dispatchStatus=()=>status;
 app.engine.executionReadiness=()=>assert.fail('a queue poll must not trigger readiness/probe work');
 const denied=await fetch(app.origin+'/api/dispatch',{headers:{origin:app.origin}});assert.equal(denied.status,401);await denied.text();
 const url=new URL(app.bootstrapUrl),bootstrap=new URLSearchParams(url.hash.slice(1)).get('bootstrap')??url.searchParams.get('bootstrap');assert.ok(bootstrap);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{origin:app.origin,'content-type':'application/json'},body:JSON.stringify({bootstrap})});assert.equal(login.status,200);await login.json();
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const response=await fetch(app.origin+'/api/dispatch',{headers:{origin:app.origin,cookie}});assert.equal(response.status,200);
 const body=await response.json();assert.deepEqual(body.dispatch,status);assert.equal(Object.hasOwn(body,'native'),false);assert.equal(body.dispatch.queued[0].wait.estimatedMemoryGapMiB,1024);
 assert.equal(app.engine.activeJobCount,0);assert.equal(app.store.db.prepare("SELECT count(*) n FROM records WHERE kind='DispatchGranted'").get().n,0);
});
