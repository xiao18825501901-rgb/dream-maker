/** Error classification is deterministic and never changes billing or model providers. */
export const USAGE_URL = 'https://chatgpt.com/settings/usage' as const;
/** Additive context for the fallback code; it never takes part in classification. */
export type FailureDetail = {name?:string;rawCode?:string;message?:string;cause?:string};
export type PublicFailure = {code:string;status:number|null;requestId?:string;param?:string;retryable:boolean;detail?:FailureDetail};
const known = new Map<string,{http:number;retry:boolean}>([
 ['subscription_sharing_user_not_eligible',{http:403,retry:false}], ['subscription_sharing_usage_limit_exceeded',{http:429,retry:false}],
 ['subscription_sharing_usage_unavailable',{http:503,retry:true}],['subscription_sharing_unsupported_capability',{http:400,retry:false}],
 ['subscription_sharing_route_not_supported',{http:403,retry:false}],['subscription_sharing_invalid_user',{http:401,retry:false}],
 ['subscription_sharing_user_unavailable',{http:503,retry:true}],['chatpass_v2_scope_not_authorized',{http:403,retry:false}],
 ['chatpass_v2_invalid_authorization_context',{http:403,retry:false}], ['sharing_not_enabled',{http:403,retry:false}],
 ['access_denied',{http:403,retry:false}],['invalid_grant',{http:401,retry:false}],['invalid_refresh_token',{http:401,retry:false}],
 ['refresh_token_expired',{http:401,retry:false}], ['refresh_token_invalidated',{http:401,retry:false}],['refresh_token_reused',{http:401,retry:false}],
 ['token_expired',{http:401,retry:false}], ['invalid_client',{http:401,retry:false}], ['sign_in_required',{http:401,retry:false}],
 ['model_not_found',{http:403,retry:false}], ['cancelled',{http:409,retry:false}],['stream_interrupted',{http:502,retry:true}],
 ['response_incomplete',{http:502,retry:true}], ['network_error',{http:503,retry:true}], ['refresh_not_ready',{http:503,retry:true}],
 ['identity_verification_unavailable',{http:503,retry:true}], ['registration_incomplete',{http:409,retry:false}],
 ['storage_invalid',{http:409,retry:false}],['encryption_unavailable',{http:503,retry:false}],
 ['region_not_supported',{http:403,retry:false}], ['unsupported_country_region_territory',{http:403,retry:false}],
]);
const id = (s:unknown) => typeof s==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s) ? s : undefined;
// Every unclassified failure collapses into SIWC_OPERATION_FAILED below. Dropping the original name,
// code and message there made a missing module, a bad argument and a refused call indistinguishable.
// describeFailure reports what WAS thrown — trimmed, secret-scrubbed, bounded — as an additive field.
const scrub=(s:string):string=>s.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{4,}/gi,'[redacted]').replace(/[A-Za-z0-9_\-+/=]{32,}/g,'[redacted]').slice(0,200);
function describeFailure(error:unknown):FailureDetail|undefined {
 const out:FailureDetail={};const seen=new Set<unknown>();let cur:unknown=error;
 for(let depth=0;cur&&typeof cur==='object'&&depth<3&&!seen.has(cur);depth+=1){
  seen.add(cur);const rec=cur as Record<string,unknown>;
  const name=typeof rec.name==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(rec.name)?rec.name:undefined;
  const rawCode=typeof rec.code==='string'&&rec.code?rec.code.slice(0,64):undefined;
  const message=typeof rec.message==='string'&&rec.message?scrub(rec.message):undefined;
  if(depth===0){if(name)out.name=name;if(rawCode)out.rawCode=rawCode;if(message)out.message=message;}
  else {const part=rawCode??name;if(part)out.cause=(out.cause?out.cause+' <- ':'')+part;}
  cur=rec.cause;
 }
 return Object.keys(out).length>0?out:undefined;
}
export function safeFailure(error:unknown):PublicFailure {
 const e=(error&&typeof error==='object'?error:{}) as Record<string,unknown>;
 const raw=id(e.code);const code=raw??'SIWC_OPERATION_FAILED';const entry=known.get(code);
 const rawStatus=typeof e.status==='number' && Number.isInteger(e.status) && e.status>=400 && e.status<600?e.status:null;
 // A recognised code already says what happened; only the fallback needs the original context.
 const detail=raw===undefined?describeFailure(error):undefined;
 return {code,status:rawStatus??entry?.http??null,retryable:entry?.retry??false,
  ...(id(e.requestId)?{requestId:id(e.requestId)}:{}),...(id(e.param)?{param:id(e.param)}:{}),
  ...(detail?{detail}:{})};
}
export function errorState(code:string):'NOT_ELIGIBLE'|'LIMIT_EXCEEDED'|'REGION_OR_POLICY_RESTRICTED'|'REAUTH_REQUIRED'|'TEMPORARILY_UNAVAILABLE'|'DISCONNECTED' {
 if(code==='subscription_sharing_user_not_eligible')return'NOT_ELIGIBLE';
 if(code==='subscription_sharing_usage_limit_exceeded')return'LIMIT_EXCEEDED';
 if(/region|country|territory|policy_restricted/.test(code))return'REGION_OR_POLICY_RESTRICTED';
 if(['invalid_grant','invalid_refresh_token','refresh_token_expired','refresh_token_invalidated','refresh_token_reused','token_expired','subscription_sharing_invalid_user','invalid_client','sign_in_required'].includes(code))return'REAUTH_REQUIRED';
 if(['subscription_sharing_usage_unavailable','subscription_sharing_user_unavailable','network_error','refresh_not_ready','identity_verification_unavailable','stream_interrupted','response_incomplete'].includes(code))return'TEMPORARILY_UNAVAILABLE';
 return'DISCONNECTED';
}
export class SiwcBlocked extends Error {
 readonly code:string;readonly status:number;
 constructor(code:string,status=409){super(code);this.code=code;this.status=status;this.name='SiwcBlocked';}
}
