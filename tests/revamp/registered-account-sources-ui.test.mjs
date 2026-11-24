// OFFLINE controller boundary, synthetic metadata only. No credential, account or model proof.
import test from 'node:test';import assert from 'node:assert/strict';import {CustomFlowWizard} from '../../dist/web/custom-flow-controller.js';
import {wizardRoles,addWizardItem,serializeWizard} from '../../dist/web/custom-flow-state.js';import {customWizardView} from '../../dist/web/custom-flow-view.js';
const data=values=>({get:name=>values[name]??null}),source=()=>({schema:'dream-maker.registered-account-source.v1',id:'account_source_'+'a'.repeat(20),sourceId:'CONTROLLER_DSH_SESSION',authRef:'controller_auth_'+'b'.repeat(20),accountRef:'controller_account_'+'c'.repeat(20),provider:'deepseek-official',authentication:'api_key',label:'本机专用来源',configurationHash:'d'.repeat(64),contentHash:'e'.repeat(64),status:'SELECTED_UNVERIFIED',accountVerified:false,modelVerified:false,executionGranted:false});
function rig(request,dreamflow=false){const drafts=new Map(),html=[],errors=[];let saved=0;const wizard=new CustomFlowWizard({request},{get:k=>drafts.get(k)??'',set:(k,v)=>(drafts.set(k,v),true),delete:k=>drafts.delete(k)},{dreamflow,active:()=>true,show:h=>html.push(h),error:e=>errors.push(e),saved:()=>saved++});return{wizard,drafts,html,errors,saved:()=>saved};}
async function open(r){await r.wizard.open('p1');const s=r.wizard.state,a=s.configuration.accounts[0];a.provider='deepseek-official';a.authentication='api_key';for(const role of wizardRoles(s)){role.provider=a.provider;role.authentication=a.authentication;role.model.id='KEEP_MODEL';}s.step=0;r.drafts.set('custom-profile:p1',serializeWizard(s));return s;}
test('the existing account step asks separate consent only for an explicit supported API source',async()=>{const r=rig(async()=>({current:null})),s=await open(r);const html=customWizardView(s);assert.match(html,/name="sourceConsent-0"/);assert.match(html,/custom-bind-dsh-source/);assert.doesNotMatch(html,/name="sourceConsent-0"[^>]*checked/);s.configuration.accounts[0].authentication='oauth';assert.doesNotMatch(customWizardView(s),/custom-bind-dsh-source/);});
test('source registration updates all dependent draft references and preserves runtime/model/budget without saving the profile',async()=>{
 const calls=[],r=rig(async(path,method,body)=>{calls.push({path,method,body});return method==='POST'?{source:source()}:{current:null};}),s=await open(r);addWizardItem(s,'group');const old=s.configuration.accounts[0].authRef,roles=structuredClone(wizardRoles(s));
 await r.wizard.bindDshSource(data({'sourceConsent-0':'on'}),0);const c=r.wizard.state.configuration;assert.equal(c.accounts[0].authRef,source().authRef);assert.ok(wizardRoles(r.wizard.state).every(role=>role.authRef===source().authRef));assert.ok(c.groups.every(g=>g.members.every(m=>m.authRef!==old)));assert.deepEqual(wizardRoles(r.wizard.state).map(v=>v.model),roles.map(v=>v.model));assert.deepEqual(wizardRoles(r.wizard.state).map(v=>v.runtime),roles.map(v=>v.runtime));assert.equal(r.saved(),0);assert.equal(calls.filter(v=>v.method==='POST').length,1);assert.equal(calls.at(-1).path,'/account-sources');assert.deepEqual(Object.keys(calls.at(-1).body).sort(),['confirmed','label','sourceId']);
});
test('no consent, OAuth, or a reply claiming verified execution cannot change the draft',async()=>{
 let posts=0;const r=rig(async(_p,m)=>{if(m==='POST'){posts++;return{source:{...source(),executionGranted:true}};}return{current:null};}),s=await open(r),before=serializeWizard(s);
 await r.wizard.bindDshSource(data({}),0);assert.equal(posts,0);s.configuration.accounts[0].authentication='oauth';await r.wizard.bindDshSource(data({'sourceConsent-0':'on'}),0);assert.equal(posts,0);s.configuration.accounts[0].authentication='api_key';await r.wizard.bindDshSource(data({'sourceConsent-0':'on'}),0);assert.equal(posts,1);assert.equal(serializeWizard(r.wizard.state),before);
});
test('late registration after closing and opening another project never attaches to its draft',async()=>{
 let finish;const pending=new Promise(r=>finish=r),r=rig(async(_p,m)=>m==='POST'?pending:{current:null});await open(r);const first=r.wizard.bindDshSource(data({'sourceConsent-0':'on'}),0);r.wizard.cancel();await r.wizard.open('p2');const before=serializeWizard(r.wizard.state);finish({source:source()});await first;assert.equal(serializeWizard(r.wizard.state),before);assert.equal(r.wizard.projectId,'p2');
});

