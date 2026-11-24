/** Read-only queue observation. Never an execution, budget or account grant. */
export interface DispatchWaitObservation {
 scope:'RESOURCE_OBSERVATION_ONLY';
 reason:'MEMORY'|'CAPACITY'|'CONFLICT'|'DEPENDENCIES'|'CURRENT_FLOW'|'CLEANUP'|'RESOURCE_RECHECK';
 sampledAt:string;
 availableMemoryMiB:number|null;
 /** Estimate from the completed proposal's remaining capacity, not an admission threshold. */
 estimatedMemoryGapMiB:number|null;
}
