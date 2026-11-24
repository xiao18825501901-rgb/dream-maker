/** Retaining interrupted source is not task completion, approval, qualification or dispatch. */
export interface ExecutorCheckpointPreview {
 schema:'dream-maker.executor-checkpoint-preview.v1';runId:string;runVersion:number;waveId:string;
 canonicalHash:string;checkpointHash:string;toolJournalHash:string;previewHash:string;
 tasks:{taskId:string;sourceHash:string;fileCount:number;toolCalls:number;priorResultSealed:boolean}[];
 canPrepare:boolean;requiresProcessCheck:true;modelsCalled:0;executionGranted:false;automaticResume:false;
}
export interface ExecutorCheckpointRequest {previewHash:string;confirmed:boolean}
/** Leaving a retained checkpoint is a Flow-state change, never a model call, merge or acceptance. */
export interface ExecutorCheckpointResumeRequest {confirmed:boolean}
export interface ExecutorCheckpointResumeResult {
 schema:'dream-maker.executor-checkpoint-resume-result.v1';runId:string;reason:string;
 taskIds:string[];waveTaskIds:string[];waveId:string;operationHash:string;
 runVersion:number;attempt:number;state:'IMPLEMENTING';phase:'IMPLEMENTING';replayed:boolean;
 taskCompletionAssumed:false;modelsCalled:0;automaticResume:false;
}
export interface ExecutorCheckpointResult {
 schema:'dream-maker.executor-checkpoint-result.v1';runId:string;previousWaveId:string;newWaveId:string;
 operationHash:string;checkpointHash:string;canonicalHash:string;runVersion:number;state:'PAUSED';replayed:boolean;
 sourceCopiesRetained:true;taskCompletionAssumed:false;modelsCalled:0;executionGranted:false;automaticResume:false;
}
