import type {Readable,Writable} from 'node:stream';
import type {NativeRequestBinding} from '../shared/native-request.js';
import type {NativeBudget} from './native-budget.js';
import type {MagpieGrantIntent} from './magpie-admission.js';
import {nativeRequestBinding} from './native-request-binding.js';
import {DomainError,hash,object} from './security.js';
import {concreteMagpieRoute,magpieRouteHash,magpieRoutePath,type MagpieConcreteRoute} from './magpie-route.js';

/** Trusted controller-only transport. The owner must pin/verify the dedicated process and
 * revalidate the original Engine dispatch and concrete account before calling grant().
 * This class neither discovers accounts nor creates dispatch/model/budget authority. */
export interface MagpieControlTransport {
 input:Writable;output:Readable;closed:Promise<unknown>;stop:()=>Promise<void>;
}
export interface MagpieControlGrant extends MagpieConcreteRoute {
 token:string;id:string;epoch:string;projectId:string;flowId:string;configurationHash:string;
 bindingHash:string;routeHash:string;roleId:string;role:'planner2'|'executor'|'reviewer';
 reservationId:string;subscriptionRequestHash?:string;
 upstreamKeyId:string;upstreamKey:string;method:'POST';path:string;bodyHash:string;expiresAtMs:number;
}
/** Internal request draft. Credential material is supplied by the dedicated child,
 * never by browser JSON or a persistent execution/profile record. */
