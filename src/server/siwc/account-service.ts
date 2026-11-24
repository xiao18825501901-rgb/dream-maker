import { randomUUID } from 'node:crypto';
import type { AuthStatus, ChatModel, ClientFactory, SafeSession, SiwcClient, UiSiwcStatus } from './types.js';
import { errorState, safeFailure, SiwcBlocked, USAGE_URL, type PublicFailure } from './errors.js';

/** Local-only account coordinator. SDK performs OAuth, identity validation, token refresh, rotation and revocation. */
export class SiwcAccountService {
 private clientPromise:Promise<SiwcClient>|null=null;
 private current:SafeSession={status:'disconnected',sharing:false};
 private activeAttempt:{id:string;startedAt:string;state:UiSiwcStatus['attempts']['state']}|null=null;
 private error:PublicFailure|undefined;
 private override:AuthStatus|undefined;
 private catalog:{profileId:string;models:ChatModel[];checkedAt:string}|null=null;
 private inferenceVerifiedProfileModel:string|null=null;
 private authTask:Promise<void>|null=null;
 private generation=0;
 private controllers=new Set<AbortController>();
 private changing=false;
 private closed=false;
 private unsubscribe:(()=>void)|null=null;
 private authController:AbortController|null=null;
 // Local timeout is not proof that the native SDK released its OAuth resources.
 private nativeAuth:Promise<SafeSession>|null=null;
 constructor(private factory:ClientFactory,private deps:{getConfig:()=>{authMode:'api_key'|'siwc_plan';siwcModel:string;siwcProfileId:string;siwcNoncommercialAttested:boolean};
   sdkPresent:()=>boolean;encryptionReady:()=>Promise<boolean>;onProfileActivated?:(id:string)=>void;authTimeoutMs?:number}){}
 private async client():Promise<SiwcClient> {
  if(this.closed)throw new SiwcBlocked('SIWC_SERVICE_CLOSED',503);
  this.clientPromise??=this.factory().then(client=>{
   if(this.closed){client.cancelSignIn();throw new SiwcBlocked('SIWC_SERVICE_CLOSED',503);}
   this.unsubscribe=client.subscribe(session=>{if(!this.closed&&!this.authTask&&!this.nativeAuth)this.updateSession(session);});
   return client;
  }).catch(e=>{this.clientPromise=null;throw e;});return this.clientPromise;
 }
 private updateSession(session:SafeSession):void {
  if(this.current.profileId!==session.profileId || this.current.status!==session.status || this.current.sharing!==session.sharing)
   this.resetAccountDerived();
  this.current=session;
 }
 private resetAccountDerived():void {this.catalog=null;this.inferenceVerifiedProfileModel=null;this.override=undefined;this.error=undefined;this.generation++;for(const x of this.controllers)x.abort();this.controllers.clear();}
 private classify(err:unknown):void {this.error=safeFailure(err);this.override=errorState(this.error.code);}
 /** A single unreadable status/stream read must not turn a saved connection into a login prompt. */
 private classifyPreservingSession(err:unknown):void {
  this.error=safeFailure(err);
  const mapped=errorState(this.error.code);
  this.override=mapped==='DISCONNECTED'&&(this.current.status==='connected'||Boolean(this.deps.getConfig().siwcProfileId))
   ?'TEMPORARILY_UNAVAILABLE':mapped;
 }
 private attested():void {if(!this.deps.getConfig().siwcNoncommercialAttested)throw new SiwcBlocked('SIWC_NONCOMMERCIAL_ATTESTATION_REQUIRED',403);}
 get isBusy():boolean {return Boolean(this.authTask || this.nativeAuth || this.changing || this.controllers.size);}
 shutdown():void {this.closed=true;this.authController?.abort();this.unsubscribe?.();this.unsubscribe=null;if(this.authTask||this.nativeAuth)void this.clientPromise?.then(c=>c.cancelSignIn()).catch(()=>{});this.resetAccountDerived();}
 async status():Promise<UiSiwcStatus> {
  const config=this.deps.getConfig(),ready=await this.deps.encryptionReady().catch(()=>false),sdk=this.deps.sdkPresent();
  if(ready&&sdk&&config.siwcNoncommercialAttested&&!this.authTask&&!this.nativeAuth&&!this.closed){try{this.updateSession(await(await this.client()).getSession());if(this.override==='TEMPORARILY_UNAVAILABLE')this.override=undefined;}catch(e){this.classifyPreservingSession(e);}}
  const serviceAvailable=!this.closed&&ready&&sdk;
  // A previously connected in-memory session is NOT proof that the encrypted store/SDK is usable now.
  const s=serviceAvailable?this.current:{status:'disconnected' as const,sharing:false};
  const state:AuthStatus=this.activeAttempt?.state==='AUTHORIZING'?'AUTHORIZING':(!serviceAvailable && (this.current.status==='connected'||Boolean(config.siwcProfileId)))?'TEMPORARILY_UNAVAILABLE':this.override??(s.status==='reauth_required'?'REAUTH_REQUIRED':s.status==='connecting'?'AUTHORIZING':s.status==='connected'?(s.sharing?(this.inferenceVerifiedProfileModel===`${s.profileId}:${config.siwcModel}`?'INFERENCE_VERIFIED':'SHARING_ENABLED'):'SIGNED_IN_NO_SHARING'):'DISCONNECTED');
  const hasSelected=s.status==='connected'&&s.sharing&&s.profileId===config.siwcProfileId;
  return {authMode:config.authMode,state,legal:{acknowledged:config.siwcNoncommercialAttested,commercialUseAllowed:false,codeBundled:false},
   eligibility:this.override==='NOT_ELIGIBLE'?'NOT_ELIGIBLE':this.override==='REGION_OR_POLICY_RESTRICTED'?'REGION_OR_POLICY_RESTRICTED':'UNKNOWN',region:this.override==='REGION_OR_POLICY_RESTRICTED'?'REGION_OR_POLICY_RESTRICTED':'UNKNOWN',
   session:{status:s.status,sharing:s.sharing,...(s.profileId?{profileId:s.profileId}:{}),...(s.profileLabel?{profileLabel:s.profileLabel}:{}),...(s.identity?{identity:{...s.identity}}:{})},
   model:{slug:config.siwcModel||null,discovery:hasSelected&&this.catalog?.profileId===s.profileId?'AVAILABLE':this.override==='MODEL_DISCOVERY_FAILED'?'FAILED':'NOT_RUN',inference:this.inferenceVerifiedProfileModel===`${s.profileId}:${config.siwcModel}`?'INFERENCE_VERIFIED':'NOT_RUN'},
   attempts:this.activeAttempt?{...this.activeAttempt}:{state:'IDLE',id:null,startedAt:null},
   usage:{source:'CHATGPT_PLAN',tokens:'UNKNOWN',costUsd:'UNKNOWN',manageUrl:USAGE_URL},...(this.error?{error:this.error}:{}),
   capability:{sdk:sdk?'PINNED_CHECKOUT':'UNAVAILABLE',osEncryption:ready?'AVAILABLE':'UNAVAILABLE',browserAuth:'USER_REQUIRED'}};
 }
 /** Starts a detached *bounded* OAuth operation, returns only opaque attempt metadata. */
 async connect(opts:{newProfile?:boolean;profileId?:string;reconsent?:boolean}):Promise<{id:string;state:'AUTHORIZING'}> {
  this.attested();if(this.closed)throw new SiwcBlocked('SIWC_SERVICE_CLOSED',503);
  if(this.authTask||this.nativeAuth||this.changing||this.controllers.size)throw new SiwcBlocked('SIWC_OPERATION_BUSY',409);
  this.changing=true;
  try {
   if(!(await this.deps.encryptionReady()))throw new SiwcBlocked('SIWC_OS_ENCRYPTION_UNAVAILABLE',503);
   if(!this.deps.sdkPresent())throw new SiwcBlocked('SIWC_SDK_NOT_PINNED_OR_NOT_BUILT',503);
   const client=await this.client();
   const limit=this.deps.authTimeoutMs??120000;
   if(!Number.isSafeInteger(limit)||limit<1||limit>300000)throw new SiwcBlocked('SIWC_AUTH_TIMEOUT_INVALID',409);
   const attempt={id:randomUUID(),startedAt:new Date().toISOString(),state:'AUTHORIZING' as const};this.activeAttempt=attempt;
   this.resetAccountDerived();const epoch=this.generation,controller=new AbortController();this.authController=controller;
   const task=Promise.resolve().then(async()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    let rejectAbort:()=>void=()=>{};
    try {
     const cancelled=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(new SiwcBlocked('cancelled',409));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
     const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new SiwcBlocked('SIWC_AUTH_TIMEOUT',408));controller.abort();try{client.cancelSignIn();}catch{}},limit);timer.unref();});
     const native=client.signIn({...opts,signal:controller.signal});this.nativeAuth=native;
     const completed=native.then(session=>{if(this.nativeAuth===native)this.nativeAuth=null;return session;},error=>{if(this.nativeAuth===native)this.nativeAuth=null;throw error;});
     const session=await Promise.race([completed,cancelled,deadline]);
     if(this.closed||controller.signal.aborted||epoch!==this.generation)throw new SiwcBlocked('cancelled',409);
     this.updateSession(session);if(this.current.profileId)this.deps.onProfileActivated?.(this.current.profileId);
     this.activeAttempt={...attempt,state:'SUCCEEDED'};this.error=undefined;this.override=undefined;
    }catch(e){this.classify(e);this.activeAttempt={...attempt,state:safeFailure(e).code==='cancelled'?'CANCELLED':'FAILED'};}
    finally{if(timer)clearTimeout(timer);controller.signal.removeEventListener('abort',rejectAbort);if(this.authController===controller)this.authController=null;}
   });
   this.authTask=task.finally(()=>{this.authTask=null;});void this.authTask.catch(()=>{});
   return{id:attempt.id,state:'AUTHORIZING'};
  }finally{this.changing=false;}
 }
 async cancel():Promise<void>{if(!this.authTask)throw new SiwcBlocked('SIWC_NO_PENDING_AUTH',409);this.authController?.abort();(await this.client()).cancelSignIn();}
 async profiles():Promise<Array<{id:string;label:string;status:SafeSession['status'];sharing:boolean;pending:boolean;requiresNewRegistration:boolean}>>{
  this.attested();const a=await(await this.client()).listProfiles();return a.map(p=>({id:p.id,label:p.label,status:p.status,sharing:p.sharing,pending:p.pending===true,requiresNewRegistration:p.requiresNewRegistration===true}));
 }
 async selectProfile(profileId:string):Promise<SafeSession>{
  this.attested();if(this.authTask||this.nativeAuth||this.changing)throw new SiwcBlocked('SIWC_OPERATION_BUSY',409);
  if(!/^[a-zA-Z0-9-]{1,100}$/.test(profileId))throw new SiwcBlocked('SIWC_PROFILE_ID_INVALID',400);
  this.changing=true;try{const client=await this.client();const profiles=await client.listProfiles();if(!profiles.some(p=>p.id===profileId&&!p.pending))throw new SiwcBlocked('SIWC_PROFILE_NOT_FOUND',404);
   this.resetAccountDerived();this.current=await client.selectProfile(profileId);if(this.current.profileId)this.deps.onProfileActivated?.(this.current.profileId);return this.current;
  }catch(e){this.classify(e);throw e;}finally{this.changing=false;}
 }
 async disconnect():Promise<{localDisconnected:boolean;remoteRevocation:'NOT_CONFIRMED'}>{
  this.attested();if(this.authTask||this.nativeAuth||this.changing)throw new SiwcBlocked('SIWC_OPERATION_BUSY',409);this.changing=true;
  try{this.resetAccountDerived();const client=await this.client();await client.disconnect();this.current=await client.getSession();return {localDisconnected:this.current.status==='disconnected',remoteRevocation:'NOT_CONFIRMED'};}
  finally{this.changing=false;}
 }
 async models():Promise<{models:ChatModel[];checkedAt:string;profileId:string}>{
  this.attested();await this.requireSession(false);const client=await this.client();const profile=this.current.profileId!;
  const controller=new AbortController();this.controllers.add(controller);try{
   const candidates=await client.listModels({signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
   if(this.current.profileId!==profile||controller.signal.aborted)throw new SiwcBlocked('SIWC_ACCOUNT_CHANGED',409);
   const models=candidates.filter(v=>v&&typeof v.slug==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v.slug)&&typeof v.displayName==='string'&&v.displayName.length<=160);
   this.catalog={profileId:profile,models,checkedAt:new Date().toISOString()};this.override=undefined;this.error=undefined;
   return{models,checkedAt:this.catalog.checkedAt,profileId:profile};
  }catch(e){this.classify(e);if(this.override==='DISCONNECTED')this.override='MODEL_DISCOVERY_FAILED';throw e;}
  finally{this.controllers.delete(controller);}
 }
 private async requireSession(modelRequired:boolean):Promise<{client:SiwcClient;profileId:string;model:string;epoch:number}> {
  this.attested();const config=this.deps.getConfig();if(config.authMode!=='siwc_plan')throw new SiwcBlocked('SIWC_MODE_NOT_SELECTED',409);
  if(this.authTask||this.nativeAuth||this.changing)throw new SiwcBlocked('SIWC_OPERATION_BUSY',409);
  if(!(await this.deps.encryptionReady()))throw new SiwcBlocked('SIWC_OS_ENCRYPTION_UNAVAILABLE',503);
  if(!this.deps.sdkPresent())throw new SiwcBlocked('SIWC_SDK_NOT_PINNED_OR_NOT_BUILT',503);
  const client=await this.client();this.updateSession(await client.getSession());
  if(this.current.status!=='connected')throw new SiwcBlocked('SIWC_NOT_CONNECTED',401);
  if(!this.current.sharing)throw new SiwcBlocked('SIWC_SCOPE_NOT_GRANTED',403);
  if(!config.siwcProfileId||this.current.profileId!==config.siwcProfileId)throw new SiwcBlocked('SIWC_PROFILE_MISMATCH',409);
  if(modelRequired&&(!config.siwcModel||this.catalog?.profileId!==config.siwcProfileId||!this.catalog.models.some(m=>m.slug===config.siwcModel)))throw new SiwcBlocked('SIWC_MODEL_NOT_SELECTED_OR_STALE',409);
  if(['NOT_ELIGIBLE','REGION_OR_POLICY_RESTRICTED','LIMIT_EXCEEDED','REAUTH_REQUIRED'].includes(this.override||''))throw new SiwcBlocked('SIWC_PLAN_BLOCKED_'+this.override,403);
  return {client,profileId:this.current.profileId,model:config.siwcModel,epoch:this.generation};
 }
 async ensureCatalogAndSelection(slug:string):Promise<{slug:string;profileId:string}> {
  const sess=await this.requireSession(false);if(!this.catalog||this.catalog.profileId!==sess.profileId)await this.models();
  if(!this.catalog?.models.some(m=>m.slug===slug))throw new SiwcBlocked('SIWC_MODEL_NOT_IN_CATALOG',400);
  this.inferenceVerifiedProfileModel=null;return{slug,profileId:sess.profileId};
 }
 async infer(input:string,instructions:string,signal:AbortSignal,onDelta?:(text:string)=>void):Promise<{text:string;model:string;profileId:string}> {
  const {client,profileId,model,epoch}=await this.requireSession(true);
  if(input.length>80000||instructions.length>20000)throw new SiwcBlocked('SIWC_CONTEXT_LIMIT',413);
  const controller=new AbortController();this.controllers.add(controller);
  const combined=AbortSignal.any([controller.signal,signal,AbortSignal.timeout(90000)]);
  let output=0;
  try {const result=await client.streamResponse({model,input:[{role:'user',content:input}],instructions,signal:combined,onDelta:part=>{
   if(combined.aborted||this.generation!==epoch)return;
   output+=part.length;if(output>24000){controller.abort();return;}
   onDelta?.(part);
  }});
   if(combined.aborted||this.generation!==epoch||this.current.profileId!==profileId||this.current.status!=='connected'||!this.current.sharing)throw new SiwcBlocked('SIWC_RESULT_STALE_OR_ABORTED',409);
   if(result.text.length>24000)throw new SiwcBlocked('SIWC_OUTPUT_TOO_LARGE',413);
   this.inferenceVerifiedProfileModel=`${profileId}:${model}`;this.error=undefined;this.override=undefined;
   return {text:result.text,model,profileId};
  }catch(e){this.classifyPreservingSession(e);throw e;}finally{this.controllers.delete(controller);}
 }
 invalidateSelection():void {this.resetAccountDerived();}
}
