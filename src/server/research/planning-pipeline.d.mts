import type { ResearchRun,SourceSnapshot } from '../../shared/research.js';
import type { PlanningEvent } from '../../shared/project-plan.js';
export interface PipelineInput {
 projectId:string;operationId:string;projectRevision:number;parentPlanId:string|null;description:string;requirementIds:string[];distribution:string;
 alternativeContext?:unknown;
 interview:{projectId:string;revision:number;status:'ENDED';answers:Record<string,{questionId:string;optionIds:string[];customText:string;skipped:boolean;answerRevision:number}>};
}
export interface PipelineDependencies {
 claim(value:{operationId:string;projectId:string;inputHash:string}):Promise<{acquired:boolean}>;
 record(value:PlanningEvent):Promise<void>;
 isCurrent(value:{projectId:string;inputHash:string;parentPlanId:string|null}):Promise<boolean>;
 makeSearchIntent(binding:unknown,options:{signal?:AbortSignal}):Promise<{keywords:unknown}>;
 authorizePublicQuery(value:{projectId:string;intentHash:string;keywords:string[];queryHash:string}):Promise<{kind:'PUBLIC_GENERIC_TERMS_ONLY';intentHash:string;queryHash:string}>;
 research:{discover(value:{keywords:string[];intentHash:string;signal?:AbortSignal}):Promise<ResearchRun>};
 reviewCandidate(snapshot:SourceSnapshot,context:unknown,options:{signal?:AbortSignal}):Promise<unknown>;
 verifyAssessment(value:unknown):boolean;
 generatePlan(context:Record<string,unknown>,options:{signal?:AbortSignal}):Promise<Record<string,unknown>>;
 persistDraft(value:{projectId:string;operationId:string;expectedInputHash:string;expectedParentId:string|null;body:unknown;signal?:AbortSignal}):Promise<{id:string}>;
 now?:()=>number;
}
export function runPlanningPipeline(input:PipelineInput,deps:PipelineDependencies,options?:{signal?:AbortSignal}):Promise<{status:'EXISTING_OPERATION_REQUIRES_RECONCILIATION'|'DRAFT_REQUIRES_USER_CONFIRMATION';draft?:{id:string};inputHash:string}>;
