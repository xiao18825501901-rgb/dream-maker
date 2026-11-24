import { mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { LayaBridge } from './laya.js';
import { CodexRunner } from './providers/codex.js';
import { roleSkillBlock } from './skill-injection.js';
import { nativeReadiness } from './providers/dsh.js';
import { buildDemo } from './demo.js';
import { capture } from './process.js';
import { treeHash, files, get, zip } from './workspace.js';
import {assertProjectStorage,executionWorkspace,readWorkspace} from './workspace-location.js';
import { captureSource, buildReviewPacket,buildRepairDiagnostics } from './review-packet.js';
import { acceptanceCommands } from './acceptance-commands.js';
import { reserveCall, checkDuration } from './budget.js';
import { DomainError, hash, id, customProbeNonce, now, object, text, redact, childEnv, hasSecret,within } from './security.js';
import { assertRunDeliveryAllowed } from './commit-guard.js';
import { TARGET_ROLE_POLICY,CUSTOM_ROLE_POLICY,rolePolicyBinding,executionIdentity } from './role-policy.js';
import {assertCustomRoleDiversity,customRoleConfiguration,customExecutionIdentity} from './flow/custom-role-identity.js';
import {customNativeFactory,assertCustomQualification} from './flow/custom-native-factory.js';
import {completedEngineeringRoles,completedReviewSource} from './flow/role-completion.js';
import {commitRoleResult,type RoleTurnResult,type DispatchedRoleResult} from './flow/role-result.js';
import type {CustomFlowConfigSnapshot} from '../shared/flow-configuration.js';
import { plainFlowReport, humanBlockerIntent } from './flow/plain-report.mjs';
import { EngineDispatch, type DispatchControl } from './flow/dispatch.js';
import type {CustomRoleProbeFactory,CustomRoleProbeInput,CustomRoleProbePreparation,CustomRoleProbeStage} from './flow/custom-role-probe.js';
import type {InspectCustomAccountSources} from '../shared/custom-account-sources.js';
import type {CustomRoleCheckView} from '../shared/custom-role-check.js';
import type {CustomProbeReceipt} from './native-probes.js';
import { currentProcessOwnership,processCleanupProven } from './flow/process-ownership.js';
import { inspectDispatchOwnership } from './flow/ownership-recovery.js';
import {boundedCodeRepairCandidate,documentationCorrectionCandidate,registerBoundedCodeRepairAuthorization} from './documentation-correction.js';
import {prepareDocumentationCustody} from './documentation-custody.js';
import {prepareDocumentationContinuation,documentationContinuationReplay,documentationContinuationEvidence,documentationPreparedEvidence,documentationRuntimeEvidence,assertDocumentationProtectedFiles,reserveDocumentationRepair,completedDocumentationEngineeringRoles,extendDocumentationContinuationCall,recoverBoundedCodeVerificationFailure,recoverBoundedCodeReviewUsage,type DocumentationContinuationRequest,type DocumentationContinuationCallExtensionRequest,type BoundedCodeVerificationRecoveryRequest,type BoundedCodeReviewRecoveryRequest} from './documentation-continuation.js';
import type {DocumentationCustodyRequest,DocumentationCustodyPrepared} from '../shared/documentation-correction.js';
import {cleanupUncertain} from './cleanup-uncertainty.js';
import {JsonDatasets} from './json-data.js';
import {SqliteDatasets,type SqliteDataRestoreSource} from './sqlite-data.js';
import {assertSqliteReadCurrent,readSqliteStatus,type ProjectDataJob} from './flow/sqlite-status.js';
import {executeSqliteRecovery,readSqliteRecoveryPlan,type SqliteRecoveryBinding} from './flow/sqlite-recovery.js';
import {validateJsonRuntimePlan,prepareJsonRuntimeInput,readJsonRuntimeOutput} from './json-runtime-protocol.js';
import {validateDataRuntimePlan} from './data-runtime-plan.js';
import {executeSqliteRuntime,type NativeSqliteDataInput,type SqliteRuntimeBinding} from './flow/sqlite-runtime.js';
import {reviewedSqliteRuntime} from './sqlite-runtime-review.js';
import type {SandboxCommand,SandboxResult,SqliteSandboxExchange} from './wsl-sandbox.js';
import type {JsonDataView} from '../shared/json-data.js';
import { roleAssistanceBrief,attachRoleGuide,roleAssistanceLabels } from './flow/role-assistance.js';
import { LAYA_QUALIFICATION_ROLES,assertLayaQualification,layaQualificationBinding,qualificationEvidence,type LayaQualification,type LayaQualificationRole } from './laya-qualification.js';
import {validateWritePaths,selectExecutorWave,ExecutorSlices,executorRoleForTurn,checkpointReasons} from './flow/executor-slices.js';
import {executeExecutorWave} from './flow/execute-wave.js';
import {installPrework,assertPreworkDispatch,savePreworkResult} from './prework/runtime.js';
import {savePreworkCloseout} from './prework/closeout.js';
import {MergeRecoveryFiles} from './flow/merge-recovery.js';
import type {MergeRecoveryRequest,MergeRecoveryResult} from '../shared/merge-recovery.js';
import type {ExecutorCheckpointRequest,ExecutorCheckpointResult,ExecutorCheckpointResumeRequest,ExecutorCheckpointResumeResult} from '../shared/executor-checkpoint.js';
import {reviewPreparationBasis,reviewPreparationDispatchRecovery,reserveReviewPreparationReplay} from './review-preparation-retry.js';
import {assertReviewTaskBodySafe,reviewAdmissionPrompt} from './review-admission.js';
import {expectedUserMessageFrameLimit} from './providers/rpc.js';
import {runDeadline,reviewWindowEvidence,type ReviewWindowApproval} from './review-window.js';
import {taskDeadlineWaiverEvidence,saveTaskDeadlineWaiver} from './task-deadline-waiver.js';
import {customBudgetSupplementPreview,saveCustomBudgetSupplement} from './flow/custom-budget-supplement.js';
import type {ReviewOnlyWindowApproval} from './review-only-window.js';
import {readOnlyReviewRetryBasis} from './review-transport-retry.js';
import {reviewSupplementBasis,reviewSupplementEvidence,assertReviewSupplementPacket,reserveReviewSupplementCall} from './review-supplement.js';
import {unstartedReviewBasis} from './unstarted-review.js';
import {interruptedReviewBasis,type InterruptedReviewInput,type InterruptedReviewObservation} from './review-interruption.js';
import {partialRepairBasis,type PartialRepairRequest} from './partial-repair.js';
import {INTERRUPTED_REPAIR_VERIFICATION_REASON,interruptedRepairVerificationBasis,interruptedRepairVerificationEvidence,type InterruptedRepairVerificationRequest} from './interrupted-repair-verification.js';
import { flowCatalog,resolveFlow,type FlowName } from './flows.js';
import { recordSeekerHandoff } from './seeker-review.js';
import {classicFlowSnapshot,compileClassicRoleConfiguration,runConfigurationFingerprint,runUsesLaya} from './flow-configuration.js';
import {currentRoleConfiguration} from './role-configuration.js';
import {CustomFlowPreparations} from './custom-flow-preparation.js';
import {dshEngineeringContract,dshEngineeringContractHash,type DshEngineeringPreparation,type DshEngineeringInput,type DshEngineeringStage,type DshEngineeringVerification,type DshEngineeringReport} from './flow/dsh-engineering.js';
import type {CustomFlowPreparationRef} from '../shared/custom-flow-preparation.js';
import { createLayaObserver,type LayaObserver } from './laya-observation.js';
import {roleEventRecord} from './role-event-persistence.js';
import type { Config, Run, Task, Phase, AgentInput, AgentOutput, Role, Review, Finding, Runner, RolePolicy,LayaDecision } from '../shared/types.js';
/** One informative sentence per engineering role for the Laya qualification
 *  forward. The label set and the "must not be unknown" gate stay unchanged. */
const LAYA_QUALIFICATION_BRIEF:Record<LayaQualificationRole,string>={
    planner2:'Planning: split the frozen requirements into small verifiable tasks with dependencies and scope.',
    executor:'Execution: write the code that implements the current task.',
    reviewer:'Review: independently inspect source, tests and evidence against the frozen requirements.',
};
/**
 * Which runner serves a role. Exported and total so the choice can be tested without spawning either
 * CLI. New Flows require Codex + DSH. The explicit legacy policy preserves older routing diagnostics;
 * configuration alone cannot opt a new Flow into that historical degraded route.
 */
export function roleRunner(role: Role, config: Config, parts: {
    executor: () => Runner;
    codex: () => Runner;
    independent?: Runner;
}, policy: RolePolicy = TARGET_ROLE_POLICY): Runner {
    rolePolicyBinding(config, policy);
    if (role === 'executor') return parts.executor();
    const independentRole = role === 'planner2' || role === 'reviewer';
    if (!independentRole || policy === TARGET_ROLE_POLICY || config.independent?.enabled !== true) return parts.codex();
    if (!parts.independent) throw new DomainError('INDEPENDENT_RUNNER_REQUIRED', 409, '独立模型已启用但运行器未接线；不会回退到 Codex。');
    return parts.independent;
}
export interface NativeExecutionFactory extends Partial<CustomRoleProbeFactory> {
    /** Exact Store/ledger proof that a failed probe stopped before model reservation or send. */
    customProbeFailureDisposition?(probeId:string):boolean;
    readonly sqliteRetirementEnabled?:boolean;
    retireSqliteData?(input:import('./sqlite-retirement-process.js').SqliteRetirementInput):Promise<import('./sqlite-retirement-process.js').SqliteRetirementReceipt>;
    inspectInterruptedReview?(input:InterruptedReviewInput,signal:AbortSignal):Promise<InterruptedReviewObservation>;
    assertEmptyNativeDispatch?(runId:string,dispatchId:string):void;
    codex?(input:AgentInput):Runner;
    /** Trusted runtime qualification; never implemented by HTTP/config proof booleans. */
    assertCustomReady?(snapshot:CustomFlowConfigSnapshot):void;
    custom?(input:AgentInput):Runner;
    // Read-only admission check: no model requests, reservations or approval mutation.
    assertReady(role:Role|'build',context?:{projectId:string;specHash:string}):void;
    executor(input:AgentInput):Runner;
    verify(input:AgentInput,onEvent:(event:unknown)=>void):Promise<Record<string,unknown>>;
    runData?(input:{runId:string;specHash:string;sourceHash:string;command:SandboxCommand;signal:AbortSignal}):Promise<SandboxResult>;
    runSqliteData?(input:NativeSqliteDataInput):Promise<SqliteSandboxExchange>;
    dshEngineeringPreparation?():DshEngineeringPreparation;
    executeDshEngineering?(input:DshEngineeringInput,emit:(event:unknown)=>void):Promise<DshEngineeringStage>;
    verifyDshEngineering?(input:DshEngineeringInput):Promise<DshEngineeringVerification>;
    close():Promise<void>;
    /** Stop new native requests and signal existing calls; retain the ledger until disposal. */
    stopRequests?():void;
    verifierPlan?(projectId:string,specHash:string):{sha256:string;plan:unknown};
    reserveRepair?(runId: string): void;
    repairRevision?(runId:string):number;
}
/**
 * Clash route hook: a Live run holds ONE selector lease for its whole lifetime and any Codex child
 * process gets the per-run proxy environment. Demo mode never touches the network route.
 */
export interface RunNetworkRoute {
    withRun<T>(runId:string,signal:AbortSignal,action:()=>Promise<T>,onRestored?:()=>void):Promise<T>;
    childEnvironment(extra:NodeJS.ProcessEnv):NodeJS.ProcessEnv;
    assertRecovered?():Promise<unknown>;
    observeCodexRequestRoute?(input:{process:import('./codex-network-path.js').CodexProcessInfo;signal:AbortSignal}):Promise<import('./codex-network-path.js').CodexRouteEvidence>;
}
const TERMINAL = ['ACCEPTED', 'CANCELLED', 'FAILED', 'PARTIAL'];
const SETTLED_BLOCK_REASONS = new Set(['REPAIR_LIMIT', 'REPEATED_FAILURE_NO_PROGRESS', 'REVIEW_BLOCKED']);
type FrozenProjectTask = { id: string; dependsOn: string[]; requirementIds: string[] };
const sameStringSet = (left: string[], right: string[]) => {
    const expected = [...right].sort();
    return left.length === right.length && [...left].sort().every((value, index) => value === expected[index]);
};
export function validatePlan(raw: unknown, requirementIds: string[], frozenTasks: readonly FrozenProjectTask[] = []): Task[] {
    const plan = object(raw);
    if(plan.dataRuntime!==undefined)validateDataRuntimePlan(plan.dataRuntime);
    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0 || plan.tasks.length > 30)
        throw new DomainError('PLAN_SCHEMA_INVALID', 502);
    const tasks: Task[] = plan.tasks.map(v => {
        const t = object(v);
        if (!Array.isArray(t.dependsOn) || !Array.isArray(t.requirementIds) || !Array.isArray(t.acceptance))
            throw new DomainError('PLAN_SCHEMA_INVALID', 502);
        let writePaths: string[] | undefined;
        if (t.writePaths !== undefined) {
            try { writePaths = validateWritePaths(t.writePaths); }
            catch (error) {
                if (!(error instanceof DomainError) || error.code !== 'EXECUTOR_WRITE_SCOPE_INVALID') throw error;
                throw new DomainError('PLAN_WRITE_SCOPE_INVALID', 502);
            }
        }
        return { id: text(t.id, 40), title: text(t.title, 1000), dependsOn: (t.dependsOn as unknown[]).map(x => text(x, 40)), requirementIds: (t.requirementIds as unknown[]).map(x => text(x, 40)), acceptance: (t.acceptance as unknown[]).map(x => text(x, 2000)), ...(writePaths === undefined ? {} : {writePaths}), status: 'pending' };
    });
    const ids = new Set(tasks.map(t => t.id));
    if (ids.size !== tasks.length)
        throw new DomainError('PLAN_DUPLICATE_TASK', 502);
    for (const t of tasks)
        if (!t.acceptance.length || t.dependsOn.some(x => !ids.has(x)) || t.requirementIds.some(x => !requirementIds.includes(x)))
            throw new DomainError('PLAN_REFERENCE_INVALID', 502);
    if (new Set(frozenTasks.map(task => task.id)).size !== frozenTasks.length)
        throw new DomainError('PLAN_SCHEMA_INVALID', 502);
    for (const frozen of frozenTasks) {
        const task = tasks.find(value => value.id === frozen.id);
        if (!task)
            throw new DomainError('PLAN_PROJECT_TASK_OMITTED', 502);
        if (!sameStringSet(task.dependsOn, frozen.dependsOn) || !sameStringSet(task.requirementIds, frozen.requirementIds))
            throw new DomainError('PLAN_PROJECT_TASK_CHANGED', 502);
    }
    for (const rid of requirementIds)
        if (!tasks.some(t => t.requirementIds.includes(rid)))
            throw new DomainError('PLAN_REQUIREMENT_OMITTED', 502);
    const visited = new Set<string>(), active = new Set<string>();
    function visit(t: Task) { if (active.has(t.id))
        throw new DomainError('PLAN_CYCLE', 502); if (visited.has(t.id))
        return; active.add(t.id); t.dependsOn.forEach(dep => visit(tasks.find(t => t.id === dep)!)); active.delete(t.id); visited.add(t.id); }
    tasks.forEach(visit);
    return tasks;
}
export function validateReview(raw: unknown, source: Review['source'], tree: string): Review {
    const v = object(raw);
    if (!['PASS', 'CHANGES_REQUESTED', 'BLOCKED'].includes(String(v.verdict)) || !Array.isArray(v.findings))
        throw new DomainError('REVIEW_SCHEMA_INVALID', 502);
    const findings: Finding[] = v.findings.map(x => { const f = object(x); if (!['critical', 'high', 'medium', 'low'].includes(String(f.severity)))
        throw new DomainError('FINDING_SEVERITY_INVALID', 502); return { id: text(f.id, 80), severity: f.severity as Finding['severity'], description: text(f.description, 5000), evidence: text(f.evidence, 5000), status: 'open' }; });
    if (new Set(findings.map(f => f.id)).size !== findings.length)
        throw new DomainError('FINDING_DUPLICATE', 502);
    if (v.verdict === 'PASS' && findings.length)
        throw new DomainError('REVIEW_PASS_WITH_FINDINGS', 502);
    return { verdict: v.verdict as Review['verdict'], findings, source, treeHash: tree };
}
const CODEX_REVIEW_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'findings'],
    properties: {
        verdict: { type: 'string', enum: ['PASS', 'CHANGES_REQUESTED', 'BLOCKED'] },
        findings: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false, required: ['id', 'severity', 'description', 'evidence'],
                properties: {
                    id: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                    description: { type: 'string' }, evidence: { type: 'string' }
                }
            }
        }
    }
};
export function codexReviewOutputSchema(withPreworkCoverage:boolean) {
    if (!withPreworkCoverage) return CODEX_REVIEW_OUTPUT_SCHEMA;
    return {
        ...CODEX_REVIEW_OUTPUT_SCHEMA,
        required: [...CODEX_REVIEW_OUTPUT_SCHEMA.required, 'preworkCoverage'],
        properties: {
            ...CODEX_REVIEW_OUTPUT_SCHEMA.properties,
            preworkCoverage: {
                type: 'array',
                additionalProperties: false,
                minItems: 1,
                maxItems: 512,
                items: {
                    type: 'object', additionalProperties: false,
                    required: ['requirementId', 'artifactPaths', 'caseIds', 'acceptanceIds'],
                    properties: {
                        requirementId: { type: 'string' },
                        artifactPaths: { type: 'array', items: { type: 'string' } },
                        caseIds: { type: 'array', items: { type: 'string' } },
                        acceptanceIds: { type: 'array', items: { type: 'string' } }
                    }
                }
            }
        }
    };
}
export class Engine {
    jobs = new Map<string, {
        controller: AbortController;
        promise: Promise<void>;
    }>();
    private readonly startedAt = Date.now();
    private pausing=false;private pauseWork?:Promise<void>;
    private readonly dispatch:EngineDispatch;
    private readonly jsonData:JsonDatasets;
    private readonly sqliteData:SqliteDatasets;
    private readonly executorSlices:ExecutorSlices;
    private readonly customPreparations:CustomFlowPreparations;
    private readonly mergeRecoveries=new Map<string,{controller:AbortController;promise:Promise<MergeRecoveryResult|ExecutorCheckpointResult>}>();
    private readonly reviewPreparations=new Map<string,Promise<unknown>>();
    private readonly reviewInspectionControllers=new Map<string,AbortController>();
    private readonly dataJobs=new Map<string,ProjectDataJob>();
    private readonly engineeringJobs=new Map<string,{controller:AbortController;promise:Promise<DshEngineeringReport>;input:DshEngineeringInput;phase:'executor'|'verifier'}>();
    private readonly customProbeJobs=new Map<string,{controller:AbortController;promise:Promise<CustomProbeReceipt>;input:CustomRoleProbeInput}>();
    private roleCommitQueue:Promise<void>=Promise.resolve();
    get activeJobCount(){return this.jobs.size+this.dataJobs.size+this.mergeRecoveries.size+this.reviewPreparations.size+this.engineeringJobs.size+this.customProbeJobs.size;}
    activeRunIds(){return [...new Set([...this.jobs.keys(),...this.dataJobs.keys(),...this.mergeRecoveries.keys(),...this.reviewPreparations.keys()])];}
    constructor(public store: Store, private laya: LayaBridge, private config: () => Config, private root: string, private data: string, private demoDelayMs = 200, private nativeExecution?:NativeExecutionFactory,
        /** Clash selector lease + per-run proxy environment for Live runs only. */
        private networkRoute?: RunNetworkRoute,
        /** A07/K09: every real role dispatch is recorded so "Laya OFF" can be proven, not assumed. */
        private layaObserver?: LayaObserver,
        /** The independent second provider for planner2/reviewer; absent means those roles stay on Codex. */
        private independentRunner?: Runner) {
        assertProjectStorage(root,data,{allowAdditionalDataRoots:true});
        this.jsonData=new JsonDatasets(store,root);
        this.sqliteData=new SqliteDatasets(store,root,data);
        this.executorSlices=new ExecutorSlices(store,data);
        this.customPreparations=new CustomFlowPreparations(store,config);
        this.dispatch=new EngineDispatch(store,{isCurrent:(request,stage)=>{
            try{
                if(request.purpose==='CUSTOM_ROLE_PROBE'){
                    const job=this.customProbeJobs.get(request.acceptanceId!);
                    return !!job&&!this.pausing&&!job.controller.signal.aborted&&request.kind===job.input.preparation.role&&
                        (request.kind!=='executor'||request.executorRoleId===job.input.preparation.roleId)&&
                        hash(this.nativeExecution?.customProbePreparation?.(job.input.selection,job.input.preparation.roleId))===hash(job.input.preparation);
                }
                if(request.purpose==='DSH_ENGINEERING_ACCEPTANCE'){
                    const job=this.engineeringJobs.get(request.acceptanceId!);
                    return !!job&&!this.pausing&&!job.controller.signal.aborted&&job.phase===request.kind&&
                        this.nativeExecution?.dshEngineeringPreparation?.().configurationHash===job.input.configurationHash;
                }
                if(request.projectId===null||request.runId===null)return false;
                const p=store.project(request.projectId),r=store.run(request.runId);
                if(request.kind==='data-runtime'){
                    const job=this.dataJobs.get(r.id);if(!job||this.pausing||job.controller.signal.aborted)return false;
                    if(job.kind==='SQLITE_READ'){assertSqliteReadCurrent(store,r.id,job);return r.mode===request.mode;}
                    if(job.kind==='SQLITE_RUNTIME'){this.assertSqliteRuntimeCurrent(r.id,job);return r.mode===request.mode&&request.dataFormat==='SQLITE_IMAGE_V1';}
                    if(job.kind==='SQLITE_RECOVERY'){this.assertSqliteRecoveryCurrent(r.id,job);return r.mode===request.mode&&request.dataFormat===undefined;}
                    this.assertJsonRuntimeCurrent(r.id,job.sourceHash,job.planHash);return true;
                }
                executionWorkspace(r,data);
                if(p.activeRunId!==r.id||p.specId!==r.specId||store.spec(r.specId).stale||r.mode!==request.mode)return false;
                if(request.kind==='route'&&stage==='RESULT')return true;
                return store.owns(p.id,r.id)&&!['CANCEL_REQUESTED',...TERMINAL].includes(r.state);
            }catch{return false;}
        }});
    }
    dispatchStatus(){return this.dispatch.snapshot();}

