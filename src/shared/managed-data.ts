import type {DemoTask} from './demo-tasks.js';
export const FIXED_DEMO_DATA_KIND='FIXED_DEMO_TASKS_V1';
export interface ManagedDataCounts {datasets:number;versions:number;operations:number;rootHash:string}
export interface ManagedDataVersion {
 projectId:string;kind:typeof FIXED_DEMO_DATA_KIND;revision:number;parentRevision:number|null;parentHash:string|null;
 tasks:DemoTask[];dataHash:string;contentHash:string;sourceRunId:string;sourceTreeHash:string;
 origin:'PREVIEW_EDIT'|'BROWSER_IMPORT'|'RESTORE';sourceSnapshotId:string|null;actor:string;at:string;
}
export interface ManagedDataView {
 schema:'dream-maker.managed-data.v1';projectId:string;kind:typeof FIXED_DEMO_DATA_KIND;
 revision:number;tasks:DemoTask[];dataHash:string|null;contentHash:string|null;
 usage:{versions:number;bytes:number;operations:number};limits:{versions:number;bytes:number;operations:number;payloadBytes:number};
 scope:'FIXED_DEMO_DATA_ONLY';nativeExecutionGranted:false;
}
export interface ManagedDataOperationView extends ManagedDataView {
 operation:{hash:string;appliedRevision:number;replayed:boolean};
}
export interface ManagedDataRestorePlan {
 schema:'dream-maker.managed-data-restore-plan.v1';scope:'FIXED_DEMO_DATA_ONLY';engineStarted:false;
 projectId:string;snapshotId:string;rehearsalId:string;
 source:{revision:number;contentHash:string;taskCount:number;at:string};
 target:{revision:number;contentHash:string|null;taskCount:number};
}
