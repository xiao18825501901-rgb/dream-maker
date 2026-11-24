/** A read-only proposal, never model qualification, budget or source-write authority. */
export interface DocumentationCorrectionCandidate {
 schema:'dream-maker.documentation-correction-candidate.v1'|'dream-maker.bounded-code-repair-candidate.v1';
 repairKind?:'CODE';runId:string;projectId:string;
 specHash:string;sourceHash:string;expectedVersion:number;planVersionId:string;planVersionHash:string;planHash:string;
 taskId:string;writePaths:string[];selectedFile:{path:string;bytes:number;sha256:string};
 protectedFileCount:number;protectedFilesHash:string;protectedFileExamples:{path:string;bytes:number;sha256:string}[];
 reviewRecordId:string;reviewPacketHash:string;reviewDispatchId:string;
 findings:{id:string;severity:string;description:string;evidence:string}[];
 parentCalls:number;parentMaxCalls:number;parentRepairs:number;parentMaxRepairs:number;parentSupplementalCalls:number;
 additionalCalls:2;additionalRepairRounds:1;executionGranted:false;roleQualification:'NOT_CHECKED_BY_CANDIDATE';
 requiresOwnerConfirmation:true;requiresOwnedProcessInspection:true;
 authorization?:{recordId:string;sha256:string};
 candidateHash:string;
}
/** Preparation retains bytes only. A later separately bound runtime must authorize any model work. */
export interface DocumentationCustodyRequest {confirmed:boolean;file:string;candidateHash:string}
export interface DocumentationCustodyPrepared {
 schema:'dream-maker.documentation-custody.v1';preparationId:string;runId:string;projectId:string;
 repairKind?:'CODE';
 candidateHash:string;sourceHash:string;reviewRecordId:string;taskId:string;writePaths:string[];
 parentCalls:number;parentSupplementalCalls:number;proposedAdditionalCalls:2;additionalCallsGranted:0;
 scope:'SOURCE_CUSTODY_ONLY';executionGranted:false;modelDispatched:false;
}
