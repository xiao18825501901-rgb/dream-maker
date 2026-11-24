// OFFLINE: the probe must accept exactly the account/model pair the route itself accepts.
import test from 'node:test';import assert from 'node:assert/strict';
import {probeAccountMatches} from '../../dist/server/flow/custom-probe-runtime.js';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {hash} from '../../dist/server/security.js';

test('qualification reads only the frozen Magpie API-key sources, once each after all identities match',()=>{
 const owner=Object.create(NativeOwner.prototype),reads=[];
 owner.context={getSecret(name){reads.push(name);return 'offline-fixture-value';}};
 const catalog=Array.from({length:11},(_,i)=>({provider:'fixture-'+i,authRef:'auth-'+i,accountRef:'account-'+i,authentication:'api_key',secretEnv:'fixture_'+i}));
 const role=(i,transport='magpie',authentication='API_KEY')=>({...catalog[i],transport,authentication});
 const roles=[role(3),role(0,'magpie','CHATGPT_SUBSCRIPTION'),role(1,'native'),role(3),role(5)];
 const expected=hash([catalog[3],catalog[5]].map(({authRef,accountRef})=>({authRef,accountRef,generationHash:hash('offline-fixture-value')})));
 assert.equal(owner.customProbeCredentialHash(roles,catalog),expected);
 assert.deepEqual(reads,['fixture_3','fixture_5']);
 for(const change of [{accountRef:'different'},{provider:'different'},{authRef:'missing'}]){
  reads.length=0;
  assert.throws(()=>owner.customProbeCredentialHash([...roles,{...role(6),...change}],catalog),{code:'CUSTOM_ACCOUNT_SOURCE_MISMATCH'});
  assert.deepEqual(reads,[]);
 }
});
const actor={roleId:'planner2',role:'planner2',provider:'deepseek-official',model:'deepseek-chat',authRef:'AUTH',accountRef:'ACCOUNT'};
const base={provider:'deepseek-official',authRef:'AUTH',accountRef:'ACCOUNT'};
test('a model set admits every declared model and nothing else',()=>{
 const account={...base,model:'deepseek-flash',models:['deepseek-flash','deepseek-chat','deepseek-reasoner']};
 assert.equal(probeAccountMatches(account,actor),true);
 assert.equal(probeAccountMatches(account,{...actor,model:'deepseek-flash'}),true);
 assert.equal(probeAccountMatches(account,{...actor,model:'gpt-6-luna'}),false);
});
test('a single-model account still matches only its own model',()=>{
 const account={...base,model:'deepseek-chat'};
 assert.equal(probeAccountMatches(account,actor),true);
 assert.equal(probeAccountMatches(account,{...actor,model:'deepseek-flash'}),false);
});
test('identity drift never matches even when the model is right',()=>{
 for(const drift of [{authRef:'OTHER'},{accountRef:'OTHER'},{provider:'openai'}])
  assert.equal(probeAccountMatches({...base,model:'deepseek-chat',...drift},actor),false);
});
