// OFFLINE UI data boundaries. Never a role, runtime, account or restoration proof.
import test from 'node:test';import assert from 'node:assert/strict';
import {shell} from '../../dist/web/views.js';import {harness,ready} from '../helpers.mjs';
const load=()=>import('../../dist/web/sqlite-status-view.js');
const snapshot=()=>({project:{id:'P',mode:'live',version:4,activeRunId:'R'},runs:[{id:'R',projectId:'P',mode:'live',version:9}]});
const empty=()=>({schema:'dream-maker.sqlite-data.v1',projectId:'P',kind:'SQLITE_IMAGE_V1',revision:0,imageHash:null,imageBytes:0,contentHash:null,usage:{versions:0,bytes:0,operations:0,pending:0},limits:{versions:32,bytes:536870912,operations:4096,pending:4},scope:'PROJECT_SQLITE_DATA_ONLY',nativeExecutionGranted:false});
const saved=()=>({...empty(),revision:2,imageHash:'a'.repeat(64),imageBytes:8192,contentHash:'b'.repeat(64),usage:{versions:2,bytes:24576,operations:3,pending:1}});

test('status entry needs a formal local current Live project/run and tracks both version bindings',async()=>{
 const m=await load(),s=snapshot(),b=m.sqliteStatusBinding(s);assert.ok(b);assert.match(m.sqliteStatusEntry(s,true),/data-action="sqlite-status"/);assert.equal(m.sqliteStatusEntry(s,false),'');
 assert.equal(m.sameSqliteStatusBinding(structuredClone(b),b),true);assert.equal(m.sameSqliteStatusBinding(null,b),false);
 for(const change of [s=>s.project.mode='demo',s=>s.runs[0].mode='demo',s=>s.project.activeRunId='other',s=>s.runs[0].projectId='other',s=>s.project.version=NaN,s=>s.runs[0].version=0]){const v=snapshot();change(v);assert.equal(m.sqliteStatusBinding(v),null);}
 for(const key of ['projectId','runId','projectVersion','runVersion']){const v=structuredClone(b);v[key]=typeof v[key]==='number'?v[key]+1:'other';assert.equal(m.sameSqliteStatusBinding(v,b),false);}
});
test('status DTO only accepts consistent metadata from the requested project, never content or authority',async()=>{
 const m=await load();assert.deepEqual(m.readSqliteStatus(empty(),'P'),empty());assert.deepEqual(m.readSqliteStatus(saved(),'P'),saved());
 for(const change of [v=>v.projectId='other',v=>v.schema='other',v=>v.kind='JSON_DOCUMENT_V1',v=>v.scope='OTHER',v=>v.nativeExecutionGranted=true,v=>v.imageHash='not-a-hash',v=>v.imageBytes=1,v=>v.revision=Infinity,v=>v.usage.versions=1,v=>v.usage.operations=0,v=>v.usage.pending=9,v=>v.usage.bytes=1,v=>v.limits.bytes=0,v=>v.buffer='SECRET_NOT_RENDERED']){const v=saved();change(v);assert.throws(()=>m.readSqliteStatus(v,'P'));}
 for(const change of [v=>v.imageHash='a'.repeat(64),v=>v.contentHash='b'.repeat(64),v=>v.imageBytes=512]){const v=empty();change(v);assert.throws(()=>m.readSqliteStatus(v,'P'));}
});
test('ordinary status distinguishes committed, pending and empty records without implying recovery or model completion',async()=>{
 const m=await load(),a=m.sqliteStatusContent(m.readSqliteStatus(empty(),'P')),b=m.sqliteStatusContent(m.readSqliteStatus(saved(),'P'));
 assert.match(a,/还没有已保存的数据库版本/);assert.match(b,/已保存版本 2/);assert.match(b,/1 次保存仍待核清/);assert.match(b,/计入保存额度/);assert.match(b,/可以另经明确确认.*新的数据库版本/);
 for(const html of [a,b]){assert.match(html,/尚不代表.*验收/);assert.doesNotMatch(html,/data-action="(?:accept|resume|build|json-execute|restore)"|<form|SQLITE_IMAGE_V1|nativeExecutionGranted/);assert.match(html,/data-action="sqlite-status"/);}
 const pending={...empty(),usage:{versions:0,bytes:8192,operations:1,pending:1}};assert.match(m.sqliteStatusContent(m.readSqliteStatus(pending,'P')),/1 次保存仍待核清/);
});
test('loading/error views are plain Chinese, closeable, and never echo raw diagnostics or start a write',async()=>{
 const m=await load();assert.match(m.sqliteStatusLoading(),/正在核对/);
 for(const code of ['SQLITE_DATA_READ_CHANGED','SQLITE_DATA_BUSY','PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED','STORAGE_CUSTODY_REFUSED','<script>secret</script>']){const html=m.sqliteStatusFailure(code);assert.match(html,/保留|核清/);assert.match(html,/data-action="close-modal"/);assert.doesNotMatch(html,/<script>|PROCESS_OWNERSHIP|STORAGE_CUSTODY|SQLITE_DATA|data-action="(?:resume|accept|restore)"/);}
});

