import { codexSubscriptionGatewayArgs } from './codex-magpie-config.js';
import { writeCodexSubscriptionModelCatalog } from './codex-magpie-catalog.js';
import { RpcPeer,RpcChildError } from './rpc.js';
import { codexLaunch, codexEnv, codexAgentCwd, codexCwdMatches,assertCodexTransportRoute,createWindowsCodexContext,codexSupervisorFeatures,wslProxyEnvironment,type WslProxyBinding } from './codex-transport.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DomainError, childEnv, object, redact,hash } from '../security.js';
import type { Config, Runner, AgentInput, AgentOutput } from '../../shared/types.js';
import { OwnedCodexSession } from './codex-owned.js';
import { reviewAdmissionPrompt } from '../review-admission.js';
import { classifyCodexTurnError, finalizeCodexRequestPath, type CodexRequestRouteObserver, type CodexRouteEvidence } from '../codex-network-path.js';
import { resolveWslProxyBinding } from './codex-wsl-proxy.js';
/** Deliberately small, closed subset for the controller's existing role policy.
 * No general TOML/config loader and no account settings cross this boundary. */
function rolePolicy(path:string|undefined,profile:string,transport:'stdio'|'wsl'):{sha256:string;settings:Record<string,unknown>;parent:string|null;dataOnly:boolean} {
    if(!path)throw new DomainError('CODEX_POLICY_FILE_MISSING',409);
    let bytes:Buffer;
    try{bytes=readFileSync(path);}catch{throw new DomainError('CODEX_POLICY_FILE_MISSING',409);}
    const fail=():never=>{throw new DomainError('CODEX_POLICY_FILE_INVALID',409);};
    if(bytes.length>16384||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profile))return fail();
    const tables:Record<string,Record<string,unknown>>={root:{},profile:{},filesystem:{},workspace:{},network:{}};
    const headers=new Map([['[permissions.'+profile+']','profile'],['[permissions.'+profile+'.filesystem]','filesystem'],['[permissions.'+profile+'.filesystem.":workspace_roots"]','workspace'],['[permissions.'+profile+'.network]','network']]);
    let section='root';const seen=new Set<string>();
    try{
        for(const raw of new TextDecoder('utf-8',{fatal:true}).decode(bytes).split(/\r?\n/)){
            const line=raw.trim();if(!line||line.startsWith('#'))continue;
            if(line.startsWith('[')){const next=headers.get(line);if(!next||seen.has(next))return fail();section=next;seen.add(next);continue;}
            const match=/^("(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|false)$/.exec(line);
            if(!match)return fail();const key=match[1].startsWith('"')?JSON.parse(match[1]):match[1],value=JSON.parse(match[2]);
            if(Object.hasOwn(tables[section],key)||['__proto__','constructor','prototype'].includes(key))return fail();tables[section][key]=value;
        }
    }catch{return fail();}
    const exact=(value:Record<string,unknown>,expected:Record<string,unknown>)=>Object.keys(value).length===Object.keys(expected).length&&Object.entries(expected).every(([key,v])=>value[key]===v);
    if(profile==='dream-maker-supervisor-data'){
        if(transport!=='stdio'||!exact(tables.root,{default_permissions:profile})||seen.has('profile')||seen.has('workspace')||!exact(tables.filesystem,{':minimal':'read'})||!exact(tables.network,{enabled:false}))return fail();
        return{sha256:hash(bytes),parent:null,dataOnly:true,settings:{default_permissions:profile,permissions:{[profile]:{filesystem:{':minimal':'read'},network:{enabled:false}}}}};
    }
    const fs=tables.filesystem,base={':root':'deny',':minimal':'read',':tmpdir':'deny',':slash_tmp':'deny'};
    const linuxRuntime='/opt/dream-maker-controller/codex-0.162.0/launcher/package/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
    if(!exact(tables.root,{default_permissions:profile})||!exact(tables.profile,{extends:':read-only'})||!exact(tables.workspace,{'.':'read'})||!exact(tables.network,{enabled:false})||Object.entries(base).some(([key,v])=>fs[key]!==v)||Object.keys(fs).length>5||Object.entries(fs).some(([key,v])=>!Object.hasOwn(base,key)&&(transport!=='wsl'||key!==linuxRuntime||v!=='read')))return fail();
    return{sha256:hash(bytes),parent:':read-only',dataOnly:false,settings:{default_permissions:profile,permissions:{[profile]:{extends:':read-only',filesystem:{...fs,':workspace_roots':{'.':'read'}},network:{enabled:false}}}}};
}
function includedQuota(quota:Record<string,unknown>):void {
    if(quota.ordinaryUsageAllowed!==true)throw new DomainError('CODEX_INCLUDED_USAGE_UNAVAILABLE',409);
    const buckets=[quota.rateLimits],by=object(quota.rateLimitsByLimitId??{});
    if('codex' in by)buckets.push(by.codex);
    for(const value of buckets){
        const bucket=object(value??{}),credits=object(bucket.credits??{});
        if(bucket.spendControlReached!==false)throw new DomainError('CODEX_INCLUDED_USAGE_UNAVAILABLE',409);
        if(credits.hasCredits!==false||credits.unlimited!==false)throw new DomainError('CODEX_PAID_CREDITS_NOT_AUTHORIZED',409);
    }
}
/** In-process proof from this runner's checked thread, valid for one physical planner request. */
export interface CodexIncludedTurn {
 readonly runId:string;readonly specHash:string;readonly model:string;readonly accountFingerprint:string;readonly threadId:string;
}
const includedTurns=new WeakMap<CodexIncludedTurn,()=>void>();
export function consumeCodexIncludedTurn(turn:CodexIncludedTurn,expected:Pick<CodexIncludedTurn,'runId'|'specHash'|'model'|'accountFingerprint'>):()=>void{
 const validate=includedTurns.get(turn);
 if(!validate||turn.runId!==expected.runId||turn.specHash!==expected.specHash||turn.model!==expected.model||turn.accountFingerprint!==expected.accountFingerprint)
  throw new DomainError('CODEX_INCLUDED_TURN_INVALID',409);
 includedTurns.delete(turn);
 validate();
 return validate;
}
export class CodexRunner implements Runner {
    /** The environment builder is injectable so a Live run can hand this child the per-run Clash proxy only. */
    constructor(private config: () => Config, private root: string,private minimumProbe=false,
        private environment: (extra: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = childEnv,
        private expectedAccountFingerprint?:string,
        private observeRequestRoute?:CodexRequestRouteObserver,
        /** 'chatgpt' is the subscription runner. 'api_key' is the same CLI driven through a
         * DM-owned loopback provider: no included-quota reading, no account fingerprint, and the
         * provider name comes from the caller's config.toml rather than being forced to openai. */
        private auth:'chatgpt'|'api_key'='chatgpt',
        private modelProvider='openai', private subscriptionGateway?:string,
        private onIncludedTurn?:(turn:CodexIncludedTurn)=>void,
        private onPreparedPrompt?:(prompt:string)=>void,
        private reviewerProvider?:string) { }
    async run(input: AgentInput, onEvent: (event: unknown) => void): Promise<AgentOutput&{observation:{model:string;provider:string;accountFingerprint?:string;includedUsageAllowed:boolean;paidFallback:false;threadId:string;turnId:string;permissionProfile:string;policyHash:string}}> {
        if (input.role !== 'planner2' && input.role !== 'reviewer')
            throw new DomainError('CODEX_ROLE_DENIED', 403);
        const config=structuredClone(this.config()),c=config.codex;
        if (!c.model)
            throw new DomainError('CODEX_MODEL_REQUIRED', 409);
        if (!c.home)
            throw new DomainError('ISOLATED_CODEX_HOME_REQUIRED', 409);
        // K07: a named permission profile is mandatory. Without it the server would fall back to
        // whatever the CLI considers default, which is exactly the silent widening we refuse.
        if (!c.permissionProfile)
            throw new DomainError('CODEX_PERMISSION_PROFILE_REQUIRED', 409);
        const policy=rolePolicy(c.policyFile,c.permissionProfile,c.transport??'stdio'),policyHash=policy.sha256;
        if(input.model!==c.model)throw new DomainError('CODEX_MODEL_BINDING_CHANGED',409);
        if (input.signal.aborted)
            throw new DomainError('RUN_CANCELLED', 409);
        // K07-B: the launch shape is decided by the transport, never by a silently widened fallback.
        const windowsCli=(c.transport??'stdio')==='stdio'&&(/(?:^|[\\/])codex\.exe$/i.test(c.command)||/\/node_modules\/@openai\/codex\/bin\/codex\.js$/i.test((c.args[0]??'').replaceAll('\\','/')));
        const windowsContext=process.platform==='win32'&&windowsCli&&policy.dataOnly?createWindowsCodexContext(this.root,c.home,input.role):undefined;
        let environment=this.environment({...codexEnv(config),...windowsContext?.environment});
        let wslProxy:WslProxyBinding|undefined;
        if((c.transport??'stdio')==='wsl'&&config.clash.enabled){
            wslProxy=await resolveWslProxyBinding(config,this.root,environment,input.signal);
            environment={...environment,...wslProxyEnvironment(wslProxy)};
        }
        const childRouteEvidence=assertCodexTransportRoute(config,environment);
        onEvent({method:'dm/codexNetworkPath',params:{role:input.role,transport:c.transport??'stdio',...childRouteEvidence}});
        const ownedSession=(c.transport??'stdio')==='wsl'?new OwnedCodexSession(config,this.root,input.workspace,wslProxy):undefined;
        const launch = ownedSession?.launch??codexLaunch(config, windowsContext?.cwd??input.workspace,{wslProxy});
        if(this.subscriptionGateway!==undefined||(this.auth==='chatgpt'&&this.modelProvider==='magpie')){
            if(input.role!=='planner2'||!this.expectedAccountFingerprint||!/^[a-f0-9]{64}$/.test(this.expectedAccountFingerprint)||!this.onIncludedTurn||!windowsContext||this.auth!=='chatgpt'||this.modelProvider!=='magpie'||!this.subscriptionGateway||!environment.DM_GATEWAY_TOKEN)
                throw new DomainError('CODEX_SUBSCRIPTION_GATEWAY_REQUIRED',409);
            const catalog=writeCodexSubscriptionModelCatalog(windowsContext.directory,c.model);
            launch.args.push(...codexSubscriptionGatewayArgs(c.model,this.subscriptionGateway,catalog.path));
        }
        if(windowsContext)launch.args.push(...windowsContext.args);
        const agentCwd = windowsContext?.cwd??codexAgentCwd(config, input.workspace);
        // The spawned process cwd is Windows-side only; for the wsl transport the Linux working
        // directory is carried by --cd, so the two cannot be confused for one another.
        const peer = new RpcPeer(launch.command, launch.args, { cwd: launch.cwd ?? input.workspace, env: environment,...(process.platform==='win32'&&windowsCli?{windowsJobRoot:this.root}:{}),...(ownedSession?{onIntent:(processId:string|undefined)=>ownedSession.bindProcess(processId)}:{}) });
        let threadId = '', turnId = '', text = '', finished = false,startingTurn=false;
        let includedTurn:CodexIncludedTurn|undefined;
        let observationStartedAt:string|null=null,requestRouteEvidence:Promise<CodexRouteEvidence|null>|null=null,routeRecorded=false;
        peer.onRpcError=evidence=>onEvent({method:'dm/codexRpcError',params:{...evidence,role:input.role,...(threadId?{threadId}:{}),turnStartRequested:startingTurn,turnIdPresent:!!turnId}});
        let failure:Error|null=null,closing:Promise<void>|null=null,closingStarted=false;
        const close=()=>{if(!closing){closingStarted=true;closing=ownedSession?ownedSession.finish(peer):peer.close();}return closing;};
        const early:{method:string;params:Record<string,unknown>}[]=[];
        let resolveTurn!: (v: void) => void, rejectTurn!: (e: Error) => void;
        const completion = new Promise<void>((res, rej) => { resolveTurn = res; rejectTurn = rej; });
        completion.catch(() => { });
        let usage: Record<string, unknown> = {};
        const stop=(error:Error)=>{
            if(finished||failure)return;failure=error;rejectTurn(error);
            if(!closingStarted){
                if(threadId&&turnId)void peer.request('turn/interrupt',{threadId,turnId},1000).catch(()=>{});
                void close().catch(()=>{});
            }
        };
        const check=()=>{if(failure)throw failure;if(input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);};
        peer.onFailure=stop;
        peer.onRequest=(_method,_params,requestId)=>{peer.send({id:requestId,error:{code:-32601,message:'Client request not permitted'}});stop(new DomainError('CODEX_CLIENT_REQUEST_DENIED',409));};
        const notification=(method:string,params:Record<string,unknown>)=>{
            if(finished||failure)return;
            if(method==='account/rateLimits/updated'){
                const bucket=object(params.rateLimits??{}),credits=object(bucket.credits??{});
                if(bucket.spendControlReached===true)stop(new DomainError('CODEX_INCLUDED_USAGE_UNAVAILABLE',409));
                else if(credits.hasCredits===true||credits.unlimited===true)stop(new DomainError('CODEX_PAID_CREDITS_NOT_AUTHORIZED',409));
                return;
            }
            if(method==='account/updated'){
                const allowed=this.auth==='api_key'?'apiKey':'chatgpt';
                if(params.authMode!=null&&params.authMode!==allowed)stop(new DomainError('CODEX_SUBSCRIPTION_ACCOUNT_REQUIRED',409));
                return;
            }
            if(!threadId||!turnId||params.threadId!==threadId)return;
            const notifiedTurn=method==='turn/completed'?object(params.turn??{}).id:params.turnId;
            if(notifiedTurn!==turnId)return;
            if((method==='item/started'||method==='item/completed')&&!['agentMessage','reasoning','userMessage'].includes(String(object(params.item??{}).type))){stop(new DomainError('CODEX_UNEXPECTED_TOOL',409));return;}
            if(!['item/started','item/completed','thread/tokenUsage/updated','turn/completed'].includes(method))return;
            onEvent({ method, params: JSON.parse(redact(params)) });
            if (method === 'item/completed') {
                const item = object(params.item ?? {});
                if (item.type === 'agentMessage' && typeof item.text === 'string')
                    text = item.text;
            }
            if (method === 'thread/tokenUsage/updated')
                usage = object(object(params.tokenUsage ?? {}).total ?? {});
            if (method === 'turn/completed') {
                const turn = object(params.turn ?? {});
                finished = true;
                if (turn.status === 'completed')
                    resolveTurn();
                else
                    rejectTurn(new DomainError('CODEX_TURN_' + String(turn.status).toUpperCase(), 502));
            }
        };
        peer.onNotification=(method,params)=>{
            if(startingTurn&&!turnId&&params.threadId===threadId){
                if(early.length>=256){stop(new DomainError('CODEX_PREACK_EVENT_LIMIT',502));return;}
                early.push({method,params});return;
            }
            notification(method,params);
        };
        const abort = () => stop(new DomainError('RUN_CANCELLED',409));
        input.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => stop(new DomainError('CODEX_TURN_TIMEOUT', 504)), config.limits.stepTimeoutMs);
        // A cold official app-server can spend tens of seconds before it answers initialize.
        // Only that first request gets the longer allowance; all later preparation remains
        // bounded by the original whole-step/cancellation limit.
        const initializationTimeoutMs=Math.min(90000,config.limits.stepTimeoutMs);
        const preparationTimeoutMs=Math.min(30000,config.limits.stepTimeoutMs);
        const prepare=async(method:'initialize'|'account/read'|'account/rateLimits/read'|'model/list'|'thread/start',params:Record<string,unknown>,timeoutMs=preparationTimeoutMs)=>{
            check();const started=performance.now();
            let deadline:NodeJS.Timeout|undefined;
            const expired=new Promise<never>((_,reject)=>{
                deadline=setTimeout(()=>{const error=new DomainError('RPC_REQUEST_TIMEOUT',504);stop(error);reject(error);},timeoutMs);
            });
            try{
                onEvent({method:'dm/codexPreparation',params:{role:input.role,method,status:'STARTED',timeoutMs}});check();
                // RpcPeer starts its timer after ownership readiness. This outer deadline includes
                // that wait and closes the original peer before any late request can be sent.
                const result=await Promise.race([peer.request(method,params,timeoutMs),expired]);check();
                onEvent({method:'dm/codexPreparation',params:{role:input.role,method,status:'COMPLETED',elapsedMs:Math.max(0,Math.floor(performance.now()-started))}});
                return result;
            }catch(error){
                const cause=failure??error;
                onEvent({method:'dm/codexPreparation',params:{role:input.role,method,status:'FAILED',elapsedMs:Math.max(0,Math.floor(performance.now()-started)),code:cause instanceof DomainError?cause.code:'CODEX_PREPARATION_FAILED'}});
                throw error;
            }finally{if(deadline)clearTimeout(deadline);}
        };
        try {
            // The installed app-server gates `thread/start.permissions` (the named permission profile K07
        // depends on) behind the experimental capability. Without declaring it every Codex role dies with
        // "thread/start.permissions requires experimentalApi capability" - a wire requirement, not a policy.
        await prepare('initialize', { clientInfo: { name: 'dream_maker', title: 'Dream Maker', version: '0.1.0' }, capabilities: { experimentalApi: true } },initializationTimeoutMs);
            peer.notify('initialized', {});
            await ownedSession?.pin();
            check();
            const account=await prepare('account/read',{refreshToken:false});check();
            // The subscription route must prove a ChatGPT account. The api-key route talks to this
            // run's DM loopback provider and never claims subscription usage, so a chatgpt account
            // is not part of its contract (see the quota note immediately below).
            if(this.auth==='chatgpt'&&object(account.account??{}).type!=='chatgpt')throw new DomainError('CODEX_SUBSCRIPTION_ACCOUNT_REQUIRED',409);
            // An api-key route has no subscription account to fingerprint and no included quota to
            // read; demanding either would make the loopback provider unusable, and skipping them is
            // not a relaxation because that route never claims subscription usage.
            if(this.auth==='chatgpt'){
                if(this.expectedAccountFingerprint&&hash(object(account.account))!==this.expectedAccountFingerprint)throw new DomainError('CODEX_ACCOUNT_BINDING_CHANGED',409);
                includedQuota(await prepare('account/rateLimits/read',{}));check();
            }
            const catalog=await prepare('model/list',{limit:100,includeHidden:true});check();
            if(!Array.isArray(catalog.data))throw new DomainError('CODEX_MODEL_CATALOG_UNVERIFIED',409);
            // `model/list` describes the CLI's own subscription catalogue. The api-key loopback
            // provider serves exactly one controller-pinned model, so absence there is not evidence
            // about our route: thread/start must still acknowledge the same model/provider below,
            // and the gateway rejects any request whose body names another model.
            if(this.auth!=='api_key'&&!catalog.data.some(value=>object(value).model===c.model))throw new DomainError(catalog.nextCursor!=null?'CODEX_MODEL_CATALOG_INCOMPLETE':'CODEX_MODEL_NOT_LISTED',409);
            // Wire SandboxMode is kebab-case, independently verified against generated TS schema.
            const dataOnly=policy.dataOnly?{environments:[],runtimeWorkspaceRoots:[],dynamicTools:[],selectedCapabilityRoots:[],allowProviderModelFallback:false}:{};
            // The pinned CLI replaces its launch feature table with the thread-level table.
            const features={...(policy.dataOnly?codexSupervisorFeatures:{shell_tool:false}),...(this.auth==='api_key'?{goals:false}:{})};
            const started = await prepare('thread/start', { model: c.model,modelProvider:this.modelProvider,serviceTier:'default', cwd: agentCwd, approvalPolicy: 'never', permissions: c.permissionProfile,config:{...policy.settings,features,web_search:'disabled',...(policy.dataOnly?{project_doc_max_bytes:0,mcp_servers:{},tools:{update_plan:{enabled:false},experimental_request_user_input:{enabled:false}}}:{})},...dataOnly, developerInstructions: this.minimumProbe?'Reply with exactly the supplied DM_PROBE nonce. No filesystem, tools, delegation or other output.':readFileSync(resolve(this.root, `prompts/${input.role}.md`), 'utf8'), serviceName: 'dream_maker' },preparationTimeoutMs);
            check();
            const threadValue=object(started.thread).id;
            threadId=typeof threadValue==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(threadValue)?threadValue:'';
            if (!threadId)
                throw new DomainError('CODEX_THREAD_ID_MISSING', 502);
            if(started.model!==c.model||started.modelProvider!==this.modelProvider||started.serviceTier!=='default')throw new DomainError('CODEX_ACTUAL_ROUTE_MISMATCH',409);
            // Fixed 0.162.0 experimental wire is {id, extends}, with no `source` field.
            // Provenance is the pinned controller policy supplied above, never a child label.
            const active=started.activePermissionProfile;
            if(active===null||active===undefined)throw new DomainError('CODEX_ACTIVE_PERMISSION_PROFILE_MISSING',409);
            const activeValue=object(active);
            const activeName=typeof activeValue.id==='string'?activeValue.id:'';
            if(!activeName||activeName!==c.permissionProfile)throw new DomainError('CODEX_ACTIVE_PERMISSION_PROFILE_MISMATCH',409);
            if(activeValue.extends!==policy.parent)throw new DomainError('CODEX_PERMISSION_PROFILE_PARENT_MISMATCH',409);
            if(policy.dataOnly&&(!Array.isArray(started.runtimeWorkspaceRoots)||started.runtimeWorkspaceRoots.length!==0||!Array.isArray(object(started.thread).environments)||(object(started.thread).environments as unknown[]).length!==0))throw new DomainError('CODEX_THREAD_ENVIRONMENT_MISMATCH',409);
            const sandbox=object(started.sandbox??{});
            if(sandbox.type!=='readOnly'||sandbox.networkAccess!==false||!codexCwdMatches(config,agentCwd,started.cwd)||started.approvalPolicy!=='never')throw new DomainError('CODEX_THREAD_POLICY_MISMATCH',409);
            if(this.auth==='chatgpt'){includedQuota(await prepare('account/rateLimits/read',{}));check();}
            // The app-server acknowledges its local provider alias. A paid Custom reviewer has a separately qualified upstream provider.
            const paidReviewer=!this.minimumProbe&&input.role==='reviewer'&&this.auth==='api_key';
            if(paidReviewer&&this.modelProvider==='magpie'&&!this.reviewerProvider)throw new DomainError('CUSTOM_CODEX_REVIEW_PROVIDER_REQUIRED',409);
            const provider=paidReviewer?(this.reviewerProvider??this.modelProvider):started.modelProvider;
            const authentication=this.auth==='api_key'?'API_KEY' as const:'CHATGPT_SUBSCRIPTION' as const;
            const reviewInput=this.minimumProbe?{prompt:input.prompt}:reviewAdmissionPrompt(input,{threadId,model:c.model,provider,authentication,permissionProfile:c.permissionProfile,policyHash,...(input.role==='reviewer'?{materialEncoding:'PACKET_OBJECT_V1' as const}:{})});
            onEvent({method:'dm/codexAdmission',params:{role:input.role,model:started.model,provider,authentication,includedUsageAllowed:this.auth==='chatgpt',paidFallback:false,threadId,permissionProfile:c.permissionProfile,policyHash,transport:launch.transport,...(reviewInput.packetHash?{reviewPacketHash:reviewInput.packetHash,materialEncoding:'PACKET_OBJECT_V1',inputHash:hash(reviewInput.prompt),inputBytes:Buffer.byteLength(reviewInput.prompt)}:{})}});
            check();
            if(hash(readFileSync(c.policyFile!))!==policyHash)throw new DomainError('CODEX_POLICY_FILE_CHANGED',409);
            if(this.subscriptionGateway){
                includedTurn=Object.freeze({runId:input.runId,specHash:input.specHash,model:c.model,threadId,accountFingerprint:hash(object(account.account))});
                const expiresAt=performance.now()+120000;
                includedTurns.set(includedTurn,()=>{
                    check();
                    if(finished||closingStarted||performance.now()>=expiresAt)throw new DomainError('CODEX_INCLUDED_TURN_INVALID',409);
                });
                this.onIncludedTurn!(includedTurn);
                check();
            }
            this.onPreparedPrompt?.(reviewInput.prompt);
            peer.expectUserMessage(threadId,reviewInput.prompt);
            startingTurn=true;
            observationStartedAt=new Date().toISOString();
            if(this.observeRequestRoute&&launch.transport==='stdio'){
                const observer=this.observeRequestRoute;
                requestRouteEvidence=(async()=>{
                    try{
                        const info=await peer.processInfo();
                        if(!info)return null;
                        return await observer({process:info,signal:input.signal});
                    }catch{return null;}
                })();
            }
            const turn = await peer.request('turn/start', { threadId,model:c.model,serviceTierForTurn:'default', input: [{ type: 'text', text: reviewInput.prompt }], cwd: agentCwd, approvalPolicy: 'never', permissions: c.permissionProfile, ...(policy.dataOnly?{environments:[]}:{}),...(input.outputSchema ? { outputSchema: input.outputSchema } : {}) });
            check();
            const turnValue=object(turn.turn).id;
            turnId=typeof turnValue==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(turnValue)?turnValue:'';
            if(!turnId)throw new DomainError('CODEX_TURN_ID_MISSING',502);
            if(requestRouteEvidence)await requestRouteEvidence;
            for(const event of early)notification(event.method,event.params);
            early.length=0;
            await completion;
            check();
            if (!text.trim())
                throw new DomainError('CODEX_EMPTY_OUTPUT', 502);
            const tokens=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
            if(requestRouteEvidence&&observationStartedAt&&!routeRecorded){
                routeRecorded=true;
                const evidence=await requestRouteEvidence;
                if(evidence)onEvent({method:'dm/codexRequestPath',params:finalizeCodexRequestPath({
                    role:input.role,startedAt:observationStartedAt,completedAt:new Date().toISOString(),
                    evidence,classification:'INFERENCE_COMPLETED',requestId:turnId,httpStatus:null
                })});
            }
            onEvent({method:'dm/codexCompletion',params:{role:input.role,model:started.model,provider,authentication,paidFallback:false,threadId,turnId,status:'completed',specHash:input.specHash,runId:input.runId}});
            return { text, sessionId: threadId, model: started.model, identity: { runner: 'CODEX_CLI', provider, authentication, model: c.model }, usage: { role: input.role, inputTokens: tokens(usage.inputTokens), outputTokens: tokens(usage.outputTokens), costUsd: null, source: 'PROVIDER', requestId: turnId },
                observation:{model:c.model,provider:this.modelProvider,...(this.auth==='chatgpt'?{accountFingerprint:hash(object(account.account))}:{}),includedUsageAllowed:this.auth==='chatgpt',paidFallback:false,threadId,turnId,permissionProfile:c.permissionProfile,policyHash} };
        }
        catch(error){
            const cause=failure??error;
            if(requestRouteEvidence&&observationStartedAt&&!routeRecorded){
                routeRecorded=true;
                const evidence=await requestRouteEvidence;
                if(evidence)onEvent({method:'dm/codexRequestPath',params:finalizeCodexRequestPath({
                    role:input.role,startedAt:observationStartedAt,completedAt:new Date().toISOString(),
                    evidence,classification:classifyCodexTurnError(cause),requestId:turnId||null,
                    httpStatus:cause instanceof RpcChildError?cause.evidence.httpStatus:null
                })});
            }
            const classification=classifyCodexTurnError(cause);
            if(classification==='REGION_OR_POLICY_RESTRICTED')throw new DomainError('REGION_OR_POLICY_RESTRICTED',409);
            if(classification==='HTTP_403_PERMISSION_DENIED')throw new DomainError('HTTP_403_PERMISSION_DENIED',403);
            throw cause;
        }
        finally {
            if(includedTurn)includedTurns.delete(includedTurn);
            clearTimeout(timer);
            input.signal.removeEventListener('abort', abort);
            await close();
        }
    }
}
