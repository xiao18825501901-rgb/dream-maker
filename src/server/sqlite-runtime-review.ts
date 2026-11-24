import type {Store} from './store.js';import type {Run} from '../shared/types.js';
import {DomainError} from './security.js';import {validateSqliteRuntimePlan,type SqliteRuntimePlan} from './data-runtime-plan.js';
import {reviewedDataPlan} from './data-source-review.js';
/** Original controller records, not a caller's PASS flag or an unreviewed current Plan. */
export function reviewedSqliteRuntime(store:Store,run:Run):SqliteRuntimePlan{
 try{
  return validateSqliteRuntimePlan(reviewedDataPlan(store,run).dataRuntime);
 }catch{throw new DomainError('SQLITE_DATA_REVIEW_BINDING_REQUIRED',409);}
}
