// OFFLINE Store, synthetic receipts and an in-memory ledger. No account, process, model or network.
import test from 'node:test';import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';
import {hash} from '../../dist/server/security.js';
import {RegisteredAccountSources} from '../../dist/server/registered-account-sources.js';
import {accountProbeEvidence,createAccountProbeAuthority,NO_ACCOUNT_PROBE_AUTHORITY} from '../../dist/server/account-verification.js';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';
const actor='local-session:'+'a'.repeat(64),signature=hash('OFFLINE_SIGNATURE');
const definition=(secretEnv='DM_SYNTHETIC_ACCOUNT_KEY')=>({sourceId:'CONTROLLER_DSH_SESSION',secretEnv,configurationHash:hash({schema:'dream-maker.controller-dsh-source.v1',sourceId:'CONTROLLER_DSH_SESSION',provider:'deepseek-official',authentication:'api_key',secretEnv})});
const input=label=>({sourceId:'CONTROLLER_DSH_SESSION',label,confirmed:true});
const price={provider:'deepseek-official',model:'deepseek-flash'};
const known=(id,extra={})=>({id,role:'executor',usageStatus:'KNOWN',outcome:'COMPLETE',chargedMicros:288671,price:{...price},...extra});
const customReceipt=(store,{probeId='custom_probe_one',authRef,accountRef,ledgerRequestIds=[],roleId='worker-one',role='executor',signed=true,schema='dream-maker.custom-minimum-role-probe.v1'}={})=>store.record('NativeCustomProbeReceipt',null,null,{
 payload:{schema,probeId,observation:{roleId,role,authRef,accountRef,provider:'deepseek-official',authentication:'API_KEY',model:'deepseek-flash',ledgerRequestIds}},
 ...(signed?{signature}:{})});
const classicReceipt=(store,{nonce='DM_PROBE_offline',ledgerRequestIds=[],provider='deepseek-official',authentication='API_KEY',model='deepseek-flash'})=>store.record('NativeProbeReceipt',null,null,{
 payload:{schema:'dream-maker.minimum-role-probe.v1',nonce,role:'executor',observation:{role:'executor',runner:'DSH',provider,authentication,model,responseId:'resp_offline',ledgerRequestIds}},
 signature});
