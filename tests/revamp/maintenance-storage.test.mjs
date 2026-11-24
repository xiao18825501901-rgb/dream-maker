import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMaintenanceRoom} from '../../dist/server/maintenance-storage.js';
test('one shared quota counts both original and archive copies before another copy is written',()=>{
 assert.doesNotThrow(()=>assertMaintenanceRoom(600000000,400000000,900000000n));
 assert.throws(()=>assertMaintenanceRoom(600000000,400000001,900000000n),{code:'MAINTENANCE_STORAGE_LIMIT'});
 assert.throws(()=>assertMaintenanceRoom(600000000,600000000,2000000000n),{code:'MAINTENANCE_STORAGE_LIMIT'});
 assert.throws(()=>assertMaintenanceRoom(0,1,256000000n),{code:'MAINTENANCE_STORAGE_LIMIT'});
 assert.throws(()=>assertMaintenanceRoom(Number.MAX_SAFE_INTEGER,1,900000000n),{code:'MAINTENANCE_STORAGE_LIMIT'});
});
test('tiny files on a measured large allocation unit cannot consume the protected disk margin',()=>{
 assert.throws(()=>assertMaintenanceRoom(0,20843216,300000000n,'MAINTENANCE_STORAGE_LIMIT',{files:2006,directories:8,unit:32768n}),{code:'MAINTENANCE_STORAGE_LIMIT'});
});
test('exFAT 128KB cluster size is capped so the physical estimate does not explode',()=>{
  assert.doesNotThrow(()=>assertMaintenanceRoom(2700000,167000000,3000000000n,'EXECUTOR_SLICE_STORAGE_LIMIT',{files:16000,directories:16020,unit:131072n}));
  assert.throws(()=>assertMaintenanceRoom(2700000,167000000,300000000n,'EXECUTOR_SLICE_STORAGE_LIMIT',{files:16000,directories:16020,unit:131072n}),{code:'EXECUTOR_SLICE_STORAGE_LIMIT'});
});
