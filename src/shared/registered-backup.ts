export interface RegisteredBackupFile {path:string;bytes:number;sha256:string}
export interface RegisteredBackupSqliteAttachment {
 path:string;projectId:string;revision:number;operationHash:string;bytes:number;sha256:string;
}
export interface RegisteredBackup {
 schema:'dream-maker.registered-backup.v2';id:string;operationHash:string;createdAt:string;
 scope:'REGISTERED_STATE_AND_PROJECT_FILES';completeProjectBackup:false;integrity:'SHA256_VERIFIED';
 state:{snapshotId:string;manifestHash:string;budget:'CAPTURED'|'UNAVAILABLE';
  sqliteImages?:{status:'NONE'|'CAPTURED';files:number;bytes:number};attachments?:RegisteredBackupSqliteAttachment[];
 };
 runs:{runId:string;projectId:string;sourceHash:string;recordedSourceHash:string|null;runStateHash:string;files:number;bytes:number}[];
 files:RegisteredBackupFile[];exclusions:['CREDENTIALS','CONFIGURATION_AND_RUNNERS','DEPENDENCY_CACHES_AND_GIT','UNREGISTERED_EXTERNAL_DATA'];
}
export interface RegisteredExtraction {
 schema:'dream-maker.registered-extraction.v1';id:string;backupId:string;operationHash:string;sourceManifestHash:string;createdAt:string;directory:string;
 scope:'SIDE_BY_SIDE_EXTRACTION_ONLY';workingDataReplaced:false;executionGranted:false;automaticResume:false;files:number;bytes:number;
}
export interface RegisteredBackupsStatus {
 schema:'dream-maker.registered-maintenance.v1';scope:'REGISTERED_STATE_AND_PROJECT_FILES';completeProjectBackup:false;
 items:{id:string;createdAt?:string;integrity:'NOT_RECHECKED'|'INCOMPLETE_OR_INVALID'}[];
 usage:{backups:number;extractions:number;bytes:number;limitBytes:number};modelsCalled:0;automaticResume:false;
}
