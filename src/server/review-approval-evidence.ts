import type {Store} from './store.js';import type {Run,Spec} from '../shared/types.js';
import {DomainError,hash} from './security.js';
// Store.now() uses canonical UTC milliseconds. SQL's lexical ordering is only
// safe for that representation; reject timezone aliases rather than rewriting receipts.
const validTime=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const binding=():never=>{throw new DomainError('REVIEW_PROJECT_APPROVAL_BINDING_INVALID',409);};
const missing=():never=>{throw new DomainError('REVIEW_PROJECT_APPROVAL_REQUIRED',409);};
/** Read original controller rows only. Frozen proposal prose is not approval authority,
 * and a verifier approval never substitutes for approval of the project itself. */
export function reviewApprovalEvidence(store:Store,run:Run,spec:Spec,firstSourceSnapshotAt:string){
 if(!run.planVersionId||run.planVersionId!==spec.id||!run.planVersionHash||!validTime(run.createdAt)||
  !validTime(firstSourceSnapshotAt)||Date.parse(firstSourceSnapshotAt)<Date.parse(run.createdAt))return binding();
 const version=store.planVersion(run.planVersionId);
 if(version.projectId!==run.projectId||version.specHash!==run.specHash||spec.projectId!==run.projectId||spec.hash!==run.specHash||
  version.contentHash!==run.planVersionHash)return binding();
 const planApproval=store.db.prepare('SELECT plan_id,spec_hash,actor,at FROM plan_version_approvals WHERE plan_id=?').get(version.id);
 if(!planApproval)return missing();
 // IDs and caller-supplied hash labels alone cannot authorize changed proposal bytes.
 if(hash(spec)!==hash(store.spec(version.id)))return binding();
 if(planApproval.plan_id!==version.id||planApproval.spec_hash!==run.specHash||typeof planApproval.actor!=='string'||
  !planApproval.actor||planApproval.actor.length>256||!validTime(version.createdAt)||!validTime(planApproval.at)||
  Date.parse(version.createdAt)>Date.parse(planApproval.at)||Date.parse(planApproval.at)>Date.parse(run.createdAt))return binding();
 // These tables are scoped to project/spec. Select the actual receipts available
 // before this run/source, excluding later approvals from retrospective authorization.
 const specApproval=store.db.prepare("SELECT id,project_id,spec_hash,kind,at FROM approvals WHERE project_id=? AND spec_hash=? AND kind='SPEC' AND at<=? ORDER BY at DESC,rowid DESC LIMIT 1")
  .get(run.projectId,run.specHash,run.createdAt);
 if(!specApproval)return missing();
 if(typeof specApproval.id!=='string'||!specApproval.id||!validTime(specApproval.at)||
  Date.parse(specApproval.at)<Date.parse(planApproval.at)||Date.parse(specApproval.at)>Date.parse(run.createdAt))return binding();
 const buildApproval=store.db.prepare("SELECT id,project_id,spec_hash,kind,at FROM approvals WHERE project_id=? AND spec_hash=? AND kind='BUILD' AND at>=? AND at<=? ORDER BY at DESC,rowid DESC LIMIT 1")
  .get(run.projectId,run.specHash,specApproval.at,firstSourceSnapshotAt);
 if(!buildApproval)return missing();
 // BUILD may be recorded milliseconds after run creation in the same transaction,
 // but must follow SPEC and precede the first source snapshot.
 if(typeof buildApproval.id!=='string'||!buildApproval.id||!validTime(buildApproval.at)||
  Date.parse(buildApproval.at)<Date.parse(specApproval.at)||Date.parse(buildApproval.at)>Date.parse(firstSourceSnapshotAt))return binding();
 return {schema:'dream-maker.project-approval-evidence.v1' as const,authority:'ORIGINAL_CONTROLLER_STORE_ROWS',
  planVersion:{id:version.id,projectId:version.projectId,specHash:version.specHash,contentHash:version.contentHash,origin:version.origin,revision:version.revision},
  planApproval,specApproval,buildApproval,runCreatedAt:run.createdAt,firstSourceSnapshotAt};
}
