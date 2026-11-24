// Explicit UI/controller boundary only. Request responses are synthetic, never Native receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CustomFlowWizard} from '../../dist/web/custom-flow-controller.js';
import {wizardConfiguration} from '../../dist/web/custom-flow-state.js';
import {addWizardItem,serializeWizard,wizardRoles} from '../../dist/web/custom-flow-state.js';
import {customFlowProfile} from '../../dist/server/flow-profiles.js';
import {UiError} from '../../dist/web/contracts.js';
const data=o=>({get:name=>o[name]??null});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function rig(request,dreamflow=false){const drafts=new Map(),html=[],errors=[],saved=[];const storage={get:k=>drafts.get(k)??'',set:(k,v)=>(drafts.set(k,v),true),delete:k=>drafts.delete(k),getRequired:k=>drafts.get(k)??'',setRequired:(k,v)=>(drafts.set(k,v),true),deleteRequired:k=>(drafts.delete(k),true),withRequiredLock:async(_key,work)=>work()};const wizard=new CustomFlowWizard({request},storage,{dreamflow,active:()=>true,show:h=>html.push(h),error:m=>errors.push(m),saved:v=>saved.push(v),specHash:()=>'b'.repeat(64)});return {wizard,drafts,html,errors,saved};}
function complete(w){w.state.configuration.roles.planner2.model.id='model-a';w.state.configuration.roles.reviewer.model.id='model-b';w.state.configuration.roles.executors[0].model.id='model-c';w.state.step=3;}
function version(c){return {schema:'dream-maker.custom-profile-version.v1',projectId:'p1',revision:1,parentHash:null,contentHash:'a'.repeat(64),configuration:c,scope:'CONFIGURATION_ONLY',serviceIdentity:'NOT_VERIFIED',executionGranted:false};}
test('account setup reads desktop providers before a role has a model',async()=>{
 const paths=[];
 const r=rig(async path=>{
  paths.push(path);
  return path==='/magpie/models'?{scope:'DESKTOP_METADATA_ONLY',models:[{id:'deepseek/m',provider:'deepseek',kind:'provider',protocols:[]}]}:{current:null};
 },true);
 await r.wizard.open('p1');
 await r.wizard.readMagpieModels(data({}));
 assert.equal(r.wizard.state.step,0);
 assert.equal(paths.filter(path=>path==='/magpie/models').length,1);
 assert.match(r.html.at(-1),/<option value="deepseek"/);
});
test('DreamFlow catalog selection saves the exact account and provider-local model',async()=>{
 const models=['github/org/shared','other/org/shared','group/shared'].map((id,index)=>({id,provider:index===1?'other':'github',kind:index===2?'alias':'provider',protocols:[]}));
 let posted;
 const r=rig(async(path,method,body)=>{
  if(path==='/magpie/models')return {scope:'DESKTOP_METADATA_ONLY',models};
  if(method==='POST'){posted=customFlowProfile(body.configuration);return {current:version(posted)};}
  return {current:null};
 },true);
 const w=r.wizard;await w.open('p1');complete(w);w.state.step=1;
 addWizardItem(w.state,'account');const [first,second]=w.state.configuration.accounts;
 await w.readMagpieModels(data({}));
 const pick=(fields)=>w.update(data(fields),true);
 for(const id of ['other/org/shared','group/shared','github/missing']){
  pick({'role-catalog-0':id});assert.equal(w.state.configuration.roles.planner2.model.id,'model-a');assert.ok(r.errors.at(-1));
 }
 pick({'role-catalog-0':'github/org/shared'});
 assert.equal(w.state.configuration.roles.planner2.model.id,'org/shared');
 assert.equal(w.state.configuration.roles.planner2.accountRef,first.accountRef);
 pick({'role-account-0':second.authRef,'role-catalog-0':'github/org/shared','role-model-0':'org/shared'});
 assert.equal(w.state.configuration.roles.planner2.model.id,'');
 pick({'role-catalog-0':'github/org/shared','role-model-2':'manual/vendor/model'});
 addWizardItem(w.state,'group');pick({'role-kind-1':'group','role-group-1':'group-1','role-member-1':'member-1'});w.state.step=2;await w.readMagpieModels(data({}));
 assert.ok(r.html.at(-1).includes('name="member-catalog-0-0"'));
 pick({'member-catalog-0-0':'github/org/shared'});
 pick({'member-account-0-0':second.authRef,'member-model-0-0':'org/shared','member-catalog-0-0':'github/org/shared'});
 assert.equal(w.state.configuration.groups[0].members[0].model,'');
 pick({'member-catalog-0-0':'github/org/shared','member-read-0-0':'on'});
 w.state.step=3;await w.submit(data({customConsent:'on'}));
 assert.equal(r.saved.length,1,JSON.stringify(r.errors));
 assert.equal(posted.roles.planner2.model.id,'org/shared');assert.equal(posted.roles.reviewer.model.id,'manual/vendor/model');
 const member=posted.groups[0].members[0];assert.equal(member.model,'org/shared');
 for(const actor of [posted.roles.planner2,member]){assert.equal(actor.provider,'github');assert.equal(actor.authRef,second.authRef);assert.equal(actor.accountRef,second.accountRef);}
 await w.open('p2');w.state.step=1;pick({'role-catalog-0':'github/org/shared'});assert.equal(w.state.configuration.roles.planner2.model.id,'');
});
const specHash='b'.repeat(64),profileHash='a'.repeat(64);
function mixedConfiguration(){
 const plannerAccount={provider:'openai',authentication:'oauth',authRef:'openai-chatgpt-main',accountRef:'openai-chatgpt-main-account',label:'GPT 规划账户'};
 const deepseekAccount={provider:'deepseek-official',authentication:'api_key',authRef:'deepseek-official-main',accountRef:'deepseek-official-main-account',label:'DeepSeek 专用来源'};
 const role=(id,account,runtime,model,write=false)=>({id,...account,runtime,model:{kind:'model',id:model},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 return {mode:'custom',laya:false,accounts:[plannerAccount,deepseekAccount],roles:{planner2:role('planner2',plannerAccount,'codex','gpt-6-luna'),executors:[role('executor-1',deepseekAccount,'dsh','deepseek-flash',true)],reviewer:role('reviewer',deepseekAccount,'independent','deepseek-v4-pro')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:3000000},timeZone:'Asia/Shanghai'};
}
const preparation=()=>({preparation:{schema:'dream-maker.custom-flow-preparation.v1',projectId:'p1',identityHash:'c'.repeat(64),contentHash:'d'.repeat(64),flowConfigHash:'e'.repeat(64),createdAt:'2026-11-04T00:00:00.000Z',scope:'CONFIGURATION_PREPARATION_ONLY',executionGranted:false,flowConfig:{schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'p1',plan:{specHash},profile:{contentHash:profileHash},qualification:'NOT_VERIFIED'}},executionGranted:false});
const selection=()=>({projectId:'p1',specHash,profileHash,preparation:{identityHash:'c'.repeat(64),contentHash:'d'.repeat(64)}});
const accountView=status=>({schema:'dream-maker.magpie-account-check.v1',projectId:'p1',scope:'REGISTERED_MEMORY_TRANSFER_ONLY',historical:true,status,selection:status==='NOT_RUN'?null:selection(),flowConfigHash:status==='NOT_RUN'?null:'e'.repeat(64),sourceBindingHash:status==='PASSED'?'f'.repeat(64):null,checkedAt:status==='NOT_RUN'?null:'2026-11-04T00:00:00.000Z',accountCount:status==='PASSED'?1:null,processClosed:status==='NOT_RUN'?null:status==='PASSED',reason:null,accountVerified:false,modelVerified:false,customExecutionGranted:false});
const roleStatus=(role,roleId,model,state='NOT_RUN')=>({schema:'dream-maker.custom-role-check.v1',projectId:'p1',role,roleId,selection:selection(),configurationHash:'e'.repeat(64),status:state,checkedAt:state==='NOT_RUN'?null:'2026-11-04T00:00:00.000Z',evidenceId:state==='PASSED_MINIMUM'?'OFFLINE_ROLE_RECEIPT':null,model:state==='PASSED_MINIMUM'?model:null,executionGranted:false,fourRoleLive:'NOT_RUN'});

test('DreamFlow saved group recommendation fills the draft only and rejects a stale preparation response',async()=>{
 const config=mixedConfiguration(),actor=config.roles.reviewer;
 const members=['deepseek-flash','deepseek-v4-pro'].map((model,i)=>({id:'m'+i,provider:actor.provider,authRef:actor.authRef,accountRef:actor.accountRef,permissions:['source_read'],model}));
 config.groups=[{id:'g',strategy:'cost',members}];actor.model={kind:'group',id:'g'};actor.selectedMemberId='m1';
 const calls=[];let stale=true;const r=rig(async(path,method,body)=>{
  if(method!=='POST')return {current:version(config)};
  calls.push(path);if(path.endsWith('/flow-preparation'))return preparation();
  assert.equal(body.roleId,'reviewer');assert.equal(body.confirmed,true);assert.deepEqual(body.preparation,selection().preparation);
  return {scope:'CONFIGURATION_ONLY',roleId:'reviewer',groupId:'g',profileHash,flowConfigHash:(stale?'f':'e').repeat(64),memberId:'m0',reserveMicros:7,currency:'CNY',expiresAtMs:Date.now()+60000};
 },true);await r.wizard.open('p1');r.wizard.state.step=1;
 const fields=data({'role-write-1':'on'});await r.wizard.recommendMember(fields,'reviewer');assert.equal(r.wizard.state.configuration.roles.reviewer.selectedMemberId,'m1');
 stale=false;await r.wizard.recommendMember(fields,'reviewer');assert.equal(r.wizard.state.configuration.roles.reviewer.selectedMemberId,'m0',JSON.stringify(r.errors));
 assert.equal(calls.length,4);assert.equal(actor.selectedMemberId,'m1');assert.deepEqual(r.saved,[]);
});
test('late loads cannot replace a closed or newer wizard and failed saves preserve the draft',async()=>{
 const old=deferred(),fresh=deferred();let count=0;const r=rig(()=>++count===1?old.promise:fresh.promise);
 const first=r.wizard.open('p1');r.wizard.cancel();const next=r.wizard.open('p2');fresh.resolve({current:null});await next;old.resolve({current:null});await first;
 assert.equal(r.wizard.state.projectId,'p2');assert.equal(r.saved.length,0);
});

test('one confirmed save is in flight; a late completion after close cannot update another dialog',async()=>{
 const pending=deferred();let posts=0;const r=rig(async(_path,method)=>method==='POST'?(posts++,pending.promise):{current:null});await r.wizard.open('p1');complete(r.wizard);
 const config=wizardConfiguration(r.wizard.state),one=r.wizard.submit(data({customConsent:'on'}));await r.wizard.submit(data({customConsent:'on'}));assert.equal(posts,1);
 r.wizard.cancel();pending.resolve({current:version(config)});await one;assert.equal(r.saved.length,0);assert.ok(r.drafts.size>0);
});

test('unknown POST result requires a read before retry and reconciles saved bytes without another POST',async()=>{
 let posts=0,current=null;const r=rig(async(_path,method,body)=>{if(method==='POST'){posts++;current=version(body.configuration);throw new UiError('NETWORK_UNCERTAIN','synthetic disconnected response');}return {current};});
 await r.wizard.open('p1');complete(r.wizard);await r.wizard.submit(data({customConsent:'on'}));assert.equal(posts,1);assert.equal(r.saved.length,0);assert.equal(r.wizard.needsRecheck,true);
 await r.wizard.submit(data({customConsent:'on'}));assert.equal(posts,1);await r.wizard.recheck();assert.equal(posts,1);assert.equal(r.saved.length,1);
});

test('version conflict retains old inputs and never adopts another revision without explicit reload',async()=>{
 let posts=0;const r=rig(async(_path,method)=>{if(method==='POST'){posts++;throw new UiError('FLOW_PROFILE_REVISION_CONFLICT','synthetic conflict',409);}return {current:null};});await r.wizard.open('p1');complete(r.wizard);
 await r.wizard.submit(data({customConsent:'on'}));assert.equal(r.wizard.state.configuration.roles.planner2.model.id,'model-a');assert.equal(r.wizard.state.baseRevision,0);assert.equal(r.saved.length,0);assert.equal(posts,1);assert.ok(r.errors.length);
});

test('reconciling an earlier saved attempt cannot delete edits made after the response was lost',async()=>{
 let current=null;const r=rig(async(_path,method,body)=>{if(method==='POST'){current=version(body.configuration);throw new UiError('NETWORK_UNCERTAIN','response lost after commit');}return {current};});
 await r.wizard.open('p1');complete(r.wizard);await r.wizard.submit(data({customConsent:'on'}));
 r.wizard.state.step=1;r.wizard.update(data({'role-model-0':'UNSAVED_AFTER_RESPONSE_LOSS','role-write-1':'on'}));await r.wizard.recheck();
 assert.equal(r.saved.length,0);assert.equal(r.wizard.state.configuration.roles.planner2.model.id,'UNSAVED_AFTER_RESPONSE_LOSS');assert.equal(r.wizard.state.baseRevision,1);assert.equal(r.wizard.needsRecheck,false);assert.ok(r.drafts.get('custom-profile:p1').includes('UNSAVED_AFTER_RESPONSE_LOSS'));
});

test('a large server-valid profile remains editable and saves without duplicating its full pending payload in the draft',async()=>{
 let posts=0;const r=rig(async(_path,method,body)=>{if(method==='POST'){posts++;return {current:version(body.configuration)};}return {current:null};});await r.wizard.open('p1');complete(r.wizard);
 const s=r.wizard.state,a=s.configuration.accounts[0];a.authRef='auth-'+ 'x'.repeat(70);a.accountRef='account-'+'x'.repeat(67);
 for(let i=1;i<64;i++)addWizardItem(s,'executor');
 for(const role of wizardRoles(s)){role.authRef=a.authRef;role.accountRef=a.accountRef;role.runtime='runtime-'+'x'.repeat(60);role.model.id='model-'+'x'.repeat(84);}
 for(let i=0;i<8;i++){addWizardItem(s,'group');for(let j=1;j<20;j++)addWizardItem(s,'member',i);const g=s.configuration.groups[i];for(const m of g.members)m.model='backup-'+'x'.repeat(83);wizardRoles(s)[i].model={kind:'group',id:g.id};wizardRoles(s)[i].selectedMemberId=g.members.at(-1).id;}
 const config=wizardConfiguration(s);assert.deepEqual(customFlowProfile(config),config);assert.ok(Buffer.byteLength(JSON.stringify(config))>60000);assert.ok(Buffer.byteLength(JSON.stringify(config))<100000);s.step=3;
 await r.wizard.submit(data({customConsent:'on'}));assert.equal(posts,1);assert.equal(r.saved.length,1);assert.ok(Buffer.byteLength(serializeWizard(r.wizard.state))<120000);
});

test('a corrupt legacy pending snapshot cannot replace a valid newer draft with the saved configuration',async()=>{
 const r=rig(async()=>({current:null}));await r.wizard.open('p1');complete(r.wizard);const a=wizardConfiguration(r.wizard.state),b=structuredClone(r.wizard.state);b.configuration.roles.planner2.model.id='KEEP_NEWER_DRAFT';b.pendingAttempt={baseRevision:0,configuration:{...a,constructor:'INVALID_PENDING_ONLY'}};
 r.drafts.set('custom-profile:p1',JSON.stringify(b));r.wizard.cancel();r.wizard.adapter.request=async()=>({current:version(a)});await r.wizard.open('p1');
 assert.equal(r.wizard.state.configuration.roles.planner2.model.id,'KEEP_NEWER_DRAFT');assert.equal(r.wizard.needsRecheck,true);r.wizard.update(data({}));assert.ok(r.drafts.get('custom-profile:p1').includes('KEEP_NEWER_DRAFT'));assert.equal(r.saved.length,0);
});

test('a failed reconciliation write retains the submitted snapshot and old baseline until the draft can be recovered',async()=>{
 let current=null;const r=rig(async(_path,method,body)=>{if(method==='POST'){current=version(body.configuration);throw new UiError('NETWORK_UNCERTAIN','response lost');}return {current};});await r.wizard.open('p1');complete(r.wizard);await r.wizard.submit(data({customConsent:'on'}));
 r.wizard.state.step=1;r.wizard.update(data({'role-model-0':'KEEP_AFTER_FAILED_RECONCILIATION','role-write-1':'on'}));const snapshotKey=r.wizard.state.pendingAttempt.key,originalSet=r.wizard.drafts.set;let fail=true;
 r.wizard.drafts.set=(key,value)=>fail&&key==='custom-profile:p1'&&JSON.parse(value).baseRevision===1?false:originalSet(key,value);
 await r.wizard.recheck();assert.ok(r.drafts.has(snapshotKey));assert.equal(r.wizard.state.baseRevision,0);assert.equal(r.wizard.needsRecheck,true);
 fail=false;r.wizard.cancel();await r.wizard.open('p1');assert.equal(r.wizard.state.configuration.roles.planner2.model.id,'KEEP_AFTER_FAILED_RECONCILIATION');assert.equal(r.wizard.state.baseRevision,1);assert.equal(r.saved.length,0);
});

test('removing the selected group member leaves an incomplete draft that can go back for an explicit reselection',async()=>{
 const r=rig(async()=>({current:null}));await r.wizard.open('p1');
 addWizardItem(r.wizard.state,'group');addWizardItem(r.wizard.state,'member',0);
 const s=r.wizard.state,g=s.configuration.groups[0];for(const m of g.members)m.model='offline-model';
 s.configuration.roles.planner2.model={kind:'group',id:g.id};s.configuration.roles.planner2.selectedMemberId=g.members[1].id;s.step=2;
 r.wizard.edit('remove-member',data({}),0,1);assert.equal(r.wizard.state.step,2);assert.equal(r.wizard.state.configuration.roles.planner2.selectedMemberId,undefined);
 r.wizard.edit('back',data({}),0,0);assert.equal(r.wizard.state.step,1);assert.equal(r.wizard.state.configuration.roles.planner2.selectedMemberId,undefined);
 assert.equal(r.errors.some(Boolean),false,JSON.stringify(r.errors));assert.ok(r.drafts.get('custom-profile:p1'));
});

test('failed pending-pointer writes retire only their newly created snapshot and leave the active draft editable',async()=>{
 let posts=0;const r=rig(async(_path,method)=>{if(method==='POST')posts++;return {current:null};});await r.wizard.open('p1');complete(r.wizard);const originalSet=r.wizard.drafts.set;
 r.wizard.drafts.set=(key,value)=>key==='custom-profile:p1'&&JSON.parse(value).pendingAttempt?false:originalSet(key,value);
 for(let i=0;i<3;i++)await r.wizard.submit(data({customConsent:'on'}));
 assert.equal(posts,0);assert.equal([...r.drafts.keys()].filter(key=>key.startsWith('custom-profile-attempt:')).length,0);assert.equal(r.wizard.state.pendingAttempt,undefined);
 r.wizard.edit('back',data({}));assert.equal(r.wizard.state.step,2);
});

test('an unreadable whole draft stays untouched until explicit reload preserves its original bytes',async()=>{
 const r=rig(async()=>({current:null}));await r.wizard.open('p1');complete(r.wizard);const saved=version(wizardConfiguration(r.wizard.state)),raw='{"schema":"damaged';r.drafts.set('custom-profile:p1',raw);r.wizard.cancel();r.wizard.adapter.request=async()=>({current:saved});
 await r.wizard.open('p1');r.wizard.update(data({}));assert.equal(r.drafts.get('custom-profile:p1'),raw);assert.equal(r.wizard.needsRecheck,true);
 await r.wizard.loadLatest();assert.equal(r.drafts.get('custom-profile-previous:p1'),raw);assert.equal(JSON.parse(r.drafts.get('custom-profile:p1')).baseRevision,1);assert.equal(r.saved.length,0);
});
test('account help keeps a saved official login reusable and does not turn transient failures into reauthorization',async()=>{
 const r=rig(async()=>({current:null}));await r.wizard.open('p1');r.wizard.edit('account-help',data({}));
 const html=r.html.at(-1);assert.match(html,/后续重新打开向导/);assert.match(html,/都会复用/);assert.match(html,/网络超时、代理故障或服务重启不会被当作登录失效/);
});

test('a mixed GPT, DSH and independent-API Custom route reaches account and role checks',async()=>{
 let current=version(mixedConfiguration()),accountChecks=0,roleProbes=0;
 const r=rig(async(path,method,body)=>{
  if(path.endsWith('/flow-preparation'))return preparation();
  if(path.endsWith('/flow-account-check')){if(method==='POST')accountChecks++;return method==='POST'?accountView('PASSED'):accountView('NOT_RUN');}
  if(path.endsWith('/flow-role-status'))return roleStatus('executor','executor-1','deepseek-flash',body.requestId?'PASSED_MINIMUM':'NOT_RUN');
  if(path.endsWith('/flow-role-probe')){roleProbes++;return{scope:'MINIMUM_ROLE_ONLY',executionGranted:false,fourRoleLive:'NOT_RUN'};}
  return{current};
 });
 await r.wizard.open('p1');r.wizard.state.step=3;
 await r.wizard.readAccountCheck();
 await r.wizard.checkAccounts(data({accountCheckConsent:'on'}));
 await r.wizard.checkRole(data({}),'executor-1',false);
 await r.wizard.checkRole(data({[`roleConsent-executor-1`]:'on'}),'executor-1',true);
 assert.equal(accountChecks,1);
 assert.equal(roleProbes,1);
 assert.equal(r.errors.some(Boolean),false,JSON.stringify(r.errors));
});
