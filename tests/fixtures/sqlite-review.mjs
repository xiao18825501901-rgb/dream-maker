// Deliberately minimal OFFLINE Review/ReviewPacket shapes for data-gate tests ONLY.
// Not a model response, valid Native review packet, audit, owner approval or business acceptance.
import {hash} from '../../dist/server/security.js';
export function seedOfflineSqliteReview(store,run,source='CODEX'){
 const packet={schema:'dream-maker.review-packet.v1',runId:run.id,specHash:run.specHash,spec:{hash:run.specHash},plan:structuredClone(run.plan),sourceHistory:[{treeHash:run.treeHash}],scope:{toolsAllowed:false},fixtureProvenance:'OFFLINE_SQLITE_GATE_SHAPE_NOT_NATIVE_REVIEW'};
 const packetHash=hash(packet),packetId=store.record('ReviewPacket',run.projectId,run.id,{sha256:packetHash,packet,fixtureProvenance:'OFFLINE_TEST_ONLY'});
 run.review={verdict:'PASS',findings:[],source,treeHash:run.treeHash};
 const reviewId=store.record('Review',run.projectId,run.id,{...run.review,packetId,packetHash,stepId:'OFFLINE_SQLITE_REVIEW',fixtureProvenance:'OFFLINE_TEST_ONLY'});store.saveRun(run);
 return {reviewId,packetId,packetHash};
}
