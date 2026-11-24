// Read-only cross-check of actual dedicated browser data. Never a product/native acceptance writer.
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { hash } from '../../dist/server/security.js';
const root=process.cwd(),output=resolve(root,'docs/revamp/evidence/W12');
const ui=JSON.parse(readFileSync(resolve(output,'ui-observations.json'),'utf8'));
const db=new DatabaseSync(resolve(root,'.runtime/revamp-20261101/dreamflow-browser-data/dream-maker.sqlite'),{readOnly:true});
try{
 const p=JSON.parse(db.prepare('SELECT data FROM projects WHERE id=?').get(ui.projectId).data);
 assert.equal(p.name,'独立 DreamFlow · 本地流程核验');assert.equal(p.mode,'demo');assert.equal(p.planner1Mode,'USER');assert.equal(p.planner1Binding,undefined);
 assert.equal(p.questions.length,0);assert.equal(p.answers.length,0);assert.equal(p.state,'SPEC_REVIEW');
 const rows=db.prepare('SELECT * FROM plan_versions WHERE project_id=? ORDER BY revision').all(p.id);assert.equal(rows.length,2);
 const versions=rows.map(row=>{
  const snapshot=JSON.parse(row.snapshot),source=JSON.parse(row.source);
  const identity={id:row.id,projectId:row.project_id,revision:row.revision,parentId:row.parent_id,specHash:row.spec_hash,origin:row.origin,snapshot,source};
  assert.equal(hash(identity),row.content_hash);
  const approval=db.prepare('SELECT actor,at FROM plan_version_approvals WHERE plan_id=?').get(row.id)??null;
  return {id:row.id,revision:row.revision,parentId:row.parent_id,specHash:row.spec_hash,contentHash:row.content_hash,goal:snapshot.projectPlan.goal,approval};
 });
 assert.ok(versions[0].approval);assert.equal(versions[1].approval,null);assert.equal(versions[1].parentId,versions[0].id);assert.equal(p.specId,versions[1].id);
 assert.notEqual(versions[0].goal,versions[1].goal);assert.match(versions[1].goal,/不安装额外组件/);
 const runs=db.prepare('SELECT data FROM runs WHERE project_id=?').all(p.id).map(row=>JSON.parse(row.data));assert.equal(runs.length,1);
 const run=runs[0];assert.equal(run.mode,'demo');assert.equal(run.flowName,'dreamflow');assert.equal(run.state,'READY_FOR_DELIVERY');assert.equal(run.specId,versions[0].id);assert.equal(Object.keys(run.roleIdentities??{}).length,0);
 const records=db.prepare('SELECT kind,run_id,data FROM records WHERE project_id=?').all(p.id).map(row=>({...row,data:JSON.parse(row.data)}));
 const conclusions=records.filter(row=>row.kind==='FlowConclusion');assert.equal(conclusions.length,1);assert.equal(conclusions[0].data.choice,'ALTERNATIVE');assert.match(conclusions[0].data.userConstraint,/不安装额外组件/);
 const modelAttempts=records.filter(row=>['ModelAttempt','NativeProbeAttempt','NativeBudgetReceipt'].includes(row.kind)).length;assert.equal(modelAttempts,0);
 const decisions=records.filter(row=>row.kind==='LayaDecision');assert.equal(decisions.length,4);assert.ok(decisions.every(row=>row.data.mode==='off'&&row.data.adoption==='off'));
 const applications=records.filter(row=>row.kind==='LayaApplication');assert.equal(applications.length,4);assert.ok(applications.every(row=>row.data.status==='NOT_PROVIDED_DEMO'&&row.data.providedToCompletedRole===false));
 const leases=db.prepare('SELECT count(*) n FROM workspace_leases').get().n,accepted=db.prepare("SELECT count(*) n FROM approvals WHERE project_id=? AND kind='DELIVERY'").get(p.id).n;
 assert.equal(leases,0);assert.equal(accepted,0);
 assert.equal(ui.beforeApproval.hasBuildConsent,false);assert.equal(ui.afterApproval.buildConsent,false);assert.equal(ui.recovered.hasBuildConsent,false);assert.equal(ui.recovered.version2,true);assert.match(ui.recovered.layaText,/NO_TURNS_OBSERVED/);
 assert.ok(ui.mobile.scrollWidth<=ui.mobile.width);assert.equal(ui.help.mainFocused,true);assert.equal(ui.console.currentOriginWarningErrorCount,0);
 const proof={...ui,database:{mode:p.mode,planner1:p.planner1Mode,questions:p.questions.length,answers:p.answers.length,versions,runs:[{id:run.id,state:run.state,mode:run.mode,flowName:run.flowName,specId:run.specId,calls:run.calls}],storedConstraint:conclusions[0].data.userConstraint,modelAttempts,leases,deliveryApprovals:accepted,layaDecisions:decisions.length,layaApplied:0},overall:'PASS_LOCAL_FIXED_DEMO_ONLY',nativeRoleAcceptance:'NOT_RUN'};
 writeFileSync(resolve(output,'sqlite-observations.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({projectId:p.id,versions:versions.length,demoRuns:runs.length,modelAttempts,leases,accepted,overall:proof.overall}));
}finally{db.close();}
