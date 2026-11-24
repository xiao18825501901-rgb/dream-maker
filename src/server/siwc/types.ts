/** Independently authored structural boundary for @siwc/local at pinned commit.
 * This file neither bundles nor reimplements OpenAI's licensed SDK. */
export type AuthStatus = 'DISCONNECTED' | 'AUTHORIZING' | 'SIGNED_IN_NO_SHARING' | 'SHARING_ENABLED' | 'MODEL_DISCOVERY_FAILED' | 'REGION_OR_POLICY_RESTRICTED' | 'NOT_ELIGIBLE' | 'LIMIT_EXCEEDED' | 'REAUTH_REQUIRED' | 'TEMPORARILY_UNAVAILABLE' | 'INFERENCE_VERIFIED';
export interface SafeSession { status: 'disconnected' | 'connecting' | 'connected' | 'reauth_required'; sharing: boolean; profileId?: string; profileLabel?: string; identity?: { name?: string; email?: string }; error?: { code:string; message:string; retryable:boolean;status?:number;requestId?:string;param?:string }; }
export interface SavedAccount { id:string; label:string; status:SafeSession['status']; sharing:boolean; identity?:SafeSession['identity']; pending?:boolean; requiresNewRegistration?:boolean }
export interface ChatModel { slug:string; displayName:string }
export interface Encryption {id:string;isAvailable():boolean|Promise<boolean>;encrypt(plaintext:string):Uint8Array|Promise<Uint8Array>;decrypt(bytes:Uint8Array):string|Promise<string>}
export interface SiwcClient {
 signIn(opts?:{signal?:AbortSignal;newProfile?:boolean;profileId?:string;label?:string;reconsent?:boolean}):Promise<SafeSession>;
 cancelSignIn():void;getSession():Promise<SafeSession>;listProfiles():Promise<SavedAccount[]>;selectProfile(id:string):Promise<SafeSession>;
 listModels(opts?:{signal?:AbortSignal}):Promise<ChatModel[]>;subscribe(listener:(s:SafeSession)=>void):()=>void;
 disconnect():Promise<void>;streamResponse(opts:{model:string;input:string|Array<{role:'user'|'assistant'|'developer';content:string}>;instructions?:string;signal?:AbortSignal;onDelta?:(part:string)=>void}):Promise<{text:string}>;
}
export interface ClientFactory {():Promise<SiwcClient>}
export interface UiSiwcStatus {
 authMode:'api_key'|'siwc_plan'; state:AuthStatus; legal:{acknowledged:boolean;commercialUseAllowed:boolean;codeBundled:boolean};
 eligibility:'UNKNOWN'|'NOT_ELIGIBLE'|'REGION_OR_POLICY_RESTRICTED';region:'UNKNOWN'|'REGION_OR_POLICY_RESTRICTED';
 session:{status:SafeSession['status'];sharing:boolean;profileId?:string;profileLabel?:string;identity?:{name?:string;email?:string}};
 model:{slug:string|null;discovery:'NOT_RUN'|'AVAILABLE'|'FAILED';inference:'NOT_RUN'|'INFERENCE_VERIFIED'};
 attempts:{state:'IDLE'|'AUTHORIZING'|'SUCCEEDED'|'FAILED'|'CANCELLED';id:string|null;startedAt:string|null};
 usage:{source:'CHATGPT_PLAN';tokens:'UNKNOWN';costUsd:'UNKNOWN';manageUrl:'https://chatgpt.com/settings/usage'};
 error?:{code:string;status:number|null;requestId?:string;param?:string;retryable:boolean};
 capability:{sdk:'PINNED_CHECKOUT'|'UNAVAILABLE';osEncryption:'AVAILABLE'|'UNAVAILABLE';browserAuth:'NOT_RUN'|'BLOCKED'|'USER_REQUIRED'};
}
