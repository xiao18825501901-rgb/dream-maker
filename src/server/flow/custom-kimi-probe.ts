import {resolve} from 'node:path';
import type {AgentInput,Config,Runner} from '../../shared/types.js';
import type {CustomProbeActor,CustomProbeObservation} from '../native-probes.js';
import {KimiRunner,createKimiTransport} from '../providers/kimi.js';
import {loadKimiAdmission} from '../kimi-admission.js';
import {createKimiCredentialAuthority} from '../kimi-credential-authority.js';
import {createKimiTokenStore} from '../kimi-token-store.js';
import {createWindowsCredentialEncryption} from '../siwc/windows-credential-encryption.js';
import {DomainError,hash,isCustomProbeNonce} from '../security.js';

/** Kimi is the third Custom harness: official OAuth, loopback server, no Magpie
 * and no Native ledger row. It is wired as the reviewer only, so a Flow can pair
 * a Codex planner with a DSH executor and an independent Kimi reviewer. */
interface RuntimeInput {
 root:string;dataRoot:string;getConfig:()=>Config;
 actor:{role:'planner2'|'executor'|'reviewer';roleId:string;provider:string;model:string;authRef:string;accountRef:string};
 configurationHash:string;assertCurrent:()=>void;
 /** Controller-owned test seam; production always builds the real loopback runner. */
 runner?:Runner;entitlementFile?:string;
}

function kimiSettings(config:Config){
 const kimi=config.kimi;
 if(!kimi||typeof kimi.baseUrl!=='string'||!kimi.baseUrl||typeof kimi.tokenFile!=='string'||!kimi.tokenFile)
  throw new DomainError('KIMI_RUNNER_UNAVAILABLE',409,'本机 Kimi 服务未配置；Kimi 角色不会退回其他运行器。');
 return {baseUrl:kimi.baseUrl,tokenFile:kimi.tokenFile,workspace:kimi.workspace};
}

/** One Kimi turn under the original Engine's owned Dispatch. The adapter, not the
 * model, states which runner answered; the session and prompt ids are the ones the
 * loopback server actually returned. */
export async function openCustomKimiRunner(input:RuntimeInput):Promise<Runner>{
 if(input.actor.provider!=='kimi'||input.actor.role!=='reviewer')throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409,'Kimi 只担任 Custom 审查角色。');
 const config=input.getConfig(),kimi=kimiSettings(config);
 let runner=input.runner;
 if(!runner){
  const admission=loadKimiAdmission(input.entitlementFile??process.env['DM_KIMI_ENTITLEMENT_FILE']??resolve(input.dataRoot,'kimi-entitlement.json')),
   credentials=createKimiCredentialAuthority({store:createKimiTokenStore({dir:resolve(input.dataRoot,'kimi-credentials'),encryption:createWindowsCredentialEncryption()})});
  await credentials.restore();
  // The durable record belongs to THIS data directory. Another directory's encrypted
  // cache is never copied in, so a fresh Custom root needs its own owner login.
  const state=credentials.current();
  if(credentials.barrier()!=='READY')throw new DomainError('KIMI_RESTORE_NOT_READY',409,'Kimi 凭据尚未完成还原屏障；这不是登录失败。');
  if(state.status==='MISSING')throw new DomainError('KIMI_CUSTOM_CREDENTIALS_REQUIRED',409,'这个 Custom 数据目录还没有 Kimi 持久化凭据；需要本人完成一次 Kimi 官方登录，且不会复制其他目录的认证缓存。');
  if(state.status==='CORRUPT')throw new DomainError('KIMI_STORED_STATE_CORRUPT',409,'已保存的 Kimi 凭据损坏；不清空、不要求重登，需按原凭据记录处理。');
  if(state.status==='REVOKED')throw new DomainError('KIMI_CREDENTIAL_REVOKED',409,'Kimi 凭据已被撤销，需要重新授权。');
  runner=new KimiRunner(input.getConfig,createKimiTransport({baseUrl:kimi.baseUrl,tokenFile:kimi.tokenFile}),undefined,undefined,admission,credentials);
 }
 const inner=runner;let used=false;
 return{run:async(args:AgentInput,emit)=>{
  if(used)throw new DomainError('CUSTOM_ROLE_TURN_ALREADY_USED',409);
  if(args.role!=='reviewer')throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
  used=true;input.assertCurrent();
  const out=await inner.run({...args,workspace:kimi.workspace??args.workspace},emit);
  input.assertCurrent();
  if(!out.sessionId||typeof out.usage?.requestId!=='string'||!out.usage.requestId)throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
  return{...out,usage:{...out.usage,role:'reviewer'},
   identity:{runner:'KIMI_SERVER',provider:'kimi',authentication:'MEMBER_SUBSCRIPTION',model:input.actor.model,
    runtime:'kimi',roleId:input.actor.roleId,authRef:input.actor.authRef,accountRef:input.actor.accountRef,configurationHash:input.configurationHash}};
 }};
}

export async function runCustomKimiProbe(input:RuntimeInput & {
 actor:CustomProbeActor & {role:'reviewer'};workspace:string;nonce:string;signal:AbortSignal;runId:string;specHash:string;
}):Promise<CustomProbeObservation>{
 const {actor}=input;
 if(actor.runtime!=='kimi'||actor.provider!=='kimi'||actor.authentication!=='MEMBER_SUBSCRIPTION')
  throw new DomainError('CUSTOM_PROBE_RUNTIME_UNSUPPORTED',409);
 if(!isCustomProbeNonce(input.nonce))throw new DomainError('CUSTOM_PROBE_NONCE_INVALID',409);
 input.assertCurrent();
 const runner=await openCustomKimiRunner({...input,actor:{...actor,role:'reviewer'}});
 const out=await runner.run({role:'reviewer',workspace:input.workspace,
   prompt:`Return only this exact code and nothing else. Do not call tools or add quotes, punctuation, Markdown, spaces, or commentary: ${input.nonce}`,
   model:actor.model,specHash:input.specHash,runId:input.runId,signal:input.signal,
   laya:{role:'reviewer',mode:'off',adoption:'off',label:null,reason:'CUSTOM_QUALIFICATION_LAYA_OFF',latencyMs:0,inputHash:hash(input.nonce),modelRevision:null,confidence:null,cached:false}},()=>{});
 input.assertCurrent();
 const text=out.text.trim();
 if(text!==input.nonce||out.identity?.runner!=='KIMI_SERVER'||out.identity.model!==actor.model||!out.sessionId||!out.usage?.requestId)
  throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
 return{...actor,runner:'KIMI_SERVER',responseId:out.usage.requestId,responseHash:hash(out.text),sessionId:out.sessionId,
  routeHash:hash({runtime:'kimi',provider:actor.provider,model:actor.model,authentication:actor.authentication}),
  paidFallback:false,ledgerRequestIds:[],cleanupReturned:true,reply:text};
}
