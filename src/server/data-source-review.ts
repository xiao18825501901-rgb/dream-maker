import type {Store} from './store.js';
import type {Run} from '../shared/types.js';
import {DomainError,object,hash} from './security.js';
import {completedCustomReviewSource} from './flow/role-completion.js';
/** A saved review and its exact frozen packet, never a caller's PASS label. */
export function reviewedDataPlan(store:Store,run:Run):Record<string,unknown>{
 try{
  const latest=store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND kind='Review' ORDER BY rowid DESC LIMIT 1").get(run.projectId,run.id);
  if(!latest||typeof latest.data!=='string'||Buffer.byteLength(latest.data)>16000000||!run.review)throw Error('review');
  const review=object(JSON.parse(latest.data)),fields={verdict:review.verdict,findings:review.findings,source:review.source,treeHash:review.treeHash};
  const expectedSource=run.flowName==='custom'?completedCustomReviewSource(run):'CODEX';
  if(review.verdict!=='PASS'||review.source!==expectedSource||review.treeHash!==run.treeHash||hash(fields)!==hash(run.review)||typeof review.packetId!=='string'||typeof review.packetHash!=='string')throw Error('review-binding');
  const row=store.db.prepare("SELECT data FROM records WHERE id=? AND project_id=? AND run_id=? AND kind='ReviewPacket'").get(review.packetId,run.projectId,run.id);
  if(!row||typeof row.data!=='string'||Buffer.byteLength(row.data)>16000000)throw Error('packet');
  const record=object(JSON.parse(row.data)),packet=object(record.packet);
  if(record.sha256!==review.packetHash||hash(packet)!==review.packetHash||packet.schema!=='dream-maker.review-packet.v1'||packet.runId!==run.id||packet.specHash!==run.specHash||object(packet.spec).hash!==run.specHash||object(packet.scope).toolsAllowed!==false||!Array.isArray(packet.sourceHistory)||object(packet.sourceHistory.at(-1)).treeHash!==run.treeHash||hash(packet.plan)!==hash(run.plan))throw Error('packet-binding');
  return object(packet.plan);
 }catch{throw new DomainError('DATA_SOURCE_REVIEW_BINDING_REQUIRED',409);}
}
