// Actual localhost HTTP + SQLite, OFFLINE owner seam; no account or model.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {hash,DomainError} from '../../dist/server/security.js';import {root} from '../helpers.mjs';
import {magpieBlocksNative} from '../../dist/server/magpie-check.js';
async function fixture(t){
 const base=join(root,'.runtime/test-temp');mkdirSync(base,{recursive:true});const data=mkdtempSync(join(base,'account-recovery-http-'));let app,calls=0;
 const deny=()=>{throw Error('NO_MODELS');};app=await createApp({root,data,configPath:join(data,'local.json'),port:0,product:'dreamflow',nativeOwnerBuilder:c=>({assertReady:deny,executor:deny,verify:deny,paidGuard:deny,stopRequests(){},close:async()=>{},describeCustomMagpieAccountCheck:input=>({flowConfigHash:app.engine.prepareCustomFlow(input.projectId,input.specHash,input.profileHash).flowConfigHash,sourceBindingHash:'f'.repeat(64)}),inspectCustomMagpieAccounts:async()=>{calls++;throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500,'PRIVATE_UNKNOWN');}})});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const session=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();
 const p=app.interviews.create('核清本机交接','合成接口检查，不生成真实成果。','demo');await app.interviews.finish(p.id,'',false);const spec=app.store.spec(app.store.project(p.id).specId);app.interviews.approve(p.id,spec.hash);
 const a={provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE'},role=(id,write=false)=>({id,...a,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}}),configuration={mode:'custom',laya:false,accounts:[a],roles:{planner2:role('planner2'),executors:[role('worker',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const version=new FlowProfiles(app.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},'local-session:'+'a'.repeat(64),'OFFLINE_RECOVERY_PROFILE'),prep=app.engine.prepareCustomFlow(p.id,spec.hash,version.contentHash);
 const checkInput={specHash:spec.hash,profileHash:version.contentHash,preparation:{identityHash:prep.identityHash,contentHash:prep.contentHash},confirmed:true},path='/api/projects/'+p.id+'/flow-account-recovery';
 const call=async(method='GET',input,key=crypto.randomUUID(),headers={},target=path)=>{const r=await fetch(app.origin+target,{method,headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':key,...headers},...(method==='GET'?{}:{body:JSON.stringify(input)})});return{status:r.status,body:await r.json()};};
 const uncertain=()=>call('POST',checkInput,crypto.randomUUID(),{},'/api/projects/'+p.id+'/flow-account-check');
 return{app,p,path,call,uncertain,calls:()=>calls};
}
test('M13 recovery HTTP requires original authentication, CSRF, target and independent consent',async t=>{
 const x=await fixture(t);assert.equal((await fetch(x.app.origin+x.path)).status,401);
 const first=await x.call();assert.equal(first.status,200);assert.equal(first.body.status,'NOT_REQUIRED');
 await x.uncertain();const read=await x.call();assert.equal(read.body.status,'REQUIRED');assert.match(read.body.targetHash,/^[a-f0-9]{64}$/);
 const input={expectedTargetHash:read.body.targetHash,confirmed:true};assert.equal((await x.call('POST',input,undefined,{'x-csrf-token':'bad'})).status,403);
 assert.equal((await x.call('POST',{...input,confirmed:false})).status,403);assert.equal((await x.call('POST',{...input,pid:123})).status,400);assert.equal((await x.call('POST',{...input,expectedTargetHash:hash('STALE')})).status,409);
 assert.equal(x.calls(),1);assert.equal(magpieBlocksNative(x.app.store),true);assert.doesNotMatch(JSON.stringify(read),/PRIVATE|runtimeDirectory|secretEnv|processId|markerPath/);
});
test('M13 absent OS evidence stays uncertain and a forged cached receipt never clears it',async t=>{
 const x=await fixture(t);await x.uncertain();const target=(await x.call()).body,input={expectedTargetHash:target.targetHash,confirmed:true},key=crypto.randomUUID();
 const first=await x.call('POST',input,key);assert.equal(first.status,409);assert.equal(magpieBlocksNative(x.app.store),true);assert.equal(x.app.store.records(x.p.id,'MagpieAccountCheckRecovery').length,0);
 const requestKey='POST:'+x.path+':'+key;x.app.store.db.prepare('UPDATE requests SET status=?,response=? WHERE key=?').run('done',JSON.stringify({schema:'dream-maker.magpie-account-recovery-request.v1',projectId:x.p.id,targetHash:target.targetHash,resultHash:hash(target)}),requestKey);
 assert.equal((await x.call('POST',input,key)).status,409);assert.equal((await x.call()).body.status,'REQUIRED');assert.equal(x.calls(),1);assert.equal(x.app.store.runs(x.p.id).length,0);
});
