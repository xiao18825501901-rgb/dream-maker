// OFFLINE: the subscription planner1 probe is proved from a real runner's answer, never from a
// caller-written observation. Every case here injects the runner so no model, bridge or network runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
const {createKimiPlanner1Probe}=await import('../dist/server/kimi-planner1-probe.js');
const {hash}=await import('../dist/server/security.js');
const sha=v=>createHash('sha256').update(v).digest('hex');
const challenge=()=>'DM_PROBE_'+randomBytes(16).toString('hex');
const config=(provider='kimi')=>()=>({planner1:{provider,model:'kimi-code/kimi-for-coding',accountRef:'kimi:acct-1',authMode:'api_key',keyEnv:'OPENAI_API_KEY',protocol:'openai-responses',baseUrl:'https://api.openai.com/v1'}});
const okCredentials=(over={})=>({barrier:()=>'READY',current:()=>({status:'OK',token:{},generation:7,messageId:'m',savedAtMs:1}),...over});
function fakeRunner({reply,archived=true,turnId='turn_1',sessionId='session_abc',answerHash=sha('answer')}={}){
 const seen=[];
 const run=async(input,onEvent)=>{
  seen.push(input);
  if(sessionId)onEvent({method:'dm/kimiArchive',params:{sessionId,archived}});
  let text=reply;
  if(text===undefined){const m=/\{"probe":"([^"]+)"\}/.exec(input.prompt);text=JSON.stringify({probe:m?m[1]:''});}
  return{text,sessionId,receipt:{turnId,reason:'completed',answerChars:text.length,answerHash,sessionId,promptId:'p1',source:'REST_TRANSCRIPT'}};
 };
 return{run,seen};
}
const invoke=(probe,ch=challenge())=>probe(ch,new AbortController().signal,'C:/tmp/probe');

test('a real echoed challenge yields a subscription observation with the spending generation',async()=>{
 const ch=challenge(),runner=fakeRunner(),probe=createKimiPlanner1Probe({getConfig:config(),runner,credentials:okCredentials()});
 const out=await invoke(probe,ch);
 assert.equal(out.role,'planner1');assert.equal(out.runner,'KIMI_SERVER');assert.equal(out.provider,'kimi-official');
 assert.equal(out.authentication,'MEMBER_SUBSCRIPTION');assert.equal(out.reply,ch);assert.equal(out.credentialGeneration,7);
 assert.deepEqual(out.ledgerRequestIds,[]);assert.equal(out.paidFallback,false);assert.equal(out.cleanupReturned,true);
 assert.equal(out.accountFingerprint,hash({accountRef:'kimi:acct-1',generation:7}));
 assert.match(out.accountFingerprint,/^[a-f0-9]{64}$/);
 assert.equal(runner.seen.length,1);assert.equal(runner.seen[0].model,'kimi-code/kimi-for-coding');
 assert.equal(runner.seen[0].laya.mode,'off');
});
for(const [name,reply] of [['an answer that does not echo the challenge','DM_PROBE_somethingelse'],['an answer that echoes a different challenge',challenge()]])
 test(name+' cannot seal a probe',async()=>{
  const probe=createKimiPlanner1Probe({getConfig:config(),runner:fakeRunner({reply:JSON.stringify({probe:reply.split('DM_PROBE_')[1]??reply})}),credentials:okCredentials()});
  await assert.rejects(invoke(probe),{code:'NATIVE_PROBE_KIMI_REPLY_UNVERIFIED'});
 });
test('an unarchived session is a leaked session, not a clean probe',async()=>{
 const probe=createKimiPlanner1Probe({getConfig:config(),runner:fakeRunner({archived:false}),credentials:okCredentials()});
 await assert.rejects(invoke(probe),{code:'KIMI_PROBE_CLEANUP_UNVERIFIED'});
});
test('a credential that is not restored or not persisted is refused before any turn',async()=>{
 for(const [credentials,code] of [[okCredentials({barrier:()=>'PENDING'}),'KIMI_RESTORE_NOT_READY'],
  [okCredentials({current:()=>({status:'MISSING'})}),'KIMI_CREDENTIALS_MISSING'],
  [okCredentials({current:()=>({status:'OK',generation:0})}),'KIMI_CREDENTIAL_GENERATION_INVALID']]){
  const runner=fakeRunner();
  await assert.rejects(invoke(createKimiPlanner1Probe({getConfig:config(),runner,credentials})),{code});
  assert.equal(runner.seen.length,0);
 }
});
test('no durable authority means no provable generation, so no probe',async()=>{
 const runner=fakeRunner();
 await assert.rejects(invoke(createKimiPlanner1Probe({getConfig:config(),runner})),{code:'KIMI_PROBE_AUTHORITY_REQUIRED'});
 assert.equal(runner.seen.length,0);
});
test('a retired planner1 provider cannot be probed through the subscription path',async()=>{
 const runner=fakeRunner();
 await assert.rejects(invoke(createKimiPlanner1Probe({getConfig:config('openai'),runner,credentials:okCredentials()})),{code:'PLANNER1_RUNNER_ROUTE_MISMATCH'});
 assert.equal(runner.seen.length,0);
});
test('a malformed challenge never reaches the runner',async()=>{
 const runner=fakeRunner();
 await assert.rejects(invoke(createKimiPlanner1Probe({getConfig:config(),runner,credentials:okCredentials()}),'not-a-challenge'),{code:'NATIVE_PROBE_CHALLENGE_INVALID'});
 assert.equal(runner.seen.length,0);
});
