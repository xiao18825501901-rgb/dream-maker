export type MergeRecoveryChoice='KEEP_FILES_AND_END'|'RESTORE_BASE_AND_END';
export interface MergeRecoveryRequest {choice:MergeRecoveryChoice;previewHash:string;expectedHash:string;confirmed:boolean}
export type MergeSourceState='SOURCE_UNCHANGED'|'COMBINED_UNCOMMITTED'|'PARTIALLY_PUBLISHED'|'EXTERNAL_CHANGE';
export interface MergeRecoveryPreview {
 schema:'dream-maker.merge-recovery-preview.v1';runId:string;waveId:string;previewHash:string;
 sourceState:MergeSourceState;source:{baseHash:string;combinedHash:string;currentHash:string};
 changedFiles:number;publishedFiles:number;previousAttempts:number;
 canKeepFiles:boolean;canRestoreBase:boolean;requiresProcessCheck:true;
 scope:'SOURCE_FILES_ONLY';businessDataChanged:false;modelsCalled:0;executionGranted:false;automaticResume:false;
}
export interface MergeRecoveryResult {
 schema:'dream-maker.merge-recovery-result.v1';runId:string;waveId:string;recoveryId:string;operationHash:string;choice:MergeRecoveryChoice;
 sourceHash:string;createdAt:string;replayed:boolean;
 scope:'SOURCE_FILES_ONLY';flowEnded:true;originalMergeApplied:false;sourceCopiesRetained:true;businessDataChanged:false;
 modelsCalled:0;executionGranted:false;automaticResume:false;
}
