import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {selectTestFiles} from '../scripts/select-test-files.mjs';

const root=resolve('tests');
const files=['codex-admission.test.mjs','revamp/role-policy.test.mjs'].map(p=>resolve(root,p));
test('explicit npm test targets select only discovered files, with stable deduplication',()=>{
 assert.deepEqual(selectTestFiles(files,['tests/codex-admission.test.mjs',files[0]],resolve('.')),files.slice(0,1));
 assert.deepEqual(selectTestFiles(files,['tests/revamp/role-policy.test.mjs'],resolve('.')),files.slice(1));
 assert.deepEqual(selectTestFiles(files,[],resolve('.')),files);
});
test('unsupported flags, absent files and paths outside the discovered suite fail before launching tests',()=>{
 for(const args of [['--grep','custom'],['tests/missing.test.mjs'],['../outside.test.mjs'],['tests']]){
  assert.throws(()=>selectTestFiles(files,args,resolve('.')),/TEST_TARGET_NOT_DISCOVERED/);
 }
});
