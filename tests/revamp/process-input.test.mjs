import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {capture} from '../../dist/server/process.js';
import {childEnv} from '../../dist/server/security.js';
import {harness} from '../helpers.mjs';
test('owned capture delivers bounded controller input through stdin and only returns the child result',async t=>{
 const h=harness(t),input='仅在可信进程间传送的合成数据';
 const r=await capture(process.execPath,['-e',"const c=require('node:crypto');let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>console.log(c.createHash('sha256').update(b).digest('hex')));"],{cwd:h.dir,env:childEnv(),input});
 assert.equal(r.code,0);assert.equal(r.stdout.trim(),createHash('sha256').update(input).digest('hex'));assert.equal(r.stderr.includes(input),false);
});
test('owned capture can observe stdout while retaining the final bounded result',async t=>{
 const h=harness(t),observed=[];
 const r=await capture(process.execPath,['-e',"process.stdout.write('ready\\n');setTimeout(()=>process.stdout.write('complete\\n'),25);"],{
  cwd:h.dir,env:childEnv(),onStdout:chunk=>observed.push(chunk)
 });
 assert.equal(r.code,0);
 assert.equal(observed.join(''),'ready\ncomplete\n');
 assert.equal(r.stdout,'ready\ncomplete\n');
});
test('oversized controller input refuses before creating the owned child',async t=>{
 const h=harness(t),marker=resolve(h.dir,'must-not-launch');
 await assert.rejects(capture(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'unexpected')",marker],{cwd:h.dir,env:childEnv(),input:'x'.repeat(65537)}),{code:'PROCESS_INPUT_LIMIT'});assert.equal(existsSync(marker),false);
});
test('explicit bounded review packets can exceed the default stdin allowance',async t=>{
 const h=harness(t),input='x'.repeat(70000);
 const r=await capture(process.execPath,['-e',"let n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>console.log(n));"],{cwd:h.dir,env:childEnv(),input,maxInputBytes:131072});
 assert.equal(r.code,0);assert.equal(r.stdout.trim(),'70000');
});
test('invalid or exceeded explicit input ceilings refuse before spawn',async t=>{
 const h=harness(t),marker=resolve(h.dir,'must-not-launch-large');
 for(const options of [{maxInputBytes:Infinity},{maxInputBytes:4194305},{maxInputBytes:65536,input:'x'.repeat(65537)}])await assert.rejects(capture(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'unexpected')",marker],{cwd:h.dir,env:childEnv(),...options}),{code:'PROCESS_INPUT_LIMIT'});
 assert.equal(existsSync(marker),false);
});
