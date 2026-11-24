import test from 'node:test';
import assert from 'node:assert/strict';
import {testHostCapacity} from '../scripts/test-host-capacity.mjs';

test('owner-authorized 1GiB floor uses one test worker below the parallel threshold',()=>{
 const low=testHostCapacity(16,2800);
 assert.deepEqual(low,{workers:1,reservedMiB:512,perWorkerMiB:512});
 assert.equal(testHostCapacity(16,1023).workers,0);
 assert.equal(testHostCapacity(16,1024).workers,1);
 assert.equal(testHostCapacity(16,3072).workers,1);
 assert.equal(testHostCapacity(16,4096).workers,2);
 assert.equal(testHostCapacity(1,4096).workers,1);
});