test('SQLite restore planning binds exact IDs, source bytes and target revision before confirmation',async()=>{
 const m=await load(),snapshotId='snapshot_'+'a'.repeat(32),rehearsalId='rehearsal_'+'b'.repeat(32);
 const plan={schema:'dream-maker.sqlite-data-restore-plan.v1',scope:'PROJECT_SQLITE_DATA_ONLY',engineStarted:false,projectId:'P',snapshotId,rehearsalId,
  source:{revision:2,contentHash:'c'.repeat(64),imageHash:'d'.repeat(64),imageBytes:8192,at:'2026-11-07T00:00:00.000Z'},target:{revision:4,contentHash:'e'.repeat(64)}};
 assert.deepEqual(m.readSqliteRestorePlan(plan,'P',snapshotId,rehearsalId),plan);
 for(const change of [v=>v.engineStarted=true,v=>v.projectId='other',v=>v.snapshotId='other',v=>v.rehearsalId='other',v=>v.source.imageHash='bad',v=>v.source.imageBytes=1,v=>v.source.at='bad',v=>v.target.revision=0,v=>v.path='C:/outside']){
  const value=structuredClone(plan);change(value);assert.throws(()=>m.readSqliteRestorePlan(value,'P',snapshotId,rehearsalId));
 }
 const html=m.sqliteRestoreConfirmation(plan,'测试项目');
 assert.match(html,/SQLITE_RESTORE|sqlite-restore-form/);assert.match(html,/name="sqliteConsent"/);assert.match(html,/不替换正在使用的应用数据库/);
 assert.doesNotMatch(html,/C:\/outside|TOKEN|SECRET|\schecked(?:\s|>|=)/);
});

test('the original project shell hides this entry in public Demo, fixed Demo, frontend tour and foreign active runs',async t=>{
 const h=harness(t),{p,s}=await ready(h),made=h.engine.create(p.id,s.hash,true);await h.engine.settled(made.id);
 const project=h.store.project(p.id),run=h.store.run(made.id);project.mode='live';run.mode='live';
 const v={mode:'local',screen:'project',projects:[project],snapshot:{project,spec:s,runs:[run],records:[]},settings:null,tab:'work',busy:false,error:'',events:[],connection:'connected',railClosed:false,files:[],fileName:'',fileText:'',previewUrl:'',specSearch:'',logLimit:40,clash:null,draft:()=>'',hasDraft:()=>false};
 assert.match(shell(v),/data-action="sqlite-status"/);
 v.mode='public-demo';assert.doesNotMatch(shell(v),/data-action="sqlite-status"/);v.mode='local';v.presentation='frontend-review';assert.doesNotMatch(shell(v),/data-action="sqlite-status"/);delete v.presentation;
 project.mode='demo';run.mode='demo';assert.doesNotMatch(shell(v),/data-action="sqlite-status"/);project.mode='live';run.mode='live';project.activeRunId='OFFLINE_FOREIGN';assert.doesNotMatch(shell(v),/data-action="sqlite-status"/);
});

test('v1 status rejects quota maxima the service cannot grant',async()=>{
 const m=await load();for(const [key,value]of Object.entries({versions:33,bytes:1073741824,operations:4097,pending:5})){const v=empty();v.limits[key]=value;assert.throws(()=>m.readSqliteStatus(v,'P'),key);}
});
test('aggregate bytes include the known head plus the minimum and maximum sizes of all remaining intents',async()=>{
 const m=await load();for(const bytes of [8192,9215,9217,201326592,536870912,24577]){const v=saved();v.usage.bytes=bytes;assert.throws(()=>m.readSqliteStatus(v,'P'),String(bytes));}
 for(const bytes of [9216,134225920]){const v=saved();v.usage.bytes=bytes;assert.equal(m.readSqliteStatus(v,'P').usage.bytes,bytes);}
 const pending={...empty(),usage:{versions:0,bytes:67108864,operations:1,pending:1}};assert.equal(m.readSqliteStatus(pending,'P').usage.bytes,67108864);
});

