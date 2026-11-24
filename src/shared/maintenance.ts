export interface StateFile {path:string;bytes:number;sha256:string}
import type {ManagedDataCounts} from './managed-data.js';
import type {StorageVolumeHealth} from './storage-durability.js';
export interface ApplicationStateCounts {projects:number;planVersions:number;approvals:number;runs:number;records:number;events:number;managedData?:ManagedDataCounts;engineeringProfiles?:number}
/** Opaque controller-custodied bytes. The Windows controller never opens these as SQLite. */
export interface StateSqliteAttachment {
 path:string;projectId:string;revision:number;operationHash:string;bytes:number;sha256:string;
 contentHash:string;sourceRunId:string;sourceTreeHash:string;
}
export interface StateSqliteImageSummary {status:'NONE'|'CAPTURED';files:number;bytes:number}
export interface StateSnapshot {
 schema:'dream-maker.state-snapshot.v1'|'dream-maker.state-snapshot.v2';id:string;operationHash:string;createdAt:string;scope:'APPLICATION_STATE_ONLY';completeProjectBackup:false;status:'VERIFIED';
 application:ApplicationStateCounts;budget:{status:'CAPTURED'|'UNAVAILABLE';requests?:number};files:StateFile[];
 /** v2 only. Absence is invalid for v2 and required to remain absent for v1. */
 sqliteImages?:StateSqliteImageSummary;attachments?:StateSqliteAttachment[];
 exclusions:['GENERATED_PROJECT_FILES','EXTERNAL_BUSINESS_DATA','CREDENTIAL_DIRECTORIES','CONFIGURATION_AND_RUNNERS'];
}
export interface RestoreRehearsal {
 schema:'dream-maker.state-rehearsal.v1';id:string;operationHash:string;sourceManifestHash:string;snapshotId:string;createdAt:string;
 scope:'READONLY_RESTORE_REHEARSAL_ONLY';engineStarted:false;application:ApplicationStateCounts;budget:StateSnapshot['budget'];
}
export type StateSnapshotListing=(Omit<StateSnapshot,'status'>&{status:'RECORDED_NOT_RECHECKED'})|{id:string;status:'INCOMPLETE_OR_INVALID';scope:'APPLICATION_STATE_ONLY';completeProjectBackup:false};
export interface MaintenanceStatus {
 schema:'dream-maker.maintenance.v1';scope:'APPLICATION_STATE_ONLY';completeProjectBackup:false;snapshots:StateSnapshotListing[];
 usage:{bytes:number;limitBytes:number;snapshots:number;rehearsals:number};modelsCalled:0;automaticResume:false;storageVolume?:StorageVolumeHealth;
}
