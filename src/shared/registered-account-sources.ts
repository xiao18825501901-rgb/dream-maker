/** Public metadata only. A registered reference is never an authenticated account.
 * `accountVerified` is per source and is derived from probe evidence: that exact account source
 * completed at least one metered, receipted real model call. It is not credential validity, not
 * `modelVerified` and not `executionGranted`; a choice entry below describes a source kind, not an
 * account, so it stays false. */
export interface RegisteredAccountSource {
 schema:'dream-maker.registered-account-source.v1';id:string;sourceId:'CONTROLLER_DSH_SESSION';
 authRef:string;accountRef:string;provider:'deepseek-official';authentication:'api_key';label:string;
 configurationHash:string;contentHash:string;status:'SELECTED_UNVERIFIED'|'SOURCE_STALE';
 accountVerified:boolean;modelVerified:false;executionGranted:false;
}
export interface AccountSourceChoices {
 schema:'dream-maker.account-source-choices.v1';
 choices:{sourceId:'CONTROLLER_DSH_SESSION';label:string;provider:'deepseek-official';authentication:'api_key';accountVerified:false}[];
 sources:RegisteredAccountSource[];
}
/** Exact draft references from controller metadata; no credential or model claims. */
export interface PublicAccountIdentity {provider:string;authentication:'api_key';authRef:string;accountRef:string}
export interface RegisterAccountSource {sourceId:'CONTROLLER_DSH_SESSION';label:string;confirmed:true}