export type MagpieControlDraft=Omit<MagpieControlGrant,'upstreamKeyId'|'upstreamKey'>;
const fields=['token','id','epoch','projectId','flowId','configurationHash','bindingHash','routeHash','roleId','role','reservationId','runtime','provider','protocol','model','authentication','accountRef','authRef','upstreamAccountRef','upstreamKeyId','upstreamKey','method','path','bodyHash','expiresAtMs'];
const draftFields=fields.filter(key=>key!=='upstreamKeyId'&&key!=='upstreamKey');
// The key's own TTL remains 120s in Magpie. This only bounds wall-clock skew between
// the independently scheduled controller and child when comparing their epochs.
const ACK_CLOCK_SKEW_MS=5000;
const ref=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function controlInput(raw:unknown,binding:NativeRequestBinding,reservationId:string,epoch:string,issued:boolean):Record<string,unknown> {
 const fail=():never=>{throw new DomainError('MAGPIE_CONTROL_GRANT_INVALID',409);};
 let expected=issued?fields:draftFields;
 let a:Record<string,unknown>,route:MagpieConcreteRoute;
 try{
  const descriptors=Object.getOwnPropertyDescriptors(object(raw));
  if(descriptors.path?.value==='/backend-api/codex/responses'){
   expected=[...expected,'subscriptionRequestHash'];
   if(!digest(descriptors.subscriptionRequestHash?.value))return fail();
  }
  if(Reflect.ownKeys(descriptors).length!==expected.length||expected.some(key=>!Object.hasOwn(descriptors,key)||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value')))return fail();
  a=Object.fromEntries(expected.map(key=>[key,descriptors[key].value]));
  route=concreteMagpieRoute({runtime:a.runtime,provider:a.provider,protocol:a.protocol,model:a.model,authentication:a.authentication,accountRef:a.accountRef,authRef:a.authRef,upstreamAccountRef:a.upstreamAccountRef});
 }catch{return fail();}
 if(Reflect.ownKeys(a).length!==expected.length||expected.some(key=>!Object.hasOwn(a,key))||!digest(a.token)||!ref(a.id)||
  a.epoch!==epoch||a.projectId!==binding.projectId||a.flowId!==binding.runId||a.configurationHash!==binding.configurationHash||a.bindingHash!==hash(binding)||a.routeHash!==binding.routeHash||a.roleId!==binding.roleId||a.role!==binding.role||a.reservationId!==reservationId||a.bodyHash!==binding.bodyHash||
  magpieRouteHash(route)!==binding.routeHash||a.path!==magpieRoutePath(route)||
  !['provider','accountRef','authRef',...(issued?['upstreamKeyId']:[])].every(key=>ref(a[key])&&!['UNKNOWN','NOT_VERIFIED'].includes(String(a[key]).toUpperCase()))||typeof a.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(a.model)||a.model.includes('://')||
  typeof a.expiresAtMs!=='number'||!Number.isSafeInteger(a.expiresAtMs)||issued&&(typeof a.upstreamKey!=='string'||!/^[\x21-\x7e]{1,512}$/.test(a.upstreamKey))||a.method!=='POST'||(a.path==='/backend-api/codex/responses'&&a.role!=='planner2'))return fail();
 return a;
}
function controlGrant(raw:unknown,binding:NativeRequestBinding,reservationId:string,epoch:string):MagpieControlGrant {return controlInput(raw,binding,reservationId,epoch,true) as unknown as MagpieControlGrant;}
function issuedGrant(raw:unknown,draft:MagpieControlDraft,controlHash:string):MagpieControlGrant|null {
 const fail=(category:string,detail?:Record<string,unknown>):never=>{
  const error=new DomainError('MAGPIE_ISSUANCE_ACK_INVALID',502);
  // Safe structural category only: never retain reply values, field names or secrets.
  Object.defineProperty(error,'cause',{value:Object.freeze({category,...(detail?{detail:Object.freeze(detail)}:{})}),enumerable:false,writable:false,configurable:false});
  throw error;
 };
 let a:Record<string,unknown>;
 try{
  const descriptors=Object.getOwnPropertyDescriptors(object(raw)),accepted=descriptors.accepted?.value;
   if(typeof accepted!=='boolean')return fail('ACK_SHAPE');
  const keys=['type','schema','epoch','id','reservationId','controlHash','accepted',...(accepted?['upstreamKeyId','upstreamKey','expiresAtMs']:[])];
   if(Reflect.ownKeys(descriptors).length!==keys.length||keys.some(key=>!Object.hasOwn(descriptors,key)||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value')))return fail('ACK_SHAPE');
  a=Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
  }catch{return fail('ACK_SHAPE');}
  if(a.type!=='issued'||a.schema!=='dream-maker.magpie-issued-key.v1')return fail('ACK_TYPE_OR_SCHEMA');
  if(a.epoch!==draft.epoch||a.id!==draft.id||a.reservationId!==draft.reservationId||a.controlHash!==controlHash)return fail('ACK_BINDING');
 if(a.accepted===false)return null;
  const subscription=draft.path==='/backend-api/codex/responses';
  const idPattern=subscription?/^subscription_[a-f0-9]{32}$/:/^[a-f0-9]{24}$/;
  const keyPattern=subscription?/^[a-f0-9]{64}$/:/^sk\x2dmagpie-key-[a-f0-9]{48}$/;
  if(typeof a.upstreamKeyId!=='string'||!idPattern.test(a.upstreamKeyId))return fail('ACK_KEY_ID');
  if(typeof a.upstreamKey!=='string'||!keyPattern.test(a.upstreamKey))return fail('ACK_KEY');
  if(typeof a.expiresAtMs!=='number'||!Number.isSafeInteger(a.expiresAtMs))return fail('ACK_EXPIRY_TYPE');
  if(a.expiresAtMs<draft.expiresAtMs)return fail('ACK_EXPIRY_BEFORE_REQUEST');
  const overrunMs=a.expiresAtMs-(Date.now()+120000+ACK_CLOCK_SKEW_MS);
  if(overrunMs>0)return fail('ACK_EXPIRY_TOO_FAR',{overrunBucket:overrunMs<=1000?'LE_1S':overrunMs<=5000?'LE_5S':overrunMs<=60000?'LE_60S':'OVER_60S'});
 return Object.freeze({...draft,upstreamKeyId:a.upstreamKeyId,upstreamKey:a.upstreamKey});
}

export class MagpieAdmissionPipe {
 private buffer='';private active=false;private closing=false;private failure:DomainError|null=null;
 private stopping:Promise<void>|null=null;
 private pending:{resolve:(value:unknown)=>void;reject:(error:Error)=>void;replied:boolean;deadline:number}|null=null;
 private timeoutMs:number;
 private preparedReservations=new Set<string>();private preparedIds=new Set<string>();
 constructor(private transport:MagpieControlTransport,private budget:NativeBudget,private session:{epoch:string;binaryHash:string;ackTimeoutMs?:number;cleanupTimeoutMs?:number}) {
  const bounded=(value:number)=>Number.isSafeInteger(value)&&value>=10&&value<=10000;
  if(!ref(session.epoch)||!digest(session.binaryHash)||!bounded(session.ackTimeoutMs??5000)||!bounded(session.cleanupTimeoutMs??10000))throw new DomainError('MAGPIE_CONTROL_SESSION_INVALID',409);
  this.session=structuredClone(session);this.timeoutMs=session.ackTimeoutMs??5000;
  transport.output.on('data',this.onData);transport.output.on('error',this.onError);transport.input.on('error',this.onError);
  void transport.closed.then(()=>{if(!this.closing)this.lose('MAGPIE_CONTROL_LOST');},()=>this.lose('MAGPIE_CONTROL_LOST'));
 }
 private onError=()=>{if(!this.closing)this.lose('MAGPIE_CONTROL_LOST');};
 private onData=(chunk:Buffer)=>{
  if(this.closing)return;
  if(!chunk.length)return;
  if(!this.pending||this.pending.replied){this.lose('MAGPIE_CONTROL_UNEXPECTED_OUTPUT');return;}
  if(Date.now()>=this.pending.deadline){this.lose('MAGPIE_CONTROL_TIMEOUT');return;}
  this.buffer+=chunk.toString('utf8');
  if(Buffer.byteLength(this.buffer)>16384){this.lose('MAGPIE_CONTROL_OUTPUT_LIMIT');return;}
  const end=this.buffer.indexOf('\n');if(end<0)return;
  const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
  if(this.buffer.length){this.lose('MAGPIE_CONTROL_UNEXPECTED_OUTPUT');return;}
  let parsed:unknown;try{parsed=JSON.parse(line);}catch{this.lose('MAGPIE_CONTROL_INVALID_OUTPUT');return;}
  this.pending.replied=true;this.pending.resolve(parsed);
 };
 private lose(code:string):void {
  this.failure??=new DomainError(code,502);this.pending?.reject(this.failure);
  void this.close().catch(()=>{}); // grant()/owner close still awaits the same cleanup promise
 }
 private startReply(deadline:number):{reply:Promise<unknown>;failed:Promise<never>} {
  let fail!:(error:Error)=>void;
  const failed=new Promise<never>((_resolve,reject)=>{fail=reject;});
  const reply=new Promise<unknown>((resolve,reject)=>{this.pending={resolve,reject:error=>{reject(error);fail(error);},replied:false,deadline};});
  return{reply,failed};
 }
 /** Acquire an ephemeral key on the same private pipe. This creates no model
  * result or router Intent; the original owner still owns settlement/recovery. */
 async prepare(reservationId:string,binding:NativeRequestBinding,raw:MagpieControlDraft,signal?:AbortSignal):Promise<MagpieControlGrant> {
  if(this.failure)throw this.failure;
  if(this.closing)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
  if(this.active)throw new DomainError('MAGPIE_CONTROL_BUSY',409);
  if(signal?.aborted)throw new DomainError('MAGPIE_CONTROL_CANCELLED',409);
  const scope=nativeRequestBinding(binding,binding?.role);
  if(scope.engineeringMode!=='custom')throw new DomainError('CLASSIC_MAGPIE_FORBIDDEN',409);
  const draft=controlInput(raw,scope,reservationId,this.session.epoch,false) as unknown as MagpieControlDraft;
  const hold=this.budget.pendingBoundRequest(reservationId,scope);
  if(hold.price.provider!==draft.provider||hold.price.model!==draft.model)throw new DomainError('MAGPIE_CONTROL_BUDGET_MISMATCH',409);
  if(hold.routerAdmission||this.preparedReservations.has(reservationId)||this.preparedIds.has(draft.id))throw new DomainError('MAGPIE_ISSUANCE_EXISTS',409);
  if(this.preparedIds.size>=4096)throw new DomainError('MAGPIE_ISSUANCE_LIMIT',409);
  if(draft.expiresAtMs<=Date.now()||draft.expiresAtMs>Date.now()+120000)throw new DomainError('MAGPIE_CONTROL_GRANT_INVALID',409);
  const frame=JSON.stringify({type:'issue',request:{...draft,maxInputTokens:hold.price.maxInputTokens,maxOutputTokens:hold.maxOutputTokens}});
  if(Buffer.byteLength(frame)>16384)throw new DomainError('MAGPIE_CONTROL_GRANT_INVALID',409);
  this.preparedReservations.add(reservationId);this.preparedIds.add(draft.id);
  this.active=true;const deadline=Math.min(Date.now()+this.timeoutMs,draft.expiresAtMs),{reply,failed}=this.startReply(deadline);
  const aborted=()=>this.lose('MAGPIE_CONTROL_CANCELLED'),timer=setTimeout(()=>this.lose('MAGPIE_CONTROL_TIMEOUT'),Math.max(1,deadline-Date.now()));
  signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  try{
   const written=new Promise<void>((resolve,reject)=>{
    if(this.failure){reject(this.failure);return;}
    this.transport.input.write(frame+'\n',error=>{if(error){this.lose('MAGPIE_CONTROL_LOST');reject(new DomainError('MAGPIE_CONTROL_LOST',502));}else resolve();});
   });
   const [ack]=await Promise.race([Promise.all([reply,written]),failed]);
   if(Date.now()>=deadline)this.lose('MAGPIE_CONTROL_TIMEOUT');if(this.failure)throw this.failure;
   const grant=issuedGrant(ack,draft,hash(frame));if(!grant)throw new DomainError('MAGPIE_ISSUANCE_DENIED',409);
   return grant;
  }catch(error){
   if(error instanceof DomainError&&error.code==='MAGPIE_ISSUANCE_DENIED')throw error;
   this.failure??=error instanceof DomainError?error:new DomainError('MAGPIE_CONTROL_LOST',502);
   try{await this.close();}catch{throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);}
   throw this.failure;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',aborted);this.pending=null;this.active=false;}
 }
 async grant(reservationId:string,binding:NativeRequestBinding,raw:MagpieControlGrant,signal?:AbortSignal):Promise<MagpieGrantIntent> {
  if(this.failure)throw this.failure;
  if(this.closing)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
  if(this.active)throw new DomainError('MAGPIE_CONTROL_BUSY',409);
  if(signal?.aborted)throw new DomainError('MAGPIE_CONTROL_CANCELLED',409);
  const scope=nativeRequestBinding(binding,binding?.role);
  if(scope.engineeringMode!=='custom')throw new DomainError('CLASSIC_MAGPIE_FORBIDDEN',409);
  const admission=controlGrant(raw,scope,reservationId,this.session.epoch);
  const hold=this.budget.pendingBoundRequest(reservationId,scope);
  if(hold.price.provider!==admission.provider||hold.price.model!==admission.model)throw new DomainError('MAGPIE_CONTROL_BUDGET_MISMATCH',409);
  // Only the original ledger supplies cost limits. Caller fields cannot widen this frame.
  const frame=JSON.stringify({type:'grant',admission:{...admission,maxInputTokens:hold.price.maxInputTokens,maxOutputTokens:hold.maxOutputTokens}});
  if(Buffer.byteLength(frame)>16384)throw new DomainError('MAGPIE_CONTROL_GRANT_INVALID',409);
  // Synchronous original-ledger transaction completes before touching the inherited pipe.
  const intent=this.budget.beginRouterAdmission(reservationId,scope,{schema:'dream-maker.magpie-grant-intent.v1',admissionId:admission.id,epoch:this.session.epoch,binaryHash:this.session.binaryHash,controlHash:hash(frame),expiresAtMs:admission.expiresAtMs});
  this.active=true;const deadline=Math.min(Date.now()+this.timeoutMs,intent.expiresAtMs),{reply,failed}=this.startReply(deadline);
  const aborted=()=>this.lose('MAGPIE_CONTROL_CANCELLED'),timer=setTimeout(()=>this.lose('MAGPIE_CONTROL_TIMEOUT'),Math.max(1,deadline-Date.now()));
  signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  try{
   const written=new Promise<void>((resolve,reject)=>{
    if(this.failure){reject(this.failure);return;}
    this.transport.input.write(frame+'\n',error=>{if(error){this.lose('MAGPIE_CONTROL_LOST');reject(new DomainError('MAGPIE_CONTROL_LOST',502));}else resolve();});
   });
   const [ack]=await Promise.race([Promise.all([reply,written]),failed]);
   if(Date.now()>=deadline)this.lose('MAGPIE_CONTROL_TIMEOUT');if(this.failure)throw this.failure;
   return this.budget.acknowledgeRouterAdmission(reservationId,scope,ack);
  }catch(error){
   this.failure??=error instanceof DomainError?error:new DomainError('MAGPIE_CONTROL_LOST',502);
   let recorded=true;try{this.budget.markRouterAdmissionUnknown(reservationId,intent.controlHash);}catch{recorded=false;}
   let cleaned=true;try{await this.close();}catch{cleaned=false;}
   if(!recorded){
    // Preserve both diagnoses: the original Engine must retain its cleanup gate even
    // when the failed ledger update also prevents a durable UNKNOWN acknowledgement.
    this.failure=new DomainError(cleaned?'MAGPIE_LEDGER_RESULT_UNCERTAIN':'PROCESS_CLEANUP_UNPROVEN',500,'MAGPIE_LEDGER_RESULT_UNCERTAIN');throw this.failure;
   }
   if(!cleaned)throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);throw this.failure;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',aborted);this.pending=null;this.active=false;}
 }
 close():Promise<void> {
  return this.stopping??=(async()=>{
   this.closing=true;this.pending?.reject(this.failure??new DomainError('MAGPIE_CONTROL_CLOSED',409));
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    try{this.transport.input.end();}catch{ /* Still attempt the original owner's cleanup. */ }
    await Promise.race([Promise.resolve().then(()=>this.transport.stop()),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DomainError('PROCESS_CLEANUP_UNPROVEN',500)),this.session.cleanupTimeoutMs??10000);})]);
   }catch{
    this.failure=new DomainError('PROCESS_CLEANUP_UNPROVEN',500);throw this.failure;
   }finally{clearTimeout(timer);this.transport.output.off('data',this.onData);this.buffer='';}
   // Error listeners deliberately survive until the owned pipes are collected: a late EPIPE
   // must not become an unhandled event that terminates the original local controller.
  })();
 }
}
