import {DomainError} from '../security.js';
import type {Store} from '../store.js';
import {ExecutorSlices,type ExecutorAssignment} from './executor-slices.js';
import type {Run} from '../../shared/types.js';
/** All grants still pass through Engine.role and the existing serial paid dispatch slot. */
export async function executeExecutorWave(input:{store:Store;slices:ExecutorSlices;runId:string;signal:AbortSignal;
 turn:(assignment:ExecutorAssignment,signal:AbortSignal)=>Promise<unknown>;gate:(run:Run)=>void;commit:(run:Run,sourceHash:string,taskIds:string[])=>void}){
 const {store,slices,runId}=input,wave=slices.prepare(runId),controller=new AbortController(),signal=AbortSignal.any([input.signal,controller.signal]);
 let firstFailure:unknown;
 await Promise.allSettled(wave.assignments.map(async assignment=>{
  try{
   if(slices.sealed(runId,assignment.id))return;
   if(store.run(runId).tasks.find(task=>task.id===assignment.taskId)?.status!=='pending')throw new DomainError('EXECUTOR_SLICE_RESULT_UNCERTAIN',409);
   if(signal.aborted)throw signal.reason??new DomainError('RUN_CANCELLED',409);
   await input.turn(assignment,signal);slices.seal(runId,assignment.id);
  }catch(error){if(firstFailure===undefined)firstFailure=error;controller.abort(error);}
 }));
 if(firstFailure!==undefined){
  if(firstFailure instanceof DomainError&&['RUNNER_RPC_ERROR','RPC_REQUEST_TIMEOUT','DSH_HOST_TIMEOUT'].includes(firstFailure.code))throw new DomainError('EXECUTOR_SLICE_RESULT_UNCERTAIN',409);
  throw firstFailure;
 }
 if(input.signal.aborted)throw input.signal.reason??new DomainError('RUN_CANCELLED',409);
 if(store.run(runId).state==='PAUSE_REQUESTED')throw new DomainError('DISPATCH_PAUSED',409);
 return slices.merge(runId,wave.id,input.signal,input.gate,(r,hash)=>input.commit(r,hash,wave.assignments.map(a=>a.taskId)));
}
