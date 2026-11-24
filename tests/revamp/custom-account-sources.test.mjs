// OFFLINE original NativeOwner + Store. Synthetic controller secrets, no process/model/network.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {harness,ready} from '../helpers.mjs';import {NativeOwner} from '../../dist/server/native-owner.js';import {customAccountReferences} from '../../dist/server/custom-account-sources.js';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';import {hash} from '../../dist/server/security.js';
const actor='local-session:'+'a'.repeat(64),canary='DM_SYNTHETIC_PRIVATE_KEY_NOT_A_REAL_CREDENTIAL';
export function configuration(provider='deepseek-official',authentication='api_key'){
 const role=(id,write=false)=>({id,provider,authentication,authRef:'AUTH_USED',accountRef:'ACCOUNT_USED',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 return{mode:'custom',laya:false,accounts:[{provider,authentication,authRef:'AUTH_USED',accountRef:'ACCOUNT_USED'},{provider,authentication,authRef:'AUTH_UNUSED',accountRef:'ACCOUNT_UNUSED'}],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
}
export async function sourceRig(t,options={}){
 let owner;t.after(()=>owner?.close());const h=harness(t),{p,s}=await ready(h),configuration=options.configuration??configurationForTest();
 const profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_ACCOUNT_SELECTION'),preparation=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);
 mkdirSync(join(h.dir,'config'),{recursive:true});const ref=(name,value)=>{const path=join(h.dir,name),bytes=JSON.stringify(value);writeFileSync(path,bytes);return{path,sha256:hash(bytes)};};
 const authority=ref('authority.json',{scopeId:'OFFLINE_ACCOUNT_SOURCES',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});
 const catalog=options.catalog??{schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_USED',accountRef:'ACCOUNT_USED',secretEnv:h.config.dsh.keyEnv},{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_UNUSED',accountRef:'ACCOUNT_UNUSED',secretEnv:'DM_CUSTOM_UNUSED_API_KEY'}]};
 const source=options.noCatalog?undefined:ref('account-sources.json',catalog);writeFileSync(join(h.dir,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:h.dir,authority,prices:{},maxOutputTokens:128,maxRequests:8,...(source?{customAccountSources:source}:{})}));
 const reads=[];owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,getSecret:name=>{reads.push(name);if(options.error)throw Error(canary);return options.missing?undefined:options.secret===undefined?canary:options.secret;}});
 const input={projectId:p.id,specHash:s.hash,profileHash:profile.contentHash,preparation:{identityHash:preparation.identityHash,contentHash:preparation.contentHash}};
 return{h,owner,p,s,profile,preparation,input,reads,source,catalog};
}
const configurationForTest=()=>configuration();
test('frozen roles resolve only explicit selected account sources and never claim account qualification',async t=>{
 const x=await sourceRig(t),view=x.owner.inspectCustomAccountSources(x.input);
 assert.equal(view.flowConfigHash,x.preparation.flowConfigHash);assert.equal(view.accounts.length,1);assert.equal(view.accounts[0].status,'AVAILABLE_UNVERIFIED');assert.deepEqual(x.reads,[x.h.config.dsh.keyEnv]);
 for(const field of ['accountVerified','modelVerified','runtimeStarted','executionGranted'])assert.equal(view[field],false);
 const text=JSON.stringify(view);assert.equal(text.includes(canary),false);assert.equal(text.includes('secretEnv'),false);assert.equal(text.includes(x.h.config.dsh.keyEnv),false);assert.equal(text.includes(hash(canary)),false);
 assert.equal(x.h.store.runs(x.p.id).length,0);assert.equal(x.owner.budget.requests().length,0);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);
});
test('one selected source may declare the explicit model set it serves',async t=>{
 const catalog={schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_USED',accountRef:'ACCOUNT_USED',secretEnv:'DM_CUSTOM_MODELS_API_KEY',models:['deepseek-flash','deepseek-chat','deepseek-reasoner']},{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_UNUSED',accountRef:'ACCOUNT_UNUSED',secretEnv:'DM_CUSTOM_UNUSED_API_KEY'}]};
 const x=await sourceRig(t,{catalog}),view=x.owner.inspectCustomAccountSources(x.input);
 assert.equal(view.accounts[0].status,'AVAILABLE_UNVERIFIED');assert.equal(JSON.stringify(view).includes('deepseek-reasoner'),false);
});
test('an empty, duplicate or oversized model set is refused before any credential is read',async t=>{
 const bad=[['deepseek-chat','deepseek-chat'],[],['a','b','c','d','e','f','g','h','i']];
 for(const models of bad){
  const catalog={schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_USED',accountRef:'ACCOUNT_USED',secretEnv:'DM_CUSTOM_MODELS_API_KEY',models},{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_UNUSED',accountRef:'ACCOUNT_UNUSED',secretEnv:'DM_CUSTOM_UNUSED_API_KEY'}]};
  const x=await sourceRig(t,{catalog});assert.throws(()=>x.owner.inspectCustomAccountSources(x.input),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});assert.deepEqual(x.reads,[]);
 }
});
test('missing private catalog reports configuration needed without inspecting any environment values',async t=>{
 const x=await sourceRig(t,{noCatalog:true}),view=x.owner.inspectCustomAccountSources(x.input);assert.equal(view.accounts[0].status,'SOURCE_NOT_CONFIGURED');assert.equal(view.sourceManifestHash,null);assert.deepEqual(x.reads,[]);
});
for(const secret of ['', 'short', 'bad\nprivate'])test('an absent or invalid selected credential remains unverified: '+JSON.stringify(secret),async t=>{
 const x=await sourceRig(t,{secret}),view=x.owner.inspectCustomAccountSources(x.input);assert.equal(view.accounts[0].status,secret?'SECRET_INVALID':'SECRET_MISSING');assert.equal(view.accountVerified,false);
});
test('credential read errors reveal no raw message or key',async t=>{const x=await sourceRig(t,{error:true}),view=x.owner.inspectCustomAccountSources(x.input);assert.equal(view.accounts[0].status,'SOURCE_UNAVAILABLE');assert.equal(JSON.stringify(view).includes(canary),false);});
test('an explicit missing-secret resolver cannot fall through to an ambient account',async t=>{
 const name='DM_CUSTOM_AMBIENT_API_KEY',previous=process.env[name];t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous;});process.env[name]=canary;
 const catalog={schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_USED',accountRef:'ACCOUNT_USED',secretEnv:name}]},x=await sourceRig(t,{catalog,missing:true});
 assert.equal(x.owner.inspectCustomAccountSources(x.input).accounts[0].status,'SECRET_MISSING');
});
test('metadata revalidation does not enumerate an unselected environment credential',async t=>{
 const x=await sourceRig(t,{missing:true}),name='DM_CUSTOM_UNSELECTED_API_KEY',previous=process.env[name];t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous;});process.env[name]='AUTH_USED';
 assert.equal(x.owner.inspectCustomAccountSources(x.input).accounts[0].status,'SECRET_MISSING');assert.deepEqual(x.reads,[x.h.config.dsh.keyEnv]);
});
test('a selected secret cannot return through an incidental account reference match',async t=>{
 const x=await sourceRig(t,{secret:'AUTH_USED'});assert.throws(()=>x.owner.inspectCustomAccountSources(x.input),{code:'CUSTOM_ACCOUNT_SECRET_IN_OBSERVATION'});
});
test('even an invalid short credential cannot be echoed through the selected reference',async t=>{
 const selection=configuration();selection.accounts[0].authRef='short';for(const role of [selection.roles.planner2,...selection.roles.executors,selection.roles.reviewer])role.authRef='short';
 const catalog={schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'short',accountRef:'ACCOUNT_USED',secretEnv:'DM_CUSTOM_ONE_API_KEY'}]},x=await sourceRig(t,{configuration:selection,catalog,secret:'short'});
 assert.throws(()=>x.owner.inspectCustomAccountSources(x.input),{code:'CUSTOM_ACCOUNT_SECRET_IN_OBSERVATION'});
});
test('component preparation blocks another source read just like original maintenance admission',async t=>{
 const x=await sourceRig(t);x.owner.preparing=Promise.resolve();assert.throws(()=>x.owner.inspectCustomAccountSources(x.input),{code:'NATIVE_OWNER_BUSY_OR_CLOSED'});assert.deepEqual(x.reads,[]);x.owner.preparing=undefined;
});
test('inspection cannot implicitly create a preparation without the original selection reference',async t=>{
 const x=await sourceRig(t);const before=x.h.store.records(x.p.id,'CustomFlowPrepared').length;const input={...x.input};delete input.preparation;
 assert.throws(()=>x.owner.inspectCustomAccountSources(input),{code:'CUSTOM_ACCOUNT_SELECTION_REQUIRED'});assert.equal(x.h.store.records(x.p.id,'CustomFlowPrepared').length,before);assert.deepEqual(x.reads,[]);
});
test('OAuth selections never borrow an API key or inspect shared login directories',async t=>{const x=await sourceRig(t,{configuration:configuration('github','oauth')}),view=x.owner.inspectCustomAccountSources(x.input);assert.equal(view.accounts[0].status,'AUTHENTICATION_NOT_SUPPORTED');assert.deepEqual(x.reads,[]);});
test('denied selections stop in the original profile and native runtime accounts avoid Magpie secret reads',async t=>{
 const denied=configuration();denied.privacy.deniedProviders=['deepseek-official'];await assert.rejects(sourceRig(t,{configuration:denied}),{code:'FLOW_PROFILE_PRIVACY_DENIED'});
 const selection=configuration();for(const role of [selection.roles.planner2,...selection.roles.executors,selection.roles.reviewer]){role.transport='native';role.nativeException=true;}
 const x=await sourceRig(t,{configuration:selection}),view=x.owner.inspectCustomAccountSources(x.input);assert.equal(view.accounts[0].status,'NATIVE_RUNTIME_MANAGED');assert.deepEqual(x.reads,[]);
});
test('a selected model group reads only its explicitly selected member account',async t=>{
 const selection=configuration();selection.accounts.push({provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_SELECTED',accountRef:'ACCOUNT_SELECTED'});
 selection.roles.executors[0].model={kind:'group',id:'GROUP_SELECTED'};selection.roles.executors[0].selectedMemberId='MEMBER_TWO';
 selection.groups=[{id:'GROUP_SELECTED',strategy:'failure_only',members:[
  {id:'MEMBER_ONE',provider:'deepseek-official',model:'deepseek-flash',authRef:'AUTH_UNUSED',accountRef:'ACCOUNT_UNUSED',permissions:['source_read']},
  {id:'MEMBER_TWO',provider:'deepseek-official',model:'deepseek-flash',authRef:'AUTH_SELECTED',accountRef:'ACCOUNT_SELECTED',permissions:['source_read']}
 ]}];
 const catalog={schema:'dream-maker.custom-account-sources.v1',accounts:[
  {provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_USED',accountRef:'ACCOUNT_USED',secretEnv:'DM_CUSTOM_USED_API_KEY'},
  {provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_UNUSED',accountRef:'ACCOUNT_UNUSED',secretEnv:'DM_CUSTOM_UNUSED_API_KEY'},
  {provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_SELECTED',accountRef:'ACCOUNT_SELECTED',secretEnv:'DM_CUSTOM_SELECTED_API_KEY'}
]},x=await sourceRig(t,{configuration:selection,catalog}),view=x.owner.inspectCustomAccountSources(x.input);
 assert.equal(view.accounts.length,2);assert.deepEqual(x.reads,['DM_CUSTOM_USED_API_KEY','DM_CUSTOM_SELECTED_API_KEY']);assert.ok(view.accounts.every(a=>a.status==='AVAILABLE_UNVERIFIED'));
});
test('group metadata never enumerates every candidate when the initial member is missing',()=>{
 const selection=configuration();selection.accounts.push({provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_SELECTED',accountRef:'ACCOUNT_SELECTED'});
 selection.roles.executors[0].model={kind:'group',id:'GROUP_SELECTED'};
 selection.groups=[{id:'GROUP_SELECTED',strategy:'failure_only',members:[
  {id:'MEMBER_ONE',provider:'deepseek-official',model:'deepseek-flash',authRef:'AUTH_UNUSED',accountRef:'ACCOUNT_UNUSED',permissions:['source_read']},
  {id:'MEMBER_TWO',provider:'deepseek-official',model:'deepseek-flash',authRef:'AUTH_SELECTED',accountRef:'ACCOUNT_SELECTED',permissions:['source_read']}
 ]}];
 assert.throws(()=>customAccountReferences(selection),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
});
test('same authRef with another declared account is a mismatch, not fallback permission',async t=>{
 const catalog={schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_USED',accountRef:'OTHER_ACCOUNT',secretEnv:'DM_CUSTOM_ONE_API_KEY'}]},x=await sourceRig(t,{catalog});assert.equal(x.owner.inspectCustomAccountSources(x.input).accounts[0].status,'SOURCE_MISMATCH');assert.deepEqual(x.reads,[]);
});
test('an invalid unused source stops the complete manifest before any selected secret read',async t=>{
 const catalog={schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_USED',accountRef:'ACCOUNT_USED',secretEnv:'DM_CUSTOM_ONE_API_KEY'},{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_UNUSED',accountRef:'ACCOUNT_UNUSED',secretEnv:'PATH'}]},x=await sourceRig(t,{catalog});assert.throws(()=>x.owner.inspectCustomAccountSources(x.input),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});assert.deepEqual(x.reads,[]);
});
test('changed private manifest and operator bytes are refused before credential lookup',async t=>{
 const x=await sourceRig(t);writeFileSync(x.source.path,JSON.stringify({...x.catalog,verified:true}));assert.throws(()=>x.owner.inspectCustomAccountSources(x.input),{code:'NATIVE_BINDING_CHANGED'});assert.deepEqual(x.reads,[]);
 const y=await sourceRig(t);writeFileSync(join(y.h.dir,'config/native-owner.local.json'),'{}');assert.throws(()=>y.owner.inspectCustomAccountSources(y.input),{code:'NATIVE_OPERATOR_CONFIG_CHANGED'});assert.deepEqual(y.reads,[]);
});
test('foreign preparation, profile drift, and busy/uncertain owners fail before reading a credential',async t=>{
 const x=await sourceRig(t);for(const input of [{...x.input,profileHash:'0'.repeat(64)},{...x.input,preparation:{...x.input.preparation,contentHash:'0'.repeat(64)}}])assert.throws(()=>x.owner.inspectCustomAccountSources(input));
 x.owner.cleanupUncertain=true;assert.throws(()=>x.owner.inspectCustomAccountSources(x.input),{code:'NATIVE_OWNER_CLEANUP_UNCERTAIN'});x.owner.cleanupUncertain=false;
 x.h.config.limits.maxCalls++;assert.throws(()=>x.owner.inspectCustomAccountSources(x.input),{code:'FLOW_PREPARATION_STALE'});assert.deepEqual(x.reads,[]);
});
for(const change of [a=>({...a,secretEnv:'PATH'}),a=>({...a,secretEnv:'OPENAI_API_KEY'}),a=>({...a,token:canary}),a=>({...a,provider:'openai'})])test('private source manifests reject widened fields and unrelated secret names before any read',async t=>{
 const catalog={schema:'dream-maker.custom-account-sources.v1',accounts:[change({provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_USED',accountRef:'ACCOUNT_USED',secretEnv:'DM_CUSTOM_ONE_API_KEY'})]},x=await sourceRig(t,{catalog});assert.throws(()=>x.owner.inspectCustomAccountSources(x.input),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});assert.deepEqual(x.reads,[]);
});

// Stage B: the account may pin the model it actually serves. Only that one extra key is allowed;
// an unparsable model is refused before any credential read, exactly like the other widened fields.
test('a source manifest may name the account model but nothing further',async t=>{
 const ok={schema:'dream-maker.custom-account-sources.v1',accounts:[
  {provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_USED',accountRef:'ACCOUNT_USED',secretEnv:'DM_CUSTOM_ONE_API_KEY',model:'deepseek-chat'},
  {provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_UNUSED',accountRef:'ACCOUNT_UNUSED',secretEnv:'DM_CUSTOM_UNUSED_API_KEY'}]};
 const x=await sourceRig(t,{catalog:ok});assert.doesNotThrow(()=>x.owner.inspectCustomAccountSources(x.input));
 for(const model of ['bad model','../escape','','x'.repeat(129),7])
  { const bad={...ok,accounts:[{...ok.accounts[0],model}]},y=await sourceRig(t,{catalog:bad});assert.throws(()=>y.owner.inspectCustomAccountSources(y.input),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'},String(model)); }
});
