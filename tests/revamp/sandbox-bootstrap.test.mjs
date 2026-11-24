// Trusted bootstrap protocol tests; no WSL, account, model or generated code is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as boundary from '../../dist/server/sandbox-resource.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const worker="import os\nassert payload['jobId']=='wsl_job_fixture'\nos.write(1,transport_tail+b'\\n')";
const helper="def run_resource_context(payload, worker, helper_hash, tail):\n exec(compile(worker,'<test-worker>','exec'),{'payload':payload,'transport_tail':tail})\n";
function run(patch={},suffix=Buffer.alloc(0)){
 const payload={schema:'dream-maker.wsl-job.v2',jobId:'wsl_job_fixture',workerHash:sha(worker),worker,resourceHelperHash:sha(helper),resourceHelper:helper,...patch};
 return spawnSync('python',['-I','-c',boundary.sandboxBootstrap(sha(worker),sha(helper))],{input:Buffer.concat([Buffer.from(JSON.stringify(payload)+'\n'),suffix]),encoding:'utf8',windowsHide:true,timeout:5000});
}
test('bootstrap verifies both frozen programs before evaluating either and preserves binary tail',()=>{
 assert.equal(typeof boundary.sandboxBootstrap,'function');
 const r=run({},Buffer.from('binary-tail'));assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'binary-tail\n');
});
test('altered worker/helper, even with rewritten payload digests, never executes',()=>{
 assert.equal(typeof boundary.sandboxBootstrap,'function');
 for(const key of ['worker','resourceHelper'])for(const resigned of [false,true]){
  const bad="print('UNTRUSTED_EXECUTED')",p={[key]:bad,...(resigned?{[key==='worker'?'workerHash':'resourceHelperHash']:sha(bad)}:{})};
  const r=run(p);assert.notEqual(r.status,0);assert.ok(!r.stdout.includes('UNTRUSTED_EXECUTED'));assert.match(r.stderr,/SANDBOX_PROGRAM_PIN_MISMATCH/);
 }
});
test('duplicate metadata keys, missing newline and overlong metadata are rejected before execution',()=>{
 assert.equal(typeof boundary.sandboxBootstrap,'function');
 for(const input of [Buffer.from('{"worker":1,"worker":2}\n'),Buffer.from('{}'),Buffer.alloc(40000001,32)]){
  const r=spawnSync('python',['-I','-c',boundary.sandboxBootstrap(sha(worker),sha(helper))],{input,encoding:'utf8',timeout:10000,windowsHide:true});
  assert.notEqual(r.status,0);assert.ok(!r.stdout.includes('UNTRUSTED_EXECUTED'));
 }
});
