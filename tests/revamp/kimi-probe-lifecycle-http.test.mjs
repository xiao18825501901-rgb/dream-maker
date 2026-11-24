// OFFLINE provider/authority only. Actual authenticated HTTP + original SQLite, no model/account access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {defaults} from '../../dist/server/config.js';
import {DomainError} from '../../dist/server/security.js';
import {root,bindKimi} from '../helpers.mjs';

test('original authenticated probe HTTP persists accepted-then-failed identity and replay never reissues it',async t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'probe-lifecycle-http-'));
 const config=bindKimi(structuredClone(defaults));Object.assign(config.kimi,{enabled:true,tokenFile:join(data,'NOT_A_REAL_TOKEN'),workspace:'/opt/offline-fixture'});
 writeFileSync(join(data,'config.json'),JSON.stringify(config));let calls=0,probeContext;
 const app=await createApp({root,data,configPath:join(data,'config.json'),port:0,nativeOwnerBuilder:context=>{
  probeContext=context;
  return {assertReady(){throw Error('OFFLINE_NO_LIVE_FACTORY');},executor(){throw Error('OFFLINE_NO_EXECUTOR');},verify:async()=>{throw Error('OFFLINE_NO_VERIFIER');},paidGuard(){throw Error('OFFLINE_NO_PAYMENT');},close:async()=>{},
   probe:async(role,signal)=>{assert.equal(role,'planner1');return context.planner1Probe('DM_PROBE_'+'b'.repeat(32),signal,data);}};
 }});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 // Patch only this isolated app's existing private dependencies. Nothing is installed in production.
 const deps=app.interviews.kimiDeps;assert.ok(deps&&probeContext);
 deps.credentials.barrier=()=> 'READY';deps.credentials.current=()=>({status:'OK',generation:9});
 deps.runner.run=async(input,onEvent)=>{calls++;onEvent({method:'dm/kimiAccepted',params:{sessionId:'session_http_offline',promptId:'prompt_http_offline',token:'NEVER_LOG_THIS'}});onEvent({method:'dm/kimiArchive',params:{sessionId:'session_http_offline',archived:false}});throw new DomainError('KIMI_SERVER_TOKEN_MISSING',409);};
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const send=async(key,token=csrf)=>{const r=await fetch(app.origin+'/api/native/probes',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':token,'idempotency-key':key},body:JSON.stringify({roles:['planner1']})});return {status:r.status,body:await r.json()};};
 assert.equal((await send('offline-probe-invalid-csrf','invalid')).status,403);assert.equal(calls,0);
 const first=await send('offline-probe-lifecycle-once'),replay=await send('offline-probe-lifecycle-once');
 assert.equal(first.status,200);assert.deepEqual(replay,first);assert.equal(first.body.results[0].ok,false);assert.equal(first.body.results[0].code,'KIMI_SERVER_TOKEN_MISSING');assert.equal(calls,1);
 const rows=app.store.db.prepare('SELECT data FROM records WHERE project_id IS NULL AND kind=? ORDER BY rowid').all('Planner1ProbeLifecycle').map(r=>JSON.parse(r.data));assert.deepEqual(rows.map(r=>r.stage),['STARTED','ACCEPTED','ARCHIVE','FAILED']);
 assert.equal(rows.at(-1).sessionId,'session_http_offline');assert.equal(rows.at(-1).promptId,'prompt_http_offline');assert.equal(rows.at(-1).credentialGeneration,9);
 assert.equal(JSON.stringify(rows).includes('NEVER_LOG_THIS'),false);assert.ok(rows.every(r=>r.costStatus==='UNKNOWN'));
 assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM records WHERE kind=?').get('NativeProbeReceipt').n,0);assert.equal(app.store.projects().length,0);assert.equal(app.store.runs().length,0);
});
