import type {Config,AgentInput,Runner} from '../../shared/types.js';
import {assertNativePriceForRoute,type NativeBudget,type NativePrice} from '../native-budget.js';
import type {OwnedMagpieControl} from '../magpie-owned.js';
import type {CustomProbeActor,CustomProbeObservation} from '../native-probes.js';
import {customProbeBudgetContext,customProbeRequestBinding,type CustomProbeBudgetContext} from './custom-probe-budget.js';
import {magpieRouteHash} from '../magpie-route.js';import {MagpieDshRequestTransport} from '../magpie-model-transport.js';
import {DeepSeekGateway} from '../deepseek-gateway.js';import {DshRunner} from '../providers/dsh.js';
import {CodexRunner,type CodexIncludedTurn} from '../providers/codex.js';import {prepareCodexMagpieHome} from '../providers/codex-magpie-home.js';
import {IndependentRunner} from '../providers/independent.js';
import {PiNativeSession} from './pi-native-session.js';
import {PiRunner} from '../providers/pi.js';
import {CUSTOM_TEXT_CLI_RUNNERS,customMagpieApiRuntime,isCustomTextCliRuntime,type CustomTextCliRuntime} from './custom-role-identity.js';
import {resolveCustomMagpieRoute} from './custom-magpie-catalog.js';
import type {CustomRoleProfile} from '../../shared/flow-profile.js';
import {openDshRoleTools} from './dsh-role-tools.js';import {DomainError,hash,isCustomProbeNonce,loopbackGatewayChatRequest} from '../security.js';import {treeHash} from '../workspace.js';
interface Ref{path:string;sha256:string}
interface Input {
    root:string;getConfig:()=>Config;budget:NativeBudget;session:OwnedMagpieControl;actor:CustomProbeActor;
    context:Omit<CustomProbeBudgetContext,'routeHash'>;workspace:string;nonce:string;signal:AbortSignal;
    /** DSH route only: the frozen engineering template and its SDK binding. */
    template?:Ref;profileBinding?:{sdkCommit:string;basePatch:string;sdkPatch:string;yamlModule:string;dependencies:Ref[]};sdkToolsModule?:string;
    claudeSupervisor?:Ref;
    customTextCli?:Partial<Record<CustomTextCliRuntime,Ref>>;
    selectedRole:CustomRoleProfile;
    maxOutputTokens:number;
    price:()=>NativePrice;assertCurrent():void;emit:(event:unknown)=>void;transport?:typeof fetch;
    /** Codex api-key route only: the child environment that carries DM_GATEWAY_TOKEN. */
    childEnvironment?:(env:NodeJS.ProcessEnv)=>NodeJS.ProcessEnv;
    observeRoute?:(input:{process:{pid:number;startedAt:string};signal:AbortSignal})=>Promise<unknown>;
}
type ProbeKind='dsh'|'codex'|'codex-subscription'|'independent'|'claude'|'pi'|CustomTextCliRuntime;
/** One credential may serve a frozen model set; the same rule the route enforces at
 * request time (model OR declared models) decides whether this role can use it. */
