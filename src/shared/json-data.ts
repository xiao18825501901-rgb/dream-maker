export const JSON_DATA_KIND='JSON_DOCUMENT_V1';
export type JsonData=null|boolean|number|string|JsonData[]|{[key:string]:JsonData};
export interface JsonDataVersion {
 projectId:string;kind:typeof JSON_DATA_KIND;revision:number;parentRevision:number|null;parentHash:string|null;
 document:Record<string,JsonData>;dataHash:string;contentHash:string;sourceRunId:string;sourceTreeHash:string;
 origin:'LOCAL_DATA_EDIT'|'JSON_IMPORT'|'RUNTIME_RESULT'|'RESTORE';sourceSnapshotId:string|null;actor:string;at:string;
}
export interface JsonDataView {
 schema:'dream-maker.json-data.v1';projectId:string;kind:typeof JSON_DATA_KIND;revision:number;
 document:Record<string,JsonData>;dataHash:string|null;contentHash:string|null;
 usage:{versions:number;bytes:number;operations:number};limits:{versions:number;bytes:number;operations:number;payloadBytes:number};
 scope:'PROJECT_JSON_DATA_ONLY';nativeExecutionGranted:false;
 operation?:{hash:string;appliedRevision:number;replayed:boolean};
}
export interface JsonDataRestorePlan {
 schema:'dream-maker.json-data-restore-plan.v1';scope:'PROJECT_JSON_DATA_ONLY';engineStarted:false;
 projectId:string;snapshotId:string;rehearsalId:string;
 source:{revision:number;contentHash:string;bytes:number;at:string};
 target:{revision:number;contentHash:string|null;bytes:number};
}
