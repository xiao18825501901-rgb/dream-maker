import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import {storedPreworkEvent} from './prework/runtime.js';
import { Settings } from './config.js';
import { Interviews } from './interview.js';
import { chatEvidenceProjection, chatProjectEditable, chatProjectPresentation, chatReviewFeedbackReady, saveChatProjectPresentation } from './chat-project.js';
import { Engine,type NativeExecutionFactory } from './engine.js';
import {createNativeOwner} from './native-owner.js';
import {latestMagpieCheck,checkMagpieLocally} from './magpie-check.js';
import {readDesktopMagpieCatalog} from './flow/custom-magpie-catalog.js';
import {magpieRoleRegistry} from './role-configuration.js';
import type {RoleRegistrySnapshot} from '../shared/project-roles.js';
import {MagpieAccountChecks} from './magpie-account-check.js';
import {MagpieAccountRecoveries} from './magpie-account-recovery.js';
import type {MagpieAccountControlObservation} from '../shared/magpie-account-check.js';
import type {MagpieCustodyBinding} from './magpie-account-custody.js';
import { LayaBridge } from './laya.js';
import { ModelProvider, type PaidRequestGuard } from './providers/model.js';
import { planner1Binding, assertPlanner1DispatchAllowed } from './planner1-binding.js';
import { planner1ModelCatalog } from './planner1-models.js';
import { LocalPlanner1Runtime, recordLocalPlanner1Capability } from './local-planner1.js';
import { normalizeRoleFields, normalizeRoleList, roleProjection } from '../shared/role-names.js';
import { KimiRunner, createKimiTransport } from './providers/kimi.js';
import { loadKimiAdmission } from './kimi-admission.js';
import { createKimiTokenStore } from './kimi-token-store.js';
import { createKimiCredentialAuthority } from './kimi-credential-authority.js';
import { kimiStatus } from './kimi-status.js';
import { archonBindingStatus } from './archon-status.js';
import {FlowProfiles} from './flow-profiles.js';
import {WorkbenchContracts} from './workbench-contracts.js';
import {ENGINE_ENTRIES} from '../shared/engine-mode.js';
import type {InspectCustomAccountSources,CustomAccountSourcesView} from '../shared/custom-account-sources.js';
import type {AccountSourceChoices,RegisteredAccountSource} from '../shared/registered-account-sources.js';
import { UserPlans } from './user-plans.js';
import type { Product } from '../shared/product.js';
import { setupSnapshot } from './onboarding.js';
import { StateMaintenance } from './maintenance.js';
import { probeStorageVolumeHealth } from './storage-durability.js';
import { ManagedDatasets } from './managed-data.js';
import {JsonDatasets} from './json-data.js';
import {RegisteredProjectBackups} from './registered-backups.js';
import { nativeReadiness } from './providers/dsh.js';
import {userBudgetInput} from './user-budget-input.js';
import type {UserBudgetLimits} from '../shared/onboarding.js';
import type {LifecycleStatus} from '../shared/lifecycle.js';
import {cleanupUncertain} from './cleanup-uncertainty.js';
import { HELP } from './flow/plain-report.mjs';
import { startKimiBridgeIfConfigured } from './kimi-bridge-startup.js';
import { createBridgeFrameLedger } from './kimi-bridge-ledger.js';
import { createAuthFailureLog } from './kimi-auth-state.js';
import { createShadowMirror, resolveOrcaMode, type ShadowMode } from './orca/shadow.js';
import { attachShadowMirror } from './orca/shadow-attach.js';
import { createLayaObserver } from './laya-observation.js';
import {createKimiPlanner1Probe,type Planner1Probe} from './kimi-planner1-probe.js';
import type {Role} from '../shared/types.js';
import type { SpawnImpl } from './kimi-bridge-launcher.js';
import { spawn as spawnChildProcess } from 'node:child_process';
import { SiwcAccountService } from './siwc/account-service.js';
import { SiwcPlanner1Provider } from './siwc/planner1-provider.js';
import { createWindowsCredentialEncryption } from './siwc/windows-credential-encryption.js';
import { inspectPinnedCheckout, makePinnedFactory } from './siwc/sdk-loader.js';
import { SiwcBlocked, safeFailure } from './siwc/errors.js';
import { ClashService, withCodexRoleProbeLease } from './clash-service.js';
import {NetworkContextsService,type LocalNetworkObservations} from './network-contexts.js';
import {createLocalNetworkCollector} from './network-context-observer.js';
import {readCodexMetadata,readCodexMetadataWithRoute,codexMetadataObservation} from './providers/codex-status.js';
import {readCodexMetadataObservation,type CodexMetadataObservation} from '../shared/codex-metadata.js';
import { IndependentRunner } from './providers/independent.js';
import { ProjectResearch, PUBLIC_RESEARCH_TERMS } from './research/project-research.js';
import {createAnonymousResearchTransport,type ResearchTransport} from './research/transport.js';
import { files, get, treeHash } from './workspace.js';
import {assertProjectStorage,readWorkspace} from './workspace-location.js';
import { DomainError, object, text, choose, integer, safeEqual, redact, within, hash } from './security.js';
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const LOCAL_UI_ASSETS = new Set(['index.html','app.js','style.css','tokens.css','base.css','hallmark.css','contracts.js','dom.js','views.js','ui.js','local-api.js','preview.js','siwc-local.js','kimi-status-summary.js','native-readiness-summary.js','project-plan-view.js','flow-help-view.js','dreamflow.html','dreamflow-app.js','user-plan-view.js','setup-view.js','maintenance-view.js','lifecycle-view.js','managed-data-view.js','plan-history-view.js','research-view.js','flow-workspace-view.js','reviewer-view.js','plain-ui-error.js','frontend-guidance-view.js','json-data-view.js','registered-backup-view.js','merge-recovery-view.js','planner1-choice-view.js','laya-probe-view.js','custom-flow-state.js','custom-flow-view.js','custom-flow-controller.js']);
const SHARED_UI_ASSETS=new Set(['shared/custom-magpie-protocol.js','shared/demo-tasks.js','shared/network-contexts.js','shared/codex-metadata.js','shared/role-names.js']);
// The chat shell is the shipped UI. The demo/preview entry stays a development artifact and is
// deliberately kept off the served allowlist; scripts/build-chat-preview.mjs builds it offline.
for (const asset of ['chat-entry.js','chat-controller.js','chat-projection.js','chat-types.js','chat-shell.js','chat-shell.css','chat-stages.js','chat-work-status.js']) LOCAL_UI_ASSETS.add(asset);
LOCAL_UI_ASSETS.add('review-window-view.js');
LOCAL_UI_ASSETS.add('network-context-view.js');
LOCAL_UI_ASSETS.add('magpie-check-view.js');
LOCAL_UI_ASSETS.add('registered-account-sources.js');
LOCAL_UI_ASSETS.add('magpie-account-check-view.js');
LOCAL_UI_ASSETS.add('custom-role-check.js');
LOCAL_UI_ASSETS.add('executor-checkpoint-view.js');
LOCAL_UI_ASSETS.add('review-preparation-view.js');
LOCAL_UI_ASSETS.add('review-supplement-view.js');
LOCAL_UI_ASSETS.add('sqlite-status-view.js');
async function body(req: IncomingMessage) { if (!req.headers['content-type']?.startsWith('application/json'))
    throw new DomainError('JSON_REQUIRED', 415); let size = 0; const chunks: Buffer[] = []; for await (const chunk of req) {
    size += chunk.length;
    if (size > 128000)
        throw new DomainError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
} try {
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
catch (e) {
    if (e instanceof DomainError)
        throw e;
    throw new DomainError('INVALID_JSON');
} }
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
export async function createApp(options: {
    root: string;
    data: string;
    configPath: string;
    /** Trusted product-startup instances shared with a pre-client service. */
    settings?:Settings;
    clash?:ClashService;
    product?:Product;
    port?: number;
    demoDelayMs?: number;
    paidRequestGuard?: PaidRequestGuard;
    nativeExecution?:NativeExecutionFactory;
    nativeOwnerBuilder?:(context:{root:string;store:Store;applicationDataRoot:string;product?:Product;getConfig:()=>import('../shared/types.js').Config;planner1Probe?:Planner1Probe;fetch?:typeof fetch;childEnvironment?:(extra:NodeJS.ProcessEnv)=>NodeJS.ProcessEnv;withNetworkRun?:<T>(runId:string,signal:AbortSignal,action:()=>Promise<T>)=>Promise<T>;observeCodexRequestRoute?:import('./codex-network-path.js').CodexRequestRouteObserver})=>NativeExecutionFactory&{paidGuard:PaidRequestGuard;restoreProbes?:(model:ModelProvider)=>Promise<void>;
        probe?:(role:Role,signal:AbortSignal,model:ModelProvider)=>Promise<unknown>;
        probeStatus?:(model:ModelProvider)=>Promise<Record<string,unknown>>;budgetStatus?:()=>unknown;configureUserBudget?:(limits:UserBudgetLimits,revision:number,actor:string,operation:string)=>unknown;
        maintenanceBusy?:()=>boolean;captureBudgetState?:(path:string)=>boolean;
        advanceProbes?:(model:ModelProvider)=>Promise<void>;inspectMagpieIngress?:(signal?:AbortSignal)=>Promise<unknown>;
        inspectCustomAccountSources?:(input:InspectCustomAccountSources)=>CustomAccountSourcesView;
        recommendCustomMagpieMember?:(input:InspectCustomAccountSources,roleId:string,signal:AbortSignal)=>Promise<ReturnType<typeof import('./flow/custom-member-recommendation.js').recommendPreparedMember>>;
        describeCustomMagpieAccountCheck?:(input:InspectCustomAccountSources)=>Readonly<MagpieCustodyBinding>;
        inspectCustomMagpieAccounts?:(input:InspectCustomAccountSources,signal:AbortSignal,binding:MagpieCustodyBinding)=>Promise<MagpieAccountControlObservation>;
        selectableAccountIdentities?:()=>{sources:import('../shared/registered-account-sources.js').PublicAccountIdentity[]};registeredAccountSources?:()=>AccountSourceChoices;registerAccountSource?:(input:unknown,actor:string,operationHash:string)=>RegisteredAccountSource;accountVerification?:(input:InspectCustomAccountSources)=>boolean;accountVerifiedForProject?:(projectId:string)=>boolean};
    /** C03: process launcher for the Kimi bridge, injectable so tests never spawn a real wsl.exe. */
    kimiBridgeSpawn?: SpawnImpl;
    /** Trusted product-startup ownership only. Never supplied by HTTP or model configuration. */
    kimiLocalService?: {stop():Promise<void>};
    /** Product lock/credential release after all original close gates and Store close succeeded. */
    onClosed?:()=>void;
    /** Trusted bootstrap-only test seam; never accepted from HTTP/config/model data. */
    researchTransport?: ResearchTransport;
    desktopMagpieCatalogPort?: number;
    /** sha256 of the Magpie build this process is bound to; enables the Magpie role registry. */
    magpieBuildSha256?: string;
    /** Trusted startup-only observation seam. Never accepted from configuration or HTTP. */
    networkCollector?:(config:import('../shared/types.js').Config,signal:AbortSignal)=>Promise<LocalNetworkObservations>;
    networkHealthProbe?:(config:import('../shared/types.js').Config,signal:AbortSignal)=>Promise<import('../shared/network-contexts.js').LocalProxyHealth>;
    /** Trusted test seam. Production uses the real app-server metadata reader under the CFW lease. */
    networkCodexMetadata?:typeof readCodexMetadata;
    /** Trusted startup seam for local Ollama tests; the endpoint itself remains fixed in product code. */
    localPlanner1Runtime?:LocalPlanner1Runtime;
}) {
    const { root, data } = options;assertProjectStorage(root,data,{allowAdditionalDataRoots:true});
    const settings = options.settings ?? new Settings(options.configPath), store = new Store(resolve(data, 'dream-maker.sqlite'));
    const product=choose(options.product??'dream-maker',['dream-maker','dreamflow']),userPlans=new UserPlans(store);
    const flowProfiles=new FlowProfiles(store);
    const magpieAccountChecks=new MagpieAccountChecks(store,()=>settings.value,input=>{if(!owner?.describeCustomMagpieAccountCheck)throw new DomainError('NATIVE_OWNER_UNAVAILABLE',409);return owner.describeCustomMagpieAccountCheck(input);},input=>{try{return owner?.accountVerification?.(input)===true;}catch{return false;}});
    const magpieAccountRecoveries=new MagpieAccountRecoveries(store,root,undefined,projectId=>{try{return owner?.accountVerifiedForProject?.(projectId)===true;}catch{return false;}});
    // The Clash route is the single trusted transport: it leases one selector, verifies the exit, and
    // restores it. Disabled means plain fetch, so this wiring is inert unless the operator opts in.
    const clash = options.clash ?? new ClashService(
        () => settings.value,
        resolve(data, 'controller', 'clash-route'),
        observation => { store.event(null, null, 'network.routed-request', observation); }
    );
    // Public repository research has no account credential. When CFW is explicitly enabled it
    // uses the same controller/CONNECT/TLS/node-chain boundary; disabled keeps the original
    // DNS-pinned anonymous transport rather than an implicit system-proxy path.
    const anonymousResearch=options.researchTransport??createAnonymousResearchTransport();
    const researchTransport:ResearchTransport=options.researchTransport??((url,init)=>
        settings.value.clash.enabled?clash.researchFetch(url,init):anonymousResearch(url,init));
    const projectResearch = new ProjectResearch(store,data,researchTransport);
    const networkContexts=new NetworkContextsService(()=>settings.value,options.networkCollector??createLocalNetworkCollector({root,store,clash}),Date.now,options.networkHealthProbe??((_config,signal)=>clash.observeLocalStability(signal)),options.networkHealthProbe?undefined:()=>clash.configurationFingerprint());
    const currentCodexMetadataContext=(network:import('../shared/network-contexts.js').NetworkContextsSnapshot):NonNullable<CodexMetadataObservation['controller']>=>({
        selectionPolicy:network.controller.selectionPolicy,
        selectedNode:network.controller.selectedNode,
        expectedNode:network.controller.selectionPolicy==='current'?network.controller.selectedNode:network.controller.configuredNode
    });
    const refreshCodexMetadataObservation=async(value:CodexMetadataObservation):Promise<CodexMetadataObservation>=>{
        const network=await networkContexts.refresh();
        const controller=currentCodexMetadataContext(network);
        const sameController=value.controller===null?controller.selectedNode===null:
            value.controller.selectionPolicy===controller.selectionPolicy&&
            value.controller.selectedNode===controller.selectedNode&&
            value.controller.expectedNode===controller.expectedNode;
        return readCodexMetadataObservation({
            ...value,
            currentConfiguration:value.currentConfiguration&&network.currentConfiguration&&
                value.configurationFingerprint===network.configurationFingerprint&&sameController,
            configurationFingerprint:network.configurationFingerprint??value.configurationFingerprint,
            controller
        });
    };
    let codexMetadataPending:Promise<CodexMetadataObservation>|undefined;
    const readCodexMetadataForDashboard=async():Promise<CodexMetadataObservation>=>{
        if(codexMetadataPending)return codexMetadataPending;
        codexMetadataPending=(async()=>{
            const config=structuredClone(settings.value);
            const report=await readCodexMetadataWithRoute(
                config,
                root,
                clash,
                AbortSignal.timeout(60000),
                options.networkCodexMetadata??readCodexMetadata
            );
            const network=await networkContexts.refresh();
            const fingerprint=network.configurationFingerprint??clash.configurationFingerprint();
            return readCodexMetadataObservation(codexMetadataObservation(report,{
                configurationFingerprint:fingerprint,
                currentConfiguration:network.currentConfiguration,
                controller:currentCodexMetadataContext(network)
            }));
        })().finally(()=>{codexMetadataPending=undefined;});
        return codexMetadataPending;
    };
    // A09: SHADOW is an observation mode only. Default OFF; when enabled it mirrors redacted event
    // shape into a bounded in-memory buffer and never dispatches, approves or writes task authority.
    const orcaRequest = resolveOrcaMode(process.env['DM_ORCA_MODE']);
    const orcaMode: ShadowMode = orcaRequest.effective;
    const shadowMirror = createShadowMirror({ mode: orcaMode });
    if (orcaMode !== 'OFF') attachShadowMirror(store, shadowMirror);
    // A07/K09: Laya OFF is a claim that needs evidence per real role turn, so every dispatch is
    // recorded here and summarised by the read-only route below.
    const layaObserver = createLayaObserver();
    const encryption = createWindowsCredentialEncryption();
    const sdkCheckout = process.env.SIWC_SDK_CHECKOUT ?? '';
    const siwc = new SiwcAccountService(makePinnedFactory({checkout:sdkCheckout,encryption,storageDir:resolve(data,'siwc-credentials')}),{
        getConfig:()=>settings.value.planner1,
        sdkPresent:()=>inspectPinnedCheckout(sdkCheckout).status==='PINNED_CHECKOUT',
        encryptionReady:async()=>encryption.isAvailable(),
        onProfileActivated: id=>settings.selectSiwcProfile(id)
    });
    // K02: the subscription planner1 probe needs the process-owned Kimi runner, which is assembled
    // below; the owner only ever calls this closure after startup, so the late binding is safe and
    // an absent runner is a refusal instead of a silent pass.
    let kimiPlanner1Probe:Planner1Probe|undefined;
    // One runner instance for both the owner (probing planner2/reviewer) and the engine (dispatching
    // them), so a Live run and its probe agree about which provider is serving those two roles.
    const independentRunner = new IndependentRunner(
        () => settings.value,
        clash.jsonRequest,
        undefined,
        role => clash.jsonRequestForRole(role)
    );
    const owner=options.nativeExecution?undefined:(options.nativeOwnerBuilder??createNativeOwner)({root,store,applicationDataRoot:data,product,getConfig:()=>settings.value,independentRunner,
        planner1Probe:(challenge,signal,workspace)=>{if(!kimiPlanner1Probe)throw new DomainError('KIMI_PROBE_INVOKER_REQUIRED',409);return kimiPlanner1Probe(challenge,signal,workspace);},fetch:clash.fetch,
        fetchForRole:role=>clash.fetchForRole(role),childEnvironment:extra=>clash.childEnvironment(extra),
        withNetworkRun:(runId,signal,action)=>clash.withRunOrActive(runId,signal,action),
        observeCodexRequestRoute:input=>clash.observeCodexRequestRoute(input)});
    const localPlanner1=options.localPlanner1Runtime??new LocalPlanner1Runtime();
    const laya = new LayaBridge(() => settings.value), model = new ModelProvider(() => settings.value, root, clash.jsonRequestForRole('planner1'), options.paidRequestGuard??owner?.paidGuard, new SiwcPlanner1Provider(siwc),localPlanner1), kimiDeps = (() => {
        // K03 assembly: the Kimi runner exists only when explicitly enabled AND a token file is
        // configured. A missing token file means the runner simply does not exist, which surfaces
        // as KIMI_RUNNER_UNAVAILABLE instead of any silent provider fallback.
        const k = settings.value.kimi;
        if (product==='dreamflow'||!k || k.enabled !== true || !k.tokenFile) return undefined;
        // A01: the runner only sends when an owner-written "Extra Usage is off" record exists for
        // this account. No record means UNKNOWN, and UNKNOWN means no reasoning.
        const admission = loadKimiAdmission(process.env['DM_KIMI_ENTITLEMENT_FILE'] ?? resolve(data, 'kimi-entitlement.json'));
        // C03: one durable authority for this process. Its RESTORE barrier is awaited during startup
        // (below), so a corrupt or revoked record is known before any inference is attempted.
        const credentials = createKimiCredentialAuthority({ store: createKimiTokenStore({ dir: resolve(data, 'kimi-credentials'), encryption }) });
        const authFailures = createAuthFailureLog();
        const runner = new KimiRunner(() => settings.value, createKimiTransport({ baseUrl: k.baseUrl, tokenFile: k.tokenFile }), undefined, undefined, admission, credentials, failure => authFailures.record(failure));
        // Same controller-owned instructions the legacy planner1 path uses, so Kimi receives the
        // identical JSON contract instead of being asked to guess a format.
        let instructions = '';
        try { instructions = readFileSync(resolve(root, 'prompts/planner1.md'), 'utf8'); } catch { instructions = ''; }
        return { runner, workspace: data, instructions, admission, credentials, authFailures };
    })(), interviews = new Interviews(store, model, laya, () => settings.value, kimiDeps, layaObserver,projectResearch);
    // Preserve the historical API runner for explicit legacy diagnostics. New Flow role policy uses Codex.
    const engine = new Engine(store, laya, () => settings.value, root, data, options.demoDelayMs,options.nativeExecution??owner, clash, layaObserver,independentRunner);
    kimiPlanner1Probe = kimiDeps ? createKimiPlanner1Probe({ getConfig: () => settings.value, runner: kimiDeps.runner, credentials: kimiDeps.credentials,
        onLifecycle: event => { store.record('Planner1ProbeLifecycle', null, null, event); } }) : undefined;
    // Read-only probe gate for the diagnostics surface: phase, request count and per-role receipt
    // state. Cached for a few seconds because prepareProbes opens the custody key on first use.
    let probeGateCache: { at: number; value: unknown } | null = null;
    const probeGate = async (): Promise<unknown> => {
        if (!owner || typeof owner.probeStatus !== 'function') return null;
        if (probeGateCache && Date.now() - probeGateCache.at < 10000) return probeGateCache.value;
        try { const value = await owner.probeStatus(model); probeGateCache = { at: Date.now(), value }; return value; }
        catch (error) { return { error: error instanceof DomainError ? error.code : 'NATIVE_PROBE_STATUS_UNAVAILABLE' }; }
    };
    // C03 startup barrier: the durable credential record is read (and its state classified) before
    // anything can dispatch inference. A damaged record is therefore a startup-visible fact, not a
    // mysterious "please log in again" later. Inference stays separately gated by Extra Usage.
    if (kimiDeps?.credentials)
        await kimiDeps.credentials.restore();
    // C03: the trusted bridge is opt-in through DM_KIMI_BRIDGE=1 and additionally requires a restored
    // credential authority. The policy is a tested pure function; this is the thin edge that uses it.
    let stopKimiBridge: (() => void) | undefined;
    // "We started a bridge once" is not "the bridge is running now": the connector can exit long after
    // startup (a dead socket is the common case). Keep the controller's own liveness answer.
    let kimiBridgeRunning: (() => boolean) | undefined;
    // Which topology is actually in play, for the diagnostics panel. "off" is the default and must
    // never be confused with "configured but failed".
    let kimiBridgeTopology: 'off' | 'connector' | 'spawn' = 'off';
    // A bridge that fails to start must not take the whole local UI down with it: the failure is a
    // configuration fact the owner can read in diagnostics, not a reason to be unable to open the app.
    let kimiBridgeError: string | null = null;
    // Durability is only real if a rotation was actually acknowledged. Keep that fact where the
    // product can read it (types, generations, error codes — never a token).
    const kimiBridgeFrames = createBridgeFrameLedger();
    try {
        if (kimiDeps?.credentials) {
            const started = await startKimiBridgeIfConfigured({
            env: process.env as Record<string, string | undefined>,
            kimiRunnerConfigured: true,
            authority: kimiDeps.credentials,
            spawn: options.kimiBridgeSpawn ?? ((command, args, spawnOptions) => spawnChildProcess(command, args, spawnOptions as never) as never),
            instanceId: process.env['DM_KIMI_BRIDGE_INSTANCE'] ?? randomBytes(8).toString('hex'),
            accountRef: process.env['DM_KIMI_BRIDGE_ACCOUNT'] ?? '',
            onFrame: (frame, direction) => kimiBridgeFrames.record(frame, direction),
            // A connector that exits (dead socket, distro gone) is a configuration fact the owner can
            // read, not a silent loss of the channel: keep the exit status as the reason.
            onExit: info => {
                const why = typeof info.code === 'number' ? String(info.code) : typeof info.signal === 'string' ? info.signal : '';
                kimiBridgeError = why === '' ? 'KIMI_BRIDGE_EXITED' : 'KIMI_BRIDGE_EXITED:' + why;
            }
        });
            stopKimiBridge = started.runtime?.stop;
            kimiBridgeRunning = started.runtime?.running;
            if (started.decision.start && started.decision.launch)
                kimiBridgeTopology = (process.env['DM_KIMI_BRIDGE_SOCKET'] ?? '').length > 0 ? 'connector' : 'spawn';
        }
    } catch (error) {
        kimiBridgeError = (error as { code?: string }).code ?? 'KIMI_BRIDGE_START_FAILED';
        kimiBridgeTopology = (process.env['DM_KIMI_BRIDGE_SOCKET'] ?? '').length > 0 ? 'connector' : 'spawn';
        stopKimiBridge = undefined;
    }
    await owner?.restoreProbes?.(model);
    engine.recover();
    const sessions = new Map<string, {
        csrf: string;
        expires: number;
    }>(), bootstrap = randomBytes(24).toString('hex');
    let bootUsed = false;
    const previews = new Map<string, string>(), projectLocks = new Map<string, Promise<unknown>>();
    let closingApplication=false,requestCleanupUncertain=false,closePromise:Promise<void>|undefined;
    const applicationStop=new AbortController();
    const activeRequests=new Set<Promise<void>>();
    const eventStreamClosers=new Set<()=>Promise<void>>();
    let workPausing=false,workPausePromise:Promise<void>|undefined,lifecycleState:LifecycleStatus['state']='RUNNING',lastChoice:LifecycleStatus['lastChoice']=null,lifecycleCode:string|null=null,lifecycleChangedAt=new Date().toISOString();
    const clearBackgroundChoice=()=>{if(lastChoice==='BACKGROUND_CURRENT_WORK'){lastChoice=null;lifecycleChangedAt=new Date().toISOString();}};
    const lifecycleSnapshot=():LifecycleStatus=>{
        const dispatch=engine.dispatchStatus();
        return {schema:'dream-maker.lifecycle.v1',state:lifecycleState,lastChoice,changedAt:lifecycleChangedAt,code:lifecycleCode,
            scope:'CONTROLLER_OWNED_WORK_ONLY',automaticResume:false,browserCloseStopsWork:false,currentRoundMayStillRun:engine.activeJobCount>0||dispatch.quarantined.length>0||model.activeCalls>0||lifecycleState==='PAUSE_REQUESTED'||lifecycleState==='PAUSE_UNCERTAIN',
            active:{engineJobs:engine.activeJobCount,interviews:interviews.activeOperations,modelCalls:model.activeCalls,queued:dispatch.queued.length,grants:dispatch.active.length,quarantined:dispatch.quarantined.length}};
    };
    const requestWorkPause=(exclude:Promise<void>)=>{
        if(workPausePromise)return;
        workPausing=true;lastChoice='PAUSE';lifecycleState='PAUSE_REQUESTED';lifecycleChangedAt=new Date().toISOString();applicationStop.abort();
        const earlier=[...activeRequests].filter(request=>request!==exclude);
        const begin=(action:()=>unknown)=>{try{return Promise.resolve(action());}catch(error){return Promise.reject(error);}};
        // Pause the Engine at its existing round boundary. P1/research/probe requests are cancelled;
        // finishing that already-started engineering round can still consume its authorized budget.
        const managers=[begin(()=>engine.pauseAll()),begin(()=>interviews.close()),begin(()=>projectResearch.close()),begin(()=>siwc.shutdown()),begin(()=>stopKimiBridge?.())];
        workPausePromise=Promise.allSettled([...managers,...earlier]).then(async results=>{
            engine.stopNativeRequests();
            if(results.some(result=>result.status==='rejected')||requestCleanupUncertain)throw new DomainError('APPLICATION_PAUSE_UNCERTAIN',409);
            await engine.disposeNative();
            lifecycleState='PAUSED';lifecycleChangedAt=new Date().toISOString();
            store.record('ApplicationLifecycleResult',null,null,{state:lifecycleState,at:lifecycleChangedAt,automaticResume:false});
        }).catch(error=>{
            lifecycleState='PAUSE_UNCERTAIN';lifecycleCode=error instanceof DomainError?error.code:'APPLICATION_PAUSE_UNCERTAIN';lifecycleChangedAt=new Date().toISOString();
            try{store.record('ApplicationLifecycleResult',null,null,{state:lifecycleState,code:lifecycleCode,at:lifecycleChangedAt,automaticResume:false});}catch{/* Retain the in-memory failure too; never convert a failed journal into success. */}
        });
    };
    const maintenanceBusy=()=>engine.activeJobCount>0||engine.dispatchStatus().quarantined.length>0||model.activeCalls>0||siwc.isBusy||projectLocks.size>0||owner?.maintenanceBusy?.()===true;
    const maintenance=new StateMaintenance({store,data,root,isBusy:maintenanceBusy,captureBudget:path=>owner?.captureBudgetState?.(path)??false});
    const registeredBackups=new RegisteredProjectBackups({store,data,root,maintenance,isBusy:maintenanceBusy});
    const managedData=new ManagedDatasets(store,root);
    const jsonData=new JsonDatasets(store,root);
    let mainOrigin = '';
    const locked = async <T>(key: string, fn: () => Promise<T>) => { const previous = projectLocks.get(key) ?? Promise.resolve(); const work = previous.catch(() => { }).then(()=>{if(closingApplication||workPausing)throw new DomainError(workPausing?'APPLICATION_PAUSING':'APPLICATION_STOPPING',409);clearBackgroundChoice();return fn();}); projectLocks.set(key, work); try {
        return await work;
    }
    finally {
        if (projectLocks.get(key) === work)
            projectLocks.delete(key);
    } };
    // Workbench contracts: one object per process, so the DM/DF engine decision, the role
    // configuration, the star answers and the explanations all read the same Store rows through
    // the same rules. Nothing here re-derives an engine for itself.
    let magpieRegistry: RoleRegistrySnapshot|null=null;
    const refreshMagpieRegistry=async():Promise<void>=>{
        const digest=String(options.magpieBuildSha256??process.env.DM_MAGPIE_BUILD_SHA256??'');
        if(!/^[a-f0-9]{64}$/.test(digest))return;
        try{
            const catalog=await readDesktopMagpieCatalog(options.desktopMagpieCatalogPort??3425);
            const models=catalog.models.map(model=>({id:model.id,protocols:model.protocols}));
            if(models.length)magpieRegistry=magpieRoleRegistry({models},digest);
        }catch{/* no reachable desktop Magpie: keep the product-route registry, never guess one */}
    };
    void refreshMagpieRegistry();
    const registryTimer=setInterval(()=>{void refreshMagpieRegistry();},60000);
    registryTimer.unref?.();
    const workbench=new WorkbenchContracts({
        store,root,config:()=>settings.value,interviews,
        // An explanation is a planner1 turn: it goes through the same provider boundary (same
        // route, same paid-request guard) and records its own ModelAttempt for the shared cap.
        explanationModel:{complete:async(payload,signal)=>{const result=await model.complete(payload,signal);return {data:result.data,usage:result.usage};}},
        registry:()=>magpieRegistry
    });
    const previewServer = http.createServer((req, res) => {
        try {
            const addr = previewServer.address();
            const pp = typeof addr === 'object' && addr ? addr.port : 0;
            if (req.headers.host !== `127.0.0.1:${pp}`)
                throw new DomainError('HOST_DENIED', 403);
            if (req.method !== 'GET')
                throw new DomainError('METHOD_DENIED', 405);
            const url = new URL(req.url ?? '/', `http://${req.headers.host}`), parts = url.pathname.split('/').filter(Boolean), token = parts.shift() ?? '', rid = previews.get(token);
            if (!rid)
                throw new DomainError('PREVIEW_NOT_FOUND', 404);
            const r = store.run(rid);
            if (r.mode !== 'demo' || !['READY_FOR_DELIVERY', 'ACCEPTED'].includes(r.state))
                throw new DomainError('DEMO_PREVIEW_NOT_READY', 409);
            const workspace=readWorkspace(r,data);
            if (r.treeHash !== treeHash(workspace))
                throw new DomainError('ARTIFACT_SOURCE_CHANGED', 409);
            const name = decodeURIComponent(parts.join('/') || 'index.html'), ext = extname(name);
            if (!MIME[ext] || !files(workspace).some(f => f.path === name))
                throw new DomainError('PREVIEW_FILE_DENIED', 404);
            const previewOrigin=`http://127.0.0.1:${pp}`;
            res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
                'access-control-allow-origin':'null',
                'content-security-policy': `default-src 'none'; script-src ${previewOrigin}; style-src ${previewOrigin}; img-src ${previewOrigin} data:; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${mainOrigin}` });
            res.end(get(workspace, name));
        }
        catch (e) {
            json(res, e instanceof DomainError ? e.status : 500, { error: e instanceof DomainError ? e.code : 'PREVIEW_ERROR' });
        }
    });
    await new Promise<void>((resolve, reject) => { previewServer.once('error', reject); previewServer.listen(0, '127.0.0.1', () => resolve()); });
    const previewPort = (previewServer.address() as {
        port: number;
    }).port;
    // A08 pre-work: the project payload carries the same three read-only states the diagnostics
    // panel shows, so the project page can explain a blocked run without sending the owner to a
    // different screen. Nothing here can grant permission or reveal a token.
    const projectStatus = (runId?:string) => ({
        // Same shape as /api/kimi/status: a proven runtime rejection must not read as healthy on the
        // project page just because that surface forgot the field.
        kimi: kimiStatus({ admission: kimiDeps?.admission, credentials: kimiDeps?.credentials, lastAuthFailure: kimiDeps?.authFailures?.last() ?? null }),
        laya: runId?engine.layaObservation(runId):createLayaObserver().summary(),
        // Recent event KINDS only (never payloads): enough to see whether SHADOW is actually observing.
        // Same requested/effective/degraded fields as diagnostics, so a silent downgrade is visible here too.
        shadow: {
            ...shadowMirror.stats(),
            requested: orcaRequest.requested,
            degraded: orcaRequest.degraded,
            reason: orcaRequest.reason,
            recent: shadowMirror.recent().slice(-3).map(event => event.kind)
        }
    });
    const snapshot = (pid: string) => {
        const project=store.project(pid),spec=project.specId?store.spec(project.specId):null,runs=store.runs(pid).map(run=>({...run,mergeRecoveryRequired:engine.mergeRecoveryRequired(run.id),executorCheckpointRequired:engine.executorCheckpointRequired(run.id),reviewPreparationCandidate:engine.reviewPreparationCandidate(run.id),reviewWindowCandidate:engine.reviewWindowCandidate(run.id)}));
        const active=runs.find(run=>run.id===project.activeRunId&&run.specId===spec?.id&&run.specHash===spec.hash&&!spec.stale);
        const reviewRun=active??runs.find(run=>run.specId===project.specId);
        // Seeker: the current editable requirements draft and the last reviewer hand-back travel with
        // the project, so the page never has to guess which version it is looking at.
        const requirementsDraft=store.records(pid,'RequirementsDraft').at(-1)??null;
        const seekerHandoff=store.records(pid,'SeekerReviewHandoff').at(-1)??null;
        const seekerInterpretation=store.records(pid,'SeekerInterpretation').at(-1)??null;
        return {project,spec,runs,records:store.records(pid).slice(-100),research:projectResearch.history(pid),planning:interviews.planningStatus(pid),flowOptions:engine.flowOptions({live:project.mode==='live'}),status:projectStatus(active?.id),chat:{editable:chatProjectEditable(store,project),reviewFeedbackReady:product!=='dreamflow'&&chatReviewFeedbackReady(store,project,reviewRun)&&!!reviewRun&&!engine.activeRunIds().includes(reviewRun.id),...chatEvidenceProjection(store,project,reviewRun,spec),presentation:chatProjectPresentation(store,pid)},
            requirementsDraft,seekerHandoff,seekerInterpretation};
    };
    const server = http.createServer(async (req, res) => {
        let finishRequest:(()=>void)|undefined;
        let accountSourceRequest=false;
        // Classify metadata routes before any host/origin guard can fail. Never use
        // ambient credential redaction to format their fixed error messages.
        try{const p=new URL(req.url??'/','http://127.0.0.1').pathname;accountSourceRequest=p==='/api/account-sources'||/^\/api\/projects\/[^/]+\/flow-account-(?:sources|check)$/.test(p);}catch{/* Malformed URLs cannot address a source operation. */}
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('x-frame-options', 'DENY');
        res.setHeader('content-security-policy', `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src http://127.0.0.1:${previewPort}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
        try {
            const addr = server.address(), port = typeof addr === 'object' && addr ? addr.port : 0;
            if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? ''))
                throw new DomainError('HOST_DENIED', 403);
            const origin = `http://${req.headers.host}`;
            if (req.headers.origin && req.headers.origin !== origin)
                throw new DomainError('ORIGIN_DENIED', 403);
            if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'] as string))
                throw new DomainError('CROSS_ORIGIN_DENIED', 403);
            const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
            accountSourceRequest=path==='/api/account-sources'||/^\/api\/projects\/[^/]+\/flow-account-(?:sources|check)$/.test(path);
            if(closingApplication)throw new DomainError('APPLICATION_STOPPING',409,'本机服务正在停止，未开始新的操作；已有数据保留。');
            if (!path.startsWith('/api/')) {
                if (method !== 'GET')
                    throw new DomainError('METHOD_DENIED', 405);
                const requested=decodeURIComponent(path.slice(1));
                const name = path==='/'||requested==='index.html' ? (product==='dreamflow'?'dreamflow.html':'index.html') : requested;
                if(product==='dreamflow'&&['app.js','siwc-local.js'].includes(name))throw new DomainError('NOT_FOUND',404);
                if (!LOCAL_UI_ASSETS.has(name)&&!SHARED_UI_ASSETS.has(name)) throw new DomainError('NOT_FOUND', 404);
                const file = within(resolve(root,SHARED_UI_ASSETS.has(name)?'dist':'dist/web'), name);
                if (!existsSync(file) || !MIME[extname(file)])
                    throw new DomainError('NOT_FOUND', 404);
                res.writeHead(200, { 'content-type': MIME[extname(file)], 'cache-control': 'no-cache' });
                res.end(readFileSync(file));
                return;
            }
            if (path === '/api/session' && method === 'POST') {
                const input = await body(req);
                if(closingApplication)throw new DomainError('APPLICATION_STOPPING',409);
                if (bootUsed || typeof input.bootstrap !== 'string' || !safeEqual(input.bootstrap, bootstrap))
                    throw new DomainError('BOOTSTRAP_DENIED', 401, '启动口令无效或已使用；请使用已登录浏览器，或重启本地服务生成新口令。');
                bootUsed = true;
                const sid = randomBytes(24).toString('hex'), csrf = randomBytes(24).toString('hex');
                sessions.set(sid, { csrf, expires: Date.now() + 12 * 3600000 });
                res.setHeader('set-cookie', `dm_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
                json(res, 200, { csrf });
                return;
            }
            const sid = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('dm_session='))?.slice('dm_session='.length), session = sid ? sessions.get(sid) : undefined;
            if (!session || session.expires < Date.now())
                throw new DomainError('SESSION_REQUIRED', 401);
            if (path === '/api/session' && method === 'GET') {
                json(res, 200, { csrf: session.csrf });
                return;
            }
            if (!['GET', 'HEAD'].includes(method) && !safeEqual(String(req.headers['x-csrf-token'] ?? ''), session.csrf))
                throw new DomainError('CSRF_DENIED', 403);
            // Read-only status handlers may await a provider before reading SQLite again. Socket
            // closure alone does not settle those handlers, so drain them with the mutations.
            let settled!:()=>void;const operation=new Promise<void>(resolve=>{settled=resolve;});activeRequests.add(operation);
            finishRequest=()=>{activeRequests.delete(operation);settled();};
            const respond = (v: unknown) => json(res, 200, v);
            if(path==='/api/application/lifecycle'&&method==='GET'){respond(lifecycleSnapshot());return;}
            if(path==='/api/product'&&method==='GET'){respond({product,planner1:product==='dreamflow'?'USER':'CONFIGURED_MODEL',authority:'SHARED_ENGINE_STORE_V1'});return;}
            if(path==='/api/chat/capabilities'&&method==='GET'){
                respond({schema:'dream-maker.chat-capabilities.v1',version:1,product,seeker:product!=='dreamflow',questionHelp:product!=='dreamflow',reviewFeedback:product!=='dreamflow',projectPresentation:true,attachments:false,roleSkillDispatch:false,rolePluginDispatch:false,perRoleReasoning:false});return;
            }
            if(path==='/api/chat/projects'&&method==='GET'){
                respond({projects:store.projects().map(project=>({...project,presentation:chatProjectPresentation(store,project.id)}))});return;
            }
            if(path==='/api/network/contexts'&&method==='GET'){respond(await networkContexts.snapshot());return;}
            if(path==='/api/magpie/checks'&&method==='GET'){respond(latestMagpieCheck(store));return;}
            if(product==='dreamflow'&&path==='/api/magpie/models'&&method==='GET'){
                if(url.searchParams.size)throw new DomainError('MAGPIE_DESKTOP_MODELS_QUERY_DENIED',400);
                respond(await readDesktopMagpieCatalog(options.desktopMagpieCatalogPort??3425));return;
            }
            if(path==='/api/account-sources'&&method==='GET'){
                if(url.searchParams.has('identities')){
                    if(product!=='dreamflow')throw new DomainError('NOT_FOUND',404);
                    if(url.searchParams.size!==1||url.searchParams.get('identities')!=='1')throw new DomainError('CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID',400);
                    if(!owner?.selectableAccountIdentities)throw new DomainError('NATIVE_OWNER_UNAVAILABLE',409);
                    respond(owner.selectableAccountIdentities());return;
                }
                if(!owner?.registeredAccountSources)throw new DomainError('NATIVE_OWNER_UNAVAILABLE',409);
                respond(owner.registeredAccountSources());return;
            }
            const flowAccountCheckRead=path.match(/^\/api\/projects\/([^/]+)\/flow-account-check$/);
            if(flowAccountCheckRead&&method==='GET'){respond(magpieAccountChecks.latest(flowAccountCheckRead[1]));return;}
            const flowAccountRecoveryRead=path.match(/^\/api\/projects\/([^/]+)\/flow-account-recovery$/);
            if(flowAccountRecoveryRead&&method==='GET'){respond(magpieAccountRecoveries.latest(flowAccountRecoveryRead[1]));return;}
            const budgetSupplementRead=path.match(/^\/api\/runs\/([^/]+)\/custom-budget-supplement$/);
            if(method==='GET'&&budgetSupplementRead){respond(engine.customBudgetSupplementPreview(budgetSupplementRead[1]));return;}
            const checkpointRead=path.match(/^\/api\/runs\/([^/]+)\/executor-checkpoint$/);
            if(checkpointRead&&method==='GET'){respond(engine.executorCheckpointPreview(checkpointRead[1]));return;}
            const mergeRecoveryRead=path.match(/^\/api\/runs\/([^/]+)\/merge-recovery$/);
            if(mergeRecoveryRead&&method==='GET'){respond(engine.mergeRecoveryPreview(mergeRecoveryRead[1]));return;}
            if(product==='dreamflow'&&(path.startsWith('/api/planner1/')||path.startsWith('/api/kimi/')||path==='/api/diagnostics/models'))throw new DomainError('USER_PLANNER_REQUIRED',409);
            // Seeker model picker: read-only catalog, no model request, no budget. classic returns
            // only the registered official whitelist; custom reads the local Magpie /v1/models
            // catalog and filters it by owned_by so an unreachable Magpie keeps its DomainError.
            if(path==='/api/planner1/models'&&method==='GET'){
                if(url.searchParams.getAll('provider').length!==1||url.searchParams.getAll('source').length>1||[...url.searchParams.keys()].some(key=>key!=='provider'&&key!=='source'))throw new DomainError('PLANNER1_MODEL_QUERY_INVALID',400);
                respond(await planner1ModelCatalog({provider:url.searchParams.get('provider')??'',source:url.searchParams.get('source')??undefined,port:options.desktopMagpieCatalogPort??3425,signal:applicationStop.signal}));return;
            }
            const planningRead=path.match(/^\/api\/projects\/([^/]+)\/planning$/);
            if(planningRead&&method==='GET'){store.project(planningRead[1]);respond({operations:interviews.planningStatus(planningRead[1])});return;}
            const flowProfileRead=path.match(/^\/api\/projects\/([^/]+)\/flow-profile$/);
            if(flowProfileRead&&method==='GET'){respond({current:flowProfiles.current(flowProfileRead[1]),executionGranted:false});return;}
            const researchRead=path.match(/^\/api\/projects\/([^/]+)\/research(?:\/([^/]+)\/sources\/([a-f0-9]{64}))?$/);
            if(researchRead && method==='GET'){
                respond(researchRead[2]?projectResearch.source(researchRead[1],researchRead[2],researchRead[3]):{operations:projectResearch.history(researchRead[1]),allowedKeywords:PUBLIC_RESEARCH_TERMS});return;
            }
            // K02: every planner1 control surface goes through one execution gate, so a retired
            // OpenAI/SIWC upstream cannot be reached from the browser, a stale config or a probe.
            const planner1Active = (purpose: string) => assertPlanner1DispatchAllowed(planner1Binding(settings.value), purpose);
            if (path === '/api/config' && method === 'GET') {
                respond({...settings.public(),flows:engine.flowOptions()});
                return;
            }
            if(path==='/api/planner1/local/status'&&method==='GET'){
                respond(localPlanner1.status(settings.value));return;
            }
            if(path==='/api/onboarding'&&method==='GET'){
                respond(setupSnapshot({product,config:settings.value,keyPresent:!!process.env[settings.value.dsh.keyEnv],probe:await probeGate(),budget:owner?.budgetStatus?.(),
                    kimi:product==='dreamflow'?undefined:kimiStatus({admission:kimiDeps?.admission,credentials:kimiDeps?.credentials,lastAuthFailure:kimiDeps?.authFailures?.last()??null}),safetyReady:nativeReadiness(settings.value).ok}));return;
            }
            if(path==='/api/maintenance'&&method==='GET'){
                respond({schema:'dream-maker.maintenance.v1',scope:'APPLICATION_STATE_ONLY',completeProjectBackup:false,snapshots:maintenance.list(),usage:maintenance.usage(),modelsCalled:0,automaticResume:false,storageVolume:await probeStorageVolumeHealth(data)});return;
            }
            if(path==='/api/maintenance/registered-backups'&&method==='GET'){
                const usage=registeredBackups.usage();respond({schema:'dream-maker.registered-maintenance.v1',scope:'REGISTERED_STATE_AND_PROJECT_FILES',completeProjectBackup:false,items:registeredBackups.list(),usage,modelsCalled:0,automaticResume:false});return;
            }
            const sqliteRead=path.match(/^\/api\/projects\/([^/]+)\/sqlite-data$/);
            if(method==='GET'&&sqliteRead){
                if(url.searchParams.size)throw new DomainError('SQLITE_DATA_READ_QUERY_DENIED',400);
                respond(await engine.sqliteDataStatus(sqliteRead[1]));return;
            }
            const sqliteRecoveryRead=path.match(/^\/api\/projects\/([^/]+)\/sqlite-data\/recovery$/);
            if(method==='GET'&&sqliteRecoveryRead){
                if(url.searchParams.size)throw new DomainError('SQLITE_DATA_RECOVERY_QUERY_DENIED',400);
                respond(engine.sqliteDataRecoveryPlan(sqliteRecoveryRead[1]));return;
            }
            const sqliteRestoreRead=path.match(/^\/api\/maintenance\/snapshots\/(snapshot_[a-f0-9]{32})\/rehearsals\/(rehearsal_[a-f0-9]{32})\/projects\/([^/]+)\/sqlite-data$/);
            if(method==='GET'&&sqliteRestoreRead){
                const [,snapshotId,rehearsalId,pid]=sqliteRestoreRead,{version}=await maintenance.sqliteDataSource(snapshotId,rehearsalId,pid),target=engine.sqliteDataPlan(pid);
                respond({schema:'dream-maker.sqlite-data-restore-plan.v1',scope:'PROJECT_SQLITE_DATA_ONLY',engineStarted:false,projectId:pid,snapshotId,rehearsalId,
                    source:{revision:version.revision,contentHash:version.contentHash,imageHash:version.image.imageHash,imageBytes:version.image.imageBytes,at:version.at},
                    target:{revision:target.revision,contentHash:target.contentHash}});return;
            }
            const jsonRead=path.match(/^\/api\/projects\/([^/]+)\/json-data$/),jsonRunRead=path.match(/^\/api\/runs\/([^/]+)\/json-data$/);
            if(method==='GET'&&(jsonRead||jsonRunRead)){
                respond(jsonRead?jsonData.read(jsonRead[1]):jsonData.readRun(jsonRunRead![1],text(url.searchParams.get('treeHash'),64)));return;
            }
            const jsonRestoreRead=path.match(/^\/api\/maintenance\/snapshots\/(snapshot_[a-f0-9]{32})\/rehearsals\/(rehearsal_[a-f0-9]{32})\/projects\/([^/]+)\/json-data$/);
            if(method==='GET'&&jsonRestoreRead){
                const [,snapshotId,rehearsalId,pid]=jsonRestoreRead,target=jsonData.read(pid),{version}=maintenance.jsonDataSource(snapshotId,rehearsalId,pid);
                respond({schema:'dream-maker.json-data-restore-plan.v1',scope:'PROJECT_JSON_DATA_ONLY',engineStarted:false,projectId:pid,snapshotId,rehearsalId,source:{revision:version.revision,contentHash:version.contentHash,bytes:Buffer.byteLength(JSON.stringify(version.document)),at:version.at},target:{revision:target.revision,contentHash:target.contentHash,bytes:Buffer.byteLength(JSON.stringify(target.document))}});return;
            }
            const dataRead=path.match(/^\/api\/projects\/([^/]+)\/data$/),previewDataRead=path.match(/^\/api\/runs\/([^/]+)\/data$/);
            if(method==='GET'&&(dataRead||previewDataRead)){
                respond(dataRead?managedData.read(dataRead[1]):managedData.readPreview(previewDataRead![1],text(url.searchParams.get('treeHash'),64)));return;
            }
            const dataRestoreRead=path.match(/^\/api\/maintenance\/snapshots\/(snapshot_[a-f0-9]{32})\/rehearsals\/(rehearsal_[a-f0-9]{32})\/projects\/([^/]+)\/data$/);
            if(method==='GET'&&dataRestoreRead){
                const [,snapshotId,rehearsalId,pid]=dataRestoreRead,target=managedData.read(pid),{version}=maintenance.managedDataSource(snapshotId,rehearsalId,pid);
                respond({schema:'dream-maker.managed-data-restore-plan.v1',scope:'FIXED_DEMO_DATA_ONLY',engineStarted:false,projectId:pid,snapshotId,rehearsalId,source:{revision:version.revision,contentHash:version.contentHash,taskCount:version.tasks.length,at:version.at},target:{revision:target.revision,contentHash:target.contentHash,taskCount:target.tasks.length}});return;
            }
            if (path === '/api/help' && method === 'GET') {
                respond({topics:HELP,modelCalls:0,automaticActions:false});return;
            }
            const flowReport=path.match(/^\/api\/runs\/([^/]+)\/report$/);
            if(flowReport&&method==='GET'){respond(engine.flowReport(flowReport[1]));return;}
            // Queue polling must never re-run account/probe preparation or grant work.
            if(path==='/api/dispatch'&&method==='GET'){respond({dispatch:engine.dispatchStatus()});return;}
            if (path === '/api/diagnostics' && method === 'GET') {
                respond({
                    runtime: { node: process.version, platform: process.platform },
                    dispatch:engine.dispatchStatus(),
                    // The readiness reason list says "probes required"; the gate says WHICH roles.
                    // Cached briefly: diagnostics is polled and prepareProbes touches the custody key.
                    native: { ...engine.executionReadiness(), probeGate: await probeGate() },
                    // Was a hardcoded 'ARCHON_NATIVE_UNVERIFIED' from when nothing native was wired; answering
                    // from the binding is the difference between a diagnostic and a slogan.
                    archon: archonBindingStatus(owner ? resolve(root, 'config/native-owner.local.json') : resolve(root, 'config/native-owner.local.json'), resolve(data, 'native-audit.json')),
                    layaMode: settings.value.laya.mode,
                    // Dream Maker keeps planner1; everything after the frozen spec is one of two
                    // named flows. Resolved read-only so a blocked flow is visible before a run,
                    // with the code that blocks it rather than a banner discovered mid-build.
                    flows: engine.flowOptions(),
                    auth: 'LOCAL_SESSION_HTTPONLY',
                    cloudCallsAutomatic: false,
                    // A07/K09: is "Laya OFF" actually observed per role turn? Zero turns is not proof.
                    layaObservation: engine.layaObservation() ?? layaObserver.summary(),
                    // A09: SHADOW is observation only; nothing here dispatches or approves.
                    shadow: {
                        mode: shadowMirror.stats().mode,
                        // Reported so a typo or an unapproved mode is never a silent downgrade.
                        requested: orcaRequest.requested,
                        degraded: orcaRequest.degraded,
                        reason: orcaRequest.reason,
                        stats: shadowMirror.stats()
                    },
                    // C03: credential + Extra Usage evidence, with no token in the payload.
                    kimi: kimiStatus({ admission: kimiDeps?.admission, credentials: kimiDeps?.credentials, lastAuthFailure: kimiDeps?.authFailures?.last() ?? null }),
                    // The bridge topology is an operational fact, not a permission.
                    bridge: {
                        topology: kimiBridgeTopology,
                        running: kimiBridgeRunning?.() === true,
                        error: kimiBridgeError,
                        frames: kimiBridgeFrames.snapshot()
                    }
                });
                return;
            }
            // Read-only controller view. configPath never leaves the server; the browser only ever sees
            // the declared selector/node and what the controller currently reports.
            if (path === '/api/clash' && method === 'GET') {
                respond(await clash.inspect());
                return;
            }
            // Read-only: is "Laya OFF" actually observed for every role turn in this process?
            if (path === '/api/laya/observation' && method === 'GET') {
                respond(engine.layaObservation() ?? layaObserver.summary());
                return;
            }
            // Read-only SHADOW view: what Orca would be allowed to see, and how much was dropped.
            if (path === '/api/orca/shadow' && method === 'GET') {
                respond({ mode: shadowMirror.stats().mode, stats: shadowMirror.stats(), recent: shadowMirror.recent() });
                return;
            }
            // Read-only: what the four-role minimum probe gate still needs. The owner asks this
            // before a Live run instead of discovering NATIVE_REAL_PROBES_REQUIRED mid-build.
            if (path === '/api/native/probes' && method === 'GET') {
                if (!owner || typeof owner.probeStatus !== 'function') throw new DomainError('NATIVE_OWNER_UNAVAILABLE', 409);
                respond(await owner.probeStatus(model));
                return;
            }
            if (path === '/api/kimi/status' && method === 'GET') {
                respond(kimiStatus({ admission: kimiDeps?.admission, credentials: kimiDeps?.credentials }));
                return;
            }
            const verifierRoute=path.match(/^\/api\/projects\/([^/]+)\/native-verifier$/);
            if(verifierRoute&&method==='GET'){const p=store.project(verifierRoute[1]);if(!p.specId)throw new DomainError('VERIFIER_SPEC_BINDING_INVALID',409);respond(engine.inspectVerifier(p.id,store.spec(p.specId).hash));return;}
            if (path === '/api/planner1/siwc/status' && method === 'GET') { planner1Active('siwc_status'); respond(await siwc.status());return; }
            if (path === '/api/planner1/siwc/profiles' && method === 'GET') { planner1Active('siwc_profiles'); respond({profiles:await siwc.profiles()});return; }
            if (path === '/api/planner1/siwc/models' && method === 'GET') { planner1Active('siwc_models'); respond(await siwc.models());return; }
            if (path === '/api/projects' && method === 'GET') {
                const entry=url.searchParams.has('entry')?choose(url.searchParams.get('entry'),ENGINE_ENTRIES):null;
                const listedProjects=store.projects();
                // Each entry (DM / DF) lists only its own projects; the entry comes from the same decision.
                respond({ projects: entry?listedProjects.filter(project=>workbench.engines.entry(project.id)===entry):listedProjects });
                return;
            }
            const workbenchEngine=path.match(/^\/api\/projects\/([^/]+)\/(engine|roles)$/);
            if(workbenchEngine&&method==='GET'){respond(workbenchEngine[2]==='engine'?workbench.engine(workbenchEngine[1]):workbench.roleCatalog(workbenchEngine[1]));return;}
            const workbenchStarGet=path.match(/^\/api\/studio\/stars\/([^/]+)(?:\/(explanation))?$/);
            if(workbenchStarGet&&method==='GET'){
                if([...url.searchParams.keys()].some(name=>name!=='projectId')||url.searchParams.getAll('projectId').length!==1)throw new DomainError('WORKBENCH_QUERY_INVALID',400);
                const pid=text(url.searchParams.get('projectId'),120);
                respond(workbenchStarGet[2]?{sessions:workbench.explanationsFor(pid,workbenchStarGet[1])}:workbench.star(pid,workbenchStarGet[1]));return;
            }
            const ev = path.match(/^\/api\/projects\/([^/]+)\/(events|prework-events)$/);
            if (ev && method === 'GET') {
                store.project(ev[1]);
                let cursor = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
                if (!Number.isSafeInteger(cursor) || cursor < 0)
                    throw new DomainError('INVALID_CURSOR');
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
                let ticks = 0,timer:ReturnType<typeof setInterval>|undefined;
                const poll = () => { try {
                    const events = store.events(ev[1], cursor);
                    for (const event of events) {
                        cursor = event.id;
                        const projected=ev[2]==='prework-events'?storedPreworkEvent(store,ev[1],event):event;
                        if(projected)res.write(`id: ${event.id}\nevent: update\ndata: ${JSON.stringify(projected)}\n\n`);
                    }
                    if (++ticks % 20 === 0)
                        res.write(': heartbeat\n\n');
                }
                catch {
                    if(timer)clearInterval(timer);
                    res.end();
                } };
                poll();
                if(res.writableEnded)return;
                timer = setInterval(poll, 250);
                const closeStream=():Promise<void>=>{
                    clearInterval(timer);eventStreamClosers.delete(closeStream);
                    if(res.destroyed||res.writableFinished)return Promise.resolve();
                    return new Promise<void>(done=>{
                        const finish=()=>{clearTimeout(deadline);res.off('finish',finish);res.off('close',finish);done();};
                        const deadline=setTimeout(()=>{res.destroy();finish();},500);
                        res.once('finish',finish);res.once('close',finish);
                        try{res.end('event: application-stopping\ndata: {"reason":"APPLICATION_STOPPING"}\n\n');}catch{res.destroy();finish();}
                    });
                };
                eventStreamClosers.add(closeStream);
                res.on('close', () => {clearInterval(timer);eventStreamClosers.delete(closeStream);});
                return;
            }
            const proj = path.match(/^\/api\/projects\/([^/]+)$/);
            if (proj && method === 'GET') {
                respond(snapshot(proj[1]));
                return;
            }
            const planHistory = path.match(/^\/api\/projects\/([^/]+)\/plans$/);
            const planDocument=path.match(/^\/api\/projects\/([^/]+)\/plan-document$/);
            if(planDocument&&method==='GET'){respond(userPlans.export(planDocument[1]));return;}
            if (planHistory && method === 'GET') {
                const after = integer(Number(url.searchParams.get('afterRevision') ?? 0), 0, 1000000);
                const limit = integer(Number(url.searchParams.get('limit') ?? 50), 1, 100);
                const plans = store.planVersions(planHistory[1], after, limit);
                respond({ plans, nextRevision: plans.length === limit ? plans.at(-1)!.revision : null });
                return;
            }
            const documentationGet=path.match(/^\/api\/runs\/([^/]+)\/documentation-correction$/);
            if(documentationGet&&method==='GET'){
                if(url.searchParams.getAll('file').length!==1||[...url.searchParams.keys()].some(k=>k!=='file'))throw new DomainError('DOCUMENTATION_CORRECTION_QUERY_INVALID',400);
                respond({candidate:engine.documentationCorrectionCandidate(documentationGet[1],text(url.searchParams.get('file'),200))});return;
            }
            const codeRepairGet=path.match(/^\/api\/runs\/([^/]+)\/bounded-code-repair$/);
            if(codeRepairGet&&method==='GET'){
                if(url.searchParams.getAll('file').length!==1||[...url.searchParams.keys()].some(k=>k!=='file'))throw new DomainError('BOUNDED_CODE_REPAIR_QUERY_INVALID',400);
                const file=text(url.searchParams.get('file'),200);if(file!=='main.mjs')throw new DomainError('BOUNDED_CODE_REPAIR_SCOPE_INVALID',400);
                respond({candidate:engine.boundedCodeRepairCandidate(codeRepairGet[1],file)});return;
            }
            const supplementGet=path.match(/^\/api\/runs\/([^/]+)\/review-supplement$/);
            if(supplementGet&&method==='GET'){respond({candidate:engine.reviewSupplementCandidate(supplementGet[1])});return;}
            const runGet = path.match(/^\/api\/runs\/([^/]+)\/(export|files|preview)$/);
            if (runGet && method === 'GET') {
                const r = store.run(runGet[1]);
                if (runGet[2] === 'export') {
                    const archive = engine.export(r.id);
                    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="dream-maker-${r.mode}-${r.id}.zip"`, 'cache-control': 'no-store' });
                    res.end(archive);
                    return;
                }
                if (runGet[2] === 'files') {
                    const name = url.searchParams.get('path');
                    const workspace=readWorkspace(r,data);
                    respond(name ? { path: name, content: get(workspace, name).toString('utf8') } : { files: files(workspace) });
                    return;
                }
                if (r.mode !== 'demo')
                    throw new DomainError('LIVE_PREVIEW_REQUIRES_ISOLATED_ORIGIN', 409);
                if (!['READY_FOR_DELIVERY', 'ACCEPTED'].includes(r.state))
                    throw new DomainError('PREVIEW_NOT_READY', 409);
                let token = [...previews].find(([, rid]) => rid === r.id)?.[0];
                if (!token) {
                    token = randomBytes(20).toString('hex');
                    previews.set(token, r.id);
                }
                respond({ url: `http://127.0.0.1:${previewPort}/${token}/index.html`, scope: 'TRUSTED_DEMO_SEPARATE_ORIGIN',...managedData.previewBinding(r.id) });
                return;
            }
            if (!['POST', 'PUT', 'PATCH'].includes(method))
                throw new DomainError('NOT_FOUND', 404);
            // A missing/blank idempotency key used to surface as INVALID_TEXT — a code that points the
            // reader at the request body while the real problem is a missing header. Name it precisely.
            const rawKey = req.headers['idempotency-key'];
            if (typeof rawKey !== 'string' || rawKey.trim() === '')
                throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400, '写操作必须带 idempotency-key 头；缺少它无法保证重放安全。');
            // Inbound role names accept their product spellings (seeker -> planner1,
            // planner -> planner2); every handler below still works on the stable wire id.
            const input = normalizeRoleFields(await body(req)), key = text(rawKey, 120);
            if(closingApplication)throw new DomainError('APPLICATION_STOPPING',409);
            if(path==='/api/application/lifecycle'&&method==='POST'){
                if(Object.keys(input).some(name=>!['choice','confirmed'].includes(name)))throw new DomainError('LIFECYCLE_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('LIFECYCLE_CONSENT_REQUIRED',403);
                const choice=choose(input.choice,['BACKGROUND_CURRENT_WORK','PAUSE']);
                await store.once(`${method}:${path}:${key}`,input,async()=>{
                    if(choice==='BACKGROUND_CURRENT_WORK'&&workPausing)throw new DomainError('APPLICATION_PAUSING',409);
                    if(choice==='BACKGROUND_CURRENT_WORK'||!workPausePromise){
                        store.record('ApplicationLifecycle',null,null,{choice,actor:'local-session:'+hash(sid!),at:new Date().toISOString(),runIds:engine.activeRunIds(),automaticResume:false});
                        if(choice==='PAUSE')requestWorkPause(operation);else{lastChoice=choice;lifecycleChangedAt=new Date().toISOString();}
                    }
                    return {schema:'dream-maker.lifecycle-intent.v1',choice};
                });
                respond(lifecycleSnapshot());return;
            }
            if(workPausing)throw new DomainError('APPLICATION_PAUSING',409,'本实例已停止新的操作。可继续查看已有方案和状态；重新打开后先核对原任务，再明确继续。');
            // Leaving acknowledgement covers only the work at that decision, never future writes.
            // Idempotent lifecycle replays above return the current state and cannot restore it.
            clearBackgroundChoice();
            if(path==='/api/network/local-check'&&method==='POST'){
                if(Object.keys(input).length)throw new DomainError('NETWORK_LOCAL_CHECK_INPUT_INVALID',400);
                const result=await store.once(`${method}:${path}:${key}`,input,async()=>{const check=await networkContexts.diagnose();return await networkContexts.snapshotForCheck(check);});
                respond(await networkContexts.replayCheck(result));return;
            }
            if(path==='/api/network/codex-metadata'&&method==='POST'){
                if(Object.keys(input).length)throw new DomainError('NETWORK_CODEX_METADATA_INPUT_INVALID',400);
                const result=await store.once(`${method}:${path}:${key}`,input,readCodexMetadataForDashboard) as CodexMetadataObservation;
                respond(await refreshCodexMetadataObservation(result));return;
            }
            const budgetSupplementWrite=path.match(/^\/api\/runs\/([^/]+)\/custom-budget-supplement$/);
            if(method==='POST'&&budgetSupplementWrite){
                if(Object.keys(input).some(k=>!['confirmed','expectedVersion','expectedRevision','flow','roles'].includes(k)))throw new DomainError('CUSTOM_BUDGET_SUPPLEMENT_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('CUSTOM_BUDGET_SUPPLEMENT_CONFIRMATION_REQUIRED',403);
                const actor='local-session:'+hash(sid!),operationHash=hash({method,path,key,session:hash(sid!)});
                await store.once('custom-budget-supplement:'+method+':'+path+':'+key,{...input,actor},async()=>({operationHash}));
                respond(await engine.approveCustomBudgetSupplement(budgetSupplementWrite[1],input,actor,operationHash));return;
            }
            const checkpointWrite=path.match(/^\/api\/runs\/([^/]+)\/executor-checkpoint$/);
            if(method==='POST'&&checkpointWrite){
                if(Object.keys(input).some(name=>!['confirmed','previewHash'].includes(name)))throw new DomainError('EXECUTOR_CHECKPOINT_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('EXECUTOR_CHECKPOINT_CONSENT_REQUIRED',403);
                const request={confirmed:true,previewHash:text(input.previewHash,64)},actor='local-session:'+hash(sid!),operationHash=hash({method,path,key,session:hash(sid!)});
                await store.once('executor-checkpoint:'+method+':'+path+':'+key,{...request,actor},async()=>({schema:'dream-maker.executor-checkpoint-intent.v1',operationHash}));
                respond(await engine.prepareExecutorCheckpoint(checkpointWrite[1],request,operationHash,actor));return;
            }
            const checkpointResume=path.match(/^\/api\/runs\/([^/]+)\/executor-checkpoint\/resume$/);
            if(method==='POST'&&checkpointResume){
                if(Object.keys(input).some(name=>name!=='confirmed'))throw new DomainError('EXECUTOR_CHECKPOINT_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('EXECUTOR_CHECKPOINT_CONSENT_REQUIRED',403);
                const request={confirmed:true},actor='local-session:'+hash(sid!),operationHash=hash({method,path,key,session:hash(sid!)});
                // Only the request identity is cached; the replay is proven from the original Store record.
                await store.once('executor-checkpoint-resume:'+method+':'+path+':'+key,{...request,actor},async()=>({schema:'dream-maker.executor-checkpoint-resume-intent.v1',operationHash}));
                respond(engine.resumeExecutorCheckpoint(checkpointResume[1],request,operationHash,actor));return;
            }
            const mergeRecoveryWrite=path.match(/^\/api\/runs\/([^/]+)\/merge-recovery$/);
            if(method==='POST'&&mergeRecoveryWrite){
                if(Object.keys(input).some(name=>!['choice','previewHash','expectedHash','confirmed'].includes(name)))throw new DomainError('MERGE_RECOVERY_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('MERGE_RECOVERY_CONSENT_REQUIRED',403);
                const request={choice:choose(input.choice,['KEEP_FILES_AND_END','RESTORE_BASE_AND_END']),previewHash:text(input.previewHash,64),expectedHash:text(input.expectedHash,64),confirmed:true};
                const actor='local-session:'+hash(sid!),operationHash=hash({method,path,key,session:hash(sid!)});
                // Persist identity only. Every replay goes through the Engine's actual source/copy checks.
                await store.once('merge-recovery:'+method+':'+path+':'+key,{...request,actor},async()=>({schema:'dream-maker.merge-recovery-intent.v1',operationHash}));
                respond(await engine.recoverMerge(mergeRecoveryWrite[1],request,operationHash,actor));return;
            }
            const jsonExecute=path.match(/^\/api\/runs\/([^/]+)\/json-data\/execute$/);
            if(method==='POST'&&jsonExecute){
                if(Object.keys(input).some(name=>!['treeHash','expectedRevision','confirmed'].includes(name)))throw new DomainError('JSON_DATA_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('JSON_DATA_CONSENT_REQUIRED',403);
                respond(await engine.executeJsonData(jsonExecute[1],text(input.treeHash,64),integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER),true,hash({method,path,key,session:hash(sid!)}),'local-session:'+hash(sid!)));return;
            }
            const jsonWrite=path.match(/^\/api\/runs\/([^/]+)\/json-data(\/import)?$/),jsonRestore=path.match(/^\/api\/projects\/([^/]+)\/json-data\/restore$/);
            if(method==='POST'&&(jsonWrite||jsonRestore)){
                const allowed=jsonRestore?['snapshotId','rehearsalId','expectedRevision','confirmed']:jsonWrite![2]?['treeHash','document','confirmed']:['treeHash','document','expectedRevision'];
                if(Object.keys(input).some(name=>!allowed.includes(name)))throw new DomainError('JSON_DATA_INPUT_INVALID',400);
                if((jsonRestore||jsonWrite?.[2])&&input.confirmed!==true)throw new DomainError('JSON_DATA_CONSENT_REQUIRED',403);
                const operationHash=hash({method,path,key,session:hash(sid!)}),actor='local-session:'+hash(sid!);
                // Store only operation metadata; document contents never enter the generic request cache.
                if(jsonRestore){const pid=jsonRestore[1],snapshotId=text(input.snapshotId,50),rehearsalId=text(input.rehearsalId,50);respond(jsonData.restore(pid,integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER),()=>maintenance.jsonDataSource(snapshotId,rehearsalId,pid),operationHash,actor));}
                else if(jsonWrite![2])respond(jsonData.import(jsonWrite![1],text(input.treeHash,64),input.document,true,operationHash,actor));
                else respond(jsonData.write(jsonWrite![1],text(input.treeHash,64),input.document,integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER),operationHash,actor));
                return;
            }
            const dataWrite=path.match(/^\/api\/runs\/([^/]+)\/data(\/import)?$/),dataRestore=path.match(/^\/api\/projects\/([^/]+)\/data\/restore$/);
            if(method==='POST'&&(dataWrite||dataRestore)){
                const allowed=dataRestore?['snapshotId','rehearsalId','expectedRevision','confirmed']:dataWrite![2]?['treeHash','tasks','confirmed']:['treeHash','tasks','expectedRevision'];
                if(Object.keys(input).some(name=>!allowed.includes(name)))throw new DomainError('MANAGED_DATA_INPUT_INVALID',400);
                if((dataRestore||dataWrite?.[2])&&input.confirmed!==true)throw new DomainError('MANAGED_DATA_CONSENT_REQUIRED',403);
                const operationHash=hash({method,path,key,session:hash(sid!)}),actor='local-session:'+hash(sid!);
                // Dataset operations retain metadata only; never cache task payloads in Store.once.
                if(dataRestore){
                    const pid=dataRestore[1],snapshotId=text(input.snapshotId,50),rehearsalId=text(input.rehearsalId,50);
                    respond(managedData.restoreFromRehearsal(pid,integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER),()=>maintenance.managedDataSource(snapshotId,rehearsalId,pid),operationHash,actor));
                }else if(dataWrite![2])respond(managedData.importBrowser(dataWrite![1],text(input.treeHash,64),input.tasks,true,operationHash,actor));
                else respond(managedData.writePreview(dataWrite![1],text(input.treeHash,64),input.tasks,integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER),operationHash,actor));
                return;
            }
            const sqliteRestore=path.match(/^\/api\/projects\/([^/]+)\/sqlite-data\/restore$/);
            if(method==='POST'&&sqliteRestore){
                const allowed=['snapshotId','rehearsalId','expectedRevision','confirmed'];
                if(Object.keys(input).some(name=>!allowed.includes(name)))throw new DomainError('SQLITE_DATA_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('SQLITE_DATA_CONSENT_REQUIRED',403);
                const pid=sqliteRestore[1],snapshotId=text(input.snapshotId,50),rehearsalId=text(input.rehearsalId,50),
                    operationHash=hash({method,path,key,session:hash(sid!)}),actor='local-session:'+hash(sid!);
                respond(await engine.restoreSqliteData(pid,integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER),
                    ()=>maintenance.sqliteDataSource(snapshotId,rehearsalId,pid),operationHash,actor));return;
            }
            const sqliteRecovery=path.match(/^\/api\/projects\/([^/]+)\/sqlite-data\/recovery$/);
            if(method==='POST'&&sqliteRecovery){
                if(Object.keys(input).some(name=>!['operationHash','confirmed'].includes(name)))throw new DomainError('SQLITE_DATA_RECOVERY_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('SQLITE_DATA_RECOVERY_CONSENT_REQUIRED',403);
                const operationHash=text(input.operationHash,64);
                if(!/^[a-f0-9]{64}$/.test(operationHash))throw new DomainError('SQLITE_DATA_RECOVERY_INPUT_INVALID',400);
                const pid=sqliteRecovery[1],actor='local-session:'+hash(sid!),
                    operation=hash({method,path,key,session:hash(sid!)}),
                    expected={schema:'dream-maker.sqlite-data-recovery-request.v1',projectId:pid,operationHash,inputHash:hash(input)};
                const receipt=await store.once(`sqlite-data-recovery:${method}:${path}:${key}`,input,async()=>expected);
                if(hash(receipt)!==hash(expected))throw new DomainError('SQLITE_DATA_RECOVERY_REQUEST_INVALID',409);
                respond(await engine.recoverSqliteData(pid,operationHash,true,operation,actor));return;
            }
            const rehearsalPath=path.match(/^\/api\/maintenance\/snapshots\/(snapshot_[a-f0-9]{32})\/rehearse$/);
            const registeredExtract=path.match(/^\/api\/maintenance\/registered-backups\/(snapshot_[a-f0-9]{32})\/extract$/);
            if(method==='POST'&&(path==='/api/maintenance/registered-backups'||registeredExtract)){
                if(Object.keys(input).some(name=>name!=='confirmed'))throw new DomainError('MAINTENANCE_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('MAINTENANCE_CONSENT_REQUIRED',403);
                const operationHash=hash({method,path,key,actor:hash(sid!)});
                // Cache the request identity only. Every replay rechecks the actual archived/copied bytes.
                await store.once('registered:'+method+':'+path+':'+key,{...input,actor:hash(sid!)},async()=>({schema:'dream-maker.registered-operation.v1',operationHash}));
                respond(registeredExtract?await registeredBackups.extractCustodied(registeredExtract[1],operationHash):await registeredBackups.createCustodied(operationHash));return;
            }
            if(method==='POST'&&(path==='/api/maintenance/snapshots'||rehearsalPath)){
                if(Object.keys(input).some(name=>name!=='confirmed'))throw new DomainError('MAINTENANCE_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('MAINTENANCE_CONSENT_REQUIRED',403);
                const operation=hash({method,path,key});
                // Bind replay to the same request, but never cache a current file-integrity claim.
                // The core uses a deterministic operation ID and rechecks actual bytes on every replay.
                await store.once(`${method}:${path}:${key}`,input,async()=>({schema:'dream-maker.maintenance-operation.v1',operationHash:hash(operation)}));
                respond(rehearsalPath?await maintenance.rehearseCustodied(rehearsalPath[1],operation):await maintenance.createCustodied(operation));return;
            }
            const flowProfileWrite=path.match(/^\/api\/projects\/([^/]+)\/flow-profile$/);
            const flowPreparation=path.match(/^\/api\/projects\/([^/]+)\/flow-preparation$/);
            const flowAccountSources=path.match(/^\/api\/projects\/([^/]+)\/flow-account-sources$/);
            const flowAccountCheck=path.match(/^\/api\/projects\/([^/]+)\/flow-account-check$/);
            const flowAccountRecovery=path.match(/^\/api\/projects\/([^/]+)\/flow-account-recovery$/);
            const flowRoleProbe=path.match(/^\/api\/projects\/([^/]+)\/flow-role-probe$/);
            const flowRoleStatus=path.match(/^\/api\/projects\/([^/]+)\/flow-role-status$/);
            const memberRecommendation=product==='dreamflow'&&path.match(/^\/api\/projects\/([^/]+)\/flow-member-recommendation$/);
            if(memberRecommendation&&method==='POST'){
                const fields=['specHash','profileHash','preparation','roleId','confirmed'],digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
                if(Object.keys(input).length!==fields.length||fields.some(k=>!Object.hasOwn(input,k))||!digest(input.specHash)||!digest(input.profileHash)||typeof input.roleId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(input.roleId)||input.confirmed!==true)throw new DomainError('CUSTOM_MAGPIE_SELECTION_SCOPE_INVALID',400);
                const selected=object(input.preparation);
                if(Object.keys(selected).length!==2||!digest(selected.identityHash)||!digest(selected.contentHash))throw new DomainError('FLOW_PREPARATION_INPUT_INVALID',400);
                if(engine.activeJobCount||model.activeCalls||interviews.activeOperations||siwc.isBusy)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
                if(!owner?.recommendCustomMagpieMember)throw new DomainError('CUSTOM_MAGPIE_ESTIMATE_UNAVAILABLE',409);
                const result=await owner.recommendCustomMagpieMember({projectId:memberRecommendation[1],specHash:input.specHash,profileHash:input.profileHash,preparation:{identityHash:selected.identityHash,contentHash:selected.contentHash}},input.roleId,applicationStop.signal);
                respond(result);return;
            }
            if(flowRoleStatus&&method==='POST'){
                const fields=['specHash','profileHash','preparation','roleId',...(Object.hasOwn(input,'requestId')?['requestId']:[])],digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
                if(Object.keys(input).length!==fields.length||fields.some(k=>!Object.hasOwn(input,k))||!digest(input.specHash)||!digest(input.profileHash)||typeof input.roleId!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(input.roleId))throw new DomainError('CUSTOM_PROBE_INPUT_INVALID',400);
                if(Object.hasOwn(input,'requestId')&&(typeof input.requestId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(input.requestId)))throw new DomainError('CUSTOM_PROBE_INPUT_INVALID',400);
                const selected=object(input.preparation);
                if(Object.keys(selected).length!==2||!digest(selected.identityHash)||!digest(selected.contentHash))throw new DomainError('CUSTOM_PROBE_INPUT_INVALID',400);
                const operation=input.requestId?hash({method:'POST',path:`/api/projects/${flowRoleStatus[1]}/flow-role-probe`,requestId:input.requestId}):undefined;
                respond(await engine.customRoleProbeStatus({projectId:flowRoleStatus[1],specHash:input.specHash,profileHash:input.profileHash,preparation:{identityHash:selected.identityHash,contentHash:selected.contentHash}},input.roleId,operation));return;
            }
            if(flowRoleProbe&&method==='POST'){
                const fields=['specHash','profileHash','preparation','roleId','confirmed',...(Object.hasOwn(input,'requestId')?['requestId']:[])],digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
                if(Object.keys(input).length!==fields.length||fields.some(k=>!Object.hasOwn(input,k))||!digest(input.specHash)||!digest(input.profileHash)||typeof input.roleId!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(input.roleId))throw new DomainError('CUSTOM_PROBE_INPUT_INVALID',400);
                if(Object.hasOwn(input,'requestId')&&(typeof input.requestId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(input.requestId)))throw new DomainError('CUSTOM_PROBE_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('CUSTOM_PROBE_CONFIRMATION_REQUIRED',403);
                const selected=object(input.preparation);
                if(Object.keys(selected).length!==2||!digest(selected.identityHash)||!digest(selected.contentHash))throw new DomainError('CUSTOM_PROBE_INPUT_INVALID',400);
                const actor='local-session:'+hash(sid!),operation=input.requestId?hash({method,path,requestId:input.requestId}):hash({method,path,key,actor}),expected={schema:'dream-maker.custom-probe-request.v1',requestHash:hash(input)};
                // Idempotency binds inputs; it never caches a volatile qualification or dispatches inside a SQLite transaction.
                const replay=await store.once(`${method}:${path}:${key}`,input,async()=>expected);
                if(hash(replay)!==hash(expected))throw new DomainError('CUSTOM_PROBE_INPUT_INVALID',409);
                const selection={projectId:flowRoleProbe[1],specHash:input.specHash,profileHash:input.profileHash,preparation:{identityHash:selected.identityHash,contentHash:selected.contentHash}};
                if(model.activeCalls||interviews.activeOperations||siwc.isBusy){engine.refuseCustomRoleProbe(selection,input.roleId,operation);throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);}
                const receipt=await engine.probeCustomRole(selection,input.roleId,operation,true,applicationStop.signal);
                respond({scope:'MINIMUM_ROLE_ONLY',receipt,executionGranted:false,fourRoleLive:'NOT_RUN'});return;
            }
            if(flowAccountRecovery&&method==='POST'){
                if(Object.keys(input).length!==2||!Object.hasOwn(input,'confirmed')||typeof input.expectedTargetHash!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedTargetHash))throw new DomainError('MAGPIE_ACCOUNT_RECOVERY_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('MAGPIE_ACCOUNT_RECOVERY_CONSENT_REQUIRED',403);
                if(engine.activeJobCount||model.activeCalls||interviews.activeOperations||siwc.isBusy)throw new DomainError('MAGPIE_ACCOUNT_RECOVERY_BUSY',409);
                const pid=flowAccountRecovery[1],actor='local-session:'+hash(sid!),targetHash=input.expectedTargetHash;
                const receipt=await store.once(`${method}:${path}:${key}`,input,async()=>({schema:'dream-maker.magpie-account-recovery-request.v1',projectId:pid,targetHash,actorHash:hash(actor),resultHash:hash({...await magpieAccountRecoveries.reconcile(pid,targetHash,actor,applicationStop.signal),restartRequired:false})}));
                const result=magpieAccountRecoveries.latest(pid);
                if(Object.keys(object(receipt)).length!==5||receipt.schema!=='dream-maker.magpie-account-recovery-request.v1'||receipt.projectId!==pid||receipt.targetHash!==targetHash||receipt.actorHash!==hash(actor)||result.status!=='RECOVERED'||result.targetHash!==targetHash||receipt.resultHash!==hash({...result,restartRequired:false}))throw new DomainError('MAGPIE_ACCOUNT_RECOVERY_RECEIPT_INVALID',409);
                respond(result);return;
            }
            if(path==='/api/account-sources'&&method==='POST'){
                if(Object.keys(input).length!==3||!['sourceId','label','confirmed'].every(k=>Object.hasOwn(input,k))||typeof input.sourceId!=='string'||typeof input.label!=='string')throw new DomainError('CUSTOM_ACCOUNT_SOURCE_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('CUSTOM_ACCOUNT_SOURCE_CONSENT_REQUIRED',403);
                if(engine.activeJobCount||model.activeCalls||interviews.activeOperations||siwc.isBusy)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
                if(!owner?.registerAccountSource)throw new DomainError('NATIVE_OWNER_UNAVAILABLE',409);
                // The original Store transaction journals this metadata-only operation and source uniqueness.
                // Its receipt is not an account/model qualification or a project approval.
                const actor='local-session:'+hash(sid!);respond({source:owner.registerAccountSource(input,actor,hash({method,path,key,actor}))});return;
            }
            if(flowAccountSources&&method==='POST'){
                const fields=['specHash','profileHash','preparation','confirmed'],digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
                if(Object.keys(input).length!==fields.length||fields.some(k=>!Object.hasOwn(input,k))||!digest(input.specHash)||!digest(input.profileHash))throw new DomainError('CUSTOM_ACCOUNT_SOURCES_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('CUSTOM_ACCOUNT_SOURCES_CONSENT_REQUIRED',403);
                const selected=object(input.preparation);
                if(Object.keys(selected).length!==2||!digest(selected.identityHash)||!digest(selected.contentHash))throw new DomainError('CUSTOM_ACCOUNT_SOURCES_INPUT_INVALID',400);
                if(engine.activeJobCount||model.activeCalls||interviews.activeOperations||siwc.isBusy)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
                if(!owner?.inspectCustomAccountSources)throw new DomainError('NATIVE_OWNER_UNAVAILABLE',409);
                const expected={schema:'dream-maker.custom-account-source-request.v1',requestHash:hash(input)};
                const receipt=await store.once(`${method}:${path}:${key}`,input,async()=>expected);
                if(hash(receipt)!==hash(expected))throw new DomainError('CUSTOM_ACCOUNT_SOURCES_REQUEST_INVALID',409);
                // Replays bind the request, never cache a volatile credential-availability claim.
                respond(owner.inspectCustomAccountSources({projectId:flowAccountSources[1],specHash:input.specHash,profileHash:input.profileHash,preparation:{identityHash:selected.identityHash,contentHash:selected.contentHash}}));return;
            }
            if(flowAccountCheck&&method==='POST'){
                const fields=['specHash','profileHash','preparation','confirmed'],digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
                if(Object.keys(input).length!==fields.length||fields.some(k=>!Object.hasOwn(input,k))||!digest(input.specHash)||!digest(input.profileHash))throw new DomainError('MAGPIE_ACCOUNT_CHECK_INPUT_INVALID',400);
                if(input.confirmed!==true)throw new DomainError('MAGPIE_ACCOUNT_CHECK_CONSENT_REQUIRED',403);
                const selected=object(input.preparation);if(Object.keys(selected).length!==2||!digest(selected.identityHash)||!digest(selected.contentHash))throw new DomainError('MAGPIE_ACCOUNT_CHECK_INPUT_INVALID',400);
                if(engine.activeJobCount||model.activeCalls||interviews.activeOperations||siwc.isBusy)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
                const actor='local-session:'+hash(sid!),operation=hash({method,path,key,actor});
                const selection={projectId:flowAccountCheck[1],specHash:input.specHash as string,profileHash:input.profileHash as string,preparation:{identityHash:selected.identityHash as string,contentHash:selected.contentHash as string}};
                const read=()=>magpieAccountChecks.check(selection,operation,actor,applicationStop.signal,owner?.inspectCustomMagpieAccounts?.bind(owner));
                const receipt=await store.once(`${method}:${path}:${key}`,input,async()=>({schema:'dream-maker.magpie-account-check-request.v1',operationHash:operation,requestHash:hash(input),resultHash:hash(await read())}));
                if(Object.keys(object(receipt)).length!==4||receipt.schema!=='dream-maker.magpie-account-check-request.v1'||receipt.operationHash!==operation||receipt.requestHash!==hash(input)||!digest(receipt.resultHash))throw new DomainError('MAGPIE_ACCOUNT_CHECK_REQUEST_INVALID',409);
                // A replay is a journal read, never cached qualification or another process.
                const result=magpieAccountChecks.read(selection,operation,actor);if(hash(result)!==receipt.resultHash)throw new DomainError('MAGPIE_ACCOUNT_CHECK_REQUEST_INVALID',409);respond(result);return;
            }
            if(flowPreparation&&method==='POST'){
                if(Object.keys(input).length!==2||!['specHash','profileHash'].every(name=>Object.hasOwn(input,name)&&typeof input[name]==='string'&&/^[a-f0-9]{64}$/.test(input[name] as string)))throw new DomainError('FLOW_PREPARATION_INPUT_INVALID',400);
                // Bind the request to its original preparation. Replays recheck current inputs;
                // drift cannot silently create a different preparation under the same key.
                const receipt=await store.once(`${method}:${path}:${key}`,input,async()=>{
                    const prepared=engine.prepareCustomFlow(flowPreparation[1],input.specHash as string,input.profileHash as string);
                    return {schema:'dream-maker.flow-preparation-request.v1',identityHash:prepared.identityHash,contentHash:prepared.contentHash};
                });
                if(receipt.schema!=='dream-maker.flow-preparation-request.v1'||Object.keys(receipt).length!==3)throw new DomainError('FLOW_PREPARATION_INTEGRITY_FAILED',409);
                respond({preparation:engine.prepareCustomFlow(flowPreparation[1],input.specHash as string,input.profileHash as string,{identityHash:receipt.identityHash,contentHash:receipt.contentHash}),executionGranted:false});return;
            }
            if(flowProfileWrite&&method==='POST'){
                // The configuration transaction owns replay/CAS; never cache a qualification claim.
                // It cannot start a Flow, select a credential value or qualify Magpie.
                const pid=flowProfileWrite[1];
                if(engine.activeRunIds().some(rid=>store.run(rid).projectId===pid))throw new DomainError('FLOW_TERMINATION_REQUIRED',409);
                const actor='local-session:'+hash(sid!),operation=hash({method,path,key,actor});
                respond({current:flowProfiles.confirm(pid,input,actor,operation),executionGranted:false});return;
            }
            const documentationCallExtension=path.match(/^\/api\/runs\/([^/]+)\/documentation-correction\/extend-calls$/);
            if(documentationCallExtension&&method==='POST'){
                if(input.confirmed!==true)throw new DomainError('DOCUMENTATION_CALL_EXTENSION_CONFIRMATION_REQUIRED',403);
                const fields=['confirmed','expectedVersion','approvalRecordId','approvalHash','ownerDecisionHash'];
                if(url.searchParams.size||Object.keys(input).length!==fields.length||fields.some(key=>!Object.hasOwn(input,key))||
                    !Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1||
                    typeof input.approvalRecordId!=='string'||!input.approvalRecordId||
                    typeof input.approvalHash!=='string'||!/^[a-f0-9]{64}$/.test(input.approvalHash)||
                    typeof input.ownerDecisionHash!=='string'||!/^[a-f0-9]{64}$/.test(input.ownerDecisionHash))
                    throw new DomainError('DOCUMENTATION_CALL_EXTENSION_INPUT_INVALID',400);
                const r=await engine.extendDocumentationContinuation(documentationCallExtension[1],{
                    confirmed:true,expectedVersion:Number(input.expectedVersion),
                    approvalRecordId:text(input.approvalRecordId,120),approvalHash:input.approvalHash,
                    ownerDecisionHash:input.ownerDecisionHash,
                },'local-session:'+hash(sid!));
                respond({runId:r.id,state:r.state,phase:r.phase,version:r.version,sourceHash:r.treeHash,calls:r.calls,
                    maxCalls:r.maxCalls,repairCount:r.repairCount,maxRepairs:r.maxRepairs,
                    documentationContinuation:r.documentationContinuation,
                    documentationContinuationExtension:r.documentationContinuationExtension,
                    additionalCalls:1,modelDispatched:false,executionStartedByPreparation:false});return;
            }
            const documentationContinue=path.match(/^\/api\/runs\/([^/]+)\/documentation-correction\/continue$/);
            if(documentationContinue&&method==='POST'){
                if(input.confirmed!==true)throw new DomainError('DOCUMENTATION_CONTINUATION_CONFIRMATION_REQUIRED',403);
                if(url.searchParams.size||input.taskDeadline!==null||Object.keys(input).some(k=>!['confirmed','file','candidateHash','taskDeadline'].includes(k)))throw new DomainError('DOCUMENTATION_CONTINUATION_INPUT_INVALID',400);
                const r=await engine.approveDocumentationContinuation(documentationContinue[1],{confirmed:true,file:text(input.file,200),candidateHash:text(input.candidateHash,64),taskDeadline:null},'local-session:'+hash(sid!));
                respond({runId:r.id,parentRunId:documentationContinue[1],state:r.state,phase:r.phase,version:r.version,sourceHash:r.treeHash,calls:r.calls,maxCalls:r.maxCalls,repairCount:r.repairCount,maxRepairs:r.maxRepairs,documentationContinuation:r.documentationContinuation,taskDeadline:null,executionStartedByPreparation:false});return;
            }
            const codeRepairRecoverVerification=path.match(/^\/api\/runs\/([^/]+)\/bounded-code-repair\/recover-verification$/);
            const codeRepairRecoverReview=path.match(/^\/api\/runs\/([^/]+)\/bounded-code-repair\/recover-review$/);
            if(codeRepairRecoverReview&&method==='POST'){
                if(input.confirmed!==true)throw new DomainError('BOUNDED_CODE_REVIEW_RECOVERY_CONFIRMATION_REQUIRED',403);
                const fields=['confirmed','expectedVersion','sourceHash','verificationEvidenceId','reviewPacketId','ownerDecisionHash'];
                if(url.searchParams.size||Object.keys(input).length!==fields.length||fields.some(key=>!Object.hasOwn(input,key))||
                    !Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1||
                    typeof input.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(input.sourceHash)||
                    typeof input.verificationEvidenceId!=='string'||!input.verificationEvidenceId||
                    typeof input.reviewPacketId!=='string'||!input.reviewPacketId||
                    typeof input.ownerDecisionHash!=='string'||!/^[a-f0-9]{64}$/.test(input.ownerDecisionHash))
                    throw new DomainError('BOUNDED_CODE_REVIEW_RECOVERY_INPUT_INVALID',400);
                const r=await engine.recoverBoundedCodeReviewUsage(codeRepairRecoverReview[1],{
                    confirmed:true,expectedVersion:Number(input.expectedVersion),sourceHash:input.sourceHash,
                    verificationEvidenceId:text(input.verificationEvidenceId,200),reviewPacketId:text(input.reviewPacketId,200),
                    ownerDecisionHash:input.ownerDecisionHash,
                },'local-session:'+hash(sid!));
                respond({runId:r.id,state:r.state,phase:r.phase,version:r.version,sourceHash:r.treeHash,
                    calls:r.calls,maxCalls:r.maxCalls,repairCount:r.repairCount,maxRepairs:r.maxRepairs,
                    verification:r.verification,review:r.review,
                    boundedCodeReviewRecovery:r.boundedCodeReviewRecovery,
                    additionalDshRepairs:1,additionalReviewerReviews:1,modelDispatched:false,
                    executionStartedByPreparation:false});return;
            }
            if(codeRepairRecoverVerification&&method==='POST'){
                if(input.confirmed!==true)throw new DomainError('BOUNDED_CODE_REPAIR_RECOVERY_CONFIRMATION_REQUIRED',403);
                const fields=['confirmed','expectedVersion','sourceHash','verificationEvidenceId','ownerDecisionHash'];
                if(url.searchParams.size||Object.keys(input).length!==fields.length||fields.some(key=>!Object.hasOwn(input,key))||
                    !Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1||
                    typeof input.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(input.sourceHash)||
                    typeof input.verificationEvidenceId!=='string'||!input.verificationEvidenceId||
                    typeof input.ownerDecisionHash!=='string'||!/^[a-f0-9]{64}$/.test(input.ownerDecisionHash))
                    throw new DomainError('BOUNDED_CODE_REPAIR_RECOVERY_INPUT_INVALID',400);
                const r=await engine.recoverBoundedCodeVerificationFailure(codeRepairRecoverVerification[1],{
                    confirmed:true,expectedVersion:Number(input.expectedVersion),sourceHash:input.sourceHash,
                    verificationEvidenceId:input.verificationEvidenceId,ownerDecisionHash:input.ownerDecisionHash,
                },'local-session:'+hash(sid!));
                respond({runId:r.id,state:r.state,phase:r.phase,version:r.version,sourceHash:r.treeHash,
                    calls:r.calls,maxCalls:r.maxCalls,repairCount:r.repairCount,maxRepairs:r.maxRepairs,
                    verification:r.verification,review:r.review,
                    boundedCodeVerificationRecovery:r.boundedCodeVerificationRecovery,
                    additionalDshRepairs:1,additionalReviewerReviews:1,modelDispatched:false,
                    executionStartedByPreparation:false});return;
            }
            const codeRepairContinue=path.match(/^\/api\/runs\/([^/]+)\/bounded-code-repair\/continue$/);
            if(codeRepairContinue&&method==='POST'){
                if(input.confirmed!==true)throw new DomainError('BOUNDED_CODE_REPAIR_CONFIRMATION_REQUIRED',403);
                if(url.searchParams.size||input.taskDeadline!==null||input.file!=='main.mjs'||Object.keys(input).some(k=>!['confirmed','file','candidateHash','taskDeadline'].includes(k)))throw new DomainError('BOUNDED_CODE_REPAIR_INPUT_INVALID',400);
                const r=await engine.approveBoundedCodeRepair(codeRepairContinue[1],{confirmed:true,file:'main.mjs',candidateHash:text(input.candidateHash,64),taskDeadline:null},'local-session:'+hash(sid!));
                respond({runId:r.id,parentRunId:codeRepairContinue[1],state:r.state,phase:r.phase,version:r.version,sourceHash:r.treeHash,calls:r.calls,maxCalls:r.maxCalls,repairCount:r.repairCount,maxRepairs:r.maxRepairs,documentationContinuation:r.documentationContinuation,taskDeadline:null,executionStartedByPreparation:false});return;
            }
            const codeRepairPrepare=path.match(/^\/api\/runs\/([^/]+)\/bounded-code-repair\/prepare$/);
            if(codeRepairPrepare&&method==='POST'){
                if(input.confirmed!==true)throw new DomainError('BOUNDED_CODE_REPAIR_CONFIRMATION_REQUIRED',403);
                if(url.searchParams.size||input.file!=='main.mjs'||Object.keys(input).some(k=>!['confirmed','file','candidateHash'].includes(k)))throw new DomainError('BOUNDED_CODE_REPAIR_INPUT_INVALID',400);
                respond(await engine.prepareBoundedCodeRepair(codeRepairPrepare[1],{confirmed:true,file:'main.mjs',candidateHash:text(input.candidateHash,64)},'local-session:'+hash(sid!)));return;
            }
            const documentationPrepare=path.match(/^\/api\/runs\/([^/]+)\/documentation-correction\/prepare$/);
            if(documentationPrepare&&method==='POST'){
                if(input.confirmed!==true)throw new DomainError('DOCUMENTATION_CUSTODY_CONFIRMATION_REQUIRED',403);
                if(url.searchParams.size||Object.keys(input).some(k=>!['confirmed','file','candidateHash'].includes(k)))throw new DomainError('DOCUMENTATION_CUSTODY_INPUT_INVALID',400);
                // Engine uses one parent-review operation identity, regardless of HTTP key/session.
                // Every replay must check the retained bytes; never return a cached stale success.
                respond(await engine.prepareDocumentationCorrection(documentationPrepare[1],{confirmed:true,file:text(input.file,200),candidateHash:text(input.candidateHash,64)},'local-session:'+hash(sid!)));return;
            }
            const result = await store.once(`${method}:${path}:${key}`, input, async () => {
                if(path==='/api/magpie/checks'&&method==='POST'){
                    if(Object.keys(input).some(name=>name!=='confirmed'))throw new DomainError('MAGPIE_CHECK_INPUT_INVALID',400);
                    if(input.confirmed!==true)throw new DomainError('MAGPIE_CHECK_CONSENT_REQUIRED',403);
                    if(engine.activeJobCount||model.activeCalls||interviews.activeOperations||siwc.isBusy)throw new DomainError('NATIVE_OWNER_BUSY_OR_CLOSED',409);
                    return checkMagpieLocally(store,hash({method,path,key,session:hash(sid!)}),'local-session:'+hash(sid!),applicationStop.signal,owner?.inspectMagpieIngress?.bind(owner));
                }
                if(path==='/api/onboarding/budget'&&method==='POST'){
                    if(Object.keys(input).some(k=>!['limits','revision','confirmed'].includes(k)))throw new DomainError('USER_BUDGET_INVALID',400);
                    if(input.confirmed!==true)throw new DomainError('USER_BUDGET_CONSENT_REQUIRED',403);
                    if(engine.activeJobCount||model.activeCalls||siwc.isBusy||projectLocks.size)throw new DomainError('STOP_RUNS_BEFORE_BUDGET_CHANGE',409);
                    if(!owner?.configureUserBudget)throw new DomainError('NATIVE_OWNER_UNAVAILABLE',409);
                    return owner.configureUserBudget(userBudgetInput(input.limits),integer(input.revision,0,1000000),'local-session:'+hash(sid!),hash({method,path,key}));
                }
                if(path==='/api/planner1/selection'&&method==='POST'){
                    if(product==='dreamflow')throw new DomainError('USER_PLANNER_REQUIRED',409);
                    if(engine.activeJobCount||model.activeCalls||interviews.activeOperations||siwc.isBusy)throw new DomainError('STOP_RUNS_AND_PLANNER1_BEFORE_CONFIG_CHANGE',409);
                    return settings.selectPlanner1(input);
                }
                if(path==='/api/laya/qualification'&&method==='POST'){
                    if(Object.keys(input).some(k=>k!=='confirmed'))throw new DomainError('LAYA_QUALIFICATION_INPUT_INVALID',400);
                    if(input.confirmed!==true)throw new DomainError('LAYA_QUALIFICATION_CONFIRMATION_REQUIRED',403);
                    if(engine.activeJobCount||model.activeCalls||interviews.activeOperations||siwc.isBusy)throw new DomainError('STOP_RUNS_BEFORE_LAYA_QUALIFICATION',409);
                    return engine.qualifyLaya('local-session:'+hash(sid!));
                }
                if(path==='/api/planner1/local/check'&&method==='POST'){
                    if(Object.keys(input).some(key=>key!=='confirmed'))throw new DomainError('LOCAL_PLANNER1_CHECK_FIELDS_INVALID',400);
                    if(input.confirmed!==true)throw new DomainError('LOCAL_PLANNER1_CHECK_CONSENT_REQUIRED',403);
                    if(engine.activeJobCount||model.activeCalls||interviews.activeOperations||siwc.isBusy)throw new DomainError('STOP_RUNS_AND_PLANNER1_BEFORE_CONFIG_CHANGE',409);
                    const binding=planner1Binding(settings.value);
                    if(binding.provider!=='local'||binding.runner!=='local-http'||binding.authMethod!=='none')
                        throw new DomainError('LOCAL_PLANNER1_NOT_SELECTED',409);
                    const evidence=await localPlanner1.check(binding.model,applicationStop.signal);
                    return recordLocalPlanner1Capability(store,binding,evidence);
                }
                if (path === '/api/config' && method === 'PUT') {
                    if(product==='dreamflow'&&input.planner1!==undefined)throw new DomainError('USER_PLANNER_REQUIRED',409);
                    if (engine.activeJobCount || model.activeCalls || siwc.isBusy)
                        throw new DomainError('STOP_RUNS_AND_PLANNER1_BEFORE_CONFIG_CHANGE', 409);
                    const oldMode=settings.value.planner1.authMode;
                    const changed = settings.updateUI(input);
                    if(oldMode!==settings.value.planner1.authMode)siwc.invalidateSelection();
                    laya.invalidate();
                    return changed;
                }
                // Running the real role probes is an owner action: it spends subscription/paid calls.
                // The route never accepts a caller challenge; the owner generates it.
                if (path === '/api/native/probes' && method === 'POST') {
                    // A caller may name a role by its product name (Seeker/Planner/...). The list is
                    // normalized to stable wire ids here, and an unknown name is a 400 rather than a
                    // silent fallback to some other role.
                    const requested = input.roles === undefined ? null : normalizeRoleList(input.roles);
                    if (input.roles !== undefined && requested === null) throw new DomainError('NATIVE_PROBE_ROLE_INVALID', 400);
                    if(product==='dreamflow'&&requested?.includes('planner1'))throw new DomainError('USER_PLANNER_REQUIRED',409);
                    if (!owner || typeof owner.probe !== 'function') throw new DomainError('NATIVE_OWNER_UNAVAILABLE', 409);
                    const runProbe = owner.probe.bind(owner);
                    const available: Role[] = product==='dreamflow'?['planner2','executor','reviewer']:['planner1', 'planner2', 'executor', 'reviewer'];
                    const wanted: Role[] = requested === null ? [...available] : requested;
                    if (wanted.length === 0 || wanted.length > available.length || wanted.some(role => !available.includes(role)))
                        throw new DomainError('NATIVE_PROBE_ROLE_INVALID', 400);
                    const results: unknown[] = [];
                    for (const role of wanted) {
                        if(applicationStop.signal.aborted)throw new DomainError('APPLICATION_STOPPING',409);
                        try {
                            const reference = await withCodexRoleProbeLease(
                                clash,
                                role,
                                applicationStop.signal,
                                () => runProbe(role, applicationStop.signal, model)
                            );
                            // The stable wire id and the display name travel together.
                            results.push({ ...roleProjection(role), ok: true, ...reference as object });
                        }
                        catch (error) { results.push({ ...roleProjection(role), ok: false, code: error instanceof DomainError ? error.code : 'NATIVE_PROBE_FAILED' }); }
                    }
                    if(applicationStop.signal.aborted)throw new DomainError('APPLICATION_STOPPING',409);
                    let advanced: string | null = null;
                    if (input.advance === true) {
                        const status = await owner.probeStatus?.(model) as { roles?: Record<Role, { valid: boolean }> } | undefined;
                        const allValid = !!status?.roles && available.every(role => status.roles![role]?.valid === true);
                        if (!allValid) advanced = 'SKIPPED_INCOMPLETE';
                        else { await owner.advanceProbes?.(model); advanced = 'REPRESENTATIVE'; }
                    }
                    return { results, advanced };
                }
                if (path.startsWith('/api/planner1/siwc/')) planner1Active('siwc_mutation');
                if (path === '/api/planner1/siwc/connect') {
                    if (input.localNoncommercial !== true) throw new DomainError('SIWC_NONCOMMERCIAL_ACK_REQUIRED',403);
                    if (engine.activeJobCount || model.activeCalls) throw new DomainError('STOP_RUNS_AND_PLANNER1_BEFORE_SIWC_CHANGE',409);
                    settings.attestSiwcNoncommercial();
                    const profileId = input.profileId===undefined?undefined:text(input.profileId,100);
                    return siwc.connect({newProfile:input.newProfile===true,profileId,reconsent:input.reconsent===true});
                }
                if (path === '/api/planner1/siwc/cancel') { await siwc.cancel();return {state:'CANCEL_REQUESTED'}; }
                if (path === '/api/planner1/siwc/select') {
                    if(engine.activeJobCount || model.activeCalls)throw new DomainError('STOP_RUNS_AND_PLANNER1_BEFORE_SIWC_CHANGE',409);
                    const chosen=await siwc.selectProfile(text(input.profileId,100));
                    return {status:chosen.status,sharing:chosen.sharing,profileId:chosen.profileId??null};
                }
                if (path === '/api/planner1/siwc/disconnect') {
                    if(engine.activeJobCount || model.activeCalls)throw new DomainError('STOP_RUNS_AND_PLANNER1_BEFORE_SIWC_CHANGE',409);
                    return siwc.disconnect();
                }
                if (path === '/api/planner1/siwc/model') {
                    if(engine.activeJobCount || model.activeCalls)throw new DomainError('STOP_RUNS_AND_PLANNER1_BEFORE_SIWC_CHANGE',409);
                    const selected=await siwc.ensureCatalogAndSelection(text(input.slug,128));
                    settings.selectSiwcModel(selected.slug,selected.profileId);return selected;
                }
                if (path === '/api/diagnostics/models') {
                    planner1Active('planner1_model_catalog');
                    return model.models();
                }
                if (path === '/api/diagnostics/laya')
                    return laya.probe();
                // Verifying a node moves a SHARED selector, so nothing else may be running while it happens.
                if (path === '/api/clash/verify') {
                    if (engine.activeJobCount || model.activeCalls || siwc.isBusy)
                        throw new DomainError('STOP_RUNS_AND_PLANNER1_BEFORE_CLASH_VERIFY', 409);
                    return clash.verify();
                }
                if (path === '/api/clash/recover') {
                    if (engine.activeJobCount || model.activeCalls || siwc.isBusy)
                        throw new DomainError('STOP_RUNS_AND_PLANNER1_BEFORE_CLASH_RECOVERY', 409);
                    return clash.recover();
                }
                if (path === '/api/projects') {
                    if(product==='dreamflow')throw new DomainError('USER_PLANNER_REQUIRED',409);
                    const mode = choose(input.mode, ['demo', 'live']);
                    if (mode === 'live') {
                        planner1Active('live_project_creation');
                        const binding = planner1Binding(settings.value);
                        // Each live route uses its own explicit consent. An API-key checkbox cannot authorize a
                        // local model, and local-only consent cannot stand in for a cloud account.
                        if (binding.authMethod === 'oauth' && input.kimiConsent !== true)
                            throw new DomainError('KIMI_OAUTH_CONSENT_REQUIRED', 403, '选择 Live 需要明确同意使用本人 Kimi 会员订阅；不会用旧的 API Key 或套餐同意代替。');
                        if (binding.provider === 'local' && input.localConsent !== true)
                            throw new DomainError('LOCAL_PLANNER1_CONSENT_REQUIRED', 403, '选择 Live 需要明确同意只把方案助手输入发送给本机 Ollama；不会自动改用云端。');
                    }
                    const p = interviews.create(text(input.name, 120), text(input.idea, 12000), mode,input.publicResearch===true,'local-session:'+hash(sid!));
                    // Pin the engine decision at creation from the defaults, so a later change of the
                    // global settings cannot silently move an untouched project to custom.
                    workbench.recordCreation(p.id,'local-session:'+hash(sid!));
                    return snapshot(p.id);
                }
                const presentation = path.match(/^\/api\/projects\/([^/]+)\/presentation$/);
                if(presentation&&method==='POST')return locked(presentation[1],async()=>{
                    saveChatProjectPresentation(store,presentation[1],input,'local-session:'+hash(sid!));
                    return snapshot(presentation[1]);
                });
                const questionHelp=path.match(/^\/api\/projects\/([^/]+)\/question-help$/);
                if(questionHelp&&method==='POST'){
                    if(product==='dreamflow')throw new DomainError('USER_PLANNER_REQUIRED',409);
                    if(Object.keys(input).some(k=>!['questionId','text','version'].includes(k)))throw new DomainError('QUESTION_HELP_INPUT_INVALID',400);
                    return locked(questionHelp[1],async()=>interviews.questionHelp(questionHelp[1],text(input.questionId,80),text(input.text,2000),integer(input.version,1,1000000)));
                }
                const reviewFeedback=path.match(/^\/api\/projects\/([^/]+)\/review-feedback$/);
                if(reviewFeedback&&method==='POST'){
                    if(product==='dreamflow')throw new DomainError('USER_PLANNER_REQUIRED',409);
                    if(Object.keys(input).some(k=>!['runId','version'].includes(k)))throw new DomainError('REVIEW_FEEDBACK_INPUT_INVALID',400);
                    if(engine.activeRunIds().includes(String(input.runId)))throw new DomainError('FLOW_NOT_SETTLED',409);
                    return locked(reviewFeedback[1],async()=>interviews.reviewFeedback(reviewFeedback[1],text(input.runId,80),integer(input.version,1,1000000)));
                }
                // The workbench's three call points. Each one is a named contract with its own
                // error codes; a refusal names the condition instead of reporting a generic failure.
                const studioRoleConfig=path.match(/^\/api\/studio\/roles\/([^/]+)\/config$/);
                if(studioRoleConfig){
                    if(method!=='POST')throw new DomainError('METHOD_DENIED',405);
                    const pid=text(input.projectId,120);
                    return locked(pid,async()=>workbench.saveRole(pid,studioRoleConfig[1],{revision:input.revision,selection:input.selection},'local-session:'+hash(sid!),hash({method,path,key})));
                }
                const studioStarExplain=path.match(/^\/api\/studio\/stars\/([^/]+)\/explain$/);
                if(studioStarExplain){
                    if(method!=='POST')throw new DomainError('METHOD_DENIED',405);
                    const pid=text(input.projectId,120);
                    return locked(pid,async()=>workbench.explain(pid,studioStarExplain[1],{turns:input.turns,question:input.question}));
                }
                const studioStar=path.match(/^\/api\/studio\/stars\/([^/]+)$/);
                if(studioStar){
                    if(method!=='PATCH')throw new DomainError('METHOD_DENIED',405);
                    const pid=text(input.projectId,120);
                    return locked(pid,async()=>workbench.editStar(pid,studioStar[1],{revision:input.revision,answer:input.answer},'local-session:'+hash(sid!)));
                }
                if(path==='/api/user-plans')return snapshot(userPlans.create(input.document,'local-session:'+hash(sid!)).id);
                const userPlan=path.match(/^\/api\/projects\/([^/]+)\/user-plan$/);
                if(userPlan)return locked(userPlan[1],async()=>snapshot(userPlans.revise(userPlan[1],input.document,integer(input.version,1,1000000),text(input.parentId,100),'local-session:'+hash(sid!)).id));
                const researchWrite=path.match(/^\/api\/projects\/([^/]+)\/(research|research-permission)(?:\/([^/]+)\/cancel)?$/);
                if(researchWrite){
                    const pid=researchWrite[1];
                    if(researchWrite[3])return projectResearch.cancel(pid,researchWrite[3]);
                    return locked(pid,async()=>researchWrite[2]==='research'
                        ?projectResearch.start(pid,input.keywords,integer(input.version,1,1000000))
                        :snapshot(interviews.authorizeResearch(pid,input.enabled===true,integer(input.version,1,1000000),'local-session:'+hash(sid!)).id));
                }
                const planningCancel=path.match(/^\/api\/projects\/([^/]+)\/planning\/cancel$/);
                if(planningCancel){store.project(planningCancel[1]);return {operations:await interviews.cancelPlanning(planningCancel[1])};}
                const planningReconcile=path.match(/^\/api\/projects\/([^/]+)\/planning\/reconcile$/);
                if(planningReconcile)return locked(planningReconcile[1],async()=>interviews.reconcilePlanning(planningReconcile[1]));
                const requirements = path.match(/^\/api\/projects\/([^/]+)\/requirements\/(draft|revise|confirm)$/);
                if (requirements)
                    return locked(requirements[1], async () => {
                        const pid = requirements[1];
                        if (product === 'dreamflow' || store.project(pid).planner1Mode === 'USER')
                            throw new DomainError('USER_PLANNER_REQUIRED', 409);
                        const actor = 'local-session:' + hash(sid!);
                        switch (requirements[2]) {
                            case 'draft':
                                await interviews.draftRequirements(pid, text(input.notes ?? '', 12000, true));
                                break;
                            case 'revise':
                                interviews.reviseRequirements(pid, input, actor);
                                break;
                            case 'confirm':
                                if (typeof input.draftHash !== 'string' || input.draftHash.trim() === '')
                                    throw new DomainError('REQUIREMENTS_DRAFT_HASH_REQUIRED', 400, '确认需求稿必须带 draftHash；缺少它无法绑定你确认的是哪一版。');
                                await interviews.confirmRequirements(pid, { draftHash: input.draftHash, notes: text(input.notes ?? '', 12000, true) }, actor);
                                break;
                        }
                        return snapshot(pid);
                    });
                const seekerInterpret = path.match(/^\/api\/runs\/([^/]+)\/seeker-interpret$/);
                if (seekerInterpret)
                    return locked(store.run(seekerInterpret[1]).projectId, async () => {
                        const interpretation = await interviews.interpretReview(seekerInterpret[1], input, 'local-session:' + hash(sid!));
                        return { interpretation, snapshot: snapshot(store.run(seekerInterpret[1]).projectId) };
                    });
                const route = path.match(/^\/api\/projects\/([^/]+)\/(next|answer|continue|alternative|finish|semantics|approve|build)$/);
                const verifierApproval=path.match(/^\/api\/projects\/([^/]+)\/native-verifier\/approve$/);
                if(verifierApproval)return locked(verifierApproval[1],async()=>{
                    // Name the binding fields: "INVALID_TEXT" from a missing hash points the reader at the body.
                    for (const field of ['specHash', 'planHash'] as const)
                        if (typeof input[field] !== 'string' || String(input[field]).trim() === '')
                            throw new DomainError('SPEC_HASH_REQUIRED', 400, `原生验收确认必须带 ${field}；缺少它无法绑定你确认的是哪一版规格与计划。`);
                    return engine.approveVerifier(verifierApproval[1],text(input.specHash,64),text(input.planHash,64),input.approved===true);
                });
                if (route)
                    return locked(route[1], async () => {
                        const pid = route[1];
                        if(['next','answer','continue','alternative','finish'].includes(route[2])&&(product==='dreamflow'||store.project(pid).planner1Mode==='USER'))throw new DomainError('USER_PLANNER_REQUIRED',409);
                        switch (route[2]) {
                            case 'next':
                                await interviews.next(pid);
                                break;
                            case 'answer':
                                interviews.answer(pid, text(input.questionId, 80), text(input.text ?? '', 8000, true), input.skip === true, integer(input.version, 1, 1000000), input.optionIds);
                                break;
                            case 'continue':
                                interviews.continue(pid);
                                break;
                            case 'alternative':
                                interviews.alternative(pid,text(input.constraint??'',2000,true));
                                break;
                            case 'finish':
                                await interviews.finish(pid, text(input.notes ?? '', 12000, true), input.summarize !== false);
                                break;
                            case 'approve': {
                                // The approval gate is the one place a missing hash must never read as a
                                // generic text error: the owner has to know WHICH spec they approved.
                                if (typeof input.specHash !== 'string' || input.specHash.trim() === '')
                                    throw new DomainError('SPEC_HASH_REQUIRED', 400, '批准必须带 specHash；缺少它无法绑定你批准的是哪一版规格。');
                                interviews.approve(pid, text(input.specHash, 64), 'local-session:' + hash(sid!));
                                break;
                            }
                            case 'semantics': {
                                const { specHash, ...confirmation } = input;
                                // Same rule as the idempotency header: a missing binding field must not be
                                // reported as INVALID_TEXT, which points the reader at the payload body.
                                if (typeof specHash !== 'string' || specHash.trim() === '')
                                    throw new DomainError('SPEC_HASH_REQUIRED', 400, '语义确认必须带 specHash；缺少它无法绑定你确认的是哪一版规格。');
                                interviews.reviseSemantics(pid, text(specHash, 64), confirmation);
                                break;
                            }
                            case 'build':
                                if (typeof input.specHash !== 'string' || input.specHash.trim() === '')
                                    throw new DomainError('SPEC_HASH_REQUIRED', 400, '构建必须带 specHash；缺少它无法绑定你批准的是哪一版规格。');
                                if(input.laya!==undefined&&typeof input.laya!=='boolean')throw new DomainError('FLOW_LAYA_CHOICE_INVALID',400);
                                if(Object.hasOwn(input,'actor')||(Object.hasOwn(input,'taskDeadline')&&input.taskDeadline!==null))throw new DomainError('TASK_DEADLINE_WAIVER_INPUT_INVALID',400);
                                if(Object.hasOwn(input,'taskDeadline')&&input.approved!==true)throw new DomainError('TASK_DEADLINE_WAIVER_CONFIRMATION_REQUIRED',403);
                                engine.create(pid, text(input.specHash, 64), input.approved === true, input.demoFault === true,input.flowName===undefined?undefined:text(input.flowName,40),{
                                    laya:input.laya as boolean|undefined,...(Object.hasOwn(input,'taskDeadline')?{taskDeadline:null}:{})
                                },'local-session:'+hash(sid!));
                                break;
                        }
                        return snapshot(pid);
                    });
                const run = path.match(/^\/api\/runs\/([^/]+)\/(pause|resume|cancel|accept|reconcile|conclude|prepare-review|prepare-repair|interrupted-repair-verification|review-window|review-only-window|review-supplement|task-deadline-waiver)$/);
                if (run) {
                    switch (run[2]) {
                        case 'task-deadline-waiver':
                            if(input.confirmed!==true)throw new DomainError('TASK_DEADLINE_WAIVER_CONFIRMATION_REQUIRED',403);
                            if(Object.keys(input).some(key=>!['confirmed','sourceHash','expectedVersion'].includes(key)))throw new DomainError('TASK_DEADLINE_WAIVER_INPUT_INVALID',400);
                            await engine.approveTaskDeadlineWaiver(run[1],{confirmed:true,sourceHash:text(input.sourceHash,64),expectedVersion:integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER)},'local-session:'+hash(sid!));
                            break;
                        case 'review-supplement':{
                            if(input.confirmed!==true)throw new DomainError('REVIEW_SUPPLEMENT_CONFIRMATION_REQUIRED',403);
                            if(Object.keys(input).some(k=>!['confirmed','sourceHash','expectedVersion','packetHash','previousReviewRecordId'].includes(k)))throw new DomainError('REVIEW_SUPPLEMENT_INPUT_INVALID',400);
                            const r=await engine.approveReviewSupplement(run[1],{confirmed:true,sourceHash:text(input.sourceHash,64),expectedVersion:integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER),packetHash:text(input.packetHash,64),previousReviewRecordId:text(input.previousReviewRecordId,200)},'local-session:'+hash(sid!));
                            return {runId:r.id,state:r.state,version:r.version,sourceHash:r.treeHash,calls:r.calls,maxCalls:r.maxCalls,reviewSupplement:r.reviewSupplement,additionalCalls:1,modelDispatched:false};
                        }
                        case 'review-window':
                            if(input.confirmed!==true)throw new DomainError('REVIEW_WINDOW_CONFIRMATION_REQUIRED',403);
                            if(Object.keys(input).some(key=>!['confirmed','sourceHash','expectedVersion','seconds'].includes(key)))throw new DomainError('REVIEW_WINDOW_INPUT_INVALID',400);
                            await engine.approveReviewWindow(run[1],{confirmed:true,sourceHash:text(input.sourceHash,64),expectedVersion:integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER),seconds:integer(input.seconds,60,7200)},'local-session:'+hash(sid!));
                            break;
                        case 'review-only-window':
                            if(input.confirmed!==true)throw new DomainError('REVIEW_ONLY_WINDOW_CONFIRMATION_REQUIRED',403);
                            if(Object.keys(input).some(key=>!['confirmed','sourceHash','expectedVersion','seconds'].includes(key)))throw new DomainError('REVIEW_ONLY_WINDOW_INPUT_INVALID',400);
                            await engine.approveReviewOnlyWindow(run[1],{confirmed:true,sourceHash:text(input.sourceHash,64),expectedVersion:integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER),seconds:input.seconds===null?null:integer(input.seconds,60,3600)},'local-session:'+hash(sid!));break;
                        case 'prepare-review':
                            if(input.confirmed!==true)throw new DomainError('REVIEW_PREPARATION_CONFIRMATION_REQUIRED',403);
                            if(input.bindingKind==='TRANSPORT_VERSION'){
                                if(Object.keys(input).some(key=>!['confirmed','bindingKind','sourceHash','expectedVersion'].includes(key)))throw new DomainError('REVIEW_PREPARATION_REQUEST_INVALID',400);
                                await engine.prepareReviewTransportRetry(run[1],{confirmed:true,sourceHash:text(input.sourceHash,64),expectedVersion:integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER)},'local-session:'+hash(sid!));break;
                            }
                            if(input.bindingKind==='INTERRUPTED_CODEX'){
                                if(Object.keys(input).some(key=>!['confirmed','bindingKind','sourceHash','expectedVersion'].includes(key)))throw new DomainError('REVIEW_PREPARATION_REQUEST_INVALID',400);
                                await engine.prepareInterruptedReview(run[1],text(input.sourceHash,64),integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER),'local-session:'+hash(sid!));break;
                            }
                            if(input.bindingKind==='SOURCE_VERSION'){
                                if(input.packetHash!==undefined)throw new DomainError('REVIEW_PREPARATION_REQUEST_INVALID',400);
                                await engine.prepareUndispatchedReviewRetry(run[1],text(input.sourceHash,64),integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER),'local-session:'+hash(sid!));
                            }else{
                                if(input.bindingKind!==undefined||input.sourceHash!==undefined||input.expectedVersion!==undefined)throw new DomainError('REVIEW_PREPARATION_REQUEST_INVALID',400);
                                await engine.prepareReviewRetry(run[1],text(input.packetHash,64),'local-session:'+hash(sid!));
                            }
                            break;
                        case 'prepare-repair':
                            if(input.confirmed!==true)throw new DomainError('PARTIAL_REPAIR_CONFIRMATION_REQUIRED',403);
                            if(Object.keys(input).some(key=>!['confirmed','sourceHash','expectedVersion'].includes(key)))throw new DomainError('PARTIAL_REPAIR_INPUT_INVALID',400);
                            await engine.preparePartialRepair(run[1],{confirmed:true,sourceHash:text(input.sourceHash,64),expectedVersion:integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER)},'local-session:'+hash(sid!));break;
                        case 'interrupted-repair-verification':
                            if(input.confirmed!==true)throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_CONFIRMATION_REQUIRED',403);
                            if(Object.keys(input).some(key=>!['confirmed','sourceHash','expectedVersion'].includes(key)))throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_INPUT_INVALID',400);
                            await engine.prepareInterruptedRepairVerification(run[1],{confirmed:true,sourceHash:text(input.sourceHash,64),expectedVersion:integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER)},'local-session:'+hash(sid!));break;
                        case 'conclude':
                            await engine.conclude(run[1],text(input.choice,20),'local-session:'+hash(sid!),text(input.reportHash,64),text(input.constraint??'',2000,true));
                            break;
                        case 'pause':
                            engine.pause(run[1]);
                            break;
                        case 'resume':
                            await engine.resume(run[1], input.reconciled === true);
                            break;
                        case 'cancel':
                            await engine.cancel(run[1]);
                            break;
                        case 'accept':
                            engine.accept(run[1]);
                            break;
                        case 'reconcile':
                            await engine.reconcile(run[1]);
                            break;
                    }
                    return snapshot(store.run(run[1]).projectId);
                }
                throw new DomainError('NOT_FOUND', 404);
            });
            respond(result);
        }
        catch (e) {
            if(cleanupUncertain(e))requestCleanupUncertain=true;
            if (!res.headersSent&&!res.destroyed){
                // The bare fallback code was unactionable: the same body covered a missing module, a bad
                // argument and a refused call. The detail now travels with the response and the server
                // log; the status and the code stay byte-identical to before.
                const typed=e instanceof DomainError || e instanceof SiwcBlocked ? e : null;
                const failure=typed?null:safeFailure(e);
                if(failure?.detail)console.error('SIWC_FALLBACK_DETAIL '+JSON.stringify(failure.detail));
                json(res, typed?typed.status:failure!.status??500,
                    {error:typed?typed.code:failure!.code,
                     ...(failure?.detail?{detail:failure.detail}:{}),
                     message:accountSourceRequest?'账户来源操作未完成；原配置保留，请重新核对来源和确认。':e instanceof DomainError ? redact(e.message) : '账户操作未完成，请查看脱敏状态与错误码；不会自动切换收费 API。'});
            }
            else if(!res.destroyed)
                res.end();
        }
        finally{finishRequest?.();}
    });
    const closeApplication=():Promise<void>=>{
        if(closePromise)return closePromise;
        closingApplication=true;applicationStop.abort();
        closePromise=Promise.resolve().then(async()=>{
            const begin=(action:()=>unknown)=>{try{return Promise.resolve(action());}catch(error){return Promise.reject(error);}};
            // Start every cancellation before waiting on a slow provider or helper. A queued write
            // must not restart work while the controller is draining its earlier requests.
            const managers=[begin(()=>engine.stopNativeRequests()),begin(()=>stopKimiBridge?.()),begin(()=>options.kimiLocalService?.stop()),begin(()=>siwc.shutdown()),begin(()=>interviews.close()),begin(()=>projectResearch.close()),begin(()=>networkContexts.close()),begin(()=>engine.close({deferNativeDisposal:true})),begin(()=>workPausePromise)];
            const managerResults=Promise.allSettled(managers);
            // Send a complete, bounded SSE terminal frame before force-closing remaining
            // sockets. Browser subscriptions stop without retrying a task on shutdown.
            const eventStreams=[...eventStreamClosers].map(close=>close());
            const servers=[new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>previewServer.close(()=>resolve()))];
            await Promise.all(eventStreams);
            server.closeAllConnections();previewServer.closeAllConnections();
            const results=await managerResults;
            await Promise.allSettled([...activeRequests]);await Promise.all(servers);
            if(results.some(result=>result.status==='rejected')||lifecycleState==='PAUSE_UNCERTAIN'||requestCleanupUncertain)throw new DomainError('APPLICATION_CLOSE_UNCERTAIN',409,'关闭收束未全部获证；没有宣告相关运行或进程恢复完成。');
            // The native owner holds the monetary ledger used by interview and HTTP settlement.
            // Dispose it only after every caller has joined; cancellation is already in progress.
            try{await engine.disposeNative();}catch{throw new DomainError('APPLICATION_CLOSE_UNCERTAIN',409,'账户控制端关闭未获证，原数据与记录保留；没有宣告恢复完成。');}
            store.close();
            options.onClosed?.();
        });return closePromise;
    };
    try {
        await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(options.port ?? 4317, '127.0.0.1', () => res()); });
    }
    catch (e) {
        await closeApplication();
        throw e;
    }
    mainOrigin = `http://127.0.0.1:${(server.address() as {
        port: number;
    }).port}`;
    return { server, previewServer, store, engine, settings, laya, interviews, projectResearch, origin: mainOrigin, bootstrapUrl: mainOrigin + '/#bootstrap=' + bootstrap, bootstrap,
        close:closeApplication
    };
}
