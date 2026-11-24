import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {root} from '../helpers.mjs';
import {childEnv} from '../../dist/server/security.js';
test('original Engine commits deferred review observations atomically (OFFLINE child)',()=>{
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--test',resolve(root,'tests/fixtures/review-window-observation.mjs')],
  {cwd:root,env:childEnv(),encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/tests 3/);
});
