export const SQLITE_DATA_KIND='SQLITE_IMAGE_V1';
export interface SqliteImageReference {
 schema:'dream-maker.sqlite-image-reference.v1';operationHash:string;imageBytes:number;imageHash:string;
 snapshotHelperHash:string;sqliteVersion:string;
}
export interface SqliteDataVersion {
 projectId:string;kind:typeof SQLITE_DATA_KIND;revision:number;parentRevision:number|null;parentHash:string|null;
 image:SqliteImageReference;dataHash:string;contentHash:string;sourceRunId:string;sourceTreeHash:string;
 origin:'SQLITE_RUNTIME_RESULT'|'RESTORE';sourceSnapshotId:string|null;actor:string;at:string;
}
export interface SqliteDataView {
 schema:'dream-maker.sqlite-data.v1';projectId:string;kind:typeof SQLITE_DATA_KIND;revision:number;
 imageHash:string|null;imageBytes:number;contentHash:string|null;
 usage:{versions:number;bytes:number;operations:number;pending:number};
 limits:{versions:number;bytes:number;operations:number;pending:number};
 scope:'PROJECT_SQLITE_DATA_ONLY';nativeExecutionGranted:false;
 operation?:{hash:string;appliedRevision:number;replayed:boolean};
}
export interface SqliteDataRestorePlan {
 schema:'dream-maker.sqlite-data-restore-plan.v1';scope:'PROJECT_SQLITE_DATA_ONLY';engineStarted:false;
 projectId:string;snapshotId:string;rehearsalId:string;
 source:{revision:number;contentHash:string;imageHash:string;imageBytes:number;at:string};
 target:{revision:number;contentHash:string|null};
}
export interface SqliteDataRecoveryCandidate {
  operationHash:string;
  expectedRevision:number;
  imageBytes:number;
  imageHash:string;
  actor:string;
  at:string;
  recoverable:boolean;
  blockedReason:'INTENT_BINDING_REQUIRED'|'INTENT_BINDING_INVALID'|null;
}
export interface SqliteDataRecoveryPlan {
  schema:'dream-maker.sqlite-data-recovery-plan.v1';
  scope:'PROJECT_SQLITE_DATA_ONLY';
  projectId:string;
  candidates:SqliteDataRecoveryCandidate[];
  automaticReplay:false;
  modelCalls:0;
}
