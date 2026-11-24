import {mkdirSync,writeFileSync} from 'node:fs';import {dirname} from 'node:path';
import type {Store} from './store.js';import type {DispatchRecoveryProof} from './flow/ownership-recovery.js';
import type {DocumentationCorrectionCandidate,DocumentationCustodyPrepared} from '../shared/documentation-correction.js';
import {DomainError,hash,id,now,within,object} from './security.js';import {files,get} from './workspace.js';

const fail=():never=>{throw new DomainError('DOCUMENTATION_CUSTODY_CHANGED',409);};
function resultFor(candidate:DocumentationCorrectionCandidate,preparationId:string):DocumentationCustodyPrepared{
 return {schema:'dream-maker.documentation-custody.v1',preparationId,...(candidate.repairKind?{repairKind:candidate.repairKind}:{}),runId:candidate.runId,projectId:candidate.projectId,candidateHash:candidate.candidateHash,sourceHash:candidate.sourceHash,reviewRecordId:candidate.reviewRecordId,taskId:candidate.taskId,writePaths:candidate.writePaths,parentCalls:candidate.parentCalls,parentSupplementalCalls:candidate.parentSupplementalCalls,proposedAdditionalCalls:2,additionalCallsGranted:0,scope:'SOURCE_CUSTODY_ONLY',executionGranted:false,modelDispatched:false};
}
/** Internal copy stage only; all eligibility, ownership and cancellation checks are provided by the original Engine. */
export async function prepareDocumentationCustody(store:Store,data:string,candidate:DocumentationCorrectionCandidate,actor:string,proof:DispatchRecoveryProof,check:()=>DocumentationCorrectionCandidate,room:(bytes:number,nodes:number)=>void):Promise<DocumentationCustodyPrepared>{
 const stableKey='documentation-custody:'+candidate.runId+':'+candidate.reviewRecordId;
 const current=()=>{const c=check();if(c.candidateHash!==candidate.candidateHash)fail();return store.run(c.runId);};
 const validate=(result:DocumentationCustodyPrepared)=>{
  current();const rows=store.db.prepare("SELECT id,kind,data FROM records WHERE project_id=? AND run_id=? AND kind IN ('DocumentationCorrectionCustodyIntent','DocumentationCorrectionPrepared') ORDER BY rowid LIMIT 5").all(candidate.projectId,candidate.runId);
  if(rows.length!==2||rows[0].kind!=='DocumentationCorrectionCustodyIntent'||rows[1].kind!=='DocumentationCorrectionPrepared')return fail();
  const intent=object(JSON.parse(String(rows[0].data))),prepared=object(JSON.parse(String(rows[1].data))),{sha256,...body}=prepared;
  if(sha256!==hash(body)||hash(result)!==hash(resultFor(candidate,result.preparationId))||hash(prepared.result)!==hash(result)||prepared.intentId!==rows[0].id||intent.candidateHash!==candidate.candidateHash||intent.preparationId!==result.preparationId||hash(intent.candidate)!==hash(candidate)||intent.scope!=='SOURCE_CUSTODY_ONLY'||intent.modelDispatched!==false||intent.actorHash!==prepared.actorHash||intent.proofHash!==hash(prepared.proof)||hash(prepared.proof)!==hash(proof)||object(prepared.proof).schema!=='dream-maker.dispatch-recovery.v1'||object(prepared.proof).proven!==true||object(prepared.proof).dispatchId!==candidate.reviewDispatchId||!/^[a-f0-9]{64}$/.test(String(object(prepared.proof).basisSha256)))return fail();
  if(!/^documentation_[a-f0-9]{20}$/.test(result.preparationId))return fail();
  const source=within(data,'controller/executor-waves/'+result.preparationId+'/source');if(hash(files(source))!==candidate.sourceHash)return fail();
  current();return result;
 };
 const result=await store.once(stableKey,{candidateHash:candidate.candidateHash},async()=>{
  const run=current(),catalog=files(run.workspace);if(hash(catalog)!==candidate.sourceHash)return fail();
  if(proof.schema!=='dream-maker.dispatch-recovery.v1'||proof.proven!==true||proof.dispatchId!==candidate.reviewDispatchId||!/^[a-f0-9]{64}$/.test(proof.basisSha256))return fail();
  const preparationId=id('documentation'),source=within(data,'controller/executor-waves/'+preparationId+'/source');
  const directories=new Set<string>();for(const file of catalog){const parts=file.path.split('/');for(let n=1;n<parts.length;n++)directories.add(parts.slice(0,n).join('/'));}
  // Original staging guard charges allocation-unit overhead for every file and
  // directory, plus the new preparation/source roots, rather than two tool files.
  room(catalog.reduce((sum,f)=>sum+f.bytes,0),catalog.length+directories.size+2);current();
  const intentId=store.record('DocumentationCorrectionCustodyIntent',candidate.projectId,candidate.runId,{preparationId,candidateHash:candidate.candidateHash,candidate,actorHash:hash(actor),proofHash:hash(proof),at:now(),scope:'SOURCE_CUSTODY_ONLY',modelDispatched:false});
  mkdirSync(source,{recursive:true,mode:0o700});
  for(const file of catalog){const bytes=get(run.workspace,file.path);if(bytes.length!==file.bytes||hash(bytes)!==file.sha256)return fail();const target=within(source,file.path);mkdirSync(dirname(target),{recursive:true,mode:0o700});within(source,file.path);writeFileSync(target,bytes,{flag:'wx',mode:0o600,flush:true});}
  if(hash(files(source))!==candidate.sourceHash)return fail();
  return store.tx(()=>{
   current();if(hash(files(source))!==candidate.sourceHash)return fail();
   const value=resultFor(candidate,preparationId);
   const body={intentId,result:value,proof,actorHash:hash(actor),at:now()};store.record('DocumentationCorrectionPrepared',candidate.projectId,candidate.runId,{...body,sha256:hash(body)});return value;
  });
 });
 return validate(result);
}
