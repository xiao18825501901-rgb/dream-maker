// OFFLINE NativeOwner delegation only. No credentials, models, DB or process launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {WslSandbox} from '../../dist/server/wsl-sandbox.js';
import {treeHash} from '../../dist/server/workspace.js';
import {withProcessOwnership} from '../../dist/server/flow/process-ownership.js';
function setup(t,mode='custom'){
 const root=resolve('.'),parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const temp=mkdtempSync(join(parent,'json-owner-')),workspace=join(temp,'workspaces/OFFLINE_JSON_RUN');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'data.mjs'),'// OFFLINE boundary fixture, never executed\n');
 t.after(()=>rmSync(temp,{recursive:true,force:true}));
 const run={id:'OFFLINE_JSON_RUN',projectId:'OFFLINE_JSON_PROJECT',specHash:'a'.repeat(64),mode:'live',flowName:mode,flowConfig:mode==='custom'?{mode:'custom',schema:'OFFLINE_FROZEN_CONFIG'}:undefined,workspace,treeHash:treeHash(workspace)};
 const store={path:join(temp,'application.sqlite'),run:id=>{assert.equal(id,run.id);return run;}},owner=Object.create(NativeOwner.prototype);
 owner.context={root,store,getSecret(){assert.fail('no credential access');}};
 const calls={classic:0,custom:0,workers:0};let seen;
 owner.assertReady=(role,scope)=>{calls.classic++;assert.equal(role,'build');assert.deepEqual(scope,{projectId:run.projectId,specHash:run.specHash});if(mode==='custom')throw Object.assign(Error('OFFLINE_CLASSIC_UNAVAILABLE'),{code:'NATIVE_PROBE_MISSING'});};
 owner.assertCustomReady=config=>{calls.custom++;assert.equal(config,run.flowConfig);};
 const result={status:'EXECUTED',exitCode:0,sourceHash:run.treeHash,stdout:'OFFLINE_ONLY'};
 t.mock.method(WslSandbox.prototype,'run',async(...args)=>{calls.workers++;seen=args;return result;});
 const input={runId:run.id,specHash:run.specHash,sourceHash:run.treeHash,command:{runtime:'node',entry:'data.mjs',args:[],stdin:'OFFLINE_JSON'},signal:new AbortController().signal};
 const scope={store,projectId:run.projectId,runId:run.id,dispatchId:'OFFLINE_JSON_DISPATCH',generation:'OFFLINE_GENERATION',mode:'live'};
 return {owner,input,run,calls,result,scope,seen:()=>seen,invoke:(change={})=>withProcessOwnership(scope,()=>owner.runData({...input,...change}))};
}
test('Custom JSON runtime uses frozen Custom qualification without Classic proof',async t=>{
 const x=setup(t);assert.equal(await x.invoke(),x.result);assert.deepEqual(x.calls,{classic:0,custom:1,workers:1});assert.deepEqual(x.seen(),[x.run.workspace,x.input.command,{signal:x.input.signal,wallSeconds:30}]);
});
test('Classic JSON runtime preserves its original qualification and worker',async t=>{
 const x=setup(t,'classic');assert.equal(await x.invoke(),x.result);assert.deepEqual(x.calls,{classic:1,custom:0,workers:1});
});
test('unowned, foreign and cancelled JSON calls never reach qualification or worker',async t=>{
 const x=setup(t,'classic');await assert.rejects(x.owner.runData(x.input),{code:'NATIVE_DATA_OWNERSHIP_REQUIRED'});
 for(const change of [{projectId:'FOREIGN'},{runId:'FOREIGN'},{mode:'demo'},{store:{}}])await assert.rejects(withProcessOwnership({...x.scope,...change},()=>x.owner.runData(x.input)),{code:'NATIVE_DATA_OWNERSHIP_REQUIRED'});
 await assert.rejects(x.invoke({signal:AbortSignal.abort()}),{code:'RUN_CANCELLED'});assert.deepEqual(x.calls,{classic:0,custom:0,workers:0});
});
test('source/spec drift, invalid Custom binding and failed qualification never execute',async t=>{
 const x=setup(t);for(const change of [{sourceHash:'b'.repeat(64)},{specHash:'b'.repeat(64)}])await assert.rejects(x.invoke(change),{code:'NATIVE_RUN_BINDING_CHANGED'});
 x.run.flowConfig=undefined;await assert.rejects(x.invoke(),{code:'CUSTOM_ROLE_BINDING_CHANGED'});
 x.run.flowConfig={mode:'custom'};x.owner.assertCustomReady=()=>{throw Object.assign(Error('OFFLINE_EXPIRED'),{code:'CUSTOM_ROLE_PROBE_REQUIRED'});};await assert.rejects(x.invoke(),{code:'CUSTOM_ROLE_PROBE_REQUIRED'});
 assert.deepEqual(x.calls,{classic:0,custom:0,workers:0});
});