export function probeAccountMatches(account:{authRef:string;accountRef:string;provider:string;model?:string;models?:readonly string[]},actor:CustomProbeActor):boolean{
    return account.authRef===actor.authRef&&account.accountRef===actor.accountRef&&account.provider===actor.provider&&
        (account.model===actor.model||!!account.models?.includes(actor.model));
}
export function customProbeKind(actor:CustomProbeActor,route?:ReturnType<typeof resolveCustomMagpieRoute>):ProbeKind{
    if(actor.runtime==='codex'&&actor.role==='planner2'&&actor.transport==='magpie'&&actor.provider==='openai'&&actor.authentication==='CHATGPT_SUBSCRIPTION'&&actor.model==='gpt-6-luna')return 'codex-subscription';
    if(actor.transport==='magpie'&&actor.authentication==='API_KEY'&&customMagpieApiRuntime(actor.role,actor.runtime)){
        if(route)return actor.runtime;
        // Historical offline classification without an owned session.
        if(actor.runtime==='claude'&&actor.role==='reviewer'&&actor.provider==='string'&&actor.model==='claude-sonnet-5')return 'claude';
        if(actor.provider==='deepseek-official'&&actor.runtime!=='claude'){
            if(actor.runtime==='dsh'&&actor.model!=='deepseek-flash')throw new DomainError('CUSTOM_PROBE_RUNTIME_UNSUPPORTED',409,'旧版 DSH 仅支持 Flash，V4 Pro 仅支持 independent Reviewer。');
            if(actor.model==='deepseek-flash'||actor.role==='reviewer'&&actor.model==='deepseek-v4-pro'&&(actor.runtime==='independent'||isCustomTextCliRuntime(actor.runtime)))return actor.runtime;
        }
    }
    throw new DomainError('CUSTOM_PROBE_RUNTIME_UNSUPPORTED',409);
}
/** Probe kind names the qualification adapter; route metadata keeps the real harness name. */
export function customProbeRouteRuntime(kind:ProbeKind):ProbeKind|'codex'{
    return kind==='codex-subscription'?'codex':kind;
}
/** Assembly of the original Magpie/Gateway tools only. No dispatch, approvals, signing or retries. */
export async function runCustomProbeRuntime(input:Input):Promise<CustomProbeObservation>{
    if(!isCustomProbeNonce(input.nonce))throw new DomainError('CUSTOM_PROBE_NONCE_INVALID',409);
    // Every Magpie-backed Custom runtime is assembled here so its gateway request stays bound to
    // the original budget permit. Each role is still probed by its own harness, never a stand-in.
    const {actor,budget,session,selectedRole}=input,sourceHash=treeHash(input.workspace);input.assertCurrent();
    if(!selectedRole||selectedRole.id!==actor.roleId||!session.observation.realCredentialsPermitted)throw new DomainError('CUSTOM_PROBE_ACCOUNT_UNVERIFIED',409);
    const route=resolveCustomMagpieRoute(session.observation,actor.role,selectedRole);
    const kind=customProbeKind(actor,route),messages=kind==='dsh'||kind==='claude',subscription=kind==='codex-subscription';
    if(route.runtime!==customProbeRouteRuntime(kind)||route.provider!==actor.provider||route.model!==actor.model||route.authRef!==actor.authRef||route.accountRef!==actor.accountRef||route.authentication!==(subscription?'oauth':'api_key'))throw new DomainError('CUSTOM_PROBE_BINDING_CHANGED',409);
    const translatedClaude=kind==='claude'&&route.protocol!=='anthropic-messages';
    const nativePi=kind==='pi'&&route.protocol!=='chat-completions';
    const wire=nativePi?(route.protocol==='openai-responses'?'responses' as const:'anthropic-messages' as const):kind==='codex'||subscription?'responses' as const:messages?'anthropic-messages' as const:'chat-completions' as const;
    const subscriptionFingerprint=subscription?/^openai\/([a-f0-9]{64})$/.exec(route.upstreamAccountRef)?.[1]:undefined;
    if(subscription&&!subscriptionFingerprint)throw new DomainError('CUSTOM_PROBE_ACCOUNT_UNVERIFIED',409);
    const frozen=kind==='dsh'?dshInput(input):undefined;
    const context=customProbeBudgetContext({...input.context,routeHash:magpieRouteHash(route)}),permit=budget.beginCustomProbe(context);
    let gateway:DeepSeekGateway|undefined;
    const assertCurrent=()=>{if(input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);input.assertCurrent();if(treeHash(input.workspace)!==sourceHash)throw new DomainError('NATIVE_PROBE_SOURCE_CHANGED',409);};
    const quote=()=>{
        assertCurrent();const q=input.price();
        assertNativePriceForRoute(q,{provider:actor.provider,model:actor.model,currency:translatedClaude||nativePi||isCustomTextCliRuntime(kind)&&route.protocol==='openai-responses'?context.roleBudget.currency:'CNY'});
        // The original Gateway preflights with the final prepared body binding;
        // there is deliberately no invented preflight body or second reservation.
        return q;
    };
    try{
        const prompt=`Return only this exact code and nothing else. Do not call tools or add quotes, punctuation, Markdown, spaces, or commentary: ${input.nonce}`,
            args:AgentInput={role:actor.role,workspace:input.workspace,prompt,model:actor.model,specHash:context.specHash,runId:context.runId,...(actor.role==='executor'?{executorRoleId:actor.roleId}:{}),signal:input.signal,
                laya:{role:actor.role,mode:'off',adoption:'off',label:null,reason:'CUSTOM_QUALIFICATION_LAYA_OFF',latencyMs:0,inputHash:hash(input.nonce),modelRevision:null,confidence:null,cached:false}},
            claude=translatedClaude?{prompt,instructions:'Reply with exactly the supplied DM_PROBE nonce. No filesystem, tools, delegation or other output.',signal:input.signal,assertCurrent}:undefined,
            pi=kind==='pi'&&route.protocol!=='chat-completions'?new PiNativeSession({protocol:route.protocol,model:actor.model,maxInputTokens:quote().maxInputTokens,maxOutputTokens:input.maxOutputTokens,prompt,tools:[]}):undefined,
            planner=!translatedClaude&&!pi&&route.protocol==='openai-responses'?{model:actor.model,maxOutputTokens:input.maxOutputTokens,prompt,instructions:'Reply with exactly the supplied DM_PROBE nonce. No filesystem, tools, delegation or other output.'}:undefined,
            transport=new MagpieDshRequestTransport({session,budget,route,role:actor.role,planner,pi,claude,transport:input.transport,
            bindRequest:payload=>customProbeRequestBinding(context,{schema:'dream-maker.native-request-binding.v1',projectId:context.projectId,runId:context.runId,engineeringMode:'custom',configurationHash:context.configurationHash,planVersionHash:context.planVersionHash,specHash:context.specHash,dispatchId:context.dispatchId,generation:context.generation,role:actor.role,roleId:actor.roleId,work:{kind:'QUALIFICATION',probeId:context.probeId,bindingHash:context.bindingHash},bodyHash:payload.bodyHash,routeHash:payload.routeHash}),
            assertCurrent:binding=>{assertCurrent();customProbeRequestBinding(context,binding);}});
        const maxInner=messages||subscription||transport.officialCliResponses||kind==='pi'?1:4;let includedTurn:CodexIncludedTurn|undefined;
        gateway=new DeepSeekGateway(budget,quote,'',input.maxOutputTokens,maxInner,input.transport??fetch,wire,true,undefined,undefined,undefined,transport,{permit,assertCurrent:binding=>{assertCurrent();customProbeRequestBinding(context,binding);}},input.actor.model,subscription?()=>{
            if(!includedTurn)throw new DomainError('CODEX_INCLUDED_TURN_INVALID',409);
            return includedTurn;
        }:undefined);
        const address=await gateway.start();
        const runner=kind==='dsh'
            ?new DshRunner(input.getConfig,input.root,async()=>({...address,close:()=>gateway!.close(),receipts:()=>gateway!.receipts()}),()=>openDshRoleTools({root:input.root,role:actor.role,roleId:actor.roleId,provider:route.provider,model:route.model,configurationHash:context.configurationHash,runId:args.runId,specHash:args.specHash,modelURL:address.url,maxOutputTokens:input.maxOutputTokens,contextTokens:quote().maxInputTokens,template:frozen!.template,profileBinding:frozen!.profileBinding,sdkToolsModule:frozen!.sdkToolsModule,controller:{async dispatch(){throw new DomainError('NATIVE_MINIMUM_TOOL_DENIED',403);}}}),{role:actor.role,roleId:actor.roleId,provider:route.provider,model:route.model,assertCurrent})
            :kind==='codex'?codexRunner(input,actor,address)
            :kind==='codex-subscription'?codexSubscriptionRunner(input,actor,address,subscriptionFingerprint!,turn=>{includedTurn=turn;})
            :kind==='independent'?independentRunner(input,actor,address)
            :kind==='pi'?new PiRunner(input.getConfig,input.root,async()=>({url:address.url,token:address.token,close:()=>gateway!.close(),receipts:()=>gateway!.receipts()}),{role:actor.role as 'planner2'|'executor'|'reviewer',roleId:actor.roleId,provider:route.provider,model:route.model,protocol:route.protocol,maxOutputTokens:input.maxOutputTokens,tools:[],assertCurrent}):undefined;
        const output=runner?await runner.run(args,input.emit):await (async()=>{
            if(!isCustomTextCliRuntime(kind)&&kind!=='claude')throw new DomainError('CUSTOM_PROBE_RUNTIME_UNSUPPORTED',409);
            const commandRef=kind==='claude'?input.claudeSupervisor:input.customTextCli?.[kind];
            if(!commandRef||actor.role==='executor')throw new DomainError('CUSTOM_CLI_COMMAND_UNVERIFIED',409);
            const {runCustomOfficialCli}=await import('../providers/custom-official-cli.js');
            const result=await runCustomOfficialCli({runtime:kind,role:actor.role,commandRef,controllerRoot:input.root,gatewayUrl:address.url,
                gatewayToken:address.token,model:actor.model,prompt:args.prompt,signal:input.signal,timeoutMs:120000,maxOutputTokens:input.maxOutputTokens,assertCurrent,receipts:()=>gateway!.receipts()});
            if(gateway!.confirmedSupervisorOutput(result.model,result.text).id!==result.requestId)throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
            return {...result,identity:undefined};
        })();assertCurrent();const receipts=gateway.receipts(),receipt=receipts[receipts.length-1];
        if(kind==='dsh'&&(output.identity?.runner!=='DSH'||output.identity.provider!==actor.provider))throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
        if(kind==='codex'||kind==='codex-subscription')gateway.confirmedSupervisorOutput(actor.model,output.text);
        if(kind==='pi'&&(output.identity?.runner!=='PI_CLI'||output.identity.provider!==actor.provider||output.identity.authentication!=='API_KEY'||output.identity.model!==actor.model||output.model!==actor.model))throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
        if(kind==='codex'&&(output.identity?.runner!=='CODEX_CLI'||output.identity.provider!=='magpie'||output.identity.authentication!=='API_KEY'))throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
        if(kind==='codex-subscription'&&(output.identity?.runner!=='CODEX_CLI'||output.identity.provider!=='magpie'||output.identity.authentication!=='CHATGPT_SUBSCRIPTION'))throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
        // The shared IndependentRunner has no identity envelope; a controller-stated envelope must agree.
        // Magpie's chat-completions response may echo its provider-qualified route model, while the
        // qualification binding stays on the bare configured model. Accept only that exact route alias;
        // the Gateway receipt below still has to normalize back to actor.model.
        const magpieOutputModel=actor.provider+'/'+actor.model,
            independentOutputModel=output.model===actor.model||
                transport.responseModel===magpieOutputModel&&output.model===magpieOutputModel;
        if(kind==='independent'&&((output.identity&&output.identity.runner!=='INDEPENDENT_API')||!independentOutputModel))throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
        if(output.identity?.model!==undefined&&output.identity.model!==actor.model)throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
        if(receipts.length<1||receipts.length>maxInner||receipts.some(r=>r.outcome!=='COMPLETE')||!receipt.minimalResponseVerified||!receipt.completionObserved||receipt.outcome!=='COMPLETE'||receipt.observedModel!==actor.model||!receipt.responseId||!receipt.responseSha256||output.text.trim()!==input.nonce||
            ((messages||nativePi||transport.officialCliResponses)&&receipt.outputTextHash!==hash(input.nonce))||!output.sessionId)throw new DomainError('CUSTOM_PROBE_RESPONSE_UNVERIFIED',409);
        return{...actor,runner:isCustomTextCliRuntime(kind)?CUSTOM_TEXT_CLI_RUNNERS[kind]:kind==='claude'?'CLAUDE_CODE':kind==='pi'?'PI_CLI':kind==='dsh'?'DSH':kind==='codex'||kind==='codex-subscription'?'CODEX':'INDEPENDENT_API',responseId:receipt.responseId,responseHash:receipt.responseSha256,sessionId:output.sessionId,routeHash:context.routeHash,paidFallback:false,ledgerRequestIds:receipts.map(r=>r.id),cleanupReturned:true,reply:output.text.trim()};
    }finally{await finishCustomProbeRuntime(gateway,input.emit,()=>budget.endCustomProbe(permit));}
}

