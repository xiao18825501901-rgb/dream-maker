import type {InspectCustomAccountSources} from './custom-account-sources.js';
/**
 * `accountVerified` here is evidence, never configuration: true only when every metered (API-key)
 * account source this view covers owns at least one signed probe receipt whose ledger request
 * settled KNOWN with a measured charge. It records that one metered real call happened for that
 * account; it never means the credential is still valid, and it is neither `modelVerified` nor
 * `customExecutionGranted`, which stay literal false in every historical process view below.
 */
/** Historical controller process evidence; never model or execution authority. */
export interface MagpieAccountCheckView {
 schema:'dream-maker.magpie-account-check.v1';projectId:string;scope:'REGISTERED_MEMORY_TRANSFER_ONLY';historical:true;
 status:'NOT_RUN'|'PASSED'|'FAILED'|'UNCERTAIN';selection:InspectCustomAccountSources|null;
 flowConfigHash:string|null;sourceBindingHash:string|null;checkedAt:string|null;accountCount:number|null;processClosed:boolean|null;
 reason:'COMPONENT_NOT_BOUND'|'BUSY'|'CHECK_FAILED'|'SELECTION_CHANGED'|'CLEANUP_UNCERTAIN'|null;
 accountVerified:boolean;modelVerified:false;customExecutionGranted:false;
}
/** Returned only by the trusted original NativeOwner after owned cleanup joins. */
export interface MagpieAccountControlObservation {
 schema:'dream-maker.magpie-account-control-observation.v1';projectId:string;flowConfigHash:string;sourceBindingHash:string;
 accountCount:number;processClosed:true;accountVerified:boolean;modelVerified:false;customExecutionGranted:false;
}
/** Cleanup of a local control check only; never a successful model request. */
export interface MagpieAccountRecoveryView {
 schema:'dream-maker.magpie-account-recovery.v1';projectId:string;scope:'LOCAL_PROCESS_CLEANUP_ONLY';
 status:'NOT_REQUIRED'|'REQUIRED'|'RECOVERED';targetHash:string|null;checkedAt:string|null;
 processClosed:boolean|null;restartRequired:boolean;
 reason:'EVIDENCE_MISSING'|'CLEANUP_UNCERTAIN'|null;
 accountVerified:boolean;modelVerified:false;customExecutionGranted:false;
}
