import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
import {root} from '../helpers.mjs';import {childEnv} from '../../dist/server/security.js';
test('interrupted review ownership observations are deferred through material CAS and transaction (OFFLINE)',()=>{
 const out=spawnSync(process.execPath,['--experimental-test-module-mocks','--test',resolve(root,'tests/fixtures/interrupted-review-observation.mjs')],{cwd:root,env:childEnv(),encoding:'utf8',timeout:40000,maxBuffer:1024*1024,windowsHide:true});
 assert.equal(out.status,0,out.stdout+'\n'+out.stderr);assert.match(out.stdout,/tests 10/);
});