function dshInput(input:Input):{template:Ref;profileBinding:NonNullable<Input['profileBinding']>;sdkToolsModule:string}{
    if(!input.template||!input.profileBinding||!input.sdkToolsModule)throw new DomainError('CUSTOM_PROBE_TEMPLATE_REQUIRED',409);
    return{template:input.template,profileBinding:input.profileBinding,sdkToolsModule:input.sdkToolsModule};
}

/** The same official CLI, pointed at this probe's DM loopback provider through a per-run home. */
function codexRunner(input:Input,actor:CustomProbeActor,address:{url:string;token:string}):Runner{
    const home=prepareCodexMagpieHome(input.root,input.context.probeId,{model:actor.model,baseUrl:address.url,envKey:'DM_GATEWAY_TOKEN'}),
        config=():Config=>{const c=input.getConfig();return{...c,codex:{...c.codex,home:home.dir,model:actor.model}};},
        environment=(extra:NodeJS.ProcessEnv)=>input.childEnvironment?.({...extra,DM_GATEWAY_TOKEN:address.token})??{...process.env,...extra,DM_GATEWAY_TOKEN:address.token};
    return new CodexRunner(config,input.root,true,environment,undefined,input.observeRoute as never,'api_key','magpie');
}

function codexSubscriptionRunner(input:Input,actor:CustomProbeActor,address:{url:string;token:string},accountFingerprint:string,onIncludedTurn:(turn:CodexIncludedTurn)=>void):Runner{
    if(!/^[a-f0-9]{64}$/.test(accountFingerprint))throw new DomainError('CUSTOM_PROBE_ACCOUNT_UNVERIFIED',409);
    const config=():Config=>{const c=input.getConfig();return{...c,codex:{...c.codex,model:actor.model}};},
        environment=(extra:NodeJS.ProcessEnv)=>input.childEnvironment?.({...extra,DM_GATEWAY_TOKEN:address.token})??{...process.env,...extra,DM_GATEWAY_TOKEN:address.token};
    return new CodexRunner(config,input.root,true,environment,accountFingerprint,input.observeRoute as never,'chatgpt','magpie',address.url,onIncludedTurn);
}

