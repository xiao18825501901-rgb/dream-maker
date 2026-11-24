import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {computeSdkBuildHash} from '../../dist/server/siwc/sdk-integrity.js';
import {inspectPinnedCheckout} from '../../dist/server/siwc/sdk-loader.js';
import {ModelProvider} from '../../dist/server/providers/model.js';
import {defaults} from '../../dist/server/config.js';
import {Store} from '../../dist/server/store.js';
import {Interviews} from '../../dist/server/interview.js';
import {LayaBridge} from '../../dist/server/laya.js';
import {createApp} from '../../dist/server/http.js';
import {root} from '../helpers.mjs';
import {randomUUID} from 'node:crypto';
const testTemp=resolve(root,'.runtime/siwc-test-temp');mkdirSync(testTemp,{recursive:true});

function buildDir(t){const base=mkdtempSync(join(testTemp,'siwc-integrity-')),dir=join(base,'dist');mkdirSync(dir);writeFileSync(join(dir,'index.js'),'export const example=true;\n');writeFileSync(join(dir,'index.d.ts'),'export declare const example:boolean;\n');t.after(()=>rmSync(base,{recursive:true,force:true}));return dir;}
test('C01 SDK compiled tree identity is deterministic and changes on edited JS',t=>{const dir=buildDir(t),a=computeSdkBuildHash(dir);assert.match(a.sha256,/^[a-f0-9]{64}$/);assert.equal(a.files,2);assert.deepEqual(computeSdkBuildHash(dir),a);writeFileSync(join(dir,'index.js'),'export const example=false;\n');assert.notEqual(computeSdkBuildHash(dir).sha256,a.sha256);});
test('C02 SDK compiled tree rejects symlinks, special files and missing entry',t=>{const dir=buildDir(t);const target=process.platform==='win32'?join(dirname(dir),'junction-target'):join(dir,'index.js');if(process.platform==='win32')mkdirSync(target);symlinkSync(target,join(dir,'redirect.js'),process.platform==='win32'?'junction':'file');assert.throws(()=>computeSdkBuildHash(dir),/SIWC_BUILD_SPECIAL_FILE_DENIED/);rmSync(join(dir,'redirect.js'));rmSync(join(dir,'index.d.ts'));assert.throws(()=>computeSdkBuildHash(dir),/SIWC_BUILD_ENTRY_MISSING/);});
test('C03 a hash by itself is not enough; SDK must have the exact official source commit',t=>{const dir=buildDir(t),sha=computeSdkBuildHash(dir).sha256;assert.equal(inspectPinnedCheckout(dir,sha).status,'UNAVAILABLE');assert.equal(inspectPinnedCheckout(dir,'0'.repeat(64)).status,'UNAVAILABLE');assert.equal(inspectPinnedCheckout(dir,'').status,'UNAVAILABLE');});
test('C04 planner1 in-flight counter returns to zero on success or rejection',async()=>{const c=structuredClone(defaults);c.planner1.authMode='siwc_plan';let done;const api=new ModelProvider(()=>c,root,undefined,undefined,{complete:()=>new Promise(resolve=>{done=resolve;})});const p=api.complete({task:'question'});assert.equal(api.activeCalls,1);done({data:{text:'yes'},usage:{role:'planner1',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN',requestId:'test'}});await p;assert.equal(api.activeCalls,0);const bad=new ModelProvider(()=>c,root,undefined,undefined,{complete:()=>Promise.reject(new Error('stubbed'))});await assert.rejects(bad.complete({task:'question'}));assert.equal(bad.activeCalls,0);});
test('C05 ARCHIVED BY K02 (dual-mode planner1 switching removed): HTTP blocks changing planner1 mode during model request without changing DSH or Laya',{skip:'ARCHIVED_BY_K02: planner1 OpenAI/SIWC selection is retired; replacement assertions live in tests/kimi-p1-binding.test.mjs (K02-01..K02-10)'},async t=>{
 const dir=mkdtempSync(join(testTemp,'siwc-race-'));let app;const oldKey=process.env.OPENAI_API_KEY,oldFetch=global.fetch,nativeFetch=global.fetch;process.env.OPENAI_API_KEY='SYNTHETIC_FIXTURE_NOT_REAL_CREDENTIAL';t.after(async()=>{global.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;if(app)await app.close();rmSync(dir,{recursive:true,force:true});});
 app=await createApp({root,data:dir,configPath:join(dir,'config.json'),port:0,paidRequestGuard:()=>({settle(){}})});let cookie='',csrf='';
 async function req(route,method='GET',input){const res=await nativeFetch(app.origin+'/api'+route,{method,headers:{...(cookie?{cookie}:{}),...(method==='GET'?{}:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':randomUUID()})},body:input===undefined?undefined:JSON.stringify(input)});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')};}
 const login=await req('/session','POST',{bootstrap:app.bootstrap});assert.equal(login.status,200);cookie=login.cookie.split(';')[0];csrf=login.data.csrf;
 const originalConfig=(await req('/config')).data.config;const configured=await req('/config','PUT',{planner1:{authMode:'api_key',protocol:originalConfig.planner1.protocol,model:'local-fake-test-model'}});assert.equal(configured.status,200);
 const newProj=await req('/projects','POST',{name:'Race check',idea:'test model call',mode:'live',apiConsent:true});assert.equal(newProj.status,200);const id=newProj.data.project.id;
 let started;const startedPromise=new Promise(r=>{started=r;});let finish;const finishPromise=new Promise(r=>{finish=r;});let remoteCalls=0;
 global.fetch=async(url,opts)=>{if(String(url).startsWith('https://api.openai.com/v1/responses')){remoteCalls++;started();await finishPromise;return Response.json({status:'completed',id:'response_stub',model:'local-fake-test-model',output:[{content:[{type:'output_text',text:JSON.stringify({topic:'test',text:'What should the first version do?',suggestion:'Use a small example',prerequisites:[]})}]}],usage:{input_tokens:5,output_tokens:5}});}throw Error('unexpected_external_call');};
 const nextPromise=req('/projects/'+id+'/next','POST',{});await Promise.race([startedPromise,new Promise((_,reject)=>setTimeout(()=>reject(Error('fake upstream was never called')),2500))]);
 const conf=await req('/config');assert.equal(conf.status,200);const config=conf.data.config;
 const change=await req('/config','PUT',{planner1:{authMode:'siwc_plan',protocol:config.planner1.protocol,model:config.planner1.model}});
 assert.equal(change.status,409);assert.equal(change.data.error,'STOP_RUNS_AND_PLANNER1_BEFORE_CONFIG_CHANGE');
 assert.equal((await req('/config')).data.config.planner1.authMode,'api_key');
 const switchAttempt=await req('/planner1/siwc/select','POST',{profileId:'abc'});assert.equal(switchAttempt.status,409);
 finish();const complete=await nextPromise;assert.equal(complete.status,200);assert.equal(remoteCalls,1);assert.equal(complete.data.project.questions.length,1);
 const after=await req('/config');assert.equal(after.data.config.dsh.model,'deepseek-flash');assert.equal(after.data.config.laya.mode,'off');
});
test('C06 ARCHIVED BY K02 (replaced by K02-10 under the Kimi binding): failed model calls persist code only, not upstream body or secret',{skip:'ARCHIVED_BY_K02: planner1 OpenAI/SIWC selection is retired; replacement assertions live in tests/kimi-p1-binding.test.mjs (K02-01..K02-10)'},async t=>{
 const dir=mkdtempSync(join(testTemp,'siwc-fail-record-'));const store=new Store(join(dir,'test.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const c=structuredClone(defaults);c.planner1.authMode='siwc_plan';const rejected={code:'subscription_sharing_usage_limit_exceeded',message:'Bearer secret-do-not-log'};
 const fake={complete:()=>Promise.reject(rejected)};const laya=new LayaBridge(()=>c);const interviews=new Interviews(store,fake,laya,()=>c);const p=interviews.create('Sample','Describe a simple app','live');await assert.rejects(interviews.next(p.id));const records=store.records(p.id,'ModelAttemptFailure');assert.equal(records.length,1);assert.equal(records[0].data.code,'subscription_sharing_usage_limit_exceeded');assert.doesNotMatch(JSON.stringify(records),/Bearer|secret-do-not-log/);
});

test('C07 ARCHIVED BY K02 (SIWC consent path retired): Live SIWC uses a separate explicit plan-consent flag, not paid API consent',{skip:'ARCHIVED_BY_K02: planner1 OpenAI/SIWC selection is retired; replacement assertions live in tests/kimi-p1-binding.test.mjs (K02-01..K02-10)'},async t=>{
 const dir=mkdtempSync(join(testTemp,'siwc-consent-'));let app; t.after(async()=>{if(app)await app.close();rmSync(dir,{recursive:true,force:true});});
 app=await createApp({root,data:dir,configPath:join(dir,'config.json'),port:0});const nativeFetch=global.fetch;let csrf='',cookie='';
 async function call(route,method='GET',body){const res=await nativeFetch(app.origin+'/api'+route,{method,headers:{...(cookie?{cookie}:{}),...(method==='GET'?{}:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':randomUUID()})},body:body===undefined?undefined:JSON.stringify(body)});return{status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')};}
 let x=await call('/session','POST',{bootstrap:app.bootstrap});assert.equal(x.status,200);csrf=x.data.csrf;cookie=x.cookie.split(';')[0];
 x=await call('/config');assert.equal(x.data.config.planner1.authMode,'api_key');
 let p=await call('/projects','POST',{name:'Consent A',idea:'An idea',mode:'live',siwcPlanConsent:true});assert.equal(p.status,403);assert.equal(p.data.error,'API_SPEND_CONSENT_REQUIRED');
 p=await call('/projects','POST',{name:'Consent B',idea:'An idea',mode:'live',apiConsent:true});assert.equal(p.status,200);
 x=await call('/config','PUT',{planner1:{authMode:'siwc_plan',protocol:'openai-responses',model:''}});assert.equal(x.status,200);
 p=await call('/projects','POST',{name:'Consent C',idea:'An idea',mode:'live',apiConsent:true});assert.equal(p.status,403);assert.equal(p.data.error,'SIWC_PLAN_USAGE_CONSENT_REQUIRED');
 p=await call('/projects','POST',{name:'Consent D',idea:'An idea',mode:'live',siwcPlanConsent:true});assert.equal(p.status,200);
});

test('C08 ARCHIVED BY K02 (replaced by K02-08 frozen-binding contract): Live projects freeze their original planner1 billing mode, including legacy default',{skip:'ARCHIVED_BY_K02: planner1 OpenAI/SIWC selection is retired; replacement assertions live in tests/kimi-p1-binding.test.mjs (K02-01..K02-10)'},async t=>{
 const dir=mkdtempSync(join(testTemp,'siwc-project-mode-'));const store=new Store(join(dir,'test.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const conf=structuredClone(defaults),calls=[];
 const fake={complete:()=>{calls.push('called');return Promise.resolve({data:{},usage:{role:'planner1',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN',requestId:'fixture'}});}};
 const i=new Interviews(store,fake,new LayaBridge(()=>conf),()=>conf);
 const p1=i.create('API project','A simple test idea','live');assert.equal(p1.planner1AuthMode,'api_key');
 conf.planner1.authMode='siwc_plan';await assert.rejects(i.next(p1.id),{code:'PROJECT_PLANNER1_MODE_MISMATCH'});assert.equal(calls.length,0);
 const p2=i.create('SIWC project','A simple test idea','live');assert.equal(p2.planner1AuthMode,'siwc_plan');
 conf.planner1.authMode='api_key';await assert.rejects(i.next(p2.id),{code:'PROJECT_PLANNER1_MODE_MISMATCH'});assert.equal(calls.length,0);
 const p3=i.create('Legacy project','A simple test idea','live');delete p3.planner1AuthMode;store.saveProject(p3);
 conf.planner1.authMode='siwc_plan';await assert.rejects(i.next(p3.id),{code:'PROJECT_PLANNER1_MODE_MISMATCH'});assert.equal(calls.length,0);
 assert.equal(store.records(p1.id,'ModelAttempt').length,0);assert.equal(store.records(p2.id,'ModelAttempt').length,0);
});

test('C09 local project page visibly warns when global provider differs from frozen Live mode', async()=>{
 const {shell}=await import('../../dist/web/views.js');const config=structuredClone(defaults);config.planner1.authMode='siwc_plan';
 const p={id:'project-test',name:'Existing API project',idea:'Some idea',mode:'live',version:1,state:'INTERVIEWING',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),questions:[],answers:[],answerHistory:[],batchTarget:10,specId:null,activeRunId:null,warnings:[],planner1AuthMode:'api_key'};
 const v={mode:'local',screen:'project',projects:[p],snapshot:{project:p,spec:null,runs:[],records:[]},settings:{config,keyStatus:{planner1:false,executor:false},nativeStatus:'NOT_VERIFIED'},tab:'work',busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:40,draft:()=>'',hasDraft:()=>false};
 assert.match(shell(v),/创建时的 planner1 模式/);config.planner1.authMode='api_key';assert.doesNotMatch(shell(v),/创建时的 planner1 模式/);
});

test('C10 SIWC account coordinator marks a pending OAuth attempt busy until settled',async()=>{
 let fail,started;const began=new Promise(r=>started=r),pending=new Promise((_,reject)=>fail=reject);
 const fake={async signIn(){started();return pending;},cancelSignIn(){fail({code:'cancelled'});},async getSession(){return{status:'disconnected',sharing:false};},async listProfiles(){return[];},async selectProfile(){throw Error('unexpected');},async listModels(){return[];},subscribe(){return()=>{};},async disconnect(){},async streamResponse(){throw Error('unexpected');}};
 const {SiwcAccountService}=await import('../../dist/server/siwc/account-service.js');
 const s=new SiwcAccountService(async()=>fake,{getConfig:()=>({authMode:'siwc_plan',siwcNoncommercialAttested:true,siwcModel:'',siwcProfileId:''}),sdkPresent:()=>true,encryptionReady:async()=>true});
 const attempt=await s.connect({newProfile:true});assert.equal(attempt.state,'AUTHORIZING');await began;assert.equal(s.isBusy,true);
 await s.cancel();for(let i=0;i<50&&s.isBusy;i++)await new Promise(r=>setTimeout(r,2));assert.equal(s.isBusy,false);assert.equal((await s.status()).attempts.state,'CANCELLED');
});
