/** Engineering mode is independent from Demo/Live and from the Dream Maker P1. */
export type EngineeringMode='classic'|'custom';
import type {CustomFlowProfile} from './flow-profile.js';
export interface RoleBinding {
    id:string;
    runtime:'codex-app-server'|'dsh';
    provider:string;
    model:string;
    authentication:'CHATGPT_SUBSCRIPTION'|'API_KEY';
    accountRef:'UNKNOWN';
    serviceIdentity:'NOT_VERIFIED';
    transport:'native';
    permissions:readonly ('source_read'|'source_write')[];
}
/** Configured identity is not evidence of an authenticated service or a completed role. */
export interface ClassicFlowConfigSnapshot {
    schema:'dream-maker.flow-config.v1';
    mode:'classic';
    projectId:string;
    runId:string;
    plan:{versionId:string;revision:number;contentHash:string;specHash:string};
    roles:{planner2:RoleBinding;executors:readonly RoleBinding[];reviewer:RoleBinding};
    laya:{enabled:boolean;mode:'off'|'shadow'|'advisory';roles:readonly string[]};
    magpie:null;
    configurationFingerprint:string;
}
/** Confirmed selections only. Authentication/dispatch evidence remains separately verified. */
export interface CustomFlowConfigSnapshot extends Omit<CustomFlowProfile,'mode'|'laya'> {
 schema:'dream-maker.flow-config.v2';mode:'custom';projectId:string;runId:string;
 plan:{versionId:string;revision:number;contentHash:string;specHash:string};
 profile:{revision:number;contentHash:string};
 laya:{enabled:false;mode:'off';roles:readonly []};
 magpie:{ownership:'DM_ONLY';routing:'MODELS_ONLY'};
 qualification:'NOT_VERIFIED';configurationFingerprint:string;
}
export type FlowConfigSnapshot=ClassicFlowConfigSnapshot|CustomFlowConfigSnapshot;
