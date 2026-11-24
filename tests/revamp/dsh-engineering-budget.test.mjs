// OFFLINE ledger boundaries. These permits are not native/model qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {NativeBudget} from '../../dist/server/native-budget.js';

const price={provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+3600000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:200000,outputMicrosPerMillion:8000000};
const authority={scopeId:'offline_engineering_scope',authorizationHash:'offline_authorization',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
const context=()=>({schema:'dream-maker.dsh-engineering-budget.v1',acceptanceId:'dsh_acceptance_offline',contractHash:'1'.repeat(64),configurationHash:'2'.repeat(64),dispatchId:'dispatch_offline',generation:'dispatch_owner_offline'});
function setup(t,uncapped=false){const dir=mkdtempSync(join(tmpdir(),'dm-engineering-budget-')),a=uncapped?{...authority,mode:'UNCAPPED',uncappedApproval:{approvedAt:new Date().toISOString(),approvedBy:'USER',statement:'OFFLINE_EXPLICIT_AUTHORIZATION',evidenceRef:'OFFLINE',supersedes:[]}}:authority,b=new NativeBudget(join(dir,'budget.sqlite'),a,()=>true);t.after(()=>{b.close();rmSync(dir,{recursive:true,force:true});});
 b.advance(Object.fromEntries(['planner1','planner2','executor','reviewer'].map(r=>[r,{evidenceId:'offline_'+r,model:'OFFLINE',source:'REAL_MODEL_RESPONSE'}])));b.verifyReceipt=()=>false;return b;}

test('engineering permit spends only a separately attributed bounded executor slice without promoting stale four-role proofs',t=>{
 const b=setup(t),p=b.beginEngineeringAcceptance(context());
 assert.throws(()=>b.reserve('executor',price,8192),{code:'PROBE_EVIDENCE_UNVERIFIED'});
 assert.throws(()=>b.reserve('executor',price,8192,p),{code:'NATIVE_PROBE_PERMIT_INVALID'});
 const r=b.reserveEngineering(p,price,8192,'3'.repeat(64));
 assert.deepEqual(r.engineeringAcceptance,{...context(),bodyHash:'3'.repeat(64)});assert.equal(r.binding,undefined);
 b.settle(r.id,null,'COMPLETE');b.endEngineeringAcceptance(p);
 assert.equal(b.summary().phase,'REPRESENTATIVE');assert.equal(b.requests().length,1);assert.equal(b.requests()[0].usageStatus,'UNKNOWN');
 assert.throws(()=>b.reserveEngineering(p,price,8192,'3'.repeat(64)),{code:'ENGINEERING_BUDGET_PERMIT_INVALID'});
 assert.throws(()=>b.reserve('executor',price,8192),{code:'PROBE_EVIDENCE_UNVERIFIED'});
});
test('engineering cannot borrow a probe permit, change provider/model/currency or replay a used acceptance identity',t=>{
 const b=setup(t),probe=b.beginEvidenceRepair('executor');
 assert.throws(()=>b.reserveEngineering(probe,price,8192,'3'.repeat(64)),{code:'ENGINEERING_BUDGET_PERMIT_INVALID'});b.endEvidenceRepair(probe);
 const p=b.beginEngineeringAcceptance(context());
 for(const patch of [{provider:'openai-official'},{model:'other'},{currency:'USD'}])assert.throws(()=>b.reserveEngineering(p,{...price,...patch},8192,'3'.repeat(64)),{code:'ENGINEERING_BUDGET_ROUTE_INVALID'});
 assert.throws(()=>b.reserveEngineering(p,price,8192,'not-a-hash'),{code:'ENGINEERING_BUDGET_SCOPE_INVALID'});
 assert.equal(b.requests().length,0);
 const r=b.reserveEngineering(p,price,8192,'3'.repeat(64));b.settle(r.id,null,'TRANSPORT_ERROR');b.endEngineeringAcceptance(p);
 assert.throws(()=>b.beginEngineeringAcceptance(context()),{code:'ENGINEERING_BUDGET_ID_REUSED'});
});
test('engineering has an eight physical request ceiling and retains every failed or unknown charge',t=>{
 const b=setup(t),p=b.beginEngineeringAcceptance(context());
 for(let i=0;i<8;i++){const r=b.reserveEngineering(p,price,8192,String(i).repeat(64));b.settle(r.id,null,'TRANSPORT_ERROR');}
 assert.throws(()=>b.reserveEngineering(p,price,8192,'9'.repeat(64)),{code:'ENGINEERING_BUDGET_REQUEST_LIMIT'});
 assert.equal(b.requests().length,8);assert.equal(b.summary().inFlight,0);assert.ok(b.summary().committedMicros>17000000);
});
test('engineering retains its own conservative money ceiling even with owner uncapped authorization',t=>{
 const b=setup(t,true),p=b.beginEngineeringAcceptance(context());
 const expensive={...price,inputMissMicrosPerMillion:25000000};
 assert.throws(()=>b.reserveEngineering(p,expensive,8192,'3'.repeat(64)),{code:'ENGINEERING_BUDGET_COST_LIMIT'});
 assert.equal(b.requests().length,0);
});
test('boxed or coercing acceptance identities cannot escape eight-request accounting',t=>{
 const b=setup(t,true);let conversions=0;
 for(const acceptanceId of [new String('dsh_acceptance_boxed'),{toString(){conversions++;return 'dsh_acceptance_coercing';}}])assert.throws(()=>b.beginEngineeringAcceptance({...context(),acceptanceId}),{code:'ENGINEERING_BUDGET_SCOPE_INVALID'});
 assert.equal(conversions,0);assert.equal(b.requests().length,0);
});
