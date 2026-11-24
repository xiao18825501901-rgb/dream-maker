import test from 'node:test';import assert from 'node:assert/strict';
import {SiwcAccountService} from '../../dist/server/siwc/account-service.js';
import {SiwcPlanner1Provider} from '../../dist/server/siwc/planner1-provider.js';
import {safeFailure,errorState} from '../../dist/server/siwc/errors.js';
import {createWindowsCredentialEncryption} from '../../dist/server/siwc/windows-credential-encryption.js';
import {inspectPinnedCheckout,PINNED_COMMIT} from '../../dist/server/siwc/sdk-loader.js';
import {ModelProvider} from '../../dist/server/providers/model.js';
import {defaults,parseConfig} from '../../dist/server/config.js';
import {root} from '../helpers.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class MockClient{
 constructor(){this.session={status:'disconnected',sharing:false};this.profiles=[{id:'profile-1',label:'Private workspace',status:'connected',sharing:true},{id:'profile-2',label:'Another workspace',status:'connected',sharing:true}];this.count=0;this.failure='';this.mode='complete';this.abortSeen=false;this.requested=[];}
 async signIn(o){this.count++;this.session={status:'connected',sharing:true,profileId:o.profileId||'profile-1',profileLabel:'Private workspace'};return this.session;}
 cancelSignIn(){this.abortSeen=true;}
 async getSession(){return structuredClone(this.session);}
 async listProfiles(){return structuredClone(this.profiles);}
 async selectProfile(id){this.session={status:'connected',sharing:true,profileId:id,profileLabel:id};return this.session;}
 subscribe(){return()=>{};}
 async listModels(){return[{slug:'test-model',displayName:'Mock synthetic model'},{slug:'test-2',displayName:'Mock model 2'}];}
 async disconnect(){this.session={status:'disconnected',sharing:false};}
 async streamResponse(o){this.requested.push(o);o.onDelta?.('{"topic":');await sleep(1);if(this.failure)throw{code:this.failure,status:this.failure.includes('limit')?429:403,message:'do-not-log-user-content bearer=STOLEN'};if(this.mode==='incomplete')throw{code:'response_incomplete',status:502,message:'partial content in error'};if(this.mode==='wait'){await new Promise((res,rej)=>{o.signal.addEventListener('abort',()=>rej({code:'cancelled'}),{once:true});});}
 o.onDelta?.('"value"}');return {text:'{"topic":"value","text":"Question?","suggestion":"","prerequisites":[]}'};}
}
function rig(overrides={}){const config=structuredClone(defaults);config.planner1.authMode='siwc_plan';config.planner1.siwcNoncommercialAttested=true;let client=new MockClient();let sdkCalls=0;const s=new SiwcAccountService(async()=>{sdkCalls++;return client;},{getConfig:()=>config.planner1,sdkPresent:()=>true,encryptionReady:async()=>true,onProfileActivated:id=>{config.planner1.siwcProfileId=id;config.planner1.siwcModel='';},...overrides});return{s,client,config,sdkCalls:()=>sdkCalls};}
async function connected(r){const x=await r.s.connect({newProfile:true});assert.match(x.id,/^[\da-f-]{36}$/);for(let i=0;i<100;i++){const st=await r.s.status();if(st.attempts.state==='SUCCEEDED')return st;await sleep(3);}throw Error('mock auth completion timeout');}
async function selected(r){await connected(r);await r.s.models();const chosen=await r.s.ensureCatalogAndSelection('test-model');r.config.planner1.siwcModel=chosen.slug;return chosen;}
test('S01 pinned commit and optional checkout: never auto-install public private workspace',()=>{assert.equal(PINNED_COMMIT,'0a36fefeb913055c8c7a1a29b63d82b96b2e841a');assert.equal(inspectPinnedCheckout('/__unavailable__').status,'UNAVAILABLE');});
test('S02 legacy config defaults preserve paid API mode and old config',()=>{const v=structuredClone(defaults);delete v.planner1.authMode;delete v.planner1.siwcModel;delete v.planner1.siwcProfileId;delete v.planner1.siwcNoncommercialAttested;const c=parseConfig(v);assert.equal(c.planner1.authMode,'api_key');assert.equal(c.planner1.keyEnv,'OPENAI_API_KEY');assert.equal(c.dsh.model,'deepseek-flash');assert.equal(c.planner1.siwcModel,'');});
test('S03 status is split into legal, sharing, catalog and completed inference',async()=>{const r=rig();let st=await r.s.status();assert.equal(st.legal.commercialUseAllowed,false);assert.equal(st.state,'DISCONNECTED');assert.equal(st.model.inference,'NOT_RUN');st=await connected(r);assert.equal(st.session.sharing,true);assert.equal(st.state,'SHARING_ENABLED');assert.equal(st.model.inference,'NOT_RUN');await r.s.models();st=await r.s.status();assert.equal(st.model.discovery,'AVAILABLE');assert.equal(st.model.inference,'NOT_RUN');});
test('S04 missing permission does not infer even if signed in',async()=>{const r=rig();r.client.session={status:'connected',sharing:false,profileId:'profile-1'};r.config.planner1.siwcProfileId='profile-1';await assert.rejects(r.s.infer('{}','instruction',new AbortController().signal),{code:'SIWC_SCOPE_NOT_GRANTED'});assert.equal(r.client.requested.length,0);assert.equal(r.sdkCalls(),1);});
test('S05 no license attestation blocks even a fake OAuth run',async()=>{const r=rig();r.config.planner1.siwcNoncommercialAttested=false;await assert.rejects(r.s.connect({}),{code:'SIWC_NONCOMMERCIAL_ATTESTATION_REQUIRED'});assert.equal(r.sdkCalls(),0);});
test('S06 missing OS encryption blocks before browser / token storage',async()=>{const r=rig({encryptionReady:async()=>false});await assert.rejects(r.s.connect({}),{code:'SIWC_OS_ENCRYPTION_UNAVAILABLE'});assert.equal(r.sdkCalls(),0);});
test('S07 missing or wrong model cannot invoke inference',async()=>{const r=rig();await connected(r);await assert.rejects(r.s.infer('{}','',new AbortController().signal),{code:'SIWC_MODEL_NOT_SELECTED_OR_STALE'});await r.s.models();await assert.rejects(r.s.ensureCatalogAndSelection('not-in-list'),{code:'SIWC_MODEL_NOT_IN_CATALOG'});});
test('S08 streamed output commits only after mock completion and keeps UNKNOWN billing',async()=>{const r=rig();await selected(r);const deltas=[];const p=new SiwcPlanner1Provider(r.s);const res=await p.complete({task:'question',answers:[]},'mock instruction',new AbortController().signal,t=>deltas.push(t));assert.equal(res.data.text,'Question?');assert.equal(res.usage.inputTokens,null);assert.equal(res.usage.costUsd,null);assert.equal(deltas.length,2);const req=r.client.requested[0];assert.equal(req.model,'test-model');assert.equal(req.instructions,'mock instruction');assert.deepEqual(req.input,[{role:'user',content:'{"task":"question","answers":[]}'}]);assert.equal((await r.s.status()).model.inference,'INFERENCE_VERIFIED');});
test('S09 incomplete stream with partial tokens never creates accepted JSON output',async()=>{const r=rig();await selected(r);r.client.mode='incomplete';const p=new SiwcPlanner1Provider(r.s);await assert.rejects(p.complete({task:'question'},'safe',new AbortController().signal),{code:'response_incomplete'});assert.equal((await r.s.status()).model.inference,'NOT_RUN');});
test('S10 subscription limit blocks only plan, never invokes paid API path',async()=>{const r=rig();await selected(r);r.client.failure='subscription_sharing_usage_limit_exceeded';await assert.rejects(r.s.infer('{}','',new AbortController().signal),e=>e.code==='subscription_sharing_usage_limit_exceeded');assert.equal((await r.s.status()).state,'LIMIT_EXCEEDED');assert.equal(r.config.planner1.authMode,'siwc_plan');});
test('S11 different account invalidates model catalog and in-flight request',async()=>{const r=rig();await selected(r);await r.s.selectProfile('profile-2');assert.equal(r.config.planner1.siwcModel,'');await assert.rejects(r.s.infer('{}','',new AbortController().signal),{code:'SIWC_MODEL_NOT_SELECTED_OR_STALE'});await r.s.models();await r.s.ensureCatalogAndSelection('test-2');assert.equal(r.client.session.profileId,'profile-2');});
test('S12 saved profile only; no arbitrary profile selection',async()=>{const r=rig();await connected(r);await assert.rejects(r.s.selectProfile('../../other'),{code:'SIWC_PROFILE_ID_INVALID'});await assert.rejects(r.s.selectProfile('not-existing'),{code:'SIWC_PROFILE_NOT_FOUND'});});
test('S13 explicit disconnect does not claim remote revocation',async()=>{const r=rig();await selected(r);const value=await r.s.disconnect();assert.equal(value.localDisconnected,true);assert.equal(value.remoteRevocation,'NOT_CONFIRMED');assert.equal((await r.s.status()).model.inference,'NOT_RUN');});
test('S14 classified noneligible, usage, refresh, unsupported and unknown diagnostic values are redacted',()=>{for(const [code,state] of [['subscription_sharing_user_not_eligible','NOT_ELIGIBLE'],['subscription_sharing_usage_limit_exceeded','LIMIT_EXCEEDED'],['subscription_sharing_usage_unavailable','TEMPORARILY_UNAVAILABLE'],['invalid_refresh_token','REAUTH_REQUIRED'],['unsupported_country_region_territory','REGION_OR_POLICY_RESTRICTED']])assert.equal(errorState(code),state);const r=safeFailure({code:'subscription_sharing_user_not_eligible',message:'token=my-private-token',status:403,requestId:'req_safe-1',param:'input',secret:'do not leak'});assert.deepEqual(Object.keys(r).sort(),['code','param','requestId','retryable','status'].sort());assert.equal(JSON.stringify(r).includes('private'),false);});
test('S15 real Windows DPAPI adapter is unavailable under non-Windows test; no plaintext fallback',async()=>{const c=createWindowsCredentialEncryption({platform:'linux'});assert.equal(await c.isAvailable(),false);await assert.rejects(c.encrypt('synthetic-not-a-real-token'),/DPAPI_UNAVAILABLE/);await assert.rejects(c.decrypt(new Uint8Array([1,2])),/DPAPI_UNAVAILABLE/);});
test('S16 DPAPI interface can be exercised with synthetic runner; MOCK, not Windows proof',async()=>{const fake={encrypt:a=>Buffer.from([...a].map(x=>x^0x23)),decrypt:a=>Buffer.from([...a].map(x=>x^0x23))};const c=createWindowsCredentialEncryption({platform:'win32',runner:async(op,b)=>fake[op](b)});assert.equal(await c.isAvailable(),true);const encrypted=await c.encrypt('synthetic-credential');assert.equal(await c.decrypt(encrypted),'synthetic-credential');assert.equal(c.id,'windows-dpapi-current-user-v1');});
test('S17 paid API mode untouched: no SIWC client created if only API is called',async()=>{const r=rig();r.config.planner1.authMode='api_key';r.config.planner1.model='synthetic-api-model';r.config.planner1.protocol='chat-completions';r.config.planner1.baseUrl='https://api.deepseek.com';const model=new ModelProvider(()=>r.config,root,async()=>({id:'offline-chat-response',model:'synthetic-api-model',choices:[{message:{content:'{"topic":"ok"}'},finish_reason:'stop'}],usage:{prompt_tokens:9,completion_tokens:2}}),()=>({settle(){}}),new SiwcPlanner1Provider(r.s));const prev=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='synthetic-test-placeholder-not-a-token';try{const result=await model.complete({task:'question'});assert.equal(result.data.topic,'ok');assert.equal(r.sdkCalls(),0);}finally{if(prev===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prev;}});
test('S18 switching accounts aborts an in-flight plan-only response',async()=>{const r=rig();await selected(r);r.client.mode='wait';const pending=r.s.infer('{}','limited instruction',new AbortController().signal);await sleep(5);await r.s.selectProfile('profile-2');await assert.rejects(pending,e=>e.code==='cancelled'||e.code==='SIWC_RESULT_STALE_OR_ABORTED');assert.equal((await r.s.status()).model.inference,'NOT_RUN');assert.equal(r.config.planner1.siwcModel,'');});
test('S19 long deltas over explicit output limit abort and do not verify inference',async()=>{const r=rig();await selected(r);r.client.streamResponse=async o=>{o.onDelta?.('A'.repeat(24001));return{text:'{"topic":"ok"}'};};await assert.rejects(r.s.infer('{}','limit',new AbortController().signal),{code:'SIWC_RESULT_STALE_OR_ABORTED'});assert.equal((await r.s.status()).model.inference,'NOT_RUN');});
test('S20 unknown profile ID and pending registration cannot be selected',async()=>{const r=rig();await connected(r);r.client.profiles.push({id:'pending-one',label:'Incomplete registration',status:'disconnected',sharing:false,pending:true});await assert.rejects(r.s.selectProfile('pending-one'),{code:'SIWC_PROFILE_NOT_FOUND'});assert.equal(r.client.session.profileId,'profile-1');});

test('S21 encryption loss after previous session blocks inference without claiming current sharing',async()=>{let available=true;const r=rig({encryptionReady:async()=>available});await selected(r);available=false;const st=await r.s.status();assert.equal(st.state,'TEMPORARILY_UNAVAILABLE');assert.equal(st.session.sharing,false);await assert.rejects(r.s.infer('{}','safe',new AbortController().signal),{code:'SIWC_OS_ENCRYPTION_UNAVAILABLE'});assert.equal(r.client.requested.length,0);});

test('S22 concurrent authorization starts only one SDK sign-in, including async preparation',async()=>{
 const r=rig();let release;const wait=new Promise(resolve=>release=resolve);let calls=0;
 r.client.signIn=async()=>{calls++;await wait;return{status:'disconnected',sharing:false};};
 const first=r.s.connect({});
 await assert.rejects(r.s.connect({}),{code:'SIWC_OPERATION_BUSY'});
 await first;release();await sleep(5);assert.equal(calls,1);
});

test('S23 service shutdown cannot activate a profile from a late OAuth result',async()=>{
 let activated=0;const r=rig({onProfileActivated:()=>activated++});let release;
 r.client.signIn=()=>new Promise(resolve=>release=resolve);
 await r.s.connect({});await sleep(1);r.s.shutdown();
 release({status:'connected',sharing:true,profileId:'profile-1'});await sleep(5);
 assert.equal(activated,0);
});

test('S24 ignored OAuth cancellation reaches deadline without releasing uncertain native ownership',async()=>{
 const r=rig({authTimeoutMs:25});r.client.signIn=()=>new Promise(()=>{});
 await r.s.connect({});await sleep(60);assert.equal(r.s.isBusy,true);
 assert.equal((await r.s.status()).attempts.state,'FAILED');
 await assert.rejects(r.s.connect({}),{code:'SIWC_OPERATION_BUSY'});
});

test('S25 native sharing revocation clears selection evidence and aborts an in-flight response',async()=>{
 const r=rig();let notify;r.client.subscribe=listener=>{notify=listener;return()=>{};};
 await selected(r);r.client.mode='wait';const pending=r.s.infer('{}','safe',new AbortController().signal);
 await sleep(5);r.client.session={status:'connected',sharing:false,profileId:'profile-1'};notify(r.client.session);
 await assert.rejects(pending);assert.equal((await r.s.status()).model.inference,'NOT_RUN');
});

test('S26 a saved connected session is reused without starting another sign-in',async()=>{
 const r=rig();
 r.client.session={status:'connected',sharing:true,profileId:'profile-1',profileLabel:'Saved account'};
 r.config.planner1.siwcProfileId='profile-1';
 const status=await r.s.status();
 assert.equal(status.session.status,'connected');
 assert.equal(status.session.sharing,true);
 assert.equal(status.session.profileId,'profile-1');
 assert.equal(r.client.count,0);
});

test('S27 a transient status-read failure keeps the saved connection and never asks for a new sign-in',async()=>{
 const r=rig();
 await connected(r);
 const before=await r.s.status();
 assert.equal(before.session.status,'connected');
 const realGetSession=r.client.getSession.bind(r.client);
 let failNext=true;
 r.client.getSession=async()=>{
  if(failNext){failNext=false;throw{status:503,message:'transient encrypted store read failure'};}
  return realGetSession();
 };
 const transient=await r.s.status();
 assert.equal(transient.session.status,'connected');
 assert.notEqual(transient.state,'DISCONNECTED');
 assert.equal(transient.state,'TEMPORARILY_UNAVAILABLE');
 const recovered=await r.s.status();
 assert.equal(recovered.state,'SHARING_ENABLED');
});

test('S28 a status read failure on a fresh service with a saved profile does not demand re-login',async()=>{
 const r=rig();
 r.config.planner1.siwcProfileId='profile-1';
 r.client.getSession=async()=>{throw{status:503,message:'transient encrypted store read failure'};};
 const status=await r.s.status();
 assert.equal(status.state,'TEMPORARILY_UNAVAILABLE');
});
