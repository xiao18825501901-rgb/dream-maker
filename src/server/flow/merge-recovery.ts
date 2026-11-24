import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,openSync,writeSync,fsyncSync,closeSync,renameSync,unlinkSync,readdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DomainError,hash,within} from '../security.js';
import {Store} from '../store.js';
import {files,get,treeHash} from '../workspace.js';
import {ExecutorSlices} from './executor-slices.js';
import type {Run} from '../../shared/types.js';
import type {MergeRecoveryRequest,MergeRecoveryResult} from '../../shared/merge-recovery.js';
const fail=(code:string):never=>{throw new DomainError(code,409);};
type Catalog=ReturnType<typeof files>;
interface RecoveryManifest {schema:'dream-maker.merge-recovery-files.v1';id:string;runId:string;waveId:string;operationHash:string;requestHash:string;actor:string;choice:MergeRecoveryRequest['choice'];beforeHash:string;targetHash:string;before:Catalog;createdAt:string}
function sourceBody(root:string,item:Catalog[number]){
 const body=get(root,item.path);if(body.length!==item.bytes||hash(body)!==item.sha256)fail('MERGE_RECOVERY_SOURCE_CHANGED');
 const wal=body.length>=4&&[0x377f0682,0x377f0683].includes(body.readUInt32BE(0));
 if(/\.(?:sqlite|sqlite3|db)(?:-wal|-shm|-journal)?$|-(?:wal|shm|journal)$/i.test(item.path)||body.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))||wal||body.subarray(0,8).equals(Buffer.from([0xd9,0xd5,0x05,0xf9,0x20,0xa1,0x63,0xd7])))fail('MERGE_RECOVERY_DATABASE_UNREGISTERED');
 return body;
}
function writeExclusive(path:string,body:Buffer){mkdirSync(dirname(path),{recursive:true,mode:0o700});const fd=openSync(path,'wx',0o600);try{let offset=0;while(offset<body.length)offset+=writeSync(fd,body,offset,body.length-offset);fsyncSync(fd);}finally{closeSync(fd);}}
/** Trusted file custody only. Original Engine supplies actual OS/route proof and owns termination. */
export class MergeRecoveryFiles {
 constructor(private store:Store,private slices:ExecutorSlices){}
 private rows(rid:string,kind:string){const r=this.store.run(rid);return this.store.records(r.projectId,kind).filter(row=>row.runId===rid);}
 replay(rid:string,input:MergeRecoveryRequest,operationHash:string,actor:string):MergeRecoveryResult|undefined{
  const requestHash=hash({rid,input,actor}),matches=this.rows(rid,'ExecutorMergeRecovered').filter(row=>row.data.operationHash===operationHash);
  if(!matches.length){const pending=this.rows(rid,'ExecutorMergeRecoveryIntent').filter(row=>row.data.operationHash===operationHash);if(pending.length){if(pending.length!==1)fail('MERGE_RECOVERY_JOURNAL_INVALID');if(pending[0].data.requestHash!==requestHash)fail('IDEMPOTENCY_MISMATCH');fail('MERGE_RECOVERY_RESULT_UNCERTAIN');}return undefined;}
  if(matches.length!==1)fail('MERGE_RECOVERY_JOURNAL_INVALID');
  const row=matches[0].data,result=row.result as MergeRecoveryResult;
  if(row.requestHash!==requestHash)fail('IDEMPOTENCY_MISMATCH');
  if(!result||result.schema!=='dream-maker.merge-recovery-result.v1'||result.runId!==rid||result.waveId!==row.waveId||result.recoveryId!==row.recoveryId||result.operationHash!==operationHash||result.choice!==input.choice||result.originalMergeApplied!==false||result.automaticResume!==false||result.executionGranted!==false||result.modelsCalled!==0)fail('MERGE_RECOVERY_JOURNAL_INVALID');
  const {wave}=this.slices.recoveryArtifacts(rid,row.waveId),directory=within(wave.directory,result.recoveryId),path=within(directory,'manifest.json'),stat=lstatSync(path);if(!stat.isFile()||stat.size>4000000)fail('MERGE_RECOVERY_COPY_CHANGED');
  const body=readFileSync(path);if(body.length>4000000||hash(body)!==row.manifestHash)fail('MERGE_RECOVERY_COPY_CHANGED');let manifest:RecoveryManifest;try{manifest=JSON.parse(body.toString('utf8'));}catch{fail('MERGE_RECOVERY_COPY_CHANGED');}
  if(manifest!.requestHash!==requestHash||manifest!.targetHash!==result.sourceHash||manifest!.operationHash!==operationHash||hash(files(within(directory,'before')))!==manifest!.beforeHash)fail('MERGE_RECOVERY_COPY_CHANGED');
  if(this.store.run(rid).state!=='CANCELLED'||treeHash(this.store.run(rid).workspace)!==result.sourceHash)fail('MERGE_RECOVERY_SOURCE_CHANGED');
  return {...result,replayed:true};
 }
 apply(rid:string,input:MergeRecoveryRequest,operationHash:string,actor:string,signal:AbortSignal,cleanupProofHash:string,gate:(run:Run)=>void,commit:(run:Run,result:MergeRecoveryResult)=>void):MergeRecoveryResult{
  const inspection=this.slices.inspectRecovery(rid),{view,wave,current}=inspection,r=this.store.run(rid),requestHash=hash({rid,input,actor}),recoveryId='recovery_'+operationHash.slice(0,32),directory=within(wave.directory,recoveryId);
  if(view.source.currentHash!==input.expectedHash)fail('MERGE_RECOVERY_SOURCE_CHANGED');if(view.previewHash!==input.previewHash)fail('MERGE_RECOVERY_PREVIEW_CHANGED');
  if(!view.canKeepFiles||!view.canRestoreBase||view.sourceState==='EXTERNAL_CHANGE')fail('MERGE_RECOVERY_NOT_ALLOWED');if(signal.aborted)fail('MERGE_RECOVERY_CANCELLED');gate(r);
  if(existsSync(directory)||this.rows(rid,'ExecutorMergeRecoveryIntent').some(row=>row.data.operationHash===operationHash))fail('MERGE_RECOVERY_RESULT_UNCERTAIN');
  if(readdirSync(wave.directory).filter(name=>name.startsWith('recovery_')).length>=8)fail('MERGE_RECOVERY_LIMIT');
  const beforeBodies=new Map(current.map(item=>[item.path,sourceBody(r.workspace,item)]));
  const targetCatalog=input.choice==='RESTORE_BASE_AND_END'?inspection.base:current,targetBodies=input.choice==='RESTORE_BASE_AND_END'?new Map(targetCatalog.map(item=>[item.path,sourceBody(within(wave.directory,'base'),item)])):beforeBodies;
  const targetHash=hash(targetCatalog),bytes=[...beforeBodies.values(),...(input.choice==='RESTORE_BASE_AND_END'?[...targetBodies.values()]:[])].reduce((n,body)=>n+body.length,0);
  this.slices.reserveRecovery(bytes+4000000,current.length+targetCatalog.length+1);
  mkdirSync(directory,{mode:0o700});const beforeRoot=within(directory,'before'),publish=within(directory,'publish');mkdirSync(beforeRoot);mkdirSync(publish);
  for(const [name,body]of beforeBodies)writeExclusive(within(beforeRoot,name),body);
  if(input.choice==='RESTORE_BASE_AND_END')for(const [name,body]of targetBodies)writeExclusive(within(publish,name),body);
  if(hash(files(beforeRoot))!==view.source.currentHash||input.choice==='RESTORE_BASE_AND_END'&&hash(files(publish))!==targetHash)fail('MERGE_RECOVERY_COPY_CHANGED');
  const manifest:RecoveryManifest={schema:'dream-maker.merge-recovery-files.v1',id:recoveryId,runId:rid,waveId:wave.id,operationHash,requestHash,actor,choice:input.choice,beforeHash:view.source.currentHash,targetHash,before:current,createdAt:new Date().toISOString()};
  const body=Buffer.from(JSON.stringify(manifest)),manifestHash=hash(body);if(body.length>4000000)fail('MERGE_RECOVERY_COPY_CHANGED');writeExclusive(within(directory,'manifest.json'),body);
  const check=()=>{if(signal.aborted)fail('MERGE_RECOVERY_CANCELLED');gate(this.store.run(rid));const latest=this.slices.inspectRecovery(rid,true,recoveryId).view;if(latest.source.currentHash!==input.expectedHash)fail('MERGE_RECOVERY_SOURCE_CHANGED');if(latest.previewHash!==input.previewHash)fail('MERGE_RECOVERY_PREVIEW_CHANGED');};
  check();this.store.record('ExecutorMergeRecoveryIntent',r.projectId,rid,{waveId:wave.id,recoveryId,operationHash,requestHash,manifestHash,choice:input.choice,cleanupProofHash,automaticResume:false});
  const result:MergeRecoveryResult={schema:'dream-maker.merge-recovery-result.v1',runId:rid,waveId:wave.id,recoveryId,operationHash,choice:input.choice,sourceHash:targetHash,createdAt:new Date().toISOString(),replayed:false,scope:'SOURCE_FILES_ONLY',flowEnded:true,originalMergeApplied:false,sourceCopiesRetained:true,businessDataChanged:false,modelsCalled:0,executionGranted:false,automaticResume:false};
  this.store.tx(()=>{
   check();const active=this.store.run(rid),previous=new Map(current.map(item=>[item.path,item])),target=new Map(targetCatalog.map(item=>[item.path,item]));
   if(input.choice==='RESTORE_BASE_AND_END')for(const name of [...new Set([...previous.keys(),...target.keys()])].sort()){
    if(signal.aborted)fail('MERGE_RECOVERY_CANCELLED');if(previous.get(name)?.sha256===target.get(name)?.sha256)continue;
    const to=within(active.workspace,name),old=previous.get(name);if(existsSync(to)){if(!old||hash(get(active.workspace,name))!==old.sha256)fail('MERGE_RECOVERY_SOURCE_CHANGED');}else if(old)fail('MERGE_RECOVERY_SOURCE_CHANGED');
    if(target.has(name)){mkdirSync(dirname(to),{recursive:true});within(active.workspace,name);renameSync(within(publish,name),to);}else unlinkSync(to);
   }
   if(treeHash(active.workspace)!==targetHash||hash(files(beforeRoot))!==manifest.beforeHash)fail('MERGE_RECOVERY_SOURCE_CHANGED');
   this.store.record('ExecutorMergeRecovered',r.projectId,rid,{waveId:wave.id,recoveryId,operationHash,requestHash,manifestHash,cleanupProofHash,result});
   commit(active,result);this.store.saveRun(active);this.store.event(r.projectId,rid,'run.merge.recovered',{waveId:wave.id,recoveryId,choice:input.choice,sourceHash:targetHash,originalMergeApplied:false,automaticResume:false});
  });return result;
 }
}
