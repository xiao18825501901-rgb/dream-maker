// OFFLINE validation scope; no external credentials or process-wide setting changes.
import test from 'node:test';import assert from 'node:assert/strict';import * as security from '../../dist/server/security.js';
test('explicit metadata checks do not enumerate ambient credentials, while normal log redaction stays intact',()=>{
 const original=process.env,canary='SyntheticAmbientCredentialValue12345',fixture={...original,DM_CUSTOM_SCOPE_TEST_API_KEY:canary};let scans=0;
 process.env=new Proxy(fixture,{ownKeys(target){scans++;return Reflect.ownKeys(target);}});
 try{
  assert.equal(security.hasSecret(canary),true);scans=0;
  assert.equal(security.withExplicitSecretInspection([],()=>security.hasSecret(canary)),false);assert.equal(scans,0);
  assert.equal(security.withExplicitSecretInspection([],()=>security.hasSecret('sk-'+'x'.repeat(20))),true);
  assert.equal(security.withExplicitSecretInspection(['short'],()=>security.hasSecret('short')),true);
  assert.equal(security.withExplicitSecretInspection([],()=>security.redact(canary)),'[REDACTED]');
  assert.equal(security.hasSecret(canary),true);
 }finally{process.env=original;}
});
test('selected-value validation is isolated, handles escaped values and restores after a throw',async()=>{
 const one='SelectedValueOne12345',two='SelectedValueTwo12345',escaped='Selected"Escaped\\Value12345';
 assert.throws(()=>security.withExplicitSecretInspection([one],()=>{assert.equal(security.hasSecret(one),true);throw Error('OFFLINE_EXPECTED');}),/OFFLINE_EXPECTED/);
 const result=await Promise.all([security.withExplicitSecretInspection([one],async()=>{await Promise.resolve();return[security.hasSecret(one),security.hasSecret(two)];}),security.withExplicitSecretInspection([two],async()=>{await Promise.resolve();return[security.hasSecret(one),security.hasSecret(two)];})]);
 assert.deepEqual(result,[[true,false],[false,true]]);assert.equal(security.withExplicitSecretInspection([escaped],()=>security.hasSecret(JSON.stringify(escaped))),true);
});
