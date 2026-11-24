// Read-only accounting observations for the dedicated W13 UI fixture; never a Live-role certificate.
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
const root=resolve(import.meta.dirname,'../..'),output=resolve(root,'docs/revamp/evidence/W13');
const read=(path,fn)=>{const db=new DatabaseSync(path,{readOnly:true});try{return fn(db);}finally{db.close();}};
const historical=path=>read(path,db=>{const rows=db.prepare('SELECT data FROM requests').all().map(row=>JSON.parse(row.data));return {requests:rows.length,pending:rows.filter(row=>row.usageStatus==='PENDING').length,chargedMicros:rows.reduce((sum,row)=>(sum[row.price.currency]=(sum[row.price.currency]??0)+(row.chargedMicros??0),sum),{CNY:0,USD:0}),userLimitTable:!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='user_budget_limits'").get()};});
const before=historical(resolve(root,'.runtime/revamp-20261101/budget-before.sqlite')),now=historical(resolve(root,'.runtime/controller/native-budget.sqlite'));
if(JSON.stringify(before)!==JSON.stringify(now))throw Error('HISTORICAL_LEDGER_CHANGED_REQUIRES_RECONCILIATION');
const fixture=resolve(root,'.runtime/revamp-20261101/onboarding-browser-data');
const policy=read(resolve(fixture,'isolated-budget.sqlite'),db=>{
 const rows=db.prepare('SELECT data FROM user_budget_limits ORDER BY revision').all().map(row=>JSON.parse(row.data));
 return {requests:db.prepare('SELECT count(*) n FROM requests').get().n,revisions:rows.map(row=>({revision:row.revision,limits:row.limits,baselineRequests:row.baselineRequests,startedAt:row.at})),sameBaseline:rows.every(row=>row.baselineHash===rows[0].baselineHash&&row.baselineRequests===rows[0].baselineRequests)};
});
const app=read(resolve(fixture,'dream-maker.sqlite'),db=>({projects:db.prepare('SELECT count(*) n FROM projects').get().n,runs:db.prepare('SELECT count(*) n FROM runs').get().n,leases:db.prepare('SELECT count(*) n FROM workspace_leases').get().n,modelAttempts:db.prepare("SELECT count(*) n FROM records WHERE kind='ModelAttempt'").get().n,approvals:db.prepare('SELECT count(*) n FROM approvals').get().n}));
if(policy.requests||Object.values(app).some(Boolean)||!policy.sameBaseline)throw Error('UI_FIXTURE_STATE_UNEXPECTED');
JSON.parse(readFileSync(resolve(output,'browser-observations.json'),'utf8'));
const report={at:new Date().toISOString(),evidenceClass:'READONLY_SQLITE_OBSERVATION_OF_BROWSER_TEST_ONLY',policy,app,historicalLedger:{unchanged:true,before,now},nativeRoles:'NOT_RUN',overall:'PARTIAL'};
writeFileSync(resolve(output,'sqlite-observations.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,fixtureRequests:policy.requests,revisions:policy.revisions.length,historicalLedgerUnchanged:true,nativeRoles:'NOT_RUN'}));
