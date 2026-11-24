// OFFLINE wire fixtures, not native permission/model evidence.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {resolve} from 'node:path';
import {CodexRunner} from '../../dist/server/providers/codex.js';
import {harness,root} from '../helpers.mjs';
import {hash} from '../../dist/server/security.js';
function setup(t,mode='success'){
 const h=harness(t),c=h.config,policyFile=resolve(h.dir,'data-policy.toml');
 writeFileSync(policyFile,readFileSync(resolve(root,'config/codex-supervisor-windows.toml')));
 c.codex={command:process.execPath,args:[resolve(root,'tests/fixtures/codex-wire.mjs'),mode],home:h.dir,model:'fixture-not-a-model',permissionProfile:'dream-maker-supervisor-data',policyFile};c.limits.stepTimeoutMs=15000;
 const input={workspace:h.dir,prompt:'OFFLINE supplied packet',model:c.codex.model,specHash:'fixture',runId:'fixture',role:'planner2',laya:{adoption:'off'},signal:new AbortController().signal};
 return{c,h,input,runner:new CodexRunner(()=>c,root),requests:()=>readFileSync(resolve(h.dir,'codex-fixture-requests.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x))};
}
test('data-only Planner 2 and Reviewer use independent threads with no tools, roots or execution environments',async t=>{
 const sessions=[];
 for(const role of ['planner2','reviewer']){
  const f=setup(t),events=[],out=await f.runner.run({...f.input,role},e=>events.push(e));sessions.push(out.sessionId);
  assert.equal(JSON.parse(out.text).verdict,'PASS');
  const start=f.requests().find(x=>x.method==='thread/start'),turn=f.requests().find(x=>x.method==='turn/start');
  assert.deepEqual(start.environments,[]);assert.deepEqual(start.runtimeWorkspaceRoots,[]);assert.deepEqual(turn.environments,[]);
  for(const key of ['shell_tool','stable_environment_tools','multi_agent','multi_agent_v2','apps','plugins','tool_search','workspace_dependencies'])assert.equal(start.features[key],false);
  assert.equal(events.find(x=>x.method==='dm/codexCompletion').params.role,role);
 }
 assert.notEqual(sessions[0],sessions[1]);
});
for(const [mode,code] of [['data-parent','CODEX_PERMISSION_PROFILE_PARENT_MISMATCH'],['data-environment','CODEX_THREAD_ENVIRONMENT_MISMATCH'],['data-roots','CODEX_THREAD_ENVIRONMENT_MISMATCH'],['tool-use','CODEX_UNEXPECTED_TOOL']])test('data-only profile fails closed for '+mode,async t=>{
 const f=setup(t,mode);await assert.rejects(f.runner.run(f.input,()=>{}),{code});assert.equal(f.requests().some(x=>x.method==='turn/start'),mode==='tool-use');
});
test('standalone data-only policy refuses workspace paths, inheritance and extra sections before starting a child',async t=>{
 const f=setup(t),base=readFileSync(f.c.codex.policyFile,'utf8');
 for(const text of [base.replace('":minimal" = "read"','":minimal" = "read"\n"F:/" = "read"'),base+'\n[permissions.dream-maker-supervisor-data]\nextends = ":read-only"\n',base+'\n[permissions.dream-maker-supervisor-data.filesystem.":workspace_roots"]\n"." = "read"\n',base.replace('enabled = false','enabled = true')]){
  writeFileSync(f.c.codex.policyFile,text);await assert.rejects(f.runner.run(f.input,()=>{}),{code:'CODEX_POLICY_FILE_INVALID'});
 }
 assert.equal(existsSync(resolve(f.h.dir,'codex-fixture-requests.jsonl')),false);
});
test('a product Codex turn refuses a changed subscription account before model dispatch',async t=>{
 const f=setup(t),runner=new CodexRunner(()=>f.c,root,false,undefined,hash({type:'DIFFERENT_ACCOUNT'}));
 await assert.rejects(runner.run(f.input,()=>{}),{code:'CODEX_ACCOUNT_BINDING_CHANGED'});
 assert.equal(f.requests().some(x=>x.method==='turn/start'),false);
});
