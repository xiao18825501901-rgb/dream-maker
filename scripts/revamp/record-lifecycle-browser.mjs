// Fixed readonly evidence sources. Never opens a provider, login file or mutable Store connection.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../..'),output=resolve(root,'docs/revamp/evidence/W15/lifecycle');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(product){
 const path=resolve(root,'.runtime/revamp-20261101/lifecycle-browser-'+product+'-data/dream-maker.sqlite'),db=new DatabaseSync(path,{readOnly:true});
 try{
  const count=table=>db.prepare('SELECT count(*) n FROM '+table).get().n;
  const runs=db.prepare('SELECT data FROM runs ORDER BY rowid').all().map(row=>JSON.parse(row.data)).map(run=>({id:run.id,mode:run.mode,state:run.state,phase:run.phase,calls:run.calls,specHash:run.specHash,treeHash:run.treeHash}));
  const plans=db.prepare('SELECT id,content_hash FROM plan_versions ORDER BY rowid').all();
  const approvals=db.prepare('SELECT kind,count(*) n FROM approvals GROUP BY kind ORDER BY kind').all();
  const nativeOrModel=db.prepare("SELECT count(*) n FROM records WHERE kind IN ('ModelAttempt','AgentSession','NativeProbeAttempt')").get().n;
  const choices=db.prepare("SELECT data FROM records WHERE kind='ApplicationLifecycle' ORDER BY rowid").all().map(row=>JSON.parse(row.data)).map(({choice,at,runIds})=>({choice,at,runIds}));
  const pauseResults=db.prepare("SELECT data FROM records WHERE kind='ApplicationLifecycleResult' ORDER BY rowid").all().map(row=>JSON.parse(row.data));
  if(nativeOrModel||runs.some(run=>run.mode!=='demo')||approvals.some(row=>row.kind==='DELIVERY'))throw Error('FIXTURE_SCOPE_NOT_DEMO_ONLY');
  if(product==='dream-maker'&&(count('projects')!==2||plans.length!==1||runs.length!==1||runs[0].state!=='READY_FOR_DELIVERY'||runs[0].calls!==4||count('workspace_leases')!==0))throw Error('DM_RESTART_OR_RESUME_NOT_PROVEN');
  if(product==='dreamflow'&&(count('projects')!==1||plans.length!==1||runs.length||approvals.length||count('workspace_leases')))throw Error('DREAMFLOW_UNAPPROVED_PLAN_NOT_PRESERVED');
  if(!pauseResults.some(result=>result.state==='PAUSED'))throw Error('PAUSE_RESULT_MISSING');
  return {product,projects:count('projects'),plans,approvals,runs,leases:count('workspace_leases'),nativeOrModel,choices,pauseResults};
 }finally{db.close();}
}
function ledger(path){
 const db=new DatabaseSync(path,{readOnly:true});try{
  const rows=db.prepare('SELECT data FROM requests ORDER BY rowid').all().map(row=>JSON.parse(row.data));
  return {requests:rows.length,pending:rows.filter(row=>row.usageStatus==='PENDING').length,chargedMicros:rows.reduce((out,row)=>{out[row.price.currency]=(out[row.price.currency]??0)+(row.chargedMicros??0);return out;},{CNY:0,USD:0}),rowDataSha256:sha(JSON.stringify(rows))};
 }finally{db.close();}
}
const before=ledger(resolve(root,'.runtime/revamp-20261101/budget-before.sqlite')),current=ledger(resolve(root,'.runtime/controller/native-budget.sqlite'));
const observations={schema:'dream-maker.lifecycle-sqlite-observations.v1',at:new Date().toISOString(),evidenceClass:'REAL_LOCAL_SQLITE_AND_FIXED_DEMO_BROWSER_NOT_LIVE_AGENT',fixtures:['dream-maker','dreamflow'].map(fixture),developmentBudget:{before,current,unchangedSinceTakeover:JSON.stringify(before)===JSON.stringify(current)},screenshots:readdirSync(output).filter(name=>name.endsWith('.png')).sort().map(path=>{const bytes=readFileSync(resolve(output,path));return {path,bytes:bytes.length,sha256:sha(bytes)};}),nativeRoles:'NOT_RUN',windowCloseHook:'NOT_IMPLEMENTED'};
writeFileSync(resolve(output,'sqlite-observations.json'),JSON.stringify(observations,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({fixtures:observations.fixtures.map(({product,projects,plans,runs,leases,nativeOrModel})=>({product,projects,plans:plans.length,runs:runs.length,leases,nativeOrModel})),developmentBudgetUnchanged:observations.developmentBudget.unchangedSinceTakeover}));
