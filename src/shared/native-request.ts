/** Attribution of one inner model request. A binding is never an account or dispatch permit. */
export type NativeRequestWork={kind:'TASK';taskIdHash:string;executorSliceId:string|null}|{kind:'REPAIR';round:number;inputHash:string}|{kind:'SUPERVISION'}|{kind:'QUALIFICATION';probeId:string;bindingHash:string};
export interface NativeRequestBinding {
 schema:'dream-maker.native-request-binding.v1';
 projectId:string;runId:string;engineeringMode:'classic'|'custom';
 configurationHash:string;planVersionHash:string;specHash:string;
 dispatchId:string;generation:string;role:'planner2'|'executor'|'reviewer';roleId:string;
 work:NativeRequestWork;bodyHash:string;routeHash:string;
}
