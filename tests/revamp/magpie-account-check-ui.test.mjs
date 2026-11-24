// OFFLINE UI/controller protocol fixtures. No real account, process or model evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {CustomFlowWizard} from '../../dist/web/custom-flow-controller.js';import {serializeWizard} from '../../dist/web/custom-flow-state.js';import {UiError} from '../../dist/web/contracts.js';
const data=o=>({get:k=>o[k]??null}),specHash='b'.repeat(64),profileHash='a'.repeat(64);
function configuration(){const a={provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',label:'我的专用来源'},role=(id,write=false)=>({id,...a,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});for(const key of ['label'])delete a[key];return{mode:'custom',laya:false,accounts:[{...a,label:'我的专用来源'}],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};}
const version=()=>({schema:'dream-maker.custom-profile-version.v1',projectId:'p1',revision:1,parentHash:null,contentHash:profileHash,configuration:configuration(),scope:'CONFIGURATION_ONLY',serviceIdentity:'NOT_VERIFIED',executionGranted:false});
const preparation=()=>({preparation:{schema:'dream-maker.custom-flow-preparation.v1',projectId:'p1',identityHash:'c'.repeat(64),contentHash:'d'.repeat(64),flowConfigHash:'e'.repeat(64),createdAt:'2026-11-04T00:00:00.000Z',scope:'CONFIGURATION_PREPARATION_ONLY',executionGranted:false,flowConfig:{schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'p1',plan:{versionId:'spec_offline',revision:1,contentHash:'9'.repeat(64),specHash},profile:{revision:1,contentHash:profileHash},qualification:'NOT_VERIFIED'}},executionGranted:false});
const selection=()=>({projectId:'p1',specHash,profileHash,preparation:{identityHash:'c'.repeat(64),contentHash:'d'.repeat(64)}});
function view(status='PASSED'){return{schema:'dream-maker.magpie-account-check.v1',projectId:'p1',scope:'REGISTERED_MEMORY_TRANSFER_ONLY',historical:true,status,selection:status==='NOT_RUN'?null:selection(),flowConfigHash:status==='NOT_RUN'?null:'e'.repeat(64),sourceBindingHash:status==='PASSED'?'f'.repeat(64):null,checkedAt:status==='NOT_RUN'?null:'2026-11-04T00:00:00.000Z',accountCount:status==='PASSED'?1:null,processClosed:status==='NOT_RUN'?null:status==='PASSED',reason:status==='UNCERTAIN'?'CLEANUP_UNCERTAIN':null,accountVerified:false,modelVerified:false,customExecutionGranted:false};}
async function rig(extra={}){const calls=[],drafts=new Map(),html=[],errors=[];let saved=0;
 const request=async(path,method='GET',body)=>{calls.push({path,method,body});if(path.endsWith('/flow-profile'))return{current:path.includes('/p1/')?version():null};if(extra.request)return extra.request(path,method,body);return path.endsWith('/flow-preparation')?preparation():view('NOT_RUN');};
 const wizard=new CustomFlowWizard({request},{get:k=>drafts.get(k)??'',set:(k,v)=>(drafts.set(k,v),true),delete:k=>drafts.delete(k)},{active:()=>true,show:h=>html.push(h),error:e=>errors.push(e),saved:()=>saved++,specHash:()=>specHash});await wizard.open('p1');wizard.state.step=3;drafts.set('custom-profile:p1',serializeWizard(wizard.state));return{wizard,calls,drafts,html,errors,saved:()=>saved};
}

test('a check requires reading history and independent consent before any preparation or account POST',async()=>{
 const x=await rig();await x.wizard.checkAccounts(data({accountCheckConsent:'on'}));assert.equal(x.calls.filter(c=>c.method==='POST').length,0);
 await x.wizard.readAccountCheck();await x.wizard.checkAccounts(data({}));assert.equal(x.calls.filter(c=>c.method==='POST').length,0);assert.ok(x.errors.some(Boolean));
});
test('one explicit check uses only saved frozen refs and never saves, builds or accepts a project',async()=>{
 const x=await rig({request:async(path,method)=>path.endsWith('/flow-preparation')?preparation():method==='POST'?view():view('NOT_RUN')});await x.wizard.readAccountCheck();await x.wizard.checkAccounts(data({accountCheckConsent:'on'}));
 const posts=x.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].path,'/projects/p1/flow-preparation');assert.equal(posts[1].path,'/projects/p1/flow-account-check');assert.deepEqual(posts[1].body,{specHash,profileHash,preparation:selection().preparation,confirmed:true});assert.equal(x.saved(),0);assert.equal(x.wizard.state.configuration.roles.planner2.model.id,'deepseek-flash');assert.ok(x.html.at(-1).includes('账户和模型仍未验证'));
});
test('unknown response requires a history read and never automatically repeats the account operation',async()=>{
 let posts=0,done=false;const x=await rig({request:async(path,method)=>{if(path.endsWith('/flow-preparation'))return preparation();if(method==='POST'){posts++;done=true;throw new UiError('NETWORK_UNCERTAIN','synthetic loss');}return view(done?'PASSED':'NOT_RUN');}});await x.wizard.readAccountCheck();await x.wizard.checkAccounts(data({accountCheckConsent:'on'}));await x.wizard.checkAccounts(data({accountCheckConsent:'on'}));assert.equal(posts,1);await x.wizard.readAccountCheck();assert.equal(posts,1);
});
test('a late preparation after closing the wizard cannot start the account check',async()=>{
 let finish,checks=0;const pending=new Promise(r=>finish=r),x=await rig({request:async(path,method)=>{if(path.endsWith('/flow-preparation'))return pending;if(method==='POST')checks++;return view('NOT_RUN');}});await x.wizard.readAccountCheck();const work=x.wizard.checkAccounts(data({accountCheckConsent:'on'}));x.wizard.cancel();await x.wizard.open('p2');const before=serializeWizard(x.wizard.state);finish(preparation());await work;assert.equal(checks,0);assert.equal(serializeWizard(x.wizard.state),before);
});
test('a newer stored draft survives preparation and prevents a stale account operation',async()=>{
 let checks=0,x; x=await rig({request:async(path,method)=>{if(path.endsWith('/flow-preparation')){x.drafts.set('custom-profile:p1','NEWER_DRAFT');return preparation();}if(method==='POST')checks++;return view('NOT_RUN');}});await x.wizard.readAccountCheck();await x.wizard.checkAccounts(data({accountCheckConsent:'on'}));assert.equal(checks,0);assert.equal(x.drafts.get('custom-profile:p1'),'NEWER_DRAFT');
});
test('changed unsaved configuration and uncertain cleanup cannot start another account check',async()=>{
 const x=await rig();await x.wizard.readAccountCheck();x.wizard.state.configuration.roles.reviewer.model.id='UNSAVED';await x.wizard.checkAccounts(data({accountCheckConsent:'on'}));assert.equal(x.calls.filter(c=>c.method==='POST').length,0);
 const y=await rig({request:async()=>view('UNCERTAIN')});await y.wizard.readAccountCheck();await y.wizard.checkAccounts(data({accountCheckConsent:'on'}));assert.equal(y.calls.filter(c=>c.method==='POST').length,0);
});
test('public results reject authority flags, foreign bindings and private paths',async()=>{
 const {readMagpieAccountCheck}=await import('../../dist/web/magpie-account-check-view.js');assert.deepEqual(readMagpieAccountCheck(view(),'p1'),view());assert.equal(readMagpieAccountCheck({...view(),accountVerified:true},'p1').accountVerified,true);for(const edit of [{accountVerified:'VERIFIED'},{accountVerified:null},{customExecutionGranted:true},{runtimeDirectory:'F:/PRIVATE'},{projectId:'other'},{sourceBindingHash:['f'.repeat(64)]}])assert.throws(()=>readMagpieAccountCheck({...view(),...edit},'p1'));
});

