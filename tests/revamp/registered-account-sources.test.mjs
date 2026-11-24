// OFFLINE original NativeOwner/SQLite, synthetic secret. No account/model/process execution.
import test from 'node:test';import assert from 'node:assert/strict';
import {NativeOwner} from '../../dist/server/native-owner.js';import {Store} from '../../dist/server/store.js';import {harness} from '../helpers.mjs';import {hash} from '../../dist/server/security.js';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {ready} from '../helpers.mjs';import {FlowProfiles} from '../../dist/server/flow-profiles.js';
const actor='local-session:'+'a'.repeat(64),secret='DM_SYNTHETIC_REGISTRATION_KEY_NOT_REAL';
const input=(label='我的专用来源')=>({sourceId:'CONTROLLER_DSH_SESSION',label,confirmed:true});
function fixture(t,options={}){
 const owners=[],extra=[];t.after(async()=>{for(const o of owners)await o.close();for(const s of extra)s.close();});const h=harness(t),reads=[];
 if(options.withOperator){mkdirSync(join(h.dir,'config'));const path=join(h.dir,'authority.json'),body=JSON.stringify({scopeId:'OFFLINE_REGISTERED_SOURCE',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});writeFileSync(path,body);writeFileSync(join(h.dir,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:h.dir,authority:{path,sha256:hash(body)},prices:{},maxOutputTokens:128,maxRequests:8}));}
 const open=store=>{const owner=new NativeOwner({root:h.dir,store,getConfig:()=>h.config,getSecret:name=>{reads.push(name);if(options.drift)h.config.dsh.keyEnv='DM_CUSTOM_CHANGED_API_KEY';if(options.unavailable)throw Error(secret);return options.missing?undefined:secret;}});owners.push(owner);return owner;};const owner=open(h.store);
 return{h,owner,reads,reopen(){const store=new Store(h.store.path);extra.push(store);return open(store);},count:kind=>Number(h.store.db.prepare('SELECT count(*) n FROM records WHERE kind=?').get(kind).n)};
}
test('listing predefined choices and registered metadata never reads a credential or needs a project',t=>{
 const x=fixture(t),view=x.owner.registeredAccountSources();assert.equal(view.sources.length,0);assert.equal(view.choices[0].sourceId,'CONTROLLER_DSH_SESSION');assert.equal(view.choices[0].accountVerified,false);assert.deepEqual(x.reads,[]);assert.equal(x.h.store.projects().length,0);
});
test('an explicit selection creates one unverified reference without storing a value, name, or credential digest',t=>{
 const x=fixture(t),source=x.owner.registerAccountSource(input(),actor,hash('OFFLINE_REGISTER'));
 assert.equal(source.provider,'deepseek-official');assert.equal(source.authentication,'api_key');assert.equal(source.status,'SELECTED_UNVERIFIED');for(const field of ['accountVerified','modelVerified','executionGranted'])assert.equal(source[field],false);
 assert.match(source.authRef,/^controller_auth_/);assert.match(source.accountRef,/^controller_account_/);assert.equal(x.count('CustomAccountSourceRegistered'),1);assert.equal(x.count('CustomAccountSourceSelection'),1);assert.deepEqual(x.reads,[x.h.config.dsh.keyEnv]);
 const text=JSON.stringify(x.h.store.db.prepare('SELECT data FROM records').all());assert.equal(text.includes(secret),false);assert.equal(text.includes(x.h.config.dsh.keyEnv),false);assert.equal(text.includes(hash(secret)),false);assert.equal(x.h.store.projects().length,0);assert.equal(x.h.store.runs().length,0);
});
test('same-operation replay and another confirmation reuse one source instead of inventing independent accounts',t=>{
 const x=fixture(t),operation=hash('OFFLINE_ONE'),one=x.owner.registerAccountSource(input(),actor,operation),two=x.owner.registerAccountSource(input(),actor,operation);
 assert.deepEqual(two,one);assert.equal(x.count('CustomAccountSourceRegistered'),1);assert.equal(x.count('CustomAccountSourceSelection'),1);
 const three=x.owner.registerAccountSource(input('另一个称呼'),actor,hash('OFFLINE_TWO'));assert.equal(three.id,one.id);assert.equal(x.count('CustomAccountSourceRegistered'),1);assert.equal(x.count('CustomAccountSourceSelection'),2);
 assert.throws(()=>x.owner.registerAccountSource(input('改写同一请求'),actor,operation),{code:'IDEMPOTENCY_KEY_REUSED'});
});
test('source metadata survives actual Store reopen and becomes stale after a reference change',t=>{
 const x=fixture(t),operation=hash('OFFLINE_REOPEN'),source=x.owner.registerAccountSource(input(),actor,operation),owner=x.reopen();assert.deepEqual(owner.registeredAccountSources().sources[0],source);
 x.h.config.dsh.keyEnv='DM_CUSTOM_CHANGED_API_KEY';assert.equal(owner.registeredAccountSources().sources[0].status,'SOURCE_STALE');assert.throws(()=>owner.registerAccountSource(input(),actor,operation),{code:'CUSTOM_ACCOUNT_SOURCE_STALE'});
});
test('invalid requests, missing consent and unrelated source identifiers cannot read a key or persist a choice',t=>{
 const x=fixture(t);for(const body of [{...input(),confirmed:false},{...input(),secretEnv:'PATH'},{...input(),key:secret},{...input(),sourceId:'WINDOWS_DAILY_CODEX'},{...input(),label:'Bearer '+secret}])assert.throws(()=>x.owner.registerAccountSource(body,actor,hash(JSON.stringify(body))));assert.equal(x.count('CustomAccountSourceRegistered'),0);assert.deepEqual(x.reads,[]);
});
test('the selected value cannot leak through a label even when it is not a recognizable key format',t=>{
 const x=fixture(t);assert.throws(()=>x.owner.registerAccountSource(input(secret),actor,hash('OFFLINE_SECRET_LABEL')),{code:'CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID'});assert.equal(x.count('CustomAccountSourceRegistered'),0);
});

