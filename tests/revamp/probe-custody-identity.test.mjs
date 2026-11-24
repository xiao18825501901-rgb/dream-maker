// OFFLINE binding regressions; VHDX substitutions use disposable F-drive files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import * as scope from '../../dist/server/probe-custody-scope.js';
import {harness} from '../helpers.mjs';

test('a replacement disk at the same approved path cannot inherit the original file identity',t=>{
 const h=harness(t),path=resolve(h.dir,'ext4.vhdx'),replacement=resolve(h.dir,'replacement.vhdx');
 writeFileSync(path,'original disposable disk');writeFileSync(replacement,'replacement disposable disk');
 const before=scope.probeCustodyDiskIdentity(path);
 renameSync(path,resolve(h.dir,'saved.vhdx'));renameSync(replacement,path);
 const after=scope.probeCustodyDiskIdentity(path);
 assert.throws(()=>scope.assertProbeCustodyDiskIdentity(before,after),{code:'NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED'});
});

test('disk contents may grow while volume, file and creation identity remain pinned',t=>{
 const h=harness(t),path=resolve(h.dir,'ext4.vhdx');writeFileSync(path,'disk');
 const before=scope.probeCustodyDiskIdentity(path);writeFileSync(path,'disk with more allocated data');
 assert.doesNotThrow(()=>scope.assertProbeCustodyDiskIdentity(before,scope.probeCustodyDiskIdentity(path)));
 for(const changed of [{...before,volumeSerial:'1'},{...before,fileId:'1'},{...before,birthtimeNs:'1'},null,{}])
  assert.throws(()=>scope.assertProbeCustodyDiskIdentity(before,changed),{code:'NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED'});
});

test('the original Windows credential path has no dedicated F-drive helper or WSL pin dependency',()=>{
 const unavailable=()=>{throw new Error('DEDICATED_F_ENVIRONMENT_NOT_INSTALLED');};
 assert.deepEqual(scope.probeCustodySourceBinding('stdio',{helper:unavailable,environment:unavailable}),{probeCipherCustody:null,probeCipherEnvironment:null});
 assert.throws(()=>scope.probeCustodySourceBinding('wsl',{helper:unavailable,environment:unavailable}),/DEDICATED_F_ENVIRONMENT_NOT_INSTALLED/);
});
