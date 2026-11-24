// Readonly evidence for one owned fixed-Demo browser scenario; no provider or credential access.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hash} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
const root=resolve(import.meta.dirname,'../..'),phase=process.argv[2];
if(!['legacy','pre-restore','post-restore','reopen'].includes(phase))throw Error('FIXED_EVIDENCE_PHASE_REQUIRED');
const output=resolve(root,'docs/revamp/evidence/W15/managed-data'),data=resolve(root,'.runtime/revamp-20261101/managed-data-browser-data');mkdirSync(output,{recursive:true});
const db=new DatabaseSync(resolve(data,'dream-maker.sqlite'),{readOnly:true});let observation;
try{
 const projects=db.prepare('SELECT data FROM projects ORDER BY id').all(),plans=db.prepare('SELECT id,content_hash FROM plan_versions ORDER BY id').all(),specs=db.prepare('SELECT data FROM specs ORDER BY id').all(),approvals=db.prepare('SELECT * FROM approvals ORDER BY id').all(),runs=db.prepare('SELECT data FROM runs ORDER BY id').all().map(row=>JSON.parse(row.data));
 const leases=Number(db.prepare('SELECT count(*) n FROM workspace_leases').get().n),models=Number(db.prepare("SELECT count(*) n FROM records WHERE kind IN ('ModelAttempt','AgentSession','NativeProbeAttempt')").get().n);
 if(leases||models||projects.length!==1||runs.some(run=>run.mode!=='demo'||!['READY_FOR_DELIVERY','ACCEPTED','CANCELLED','FAILED'].includes(run.state)))throw Error('FIXED_BROWSER_NOT_QUIESCENT');
 const sources=runs.map(run=>({runId:run.id,recordedHash:run.treeHash,actualHash:treeHash(run.workspace)}));if(sources.some(source=>source.actualHash!==source.recordedHash))throw Error('FIXED_SOURCE_CHANGED');
 const heads=db.prepare('SELECT h.project_id,h.revision,v.data_json,v.data_hash,v.content_hash,v.origin FROM managed_dataset_heads h JOIN managed_dataset_versions v ON v.project_id=h.project_id AND v.kind=h.kind AND v.revision=h.revision ORDER BY h.project_id').all().map(row=>({projectId:row.project_id,revision:row.revision,taskCount:JSON.parse(row.data_json).length,dataHash:row.data_hash,contentHash:row.content_hash,origin:row.origin}));
 observation={schema:'dream-maker.managed-data-browser-observation.v1',at:new Date().toISOString(),phase,evidenceClass:'REAL_LOCAL_BROWSER_SQLITE_FIXED_DEMO_NOT_LIVE',projectCount:projects.length,runCount:runs.length,leases,models,sources,plans,projectHash:hash(projects),specHash:hash(specs),approvalsHash:hash(approvals),runHash:hash(runs),heads,versions:Number(db.prepare('SELECT count(*) n FROM managed_dataset_versions').get().n),restores:Number(db.prepare("SELECT count(*) n FROM records WHERE kind='ManagedDataRestore'").get().n)};
}finally{db.close();}
function budget(path){const db=new DatabaseSync(path,{readOnly:true});try{const rows=db.prepare('SELECT data FROM requests ORDER BY rowid').all().map(row=>JSON.parse(row.data));return{requests:rows.length,pending:rows.filter(row=>row.usageStatus==='PENDING').length,rowDataSha256:hash(rows)};}finally{db.close();}}
const before=budget(resolve(root,'.runtime/revamp-20261101/budget-before.sqlite')),current=budget(resolve(root,'.runtime/controller/native-budget.sqlite'));
observation.budget={before,current,unchangedSinceTakeover:hash(before)===hash(current)};if(!observation.budget.unchangedSinceTakeover)throw Error('ORIGINAL_BUDGET_CHANGED');
if(['post-restore','reopen'].includes(phase)){
 const previous=JSON.parse(readFileSync(resolve(output,'pre-restore.json'),'utf8'));
 observation.sourcePlanAndApprovalsUnchanged=['projectHash','specHash','approvalsHash','runHash'].every(key=>observation[key]===previous[key])&&hash(observation.sources)===hash(previous.sources);
 if(!observation.sourcePlanAndApprovalsUnchanged)throw Error('SOURCE_PLAN_OR_APPROVAL_CHANGED_DURING_DATA_RESTORE');
 if(phase==='reopen'){const restored=JSON.parse(readFileSync(resolve(output,'post-restore.json'),'utf8'));if(hash(observation.heads)!==hash(restored.heads))throw Error('DATA_REOPEN_CHANGED');}
}
writeFileSync(resolve(output,phase+'.json'),JSON.stringify(observation,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({phase,projects:observation.projectCount,runs:observation.runCount,leases:observation.leases,models:observation.models,heads:observation.heads.map(({revision,taskCount,origin})=>({revision,taskCount,origin})),budgetUnchanged:observation.budget.unchangedSinceTakeover,sourcePlanAndApprovalsUnchanged:observation.sourcePlanAndApprovalsUnchanged}));
