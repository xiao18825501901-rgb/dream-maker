// OFFLINE source identity only. No credential, CLI, model or native audit changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {childEnv} from '../dist/server/security.js';
// The snapshot this asserts over reads the operator's machine-local binding, which the engineering package
// deliberately excludes; in a fresh extraction it exited non-zero and read as a product failure. Absent
// binding skips with a reason, present binding asserts exactly as before.
test('current source receipt binds the public Codex policy, not private runtime config',t=>{
 if(!existsSync(resolve('config/native-owner.local.json'))){t.skip('needs the operator'+String.fromCharCode(39)+'s local binding (excluded from the public package)');return;}
 // The spawnSync timeout below is a deadline only (the snapshot takes ~4s alone). A 15s limit
 // flaked under the full parallel suite, and 45s then flaked again once the suite passed 600
 // tests: the snapshot hashes the whole tree and loses the CPU race, which killed the child and
 // read as "current source receipt fails" instead of "this machine was busy". No assertion changed.
 // Standalone the file passes in ~9s (measured 2026-10-18); 120s only bounds a hung child.
 const file='.runtime/source-policy-'+randomUUID()+'.json';
 try{
  const r=spawnSync(process.execPath,['scripts/snapshot-source.mjs',file],{cwd:resolve('.'),env:childEnv(),encoding:'utf8',timeout:120000});
  assert.equal(r.status,0);
  const receipt=JSON.parse(readFileSync(file,'utf8'));
  const item=receipt.sourceFiles.find(item=>item.path==='config/codex-agent-readonly.toml');
  assert.ok(item);assert.equal(item.sha256,createHash('sha256').update(readFileSync(item.path)).digest('hex'));
  assert.equal(receipt.sourceFiles.some(item=>item.path==='config/local.json'),false);
  assert.equal(receipt.originalEvidencePreserved,true);
 }finally{try{unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}}
});