test('unknown Intent recovery accepts only anonymous exact metadata and requires its own confirmation',async()=>{
 const m=await load(),operationHash='a'.repeat(64);
 const plan={schema:'dream-maker.sqlite-data-recovery-plan.v1',scope:'PROJECT_SQLITE_DATA_ONLY',projectId:'P',automaticReplay:false,modelCalls:0,
  candidates:[{operationHash,expectedRevision:1,imageBytes:8192,imageHash:'b'.repeat(64),actor:'local-session:'+'c'.repeat(64),at:'2026-11-08T00:00:00.000Z',recoverable:true,blockedReason:null}]};
 assert.deepEqual(m.readSqliteRecoveryPlan(plan,'P'),plan);
 for(const change of [v=>v.projectId='other',v=>v.automaticReplay=true,v=>v.modelCalls=1,v=>v.candidates[0].operationHash='bad',v=>v.candidates[0].expectedRevision=-1,
  v=>v.candidates[0].imageBytes=1,v=>v.candidates[0].imageHash='bad',v=>v.candidates[0].actor='local-session:secret',v=>v.candidates[0].at='bad',
  v=>v.candidates[0].blockedReason='INTENT_BINDING_REQUIRED',
  v=>{v.candidates[0].recoverable=false;v.candidates[0].blockedReason=null},
  v=>v.candidates.push(structuredClone(v.candidates[0])),v=>v.path='F:/outside']){const value=structuredClone(plan);change(value);assert.throws(()=>m.readSqliteRecoveryPlan(value,'P'));}
 const section=m.sqliteRecoverySection(plan),confirmation=m.sqliteRecoveryConfirmation(plan,plan.candidates[0],'测试项目');
 assert.match(section,/data-action="sqlite-recovery"/);assert.match(section,/不会重跑模型、DSH/);
 assert.match(confirmation,/sqlite-recovery-form/);assert.match(confirmation,/name="sqliteRecoveryConsent"/);assert.match(confirmation,/不会重跑模型、DSH/);
 for(const html of [section,confirmation])assert.doesNotMatch(html,/F:\/outside|type":"Buffer|local-session:/);
});

test('legacy or damaged Intent bindings stay visible but never offer recovery',async()=>{
 const m=await load(),base={schema:'dream-maker.sqlite-data-recovery-plan.v1',scope:'PROJECT_SQLITE_DATA_ONLY',projectId:'P',automaticReplay:false,modelCalls:0};
 for(const [blockedReason,text] of [['INTENT_BINDING_REQUIRED',/旧记录.*缺少可信绑定/],['INTENT_BINDING_INVALID',/可信绑定已损坏/]]){
  const plan={...base,candidates:[{operationHash:'a'.repeat(64),expectedRevision:1,imageBytes:8192,imageHash:'b'.repeat(64),
   actor:'local-session:'+'c'.repeat(64),at:'2026-11-08T00:00:00.000Z',recoverable:false,blockedReason}]};
  const checked=m.readSqliteRecoveryPlan(plan,'P'),section=m.sqliteRecoverySection(checked);
  assert.match(section,text);assert.doesNotMatch(section,/data-action="sqlite-recovery"/);
  assert.throws(()=>m.sqliteRecoveryConfirmation(checked,checked.candidates[0],'测试项目'));
 }
});

test('completed SQLite operations survive the strict status DTO with their replay marker',async()=>{
 const m=await load(),operation={hash:'d'.repeat(64),appliedRevision:2,replayed:false},value={...saved(),operation};
 assert.deepEqual(m.readSqliteStatus(value,'P'),value);
 for(const change of [v=>v.operation.hash='bad',v=>v.operation.appliedRevision=0,v=>v.operation.replayed='no',v=>v.operation.path='C:/outside']){const raw=structuredClone(value);change(raw);assert.throws(()=>m.readSqliteStatus(raw,'P'));}
});
