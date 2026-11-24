// OFFLINE coordination/signature tests. Invokers never call a model or sign a Live audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {harness} from './helpers.mjs';
const sha='a'.repeat(64),roles=['planner1','planner2','executor','reviewer'];
const binding=()=>({scopeId:'OFFLINE',authorizationHash:sha,sourceHash:sha,configurationHash:sha,expiresAt:new Date(Date.now()+60000).toISOString(),planner1Mode:'api_key',planner2Mode:'chatgpt_subscription',models:{planner1:'api-model',planner2:'codex-model',executor:'deepseek-flash',reviewer:'codex-model'}});
async function setup(t,override={}){
 const {NativeProbes}=await import('../dist/server/native-probes.js');
 const h=harness(t),key=randomBytes(32),current=binding();let count=0;
 const ledger=[{id:'paid-planner1',role:'planner1',price:{provider:'openai-official',model:'api-model'},usageStatus:'KNOWN',outcome:'RESPONSE_RECEIVED'},
 {id:'paid-executor',role:'executor',price:{provider:'deepseek-official',model:'deepseek-flash'},usageStatus:'UNKNOWN',outcome:'COMPLETE'}];
 const invoke=async(role,challenge,signal)=>{count++;return{role,model:current.models[role],runner:role==='planner1'?'LLM_API':role==='executor'?'DSH':'CODEX',
 provider:role==='executor'?'deepseek-official':role==='planner1'?'openai-official':'openai',authentication:role==='planner1'||role==='executor'?'API_KEY':'CHATGPT_SUBSCRIPTION',
 responseId:role+'-response',responseHash:sha,sessionId:role+'-session',accountFingerprint:sha,includedUsageAllowed:true,paidFallback:false,
 ledgerRequestIds:role==='planner1'?['paid-planner1']:role==='executor'?['paid-executor']:[],cleanupReturned:true,reply:challenge,...override};};
 const options={store:h.store,key,current:()=>current,ledger:()=>ledger,invoke};
 const probes=new NativeProbes(options);t.after(()=>probes.close());
 return{h,key,current,ledger,invoke,options,probes,count:()=>count,NativeProbes};
}

for(const domain of ['custom','engineering'])test('a '+domain+' paid request cannot be re-signed as a Classic minimum probe',async t=>{
 const x=await setup(t);if(domain==='custom')x.ledger[1].binding={engineeringMode:'custom'};else x.ledger[1].engineeringAcceptance={scope:'OFFLINE_ENGINEERING_ONLY'};
 await assert.rejects(x.probes.run('executor',new AbortController().signal),{code:'NATIVE_PROBE_ROUTE_SCOPE_MISMATCH'});assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeProbeReceipt'").get().n,0);
});
test('only an owned challenge completion creates a role-bound signed reference; restart caches it',async t=>{
 const x=await setup(t),ref=await x.probes.run('planner1',new AbortController().signal);
 assert.equal(x.probes.verify('planner1',ref),true);assert.equal(x.probes.verify('executor',ref),false);
 assert.equal(x.probes.verify('planner1',{...ref,evidenceId:'caller-label'}),false);
 const restored=new x.NativeProbes(x.options);t.after(()=>restored.close());
 assert.equal(restored.verify('planner1',ref),true);
 assert.deepEqual(await restored.run('planner1',new AbortController().signal),ref);assert.equal(x.count(),1);
});
test('read-only setup evidence exposes only verified identity fields, never nonce, account or configured guesses',async t=>{
 const x=await setup(t);await x.probes.run('planner2',new AbortController().signal);
 const evidence=x.probes.evidence();assert.equal(evidence.planner2.model,'codex-model');
 assert.deepEqual(Object.keys(evidence.planner2).sort(),['at','authentication','evidenceId','model','provider','runner']);
 x.current.models.planner2='changed-config';assert.equal(x.probes.evidence().planner2,undefined);
});
// probeExpiresAt is signed into every receipt and was never read: an expired receipt verified exactly like a
// fresh one, so the field was a claim the product did not keep. The audit expiry already works this way —
// stale evidence is re-taken, never silently extended.
test('a receipt stops verifying once the binding expiry has passed',async t=>{
 const x=await setup(t),ref=await x.probes.run('planner1',new AbortController().signal);
 assert.equal(x.probes.verify('planner1',ref),true);
 x.current.expiresAt=new Date(Date.now()-1000).toISOString();
 assert.equal(x.probes.verify('planner1',ref),false,'an expired binding invalidates the receipt');
 assert.deepEqual(x.probes.evidence(),{},'read-only setup does not expose stale evidence or fail the whole status page');
 x.current.expiresAt=new Date(Date.now()+60000).toISOString();
 assert.equal(x.probes.verify('planner1',ref),false,'the signed binding differs too, so it stays invalid');
});
test('an unparsable expiry fails closed instead of verifying',async t=>{
 const x=await setup(t),ref=await x.probes.run('planner1',new AbortController().signal);
 x.current.expiresAt='not-a-date';
 assert.equal(x.probes.verify('planner1',ref),false);
});

