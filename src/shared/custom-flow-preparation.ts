import type {CustomFlowConfigSnapshot} from './flow-configuration.js';
export interface CustomFlowPreparation {
 schema:'dream-maker.custom-flow-preparation.v1';projectId:string;identityHash:string;
 flowConfig:CustomFlowConfigSnapshot;flowConfigHash:string;createdAt:string;
 scope:'CONFIGURATION_PREPARATION_ONLY';executionGranted:false;contentHash:string;
}
export type CustomFlowPreparationRef=Pick<CustomFlowPreparation,'identityHash'|'contentHash'>;
