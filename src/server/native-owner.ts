import {existsSync,readFileSync,statSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,relative,sep,isAbsolute,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from './store.js';
import {cleanupUncertain} from './cleanup-uncertainty.js';
import {roleSkillBlock} from './skill-injection.js';
import type {NativeExecutionFactory} from './engine.js';
import {inspectInterruptedCodexReview} from './providers/codex-history.js';
import type {InterruptedReviewInput,InterruptedReviewObservation} from './review-interruption.js';
import type {AgentInput,Config,Role,Runner} from '../shared/types.js';
import {DomainError,hash,within,registerCredentialEnv,hasSecret,childEnv,withExplicitSecretInspection,isCustomProbeNonce,loopbackGatewayChatRequest} from './security.js';
import {NativeBudget,assertCustomModelPrices,assertNativePriceForRoute,type BudgetAuthority,type NativePrice,type NativePriceRef} from './native-budget.js';
import {customFlowRequestBudget,customDispatchConfiguration} from './flow/custom-budget.js';
import {customProbeBudgetSupplement,assertCustomBudgetSupplementHistory} from './flow/custom-budget-supplement.js';
import {customRoleRequestContext} from './flow/custom-role-context.js';
import {CUSTOM_CLI_RUNNERS,customRoleConfiguration,CUSTOM_TEXT_CLI_RUNNERS,isCustomTextCliRuntime,type CustomTextCliRuntime} from './flow/custom-role-identity.js';
import {resolveCustomMagpieRoute} from './flow/custom-magpie-catalog.js';
import {runCustomProbeRuntime} from './flow/custom-probe-runtime.js';
import {runCustomCodexProbe} from './flow/custom-codex-probe.js';
import {runCustomIndependentProbe} from './flow/custom-independent-probe.js';
import {openDshRoleTools,customProductTools,readOnlyDeskTools} from './flow/dsh-role-tools.js';
import {MagpieDshRequestTransport} from './magpie-model-transport.js';
import {PiNativeSession} from './flow/pi-native-session.js';
import {PI_READ_ONLY_TOOLS} from './flow/pi-native-wire.js';
import {PiRunner} from './providers/pi.js';
import {prepareCodexMagpieHome} from './providers/codex-magpie-home.js';
import {exactPreUpstreamGatewayRejection} from './magpie-usage-evidence.js';
import {magpieRouteHash,supportsClaudeReadOnlyBuild,supportsCodexSupervisorBuild,supportsOfficialCliResponsesBuild} from './magpie-route.js';
import type {CustomRoleProbeInput,CustomRoleProbePreparation,CustomRoleProbeStage} from './flow/custom-role-probe.js';
import type {CustomFlowConfigSnapshot} from '../shared/flow-configuration.js';
import {CustomFlowPreparations} from './custom-flow-preparation.js';
import {preparedMemberScope,recommendPreparedMember} from './flow/custom-member-recommendation.js';
import {canReviseAfterFlow} from './flow/conclusion.js';
import {observeCustomAccountSources,resolveCustomAccountSources,publicAccountIdentities,customAccountReferences} from './custom-account-sources.js';
import {createMagpieAccountCustody,revokeMagpieAccountCustody,magpieAccountCustodyPending,type MagpieAccountCustody} from './magpie-account-custody.js';
import type {InspectCustomAccountSources} from '../shared/custom-account-sources.js';
import type {MagpieAccountControlObservation} from '../shared/magpie-account-check.js';
import {accountCheckBinding,accountCheckRecoveryTarget} from './magpie-account-check-state.js';
import {createAccountProbeAuthority,type AccountProbeAuthority} from './account-verification.js';
import {RegisteredAccountSources,dshAccountSourceDefinition,accountSourceInput} from './registered-account-sources.js';
import {DeepSeekGateway} from './deepseek-gateway.js';
import {openOwnedMagpieControl,REVIEWED_MAGPIE_BUILD_SHA256,REVIEWED_CUSTOM_MAGPIE_BUILD_SHA256,REVIEWED_EXECUTOR_CLI_BUILD_SHA256,type MagpieExecutableRef,type MagpieSubscriptionScope,type OwnedMagpieControl} from './magpie-owned.js';
import type {MagpieCustodyBinding} from './magpie-account-custody.js';
import {nativePlannerGuard,type PaidRequestGuard} from './providers/model.js';
import {DshRunner,nativeReadiness,dshRuntimeReadiness} from './providers/dsh.js';
import {createExecutorTools,type FileBinding} from './executor-tools.js';
import {boundExecutorAssignment,executorRoleForTurn} from './flow/executor-slices.js';
import {startToolBroker} from './tool-broker.js';
import {WslSandbox,type SandboxCommand,type SandboxResult,type SqliteSandboxExchange} from './wsl-sandbox.js';
import type {NativeSqliteDataInput} from './flow/sqlite-runtime.js';
import {prepareSqliteRuntimeCommand} from './data-runtime-plan.js';
import {SqliteDatasets} from './sqlite-data.js';
import {executionWorkspace} from './workspace-location.js';
import {reviewedSqliteRuntime} from './sqlite-runtime-review.js';
import {retireSqliteGuest,type SqliteRetirementInput,type SqliteRetirementReceipt} from './sqlite-retirement-process.js';
import {WslVerifier,validateVerifierPlan} from './wsl-verifier.js';
import {OPERATOR_REQUEST_CEILING} from './operator-ceiling.js';
import {NativeProbes,type ProbeBinding,type ProbeObservation,type CustomProbeBinding,type CustomProbeActor} from './native-probes.js';
import {assertCustomDirectRoles} from './flow/custom-role-identity.js';
import {openCustomKimiRunner,runCustomKimiProbe} from './flow/custom-kimi-probe.js';
import {customEngineeringFingerprint} from './flow-configuration.js';
import type {Planner1Probe} from './kimi-planner1-probe.js';
import {openProbeKey,openWslProbeKey} from './native-probe-custody.js';
import {probeCustodySourceBinding,selectProbeCustody} from './probe-custody-scope.js';
import {ModelProvider} from './providers/model.js';
import {planner1Binding, assertPlanner1DispatchAllowed, SEEKER_PLANNER1_BINDING_VERSION} from './planner1-binding.js';
import {probeRoles,type ProbeProfile} from './flow/probe-profile.js';
import type {Product} from '../shared/product.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {ProbeBudgetPermit,EngineeringBudgetPermit} from './native-budget.js';
import type {UserBudgetLimits} from '../shared/onboarding.js';
import {CodexRunner,type CodexIncludedTurn} from './providers/codex.js';
import {IndependentRunner} from './providers/independent.js';
import type {CodexRequestRouteObserver} from './codex-network-path.js';
import {treeHash} from './workspace.js';
import {rolePolicyBinding} from './role-policy.js';
import {magpieBlocksNative} from './magpie-check.js';
import {dshTemplateBindingFiles} from './dsh-template-bindings.js';
import {currentProcessOwnership,type ProcessOwnershipScope} from './flow/process-ownership.js';
import {executorModelRequestBinding,customModelRequestBinding} from './flow/native-request-context.js';
import {dshEngineeringContract,dshEngineeringContractHash,createDshEngineeringTools,dshEngineeringArtifacts,verifyDshEngineering as runEngineeringVerifier,type DshEngineeringInput,type DshEngineeringPreparation,type DshEngineeringStage} from './flow/dsh-engineering.js';

interface Ref {path:string;sha256:string}
interface Operator {
    schema:'dream-maker.native-owner.v1';scopeRoot:string;authority:Ref;template:Ref;
    prices:{executor:Ref;planner1?:Ref;independent?:Ref;planner2?:Ref;reviewer?:Ref};files:FileBinding;sdkToolsModule:string;
    profileBinding:{sdkCommit:string;basePatch:string;sdkPatch:string;yamlModule:string;dependencies:Ref[]};
    oracleRoot:string;oracles:Record<string,{relativePath:string;sha256:string}>;
    maxOutputTokens:number;maxRequests:number;
    probeExpiresAt?:string;
    probeCustody?:{type:'DEDICATED_WSL';distribution:string};
    magpieCandidate?:MagpieExecutableRef;
    customAccountSources?:Ref;
    claudeSupervisor?:Ref;
    /** Pinned CLI commands: the text CLIs, and the `codex exec` binding its executor leg needs. */
    customTextCli?:Partial<Record<CustomTextCliRuntime|'codex',Ref>>;
    customModelPrices?:Record<string,NativePriceRef>;
    codexSubscriptionAccount?:Ref;
}
export interface NativeOwnerContext {root:string;store:Store;getConfig:()=>Config;getSecret?:(name:string)=>string|undefined;fetch?:typeof fetch;
    /** Trusted product wiring that assigns the existing CFW transport to one agent role. */
    fetchForRole?:(role:'planner1'|'planner2'|'executor'|'reviewer')=>typeof fetch;
    childEnvironment?:(extra:NodeJS.ProcessEnv)=>NodeJS.ProcessEnv;
    /** Reuse an active Engine lease or create one owned lease for a local
     * controller process. The callback lifetime includes process cleanup. */
    withNetworkRun?:<T>(runId:string,signal:AbortSignal,action:()=>Promise<T>)=>Promise<T>;
    /** Optional request-level observation for the exact DM-owned Windows Codex child. */
    observeCodexRequestRoute?:CodexRequestRouteObserver;
    /** HTTP startup must bind its actual app data directory before any ledger is opened. */
    applicationDataRoot?:string;
    product?:Product;
    /** Controller-owned pinned candidate only; never accepted from browser settings/proof flags. */
    magpieCandidate?:MagpieExecutableRef;
    /** K02: the real subscription planner1 probe. Supplied by the process that owns the Kimi runner;
     *  absent means a subscription planner1 can never be certified, which is a refusal, not a pass. */
    planner1Probe?:Planner1Probe;
    /** The independent provider runner used to prove planner2/reviewer when that section is enabled. */
    independentRunner?:Runner}

// One owner, one fixed ledger. Missing local bindings never create a permissive runtime.
export class NativeOwner implements NativeExecutionFactory {
    private operatorPath:string;private operatorHash='';private operator?:Operator;
    private budget?:NativeBudget;private failure='NATIVE_OPERATOR_CONFIG_REQUIRED';
    private finalBudgetStatus?:ReturnType<NativeOwner['liveBudgetStatus']>;private finalBudgetAt?:string;
    private closed=false;private stopping=false;private closing?:Promise<void>;private stoppingProbes?:Promise<void>;private cleanupUncertain=false;private active=new Map<AbortController,Promise<unknown>>();
    private plannerTickets=new Set<AbortController>();
    private accountCustodies=new Set<MagpieAccountCustody>();
    private probes?:NativeProbes;private preparing?:Promise<void>;private probeAuthority?:AccountProbeAuthority;
    private customProofs?:NativeProbes;private customPreparing?:Promise<void>;private stoppingCustomProofs?:Promise<void>;
    private readonly customProbeStages=new WeakMap<CustomRoleProbeStage,{inputHash:string;signal:AbortSignal}>();
    private probePermits=new AsyncLocalStorage<ProbeBudgetPermit>();
    private profile():ProbeProfile{return this.context.product==='dreamflow'?'ENGINEERING_ONLY':'FULL_DM';}
    constructor(private context:NativeOwnerContext){
        this.operatorPath=within(context.root,'config/native-owner.local.json');
        registerCredentialEnv(context.getConfig().dsh.keyEnv);
        registerCredentialEnv(context.getConfig().planner1.keyEnv);
        if(!existsSync(this.operatorPath))return;
        try{
            const bytes=readFileSync(this.operatorPath);this.operatorHash=hash(bytes);
            const op=JSON.parse(bytes.toString('utf8')) as Operator;
            if(bytes.length>128000||hasSecret(bytes.toString('utf8'))||op.schema!=='dream-maker.native-owner.v1'||resolve(op.scopeRoot)!==resolve(context.root)||
                // The request ceiling is an operational guard on how many provider calls one binding may spend; the
            // MONEY ceiling lives in the authority and in the per-request prices. 30 was too tight to finish a
            // real four-role run (probes alone are 4, and an executor turn spends one request per tool step).
            !Number.isInteger(op.maxRequests)||op.maxRequests<1||op.maxRequests>OPERATOR_REQUEST_CEILING||!Number.isInteger(op.maxOutputTokens)||op.maxOutputTokens<128||op.maxOutputTokens>16000)
                throw new DomainError('NATIVE_OPERATOR_CONFIG_INVALID',409);
            assertCustomModelPrices(op.customModelPrices,context.root);
            if(context.applicationDataRoot!==undefined){
                const pathKey=(value:string)=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
                // Legacy operator bindings own exactly this ledger. A different app data
                // copy must not acquire it, nor silently create a new empty spend history.
                if(pathKey(context.applicationDataRoot)!==pathKey(resolve(context.root,'.runtime'))||pathKey(context.store.path)!==pathKey(resolve(context.applicationDataRoot,'dream-maker.sqlite')))throw new DomainError('NATIVE_DATA_ROOT_MISMATCH',409);
            }
            this.operator=op;
            const authority=this.readRef(op.authority) as BudgetAuthority;
            const ledger=within(context.root,'.runtime/controller/native-budget.sqlite');
            this.budget=new NativeBudget(ledger,authority,(role,receipt)=>this.probes?.verify(role,receipt)??false,summary=>{if(summary.warning)context.store.event(null,null,'budget.warning',{currency:'CNY',...summary});},this.profile(),binding=>customFlowRequestBudget(context.store,context.getConfig(),binding),binding=>{
                const {snapshot}=customDispatchConfiguration(context.store,context.getConfig(),binding);this.assertCustomReady(snapshot);this.requireUserBudget(snapshot.projectId,context.store.project(snapshot.projectId).specId??undefined);
            },(binding,limits,rows)=>assertCustomBudgetSupplementHistory(context.store,binding,limits,rows));this.failure='';
        }catch(error){this.failure=error instanceof DomainError?error.code:'NATIVE_OPERATOR_CONFIG_INVALID';}
    }
    private readRef(ref:Ref):unknown {
        if(!ref||typeof ref.path!=='string'||typeof ref.sha256!=='string')throw new DomainError('NATIVE_BINDING_REQUIRED',409);
        if(!isAbsolute(ref.path))throw new DomainError('NATIVE_BINDING_PATH_DENIED',409);
        const path=within(this.context.root,relative(this.context.root,ref.path).split(sep).join('/'));
        const bytes=readFileSync(path);if(bytes.length>2000000||hash(bytes)!==ref.sha256)throw new DomainError('NATIVE_BINDING_CHANGED',409);
        return JSON.parse(bytes.toString('utf8'));
    }
    private configured(){
        if(this.closed)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        if(this.stopping)throw new DomainError('NATIVE_OWNER_STOPPING',409);
        if(this.failure||!this.operator||!this.budget)throw new DomainError(this.failure||'NATIVE_OPERATOR_CONFIG_REQUIRED',409);
        if(hash(readFileSync(this.operatorPath))!==this.operatorHash)throw new DomainError('NATIVE_OPERATOR_CONFIG_CHANGED',409);
        this.readRef(this.operator.authority);return{op:this.operator,budget:this.budget};
    }
    /** The exact provider/model quote takes precedence for every paid Custom role.
     * Legacy configurations retain their role and executor fallbacks. */
    private customPriceRef(role:'planner2'|'executor'|'reviewer',provider:string,model:string):Ref {
        const {op}=this.configured();
        const key=provider+'/'+model;
        if(op.customModelPrices&&Object.hasOwn(op.customModelPrices,key))return op.customModelPrices[key];
        return role==='planner2'?op.prices.planner2??op.prices.executor:role==='reviewer'?op.prices.reviewer??op.prices.executor:op.prices.executor;
    }
    private quote(role:'executor'|'planner1'|'independent',requestedOutput?:number,permit?:ProbeBudgetPermit,engineering?:EngineeringBudgetPermit):NativePrice {
        const {op,budget}=this.configured(),ref=op.prices[role],c=this.context.getConfig();
        if(!ref)throw new DomainError('NATIVE_PRICE_UNKNOWN',409);
        const q=this.readRef(ref) as NativePrice;
        // Each provider's official price is denominated in its own currency: DeepSeek bills CNY, the
        // independent provider bills USD. A price artifact that disagrees with its own route is refused
        // instead of being coerced into the wrong currency.
        // The independent provider's own endpoint decides its price identity: api.deepseek.com bills CNY at
        // deepseek-official rates, api.openai.com bills USD at openai-official rates. Hard-coding openai made
        // a same-vendor fallback (owner-authorized on 2026-10-28 when no funded OpenAI key existed) impossible
        // and would have mispriced the ledger.
        const p1Api=role==='planner1'&&c.planner1.bindingVersion===2,p1Provider=p1Api&&planner1Binding(c).provider==='deepseek'?'deepseek-official':'openai-official';
        const indieHost=(()=>{try{return new URL(String(c.independent?.baseUrl??'')).hostname}catch{return ''}})(),
            indieProvider=indieHost==='api.deepseek.com'?'deepseek-official':'openai-official',
            currency=p1Api?(p1Provider==='deepseek-official'?'CNY':'USD'):role==='independent'?(indieProvider==='deepseek-official'?'CNY':'USD'):'CNY',
            provider=p1Api?p1Provider:role==='executor'?'deepseek-official':indieProvider,
            model=role==='independent'?String(c.independent?.model??''):(role==='executor'?'deepseek-flash':c.planner1.model);
        assertNativePriceForRoute(q,{provider,model,currency});
        const ceiling=requestedOutput??(role==='executor'?op.maxOutputTokens:this.context.getConfig().planner1.maxOutputTokens);
        if(engineering)budget.engineeringPreflight(engineering,q,ceiling);else budget.preflight(q,ceiling,permit);
        if(budget.requests().length>=op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);
        return q;
    }
    assertReady(role:Role|'build',scope?:{projectId:string;specHash:string},minimumProbe=false,engineering?:EngineeringBudgetPermit):void {
        this.assertNativeCleanup();
        if(engineering&&(role!=='executor'||scope!==undefined||minimumProbe))throw new DomainError('ENGINEERING_BUDGET_SCOPE_INVALID',409);
        if(role!=='build'&&!probeRoles(this.profile()).includes(role))throw new DomainError('NATIVE_ROLE_NOT_IN_PRODUCT',409);
        const {op,budget}=this.configured(),c=this.context.getConfig();
        if(scope)this.requireUserBudget(scope.projectId,this.context.store.project(scope.projectId).specId??undefined);
        const readiness=nativeReadiness(c);if(!readiness.ok)throw new DomainError('NATIVE_INTEGRATION_BLOCKED',409);
        const audit=JSON.parse(readFileSync(c.nativeAuditPath,'utf8'));
        for(const ref of [op.authority,op.template,...Object.values(op.prices)]){
            this.readRef(ref);
            if(!audit.evidenceFiles.some((f:Ref)=>f.path===ref.path&&f.sha256===ref.sha256))throw new DomainError('NATIVE_OPERATOR_BINDING_NOT_AUDITED',409);
        }
        if(!audit.evidenceFiles.some((f:Ref)=>f.path===this.operatorPath&&f.sha256===this.operatorHash))throw new DomainError('NATIVE_OPERATOR_BINDING_NOT_AUDITED',409);
        const template=this.readRef(op.template) as Record<string,unknown>;
        if(template.profile!=='sdk'||template.reasoningEffort!=='off'||template.maxTokens!==op.maxOutputTokens||!Array.isArray(template.patches)||template.patches.length)
            throw new DomainError('NATIVE_TEMPLATE_LIMITS_INVALID',409);
        if(!op.files||!Array.isArray(op.files.dependencies)||!op.profileBinding||!Array.isArray(op.profileBinding.dependencies)||!Array.isArray(template.dependencyFiles))throw new DomainError('NATIVE_BINDING_REQUIRED',409);
        const refs=[...op.files.dependencies,...op.profileBinding.dependencies];
        for(const path of [op.sdkToolsModule,...dshTemplateBindingFiles(template)]){
            if(typeof path!=='string')throw new DomainError('NATIVE_BINDING_REQUIRED',409);
            const expected=audit.evidenceFiles.find((f:Ref)=>f.path===path);if(!expected)throw new DomainError('NATIVE_OPERATOR_BINDING_NOT_AUDITED',409);refs.push(expected);
        }
        for(const ref of refs)if(!audit.evidenceFiles.some((f:Ref)=>f.path===ref.path&&f.sha256===ref.sha256)||hash(readFileSync(ref.path))!==ref.sha256)throw new DomainError('NATIVE_BINDING_CHANGED',409);
        if(c.dsh.model!=='deepseek-flash'||c.limits.maxRepairs>2)throw new DomainError('NATIVE_SCOPE_LIMITS_EXCEEDED',409);
        if(role==='executor'||role==='build'){
            this.quote('executor',undefined,role==='executor'&&minimumProbe?this.probePermits.getStore():undefined,engineering);
            if(!minimumProbe&&!engineering&&budget.summary().phase!=='REPRESENTATIVE')throw new DomainError('NATIVE_REAL_PROBES_REQUIRED',409);
            if(!(this.context.getSecret?.(c.dsh.keyEnv)??process.env[c.dsh.keyEnv]))throw new DomainError('DSH_KEY_MISSING',409);
        }
        if(scope){
            const plan=this.verifierPlan(scope.projectId,scope.specHash);
            const receipts=this.context.store.records(scope.projectId,'VerifierApproval');
            if(!this.context.store.approved(scope.projectId,scope.specHash,'VERIFIER')||!receipts.some(r=>r.data.specHash===scope.specHash&&r.data.planHash===plan.sha256))throw new DomainError('TRUSTED_VERIFIER_APPROVAL_REQUIRED',409);
        }
    }
    readonly paidGuard:PaidRequestGuard=route=>{
        if(this.profile()==='ENGINEERING_ONLY')throw new DomainError('NATIVE_ROLE_NOT_IN_PRODUCT',409);
        const {budget}=this.configured(),permit=this.probePermits.getStore();const guard=nativePlannerGuard(budget,()=>this.quote('planner1',route.maxOutputTokens,permit),permit);
        const ticket=guard(route),controller=new AbortController();this.plannerTickets.add(controller);
        return{ledgerRequestId:ticket.ledgerRequestId,signal:controller.signal,settle:(usage,outcome)=>{
            try{if(!this.closed){ticket.settle(usage,outcome);this.warning();}}finally{this.plannerTickets.delete(controller);}
        }};
    };
    private warning(){
        const summary=this.budget?.summary();if(summary?.warning)this.context.store.event(null,null,'budget.warning',{currency:'CNY',...summary});
    }
    private assertNativeCleanup(allowCurrentLocalCheck=false){
        if(this.cleanupUncertain||magpieBlocksNative(this.context.store,allowCurrentLocalCheck))throw new DomainError('NATIVE_OWNER_CLEANUP_UNCERTAIN',409);
    }
    /** The one derivation every account view shares: original receipts plus settled ledger rows. */
    accountProbeAuthority():AccountProbeAuthority{
        return this.probeAuthority??=createAccountProbeAuthority(this.context.store,()=>this.budget?this.budget.requests():[]);
    }
    /** Every metered account source the frozen flow uses must own probe evidence; unknown is false. */
    private verifiedAccounts(input:InspectCustomAccountSources):boolean{
        try{
            const prepared=new CustomFlowPreparations(this.context.store,this.context.getConfig).historical(input.projectId,input.preparation);
            const {used}=customAccountReferences(prepared.flowConfig);
            return this.accountProbeAuthority().verifiedEveryMetered(prepared.flowConfig.accounts.filter(account=>used.has(account.authRef)));
        }catch{return false;}
    }
    accountVerification(input:InspectCustomAccountSources):boolean{return this.verifiedAccounts(input);}
    accountVerifiedForProject(projectId:string):boolean{
        try{const target=accountCheckRecoveryTarget(this.context.store,projectId);return target?this.verifiedAccounts(target.intent.selection):false;}catch{return false;}
    }
    /** Source metadata setup works before a model operator is installed; it grants no execution. */
    registeredAccountSources(){return withExplicitSecretInspection([],()=>{
        if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        return new RegisteredAccountSources(this.context.store,this.accountProbeAuthority()).list(dshAccountSourceDefinition(this.context.getConfig().dsh));
    });}
    selectableAccountIdentities(){return withExplicitSecretInspection([],()=>{
        const registered=this.registeredAccountSources();
        if(this.failure&&existsSync(this.operatorPath))throw new DomainError(this.failure,409);
        const manifest=this.operator?this.customAccountManifest(this.configured().op):undefined;
        return {sources:publicAccountIdentities(manifest,this.context.getConfig().dsh.keyEnv,registered.sources)};
    });}
    registerAccountSource(raw:unknown,actor:string,operationHash:string){return withExplicitSecretInspection([],()=>{
        if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);this.assertNativeCleanup();
        if(this.preparing||this.active.size||this.plannerTickets.size||this.budget?.summary().inFlight)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
        if(!/^local-session:[a-f0-9]{64}$/.test(actor)||!/^[a-f0-9]{64}$/.test(operationHash))throw new DomainError('CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID',409);
        const input=accountSourceInput(raw),definition=dshAccountSourceDefinition(this.context.getConfig().dsh);registerCredentialEnv(definition.secretEnv);
        let value:string|undefined;try{value=this.context.getSecret?this.context.getSecret(definition.secretEnv):process.env[definition.secretEnv];}catch{value=undefined;}
        try{
            if(dshAccountSourceDefinition(this.context.getConfig().dsh).configurationHash!==definition.configurationHash)throw new DomainError('CUSTOM_ACCOUNT_SOURCE_STALE',409);
            return withExplicitSecretInspection(value===undefined?[]:[value],()=>new RegisteredAccountSources(this.context.store,this.accountProbeAuthority()).register(input,definition,actor,operationHash));
        }finally{value=undefined;}
    });}
    /** Shared metadata resolution. Never reads a credential or discovers an account. */
    private customAccountSelection(input:InspectCustomAccountSources,allowCurrentLocalCheck=false){
        const {budget}=this.configured();this.assertNativeCleanup(allowCurrentLocalCheck);
        if(!input||!input.preparation||Object.keys(input).length!==4||Object.keys(input).some(k=>!['projectId','specHash','profileHash','preparation'].includes(k)))throw new DomainError('CUSTOM_ACCOUNT_SELECTION_REQUIRED',409);
        const preparations=new CustomFlowPreparations(this.context.store,this.context.getConfig),prepared=preparations.prepare(input.projectId,input.specHash,input.profileHash,input.preparation);
        return{budget,preparations,prepared,...this.customAccountCatalog(prepared.flowConfig,prepared.flowConfigHash)};
    }
    private customAccountManifest(operator:Operator){
        const ref=operator.customAccountSources;
        if(ref!==undefined&&(!ref||typeof ref!=='object'||Array.isArray(ref)||Reflect.ownKeys(ref).length!==2||typeof ref.path!=='string'||typeof ref.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256)))throw new DomainError('CUSTOM_ACCOUNT_SOURCES_INVALID',409);
        return ref?this.readRef(ref):undefined;
    }
    /** Same private source rules for preparation and an already frozen running Flow. */
    private customAccountCatalog(snapshot:CustomFlowConfigSnapshot,flowConfigHash:string,dispatchIdentityHash?:string){
        const ref=this.operator!.customAccountSources,manifest=this.customAccountManifest(this.operator!);
        const definition=dshAccountSourceDefinition(this.context.getConfig().dsh),registered=new RegisteredAccountSources(this.context.store,this.accountProbeAuthority()).forProfile(snapshot,definition),catalog=resolveCustomAccountSources(snapshot,manifest,definition.secretEnv,registered);
        const binding={flowConfigHash,sourceBindingHash:hash({schema:'dream-maker.magpie-source-binding.v1',operatorHash:this.operatorHash,manifestHash:ref?.sha256??null,registeredHash:registered.contentHash,definitionHash:definition.configurationHash,catalog,...(dispatchIdentityHash?{dispatchIdentityHash}:{})})};
        return{manifest,manifestHash:ref?.sha256??null,definition,registered,catalog,binding};
    }
    /** No browser verification flag, Classic proof, model listing or local custody
     * observation can replace this independently signed Custom evidence domain. */
    assertCustomReady(snapshot:CustomFlowConfigSnapshot):void {
        this.configured();this.assertNativeCleanup();assertCustomDirectRoles(snapshot);
        if(!this.customProofs)throw new DomainError('CUSTOM_ROLE_QUALIFICATION_REQUIRED',409);
        this.customProofs.assertCustomReady(this.customProbeBinding(snapshot));
    }
    private customProbeCredentialHash(roles:CustomProbeActor[],catalog:ReturnType<typeof resolveCustomAccountSources>):string {
        const selected=new Set<typeof catalog[number]>();
        for(const actor of roles){
            if(actor.transport!=='magpie'||actor.authentication!=='API_KEY')continue;
            const source=catalog.find(entry=>entry.authRef===actor.authRef);
            if(!source||source.accountRef!==actor.accountRef||source.provider!==actor.provider||source.authentication!=='api_key')
                throw new DomainError('CUSTOM_ACCOUNT_SOURCE_MISMATCH',409);
            selected.add(source);
        }
        // Finish matching all frozen actors before the first credential lookup. Preserve catalog order for existing proofs.
        return hash(catalog.filter(source=>selected.has(source)).map(source=>{
            const value=this.context.getSecret?this.context.getSecret(source.secretEnv):process.env[source.secretEnv];
            if(typeof value!=='string'||!/^[\x21-\x7e]{8,512}$/.test(value))throw new DomainError('MAGPIE_ACCOUNT_SECRET_INVALID',409);
            return{authRef:source.authRef,accountRef:source.accountRef,generationHash:hash(value)};
        }));
    }
    private customProbeBinding(snapshot:CustomFlowConfigSnapshot):CustomProbeBinding {
        const {op}=this.configured(),config=this.context.getConfig();assertCustomDirectRoles(snapshot);
        if(typeof op.probeExpiresAt!=='string'||!Number.isFinite(Date.parse(op.probeExpiresAt))||Date.parse(op.probeExpiresAt)<=Date.now())throw new DomainError('CUSTOM_PROBE_EXPIRY_REQUIRED',409);
        if(snapshot.configurationFingerprint!==customEngineeringFingerprint(config,snapshot.profile.contentHash))throw new DomainError('RUN_CONFIG_CHANGED',409);
        if(!dshRuntimeReadiness(config).ok)throw new DomainError('CUSTOM_RUNTIME_AUDIT_REQUIRED',409);
        const candidate=this.reviewedMagpieCandidate();if(hash(readFileSync(candidate.path))!==candidate.sha256)throw new DomainError('MAGPIE_EXECUTABLE_CHANGED',409);
        const selection=this.customAccountCatalog(snapshot,hash(snapshot));
        const roles:CustomProbeActor[]=[{role:'planner2' as const,selected:snapshot.roles.planner2},...snapshot.roles.executors.map(selected=>({role:'executor' as const,selected})),{role:'reviewer' as const,selected:snapshot.roles.reviewer}].map(({role,selected})=>{
            const actor=customRoleConfiguration(snapshot,role,role==='executor'?selected.id:undefined);
            return{role,roleId:actor.id,runtime:actor.runtime,provider:actor.provider,
                // OAuth legs state their real subscription shape; a Kimi reviewer must not
                // borrow the ChatGPT label, and no OAuth leg carries a DM-held secret.
                authentication:actor.authentication!=='oauth'?'API_KEY' as const:actor.provider==='kimi'?'MEMBER_SUBSCRIPTION' as const:'CHATGPT_SUBSCRIPTION' as const,
                transport:actor.transport,model:actor.model.id,authRef:actor.authRef,accountRef:actor.accountRef};
        });
        const audit=JSON.parse(readFileSync(config.nativeAuditPath,'utf8')),template=this.readRef(op.template) as Record<string,unknown>;
        if(template.profile!=='sdk'||template.reasoningEffort!=='off'||template.maxTokens!==op.maxOutputTokens||!Array.isArray(template.patches)||template.patches.length)throw new DomainError('NATIVE_TEMPLATE_LIMITS_INVALID',409);
        if(roles.some(role=>role.runtime==='claude')){
            const ref=op.claudeSupervisor;
            if(!ref||!audit.evidenceFiles.some((entry:Ref)=>entry.path===ref.path&&entry.sha256===ref.sha256))
                throw new DomainError('CUSTOM_CLAUDE_COMMAND_UNVERIFIED',409);
        }
        const refs=[op.authority,op.template,op.prices.executor,...op.files.dependencies,...op.profileBinding.dependencies,{path:this.operatorPath,sha256:this.operatorHash}];
        for(const {role,runtime,provider,model,authentication,transport} of roles){
            if(transport==='magpie'&&authentication==='API_KEY'){
                const ref=this.customPriceRef(role,provider,model);
                assertNativePriceForRoute(this.readRef(ref) as NativePrice,{provider,model,currency:isCustomTextCliRuntime(runtime)?snapshot.budget.currency:'CNY'});
                refs.push(ref);
            }
            if(!isCustomTextCliRuntime(runtime))continue;
            const ref=op.customTextCli?.[runtime];
            if(!ref)throw new DomainError('CUSTOM_CLI_COMMAND_UNVERIFIED',409);
            refs.push(ref);
        }
        for(const path of [op.sdkToolsModule,...dshTemplateBindingFiles(template)]){
            const ref=audit.evidenceFiles.find((r:Ref)=>r.path===path);if(!ref)throw new DomainError('NATIVE_OPERATOR_BINDING_NOT_AUDITED',409);refs.push(ref);
        }
        for(const ref of refs)if(!audit.evidenceFiles.some((r:Ref)=>r.path===ref.path&&r.sha256===ref.sha256)||hash(readFileSync(ref.path))!==ref.sha256)throw new DomainError('NATIVE_BINDING_CHANGED',409);
        const credentialHash=this.customProbeCredentialHash(roles,selection.catalog);
        return{schema:'dream-maker.custom-probe-binding.v1',flowConfigHash:hash(snapshot),sourceBindingHash:selection.binding.sourceBindingHash,credentialHash,
            runtimeHash:hash({server:treeHash(within(this.context.root,'dist/server')),adapters:treeHash(within(this.context.root,'adapters')),prompts:treeHash(within(this.context.root,'prompts')),host:hash(readFileSync(within(this.context.root,'scripts/dsh-host.mjs'))),worker:hash(readFileSync(within(this.context.root,'scripts/isolation/wsl-worker.py'))),resourceHelper:hash(readFileSync(within(this.context.root,'scripts/isolation/wsl-resource-context.py'))),candidate,template,price:this.readRef(op.prices.executor),audit:hash(readFileSync(config.nativeAuditPath)),refs}),
            authorizationHash:hash(this.readRef(op.authority)),expiresAt:op.probeExpiresAt??'',roles};
    }
    /** Opens only the original controller signing-key custody. This cannot issue a
     * Custom model receipt, advance Classic probes, grant a budget or start an Agent. */
    async prepareCustomProbeEvidence():Promise<void> {
        this.configured();if(this.customProofs)return;
        if(!this.customPreparing)this.customPreparing=(async()=>{
            const {op,budget}=this.configured(),hasReceipts=budget.summary().phase==='REPRESENTATIVE'||!!this.context.store.db.prepare("SELECT 1 FROM records WHERE kind IN ('NativeProbeReceipt','NativeCustomProbeReceipt') LIMIT 1").get();
            // An explicit operator custody selection is independent from the Codex runtime.
            const custody=selectProbeCustody(op.probeCustody,{transport:'stdio'}),key=custody.transport==='wsl'?await openWslProbeKey(this.context.root,hasReceipts,custody.distribution):await openProbeKey(this.context.root,hasReceipts);
            try{
                if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
                this.customProofs=new NativeProbes({store:this.context.store,key,current:()=>{throw new DomainError('CUSTOM_PROBE_CLASSIC_DOMAIN_DENIED',409);},ledger:()=>this.configured().budget.requests(),invoke:async()=>{throw new DomainError('CUSTOM_PROBE_ISSUER_NOT_CONNECTED',409);}});
            }finally{key.fill(0);}
        })().finally(()=>{this.customPreparing=undefined;});
        await this.customPreparing;
    }
    /** Current controller binding only. Selection is not a Build or model qualification. */
    customProbePreparation(selection:InspectCustomAccountSources,roleId:string):CustomRoleProbePreparation {
        const {prepared}=this.customAccountSelection(selection),binding=this.customProbeBinding(prepared.flowConfig),actor=binding.roles.find(r=>r.roleId===roleId);
        if(!actor||!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(roleId))throw new DomainError('CUSTOM_ROLE_ID_UNSUPPORTED',409);
        // Custom runs are frozen to Laya off. One instance can still serve Classic with the
        // product-wide switch at advisory, so the per-run snapshot is the authority here; the
        // global switch cannot be used to smuggle Laya into a Custom role.
        const laya=prepared.flowConfig.laya;
        if(!laya||laya.enabled!==false||laya.mode!=='off')throw new DomainError('CUSTOM_LAYA_FORBIDDEN',409);
        // Reject a stale or foreign role quote before queueing a billable qualification.
        // The gateway still checks the current quote when reserving the actual request.
        if(actor.transport==='magpie'&&actor.authentication==='API_KEY'){
            const price=this.readRef(this.customPriceRef(actor.role,actor.provider,actor.model)) as NativePrice;
            assertNativePriceForRoute(price,{provider:actor.provider,model:actor.model,currency:isCustomTextCliRuntime(actor.runtime)?prepared.flowConfig.budget.currency:'CNY'});
        }
        return{role:actor.role,roleId:actor.roleId,bindingHash:hash(binding),configurationHash:prepared.flowConfigHash,expiresAt:binding.expiresAt};
    }
    private customProbeInputHash(input:CustomRoleProbeInput){return hash({selection:input.selection,preparation:input.preparation,probeId:input.probeId,nonce:input.nonce});}
    private assertCustomProbeCurrent(input:CustomRoleProbeInput,expected?:ProcessOwnershipScope){
        if(input.signal.aborted||this.closed||this.stopping||hash(this.customProbePreparation(input.selection,input.preparation.roleId))!==hash(input.preparation))throw new DomainError('CUSTOM_PROBE_BINDING_CHANGED',409);
        const scope=currentProcessOwnership();
        if(!scope||expected&&scope!==expected||scope.store!==this.context.store||scope.projectId!==null||scope.runId!==null||scope.mode!=='live'||scope.acceptanceId!==input.probeId||!/^custom_probe_[A-Za-z0-9_-]{1,100}$/.test(input.probeId)||!isCustomProbeNonce(input.nonce))throw new DomainError('CUSTOM_PROBE_DISPATCH_REQUIRED',409);
        const rows=this.context.store.db.prepare("SELECT kind,data FROM records WHERE project_id IS NULL AND run_id IS NULL AND kind IN ('DispatchGranted','DispatchFinished','DispatchReconciled') AND json_extract(data,'$.dispatchId')=?").all(scope.dispatchId);
        if(rows.length!==1||rows[0].kind!=='DispatchGranted')throw new DomainError('CUSTOM_PROBE_DISPATCH_REQUIRED',409);
        const grant=JSON.parse(String(rows[0].data));
        if(grant.generation!==scope.generation||grant.purpose!=='CUSTOM_ROLE_PROBE'||grant.acceptanceId!==input.probeId||grant.kind!==input.preparation.role||grant.mode!=='live'||grant.kind==='executor'&&grant.executorRoleId!==input.preparation.roleId)throw new DomainError('CUSTOM_PROBE_DISPATCH_REQUIRED',409);
        const intents=this.context.store.db.prepare("SELECT data FROM records WHERE kind='CustomRoleProbeIntent' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.probeId')=? LIMIT 2").all(input.probeId);
        if(intents.length!==1||hash(JSON.parse(String(intents[0].data)).preparation)!==hash(input.preparation)||this.context.store.db.prepare("SELECT 1 FROM records WHERE kind='CustomRoleProbeResult' AND json_extract(data,'$.probeId')=? LIMIT 1").get(input.probeId))throw new DomainError('CUSTOM_PROBE_BINDING_CHANGED',409);
        return scope;
    }
    async executeCustomRoleProbe(raw:CustomRoleProbeInput,emit:(event:unknown)=>void):Promise<CustomRoleProbeStage>{
        const input={...raw,selection:structuredClone(raw.selection),preparation:{...raw.preparation}},scope=this.assertCustomProbeCurrent(input),{op,budget}=this.configured();
        if(!this.customProofs)throw new DomainError('CUSTOM_PROBE_CUSTODY_REQUIRED',409);
        if(this.context.store.db.prepare("SELECT 1 FROM records WHERE kind='NativeCustomProbeAttempt' AND json_extract(data,'$.probeId')=? LIMIT 1").get(input.probeId))throw new DomainError('CUSTOM_PROBE_RECOVERY_REQUIRED',409);
        const attemptId=this.context.store.record('NativeCustomProbeAttempt',null,null,{probeId:input.probeId,bindingHash:input.preparation.bindingHash,role:input.preparation.role,roleId:input.preparation.roleId,dispatchId:scope.dispatchId,generation:scope.generation,nonce:input.nonce});
        const parent=within(this.context.root,'.runtime/custom-probes');mkdirSync(parent,{recursive:true});const workspace=mkdtempSync(resolve(parent,'owned-'));
        const settled=this.customAccountSelection(input.selection),seedActor=this.customProbeBinding(settled.prepared.flowConfig).roles.find(r=>r.roleId===input.preparation.roleId)!,
            probeSubscription=seedActor.authentication==='CHATGPT_SUBSCRIPTION'?this.customSubscriptionScopeFor(settled.prepared.flowConfig,seedActor.role,settled.prepared.flowConfig.runId,seedActor.role==='executor'?seedActor.roleId:undefined):undefined;
        const observation=seedActor.transport!=='magpie'&&seedActor.runtime==='independent'?await runCustomIndependentProbe({root:this.context.root,getConfig:this.context.getConfig,actor:seedActor,workspace,nonce:input.nonce,signal:input.signal,
            runId:settled.prepared.flowConfig.runId,specHash:settled.prepared.flowConfig.plan.specHash,assertCurrent:()=>this.assertCustomProbeCurrent(input,scope)}):seedActor.transport==='magpie'&&seedActor.runtime!=='dsh'?await this.withCustomMagpieControl(input.selection,async(session,_binding,signal)=>{
            this.assertCustomProbeCurrent(input,scope);const {prepared}=this.customAccountSelection(input.selection),snapshot=prepared.flowConfig,binding=this.customProbeBinding(snapshot),actor=binding.roles.find(r=>r.roleId===input.preparation.roleId)!;
            const selected=customRoleConfiguration(snapshot,actor.role,actor.role==='executor'?actor.roleId:undefined);
            const supplement=customProbeBudgetSupplement(this.context.store,snapshot,actor.roleId);
            // The same Codex harness, but its model leg is this DM-owned loopback gateway so the
            // probe stays metered and attributed by the original budget permit.
            return runCustomProbeRuntime({root:this.context.root,getConfig:this.context.getConfig,budget,session,actor,workspace,nonce:input.nonce,signal,
                context:{schema:'dream-maker.custom-probe-budget.v1',probeId:input.probeId,bindingHash:hash(binding),projectId:snapshot.projectId,runId:snapshot.runId,configurationHash:hash(snapshot),planVersionHash:snapshot.plan.contentHash,specHash:snapshot.plan.specHash,role:actor.role,roleId:actor.roleId,dispatchId:scope.dispatchId,generation:scope.generation,flowBudget:snapshot.budget,roleBudget:selected.budget,...(supplement?{supplement}:{})},
                claudeSupervisor:op.claudeSupervisor,customTextCli:op.customTextCli,selectedRole:selected,maxOutputTokens:op.maxOutputTokens,transport:this.context.fetch,childEnvironment:this.context.childEnvironment,observeRoute:this.context.observeCodexRequestRoute as never,
                price:()=>{const current=this.configured();if(current.budget.requests().length>=current.op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);return this.readRef(this.customPriceRef(actor.role,actor.provider,actor.model)) as NativePrice;},
                assertCurrent:()=>{this.assertCustomProbeCurrent(input,scope);if(hash(customProbeBudgetSupplement(this.context.store,snapshot,actor.roleId)??null)!==hash(supplement??null))throw new DomainError('CUSTOM_BUDGET_CONTEXT_STALE',409);},
                emit:event=>{this.context.store.record('NativeBudgetReceipt',null,null,{probeId:input.probeId,roleId:actor.roleId,event});emit(event);}});
        },input.signal,probeSubscription):seedActor.runtime==='codex'?await runCustomCodexProbe({root:this.context.root,getConfig:this.context.getConfig,actor:seedActor,workspace,nonce:input.nonce,signal:input.signal,
            runId:settled.prepared.flowConfig.runId,specHash:settled.prepared.flowConfig.plan.specHash,assertCurrent:()=>this.assertCustomProbeCurrent(input,scope),
            childEnvironment:this.context.childEnvironment,observeRoute:this.context.observeCodexRequestRoute as never}):seedActor.runtime==='kimi'?await runCustomKimiProbe({root:this.context.root,dataRoot:dirname(this.context.store.path),getConfig:this.context.getConfig,actor:seedActor as CustomProbeActor&{role:'reviewer'},configurationHash:input.preparation.configurationHash,workspace,nonce:input.nonce,signal:input.signal,
            runId:settled.prepared.flowConfig.runId,specHash:settled.prepared.flowConfig.plan.specHash,assertCurrent:()=>this.assertCustomProbeCurrent(input,scope)}):await this.withCustomMagpieControl(input.selection,async(session,_binding,signal)=>{
            this.assertCustomProbeCurrent(input,scope);const {prepared}=this.customAccountSelection(input.selection),snapshot=prepared.flowConfig,binding=this.customProbeBinding(snapshot),actor=binding.roles.find(r=>r.roleId===input.preparation.roleId)!;
            const selected=customRoleConfiguration(snapshot,actor.role,actor.role==='executor'?actor.roleId:undefined);
            const supplement=customProbeBudgetSupplement(this.context.store,snapshot,actor.roleId);
            return runCustomProbeRuntime({root:this.context.root,getConfig:this.context.getConfig,budget,session,actor,workspace,nonce:input.nonce,signal,
                context:{schema:'dream-maker.custom-probe-budget.v1',probeId:input.probeId,bindingHash:hash(binding),projectId:snapshot.projectId,runId:snapshot.runId,configurationHash:hash(snapshot),planVersionHash:snapshot.plan.contentHash,specHash:snapshot.plan.specHash,role:actor.role,roleId:actor.roleId,dispatchId:scope.dispatchId,generation:scope.generation,flowBudget:snapshot.budget,roleBudget:selected.budget,...(supplement?{supplement}:{})},
                template:op.template,profileBinding:op.profileBinding,sdkToolsModule:op.sdkToolsModule,claudeSupervisor:op.claudeSupervisor,customTextCli:op.customTextCli,selectedRole:selected,maxOutputTokens:op.maxOutputTokens,transport:this.context.fetch,
                price:()=>{const current=this.configured();if(current.budget.requests().length>=current.op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);return this.readRef(this.customPriceRef(actor.role,actor.provider,actor.model)) as NativePrice;},
                assertCurrent:()=>{this.assertCustomProbeCurrent(input,scope);if(hash(customProbeBudgetSupplement(this.context.store,snapshot,actor.roleId)??null)!==hash(supplement??null))throw new DomainError('CUSTOM_BUDGET_CONTEXT_STALE',409);},emit:event=>{this.context.store.record('NativeBudgetReceipt',null,null,{probeId:input.probeId,roleId:actor.roleId,event});emit(event);}});
        },input.signal);
        this.assertCustomProbeCurrent(input,scope);
        const stage=Object.freeze({attemptId,bindingHash:input.preparation.bindingHash,observation:Object.freeze({...observation,ledgerRequestIds:Object.freeze([...observation.ledgerRequestIds]) as unknown as string[]})});
        this.customProbeStages.set(stage,{inputHash:this.customProbeInputHash(input),signal:input.signal});return stage;
    }
    completeCustomRoleProbe(input:CustomRoleProbeInput,stage:CustomRoleProbeStage){
        const original=this.customProbeStages.get(stage);
        if(currentProcessOwnership()||!original||original.signal!==input.signal||original.signal.aborted||input.signal.aborted||original.inputHash!==this.customProbeInputHash(input)||
            this.context.store.db.prepare("SELECT 1 FROM records WHERE kind='CustomRoleProbeResult' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.probeId')=? LIMIT 1").get(input.probeId)||
            hash(this.customProbePreparation(input.selection,input.preparation.roleId))!==hash(input.preparation))throw new DomainError('CUSTOM_PROBE_ISSUANCE_UNVERIFIED',409);
        this.customProbeStages.delete(stage);const {prepared}=this.customAccountSelection(input.selection),binding=this.customProbeBinding(prepared.flowConfig);
        return this.customProofs!.issueCustom(binding,stage.attemptId,stage.observation);
    }
    customProbeReceipt(selection:InspectCustomAccountSources,roleId:string,evidenceId:string){
        if(!this.customProofs)throw new DomainError('CUSTOM_PROBE_CUSTODY_REQUIRED',409);
        const {prepared}=this.customAccountSelection(selection);return this.customProofs.customEvidence(this.customProbeBinding(prepared.flowConfig),roleId,evidenceId);
    }
    /** Proves the one bounded retry exception for a failure before model reservation. */
    customProbeFailureDisposition(probeId:string):boolean {
        try{
            if(typeof probeId!=='string'||!/^custom_probe_[A-Za-z0-9_-]{1,100}$/.test(probeId))return false;
            const one=(kind:string):{rowid:number;at:string;data:Record<string,unknown>}|null=>{
                const rows=this.context.store.db.prepare("SELECT rowid,at,data FROM records WHERE kind=? AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.probeId')=? LIMIT 2").all(kind,probeId);
                if(rows.length!==1)return null;
                const value=JSON.parse(String(rows[0].data));
                if(!value||typeof value!=='object'||Array.isArray(value))return null;
                return{rowid:Number(rows[0].rowid),at:String(rows[0].at),data:value as Record<string,unknown>};
            };
            const intent=one('CustomRoleProbeIntent'),attempt=one('NativeCustomProbeAttempt'),result=one('CustomRoleProbeResult');
            if(!intent||!attempt||!result)return false;
            const preparation=intent.data.preparation as Record<string,unknown>|undefined;
            if(!preparation||typeof preparation!=='object'||Array.isArray(preparation)||
                intent.data.probeId!==probeId||intent.data.purpose!=='MINIMUM_ROLE_ONLY'||intent.data.automaticRetry!==false||
                typeof intent.data.selectionHash!=='string'||!/^[a-f0-9]{64}$/.test(intent.data.selectionHash)||
                !['planner2','executor','reviewer'].includes(String(preparation.role))||typeof preparation.roleId!=='string'||
                preparation.roleId!==attempt.data.roleId||preparation.role!==attempt.data.role||
                preparation.bindingHash!==attempt.data.bindingHash||
                typeof attempt.data.dispatchId!=='string'||typeof attempt.data.generation!=='string'||
                result.data.status!=='FAILED'||!['NATIVE_PRICE_ROUTE_MISMATCH','RUNNER_RPC_ERROR'].includes(String(result.data.code))||result.data.automaticRetry!==false)return false;
            const latestSelection=this.context.store.db.prepare("SELECT max(rowid) rowid FROM records WHERE kind='CustomRoleProbeIntent' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.selectionHash')=?").get(intent.data.selectionHash);
            if(Number(latestSelection?.rowid)!==intent.rowid)return false;
            const journal=this.context.store.db.prepare("SELECT rowid,kind,at,data FROM records WHERE project_id IS NULL AND run_id IS NULL AND kind IN ('DispatchGranted','DispatchFinished') AND json_extract(data,'$.dispatchId')=? ORDER BY rowid").all(attempt.data.dispatchId)
                .map(row=>{const value=JSON.parse(String(row.data));return{rowid:Number(row.rowid),kind:String(row.kind),at:String(row.at),data:value as Record<string,unknown>};});
            if(journal.length!==2||journal[0].kind!=='DispatchGranted'||journal[1].kind!=='DispatchFinished')return false;
            const grant=journal[0].data,finished=journal[1].data;
            if(grant.generation!==attempt.data.generation||finished.generation!==attempt.data.generation||
                grant.kind!==preparation.role||grant.mode!=='live'||grant.purpose!=='CUSTOM_ROLE_PROBE'||grant.acceptanceId!==probeId||
                preparation.role==='executor'&&grant.executorRoleId!==preparation.roleId||
                finished.purpose!=='CUSTOM_ROLE_PROBE'||finished.acceptanceId!==probeId||
                finished.outcome!==result.data.code||finished.cleanupReturned!==true)return false;
            const receipt=this.context.store.db.prepare("SELECT 1 FROM records WHERE kind='NativeCustomProbeReceipt' AND project_id IS NULL AND run_id IS NULL AND (json_extract(data,'$.payload.probeId')=? OR json_extract(data,'$.probeId')=?) LIMIT 1").get(probeId,probeId);
            const session=this.context.store.db.prepare("SELECT 1 FROM records WHERE kind='AgentSession' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.dispatchId')=? LIMIT 1").get(attempt.data.dispatchId);
            const tool=this.context.store.db.prepare("SELECT 1 FROM records WHERE kind IN ('ToolIntent','ToolResult') AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.dispatchId')=? LIMIT 1").get(attempt.data.dispatchId);
            if(receipt||session||tool)return false;
            const budgetRows=this.context.store.db.prepare("SELECT rowid,data FROM records WHERE kind='NativeBudgetReceipt' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.probeId')=? ORDER BY rowid").all(probeId)
                .map(row=>{const data=JSON.parse(String(row.data)) as Record<string,unknown>,event=data.event as Record<string,unknown>|undefined;return{rowid:Number(row.rowid),data,event};})
                .filter(row=>row.event?.method==='dm/budget');
            if(budgetRows.length!==1)return false;
            const budgetRow=budgetRows[0],budget=budgetRow.data,event=budgetRow.event,params=event?.params as Record<string,unknown>|undefined;
            if(budget.probeId!==probeId||budget.roleId!==preparation.roleId||event?.method!=='dm/budget'||!Array.isArray(params?.requests))return false;
            if(!(intent.rowid<journal[0].rowid&&journal[0].rowid<attempt.rowid&&attempt.rowid<budgetRow.rowid&&budgetRow.rowid<journal[1].rowid&&journal[1].rowid<result.rowid))return false;
            const ledger=this.configured().budget.requests();
            const matching=ledger.filter(row=>{
                const value=row as Record<string,unknown>,custom=value.customProbe as Record<string,unknown>|undefined,binding=value.binding as Record<string,unknown>|undefined,work=binding?.work as Record<string,unknown>|undefined;
                return custom?.probeId===probeId||binding?.dispatchId===attempt.data.dispatchId||work?.probeId===probeId;
            });
            if(result.data.code==='NATIVE_PRICE_ROUTE_MISMATCH')return params.requests.length===0&&matching.length===0;
            if(result.data.code!=='RUNNER_RPC_ERROR'||params.requests.length!==1||matching.length!==1)return false;
            const value=matching[0] as Record<string,unknown>,custom=value.customProbe as Record<string,unknown>|undefined,binding=value.binding as Record<string,unknown>|undefined,work=binding?.work as Record<string,unknown>|undefined,router=value.routerAdmission as Record<string,unknown>|undefined;
            if(value.role!==preparation.role||value.usageStatus!=='UNKNOWN'||value.outcome!=='MODEL_GATEWAY_UPSTREAM_FAILURE'||
                custom?.probeId!==probeId||custom.roleId!==preparation.roleId||custom.bindingHash!==preparation.bindingHash||
                custom.dispatchId!==attempt.data.dispatchId||custom.generation!==attempt.data.generation||
                binding?.engineeringMode!=='custom'||binding.dispatchId!==attempt.data.dispatchId||binding.generation!==attempt.data.generation||
                binding.role!==preparation.role||binding.roleId!==preparation.roleId||
                work?.kind!=='QUALIFICATION'||work.probeId!==probeId||work.bindingHash!==preparation.bindingHash||
                router?.status!=='ACKNOWLEDGED'||typeof router.admissionId!=='string'||!/^admission_[A-Za-z0-9_-]{1,100}$/.test(router.admissionId))return false;
            const from=typeof intent.data.at==='string'?intent.data.at:'',to=typeof finished.at==='string'?finished.at:'';
            return exactPreUpstreamGatewayRejection({root:this.context.root,admissionId:router.admissionId,expectedBinarySha256:String(router.binaryHash??''),from,to});
        }catch{return false;}
    }
    /** No preparation/current UI lookup is allowed after the original Flow starts. */
    private customRunAccountSelection(input:AgentInput,ownership:ProcessOwnershipScope|undefined){
        const {budget}=this.configured();this.assertNativeCleanup();
        const selected=customRoleRequestContext(this.context.store,this.context.getConfig(),input,ownership);
        return{budget,snapshot:selected.snapshot,...this.customAccountCatalog(selected.snapshot,selected.identity.configurationHash,selected.identityHash)};
    }
    /** A controller-only, one-shot capability, not Custom runtime qualification. */
    prepareCustomRunMagpieCustody(input:AgentInput,signal?:AbortSignal){
        return this.createCustomRunMagpieCustody(input,signal);
    }
    private createCustomRunMagpieCustody(input:AgentInput,signal?:AbortSignal,allowedController?:AbortController){
        return withExplicitSecretInspection([],()=>{
            const {budget}=this.configured();this.assertNativeCleanup();
            const assertIdle=()=>{if(this.preparing||[...this.active.keys()].some(c=>c!==allowedController)||this.plannerTickets.size||budget.summary().inFlight)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);};assertIdle();
            for(const old of this.accountCustodies)if(!magpieAccountCustodyPending(old))this.accountCustodies.delete(old);
            if(this.accountCustodies.size>=8)throw new DomainError('MAGPIE_ACCOUNT_CUSTODY_LIMIT',409);
            const selected={...input,laya:{...input.laya},signal:signal?AbortSignal.any([input.signal,signal]):input.signal},ownership=currentProcessOwnership(),selection=this.customRunAccountSelection(selected,ownership),binding=Object.freeze({...selection.binding});
            const custody=createMagpieAccountCustody({snapshot:selection.snapshot,binding,sources:selection.catalog,dshKeyEnv:selection.definition.secretEnv,bridgeCandidateHash:()=>this.reviewedMagpieCandidate().sha256,signal:selected.signal,
                getSecret:name=>this.context.getSecret?this.context.getSecret(name):process.env[name],
                assertCurrent:()=>withExplicitSecretInspection([],()=>{assertIdle();
                    if(currentProcessOwnership()!==ownership)throw new DomainError('MAGPIE_ACCOUNT_CUSTODY_STALE',409);
                    return this.customRunAccountSelection(selected,ownership).binding;})});
            this.accountCustodies.add(custody);return Object.freeze({custody,binding});
        });
    }
    private customSubscriptionScopeFor(snapshot:CustomFlowConfigSnapshot,role:Role,runId:string,executorRoleId?:string):Readonly<MagpieSubscriptionScope>|undefined{
        if(role!=='planner2')return undefined;
        const actor=customRoleConfiguration(snapshot,role,executorRoleId);
        if(actor.runtime!=='codex'||actor.transport!=='magpie'||actor.authentication!=='oauth')return undefined;
        if(snapshot.runId!==runId)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
        const ref=this.operator?.codexSubscriptionAccount;
        if(!ref)throw new DomainError('CUSTOM_SUBSCRIPTION_ACCOUNT_NOT_PINNED',409);
        const pin=this.readRef(ref) as Record<string,unknown>|null;
        if(!pin||pin.schema!=='dream-maker.codex-subscription-account.v1'||pin.authRef!==actor.authRef||pin.accountRef!==actor.accountRef||
           pin.homeHash!==hash(this.context.getConfig().codex.home)||typeof pin.accountFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(pin.accountFingerprint))
            throw new DomainError('CUSTOM_SUBSCRIPTION_ACCOUNT_BINDING_CHANGED',409);
        return{projectId:snapshot.projectId,flowId:runId,configurationHash:hash(snapshot),authRef:actor.authRef,accountRef:actor.accountRef,accountFingerprint:pin.accountFingerprint};
    }
    private customSubscriptionScope(snapshot:CustomFlowConfigSnapshot,input:AgentInput){return this.customSubscriptionScopeFor(snapshot,input.role,input.runId,input.executorRoleId);}
    /** Original NativeOwner owns the same active operation until its Windows Job is
     * closed. The caller cannot supply a snapshot, source manifest or proof flag. */
    async withCustomRunMagpieControl<T>(input:AgentInput,consume:(session:OwnedMagpieControl,binding:Readonly<MagpieCustodyBinding>,signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
        if(typeof consume!=='function')throw new DomainError('MAGPIE_ACCOUNT_CONSUMER_REQUIRED',409);
        const {budget}=this.configured();this.assertNativeCleanup();const candidate=this.reviewedMagpieCandidate(),controller=new AbortController();
        const combined=AbortSignal.any([input.signal,controller.signal,...(signal?[signal]:[])]),selected={...input,laya:{...input.laya},signal:combined},ownership=currentProcessOwnership(),ticket=this.createCustomRunMagpieCustody(selected,combined,controller);
        const pending=this.withMagpieNetwork(`magpie-custom-${selected.runId}`,combined,async()=>{
            const subscription=this.customSubscriptionScope(this.customRunAccountSelection(selected,ownership).snapshot,selected);
            const session=await this.openMagpieControl({root:this.context.root,binary:candidate,budget,signal:combined,accountCustody:ticket.custody,custodyBinding:ticket.binding,...(subscription?{subscription}:{})});
            let result:T;
            try{
                if(combined.aborted)throw new DomainError('MAGPIE_START_CANCELLED',409);
                if(hash(this.customRunAccountSelection(selected,ownership).binding)!==hash(ticket.binding))throw new DomainError('MAGPIE_ACCOUNT_CUSTODY_STALE',409);
                result=await consume(session,ticket.binding,combined);
            }finally{await session.close();}
            // A late Store/source/operator change during cleanup must not escape as success.
            if(combined.aborted)throw new DomainError('MAGPIE_START_CANCELLED',409);
            if(hash(this.customRunAccountSelection(selected,ownership).binding)!==hash(ticket.binding))throw new DomainError('MAGPIE_ACCOUNT_CUSTODY_STALE',409);
            return result;
        });this.active.set(controller,pending);
        try{return await pending;}catch(error){if(cleanupUncertain(error))this.cleanupUncertain=true;throw error;}
        finally{revokeMagpieAccountCustody(ticket.custody);this.accountCustodies.delete(ticket.custody);this.active.delete(controller);}
    }
    /** Only explicit private manifest references. No account discovery, auth request or model call. */
    inspectCustomAccountSources(input:InspectCustomAccountSources){
        return withExplicitSecretInspection([],()=>{
            const {budget}=this.configured();if(this.preparing||this.active.size||this.plannerTickets.size||budget.summary().inFlight)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
            const selection=this.customAccountSelection(input);
            const view=observeCustomAccountSources(selection.prepared.flowConfig,selection.manifest,selection.manifestHash,selection.definition.secretEnv,name=>this.context.getSecret?this.context.getSecret(name):process.env[name],selection.registered,this.accountProbeAuthority());
            selection.preparations.prepare(input.projectId,input.specHash,input.profileHash,input.preparation);return view;
        });
    }
    /** Controller-only capability for the original owned launcher. No HTTP serialization,
     * model qualification, budget grant or process is created by preparing this ticket. */
    prepareCustomMagpieCustody(input:InspectCustomAccountSources,signal?:AbortSignal){
        return this.createCustomMagpieCustody(input,signal,false);
    }
    private createCustomMagpieCustody(input:InspectCustomAccountSources,signal:AbortSignal|undefined,allowCurrentLocalCheck:boolean,allowedController?:AbortController){
        return withExplicitSecretInspection([],()=>{
            const {budget}=this.configured();this.assertNativeCleanup(allowCurrentLocalCheck);
            // The consuming local check owns its own controller: exactly like the run
            // capability, it may consume its ticket while that session is active.
            const assertIdle=()=>{if(this.preparing||[...this.active.keys()].some(c=>c!==allowedController)||this.plannerTickets.size||budget.summary().inFlight)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);};assertIdle();
            for(const old of this.accountCustodies)if(!magpieAccountCustodyPending(old))this.accountCustodies.delete(old);
            if(this.accountCustodies.size>=8)throw new DomainError('MAGPIE_ACCOUNT_CUSTODY_LIMIT',409);
            const copy=structuredClone(input),selection=this.customAccountSelection(copy,allowCurrentLocalCheck),binding=Object.freeze({...selection.binding});
            const custody=createMagpieAccountCustody({snapshot:selection.prepared.flowConfig,binding,sources:selection.catalog,dshKeyEnv:selection.definition.secretEnv,bridgeCandidateHash:()=>this.reviewedMagpieCandidate().sha256,signal,
                getSecret:name=>this.context.getSecret?this.context.getSecret(name):process.env[name],
                assertCurrent:()=>withExplicitSecretInspection([],()=>{
                    assertIdle();const next=this.customAccountSelection(copy,allowCurrentLocalCheck);assertIdle();return next.binding;
                })});
            this.accountCustodies.add(custody);return Object.freeze({custody,binding});
        });
    }
    async recommendCustomMagpieMember(input:InspectCustomAccountSources,roleId:string,signal:AbortSignal){
        const current=()=>{
            const {prepared,budget}=this.customAccountSelection(input),{op}=this.configured();
            if(this.context.store.runs(input.projectId).some(run=>run.id===prepared.flowConfig.runId||!canReviseAfterFlow(this.context.store,run)))throw new DomainError('FLOW_TERMINATION_REQUIRED',409);
            preparedMemberScope(prepared.flowConfig,roleId);
            if(budget.requests().length>=op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);
            return {prepared,budget,op};
        };
        current();
        const recommendation=await this.withCustomMagpieControl(input,async session=>{
            const {prepared,budget,op}=current();
            return recommendPreparedMember(prepared.flowConfig,roleId,session.observation,budget,op.maxOutputTokens,(role,provider,model)=>this.readRef(this.customPriceRef(role,provider,model)) as NativePrice);
        },signal);
        current();if(recommendation.expiresAtMs<=Date.now())throw new DomainError('CUSTOM_MAGPIE_ESTIMATE_UNAVAILABLE',409);
        return recommendation;
    }
    /** Trusted controller continuation, never a browser callback. The original owner's
     * active operation joins startup, consumer work and OS cleanup as one lifetime. */
    async withCustomMagpieControl<T>(input:InspectCustomAccountSources,consume:(session:OwnedMagpieControl,binding:Readonly<MagpieCustodyBinding>,signal:AbortSignal)=>Promise<T>,signal?:AbortSignal,subscription?:Readonly<MagpieSubscriptionScope>):Promise<T>{
        return this.useCustomMagpieControl(input,consume,signal,false,undefined,subscription);
    }
    private async useCustomMagpieControl<T>(input:InspectCustomAccountSources,consume:(session:OwnedMagpieControl,binding:Readonly<MagpieCustodyBinding>,signal:AbortSignal)=>Promise<T>,signal:AbortSignal|undefined,allowCurrentLocalCheck:boolean,expectedBinding?:MagpieCustodyBinding,subscription?:Readonly<MagpieSubscriptionScope>):Promise<T>{
        if(typeof consume!=='function')throw new DomainError('MAGPIE_ACCOUNT_CONSUMER_REQUIRED',409);
        const {budget}=this.configured();this.assertNativeCleanup(allowCurrentLocalCheck);const candidate=this.reviewedMagpieCandidate();
        const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal,selected=structuredClone(input),ticket=this.createCustomMagpieCustody(selected,combined,allowCurrentLocalCheck,controller);
        if(expectedBinding&&hash(expectedBinding)!==hash(ticket.binding)){revokeMagpieAccountCustody(ticket.custody);this.accountCustodies.delete(ticket.custody);throw new DomainError('MAGPIE_ACCOUNT_CUSTODY_STALE',409);}
        const pending=this.withMagpieNetwork(`magpie-account-${selected.projectId}-${selected.specHash}`,combined,async()=>{
            const session=await this.openMagpieControl({root:this.context.root,binary:candidate,budget,signal:combined,accountCustody:ticket.custody,custodyBinding:ticket.binding,...(subscription?{subscription}:{})});
            try{
                if(combined.aborted)throw new DomainError('MAGPIE_START_CANCELLED',409);
                const next=withExplicitSecretInspection([],()=>this.customAccountSelection(selected,allowCurrentLocalCheck));
                if(hash(next.binding)!==hash(ticket.binding))throw new DomainError('MAGPIE_ACCOUNT_CUSTODY_STALE',409);
                return await consume(session,ticket.binding,combined);
            }finally{await session.close();}
        });this.active.set(controller,pending);
        try{return await pending;}catch(error){if(cleanupUncertain(error))this.cleanupUncertain=true;throw error;}
        finally{revokeMagpieAccountCustody(ticket.custody);this.accountCustodies.delete(ticket.custody);this.active.delete(controller);}
    }
    /** Used only within the original durable local-check scope. The returned closed
     * observation cannot escape until useCustomMagpieControl has joined OS cleanup. */
    describeCustomMagpieAccountCheck(input:InspectCustomAccountSources):Readonly<MagpieCustodyBinding>{
        return withExplicitSecretInspection([],()=>{const current=this.customAccountSelection(input,true);if(this.preparing||this.active.size||this.plannerTickets.size||current.budget.summary().inFlight)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);return Object.freeze({...current.binding});});
    }
    async inspectCustomMagpieAccounts(input:InspectCustomAccountSources,signal:AbortSignal,expectedBinding:MagpieCustodyBinding):Promise<MagpieAccountControlObservation>{
        const selected=structuredClone(input),bound=accountCheckBinding(expectedBinding);
        const result=await this.useCustomMagpieControl<MagpieAccountControlObservation>(selected,async(session,binding)=>{
            if(session.observation.qualification!=='NOT_VERIFIED'||!session.observation.realCredentialsPermitted||session.observation.accountCount<1)throw new DomainError('MAGPIE_ACCOUNT_CHECK_OBSERVATION_INVALID',502);
            return{schema:'dream-maker.magpie-account-control-observation.v1',projectId:selected.projectId,flowConfigHash:binding.flowConfigHash,sourceBindingHash:binding.sourceBindingHash,accountCount:session.observation.accountCount,processClosed:true,accountVerified:this.accountVerification(selected),modelVerified:false,customExecutionGranted:false};
        },signal,true,bound);
        // The owned close has completed. A source/operator change during that await
        // must not escape as a success; this stable error also carries closed provenance.
        try{if(hash(this.describeCustomMagpieAccountCheck(selected))!==hash(bound))throw new DomainError('MAGPIE_ACCOUNT_CHECK_SELECTION_CHANGED',409);}catch{throw new DomainError('MAGPIE_ACCOUNT_CHECK_SELECTION_CHANGED',409);}
        return result;
    }
    private reviewedMagpieCandidate():MagpieExecutableRef {
        const fromEnv=process.env.DM_MAGPIE_CANDIDATE_PATH&&process.env.DM_MAGPIE_CANDIDATE_SHA256
            ?{path:process.env.DM_MAGPIE_CANDIDATE_PATH,sha256:process.env.DM_MAGPIE_CANDIDATE_SHA256}:undefined;
        const candidate=this.context.magpieCandidate??this.operator?.magpieCandidate??fromEnv;
        if(!candidate)throw new DomainError('MAGPIE_CANDIDATE_BINDING_REQUIRED',409);
        // The private operator selects only the reviewed DM build; trusted bootstrap tests
        // may inject a pinned candidate. The owned launcher rechecks bytes and ancestors.
        if(!this.context.magpieCandidate){
            if(typeof candidate!=='object'||Array.isArray(candidate)||Reflect.ownKeys(candidate).length!==2||typeof candidate.path!=='string'||!isAbsolute(candidate.path))throw new DomainError('MAGPIE_CANDIDATE_BINDING_REQUIRED',409);
            const path=resolve(candidate.path).toLowerCase();
            const original=candidate.sha256===REVIEWED_MAGPIE_BUILD_SHA256&&path.startsWith(resolve('F:/DreamMakerSuite').toLowerCase()+sep);
            const custom=candidate.sha256===REVIEWED_CUSTOM_MAGPIE_BUILD_SHA256&&path===resolve('E:/DreamMakerSuite/custom-mvp/runtime/magpie/string-r2/dream-maker-magpie.exe').toLowerCase();
            const cliResponses=supportsOfficialCliResponsesBuild(candidate.sha256)&&path===resolve('F:/DreamMakerSuite/evidence/M07/v5-source-rebuild-S3GrBg/cli-responses/dream-maker-magpie.exe').toLowerCase();
            const executorCli=candidate.sha256===REVIEWED_EXECUTOR_CLI_BUILD_SHA256&&path===resolve('D:/DreamMakerSuite/runtime/magpie-dm-candidate-5a2b952c/dream-maker-magpie.exe').toLowerCase();
            if(!original&&!custom&&!cliResponses&&!executorCli)throw new DomainError('MAGPIE_CANDIDATE_BINDING_REQUIRED',409);
        }
        return candidate;
    }
    private customMagpieNetworkEnvironment(base:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
        if(!this.context.getConfig().clash.enabled)return base;
        if(typeof this.context.childEnvironment!=='function')throw new DomainError('MAGPIE_CONTROLLED_NETWORK_REQUIRED',409);
        return this.context.childEnvironment(base);
    }
    private withMagpieNetwork<T>(runId:string,signal:AbortSignal,action:()=>Promise<T>):Promise<T>{
        if(!this.context.getConfig().clash.enabled)return action();
        if(typeof this.context.withNetworkRun!=='function')throw new DomainError('MAGPIE_CONTROLLED_NETWORK_REQUIRED',409);
        return this.context.withNetworkRun(runId,signal,action);
    }
    /** Every DM-owned Magpie process, including the empty-account local check, uses
     * the same current CFW lease when DM routing is enabled. */
    private openMagpieControl(input:Omit<Parameters<typeof openOwnedMagpieControl>[0],'networkEnvironment'>){
        if(!this.context.getConfig().clash.enabled)return openOwnedMagpieControl(input);
        if(typeof this.context.childEnvironment!=='function')throw new DomainError('MAGPIE_CONTROLLED_NETWORK_REQUIRED',409);
        return openOwnedMagpieControl({...input,networkEnvironment:base=>this.customMagpieNetworkEnvironment(base)});
    }
    /** Local empty-account process check, not a model probe, audit or Custom dispatch permit. */
    async inspectMagpieIngress(signal?:AbortSignal){
        if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        this.assertNativeCleanup(true);
        const candidate=this.reviewedMagpieCandidate();
        const {budget}=this.configured();
        if(this.active.size||this.plannerTickets.size||budget.summary().inFlight)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
        const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
        const pending=this.withMagpieNetwork('magpie-ingress-check',combined,async()=>{const session=await this.openMagpieControl({root:this.context.root,binary:candidate,budget,signal:combined});
            try{return{...session.observation};}finally{await session.close();}
        });this.active.set(controller,pending);
        try{return await pending;}catch(error){if(cleanupUncertain(error))this.cleanupUncertain=true;throw error;}finally{this.active.delete(controller);}
    }
    /** Product Custom roles still run beneath the original Engine's owned Dispatch. */
    /** A Custom Codex role uses the same official CLI as Classic but is bound to the
     * frozen Custom actor: no Magpie process, no paid ledger row, exactly one turn. */
    private customCodex(input:AgentInput,actor:ReturnType<typeof customRoleConfiguration>,assertCurrent:()=>void,configurationHash:string):Runner{
        if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        const modelId=actor.model.id;let used=false;
        return{run:async(args,emit)=>{
            if(used)throw new DomainError('CUSTOM_ROLE_TURN_ALREADY_USED',409);
            if(args.role!==input.role||args.runId!==input.runId||args.workspace!==input.workspace||args.model!==input.model||args.signal!==input.signal)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            used=true;assertCurrent();
            const controller=new AbortController(),runner=new CodexRunner(this.context.getConfig,this.context.root,false,this.context.childEnvironment,undefined,this.context.observeCodexRequestRoute),
                pending=runner.run({...args,signal:AbortSignal.any([args.signal,controller.signal])},emit);
            this.active.set(controller,pending);
            try{
                const out=await pending;assertCurrent();
                if(!out.identity||out.identity.runner!=='CODEX_CLI'||out.identity.model!==modelId||!out.sessionId)throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
                return{...out,identity:{...out.identity,runtime:actor.runtime,roleId:actor.id,authRef:actor.authRef,accountRef:actor.accountRef,configurationHash}};
            }catch(error){if(cleanupUncertain(error))this.cleanupUncertain=true;throw error;}finally{this.active.delete(controller);}
        }};
    }
    /** A direct-API Custom role. No tools, no Magpie: the frozen provider/model is called
     * over the configured independent route and one turn is consumed at most. */
    private customIndependent(input:AgentInput,actor:ReturnType<typeof customRoleConfiguration>,assertCurrent:()=>void,configurationHash:string):Runner{
        if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        const modelId=actor.model.id;let used=false;
        return{run:async(args,emit)=>{
            if(used)throw new DomainError('CUSTOM_ROLE_TURN_ALREADY_USED',409);
            if(args.role!==input.role||args.runId!==input.runId||args.workspace!==input.workspace||args.model!==input.model||args.signal!==input.signal)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            used=true;assertCurrent();
            const config=():Config=>{const c=this.context.getConfig();return{...c,independent:{...c.independent!,enabled:true,model:modelId}};},
                runner=new IndependentRunner(config,undefined,name=>{try{return this.context.getSecret?this.context.getSecret(name):process.env[name];}catch{return undefined;}}),
                out=await runner.run({...args,model:modelId},emit);
            assertCurrent();
            // The shared IndependentRunner reports text, session and usage but carries no identity
            // envelope, so the controller states the runner it actually invoked. A runner that does
            // return one still has to agree; a contradictory envelope is never silently overwritten.
            if(out.model!==modelId||!out.sessionId||out.identity&&out.identity.runner!=='INDEPENDENT_API')throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
            const identity={runner:'INDEPENDENT_API' as const,provider:actor.provider,authentication:'API_KEY' as const,model:modelId};
            return{...out,identity:{...identity,runtime:actor.runtime,roleId:actor.id,authRef:actor.authRef,accountRef:actor.accountRef,configurationHash}};
        }};
    }
    private qualifiedCustomMagpieRoute(session:OwnedMagpieControl,input:AgentInput,actor:ReturnType<typeof customRoleConfiguration>){
        if(input.role==='planner1')throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409);
        const route=resolveCustomMagpieRoute(session.observation,input.role,actor);
        if(!session.observation.realCredentialsPermitted||!this.customProofs)throw new DomainError('CUSTOM_ROLE_QUALIFICATION_REQUIRED',409);
        const {snapshot}=this.customRunAccountSelection(input,currentProcessOwnership());
        this.customProofs.assertCustomReady(this.customProbeBinding(snapshot),{roleId:actor.id,routeHash:magpieRouteHash(route)});
        return route;
    }
    /** A text-only direct API role whose model leg is the DM loopback gateway instead of a
     * provider URL. Same frozen account, same budget permit and the same attribution as the
     * DSH and Codex Magpie routes; the harness itself stays the independent API runner. */
    private customTextMagpie(input:AgentInput,actor:ReturnType<typeof customRoleConfiguration>,assertCurrent:()=>void,configurationHash:string):Runner{
        if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        const modelId=actor.model.id;let used=false;
        return{run:async(args,emit)=>{
            if(used)throw new DomainError('CUSTOM_ROLE_TURN_ALREADY_USED',409);
            if(args.role!==input.role||args.runId!==input.runId||args.workspace!==input.workspace||args.model!==input.model||args.signal!==input.signal)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            if(args.role==='planner1')throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409);
            const turnRole=args.role;
            const claude=actor.runtime==='claude',cliRuntime=isCustomTextCliRuntime(actor.runtime)?actor.runtime:undefined;
            // OpenCode and Cline stay text-only supervisors. Their CLI can run headless, but no
            // tool-carrying model leg exists for them (custom-role-identity.ts customMagpieApiRuntime),
            // so an executor turn is refused before any gateway is built.
            if(cliRuntime&&turnRole==='executor')throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409);
            used=true;assertCurrent();
            const {op,budget}=this.configured();
            return this.withCustomRunMagpieControl(args,async(session,_binding,signal)=>{
                assertCurrent();
                const route=this.qualifiedCustomMagpieRoute(session,args,actor),protocol=claude||route.protocol==='anthropic-messages'?'anthropic-messages' as const:'chat-completions' as const;
                const officialResponses=!!cliRuntime&&route.protocol==='openai-responses';
                const translatedClaude=claude&&route.protocol!=='anthropic-messages';
                if(translatedClaude&&!supportsClaudeReadOnlyBuild(session.observation.binaryHash))throw new DomainError('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE',409);
                const claudeTurn=translatedClaude?{prompt:args.prompt,instructions:'Complete the supplied read-only '+turnRole+' task. Do not call tools or access the filesystem.',assertCurrent,signal}:undefined;
                const planner=officialResponses?{model:modelId,prompt:args.prompt,instructions:'Complete the supplied read-only '+turnRole+' task. Do not call tools or access the filesystem.',maxOutputTokens:op.maxOutputTokens}:undefined;
                const channel=new MagpieDshRequestTransport({session,budget,route,role:turnRole,planner,claude:claudeTurn,transport:this.context.fetch,bindRequest:payload=>{assertCurrent();return customModelRequestBinding(this.context.store,this.context.getConfig(),args,currentProcessOwnership(),payload.route,payload.bodyHash);},assertCurrent:()=>{assertCurrent();}});
                const quote=()=>{assertCurrent();const q=this.readRef(this.customPriceRef(turnRole,actor.provider,modelId)) as NativePrice;
                    assertNativePriceForRoute(q,{provider:actor.provider,model:modelId,currency:officialResponses||translatedClaude?actor.budget.currency:'CNY'});
                    if(budget.requests().length>=op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);return q;};
                const gateway=new DeepSeekGateway(budget,quote,'',op.maxOutputTokens,claude||officialResponses?1:Math.min(op.maxRequests,200),this.context.fetch??fetch,protocol,claude,undefined,undefined,undefined,channel,undefined,modelId);
                try{
                    const address=await gateway.start();
                    if((claude||cliRuntime)&&turnRole!=='executor'){
                        const {runCustomOfficialCli}=await import('./providers/custom-official-cli.js');
                        const runtime=cliRuntime??'claude';
                        const commandRef=cliRuntime?op.customTextCli?.[cliRuntime]:op.claudeSupervisor;
                        if(!commandRef)throw new DomainError('CUSTOM_CLI_COMMAND_UNVERIFIED',409);
                        const out=await runCustomOfficialCli({runtime,role:turnRole,commandRef,wire:protocol,controllerRoot:this.context.root,
                            gatewayUrl:address.url,gatewayToken:address.token,model:modelId,prompt:args.prompt,signal,timeoutMs:300000,maxOutputTokens:op.maxOutputTokens,assertCurrent,receipts:()=>gateway.receipts()});
                        assertCurrent();
                        const receipt=gateway.confirmedSupervisorOutput(out.model,out.text);
                        if(receipt.id!==out.requestId)throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
                        return{text:out.text,sessionId:out.sessionId,model:out.model,usage:{role:turnRole,requestId:receipt.id,
                            inputTokens:receipt.usage?.inputTokens??null,outputTokens:receipt.usage?.outputTokens??null,costUsd:null,source:receipt.usage?'PROVIDER' as const:'UNKNOWN' as const},
                            identity:{runner:cliRuntime?CUSTOM_TEXT_CLI_RUNNERS[cliRuntime]:'CLAUDE_CODE' as const,provider:actor.provider,authentication:'API_KEY' as const,model:out.model,runtime,
                                roleId:actor.id,authRef:actor.authRef,accountRef:actor.accountRef,configurationHash,routeHash:magpieRouteHash(route)}};
                    }
                    const activeEffort=turnRole==='reviewer'&&modelId==='deepseek-v4-pro'?'low' as const:undefined,
                        config=():Config=>{const c=this.context.getConfig();return{...c,independent:{enabled:true,baseUrl:address.url,protocol:'chat-completions',model:modelId,keyEnv:'DM_GATEWAY_TOKEN',maxOutputTokens:op.maxOutputTokens,maxRequests:1}};},
                        runner=new IndependentRunner(config,loopbackGatewayChatRequest(address),name=>name==='DM_GATEWAY_TOKEN'?address.token:undefined,undefined,activeEffort);
                    const out=await runner.run({...args,signal},emit);
                    assertCurrent();
                    // Magpie may answer with its provider-qualified route spelling. Accept exactly
                    // that spelling for this prepared route and record the bare frozen model, so a
                    // different model (or any other qualification) still fails as unverified.
                    const observedModel=out.model===modelId?modelId:out.model===actor.provider+'/'+modelId?modelId:null;
                    if(observedModel===null||!out.sessionId||out.identity&&out.identity.runner!=='INDEPENDENT_API')throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
                    return{...out,model:observedModel,identity:{runner:'INDEPENDENT_API' as const,provider:actor.provider,authentication:'API_KEY' as const,model:observedModel,runtime:actor.runtime,roleId:actor.id,authRef:actor.authRef,accountRef:actor.accountRef,configurationHash,routeHash:magpieRouteHash(route)}};
                }finally{
                    try{await gateway.close();}finally{
                        const event={method:'dm/budget',params:{requests:gateway.receipts()}};
                        this.context.store.record('NativeBudgetReceipt',this.context.store.run(args.runId).projectId,args.runId,event);emit(event);
                        this.warning();
                    }
                }
            },args.signal);
        }};
    }
    /** Custom harness: the Pi Agent CLI drives only the DM tool broker.
     *
     *  All three engineering roles use this one lane, and the role decides what the lane may do:
     *  an executor keeps the five desk_* tools (the write three only when its frozen permissions
     *  grant source_write), while planner2 and reviewer are frozen to PI_READ_ONLY_TOOLS
     *  (desk_read/desk_search) and can never reach desk_write, desk_edit or desk_run. A read role
     *  is pinned to its own role id — never to an executor's — and each turn opens a fresh Pi
     *  control directory with --no-session, so no session state crosses roles. */
    private customPi(input:AgentInput,role:Role,actor:ReturnType<typeof customRoleConfiguration>,assertCurrent:()=>void,configurationHash:string):Runner{
        if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        if(actor.runtime!=='pi'||(role!=='executor'&&role!=='planner2'&&role!=='reviewer'))throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409,'Pi Agent 只担任 Custom 的规划、执行或审查角色。');
        // Role isolation at the dispatch boundary: the read roles are named by the role itself,
        // so a turn that arrives for planner2 carrying an executor binding is a different role
        // wearing this one's envelope and is refused before any control process is opened.
        if(role!=='executor'&&actor.id!==role)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
        const model=actor.model.id;
        let used=false;
        return{run:async(args,emit)=>{
            if(used)throw new DomainError('CUSTOM_ROLE_TURN_ALREADY_USED',409);
            if(args.role!==input.role||args.runId!==input.runId||args.workspace!==input.workspace||args.model!==input.model||args.signal!==input.signal)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            used=true;assertCurrent();
            const {op,budget}=this.configured();
            return this.withCustomRunMagpieControl(args,async(session,_binding,signal)=>{
                assertCurrent();
                const route=this.qualifiedCustomMagpieRoute(session,args,actor);
                const protocol=route.protocol,nativePi=protocol!=='chat-completions',readOnly=role!=='executor';
                const quote=()=>{assertCurrent();const q=this.readRef(this.customPriceRef(role as 'planner2'|'executor'|'reviewer',actor.provider,model)) as NativePrice;
                    assertNativePriceForRoute(q,{provider:actor.provider,model,currency:nativePi?actor.budget.currency:'CNY'});
                    if(budget.requests().length>=op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);return q;};
                // The frozen role, not the permission set, decides the tool list: only an executor
                // may hold the write three, and a read role holds exactly the read pair even if its
                // permissions were ever widened. PiRunner and the transport re-check the same list.
                const names=readOnly?Object.freeze([...PI_READ_ONLY_TOOLS]):
                    Object.freeze(['desk_read','desk_search',...(actor.permissions.includes('source_write')?['desk_write','desk_edit','desk_run']:[])]);
                const pi=protocol==='chat-completions'?undefined:new PiNativeSession({protocol,model,maxInputTokens:quote().maxInputTokens,maxOutputTokens:op.maxOutputTokens,prompt:args.prompt,tools:names});
                // The channel carries the role, so the ledger, the receipt and the transport's own
                // purpose gate all read the turn a read role actually ran. A read-only turn is one
                // supervision answer plus at most one read round, so its request ceiling is small
                // and finite rather than the executor's per-run allowance.
                const channel=new MagpieDshRequestTransport({session,budget,route,role:role as 'planner2'|'executor'|'reviewer',pi,transport:this.context.fetch,bindRequest:payload=>{assertCurrent();return customModelRequestBinding(this.context.store,this.context.getConfig(),args,currentProcessOwnership(),payload.route,payload.bodyHash);},assertCurrent:()=>{assertCurrent();}});
                const gateway=new DeepSeekGateway(budget,quote,'',op.maxOutputTokens,readOnly?Math.min(op.maxRequests,4):Math.min(op.maxRequests,200),this.context.fetch??fetch,protocol==='openai-responses'?'responses':protocol,false,undefined,undefined,undefined,channel,undefined,model);
                let broker:Awaited<ReturnType<typeof startToolBroker>>|undefined;
                try{
                    const base=await createExecutorTools(this.context.store,this.context.getConfig,args.runId,op.files,new WslSandbox(this.context.root),input.executorSliceId);
                    // A read role reaches the same owned desk_* implementations through the
                    // read-only controller, so the broker audit is identical while the write three
                    // are refused on the controller side instead of being merely undeclared.
                    const controller=readOnly?readOnlyDeskTools(role as 'planner2'|'reviewer',actor.permissions,base,assertCurrent,signal):
                        customProductTools('executor',actor.permissions,base,assertCurrent,signal);
                    broker=await startToolBroker(pi?pi.toolController(controller):controller);
                    const address=await gateway.start();
                    const runner=new PiRunner(()=>this.context.getConfig(),this.context.root,
                        async()=>({url:address.url,token:address.token,close:()=>gateway.close(),receipts:()=>gateway.receipts()}),
                        {role:role as 'planner2'|'executor'|'reviewer',roleId:actor.id,provider:route.provider,model:route.model,protocol,maxOutputTokens:op.maxOutputTokens,tools:names,assertCurrent},
                        async()=>({url:broker!.url,token:broker!.token,close:()=>broker!.close()}));
                    const output=await runner.run({...args,signal},event=>{
                        if(event&&typeof event==='object'&&(event as {method?:unknown}).method==='dm/budget')this.context.store.record('NativeBudgetReceipt',this.context.store.run(args.runId).projectId,args.runId,event);
                        emit(event);
                    });
                    assertCurrent();
                    if(nativePi)gateway.confirmedPiOutput(route.model,output.text,output.usage?.requestId??undefined);
                    if(!output.identity||output.identity.runner!=='PI_CLI'||output.identity.authentication!=='API_KEY'||output.identity.provider!==route.provider||output.identity.model!==route.model||!output.sessionId)throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
                    return{...output,identity:{...output.identity,runtime:actor.runtime,roleId:actor.id,authRef:actor.authRef,accountRef:actor.accountRef,configurationHash,routeHash:magpieRouteHash(route)}};
                }finally{
                    pi?.close();
                    try{await broker?.close();}catch{/* broker already closed by the runner */}
                    try{await gateway.close();}finally{this.warning();}
                }
            },args.signal);
        }};
    }
    /** Custom executor harness: the installed Claude Code CLI, with its own tools, on the native
     * Messages lane. It is the second executor leg whose tools are the harness's own rather than
     * the DM broker's desk_* intents, so the audit it can produce is process-level only: argv,
     * cwd, exit code, tool_use/tool_result counts and a workspace file diff. See
     * providers/claude-executor.ts for the exact boundary and how it differs from desk_* calls. */
    private customClaudeExecutor(input:AgentInput,actor:ReturnType<typeof customRoleConfiguration>,assertCurrent:()=>void,configurationHash:string):Runner{
        if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        if(actor.runtime!=='claude'||input.role!=='executor')throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409,'Claude Code 只在执行器回合担任该角色。');
        const model=actor.model.id;let used=false;
        return{run:async(args,emit)=>{
            if(used)throw new DomainError('CUSTOM_ROLE_TURN_ALREADY_USED',409);
            if(args.role!==input.role||args.runId!==input.runId||args.workspace!==input.workspace||args.model!==input.model||args.signal!==input.signal)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            used=true;assertCurrent();
            const {op,budget}=this.configured();
            return this.withCustomRunMagpieControl(args,async(session,_binding,signal)=>{
                assertCurrent();
                const route=this.qualifiedCustomMagpieRoute(session,args,actor);
                // Two outlets, one CLI. The harness's own Messages wire is the native passthrough and
                // keeps its reviewed-build evidence; a model that declares only an OpenAI wire is the
                // translated outlet, where this product builds the upstream body and rebuilds the
                // CLI's Messages answer. Who serves which is the resolved protocol, never a guess.
                if(route.protocol!=='anthropic-messages'&&route.protocol!=='openai-responses'&&route.protocol!=='chat-completions')
                    throw new DomainError('CUSTOM_ROLE_MODEL_NOT_WIRED',409);
                const channel=new MagpieDshRequestTransport({session,budget,route,role:'executor',transport:this.context.fetch,bindRequest:payload=>{assertCurrent();return customModelRequestBinding(this.context.store,this.context.getConfig(),args,currentProcessOwnership(),payload.route,payload.bodyHash);},assertCurrent:()=>{assertCurrent();}});
                const quote=()=>{assertCurrent();const q=this.readRef(this.customPriceRef('executor',actor.provider,model)) as NativePrice;
                    assertNativePriceForRoute(q,{provider:actor.provider,model,currency:'CNY'});
                    if(budget.requests().length>=op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);return q;};
                // One executor turn spends one model request per tool round, so the ceiling is the
                // frozen per-run ceiling rather than the read-only supervisor's single request.
                const gateway=new DeepSeekGateway(budget,quote,'',op.maxOutputTokens,Math.min(op.maxRequests,200),this.context.fetch??fetch,'anthropic-messages',false,undefined,undefined,undefined,channel,undefined,model);
                try{
                    const address=await gateway.start();
                    const commandRef=op.claudeSupervisor;
                    if(!commandRef)throw new DomainError('CUSTOM_CLI_COMMAND_UNVERIFIED',409);
                    const {runClaudeExecutorTurn}=await import('./providers/claude-executor.js');
                    const observation=await runClaudeExecutorTurn({commandRef,controllerRoot:this.context.root,workspace:resolve(args.workspace),
                        gatewayUrl:address.url,gatewayToken:address.token,model,prompt:args.prompt,signal,timeoutMs:300000,maxOutputTokens:op.maxOutputTokens,assertCurrent});
                    assertCurrent();
                    // The CLI's own stream reports how many model responses it consumed. Every one
                    // of them must be a ledger row this gateway recorded: a turn that quietly spent
                    // a request outside the ledger is refused instead of being reported complete.
                    const receipts=gateway.receipts();
                    if(receipts.length!==observation.modelResponses||receipts.some(row=>row.outcome!=='COMPLETE'))
                        throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
                    const audit={method:'dm/claude-executor-audit',params:{commandLine:observation.commandLine,cwd:observation.cwd,exitCode:observation.exitCode,
                        toolUses:observation.toolUses,toolResults:observation.toolResults,deniedToolResults:observation.deniedToolResults,fileChanges:observation.fileChanges}};
                    this.context.store.record('NativeBudgetReceipt',this.context.store.run(args.runId).projectId,args.runId,audit);emit(audit);
                    const last=receipts.at(-1)!;
                    return{text:observation.text,sessionId:observation.sessionId,model:observation.model,
                        usage:{role:'executor',requestId:last.id,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN' as const},
                        identity:{runner:'CLAUDE_CODE' as const,provider:actor.provider,authentication:'API_KEY' as const,model:observation.model,runtime:actor.runtime,
                            roleId:actor.id,authRef:actor.authRef,accountRef:actor.accountRef,configurationHash,routeHash:magpieRouteHash(route)}};
                }finally{
                    try{await gateway.close();}finally{
                        const event={method:'dm/budget',params:{requests:gateway.receipts()}};
                        this.context.store.record('NativeBudgetReceipt',this.context.store.run(args.runId).projectId,args.runId,event);emit(event);this.warning();
                    }
                }
            },args.signal);
        }};
    }
    /** Custom executor harness: the installed OpenCode or Cline CLI, with its own tools, on the
     * native Messages lane. Same process-level audit as the Claude leg (argv, cwd, exit code, tool
     * counts, workspace diff) because the tools are the CLI's own rather than broker desk_* intents.
     * See providers/cli-executor.ts for the exact boundary and the two sandbox differences: Cline
     * has no selective command deny, so its run_commands tool is not fenced like OpenCode's bash —
     * the product stops the turn when the CLI's own stream reports an installer, and refuses the
     * turn outright when a git reference moved. */
    private customCliExecutor(input:AgentInput,actor:ReturnType<typeof customRoleConfiguration>,assertCurrent:()=>void,configurationHash:string):Runner{
        if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        const runtime=actor.runtime;
        if((runtime!=='opencode'&&runtime!=='cline'&&runtime!=='codex')||input.role!=='executor')throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409,'OpenCode、Cline 与 Codex 只在执行器回合担任该角色。');
        const model=actor.model.id;let used=false;
        return{run:async(args,emit)=>{
            if(used)throw new DomainError('CUSTOM_ROLE_TURN_ALREADY_USED',409);
            if(args.role!==input.role||args.runId!==input.runId||args.workspace!==input.workspace||args.model!==input.model||args.signal!==input.signal)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            used=true;assertCurrent();
            const {op,budget}=this.configured();
            return this.withCustomRunMagpieControl(args,async(session,_binding,signal)=>{
                assertCurrent();
                const route=this.qualifiedCustomMagpieRoute(session,args,actor);
                // Same two outlets as the Claude leg: the harness's own wire is the native
                // passthrough, and a model that declares only an OpenAI wire is the translated one.
                const native=route.protocol===(runtime==='codex'?'openai-responses':'anthropic-messages');
                if(!native&&route.protocol!=='chat-completions'&&!(runtime!=='codex'&&route.protocol==='openai-responses'))
                    throw new DomainError('CUSTOM_ROLE_MODEL_NOT_WIRED',409);
                const channel=new MagpieDshRequestTransport({session,budget,route,role:'executor',transport:this.context.fetch,bindRequest:payload=>{assertCurrent();return customModelRequestBinding(this.context.store,this.context.getConfig(),args,currentProcessOwnership(),payload.route,payload.bodyHash);},assertCurrent:()=>{assertCurrent();}});
                const quote=()=>{assertCurrent();const q=this.readRef(this.customPriceRef('executor',actor.provider,model)) as NativePrice;
                    assertNativePriceForRoute(q,{provider:actor.provider,model,currency:'CNY'});
                    if(budget.requests().length>=op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);return q;};
                // One executor turn spends one model request per tool round, exactly as the Claude leg.
                // The wire this gateway serves is always the CLI's own: a translated route changes the
                // upstream the product builds, never the dialect the installed CLI reads.
                const gateway=new DeepSeekGateway(budget,quote,'',op.maxOutputTokens,Math.min(op.maxRequests,200),this.context.fetch??fetch,runtime==='codex'?'responses':'anthropic-messages',false,undefined,undefined,undefined,channel,undefined,model);
                try{
                    const address=await gateway.start();
                    const commandRef=op.customTextCli?.[runtime];
                    if(!commandRef)throw new DomainError('CUSTOM_CLI_COMMAND_UNVERIFIED',409);
                    const {runCliExecutorTurn}=await import('./providers/cli-executor.js');
                    const observation=await runCliExecutorTurn({runtime,commandRef,controllerRoot:this.context.root,workspace:resolve(args.workspace),
                        gatewayUrl:address.url,gatewayToken:address.token,model,prompt:args.prompt,signal,timeoutMs:300000,maxOutputTokens:op.maxOutputTokens,assertCurrent});
                    assertCurrent();
                    // The CLI's own stream reports how many model rounds it consumed. Every one of
                    // them must be a ledger row this gateway recorded.
                    const receipts=gateway.receipts();
                    if(receipts.length!==observation.modelResponses||receipts.some(row=>row.outcome!=='COMPLETE'))
                        throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
                    // Process-level record, never a desk_* trail. Cline's 25 built-in tools are its
                    // own and cannot be routed through the broker, so what this row carries is the
                    // argv, cwd, exit code, the CLI's tool-call counts (per tool name, and how many
                    // were refused), the workspace change list with its diff summary, and the
                    // git-ref verdict — and it states inside itself that no per-call approval
                    // exists for it. The three flat counters stay for the consumers that already
                    // read this event.
                    const audit={method:'dm/cli-executor-audit',params:{...observation.audit,
                        toolUses:observation.toolUses,toolResults:observation.toolResults,deniedToolResults:observation.deniedToolResults}};
                    this.context.store.record('NativeBudgetReceipt',this.context.store.run(args.runId).projectId,args.runId,audit);emit(audit);
                    const last=receipts.at(-1)!;
                    return{text:observation.text,sessionId:observation.sessionId,model:observation.model,
                        usage:{role:'executor',requestId:last.id,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN' as const},
                        identity:{runner:CUSTOM_CLI_RUNNERS[runtime],provider:actor.provider,authentication:'API_KEY' as const,model:observation.model,runtime:actor.runtime,
                            roleId:actor.id,authRef:actor.authRef,accountRef:actor.accountRef,configurationHash,routeHash:magpieRouteHash(route)}};
                }finally{
                    try{await gateway.close();}finally{
                        const event={method:'dm/budget',params:{requests:gateway.receipts()}};
                        this.context.store.record('NativeBudgetReceipt',this.context.store.run(args.runId).projectId,args.runId,event);emit(event);this.warning();
                    }
                }
            },args.signal);
        }};
    }
    custom(input:AgentInput):Runner {
        const selected=this.customRunAccountSelection(input,currentProcessOwnership());this.assertCustomReady(selected.snapshot);
        const fingerprint=(value:AgentInput)=>hash({role:value.role,workspace:value.workspace,model:value.model,specHash:value.specHash,runId:value.runId,executorSliceId:value.executorSliceId,executorRoleId:value.executorRoleId,taskId:value.taskId,repairRound:value.repairRound,laya:value.laya,outputSchema:value.outputSchema}),expected=fingerprint(input);
        let consumed=false;
        return{run:async(args,emit)=>{
            if(fingerprint(args)!==expected)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            if(consumed)throw new DomainError('CUSTOM_ROLE_TURN_ALREADY_USED',409);
            const scope=currentProcessOwnership(),current=this.customRunAccountSelection(args,scope),{op,budget}=this.configured();this.assertCustomReady(current.snapshot);
            const actor=customRoleConfiguration(current.snapshot,args.role,args.executorRoleId),role=args.role as 'planner2'|'executor'|'reviewer';
            this.requireUserBudget(current.snapshot.projectId,this.context.store.project(current.snapshot.projectId).specId??undefined);
            consumed=true;
            const assertCurrent=()=>{
                if(args.signal.aborted||currentProcessOwnership()!==scope)throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);
                const next=this.customRunAccountSelection(args,scope);
                if(hash(next.snapshot)!==hash(current.snapshot))throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);
                this.assertCustomReady(next.snapshot);this.requireUserBudget(next.snapshot.projectId,this.context.store.project(next.snapshot.projectId).specId??undefined);
            };
            if(actor.runtime==='codex'){
                // Codex's executor leg is a separate process binding: `codex exec` on the native
                // Responses wire, never the read-only app-server adapter the supervision lane uses
                // (codex-transport.ts codexSupervisorFeatures disables shell/unified exec there). The
                // binding must be pinned like the other CLI commands, so an operator that has not
                // declared one keeps the lane closed instead of driving the adapter as an executor.
                if(role==='executor'){
                    if(op.customTextCli?.codex)return this.customCliExecutor(args,actor,assertCurrent,hash(current.snapshot)).run(args,emit);
                    throw new DomainError('CUSTOM_CLI_COMMAND_UNVERIFIED',409,'Codex 执行器需要操作员固定 codex exec 的命令绑定（customTextCli.codex），当前配置未提供。');
                }
                if(actor.transport!=='magpie'){
                    assertCurrent();
                    return this.customCodex(args,actor,assertCurrent,hash(current.snapshot)).run(args,emit);
                }
                const subscription=actor.authentication==='oauth';
                // Subscription planning uses the original dedicated CLI home and account pin.
                // API-key planning uses a separate per-run home.
                assertCurrent();
                return this.withCustomRunMagpieControl(args,async(session,_binding,signal)=>{
                    assertCurrent();
                    const route=this.qualifiedCustomMagpieRoute(session,args,actor);
                    const pin=this.customSubscriptionScope(current.snapshot,args);
                    if(subscription&&(!pin||route.upstreamAccountRef!=='openai/'+pin.accountFingerprint))throw new DomainError('CUSTOM_SUBSCRIPTION_ACCOUNT_BINDING_CHANGED',409);
                    let turn:CodexIncludedTurn|undefined,preparedPrompt:string|undefined;
                    const limits=(prompt:string)=>({model:route.model,maxOutputTokens:op.maxOutputTokens,prompt,
                        instructions:readFileSync(within(this.context.root,'prompts/'+role+'.md'),'utf8')+roleSkillBlock(this.context.root,this.context.store,current.snapshot.projectId,role),outputSchema:args.outputSchema});
                    const planner=subscription?limits(args.prompt):route.protocol==='openai-responses'?()=>{
                        if(!preparedPrompt)throw new DomainError('CUSTOM_CODEX_PROMPT_UNVERIFIED',409);
                        return limits(preparedPrompt);
                    }:undefined;
                    // Protocol dispatch: a Messages-only model keeps Codex on Responses locally and
                    // translates the frozen turn inside this transport. It replaces the Chat/Responses
                    // planner binding above, which this lane never uses.
                    const codexSupervisor=route.protocol==='anthropic-messages'?{
                        prompt:()=>{
                            if(!preparedPrompt)throw new DomainError('CUSTOM_CODEX_PROMPT_UNVERIFIED',409);
                            return preparedPrompt;
                        },
                        instructions:limits(args.prompt).instructions,assertCurrent,signal}:undefined;
                    if(codexSupervisor&&!supportsCodexSupervisorBuild(session.observation.binaryHash))throw new DomainError('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE',409);
                    const channel=new MagpieDshRequestTransport({session,budget,route,role,planner,codexSupervisor,transport:this.context.fetch,bindRequest:payload=>{assertCurrent();return customModelRequestBinding(this.context.store,this.context.getConfig(),args,scope,payload.route,payload.bodyHash);},assertCurrent:()=>{assertCurrent();}});
                    const quote=()=>{assertCurrent();const q=this.readRef(this.customPriceRef(role,actor.provider,actor.model.id)) as NativePrice;
                        assertNativePriceForRoute(q,{provider:actor.provider,model:actor.model.id,currency:'CNY'});
                        if(budget.requests().length>=op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);return q;};
                    // Codex speaks Responses locally. The owned route selects native Responses
                    // or the supported upstream chat conversion for this exact model.
                    const gateway=new DeepSeekGateway(budget,quote,'',op.maxOutputTokens,subscription?1:Math.min(op.maxRequests,200),this.context.fetch??fetch,'responses',false,undefined,undefined,undefined,channel,undefined,actor.model.id,subscription?()=>{
                        assertCurrent();if(!turn)throw new DomainError('CODEX_INCLUDED_TURN_INVALID',409);
                        if(budget.requests().length>=op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);
                        return turn;
                    }:undefined);
                    try{
                        const address=await gateway.start(),
                            home=subscription?{dir:this.context.getConfig().codex.home}:prepareCodexMagpieHome(this.context.root,args.runId,{model:actor.model.id,baseUrl:address.url,envKey:'DM_GATEWAY_TOKEN'}),
                            config=():Config=>{const c=this.context.getConfig();return{...c,codex:{...c.codex,home:home.dir,model:actor.model.id}};},
                            runner=new CodexRunner(config,this.context.root,false,extra=>this.context.childEnvironment?.({...extra,DM_GATEWAY_TOKEN:address.token})??childEnv({...extra,DM_GATEWAY_TOKEN:address.token}),pin?.accountFingerprint,this.context.observeCodexRequestRoute,subscription?'chatgpt':'api_key','magpie',subscription?address.url:undefined,subscription?value=>{turn=value;}:undefined,prompt=>{preparedPrompt=prompt;},route.provider);
                        const out=await runner.run({...args,signal},emit);
                        assertCurrent();
                        if(!out.identity||out.identity.runner!=='CODEX_CLI'||out.observation.provider!=='magpie'||out.identity.provider!==(role==='reviewer'?route.provider:'magpie')||out.identity.authentication!==(subscription?'CHATGPT_SUBSCRIPTION':'API_KEY')||out.identity.model!==actor.model.id||!out.sessionId)throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
                        gateway.confirmedSupervisorOutput(out.identity.model,out.text);
                        return{...out,identity:{...out.identity,provider:channel.provider,runtime:actor.runtime,roleId:actor.id,authRef:actor.authRef,accountRef:actor.accountRef,configurationHash:hash(current.snapshot),routeHash:magpieRouteHash(route)}};
                    }finally{
                        try{await gateway.close();}finally{
                            const event={method:'dm/budget',params:{requests:gateway.receipts()}};
                            this.context.store.record('NativeBudgetReceipt',this.context.store.run(args.runId).projectId,args.runId,event);emit(event);this.warning();
                        }
                    }
                },args.signal);
            }
            if(actor.runtime==='kimi'){
                if(role!=='reviewer')throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409,'Kimi 只担任 Custom 审查角色。');
                assertCurrent();
                const runner=await openCustomKimiRunner({root:this.context.root,dataRoot:dirname(this.context.store.path),getConfig:this.context.getConfig,
                    actor:{role:'reviewer',roleId:actor.id,provider:actor.provider,model:actor.model.id,authRef:actor.authRef,accountRef:actor.accountRef},
                    configurationHash:hash(current.snapshot),assertCurrent});
                return runner.run(args,emit);
            }
            if(actor.runtime==='claude'&&role==='executor'){
                // Claude Code is the CLI whose headless mode is a real executor: it writes inside
                // its working directory and refuses out-of-tree writes, denied tools and git push
                // (docs/CLI_EXECUTOR_FEASIBILITY.md; reproduce with scripts/probe-claude-executor.mjs).
                // The model leg is the native Messages lane with tools in the body, and the lane
                // stays closed until supportsClaudeExecutorBuild carries a build digest that proved
                // exactly this turn end to end. Read-only Claude roles keep their old path below.
                assertCurrent();
                return this.customClaudeExecutor(args,actor,assertCurrent,hash(current.snapshot)).run(args,emit);
            }
            if((actor.runtime==='opencode'||actor.runtime==='cline')&&role==='executor'){
                // OpenCode and Cline are tool-bearing executors on the native Messages wire, exactly
                // like Claude Code: their own edit/shell tools run inside the flows workspace while
                // the model leg stays metered by the DM-owned Magpie. The lane is gated by its own
                // reviewed build digest, so an unregistered build fails at the transport, not here.
                assertCurrent();
                return this.customCliExecutor(args,actor,assertCurrent,hash(current.snapshot)).run(args,emit);
            }
            if(actor.runtime==='independent'||actor.runtime==='claude'||isCustomTextCliRuntime(actor.runtime)){
                if(role==='executor')throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409,'该运行器没有带工具的模型腿，不能担任执行器。');
                assertCurrent();
                return(actor.transport==='magpie'?this.customTextMagpie(args,actor,assertCurrent,hash(current.snapshot)):this.customIndependent(args,actor,assertCurrent,hash(current.snapshot))).run(args,emit);
            }
            if(actor.runtime==='pi'){
                assertCurrent();
                return this.customPi(args,role,actor,assertCurrent,hash(current.snapshot)).run(args,emit);
            }
            // Any other runtime must never fall back to DSH or Codex.
            if(actor.runtime!=='dsh')throw new DomainError('CUSTOM_ROLE_RUNTIME_NOT_WIRED',409,'该 Custom 角色运行器尚未接线；不会退回 DSH 或 Codex。');
            return this.withCustomRunMagpieControl(args,async(session,_binding,signal)=>{
                assertCurrent();const route=this.qualifiedCustomMagpieRoute(session,args,actor);
                // Protocol dispatch: the native Messages route keeps the byte-identical passthrough.
                // A supervision role keeps its single terminal tool on either OpenAI wire, and an
                // executor keeps every tool round trip on either of them too: the resolved protocol
                // selects the outlet. Both translated lanes live inside this transport and fail
                // closed on any other shape.
                const supervisorTranslated=route.protocol!=='anthropic-messages'&&role!=='executor';
                const executorTranslated=role==='executor'&&route.protocol!=='anthropic-messages';
                if(route.protocol!=='anthropic-messages'&&!supervisorTranslated&&!executorTranslated)throw new DomainError('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE',409);
                const channel=new MagpieDshRequestTransport({session,budget,route,role,transport:this.context.fetch,supervisor:supervisorTranslated?true:undefined,dshExecutor:executorTranslated?true:undefined,bindRequest:payload=>{assertCurrent();return customModelRequestBinding(this.context.store,this.context.getConfig(),args,scope,payload.route,payload.bodyHash);},assertCurrent:()=>{assertCurrent();}});
                const quote=()=>{assertCurrent();const q=this.readRef(this.customPriceRef(role,actor.provider,actor.model.id)) as NativePrice;
                    assertNativePriceForRoute(q,{provider:actor.provider,model:actor.model.id,currency:'CNY'});
                    if(budget.requests().length>=op.maxRequests)throw new DomainError('NATIVE_TOTAL_REQUEST_LIMIT',409);return q;};
                // Product supervision uses Gateway's single terminal-tool allowlist;
                // the separate opaque minimal-probe path remains entirely tool-free.
                const gateway=new DeepSeekGateway(budget,quote,'',op.maxOutputTokens,Math.min(op.maxRequests,200),this.context.fetch??fetch,'anthropic-messages',false,undefined,undefined,undefined,channel,undefined,route.model);
                try{
                    const address=await gateway.start(),runner=new DshRunner(this.context.getConfig,this.context.root,async()=>({...address,close:()=>gateway.close(),receipts:()=>gateway.receipts()}),async()=>{
                        // The engine binds the executor to a slice workspace, yet the delivery still landed in the canonical
                        // tree and the merge answered EXTERNAL_WORKSPACE_CHANGE. State the slice id this layer actually got.
                        if(role==='executor')process.stderr.write('EXECUTOR_TOOL_BINDING '+JSON.stringify({executorSliceId:(args as {executorSliceId?:string}).executorSliceId??null,runId:args.runId})+'\n');
                        assertCurrent();const base=role==='executor'?await createExecutorTools(this.context.store,this.context.getConfig,args.runId,op.files,new WslSandbox(this.context.root),input.executorSliceId):undefined;
                        return openDshRoleTools({root:this.context.root,role,roleId:actor.id,provider:route.provider,model:route.model,configurationHash:hash(current.snapshot),runId:args.runId,specHash:args.specHash,modelURL:address.url,contextTokens:quote().maxInputTokens,template:op.template,profileBinding:op.profileBinding,sdkToolsModule:op.sdkToolsModule,maxOutputTokens:op.maxOutputTokens,
                            controller:customProductTools(role,actor.permissions,base,assertCurrent,signal)});
                    },{role,roleId:actor.id,provider:route.provider,model:route.model,assertCurrent,requireTerminal:role==='planner2'||role==='reviewer'});
                    const output=await runner.run({...args,signal},event=>{if(event&&typeof event==='object'&&(event as {method?:unknown}).method==='dm/budget')this.context.store.record('NativeBudgetReceipt',current.snapshot.projectId,current.snapshot.runId,event);emit(event);});assertCurrent();
                    if(!output.identity||output.identity.runner!=='DSH'||output.identity.provider!==route.provider||output.identity.model!==route.model||!output.sessionId)throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
                    return{...output,identity:{...output.identity,runtime:actor.runtime,roleId:actor.id,authRef:actor.authRef,accountRef:actor.accountRef,configurationHash:hash(current.snapshot),routeHash:magpieRouteHash(route)}};
                }finally{await gateway.close();this.warning();}
            },args.signal);
        }};
    }
    executor(input:AgentInput):Runner {
        this.assertReady('executor');
        const r=this.context.store.run(input.runId);
        this.requireUserBudget(r.projectId,r.specId);
        const assignment=input.executorSliceId?boundExecutorAssignment(this.context.store,r.id,input.executorSliceId):undefined;
        if(input.role!=='executor'||r.specHash!==input.specHash||resolve(assignment?.workspace??r.workspace)!==resolve(input.workspace)||input.executorRoleId!==undefined&&input.executorRoleId!==executorRoleForTurn(r,assignment))throw new DomainError('NATIVE_RUN_BINDING_CHANGED',409);
        return this.executorRunner(input,{projectId:r.projectId,runId:r.id},false);
    }
    private executorRunner(input:AgentInput,scope:{projectId:string|null;runId:string|null;acceptanceId?:string},minimumProbe:boolean,engineering?:{input:DshEngineeringInput;permit:EngineeringBudgetPermit;assertCurrent:()=>void}):Runner {
        const permit=minimumProbe?this.probePermits.getStore():undefined;
        if(minimumProbe&&!permit)throw new DomainError('NATIVE_PROBE_PERMIT_REQUIRED',409);
        const ownership=minimumProbe?undefined:currentProcessOwnership();
        if(!minimumProbe&&!ownership)throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);
        this.assertReady('executor',undefined,minimumProbe,engineering?.permit);const {op,budget}=this.configured();
        // The ceiling must MATCH the frozen profile and the template (the adapter refuses a mismatch), so
        // both run kinds use op.maxOutputTokens. A probe stays minimal by contract instead of by budget:
        // no tools are exposed and the answer must echo the challenge exactly. Capping the number only
        // here made every real binding unusable for a probe (NATIVE_FROZEN_PROFILE_CHANGED).
        const outputCeiling=op.maxOutputTokens;
        let gateway:DeepSeekGateway|undefined,modelURL='';
        const runner=new DshRunner(this.context.getConfig,this.context.root,async()=>{
            engineering?.assertCurrent();this.assertReady('executor',undefined,minimumProbe,engineering?.permit);
            // The gateway has a per-run bound within the lifetime operator ceiling. A minimum probe
            // gets exactly one upstream request; ordinary Executor turns remain bounded at 200.
            const maximumRequests=minimumProbe?1:engineering?8:Math.min(op.maxRequests,200);
            const apiKey=this.context.getSecret?.(this.context.getConfig().dsh.keyEnv)??process.env[this.context.getConfig().dsh.keyEnv]!;
            gateway=new DeepSeekGateway(budget,()=>this.quote('executor',undefined,permit,engineering?.permit),apiKey,outputCeiling,maximumRequests,this.executorTransport(),'anthropic-messages',minimumProbe,permit,
                minimumProbe||engineering?undefined:bodyHash=>{
                    if(budget.repairRevision(input.runId)!==this.context.store.run(input.runId).repairCount)throw new DomainError('NATIVE_REPAIR_BINDING_MISMATCH',409);
                    return executorModelRequestBinding(this.context.store,this.context.getConfig(),input,ownership,bodyHash);
                },engineering?{permit:engineering.permit,assertCurrent:engineering.assertCurrent}:undefined);
            const address=await gateway.start();modelURL=address.url;
            return{...address,receipts:()=>gateway!.receipts(),close:async()=>{await gateway!.close();this.warning();}};
        },async()=>{
            let broker:Awaited<ReturnType<typeof startToolBroker>>|undefined;
            try{
                const controller=minimumProbe?{async dispatch(){throw new DomainError('NATIVE_MINIMUM_TOOL_DENIED',403);}}:engineering?
                    await createDshEngineeringTools(engineering.input,op.files,new WslSandbox(this.context.root),engineering.assertCurrent,
                        (kind,data)=>this.context.store.record(kind,null,null,{acceptanceId:engineering.input.acceptanceId,...data}),()=>this.engineeringJournal(engineering.input.acceptanceId)):
                    await createExecutorTools(this.context.store,this.context.getConfig,input.runId,op.files,new WslSandbox(this.context.root),input.executorSliceId);
                broker=await startToolBroker(controller);
                const parent=within(this.context.root,'.runtime/native-dispatches');mkdirSync(parent,{recursive:true});
                const directory=mkdtempSync(resolve(parent,'owned-'));
                const profileModule=await import(pathToFileURL(resolve(this.context.root,'adapters/dsh-native-profile.mjs')).href);
                const profile=profileModule.buildNativeProfile(directory,op.profileBinding,{modelURL,maxTokens:outputCeiling,
                    contextTokens:this.quote('executor',undefined,permit,engineering?.permit).maxInputTokens,pluginURL:pathToFileURL(resolve(this.context.root,'adapters/dsh-tools-plugin.mjs')).href});
                const configPath=resolve(directory,'tool-client.json');
                writeFileSync(configPath,JSON.stringify({schema:'dream-maker.dsh-tool-client.v1',sdkCommit:op.profileBinding.sdkCommit,
                    sdkToolsModule:op.sdkToolsModule,toolUrl:broker.url,dependencies:[{path:op.sdkToolsModule,sha256:hash(readFileSync(op.sdkToolsModule))}]}),{flag:'wx',mode:0o600});
                const dispatchPath=resolve(directory,'dispatch-binding.json');
                writeFileSync(dispatchPath,JSON.stringify({schema:'dream-maker.archon-dispatch.v1',runId:input.runId,specHash:input.specHash,template:op.template,
                    launch:{dshHome:profile.home,controlRoot:directory,profileManifestPath:profile.manifestPath,profileManifestSha256:profile.manifestSha256}}),{flag:'wx',mode:0o600});
                const owned=broker;
                return{url:owned.url,token:owned.token,configPath,configSha256:hash(readFileSync(configPath)),dispatchPath,dispatchSha256:hash(readFileSync(dispatchPath)),close:()=>owned.close()};
            }catch(error){await broker?.close();throw error;}
        });
        const owned:Runner={run:async(args,emit)=>{
            if(this.closed||this.stopping||this.active.size)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
            const controller=new AbortController(),pending=runner.run({...args,signal:AbortSignal.any([args.signal,controller.signal])},event=>{
                if(event&&typeof event==='object'&&(event as {method?:string}).method==='dm/budget')this.context.store.record('NativeBudgetReceipt',scope.projectId,scope.runId,scope.acceptanceId?{acceptanceId:scope.acceptanceId,event}:event);
                emit(event);
            });
            this.active.set(controller,pending);try{return await pending;}catch(error){if(cleanupUncertain(error))this.cleanupUncertain=true;throw error;}finally{this.active.delete(controller);}
        }};
        return owned;
    }
    /** The DSH tool host remains local; its external model leg is owned by this
     * Windows gateway and must carry executor attribution when CFW is active. */
    private executorTransport(): typeof fetch {
        return this.context.fetchForRole?.('executor') ?? this.context.fetch ?? fetch;
    }
    /** No Codex account/cache access, model request or role-proof promotion. */
    dshEngineeringPreparation():DshEngineeringPreparation {
        const {op}=this.configured(),c=this.context.getConfig();
        if(c.laya.mode!=='off'||c.dsh.model!=='deepseek-flash'||c.clash?.enabled)throw new DomainError('ENGINEERING_ACCEPTANCE_ROUTE_INVALID',409);
        return{contractHash:dshEngineeringContractHash,configurationHash:hash({purpose:'DSH_EXECUTOR_COMPONENT_ONLY',dsh:c.dsh,laya:c.laya,limits:c.limits,
            operatorHash:this.operatorHash,auditHash:hash(readFileSync(c.nativeAuditPath)),server:treeHash(within(this.context.root,'dist/server')),adapters:treeHash(within(this.context.root,'adapters')),
            workerHash:hash(readFileSync(within(this.context.root,'scripts/isolation/wsl-worker.py'))),resourceHelper:hash(readFileSync(within(this.context.root,'scripts/isolation/wsl-resource-context.py'))),files:op.files})};
    }
    private engineeringJournal(acceptanceId:string){return this.context.store.db.prepare("SELECT id,kind,data FROM records WHERE project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.acceptanceId')=? ORDER BY rowid LIMIT 257").all(acceptanceId)
        .map(row=>({id:String(row.id),kind:String(row.kind),data:JSON.parse(String(row.data)) as Record<string,unknown>}));}
    private assertEngineeringCurrent(input:DshEngineeringInput,kind:'executor'|'verifier'){
        const ownership=currentProcessOwnership(),preparation=this.dshEngineeringPreparation(),rows=this.engineeringJournal(input.acceptanceId),intents=rows.filter(r=>r.kind==='EngineeringAcceptanceIntent');
        if(input.signal.aborted||this.stopping||this.closed||rows.length>256||intents.length!==1||!ownership||ownership.store!==this.context.store||ownership.mode!=='live'||ownership.projectId!==null||ownership.runId!==null||ownership.acceptanceId!==input.acceptanceId||
            input.contractHash!==preparation.contractHash||input.configurationHash!==preparation.configurationHash||intents[0].data.contractHash!==input.contractHash||intents[0].data.configurationHash!==input.configurationHash||intents[0].data.workspace!==input.workspace||
            input.workspace!==within(this.context.root,`.runtime/engineering-acceptance/${input.acceptanceId}/workspace`)||rows.some(r=>r.kind==='EngineeringAcceptanceResult'))throw new DomainError('ENGINEERING_ACCEPTANCE_STALE',409);
        const grant=rows.filter(r=>r.kind==='DispatchGranted'&&r.data.dispatchId===ownership.dispatchId&&r.data.generation===ownership.generation);
        if(grant.length!==1||grant[0].data.kind!==kind||rows.some(r=>['DispatchFinished','DispatchReconciled'].includes(r.kind)&&r.data.dispatchId===ownership.dispatchId))throw new DomainError('ENGINEERING_ACCEPTANCE_STALE',409);
        return ownership;
    }
    async executeDshEngineering(input:DshEngineeringInput,emit:(event:unknown)=>void):Promise<DshEngineeringStage>{
        const ownership=this.assertEngineeringCurrent(input,'executor'),{budget}=this.configured();
        const permit=budget.beginEngineeringAcceptance({schema:'dream-maker.dsh-engineering-budget.v1',acceptanceId:input.acceptanceId,contractHash:input.contractHash,configurationHash:input.configurationHash,dispatchId:ownership.dispatchId,generation:ownership.generation});
        try{
            // runId/specHash are bridge correlation fields only; no user Run/Spec/approval is created.
            const args:AgentInput={runId:input.acceptanceId,specHash:input.contractHash,workspace:input.workspace,role:'executor',model:'deepseek-flash',prompt:dshEngineeringContract().task,
                laya:{role:'executor',mode:'off',adoption:'off',label:null,reason:'ENGINEERING_ACCEPTANCE_LAYA_OFF',latencyMs:0,inputHash:hash(dshEngineeringContract().task),modelRevision:null,confidence:null,cached:false},signal:input.signal};
            const output=await this.executorRunner(args,{projectId:null,runId:null,acceptanceId:input.acceptanceId},false,{input,permit,assertCurrent:()=>{this.assertEngineeringCurrent(input,'executor');}}).run(args,emit);
            this.assertEngineeringCurrent(input,'executor');
            const requests=budget.requests().filter(r=>r.engineeringAcceptance?.acceptanceId===input.acceptanceId);
            if(output.identity?.runner!=='DSH'||output.identity.provider!=='deepseek-official'||output.identity.model!=='deepseek-flash'||!output.sessionId||requests.length<1||requests.length>8||requests.some(r=>r.usageStatus==='PENDING'))throw new DomainError('ENGINEERING_EXECUTOR_IDENTITY_UNVERIFIED',409);
            const artifacts=dshEngineeringArtifacts(input,this.engineeringJournal(input.acceptanceId));
            return{output,sourceHash:artifacts.sourceHash,ledgerRequestIds:requests.map(r=>r.id),requests};
        }finally{budget.endEngineeringAcceptance(permit);}
    }
    async verifyDshEngineering(input:DshEngineeringInput){
        this.assertNativeCleanup();
        this.assertEngineeringCurrent(input,'verifier');
        if(this.active.size)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
        const controller=new AbortController(),combined={...input,signal:AbortSignal.any([input.signal,controller.signal])};
        const pending=runEngineeringVerifier(combined,new WslSandbox(this.context.root),()=>{this.assertEngineeringCurrent(combined,'verifier');});this.active.set(controller,pending);
        try{return await pending;}catch(error){if(cleanupUncertain(error))this.cleanupUncertain=true;throw error;}finally{this.active.delete(controller);}
    }
    private probeBinding():ProbeBinding{
        const {op}=this.configured(),c=this.context.getConfig(),authority=this.readRef(op.authority) as BudgetAuthority;
        const custody=selectProbeCustody(op.probeCustody,c.codex);
        const source={server:treeHash(within(this.context.root,'dist/server')),adapters:treeHash(within(this.context.root,'adapters')),
            prompts:treeHash(within(this.context.root,'prompts')),host:hash(readFileSync(within(this.context.root,'scripts/dsh-host.mjs'))),
            entry:hash(readFileSync(within(this.context.root,'scripts/probe-native.mjs'))),
            codexProcessOwner:hash(readFileSync(within(this.context.root,'scripts/isolation/codex-owned-process.py'))),
            resourceHelper:hash(readFileSync(within(this.context.root,'scripts/isolation/wsl-resource-context.py'))),
            worker:hash(readFileSync(within(this.context.root,'scripts/isolation/wsl-worker.py'))),
            windowsProcessOwner:hash(readFileSync(within(this.context.root,'scripts/isolation/windows-owned-job.cs'))),
            ...probeCustodySourceBinding(custody.transport)};
        const audit=c.nativeAuditPath&&existsSync(c.nativeAuditPath)?hash(readFileSync(c.nativeAuditPath)):null;
        const credentials=(this.profile()==='ENGINEERING_ONLY'?['dsh']:['planner1','dsh']).map(role=>{const key=c[role as 'planner1'|'dsh'].keyEnv;return hash(this.context.getSecret?.(key)??process.env[key]??'');});
        const authPath=c.codex.home?resolve(c.codex.home,'auth.json'):'';
        let accountBinding:string|null=null;
        if(c.codex.permissionProfile==='dream-maker-supervisor-data'){
            // Official app-server account/read supplies actual identity. Never open its auth cache.
            // Before every product turn CodexRunner compares that identity with the signed receipt.
            accountBinding=hash({authentication:'CHATGPT_SUBSCRIPTION',home:c.codex.home});
        }else if(authPath&&existsSync(authPath)){
            const auth=JSON.parse(readFileSync(authPath,'utf8'));
            accountBinding=hash({mode:auth.auth_mode,accountId:auth.tokens?.account_id??null});
        }
        const cli=c.codex.args[0];
        const cliBinding=cli&&isAbsolute(cli)&&existsSync(cli)?hash({entry:hash(readFileSync(cli)),
            package:hash(readFileSync(resolve(cli,'../../package.json')))}):null;
        // The probe mode follows the frozen planner1 binding, not the legacy authMode field: a Kimi
        // OAuth binding is a member subscription and must never be probed as a paid API key.
        const p1=this.profile()==='ENGINEERING_ONLY'?null:planner1Binding(c);
        // Receipts bind to the WHOLE authorization document, not to one short field inside it: the
        // ledger keeps a truncated scope identity, and a probe must not inherit that truncation.
        // The oracle registry is deliberately NOT part of the executed configuration: receipts attest the
        // execution stack (adapters, prompts, prices, models, credentials), while 'which verifier plan is
        // registered for which spec' is bound by the plan's own sha256 plus the owner's approval. Including
        // the registry here made registering an approved plan invalidate every receipt.
        const operatorIdentity=hash({...op,oracles:{}});
        // Versioned identities, so that a change to ONE class of setting only invalidates what it must.
        // execution: what the model calls actually are (provider, model, adapters, prompts, prices, credentials).
        // verification: which spec/oracle plan the run is judged by.
        // policy-critical: ceilings that change how much the system may spend or how far tools may reach — an
        //   operator who raises these must re-probe, because the earlier receipts did not cover that authority.
        // policy-operational: timeouts and wall-clock windows only. Tuning those is routine operations and must
        //   NOT cost four model calls (that trap cost this project two full probe rounds).
        const rolePolicy=rolePolicyBinding(c);
        const {planner1:_p1,kimi:_kimi,...engineeringConfig}=c;
        if(!p1)rolePolicy.models.planner1=''; // User P1 has no model or authentication ID.
        const policyCritical=hash({maxRequests:op.maxRequests,maxOutputTokens:op.maxOutputTokens,repairs:authority.maxRepairs,inFlight:authority.maxInFlight,mode:authority.mode,readPaths:op.files.readPaths,writePaths:op.files.writePaths});
        const policyOperational=hash({stepTimeoutMs:c.limits.stepTimeoutMs,maxSeconds:c.limits.maxSeconds,maxCalls:c.limits.maxCalls,maxRepairs:c.limits.maxRepairs});
        const verificationIdentity=hash({oracles:op.oracles,verifier:op.template,oracleRoot:op.oracleRoot});
        return{profile:this.profile(),scopeId:authority.scopeId,authorizationHash:hash(authority),sourceHash:hash(source),
            configurationHash:hash({config:p1?c:engineeringConfig,operator:operatorIdentity,audit,credentials,accountBinding,cliBinding,p1,rolePolicy,policyCritical,verificationIdentity}),expiresAt:op.probeExpiresAt??'',
            policyCriticalHash:policyCritical,policyOperationalHash:policyOperational,verificationHash:verificationIdentity,
            planner1Mode:p1===null?'user':p1.authMethod==='oauth'?'siwc_plan':p1.authMethod==='none'?'local':'api_key',
            ...(p1?.provider==='local'?{planner1Provider:'local-ollama'}:{}),
            // The probe receipt names the provider it actually reached. Version 2 was the only route mapped
            // here, so a version-4 Seeker binding fell through to the independent fallback and could never
            // produce a verifiable planner1 receipt.
            ...((p1?.bindingVersion===2||p1?.bindingVersion===SEEKER_PLANNER1_BINDING_VERSION)&&p1.authMethod==='api_key'?{planner1Provider:p1.provider==='deepseek'?'deepseek-official':'openai-official'}:{}),
            // New probes attest the current target, regardless of preserved legacy fallback settings.
            rolePolicy:rolePolicy.rolePolicy,planner2Mode:rolePolicy.planner2Mode,
            independence:rolePolicy.independence,independentProvider:rolePolicy.independentProvider,
            models:{...rolePolicy.models,planner1:p1?.model??''}};
    }
    async prepareProbes(model:ModelProvider):Promise<void>{
        this.configured();
        if(this.probes)return;
        if(!this.preparing)this.preparing=(async()=>{
            const binding=this.probeBinding();
            if(!Number.isFinite(Date.parse(binding.expiresAt))||Date.parse(binding.expiresAt)<=Date.now())throw new DomainError('NATIVE_PROBE_EXPIRY_REQUIRED',409);
            const hasReceipts=this.configured().budget.summary().phase==='REPRESENTATIVE'||
                !!this.context.store.db.prepare("SELECT 1 FROM records WHERE kind='NativeProbeReceipt' LIMIT 1").get();
            const c=this.context.getConfig();
            const custody=selectProbeCustody(this.configured().op.probeCustody,c.codex);
            const key=custody.transport==='wsl'?await openWslProbeKey(this.context.root,hasReceipts,custody.distribution):await openProbeKey(this.context.root,hasReceipts);
            try{
                if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
                this.probes=new NativeProbes({store:this.context.store,key,current:()=>this.probeBinding(),ledger:()=>this.configured().budget.requests(),
                    invoke:(role,challenge,signal)=>this.invokeProbe(role,challenge,signal,model)});
            }finally{key.fill(0);}
        })().finally(()=>{this.preparing=undefined;});
        await this.preparing;
    }
    async probe(role:Role,signal:AbortSignal,model:ModelProvider){
        await this.prepareProbes(model);
        if(this.active.size||this.plannerTickets.size)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
        return this.probes!.run(role,signal);
    }
    async restoreProbes(model:ModelProvider):Promise<void>{
        if(!this.budget||this.failure)return;
        try{if(this.budget.summary().phase==='REPRESENTATIVE')await this.prepareProbes(model);}
        catch(error){this.context.store.event(null,null,'native.probe.restore.blocked',{code:error instanceof DomainError?error.code:'NATIVE_PROBE_RESTORE_UNAVAILABLE'});}
        if(this.context.store.db.prepare("SELECT 1 FROM records WHERE kind='NativeCustomProbeReceipt' LIMIT 1").get())try{await this.prepareCustomProbeEvidence();}
        catch(error){this.context.store.event(null,null,'native.custom.probe.restore.blocked',{code:error instanceof DomainError?error.code:'CUSTOM_PROBE_CUSTODY_UNAVAILABLE'});}
    }
    async advanceProbes(model:ModelProvider){await this.prepareProbes(model);await this.probes!.advance(this.configured().budget);}
    /** Phase, request count and per-role receipt validity, without running any probe. */
    async probeStatus(model:ModelProvider){
        const {op,budget}=this.configured();
        const base={phase:budget.summary().phase,requests:budget.requests().length,maxRequests:op.maxRequests};
        try{await this.prepareProbes(model);}
        catch(error){return{...base,roles:null,error:error instanceof DomainError?error.code:'NATIVE_PROBE_STATUS_UNAVAILABLE'};}
        return{...base,profile:this.profile(),requiredRoles:probeRoles(this.profile()),roles:this.probes!.status(),evidence:this.probes!.evidence(),error:null};
    }
    assertEmptyNativeDispatch(runId:string,dispatchId:string):void{
        this.assertNativeCleanup();if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        const {budget}=this.configured();
        if(budget.requests().some(r=>r.binding?.dispatchId===dispatchId||r.binding?.runId===runId&&r.usageStatus==='PENDING'))throw new DomainError('NATIVE_DISPATCH_REQUESTS_PRESENT',409);
    }
    async inspectInterruptedReview(input:InterruptedReviewInput,signal:AbortSignal):Promise<InterruptedReviewObservation>{
        this.assertNativeCleanup();if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
        const controller=new AbortController(),pending=inspectInterruptedCodexReview(this.context.root,this.context.getConfig(),structuredClone(input),AbortSignal.any([signal,controller.signal]),this.context.childEnvironment);
        this.active.set(controller,pending);try{return await pending;}catch(error){if(cleanupUncertain(error))this.cleanupUncertain=true;throw error;}finally{this.active.delete(controller);}
    }
    codex(input:AgentInput):Runner{
        this.assertNativeCleanup();
        if(input.role!=='planner2'&&input.role!=='reviewer')throw new DomainError('CODEX_ROLE_DENIED',403);
        if(!this.probes)throw new DomainError('NATIVE_PROBE_MISSING',409);
        const fingerprint=this.probes.codexAccountFingerprint(input.role);
        const binding={role:input.role,runId:input.runId,specHash:input.specHash,workspace:input.workspace,model:input.model,signal:input.signal};
        let consumed=false;
        return{run:async(actual,emit)=>{
            this.assertNativeCleanup();
            if(this.closed||this.stopping)throw new DomainError('NATIVE_OWNER_CLOSED',409);
            if(actual.role!==binding.role||actual.runId!==binding.runId||actual.specHash!==binding.specHash||actual.workspace!==binding.workspace||actual.model!==binding.model||actual.signal!==binding.signal)throw new DomainError('NATIVE_RUN_BINDING_CHANGED',409);
            if(consumed)throw new DomainError('NATIVE_RUN_ALREADY_DISPATCHED',409);
            consumed=true;
            const controller=new AbortController(),signal=AbortSignal.any([actual.signal,controller.signal]);
            const pending=new CodexRunner(this.context.getConfig,this.context.root,false,this.context.childEnvironment,fingerprint,this.context.observeCodexRequestRoute).run({...actual,signal},emit);
            this.active.set(controller,pending);
            try{return await pending;}catch(error){if(cleanupUncertain(error))this.cleanupUncertain=true;throw error;}finally{this.active.delete(controller);}
        }};
    }
    /** Existing scope history only. Never promotes source/role readiness or supplies a new user budget. */
    budgetStatus(){
        return this.finalBudgetStatus?{...structuredClone(this.finalBudgetStatus),readOnly:true,historyState:'FROZEN_AT_CLOSE',observedAt:this.finalBudgetAt}:
            {...this.liveBudgetStatus(),readOnly:true,historyState:'OPEN_LEDGER_HISTORY',observedAt:new Date().toISOString()};
    }
    private liveBudgetStatus(){
        if(!this.budget)return {status:'UNAVAILABLE',mode:null,requests:null,maxRequests:null,byCurrency:{}};
        const summary=this.budget.summary();
        return {status:'HISTORY_ONLY',mode:summary.mode,requests:this.budget.requests().length,maxRequests:this.operator?.maxRequests??null,byCurrency:summary.byCurrency,userBudget:this.budget.userBudgetStatus()};
    }
    configureUserBudget(limits:UserBudgetLimits,revision:number,actor:string,operation:string){
        if(this.active.size||this.plannerTickets.size)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
        return this.configured().budget.configureUserBudget(limits,revision,actor,operation);
    }
    maintenanceBusy(){return this.closed||this.active.size>0||this.plannerTickets.size>0||!!this.preparing||!!this.budget?.summary().inFlight;}
    captureBudgetState(path:string):boolean{
        if(this.maintenanceBusy())throw new DomainError('MAINTENANCE_BUSY',409);
        if(!this.budget)return false;
        this.budget.captureState(path);return true;
    }
    private requireUserBudget(projectId:string,specId?:string){
        const p=this.context.store.project(projectId),required=p.userSpendingRequired===true||(specId?this.context.store.planVersion(specId).source.userSpendingRequired===true:false);
        if(required&&!this.configured().budget.userBudgetStatus().configured)throw new DomainError('USER_BUDGET_SETUP_REQUIRED',409,'先设置普通用户费用上限；历史开发授权不会成为新项目的默认。');
    }
    /**
     * The Codex roles must run on an INDEPENDENT @openai/codex CLI, never on our own runtime. Two
     * transports are legal: the pinned Windows entry launched by this node, or the pinned Linux CLI
     * in the isolated WSL home. The Linux one exists because Codex's Windows restricted-token sandbox
     * cannot be prepared by an unelevated process, so thread/start fails there before any turn.
     * In both cases the proof is a real answer from the CLI itself, not a configuration claim.
     */
    private assertIndependentCodex(c:Config):void{
        const args=c.codex.args??[];
        if(!args.includes('app-server'))throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409);
        if((c.codex.transport??'stdio')==='wsl'){
            const distro=c.codex.wslDistro??'',binary=c.codex.wslBinary??'';
            if(!distro||!binary.startsWith('/')||binary.includes('..')||binary.includes(' '))
                throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409);
            const probe=spawnSync(c.codex.wslCommand||'wsl.exe',['-d',distro,'--exec',binary,'--version'],{encoding:'utf8',timeout:30000,env:childEnv({})});
            if(probe.status!==0)throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409,'WSL Codex CLI 没有回答 --version');
            const head=String(probe.stdout??'').trim().split(String.fromCharCode(10))[0];
            if(!/^codex-cli [0-9]+\.[0-9]+\.[0-9]+/.test(head))
                throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409,'WSL Codex CLI 版本串不是 codex-cli x.y.z');
            return;
        }
        if(!isAbsolute(c.codex.command)||!isAbsolute(args[0]??''))throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409);
        try{
            if(!statSync(c.codex.command).isFile())throw new Error('not a file');
        }catch{throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409,'独立 Node 运行时不可用');}
        if(!/(?:^|[\\/])node(?:\.exe)?$/i.test(c.codex.command))throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409);
        const entry=resolve(args[0]),packageRoot=dirname(dirname(entry)),entryRelative=relative(packageRoot,entry).split(sep).join('/');
        if(entryRelative.startsWith('..')||isAbsolute(entryRelative))throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409);
        const packagePath=resolve(packageRoot,'package.json');
        let pack:{name?:unknown;version?:unknown;bin?:unknown};
        try{
            if(statSync(packagePath).size>1000000)throw new Error('package metadata too large');
            pack=JSON.parse(readFileSync(packagePath,'utf8')) as typeof pack;
        }catch{throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409,'独立 Codex 包元数据不可用');}
        const bin=pack.bin&&typeof pack.bin==='object'?pack.bin as Record<string,unknown>:{};
        if(pack.name!=='@openai/codex'||bin.codex!==entryRelative||!/^[0-9][0-9A-Za-z.+_-]*$/.test(String(pack.version??'')))
            throw new DomainError('INDEPENDENT_CODEX_CLI_REQUIRED',409);
    }
    private async invokeProbe(role:Role,challenge:string,signal:AbortSignal,model:ModelProvider):Promise<ProbeObservation>{
        const {budget}=this.configured(),c=this.context.getConfig();
        // The unexported async context transports this probe's opaque reservation capability only.
        // Ordinary build/dispatch preflights never read it, even during an active subscription probe.
        const permit=budget.beginEvidenceRepair(role);
        try{return await this.probePermits.run(permit,()=>this.probeTurn(role,challenge,signal,model,budget,c));}
        finally{budget.endEvidenceRepair(permit);}
    }
    private async probeTurn(role:Role,challenge:string,signal:AbortSignal,model:ModelProvider,budget:NativeBudget,c:Config):Promise<ProbeObservation>{
        // Re-probing is normally confined to the PROBE phase. But a receipt binds the operator file and the
        // built server, so any legitimate operator change (registering a verifier plan, rewriting a price)
        // invalidates the stored proofs while the phase stays REPRESENTATIVE — and that used to brick the
        // ledger permanently. Stale proofs therefore re-open the probe path; valid proofs still do not.
        if(budget.summary().phase!=='PROBE'){
            const status=this.probes?.status();
            const stale=!status||probeRoles(this.profile()).some(role=>status[role].valid!==true);
            if(!stale)throw new DomainError('NATIVE_PROBE_PHASE_REQUIRED',409);
        }
        // The probe still pins its own AgentInput to Laya OFF (see below): it attests runner identity,
        // not the helper. A Live run that turns Laya on is admitted only through the controller-owned
        // qualification (flows.ts / Engine.qualifyLaya), never through this OFF/ON flag alone.
        if(role==='planner1'){
            // K02 execution gate: a planner1 probe must not reach a retired OpenAI/SIWC upstream,
            // even when a stored binding or an operator request asks for it.
            const p1=planner1Binding(c);
            assertPlanner1DispatchAllowed(p1, 'planner1_probe');
            if(p1.provider==='kimi'){
                // The active subscription leg: a real Kimi turn, accounted by credential generation.
                if(!this.context.planner1Probe)throw new DomainError('KIMI_PROBE_INVOKER_REQUIRED',409);
                this.assertReady(role,undefined,true);
                const parent=within(this.context.root,'.runtime/native-probe-work');mkdirSync(parent,{recursive:true});
                const workspace=mkdtempSync(resolve(parent,'owned-')),before=treeHash(workspace);
                const observation=await this.context.planner1Probe(challenge,signal,workspace);
                if(treeHash(workspace)!==before)throw new DomainError('NATIVE_PROBE_SOURCE_CHANGED',409);
                return observation;
            }
            if(p1.provider==='local'){
                this.assertReady(role,undefined,true);
                const out=await model.probe(challenge,signal),observed=out.observation;
                if(!observed||observed.runner!=='LOCAL_HTTP'||observed.provider!=='local-ollama'||observed.authentication!=='NONE'||observed.ledgerRequestId)
                    throw new DomainError('NATIVE_PROBE_LOCAL_UNVERIFIED',409);
                return{role,model:observed.model,runner:'LOCAL_HTTP',provider:'local-ollama',authentication:'NONE',
                    responseId:observed.responseId,responseHash:observed.responseObjectHash,ledgerRequestIds:[],
                    paidFallback:false,cleanupReturned:true,reply:typeof out.data.probe==='string'?out.data.probe:''};
            }
            this.assertReady(role,undefined,true);
            const out=await model.probe(challenge,signal),observed=out.observation;
            if(!observed||!observed.ledgerRequestId)throw new DomainError('NATIVE_PROBE_PAID_COMPLETION_UNVERIFIED',409);
            return{role,model:observed.model,runner:'LLM_API',provider:observed.provider,authentication:'API_KEY',
                responseId:observed.responseId,responseHash:observed.responseObjectHash,ledgerRequestIds:[observed.ledgerRequestId],
                paidFallback:false,cleanupReturned:true,reply:typeof out.data.probe==='string'?out.data.probe:''};
        }
        this.assertReady(role,undefined,true);
        const parent=within(this.context.root,'.runtime/native-probe-work');mkdirSync(parent,{recursive:true});
        const workspace=mkdtempSync(resolve(parent,'owned-')),before=treeHash(workspace),probeId='probe_'+hash(challenge).slice(0,20);
        // The receipt is only accepted when the model's answer IS the nonce (the gateway hashes the
        // trimmed text), so the probe must ask for exactly that instead of sending a bare token the
        // model is free to interpret, quote or wrap.
        const currentRoles=rolePolicyBinding(c);
        const input:AgentInput={role,workspace,prompt:'Return exactly this token and nothing else. No quotes, no JSON, no punctuation, no explanation: '+challenge,model:currentRoles.models[role],runId:probeId,specHash:hash({challenge,role}),
            laya:{role,mode:'off',adoption:'off',label:null,reason:'MINIMUM_PROBE',latencyMs:0,inputHash:'',modelRevision:null,confidence:null,cached:false},signal};
        if(role==='executor'){
            // The echo is model output, and a model occasionally appends a period or a newline. One retry with a
            // sharper instruction is cheaper and more honest than loosening the comparison: the receipt still only
            // counts when the answer IS the challenge.
            for(let attempt=0;attempt<2;attempt++){
                const receipts:unknown[]=[];
                const prompt=attempt===0?input.prompt:input.prompt+' Output the 40 characters only; do not add a period, quotes, code fences or a newline.';
                const out=await this.executorRunner({...input,prompt},{projectId:null,runId:null},true).run({...input,prompt},event=>{
                    if(event&&typeof event==='object'&&(event as {method?:string}).method==='dm/budget'){
                        const params=(event as {params:{requests:unknown[]}}).params;receipts.push(...params.requests);
                    }
                });
                const receipt=receipts.length===1?receipts[0] as Record<string,unknown>:null;
                const verified=!!receipt&&receipt.minimalResponseVerified===true&&receipt.outputTextHash===hash(challenge)&&receipt.outcome==='COMPLETE';
                if(!verified){
                    if(attempt===1)throw new DomainError('NATIVE_PROBE_DSH_RESPONSE_UNVERIFIED',409);
                    continue;
                }
                if(treeHash(workspace)!==before)throw new DomainError('NATIVE_PROBE_SOURCE_CHANGED',409);
                return{role,runner:'DSH',provider:'deepseek-official',model:String(receipt!.observedModel),authentication:'API_KEY',
                    responseId:String(receipt!.responseId),responseHash:String(receipt!.responseSha256),sessionId:out.sessionId,ledgerRequestIds:[String(receipt!.id)],
                    paidFallback:false,cleanupReturned:true,reply:out.text.trim()};
            }
            throw new DomainError('NATIVE_PROBE_DSH_RESPONSE_UNVERIFIED',409);
        }
        const indieProvider=(()=>{try{return new URL(String(c.independent?.baseUrl??'')).hostname==='api.deepseek.com'?'deepseek-official':'openai-official'}catch{return 'openai-official'}})();
        if((role==='planner2'||role==='reviewer')&&currentRoles.planner2Mode==='api_key'&&c.independent?.enabled===true){
            // The independent provider's proof: one real answer that IS the nonce, billed as exactly one
            // settled ledger entry against its own USD price artifact. Nothing here can borrow the
            // subscription shape: the receipt names runner LLM_API + API_KEY and carries a ledger id.
            if(!this.context.independentRunner)throw new DomainError('INDEPENDENT_RUNNER_REQUIRED',409);
            const budget=this.configured().budget,permit=this.probePermits.getStore(),price=this.quote('independent',c.independent.maxOutputTokens,permit);
            const reservation=budget.reserve(role,price,c.independent.maxOutputTokens,permit);
            try{
                const out=await this.context.independentRunner.run(input,()=>{});
                const reply=out.text.trim();
                if(reply!==challenge)throw new DomainError('NATIVE_PROBE_INDEPENDENT_RESPONSE_UNVERIFIED',409);
                const usage=out.usage.inputTokens===null&&out.usage.outputTokens===null?null:
                    {inputTokens:out.usage.inputTokens??0,outputTokens:out.usage.outputTokens??0,cacheHitTokens:0};
                budget.settle(reservation.id,usage,'RESPONSE_RECEIVED');
                if(treeHash(workspace)!==before)throw new DomainError('NATIVE_PROBE_SOURCE_CHANGED',409);
                // sessionId and accountFingerprint are not decoration: NativeProbes.advance() refuses two
                // planner/reviewer receipts that share a session (the two roles must stay independent) and
                // refuses receipts whose account fingerprint disagrees (they must be the SAME account and
                // model). Both are derivable here without exposing the key: the fingerprint hashes it.
                const key=this.context.getSecret?.(c.independent.keyEnv)??process.env[c.independent.keyEnv]??'';
                return{role,model:String(c.independent.model),runner:'LLM_API',provider:indieProvider,authentication:'API_KEY',
                    responseId:out.sessionId,sessionId:out.sessionId,responseHash:hash({id:out.sessionId,reply}),
                    accountFingerprint:hash({provider:indieProvider,model:String(c.independent.model),key:hash(key)}),
                    ledgerRequestIds:[reservation.id],paidFallback:false,cleanupReturned:true,reply};
            }catch(error){
                // A refused or failed turn must still leave the reservation settled, or the ledger keeps a
                // phantom in-flight request. A settle failure never masks the original cause.
                try{budget.settle(reservation.id,null,'TRANSPORT_ERROR');}catch{}
                throw error;
            }
        }
        this.assertIndependentCodex(c);
        const controller=new AbortController();
        const pending=new CodexRunner(this.context.getConfig,this.context.root,true,this.context.childEnvironment,undefined,this.context.observeCodexRequestRoute).run({...input,signal:AbortSignal.any([signal,controller.signal])},
            event=>{
                const value=event as {method?:unknown;params?:unknown};
                if(value?.method==='dm/codexRequestPath')this.context.store.event(null,null,'network.codex-request',value.params??null);
                else this.context.store.event(null,null,'native.probe.event',event);
            });
        this.active.set(controller,pending);
        let out:Awaited<typeof pending>;
        try{out=await pending;}finally{this.active.delete(controller);}
        if(treeHash(workspace)!==before)throw new DomainError('NATIVE_PROBE_SOURCE_CHANGED',409);
        return{role,runner:'CODEX',provider:out.observation.provider,model:out.observation.model,authentication:'CHATGPT_SUBSCRIPTION',
            responseId:out.observation.turnId,responseHash:hash(out.text),sessionId:out.sessionId,accountFingerprint:out.observation.accountFingerprint,
            includedUsageAllowed:true,paidFallback:false,ledgerRequestIds:[],cleanupReturned:true,reply:out.text.trim()};
    }
    async runData(input:{runId:string;specHash:string;sourceHash:string;command:SandboxCommand;signal:AbortSignal}):Promise<SandboxResult>{
        if(input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);
        const r=this.context.store.run(input.runId),owner=currentProcessOwnership();
        if(!owner||owner.store!==this.context.store||owner.runId!==r.id||owner.projectId!==r.projectId||owner.mode!=='live')throw new DomainError('NATIVE_DATA_OWNERSHIP_REQUIRED',409);
        const workspace=executionWorkspace(r,dirname(this.context.store.path));
        if(r.mode!=='live'||r.specHash!==input.specHash||r.treeHash!==input.sourceHash||treeHash(workspace)!==input.sourceHash)throw new DomainError('NATIVE_RUN_BINDING_CHANGED',409);
        if(r.flowName==='custom'){
            if(r.flowConfig?.mode!=='custom')throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            this.assertCustomReady(r.flowConfig);
        }else this.assertReady('build',{projectId:r.projectId,specHash:input.specHash});
        // No model request, credentials, network route or control endpoint enters this worker.
        return new WslSandbox(this.context.root).run(workspace,input.command,{signal:input.signal,wallSeconds:30});
    }
    async runSqliteData(input:NativeSqliteDataInput):Promise<SqliteSandboxExchange>{
        if(input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);
        const r=this.context.store.run(input.runId),owner=currentProcessOwnership();
        if(!owner||owner.store!==this.context.store||owner.runId!==r.id||owner.projectId!==r.projectId||owner.mode!=='live')throw new DomainError('NATIVE_DATA_OWNERSHIP_REQUIRED',409);
        const workspace=executionWorkspace(r,dirname(this.context.store.path));
        new SqliteDatasets(this.context.store,this.context.root,dirname(this.context.store.path)).assertRuntimeSource(r.id,input.sourceHash);
        const plan=reviewedSqliteRuntime(this.context.store,r);
        if(r.specHash!==input.specHash||hash(plan)!==input.planHash||hash(prepareSqliteRuntimeCommand(plan,input.binding))!==hash(input.command))throw new DomainError('NATIVE_RUN_BINDING_CHANGED',409);
        if(r.flowName==='custom'){
            if(r.flowConfig?.mode!=='custom')throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            this.assertCustomReady(r.flowConfig);
        }else this.assertReady('build',{projectId:r.projectId,specHash:input.specHash});
        // One existing binary worker, no model, credential, controller endpoint or network route.
        return new WslSandbox(this.context.root).runSqlite(workspace,input.command,input.image,input.binding,{signal:input.signal,wallSeconds:30});
    }
    readonly sqliteRetirementEnabled:boolean=false;
    async retireSqliteData(input:SqliteRetirementInput):Promise<SqliteRetirementReceipt>{
        if(this.sqliteRetirementEnabled!==true)throw new DomainError('SQLITE_RETIREMENT_NOT_RELEASED',409);
        // Post-commit resource cleanup uses the original opaque authority, never model/account admission.
        return retireSqliteGuest(this.context.store,this.context.root,input);
    }
    async verify(input:AgentInput,emit:(event:unknown)=>void):Promise<Record<string,unknown>> {
        this.assertNativeCleanup();
        const {op}=this.configured(),r=this.context.store.run(input.runId);
        const approved=this.verifierPlan(r.projectId,input.specHash);
        if(r.specHash!==input.specHash||!this.context.store.approved(r.projectId,input.specHash,'VERIFIER')||
            !this.context.store.records(r.projectId,'VerifierApproval').some(record=>record.data.specHash===input.specHash&&record.data.planHash===approved.sha256))throw new DomainError('TRUSTED_VERIFIER_APPROVAL_REQUIRED',409);
        const root=within(this.context.root,relative(this.context.root,op.oracleRoot).split(sep).join('/'));
        const verifier=new WslVerifier(this.context.root,root,spec=>spec===input.specHash?op.oracles[spec]??null:null);
        return verifier.verify(input,emit);
    }
    verifierPlan(projectId:string,specHash:string){
        const {op}=this.configured(),p=this.context.store.project(projectId),s=p.specId?this.context.store.spec(p.specId):null;
        if(!s||s.stale||s.hash!==specHash)throw new DomainError('VERIFIER_SPEC_BINDING_INVALID',409);
        const ref=op.oracles?.[specHash];if(!ref)throw new DomainError('TRUSTED_VERIFIER_PLAN_REQUIRED',409);
        const root=within(this.context.root,relative(this.context.root,op.oracleRoot).split(sep).join('/'));
        const bytes=readFileSync(within(root,ref.relativePath));if(hash(bytes)!==ref.sha256||hasSecret(bytes.toString('utf8')))throw new DomainError('TRUSTED_VERIFIER_PLAN_CHANGED',409);
        return{sha256:ref.sha256,plan:validateVerifierPlan(JSON.parse(bytes.toString('utf8')),specHash,s.requirements.map(r=>r.id),s.acceptanceItems??[])};
    }
    repairRevision(runId:string){const {budget}=this.configured();return budget.repairRevision(runId);}
    reserveRepair(runId: string){const {budget}=this.configured();budget.repair(runId);}
    stopRequests(){
        if(this.stopping||this.closed)return;this.stopping=true;
        for(const ticket of this.accountCustodies)revokeMagpieAccountCustody(ticket);this.accountCustodies.clear();
        this.stoppingProbes=this.probes?.close();
        this.stoppingCustomProofs=this.customProofs?.close();void this.stoppingCustomProofs?.catch(()=>{});
        // Observe immediately; final disposal below still joins the original promise.
        void this.stoppingProbes?.catch(()=>{});
        for(const controller of this.active.keys())controller.abort();
        for(const controller of this.plannerTickets)controller.abort();
    }
    close():Promise<void>{
        if(this.closing)return this.closing;this.stopRequests();
        this.closing=(async()=>{
            const results=await Promise.allSettled([...this.active.values(),...(this.preparing?[this.preparing]:[]),...(this.customPreparing?[this.customPreparing]:[]),...(this.stoppingProbes?[this.stoppingProbes]:[]),...(this.stoppingCustomProofs?[this.stoppingCustomProofs]:[])]);
            if(this.cleanupUncertain||results.some(result=>result.status==='rejected'&&cleanupUncertain(result.reason))){
                this.context.store.event(null,null,'native.close.uncertain',{code:'NATIVE_OWNER_CLEANUP_UNCERTAIN'});
                throw new DomainError('NATIVE_OWNER_CLEANUP_UNCERTAIN',409,'原生进程或探针清理未获证；原费用账本和记录保留。');
            }
            this.closed=true;
            if(this.budget){for(const r of this.budget.requests().filter(r=>r.usageStatus==='PENDING'))this.budget.settle(r.id,null,'OWNER_CLOSE_UNKNOWN');this.finalBudgetStatus=structuredClone(this.liveBudgetStatus());this.finalBudgetAt=new Date().toISOString();this.budget.close();}
        })();return this.closing;
    }
}
export const createNativeOwner=(context:NativeOwnerContext)=>new NativeOwner(context);
