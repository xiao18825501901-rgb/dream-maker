export type CustomAccountSourceStatus='AVAILABLE_UNVERIFIED'|'SECRET_MISSING'|'SECRET_INVALID'|'SOURCE_UNAVAILABLE'|'SOURCE_NOT_CONFIGURED'|'SOURCE_MISMATCH'|'PROVIDER_NOT_SUPPORTED'|'AUTHENTICATION_NOT_SUPPORTED'|'NATIVE_RUNTIME_MANAGED'|'POLICY_DENIED';
/** Availability only. Never contains an environment name, credential value or credential digest.
 * `accountVerified` is the probe-evidence fact for the listed account sources: every metered
 * (API-key) source completed at least one metered, receipted real model call. Availability,
 * `modelVerified`, `runtimeStarted` and `executionGranted` are separate and stay closed. */
export interface CustomAccountSourcesView {
 schema:'dream-maker.custom-account-sources-observation.v1';projectId:string;flowConfigHash:string;sourceManifestHash:string|null;
 /** Digest of explicit public registrations, never a credential digest. */
 sourceBindingHash?:string;
 accounts:{authRef:string;accountRef:string;provider:string;authentication:'oauth'|'api_key';status:CustomAccountSourceStatus}[];
 accountVerified:boolean;modelVerified:false;runtimeStarted:false;executionGranted:false;
}
export interface InspectCustomAccountSources {
 projectId:string;specHash:string;profileHash:string;preparation:{identityHash:string;contentHash:string};
}
