// OFFLINE SDK fixture driving the real DM-owned host executable. Not native/model evidence.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {childEnv} from '../../dist/server/security.js';
const host=fileURLToPath(new URL('../../vendor/archon/dsh-node-host.mjs',import.meta.url));
function run(t,scenario){
 const root=mkdtempSync(join(tmpdir(),'dm-host-message-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const sdk=join(root,'sdk-client'),llm=join(root,'dsh-llm');for(const dir of [sdk,llm]){mkdirSync(join(dir,'lib'),{recursive:true});writeFileSync(join(dir,'package.json'),JSON.stringify({type:'module'}));}
 writeFileSync(join(llm,'lib/index.js'),'export const ReasoningEffortId=value=>value;');
 writeFileSync(join(sdk,'lib/index.js'),`// EXPLICIT OFFLINE FIXTURE: no network, account, subprocess or model.
 export class DeepSeekHarness{async run(_prompt,o){let seq=0;const send=(type,data)=>o.onNotification({method:'session.event',params:{sessionId:o.sessionId,event:{seq:seq++,type,data}}});send('agent/inbox/spliced',{});send('turn/start',{turn:1});
 const scenario=${JSON.stringify(scenario)};
 if(scenario!=='missing'){const content=scenario==='text'?[{type:'text',text:'OFFLINE_TEXT'}]:[{type:'tool-call',name:'submit_review',callId:'OFFLINE_CALL',arguments:'{}'}];send('assistant/message',{message:{role:'assistant',content}});}
 if(scenario!=='missing'&&scenario!=='text'){send('tool/call',{callId:'OFFLINE_CALL',name:'submit_review',arguments:'{}'});if(scenario!=='open-tool')send('tool/result',{message:{toolCallId:'OFFLINE_CALL',isError:false,content:[{type:'text',text:'accepted'}]}});}
 send('turn/end',{reason:{kind:scenario==='failed'?'error':'completed'}});o.onNotification({method:'session.status',params:{status:'idle'}});return{sessionId:o.sessionId};}async close(){}}
 `);
 const config=join(root,'config.json');writeFileSync(config,JSON.stringify({sdkRoot:sdk,cwd:root,dshHome:root,sessionId:'OFFLINE_SESSION',prompt:'OFFLINE',timeoutMs:5000,closeTimeoutMs:1000}));
 const stdout=execFileSync(process.execPath,[host,config],{encoding:'utf8',env:childEnv(),windowsHide:true,timeout:10000,maxBuffer:200000});return stdout.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
}
test('observed tool-only assistant message emits an empty text marker without invented prose',t=>{const events=run(t,'tool-only');assert.deepEqual(events.filter(e=>e.type==='assistant_text').map(e=>e.text),['']);const result=events.find(e=>e.type==='result');assert.equal(result.assistantMessages,1);assert.equal(result.openTools,0);assert.equal(result.stopReason,'completed');assert.equal(result.closed,true);});
test('ordinary assistant text is preserved exactly',t=>{const events=run(t,'text');assert.deepEqual(events.filter(e=>e.type==='assistant_text').map(e=>e.text),['OFFLINE_TEXT']);});
test('a missing assistant message does not acquire a synthetic marker',t=>{const events=run(t,'missing');assert.equal(events.filter(e=>e.type==='assistant_text').length,0);assert.equal(events.find(e=>e.type==='result').assistantMessages,0);});
test('an observed empty message does not rewrite a failed turn as completed',t=>{const events=run(t,'failed');assert.deepEqual(events.filter(e=>e.type==='assistant_text').map(e=>e.text),['']);assert.equal(events.find(e=>e.type==='result').stopReason,'error');});
test('an empty assistant marker does not clear an outstanding tool',t=>{const events=run(t,'open-tool');assert.deepEqual(events.filter(e=>e.type==='assistant_text').map(e=>e.text),['']);assert.equal(events.find(e=>e.type==='result').openTools,1);});