test('a selected value equal to public projection vocabulary is rejected before commit',t=>{
 for(const selected of ['SELECTED_UNVERIFIED','dream-maker.registered-account-source.v1']){
  const x=fixture(t);x.owner.context.getSecret=()=>selected;
  assert.throws(()=>x.owner.registerAccountSource(input(),actor,hash(selected)),{code:'CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID'});
  assert.equal(x.count('CustomAccountSourceRegistered'),0);assert.equal(x.count('CustomAccountSourceSelection'),0);
 }
});

test('labels cannot store or expose the selected environment identifier',t=>{
 const x=fixture(t);for(const label of [x.h.config.dsh.keyEnv,'我的 '+x.h.config.dsh.keyEnv.toLowerCase()]){
  assert.throws(()=>x.owner.registerAccountSource(input(label),actor,hash(label)),{code:'CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID'});
 }
 assert.equal(x.count('CustomAccountSourceRegistered'),0);
});

test('configured identifiers colliding with fixed public or stored vocabulary fail closed',t=>{
 for(const name of ['SELECTED_UNVERIFIED','accountVerified','createdAt']){const x=fixture(t);x.h.config.dsh.keyEnv=name;
  assert.throws(()=>x.owner.registerAccountSource(input(),actor,hash(name)),{code:'CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID'});
  assert.equal(x.count('CustomAccountSourceRegistered'),0);assert.equal(x.count('CustomAccountSourceSelection'),0);
 }
});