/** Text-only direct API runner whose base URL is this probe's loopback gateway, so the request is
 * metered and attributed by the same budget permit instead of reaching a provider directly. */
function independentRunner(input:Input,actor:CustomProbeActor,address:{url:string;token:string}):Runner{
    const config=():Config=>{const c=input.getConfig();return{...c,independent:{enabled:true,baseUrl:address.url,protocol:'chat-completions',model:actor.model,keyEnv:'DM_GATEWAY_TOKEN',maxOutputTokens:input.maxOutputTokens,maxRequests:1}};};
    return new IndependentRunner(config,loopbackGatewayChatRequest(address),name=>name==='DM_GATEWAY_TOKEN'?address.token:undefined);
}




/** Persist bounded transport facts after handlers settle, including when the harness throws.
 * The existing owner event sink binds these to the probe/role. No response body or raw ID leaves here. */
export async function finishCustomProbeRuntime(gateway:Pick<DeepSeekGateway,'close'|'receipts'>|undefined,emit:(event:unknown)=>void,endPermit:()=>void):Promise<void>{
    try{
        await gateway?.close();
        for(const r of gateway?.receipts()??[])emit({method:'dm/customProbeGatewayReceipt',params:{
            id:r.id,upstreamHttpStatus:r.upstreamHttpStatus,upstreamContentType:r.upstreamContentType,
            protocolEventCount:r.protocolEventCount,protocolLastEventType:r.protocolLastEventType,protocolLastEventDetail:r.protocolLastEventDetail,protocolFailureStage:r.protocolFailureStage,
            toolArgumentFailureDetail:r.toolArgumentFailureDetail,
            upstreamBodyShape:r.upstreamBodyShape,upstreamBodyBytes:r.upstreamBodyBytes,upstreamBodySha256:r.upstreamBodySha256,upstreamBodyCode:r.upstreamBodyCode,
            upstreamRequestIdSha256:r.upstreamRequestIdSha256,
            transportErrorCode:r.transportErrorCode,networkFailureClass:r.networkFailureClass,
            elapsedMs:r.elapsedMs,elapsedMsCapped:r.elapsedMsCapped,completionObserved:r.completionObserved,
            responseModelMatched:r.responseModelMatched,outcome:r.outcome,recordedAt:r.recordedAt
        }});
    }finally{endPermit();}
}
