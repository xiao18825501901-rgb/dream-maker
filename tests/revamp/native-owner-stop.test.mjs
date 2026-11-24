// Isolated original monetary controller; no network, credential or actual provider request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createNativeOwner} from '../../dist/server/native-owner.js';
import {hash} from '../../dist/server/security.js';
import {harness} from '../helpers.mjs';

test('stopping native admission aborts tickets while retaining their ledger for actual late settlement',async t=>{
 let owner;t.after(()=>owner?.close());const h=harness(t);h.config.planner1.model='OFFLINE_OWNER_STOP';
 const authority={scopeId:'OFFLINE_STOP_SCOPE',authorizationHash:'OFFLINE_NOT_LIVE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
 const ref=(name,value)=>{const path=resolve(h.dir,name),bytes=JSON.stringify(value);writeFileSync(path,bytes);return {path,sha256:hash(bytes)};};
 const auth=ref('authority.json',authority),price=ref('price.json',{provider:'openai-official',model:h.config.planner1.model,currency:'CNY',source:'OFFLINE_NOT_AN_INVOICE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
 mkdirSync(resolve(h.dir,'config'));writeFileSync(resolve(h.dir,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:h.dir,authority:auth,prices:{planner1:price},maxOutputTokens:128,maxRequests:5}));
 owner=createNativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config});const route={baseUrl:'https://api.openai.com/v1',model:h.config.planner1.model,protocol:'openai-responses',maxOutputTokens:128};
 const ticket=owner.paidGuard(route);assert.equal(typeof owner.stopRequests,'function');owner.stopRequests();assert.equal(ticket.signal.aborted,true);assert.throws(()=>owner.paidGuard(route),{code:'NATIVE_OWNER_STOPPING'});
 ticket.settle({input_tokens:10,output_tokens:2},'OFFLINE_SETTLED_AFTER_STOP');await owner.close();
 const history=owner.budgetStatus();assert.equal(history.requests,1);assert.equal(history.readOnly,true);assert.equal(history.historyState,'FROZEN_AT_CLOSE');assert.ok(Number.isFinite(Date.parse(history.observedAt)));
 const db=new DatabaseSync(resolve(h.dir,'.runtime/controller/native-budget.sqlite'),{readOnly:true});try{const rows=db.prepare('SELECT data FROM requests').all().map(row=>JSON.parse(row.data));assert.equal(rows.length,1);assert.equal(rows[0].usageStatus,'KNOWN');assert.equal(rows[0].chargedMicros,36);}finally{db.close();}
});
