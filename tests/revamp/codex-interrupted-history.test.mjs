// Pure OFFLINE transcript counterexamples; no credentials, RPC or model.
import test from 'node:test';import assert from 'node:assert/strict';
import * as history from '../../dist/server/providers/codex-history.js';import {hash} from '../../dist/server/security.js';
const input={threadId:'OFFLINE_THREAD',model:'OFFLINE_MODEL',inputHash:hash('original input')};
const message=text=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
const rows=()=>[{type:'session_meta',payload:{id:input.threadId}},{type:'event_msg',payload:{type:'task_started',turn_id:'OFFLINE_TURN'}},
 message('<environment_context>\n  <current_date>2026-11-06</current_date>\n  <timezone>Asia/Shanghai</timezone>\n</environment_context>'),
 {type:'turn_context',payload:{turn_id:'OFFLINE_TURN',cwd:'F:/OFFLINE/packet',model:input.model,approval_policy:'never'}},message('original input')];
const validate=r=>history.validateInterruptedTranscript(Buffer.from(r.map(x=>JSON.stringify(x)).join('\n')),input,'F:/OFFLINE/packet');
test('exact unique original input and fixed official environment envelope are accepted',()=>{assert.equal(validate(rows()).turnId,'OFFLINE_TURN');});
for(const [name,change]of Object.entries({
 'additional text in the matched message':r=>r.at(-1).payload.content.push({type:'input_text',text:'another instruction'}),
 'another user message':r=>r.push(message('another instruction')),
 'missing session metadata':r=>r.shift(),
 'duplicate session metadata':r=>r.unshift(r[0]),
 'nonzero or unverified model usage':r=>r.push({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{output_tokens:12}}}}),
 'different original working directory':r=>r[3].payload.cwd='F:/FOREIGN',
 'wrong turn context':r=>r[3].payload.turn_id='FOREIGN_TURN'
 ,'foreign completed user item':r=>r.push({type:'event_msg',payload:{type:'item_completed',turn_id:'FOREIGN_TURN',item:{type:'UserMessage',content:[{type:'input_text',text:'another instruction'}]}}})
}))test(name+' cannot authorize interrupted review recovery',()=>{const r=rows();change(r);assert.throws(()=>validate(r),{code:'REVIEW_INTERRUPTION_HISTORY_UNVERIFIED'});});
