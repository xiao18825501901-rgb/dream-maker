// OFFLINE TEST fixture setup only. Never Native/Live evidence or a formal-database migration.
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureSource} from '../../dist/server/review-packet.js';
import {installPrework} from '../../dist/server/prework/runtime.js';
import {customRoleConfiguration} from '../../dist/server/flow/custom-role-identity.js';
import {hash} from '../../dist/server/security.js';

const testTemp=fileURLToPath(new URL('../../.runtime/test-temp/',import.meta.url));
function inside(parent,path){
 const child=relative(realpathSync(parent),realpathSync(path));
 assert.ok(child&&!isAbsolute(child)&&child!=='..'&&!child.startsWith('..'+sep),'OFFLINE fixture must stay inside its isolated test directory');
}
export function assertOfflineHarness(h){
 inside(testTemp,h.dir);
 inside(h.dir,h.store.path);
}
/** Install once, after the complete pending DAG and initial source are seeded,
 * before slices, running statuses, source edits or executor dispatch. No model turn. */
export function installOfflinePrework(h,runId,{plannerSession='OFFLINE_PREWORK_P2_'+runId,plannerRequest='OFFLINE_PREWORK_REQUEST_'+runId}={}){
 assertOfflineHarness(h);
 const r=h.store.run(runId);
 inside(resolve(h.dir,'workspaces'),r.workspace);
 assert.equal(r.prework,undefined,'OFFLINE prework must not replace an installed contract');
 assert.equal(r.phase,'IMPLEMENTING');
 assert.ok(r.tasks.length&&r.tasks.every(task=>task.status==='pending'));
 assert.equal(h.store.records(r.projectId,'SourceSnapshot').filter(row=>row.runId===r.id&&row.data.stage==='BASELINE').length,0);
 if(!r.roleIdentities?.planner2){
  // A completed synthetic P2 prerequisite, not a dispatched AgentSession, usage or Native receipt.
  let identity={runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:h.config.codex.model};
  if(r.flowConfig?.mode==='custom'){
   const selected=customRoleConfiguration(r.flowConfig,'planner2');
   identity={runner:'DSH',runtime:selected.runtime,provider:selected.provider,authentication:'API_KEY',model:selected.model.id,
    roleId:selected.id,authRef:selected.authRef,accountRef:selected.accountRef,configurationHash:r.flowConfigHash,routeHash:hash('OFFLINE_PREWORK_P2_ROUTE_'+r.id)};
  }
  r.sessions.planner2=plannerSession;
  (r.roleIdentities??={}).planner2={...identity,sessionId:plannerSession,requestId:plannerRequest};
  h.store.record('OfflinePreworkPrerequisite',r.projectId,r.id,{scope:'OFFLINE_TEST_ONLY_NOT_NATIVE_OR_LIVE',role:'planner2',
   completed:true,identity:r.roleIdentities.planner2,modelsCalled:0,modelDispatched:false});
 }
 const baseline=captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'BASELINE');
 r.treeHash=baseline.treeHash;
 h.store.saveRun(r);
 h.store.record('SourceSnapshot',r.projectId,r.id,baseline);
 installPrework(h.store,r.id);
 return h.store.run(r.id);
}

/** Explicit synthetic P2 boundary for controller-loop tests that replace role().
 * No Native session, model call, usage or signed admission is created. */
export function seedOfflinePlannerIdentity(h,runId){
 assertOfflineHarness(h);const r=h.store.run(runId);
 inside(resolve(h.dir,'workspaces'),r.workspace);
 assert.equal(r.phase,'PLANNING');assert.equal(r.flowName,'classic');
 assert.equal(r.roleIdentities?.planner2,undefined);
 const sessionId='OFFLINE_PREWORK_P2_'+r.id,requestId='OFFLINE_PREWORK_REQUEST_'+r.id;
 r.sessions.planner2=sessionId;(r.roleIdentities??={}).planner2={runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:'OFFLINE_PLANNER',sessionId,requestId};
 h.store.record('OfflinePreworkPrerequisite',r.projectId,r.id,{scope:'OFFLINE_TEST_ONLY_NOT_NATIVE_OR_LIVE',modelsCalled:0,modelDispatched:false,identity:r.roleIdentities.planner2});h.store.saveRun(r);
}
