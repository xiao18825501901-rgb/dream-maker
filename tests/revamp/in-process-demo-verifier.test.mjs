// OFFLINE helper checks. No Native/WSL/model evidence or production database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync,cpSync,mkdtempSync,mkdirSync,rmSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inProcessDemoVerifier} from '../fixtures/in-process-demo-verifier.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
function fixture(t){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
 const workspace=mkdtempSync(resolve(parent,'offline-in-process-verifier-'));
 cpSync(resolve(root,'examples/study-board'),workspace,{recursive:true});
 t.after(()=>rmSync(workspace,{recursive:true,force:true}));
 let cleanup=0;
 const h={store:{run:()=>({mode:'demo',workspace})},engine:{dispatch:{run:async(request,action)=>action({confirmCleanup(){cleanup++;}})}}};
 inProcessDemoVerifier(h);return{h,workspace,cleanup:()=>cleanup};
}
test('OFFLINE Demo executes the original twelve assertions without a subprocess',async t=>{
 const {h,cleanup}=fixture(t),argv=process.argv,log=console.log;
 const result=await h.engine.dispatch.run({kind:'verifier',mode:'demo',runId:'OFFLINE'},()=>{throw Error('SUBPROCESS_MUST_NOT_START');});
 assert.equal(result.code,0);assert.match(result.stdout,/OFFLINE_IN_PROCESS_DEMO_VERIFIER/);
 assert.equal(result.stdout.split('\n').filter(line=>line.startsWith('PASS ')).length,12);
 assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)),{schema:'dream-maker.verification.v1',checks:12,result:'PASS',scope:'DEMO_TEMPLATE_ONLY'});
 assert.equal(cleanup(),1);assert.equal(process.argv,argv);assert.equal(console.log,log);
});
test('OFFLINE failed original assertion stays failed and restores process globals',async t=>{
 const {h,workspace,cleanup}=fixture(t),argv=process.argv,log=console.log;unlinkSync(resolve(workspace,'README.md'));
 const result=await h.engine.dispatch.run({kind:'verifier',mode:'demo',runId:'OFFLINE'},()=>{});
 assert.equal(result.code,1);assert.doesNotMatch(result.stdout,/"result":"PASS"/);
 assert.equal(cleanup(),1);assert.equal(process.argv,argv);assert.equal(console.log,log);
});
test('Live verifier and other dispatches always retain the original action',async t=>{
 const {h,cleanup}=fixture(t);let calls=0;
 for(const request of [{kind:'verifier',mode:'live'},{kind:'executor',mode:'demo'}]){
  assert.equal(await h.engine.dispatch.run(request,()=>{calls++;return'ORIGINAL_ACTION';}),'ORIGINAL_ACTION');
 }
 assert.equal(calls,2);assert.equal(cleanup(),0);
});
test('altered Demo module is rejected before import without leaving a pending action',async t=>{
 const {h,workspace,cleanup}=fixture(t),argv=process.argv,log=console.log;
 appendFileSync(resolve(workspace,'board.mjs'),'\nthrow Error("MUST_NOT_IMPORT");\n');
 await assert.rejects(h.engine.dispatch.run({kind:'verifier',mode:'demo',runId:'OFFLINE'},()=>{}),/OFFLINE_VERIFIER_TRUSTED_TEMPLATE_REQUIRED/);
 assert.equal(cleanup(),1);assert.equal(process.argv,argv);assert.equal(console.log,log);
});
