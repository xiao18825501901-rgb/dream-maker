// Actual localhost HTTP + original NativeOwner/Store, synthetic session key only.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {NativeOwner} from '../../dist/server/native-owner.js';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';import {hash} from '../../dist/server/security.js';import {root} from '../helpers.mjs';
const canary='DM_SYNTHETIC_HTTP_ACCOUNT_KEY_NOT_REAL';
function profile(){const role=(id,write=false)=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'HTTP_AUTH',accountRef:'HTTP_ACCOUNT',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});return{mode:'custom',laya:false,accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'HTTP_AUTH',accountRef:'HTTP_ACCOUNT'}],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};}
for(const product of ['dream-maker','dreamflow'])test(product+' checks actual private account references through original auth and rechecks volatile availability on replay',{timeout:45000},async()=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const scope=mkdtempSync(join(parent,'custom-account-http-')),data=join(scope,'.runtime');mkdirSync(join(data,'config'),{recursive:true});mkdirSync(join(scope,'config'),{recursive:true});
 const ref=(name,value)=>{const bytes=JSON.stringify(value),path=join(scope,name);writeFileSync(path,bytes);return{path,sha256:hash(bytes)};};
 const authority=ref('authority.json',{scopeId:'OFFLINE_HTTP_ACCOUNT_SOURCE',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2}),sources=ref('sources.json',{schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'HTTP_AUTH',accountRef:'HTTP_ACCOUNT',secretEnv:'DM_CUSTOM_HTTP_API_KEY'}]});
 writeFileSync(join(scope,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:scope,authority,customAccountSources:sources,prices:{},maxOutputTokens:128,maxRequests:8}));
 let key=canary,reads=0,models=0,owner;const app=await createApp({root:scope,data,configPath:join(data,'local.json'),product,port:0,paidRequestGuard:()=>{models++;throw Error('NO_MODEL');},nativeOwnerBuilder:context=>owner=new NativeOwner({...context,root:scope,getSecret:()=>{reads++;return key;},fetch:async()=>{models++;throw Error('NO_PROVIDER');}})});
 try{
  const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const p=app.interviews.create('账户来源本机检查','不调用模型或登录服务。','demo');await app.interviews.finish(p.id,'',false);const s=app.store.spec(app.store.project(p.id).specId);app.interviews.approve(p.id,s.hash);
  const version=new FlowProfiles(app.store).confirm(p.id,{configuration:profile(),expectedRevision:0,confirmed:true},'local-session:'+'a'.repeat(64),'OFFLINE_HTTP_PROFILE'),preparation=app.engine.prepareCustomFlow(p.id,s.hash,version.contentHash),path='/api/projects/'+p.id+'/flow-account-sources';
  const input={specHash:s.hash,profileHash:version.contentHash,preparation:{identityHash:preparation.identityHash,contentHash:preparation.contentHash},confirmed:true};
  const call=async(body=input,extra={})=>{const response=await fetch(app.origin+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...extra},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
  assert.equal((await call(input,{cookie:''})).status,401);assert.equal((await call(input,{'x-csrf-token':'wrong'})).status,403);assert.equal((await call({...input,confirmed:false})).status,403);assert.equal((await call({...input,secret:canary})).status,400);assert.equal(reads,0);
  const id=crypto.randomUUID(),first=await call(input,{'idempotency-key':id});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.accounts[0].status,'AVAILABLE_UNVERIFIED');
  for(const field of ['accountVerified','modelVerified','runtimeStarted','executionGranted'])assert.equal(first.body[field],false);assert.equal(first.body.flowConfigHash,preparation.flowConfigHash);
  key=undefined;const second=await call(input,{'idempotency-key':id});assert.equal(second.status,200);assert.equal(second.body.accounts[0].status,'SECRET_MISSING','idempotency must not cache availability as a credential proof');
  assert.equal((await call({...input,profileHash:'0'.repeat(64)},{'idempotency-key':id})).status,409);assert.equal(reads,2);
  app.settings.value.limits.maxCalls++;assert.equal((await call(input,{'idempotency-key':id})).status,409);assert.equal(reads,2);
  assert.equal(JSON.stringify(app.store.db.prepare('SELECT data FROM records').all()).includes(canary),false);assert.equal(JSON.stringify([first,second]).includes('DM_CUSTOM_HTTP_API_KEY'),false);
  assert.equal(app.store.runs(p.id).length,0);assert.equal(app.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);assert.equal(owner.budget.requests().length,0);assert.equal(models,0);
 }finally{await app.close();rmSync(scope,{recursive:true,force:true});}
});

