import type {AgentInput,Config} from '../../shared/types.js';
import type {CustomProbeActor,CustomProbeObservation} from '../native-probes.js';
import {CodexRunner} from '../providers/codex.js';
import {DomainError,hash,isCustomProbeNonce} from '../security.js';

interface Input {
 root:string;getConfig:()=>Config;actor:CustomProbeActor;workspace:string;nonce:string;signal:AbortSignal;runId:string;specHash:string;
 assertCurrent():void;childEnvironment?:(env:NodeJS.ProcessEnv)=>NodeJS.ProcessEnv;
 observeRoute?:(input:{process:{pid:number;startedAt:string};signal:AbortSignal})=>Promise<unknown>;
}

/** Minimum Codex role turn on the ChatGPT subscription route: one nonce, no tools, no Magpie
 * and no paid ledger row. The api-key route is assembled by the Magpie-backed probe runtime so
 * its gateway requests stay bound to the original budget permit. */
export async function runCustomCodexProbe(input:Input):Promise<CustomProbeObservation>{
 const {actor}=input;
 if(actor.runtime!=='codex'||actor.provider!=='openai'||actor.authentication!=='CHATGPT_SUBSCRIPTION')throw new DomainError('CUSTOM_PROBE_RUNTIME_UNSUPPORTED',409);
 if(!isCustomProbeNonce(input.nonce))throw new DomainError('CUSTOM_PROBE_NONCE_INVALID',409);
 input.assertCurrent();
 const config=input.getConfig,
  runner=new CodexRunner(config,input.root,true,input.childEnvironment,undefined,input.observeRoute as never),
  args:AgentInput={role:actor.role,workspace:input.workspace,prompt:`Return only this exact code and nothing else. Do not call tools or add quotes, punctuation, Markdown, spaces, or commentary: ${input.nonce}`,
   model:actor.model,specHash:input.specHash,runId:input.runId,signal:input.signal,
   laya:{role:actor.role,mode:'off',adoption:'off',label:null,reason:'CUSTOM_QUALIFICATION_LAYA_OFF',latencyMs:0,inputHash:hash(input.nonce),modelRevision:null,confidence:null,cached:false}},
  out=await runner.run(args,()=>{});
 input.assertCurrent();
 const text=out.text.trim();
 if(text!==input.nonce||out.identity?.runner!=='CODEX_CLI'||out.identity.model!==actor.model||!out.sessionId||!out.usage?.requestId
  ||out.identity.authentication!=='CHATGPT_SUBSCRIPTION')throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
 return{...actor,runner:'CODEX',responseId:out.usage.requestId,responseHash:hash(out.text),sessionId:out.sessionId,
  routeHash:hash({runtime:'codex',provider:actor.provider,model:actor.model,authentication:actor.authentication,transport:'native'}),
  paidFallback:false,ledgerRequestIds:[],cleanupReturned:true,reply:text};
}
