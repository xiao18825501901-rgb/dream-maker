// OFFLINE tests only. Execute the original trusted Demo assertions without a
// child-process startup dependency. Never installed in a product or Live run.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
let running=false;
export function inProcessDemoVerifier(h){
 const dispatch=h.engine.dispatch,original=dispatch.run;
 dispatch.run=function(request,action){
  if(request.kind!=='verifier'||request.mode!=='demo')return original.call(this,request,action);
  return original.call(this,request,async control=>{
   try{
   const run=h.store.run(request.runId);
   assert.equal(run.mode,'demo','OFFLINE_VERIFIER_DEMO_ONLY');
   assert.equal(running,false,'OFFLINE_VERIFIER_ALREADY_ACTIVE');
   // Only the unchanged controller-owned Demo module may execute in this process.
   assert.deepEqual(readFileSync(resolve(run.workspace,'board.mjs')),readFileSync(resolve(root,'examples/study-board/board.mjs')),'OFFLINE_VERIFIER_TRUSTED_TEMPLATE_REQUIRED');
   const argv=process.argv,log=console.log,lines=['OFFLINE_IN_PROCESS_DEMO_VERIFIER; NO_CHILD_PROCESS; NOT_NATIVE_EVIDENCE'];
   running=true;
   try{
    process.argv=[process.execPath,resolve(root,'scripts/verify-board.mjs'),run.workspace];
    console.log=(...parts)=>lines.push(parts.join(' '));
    await import(pathToFileURL(resolve(root,'scripts/verify-board.mjs')).href+'?offline='+randomUUID());
    return{stdout:lines.join('\n')+'\n',stderr:'',code:0};
   }catch(error){return{stdout:lines.join('\n')+'\n',stderr:String(error?.stack??error),code:1};}
   finally{process.argv=argv;console.log=log;running=false;}
   }finally{control.confirmCleanup();} // No child exists, including rejected preconditions.
  });
 };
 return()=>{dispatch.run=original;};
}
