// Controller result contracts only; fabricated receipts below are not OS or Native proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sandbox from '../../dist/server/wsl-sandbox.js';
import {sqliteInputDescriptor} from '../../dist/server/sqlite-channel.js';
import {hash} from '../../dist/server/security.js';

const emptyHash=hash(Buffer.alloc(0));
function fixture(){
 const expected={jobId:'wsl_job_sqlite_contract',sourceHash:'a'.repeat(64),workerHash:'b'.repeat(64),environment:sandbox.WSL_ENVIRONMENT,
  descriptor:sqliteInputDescriptor(null,{inputHash:'c'.repeat(64),expectedRevision:0}),snapshotHelperHash:'d'.repeat(64)};
 const image=Buffer.alloc(8192);Buffer.from('SQLite format 3\0').copy(image);image.writeUInt16BE(4096,16);image[18]=image[19]=1;
 const sqlite={schema:'dream-maker.sqlite-execution.v1',...expected.descriptor,snapshotHelperHash:expected.snapshotHelperHash,
  snapshotStatus:'READY',snapshot:{schema:'dream-maker.sqlite-snapshot.v1',bytes:image.length,sha256:hash(image),integrity:'ok',sqliteVersion:'3.45.1'},
  generatedPidsAfter:[],snapshotPidsAfter:[],privateMountNamespace:true,runTmpfsBytes:33554432,dataTmpfsBytes:218103808,mountsRemoved:true,
  retention:{schema:'dream-maker.sqlite-retention.v1',state:'RETAINED',bytes:8192,manifestHash:'e'.repeat(64)}};
 // The descriptor schema is deliberately separate from the result schema.
 sqlite.schema='dream-maker.sqlite-execution.v1';
 const result={schema:'dream-maker.wsl-result.v1',jobId:expected.jobId,sourceHash:expected.sourceHash,workerHash:expected.workerHash,environment:expected.environment,
  status:'EXECUTED',exitCode:0,stdout:'',stderr:'',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true},sqlite};
 const frame={schema:'dream-maker.sqlite-frame.v1',kind:'SQLITE_IMAGE_V1',inputHash:expected.descriptor.inputHash,expectedRevision:0,imageBytes:image.length,imageHash:hash(image),result};
 return {expected,result,frame,image};
}
test('SQLite launch uses the original sandbox and result gate with a separate binary return value',()=>{
 assert.equal(typeof sandbox.WslSandbox.prototype.runSqlite,'function');
 const f=fixture();assert.equal(sandbox.checkSqliteSandboxResult(f.result,f.expected,f.frame),f.result);
 assert.equal(JSON.stringify(f.result).includes('"type":"Buffer"'),false);
});
test('SQLite result rejects changed input/revision/helper, unquiesced stages and unproven mounts or retention',()=>{
 const f=fixture();
 for(const patch of [{inputHash:'f'.repeat(64)},{expectedRevision:1},{imageHash:'f'.repeat(64)},{imageBytes:512},
  {snapshotHelperHash:'f'.repeat(64)},{generatedPidsAfter:['9']},{snapshotPidsAfter:['10']},{privateMountNamespace:false},
  {runTmpfsBytes:1},{dataTmpfsBytes:1},{mountsRemoved:false},{retention:{...f.result.sqlite.retention,state:'UNKNOWN'}}]){
  const result={...f.result,sqlite:{...f.result.sqlite,...patch}};
  assert.throws(()=>sandbox.checkSqliteSandboxResult(result,f.expected,{...f.frame,result}),{code:'SQLITE_SANDBOX_RESULT_UNPROVEN'});
 }
 assert.throws(()=>sandbox.checkSqliteSandboxResult({...f.result,cleanup:{...f.result.cleanup,sourceUnchanged:false}},f.expected,f.frame),{code:'SANDBOX_RESULT_OR_CLEANUP_UNPROVEN'});
});
test('SQLite output bytes must agree with the fixed snapshot, frame and successful generated exit',()=>{
 const f=fixture();
 for(const patch of [{imageHash:emptyHash},{imageBytes:0},{inputHash:'f'.repeat(64)},{expectedRevision:1}])
  assert.throws(()=>sandbox.checkSqliteSandboxResult(f.result,f.expected,{...f.frame,...patch}),{code:'SQLITE_SANDBOX_RESULT_UNPROVEN'});
 for(const patch of [{exitCode:1},{status:'TIMED_OUT'}])assert.throws(()=>sandbox.checkSqliteSandboxResult({...f.result,...patch},f.expected,f.frame),{code:'SQLITE_SANDBOX_RESULT_UNPROVEN'});
 for(const snapshot of [null,{...f.result.sqlite.snapshot,integrity:'self-reported'}, {...f.result.sqlite.snapshot,bytes:4096}])
  assert.throws(()=>sandbox.checkSqliteSandboxResult({...f.result,sqlite:{...f.result.sqlite,snapshot}},f.expected,f.frame),{code:'SQLITE_SANDBOX_RESULT_UNPROVEN'});
});
test('cancelled or rejected SQLite work preserves evidence but never returns a snapshot as a committed result',()=>{
 const f=fixture();
 for(const status of ['CANCELLED','TIMED_OUT','EXECUTED']){
  const result={...f.result,status,exitCode:status==='EXECUTED'?0:-9,sqlite:{...f.result.sqlite,snapshotStatus:status==='EXECUTED'?'REJECTED':'NOT_RUN',snapshot:null}};
  const frame={...f.frame,imageBytes:0,imageHash:emptyHash,result};
  assert.equal(sandbox.checkSqliteSandboxResult(result,f.expected,frame),result);
  assert.throws(()=>sandbox.checkSqliteSandboxResult(result,f.expected,{...frame,imageBytes:f.image.length,imageHash:hash(f.image)}),{code:'SQLITE_SANDBOX_RESULT_UNPROVEN'});
 }
});

test('oversized SQLite input is rejected before cloning the caller buffer',async()=>{
 const body=Buffer.alloc(64*1024*1024+512),original=Buffer.from;let copied=false,pending;
 Buffer.from=function(value,...rest){if(value===body)copied=true;return original(value,...rest);};
 try{pending=new sandbox.WslSandbox(process.cwd()).runSqlite(process.cwd(),{},body,{inputHash:'a'.repeat(64),expectedRevision:1});}
 finally{Buffer.from=original;}
 await assert.rejects(pending);assert.equal(copied,false);
});
