import type {Store} from '../store.js';
import type {Run,Config} from '../../shared/types.js';
import {DomainError,hash,object} from '../security.js';
import {treeHash} from '../workspace.js';
import {completedEngineeringRoles} from '../flow/role-completion.js';
import {readPrework} from './runtime.js';
import {expandReviewTestDataPool} from '../review-source-pool.js';
import {preworkCloseout,type PreworkContract} from './contract.js';
const fail=():never=>{throw new DomainError('PREWORK_REVIEW_COVERAGE_REQUIRED',409);};
export interface RequirementReview {requirementId:string;artifactPaths:string[];caseIds:string[];acceptanceIds:string[]}
/** Evidence references are checked against the exact packet the real Reviewer saw. */
export function checkPreworkReviewCoverage(contract:PreworkContract,raw:unknown,packet:unknown,acceptance:{id:string;requirementIds:string[]}[]):RequirementReview[] {
 if(!Array.isArray(raw)||raw.length!==contract.requirements.length)return fail();
 const p=object(packet),history=p.sourceHistory;
 if(!Array.isArray(history)||!history.length)return fail();
 const latest=object(history.at(-1)),sourceFiles=latest.files;
 if(!Array.isArray(sourceFiles))return fail();
 const paths=new Set(sourceFiles.map(f=>object(f).path)),tests=expandReviewTestDataPool(p);
 if(!Array.isArray(tests)||!tests.length)return fail();
 let evidence:Record<string,unknown>;try{evidence=object(JSON.parse(String(object(object(tests.at(-1)).data).stdout)));}catch{return fail();}
 const cases=Array.isArray(evidence.cases)?evidence.cases.map(object):[];
 const rows=raw.map(value=>{
  const r=object(value);
  if(Object.keys(r).some(k=>!['requirementId','artifactPaths','caseIds','acceptanceIds'].includes(k))||typeof r.requirementId!=='string'||!contract.requirements.some(x=>x.requirementId===r.requirementId))return fail();
  for(const key of ['artifactPaths','caseIds','acceptanceIds'])if(!Array.isArray(r[key])||(r[key] as unknown[]).length>512||(r[key] as unknown[]).some(x=>typeof x!=='string')||new Set(r[key] as unknown[]).size!==(r[key] as unknown[]).length)return fail();
  const row=r as unknown as RequirementReview;
  if(!row.artifactPaths.length||row.artifactPaths.some(path=>!paths.has(path))||!row.caseIds.length||row.caseIds.some(id=>!cases.some(c=>c.id===id&&c.ok===true&&c.status==='EXECUTED'&&Array.isArray(c.requirementIds)&&c.requirementIds.includes(row.requirementId))))return fail();
  const expected=acceptance.filter(a=>a.requirementIds.includes(row.requirementId)).map(a=>a.id);
  if(hash([...row.acceptanceIds].sort())!==hash(expected.sort()))return fail();
  const requiredCases=cases.filter(c=>Array.isArray(c.requirementIds)&&c.requirementIds.includes(row.requirementId));
  if(hash([...row.caseIds].sort())!==hash(requiredCases.map(c=>c.id).sort()))return fail();
  // One case may cover several requirements. Apply the original verifier's
  // acceptance binding rule to that case's full requirement set.
  if(requiredCases.some(c=>{
   if(c.acceptanceIds===undefined)return false;
   const requirements=c.requirementIds as unknown[];
   return !Array.isArray(c.acceptanceIds)||c.acceptanceIds.some(id=>typeof id!=='string'||!acceptance.some(a=>a.id===id&&a.requirementIds.every(req=>requirements.includes(req))));
  }))return fail();
  return structuredClone(row);
 });
 if(new Set(rows.map(r=>r.requirementId)).size!==rows.length)return fail();return rows;
}
export function savePreworkCloseout(store:Store,r:Run,config:Config,rawReview:unknown,packetId:string) {
 if(!r.prework)return; // Never synthesize a contract for an old run.
 const contract=readPrework(store,r);
 if(r.review?.verdict!=='PASS'||!r.verification?.ok||r.review.treeHash!==r.treeHash||r.verification.treeHash!==r.treeHash||treeHash(r.workspace)!==r.treeHash||!completedEngineeringRoles(r,config,store))return fail();
 const row=store.db.prepare("SELECT data FROM records WHERE id=? AND project_id=? AND run_id=? AND kind='ReviewPacket'").get(packetId,r.projectId,r.id);
 if(!row)return fail();const data=object(JSON.parse(String(row.data))),packet=object(data.packet);
 if(hash(packet)!==data.sha256||object(object(packet.prework).contract).contractId!==contract.contractId)return fail();
 const reviews=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='Review' AND json_extract(data,'$.packetId')=?").all(r.projectId,r.id,packetId);
 if(reviews.length!==1)return fail();
 const projection=r.mode==='live'?checkPreworkReviewCoverage(contract,object(rawReview).preworkCoverage,packet,store.spec(r.specId).acceptanceItems??[]):[];
 const actual=contract.requirements.map(req=>({requirementId:req.requirementId,evidence:r.mode==='live'?'E5':'E2',review:r.mode==='live'?'R1':'R0',artifactRef:r.verification!.evidenceId}));
 const closeout=preworkCloseout(contract,actual);
 if(!closeout.coverageReached)return fail();
 const recordId=store.record('PreworkCloseout',r.projectId,r.id,{...closeout,packetId,packetHash:data.sha256,reviewRecordId:reviews[0].id,verificationEvidenceId:r.verification.evidenceId,treeHash:r.treeHash,coverage:projection,scope:r.mode==='live'?'REAL_ROLE_AND_VERIFIER_EVIDENCE':'SYNTHETIC_DEMO_NOT_LIVE'});
 store.event(r.projectId,r.id,'prework.closeout',{contractId:contract.contractId,status:'coverage-reached'});return recordId;
}
