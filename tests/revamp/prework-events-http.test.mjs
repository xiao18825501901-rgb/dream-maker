// Real authenticated localhost SSE; isolated synthetic Store only. No product login or models.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {defaults} from '../../dist/server/config.js';
import {root,ready} from '../helpers.mjs';
import {installOfflinePrework} from '../fixtures/offline-prework.mjs';

for(const product of ['dream-maker','dreamflow'])test(`PW ${product} authenticated safe events bind producer epoch and replay without raw payload`,async t=>{
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
 const data=mkdtempSync(resolve(parent,'prework-events-')),configPath=resolve(data,'config.json');
 writeFileSync(configPath,JSON.stringify(defaults));let models=0;
 const app=await createApp({root,data,configPath,product,port:0,paidRequestGuard:()=>{models++;throw Error('MODEL_FORBIDDEN');},kimiBridgeSpawn:()=>{models++;throw Error('MODEL_FORBIDDEN');}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 app.engine.launch=()=>{};
 const {p,s}=await ready(app),created=app.engine.create(p.id,s.hash,true),run=app.store.run(created.id);
 run.tasks=[{id:'T1',title:'synthetic',dependsOn:[],requirementIds:s.requirements.map(r=>r.id),acceptance:['synthetic'],writePaths:['main.mjs'],status:'pending'}];
 run.state=run.phase='IMPLEMENTING';app.store.saveRun(run);
 const saved=installOfflinePrework({...app,dir:data,config:defaults},run.id);
 const contract=app.store.records(p.id,'PreworkContract')[0].data.contract;
 const first=app.store.events(p.id).find(e=>e.type==='prework.ready').id;
 app.store.event(p.id,run.id,'agent.event',{prompt:'PRIVATE_EVENT_SENTINEL'});
 const last=app.store.event(p.id,run.id,'prework.result',{contractId:saved.prework.contractId,status:'awaiting-verification',prompt:'PRIVATE_EVENT_SENTINEL',stdout:'PRIVATE_EVENT_SENTINEL'});
 const path=app.origin+`/api/projects/${p.id}/prework-events`;
 assert.equal((await fetch(path)).status,401);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(path+'?after=-1',{headers:{cookie}})).status,400);
 async function events(headers,count){
  const stop=new AbortController();let reader;
  try{
   const response=await fetch(path+'?after=0',{headers:{cookie,...headers},signal:AbortSignal.any([stop.signal,AbortSignal.timeout(10000)])});
   assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
   reader=response.body.getReader();const decoder=new TextDecoder();let text='';
   while((text.match(/^data: /gm)??[]).length<count){const part=await reader.read();assert.equal(part.done,false);text+=decoder.decode(part.value,{stream:true});}
   assert.doesNotMatch(text,/PRIVATE_EVENT_SENTINEL|prompt|stdout/);
   return [...text.matchAll(/^data: (.+)$/gm)].map(m=>JSON.parse(m[1]));
  }finally{stop.abort();await reader?.cancel().catch(()=>{});}
 }
 const rows=await events({},2);assert.deepEqual(rows.map(r=>r.eventId),[first,last]);
 for(const row of rows){assert.equal(row.sourceEpoch,contract.sourceEpoch);assert.equal(row.key,contract.sourceEpoch+':'+row.eventId);assert.equal(row.flowId,run.id);assert.equal(row.schema,'dm.prework.event.v1');assert.equal(row.mode,'demo');assert.equal(row.evidenceScope,'SYNTHETIC_DEMO_NOT_LIVE');}
 const replay=await events({'Last-Event-ID':String(first)},1);assert.deepEqual(replay.map(r=>r.eventId),[last]);
 assert.equal(models,0);assert.equal(app.store.run(run.id).calls,0);assert.equal(app.store.records(p.id,'PreworkCloseout').length,0);
 app.store.event(p.id,run.id,'prework.result',{contractId:'prework_'+'f'.repeat(64),status:'awaiting-verification'});
 const abort=new AbortController();
 try{
  const response=await fetch(path+'?after='+last,{headers:{cookie},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])});
  const reader=response.body.getReader();const chunk=await reader.read();
  await reader.cancel();assert.equal(chunk.done,true,'foreign contract must close before emitting an event');
 }finally{abort.abort();}
 // Normal authenticated events retain their original payload/shape; a safe feed
 // neither silently changes that API nor creates a separate event producer.
 const rawStop=new AbortController();const raw=await fetch(app.origin+`/api/projects/${p.id}/events?after=${first}`,{headers:{cookie},signal:rawStop.signal});
 const rawReader=raw.body.getReader(),rawChunk=await rawReader.read();
 assert.match(new TextDecoder().decode(rawChunk.value),/PRIVATE_EVENT_SENTINEL/);
 await app.close();let tail='';
 while(true){const chunk=await rawReader.read();if(chunk.done)break;tail+=new TextDecoder().decode(chunk.value);}
 assert.match(tail,/application-stopping/);rawStop.abort();
});
