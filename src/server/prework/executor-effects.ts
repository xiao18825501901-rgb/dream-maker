import {DomainError,hash} from '../security.js';
export interface EffectIdentity {dispatchId:string;generation:string;sliceId?:string;taskId?:string;sessionId:string}
export interface EffectRow {id:string;kind:string;ordinal:number;data:Record<string,unknown>}
function fail():never{throw new DomainError('REVIEW_ROLE_EVIDENCE_REQUIRED',409);}
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bounded=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=500&&v.trim()===v&&!/[\x00-\x1f]/.test(v);
/** Account for each completed executor turn: a real paired write, or an exactly
 * sealed unchanged task subsequently published by the original merge coordinator.
 * Neither path verifies functionality or substitutes for the project Reviewer. */
export function checkedExecutorEffectCoverage(entries:EffectIdentity[],rows:EffectRow[],specHash:string) {
 if(!entries.length||!sha(specHash)||rows.length>20000||new Set(rows.map(r=>r.id)).size!==rows.length||new Set(rows.map(r=>r.ordinal)).size!==rows.length||rows.some(r=>!bounded(r.id)||!Number.isSafeInteger(r.ordinal)||r.ordinal<1))fail();
 return entries.map(identity=>{
  if(!bounded(identity.dispatchId)||!bounded(identity.generation)||!bounded(identity.sessionId)||identity.sliceId!==undefined&&!bounded(identity.sliceId)||identity.taskId!==undefined&&!bounded(identity.taskId))return fail();
  const grants=rows.filter(r=>r.kind==='DispatchGranted'&&r.data.dispatchId===identity.dispatchId),ends=rows.filter(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===identity.dispatchId);
  if(grants.length!==1||ends.length!==1) return fail();const grant=grants[0],end=ends[0];
  if(grant.data.kind!=='executor'||grant.data.generation!==identity.generation||grant.data.executorSliceId!==identity.sliceId||end.data.generation!==identity.generation||end.data.outcome!=='COMPLETED'||end.data.cleanupReturned!==true||grant.ordinal>=end.ordinal)return fail();
  const intents=rows.filter(r=>r.kind==='ToolIntent'&&r.ordinal>grant.ordinal&&r.ordinal<end.ordinal&&r.data.sliceId===identity.sliceId);
  const results=rows.filter(r=>r.kind==='ToolResult'&&r.ordinal>grant.ordinal&&r.ordinal<end.ordinal&&r.data.sliceId===identity.sliceId);
  if(results.some(r=>!intents.some(i=>i.id===r.data.intentId)))return fail();
  const pairs=intents.map(intent=>{
   if(intent.data.specHash!==specHash||!['desk_read','desk_search','desk_write','desk_edit','desk_run'].includes(String(intent.data.tool)))return fail();
   const matched=results.filter(r=>r.data.intentId===intent.id);
   if(matched.length!==1||matched[0].ordinal<=intent.ordinal||matched[0].data.tool!==intent.data.tool||!['COMPLETE','FAILED_NO_EFFECT'].includes(String(matched[0].data.status)))return fail();
   const result=matched[0];if(result.data.status==='COMPLETE'&&(result.data.specHash!==specHash||!sha(result.data.sourceHash)))return fail();
   return{intent,result};
  });
  const writes=pairs.filter(p=>p.result.data.status==='COMPLETE'&&['desk_write','desk_edit'].includes(String(p.intent.data.tool)));
  if(writes.length)return{dispatchId:identity.dispatchId,sessionId:identity.sessionId,effect:'PAIRED_WRITE' as const,intentRecordIds:writes.map(p=>p.intent.id),resultRecordIds:writes.map(p=>p.result.id)};
  if(!identity.sliceId||!identity.taskId||!pairs.some(p=>p.result.data.status==='COMPLETE'&&['desk_read','desk_search'].includes(String(p.intent.data.tool))))return fail();
  const seals=rows.filter(r=>r.kind==='ExecutorSliceSealed'&&r.data.sliceId===identity.sliceId);if(seals.length!==1)return fail();const seal=seals[0];
  if(!bounded(seal.data.waveId)||!/^[A-Za-z0-9_-]+$/.test(seal.data.waveId))return fail();
  const prepared=rows.filter(r=>r.kind==='ExecutorWavePrepared'&&r.data.id===seal.data.waveId),merges=rows.filter(r=>r.kind==='ExecutorMergeApplied'&&r.data.waveId===seal.data.waveId),mergeIntents=rows.filter(r=>r.kind==='ExecutorMergeIntent'&&r.data.waveId===seal.data.waveId);
  if(prepared.length!==1||merges.length!==1||mergeIntents.length!==1)return fail();const p=prepared[0],m=merges[0],mi=mergeIntents[0];
  // The original coordinator's Intent binds wave and source, not task IDs.
  // Task membership is recorded by its subsequent Applied record for that wave.
  if(Object.keys(mi.data).some(k=>!['waveId','beforeHash','sourceHash','changedCount','changedHash','automaticResume'].includes(k))||!Number.isSafeInteger(mi.data.changedCount)||Number(mi.data.changedCount)<0||!sha(mi.data.changedHash)||mi.data.automaticResume!==false)return fail();
  if(p.ordinal>=grant.ordinal||seal.ordinal<=end.ordinal||mi.ordinal<=seal.ordinal||m.ordinal<=mi.ordinal||seal.data.deltaHash!==hash([])||!sha(p.data.sourceHash)||seal.data.sourceHash!==p.data.sourceHash||mi.data.beforeHash!==p.data.sourceHash||mi.data.sourceHash!==m.data.sourceHash||!sha(m.data.sourceHash)||!Array.isArray(m.data.taskIds)||!m.data.taskIds.includes(identity.taskId)||m.data.verificationRequired!==true||m.data.reviewRequired!==true||pairs.some(pair=>pair.result.data.status==='COMPLETE'&&pair.result.data.sourceHash!==seal.data.sourceHash))return fail();
  return{dispatchId:identity.dispatchId,sessionId:identity.sessionId,effect:'SEALED_UNCHANGED' as const,sealRecordId:seal.id,mergeIntentRecordId:mi.id,mergeRecordId:m.id,intentRecordIds:pairs.map(p=>p.intent.id),resultRecordIds:pairs.map(p=>p.result.id)};
 });
}
