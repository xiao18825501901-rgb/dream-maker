// Offline assembly admission tests, no model transport or native-audit promotion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeOwner} from '../dist/server/native-owner.js';
import {harness,ready,root} from './helpers.mjs';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {hash} from '../dist/server/security.js';
import {NativeBudget} from '../dist/server/native-budget.js';
test('missing local operator binding blocks native owner without creating a budget or reading credentials',async t=>{
 const h=harness(t);let reads=0;
 const owner=createNativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,getSecret:()=>{reads++;throw Error('MUST_NOT_READ');}});
 assert.throws(()=>owner.assertReady('build'),{code:'NATIVE_OPERATOR_CONFIG_REQUIRED'});
 assert.equal(reads,0);await owner.close();
});

test('verification refuses a different oracle hash even when the old spec-level marker exists',async t=>{
 let owner;t.after(()=>owner?.close());const h=harness(t),{p,s}=await ready(h);
 const r=h.engine.create(p.id,s.hash,true);await h.engine.cancel(r.id);await h.engine.settled(r.id);
 const authority={scopeId:'OFFLINE_ORACLE_SCOPE',authorizationHash:'OFFLINE_ORACLE_AUTHORITY',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
 const authorityPath=resolve(h.dir,'authority.json');writeFileSync(authorityPath,JSON.stringify(authority));
 const oracleRoot=resolve(h.dir,'oracles');mkdirSync(oracleRoot);const path=resolve(oracleRoot,'plan.json');
 writeFileSync(path,JSON.stringify({schema:'dream-maker.cli-verifier.v1',specHash:s.hash,cases:[{id:'case1',requirementIds:s.requirements.map(x=>x.id),runtime:'node',entry:'main.mjs',args:[],stdin:'',expectedExitCode:0,expectedStdout:'new expectation\n'}]}));
 mkdirSync(resolve(h.dir,'config'));writeFileSync(resolve(h.dir,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:h.dir,
  authority:{path:authorityPath,sha256:hash(readFileSync(authorityPath))},oracleRoot,oracles:{[s.hash]:{relativePath:'plan.json',sha256:hash(readFileSync(path))}},maxOutputTokens:128,maxRequests:5}));
 owner=createNativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config});
 h.store.approve(p.id,s.hash,'VERIFIER');h.store.record('VerifierApproval',p.id,null,{specHash:s.hash,planHash:'0'.repeat(64),source:'OFFLINE_OLD_APPROVAL_NOT_LIVE'});
 await assert.rejects(owner.verify({runId:r.id,specHash:s.hash,workspace:r.workspace,role:'executor',prompt:JSON.stringify({spec:s}),model:'deepseek-flash',signal:AbortSignal.abort()},()=>{}),{code:'TRUSTED_VERIFIER_APPROVAL_REQUIRED'});
});

test('owned planner reservation cancellation stays unknown on close and does not reset the ledger',async t=>{
 let owner; t.after(()=>owner?.close());const h=harness(t);h.config.planner1.model='OFFLINE_OWNER_MODEL';
 const authority={scopeId:'OFFLINE_OWNER_SCOPE',authorizationHash:'OFFLINE_AUTHORITY_NOT_LIVE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
 function ref(name,value){const path=resolve(h.dir,name);writeFileSync(path,JSON.stringify(value));return{path,sha256:hash(readFileSync(path))};}
 const a=ref('authority.json',authority),q=ref('price.json',{provider:'openai-official',model:h.config.planner1.model,currency:'CNY',source:'OFFLINE_PRICE_NOT_INVOICE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
 mkdirSync(resolve(h.dir,'config'));writeFileSync(resolve(h.dir,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:h.dir,authority:a,prices:{planner1:q},maxOutputTokens:128,maxRequests:5}));
 owner=createNativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config});
 owner.reserveRepair('run_offline');owner.reserveRepair('run_offline');assert.throws(()=>owner.reserveRepair('run_offline'),{code:'NATIVE_REPAIR_LIMIT_EXCEEDED'});
 const ticket=owner.paidGuard({baseUrl:'https://api.openai.com/v1',model:h.config.planner1.model,protocol:'openai-responses',maxOutputTokens:128});
 assert.ok(ticket.signal instanceof AbortSignal);
 await owner.close();assert.equal(ticket.signal.aborted,true);
 ticket.settle({input_tokens:1,output_tokens:1},'LATE_OFFLINE_RESULT');
 const b=new NativeBudget(resolve(h.dir,'.runtime/controller/native-budget.sqlite'),authority);
 try{assert.equal(b.requests().length,1);assert.equal(b.requests()[0].usageStatus,'UNKNOWN');assert.equal(b.summary().committedMicros,2098176);}finally{b.close();}
});
