// Read-only dedicated fixed-Demo evidence. Never writes project, approval, budget or audit state.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../..',import.meta.url)),directory=resolve(root,'docs/revamp/evidence/W11');
const ui=JSON.parse(readFileSync(resolve(directory,'ui-observations.json'),'utf8'));
if(ui.evidenceClass!=='ACTUAL_LOCAL_HTTP_FIXED_DEMO_NOT_NATIVE_LAYA_OR_ROLE_ACCEPTANCE'||!/^project_[a-f0-9]{20}$/.test(ui.projectId))throw Error('DEDICATED_DEMO_EVIDENCE_REQUIRED');
const db=new DatabaseSync(resolve(root,'.runtime/revamp-20261101/browser-data/dream-maker.sqlite'),{readOnly:true});
try{
 const p=JSON.parse(db.prepare('SELECT data FROM projects WHERE id=?').get(ui.projectId).data);
 if(p.mode!=='demo'||p.name!=='W11 流程选择 · 隔离数据')throw Error('DEDICATED_DEMO_PROJECT_REQUIRED');
 const runs=db.prepare('SELECT data FROM runs WHERE project_id=? ORDER BY rowid').all(p.id).map(row=>JSON.parse(row.data)),latest=runs.at(-1);
 const rows=db.prepare('SELECT kind,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid').all(p.id,latest.id).map(row=>({kind:row.kind,data:JSON.parse(row.data)}));
 const decisions=rows.filter(row=>row.kind==='LayaDecision').map(row=>row.data),applications=rows.filter(row=>row.kind==='LayaApplication').map(row=>row.data);
 const leases=db.prepare('SELECT count(*) AS n FROM workspace_leases WHERE project_id=?').get(p.id).n;
 const accepted=db.prepare("SELECT count(*) AS n FROM approvals WHERE project_id=? AND kind='DELIVERY'").get(p.id).n;
 if(runs.length!==2||latest.state!=='READY_FOR_DELIVERY'||latest.mode!=='demo'||latest.flowName!=='dreamflow'||leases||accepted||decisions.length!==4||applications.length!==4||decisions.some(d=>d.mode!=='off'||d.adoption!=='off')||applications.some(d=>d.providedToCompletedRole!==false||d.status!=='NOT_PROVIDED_DEMO')||rows.some(row=>row.kind==='ModelAttempt'||row.kind==='NativeBudgetReceipt'))throw Error('DEMO_SCOPE_EVIDENCE_MISMATCH');
 const report={...ui,database:{projectId:p.id,mode:p.mode,answerCount:p.answers.length,specCount:db.prepare('SELECT count(*) AS n FROM specs WHERE project_id=?').get(p.id).n,
  runs:runs.map(r=>({id:r.id,mode:r.mode,flowName:r.flowName,state:r.state,rolePolicy:r.rolePolicy})),latestDecisions:decisions.map(d=>({role:d.role,mode:d.mode,adoption:d.adoption,scope:d.support?.authority??null})),latestApplications:applications.map(d=>({role:d.role,status:d.status,providedToCompletedRole:d.providedToCompletedRole})),leases,deliveryApprovals:accepted,modelAttempts:0},nativeRoleAcceptance:'NOT_RUN',realLayaModel:'NOT_RUN',overall:'PASS_LOCAL_FIXED_DEMO_ONLY'};
 writeFileSync(resolve(directory,'sqlite-observations.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({projectId:p.id,runs:runs.length,latestRunId:latest.id,flowName:latest.flowName,decisions:decisions.length,applications:applications.length,modelAttempts:0,leases,deliveryApprovals:accepted,overall:report.overall}));
}finally{db.close();}
