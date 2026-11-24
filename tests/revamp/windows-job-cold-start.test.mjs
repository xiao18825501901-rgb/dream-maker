// ACTUAL_WINDOWS_LOCAL_BENIGN_STARTUP. No Codex, account, network or generated program.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {WindowsJobSession} from '../../dist/server/flow/windows-job.js';
import {childEnv} from '../../dist/server/security.js';
import {root} from '../helpers.mjs';

test('a bounded cold Windows Job startup remains owned before the first RPC is allowed',
 {skip:process.platform!=='win32',timeout:30000},async()=>{
  const job=new WindowsJobSession(root,process.execPath,['-e','process.stdout.write("benign cold startup")'],root,childEnv());
  // The observed first native launch took 4100 ms to publish ownership. A deterministic
  // delay reproduces that boundary without issuing a model request or relaxing Job limits.
  const args=[...job.args];args[args.length-1]='Start-Sleep -Milliseconds 4300; '+args.at(-1);
  const child=spawn(job.command,args,{cwd:root,env:job.environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  try{
   await job.pin();assert.ok(Number.isSafeInteger(job.targetPid)&&job.targetPid>0);
   const ended=await closed;assert.equal(ended.code,0,stderr);assert.equal(stdout,'benign cold startup');
  }finally{
   await closed;
   const proof=await job.prove();assert.equal(proof.kind,'TRUSTED_WINDOWS_JOB');
  }
 });