test('coercible nonstring references in a reply cannot corrupt a valid draft',async()=>{
 for(const field of ['id','authRef','accountRef']){const value=source();value[field]=[value[field]];const r=rig(async(_p,m)=>m==='POST'?{source:value}:{current:null});const s=await open(r),before=serializeWizard(s);
  await r.wizard.bindDshSource(data({'sourceConsent-0':'on'}),0);assert.equal(serializeWizard(r.wizard.state),before);assert.ok(r.errors.some(Boolean));
 }
});
const identity={provider:'vendor-a',authentication:'api_key',authRef:'vendor-auth',accountRef:'vendor-account'};
test('source selection guards provider, target account, both unique references and other roles',async()=>{
 const r=rig(async path=>path.startsWith('/account-sources')?{sources:[identity]}:{current:null},true);await r.wizard.open('p1');const w=r.wizard;
 addWizardItem(w.state,'account');const first=w.state.configuration.accounts[0],second=w.state.configuration.accounts[1];await w.readAccountIdentities();
 const fields=data({'account-provider-1':identity.provider,'account-auth-1':'api_key'});w.update(fields,true);
 const reject=(i,target,authRef)=>{const before=serializeWizard(w.state);w.attachAccountIdentity(data({}),i,target,w.state.configuration.accounts[i].accountRef,authRef,identity.accountRef);assert.equal(serializeWizard(w.state),before);assert.ok(r.errors.at(-1));};
 reject(0,first.authRef,identity.authRef);reject(1,first.authRef,identity.authRef);reject(1,second.authRef,'unlisted');
 w.attachAccountIdentity(data({}),1,second.authRef,second.accountRef,identity.authRef,identity.accountRef);assert.equal(w.state.configuration.accounts[1].accountRef,identity.accountRef);assert.ok(wizardRoles(w.state).every(role=>role.authRef===first.authRef));
 w.update(data({'account-provider-0':identity.provider,'account-auth-0':'api_key'}));reject(0,first.authRef,identity.authRef);
 const other=rig(async()=>({current:null}));await other.wizard.open('p1');assert.doesNotMatch(other.html.at(-1),/read-account-identities/);
});
test('late identity responses leave a changed draft and a newly opened project untouched',async()=>{
 for(const change of ['storage','project']){
  let done;const wait=new Promise(r=>done=r),r=rig(async path=>path.startsWith('/account-sources')?wait:{current:null},true);await r.wizard.open('p1');const pending=r.wizard.readAccountIdentities();
  if(change==='storage')r.drafts.set('custom-profile:p1','other-tab');else{r.wizard.cancel();await r.wizard.open('p2');}
  const before=serializeWizard(r.wizard.state);done({sources:[identity]});await pending;assert.equal(serializeWizard(r.wizard.state),before);assert.doesNotMatch(r.html.at(-1),/vendor-a/);
  if(change==='storage')assert.equal(r.drafts.get('custom-profile:p1'),'other-tab');else assert.equal(r.wizard.projectId,'p2');
 }
});
test('binding rejects a mixed source tuple and preserves external edits made after the list loaded',async()=>{
 const r=rig(async path=>path.startsWith('/account-sources')?{sources:[identity]}:{current:null},true),w=r.wizard;await w.open('p1');
 const fields=data({'account-provider-0':identity.provider,'account-auth-0':'api_key'});w.update(fields);await w.readAccountIdentities();const target=w.state.configuration.accounts[0],before=serializeWizard(w.state);
 w.attachAccountIdentity(fields,0,target.authRef,target.accountRef,identity.authRef,'mismatched-account');assert.equal(serializeWizard(w.state),before);
 r.drafts.set('custom-profile:p1','external');w.update(fields);w.attachAccountIdentity(fields,0,target.authRef,target.accountRef,identity.authRef,identity.accountRef);
 assert.equal(serializeWizard(w.state),before);assert.equal(r.drafts.get('custom-profile:p1'),'external');
});
test('duplicate auth or account references and private fields invalidate the whole response',async()=>{
 for(const extra of [{...identity,authRef:'another'},{...identity,accountRef:'another'},{...identity,endpoint:'private'}]){
  const r=rig(async p=>p.startsWith('/account-sources')?{sources:[identity,extra]}:{current:null},true);await r.wizard.open('p1');await r.wizard.readAccountIdentities();assert.ok(r.errors.at(-1));assert.doesNotMatch(r.html.at(-1),/vendor-a/);
 }
});
