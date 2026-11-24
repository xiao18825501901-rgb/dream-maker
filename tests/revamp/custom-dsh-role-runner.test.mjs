// OFFLINE synthetic audit/receipts and local bridge only. No provider or formal qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {writeFileSync,readFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';import {resolve} from 'node:path';
import {root} from '../helpers.mjs';import {defaults} from '../../dist/server/config.js';import {DshRunner,dshRuntimeReadiness} from '../../dist/server/providers/dsh.js';import {hash} from '../../dist/server/security.js';
function fixture(t,role='planner2',terminalText,model='deepseek-flash',slowInit=false,provider){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
 const h={dir:mkdtempSync(resolve(parent,'custom-dsh-')),config:structuredClone(defaults)};
 t.after(()=>rmSync(h.dir,{recursive:true,force:true}));h.config.codex.home='';h.config.codex.model='';h.config.dsh.model='legacy-unverified-alias';h.config.dsh.modulePath=resolve(root,'tests/fixtures/custom-dsh-role-adapter.mjs');
 if(slowInit){
  const upstream=pathToFileURL(h.config.dsh.modulePath).href;
  h.config.dsh.modulePath=resolve(h.dir,'slow-adapter.mjs');
  writeFileSync(h.config.dsh.modulePath,`export {run} from ${JSON.stringify(upstream)}; export async function capabilities(){await new Promise(done=>setTimeout(done,10500));return {verified:false};}`);
 }
 const proof=resolve(h.dir,'OFFLINE-proof.txt');writeFileSync(proof,'SYNTHETIC NOT OS EVIDENCE');h.config.nativeAuditPath=resolve(h.dir,'audit.json');
 const audit={configurationHash:hash({codex:h.config.codex,dsh:h.config.dsh,laya:h.config.laya,limits:h.config.limits}),dshConfigurationHash:dshRuntimeReadiness(h.config).configurationHash,status:'LIVE_READY',osIsolationVerified:true,secretIsolationVerified:true,noImplicitLayaVerified:true,verifierImplemented:true,sandboxExecutionVerified:true,expiresAt:new Date(Date.now()+60000).toISOString(),moduleSha256:hash(readFileSync(h.config.dsh.modulePath)),evidenceFiles:[{path:proof,sha256:hash(readFileSync(proof))}]};writeFileSync(h.config.nativeAuditPath,JSON.stringify(audit));
 const toolConfig=resolve(h.dir,'OFFLINE-tools.json');writeFileSync(toolConfig,'{}');let calls=0,closed=0;
 const choice={role,provider,roleId:role==='executor'?'execA':role,model,assertCurrent:()=>{calls++;},...(terminalText===undefined?{}:{requireTerminal:true})};
 const runner=new DshRunner(()=>h.config,root,async()=>({url:'http://127.0.0.1:1/v1',token:'OFFLINE_EPHEMERAL',close:async()=>{closed++;},receipts:()=>[{outcome:'COMPLETE',completionObserved:true,observedModel:model}]}),async()=>({url:'http://127.0.0.1:1/tools',token:'OFFLINE_TOOL',configPath:toolConfig,configSha256:hash(readFileSync(toolConfig)),...(terminalText===undefined?{}:{terminal:()=>terminalText}),close:async()=>{}}),choice);
 const input={role,model,workspace:h.dir,prompt:'OFFLINE echo only',runId:'OFFLINE_probe',specHash:hash('OFFLINE'),...(role==='executor'?{executorRoleId:'execA'}:{}),laya:{role,mode:'off',adoption:'off'},signal:new AbortController().signal};
 return{h,audit,choice,runner,input,state:()=>({calls,closed})};
}
for(const role of ['planner2','executor','reviewer'])test('controller-bound Custom '+role+' uses its role/model without a Codex account',async t=>{
 const x=fixture(t,role),before=readdirSync(x.h.dir),out=await x.runner.run(x.input,()=>{});
 assert.equal(out.text,'OFFLINE_ROLE_'+role);assert.equal(out.sessionId,'OFFLINE_SESSION_'+role);assert.equal(out.usage.role,role);assert.equal(out.identity.model,'deepseek-flash');assert.equal(x.h.config.dsh.model,'legacy-unverified-alias');assert.deepEqual(readdirSync(x.h.dir),before);assert.ok(x.state().calls>=2);assert.equal(x.state().closed,1);
});
test('Custom executor completes a cold initialize and passes the approved Pro model through',async t=>{
 const x=fixture(t,'executor',undefined,'deepseek-v4-pro',true),out=await x.runner.run(x.input,()=>{});
 assert.equal(out.text,'OFFLINE_ROLE_executor');
 assert.equal(out.model,'deepseek-v4-pro');
 assert.equal(out.identity.model,'deepseek-v4-pro');
 assert.equal(x.state().closed,1);
});
test('DSH transmits and reports the selected external provider and model',async t=>{
 const x=fixture(t,'planner2',undefined,'alternate-model',false,'alternate-provider');
 const out=await x.runner.run(x.input,()=>{});
 assert.equal(out.identity.provider,'alternate-provider');assert.equal(out.identity.model,'alternate-model');
});
test('Custom bridge refuses a foreign role/executor or model and Laya before any gateway starts',async t=>{
 for(const patch of [{role:'reviewer'},{model:'legacy-unverified-alias'},{executorRoleId:'foreign'},{laya:{mode:'on',adoption:'off'}}]){
  const x=fixture(t,'executor');await assert.rejects(x.runner.run({...x.input,...patch},()=>{}),{code:'CUSTOM_DSH_ROLE_BINDING_INVALID'});assert.equal(x.state().closed,0);
 }
});
test('Custom runner freezes controller selection and rejects an expired runtime audit',async t=>{
 const x=fixture(t,'reviewer');x.choice.role='executor';x.choice.model='changed';x.audit.expiresAt='2020-01-01T00:00:00Z';writeFileSync(x.h.config.nativeAuditPath,JSON.stringify(x.audit));
 await assert.rejects(x.runner.run(x.input,()=>{}),{code:'NATIVE_INTEGRATION_BLOCKED'});assert.equal(x.state().closed,0);
});
test('Custom currentness is synchronous authority and cannot be a boolean or promise',async t=>{
 for(const assertCurrent of [()=>true,()=>Promise.resolve(),()=>Promise.reject(Error('OFFLINE_REJECT'))]){
  const x=fixture(t),bad=new DshRunner(()=>x.h.config,root,undefined,undefined,{...x.choice,assertCurrent});
  await assert.rejects(bad.run(x.input,()=>{}),{code:'CUSTOM_DSH_CURRENTNESS_INVALID'});
 }
});
test('a required Custom terminal submission replaces prose with the exact captured JSON',async t=>{
 const payload=JSON.stringify({tasks:[{id:'T1',title:'offline',dependsOn:[],requirementIds:['R1'],acceptance:['offline'],writePaths:['main.mjs']}]});
 const x=fixture(t,'planner2',payload),out=await x.runner.run(x.input,()=>{});
 assert.equal(out.text,payload);
});
test('a required Custom terminal submission fails closed when no terminal tool was used',async t=>{
 const x=fixture(t,'planner2');
 x.choice.requireTerminal=true;
 const runner=new DshRunner(()=>x.h.config,root,async()=>({url:'http://127.0.0.1:1/v1',token:'OFFLINE_EPHEMERAL',close:async()=>{},receipts:()=>[{outcome:'COMPLETE',completionObserved:true,observedModel:'deepseek-flash'}]}),async()=>({url:'http://127.0.0.1:1/tools',token:'OFFLINE_TOOL',configPath:resolve(x.h.dir,'OFFLINE-tools.json'),configSha256:hash(readFileSync(resolve(x.h.dir,'OFFLINE-tools.json'))),close:async()=>{}}),x.choice);
 await assert.rejects(runner.run(x.input,()=>{}),{code:'CUSTOM_TERMINAL_SUBMISSION_REQUIRED'});
});
test('a separately audited DSH fingerprint survives Codex-only changes and still rejects DSH changes',t=>{
 const x=fixture(t);x.audit.dshConfigurationHash=hash({dsh:x.h.config.dsh,laya:x.h.config.laya,limits:x.h.config.limits});writeFileSync(x.h.config.nativeAuditPath,JSON.stringify(x.audit));
 x.h.config.codex.home='OFFLINE_UNRELATED_CODEX_HOME';x.h.config.codex.model='OFFLINE_CHANGED_CODEX_MODEL';
 assert.equal(dshRuntimeReadiness(x.h.config).ok,true);x.h.config.dsh.model='CHANGED';assert.equal(dshRuntimeReadiness(x.h.config).ok,false);
});
