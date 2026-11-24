// OFFLINE CLI-result contract, not provider or role qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import {readClaudeSupervisorResult,runClaudeSupervisor} from '../../dist/server/providers/claude-supervisor.js';
const result=()=>({type:'result',subtype:'success',is_error:false,session_id:'11111111-1111-4111-8111-111111111111',uuid:'22222222-2222-4222-8222-222222222222',result:'review data',modelUsage:{'claude-sonnet-5':{inputTokens:10,outputTokens:5}},permission_denials:[]});
test('actual CLI terminal shape yields only observed session/model/text, not runtime qualification',()=>{
 const output=readClaudeSupervisorResult(JSON.stringify(result()),'claude-sonnet-5');
 assert.equal(output.text,'review data');assert.equal(output.sessionId,result().session_id);assert.equal(output.model,'claude-sonnet-5');assert.equal(output.requestId,result().uuid);
 assert.equal(output.inputTokens,10);assert.equal(output.outputTokens,5);assert.equal(output.costUsd,null);assert.equal('identity' in output,false);
});
test('failure, foreign models, missing sessions and denied tools cannot become completion',()=>{
 for(const patch of [{is_error:true},{subtype:'error_max_turns'},{type:'assistant'},{session_id:''},{uuid:''},{result:''},{modelUsage:{}},{modelUsage:{'claude-opus-5':{}}},{modelUsage:{'claude-sonnet-5':{},'claude-opus-5':{}}},{permission_denials:[{tool_name:'Read'}]}])assert.throws(()=>readClaudeSupervisorResult(JSON.stringify({...result(),...patch}),'claude-sonnet-5'),{code:'CLAUDE_RESULT_UNVERIFIED'});
 assert.throws(()=>readClaudeSupervisorResult('not json','claude-sonnet-5'),{code:'CLAUDE_RESULT_UNVERIFIED'});
});
test('CLI estimates are not provider charges and absent token counters stay unknown',()=>{
 const v=result();v.total_cost_usd=10;v.modelUsage['claude-sonnet-5']={};
 const out=readClaudeSupervisorResult(JSON.stringify(v),'claude-sonnet-5');assert.equal(out.costUsd,null);assert.equal(out.inputTokens,null);assert.equal(out.outputTokens,null);
});
test('executor, remote targets and cancelled work refuse before launch',async()=>{
 const base={command:'E:/not-launched.exe',controllerRoot:'E:/not-created',gatewayUrl:'http://127.0.0.1:45001',gatewayToken:'DM_SYNTHETIC_TOKEN',model:'claude-sonnet-5',role:'reviewer',prompt:'synthetic',signal:new AbortController().signal,timeoutMs:1000};
 for(const patch of [{role:'executor'},{gatewayUrl:'https://example.test'},{gatewayUrl:'http://localhost:45001'},{gatewayUrl:'http://127.0.0.1:45001/v1'},{model:'gpt-6-luna'}])await assert.rejects(runClaudeSupervisor({...base,...patch}),{code:'CLAUDE_SUPERVISOR_INPUT_INVALID'});
 const c=new AbortController();c.abort();await assert.rejects(runClaudeSupervisor({...base,signal:c.signal}),{code:'RUN_CANCELLED'});
});

test('a Custom Claude command must match the pinned bytes before use',async t=>{
 const {verifiedClaudeCommand}=await import('../../dist/server/providers/claude-supervisor.js');
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {createHash}=await import('node:crypto');
 const dir=mkdtempSync(join(tmpdir(),'dm-claude-ref-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'claude.exe');
 writeFileSync(path,'offline fixture');
 const ref={path,sha256:createHash('sha256').update('offline fixture').digest('hex')};
 assert.equal(verifiedClaudeCommand(ref),path);
 for(const bad of [undefined,{...ref,path:'relative.exe'},{...ref,sha256:'0'.repeat(64)}])
  assert.throws(()=>verifiedClaudeCommand(bad),{code:'CUSTOM_CLAUDE_COMMAND_UNVERIFIED'});
 writeFileSync(path,'changed fixture');
 assert.throws(()=>verifiedClaudeCommand(ref),{code:'CUSTOM_CLAUDE_COMMAND_UNVERIFIED'});
});