    /** Source- and config-bound identity: a prompt, adapter or Laya edit re-opens the qualification. */
    private layaBinding(){return layaQualificationBinding(this.root,this.config(),p=>treeHash(p));}
    private latestLayaQualification():unknown{
        try{
            const row=this.store.db.prepare("SELECT data FROM records WHERE kind='LayaQualification' ORDER BY rowid DESC LIMIT 1").get() as {data?:unknown}|undefined;
            if(!row||typeof row.data!=='string')return null;
            return JSON.parse(row.data);
        }catch{return null;}
    }
    /** Read-only. Never issues anything; used by the flow catalog and by create(). */
    layaQualificationStatus():{qualified:boolean;reason:string}{
        try{
            assertLayaQualification(this.latestLayaQualification(),{binding:this.layaBinding(),config:this.config()});
            return {qualified:true,reason:''};
        }catch(error){
            return {qualified:false,reason:error instanceof DomainError?error.code:'NATIVE_LAYA_QUALIFICATION_REQUIRED'};
        }
    }
    /**
     * One genuine forward per engineering role, then a controller-owned record bound to the exact
     * compiled source and Laya configuration. It grants no role, budget, approval or verdict.
     */
    async qualifyLaya(actor:string):Promise<LayaQualification>{
        const c=this.config();
        if(c.laya.mode!=='advisory')throw new DomainError('LAYA_ADVISORY_REQUIRED',409);
        if(LAYA_QUALIFICATION_ROLES.some(role=>c.laya.roles[role]==='off'))throw new DomainError('LAYA_ROLES_INCOMPLETE',409);
        if(this.activeJobCount||this.pausing)throw new DomainError('STOP_RUNS_BEFORE_LAYA_QUALIFICATION',409);
        const binding=this.layaBinding(),decisions={} as Record<LayaQualificationRole,LayaDecision>;
        for(const role of LAYA_QUALIFICATION_ROLES){
            const state={role,runId:'laya-qualification',scope:'QUALIFICATION_ONLY',specHash:hash({sourceHash:binding.sourceHash,role}),
                // The state used to be hashes and nulls only, so the category
                // forward was decided on noise. A one-line role brief keeps the
                // same label set and gate while giving the model real signal.
                roleBrief:LAYA_QUALIFICATION_BRIEF[role],labels:roleAssistanceLabels(role),
                phase:'QUALIFICATION',taskDataHash:hash('laya-qualification:'+role),goal:null,currentTask:null,
                sourceHash:binding.sourceHash,sourceSpan:null,rawEvidence:null,
                authority:'CATEGORY_ADVICE_ONLY_NO_PERMISSION_OR_SUCCESS',coverage:'QUALIFICATION_FORWARD_ONLY_NOT_TASK_EVIDENCE'};
            const decision=await this.laya.decide(role,'laya-qualification',state,roleAssistanceLabels(role),undefined,{});
            if(decision.reason!=='VALIDATED_ADVISORY_ONLY'||decision.adoption!=='advisory'||decision.cached)
                throw new DomainError('LAYA_QUALIFICATION_FORWARD_FAILED',409,role+':'+decision.reason);
            decisions[role]=decision;
        }
        const issuedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+24*3600*1000).toISOString();
        // Two independent fingerprints are recorded: the qualification binding (compiled source + Laya
        // protocol + role models) and the nativeReadiness configuration the audit will certify. The
        // audit recomputes both itself; neither value is trusted from this file.
        const auditConfigurationHash=nativeReadiness(c).configurationHash;
        const record:LayaQualification={schema:'dream-maker.laya-qualification.v1',status:'QUALIFIED',protocol:'dm-bridge-v1',
            baseUrl:new URL(c.laya.baseUrl).origin,mode:'advisory',roles:[...LAYA_QUALIFICATION_ROLES],
            sourceHash:binding.sourceHash,configurationHash:binding.configurationHash,
            modelRevision:decisions.planner2.modelRevision??null,roleEvidence:qualificationEvidence(decisions),
            causalModelInfluence:'NOT_CLAIMED',issuedAt,expiresAt};
        this.store.record('LayaQualification',null,null,{...record,actor});
        mkdirSync(this.data,{recursive:true,mode:0o700});
        writeFileSync(resolve(this.data,'laya-live-evidence.json'),JSON.stringify({schema:'dream-maker.laya-live-evidence.v2',
            mode:'LIVE',turns:LAYA_QUALIFICATION_ROLES.length,turnsScope:'EXPLICIT_QUALIFICATION_FORWARDS',fullyOff:false,influencedTurns:0,
            explicitControllerCalls:LAYA_QUALIFICATION_ROLES.length,controllerOwned:true,protocol:'dm-bridge-v1',
            truncationMetadata:c.laya.requireTruncationMetadata?'REQUIRED':'NOT_PROVIDED_BY_LOCAL_SHIM_NOT_REQUIRED',
            modelRevision:record.modelRevision,sourceHash:record.sourceHash,configurationHash:record.configurationHash,
            auditConfigurationHash,
            qualified:true,at:issuedAt},null,2)+'\n',{mode:0o600});
        return record;
    }
    /** Closed before dispatch. A replay cannot become a later model request. */
    refuseCustomRoleProbe(selection:InspectCustomAccountSources,roleId:string,operation:string,preparation?:CustomRoleProbePreparation):void{
        if(typeof operation!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(operation))throw new DomainError('CUSTOM_PROBE_OPERATION_INVALID',400);
        const operationHash=hash(operation),selectionHash=hash({selection,roleId});
        this.store.tx(()=>{
            if(this.store.db.prepare("SELECT 1 FROM records WHERE kind='CustomRoleProbeIntent' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.operationHash')=? LIMIT 1").get(operationHash))return;
            const rows=this.store.db.prepare("SELECT data FROM records WHERE kind='CustomRoleProbeRefusal' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.operationHash')=? LIMIT 2").all(operationHash);
            if(rows.length){if(rows.length!==1||object(JSON.parse(String(rows[0].data))).selectionHash!==selectionHash)throw new DomainError('CUSTOM_PROBE_BINDING_CHANGED',409);return;}
            this.store.record('CustomRoleProbeRefusal',null,null,{schema:'dream-maker.custom-probe-refusal.v1',operationHash,selectionHash,roleId,...(preparation?{preparation}:{}),status:'NOT_ADMITTED',automaticRetry:false,at:now()});
        });
    }
    /** Read the original journal, then revalidate signed success. Never dispatches or signs. */
    async customRoleProbeStatus(selection:InspectCustomAccountSources,roleId:string,operation?:string):Promise<CustomRoleCheckView>{
        const factory=this.nativeExecution;
        const selected=structuredClone(selection);
        if(operation!==undefined&&(typeof operation!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(operation)))throw new DomainError('CUSTOM_PROBE_OPERATION_INVALID',400);
        const selectionHash=hash({selection:selected,roleId});
        const matches=operation===undefined?this.store.db.prepare("SELECT data FROM records WHERE kind='CustomRoleProbeIntent' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.selectionHash')=? ORDER BY rowid DESC LIMIT 1").all(selectionHash):this.store.db.prepare("SELECT data FROM records WHERE kind='CustomRoleProbeIntent' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.operationHash')=? LIMIT 2").all(hash(operation));
        if(matches.length>1)throw new DomainError('CUSTOM_PROBE_RECOVERY_REQUIRED',409);
        const row=matches[0],intent=row?object(JSON.parse(String(row.data))):null;
        if(intent&&intent.selectionHash!==selectionHash)throw new DomainError('CUSTOM_PROBE_BINDING_CHANGED',409);
        if(!intent&&operation!==undefined){
            const closed=this.store.db.prepare("SELECT data FROM records WHERE kind='CustomRoleProbeRefusal' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.operationHash')=? LIMIT 2").all(hash(operation));
            if(closed.length){
                if(closed.length!==1)throw new DomainError('CUSTOM_PROBE_RECOVERY_REQUIRED',409);const refusal=object(JSON.parse(String(closed[0].data)));
                if(refusal.schema!=='dream-maker.custom-probe-refusal.v1'||refusal.status!=='NOT_ADMITTED'||refusal.selectionHash!==selectionHash||refusal.roleId!==roleId||typeof refusal.at!=='string'||!Number.isFinite(Date.parse(refusal.at))||new Date(refusal.at).toISOString()!==refusal.at)throw new DomainError('CUSTOM_PROBE_RECOVERY_REQUIRED',409);
                let role:CustomRoleCheckView['role'],configurationHash:string;
                if(refusal.preparation){const p=object(refusal.preparation);if(p.roleId!==roleId||!['planner2','executor','reviewer'].includes(String(p.role))||typeof p.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(p.configurationHash))throw new DomainError('CUSTOM_PROBE_RECOVERY_REQUIRED',409);role=p.role as typeof role;configurationHash=p.configurationHash;}
                else{const prior=this.customPreparations.historical(selected.projectId,selected.preparation),s=prior.flowConfig;role=s.roles.planner2.id===roleId?'planner2':s.roles.reviewer.id===roleId?'reviewer':s.roles.executors.some(r=>r.id===roleId)?'executor':(()=>{throw new DomainError('CUSTOM_ROLE_ID_UNSUPPORTED',409);})();configurationHash=prior.flowConfigHash;}
                return{schema:'dream-maker.custom-role-check.v1',projectId:selected.projectId,role,roleId,selection:selected,configurationHash,status:'NOT_ADMITTED',checkedAt:refusal.at,evidenceId:null,model:null,executionGranted:false,fourRoleLive:'NOT_RUN'};
            }
        }
        // Current eligibility is deliberately not a prerequisite for reading an old operation.
        if(!intent&&!factory?.customProbePreparation)throw new DomainError('CUSTOM_PROBE_ISSUER_NOT_CONNECTED',409);
        const raw=intent?object(intent.preparation):factory!.customProbePreparation!(selected,roleId);
        if(raw.roleId!==roleId||!['planner2','executor','reviewer'].includes(String(raw.role))||typeof raw.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(raw.configurationHash)||typeof raw.bindingHash!=='string'||!/^[a-f0-9]{64}$/.test(raw.bindingHash)||typeof raw.expiresAt!=='string'||!Number.isFinite(Date.parse(raw.expiresAt)))throw new DomainError('CUSTOM_PROBE_RECOVERY_REQUIRED',409);
        const preparation=raw as unknown as CustomRoleProbePreparation;
        const view:CustomRoleCheckView={schema:'dream-maker.custom-role-check.v1',projectId:selected.projectId,role:preparation.role,roleId,selection:selected,configurationHash:preparation.configurationHash,status:'NOT_RUN',checkedAt:null,evidenceId:null,model:null,executionGranted:false,fourRoleLive:'NOT_RUN'};
        if(!row)return view;
        const probeId=String(intent!.probeId);
        const stamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v?v:null;
        view.checkedAt=stamp(intent!.at);
        if(this.customProbeJobs.has(probeId))return{...view,status:'RUNNING'};
        const rows=this.store.db.prepare("SELECT data FROM records WHERE kind='CustomRoleProbeResult' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.probeId')=? LIMIT 2").all(probeId);
        if(rows.length!==1||this.dispatch.hasUncertain(probeId))return{...view,status:'UNCERTAIN'};
        const result=object(JSON.parse(String(rows[0].data)));view.checkedAt=stamp(result.at);
        if(result.status==='UNKNOWN')return{...view,status:'UNCERTAIN'};
        if(result.status==='FAILED'){
            let noEffect=false;
            if(['NATIVE_PRICE_ROUTE_MISMATCH','RUNNER_RPC_ERROR'].includes(String(result.code))&&typeof factory?.customProbeFailureDisposition==='function')try{noEffect=factory.customProbeFailureDisposition(probeId)===true;}catch{noEffect=false;}
            return{...view,status:noEffect?'FAILED_NO_EFFECT':'FAILED'};
        }
        if(result.status!=='QUALIFIED_MINIMUM_ROLE_ONLY'||!view.checkedAt)return{...view,status:'UNCERTAIN'};
        try{
            if(!factory?.customProbePreparation||!factory.prepareCustomProbeEvidence||!factory.customProbeReceipt||hash(factory.customProbePreparation(selected,roleId))!==hash(preparation))return{...view,status:'NOT_CURRENT'};
            // Opening the original controller key custody cannot issue a new role receipt.
            await factory.prepareCustomProbeEvidence();
            const evidenceId=String(object(result.receipt).evidenceId),receipt=factory.customProbeReceipt(selected,roleId,evidenceId);
            if(hash(factory.customProbePreparation(selected,roleId))!==hash(preparation)||receipt.probeId!==probeId||receipt.evidenceId!==evidenceId||receipt.roleId!==roleId||receipt.role!==preparation.role||receipt.source!=='REAL_MODEL_RESPONSE'||typeof receipt.model!=='string'||!receipt.model.trim())throw new DomainError('CUSTOM_PROBE_ISSUANCE_UNVERIFIED',409);
            return{...view,status:'PASSED_MINIMUM',evidenceId:receipt.evidenceId,model:receipt.model};
        }catch{return{...view,status:'NOT_CURRENT'};}
    }
    /** A Custom role probe owns no project or run, so the run-scoped reconcile API can never
     *  close its grant. The next probe therefore asks the engine for the same OS ownership
     *  proof first; only a proven dispatch is recorded as reconciled, and every other shape
     *  keeps the busy refusal below authoritative. */
    private async closeProbeDispatchQuarantine():Promise<void>{
        for(const scope of this.dispatch.snapshot().quarantined){
            if(scope.projectId!==null||scope.runId!==null||typeof scope.acceptanceId!=='string'||!scope.acceptanceId)continue;
            try{await this.dispatch.reconcileOwned(scope.acceptanceId,(dispatchId,inner)=>inspectDispatchOwnership(this.store,this.root,this.config(),inner.projectId,inner.runId,dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute)));}
            catch{/* Unproven ownership stays quarantined and keeps refusing new probes. */}
        }
    }
    /** One explicit model qualification through the original queue, never a user Build. */
    async probeCustomRole(selection:InspectCustomAccountSources,roleId:string,operation:string,confirmed:boolean,signal?:AbortSignal):Promise<CustomProbeReceipt>{
        if(confirmed!==true)throw new DomainError('CUSTOM_PROBE_CONFIRMATION_REQUIRED',409);
        if(typeof operation!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(operation)||typeof roleId!=='string')throw new DomainError('CUSTOM_PROBE_OPERATION_INVALID',400);
        let acceptedPreparation:CustomRoleProbePreparation|undefined;
        try{
        if(this.store.db.prepare("SELECT 1 FROM records WHERE kind='CustomRoleProbeRefusal' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.operationHash')=? LIMIT 1").get(hash(operation)))throw new DomainError('CUSTOM_PROBE_NOT_ADMITTED',409);
        if(this.pausing||signal?.aborted)throw new DomainError('RUN_CANCELLED',409);
        const factory=this.nativeExecution;
        if(!factory||['customProbePreparation','prepareCustomProbeEvidence','executeCustomRoleProbe','completeCustomRoleProbe','customProbeReceipt'].some(key=>typeof factory[key as keyof NativeExecutionFactory]!=='function'))throw new DomainError('CUSTOM_PROBE_ISSUER_NOT_CONNECTED',409);
        const owned=factory as NativeExecutionFactory&CustomRoleProbeFactory,selected=structuredClone(selection),preparation=owned.customProbePreparation(selected,roleId),operationHash=hash(operation),selectionHash=hash({selection:selected,roleId});
        acceptedPreparation=preparation;
        const expiry=Date.parse(preparation.expiresAt);if(!Number.isFinite(expiry)||expiry<=Date.now())throw new DomainError('CUSTOM_PROBE_EXPIRY_REQUIRED',409);
        const previous=this.store.db.prepare("SELECT data FROM records WHERE kind='CustomRoleProbeIntent' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.operationHash')=? LIMIT 2").all(operationHash);
        if(previous.length){
            if(previous.length!==1)throw new DomainError('CUSTOM_PROBE_RECOVERY_REQUIRED',409);
            const intent=object(JSON.parse(String(previous[0].data))),probeId=String(intent.probeId);
            if(intent.selectionHash!==selectionHash||hash(intent.preparation)!==hash(preparation))throw new DomainError('CUSTOM_PROBE_BINDING_CHANGED',409);
            const active=this.customProbeJobs.get(probeId);if(active)return active.promise;
            const rows=this.store.db.prepare("SELECT data FROM records WHERE kind='CustomRoleProbeResult' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.probeId')=? LIMIT 2").all(probeId);
            if(rows.length!==1)throw new DomainError('CUSTOM_PROBE_RECOVERY_REQUIRED',409);
            const result=object(JSON.parse(String(rows[0].data)));
            if(result.status!=='QUALIFIED_MINIMUM_ROLE_ONLY')throw new DomainError('CUSTOM_PROBE_RECOVERY_REQUIRED',409);
            const receipt=owned.customProbeReceipt(selected,roleId,String(object(result.receipt).evidenceId));if(receipt.probeId!==probeId)throw new DomainError('CUSTOM_PROBE_ISSUANCE_UNVERIFIED',409);return receipt;
        }
        await this.closeProbeDispatchQuarantine();
        if(this.activeJobCount||this.dispatch.snapshot().quarantined.length)throw new DomainError('CUSTOM_PROBE_BUSY_OR_UNCERTAIN',409);
        const probeId=id('custom_probe'),controller=new AbortController(),abort=()=>controller.abort(new DomainError('RUN_CANCELLED',409));signal?.addEventListener('abort',abort,{once:true});
        const input:CustomRoleProbeInput={selection:selected,preparation,probeId,nonce:customProbeNonce(),signal:controller.signal};
        this.store.record('CustomRoleProbeIntent',null,null,{probeId,operationHash,selectionHash,preparation,purpose:'MINIMUM_ROLE_ONLY',automaticRetry:false,at:now()});
        const deadline=setTimeout(()=>controller.abort(new DomainError('CUSTOM_PROBE_DEADLINE',409)),Math.max(1,Math.min(450000,expiry-Date.now())));
        const job={controller,input,promise:undefined as unknown as Promise<CustomProbeReceipt>};
        job.promise=Promise.resolve().then(async()=>{
            try{
                await owned.prepareCustomProbeEvidence();
                if(controller.signal.aborted)throw new DomainError('RUN_CANCELLED',409);
                const routed=this.config().clash.enabled,route=this.networkRoute;
                if(routed&&!route)throw new DomainError('CLASH_RUN_LEASE_REQUIRED',409);
                const stage=await this.dispatch.run({projectId:null,runId:null,purpose:'CUSTOM_ROLE_PROBE',acceptanceId:probeId,kind:preparation.role,mode:'live',signal:controller.signal,...(preparation.role==='executor'?{executorRoleId:roleId}:{})},async control=>{
                    let routeReleased=!routed,actionFailed=false,actionError:unknown;
                    const execute=async()=>{try{return await owned.executeCustomRoleProbe(input,event=>this.store.event(null,null,'custom.probe.event',{probeId,event}));}
                        catch(error){actionFailed=true;actionError=error;throw error;}};
                    try{
                        if(!routed)return await execute();
                        try{return await route!.withRun(probeId,controller.signal,execute);}
                        catch(error){
                            // Raw restoration/filesystem failures cannot be hidden by
                            // optimistic process cleanup or a swallowed release callback.
                            if(!actionFailed||error!==actionError)throw new DomainError('CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY',409);
                            throw error;
                        }finally{
                            try{
                                const evidence=await route!.assertRecovered?.();
                                if(!evidence||typeof evidence!=='object'||(evidence as {scope?:unknown}).scope!=='OWNED_CLASH_JOURNALS'||(evidence as {pendingLocks?:unknown}).pendingLocks!==0)throw new Error('ROUTE_RELEASE_UNPROVEN');
                                routeReleased=true;
                            }catch{throw new DomainError('CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY',409);}
                        }
                    }finally{const scope=currentProcessOwnership();if(routeReleased&&scope&&processCleanupProven(scope))control.confirmCleanup();}
                });
                if(controller.signal.aborted||hash(owned.customProbePreparation(selected,roleId))!==hash(preparation))throw new DomainError('CUSTOM_PROBE_BINDING_CHANGED',409);
                const receipt=owned.completeCustomRoleProbe(input,stage);
                if(receipt.probeId!==probeId)throw new DomainError('CUSTOM_PROBE_ISSUANCE_UNVERIFIED',409);
                this.store.record('CustomRoleProbeResult',null,null,{probeId,status:'QUALIFIED_MINIMUM_ROLE_ONLY',receipt,automaticRetry:false,at:now()});return receipt;
            }catch(error){this.store.record('CustomRoleProbeResult',null,null,{probeId,status:this.dispatch.hasUncertain(probeId)?'UNKNOWN':'FAILED',code:error instanceof DomainError?error.code:'CUSTOM_PROBE_FAILED',automaticRetry:false,at:now()});throw error;}
            finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);this.customProbeJobs.delete(probeId);}
        });
        this.customProbeJobs.set(probeId,job);return job.promise;
        }catch(error){this.refuseCustomRoleProbe(selection,roleId,operation,acceptedPreparation);throw error;}
    }
    /** Explicit operator capability exercise, not a user Flow or an alternative scheduler. */
    async runDshEngineeringAcceptance(operation:string,confirmed:boolean,signal?:AbortSignal):Promise<DshEngineeringReport>{
        if(confirmed!==true)throw new DomainError('ENGINEERING_ACCEPTANCE_CONFIRMATION_REQUIRED',409);
        if(this.pausing)throw new DomainError('APPLICATION_PAUSING',409);
        if(typeof operation!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(operation))throw new DomainError('ENGINEERING_ACCEPTANCE_OPERATION_INVALID',400);
        if(signal?.aborted)throw new DomainError('RUN_CANCELLED',409);
        const factory=this.nativeExecution;if(!factory?.dshEngineeringPreparation||!factory.executeDshEngineering||!factory.verifyDshEngineering)throw new DomainError('ENGINEERING_ACCEPTANCE_NOT_CONNECTED',409);
        const preparation=factory.dshEngineeringPreparation();if(preparation.contractHash!==dshEngineeringContractHash)throw new DomainError('ENGINEERING_ACCEPTANCE_STALE',409);
        const operationHash=hash(operation),previous=this.store.db.prepare("SELECT data FROM records WHERE kind='EngineeringAcceptanceIntent' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.operationHash')=?").all(operationHash);
        if(previous.length){
            if(previous.length!==1)throw new DomainError('ENGINEERING_ACCEPTANCE_RECOVERY_REQUIRED',409);
            const intent=object(JSON.parse(String(previous[0].data))),acceptanceId=String(intent.acceptanceId),active=this.engineeringJobs.get(acceptanceId);
            if(intent.configurationHash!==preparation.configurationHash||intent.contractHash!==preparation.contractHash)throw new DomainError('ENGINEERING_ACCEPTANCE_STALE',409);
            if(active)return active.promise;
            const records=this.store.db.prepare("SELECT data FROM records WHERE kind='EngineeringAcceptanceResult' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.acceptanceId')=?").all(acceptanceId);
            if(records.length!==1)throw new DomainError('ENGINEERING_ACCEPTANCE_RECOVERY_REQUIRED',409);
            const result=object(JSON.parse(String(records[0].data)));
            if(result.status!=='VERIFIED_EXECUTOR_COMPONENT')throw new DomainError('ENGINEERING_ACCEPTANCE_RECOVERY_REQUIRED',409);
            const expected=within(this.root,`.runtime/engineering-acceptance/${acceptanceId}/workspace`);
            if(result.workspace!==expected||intent.workspace!==expected||treeHash(expected)!==result.sourceHash)throw new DomainError('ENGINEERING_ACCEPTANCE_RESULT_CHANGED',409);
            return structuredClone(result) as unknown as DshEngineeringReport;
        }
        if(this.activeJobCount||this.dispatch.snapshot().quarantined.length)throw new DomainError('ENGINEERING_ACCEPTANCE_BUSY_OR_UNCERTAIN',409);
        const acceptanceId=id('dsh_acceptance'),workspace=within(this.root,`.runtime/engineering-acceptance/${acceptanceId}/workspace`);mkdirSync(workspace,{recursive:true});
        const controller=new AbortController(),abort=()=>controller.abort(new DomainError('RUN_CANCELLED',409));signal?.addEventListener('abort',abort,{once:true});
        const input:DshEngineeringInput={acceptanceId,workspace,...preparation,signal:controller.signal};
        this.store.record('EngineeringAcceptanceIntent',null,null,{...preparation,acceptanceId,operationHash,workspace,purpose:'DSH_EXECUTOR_COMPONENT_ONLY',initialSourceHash:treeHash(workspace),limits:dshEngineeringContract(),at:now()});
        const timer=setTimeout(()=>controller.abort(new DomainError('ENGINEERING_ACCEPTANCE_DEADLINE',409)),dshEngineeringContract().maxSeconds*1000);
        const job={controller,input,phase:'executor' as 'executor'|'verifier',promise:undefined as unknown as Promise<DshEngineeringReport>};
        const execute=async()=>{
            const dispatch=async<T>(kind:'executor'|'verifier',action:()=>Promise<T>)=>this.dispatch.run({projectId:null,runId:null,purpose:'DSH_ENGINEERING_ACCEPTANCE',acceptanceId,kind,mode:'live',signal:controller.signal},async control=>{
                try{return await action();}finally{const ownership=currentProcessOwnership();if(ownership&&processCleanupProven(ownership))control.confirmCleanup();}
            });
            try{
                const stage=await dispatch('executor',()=>factory.executeDshEngineering!(input,event=>this.store.event(null,null,'engineering.executor.event',{acceptanceId,event})));
                if(controller.signal.aborted||treeHash(workspace)!==stage.sourceHash)throw new DomainError('ENGINEERING_ACCEPTANCE_RESULT_CHANGED',409);
                this.store.record('EngineeringAcceptanceStage',null,null,{acceptanceId,sourceHash:stage.sourceHash,stage});job.phase='verifier';
                const verification=await dispatch('verifier',()=>factory.verifyDshEngineering!(input));
                if(controller.signal.aborted||!verification.ok||verification.sourceHash!==stage.sourceHash||treeHash(workspace)!==stage.sourceHash)throw new DomainError('ENGINEERING_ACCEPTANCE_VERIFICATION_FAILED',409);
                const report:DshEngineeringReport={schema:'dream-maker.dsh-engineering-result.v1',acceptanceId,purpose:'DSH_EXECUTOR_COMPONENT_ONLY',status:'VERIFIED_EXECUTOR_COMPONENT',...preparation,workspace,sourceHash:stage.sourceHash,stage,verification,fourRoleLive:'NOT_RUN',reviewer:'BLOCKED'};
                this.store.record('EngineeringAcceptanceResult',null,null,report);return report;
            }catch(error){this.store.record('EngineeringAcceptanceResult',null,null,{acceptanceId,status:this.dispatch.hasUncertain(acceptanceId)?'UNKNOWN':'FAILED',code:error instanceof DomainError?error.code:'ENGINEERING_ACCEPTANCE_FAILED',automaticRetry:false,at:now()});throw error;}
            finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.engineeringJobs.delete(acceptanceId);}
        };
        job.promise=Promise.resolve().then(execute);this.engineeringJobs.set(acceptanceId,job);return job.promise;
    }
    private dataRecoveryOnly(rid:string){const pending=this.dispatch.snapshot().quarantined.filter(row=>row.runId===rid);return pending.length>0&&pending.every(row=>row.kind==='data-runtime');}
    sqliteDataStatus(pid:string){
        return readSqliteStatus({store:this.store,datasets:this.sqliteData,dispatch:this.dispatch,jobs:this.dataJobs,pausing:()=>this.pausing,activeRunIds:()=>this.activeRunIds(),activeJobCount:()=>this.activeJobCount},pid);
    }
    sqliteDataRecoveryPlan(pid:string){
        return readSqliteRecoveryPlan({store:this.store,datasets:this.sqliteData,dispatch:this.dispatch,jobs:this.dataJobs,pausing:()=>this.pausing,activeRunIds:()=>this.activeRunIds(),activeJobCount:()=>this.activeJobCount,assertCurrent:(rid,binding)=>this.assertSqliteRecoveryCurrent(rid,binding)},pid);
    }
    private assertSqliteRecoveryCurrent(rid:string,binding:SqliteRecoveryBinding){
        const r=this.store.run(rid),p=this.store.project(binding.projectId);this.assertBinding(r);
        executionWorkspace(r,this.data);
        assertSqliteReadCurrent(this.store,rid,binding);
        if(p.activeRunId!==rid||r.projectId!==p.id||p.version!==binding.projectVersion||r.version!==binding.runVersion)throw new DomainError('SQLITE_DATA_RECOVERY_CHANGED',409);
    }
    recoverSqliteData(pid:string,operationHash:string,confirmed:boolean,operation:string,actor:string){
        return executeSqliteRecovery({store:this.store,datasets:this.sqliteData,dispatch:this.dispatch,jobs:this.dataJobs,pausing:()=>this.pausing,activeRunIds:()=>this.activeRunIds(),activeJobCount:()=>this.activeJobCount,assertCurrent:(rid,binding)=>this.assertSqliteRecoveryCurrent(rid,binding)},pid,operationHash,confirmed,operation,actor);
    }
    sqliteDataPlan(pid:string){
        const p=this.store.project(pid);
        if(p.mode!=='live'||!p.activeRunId)throw new DomainError('SQLITE_DATA_RESTORE_TARGET_INVALID',409);
        const r=this.store.run(p.activeRunId);
        if(r.projectId!==pid||r.mode!=='live')throw new DomainError('SQLITE_DATA_RESTORE_TARGET_INVALID',409);
        return this.sqliteData.metadata(pid);
    }
    restoreSqliteData(pid:string,revision:number,source:()=>SqliteDataRestoreSource|unknown|Promise<SqliteDataRestoreSource|unknown>,operation:string,actor:string){
        return this.sqliteData.restoreFromRehearsal(pid,revision,source,operation,actor);
    }
    private assertSqliteRuntimeCurrent(rid:string,binding:SqliteRuntimeBinding){
        const r=this.store.run(rid),p=this.store.project(binding.projectId);this.assertBinding(r);
        executionWorkspace(r,this.data);
        if(p.activeRunId!==rid||r.projectId!==p.id||p.version!==binding.projectVersion||r.version!==binding.runVersion)throw new DomainError('SQLITE_DATA_RUNTIME_CHANGED',409);
        this.sqliteData.assertRuntimeSource(rid,binding.sourceHash);
        if(hash(reviewedSqliteRuntime(this.store,r))!==binding.planHash)throw new DomainError('SQLITE_DATA_RUNTIME_PLAN_CHANGED',409);
    }
    /** Controller-only until guest retirement, full backups and storage readiness gates are connected. */
    executeSqliteData(rid:string,sourceHash:string,revision:number,confirmed:boolean,operation:string,actor:string){
        return executeSqliteRuntime({store:this.store,root:this.root,datasets:this.sqliteData,dispatch:this.dispatch,jobs:this.dataJobs,pausing:()=>this.pausing,activeRunIds:()=>this.activeRunIds(),activeJobCount:()=>this.activeJobCount,native:()=>this.nativeFactory(),assertCurrent:(id,binding)=>this.assertSqliteRuntimeCurrent(id,binding),assertReady:r=>this.assertNativeReadyForRun(r,'build'),read:pid=>this.sqliteDataStatus(pid)},rid,sourceHash,revision,confirmed,operation,actor);
    }
    /** Reconcile only the old OS ownership. Never apply an uncertain result or alter a delivered Flow. */
    async reconcileJsonData(rid:string){
        const r=this.store.run(rid);if(this.activeRunIds().includes(rid))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        if(!this.dataRecoveryOnly(rid))throw new DomainError('RECONCILIATION_NOT_REQUIRED',409);
        await this.dispatch.reconcileOwned(rid,(dispatchId,scope)=>inspectDispatchOwnership(this.store,this.root,this.config(),scope.projectId,rid,dispatchId));
        this.dispatch.assertReconciliationReady(rid);
        this.store.event(r.projectId,rid,'run.json-data.reconciled',{automaticResume:false,resultApplied:false,originalFlowUnchanged:true});
        this.dispatch.releaseAfterOwnershipProof(rid);return this.store.run(rid);
    }
    private assertJsonRuntimeCurrent(rid:string,sourceHash:string,planHash:string):JsonDataView{
        const r=this.store.run(rid);executionWorkspace(r,this.data);this.assertBinding(r);
        if(this.store.project(r.projectId).activeRunId!==rid)throw new DomainError('JSON_DATA_SOURCE_UNVERIFIED',409);
        if(hash(validateJsonRuntimePlan(object(r.plan).dataRuntime))!==planHash)throw new DomainError('JSON_DATA_RUNTIME_PLAN_CHANGED',409);
        return this.jsonData.readRun(rid,sourceHash);
    }
    /** Runs only the reviewed plan's bounded entry. Request caches contain metadata, never business data. */
    async executeJsonData(rid:string,sourceHash:string,revision:number,confirmed:boolean,operation:string,actor:string):Promise<JsonDataView>{
        if(this.pausing)throw new DomainError('APPLICATION_PAUSING',409);
        if(confirmed!==true)throw new DomainError('JSON_DATA_CONSENT_REQUIRED',403);
        if(!Number.isSafeInteger(revision)||revision<0||!/^[a-f0-9]{64}$/.test(operation)||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('JSON_DATA_INPUT_INVALID',400);
        const r=this.store.run(rid),plan=validateJsonRuntimePlan(object(r.plan).dataRuntime),planHash=hash(plan);
        const current=this.assertJsonRuntimeCurrent(rid,sourceHash,planHash);
        const request={runId:rid,specHash:r.specHash,sourceHash,planHash,revision,actor},key='json-runtime:'+operation;
        const view=(receipt:{hash:string;appliedRevision:number},replayed:boolean)=>({...this.jsonData.read(r.projectId),operation:{...receipt,replayed}});
        // Pending/failed durable requests are uncertain, including across process restart. No auto-rerun.
        if(this.store.db.prepare('SELECT 1 FROM requests WHERE key=?').get(key))return view(await this.store.once(key,request,async()=>{throw new DomainError('REQUEST_RESULT_UNCERTAIN',409);}),true);
        if(this.activeRunIds().some(id=>this.store.run(id).projectId===r.projectId))throw new DomainError('WORKSPACE_BUSY',409);
        if(this.activeJobCount>=64)throw new DomainError('GLOBAL_FLOW_QUEUE_FULL',409);
        if(this.dispatch.snapshot().quarantined.length)throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
        if(current.revision!==revision)throw new DomainError('JSON_DATA_CONFLICT',409);
        const native=this.nativeFactory();this.assertNativeReadyForRun(r,'build');
        if(!native.runData)throw new DomainError('JSON_DATA_RUNTIME_UNAVAILABLE',409);
        const prepared=prepareJsonRuntimeInput({projectId:r.projectId,runId:rid,specHash:r.specHash,sourceHash},current),controller=new AbortController();
        const deadline=setTimeout(()=>controller.abort(new DomainError('JSON_DATA_RUNTIME_TIMEOUT',409)),90000);
        const promise=Promise.resolve().then(()=>this.store.once(key,request,async()=>{
            this.store.record('JsonDataRuntimeRequested',r.projectId,rid,{operationHash:operation,...request,inputHash:prepared.expected.inputHash,modelCalls:0});
            const result=await this.dispatch.run({projectId:r.projectId,runId:rid,kind:'data-runtime',mode:r.mode,signal:controller.signal},async control=>{
                try{
                    this.assertJsonRuntimeCurrent(rid,sourceHash,planHash);this.assertNativeReadyForRun(this.store.run(rid),'build');
                    return await native.runData!({runId:rid,specHash:r.specHash,sourceHash,command:{runtime:plan.runtime,entry:plan.entry,args:plan.args,stdin:prepared.stdin},signal:controller.signal});
                }finally{const ownership=currentProcessOwnership();if(ownership&&processCleanupProven(ownership))control.confirmCleanup();}
            });
            if(controller.signal.aborted||this.pausing)throw new DomainError('JSON_DATA_RUNTIME_CANCELLED',409);
            this.assertJsonRuntimeCurrent(rid,sourceHash,planHash);
            if(result.status!=='EXECUTED'||result.exitCode!==0||result.sourceHash!==sourceHash)throw new DomainError('JSON_DATA_RUNTIME_FAILED',409);
            const document=readJsonRuntimeOutput(result.stdout,prepared.expected);
            const saved=this.jsonData.writeRuntime(rid,sourceHash,document,revision,operation,actor,{inputHash:prepared.expected.inputHash,resultHash:hash(result)});
            return {hash:operation,appliedRevision:saved.operation!.appliedRevision};
        })).finally(()=>{clearTimeout(deadline);this.dataJobs.delete(rid);});
        this.dataJobs.set(rid,{kind:'JSON_RUNTIME',controller,promise,sourceHash,planHash});return view(await promise,false);
    }
    /** Read-only coverage summary for the current process; null when no observer is attached. */
    layaObservation(runId?:string) {
        if(!runId)return this.layaObserver?this.layaObserver.summary():null;
        const run=this.store.run(runId),observer=createLayaObserver();
        const rows=this.store.db.prepare("SELECT kind,data FROM records WHERE project_id=? AND run_id=? AND kind IN ('LayaDecision','LayaApplication') ORDER BY rowid LIMIT 2001").all(run.projectId,runId);
        if(rows.length>2000)return {...observer.summary(),reason:'CONTROLLER_RECORD_LIMIT',fullyOff:false};
        const records=rows.map(row=>({kind:String(row.kind),data:object(JSON.parse(String(row.data)))}));
        const sessions=this.store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND kind='AgentSession' ORDER BY rowid LIMIT 2001").all(run.projectId,runId);
        if(sessions.length>2000)return {...observer.summary(),reason:'CONTROLLER_RECORD_LIMIT',fullyOff:false};
        // Advice counts as supplied only when the application names the exact adapter session that
        // completed the role turn. A role-level identity alone cannot promote a foreign or absent turn.
        const completedTurns=new Set(sessions.map(row=>{const s=object(JSON.parse(String(row.data)));return [s.role,s.sessionId,s.dispatchId,s.generation].join('|');}));
        for(const row of records.filter(row=>row.kind==='LayaDecision')){
            const d=row.data,role=String(d.role),application=records.find(row=>row.kind==='LayaApplication'&&row.data.role===role&&row.data.decisionHash===hash(d)&&row.data.inputHash===d.inputHash);
            const completion=(application?.data.completedRole&&typeof application.data.completedRole==='object'&&!Array.isArray(application.data.completedRole))?application.data.completedRole as Record<string,unknown>:{};
            const completionKey=[role,completion.sessionId,completion.dispatchId,completion.generation];
            const completedTurn=completionKey.every(value=>typeof value==='string'&&value.length>0)&&completedTurns.has(completionKey.join('|'));
            const applied=run.mode==='live'&&!!run.roleIdentities?.[role as Role]&&completedTurn&&application?.data.mode==='live'&&application.data.status==='PROVIDED_TO_COMPLETED_ROLE'&&application.data.providedToCompletedRole===true;
            observer.record({role,mode:String(d.mode),adoption:String(d.adoption),applied,runMode:run.mode});
        }return observer.summary();
    }
    private nativeFactory(){
        if(!this.nativeExecution||['assertReady','executor','verify','close'].some(k=>typeof this.nativeExecution![k as keyof NativeExecutionFactory]!=='function'))throw new DomainError('NATIVE_RUNTIME_FACTORY_REQUIRED',409);
        return this.nativeExecution;
    }
    private assertNativeReadyForRun(run:Run,role:Role|'build'){
        if(run.flowName==='custom'){
            if(run.flowConfig?.mode!=='custom')throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
            assertCustomQualification(this.nativeExecution,run.flowConfig);
        }else this.nativeFactory().assertReady(role,{projectId:run.projectId,specHash:run.specHash});
    }
    executionReadiness(){
        const result=nativeReadiness(this.config());
        try{this.nativeFactory().assertReady('build');}
        catch(error){result.reasons.push(error instanceof DomainError?error.code:'NATIVE_RUNTIME_FACTORY_UNVERIFIED');result.ok=false;}
        result.reasons=[...new Set(result.reasons)];return result;
    }
    recover() { for (const r of this.store.runs()) {
        if(this.executorSlices.hasUncertainMerge(r.id)){
            if(r.state==='ACCEPTED'){this.store.event(r.projectId,r.id,'run.accepted.merge.recovery.required',{automaticResume:false});continue;}
            this.update(r.id,'run.executor.merge.recovery.required',current=>{current.state='BLOCKED';current.reason='EXECUTOR_MERGE_RESULT_UNCERTAIN';});continue;
        }
        if(this.dispatch.hasUncertain(r.id)){
            if(this.dataRecoveryOnly(r.id)){this.store.event(r.projectId,r.id,'run.json-data.recovery.required',{reason:'PROCESS_CLEANUP_UNPROVEN',automaticResume:false,resultApplied:false});continue;}
            if(r.state==='ACCEPTED'){this.store.event(r.projectId,r.id,'run.accepted.dispatch.recovery.required',{reason:'PROCESS_CLEANUP_UNPROVEN'});continue;}
            this.update(r.id,'run.dispatch.recovery.required',current=>{current.state='BLOCKED';current.reason='PROCESS_CLEANUP_UNPROVEN';});continue;
        }
        if(r.pendingLeaseRelease&&!this.jobs.has(r.id)&&(['READY_FOR_DELIVERY','CANCELLED'].includes(r.state)||r.state==='BLOCKED'&&SETTLED_BLOCK_REASONS.has(r.reason??''))){
            this.store.tx(()=>{this.releaseWriterWhenSafe(r);this.store.saveRun(r);this.store.event(r.projectId,r.id,'run.finalize.writer.recovered',{leaseHeld:this.store.owns(r.projectId,r.id)});});continue;
        }
        // A run that reached delivery before the lease rule changed can still be holding its writer. Release
        // it here instead of editing workspace_leases by hand; the delivered artifact stays untouched.
        if (r.state === 'READY_FOR_DELIVERY' && this.store.owns(r.projectId, r.id)) {
            this.store.tx(() => { this.store.release(r.projectId, r.id); this.store.event(r.projectId, r.id, 'run.lease.released', { reason: 'DELIVERY_SETTLED' }); });
        }
        if (!TERMINAL.includes(r.state) && !['BLOCKED', 'PAUSED', 'READY_FOR_DELIVERY'].includes(r.state)) {
            this.store.tx(() => { r.state = 'BLOCKED'; r.reason = 'WORKER_RESTART_RESULT_UNCERTAIN'; this.store.saveRun(r); this.store.event(r.projectId, r.id, 'run.recovery.required', { phase: r.phase, attempt: r.attempt }); });
        }
    }
    for(const project of this.store.projects()){
        if(!project.activeRunId)continue;
        let active:Run;
        try{active=this.store.run(project.activeRunId);}catch{continue;}
        if(active.state!=='CANCELLED')continue;
        this.store.tx(()=>{
            const current=this.store.project(project.id);
            if(current.activeRunId!==active.id)return;
            const cancelled=this.store.run(active.id);
            if(cancelled.state==='CANCELLED')this.repairProjectActiveRunInTransaction(cancelled);
        });
    }
    }
    /**
     * Controlled reconciliation for a run whose worker died without a result.
     *
     * Nothing here guesses. The writer lease is released only after every ownership proof holds, the
     * release happens in the same SQLite transaction as the state change, and the proofs are written as a
     * run.reconciled event — this replaces hand-deleting workspace_leases rows as a recovery mechanism.
     */
    async reconcile(rid: string) {
        const r = this.store.run(rid);
        if(this.executorSlices.hasUncertainMerge(rid))throw new DomainError('EXECUTOR_MERGE_RESULT_UNCERTAIN',409,'本轮的文件合并还没核对完，暂时不能结束或继续。现有文件与恢复副本均保留，请先完成合并恢复检查。');
        if(this.dataRecoveryOnly(rid))return this.reconcileJsonData(rid);
        if (TERMINAL.includes(r.state) || r.state === 'CANCELLED')
            return r;
        if (this.jobs.has(rid))
            throw new DomainError('PROCESS_OWNERSHIP_ACTIVE', 409, '本进程仍在执行该运行，不能宣告旧写者已结束。');
        if (!['WORKER_RESTART_RESULT_UNCERTAIN', 'PROCESS_CLEANUP_UNPROVEN'].includes(r.reason ?? ''))
            throw new DomainError('RECONCILIATION_NOT_REQUIRED', 409);
        const proofs = this.ownershipProofs(r);
        if (!proofs.ok)
            throw new DomainError('PROCESS_OWNERSHIP_UNPROVEN', 409, proofs.reasons.join(', '));
        await this.dispatch.reconcileOwned(rid,(dispatchId,scope)=>inspectDispatchOwnership(this.store,this.root,this.config(),scope.projectId,rid,dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute)));
        this.dispatch.assertReconciliationReady(rid);
        const result=this.store.tx(() => {
            const cur = this.store.run(rid);
            cur.state = 'CANCELLED';
            cur.reason = 'PROCESS_OWNERSHIP_RECONCILED';
            this.store.saveRun(cur);
            this.store.release(cur.projectId, cur.id);
            this.store.event(cur.projectId, cur.id, 'run.reconciled', { phase: cur.phase, attempt: cur.attempt, proof: proofs.evidence });
            return cur;
        });
        this.dispatch.releaseAfterOwnershipProof(rid);return result;
    }
    mergeRecoveryRequired(rid:string){return this.executorSlices.hasUncertainMerge(rid);}
    customBudgetSupplementPreview(rid:string){return this.store.tx(()=>customBudgetSupplementPreview(this.store,this.store.run(rid)));}
    async approveCustomBudgetSupplement(rid:string,input:unknown,actor:string,operationHash:string){
        if(this.pausing||this.activeJobCount||this.reviewPreparations.size||this.dispatch.snapshot().quarantined.length)throw new DomainError('CUSTOM_BUDGET_SUPPLEMENT_BUSY',409);
        return this.store.tx(()=>{
            const r=this.store.run(rid);this.assertCurrent(r);this.unchanged(r);
            if(!['BLOCKED','PAUSED'].includes(r.state)||this.store.project(r.projectId).activeRunId!==rid||
                this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('CUSTOM_BUDGET_SUPPLEMENT_NOT_IDLE',409);
            return saveCustomBudgetSupplement(this.store,r,input,actor,operationHash);
        });
    }
    executorCheckpointRequired(rid:string){return this.executorSlices.needsCheckpoint(rid);}
    executorCheckpointPreview(rid:string){
        const r=this.store.run(rid);this.assertBinding(r);
        return this.executorSlices.inspectCheckpoint(rid,!this.jobs.has(rid)&&!this.dataJobs.has(rid)&&!this.mergeRecoveries.size).view;
    }
    async prepareExecutorCheckpoint(rid:string,input:ExecutorCheckpointRequest,operationHash:string,actor:string):Promise<ExecutorCheckpointResult>{
        if(input.confirmed!==true)throw new DomainError('EXECUTOR_CHECKPOINT_CONSENT_REQUIRED',403);
        if(!/^[a-f0-9]{64}$/.test(input.previewHash)||!/^[a-f0-9]{64}$/.test(operationHash)||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('EXECUTOR_CHECKPOINT_INPUT_INVALID',400);
        this.assertBinding(this.store.run(rid));
        const replay=this.executorSlices.replayCheckpoint(rid,input,operationHash,actor);if(replay)return replay;
        if(this.pausing)throw new DomainError('APPLICATION_PAUSING',409);
        if(this.jobs.has(rid)||this.dataJobs.has(rid))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        if(this.mergeRecoveries.size)throw new DomainError('EXECUTOR_CHECKPOINT_BUSY',409);
        const controller=new AbortController(),gate=(r:Run)=>{
            if(controller.signal.aborted||this.pausing)throw new DomainError('EXECUTOR_CHECKPOINT_CANCELLED',409);this.assertCurrent(r);
            if(r.state!=='BLOCKED'||this.store.project(r.projectId).activeRunId!==rid)throw new DomainError('EXECUTOR_CHECKPOINT_NOT_REQUIRED',409);
        };
        const work=Promise.resolve().then(async()=>{
            const r=this.store.run(rid);gate(r);const view=this.executorSlices.inspectCheckpoint(rid).view;
            if(view.previewHash!==input.previewHash)throw new DomainError('EXECUTOR_CHECKPOINT_PREVIEW_CHANGED',409);
            const proof=this.ownershipProofs(r);if(!proof.ok)throw new DomainError('PROCESS_OWNERSHIP_UNPROVEN',409,proof.reasons.join(', '));
            const grants=this.store.records(r.projectId,'DispatchGranted').filter(row=>row.runId===rid);if(grants.length>128)throw new DomainError('DISPATCH_RECOVERY_RECORD_LIMIT',409);
            const actual:unknown[]=[];for(const grant of grants)actual.push(await inspectDispatchOwnership(this.store,this.root,this.config(),r.projectId,rid,String(grant.data.dispatchId),this.networkRoute?.assertRecovered?.bind(this.networkRoute)));
            await this.dispatch.reconcileOwned(rid,(dispatchId,scope)=>inspectDispatchOwnership(this.store,this.root,this.config(),scope.projectId,rid,dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute)));
            this.dispatch.assertReconciliationReady(rid);gate(this.store.run(rid));
            return this.executorSlices.prepareCheckpoint(rid,input,operationHash,actor,controller.signal,hash({owner:proof.evidence,dispatches:actual}),gate);
        }).finally(()=>this.mergeRecoveries.delete(rid));
        this.mergeRecoveries.set(rid,{controller,promise:work});return work;
    }
    /**
     * Explicit recovery for the one class of block the checkpoint code itself declares recoverable.
     * It reuses the preview's custody read and the existing resume field change, then hands the run
     * back to the original loop. Nothing here is automatic: recover() is untouched, automaticResume
     * stays false and the recovery itself calls no model.
     */
    resumeExecutorCheckpoint(rid:string,input:ExecutorCheckpointResumeRequest,operationHash:string,actor:string):ExecutorCheckpointResumeResult{
        if(input.confirmed!==true)throw new DomainError('EXECUTOR_CHECKPOINT_CONSENT_REQUIRED',403);
        if(!/^[a-f0-9]{64}$/.test(operationHash)||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('EXECUTOR_CHECKPOINT_INPUT_INVALID',400);
        const r=this.store.run(rid);this.assertBinding(r);
        const replay=this.executorSlices.replayCheckpointResume(rid,operationHash,actor);if(replay)return replay;
        if(this.pausing)throw new DomainError('APPLICATION_PAUSING',409);
        if(this.store.project(r.projectId).activeRunId!==rid)throw new DomainError('EXECUTOR_CHECKPOINT_RESUME_NOT_ACTIVE',409);
        if(r.state!=='BLOCKED'||r.phase!=='IMPLEMENTING')throw new DomainError('EXECUTOR_CHECKPOINT_RESUME_NOT_BLOCKED',409);
        if(!checkpointReasons.has(r.reason??''))throw new DomainError('EXECUTOR_CHECKPOINT_RESUME_NOT_RECOVERABLE',409);
        // The same idle/ownership proof every other recovery path uses: a live job, an unknown
        // dispatch or an unsettled merge cannot be resumed over.
        if(this.jobs.has(rid)||this.dataJobs.has(rid)||this.reviewPreparations.has(rid))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        if(this.dispatch.hasUncertain(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
        if(this.executorSlices.hasUncertainMerge(rid))throw new DomainError('EXECUTOR_MERGE_RESULT_UNCERTAIN',409);
        this.assertCurrent(r);this.unchanged(r);
        // resume() already refuses Live before a refused account or permission can consume a round;
        // the same read-only admission runs here so a refusal leaves the retained checkpoint intact.
        if(r.mode==='live')this.assertNativeReadyForRun(r,r.flowName==='custom'?'build':'executor');
        const gate=(current:Run)=>{
            this.assertCurrent(current);
            if(this.store.project(current.projectId).activeRunId!==rid)throw new DomainError('EXECUTOR_CHECKPOINT_RESUME_NOT_ACTIVE',409);
            if(current.state!=='BLOCKED')throw new DomainError('EXECUTOR_CHECKPOINT_RESUME_NOT_BLOCKED',409);
        };
        const result=this.executorSlices.resumeCheckpoint(rid,operationHash,actor,gate);
        this.launch(rid);return result;
    }
    mergeRecoveryPreview(rid:string){return this.executorSlices.inspectRecovery(rid,!this.jobs.has(rid)&&!this.dataJobs.has(rid)&&!this.mergeRecoveries.has(rid)).view;}
    async recoverMerge(rid:string,input:MergeRecoveryRequest,operationHash:string,actor:string):Promise<MergeRecoveryResult>{
        if(input.confirmed!==true)throw new DomainError('MERGE_RECOVERY_CONSENT_REQUIRED',403);
        if(!['KEEP_FILES_AND_END','RESTORE_BASE_AND_END'].includes(input.choice)||![input.previewHash,input.expectedHash,operationHash].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('MERGE_RECOVERY_INPUT_INVALID',400);
        const custody=new MergeRecoveryFiles(this.store,this.executorSlices),replayed=custody.replay(rid,input,operationHash,actor);if(replayed)return replayed;
        if(this.pausing)throw new DomainError('APPLICATION_PAUSING',409);
        if(this.jobs.has(rid)||this.dataJobs.has(rid))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        if(this.mergeRecoveries.size)throw new DomainError('MERGE_RECOVERY_BUSY',409);
        const controller=new AbortController();
        const gate=(r:Run)=>{if(controller.signal.aborted||this.pausing)throw new DomainError('MERGE_RECOVERY_CANCELLED',409);this.assertCurrent(r);if(r.state!=='BLOCKED'||this.store.project(r.projectId).activeRunId!==rid)throw new DomainError('MERGE_RECOVERY_NOT_ALLOWED',409);};
        const work=Promise.resolve().then(async()=>{
            const r=this.store.run(rid);gate(r);const preview=this.executorSlices.inspectRecovery(rid).view;
            if(preview.source.currentHash!==input.expectedHash)throw new DomainError('MERGE_RECOVERY_SOURCE_CHANGED',409);if(preview.previewHash!==input.previewHash)throw new DomainError('MERGE_RECOVERY_PREVIEW_CHANGED',409);
            const proof=this.ownershipProofs(r);if(!proof.ok)throw new DomainError('PROCESS_OWNERSHIP_UNPROVEN',409,proof.reasons.join(', '));
            await this.dispatch.reconcileOwned(rid,(dispatchId,scope)=>inspectDispatchOwnership(this.store,this.root,this.config(),scope.projectId,rid,dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute)));
            this.dispatch.assertReconciliationReady(rid);gate(this.store.run(rid));
            return custody.apply(rid,input,operationHash,actor,controller.signal,hash(proof.evidence),gate,(current,result)=>{
                current.treeHash=result.sourceHash;current.state='CANCELLED';current.reason=result.choice==='RESTORE_BASE_AND_END'?'MERGE_RECOVERY_BASE_RESTORED':'MERGE_RECOVERY_FILES_RETAINED';
                this.releaseWriterWhenSafe(current);if(this.store.owns(current.projectId,current.id))throw new DomainError('PROCESS_OWNERSHIP_UNPROVEN',409);
            });
        }).finally(()=>this.mergeRecoveries.delete(rid));
        this.mergeRecoveries.set(rid,{controller,promise:work});return work;
    }
    /** Everything that must be true before an uncertain run may give up its writer lease. */
    private ownershipProofs(r: Run) {
        const reasons: string[] = [];
        const evidence: Record<string, unknown> = { runId: r.id, phase: r.phase, attempt: r.attempt };
        if (this.jobs.has(r.id))
            reasons.push('ACTIVE_JOB');
        if (!this.store.owns(r.projectId, r.id))
            reasons.push('LEASE_NOT_HELD');
        // The single-writer lock already guarantees no other server process is running, so a run with no job
        // here was written by an earlier generation. Timestamps are recorded as evidence, not as the proof.
        evidence.runUpdatedAt = r.updatedAt;
        evidence.processStartedAt = new Date(this.startedAt).toISOString();
        // Any host that outlived its parent would still be writing the workspace; refuse while one is alive.
        const alive: number[] = [];
        const seen: string[] = [];
        // Bounded scan of the only two places an owned host records its pid; never walk all of .runtime
        // (that directory holds databases and logs and this check runs on a recovery path).
        const candidates = [resolve(this.root, '.runtime/native/host.pid'), resolve(this.root, '.runtime/native/dsh-home/host.pid')];
        try {
            const dispatches = resolve(this.root, '.runtime/native-dispatches');
            if (existsSync(dispatches))
                for (const dir of readdirSync(dispatches))
                    candidates.push(resolve(dispatches, dir, 'host.pid'));
        }
        catch { }
        for (const path of candidates) {
            try {
                if (!existsSync(path))
                    continue;
                const pid = Number(readFileSync(path, 'utf8').trim());
                if (!Number.isSafeInteger(pid) || pid <= 0)
                    continue;
                seen.push(path);
                process.kill(pid, 0);
                alive.push(pid);
            }
            catch (error) {
                if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM')
                    alive.push(-1);
            }
        }
        evidence.hostPidFiles = seen;
        evidence.liveHostPids = alive;
        if (alive.length)
            reasons.push('HOST_PROCESS_ALIVE');
        return { ok: reasons.length === 0, reasons, evidence };
    }
    prepareCustomFlow(pid:string,specHash:string,profileHash:string,expected?:CustomFlowPreparationRef){
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        if(this.activeRunIds().some(rid=>this.store.run(rid).projectId===pid))throw new DomainError('FLOW_TERMINATION_REQUIRED',409);
        return this.customPreparations.prepare(pid,specHash,profileHash,expected);
    }
    /** Trusted mode catalog projection: ownership shape can expose preparation, never execution. */
    flowOptions(opts:{live?:boolean;laya?:boolean}={}){
        return flowCatalog(this.config(),{...opts,layaQualification:()=>this.layaQualificationStatus()},()=>{
            try{customNativeFactory(this.nativeExecution);return {connected:true};}
            catch{return {connected:false};}
        });
    }
    create(pid: string, specHash: string, approved: boolean, demoFault = false,flowChoice?:string,options:{laya?:boolean;taskDeadline?:null}={},actor?:string): Run {
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409,'本实例已停止新的制作派发；重新打开后先核对原运行，再明确继续。');
        const p = this.store.project(pid);
        if (!approved)
            throw new DomainError('BUILD_APPROVAL_REQUIRED', 403);
        const noTaskDeadline=Object.hasOwn(options,'taskDeadline');
        if(noTaskDeadline&&options.taskDeadline!==null)throw new DomainError('TASK_DEADLINE_WAIVER_INPUT_INVALID',400);
        if(noTaskDeadline&&(!actor||!/^local-session:[a-f0-9]{64}$/.test(actor)))throw new DomainError('TASK_DEADLINE_WAIVER_CONFIRMATION_REQUIRED',403);
        if(noTaskDeadline&&p.mode!=='live')throw new DomainError('TASK_DEADLINE_WAIVER_BINDING_INVALID',409);
        if (!p.specId || p.state !== 'READY_TO_BUILD')
            throw new DomainError('SPEC_NOT_APPROVED', 409);
        const s = this.store.spec(p.specId);
        if (s.stale || s.hash !== specHash || !this.store.approved(pid, s.hash, 'SPEC'))
            throw new DomainError('SPEC_APPROVAL_STALE', 409);
        const planVersion = this.store.planVersion(s.id);
        if (!planVersion.approval) throw new DomainError('PLAN_VERSION_APPROVAL_REQUIRED', 409);
        const flowName=flowChoice??'classic';
        if(flowName==='dreamflow'||flowName==='dreamflow-laya')throw new DomainError('LEGACY_FLOW_REQUIRES_MODE_CONFIRMATION',409,'旧流程仅保留历史，请重新选择经典或完全自定义。');
        if(options.laya!==undefined&&typeof options.laya!=='boolean')throw new DomainError('FLOW_LAYA_CHOICE_INVALID',400);
        if(flowName==='custom'&&options.laya===true)throw new DomainError('CUSTOM_LAYA_FORBIDDEN',400);
        const flow=resolveFlow(flowName,this.config(),{live:p.mode==='live',laya:options.laya,layaQualification:()=>this.layaQualificationStatus()});
        // The pure catalog cannot grant Custom execution. Only the original owned factory
        // may qualify the immutable prepared configuration below; no client flag is accepted.
        if(flowName==='custom')customNativeFactory(this.nativeExecution);
        else if(flow.blockedBy)throw new DomainError(flow.blockedBy,409,flow.reason);
        const prepared=flowName==='custom'?this.customPreparations.prepareCurrent(pid,s.hash):null;
        if (p.mode === 'live') {
            if(planVersion.origin!=='COMPLETE_PLAN'||!s.projectPlan)throw new DomainError('COMPLETE_PROJECT_PLAN_REQUIRED',409);
            if(prepared)assertCustomQualification(this.nativeExecution,prepared.flowConfig);
            else{
                const ready = nativeReadiness(this.config());
                if (!ready.ok)throw new DomainError('NATIVE_INTEGRATION_BLOCKED',409,ready.reasons.join(', '));
                this.nativeFactory().assertReady('build',{projectId:pid,specHash:s.hash});
            }
        }
        else if(prepared)throw new DomainError('CUSTOM_NATIVE_RUNTIME_REQUIRED',409,'自定义流程需要真实运行器，不能作为固定演示运行。');
        if(this.activeRunIds().some(rid=>this.store.run(rid).projectId===pid))throw new DomainError('WORKSPACE_BUSY',409);
        if(this.dispatch.snapshot().quarantined.length)throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
        if(this.activeJobCount>=64)throw new DomainError('GLOBAL_FLOW_QUEUE_FULL',409,'等待和活动项目已达到本机队列上限，请先完成或安全暂停已有任务。');
        const limits = this.config().limits, rid = prepared?.flowConfig.runId??id('run'), workspace = resolve(this.data, 'workspaces', rid);
        const r: Run = { id: rid, projectId: pid, mode: p.mode, version: 1, specId: s.id, specHash: s.hash, configFingerprint: hash(this.config()), state: 'PLANNING', phase: 'PLANNING', repairCount: 0, maxRepairs: limits.maxRepairs, calls: 0, maxCalls: limits.maxCalls, createdAt: now(), updatedAt: now(), workspace, treeHash: null, tasks: [], findings: [], plan: null, verification: null, review: null, artifacts: [], reason: null, failedFingerprints: [], attempt: 0, demoFault: p.mode === 'demo' && demoFault, maxSeconds: limits.maxSeconds, usage: [], sessions: {} };
        r.planVersionId = planVersion.id;
        r.planVersionHash = planVersion.contentHash;
        r.rolePolicy = prepared?CUSTOM_ROLE_POLICY:TARGET_ROLE_POLICY;
        r.flowName=flowName as FlowName;
        // Custom dispatch remains closed above until its real NativeOwner factory qualifies.
        // Its run consumes the exact prepared configuration/identity, never a Classic fallback.
        // A project's own role configuration is compiled into the classic Flow at freeze time, so a
        // saved selection becomes run data instead of a badge-only value. A project that never saved
        // one passes null and keeps the byte-identical classic bindings; a Custom run keeps its
        // prepared flow and is never compiled here.
        const savedRoles=prepared?null:(currentRoleConfiguration(this.store,pid)?.roles??null);
        r.flowConfig=prepared?.flowConfig??compileClassicRoleConfiguration(classicFlowSnapshot(this.config(),planVersion,rid,options.laya===true),savedRoles);
        r.flowConfigHash=hash(r.flowConfig);
        r.configFingerprint=r.flowConfig.configurationFingerprint;
        this.store.tx(() => {
            this.assertBinding(r);this.store.acquire(pid, rid);this.store.approve(pid,s.hash,'BUILD');this.store.insertRun(r);
            if(noTaskDeadline)saveTaskDeadlineWaiver(this.store,r,actor!);
            p.activeRunId=rid;this.store.saveProject(p);
            this.store.event(pid,rid,'run.created',{mode:p.mode,specHash:s.hash,scope:p.mode==='demo'?'FIXED_STUDY_BOARD_TEMPLATE':'LIVE_AUDITED_HOST'});
        });
        mkdirSync(workspace, { recursive: true, mode: 0o700 });
        this.launch(rid);
        return r;
    }
    private reserveDocumentationRuntime(run:Run){
        const factory=this.nativeFactory();
        if(typeof factory.repairRevision!=='function'||typeof factory.reserveRepair!=='function')
            throw new DomainError('DOCUMENTATION_REPAIR_ACCOUNTING_REQUIRED',409);
        return reserveDocumentationRepair(this.store,run,{
            repairRevision:runId=>factory.repairRevision!(runId),
            reserveRepair:runId=>factory.reserveRepair!(runId),
        });
    }
    launch(rid: string) {
        if (this.jobs.has(rid))
            return;
        const prepared=this.store.run(rid);
        if(prepared.documentationContinuation){
            documentationContinuationEvidence(this.store,prepared);
            if(prepared.state==='PAUSED'&&prepared.repairCount===0)throw new DomainError('DOCUMENTATION_CONTINUATION_RESUME_REQUIRED',409);
            if(!['IMPLEMENTING','VERIFYING','REVIEWING'].includes(prepared.state))throw new DomainError('DOCUMENTATION_CONTINUATION_STATE_INVALID',409);
            documentationRuntimeEvidence(this.store,prepared);
            this.reserveDocumentationRuntime(prepared);
        }
        if([...this.dataJobs.keys()].some(id=>this.store.run(id).projectId===this.store.run(rid).projectId))throw new DomainError('WORKSPACE_BUSY',409);
        if(this.pausing){const current=this.store.run(rid);if(!['BLOCKED','PAUSED','READY_FOR_DELIVERY',...TERMINAL].includes(current.state))this.update(rid,'run.paused',run=>{run.state='PAUSED';});return;}
        const controller = new AbortController(), run = this.store.run(rid);
        executionWorkspace(run,this.data);
        const remaining = Math.max(0, runDeadline(this.store,run) - Date.now());
        const deadline = Number.isFinite(remaining)?setTimeout(() => controller.abort(new DomainError('RUN_WALL_TIME_BUDGET_EXCEEDED', 409)), remaining):undefined;
        const work = () => this.loop(rid, controller.signal);
        // A Live run is wrapped in the Clash selector lease so verification and every model call share one
        // node chain; a route failure block never silently degrades to a direct connection.
        const routed=async(control?:DispatchControl)=>{
            if(this.store.run(rid).state==='PAUSE_REQUESTED'){this.update(rid,'run.paused',r=>{r.state='PAUSED';});control?.confirmCleanup();return;}
            const value=await this.networkRoute!.withRun(rid,controller.signal,work,()=>control?.confirmCleanup());
            if(this.store.run(rid).reason==='PROCESS_CLEANUP_UNPROVEN')throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);
            control?.confirmCleanup();
            return value;
        };
        const promise = Promise.resolve().then(() => run.mode === 'live' && this.networkRoute
            ?this.config().clash.enabled?this.dispatch.run({projectId:run.projectId,runId:rid,kind:'route',mode:run.mode,signal:controller.signal},routed):routed()
            :work())
            .catch(error => {
                const current = this.store.run(rid);
                if(this.dispatch.hasUncertain(rid)||error instanceof DomainError&&error.code==='PROCESS_CLEANUP_UNPROVEN'){
                    this.update(rid,'run.route.cleanup.unproven',value=>{value.state='BLOCKED';value.reason='PROCESS_CLEANUP_UNPROVEN';});return;
                }
                if (!['BLOCKED', 'CANCELLED', 'FAILED', 'PARTIAL', 'READY_FOR_DELIVERY', 'ACCEPTED', 'PAUSED'].includes(current.state)) {
                    if (controller.signal.aborted || current.state === 'CANCEL_REQUESTED') this.finalCancel(rid);
                    else if(error instanceof DomainError&&error.code==='DISPATCH_PAUSED')this.update(rid,'run.paused',value=>{value.state='PAUSED';});
                    else this.update(rid, 'run.route.blocked', value => { value.state = 'BLOCKED'; value.reason = error instanceof DomainError ? error.code : redact(String(error)); });
                }
            })
            .finally(() => { clearTimeout(deadline); this.jobs.delete(rid);
                const current=this.store.run(rid);if(current.pendingLeaseRelease)this.store.tx(()=>{this.releaseWriterWhenSafe(current);this.store.saveRun(current);this.store.event(current.projectId,current.id,'run.finalize.writer',{leaseHeld:this.store.owns(current.projectId,current.id),reason:current.reason});});
            });
        this.jobs.set(rid, { controller, promise });
    }
    async settled(rid: string) { await this.jobs.get(rid)?.promise; }
    private update(rid: string, type: string, fn: (r: Run) => void) { return this.store.tx(() => { const r = this.store.run(rid); fn(r); this.store.saveRun(r); this.store.event(r.projectId, r.id, type, { state: r.state, phase: r.phase, attempt: r.attempt, reason: r.reason }); return r; }); }
    /** Binding a run to its frozen configuration and spec. True for a settled run too. */
    private assertBinding(r: Run) {
        if(r.flowName==='custom'){
            customNativeFactory(this.nativeExecution);
            if(r.rolePolicy!==CUSTOM_ROLE_POLICY)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
        }
        if (r.configFingerprint !== runConfigurationFingerprint(r,this.config()))
        throw new DomainError('RUN_CONFIG_CHANGED', 409); const p = this.store.project(r.projectId); if (!p.specId || p.specId !== r.specId || this.store.spec(r.specId).stale || this.store.spec(r.specId).hash !== r.specHash)
        throw new DomainError('RUN_SPEC_STALE', 409);
        if (r.planVersionId) {
            const plan = this.store.planVersion(r.planVersionId);
            if (plan.projectId !== r.projectId || plan.specHash !== r.specHash || plan.contentHash !== r.planVersionHash || !plan.approval)
                throw new DomainError('RUN_PLAN_VERSION_CHANGED', 409);
        }
    }
    /** A WRITER also has to hold the project lease. Acceptance is a reader action on a frozen artifact, so it
     *  must survive the release that happens when a run reaches READY_FOR_DELIVERY (see advance). */
    private assertCurrent(r: Run) { executionWorkspace(r,this.data);this.assertBinding(r); if (!this.store.owns(r.projectId, r.id))
        throw new DomainError('WORKSPACE_LEASE_LOST', 409); }
    private unchanged(r: Run) { executionWorkspace(r,this.data);if (r.treeHash && r.treeHash !== treeHash(r.workspace))
        throw new DomainError('EXTERNAL_WORKSPACE_CHANGE', 409); }
    private async delay(signal: AbortSignal) { if (signal.aborted)
        throw new DomainError('RUN_CANCELLED', 409); if (this.demoDelayMs)
        await new Promise<void>((res, rej) => { const abort = () => { clearTimeout(timer); rej(new DomainError('RUN_CANCELLED', 409)); }; const timer = setTimeout(() => { signal.removeEventListener('abort', abort); res(); }, this.demoDelayMs); signal.addEventListener('abort', abort, { once: true }); }); }
    /** The classic executor model the run froze, which is what the request-context pin re-checks. */
    private classicExecutorModel(r: Run): string {
        const flow = r.flowConfig as { mode?: string; roles?: { executors?: readonly { model?: string }[] } } | null | undefined;
        const frozen = flow?.mode === 'classic' ? flow.roles?.executors?.[0]?.model : undefined;
        const model = typeof frozen === 'string' && frozen ? frozen : this.config().dsh.model;
        process.stderr.write('CLASSIC_EXECUTOR_MODEL_BOUND '+JSON.stringify({runId:r.id,frozen:typeof frozen==='string'&&frozen?frozen:null,model})+'\n');
        return model;
    }
    /** The registered verifier cases for this spec, or undefined when none is registered. */
    private verifierCasesFor(specHash:string): readonly unknown[] | undefined {
        try {
            const path=resolve(this.root,'.runtime/controller/oracles',specHash+'.json');
            if(!existsSync(path))return undefined;
            const plan=JSON.parse(readFileSync(path,'utf8')) as {cases?:unknown[]};
            return Array.isArray(plan.cases)&&plan.cases.length?plan.cases.slice(0,20):undefined;
        } catch { return undefined; }
    }
    private async role(r: Run, role: Role, prompt: string, signal: AbortSignal,taskId?:string,sliceId?:string): Promise<unknown> {
        if(r.reviewSupplement&&role!=='reviewer')throw new DomainError('REVIEW_SUPPLEMENT_ROLE_DENIED',409);
        if(r.reviewOnlyWindow&&role!=='reviewer')throw new DomainError('REVIEW_ONLY_CONTINUATION_ROLE_DENIED',409);
        if(role==='planner1')throw new DomainError('ENGINE_PLANNER1_DISPATCH_DENIED',403);
        // This gate precedes queue admission and charging. Runtime/tools recheck it later.
        const handoff=role==='executor'?assertPreworkDispatch(this.store,this.store.run(r.id),taskId):undefined;
        // The task is still pending before dispatch; active assignment() remains enforced after task.started.
        const prepared=sliceId?this.executorSlices.pending(r.id)?.assignments.find(a=>a.id===sliceId):undefined;
        if(sliceId&&(!prepared||prepared.taskId!==taskId||role!=='executor'))throw new DomainError('EXECUTOR_SLICE_BINDING_CHANGED',409);
        const actor=role==='executor'?executorRoleForTurn(r,prepared):undefined;
        const beforeFiles=handoff?files(prepared?.workspace??r.workspace):undefined;
        if(handoff)prompt+='\nPREWORK HANDOFF (read-only): '+JSON.stringify(handoff);
        const observation:{decision?:LayaDecision;provided:boolean;promptHash?:string;completion?:{dispatchId:string;generation:string;sessionId:string;requestId:string}}={provided:false};
        try{
            const executorParallelClass=role==='executor'?(r.flowName==='custom'?'CUSTOM_MULTI':'CLASSIC_SERIAL'):undefined;
            const completion=await this.dispatch.run({projectId:r.projectId,runId:r.id,kind:role,mode:r.mode,signal,...(actor?{executorRoleId:actor}:{}),...(role==='executor'&&sliceId?{executorSliceId:sliceId}:{}),...(executorParallelClass?{executorParallelClass}:{})},control=>this.roleTurn(r,role,prompt,signal,control,observation,taskId,sliceId));
            if(signal.aborted)throw signal.reason instanceof DomainError?signal.reason:new DomainError('RUN_CANCELLED',409);
            const publish=handoff&&beforeFiles?(current:Run)=>{
                const afterFiles=files(prepared?.workspace??r.workspace),old=new Map(beforeFiles.map(f=>[f.path,f.sha256])),next=new Map(afterFiles.map(f=>[f.path,f.sha256]));
                savePreworkResult(this.store,current,{...(taskId?{taskId}:{}),dispatchId:completion.dispatchId,generation:completion.generation,
                    sessionId:completion.result.mode==='live'?completion.result.out.sessionId:'synthetic-demo',requestId:completion.result.mode==='live'?completion.result.out.usage.requestId:'synthetic-demo',beforeHash:hash(beforeFiles),afterHash:hash(afterFiles),
                    changedPaths:[...new Set([...old.keys(),...next.keys()])].filter(p=>old.get(p)!==next.get(p)).sort()});
            }:undefined;
            await this.commitRoleCompletion(r.id,role,completion,publish);
            if(completion.result.mode==='demo')return null;
            const {out}=completion.result;
            observation.completion={dispatchId:completion.dispatchId,generation:completion.generation,sessionId:out.sessionId,requestId:out.usage.requestId};
            observation.provided=observation.decision?.adoption==='advisory'&&!!observation.decision.support?.guide;
            if(role==='executor')return out.text;
            try{return JSON.parse(redact(out.text));}catch{throw new DomainError('AGENT_STRUCTURED_OUTPUT_INVALID',502);}
        }
        finally{
            const decision=observation.decision;if(decision){
                this.store.record('LayaApplication',r.projectId,r.id,{role,mode:r.mode,decisionHash:hash(decision),inputHash:decision.inputHash,...(decision.invocation?{invocation:decision.invocation}:{}),...(observation.completion?{completedRole:observation.completion}:{}),...(observation.promptHash?{agentInputPromptHash:observation.promptHash}:{}),providedToCompletedRole:observation.provided,
                    status:observation.provided?'PROVIDED_TO_COMPLETED_ROLE':r.mode==='demo'?'NOT_PROVIDED_DEMO':'NOT_CONFIRMED_PROVIDED',causalModelInfluence:'NOT_CLAIMED'});
                this.layaObserver?.record({role,mode:decision.mode,adoption:decision.adoption,applied:observation.provided,runMode:r.mode});
            }
        }
    }
    private async commitRoleCompletion(runId:string,role:Role,completion:DispatchedRoleResult,afterPublish?:(run:Run)=>void):Promise<void>{
        let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),prior=this.roleCommitQueue;
        this.roleCommitQueue=prior.then(()=>gate);
        await prior;
        try{
            const current=this.store.run(runId);this.assertCurrent(current);
            commitRoleResult(this.store,current,role,completion,afterPublish);
        }finally{release();}
    }
    private async roleTurn(r:Run,role:Role,prompt:string,signal:AbortSignal,control:DispatchControl,observation:{decision?:LayaDecision;provided:boolean;promptHash?:string;completion?:{dispatchId:string;generation:string;sessionId:string;requestId:string}},taskId?:string,sliceId?:string):Promise<DispatchedRoleResult>{
        const ownership=currentProcessOwnership();if(!ownership)throw new DomainError('PROCESS_OWNERSHIP_UNPROVEN',409);
        try{return{result:await this.roleTurnOwned(r,role,prompt,signal,control,observation,taskId,sliceId),dispatchId:ownership.dispatchId,generation:ownership.generation,phase:r.phase};}
        finally{
            if(r.reviewSupplement&&role==='reviewer')this.store.record('ReviewSupplementDispatchEnd',r.projectId,r.id,{dispatchId:ownership.dispatchId,generation:ownership.generation,eventBoundaryId:Number(this.store.db.prepare('SELECT COALESCE(MAX(id),0) n FROM events WHERE project_id=? AND run_id=?').get(r.projectId,r.id)!.n)});
            if(processCleanupProven(ownership))control.confirmCleanup();
        }
    }
    private async verifyOwned(input:AgentInput,emit:(e:unknown)=>void,control:DispatchControl){
        try{return await this.nativeFactory().verify(input,emit);}
        finally{const ownership=currentProcessOwnership();if(ownership&&processCleanupProven(ownership))control.confirmCleanup();}
    }
    private async roleTurnOwned(r:Run,role:Role,prompt:string,signal:AbortSignal,control:DispatchControl,observation:{decision?:LayaDecision;provided:boolean;promptHash?:string;completion?:{dispatchId:string;generation:string;sessionId:string;requestId:string}},taskId?:string,sliceId?:string):Promise<RoleTurnResult>{
        try{
            if(signal.aborted)throw signal.reason??new DomainError('RUN_CANCELLED',409);
            if(this.pausing||this.store.run(r.id).state==='PAUSE_REQUESTED')throw new DomainError('DISPATCH_PAUSED',409);
            this.assertCurrent(this.store.run(r.id));this.unchanged(r);
            if(role==='executor')assertPreworkDispatch(this.store,this.store.run(r.id),taskId);
            if(r.mode==='live'){
                const custom=r.flowName==='custom';
                if(r.rolePolicy!==(custom?CUSTOM_ROLE_POLICY:TARGET_ROLE_POLICY))throw new DomainError('LEGACY_ROLE_POLICY_REQUIRES_NEW_FLOW',409);
                this.assertNativeReadyForRun(r,role);
            }
            this.update(r.id, 'role.dispatch', x => {
                if(x.reviewSupplement){assertReviewSupplementPacket(this.store,x,JSON.parse(prompt));reserveReviewSupplementCall(this.store,x,role,currentProcessOwnership()!);}
                else if(!reserveReviewPreparationReplay(this.store,x,role,currentProcessOwnership()!))reserveCall(x);
            });
        }catch(error){control.confirmCleanup();throw error;} // Admission is read-only; no process or model was launched.
        if(role==='planner1')throw new DomainError('ENGINE_PLANNER1_DISPATCH_DENIED',403);
        const assistanceSourceHash=treeHash(r.workspace);
        const brief=roleAssistanceBrief(this.store,this.store.run(r.id),role,prompt,runUsesLaya(r),taskId);
        const decision = attachRoleGuide(role,await this.laya.decide(role,r.projectId,brief.state,brief.labels,signal,{forceOff:!runUsesLaya(r)}),brief.support);
        const assistanceOwner=currentProcessOwnership();
        if(!assistanceOwner)throw new DomainError('PROCESS_OWNERSHIP_UNPROVEN',409);
        decision.invocation={dispatchId:assistanceOwner.dispatchId,generation:assistanceOwner.generation,taskId:taskId??null,sourceHash:assistanceSourceHash};
        observation.decision=decision;
        this.store.record('LayaDecision', r.projectId, r.id, decision);
        // A helper decision is not a model dispatch. Recheck after that await so pausing or
        // cancellation cannot open a role round that had not actually begun.
        if(signal.aborted){control.confirmCleanup();throw signal.reason??new DomainError('RUN_CANCELLED',409);}
        if(this.pausing||this.store.run(r.id).state==='PAUSE_REQUESTED'){control.confirmCleanup();throw new DomainError('DISPATCH_PAUSED',409);}
        // Configuration/spec/source may change while the read-only assistance awaits.
        // Fence before constructing any runtime, not only after a model has already run.
        this.assertCurrent(this.store.run(r.id));this.unchanged(r);
        if(treeHash(r.workspace)!==assistanceSourceHash)throw new DomainError('EXTERNAL_WORKSPACE_CHANGE',409);
        if(role==='executor')assertPreworkDispatch(this.store,this.store.run(r.id),taskId);
        if(runUsesLaya(r)&&decision.reason!=='VALIDATED_ADVISORY_ONLY')throw new DomainError('LAYA_ROLE_SUPPORT_UNAVAILABLE',409,decision.reason);
        if(role==='executor'&&taskId)this.update(r.id,'task.started',run=>{run.tasks=run.tasks.map(task=>task.id===taskId?{...task,status:'running'}:task);});
        if (r.mode === 'demo') {
            try{await this.delay(signal);}finally{control.confirmCleanup();}
            return{mode:'demo'};
        }
        const body = JSON.stringify({ specHash: r.specHash, taskData: prompt, laya: decision.adoption === 'advisory' ? decision : null });
        observation.promptHash=hash(body);
        const assignment=sliceId?this.executorSlices.assignment(r.id,sliceId):undefined;
        if(assignment&&(role!=='executor'||assignment.taskId!==taskId))throw new DomainError('EXECUTOR_SLICE_BINDING_CHANGED',409);
        const executorRoleId=role==='executor'?executorRoleForTurn(r,assignment):undefined,customRole=r.flowConfig?.mode==='custom'?customRoleConfiguration(r.flowConfig,role,executorRoleId):undefined;
        // Names the directory the executor will actually write into. The wave protocol needs the slice copy; a silent
        // fall back to the canonical workspace makes the merge answer EXTERNAL_WORKSPACE_CHANGE and the delivery never
        // reaches the verifier, so the resolved target is stated on stderr.
        if(role==='executor')process.stderr.write('EXECUTOR_WORKSPACE '+JSON.stringify({sliceBound:!!assignment,sliceId:assignment?.id??null,workspace:(assignment?.workspace??r.workspace),canonical:r.workspace})+'\n');
        const input: AgentInput = { role, workspace: assignment?.workspace??r.workspace, ...(assignment?{executorSliceId:assignment.id}:{}),...(executorRoleId?{executorRoleId}:{}),...(role==='executor'&&taskId?{taskId}:{}),...(role==='executor'&&r.phase==='REPAIRING'?{repairRound:r.repairCount}:{}), ...(role==='reviewer'&&r.flowName!=='custom'?{outputSchema:codexReviewOutputSchema(Boolean(r.prework))}:{}), prompt: body, model: customRole?customRole.model.id:role === 'executor' ? this.classicExecutorModel(r) : this.config().codex.model, specHash: r.specHash, runId: r.id, laya: decision, signal };
        const runner = customRole?customNativeFactory(this.nativeExecution).custom(input):roleRunner(role, this.config(), {
            executor: () => this.nativeFactory().executor(input),
            codex: () => this.nativeFactory().codex?.(input)??new CodexRunner(this.config, this.root, false, this.networkRoute?.childEnvironment.bind(this.networkRoute),undefined,this.networkRoute?.observeCodexRequestRoute?.bind(this.networkRoute)),
            independent: this.independentRunner,
        }, r.rolePolicy ?? 'LEGACY_CONFIGURED_V1');
        const eventOwnership=currentProcessOwnership();
        const emit = (e: unknown) => {
            const value=object(JSON.parse(redact(e)));
            const record=roleEventRecord(value,!!r.reviewSupplement,eventOwnership!);
            this.store.event(r.projectId,r.id,record.type,record.payload);
        };
        const boundedRepair=r.phase==='REPAIRING'&&this.store.records(r.projectId,'PartialRepairContinuation').some(row=>row.runId===r.id);
        const out = role === 'executor'&&!customRole&&!boundedRepair&&!r.documentationContinuation
            ? await this.executorSegmented(r, input, runner, prompt, decision, emit)
            : await runner.run(input, emit);
        // Dispatch checks the actual process receipts separately from the role's returned text.
        this.assertCurrent(this.store.run(r.id));
        const identity = customRole?customExecutionIdentity(r,role,out,executorRoleId):executionIdentity(role,this.config(),out);
        if ((role === 'planner2' || role === 'reviewer') && r.sessions[role === 'planner2' ? 'reviewer' : 'planner2'] === out.sessionId)
            throw new DomainError('ROLE_SESSIONS_NOT_INDEPENDENT', 409);
        if(role==='reviewer'&&r.flowName==='custom'&&(this.store.run(r.id).executorRoleIdentities??[]).some(value=>value.sessionId===out.sessionId))
            throw new DomainError('ROLE_SESSIONS_NOT_INDEPENDENT',409);
        if(r.documentationContinuation){
            const inherited=documentationRuntimeEvidence(this.store,this.store.run(r.id)).approval,parent=this.store.run(inherited.parentRunId);
            const executorSessions=r.flowName==='custom'?this.store.run(r.id).executorRoleIdentities?.map(value=>value.sessionId)??[]:r.sessions.executor?[r.sessions.executor]:[];
            if(out.sessionId===parent.roleIdentities?.planner2?.sessionId||out.sessionId===parent.sessions.reviewer||executorSessions.includes(out.sessionId)&&role==='reviewer')
                throw new DomainError('ROLE_SESSIONS_NOT_INDEPENDENT',409);
        }
        return{mode:'live',out:structuredClone(out),identity,...(input.executorRoleId?{executorRoleId:input.executorRoleId}:{}),...(assignment?{assignment:{taskId:assignment.taskId,sliceId:assignment.id}}:{})};
    }
    private advance(rid: string, phase: Phase, apply: (r: Run) => void = () => { }) { this.update(rid, 'run.phase', r => { apply(r); r.phase = phase; if (r.state !== 'CANCEL_REQUESTED')
        r.state = r.state === 'PAUSE_REQUESTED'&&phase!=='READY_FOR_DELIVERY' ? 'PAUSED' : phase;
        // A delivered run is no longer a writer: the workspace is frozen, verified and reviewed, and both
        // acceptance and export read it. Keeping the lease pinned the project instead — two demo runs sat in
        // READY_FOR_DELIVERY since 2026-10-18 holding theirs, so no new build for those projects was possible
        // until each was cancelled by hand. Released in the same transaction as the state change, mirroring
        // blockAndRelease, so a crash cannot leave a delivered run holding a writer.
        if (r.state === 'READY_FOR_DELIVERY') this.releaseWriterWhenSafe(r); }); }
    private releaseWriterWhenSafe(r:Run){
        if(this.executorSlices.hasUncertainMerge(r.id)){r.state='BLOCKED';r.reason='EXECUTOR_MERGE_RESULT_UNCERTAIN';r.pendingLeaseRelease=true;return;}
        if(this.dispatch.hasUncertain(r.id)){r.state='BLOCKED';r.reason='PROCESS_CLEANUP_UNPROVEN';r.pendingLeaseRelease=true;return;}
        if(this.dispatch.hasActiveRoute(r.id)){r.pendingLeaseRelease=true;return;}
        delete r.pendingLeaseRelease;this.store.release(r.projectId,r.id);
    }
    private blockAndRelease(rid: string, type: string, reason: string) {
        return this.update(rid, type, r => {
            r.state = 'BLOCKED';
            r.reason = reason;
            // This path is only used after the verifier/reviewer has settled. Keep the state transition and
            // lease release in one SQLite transaction so a crash cannot leave a settled block holding a writer.
            this.releaseWriterWhenSafe(r);
        });
    }
    private repair(rid: string, reason: string, settledWriterFailure = false) {
        const result = this.update(rid, 'run.repair.requested', r => {
            if(r.documentationContinuation){
                const code=documentationContinuationEvidence(this.store,r)?.repairKind==='CODE';
                r.state='BLOCKED';
                r.reason=reason.startsWith('VERIFIER_EXIT_')
                    ?code?'BOUNDED_CODE_REPAIR_VERIFICATION_FAILED':'DOCUMENTATION_CONTINUATION_VERIFICATION_FAILED'
                    :code?'BOUNDED_CODE_REPAIR_REVIEW_CHANGES_REQUESTED':'DOCUMENTATION_CONTINUATION_REVIEW_CHANGES_REQUESTED';
                if(settledWriterFailure)this.releaseWriterWhenSafe(r);
                return;
            }
            if(r.reviewSupplement){r.state='BLOCKED';r.reason='REVIEW_SUPPLEMENT_CHANGES_REQUESTED';if(settledWriterFailure)this.releaseWriterWhenSafe(r);return;}
            reason = redact(reason);
            const fp = hash(reason);
            r.failedFingerprints.push(fp);
            // A declared file that is still absent means the slice is not finished yet, not that the plan is
            // wrong. Counting it as a repair spent the whole budget before the remaining tasks had ever been
            // attempted, so the verifier then judged a half-built delivery (measured: 3 of 10 tasks done).
            // Such a retry keeps the run on the same task and no longer consumes the repair budget, while the
            // repeated-fingerprint rule below still stops it from looping forever.
            const INCOMPLETE_TASK_RETRY=/EXECUTOR_DECLARED_FILES_MISSING|DECLARED_FILES_PREFLIGHT/.test(reason);
            const noProgress = r.failedFingerprints.filter(x => x === fp).length >= 2;
            if (noProgress || (!INCOMPLETE_TASK_RETRY && r.repairCount >= r.maxRepairs)) {
                r.state = 'BLOCKED';
                r.reason = r.repairCount >= r.maxRepairs ? 'REPAIR_LIMIT' : 'REPEATED_FAILURE_NO_PROGRESS';
                if (settledWriterFailure)
                    this.releaseWriterWhenSafe(r);
                return;
            }
            if(r.mode==='live'){
                const factory=this.nativeFactory();if(!factory.reserveRepair)throw new DomainError('NATIVE_REPAIR_ACCOUNTING_REQUIRED',409);
                factory.reserveRepair(r.id);
            }
            if(!INCOMPLETE_TASK_RETRY)r.repairCount++;
            r.phase = 'REPAIRING';
            r.state = r.state === 'PAUSE_REQUESTED' ? 'PAUSED' : 'REPAIRING';
            r.reason = reason;
        });
        return result;
    }
    private async loop(rid: string, signal: AbortSignal) {
        try {
            for (;;) {
                let r = this.store.run(rid);
                if (signal.aborted)
                    throw signal.reason ?? new DomainError('RUN_CANCELLED', 409);
                if (r.state === 'CANCEL_REQUESTED') {
                    this.finalCancel(rid);
                    return;
                }
                if (['PAUSED', 'BLOCKED', 'READY_FOR_DELIVERY', ...TERMINAL].includes(r.state))
                    return;
                if (r.state === 'PAUSE_REQUESTED') {
                    this.update(rid, 'run.paused', x => { x.state = 'PAUSED'; });
                    return;
                }
                this.assertCurrent(r);
                checkDuration(r,this.store);
                this.unchanged(r);
                this.update(rid, 'step.started', x => { x.attempt++; });
                r = this.store.run(rid);
                const stepId = this.store.record('Step', r.projectId, r.id, { phase: r.phase, attempt: r.attempt, specHash: r.specHash, treeHash: r.treeHash, startedAt: now() });
                const spec = this.store.spec(r.specId);
                if (r.phase === 'PLANNING') {
                    // The planner is validated against requirement IDS, so it has to be told them explicitly:
                    // the master prompt describes the product, and a model that only sees prose invents its own
                    // ids and the run dies as PLAN_REQUIREMENT_OMITTED. Listing them is also what makes the
                    // omission check meaningful instead of a guessing game.
                    const requirementIndex = spec.requirements.map(x => x.id + ' (' + String(x.priority ?? 'must') + '): ' + String(x.text ?? '')).join(String.fromCharCode(10));
                    // The Seeker plan carries its own requirement id space (S001..), which this spec does not have.
                    // Offering those ids made the planner copy them into requirementIds, and every attempt was then
                    // rejected as PLAN_REFERENCE_INVALID. Only ids that exist in this spec may reach the planner.
                    const specRequirementIds = new Set(spec.requirements.map(x => x.id));
                    const frozenProjectTasks = (r.mode === 'live' && Array.isArray(spec.projectPlan?.tasks) ? spec.projectPlan.tasks : [])
                        .map(task => ({ ...task, requirementIds: (Array.isArray(task.requirementIds) ? task.requirementIds : []).filter((id: string) => specRequirementIds.has(id)) }));
                    const approvedVersion = r.planVersionId ? this.store.planVersion(r.planVersionId) : undefined;
                    const approvalContext = approvedVersion
                        ? '\n\nAPPROVED PLAN VERSION: ' + approvedVersion.id + '\nSHA-256: ' + approvedVersion.contentHash
                            + '\nThe controller verified approval of this frozen version for this run. Historical pending-approval wording in the proposal does not revoke that approval. Do not change the frozen scope or defaults.'
                        : '';
                    const planPrompt = spec.masterPrompt + approvalContext
                        + '\nDATA RUNTIME: only when required by the frozen spec, optional dataRuntime declares JSON_DOCUMENT_V1 (dream-maker.json-runtime-plan.v1) or SQLITE_IMAGE_V1 (dream-maker.sqlite-runtime-plan.v1), with runtime node/python, relative entry and bounded args. SQLite uses only /data/project.sqlite; bytes travel through the controller binary channel, never stdout or a host path. A declaration grants no execution or approval. Implement and test the declared entry; never invent persistence success.'
                        + String.fromCharCode(10, 10)
                        + 'REQUIREMENTS (' + spec.requirements.length + ') — every id below must appear in the requirementIds of at least one task, spelled exactly as written:'
                        + String.fromCharCode(10) + requirementIndex
                        + String.fromCharCode(10, 10)
                        + 'FROZEN PROJECT TASKS (' + frozenProjectTasks.length + ') — preserve every id, dependsOn and requirementIds exactly. You may add dependent implementation tasks, but may not omit or alter these approved tasks. Keep each frozen task check in its acceptance list and declare its non-empty writePaths.'
                        + String.fromCharCode(10) + JSON.stringify(frozenProjectTasks)
                        + String.fromCharCode(10, 10)
                        + 'TASK GRANULARITY: each task must be one coherent, independently verifiable implementation slice that one executor turn can finish in at most 8 tool calls. Split broad setup, data, UI, integration and verification work into separate tasks; do not emit a mega-task. Every new task must declare non-empty writePaths: exact source files or directory prefixes ending in /. Controller-owned verification and independent review are not executor tasks; the controller runs them after implementation. Do not create empty-scope tasks for testing, review, approval or delivery. Independent tasks need disjoint write scopes; shared files require dependencies. No roots, globs, credentials, Git or dependency caches.'
                        + '\nPREWORK HANDOFF: every task must declare at least one exact approved requirementId, non-empty acceptance checks and non-empty writePaths. The controller converts this DAG into an immutable requirement/evidence matrix and scoped work packages. Executor dispatch is forbidden until that handoff validates. Separate evidence collection from final independent review; never add a review-only task or self-declare completed evidence.'
                        + (r.flowName==='custom'?'\n\nCUSTOM TERMINAL TOOL: Call submit_engineering_plan exactly once with the complete final plan object. Put the plan fields in the tool arguments, not in assistant prose. A prose-only answer, Markdown answer or second submission is invalid and will block the run.':'');
                    const before = treeHash(r.workspace);
                    // A planner answer is model output, and a plan that omits one requirement id is a real,
                    // reproducible behaviour rather than a bug in the model. Asking once and blocking the run
                    // wastes an entire dispatch, so the omission is fed back ONCE with the missing ids named.
                    // The role keeps its own conversation, so the retry is a correction, not a fresh start.
                    // A planner answer is model output, and an answer that omits a requirement id is normal model
                    // behaviour rather than a product bug. Blocking the whole dispatch on the first attempt wastes
                    // the run, so a plan that fails validation is fed back ONE more time with the reason named. The
                    // role keeps its own conversation, so the retry is a correction, not a restart.
                    const requirementIds = spec.requirements.map(x => x.id);
                    let plan: unknown, tasks: Task[] | undefined, lastPlanError = '';
                    // Custom has no implicit correction/retry policy. Its saved failure
                    // must be reviewed before another paid role dispatch is authorized.
                    // A rejected plan is a pure shape defect: nothing was written and no task ran. Custom used
                    // to get exactly one dispatch, so a single drifted dependsOn/requirementIds set killed the run
                    // with PLAN_PROJECT_TASK_CHANGED and no way to correct it. One bounded correction is allowed
                    // here for the same reason classic gets it; anything that touches the workspace stays fatal.
                    const planningAttempts=2;
                    for (let attempt = 0; attempt < planningAttempts; attempt++) {
                        const retryPrompt = planPrompt + String.fromCharCode(10, 10)
                            + (r.flowName==='custom'
                                ? 'Your previous submission was REJECTED (' + String(lastPlanError) + '). Call submit_engineering_plan exactly once with ONE corrected plan object and non-empty writePaths for every task. Do not return prose or Markdown.'
                                : 'Your previous answer was REJECTED (' + String(lastPlanError) + '). Reply with ONE JSON object and nothing else — no prose, no markdown fences, no tool calls — covering every one of the ' + spec.requirements.length + ' requirement ids above.');
                        let output: unknown;
                        try { output = await this.role(r, 'planner2', attempt === 0 ? planPrompt : retryPrompt, signal); }
                        // Both refusals below are shape defects with no side effect: the data-only guard
                        // stopped a non-message item before any write, and a non-JSON answer changed nothing.
                        // The planner keeps its conversation, so one named correction is the same bounded
                        // correction already used for PLAN_*; anything else (a written workspace, cancellation,
                        // a transport fault) stays fatal on the first occurrence.
                        catch (error) { if (attempt + 1 >= planningAttempts || !(error instanceof DomainError) || !['AGENT_STRUCTURED_OUTPUT_INVALID', 'CODEX_UNEXPECTED_TOOL'].includes(error.code)) throw error; lastPlanError = error.code; continue; }
                        if (before !== treeHash(r.workspace))
                            throw new DomainError('PLANNER_WROTE_SOURCE', 409);
                        plan = r.mode === 'demo' ? { controllerDemoTemplate:true, tasks: [{ id: 'T1', title: '生成固定学习任务板样例', dependsOn: [], requirementIds: spec.requirements.map(x => x.id), acceptance: spec.acceptance,writePaths:['index.html','style.css','board.mjs','app.mjs','README.md'] }, { id: 'T2', title: '装配样例界面与本地存储', dependsOn: ['T1'], requirementIds: spec.requirements.map(x=>x.id), acceptance: ['验证添加、完成、删除和恢复'],writePaths:['index.html','style.css','board.mjs','app.mjs','README.md'] }] } : output;
                        // The frozen project plan is produced by the Seeker planning contract and uses its own
                        // requirement id space (S001..), so its edges cannot be validated against spec.requirements.
                        // It stays a reference in the prompt; the run's plan is validated on its own terms: every
                        // spec requirement covered, no cycles, no dangling references.
                        try { tasks = validatePlan(plan, requirementIds); break; }
                        catch (error) {
                            // Only shape refusals are retried; anything else (a written workspace, a cancelf) is final.
                            if (attempt + 1 >= planningAttempts || !(error instanceof DomainError) || !String(error.code).startsWith('PLAN_')) throw error;
                            lastPlanError = error.code;
                        }
                    }
                    if (!tasks) throw new DomainError('PLAN_SCHEMA_INVALID', 502);
                    if (!Array.isArray(tasks) || tasks.length === 0) {
                        process.stderr.write('PLAN_TASKS_EMPTY '+JSON.stringify({runId:r.id,keys:Object.keys(plan||{}).slice(0,12)})+'\n');
                        throw new DomainError('PLAN_TASKS_EMPTY', 502);
                    }
                    this.store.record('SourceSnapshot',r.projectId,r.id,captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'BASELINE'));
                    this.store.record('Plan', r.projectId, r.id, { plan, stepId, specHash: r.specHash });
                    for (const task of tasks)
                        this.store.record('Task', r.projectId, r.id, task);
                    this.advance(rid, 'IMPLEMENTING', x => { x.tasks = tasks; x.plan = plan; x.treeHash = before; });
                    installPrework(this.store,rid);
                }
                else if (r.phase === 'IMPLEMENTING' || r.phase === 'REPAIRING') {
                    if(!r.prework&&Array.isArray(r.tasks)&&r.tasks.length>0){
                        try{installPrework(this.store,rid);process.stderr.write('PREWORK_BACKFILL '+JSON.stringify({runId:rid,tasks:r.tasks.length})+'\n');Object.assign(r,this.store.run(rid));}
                        catch(e){process.stderr.write('PREWORK_BACKFILL_FAILED '+JSON.stringify({runId:rid,reason:e instanceof DomainError?e.code:String(e).slice(0,80)})+'\n');}
                    }
                    const documentation=r.documentationContinuation?documentationRuntimeEvidence(this.store,r):null;
                    if(documentation){
                        if(r.phase!=='IMPLEMENTING')throw new DomainError('DOCUMENTATION_CONTINUATION_STATE_INVALID',409);
                        const runnable=selectExecutorWave(r.tasks);
                        const pending=this.executorSlices.pending(rid);
                        const pendingBound=!pending||(
                            pending.assignments.length===1&&
                            pending.assignments[0].taskId===documentation.approval.taskId&&
                            hash(pending.assignments[0].writePaths)===hash(documentation.approval.writePaths)&&
                            pending.sourceHash===r.treeHash
                        );
                        if(!pendingBound||runnable.length!==1||runnable[0].id!==documentation.approval.taskId)
                            throw new DomainError('DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED',409);
                    }
                    if(r.phase==='IMPLEMENTING'&&!(r.mode==='demo'&&object(r.plan??{}).controllerDemoTemplate===true)&&(this.executorSlices.pending(rid)||selectExecutorWave(r.tasks).length)){
                        const source=r.treeHash;
                        this.store.record('SourceSnapshot',r.projectId,rid,captureSource(r.workspace,{runId:rid,specHash:r.specHash},'EXECUTOR_BEFORE'));
                        await executeExecutorWave({store:this.store,slices:this.executorSlices,runId:rid,signal,
                            turn:async(assignment,turnSignal)=>{
                                const current=this.store.run(rid),task=current.tasks.find(t=>t.id===assignment.taskId)!;
                                let acceptance:unknown=null;try{const plan=this.nativeFactory().verifierPlan?.(current.projectId,current.specHash);acceptance=acceptanceCommands(plan?.plan);}catch{/* Existing verifier still owns full-tree admission. */}
                                const boundedRecovery=current.phase==='IMPLEMENTING'&&
                                    (current.boundedCodeVerificationRecovery!==undefined||current.boundedCodeReviewRecovery!==undefined);
                                const repairDiagnostics=current.phase==='REPAIRING'||boundedRecovery?buildRepairDiagnostics(this.store,current,spec):null;
                                // This is the prompt the wave executor actually sends. Measured on an eleven-requirement
                                // spec: spec.masterPrompt plus the whole plan made the first request about 62 KB, DeepSeek
                                // answered 400 before any tool call, and the slice recorded RUNNER_RPC_ERROR with no file
                                // written. Send the task's own requirement in full and the rest bounded.
                                const taskRequirementIds=new Set<string>(Array.isArray((task as {requirementIds?:string[]}|null)?.requirementIds)?(task as {requirementIds:string[]}).requirementIds:[]);
                                const boundedText=(value:unknown,limit:number)=>{const s=typeof value==='string'?value:'';return s.length<=limit?s:s.slice(0,limit)+'…';};
                                const waveSpecView={hash:spec.hash,requirements:(spec.requirements??[]).map(r=>({id:r.id,text:boundedText(r.text,taskRequirementIds.has(r.id)?4000:300)})),acceptance:(spec.acceptanceItems??[]).map(a=>({id:a.id,criterion:boundedText(a.criterion,300)}))};
                                const wavePlanView={planVersionId:(current.plan as {versionId?:string}|null)?.versionId,tasks:((current.plan as {tasks?:{id:string;title?:string;status?:string;dependsOn?:string[]}[]}|null)?.tasks??[]).map(t=>({id:t.id,title:t.title,status:t.status,dependsOn:t.dependsOn}))};
                                const verifierCases=this.verifierCasesFor(current.specHash);
                                const prompt=readFileSync(resolve(this.root,'prompts/executor.md'),'utf8')+roleSkillBlock(this.root,this.store,current.projectId,'executor')+'\n'+JSON.stringify({spec:waveSpecView,plan:wavePlanView,currentTask:task,...(verifierCases?{verifierCases}:{}),findings:current.findings,repairCount:current.repairCount,acceptanceCommands:acceptance,repairDiagnostics,
                                    instruction:boundedRecovery?'Repair this task using the original verifier diagnostics, preserving all frozen requirements. Write only the declared writePaths. Other task copies are private. This result is not verified until combined verification and independent review.':'Implement only this task in its independent source copy. Write only the declared writePaths. Other task copies are private. This result is not verified until combined verification and independent review.'});
                                return this.role(current,'executor',prompt,turnSignal,assignment.taskId,assignment.id);
                            },
                            gate:current=>{this.assertCurrent(current);if(this.pausing||current.state==='PAUSE_REQUESTED')throw new DomainError('DISPATCH_PAUSED',409);if(current.treeHash!==source)throw new DomainError('EXECUTOR_SOURCE_CHANGED',409);},
                            commit:(current,sourceHash,taskIds)=>{
                                // A task is implemented only when the files its plan declares actually exist. The executor
                                // model has reported completion after four writes for seventeen declared files; believing that
                                // let a delivery reach REVIEWING without its entry file, where the verifier can only answer
                                // SANDBOX_ENTRY_MISSING and the review packet then rejects the whole run as unprovable.
                                const present=new Set(files(current.workspace).map(f=>f.path));
                                const missing=[...new Set(current.tasks.filter(t=>taskIds.includes(t.id)).flatMap(t=>Array.isArray(t.writePaths)?t.writePaths:[]).filter(p=>!present.has(p)))];
                                if(missing.length)throw new DomainError('EXECUTOR_DECLARED_FILES_MISSING',409,'missing '+missing.slice(0,8).join(', '));
                                current.treeHash=sourceHash;current.verification=null;current.review=null;current.tasks=current.tasks.map(t=>taskIds.includes(t.id)?{...t,status:'implemented'}:t);current.phase=current.tasks.some(t=>t.status==='pending')?'IMPLEMENTING':'VERIFYING';current.state=current.phase;}
                        });
                        if(documentation)assertDocumentationProtectedFiles(this.store,this.store.run(rid));
                        this.store.record('SourceSnapshot',r.projectId,rid,captureSource(r.workspace,{runId:rid,specHash:r.specHash},'EXECUTOR_AFTER'));
                        continue;
                    }
                    const task = r.phase === 'IMPLEMENTING' ? r.tasks.find(t => t.status === 'pending' && t.dependsOn.every(dep => r.tasks.some(x => x.id === dep && ['implemented', 'done'].includes(x.status)))) : null;
                    if (r.phase === 'IMPLEMENTING' && !task)
                        throw new DomainError('NO_RUNNABLE_TASK', 409);
                    // The verifier will run the approved acceptance commands VERBATIM. Handing the executor those
                    // argv lines (never their expected output) ended a loop where two runs in a row built a CLI
                    // that answered ERROR BAD_ARGS to every case: the flags were in the spec, the model just
                    // guessed a different spelling. It also cannot help hardcoding, because the expected text
                    // is not included.
                    const acceptance = (() => {
                        try {
                            const factory = this.nativeFactory();
                            const getter = factory.verifierPlan;
                            if (!getter) return null;
                            const planned = getter.call(factory, r.projectId, r.specHash);
                            return acceptanceCommands(planned?.plan);
                        } catch { return null; }
                    })();
                    const repairDiagnostics=r.phase==='REPAIRING'||
                        r.phase==='IMPLEMENTING'&&
                        (r.boundedCodeVerificationRecovery!==undefined||r.boundedCodeReviewRecovery!==undefined)
                        ?buildRepairDiagnostics(this.store,r,spec):null;
                    // The whole plan used to travel with every task, which pushed the first executor request of a
                    // larger spec to roughly 62 KB: DeepSeek answered 400 before any tool call, the slice recorded
                    // RUNNER_RPC_ERROR, and no file was ever written. The turn only needs the current task plus the
                    // dependency graph, so the rest of the plan is sent as ids, titles and dependencies.
                    const planOutline = { planVersionId: (r.plan as { versionId?: string } | undefined)?.versionId,
                        tasks: ((r.plan as { tasks?: { id: string; title?: string; status?: string; dependsOn?: string[] }[] } | undefined)?.tasks ?? [])
                            .map(t => ({ id: t.id, title: t.title, status: t.status, dependsOn: t.dependsOn })) };
                    // spec.masterPrompt is a rendered duplicate of the same requirements and acceptance items, and on an
                    // eleven-requirement spec it alone pushed the request past what the route accepts. Send the structured
                    // spec instead: same decisions, roughly half the bytes.
                    // Measured on an eleven-requirement spec: the full requirement texts alone were 31.9 KB of a 56.9 KB
                    // task payload, and the request was refused with 400 before any tool call. The executor needs the current
                    // task's requirement in full and the rest as identifiers, so each text is bounded here.
                    const currentRequirementIds = new Set<string>(Array.isArray((task as { requirementIds?: string[] } | null | undefined)?.requirementIds) ? (task as { requirementIds: string[] }).requirementIds : []);
                    const bounded = (value: unknown, limit: number) => { const s = typeof value === 'string' ? value : ''; return s.length <= limit ? s : s.slice(0, limit) + '…'; };
                    const specView = { hash: spec.hash,
                        requirements: (spec.requirements ?? []).map(r => ({ id: r.id, text: bounded(r.text, currentRequirementIds.has(r.id) ? 4000 : 300) })),
                        acceptance: (spec.acceptanceItems ?? []).map(a => ({ id: a.id, criterion: bounded(a.criterion, 300) })) };
                    const prompt = readFileSync(resolve(this.root, 'prompts/executor.md'), 'utf8') + roleSkillBlock(this.root, this.store, r.projectId, 'executor') + '\n' + JSON.stringify({ spec: specView, plan: planOutline, currentTask: task, findings: r.findings, repairCount: r.repairCount, acceptanceCommands: acceptance,repairDiagnostics, instruction: task ? 'Implement only the current task. Implemented is not yet verified.' : 'Repair the reported findings using the original verifier diagnostics when supplied, preserving all frozen requirements.' });
                    this.store.record('SourceSnapshot',r.projectId,r.id,captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'EXECUTOR_BEFORE'));
                    if(task){this.update(r.id,'task.started',run=>{run.tasks=run.tasks.map(t=>t.id===task.id?{...t,status:'running'}:t);});
                        process.stderr.write('REPAIR_TASK_STARTED '+JSON.stringify({taskId:task.id})+'\n');}
                    const repairSlice=this.executorSlices.pending(r.id)?.assignments.find(item=>item.taskId===task?.id)?.id;
            process.stderr.write('REPAIR_SLICE_BOUND '+JSON.stringify({taskId:task?.id??null,sliceId:repairSlice??null})+'\n');
            await this.role(r, 'executor', prompt, signal,task?.id,repairSlice);
                    if (signal.aborted)
                        throw new DomainError('RUN_CANCELLED', 409);
                    if (r.mode === 'demo')
                        buildDemo(this.root, r.workspace, r.demoFault && r.repairCount === 0);
                    const tree = treeHash(r.workspace);
                    this.store.record('SourceSnapshot',r.projectId,r.id,captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'EXECUTOR_AFTER'));
                    const next = task && r.tasks.some(t => t.id !== task.id && t.status === 'pending') ? 'IMPLEMENTING' : 'VERIFYING';
                    this.advance(rid, next, x => { x.treeHash = tree; x.verification = null; x.review = null; if (task)
                        x.tasks = x.tasks.map(t => t.id === task.id ? { ...t, status: 'implemented' } : t); });
                }
                else if (r.phase === 'VERIFYING') {
                    const before = treeHash(r.workspace);
                    this.store.record('SourceSnapshot',r.projectId,r.id,captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'VERIFIER_INPUT'));
                    let output: {
                        stdout: string;
                        stderr: string;
                        code: number | null;
                    };
                    let command: string[];
                    if (r.mode === 'demo') {
                        command = [process.execPath, resolve(this.root, 'scripts/verify-board.mjs'), r.workspace];
                        output = await this.dispatch.run({projectId:r.projectId,runId:r.id,kind:'verifier',mode:r.mode,signal},control=>capture(command[0], command.slice(1), { cwd: r.workspace, signal, timeoutMs: 15000, env: childEnv(),onCleanup:control.confirmCleanup }));
                    }
                    else {
                        // A missing declared entry is a determinate pre-spawn refusal: nothing ran and nothing changed, and
                        // it is precisely the defect repair exists to fix. It used to escape as a 409 and block the run at
                        // VERIFYING with a delivery the executor had already marked implemented.
                        let out: Record<string, unknown>;
                        try {
                            out = await this.dispatch.run({projectId:r.projectId,runId:r.id,kind:'verifier',mode:r.mode,signal},control=>this.verifyOwned({ role: 'executor', workspace: r.workspace, prompt: JSON.stringify({ spec, plan: r.plan }), model: r.flowConfig?.mode==='custom'?customRoleConfiguration(r.flowConfig,'executor',r.flowConfig.roles.executors[0].id).model.id:this.config().dsh.model, specHash: r.specHash, runId: r.id, laya: { role: 'executor', mode: 'off', adoption: 'off', label: null, reason: 'DETERMINISTIC_VERIFICATION', latencyMs: 0, inputHash: '', modelRevision: null, confidence: null, cached: false }, signal }, e => this.store.event(r.projectId, r.id, 'verify.event', JSON.parse(redact(e))),control));
                        } catch (error) {
                            if (!(error instanceof DomainError) || error.code !== 'SANDBOX_ENTRY_MISSING') throw error;
                            // Nothing ran, so there is no evidence and none may be invented: fabricated material reached
                            // REVIEWING and the packet rejected the run as unprovable. The executor-side guard now stops
                            // this shape earlier; if it still appears, name the real condition.
                            throw new DomainError('DELIVERY_ENTRY_MISSING', 409, 'the declared entry file is absent from the delivery');
                        }
                        if (!Array.isArray(out.command) || typeof out.stdout !== 'string' || typeof out.stderr !== 'string' || typeof out.exitCode !== 'number')
                            throw new DomainError('VERIFIER_SCHEMA_INVALID', 502);
                        output = { stdout: out.stdout, stderr: out.stderr, code: out.exitCode };
                        command = (out.command as unknown[]).map((x: unknown) => text(x, 2000));
                    }
                    if (before !== treeHash(r.workspace))
                        throw new DomainError('VERIFIER_MUTATED_SOURCE', 409);
                    const evidence = { stepId, attempt: r.attempt, specHash: r.specHash, treeHash: before, command, ...output, at: now(), scope: r.mode === 'demo' ? 'DEMO_TEMPLATE_ONLY' : 'LIVE_VERIFIER' };
                    if(hasSecret(JSON.stringify(evidence)))throw new DomainError('REVIEW_SECRET_IN_MATERIAL',403);
                    const evidenceId = this.store.record('Evidence', r.projectId, r.id, evidence);
                    this.update(rid, 'verification.completed', x => { x.verification = { ok: output.code === 0, exitCode: output.code, stdout: redact(output.stdout), stderr: redact(output.stderr), command, treeHash: before, at: now(), evidenceId }; });
                    if (output.code === 0)
                        this.advance(rid, 'REVIEWING');
                    else {
                        this.update(rid, 'finding.created', x => { x.findings.push({ id: id('finding'), severity: 'high', description: '确定性验证失败，必须修复后重测。', evidence: evidenceId, status: 'open' }); });
                        this.repair(rid, `VERIFIER_EXIT_${output.code}: ${output.stderr.slice(-2000)}`, true);
                    }
                }
                else if (r.phase === 'REVIEWING') {
                    const before = treeHash(r.workspace), packet=buildReviewPacket(this.store,r,spec);
                    const packetId=this.store.record('ReviewPacket',r.projectId,r.id,{sha256:hash(packet),packet});
                    // The reviewer prompt must stay one JSON document: the controller
                    // appends its session/packet admission only when it can parse the
                    // whole payload. All closeout instructions already travel inside
                    // packet.prework.closeoutPolicy.
                    // A tool-based reviewer and a plain-JSON reviewer need different
                    // instructions. DSH submits through its terminal tool; the Kimi
                    // reviewer has no tool channel and must answer with the object.
                    const customReviewerRuntime=r.flowName==='custom'&&r.flowConfig?.mode==='custom'?customRoleConfiguration(r.flowConfig,'reviewer').runtime:undefined;
                    const reviewPrompt=JSON.stringify(packet)
                        + (r.flowName!=='custom'?'':customReviewerRuntime==='dsh'
                            ?'\n\nCUSTOM TERMINAL TOOL: Call submit_review exactly once with the complete final review object. Put the verdict and findings in the tool arguments, not in assistant prose. A prose-only answer, Markdown answer or second submission is invalid and will block the run.'
                            :'\n\nCUSTOM REVIEW OUTPUT: Answer with exactly one JSON object and nothing else. Shape: {"verdict":"PASS"|"CHANGES_REQUESTED"|"BLOCKED","findings":[{"id":"f1","severity":"critical"|"high"|"medium"|"low","description":"...","evidence":"..."}]}. A PASS must carry an empty findings array. When the packet requires prework coverage, add the preworkCoverage array exactly as its closeout policy describes. No Markdown fences and no commentary outside the JSON.');
                    const output = await this.role(r, 'reviewer', reviewPrompt, signal);
                    if (before !== treeHash(r.workspace))
                        throw new DomainError('REVIEWER_WROTE_SOURCE', 409);
                    const review = validateReview(r.mode === 'demo' ? { verdict: r.verification?.ok ? 'PASS' : 'BLOCKED', findings: [] } : output, completedReviewSource(this.store.run(rid),this.config()), before);
                    this.store.record('Review', r.projectId, r.id, { ...review, stepId, packetId,packetHash:hash(packet) });
                    this.update(rid, 'review.completed', x => { x.review = review; x.findings = x.findings.map(f => ({ ...f, status: review.verdict === 'PASS' ? 'resolved' : f.status })); x.findings.push(...review.findings); });
                    if (review.verdict === 'PASS') {
                        // Re-check the run-level commit preconditions with values read now, not earlier.
                        assertRunDeliveryAllowed({
                            leaseHeld: this.store.owns(r.projectId, r.id),
                            cancelled: this.store.run(rid).state === 'CANCEL_REQUESTED',
                            treeHashStable: r.treeHash === treeHash(r.workspace)
                        });
                        this.advance(rid, 'READY_FOR_DELIVERY', x => { x.tasks = x.tasks.map(t => ({ ...t, status: 'done' })); x.reason = null; x.artifacts = files(x.workspace).map(f => f.path);
                            // Inherited role completion requires done tasks. Publish closeout
                            // inside the same transaction; a failed gate rolls delivery back.
                            savePreworkCloseout(this.store,x,this.config(),output,packetId);
                        });
                    }
                    else if (review.verdict === 'BLOCKED') {
                        this.blockAndRelease(rid, 'run.blocked', 'REVIEW_BLOCKED');
                    }
                    else
                        this.repair(rid, JSON.stringify(review.findings), true);
                    // Reviewer -> Seeker: the settled verdict is handed back together with its exact
                    // binding (run, spec, plan version, workspace, review record hash). Nothing is
                    // accepted here and no new interview is opened; Seeker interprets on request.
                    recordSeekerHandoff(this.store, this.store.run(rid));
                }
                else
                    return;
            }
        }
        catch (e) {
            if (e instanceof DomainError && e.code === 'PROCESS_CLEANUP_UNPROVEN')
                this.update(rid, 'run.cleanup.unproven', r => { r.state = 'BLOCKED'; r.reason = 'PROCESS_CLEANUP_UNPROVEN'; });
            else if (signal.aborted && signal.reason instanceof DomainError && signal.reason.code === 'RUN_WALL_TIME_BUDGET_EXCEEDED')
                this.update(rid, 'run.budget.blocked', r => { r.state = 'BLOCKED'; r.reason = 'RUN_WALL_TIME_BUDGET_EXCEEDED'; });
            else if (signal.aborted || this.store.run(rid).state === 'CANCEL_REQUESTED')
                this.finalCancel(rid);
            else if(e instanceof DomainError&&e.code==='DISPATCH_PAUSED')this.update(rid,'run.paused',r=>{r.state='PAUSED';});
            // A runner RPC failure is a HOST/transport fault, not a verdict about the work: the child that
            // carries the executor can die mid-turn (observed as a libuv assertion on Windows). Discarding the
            // whole run for that is wasteful, so it is retried through the normal repair budget, which still
            // bounds it (same reason twice, or the repair ceiling, becomes BLOCKED).
            else if (!this.pausing && !this.store.run(rid).reviewSupplement && !this.store.run(rid).documentationContinuation && this.store.run(rid).flowName!=='custom' && e instanceof DomainError && ['RUNNER_RPC_ERROR','EXECUTOR_DECLARED_FILES_MISSING','DELIVERY_ENTRY_MISSING'].includes(e.code) && this.store.run(rid).repairCount < this.store.run(rid).maxRepairs) {
                // A delivery that is missing the files its plan declares is repairable work, not a verdict: send it back
                // with the named gap so the executor writes what is actually missing instead of stopping the run.
                this.repair(rid, e.code);
                // Keep the same owned job, route and cancellation signal. launch()
                // deliberately refuses this Run while its original job still exists.
                if (this.store.run(rid).state === 'REPAIRING') await this.loop(rid, signal);
            }
            else
                this.update(rid, 'run.blocked', r => { r.state = 'BLOCKED'; r.reason = e instanceof DomainError ? e.code : redact(String(e)); });
        }
    }
    pause(rid: string) { const r = this.store.run(rid); if (TERMINAL.includes(r.state) || ['BLOCKED', 'READY_FOR_DELIVERY', 'PAUSED'].includes(r.state))
        throw new DomainError('RUN_NOT_PAUSABLE', 409); return this.update(rid, 'run.pause.requested', x => { x.state = 'PAUSE_REQUESTED'; }); }
    /** One explicit recovery of local pre-turn preparation only. Never reopens a
     * model verdict, changes source/tasks/counters, launches a role or grants acceptance. */
    documentationCorrectionCandidate(rid:string,path:string){
        const r=this.store.run(rid);this.assertBinding(r);this.unchanged(r);
        if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
        const candidate=documentationCorrectionCandidate(this.store,rid,path);this.unchanged(this.store.run(rid));return candidate;
    }
    async prepareDocumentationCorrection(rid:string,input:DocumentationCustodyRequest,actor:string):Promise<DocumentationCustodyPrepared>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('DOCUMENTATION_CUSTODY_CONFIRMATION_REQUIRED',403);
        if(Object.keys(input).some(k=>!['confirmed','file','candidateHash'].includes(k))||typeof request.file!=='string'||typeof request.candidateHash!=='string'||!/^[a-f0-9]{64}$/.test(request.candidateHash))throw new DomainError('DOCUMENTATION_CUSTODY_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const r=this.store.run(rid);
        if(this.activeRunIds().some(id=>this.store.run(id).projectId===r.projectId))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const controller=new AbortController();this.reviewInspectionControllers.set(rid,controller);
        const check=()=>{if(controller.signal.aborted)throw new DomainError('RUN_CANCELLED',409);if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);const c=this.documentationCorrectionCandidate(rid,request.file);if(c.candidateHash!==request.candidateHash)throw new DomainError('DOCUMENTATION_CUSTODY_CHANGED',409);return c;};
        const work=Promise.resolve().then(async()=>{
            const candidate=check(),deferred:any[]=[];
            const proof=await inspectDispatchOwnership(this.store,this.root,this.config(),r.projectId,rid,candidate.reviewDispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute),obs=>deferred.push(obs));
            check();
            // Candidate requires already durable cleanup for each process, so this copy-only path
            // must not rely on a new recovered/uncertain process observation or grant new authority.
            if(deferred.length)throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
            return prepareDocumentationCustody(this.store,this.data,candidate,actor,proof,check,(bytes,nodes)=>this.executorSlices.reserveRecovery(bytes,nodes));
        }).finally(()=>{this.reviewPreparations.delete(rid);this.reviewInspectionControllers.delete(rid);});
        this.reviewPreparations.set(rid,work);return work;
    }
    async approveDocumentationContinuation(rid:string,input:DocumentationContinuationRequest,actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('DOCUMENTATION_CONTINUATION_CONFIRMATION_REQUIRED',403);
        if(Object.keys(input).some(k=>!['confirmed','file','candidateHash','taskDeadline'].includes(k))||request.taskDeadline!==null||typeof request.file!=='string'||typeof request.candidateHash!=='string'||!/^[a-f0-9]{64}$/.test(request.candidateHash))throw new DomainError('DOCUMENTATION_CONTINUATION_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const replay=documentationContinuationReplay(this.store,rid,request);if(replay){this.assertBinding(replay);this.unchanged(replay);return replay;}
        const custody=await this.prepareDocumentationCorrection(rid,{confirmed:true,file:request.file,candidateHash:request.candidateHash},actor);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const check=()=>{if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);const c=this.documentationCorrectionCandidate(rid,request.file);if(c.candidateHash!==request.candidateHash)throw new DomainError('DOCUMENTATION_CONTINUATION_CHANGED',409);return c;};
        const candidate=check();
        return prepareDocumentationContinuation(this.store,this.data,this.config(),candidate,custody,request,actor,check,(bytes,nodes)=>this.executorSlices.reserveRecovery(bytes,nodes),child=>this.seedContinuationPrework(child));
    }
    boundedCodeRepairCandidate(rid:string,path:string){
        const r=this.store.run(rid);this.assertBinding(r);this.unchanged(r);
        if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
        const candidate=boundedCodeRepairCandidate(this.store,rid,path);this.unchanged(this.store.run(rid));return candidate;
    }
    async registerBoundedCodeRepairAuthorization(rid:string,input:import('../shared/documentation-correction.js').DocumentationCustodyRequest&{
        ownerApproval:import('./documentation-correction.js').OwnerBoundedCodeRepairApproval;
    },actor:string){
        const r=this.store.run(rid);this.assertBinding(r);this.unchanged(r);
        if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
        const result=await registerBoundedCodeRepairAuthorization(this.store,rid,input as import('./documentation-correction.js').BoundedCodeRepairAuthorizationRequest,actor);
        this.unchanged(this.store.run(rid));return result;
    }
    async prepareBoundedCodeRepair(rid:string,input:DocumentationCustodyRequest,actor:string):Promise<DocumentationCustodyPrepared>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('BOUNDED_CODE_REPAIR_CONFIRMATION_REQUIRED',403);
        if(Object.keys(input).some(k=>!['confirmed','file','candidateHash'].includes(k))||request.file!=='main.mjs'||typeof request.candidateHash!=='string'||!/^[a-f0-9]{64}$/.test(request.candidateHash))throw new DomainError('BOUNDED_CODE_REPAIR_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const r=this.store.run(rid);
        if(this.activeRunIds().some(id=>this.store.run(id).projectId===r.projectId))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const controller=new AbortController();this.reviewInspectionControllers.set(rid,controller);
        const check=()=>{if(controller.signal.aborted)throw new DomainError('RUN_CANCELLED',409);if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);const c=this.boundedCodeRepairCandidate(rid,request.file);if(c.candidateHash!==request.candidateHash)throw new DomainError('BOUNDED_CODE_REPAIR_CHANGED',409);return c;};
        const work=Promise.resolve().then(async()=>{
            const candidate=check(),deferred:any[]=[];
            const proof=await inspectDispatchOwnership(this.store,this.root,this.config(),r.projectId,rid,candidate.reviewDispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute),obs=>deferred.push(obs));
            check();
            if(deferred.length)throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
            return prepareDocumentationCustody(this.store,this.data,candidate,actor,proof,check,(bytes,nodes)=>this.executorSlices.reserveRecovery(bytes,nodes));
        }).finally(()=>{this.reviewPreparations.delete(rid);this.reviewInspectionControllers.delete(rid);});
        this.reviewPreparations.set(rid,work);return work;
    }
    async approveBoundedCodeRepair(rid:string,input:DocumentationContinuationRequest,actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('BOUNDED_CODE_REPAIR_CONFIRMATION_REQUIRED',403);
        if(request.file!=='main.mjs'||request.taskDeadline!==null||Object.keys(input).some(k=>!['confirmed','file','candidateHash','taskDeadline'].includes(k))||typeof request.candidateHash!=='string'||!/^[a-f0-9]{64}$/.test(request.candidateHash))throw new DomainError('BOUNDED_CODE_REPAIR_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const replay=documentationContinuationReplay(this.store,rid,request);if(replay){const approval=documentationContinuationEvidence(this.store,replay);if(!approval||approval.repairKind!=='CODE')throw new DomainError('BOUNDED_CODE_REPAIR_CHANGED',409);this.assertBinding(replay);this.unchanged(replay);return replay;}
        const custody=await this.prepareBoundedCodeRepair(rid,{confirmed:true,file:request.file,candidateHash:request.candidateHash},actor);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const check=()=>{if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);const c=this.boundedCodeRepairCandidate(rid,request.file);if(c.candidateHash!==request.candidateHash)throw new DomainError('BOUNDED_CODE_REPAIR_CHANGED',409);return c;};
        const candidate=check();
        return prepareDocumentationContinuation(this.store,this.data,this.config(),candidate,custody,request,actor,check,(bytes,nodes)=>this.executorSlices.reserveRecovery(bytes,nodes),child=>this.seedContinuationPrework(child));
    }
    private seedContinuationPrework(child:Run){
        this.store.record('SourceSnapshot',child.projectId,child.id,captureSource(child.workspace,{runId:child.id,specHash:child.specHash},'BASELINE'));
        installPrework(this.store,child.id);Object.assign(child,this.store.run(child.id));
    }
    async extendDocumentationContinuation(rid:string,input:DocumentationContinuationCallExtensionRequest,actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('DOCUMENTATION_CALL_EXTENSION_CONFIRMATION_REQUIRED',403);
        const fields=['confirmed','expectedVersion','approvalRecordId','approvalHash','ownerDecisionHash'];
        if(Object.keys(input).some(key=>!fields.includes(key))||Object.keys(input).length!==fields.length||
            !Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||
            typeof request.approvalRecordId!=='string'||!request.approvalRecordId||
            typeof request.approvalHash!=='string'||!/^[a-f0-9]{64}$/.test(request.approvalHash)||
            typeof request.ownerDecisionHash!=='string'||!/^[a-f0-9]{64}$/.test(request.ownerDecisionHash))
            throw new DomainError('DOCUMENTATION_CALL_EXTENSION_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const r=this.store.run(rid);
        if(this.activeRunIds().some(id=>this.store.run(id).projectId===r.projectId)||this.reviewPreparations.has(rid)||
            this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))
            throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        this.assertBinding(r);
        return extendDocumentationContinuationCall(this.store,rid,request,actor);
    }
    async recoverBoundedCodeVerificationFailure(rid:string,input:BoundedCodeVerificationRecoveryRequest,actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))
            throw new DomainError('BOUNDED_CODE_REPAIR_RECOVERY_CONFIRMATION_REQUIRED',403);
        const fields=['confirmed','expectedVersion','sourceHash','verificationEvidenceId','ownerDecisionHash'];
        if(Object.keys(input).some(key=>!fields.includes(key))||Object.keys(input).length!==fields.length||
            !Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||
            typeof request.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(request.sourceHash)||
            typeof request.verificationEvidenceId!=='string'||!request.verificationEvidenceId||
            typeof request.ownerDecisionHash!=='string'||!/^[a-f0-9]{64}$/.test(request.ownerDecisionHash))
            throw new DomainError('BOUNDED_CODE_REPAIR_RECOVERY_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const r=this.store.run(rid);
        if(this.activeRunIds().some(id=>this.store.run(id).projectId===r.projectId)||this.reviewPreparations.has(rid)||
            this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))
            throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        this.assertBinding(r);this.unchanged(r);
        const result=await recoverBoundedCodeVerificationFailure(this.store,rid,request,actor);
        this.unchanged(this.store.run(rid));
        return result;
    }
    async recoverBoundedCodeReviewUsage(rid:string,input:BoundedCodeReviewRecoveryRequest,actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))
            throw new DomainError('BOUNDED_CODE_REVIEW_RECOVERY_CONFIRMATION_REQUIRED',403);
        const fields=['confirmed','expectedVersion','sourceHash','verificationEvidenceId','reviewPacketId','ownerDecisionHash'];
        if(Object.keys(input).some(key=>!fields.includes(key))||Object.keys(input).length!==fields.length||
            !Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||
            typeof request.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(request.sourceHash)||
            typeof request.verificationEvidenceId!=='string'||!request.verificationEvidenceId||
            typeof request.reviewPacketId!=='string'||!request.reviewPacketId||
            typeof request.ownerDecisionHash!=='string'||!/^[a-f0-9]{64}$/.test(request.ownerDecisionHash))
            throw new DomainError('BOUNDED_CODE_REVIEW_RECOVERY_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const r=this.store.run(rid);
        if(this.activeRunIds().some(id=>this.store.run(id).projectId===r.projectId)||this.reviewPreparations.has(rid)||
            this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))
            throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        this.assertBinding(r);this.unchanged(r);
        const result=await recoverBoundedCodeReviewUsage(this.store,rid,request,actor);
        this.unchanged(this.store.run(rid));
        return result;
    }
    reviewSupplementCandidate(rid:string){
        const run=this.store.run(rid);this.assertBinding(run);this.unchanged(run);
        const packet=buildReviewPacket(this.store,run,this.store.spec(run.specId)),basis=reviewSupplementBasis(this.store,run,packet);
        return {sourceHash:run.treeHash!,expectedVersion:run.version,packetHash:basis.packetHash,previousReviewRecordId:basis.previousReviewRecordId,additionalCalls:1,scope:'REVIEWER_ONLY_NO_REPAIR',modelDispatched:false};
    }
    async approveTaskDeadlineWaiver(rid:string,input:{confirmed:boolean;sourceHash:string;expectedVersion:number},actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))
            throw new DomainError('TASK_DEADLINE_WAIVER_CONFIRMATION_REQUIRED',403);
        if(Object.keys(input).some(k=>!['confirmed','sourceHash','expectedVersion'].includes(k))||
            !/^[a-f0-9]{64}$/.test(request.sourceHash)||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1)
            throw new DomainError('TASK_DEADLINE_WAIVER_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        if(this.reviewPreparations.has(rid)||this.activeRunIds().some(id=>this.store.run(id).projectId===this.store.run(rid).projectId))
            throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        return this.store.tx(()=>{
            const fresh=this.store.run(rid);
            if(fresh.taskDeadlineWaiver!==undefined){
                taskDeadlineWaiverEvidence(this.store,fresh);
                throw new DomainError('TASK_DEADLINE_WAIVER_ALREADY_PRESENT',409);
            }
            if(fresh.version!==request.expectedVersion||fresh.treeHash!==request.sourceHash||
                this.store.project(fresh.projectId).activeRunId!==rid)
                throw new DomainError('TASK_DEADLINE_WAIVER_CHANGED',409);
            if(fresh.mode!=='live'||(fresh.flowName!=='classic'&&fresh.flowName!=='custom')||fresh.flowConfig?.mode!==fresh.flowName||
                !fresh.planVersionHash||!fresh.flowConfigHash)
                throw new DomainError('TASK_DEADLINE_WAIVER_BINDING_INVALID',409);
            if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))
                throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
            this.assertCurrent(fresh);
            this.unchanged(fresh);
            return saveTaskDeadlineWaiver(this.store,fresh,actor);
        });
    }
    approveReviewSupplement(rid:string,input:{confirmed:boolean;sourceHash:string;expectedVersion:number;packetHash:string;previousReviewRecordId:string},actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('REVIEW_SUPPLEMENT_CONFIRMATION_REQUIRED',403);
        if(Object.keys(input).some(k=>!['confirmed','sourceHash','expectedVersion','packetHash','previousReviewRecordId'].includes(k))||
            !/^[a-f0-9]{64}$/.test(request.sourceHash)||!/^[a-f0-9]{64}$/.test(request.packetHash)||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||typeof request.previousReviewRecordId!=='string'||!request.previousReviewRecordId)throw new DomainError('REVIEW_SUPPLEMENT_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        if(this.reviewPreparations.has(rid)||this.activeRunIds().some(id=>this.store.run(id).projectId===this.store.run(rid).projectId))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const controller=new AbortController();this.reviewInspectionControllers.set(rid,controller);
        const work=Promise.resolve().then(async()=>{
            const check=()=>{if(controller.signal.aborted)throw new DomainError('RUN_CANCELLED',409);if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
                const r=this.store.run(rid);if(r.version!==request.expectedVersion||r.treeHash!==request.sourceHash||this.store.project(r.projectId).activeRunId!==rid||runUsesLaya(r))throw new DomainError('REVIEW_SUPPLEMENT_CHANGED',409);
                this.assertBinding(r);this.unchanged(r);const packet=buildReviewPacket(this.store,r,this.store.spec(r.specId)),basis=reviewSupplementBasis(this.store,r,packet);
                if(basis.packetHash!==request.packetHash||basis.previousReviewRecordId!==request.previousReviewRecordId)throw new DomainError('REVIEW_SUPPLEMENT_CHANGED',409);
                if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
                return {r,basis};};
            const {basis}=check(),deferred:any[]=[];
            const proof=await inspectDispatchOwnership(this.store,this.root,this.config(),this.store.run(rid).projectId,rid,basis.dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute),obs=>deferred.push(obs));
            return this.store.tx(()=>{const {r,basis:fresh}=check();if(fresh.basisHash!==basis.basisHash)throw new DomainError('REVIEW_SUPPLEMENT_CHANGED',409);
                this.store.acquire(r.projectId,rid);for(const obs of deferred)this.store.record('WindowsIntentRecoveryObservation',r.projectId,rid,obs);
                const approval={schema:'dream-maker.review-supplement.v1',runId:rid,projectId:r.projectId,specHash:r.specHash,planVersionHash:r.planVersionHash,flowConfigHash:r.flowConfigHash,configFingerprint:r.configFingerprint,
                    sourceHash:r.treeHash,calls:r.calls,maxCalls:r.maxCalls,repairCount:r.repairCount,maxRepairs:r.maxRepairs,originalCreatedAt:r.createdAt,originalMaxSeconds:r.maxSeconds,
                    ...basis,proof,at:now(),actorHash:hash(actor),additionalCalls:1,scope:'REVIEWER_ONLY_NO_REPAIR',confirmed:true,modelDispatched:false};
                const recordId=this.store.record('ReviewSupplementApproval',r.projectId,rid,approval);r.reviewSupplement={recordId,sha256:hash(approval)};
                const finalPacket=buildReviewPacket(this.store,r,this.store.spec(r.specId));assertReviewSupplementPacket(this.store,r,finalPacket);
                assertReviewTaskBodySafe({specHash:r.specHash,taskData:JSON.stringify(finalPacket),laya:null});
                // The future official thread ID is unknown: reserve the maximum valid ID length.
                if(this.config().codex.permissionProfile!=='dream-maker-supervisor-data')throw new DomainError('REVIEW_SUPPLEMENT_BINDING_INVALID',409);
                const boundThread='DM_PREFLIGHT_ONLY_'.padEnd(200,'x'),boundInput=reviewAdmissionPrompt({role:'reviewer',runId:rid,specHash:r.specHash,prompt:JSON.stringify({specHash:r.specHash,taskData:JSON.stringify(finalPacket),laya:null})},
                    {threadId:boundThread,model:this.config().codex.model,provider:'openai',permissionProfile:'dream-maker-supervisor-data',policyHash:String(approval.reviewPolicyHash),materialEncoding:'PACKET_OBJECT_V1'});
                expectedUserMessageFrameLimit(boundThread,boundInput.prompt);
                r.state='PAUSED';r.reason='REVIEW_SUPPLEMENT_PREPARED';this.store.saveRun(r);this.store.event(r.projectId,rid,'run.review-supplement.approved',{...r.reviewSupplement,additionalCalls:1,modelDispatched:false});return r;
            });
        }).finally(()=>{this.reviewPreparations.delete(rid);this.reviewInspectionControllers.delete(rid);});this.reviewPreparations.set(rid,work);return work;
    }
    approveReviewWindow(rid:string,input:{sourceHash:string;expectedVersion:number;seconds:number;confirmed:boolean},actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('REVIEW_WINDOW_CONFIRMATION_REQUIRED',403);
        if(!/^[a-f0-9]{64}$/.test(request.sourceHash)||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||
            !Number.isSafeInteger(request.seconds)||request.seconds<60||request.seconds>7200)throw new DomainError('REVIEW_WINDOW_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        if(this.reviewPreparations.has(rid)||this.activeRunIds().some(id=>this.store.run(id).projectId===this.store.run(rid).projectId))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const work=Promise.resolve().then(async()=>{
            const check=()=>{if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);const r=this.store.run(rid);
                if(r.version!==request.expectedVersion||r.treeHash!==request.sourceHash||r.reviewWindow!==undefined||
                    this.store.project(r.projectId).activeRunId!==rid||Date.now()<runDeadline(this.store,r)||
                    this.store.db.prepare("SELECT 1 FROM records WHERE project_id=? AND run_id=? AND kind='ReviewWindowApproval'").get(r.projectId,rid))
                    throw new DomainError('REVIEW_WINDOW_RECOVERY_NOT_ALLOWED',409);
                this.assertCurrent(r);this.unchanged(r);return r;
            };
            const run=check(),packet=buildReviewPacket(this.store,run,this.store.spec(run.specId)),packetHash=hash(packet);
            const basis=reviewPreparationBasis(this.store,run,packetHash,{expiredWindowApproval:true,allowPacketRebuild:true});
            if(!basis.preDispatch||!run.planVersionHash||!run.flowConfigHash)throw new DomainError('REVIEW_WINDOW_RECOVERY_NOT_ALLOWED',409);
            if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
            assertReviewTaskBodySafe({specHash:run.specHash,taskData:JSON.stringify(packet),laya:null});
            const proofs:Awaited<ReturnType<typeof inspectDispatchOwnership>>[]=[];
            const deferred:any[]=[];for(const dispatchId of basis.dispatchIds){check();proofs.push(await inspectDispatchOwnership(this.store,this.root,this.config(),run.projectId,rid,dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute),(obs)=>deferred.push(obs)));}
            const current=check(),after=reviewPreparationBasis(this.store,current,packetHash,{expiredWindowApproval:true,allowPacketRebuild:true});
            if(after.basisHash!==basis.basisHash||after.version!==basis.version||hash(buildReviewPacket(this.store,current,this.store.spec(current.specId)))!==packetHash)
                throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
            return this.store.tx(()=>{const fresh=check(),finalBasis=reviewPreparationBasis(this.store,fresh,packetHash,{expiredWindowApproval:true,allowPacketRebuild:true});
                if(finalBasis.basisHash!==basis.basisHash)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
                for(const obs of deferred)this.store.record('WindowsIntentRecoveryObservation',run.projectId,rid,obs);
                const proofBody={schema:'dream-maker.review-window-process-proofs.v1',runId:rid,proofs},proofId=this.store.record('ReviewWindowProcessProofs',fresh.projectId,rid,proofBody);
                const approvedAt=now();
                const approval:ReviewWindowApproval={schema:'dream-maker.review-window-approval.v1',runId:rid,projectId:fresh.projectId,specHash:fresh.specHash,
                    planVersionHash:fresh.planVersionHash!,flowConfigHash:fresh.flowConfigHash!,sourceHash:request.sourceHash,evidenceId:fresh.verification!.evidenceId,
                    originalCreatedAt:fresh.createdAt,originalMaxSeconds:fresh.maxSeconds,originalDeadline:new Date(Date.parse(fresh.createdAt)+fresh.maxSeconds*1000).toISOString(),
                    at:approvedAt,expiresAt:new Date(Date.parse(approvedAt)+request.seconds*1000).toISOString(),seconds:request.seconds,
                    calls:fresh.calls,maxCalls:fresh.maxCalls,repairCount:fresh.repairCount,maxRepairs:fresh.maxRepairs,packetHash,basisHash:basis.basisHash,
                    actorHash:hash(actor),confirmed:true,modelDispatched:false,ownershipProofs:{recordId:proofId,sha256:hash(proofBody)}};
                const recordId=this.store.record('ReviewWindowApproval',fresh.projectId,rid,approval);fresh.reviewWindow={recordId,sha256:hash(approval)};
                // Keep original timestamps, limits, counters and BLOCKED state. This
                // is neither role qualification nor preparation/resume/acceptance.
                runDeadline(this.store,fresh);this.store.saveRun(fresh);
                this.store.event(fresh.projectId,rid,'run.review-window.approved',{...fresh.reviewWindow,expiresAt:approval.expiresAt,modelDispatched:false});return fresh;
            });
        }).finally(()=>this.reviewPreparations.delete(rid));
        this.reviewPreparations.set(rid,work);return work;
    }
    reviewWindowCandidate(rid:string):{kind:'EXPIRED_REVIEW_WINDOW';sourceHash:string;version:number;maxSeconds:7200}|null{
        const r=this.store.run(rid);
        if(!r.treeHash||r.reviewWindow!==undefined||this.store.project(r.projectId).activeRunId!==rid)return null;
        try{
            if(Date.now()<runDeadline(this.store,r))return null;
            const basis=reviewPreparationBasis(this.store,r,'0'.repeat(64),{expiredWindowApproval:true,allowPacketRebuild:true});
            return basis.preDispatch?{kind:'EXPIRED_REVIEW_WINDOW',sourceHash:r.treeHash,version:r.version,maxSeconds:7200}:null;
        }catch{return null;}
    }
    reviewPreparationCandidate(rid:string):{kind:'SOURCE_VERSION';sourceHash:string;version:number}|null{
        const r=this.store.run(rid);
        if(!['REVIEW_PACKET_LIMIT','REVIEW_ROLE_EVIDENCE_REQUIRED','REVIEW_CUSTODY_EVIDENCE_INCOMPLETE','NATIVE_PROBE_MISSING','NATIVE_PROBE_BINDING_CHANGED','RPC_REQUEST_TIMEOUT'].includes(r.reason??'')||
            !r.treeHash||this.store.project(r.projectId).activeRunId!==rid)return null;
        try{const expectedPacketHash=r.reason==='RPC_REQUEST_TIMEOUT'?hash(buildReviewPacket(this.store,r,this.store.spec(r.specId))):
                r.reviewWindow===undefined?'0'.repeat(64):
                reviewWindowEvidence(this.store,r)!.packetHash,
                basis=reviewPreparationBasis(this.store,r,expectedPacketHash,{allowPacketRebuild:true});
            return basis.preDispatch||('probeBindingRecovery' in basis&&basis.probeBindingRecovery===true)||
                ('coldInitializeRecovery' in basis&&basis.coldInitializeRecovery===true)?{kind:'SOURCE_VERSION',sourceHash:r.treeHash,version:r.version}:null;
        }catch(error){if(error instanceof DomainError)return null;throw error;}
    }
    approveReviewOnlyWindow(rid:string,input:{confirmed:boolean;sourceHash:string;expectedVersion:number;seconds:number|null},actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('REVIEW_ONLY_WINDOW_CONFIRMATION_REQUIRED',403);
        if(!/^[a-f0-9]{64}$/.test(request.sourceHash)||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||(request.seconds!==null&&(typeof request.seconds!=='number'||!Number.isSafeInteger(request.seconds)||request.seconds<60||request.seconds>3600)))throw new DomainError('REVIEW_ONLY_WINDOW_INPUT_INVALID',400);
        if(this.pausing||this.reviewPreparations.has(rid)||this.activeRunIds().some(id=>this.store.run(id).projectId===this.store.run(rid).projectId))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const controller=new AbortController();this.reviewInspectionControllers.set(rid,controller);
        const work=Promise.resolve().then(async()=>{
            const check=()=>{if(controller.signal.aborted)throw new DomainError('RUN_CANCELLED',409);if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);const r=this.store.run(rid);
                const parent=reviewWindowEvidence(this.store,r);
                if(r.version!==request.expectedVersion||r.treeHash!==request.sourceHash||!parent||r.reviewOnlyWindow||Date.now()<Date.parse(parent.expiresAt)||
                    this.store.project(r.projectId).activeRunId!==rid||runUsesLaya(r)||this.store.records(r.projectId,'ReviewOnlyWindowApproval').some(row=>row.runId===rid))throw new DomainError('REVIEW_ONLY_WINDOW_NOT_ALLOWED',409);
                this.assertCurrent(r);this.unchanged(r);return {r,parent};};
            const {r:run}=check(),basis=unstartedReviewBasis(this.store,run);
            if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
            const deferred:any[]=[],proof=await inspectDispatchOwnership(this.store,this.root,this.config(),run.projectId,rid,basis.dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute),obs=>deferred.push(obs));
            if(unstartedReviewBasis(this.store,check().r).basisHash!==basis.basisHash)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
            return this.store.tx(()=>{const {r:fresh,parent}=check();if(unstartedReviewBasis(this.store,fresh).basisHash!==basis.basisHash)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
                for(const obs of deferred)this.store.record('WindowsIntentRecoveryObservation',fresh.projectId,rid,obs);
                const proofBody={schema:'dream-maker.review-only-window-proof.v1',runId:rid,projectId:fresh.projectId,specHash:fresh.specHash,sourceHash:fresh.treeHash,basis,proof};
                const proofRecordId=this.store.record('ReviewOnlyWindowProofs',fresh.projectId,rid,proofBody);
                const at=now(),approval:ReviewOnlyWindowApproval={schema:'dream-maker.review-only-window.v1',runId:rid,projectId:fresh.projectId,specHash:fresh.specHash,
                    planVersionHash:fresh.planVersionHash!,flowConfigHash:fresh.flowConfigHash!,sourceHash:fresh.treeHash!,parentHash:fresh.reviewWindow!.sha256,parentExpiresAt:parent.expiresAt,
                    originalCreatedAt:fresh.createdAt,originalMaxSeconds:fresh.maxSeconds,calls:fresh.calls,maxCalls:fresh.maxCalls,repairCount:fresh.repairCount,maxRepairs:fresh.maxRepairs,
                    at,seconds:request.seconds,expiresAt:request.seconds===null?null:new Date(Date.parse(at)+request.seconds*1000).toISOString(),actorHash:hash(actor),confirmed:true,modelDispatched:false,scope:'REVIEW_ONLY_NO_REPAIR',proofHash:hash(proofBody),proofRecordId};
                const recordId=this.store.record('ReviewOnlyWindowApproval',fresh.projectId,rid,approval);fresh.reviewOnlyWindow={recordId,sha256:hash(approval)};
                runDeadline(this.store,fresh);this.store.saveRun(fresh);this.store.event(fresh.projectId,rid,'run.review-only-window.approved',{...fresh.reviewOnlyWindow,expiresAt:approval.expiresAt,models:0});return fresh;
            });
        }).catch(error=>{if(cleanupUncertain(error))this.update(rid,'run.review-only-window.cleanup-unproven',r=>{r.state='BLOCKED';r.reason='PROCESS_CLEANUP_UNPROVEN';});throw error;})
          .finally(()=>{this.reviewPreparations.delete(rid);this.reviewInspectionControllers.delete(rid);});this.reviewPreparations.set(rid,work);return work;
    }
    prepareReviewTransportRetry(rid:string,input:{confirmed:boolean;sourceHash:string;expectedVersion:number},actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('REVIEW_TRANSPORT_CONFIRMATION_REQUIRED',403);
        if(!/^[a-f0-9]{64}$/.test(request.sourceHash)||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1)throw new DomainError('REVIEW_TRANSPORT_INPUT_INVALID',400);
        if(this.pausing||this.reviewPreparations.has(rid)||this.activeRunIds().some(id=>this.store.run(id).projectId===this.store.run(rid).projectId))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const controller=new AbortController();this.reviewInspectionControllers.set(rid,controller);
        const work=Promise.resolve().then(async()=>{
            const check=()=>{if(controller.signal.aborted)throw new DomainError('RUN_CANCELLED',409);if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);const r=this.store.run(rid);
                if(r.version!==request.expectedVersion||r.treeHash!==request.sourceHash||this.store.project(r.projectId).activeRunId!==rid||runUsesLaya(r))throw new DomainError('REVIEW_TRANSPORT_RETRY_NOT_ALLOWED',409);
                this.assertCurrent(r);this.unchanged(r);return r;};
            const run=check(),packet=buildReviewPacket(this.store,run,this.store.spec(run.specId)),packetHash=hash(packet),
                basis=readOnlyReviewRetryBasis(this.store,run,this.config(),this.root,packet);
            if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
            assertReviewTaskBodySafe({specHash:run.specHash,taskData:JSON.stringify(packet),laya:null});
            const deferred:any[]=[],proof=await inspectDispatchOwnership(this.store,this.root,this.config(),run.projectId,rid,basis.dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute),obs=>deferred.push(obs));
            if(proof.proven!==true||proof.dispatchId!==basis.dispatchId)throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
            const current=check(),currentPacket=buildReviewPacket(this.store,current,this.store.spec(current.specId));
            if(readOnlyReviewRetryBasis(this.store,current,this.config(),this.root,currentPacket).basisHash!==basis.basisHash||hash(currentPacket)!==packetHash)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
            this.assertNativeReadyForRun(current,'reviewer');
            return this.store.tx(()=>{const fresh=check(),freshPacket=buildReviewPacket(this.store,fresh,this.store.spec(fresh.specId));
                if(readOnlyReviewRetryBasis(this.store,fresh,this.config(),this.root,freshPacket).basisHash!==basis.basisHash||hash(freshPacket)!==packetHash)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
                for(const obs of deferred)this.store.record('WindowsIntentRecoveryObservation',fresh.projectId,rid,obs);
                this.store.record('ReviewTransportRetryPreparation',fresh.projectId,rid,{basis,proof,packetHash,actorHash:hash(actor),sourceHash:fresh.treeHash,specHash:fresh.specHash,
                    planVersionHash:fresh.planVersionHash,calls:fresh.calls,maxCalls:fresh.maxCalls,repairCount:fresh.repairCount,maxRepairs:fresh.maxRepairs,modelDispatched:false});
                fresh.state='PAUSED';fresh.reason='REVIEW_TRANSPORT_RETRY_PREPARED';this.store.saveRun(fresh);this.store.event(fresh.projectId,rid,'run.review-transport-retry.prepared',{dispatchId:basis.dispatchId,priorModelOutcome:'UNKNOWN',modelDispatched:false});return fresh;
            });
        }).catch(error=>{if(cleanupUncertain(error))this.update(rid,'run.review-transport.cleanup-unproven',r=>{r.state='BLOCKED';r.reason='PROCESS_CLEANUP_UNPROVEN';});throw error;})
          .finally(()=>{this.reviewPreparations.delete(rid);this.reviewInspectionControllers.delete(rid);});this.reviewPreparations.set(rid,work);return work;
    }
    prepareInterruptedReview(rid:string,sourceHash:string,version:number,actor:string):Promise<Run>{
        if(!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('REVIEW_INTERRUPTION_CONFIRMATION_REQUIRED',403);
        if(this.pausing||this.reviewPreparations.has(rid)||this.activeRunIds().some(id=>this.store.run(id).projectId===this.store.run(rid).projectId))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const controller=new AbortController();this.reviewInspectionControllers.set(rid,controller);
        const work=Promise.resolve().then(async()=>{
            const check=()=>{if(controller.signal.aborted)throw new DomainError('RUN_CANCELLED',409);if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);const r=this.store.run(rid);
                if(r.version!==version||r.treeHash!==sourceHash||this.store.project(r.projectId).activeRunId!==rid||runUsesLaya(r))throw new DomainError('REVIEW_INTERRUPTION_NOT_RECOVERABLE',409);
                this.assertCurrent(r);this.unchanged(r);return r;};
            const run=check(),basis=interruptedReviewBasis(this.store,run),native=this.nativeFactory();
            if(!native.inspectInterruptedReview||this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('REVIEW_INTERRUPTION_HISTORY_UNVERIFIED',409);
            const deferred:any[]=[];
            const proof=await inspectDispatchOwnership(this.store,this.root,this.config(),run.projectId,rid,basis.input.dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute),obs=>deferred.push(obs));
            const inspect=()=>native.inspectInterruptedReview!(basis.input,controller.signal);
            const observed=this.networkRoute
                ?await this.networkRoute.withRun(`review-inspection-${rid}`,controller.signal,inspect)
                :await inspect();
            if(observed.schema!=='dream-maker.interrupted-review-observation.v1'||observed.threadId!==basis.input.threadId||observed.status!=='interrupted'||
                !/^[A-Za-z0-9_-]{1,200}$/.test(observed.turnId)||observed.inputHash!==basis.input.inputHash||observed.userOnly!==true||observed.modelDispatchesByInspection!==0||observed.cleanupReturned!==true||
                !/^[a-f0-9]{64}$/.test(observed.contextHash)||!/^[a-f0-9]{64}$/.test(observed.transcriptHash))throw new DomainError('REVIEW_INTERRUPTION_HISTORY_UNVERIFIED',409);
            const current=check();if(interruptedReviewBasis(this.store,current).basisHash!==basis.basisHash)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
            this.assertNativeReadyForRun(current,'reviewer');
            return this.store.tx(()=>{const fresh=check();if(interruptedReviewBasis(this.store,fresh).basisHash!==basis.basisHash)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
                for(const obs of deferred)this.store.record('WindowsIntentRecoveryObservation',fresh.projectId,rid,obs);
                this.store.record('ReviewInterruptedRecovery',fresh.projectId,rid,{...basis,observation:observed,ownership:proof,actorHash:hash(actor),modelDispatched:false});
                fresh.state='PAUSED';fresh.reason='REVIEW_INTERRUPTION_RECONCILED';this.store.saveRun(fresh);
                this.store.event(fresh.projectId,rid,'run.review-interruption.reconciled',{threadId:observed.threadId,turnId:observed.turnId,modelDispatched:false});return fresh;
            });
        }).catch(error=>{
            if(cleanupUncertain(error))this.update(rid,'run.review-inspection.cleanup-unproven',r=>{r.state='BLOCKED';r.reason='PROCESS_CLEANUP_UNPROVEN';});
            throw error;
        }).finally(()=>{this.reviewPreparations.delete(rid);this.reviewInspectionControllers.delete(rid);});this.reviewPreparations.set(rid,work);return work;
    }
    prepareReviewRetry(rid:string,expectedPacketHash:string,actor:string):Promise<Run>{
        return this.prepareReviewRetryRequest(rid,{kind:'RECORDED_PACKET',packetHash:expectedPacketHash},actor);
    }
    prepareUndispatchedReviewRetry(rid:string,sourceHash:string,version:number,actor:string):Promise<Run>{
        return this.prepareReviewRetryRequest(rid,{kind:'SOURCE_VERSION',sourceHash,version},actor);
    }
    private prepareReviewRetryRequest(rid:string,request:{kind:'RECORDED_PACKET';packetHash:string}|{kind:'SOURCE_VERSION';sourceHash:string;version:number},actor:string):Promise<Run>{
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        if(this.reviewPreparations.has(rid)||this.activeRunIds().some(id=>this.store.run(id).projectId===this.store.run(rid).projectId))
            throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const work=Promise.resolve().then(async()=>{
            const check=()=>{if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);const r=this.store.run(rid);
                if(this.store.project(r.projectId).activeRunId!==rid)throw new DomainError('REVIEW_PREPARATION_RECOVERY_NOT_ALLOWED',409);
                this.assertCurrent(r);this.unchanged(r);return r;};
            const run=check();
            if(request.kind==='SOURCE_VERSION'&&(!/^[a-f0-9]{64}$/.test(request.sourceHash)||!Number.isSafeInteger(request.version)||request.version!==run.version||request.sourceHash!==run.treeHash))
                throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
            const expectedPacketHash=request.kind==='RECORDED_PACKET'?request.packetHash:hash(buildReviewPacket(this.store,run,this.store.spec(run.specId)));
            const recoveryOptions=request.kind==='SOURCE_VERSION'?{allowPacketRebuild:true}:undefined;
            const basis=reviewPreparationBasis(this.store,run,expectedPacketHash,recoveryOptions);
            if(request.kind==='SOURCE_VERSION'&&!basis.preDispatch&&!('packetRebuilt' in basis&&basis.packetRebuilt)&&
                !('probeBindingRecovery' in basis&&basis.probeBindingRecovery===true)&&
                !('coldInitializeRecovery' in basis&&basis.coldInitializeRecovery===true))throw new DomainError('REVIEW_PREPARATION_RECOVERY_NOT_ALLOWED',409);
            if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
            const packet=buildReviewPacket(this.store,run,this.store.spec(run.specId));
            if(hash(packet)!==basis.packetHash)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
            assertReviewTaskBodySafe({specHash:run.specHash,taskData:JSON.stringify(packet),laya:null});
            const deferred:any[]=[];const proofs:Awaited<ReturnType<typeof inspectDispatchOwnership>>[]=[];for(const dispatchId of basis.dispatchIds){check();proofs.push(await inspectDispatchOwnership(this.store,this.root,this.config(),run.projectId,rid,dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute),(obs)=>deferred.push(obs)));}
            const current=check(),after=reviewPreparationBasis(this.store,current,expectedPacketHash,recoveryOptions);
            if(after.basisHash!==basis.basisHash||after.version!==basis.version||hash(buildReviewPacket(this.store,current,this.store.spec(current.specId)))!==basis.packetHash)
                throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
            this.assertNativeReadyForRun(current,'reviewer');
            return this.store.tx(()=>{const fresh=check();
                if(fresh.version!==basis.version)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
                const finalBasis=reviewPreparationBasis(this.store,fresh,expectedPacketHash,recoveryOptions);
                if(finalBasis.basisHash!==basis.basisHash)throw new DomainError('REVIEW_PREPARATION_MATERIAL_CHANGED',409);
                for(const obs of deferred)this.store.record('WindowsIntentRecoveryObservation',run.projectId,rid,obs);
                this.store.record('ReviewPreparationRecovery',fresh.projectId,rid,{...basis,proofs,actorHash:hash(actor),sourceHash:fresh.treeHash,
                    specHash:fresh.specHash,planVersionHash:fresh.planVersionHash,calls:fresh.calls,repairCount:fresh.repairCount,createdAt:fresh.createdAt,maxSeconds:fresh.maxSeconds,modelDispatched:false});
                fresh.state='PAUSED';fresh.reason='REVIEW_PREPARATION_RECHECKED';this.store.saveRun(fresh);
                this.store.event(fresh.projectId,rid,'run.review-preparation.rechecked',{packetHash:basis.packetHash,dispatchId:basis.dispatchId,modelDispatched:false});return fresh;
            });
        }).finally(()=>this.reviewPreparations.delete(rid));
        this.reviewPreparations.set(rid,work);return work;
    }
    preparePartialRepair(rid:string,input:PartialRepairRequest,actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('PARTIAL_REPAIR_CONFIRMATION_REQUIRED',403);
        if(!/^[a-f0-9]{64}$/.test(request.sourceHash)||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1)throw new DomainError('PARTIAL_REPAIR_INPUT_INVALID',400);
        if(this.pausing||this.reviewPreparations.has(rid)||this.activeRunIds().some(id=>this.store.run(id).projectId===this.store.run(rid).projectId))throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        const controller=new AbortController();this.reviewInspectionControllers.set(rid,controller);
        const work=Promise.resolve().then(async()=>{
            const check=()=>{if(controller.signal.aborted)throw new DomainError('RUN_CANCELLED',409);if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
                const r=this.store.run(rid);if(r.version!==request.expectedVersion||this.store.project(r.projectId).activeRunId!==rid||runUsesLaya(r))throw new DomainError('PARTIAL_REPAIR_NOT_RECOVERABLE',409);this.assertCurrent(r);return r;};
            const run=check(),basis=partialRepairBasis(this.store,run,request.sourceHash);
            if(basis.admissionRecovery){const inspect=this.nativeFactory().assertEmptyNativeDispatch;if(!inspect)throw new DomainError('NATIVE_DISPATCH_HISTORY_REQUIRED',409);
                const result:unknown=inspect.call(this.nativeFactory(),rid,basis.dispatchId);if(result!==undefined)throw new DomainError('NATIVE_DISPATCH_HISTORY_UNVERIFIED',409);}
            if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
            const deferred:any[]=[],proof=await inspectDispatchOwnership(this.store,this.root,this.config(),run.projectId,rid,basis.dispatchId,this.networkRoute?.assertRecovered?.bind(this.networkRoute),obs=>deferred.push(obs));
            const current=check();if(partialRepairBasis(this.store,current,request.sourceHash).basisHash!==basis.basisHash)throw new DomainError('PARTIAL_REPAIR_MATERIAL_CHANGED',409);
            this.assertNativeReadyForRun(current,'executor');
            return this.store.tx(()=>{const fresh=check();if(partialRepairBasis(this.store,fresh,request.sourceHash).basisHash!==basis.basisHash)throw new DomainError('PARTIAL_REPAIR_MATERIAL_CHANGED',409);
                for(const obs of deferred)this.store.record('WindowsIntentRecoveryObservation',run.projectId,rid,obs);
                this.store.record(basis.admissionRecovery?'PartialRepairAdmissionRecovery':'PartialRepairContinuation',run.projectId,rid,{schema:'dream-maker.partial-repair-continuation.v1',...basis,actorHash:hash(actor),proof,
                    source:captureSource(fresh.workspace,{runId:rid,specHash:run.specHash},'EXECUTOR_BEFORE'),calls:fresh.calls,repairCount:fresh.repairCount,maxRepairs:fresh.maxRepairs,
                    automaticRetry:false,taskCompletionAssumed:false,modelDispatched:false});
                fresh.treeHash=request.sourceHash;fresh.verification=null;fresh.state='PAUSED';fresh.reason=basis.repairReason;this.store.saveRun(fresh);
                this.store.event(fresh.projectId,rid,'run.partial-repair.prepared',{sourceHash:request.sourceHash,modelDispatched:false,completionAssumed:false});return fresh;
            });
        }).catch(error=>{if(cleanupUncertain(error))this.update(rid,'run.partial-repair.cleanup-unproven',r=>{r.state='BLOCKED';r.reason='PROCESS_CLEANUP_UNPROVEN';});throw error;})
          .finally(()=>{this.reviewPreparations.delete(rid);this.reviewInspectionControllers.delete(rid);});this.reviewPreparations.set(rid,work);return work;
    }
    async prepareInterruptedRepairVerification(rid:string,input:InterruptedRepairVerificationRequest,actor:string):Promise<Run>{
        const request=Object.freeze({...input});
        if(request.confirmed!==true||!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_CONFIRMATION_REQUIRED',403);
        if(Object.keys(input).some(key=>!['confirmed','sourceHash','expectedVersion'].includes(key))||
            !/^[a-f0-9]{64}$/.test(request.sourceHash)||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1)
            throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_INPUT_INVALID',400);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const r=this.store.run(rid);
        if(this.activeRunIds().some(id=>this.store.run(id).projectId===r.projectId)||this.reviewPreparations.has(rid))
            throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);
        this.assertBinding(r);
        if(r.interruptedRepairVerification!==undefined){
            const evidence=interruptedRepairVerificationEvidence(this.store,r);
            if(evidence.requestVersion!==request.expectedVersion||evidence.sourceHash!==request.sourceHash)
                throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_CHANGED',409);
            this.assertCurrent(r);
            return r;
        }
        if(this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid))
            throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
        const basis=interruptedRepairVerificationBasis(this.store,r,request.sourceHash);
        if(r.version!==request.expectedVersion)throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_CHANGED',409);
        const deferred:any[]=[],proof=await inspectDispatchOwnership(this.store,this.root,this.config(),r.projectId,rid,basis.dispatchId,
            this.networkRoute?.assertRecovered?.bind(this.networkRoute),obs=>deferred.push(obs));
        const current=this.store.run(rid);
        this.assertBinding(current);
        if(current.version!==request.expectedVersion||
            interruptedRepairVerificationBasis(this.store,current,request.sourceHash).basisHash!==basis.basisHash)
            throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_CHANGED',409);
        return this.store.tx(()=>{
            const fresh=this.store.run(rid);
            if(fresh.version!==request.expectedVersion)throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_CHANGED',409);
            if(fresh.interruptedRepairVerification!==undefined)throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_CHANGED',409);
            const finalBasis=interruptedRepairVerificationBasis(this.store,fresh,request.sourceHash);
            if(finalBasis.basisHash!==basis.basisHash)throw new DomainError('INTERRUPTED_REPAIR_VERIFICATION_CHANGED',409);
            for(const obs of deferred)this.store.record('WindowsIntentRecoveryObservation',fresh.projectId,rid,obs);
            const data={
                ...finalBasis,
                requestVersion:request.expectedVersion,
                specHash:fresh.specHash,
                planVersionHash:fresh.planVersionHash,
                calls:fresh.calls,
                maxCalls:fresh.maxCalls,
                repairCount:fresh.repairCount,
                maxRepairs:fresh.maxRepairs,
                createdAt:fresh.createdAt,
                maxSeconds:fresh.maxSeconds,
                actorHash:hash(actor),
                proof,
                modelDispatched:false,
                automaticRetry:false,
                completionAssumed:false,
                at:now(),
            };
            const recordId=this.store.record('InterruptedRepairVerificationRecovery',fresh.projectId,rid,data);
            fresh.interruptedRepairVerification={recordId,sha256:hash(data)};
            fresh.treeHash=request.sourceHash;
            fresh.phase='VERIFYING';
            fresh.state='PAUSED';
            fresh.reason=INTERRUPTED_REPAIR_VERIFICATION_REASON;
            this.store.saveRun(fresh);
            this.store.event(fresh.projectId,rid,'run.interrupted-repair-verification.prepared',{
                recordId,sha256:fresh.interruptedRepairVerification.sha256,sourceHash:request.sourceHash,
                dispatchId:finalBasis.dispatchId,modelDispatched:false,automaticRetry:false,completionAssumed:false,
            });
            return fresh;
        });
    }
    async resume(rid: string, reconciled = false) {
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        await this.settled(rid);
        if(this.pausing)throw new DomainError('ENGINE_PAUSING',409);
        const r = this.store.run(rid);
        let documentationRuntime: ReturnType<typeof documentationRuntimeEvidence> | undefined;
        if(r.documentationContinuation){assertDocumentationProtectedFiles(this.store,r);
            if(r.calls===0)documentationPreparedEvidence(this.store,r);
            else documentationRuntime=documentationRuntimeEvidence(this.store,r);
        }
        const documentationRecovery=r.state==='BLOCKED'&&r.phase==='IMPLEMENTING'&&r.reason==='DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED'&&documentationRuntime!==undefined;
        let pendingDocumentationWave:ReturnType<ExecutorSlices['pending']>|undefined;
        if(documentationRecovery){
            pendingDocumentationWave=this.executorSlices.pendingRecoveryWave(rid,documentationRuntime!.approval.taskId,documentationRuntime!.approval.writePaths);
            if(this.store.records(r.projectId,'DocumentationContinuationRecovery').some(row=>row.runId===rid))
                throw new DomainError('DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED',409);
        }
        if (!['PAUSED', 'BLOCKED'].includes(r.state))
            throw new DomainError('RUN_NOT_RESUMABLE', 409);
        executionWorkspace(r,this.data);
        if (['REPAIR_LIMIT', 'REPEATED_FAILURE_NO_PROGRESS', 'REVIEW_BLOCKED', 'RUN_CALL_BUDGET_EXCEEDED', 'RUN_WALL_TIME_BUDGET_EXCEEDED'].includes(r.reason ?? ''))
            throw new DomainError('BUDGET_OR_REPAIR_LIMIT_REQUIRES_NEW_RUN', 409);
        this.assertCurrent(r);
        this.unchanged(r);
        if(r.reason===INTERRUPTED_REPAIR_VERIFICATION_REASON)interruptedRepairVerificationEvidence(this.store,r);
        const preparationDispatchRecovery=r.state==='BLOCKED'&&r.phase==='REPAIRING'&&
            r.reason==='REVIEW_PREPARATION_REPLAY_INVALID'&&reconciled===true?reviewPreparationDispatchRecovery(this.store,r):undefined;
        if(r.reviewSupplement){const supplement=assertReviewSupplementPacket(this.store,r,buildReviewPacket(this.store,r,this.store.spec(r.specId)));if(supplement.used)throw new DomainError('REVIEW_SUPPLEMENT_CALL_EXHAUSTED',409);}
        if (r.state === 'BLOCKED' && !documentationRecovery && !preparationDispatchRecovery && (!reconciled || r.mode === 'live'))
            throw new DomainError('MANUAL_RECONCILIATION_REQUIRED', 409);
        // Refused money/qualification gates must leave a retained checkpoint usable. Do not
        // turn a no-dispatch refusal into another interrupted wave or spend a recovery attempt.
        if(r.mode==='live'){
            if(r.flowName==='custom')this.assertNativeReadyForRun(r,'build');
            else{const role=r.phase==='PLANNING'?'planner2':r.phase==='REVIEWING'?'reviewer':r.phase==='IMPLEMENTING'||r.phase==='REPAIRING'?'executor':undefined;
                if(role)this.assertNativeReadyForRun(r,role);}
        }
        if(r.documentationContinuation)this.reserveDocumentationRuntime(this.store.run(rid));
        if(documentationRecovery){
            const recovered=this.update(rid,'run.documentation-continuation.binding-recovered',x=>{
                x.state=x.phase;x.reason=null;
                this.store.record('DocumentationContinuationRecovery',x.projectId,x.id,{
                    schema:'dream-maker.documentation-continuation-recovery.v1',
                    runId:x.id,reason:'DOCUMENTATION_CONTINUATION_TASK_BINDING_CHANGED',
                    sourceHash:x.treeHash,waveId:pendingDocumentationWave!.id,taskId:documentationRuntime!.approval.taskId,
                    calls:x.calls,repairCount:x.repairCount,modelsDispatched:false,automaticRetry:false,
                    at:now(),
                });
            });
            this.launch(rid);return recovered;
        }
        if(preparationDispatchRecovery){
            const recovered=this.update(rid,'run.review-preparation.dispatch-recovered',x=>{
                x.state=x.phase;
                // The Executor request binding is part of the repair authority.
                // Keep the exact open Reviewer findings as its cause after a
                // zero-model dispatch-recovery; a null cause would make every
                // DSH request fail closed as NATIVE_REQUEST_BINDING_STALE.
                x.reason=JSON.stringify(x.review!.findings);
                this.store.record('ReviewPreparationDispatchRecovery',x.projectId,x.id,{...preparationDispatchRecovery,recoveredAt:now()});
            });
            this.launch(rid);return recovered;
        }
        const out = this.update(rid, 'run.resumed', x => { x.state = x.phase;
            // A paused verifier repair still needs its original diagnostic source.
            // Clearing that origin would silently turn a resumed repair into a blind turn.
            if(!(x.phase==='REPAIRING'&&(x.reason?.startsWith('VERIFIER_EXIT_')||x.reason&&x.failedFingerprints.at(-1)===hash(x.reason))))x.reason=null;
            if(x.state==='READY_FOR_DELIVERY')this.releaseWriterWhenSafe(x); if (reconciled && x.mode === 'demo')
            x.tasks = x.tasks.map(t => t.status === 'running' ? { ...t, status: 'pending' } : t); });
        this.launch(rid);
        return out;
    }
    async cancel(rid: string) {
        const r = this.store.run(rid);
        if(this.executorSlices.hasUncertainMerge(rid))throw new DomainError('EXECUTOR_MERGE_RESULT_UNCERTAIN',409);
        if(this.dataJobs.has(rid))return this.cancelJsonData(rid);
        if(this.dispatch.hasUncertain(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
        if (r.state === 'ACCEPTED')
            throw new DomainError('ACCEPTED_RUN_IMMUTABLE', 409);
        if (r.state === 'CANCELLED')
            return r;
        if (r.mode === 'live' && ['WORKER_RESTART_RESULT_UNCERTAIN', 'PROCESS_CLEANUP_UNPROVEN'].includes(r.reason ?? ''))
            throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED', 409);
        this.update(rid, 'run.cancel.requested', x => { x.state = 'CANCEL_REQUESTED'; });
        const preparation=this.reviewPreparations.get(rid);
        if(preparation){
            this.reviewInspectionControllers.get(rid)?.abort();
            try{await preparation;}catch(error){
                if(!(error instanceof DomainError&&error.code==='RUN_CANCELLED')){
                    this.update(rid,'run.review-inspection.cleanup-unproven',x=>{x.state='BLOCKED';x.reason='PROCESS_CLEANUP_UNPROVEN';});
                    throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
                }
            }
        }
        const job = this.jobs.get(rid);
        if (job) {
            job.controller.abort();
            await job.promise;
        }
        else
            this.finalCancel(rid);
        return this.store.run(rid);
    }
    private repairProjectActiveRunInTransaction(cancelled:Run){
        const project=this.store.project(cancelled.projectId);
        if(project.activeRunId!==cancelled.id)return false;
        const previous=this.store.runs(cancelled.projectId).find(run=>
            run.id!==cancelled.id&&run.specId===cancelled.specId&&run.specHash===cancelled.specHash&&run.mode===cancelled.mode&&
            ['ACCEPTED','READY_FOR_DELIVERY'].includes(run.state)&&run.review?.verdict==='PASS'&&
            run.verification?.ok===true&&run.review.treeHash===run.treeHash&&run.verification.treeHash===run.treeHash);
        project.activeRunId=previous?.id??null;
        this.store.saveProject(project);
        this.store.event(project.id,cancelled.id,'project.active-run.recovered',{
            cancelledRunId:cancelled.id,
            activeRunId:project.activeRunId,
        });
        return true;
    }
    async cancelJsonData(rid:string){
        const r=this.store.run(rid),job=this.dataJobs.get(rid);
        if(job){
            job.controller.abort(new DomainError(job.kind==='SQLITE_READ'?'SQLITE_DATA_READ_CANCELLED':job.kind==='SQLITE_RUNTIME'?'SQLITE_DATA_RUNTIME_CANCELLED':job.kind==='SQLITE_RECOVERY'?'SQLITE_DATA_RECOVERY_CANCELLED':'JSON_DATA_RUNTIME_CANCELLED',409));
            try{await job.promise;}catch(error){if(this.dispatch.hasUncertain(rid))throw error;}
        }
        if(this.dispatch.hasUncertain(rid))throw new DomainError('PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED',409);
        this.store.event(r.projectId,rid,job?.kind==='SQLITE_READ'?'run.sqlite-data.read-cancelled':job?.kind==='SQLITE_RUNTIME'||job?.kind==='SQLITE_RECOVERY'?'run.sqlite-data.cancelled':'run.json-data.cancelled',{cleanupReturned:true,originalFlowUnchanged:true,automaticResume:false});
        return this.store.run(rid);
    }
    private finalCancel(rid: string) { this.store.tx(() => { const r = this.store.run(rid); if (r.state === 'CANCELLED')
        return; r.state = 'CANCELLED'; r.reason = 'USER_CANCELLED'; this.releaseWriterWhenSafe(r);this.store.saveRun(r); this.store.event(r.projectId, r.id, 'run.cancelled', { attempt: r.attempt });this.repairProjectActiveRunInTransaction(r); }); }
    accept(rid: string) {
        const r = this.store.run(rid);
        if(this.jobs.has(rid)||this.dataJobs.has(rid)||this.dispatch.hasUncertain(rid)||this.executorSlices.hasUncertainMerge(rid)||this.store.owns(r.projectId,rid))throw new DomainError('ACCEPTANCE_GATES_NOT_MET',409);
        if (r.state === 'BLOCKED' && SETTLED_BLOCK_REASONS.has(r.reason ?? ''))
            throw new DomainError('ACCEPTANCE_GATES_NOT_MET', 409);
        // No lease: a READY_FOR_DELIVERY run released it on purpose, and accepting must stay possible.
        this.assertBinding(r);
        this.unchanged(r);
        if (r.state !== 'READY_FOR_DELIVERY' || !r.verification?.ok || r.review?.verdict !== 'PASS' || r.review.treeHash !== r.treeHash || r.verification.treeHash !== r.treeHash || r.findings.some(f => f.status === 'open') || (r.flowName==='custom'||!!r.documentationContinuation)&&!completedEngineeringRoles(r,this.config(),this.store))
            throw new DomainError('ACCEPTANCE_GATES_NOT_MET', 409);
        // The owner's Custom standard: three roles on one harness, or one model on
        // three harnesses, is not an independent plan/execute/review chain. This is
        // checked at acceptance so a non-diverse Flow can never be counted as passed.
        if(r.flowName==='custom'&&r.flowConfig?.mode==='custom')assertCustomRoleDiversity(r.flowConfig);
        return this.store.tx(() => { r.state = 'ACCEPTED'; this.store.saveRun(r); this.store.release(r.projectId, r.id); this.store.approve(r.projectId, r.specHash, 'DELIVERY'); this.store.event(r.projectId, r.id, 'run.accepted', { mode: r.mode, treeHash: r.treeHash }); return r; });
    }
    inspectVerifier(pid:string,specHash:string){
        const p=this.store.project(pid),s=p.specId?this.store.spec(p.specId):null;
        if(!s||s.stale||s.hash!==specHash)throw new DomainError('VERIFIER_SPEC_BINDING_INVALID',409);
        const getter=this.nativeFactory().verifierPlan;if(!getter)throw new DomainError('TRUSTED_VERIFIER_NOT_CONFIGURED',409);
        return getter.call(this.nativeFactory(),pid,specHash);
    }
    private assertVerifierApprovalLease(pid:string,specHash:string){
        const lease=this.store.db.prepare('SELECT run_id FROM workspace_leases WHERE project_id=?').get(pid) as {run_id?:unknown}|undefined;
        if(!lease)return;
        try{
            const rid=String(lease.run_id),run=this.store.run(rid),project=this.store.project(pid);
            if(project.activeRunId!==rid||run.projectId!==pid||run.specHash!==specHash||run.state!=='PAUSED'||
                run.phase!=='IMPLEMENTING'||run.reason!=='BOUNDED_CODE_REPAIR_PREPARED'||!this.store.owns(pid,rid))
                throw new DomainError('WORKSPACE_BUSY',409);
            const approval=documentationContinuationEvidence(this.store,run);
            if(!approval||approval.repairKind!=='CODE')throw new DomainError('WORKSPACE_BUSY',409);
            documentationPreparedEvidence(this.store,run);
        }catch(error){
            if(error instanceof DomainError&&error.code==='WORKSPACE_BUSY')throw error;
            throw new DomainError('WORKSPACE_BUSY',409);
        }
    }
    flowReport(rid:string) {
        const r=this.store.run(rid);
        if(this.jobs.has(rid)||this.store.owns(r.projectId,r.id)||!['READY_FOR_DELIVERY','ACCEPTED','CANCELLED','BLOCKED','FAILED','PARTIAL'].includes(r.state))
            throw new DomainError('FLOW_NOT_SETTLED',409);
        const s=this.store.spec(r.specId);
        let sourceUnchanged=false;try{sourceUnchanged=!!r.treeHash&&treeHash(readWorkspace(r,this.data))===r.treeHash;}catch{}
        const targetRolesMet=completedEngineeringRoles(r,this.config(),this.store);
        const technical=targetRolesMet&&sourceUnchanged&&r.verification?.ok===true&&r.verification.treeHash===r.treeHash&&r.review?.verdict==='PASS'&&r.review.treeHash===r.treeHash&&!r.findings.some(f=>f.status==='open');
        const verifiedCount=technical?s.requirements.length:0,remainingCount=s.requirements.length-verifiedCount;
        const status=['READY_FOR_DELIVERY','ACCEPTED'].includes(r.state)?technical?'COMPLETED':'PARTIAL':r.state;
        const reasons=[...(r.reason?[r.reason]:[]),...(!sourceUnchanged&&r.treeHash?['ARTIFACT_SOURCE_CHANGED']:[])];
        const report={schema:'dream-maker.flow-report.v1',runId:r.id,specHash:r.specHash,planVersionId:r.planVersionId??null,state:r.state,
            evidenceClass:r.mode==='demo'?'OFFLINE_DEMO_NOT_LIVE_AGENT':'ACTUAL_RUN_EVIDENCE_REQUIRES_SOURCE_BOUND_VERIFIER_AND_ROLES',
            technicalRequirementsMet:technical,targetRolesMet,userAccepted:r.state==='ACCEPTED',verifiedCount,remainingCount,sourceUnchanged,
            callAccounting:{originalCalls:r.calls,originalMaxCalls:r.maxCalls,supplementalReviewCalls:reviewSupplementEvidence(this.store,r)?.used??0,totalCalls:r.calls+(reviewSupplementEvidence(this.store,r)?.used??0)},
            summary:plainFlowReport({status,completedCount:verifiedCount,remainingCount,blockers:reasons.map(code=>({code})),planVersion:s.revision}),
            rolePolicy:r.rolePolicy??'HISTORICAL_UNRECORDED',roles:r.roleIdentities??{},executorRoles:r.executorRoleIdentities??[],sourceHash:r.treeHash,
            evidence:{verificationId:r.verification?.evidenceId??null,verificationBound:r.verification?.treeHash===r.treeHash,reviewSource:r.review?.source??null,reviewBound:r.review?.treeHash===r.treeHash},
            limitations:['本轮报告不代表整个项目完成，也不代替你的最终接受。',...(r.mode==='demo'?['本轮使用固定 Demo 规则，不是四角色 Live。']:[])]};
        return {...report,reportHash:hash(report)};
    }
    async conclude(rid:string,choice:string,actor:string,expectedReportHash?:string,userConstraint='') {
        if(!['HANDLE','HELP','ALTERNATIVE','SAVE'].includes(choice))throw new DomainError('INVALID_BLOCKER_CHOICE',400);
        userConstraint=text(userConstraint,2000,true);if(hasSecret(userConstraint))throw new DomainError('SECRET_IN_NOTES');
        await this.settled(rid);
        const r=this.store.run(rid);
        if(r.flowConclusion){
            const row=this.store.records(r.projectId,'FlowConclusion').find(row=>row.id===r.flowConclusion!.recordId);
            if(!row||hash(row.data)!==r.flowConclusion.sha256)throw new DomainError('FLOW_CONCLUSION_CHANGED',409);
            if(row.data.choice!==choice||(row.data.userConstraint??'')!==userConstraint){
                const currentReport=this.flowReport(rid);
                if(expectedReportHash!==undefined&&expectedReportHash!==currentReport.reportHash)throw new DomainError('FLOW_REPORT_CHANGED',409);
                const prior=this.store.records(r.projectId,'FlowFollowup').filter(row=>row.runId===rid).at(-1);
                if(prior?.data.choice!==choice||(prior?.data.userConstraint??'')!==userConstraint)this.store.record('FlowFollowup',r.projectId,rid,{reportId:row.data.reportId,choice,userConstraint,constraintSource:'EXPLICIT_LOCAL_SESSION',actor:text(actor,160),at:now(),intent:humanBlockerIntent({flowTerminal:true,choice}),automaticBuild:false});
            }
            return {reportId:row.data.reportId as string,report:row.data.report as ReturnType<Engine['flowReport']>};
        }
        const report=this.flowReport(rid),intent=humanBlockerIntent({flowTerminal:true,choice});
        if(expectedReportHash!==undefined&&expectedReportHash!==report.reportHash)throw new DomainError('FLOW_REPORT_CHANGED',409);
        return this.store.tx(()=>{
            const current=this.store.run(rid);if(current.version!==r.version)throw new DomainError('FLOW_CHANGED',409);
            const reportId=id('flow_report'),at=now();
            const data={reportId,runId:r.id,specHash:r.specHash,choice,userConstraint,constraintSource:'EXPLICIT_LOCAL_SESSION',actor:text(actor,160),at,report,intent,automaticBuild:false,deliveryAccepted:false};
            const recordId=this.store.record('FlowConclusion',r.projectId,r.id,data);
            current.flowConclusion={recordId,sha256:hash(data),at};this.store.saveRun(current);
            this.store.event(r.projectId,r.id,'flow.concluded',{reportId,choice,accepted:report.userAccepted});return {reportId,report};
        });
    }
    approveVerifier(pid:string,specHash:string,planHash:string,approved:boolean){
        if(!approved)throw new DomainError('TRUSTED_VERIFIER_CONSENT_REQUIRED',403);
        const plan=this.inspectVerifier(pid,specHash);if(plan.sha256!==planHash)throw new DomainError('TRUSTED_VERIFIER_PLAN_CHANGED',409);
        this.store.tx(()=>{this.assertVerifierApprovalLease(pid,specHash);this.store.approve(pid,specHash,'VERIFIER');this.store.record('VerifierApproval',pid,null,{specHash,planHash,source:'EXPLICIT_LOCAL_SESSION_ACTION'});});
        return{specHash,planHash,approved:true};
    }
    export(rid: string) {
        const r = this.store.run(rid);
        if (!['READY_FOR_DELIVERY', 'ACCEPTED'].includes(r.state) || this.jobs.has(rid))
            throw new DomainError('EXPORT_REQUIRES_STABLE_DELIVERY', 409);
        const workspace=readWorkspace(r,this.data);
        if (r.treeHash && treeHash(workspace) !== r.treeHash)
            throw new DomainError('ARTIFACT_SOURCE_CHANGED', 409);
        // Everything in the archive has to be attested by the manifest, including the spec copy that travels
        // with it: DREAM_MAKER_SPEC.md used to be added to the ZIP with no hash anywhere, so a corrupted or
        // substituted spec in an otherwise verified delivery would have gone unnoticed.
        const documents = [{ path: 'DREAM_MAKER_SPEC.md', data: Buffer.from(this.store.spec(r.specId).masterPrompt) }];
        const manifest = { schema: 'dream-maker.delivery.v1', runId: r.id, mode: r.mode, status: r.state, specHash: r.specHash, treeHash: r.treeHash, files: files(workspace), documents: documents.map(d => ({ path: d.path, bytes: d.data.length, sha256: hash(d.data) })), evidenceLevel: r.mode === 'demo' ? 'OFFLINE_DEMO_NOT_LIVE_AGENT' : 'LIVE_HOST_CLAIM_REQUIRES_EVIDENCE', exportedAt: now() };
        const entries = files(workspace).map(f => ({ path: f.path, data: get(workspace, f.path) }));
        entries.push({ path: 'DREAM_MAKER_MANIFEST.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...documents);
        return zip(entries);
    }
    // Bounded executor segmentation. A long tool-using turn may only be split at a boundary the SYSTEM can
    // verify, never at a fabricated SDK checkpoint. The boundary here is a dispatch plus the workspace: files
    // already written stay on disk and their tree hash is recorded, so the next segment continues from them.
    // A segment is NOT a substantive repair (the repair counter is untouched) and each segment still reserves
    // and settles its own requests, so budget accounting is unchanged.
    private async executorSegmented(r: Run, input: AgentInput, runner: Runner, prompt: string,
        decision: { adoption?: unknown }, emit: (e: unknown) => void): Promise<AgentOutput> {
        executionWorkspace(r,this.data);
        const CAP = 3, transient = new Set(['DSH_HOST_TIMEOUT', 'RUNNER_RPC_ERROR', 'RPC_REQUEST_TIMEOUT']);
        let last: unknown = null;
        for (let segment = 0; segment < CAP; segment++) {
            if(this.pausing||this.store.run(r.id).state==='PAUSE_REQUESTED'){if(segment>0&&last instanceof DomainError)throw last;throw new DomainError('DISPATCH_PAUSED',409);}
            const tree = treeHash(input.workspace);
            const note = ' SEGMENT ' + (segment + 1) + '/' + CAP + ': the previous segment ended in a transport failure, not a review finding.'
                + ' Continue from the workspace that already exists (' + JSON.stringify(files(input.workspace).map(f => f.path)) + ').'
                + ' Do not restart completed work; stop after at most 8 tool calls or when the task is done.';
            const attempt: AgentInput = segment === 0 ? input : { ...input, prompt: JSON.stringify({ specHash: r.specHash, taskData: prompt + note, laya: decision.adoption === 'advisory' ? decision : null }) };
            if (segment > 0)
                this.update(r.id, 'role.segment.dispatch', current => reserveCall(current));
            try { return await runner.run(attempt, emit); }
            catch (error) {
                last = error;
                const code = error instanceof DomainError ? error.code : '';
                if (!transient.has(code) || treeHash(input.workspace) !== tree) throw error;
                this.store.record('ExecutorSegment', r.projectId, r.id, { segment: segment + 1, cap: CAP, code, treeHash: tree, at: now() });
                emit({ method: 'dm/executorSegment', params: { segment: segment + 1, cap: CAP, code } });
            }
        }
        throw last instanceof DomainError ? last : new DomainError('EXECUTOR_SEGMENT_LIMIT', 409);
    }
    private async settleMergeRecovery(rid:string,work:Promise<unknown>){
        try{await work;}catch(error){
            // A confirmed cancellation before publication can settle on exit. An OS/route failure
            // or interrupted publication remains uncertain and must reach the lifecycle caller.
            if(error instanceof DomainError&&error.code==='MERGE_RECOVERY_CANCELLED'&&!this.dispatch.hasUncertain(rid))return;
            throw error;
        }
    }
    pauseAll():Promise<void>{
        if(this.pauseWork)return this.pauseWork;this.pausing=true;
        const jobs=[...this.jobs.entries()],dataJobs=[...this.dataJobs.entries()],recoveries=[...this.mergeRecoveries.entries()],engineering=[...this.engineeringJobs.values(),...this.customProbeJobs.values()],admissionFailures:unknown[]=[];
        for(const job of engineering)job.controller.abort(new DomainError('APPLICATION_PAUSING',409));
        for(const [,job]of recoveries)job.controller.abort(new DomainError('APPLICATION_PAUSING',409));
        for(const [,job]of dataJobs)job.controller.abort(new DomainError('APPLICATION_PAUSING',409));
        // Persist the boundary before yielding: an already-queued completion continuation may
        // otherwise advance directly into verifier admission ahead of a deferred pause write.
        for(const [rid]of jobs){
            try{
                const current=this.store.run(rid);
                if(!['PAUSE_REQUESTED','PAUSED','BLOCKED','READY_FOR_DELIVERY',...TERMINAL].includes(current.state))this.pause(rid);
                this.dispatch.pauseQueued(rid);
            }catch(error){admissionFailures.push(error);}
        }
        this.pauseWork=Promise.resolve().then(async()=>{
            await Promise.allSettled([...this.reviewPreparations.values()]);
            // Finish only the already-started round under its existing duration/call/fee bounds.
            // No automatic continuation, retry segment, new run or source/lease reconciliation.
            const results=await Promise.allSettled([...jobs.map(([,job])=>job.promise),...dataJobs.map(([rid,job])=>job.promise.catch(error=>{if(this.dispatch.hasUncertain(rid))throw error;})),...recoveries.map(([rid,job])=>this.settleMergeRecovery(rid,job.promise)),...engineering.map(job=>job.promise.catch(error=>{if(this.dispatch.hasUncertain('acceptanceId' in job.input?job.input.acceptanceId:job.input.probeId))throw error;}))]),dispatch=this.dispatch.snapshot();
            const unresolved=this.store.runs().some(run=>['WORKER_RESTART_RESULT_UNCERTAIN','PROCESS_CLEANUP_UNPROVEN'].includes(run.reason??'')||run.mode==='live'&&run.state==='BLOCKED'&&(run.tasks.some(task=>task.status==='running')||['RUNNER_RPC_ERROR','RPC_REQUEST_TIMEOUT','DSH_HOST_TIMEOUT'].includes(run.reason??'')));
            if(admissionFailures.length||results.some(result=>result.status==='rejected')||this.activeJobCount||dispatch.active.length||dispatch.queued.length||dispatch.quarantined.length||unresolved)
                throw new DomainError('ENGINE_PAUSE_UNCERTAIN',409,'停止派发后仍有结果或清理未核清；原进度、费用与租约保留，没有宣告安全暂停。');
        });return this.pauseWork;
    }
    stopNativeRequests(){this.nativeExecution?.stopRequests?.();}
    async disposeNative(){await this.nativeExecution?.close();}
    async close(options:{deferNativeDisposal?:boolean}={}) {
        this.pausing=true;
        const jobs=[...this.jobs.entries()],dataJobs=[...this.dataJobs.entries()],recoveries=[...this.mergeRecoveries.entries()],engineering=[...this.engineeringJobs.values(),...this.customProbeJobs.values()];
        for(const job of engineering)job.controller.abort(new DomainError('APPLICATION_STOP_REQUESTED',409));
        for(const [,job]of recoveries)job.controller.abort(new DomainError('APPLICATION_STOP_REQUESTED',409));
        // A refusal to cancel one uncertain run must not leave another owned job running. Close
        // admission and signal every job before awaiting any individual cancellation or cleanup.
        const admission=this.dispatch.close();
        this.stopNativeRequests();
        for(const [,job]of jobs)job.controller.abort(new DomainError('APPLICATION_STOP_REQUESTED',409));
        for(const [,job]of dataJobs)job.controller.abort(new DomainError('APPLICATION_STOP_REQUESTED',409));
        const results=await Promise.allSettled([admission,...jobs.map(([rid])=>this.cancel(rid)),...jobs.map(([,job])=>job.promise),...dataJobs.map(([rid,job])=>job.promise.catch(error=>{if(this.dispatch.hasUncertain(rid))throw error;})),...recoveries.map(([rid,job])=>this.settleMergeRecovery(rid,job.promise)),...engineering.map(job=>job.promise.catch(error=>{if(this.dispatch.hasUncertain('acceptanceId' in job.input?job.input.acceptanceId:job.input.probeId))throw error;}))]);
        await Promise.allSettled([...this.reviewPreparations.values()]);
        try{await this.closeProbeDispatchQuarantine();}catch{/* The refusal below stays authoritative. */}
        const native=options.deferNativeDisposal?[]:await Promise.allSettled([this.disposeNative()]);
        if([...results,...native].some(result=>result.status==='rejected')||this.dispatch.snapshot().quarantined.some(row=>row.kind==='data-runtime'||row.acceptanceId!==undefined))throw new DomainError('ENGINE_CLOSE_UNCERTAIN',409,'已等待本实例任务收束，但至少一项清理未获证；原租约和记录保留。');
    }
}
