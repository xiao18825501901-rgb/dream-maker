// OFFLINE original Store/NativeOwner with synthetic secrets. No process or model call.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
import {harness,ready} from '../helpers.mjs';import {NativeOwner} from '../../dist/server/native-owner.js';import {FlowProfiles} from '../../dist/server/flow-profiles.js';import {hash} from '../../dist/server/security.js';
import {consumeMagpieAccountCustody} from '../../dist/server/magpie-account-custody.js';
import {withMagpieLocalCheck} from '../../dist/server/magpie-check.js';
const actor='local-session:'+'a'.repeat(64),value='UNMARKED_SYNTHETIC_OWNER_CUSTODY_NOT_REAL';
async function rig(t,{registered=false}={}){
 let owner;t.after(()=>owner?.close());
 const h=harness(t),{p,s}=await ready(h),reads=[];mkdirSync(join(h.dir,'config'));const ref=(name,v)=>{const path=join(h.dir,name),bytes=JSON.stringify(v);writeFileSync(path,bytes);return{path,sha256:hash(bytes)};};
 const authority=ref('authority.json',{scopeId:'OFFLINE_CUSTODY_OWNER',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2}),manifest=ref('sources.json',{schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',secretEnv:h.config.dsh.keyEnv}]});
 const operatorPath=join(h.dir,'config/native-owner.local.json');writeFileSync(operatorPath,JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:h.dir,authority,prices:{},maxOutputTokens:128,maxRequests:8,...(registered?{}:{customAccountSources:manifest})}));
 owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,getSecret:name=>{reads.push(name);return value;}});
 const a=registered?owner.registerAccountSource({sourceId:'CONTROLLER_DSH_SESSION',label:'离线专用来源',confirmed:true},actor,hash('OFFLINE_CUSTODY_REGISTER')):{authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE'};reads.length=0;
 const role=(id,write=false)=>({id,provider:'deepseek-official',authentication:'api_key',authRef:a.authRef,accountRef:a.accountRef,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}}),configuration={mode:'custom',laya:false,accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:a.authRef,accountRef:a.accountRef}],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_CUSTODY_PROFILE'),preparation=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash),input={projectId:p.id,specHash:s.hash,profileHash:profile.contentHash,preparation:{identityHash:preparation.identityHash,contentHash:preparation.contentHash}};
 return{h,p,s,a,owner,reads,input,operatorPath,manifest};
}
for(const registered of [false,true])test('original owner issues custody only for frozen '+(registered?'registered':'private-manifest')+' sources without reading a key',async t=>{
 const x=await rig(t,{registered}),ticket=x.owner.prepareCustomMagpieCustody(x.input);assert.deepEqual(x.reads,[]);assert.equal(JSON.stringify(ticket).includes(value),false);const account=consumeMagpieAccountCustody(ticket.custody,ticket.binding)[0];assert.equal(account.authRef,x.a.authRef);assert.equal(account.key,value);account.key='';assert.deepEqual(x.reads,[x.h.config.dsh.keyEnv]);assert.equal(x.owner.budget.requests().length,0);assert.equal(x.h.store.runs(x.p.id).length,0);
});
test('drift of the original configuration or source fails before a credential read',async t=>{
 for(const change of [x=>x.h.config.limits.maxCalls++,x=>writeFileSync(x.manifest.path,'{}')]){const x=await rig(t),ticket=x.owner.prepareCustomMagpieCustody(x.input);change(x);assert.throws(()=>consumeMagpieAccountCustody(ticket.custody,ticket.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_STALE'});assert.deepEqual(x.reads,[]);}
});
test('foreign preparation and owner shutdown cannot leave a reusable custody',async t=>{
 const x=await rig(t);assert.throws(()=>x.owner.prepareCustomMagpieCustody({...x.input,preparation:{...x.input.preparation,contentHash:'0'.repeat(64)}}));assert.deepEqual(x.reads,[]);const ticket=x.owner.prepareCustomMagpieCustody(x.input);x.owner.stopRequests();assert.throws(()=>consumeMagpieAccountCustody(ticket.custody,ticket.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_INVALID'});assert.deepEqual(x.reads,[]);
});
test('changing a caller request after issue cannot redirect the original source',async t=>{
 const x=await rig(t),ticket=x.owner.prepareCustomMagpieCustody(x.input);x.input.specHash='0'.repeat(64);x.input.preparation.contentHash='0'.repeat(64);const a=consumeMagpieAccountCustody(ticket.custody,ticket.binding)[0];assert.equal(a.authRef,x.a.authRef);a.key='';
});

test('the owned account control refuses a missing candidate before reading any credential',async t=>{
 const x=await rig(t);let callbacks=0;await assert.rejects(x.owner.withCustomMagpieControl(x.input,async()=>{callbacks++;}),{code:'MAGPIE_CANDIDATE_BINDING_REQUIRED'});assert.deepEqual(x.reads,[]);assert.equal(callbacks,0);assert.equal(x.owner.budget.requests().length,0);
});

test('only the dedicated account inspector can use the original active local check scope',async t=>{
 const x=await rig(t);await withMagpieLocalCheck(x.h.store,hash('OFFLINE_ACCOUNT_LOCAL_SCOPE'),async()=>{
  assert.throws(()=>x.owner.prepareCustomMagpieCustody(x.input),{code:'NATIVE_OWNER_CLEANUP_UNCERTAIN'});
  await assert.rejects(x.owner.inspectCustomMagpieAccounts(x.input,new AbortController().signal,x.owner.describeCustomMagpieAccountCheck(x.input)),{code:'MAGPIE_CANDIDATE_BINDING_REQUIRED'});
 });assert.deepEqual(x.reads,[]);
});

test('operator drift during owned cleanup is rechecked before a historical success escapes',async t=>{
 const x=await rig(t),selected=x.owner.describeCustomMagpieAccountCheck(x.input);
 x.owner.useCustomMagpieControl=async(_input,consume)=>{const value=await consume({observation:{qualification:'NOT_VERIFIED',realCredentialsPermitted:true,accountCount:1}},selected,new AbortController().signal);writeFileSync(x.operatorPath,readFileSync(x.operatorPath,'utf8')+' ');return value;};
 await assert.rejects(x.owner.inspectCustomMagpieAccounts(x.input,new AbortController().signal,selected),{code:'MAGPIE_ACCOUNT_CHECK_SELECTION_CHANGED'});assert.deepEqual(x.reads,[]);
});

test('the owned local check consumes its own ticket while its controller is active',async t=>{
 const x=await rig(t),binding=x.owner.describeCustomMagpieAccountCheck(x.input);let consumed=0;
 x.owner.reviewedMagpieCandidate=()=>({path:join(x.h.dir,'synthetic-magpie.exe'),sha256:'0'.repeat(64)});
 x.owner.openMagpieControl=async({accountCustody,custodyBinding})=>{
  const accounts=consumeMagpieAccountCustody(accountCustody,custodyBinding);consumed=accounts.length;for(const account of accounts)account.key='';
  return{observation:{qualification:'NOT_VERIFIED',realCredentialsPermitted:true,accountCount:accounts.length},close:async()=>{}};
 };
 await withMagpieLocalCheck(x.h.store,hash('OFFLINE_ACCOUNT_OWN_CONTROLLER'),async()=>{
  const view=await x.owner.inspectCustomMagpieAccounts(x.input,new AbortController().signal,binding);
  assert.equal(view.accountCount,1);assert.equal(view.processClosed,true);assert.equal(view.accountVerified,false);assert.equal(consumed,1);
 });
 assert.deepEqual(x.reads,[x.h.config.dsh.keyEnv]);
});

test('a foreign active controller still refuses the local account check',async t=>{
 const x=await rig(t),foreign=new AbortController();x.owner.active.set(foreign,new Promise(()=>{}));
 try{
  assert.throws(()=>x.owner.describeCustomMagpieAccountCheck(x.input),{code:'NATIVE_OWNER_BUSY_OR_CLOSED'});
  assert.throws(()=>x.owner.prepareCustomMagpieCustody(x.input),{code:'NATIVE_OWNER_BUSY_OR_CLOSED'});
 }finally{x.owner.active.delete(foreign);}
 assert.deepEqual(x.reads,[]);
});
