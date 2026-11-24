// OFFLINE counter fixtures only. A synthetic counter cannot authorize real recovery.
import test from 'node:test';import assert from 'node:assert/strict';
const reader=()=>({inspectorSha256:'e'.repeat(64),readerSha256:'f'.repeat(64)});
async function check(witness,current,scope='a'.repeat(64),reading=reader()){return(await import('../dist/server/flow/windows-job-recovery.js')).checkWindowsUptimeReset(witness,current,scope,reading);}
const witness=()=>({schema:'dream-maker.windows-uptime-witness.v1',scopeHash:'a'.repeat(64),...reader(),measurement:{schema:'dream-maker.windows-uptime.v1',source:'KERNEL32_GET_TICK_COUNT_64',hostHash:'c'.repeat(64),milliseconds:'36000000'}});
const current=milliseconds=>({schema:'dream-maker.windows-uptime.v1',source:'KERNEL32_GET_TICK_COUNT_64',hostHash:'c'.repeat(64),milliseconds});
test('a reset after a durable scope-bound counter can end an old process epoch, never a model result',async()=>{
 const result=await check(witness(),current('120000'));assert.equal(result.basis,'WINDOWS_UPTIME_RESET_AFTER_DURABLE_WITNESS');assert.equal(result.modelCompletionClaim,false);
});
for(const value of ['36000000','36000001'])test('same boot counter '+value+' preserves the old lease',async()=>{await assert.rejects(check(witness(),current(value)),{code:'WINDOWS_RESTART_REQUIRED_FOR_OWNERSHIP'});});
for(const [name,alter] of [
 ['different scope',w=>w.scopeHash='b'.repeat(64)],['wrong source',w=>w.measurement.source='USER_CONFIRMED'],['ambiguous overflowing counter',w=>w.measurement.milliseconds='18446744073709551615']
])test('uptime recovery rejects '+name,async()=>{const w=witness();alter(w);await assert.rejects(check(w,current('120000')),{code:'WINDOWS_INTENT_OBSERVATION_UNPROVEN'});});
test('another computer cannot clear an old machine process lease',async()=>{
 const next=current('120000');next.hostHash='d'.repeat(64);await assert.rejects(check(witness(),next),{code:'WINDOWS_INTENT_OBSERVATION_UNPROVEN'});
});
for(const field of ['inspectorSha256','readerSha256'])test('a changed '+field+' cannot clear the old lease even after a lower counter',async()=>{
 const reading=reader();reading[field]='b'.repeat(64);
 await assert.rejects(check(witness(),current('120000'),'a'.repeat(64),reading),{code:'WINDOWS_INTENT_OBSERVATION_UNPROVEN'});
});
test('a legacy witness without the fixed reader fingerprint remains blocked',async()=>{
 const w=witness();delete w.readerSha256;
 await assert.rejects(check(w,current('120000')),{code:'WINDOWS_INTENT_OBSERVATION_UNPROVEN'});
});
