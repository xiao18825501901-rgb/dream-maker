import type { Run } from '../shared/types.js';
import { DomainError } from './security.js';
import type {Store} from './store.js';
import {runDeadline} from './review-window.js';
export function reserveCall(run: Run) { if (run.calls >= run.maxCalls)
    throw new DomainError('RUN_CALL_BUDGET_EXCEEDED', 409); run.calls++; }
export function checkDuration(run: Run,store?:Store) {
    if((run.reviewWindow||run.documentationContinuation)&&!store)throw new DomainError('REVIEW_WINDOW_STORE_REQUIRED',409);
    if (Date.now() >= (store?runDeadline(store,run):Date.parse(run.createdAt)+run.maxSeconds*1000))
    throw new DomainError('RUN_WALL_TIME_BUDGET_EXCEEDED', 409); }
