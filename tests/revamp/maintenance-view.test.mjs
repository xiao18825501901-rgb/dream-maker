// Offline text/interaction contract only; browser/restore/database acceptance is recorded separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenancePage,maintenanceConfirmation} from '../../dist/web/maintenance-view.js';
const snapshot={schema:'dream-maker.maintenance.v1',scope:'APPLICATION_STATE_ONLY',completeProjectBackup:false,modelsCalled:0,automaticResume:false,usage:{bytes:1048576,limitBytes:1000000000,snapshots:1,rehearsals:0},snapshots:[{id:'snapshot_'+'a'.repeat(32),createdAt:'2026-11-01T00:00:00.000Z',status:'RECORDED_NOT_RECHECKED',application:{projects:1,planVersions:2},budget:{status:'UNAVAILABLE'},files:[]}]};
test('maintenance makes state-only coverage and unavailable monetary snapshot explicit, never a full backup',()=>{
 const html=maintenancePage(snapshot);assert.match(html,/数据与维护/);assert.match(html,/不是完整项目备份/);assert.match(html,/业务文件/);assert.match(html,/费用账本.*未包含/);assert.match(html,/1\.00/);assert.match(html,/data-action="maintenance-rehearse"/);assert.doesNotMatch(html,/全部备份成功|完整恢复成功/);
});
test('creating and rehearsing need an unselected explicit confirmation and never accept a file path or credential',()=>{
 for(const kind of ['create','rehearse']){const html=maintenanceConfirmation(kind,'snapshot_'+'a'.repeat(32));assert.match(html,/name="maintenanceConsent"/);assert.doesNotMatch(html,/\schecked(?:\s|>|=)|name="(?:path|token|key)"/);assert.match(html,/不会开始/);assert.match(html,/不覆盖/);}
});
test('incomplete copies expose a warning without a rehearsal action, and imported text is escaped',()=>{
 const html=maintenancePage({...snapshot,snapshots:[{id:'<img src=x>',status:'INCOMPLETE_OR_INVALID',scope:'APPLICATION_STATE_ONLY',completeProjectBackup:false}]});assert.match(html,/未完成|需检查/);assert.doesNotMatch(html,/<img|data-action="maintenance-rehearse"/);
});
test('a successful rehearsal display is bound to its exact snapshot and observation time',()=>{
 const html=maintenancePage(snapshot,{snapshotId:'snapshot_'+'b'.repeat(32),createdAt:'2026-11-01T01:02:03.000Z',application:{projects:1,planVersions:2},budget:{status:'UNAVAILABLE'},engineStarted:false});
 assert.match(html,/snapshot_bbbbb/);assert.match(html,/2026-11-01T01:02:03\.000Z/);assert.doesNotMatch(html,/本次只读演练已核对/);
});
