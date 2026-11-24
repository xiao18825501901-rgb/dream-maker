import test from 'node:test';
import assert from 'node:assert/strict';
import {testHostCapacity} from '../../scripts/test-host-capacity.mjs';
test('test workers preserve the measured execution/supervision margin before expanding the pool',()=>{
 assert.deepEqual(testHostCapacity(16,3114),{workers:1,reservedMiB:2560,perWorkerMiB:512});
 assert.equal(testHostCapacity(16,4096).workers,2);assert.equal(testHostCapacity(16,32768).workers,2);
 assert.equal(testHostCapacity(1,4096).workers,1);assert.equal(testHostCapacity(16,1724).workers,1);assert.equal(testHostCapacity(16,3071).workers,1);assert.equal(testHostCapacity(16,3072).workers,1);
});
test('invalid resource samples never become unbounded worker counts',()=>{
 for(const [cpu,memory]of [[0,4000],[1,-1],[1,NaN],[Infinity,4000],[1.5,4000]])assert.throws(()=>testHostCapacity(cpu,memory),/TEST_HOST_SAMPLE_INVALID/);
});
