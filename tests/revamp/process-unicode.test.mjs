import test from 'node:test';import assert from 'node:assert/strict';import {capture} from '../../dist/server/process.js';
// Actual benign child transport, no user code, account or model.
test('capture preserves UTF-8 characters split across independent stdout/stderr pipe chunks',async()=>{
 const code="process.stdout.write(Buffer.from([0xe4]));process.stderr.write(Buffer.from([0xe6]));setTimeout(()=>{process.stdout.end(Buffer.from([0xb8,0xad]));process.stderr.end(Buffer.from([0x96,0x87]));},100)";
 const result=await capture(process.execPath,['-e',code],{cwd:process.cwd(),timeoutMs:5000,maxBytes:20});assert.equal(result.code,0);assert.equal(result.stdout,'中');assert.equal(result.stderr,'文');
});
