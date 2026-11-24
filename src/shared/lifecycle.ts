export interface LifecycleStatus {
 schema:'dream-maker.lifecycle.v1';
 state:'RUNNING'|'PAUSE_REQUESTED'|'PAUSED'|'PAUSE_UNCERTAIN';
 lastChoice:'BACKGROUND_CURRENT_WORK'|'PAUSE'|null;
 changedAt:string;code:string|null;
 scope:'CONTROLLER_OWNED_WORK_ONLY';automaticResume:false;browserCloseStopsWork:false;
 currentRoundMayStillRun:boolean;
 active:{engineJobs:number;interviews:number;modelCalls:number;queued:number;grants:number;quarantined:number};
}