/** Two independently registered sources share one provider; only evidence marks one of them. */
function twoSources(t){
 const h=harness(t),definitionA=definition('DM_SYNTHETIC_KEY_A'),definitionB=definition('DM_SYNTHETIC_KEY_B'),sources=new RegisteredAccountSources(h.store);
 const a=sources.register(input('合成来源 A'),definitionA,actor,hash('OFFLINE_SOURCE_A'));
 const b=sources.register(input('合成来源 B'),definitionB,actor,hash('OFFLINE_SOURCE_B'));
 return{h,definitionA,definitionB,a,b,read:(authority,definition,id)=>new RegisteredAccountSources(h.store,authority).list(definition).sources.find(source=>source.id===id)};
}
test('a configured source with no receipt is never VERIFIED, and offline defaults stay closed',t=>{
 const x=twoSources(t);
 assert.equal(x.a.accountVerified,false);assert.equal(x.b.accountVerified,false);
 const empty=createAccountProbeAuthority(x.h.store,()=>[]);
 assert.equal(x.read(empty,x.definitionA,x.a.id).accountVerified,false);
 assert.equal(x.read(empty,x.definitionB,x.b.id).accountVerified,false);
 assert.equal(NO_ACCOUNT_PROBE_AUTHORITY.verified({authRef:x.a.authRef,accountRef:x.a.accountRef,provider:'deepseek-official',authentication:'api_key'}),false);
 const view=x.read(empty,x.definitionA,x.a.id);
 assert.equal(view.modelVerified,false);assert.equal(view.executionGranted,false);assert.equal(view.status,'SELECTED_UNVERIFIED');
});
test('one metered KNOWN real-model receipt marks exactly the account that owns it',t=>{
 const x=twoSources(t),ledger=[known('req_known',{customProbe:{probeId:'custom_probe_one'}})];
 customReceipt(x.h.store,{probeId:'custom_probe_one',authRef:x.a.authRef,accountRef:x.a.accountRef,ledgerRequestIds:['req_known']});
 const authority=createAccountProbeAuthority(x.h.store,()=>ledger);
 const marked=x.read(authority,x.definitionA,x.a.id),other=x.read(authority,x.definitionB,x.b.id);
 assert.equal(marked.accountVerified,true);assert.equal(marked.modelVerified,false);assert.equal(marked.executionGranted,false);
 assert.equal(other.accountVerified,false);
 const evidence=accountProbeEvidence(x.h.store,ledger);
 assert.equal(evidence.length,1);assert.equal(evidence[0].authRef,x.a.authRef);assert.equal(evidence[0].accountRef,x.a.accountRef);
 assert.equal(evidence[0].chargedMicros,288671);assert.equal(evidence[0].domain,'CUSTOM_PROBE');
 assert.equal(JSON.stringify(evidence).includes(x.definitionA.secretEnv),false);
});
test('an UNKNOWN settle, another probe row, or a replayed id is not evidence',t=>{
 const x=twoSources(t),account={authRef:x.a.authRef,accountRef:x.a.accountRef,provider:'deepseek-official',authentication:'api_key'};
 customReceipt(x.h.store,{probeId:'custom_probe_two',authRef:x.a.authRef,accountRef:x.a.accountRef,ledgerRequestIds:['req_unknown']});
 const unknown=createAccountProbeAuthority(x.h.store,()=>[known('req_unknown',{usageStatus:'UNKNOWN',customProbe:{probeId:'custom_probe_two'}})]);
 assert.equal(unknown.verified(account),false);
 const unfinished=createAccountProbeAuthority(x.h.store,()=>[known('req_unknown',{outcome:'RESTART_UNKNOWN',customProbe:{probeId:'custom_probe_two'}})]);
 assert.equal(unfinished.verified(account),false);
 const foreign=createAccountProbeAuthority(x.h.store,()=>[known('req_unknown',{customProbe:{probeId:'custom_probe_other'}})]);
 assert.equal(foreign.verified(account),false);
 const unpriced=createAccountProbeAuthority(x.h.store,()=>[known('req_unknown',{chargedMicros:null,customProbe:{probeId:'custom_probe_two'}})]);
 assert.equal(unpriced.verified(account),false);
 const wrongModel=createAccountProbeAuthority(x.h.store,()=>[known('req_unknown',{price:{provider:'deepseek-official',model:'deepseek-chat'},customProbe:{probeId:'custom_probe_two'}})]);
 assert.equal(wrongModel.verified(account),false);
});
test('an unsigned or foreign envelope cannot promote the account',t=>{
 const x=twoSources(t),account={authRef:x.a.authRef,accountRef:x.a.accountRef,provider:'deepseek-official',authentication:'api_key'},ledger=[known('req_signed',{customProbe:{probeId:'custom_probe_three'}})];
 customReceipt(x.h.store,{probeId:'custom_probe_three',authRef:x.a.authRef,accountRef:x.a.accountRef,ledgerRequestIds:['req_signed'],signed:false});
 customReceipt(x.h.store,{probeId:'custom_probe_three',authRef:x.a.authRef,accountRef:x.a.accountRef,ledgerRequestIds:['req_signed'],schema:'dream-maker.minimum-role-probe.v9'});
 assert.equal(accountProbeEvidence(x.h.store,ledger).length,0);
 assert.equal(createAccountProbeAuthority(x.h.store,()=>ledger).verified(account),false);
});
test('a subscription or membership leg that wrote no ledger row never qualifies',t=>{
 const x=twoSources(t),account={authRef:x.a.authRef,accountRef:x.a.accountRef,provider:'deepseek-official',authentication:'api_key'};
 customReceipt(x.h.store,{probeId:'custom_probe_four',authRef:x.a.authRef,accountRef:x.a.accountRef,ledgerRequestIds:[]});
 classicReceipt(x.h.store,{nonce:'DM_PROBE_subscription',ledgerRequestIds:[],authentication:'CHATGPT_SUBSCRIPTION',model:'gpt-6-luna'});
 assert.equal(accountProbeEvidence(x.h.store,[]).length,0);
 assert.equal(createAccountProbeAuthority(x.h.store,()=>[]).verified(account),false);
});
test('a reference-less paid executor receipt marks the API-key account of its provider only',t=>{
 const x=twoSources(t),ledger=[known('req_classic',{price:{provider:'deepseek-official',model:'deepseek-flash'}})];
 classicReceipt(x.h.store,{nonce:'DM_PROBE_paid',ledgerRequestIds:['req_classic']});
 const authority=createAccountProbeAuthority(x.h.store,()=>ledger),metered={authRef:x.a.authRef,accountRef:x.a.accountRef,provider:'deepseek-official',authentication:'api_key'};
 assert.equal(authority.verifiedEveryMetered([metered]),true);
 assert.equal(authority.verified({...metered,provider:'openai'}),false);
 assert.equal(authority.verified({...metered,authentication:'oauth'}),false);
 assert.equal(authority.verifiedEveryMetered([]),false);
 const evidence=accountProbeEvidence(x.h.store,ledger);
 assert.equal(evidence.length,1);assert.equal(evidence[0].authRef,null);assert.equal(evidence[0].role,'executor');
});
test('the account check accepts the derived flag and refuses a counterfeit one',async t=>{
 const {MagpieAccountChecks}=await import('../../dist/server/magpie-account-check.js'),h=harness(t),{p,s}=await ready(h);
 const role=id=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const configuration={mode:'custom',laya:false,accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE'}],roles:{planner2:role('planner2'),executors:[role('worker-one')],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_ACCOUNT_VERIFIED_PROFILE'),prep=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);
 const selection={projectId:p.id,specHash:s.hash,profileHash:profile.contentHash,preparation:{identityHash:prep.identityHash,contentHash:prep.contentHash}},signal=new AbortController().signal;
 const observation=verified=>({schema:'dream-maker.magpie-account-control-observation.v1',projectId:p.id,flowConfigHash:prep.flowConfigHash,sourceBindingHash:'f'.repeat(64),accountCount:1,processClosed:true,accountVerified:verified,modelVerified:false,customExecutionGranted:false});
 const passes=await new MagpieAccountChecks(h.store,()=>h.config,()=>({flowConfigHash:prep.flowConfigHash,sourceBindingHash:'f'.repeat(64)}),()=>true).check(selection,hash('OFFLINE_VERIFIED'),actor,signal,async()=>observation(true));
 assert.equal(passes.status,'PASSED');assert.equal(passes.accountVerified,true);assert.equal(passes.modelVerified,false);assert.equal(passes.customExecutionGranted,false);
 const latest=new MagpieAccountChecks(h.store,()=>h.config,()=>({flowConfigHash:prep.flowConfigHash,sourceBindingHash:'f'.repeat(64)}),()=>true).latest(p.id);
 assert.equal(latest.accountVerified,true);
 const counterfeit=await new MagpieAccountChecks(h.store,()=>h.config,()=>({flowConfigHash:prep.flowConfigHash,sourceBindingHash:'f'.repeat(64)}),()=>false).check(selection,hash('OFFLINE_COUNTERFEIT'),actor,signal,async()=>observation(true));
 assert.notEqual(counterfeit.status,'PASSED');assert.equal(counterfeit.accountVerified,false);assert.equal(counterfeit.modelVerified,false);
});
