// OFFLINE CFW controller and NativeOwner seam. No upstream, OAuth or model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {defaults} from '../../dist/server/config.js';
import {ClashService,withCodexRoleProbeLease} from '../../dist/server/clash-service.js';
import {root} from '../helpers.mjs';

async function controllerFixture(){
 let mutations=0;
 const server=createServer((request,response)=>{
  response.setHeader('content-type','application/json');
  if(request.url==='/configs'){
   response.end(JSON.stringify({mode:'rule','mixed-port':7890}));
   return;
  }
  if(request.url==='/proxies'){
   response.end(JSON.stringify({proxies:{
    selector:{name:'selector',type:'Selector',now:'user-node',all:['user-node']},
    'user-node':{name:'user-node',type:'Shadowsocks'}
   }}));
   return;
  }
  if(request.url==='/proxies/selector'&&request.method==='GET'){
   response.end(JSON.stringify({name:'selector',type:'Selector',now:'user-node',all:['user-node']}));
   return;
  }
  if(request.url==='/proxies/selector'&&request.method==='PUT'){
   mutations++;
   response.statusCode=500;
   response.end(JSON.stringify({error:'OFFLINE_MUTATION_FORBIDDEN'}));
   return;
  }
  response.statusCode=404;
  response.end(JSON.stringify({error:'OFFLINE_NOT_FOUND'}));
 });
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const address=server.address();
 assert.ok(address&&typeof address==='object');
 return{
  port:address.port,
  get mutations(){return mutations;},
  async close(){
   server.closeAllConnections();
   await new Promise(done=>server.close(done));
  }
 };
}

test('native Codex role probes hold the current-user CFW lease for the child environment',async t=>{
 const fixture=await controllerFixture();
 const parent=resolve(root,'.runtime/test-temp');
 mkdirSync(parent,{recursive:true});
 const data=mkdtempSync(resolve(parent,'native-probe-cfw-'));
 const clashPath=resolve(data,'clash.yaml');
 writeFileSync(clashPath,[
  'mixed-port: 7890',
  `external-controller: 127.0.0.1:${fixture.port}`,
  'secret: fixture-secret'
 ].join('\n'));
 const config=structuredClone(defaults);
 config.clash={
  enabled:true,
  configPath:clashPath,
  selector:'selector',
  node:'',
  selectionPolicy:'current',
  expectedMode:'rule'
 };
 const configPath=resolve(data,'config.json');
 writeFileSync(configPath,JSON.stringify(config));
 const probes=[];
 const app=await createApp({
  root,
  data,
  configPath,
  port:0,
  nativeOwnerBuilder:context=>({
   paidGuard(){throw Error('NO_MODEL');},
   assertReady(){throw Error('NO_MODEL');},
   executor(){throw Error('NO_MODEL');},
   verify(){throw Error('NO_MODEL');},
   async close(){},
   async probe(role){
    const environment=context.childEnvironment({});
    probes.push({
     role,
     httpProxy:environment.HTTP_PROXY,
     httpsProxy:environment.HTTPS_PROXY,
     allProxy:environment.ALL_PROXY,
     noProxy:environment.NO_PROXY
    });
    return{evidenceId:`OFFLINE_${role}`,model:'OFFLINE_MODEL',source:'OFFLINE_CONTRACT'};
   }
  })
 });
 t.after(async()=>{
  await app.close();
  await fixture.close();
  rmSync(data,{recursive:true,force:true});
 });
 const login=await fetch(app.origin+'/api/session',{
  method:'POST',
  headers:{'content-type':'application/json'},
  body:JSON.stringify({bootstrap:app.bootstrap})
 });
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const {csrf}=await login.json();
 const response=await fetch(app.origin+'/api/native/probes',{
  method:'POST',
  headers:{
   cookie,
   'content-type':'application/json',
   'x-csrf-token':csrf,
   'idempotency-key':crypto.randomUUID()
  },
  body:JSON.stringify({roles:['planner2','reviewer']})
 });
 assert.equal(response.status,200);
 const body=await response.json();
 assert.deepEqual(body.results.map(value=>value.role),['planner2','reviewer']);
 assert.ok(body.results.every(value=>value.ok===true));
 assert.deepEqual(probes.map(value=>value.role),['planner2','reviewer']);
 for(const probe of probes){
  assert.equal(probe.httpProxy,'http://127.0.0.1:7890/');
  assert.equal(probe.httpsProxy,probe.httpProxy);
  assert.equal(probe.allProxy,probe.httpProxy);
  assert.match(probe.noProxy,/127[.]0[.]0[.]1/);
 }
 assert.equal(fixture.mutations,0);
});

test('role lease helper only leases Codex children and releases after action failure',async t=>{
 const fixture=await controllerFixture();
 const parent=resolve(root,'.runtime/test-temp');
 mkdirSync(parent,{recursive:true});
 const data=mkdtempSync(resolve(parent,'native-probe-cfw-scope-'));
 const clashPath=resolve(data,'clash.yaml');
 writeFileSync(clashPath,[
  'mixed-port: 7890',
  `external-controller: 127.0.0.1:${fixture.port}`,
  'secret: fixture-secret'
 ].join('\n'));
 const config=structuredClone(defaults);
 config.clash={
  enabled:true,
  configPath:clashPath,
  selector:'selector',
  node:'',
  selectionPolicy:'current',
  expectedMode:'rule'
 };
 const service=new ClashService(()=>config,resolve(data,'clash-route'));
 const signal=new AbortController().signal;
 t.after(async()=>{
  await fixture.close();
  rmSync(data,{recursive:true,force:true});
 });

 for(const role of ['planner1','executor']){
  let ran=0;
  const result=await withCodexRoleProbeLease(service,role,signal,async()=>{
   assert.throws(()=>service.childEnvironment({}),{code:'CLASH_RUN_LEASE_REQUIRED'});
   ran++;
   return role;
  });
  assert.equal(result,role);
  assert.equal(ran,1);
 }

 for(const role of ['planner2','reviewer']){
  let ran=0;
  const result=await withCodexRoleProbeLease(service,role,signal,async()=>{
   const environment=service.childEnvironment({});
   assert.equal(environment.HTTPS_PROXY,'http://127.0.0.1:7890/');
   ran++;
   return role;
  });
  assert.equal(result,role);
  assert.equal(ran,1);
  assert.throws(()=>service.childEnvironment({}),{code:'CLASH_RUN_LEASE_REQUIRED'});
 }

 await assert.rejects(
  withCodexRoleProbeLease(service,'planner2',signal,async()=>{
   assert.equal(service.childEnvironment({}).HTTPS_PROXY,'http://127.0.0.1:7890/');
   throw Error('OFFLINE_ACTION_FAILURE');
  }),
  /OFFLINE_ACTION_FAILURE/
 );
 assert.throws(()=>service.childEnvironment({}),{code:'CLASH_RUN_LEASE_REQUIRED'});
 assert.equal(fixture.mutations,0);
});