test('the account-check panel no longer claims the old all-DSH-only route',async()=>{
 const {magpieAccountCheckPanel}=await import('../../dist/web/magpie-account-check-view.js');
 const html=magpieAccountCheckPanel({saved:true,needsRead:false,view:view('NOT_RUN')});
 assert.doesNotMatch(html,/目前接入 DeepSeek 官方 API、DSH 和 deepseek-flash 的已保存组合/);
 assert.match(html,/OpenAI 订阅规划账户/);
 assert.match(html,/DeepSeek API Key/);
 assert.match(html,/不验证账户或模型资格/);
});

function recoveryView(status='REQUIRED',restartRequired=status==='RECOVERED'){return{schema:'dream-maker.magpie-account-recovery.v1',projectId:'p1',scope:'LOCAL_PROCESS_CLEANUP_ONLY',status,targetHash:'7'.repeat(64),checkedAt:status==='RECOVERED'?'2026-11-04T00:00:00.000Z':null,processClosed:status==='RECOVERED',restartRequired,reason:status==='RECOVERED'?null:'CLEANUP_UNCERTAIN',accountVerified:false,modelVerified:false,customExecutionGranted:false};}
test('M13 recovery needs history and separate consent, sends only the frozen target, and never repeats the check',async()=>{
 const x=await rig({request:async(path,method)=>path.endsWith('/flow-account-recovery')?recoveryView(method==='POST'?'RECOVERED':'REQUIRED'):view('UNCERTAIN')});
 await x.wizard.recoverAccountCheck(data({accountRecoveryConsent:'on'}));assert.equal(x.calls.filter(c=>c.method==='POST').length,0);
 await x.wizard.readAccountCheck();await x.wizard.recoverAccountCheck(data({}));assert.equal(x.calls.filter(c=>c.method==='POST').length,0);
 await x.wizard.recoverAccountCheck(data({accountRecoveryConsent:'on'}));const posts=x.calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].path,'/projects/p1/flow-account-recovery');assert.deepEqual(posts[0].body,{expectedTargetHash:'7'.repeat(64),confirmed:true});assert.ok(x.html.at(-1).includes('关闭并重开'));
 await x.wizard.checkAccounts(data({accountCheckConsent:'on'}));assert.equal(x.calls.filter(c=>c.method==='POST').length,1);
});
test('M13 lost recovery response requires reading saved evidence before another attempt',async()=>{
 let posts=0,recovered=false;const x=await rig({request:async(path,method)=>{if(!path.endsWith('/flow-account-recovery'))return view('UNCERTAIN');if(method==='POST'){posts++;recovered=true;throw new UiError('NETWORK_UNCERTAIN','synthetic loss');}return recoveryView(recovered?'RECOVERED':'REQUIRED');}});
 await x.wizard.readAccountCheck();await x.wizard.recoverAccountCheck(data({accountRecoveryConsent:'on'}));await x.wizard.recoverAccountCheck(data({accountRecoveryConsent:'on'}));assert.equal(posts,1);await x.wizard.readAccountCheck();assert.equal(posts,1);assert.ok(x.html.at(-1).includes('关闭并重开'));
});
test('M13 late recovery cannot overwrite another project or a newer draft',async()=>{
 let finish;const pending=new Promise(r=>finish=r),x=await rig({request:async(path,method)=>method==='POST'?pending:path.endsWith('/flow-account-recovery')?recoveryView():view('UNCERTAIN')});await x.wizard.readAccountCheck();const work=x.wizard.recoverAccountCheck(data({accountRecoveryConsent:'on'}));x.wizard.cancel();await x.wizard.open('p2');const current=serializeWizard(x.wizard.state);finish(recoveryView('RECOVERED'));await work;assert.equal(serializeWizard(x.wizard.state),current);assert.equal(x.wizard.projectId,'p2');
});
test('M13 recovery projection rejects forged qualification, private metadata and inconsistent restart flags',async()=>{
 const {readMagpieAccountRecovery}=await import('../../dist/web/magpie-account-check-view.js');assert.deepEqual(readMagpieAccountRecovery(recoveryView(),'p1'),recoveryView());
 for(const edit of [{modelVerified:true},{customExecutionGranted:true},{markerPath:'F:/PRIVATE'},{projectId:'other'},{restartRequired:true}])assert.throws(()=>readMagpieAccountRecovery({...recoveryView(),...edit},'p1'));
});