test('DreamFlow account step binds an exact private v2 identity via authenticated HTTP without reading credentials',async t=>{
 const scope=mkdtempSync(join(root,'.runtime/test-temp/source-picker-')),data=join(scope,'.runtime');
 t.after(()=>rmSync(scope,{recursive:true,force:true}));mkdirSync(join(scope,'config'),{recursive:true});mkdirSync(data,{recursive:true});
 const pin=(name,value)=>{const path=join(scope,name),bytes=JSON.stringify(value);writeFileSync(path,bytes);return{path,sha256:hash(bytes)};};
 const ids=['first','second'].map(id=>({provider:'vendor-a',authentication:'api_key',authRef:'auth-'+id,accountRef:'account-'+id}));
 const manifest=pin('sources.json',{schema:'dream-maker.custom-account-sources.v2',accounts:ids.map((identity,i)=>({...identity,secretEnv:'DM_CUSTOM_PICKER_'+i+'_API_KEY',capabilities:[{model:'test-model',protocol:'openai-responses',endpoint:'https://hidden.example/v1/responses'}]}))});
 const authority=pin('authority.json',{scopeId:'OFFLINE_HTTP_PICKER',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});
 writeFileSync(join(scope,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:scope,authority,customAccountSources:manifest,prices:{},maxOutputTokens:128,maxRequests:8}));
 let reads=0;const app=await createApp({root:scope,data,configPath:join(data,'local.json'),product:'dreamflow',port:0,nativeOwnerBuilder:ctx=>new NativeOwner({...ctx,getSecret:()=>{reads++;throw Error('NO_SECRET_READ');}})});
 try{
  const endpoint='/api/account-sources?identities=1';assert.equal((await fetch(app.origin+endpoint)).status,401);
  const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});const cookie=login.headers.get('set-cookie').split(';')[0];
  const get=path=>fetch(app.origin+path,{headers:{cookie}});const reply=await get(endpoint);assert.equal(reply.status,200);assert.deepEqual(await reply.json(),{sources:ids});
  const {CustomFlowWizard}=await import('../../dist/web/custom-flow-controller.js');const {wizardRoles,addWizardItem}=await import('../../dist/web/custom-flow-state.js');
  const project=app.interviews.create('测试来源','离线', 'demo'),drafts=new Map();let html='';const errors=[];
  const wizard=new CustomFlowWizard({request:async path=>{const response=await get('/api'+path);assert.equal(response.status,200);return response.json();}},
   {get:k=>drafts.get(k)??'',set:(k,v)=>(drafts.set(k,v),true),delete:k=>drafts.delete(k)},
   {dreamflow:true,active:()=>true,show:view=>html=view,error:m=>errors.push(m),saved:()=>assert.fail('unexpected profile write')});
  await wizard.open(project.id);const dataFor=fields=>({get:name=>fields[name]??null});await wizard.readAccountIdentities();assert.match(html,/value="vendor-a"/);
  wizard.update(dataFor({'account-provider-0':'vendor-a','account-auth-0':'api_key'}),true);addWizardItem(wizard.state,'group');assert.match(html,/data-source="auth-second"/);
  const draftAuth=wizard.state.configuration.accounts[0].authRef;wizard.attachAccountIdentity(dataFor({}),0,draftAuth,wizard.state.configuration.accounts[0].accountRef,ids[1].authRef,ids[1].accountRef);
  assert.equal(wizard.state.configuration.accounts[0].accountRef,ids[1].accountRef);assert.ok(wizardRoles(wizard.state).every(r=>r.authRef===ids[1].authRef&&r.accountRef===ids[1].accountRef));assert.equal(wizard.state.configuration.groups[0].members[0].accountRef,ids[1].accountRef);
  wizard.cancel();await wizard.open(project.id);assert.equal(wizard.state.configuration.accounts[0].authRef,ids[1].authRef);assert.deepEqual(errors.filter(Boolean),[]);
  writeFileSync(manifest.path,'{}');const stale=await get(endpoint);assert.equal(stale.status,409);assert.equal((await stale.json()).error,'NATIVE_BINDING_CHANGED');assert.equal(reads,0);
 }finally{await app.close();}
});

test('identity projection deduplicates exact pins, omits stale registrations and rejects ambiguous references',async()=>{
 const {publicAccountIdentities}=await import('../../dist/server/custom-account-sources.js');
 const {withExplicitSecretInspection}=await import('../../dist/server/security.js');
 const identity={provider:'deepseek-official',authentication:'api_key',authRef:'auth-one',accountRef:'account-one'};
 const env='DSH_PICKER_API_KEY',source={...identity,secretEnv:env,capabilities:[{model:'test',protocol:'chat-completions',endpoint:'https://api.deepseek.com/v1/chat/completions'}]};
 const manifest={schema:'dream-maker.custom-account-sources.v2',accounts:[source]},registered={...identity,status:'SELECTED_UNVERIFIED'};
 const project=(m,registrations)=>withExplicitSecretInspection([],()=>publicAccountIdentities(m,env,registrations));
 assert.deepEqual(project(manifest,[registered]),[identity]);
 assert.deepEqual(project(manifest,[{...registered,authRef:'alias-auth',accountRef:'alias-account'}]),[identity]);
 assert.deepEqual(project(undefined,[{...registered,status:'SOURCE_STALE'}]),[]);
 for(const changed of [{authRef:'alias-auth'},{accountRef:'alias-account'}])assert.throws(()=>project(manifest,[{...registered,...changed}]),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
 assert.throws(()=>project({...manifest,accounts:[{...source,authRef:env}]},[]),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
});
