import type { ResearchRun, SourceSnapshot } from './research.js';
export interface PlanRequirement { id:string; text:string; origin:'USER'|'AI_SUGGESTION'|'ASSUMPTION'; sources:string[] }
export interface ProjectPlan {
    goal:string;
    requirements:PlanRequirement[];
    acceptance:{id:string;check:string;requirementIds:string[]}[];
    architecture:{summary:string;runtime:string;components:string[]};
    dataModel:{entities:string[];persistence:string};
    interfaces:{userFlows:string[];boundaries:string[]};
    tasks:{id:string;title:string;dependsOn:string[];requirementIds:string[];check:string}[];
    delivery:{type:string;howToUse:string;standalone:boolean;needsInternet:boolean;ongoingFees:string[]};
    resources:{accounts:string[];hardware:string[];network:string[];ongoingCosts:string[]};
    risks:string[]; milestones:string[]; assumptions:string[]; unknowns:string[]; outOfScope:string[];
    research:{status:ResearchRun['status']|'USER_IMPORTED_PLAN';sourceRefs:Pick<SourceSnapshot,'webUrl'|'commit'|'snapshotHash'>[];searchScope?:string;failures?:ResearchRun['failures']};
    reuse:{mode:'ADAPT_PROJECT'|'REUSE_COMPONENTS'|'IMPLEMENT_ORIGINAL';selected:unknown[];reason?:string;externalCodeExecuted?:false};
    inputBinding:{inputHash:string;interviewRevision:number;projectRevision:number;operationId?:string;notesHash?:string;policyHash?:string};
}
export interface PlanningEvent {
    operationId:string;projectId:string;inputHash:string;state:string;draftId?:string;code?:string;
    [key:string]:unknown;
}
