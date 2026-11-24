import test from 'node:test';
import assert from 'node:assert/strict';
import {readRegisteredBackups,readRegisteredExtraction,registeredBackupPanel,registeredBackupConfirmation,registeredBackupError} from '../../dist/web/registered-backup-view.js';
const status={schema:'dream-maker.registered-maintenance.v1',scope:'REGISTERED_STATE_AND_PROJECT_FILES',completeProjectBackup:false,items:[{id:'snapshot_'+'a'.repeat(32),createdAt:new Date().toISOString(),integrity:'NOT_RECHECKED'}],usage:{backups:1,extractions:0,bytes:200,limitBytes:1000000000},modelsCalled:0,automaticResume:false};
test('registered backup UI names all-project scope, exclusions and current file revalidation',()=>{
 assert.deepEqual(readRegisteredBackups(status),status);assert.throws(()=>readRegisteredBackups({...status,completeProjectBackup:true}));assert.throws(()=>readRegisteredBackups({...status,items:[{...status.items[0],id:'../outside'}]}));
 const html=registeredBackupPanel(status,undefined,false);assert.match(html,/全部项目/);assert.match(html,/凭据|账户/);assert.match(html,/未登记|外部/);assert.match(html,/重新核对/);assert.match(html,/registered-extract/);assert.match(registeredBackupPanel(undefined,undefined,false),/disabled/);
});
test('registered extraction needs explicit separate consent and never claims live state was replaced',()=>{
 for(const kind of ['create','extract'])assert.match(registeredBackupConfirmation(kind,status.items[0].id),/name="registeredConsent" required/);
 const restored={schema:'dream-maker.registered-extraction.v1',id:'recovered_'+'b'.repeat(32),backupId:status.items[0].id,operationHash:'c'.repeat(64),sourceManifestHash:'d'.repeat(64),createdAt:new Date().toISOString(),directory:'F:\\example\\<svg onload=bad()>',scope:'SIDE_BY_SIDE_EXTRACTION_ONLY',workingDataReplaced:false,executionGranted:false,automaticResume:false,files:8,bytes:200};
 assert.deepEqual(readRegisteredExtraction(restored,status.items[0].id),restored);assert.throws(()=>readRegisteredExtraction({...restored,workingDataReplaced:true},status.items[0].id));
 const html=registeredBackupPanel(status,restored,false);assert.doesNotMatch(html,/<svg/);assert.match(html,/原.*数据.*没有.*覆盖/);assert.match(html,/提取/);assert.match(registeredBackupError('REGISTERED_BACKUP_FILE_CHANGED'),/保留|停止/);
});
