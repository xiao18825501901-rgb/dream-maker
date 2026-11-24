/** User-selected references, never credentials or proof that an account/runtime works. */
export interface ProfileBudget {currency:'CNY'|'USD';maxMicros:number}
export interface CustomRoleProfile {
 id:string;provider:string;authentication:'oauth'|'api_key';authRef:string;accountRef:string;
 runtime:string;model:{kind:'model'|'group';id:string};transport:'magpie'|'native';nativeException:boolean;
 /** Required at execution time for a group; never defaults to the first member. */
 selectedMemberId?:string;
 permissions:('source_read'|'source_write')[];budget:ProfileBudget;
}
export interface CustomFlowProfile {
 mode:'custom';laya:false;
 accounts:{provider:string;authentication:'oauth'|'api_key';authRef:string;accountRef:string;label?:string}[];
 roles:{planner2:CustomRoleProfile;executors:CustomRoleProfile[];reviewer:CustomRoleProfile};
 groups:{id:string;strategy:'failure_only'|'rotate'|'cost'|'smart';members:{id:string;provider:string;model:string;authRef:string;accountRef:string;permissions:('source_read'|'source_write')[]}[]}[];
 privacy:{deniedProviders:string[];deniedDataLabels:string[]};budget:ProfileBudget;timeZone:string;
}
export interface FlowProfileVersion {
 schema:'dream-maker.custom-profile-version.v1';projectId:string;revision:number;parentHash:string|null;
 configuration:CustomFlowProfile;confirmedAt:string;confirmedBy:string;operationHash:string;requestHash:string;contentHash:string;
 scope:'CONFIGURATION_ONLY';serviceIdentity:'NOT_VERIFIED';executionGranted:false;
}
export interface ConfirmFlowProfile {configuration:CustomFlowProfile;expectedRevision:number;confirmed:true}
