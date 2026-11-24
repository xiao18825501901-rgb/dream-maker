import type { Store } from '../store.js';
import type { Run } from '../../shared/types.js';
import { hash } from '../security.js';
/** Terminal historical states retain their original meaning. A delivered-but-unaccepted Flow
 * needs an explicit controller conclusion before revising its plan. No lease is removed here. */
export function canReviseAfterFlow(store: Store, run: Run): boolean {
    if (store.owns(run.projectId,run.id)) return false;
    if (['ACCEPTED','CANCELLED','FAILED','PARTIAL','BLOCKED'].includes(run.state)) return true;
    if (run.state!=='READY_FOR_DELIVERY'||!run.flowConclusion) return false;
    const end=run.flowConclusion;
    return store.records(run.projectId,'FlowConclusion').some(row=>row.id===end.recordId&&row.runId===run.id&&hash(row.data)===end.sha256&&row.data.specHash===run.specHash);
}
