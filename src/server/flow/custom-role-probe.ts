import type {InspectCustomAccountSources} from '../../shared/custom-account-sources.js';
import type {CustomProbeObservation,CustomProbeReceipt} from '../native-probes.js';
/** Internal controller contract. None of these fields grants project execution. */
export interface CustomRoleProbePreparation {
    role:'planner2'|'executor'|'reviewer';roleId:string;bindingHash:string;configurationHash:string;expiresAt:string;
}
export interface CustomRoleProbeInput {
    selection:InspectCustomAccountSources;preparation:CustomRoleProbePreparation;
    probeId:string;nonce:string;signal:AbortSignal;
}
export interface CustomRoleProbeStage {
    attemptId:string;bindingHash:string;observation:CustomProbeObservation;
}
export interface CustomRoleProbeFactory {
    customProbePreparation(selection:InspectCustomAccountSources,roleId:string):CustomRoleProbePreparation;
    prepareCustomProbeEvidence():Promise<void>;
    executeCustomRoleProbe(input:CustomRoleProbeInput,emit:(event:unknown)=>void):Promise<CustomRoleProbeStage>;
    completeCustomRoleProbe(input:CustomRoleProbeInput,stage:CustomRoleProbeStage):CustomProbeReceipt;
    customProbeReceipt(selection:InspectCustomAccountSources,roleId:string,evidenceId:string):CustomProbeReceipt;
}
