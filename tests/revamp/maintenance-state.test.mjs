// Real local SQLite snapshots/rehearsals; no role calls, production data or user acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {harness} from '../helpers.mjs';
import {UserPlans} from '../../dist/server/user-plans.js';
import {fixtureProjectPlan} from '../fixtures/full-project-plan.mjs';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {hash} from '../../dist/server/security.js';
import {NativeBudget} from '../../dist/server/native-budget.js';
function setup(t){const h=harness(t),plans=new UserPlans(h.store),doc={schema:'dream-maker.user-plan.v1',name:'状态保护',mode:'demo',plan:fixtureProjectPlan([{id:'R1',text:'保留旧版本',origin:'USER',sources:['USER_DOCUMENT']}])};const p=plans.create(doc,'OFFLINE_DOCUMENT');let busy=false;
 return {h,p,doc,plans,service:new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>busy}),setBusy:value=>busy=value};}
test('consistent state snapshot preserves every immutable version, excludes credentials and never overwrites working data',t=>{
 const {h,p,doc,plans,service}=setup(t);doc.plan.goal='第二版仍保留第一版';plans.revise(p.id,doc,p.version,p.specId,'OFFLINE_DOCUMENT');
 mkdirSync(resolve(h.dir,'kimi-credentials'));writeFileSync(resolve(h.dir,'kimi-credentials','CANARY.txt'),'PRIVATE_AUTH_MUST_NOT_COPY');
 mkdirSync(resolve(h.dir,'business'));writeFileSync(resolve(h.dir,'business','CANARY.txt'),'BUSINESS_DATA_KEEP');
 const before=h.store.planVersions(p.id).map(v=>v.contentHash),receipt=service.create('OFFLINE_BACKUP_ONE');
 assert.equal(receipt.scope,'APPLICATION_STATE_ONLY');assert.equal(receipt.status,'VERIFIED');assert.equal(receipt.application.planVersions,2);assert.equal(receipt.budget.status,'UNAVAILABLE');assert.equal(receipt.completeProjectBackup,false);
 assert.deepEqual(h.store.planVersions(p.id).map(v=>v.contentHash),before);assert.equal(readFileSync(resolve(h.dir,'business','CANARY.txt'),'utf8'),'BUSINESS_DATA_KEEP');
 const folder=resolve(h.dir,'controller','state-backups',receipt.id);assert.deepEqual(readdirSync(folder).sort(),['application.sqlite','manifest.json']);
 assert.equal(service.verify(receipt.id).status,'VERIFIED');assert.deepEqual(service.create('OFFLINE_BACKUP_ONE'),receipt);assert.equal(service.list().length,1);
 const rehearsal=service.rehearse(receipt.id,'OFFLINE_RESTORE_ONE');assert.equal(rehearsal.engineStarted,false);assert.equal(rehearsal.application.planVersions,2);assert.equal(rehearsal.scope,'READONLY_RESTORE_REHEARSAL_ONLY');
 assert.equal(h.store.runs(p.id).length,0);assert.deepEqual(h.store.planVersions(p.id).map(v=>v.contentHash),before);
});
test('busy state and a held writer lease refuse before a snapshot directory or authority is created',t=>{
 const {h,p,service,setBusy}=setup(t);setBusy(true);assert.throws(()=>service.create('OFFLINE_BUSY'),{code:'MAINTENANCE_BUSY'});setBusy(false);
 h.store.acquire(p.id,'uncertain-writer');assert.throws(()=>service.create('OFFLINE_LEASE'),{code:'MAINTENANCE_WRITER_UNSETTLED'});assert.equal(existsSync(resolve(h.dir,'controller','state-backups')),false);
});
test('changed backup bytes, malformed identities and redirected directories refuse restore without touching live state',t=>{
 const {h,p,service}=setup(t),receipt=service.create('OFFLINE_INTEGRITY'),file=resolve(h.dir,'controller','state-backups',receipt.id,'application.sqlite');
 const original=hash(readFileSync(file));writeFileSync(file,'broken');assert.notEqual(hash(readFileSync(file)),original);
 assert.throws(()=>service.verify(receipt.id),{code:'MAINTENANCE_SNAPSHOT_CHANGED'});assert.throws(()=>service.rehearse(receipt.id,'OFFLINE_BAD_RESTORE'),{code:'MAINTENANCE_SNAPSHOT_CHANGED'});assert.equal(h.store.projects().length,1);assert.equal(h.store.spec(p.specId).id,p.specId);
 for(const value of ['../escape','C:/outside','snapshot_invalid'])assert.throws(()=>service.verify(value));
 const other=resolve(h.dir,'OTHER'),controller=resolve(h.dir,'OTHER_DATA');mkdirSync(other);mkdirSync(controller);symlinkSync(other,resolve(controller,'controller'),process.platform==='win32'?'junction':'dir');
 const bad=new StateMaintenance({store:h.store,data:controller,isBusy:()=>false});assert.throws(()=>bad.create('OFFLINE_LINK'),/SYMLINK|PATH/);assert.deepEqual(readdirSync(other),[]);
});
test('the existing monetary owner snapshots its full ledger and cap without resetting consumption or carrying a live request',t=>{
 let budget;t.after(()=>budget?.close());const {h}=setup(t);
 budget=new NativeBudget(resolve(h.dir,'budget.sqlite'),{scopeId:'OFFLINE_W15',authorizationHash:'TEST_ONLY',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2},()=>false);
 budget.configureUserBudget({CNY:3000000,USD:0},0,'local-session:'+'b'.repeat(64),'OFFLINE_CAP');
 const price={provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000};
 const pending=budget.reserve('executor',price,128),service=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>false,captureBudget:path=>{budget.captureState(path);return true;}});
 assert.throws(()=>service.create('OFFLINE_PENDING_SNAPSHOT'),{code:'MAINTENANCE_BUDGET_IN_FLIGHT'});
 budget.settle(pending.id,null,'OFFLINE_UNKNOWN');const before=budget.summary(),receipt=service.create('OFFLINE_SETTLED_SNAPSHOT');assert.equal(receipt.budget.status,'CAPTURED');assert.equal(receipt.budget.requests,1);assert.equal(receipt.files.length,2);
 const rehearsal=service.rehearse(receipt.id,'OFFLINE_BUDGET_REHEARSAL');assert.equal(rehearsal.budget.requests,1);assert.deepEqual(budget.summary(),before);assert.equal(budget.userBudgetStatus().limits.CNY,3000000);
 const copy=new DatabaseSync(resolve(h.dir,'controller/state-backups',receipt.id,'budget.sqlite'),{readOnly:true});try{assert.equal(copy.prepare('SELECT count(*) n FROM user_budget_limits').get().n,1);assert.equal(JSON.parse(copy.prepare('SELECT data FROM requests').get().data).chargedMicros,pending.reservedMicros);}finally{copy.close();}
});
test('incomplete rehearsal directories consume the bounded count before any new copy is created',t=>{
 const {h,service}=setup(t),snapshot=service.create('OFFLINE_LIMIT_SOURCE'),base=resolve(h.dir,'controller/state-rehearsals');mkdirSync(base);
 for(let i=0;i<50;i++)mkdirSync(resolve(base,'rehearsal_'+hash(String(i)).slice(0,32)));
 assert.throws(()=>service.rehearse(snapshot.id,'OFFLINE_LIMIT_NEXT'),{code:'MAINTENANCE_REHEARSAL_LIMIT'});assert.equal(readdirSync(base).length,50);
});
test('a source database above the file limit is rejected before VACUUM or creating a backup directory',t=>{
 const {h,service}=setup(t),original=h.store.db;let vacuums=0;
 h.store.db=new Proxy(original,{get(target,key){if(key==='prepare')return sql=>{if(sql==='PRAGMA page_count')return {get:()=>({page_count:100000})};if(sql==='PRAGMA page_size')return {get:()=>({page_size:4096})};if(sql.startsWith('VACUUM'))vacuums++;return target.prepare(sql);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 try{assert.throws(()=>service.create('OFFLINE_OVERSIZE'),{code:'MAINTENANCE_FILE_DENIED'});assert.equal(vacuums,0);assert.equal(existsSync(resolve(h.dir,'controller/state-backups')),false);}finally{h.store.db=original;}
});
test('replayed rehearsal receipts cannot claim full restore, a different identity or invented version counts',t=>{
 const {h,service}=setup(t),snapshot=service.create('OFFLINE_RECEIPT_SOURCE'),receipt=service.rehearse(snapshot.id,'OFFLINE_RECEIPT'),path=resolve(h.dir,'controller/state-rehearsals',receipt.id,'manifest.json');
 for(const mutation of [record=>record.scope='FULL_PROJECT_RESTORED',record=>record.id='wrong',record=>record.application.planVersions=999]){
  const changed=structuredClone(receipt);mutation(changed);writeFileSync(path,JSON.stringify(changed));assert.throws(()=>service.rehearse(snapshot.id,'OFFLINE_RECEIPT'),{code:'MAINTENANCE_REHEARSAL_CHANGED'});
 }
});
