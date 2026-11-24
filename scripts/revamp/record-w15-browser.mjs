// Read-only verification of dedicated local state/rehearsal files; not a product/native-role certificate.
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {hash} from '../../dist/server/security.js';
import {userBudgetStatus} from '../../dist/server/user-budget-policy.js';
const root=resolve(import.meta.dirname,'../..'),data=resolve(root,'.runtime/revamp-20261101/onboarding-browser-data'),output=resolve(root,'docs/revamp/evidence/W15');
const read=(path,fn)=>{const db=new DatabaseSync(path,{readOnly:true});try{return fn(db);}finally{db.close();}};
const application=db=>({projects:db.prepare('SELECT count(*) n FROM projects').get().n,versions:db.prepare('SELECT id,content_hash hash FROM plan_versions ORDER BY id').all(),runs:db.prepare('SELECT count(*) n FROM runs').get().n,approvals:db.prepare('SELECT count(*) n FROM approvals').get().n,leases:db.prepare('SELECT count(*) n FROM workspace_leases').get().n,modelAttempts:db.prepare("SELECT count(*) n FROM records WHERE kind='ModelAttempt'").get().n});
const current=read(resolve(data,'dream-maker.sqlite'),application);if(current.projects!==1||current.versions.length!==2||current.runs||current.approvals||current.leases||current.modelAttempts)throw Error('FIXTURE_ACTIVITY_UNEXPECTED');
// verify/list use only paths and read-only SQLite; do not instantiate the writing Store constructor.
const maintenance=new StateMaintenance({data,store:{path:resolve(data,'dream-maker.sqlite')},isBusy:()=>false});
const snapshots=maintenance.list().map(item=>{try{const verified=maintenance.verify(item.id);return {id:item.id,status:'VERIFIED_NOW',scope:verified.scope,budget:verified.budget,application:read(resolve(data,'controller/state-backups',item.id,'application.sqlite'),application),manifestHash:hash(verified)};}catch(error){return {id:item.id,status:'BLOCKED_CORRUPTED_TEST_COPY',code:error.code};}});
const good=snapshots.filter(item=>item.status==='VERIFIED_NOW');if(good.length!==1||snapshots.length!==2||hash(good[0].application.versions)!==hash(current.versions))throw Error('SNAPSHOT_EVIDENCE_UNEXPECTED');
const rehearsals=readdirSync(resolve(data,'controller/state-rehearsals')).map(id=>{
 const folder=resolve(data,'controller/state-rehearsals',id),record=JSON.parse(readFileSync(resolve(folder,'manifest.json'),'utf8')),source=maintenance.verify(record.snapshotId);
 if(record.scope!=='READONLY_RESTORE_REHEARSAL_ONLY'||record.engineStarted!==false||record.sourceManifestHash!==hash(source))throw Error('REHEARSAL_IDENTITY_FAILED');
 for(const file of source.files)if(hash(readFileSync(resolve(folder,file.path)))!==file.sha256)throw Error('REHEARSAL_BYTES_FAILED');
 const state=read(resolve(folder,'application.sqlite'),application);if(hash(state.versions)!==hash(current.versions))throw Error('REHEARSAL_VERSIONS_FAILED');
 return {id,snapshotId:record.snapshotId,scope:record.scope,engineStarted:false,application:state,budget:record.budget};
});
const monetary=read(resolve(data,'isolated-budget.sqlite'),db=>{const requests=db.prepare('SELECT data FROM requests ORDER BY rowid').all().map(row=>JSON.parse(row.data)),authority=JSON.parse(db.prepare('SELECT authority FROM scope WHERE id=1').get().authority);if(requests.length)throw Error('MODEL_REQUEST_IN_TEST_FIXTURE');return {requests:0,userBudget:userBudgetStatus(db,requests,authority.scopeId)};});
if(monetary.userBudget.limits.CNY!==2500001||monetary.userBudget.limits.USD!==0)throw Error('USER_CAP_CHANGED');
const historical=path=>read(path,db=>{const rows=db.prepare('SELECT data FROM requests').all().map(row=>JSON.parse(row.data));return {requests:rows.length,pending:rows.filter(row=>row.usageStatus==='PENDING').length,chargedMicros:rows.reduce((sum,row)=>(sum[row.price.currency]=(sum[row.price.currency]??0)+(row.chargedMicros??0),sum),{CNY:0,USD:0}),userLimitTable:!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='user_budget_limits'").get()};});
const before=historical(resolve(root,'.runtime/revamp-20261101/budget-before.sqlite')),now=historical(resolve(root,'.runtime/controller/native-budget.sqlite'));if(hash(before)!==hash(now))throw Error('ORIGINAL_LEDGER_CHANGED');
const canaries={business:readFileSync(resolve(data,'business-data/keep.txt'),'utf8')==='BUSINESS_CANARY_W15_KEEP',credentialSentinel:readFileSync(resolve(data,'credential-canary/keep.txt'),'utf8')==='SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL'};if(!Object.values(canaries).every(Boolean))throw Error('FIXTURE_CANARY_CHANGED');
const report={at:new Date().toISOString(),evidenceClass:'READONLY_LOCAL_SQLITE_AND_FILE_OBSERVATION_WITH_SYNTHETIC_PROJECT_DATA',current,snapshots,rehearsals,monetary,canaries,usage:maintenance.usage(),historicalLedger:{unchanged:true,before,now},modelsCalled:0,nativeRoles:'NOT_RUN',completeProjectBackup:false,workingDataRestored:false,overall:'PARTIAL'};
writeFileSync(resolve(output,'sqlite-observations.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,versions:current.versions.length,verifiedSnapshots:good.length,deliberatelyCorruptedCopies:snapshots.length-good.length,rehearsals:rehearsals.length,originalLedgerUnchanged:true,nativeRoles:'NOT_RUN'}));
