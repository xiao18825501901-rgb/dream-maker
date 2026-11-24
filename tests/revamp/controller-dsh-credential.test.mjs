// Synthetic credentials only; no User/Machine registry writes or model requests.
import test from 'node:test';import assert from 'node:assert/strict';
import * as credentials from '../../dist/server/controller-dsh-credential.js';
import {childEnv,redact} from '../../dist/server/security.js';
const config={model:'deepseek-flash',keyEnv:'DEEPSEEK_API_KEY',modulePath:''};
const reference='windows-user:Dream_Maker_dsh',fake='OFFLINE_DSH_CREDENTIAL_NOT_A_REAL_KEY';

test('normal launch keeps the existing session credential and never discovers Windows accounts',()=>{
 let reads=0;const env={DEEPSEEK_API_KEY:'existing-offline-key'};
 const result=credentials.installDshControllerCredential(config,{env,readUser:()=>{reads++;return fake;}});
 assert.equal(reads,0);assert.equal(result.installed,false);result.restore();assert.deepEqual(env,{DEEPSEEK_API_KEY:'existing-offline-key'});
});

test('an explicit owner reference is mapped only into the trusted controller process',()=>{
 const env={DM_DSH_CREDENTIAL_REFERENCE:reference},calls=[];
 const result=credentials.installDshControllerCredential(config,{env,readUser:()=>{calls.push('WINDOWS_USER');return fake;}});
 assert.deepEqual(calls,['WINDOWS_USER']);assert.equal(env.DEEPSEEK_API_KEY,fake);assert.equal(result.reference,reference);
 assert.equal(JSON.stringify(result).includes(fake),false);assert.equal(result.installed,true);result.restore();assert.equal(env.DEEPSEEK_API_KEY,undefined);
});

test('the selected reference cannot read another account, change another role, or overwrite PATH',()=>{
 let reads=0;const readUser=()=>{reads++;return fake;};
 for(const [selected,configured]of [['windows-user:OPENAI_API_KEY',config],['windows-machine:Dream_Maker_dsh',config],[reference,{...config,keyEnv:'PATH'}],[reference,{...config,model:'other-model'}]])
  assert.throws(()=>credentials.installDshControllerCredential(configured,{env:{DM_DSH_CREDENTIAL_REFERENCE:selected},readUser}),{code:'DSH_CREDENTIAL_REFERENCE_DENIED'});
 assert.equal(reads,0);
});

test('a different existing session credential refuses replacement without modifying it',()=>{
 const env={DM_DSH_CREDENTIAL_REFERENCE:reference,DEEPSEEK_API_KEY:'another-offline-key'};
 assert.throws(()=>credentials.installDshControllerCredential(config,{env,readUser:()=>fake}),{code:'DSH_CREDENTIAL_REFERENCE_CONFLICT'});
 assert.equal(env.DEEPSEEK_API_KEY,'another-offline-key');
});

test('an identical session key can be selected and restored without losing the original session',()=>{
 const env={DM_DSH_CREDENTIAL_REFERENCE:reference,DEEPSEEK_API_KEY:fake};
 const result=credentials.installDshControllerCredential(config,{env,readUser:()=>fake});result.restore();assert.equal(env.DEEPSEEK_API_KEY,fake);
});

test('missing, malformed and failed reads return a safe error without exposing any reader output',()=>{
 for(const readUser of [()=>'',()=>fake+'\nsecond-line',()=>{throw Error(fake);},()=> 'x'.repeat(8193)]){
  const env={DM_DSH_CREDENTIAL_REFERENCE:reference};assert.throws(()=>credentials.installDshControllerCredential(config,{env,readUser}),e=>e.code==='DSH_CREDENTIAL_REFERENCE_UNAVAILABLE'&&!String(e).includes(fake));assert.equal(env.DEEPSEEK_API_KEY,undefined);
 }
});

test('restoring one installation cannot undo a later explicit secret rotation',()=>{
 const env={DM_DSH_CREDENTIAL_REFERENCE:reference};const result=credentials.installDshControllerCredential(config,{env,readUser:()=>fake});
 env.DEEPSEEK_API_KEY='new-offline-key';result.restore();assert.equal(env.DEEPSEEK_API_KEY,'new-offline-key');
});

test('native child environments omit the real key and controller diagnostics redact it',t=>{
 const prior=process.env.DEEPSEEK_API_KEY,selected=process.env.DM_DSH_CREDENTIAL_REFERENCE;
 t.after(()=>{if(prior===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=prior;if(selected===undefined)delete process.env.DM_DSH_CREDENTIAL_REFERENCE;else process.env.DM_DSH_CREDENTIAL_REFERENCE=selected;});
 delete process.env.DEEPSEEK_API_KEY;process.env.DM_DSH_CREDENTIAL_REFERENCE=reference;
 const result=credentials.installDshControllerCredential(config,{readUser:()=>fake});
 try{assert.equal(childEnv().DEEPSEEK_API_KEY,undefined);assert.equal(childEnv().DM_DSH_CREDENTIAL_REFERENCE,undefined);assert.equal(redact(fake),'[REDACTED]');}
 finally{result.restore();}
});
