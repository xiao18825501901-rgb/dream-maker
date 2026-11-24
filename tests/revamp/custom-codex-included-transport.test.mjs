// Offline request authorization checks. No Codex process, account, budget database or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {MagpieDshRequestTransport} from '../../dist/server/magpie-model-transport.js';
import {magpieRouteHash} from '../../dist/server/magpie-route.js';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {hash} from '../../dist/server/security.js';

const model='gpt-6-luna', fingerprint='a'.repeat(64);
const route={runtime:'codex',provider:'openai',protocol:'openai-responses',model,authentication:'oauth',authRef:'synthetic-auth',accountRef:'synthetic-account',upstreamAccountRef:'openai/'+fingerprint};
const path='/backend-api/codex/responses';

for(const [label,credential,code] of [
 ['absent',undefined,'CODEX_SUBSCRIPTION_GATEWAY_REQUIRED'],
 ['malformed header',{authorization:'Basic synthetic'},'CODEX_SUBSCRIPTION_GATEWAY_REQUIRED'],
 ['copied account metadata',{authorization:'Bearer synthetic',turn:{runId:'synthetic_run',specHash:fingerprint,accountFingerprint:fingerprint,model,threadId:'synthetic_thread'}},'CODEX_INCLUDED_TURN_INVALID'],
]){
 test('subscription transport refuses '+label+' before requesting a Magpie grant',async()=>{
  let grants=0,sends=0;
  const transport=new MagpieDshRequestTransport({
   route,role:'planner2',planner:{model,maxOutputTokens:64,prompt:'test',instructions:'test'},
   session:{observation:{address:'127.0.0.1:1'},prepareModelPayload:(_,body)=>({body,method:'POST',bodyHash:hash(body),routeHash:magpieRouteHash(route),route,path,maxOutputTokens:64}),control:{prepare(){grants++;throw Error('unexpected grant')}}},
   budget:{includedPlannerCheck:NativeBudget.prototype.includedPlannerCheck.bind({includedHolds:new Map()}),pendingBoundRequest:()=>({price:{provider:'openai',model},maxOutputTokens:64})},
   bindRequest:p=>({schema:'dream-maker.native-request-binding.v1',projectId:'synthetic_project',runId:'synthetic_run',engineeringMode:'custom',configurationHash:fingerprint,planVersionHash:fingerprint,specHash:fingerprint,dispatchId:'test_dispatch',generation:'test_owner',role:'planner2',roleId:'planner2',work:{kind:'SUPERVISION'},routeHash:p.routeHash,bodyHash:p.bodyHash}),
   assertCurrent(){},transport(){sends++;throw Error('unexpected send')}
  });
  assert.equal(transport.responseModel,model);
  const request=transport.prepare('{}');
  await assert.rejects(transport.send(request,'test_hold',new AbortController().signal,credential),{code});
  assert.equal(grants,0);assert.equal(sends,0);
 });
}