test('editing stored model data invalidates the signature without changing approval or ledger',async t=>{
 const x=await setup(t),ref=await x.probes.run('planner1',new AbortController().signal);
 x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.payload.observation.model','forged') WHERE id=?").run(ref.evidenceId);
 assert.equal(x.probes.verify('planner1',ref),false);
});
for(const [name,mutate] of [
 ['configuration',x=>x.current.configurationHash='b'.repeat(64)],
 ['source',x=>x.current.sourceHash='b'.repeat(64)],
 ['expiry',x=>x.current.expiresAt='2000-01-01T00:00:00Z'],
 ['missing paid request',x=>x.ledger.splice(0,1)],
 ['pending request',x=>x.ledger[0].usageStatus='PENDING'],
 ['foreign ledger role',x=>x.ledger[0].role='executor'],
 ['usage bound breach',x=>x.ledger[0].limitExceeded=true]
])test('cached proof is rejected after '+name+' change',async t=>{
 const x=await setup(t),ref=await x.probes.run('planner1',new AbortController().signal);mutate(x);
 assert.equal(x.probes.verify('planner1',ref),false);
});
test('over-bound paid usage cannot be sealed into a new minimum probe receipt',async t=>{
 const x=await setup(t);x.ledger[1].limitExceeded=true;
 await assert.rejects(x.probes.run('executor',new AbortController().signal),{code:'NATIVE_PROBE_LEDGER_UNVERIFIED'});
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeProbeReceipt'").get().n,0);
});
for(const [name,extra] of [
 ['wrong challenge',{reply:'model-self-evaluation-PASS'}],['no cleanup',{cleanupReturned:false}],
 ['wrong provider',{provider:'other-provider'}],['paid fallback',{paidFallback:true}],
 ['missing response',{responseId:''}],['wrong model',{model:'other-model'}]
])test('cannot seal '+name+' as a verified probe',async t=>{
 const x=await setup(t,extra);await assert.rejects(x.probes.run('planner1',new AbortController().signal));
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeProbeReceipt'").get().n,0);
});
test('all-four advancement enforces same model/account and distinct Codex sessions',async t=>{
 const x=await setup(t);let proofs;
 const budget={advance:refs=>{proofs=refs;}};
 await assert.rejects(x.probes.advance(budget));
 for(const role of roles)await x.probes.run(role,new AbortController().signal);
 await x.probes.advance(budget);assert.deepEqual(Object.keys(proofs),roles);
 assert.ok(roles.every(role=>x.probes.verify(role,proofs[role])));
 const same=await setup(t,{sessionId:'same-session'});
 for(const role of roles)await same.probes.run(role,new AbortController().signal);
 await assert.rejects(same.probes.advance(budget),{code:'NATIVE_PROBE_CODEX_SESSIONS_REUSED'});
});
test('engineering profile signs exactly three independent roles and cannot be reused as full DM',async t=>{
 const x=await setup(t);x.current.profile='ENGINEERING_ONLY';let received;
 await assert.rejects(x.probes.run('planner1',new AbortController().signal),{code:'NATIVE_ROLE_NOT_IN_PRODUCT'});
 assert.equal(x.count(),0);
 const refs={};for(const role of ['planner2','executor','reviewer'])refs[role]=await x.probes.run(role,new AbortController().signal);
 await x.probes.advance({advance:proofs=>{received=proofs;}});
 assert.deepEqual(Object.keys(received),['planner2','executor','reviewer']);assert.equal(x.count(),3);
 x.current.profile='FULL_DM';assert.equal(x.probes.verify('executor',refs.executor),false);
 await assert.rejects(x.probes.advance({advance:()=>assert.fail('must not advance')}),{code:'NATIVE_PROBE_MISSING'});
});

test('cancellation or changed binding during invocation prevents a receipt',async t=>{
 const x=await setup(t),abort=new AbortController();
 const p=new x.NativeProbes({...x.options,invoke:async(...args)=>{const out=await x.invoke(...args);abort.abort();return out;}});t.after(()=>p.close());
 await assert.rejects(p.run('planner1',abort.signal),{code:'RUN_CANCELLED'});
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeProbeReceipt'").get().n,0);
 const changed=new x.NativeProbes({...x.options,invoke:async(...args)=>{const out=await x.invoke(...args);x.current.sourceHash='c'.repeat(64);return out;}});t.after(()=>changed.close());
 await assert.rejects(changed.run('planner1',new AbortController().signal),{code:'NATIVE_PROBE_BINDING_CHANGED'});
});
const subscription=(challenge,override={})=>({role:'planner1',model:'kimi-code/kimi-for-coding',runner:'KIMI_SERVER',provider:'kimi-official',
 authentication:'MEMBER_SUBSCRIPTION',responseId:'turn_1',responseHash:sha,sessionId:'session_abc',accountFingerprint:sha,
 credentialGeneration:7,includedUsageAllowed:true,paidFallback:false,ledgerRequestIds:[],cleanupReturned:true,reply:challenge,...override});
