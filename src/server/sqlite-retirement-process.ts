import {readFileSync} from 'node:fs';import {resolve} from 'node:path';import {randomBytes} from 'node:crypto';
import type {Store} from './store.js';import {DomainError,hash,object,childEnv} from './security.js';import {own,capture} from './process.js';
import {consumeSqliteRetirementPermit,type SqliteRetirementPermit,type SqliteRetirementBasis} from './sqlite-retirement.js';
import {retirementBootstrap,checkRetirementObservation,type RetirementObservation} from './sqlite-retirement-protocol.js';
import {currentProcessOwnership,inspectOutsideExecutionScope} from './flow/process-ownership.js';
import {WSL_ENVIRONMENT} from './wsl-sandbox.js';
export interface SqliteRetirementInput {permit:SqliteRetirementPermit;signal:AbortSignal}
export interface SqliteRetirementReceipt {schema:'dream-maker.sqlite-retirement-receipt.v1';attemptId:string;jobId:string;authorityHash:string;outcomeHash:string;retired:true;reservationReleased:true;cleanupReturned:true}
export interface RetirementIntent {basis:SqliteRetirementBasis;attemptId:string;helperHash:string;resourceHelperHash:string;environment:string}
type Row={id:string;kind:string;data:Record<string,unknown>};
type Closed={code:number|null;signal:NodeJS.Signals|null};
function waitWithin<T>(promise:Promise<T>,milliseconds:number):Promise<{timedOut:boolean;value?:T}>{
 if(!Number.isSafeInteger(milliseconds)||milliseconds<10||milliseconds>60000)throw new DomainError('SQLITE_RETIREMENT_TIME_LIMIT',409);
 return new Promise((resolve,reject)=>{
  let settled=false;
  const timer=setTimeout(()=>{settled=true;resolve({timedOut:true});},milliseconds);
  promise.then(value=>{
   if(settled)return;settled=true;clearTimeout(timer);resolve({timedOut:false,value});
  },error=>{
   if(settled)return;settled=true;clearTimeout(timer);reject(error);
  });
 });
}
/** Bounds both natural close and fallback-stop proof; neither may leave the caller awaiting forever. */
export async function settleRetirementProcess(closed:Promise<Closed>,stop:()=>Promise<void>,options:{closeMs?:number;stopMs?:number}={}):Promise<Closed>{
 const closeMs=options.closeMs??5000,stopMs=options.stopMs??15000;
 try{
  const first=await waitWithin(closed,closeMs),stopped=await waitWithin(Promise.resolve().then(stop),stopMs);
  if(stopped.timedOut)throw new DomainError('SQLITE_RETIREMENT_CLEANUP_UNPROVEN',502);
  const final=first.timedOut?await waitWithin(closed,closeMs):first;
  if(final.timedOut||!final.value)throw new DomainError('SQLITE_RETIREMENT_CLEANUP_UNPROVEN',502);
  return final.value;
 }catch(error){
  if(error instanceof DomainError&&error.code==='SQLITE_RETIREMENT_CLEANUP_UNPROVEN')throw error;
  throw new DomainError('SQLITE_RETIREMENT_CLEANUP_UNPROVEN',502);
 }
}
export function retirementRootClosure(rows:Row[],processId:string,generation:string){
 const select=(kind:string)=>rows.filter(r=>r.kind===kind&&r.data.processId===processId),intents=select('OwnedProcessIntent'),starts=select('OwnedProcessRootStarted'),ends=select('OwnedProcessRootExited');
 const i=intents[0],s=starts[0],e=ends[0];
 if(intents.length!==1||starts.length!==1||ends.length!==1||!generation||[i,s,e].some(r=>r.data.generation!==generation)||rows.indexOf(i)>=rows.indexOf(s)||rows.indexOf(s)>=rows.indexOf(e)||!Number.isSafeInteger(s.data.pid)||Number(s.data.pid)<=1||typeof s.data.identity!=='string'||!/^win32:[1-9][0-9]{0,19}$/.test(s.data.identity)||e.data.rootClosed!==true||!Number.isSafeInteger(e.data.code)||e.data.signal!==null)throw new DomainError('SQLITE_RETIREMENT_CLEANUP_UNPROVEN',502);
 return {pid:Number(s.data.pid),identity:s.data.identity,startRecordId:s.id,closeRecordId:e.id};
}
function input(root:string,basis:SqliteRetirementBasis,attemptId:string){
 if(!/^retire_attempt_[a-f0-9]{32}$/.test(attemptId))throw new DomainError('SQLITE_RETIREMENT_ATTEMPT_INVALID',409);
 const program=readFileSync(resolve(root,'scripts/isolation/sqlite-retire.py'),'utf8'),resourceProgram=readFileSync(resolve(root,'scripts/isolation/wsl-resource-context.py'),'utf8'),helperHash=hash(program),resourceHelperHash=hash(resourceProgram);
 if(resourceHelperHash!==basis.resourceHelperHash)throw new DomainError('SQLITE_RETIREMENT_RESOURCE_SOURCE_CHANGED',409);
 const line=JSON.stringify({schema:'dream-maker.sqlite-retirement-input.v1',program,resourceProgram,request:{basis,attemptId}})+'\n';
 if(Buffer.byteLength(line)>65536)throw new DomainError('SQLITE_RETIREMENT_PROGRAM_LIMIT',409);
 return {line,helperHash,resourceHelperHash};
}
/** Fixed read-only inspector: no effects or account access; root and guest identity checks are separate. */
export async function readSqliteRetirement(root:string,intent:RetirementIntent):Promise<RetirementObservation>{
 try{
  if(intent.environment!==WSL_ENVIRONMENT)throw Error();const sent=input(root,intent.basis,intent.attemptId);
  if(sent.helperHash!==intent.helperHash||sent.resourceHelperHash!==intent.resourceHelperHash)throw Error();
  const r=await inspectOutsideExecutionScope(()=>capture('wsl.exe',['-d',WSL_ENVIRONMENT,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-I','-c',retirementBootstrap(sent.helperHash,sent.resourceHelperHash,'read')],{cwd:root,env:childEnv(),input:sent.line,timeoutMs:15000,maxBytes:32768}));
  if(r.code!==0)throw Error();return checkRetirementObservation(JSON.parse(r.stdout),intent.basis,intent.attemptId,intent.helperHash);
 }catch{throw new DomainError('SQLITE_RETIREMENT_CLEANUP_UNPROVEN',502);}
}
/** Server-only. A model/HTTP boolean, receipt or fabricated permit cannot reach the process start. */
export async function retireSqliteGuest(store:Store,root:string,request:SqliteRetirementInput):Promise<SqliteRetirementReceipt>{
 const basis=consumeSqliteRetirementPermit(request.permit,store,root,request.signal),owner=currentProcessOwnership()!;
 const attemptId='retire_attempt_'+randomBytes(16).toString('hex'),sent=input(root,basis,attemptId),intent={basis,attemptId,helperHash:sent.helperHash,resourceHelperHash:sent.resourceHelperHash,environment:WSL_ENVIRONMENT};
 if(process.platform!=='win32')throw new DomainError('DEDICATED_WINDOWS_WSL_REQUIRED',409);
 const p=own('wsl.exe',['-d',WSL_ENVIRONMENT,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-I','-c',retirementBootstrap(sent.helperHash,sent.resourceHelperHash,'run')],{cwd:root,env:childEnv(),onIntent:processId=>store.record('OwnedSqliteRetirementIntent',owner.projectId,owner.runId,{processId,dispatchId:owner.dispatchId,generation:owner.generation,...intent,modelCalls:0})});
 let error:Error|undefined,bytes=0,fallback:ReturnType<typeof setTimeout>|undefined;
 const cancel=()=>{p.child.stdin.end();fallback??=setTimeout(()=>{error??=new DomainError('SQLITE_RETIREMENT_CLEANUP_UNPROVEN',502);void p.stop().catch(()=>{});},8000);};
 const abort=()=>{error??=new DomainError('RUN_CANCELLED',409);cancel();};
 const drain=(b:Buffer)=>{bytes+=b.length;if(bytes>32768){error??=new DomainError('SQLITE_RETIREMENT_OUTPUT_LIMIT',502);cancel();}};
 p.child.stdout.on('data',drain);p.child.stderr.on('data',drain);
 p.child.on('error',()=>{error??=new DomainError('WSL_EXECUTABLE_UNAVAILABLE',409);});
 for(const stream of [p.child.stdin,p.child.stdout,p.child.stderr])stream.on('error',()=>{error??=new DomainError('SQLITE_RETIREMENT_CHANNEL_FAILED',502);cancel();});
 const timer=setTimeout(()=>{error??=new DomainError('SQLITE_RETIREMENT_OPERATION_TIMEOUT',504);cancel();},60000);
 request.signal.addEventListener('abort',abort,{once:true});
 const sending=request.signal.aborted?(abort(),Promise.resolve()):new Promise<void>(yes=>p.child.stdin.write(sent.line,e=>{if(e){error??=new DomainError('SQLITE_RETIREMENT_CHANNEL_FAILED',502);cancel();}yes();}));
 try{
  const closed=await settleRetirementProcess(p.closed,p.stop);await sending;
  const rows=store.db.prepare("SELECT id,kind,data FROM records WHERE project_id IS ? AND run_id IS ? AND json_extract(data,'$.dispatchId')=? ORDER BY rowid LIMIT 4097").all(owner.projectId,owner.runId,owner.dispatchId);
  if(rows.length>4096)throw new DomainError('DISPATCH_RECOVERY_RECORD_LIMIT',409);
  const records=rows.map(v=>({id:String(v.id),kind:String(v.kind),data:object(JSON.parse(String(v.data)))}));
  const closure=retirementRootClosure(records,p.processId!,owner.generation),observation=await readSqliteRetirement(root,intent);
  store.record('OwnedSqliteRetirementClosed',owner.projectId,owner.runId,{processId:p.processId,dispatchId:owner.dispatchId,generation:owner.generation,attemptId,jobId:basis.jobId,authorityHash:basis.authorityHash,observationHash:hash(observation),outcome:observation.outcome,rootClosure:closure,helperAbsent:true,modelCalls:0});
  p.proveCleanup({kind:'TRUSTED_WSL_SQLITE_RETIREMENT',scopeId:attemptId,receiptSha256:hash({observation,closure})});
  if(error)throw error;if(request.signal.aborted)throw new DomainError('RUN_CANCELLED',409);
  if(!observation.outcome||closed.code!==0||observation.outcome.status!=='RETIRED')throw new DomainError(observation.outcome?.errorCode??'SQLITE_RETIREMENT_RESULT_UNCERTAIN',409);
  return {schema:'dream-maker.sqlite-retirement-receipt.v1',attemptId,jobId:basis.jobId,authorityHash:basis.authorityHash,outcomeHash:hash(observation.outcome),retired:true,reservationReleased:true,cleanupReturned:true};
 }finally{clearTimeout(timer);if(fallback)clearTimeout(fallback);request.signal.removeEventListener('abort',abort);p.child.stdin.destroy();}
}
