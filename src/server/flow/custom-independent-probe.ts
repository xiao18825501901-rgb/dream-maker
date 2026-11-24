import type {AgentInput,Config} from '../../shared/types.js';
import type {CustomProbeActor,CustomProbeObservation} from '../native-probes.js';
import {IndependentRunner} from '../providers/independent.js';
import {DomainError,hash,isCustomProbeNonce} from '../security.js';

interface Input {root:string;getConfig:()=>Config;actor:CustomProbeActor;workspace:string;nonce:string;signal:AbortSignal;runId:string;specHash:string;assertCurrent():void}

/** Minimum direct-API role turn: one nonce over the plain HTTPS model route.
 * This harness has no tools, no Magpie and no agent runtime in between. */
export async function runCustomIndependentProbe(input:Input):Promise<CustomProbeObservation>{
 const {actor}=input;
 if(actor.runtime!=='independent'||actor.provider!=='deepseek-official'||actor.authentication!=='API_KEY')throw new DomainError('CUSTOM_PROBE_RUNTIME_UNSUPPORTED',409);
 if(!isCustomProbeNonce(input.nonce))throw new DomainError('CUSTOM_PROBE_NONCE_INVALID',409);
 input.assertCurrent();
 // The role's frozen model wins over the global independent default.
 const config=():Config=>{const c=input.getConfig();return{...c,independent:{...c.independent!,model:actor.model}};},
  runner=new IndependentRunner(config),
  args:AgentInput={role:actor.role,workspace:input.workspace,prompt:`Return only this exact code and nothing else. Do not add quotes, punctuation, Markdown, spaces, or commentary: ${input.nonce}`,
   model:actor.model,specHash:input.specHash,runId:input.runId,signal:input.signal,
   laya:{role:actor.role,mode:'off',adoption:'off',label:null,reason:'CUSTOM_QUALIFICATION_LAYA_OFF',latencyMs:0,inputHash:hash(input.nonce),modelRevision:null,confidence:null,cached:false}},
  out=await runner.run(args,()=>{});
 input.assertCurrent();
 const text=out.text.trim();
 if(text!==input.nonce||!out.sessionId||!out.usage?.requestId||out.model!==actor.model)throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
 return{...actor,runner:'INDEPENDENT_API',responseId:out.usage.requestId,responseHash:hash(out.text),sessionId:out.sessionId,
  routeHash:hash({runtime:'independent',provider:actor.provider,model:actor.model,authentication:actor.authentication}),
  paidFallback:false,ledgerRequestIds:[],cleanupReturned:true,reply:text};
}
