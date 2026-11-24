// OFFLINE: injected runner events, isolated original Store. No model, login or Native receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createKimiPlanner1Probe} from '../../dist/server/kimi-planner1-probe.js';
import {DomainError,hash} from '../../dist/server/security.js';
import {harness} from '../helpers.mjs';

const challenge='DM_PROBE_'+'a'.repeat(32),sessionId='session_offline_lifecycle',promptId='prompt_offline_lifecycle';
const getConfig=()=>({planner1:{provider:'kimi',model:'kimi-code/kimi-for-coding',accountRef:'kimi:offline-lifecycle'}});
const credentials={barrier:()=>'READY',current:()=>({status:'OK',generation:7})};
const invoke=probe=>probe(challenge,new AbortController().signal,'F:/DreamMakerSuite/temp/offline-probe');
function completed(input,onEvent,extra={}){
 const text=JSON.stringify({probe:challenge});
 onEvent({method:'dm/kimiAccepted',params:{sessionId,promptId,...extra}});
 onEvent({method:'dm/kimiCompletion',params:{sessionId,promptId,rawInputTokens:10,cacheReadTokens:2,billableInputTokens:8,answerHash:hash(text),...extra}});
 onEvent({method:'dm/kimiReceipt',params:{sessionId,promptId,turnId:'turn_offline',reason:'completed',answerChars:text.length,...extra}});
 onEvent({method:'dm/kimiArchive',params:{sessionId,archived:true,...extra}});
 return {text,sessionId,usage:{inputTokens:8,outputTokens:3,costUsd:null},receipt:{sessionId,promptId,turnId:'turn_offline',answerHash:hash(text)}};
}

test('accepted then failed polling retains request identity and unknown cost in the original Store',async t=>{
 const h=harness(t),failure=new DomainError('KIMI_SERVER_TOKEN_MISSING',409);let calls=0;
 const runner={async run(input,onEvent){calls++;onEvent({method:'dm/kimiAccepted',params:{sessionId,promptId}});onEvent({method:'dm/kimiArchive',params:{sessionId,archived:false}});throw failure;}};
 const probe=createKimiPlanner1Probe({getConfig,runner,credentials,onLifecycle:event=>{h.store.record('Planner1ProbeLifecycle',null,null,event);}});
 await assert.rejects(invoke(probe),e=>e===failure);
 const rows=h.store.db.prepare('SELECT data FROM records WHERE project_id IS NULL AND kind=? ORDER BY rowid').all('Planner1ProbeLifecycle').map(r=>JSON.parse(r.data));
 assert.equal(calls,1);assert.deepEqual(rows.map(r=>r.stage),['STARTED','ACCEPTED','ARCHIVE','FAILED']);
 assert.equal(rows[1].sessionId,sessionId);assert.equal(rows[1].promptId,promptId);assert.equal(rows[2].archived,false);
 assert.equal(rows.at(-1).code,'KIMI_SERVER_TOKEN_MISSING');assert.equal(rows.at(-1).sessionId,sessionId);
 assert.ok(rows.every(r=>r.costStatus==='UNKNOWN'&&r.costCny===null&&r.costUsd===null));
 assert.ok(rows.every(r=>r.attemptId==='probe_'+hash(challenge).slice(0,20)&&r.credentialGeneration===7));
});

test('successful observation journals fixed metadata without promoting it into signed qualification',async()=>{
 const events=[],secret='DO_NOT_LOG_SECRET_VALUE';let calls=0;
 const runner={async run(input,onEvent){calls++;return completed(input,onEvent,{token:secret,text:secret,accountRef:secret,arbitrary:{authorization:secret}});}};
 const probe=createKimiPlanner1Probe({getConfig,runner,credentials,onLifecycle:e=>{events.push(e);}});
 await invoke(probe);assert.equal(calls,1);
 assert.deepEqual(events.map(e=>e.stage),['STARTED','ACCEPTED','COMPLETED','RECEIPT','ARCHIVE','VALIDATED']);
 assert.equal(events[2].rawInputTokens,10);assert.equal(events[2].billableInputTokens,8);assert.equal(events.at(-1).outputTokens,3);
 assert.equal(events[3].turnId,'turn_offline');assert.equal(events[4].archived,true);
 const serialized=JSON.stringify(events);assert.equal(serialized.includes(secret),false);assert.equal(serialized.includes(challenge),false);
 assert.ok(events.every(e=>e.evidence==='RUNNER_OBSERVATION_NOT_NATIVE_QUALIFICATION'));
 assert.ok(events.every(e=>e.model==='kimi-code/kimi-for-coding'&&/^[a-f0-9]{64}$/.test(e.accountFingerprint)));
});

test('a failed durable start journal refuses before a model can be dispatched',async()=>{
 let calls=0;const runner={async run(input,onEvent){calls++;return completed(input,onEvent);}};
 const probe=createKimiPlanner1Probe({getConfig,runner,credentials,onLifecycle(){throw Error('private storage error');}});
 await assert.rejects(invoke(probe),{code:'KIMI_PROBE_JOURNAL_UNAVAILABLE'});assert.equal(calls,0);
});

test('journal failure after acceptance cannot issue qualification or retry the physical request',async()=>{
 let calls=0;const events=[];
 const runner={async run(input,onEvent){calls++;try{return completed(input,onEvent);}finally{onEvent({method:'dm/kimiArchive',params:{sessionId,archived:false}});}}};
 const probe=createKimiPlanner1Probe({getConfig,runner,credentials,onLifecycle:e=>{events.push(e);if(e.stage==='ACCEPTED')throw Error('write unavailable');}});
 await assert.rejects(invoke(probe),{code:'KIMI_PROBE_JOURNAL_UNAVAILABLE'});assert.equal(calls,1);
 assert.equal(events.some(e=>e.stage==='VALIDATED'),false);assert.equal(events.some(e=>e.stage==='ARCHIVE'),true);
});

test('event floods and invalid peer fields cannot expand the durable journal',async()=>{
 const events=[];const runner={async run(input,onEvent){for(let i=0;i<100;i++)onEvent({method:'dm/unknown',params:{secret:'not recorded'}});const out=completed(input,onEvent,{rawInputTokens:Infinity,cacheReadTokens:-1});for(let i=0;i<100;i++)onEvent({method:'dm/kimiArchive',params:{sessionId,archived:true,secret:'not recorded'}});return out;}};
 await invoke(createKimiPlanner1Probe({getConfig,runner,credentials,onLifecycle:e=>{events.push(e);}}));
 assert.equal(events.length,6);assert.equal(events[2].rawInputTokens,null);assert.equal(events[2].cacheReadTokens,null);
 assert.equal(JSON.stringify(events).includes('not recorded'),false);
});

test('a runner swallowing archive observer failure still cannot obtain qualification',async()=>{
 let calls=0;const runner={async run(input,onEvent){calls++;const out=completed(input,event=>{try{onEvent(event);}catch(error){if(event.method!=='dm/kimiArchive')throw error;}});return out;}};
 const probe=createKimiPlanner1Probe({getConfig,runner,credentials,onLifecycle:e=>{if(e.stage==='ARCHIVE')throw Error('archive journal write unavailable');}});
 await assert.rejects(invoke(probe),{code:'KIMI_PROBE_JOURNAL_UNAVAILABLE'});assert.equal(calls,1);
});
