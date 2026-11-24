// OFFLINE UI contract only. No browser, model, account or formal database writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceErrorMessage,maintenancePage} from '../../dist/web/maintenance-view.js';

test('maintenance UI explains SQLite attachment scope and uncertain operations without claiming recovery',()=>{
 assert.match(maintenanceErrorMessage('MAINTENANCE_SQLITE_OPERATION_UNCERTAIN'),/尚未核清/);
 assert.match(maintenanceErrorMessage('MAINTENANCE_SQLITE_IMAGE_CHANGED'),/摘要不一致/);
 const state={
  schema:'dream-maker.maintenance.v1',scope:'APPLICATION_STATE_ONLY',completeProjectBackup:false,modelsCalled:0,automaticResume:false,
  usage:{bytes:4096,limitBytes:1000000000,snapshots:1,rehearsals:0},snapshots:[{
   schema:'dream-maker.state-snapshot.v2',id:'snapshot_'+'a'.repeat(32),operationHash:'a'.repeat(64),createdAt:'2026-11-07T00:00:00.000Z',
   scope:'APPLICATION_STATE_ONLY',completeProjectBackup:false,status:'RECORDED_NOT_RECHECKED',application:{projects:1,planVersions:1,approvals:1,runs:0,records:0,events:0},
   budget:{status:'UNAVAILABLE'},files:[{path:'application.sqlite',bytes:2048,sha256:'b'.repeat(64)}],
   sqliteImages:{status:'CAPTURED',files:1,bytes:2048},attachments:[{path:'sqlite-images/'+'c'.repeat(64)+'.sqlite',projectId:'project_fixture',revision:1,
    operationHash:'c'.repeat(64),bytes:2048,sha256:'d'.repeat(64),contentHash:'e'.repeat(64),sourceRunId:'run_fixture',sourceTreeHash:'f'.repeat(64)}],
   exclusions:['GENERATED_PROJECT_FILES','EXTERNAL_BUSINESS_DATA','CREDENTIAL_DIRECTORIES','CONFIGURATION_AND_RUNNERS']
  }]
 },result={schema:'dream-maker.state-rehearsal.v1',id:'rehearsal_'+'1'.repeat(32),operationHash:'1'.repeat(64),sourceManifestHash:'2'.repeat(64),snapshotId:'snapshot_'+'a'.repeat(32),createdAt:'2026-11-07T00:00:01.000Z',scope:'READONLY_RESTORE_REHEARSAL_ONLY',engineStarted:false,application:{projects:1,planVersions:1,approvals:1,runs:0,records:0,events:0},budget:{status:'UNAVAILABLE'}};
 const page=maintenancePage(state,result,undefined,[{id:'project_fixture',name:'测试项目',mode:'live'}]);
 assert.match(page,/1 份项目数据库镜像/);
 assert.match(page,/由原 Store 锚点绑定/);
 assert.match(page,/data-action="sqlite-data-restore"/);
 assert.match(page,/新增.*数据版本/);
 assert.match(page,/不覆盖旧版本/);
 assert.doesNotMatch(page,/完整项目已恢复/);
});