async function subscriptionProbes(t,override={}){
 const x=await setup(t);x.current.planner1Mode='siwc_plan';x.current.models.planner1='kimi-code/kimi-for-coding';
 const probes=new x.NativeProbes({...x.options,invoke:async(role,challenge)=>subscription(challenge,override)});t.after(()=>probes.close());
 return{...x,probes};
}
test('a subscription planner1 is certified by its credential generation, not by a paid ledger entry',async t=>{
 const x=await subscriptionProbes(t),ref=await x.probes.run('planner1',new AbortController().signal);
 assert.equal(x.probes.verify('planner1',ref),true);
 const payload=x.h.store.db.prepare("SELECT data FROM records WHERE kind='NativeProbeReceipt'").get().data;
 assert.deepEqual(JSON.parse(payload).payload.observation.ledgerRequestIds,[]);
 assert.equal(JSON.parse(payload).payload.observation.credentialGeneration,7);
});
test('a subscription planner1 binding refuses a paid-shaped observation instead of reading it as proof',async t=>{
 const x=await subscriptionProbes(t,{runner:'LLM_API',provider:'openai-official',authentication:'API_KEY',ledgerRequestIds:['paid-planner1']});
 await assert.rejects(x.probes.run('planner1',new AbortController().signal),{code:'NATIVE_PROBE_SUBSCRIPTION_UNVERIFIED'});
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeProbeReceipt'").get().n,0);
});
for(const [name,extra] of [
 ['a reused paid ledger entry',{ledgerRequestIds:['paid-planner1']}],['a missing credential generation',{credentialGeneration:0}],
 ['a missing account fingerprint',{accountFingerprint:undefined}],['included usage not allowed',{includedUsageAllowed:false}],
 ['a non-subscription runner',{runner:'DSH'}]
])test('a subscription planner1 probe refuses '+name,async t=>{
 const x=await subscriptionProbes(t,extra);
 await assert.rejects(x.probes.run('planner1',new AbortController().signal),{code:'NATIVE_PROBE_SUBSCRIPTION_UNVERIFIED'});
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeProbeReceipt'").get().n,0);
});
test('an api_key planner1 binding still demands the paid OpenAI completion, not a subscription turn',async t=>{
 const x=await setup(t);
 // same model id, so the refusal is about the missing paid completion and not about the model name
 const probes=new x.NativeProbes({...x.options,invoke:async(role,challenge)=>subscription(challenge,{model:'api-model'})});t.after(()=>probes.close());
 await assert.rejects(probes.run('planner1',new AbortController().signal),{code:'NATIVE_PROBE_PAID_COMPLETION_UNVERIFIED'});
});
test('status reports which roles hold a verifying receipt without running anything',async t=>{
 const x=await setup(t);
 assert.deepEqual(Object.keys(x.probes.status()),roles);
 assert.ok(roles.every(r=>x.probes.status()[r].present===false));
 const ref=await x.probes.run('planner1',new AbortController().signal);
 const after=x.probes.status();
 assert.deepEqual(after.planner1,{present:true,valid:true});
 assert.deepEqual(after.executor,{present:false,valid:false});
 // A stale/failed verification shows as present-but-invalid rather than silently absent.
 x.current.configurationHash='b'.repeat(64);
 assert.deepEqual(x.probes.status().planner1,{present:true,valid:false});
 assert.equal(x.count(),1);
});
test('a signed Codex receipt invalidated by a binding change is not reported as absent',async t=>{
 const x=await setup(t);
 await x.probes.run('planner2',new AbortController().signal);
 x.current.sourceHash='b'.repeat(64);
 assert.throws(
   ()=>x.probes.codexAccountFingerprint('planner2'),
   {code:'NATIVE_PROBE_BINDING_CHANGED'},
 );
 assert.throws(
   ()=>x.probes.codexAccountFingerprint('reviewer'),
   {code:'NATIVE_PROBE_MISSING'},
 );
});
test('all-four advancement accepts a subscription planner1 next to the paid and Codex legs',async t=>{
 const x=await subscriptionProbes(t);let proofs;
 const probes=new x.NativeProbes({...x.options,invoke:async(role,challenge)=>role==='planner1'?subscription(challenge):await x.invoke(role,challenge)});t.after(()=>probes.close());
 for(const role of roles)await probes.run(role,new AbortController().signal);
 await probes.advance({advance:refs=>{proofs=refs;}});
 assert.deepEqual(Object.keys(proofs),roles);
 assert.ok(roles.every(role=>probes.verify(role,proofs[role])));
});
test('concurrent probe is refused and close waits for the cancelled owned invocation',async t=>{
 const x=await setup(t);let release,started;
 const begun=new Promise(resolve=>{started=resolve;}),done=new Promise(resolve=>{release=resolve;});
 const p=new x.NativeProbes({...x.options,invoke:async(...args)=>{started();await done;return x.invoke(...args);}});t.after(()=>p.close());
 const pending=p.run('planner2',new AbortController().signal);pending.catch(()=>{});await begun;
 await assert.rejects(p.run('reviewer',new AbortController().signal),{code:'NATIVE_PROBE_BUSY'});
 let closed=false;const closing=p.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
 release();await assert.rejects(pending,{code:'RUN_CANCELLED'});await closing;
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM records WHERE kind='NativeProbeReceipt'").get().n,0);
});
