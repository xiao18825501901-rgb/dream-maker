// Read the dedicated UI test database only. Does not change any project/approval/audit state.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../../dist/server/security.js';
const root=fileURLToPath(new URL('../..',import.meta.url));
const directory=resolve(root,'docs/revamp/evidence/W09'),ui=JSON.parse(readFileSync(resolve(directory,'ui-observations.json'),'utf8'));
const db=new DatabaseSync(resolve(root,'.runtime/revamp-20261101/browser-data/dream-maker.sqlite'),{readOnly:true});
try{
 const p=JSON.parse(db.prepare('SELECT data FROM projects WHERE id=?').get(ui.projectId).data);
 if(p.mode!=='demo'||!p.name.includes('离线数据'))throw Error('EXPLICIT_DEMO_TEST_DATA_REQUIRED');
 const runs=db.prepare('SELECT data FROM runs WHERE project_id=?').all(p.id).map(r=>JSON.parse(r.data));
 const records=db.prepare('SELECT kind,data FROM records WHERE project_id=?').all(p.id).map(r=>({kind:r.kind,data:JSON.parse(r.data)}));
 const approvals=db.prepare('SELECT kind,count(*) AS n FROM approvals WHERE project_id=? GROUP BY kind').all(p.id);
 const specs=db.prepare('SELECT id,data FROM specs WHERE project_id=?').all(p.id).map(r=>({id:r.id,sha256:hash(r.data),stale:JSON.parse(r.data).stale}));
 const report={...ui,database:{project:{id:p.id,mode:p.mode,state:p.state,batchSize:p.batchSize,interviewMode:p.interviewMode,answerCount:p.answers.length,constraint:p.alternativeContext?.userConstraint},
  runs:runs.map(r=>({id:r.id,state:r.state,mode:r.mode,treeHash:r.treeHash,calls:r.calls,cloudUsage:r.usage.filter(u=>u.source!=='DEMO_NO_CLOUD').length,flowConcluded:!!r.flowConclusion})),specs,approvals,
  conclusions:records.filter(r=>r.kind==='FlowConclusion').map(r=>({choice:r.data.choice,reportId:r.data.reportId,evidenceClass:r.data.report.evidenceClass,userAccepted:r.data.report.userAccepted})),
  followups:records.filter(r=>r.kind==='FlowFollowup').map(r=>({choice:r.data.choice,automaticBuild:r.data.automaticBuild})),
  modelAttempts:records.filter(r=>r.kind==='ModelAttempt').length,
  leases:db.prepare('SELECT count(*) AS n FROM workspace_leases WHERE project_id=?').get(p.id).n}};
 if(runs.length!==1||runs[0].state!=='READY_FOR_DELIVERY'||approvals.some(r=>r.kind==='DELIVERY')||report.database.modelAttempts!==0||report.database.leases!==0)throw Error('BROWSER_EVIDENCE_BOUNDARY_MISMATCH');
 writeFileSync(resolve(directory,'browser-observations.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({projectId:p.id,state:p.state,batchSize:p.batchSize,oldRuns:runs.length,oldArtifactState:runs[0].state,deliveryApprovals:0,modelAttempts:0,leases:0}));
}finally{db.close();}