test('persisted reference fields must be strings, never coercible arrays',t=>{
 for(const field of ['id','authRef','accountRef']){const x=fixture(t);x.owner.registerAccountSource(input(),actor,hash(field));
  const {contentHash,...body}=JSON.parse(x.h.store.db.prepare("SELECT data FROM records WHERE kind='CustomAccountSourceRegistered'").get().data);body[field]=[body[field]];
  x.h.store.db.prepare("UPDATE records SET data=? WHERE kind='CustomAccountSourceRegistered'").run(JSON.stringify({...body,contentHash:hash(body)}));
  assert.throws(()=>x.owner.registeredAccountSources(),{code:'CUSTOM_ACCOUNT_SOURCE_INTEGRITY'});
 }
});
test('missing or unreadable values do not turn a saved reference into a verified account',t=>{
 for(const options of [{missing:true},{unavailable:true}]){const x=fixture(t,options),s=x.owner.registerAccountSource(input(),actor,hash(JSON.stringify(options)));assert.equal(s.accountVerified,false);assert.equal(s.modelVerified,false);assert.equal(s.status,'SELECTED_UNVERIFIED');}
});
test('invalid session identity and reference drift are rejected before a source can be stored',t=>{
 const x=fixture(t);assert.throws(()=>x.owner.registerAccountSource(input(),'not-a-session',hash('OFFLINE_ACTOR')),{code:'CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID'});assert.deepEqual(x.reads,[]);
 const y=fixture(t,{drift:true});assert.throws(()=>y.owner.registerAccountSource(input(),actor,hash('OFFLINE_DRIFT')),{code:'CUSTOM_ACCOUNT_SOURCE_STALE'});assert.equal(y.count('CustomAccountSourceRegistered'),0);
});
test('malformed persisted metadata fails closed without returning raw database text',t=>{
 const x=fixture(t);x.owner.registerAccountSource(input(),actor,hash('OFFLINE_CORRUPT'));x.h.store.db.prepare("UPDATE records SET data=? WHERE kind='CustomAccountSourceRegistered'").run('{bad');assert.throws(()=>x.owner.registeredAccountSources(),{code:'CUSTOM_ACCOUNT_SOURCE_INTEGRITY'});
});

test('a malformed selection receipt fails with an integrity error and cannot duplicate a registration',t=>{
 const x=fixture(t),op=hash('OFFLINE_CORRUPT_RECEIPT');x.owner.registerAccountSource(input(),actor,op);
 x.h.store.db.prepare("UPDATE records SET data=? WHERE kind='CustomAccountSourceSelection'").run('{broken');
 assert.throws(()=>x.owner.registerAccountSource(input(),actor,op),{code:'CUSTOM_ACCOUNT_SOURCE_INTEGRITY'});
 assert.equal(x.count('CustomAccountSourceRegistered'),1);assert.equal(x.count('CustomAccountSourceSelection'),1);
});

test('a receipt with a self-consistent hash but invalid metadata cannot authorize a replay',t=>{
 const x=fixture(t),op=hash('OFFLINE_BAD_RECEIPT_FIELDS');x.owner.registerAccountSource(input(),actor,op);
 const row=x.h.store.db.prepare("SELECT data FROM records WHERE kind='CustomAccountSourceSelection'").get(),{contentHash,...body}=JSON.parse(row.data);body.createdAt='not-a-time';
 x.h.store.db.prepare("UPDATE records SET data=? WHERE kind='CustomAccountSourceSelection'").run(JSON.stringify({...body,contentHash:hash(body)}));
 assert.throws(()=>x.owner.registerAccountSource(input(),actor,op),{code:'CUSTOM_ACCOUNT_SOURCE_INTEGRITY'});
});

test('an existing mixed-case DSH credential reference works without renaming or ambient discovery',t=>{
 const x=fixture(t);x.h.config.dsh.keyEnv='Dream_Maker_dsh';
 assert.equal(x.owner.registeredAccountSources().choices.length,1);assert.deepEqual(x.reads,[]);
 const saved=x.owner.registerAccountSource(input(),actor,hash('OFFLINE_MIXED_CASE'));
 assert.equal(saved.accountVerified,false);assert.deepEqual(x.reads,['Dream_Maker_dsh']);
 const text=JSON.stringify(x.h.store.db.prepare('SELECT data FROM records').all());assert.equal(text.includes('Dream_Maker_dsh'),false);assert.equal(text.includes(secret),false);
});
test('a saved source feeds the original frozen-profile availability path without editing the operator',async t=>{
 const x=fixture(t,{withOperator:true}),source=x.owner.registerAccountSource(input(),actor,hash('OFFLINE_PROFILE_SOURCE')),{p,s}=await ready(x.h);
 const role=(id,write=false)=>({id,provider:source.provider,authentication:source.authentication,authRef:source.authRef,accountRef:source.accountRef,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const configuration={mode:'custom',laya:false,accounts:[{provider:source.provider,authentication:source.authentication,authRef:source.authRef,accountRef:source.accountRef}],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const profile=new FlowProfiles(x.h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_REGISTERED_PROFILE'),prepared=x.h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash),body={projectId:p.id,specHash:s.hash,profileHash:profile.contentHash,preparation:{identityHash:prepared.identityHash,contentHash:prepared.contentHash}},view=x.owner.inspectCustomAccountSources(body);
 assert.equal(view.accounts[0].status,'AVAILABLE_UNVERIFIED');assert.match(view.sourceBindingHash,/^[a-f0-9]{64}$/);assert.equal(view.sourceManifestHash,null);assert.equal(view.accountVerified,false);assert.equal(x.owner.budget.requests().length,0);assert.equal(x.h.store.runs(p.id).length,0);
 x.h.config.dsh.keyEnv='DM_CUSTOM_RELOCATED_API_KEY';const next=x.h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash),before=x.reads.length;assert.throws(()=>x.owner.inspectCustomAccountSources({...body,preparation:{identityHash:next.identityHash,contentHash:next.contentHash}}),{code:'CUSTOM_ACCOUNT_SOURCE_STALE'});assert.equal(x.reads.length,before);
});

test('an unused legacy source for the same credential does not block the registered reference',async t=>{
 const x=fixture(t,{withOperator:true});x.h.config.dsh.keyEnv='Dream_Maker_dsh';const source=x.owner.registerAccountSource(input(),actor,hash('OFFLINE_LEGACY_SOURCE')),{p,s}=await ready(x.h);
 const sourcePath=join(x.h.dir,'legacy-sources.json'),bytes=JSON.stringify({schema:'dream-maker.custom-account-sources.v1',accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'LEGACY_AUTH',accountRef:'LEGACY_ACCOUNT',secretEnv:x.h.config.dsh.keyEnv}]});writeFileSync(sourcePath,bytes);
 const operatorPath=join(x.h.dir,'config/native-owner.local.json'),op=JSON.parse(readFileSync(operatorPath,'utf8'));op.customAccountSources={path:sourcePath,sha256:hash(bytes)};await x.owner.close();writeFileSync(operatorPath,JSON.stringify(op));const owner=x.reopen();
 const role=(id,write=false)=>({id,provider:source.provider,authentication:source.authentication,authRef:source.authRef,accountRef:source.accountRef,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const configuration={mode:'custom',laya:false,accounts:[{provider:source.provider,authentication:source.authentication,authRef:source.authRef,accountRef:source.accountRef}],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const profile=new FlowProfiles(x.h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_LEGACY_PROFILE'),prepared=x.h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);
 const result=owner.inspectCustomAccountSources({projectId:p.id,specHash:s.hash,profileHash:profile.contentHash,preparation:{identityHash:prepared.identityHash,contentHash:prepared.contentHash}});
 assert.equal(result.accounts[0].status,'AVAILABLE_UNVERIFIED');assert.equal(result.accounts[0].authRef,source.authRef);assert.equal(result.executionGranted,false);
 const reads=x.reads.length;configuration.accounts.push({provider:'deepseek-official',authentication:'api_key',authRef:'LEGACY_AUTH',accountRef:'LEGACY_ACCOUNT'});configuration.roles.executors[0].authRef='LEGACY_AUTH';configuration.roles.executors[0].accountRef='LEGACY_ACCOUNT';
 const next=new FlowProfiles(x.h.store).confirm(p.id,{configuration,expectedRevision:1,confirmed:true},actor,'OFFLINE_TWO_SELECTED_ALIASES'),two=x.h.engine.prepareCustomFlow(p.id,s.hash,next.contentHash);
 assert.throws(()=>owner.inspectCustomAccountSources({projectId:p.id,specHash:s.hash,profileHash:next.contentHash,preparation:{identityHash:two.identityHash,contentHash:two.contentHash}}),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});assert.equal(x.reads.length,reads);
});
