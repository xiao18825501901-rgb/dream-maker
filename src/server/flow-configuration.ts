import type {Config,PlanVersion,Run} from '../shared/types.js';
import type {ClassicFlowConfigSnapshot,CustomFlowConfigSnapshot,RoleBinding} from '../shared/flow-configuration.js';
import type {FlowProfileVersion} from '../shared/flow-profile.js';
import type {RoleSelection} from '../shared/project-roles.js';
import type {EngineRole} from '../shared/engine-mode.js';
import {customFlowProfile} from './flow-profiles.js';
import {DomainError,hash,object} from './security.js';

/** Only engineering inputs bind a new Flow. P1 changes do not reconfigure its agents. */
export function engineeringFingerprint(config:Config,layaEnabled:boolean):string {
    const {planner1:_planner1,kimi:_kimi,...engineering}=config;
    const {planner1:_p1Role,...roles}=config.laya.roles;
    return hash({...engineering,laya:layaEnabled?{...config.laya,roles}:{mode:'off'}});
}

function immutable<T>(value:T):T {
    if(value&&typeof value==='object'){
        for(const child of Object.values(value))immutable(child);
        Object.freeze(value);
    }
    return value;
}

/** Built from the actual controller configuration and approved Store plan, never HTTP booleans. */
export function classicFlowSnapshot(config:Config,plan:PlanVersion,runId:string,layaEnabled:boolean):ClassicFlowConfigSnapshot {
    if(!plan.approval)throw new DomainError('PLAN_VERSION_APPROVAL_REQUIRED',409);
    const codex=(role:'planner2'|'reviewer'):RoleBinding=>({id:role,runtime:'codex-app-server',provider:'openai',
        model:config.codex.model||'UNKNOWN',authentication:'CHATGPT_SUBSCRIPTION',accountRef:'UNKNOWN',serviceIdentity:'NOT_VERIFIED',
        transport:'native',permissions:['source_read']});
    return immutable({schema:'dream-maker.flow-config.v1',mode:'classic',projectId:plan.projectId,runId,
        plan:{versionId:plan.id,revision:plan.revision,contentHash:plan.contentHash,specHash:plan.specHash},
        roles:{planner2:codex('planner2'),reviewer:codex('reviewer'),executors:[{id:'executor-1',runtime:'dsh',provider:'deepseek-official',
            model:config.dsh.model||'UNKNOWN',authentication:'API_KEY',accountRef:'UNKNOWN',serviceIdentity:'NOT_VERIFIED',
            transport:'native',permissions:['source_read','source_write']}]},
        laya:{enabled:layaEnabled,mode:layaEnabled?config.laya.mode:'off',roles:layaEnabled?['planner2','executor-1','reviewer']:[]},
        magpie:null,configurationFingerprint:engineeringFingerprint(config,layaEnabled)});
}

/**
 * The runtime each classic binding already carries, with the harnesses that mean that runtime.
 * A classic binding is one runtime plus its provider / authentication / transport evidence, so the
 * compile may only accept a harness that keeps that route; any other harness belongs to Custom.
 */
const CLASSIC_ROLE_LANES:Readonly<Record<'planner2'|'executor'|'reviewer',{runtime:RoleBinding['runtime'];harnesses:readonly string[]}>>=Object.freeze({
    planner2:Object.freeze({runtime:'codex-app-server' as const,harnesses:Object.freeze(['codex-app-server','codex'])}),
    reviewer:Object.freeze({runtime:'codex-app-server' as const,harnesses:Object.freeze(['codex-app-server','codex'])}),
    executor:Object.freeze({runtime:'dsh' as const,harnesses:Object.freeze(['dsh'])})
});

export interface CompiledClassicRole {role:'planner2'|'executor'|'reviewer';runtime:RoleBinding['runtime'];model:string}

/**
 * The compile step between the project-level role record and the run's frozen Flow.
 *
 * The argument is the project's latest ProjectRoleConfiguration revision (the same validated chain
 * the workbench reads), or null when the project never saved one. A null record returns the
 * snapshot itself, so a project that never touched its roles keeps the classic bindings unchanged.
 *
 * For a saved record only the field a classic binding can carry is taken over: the model, and only
 * on the harness that already means this role's lane. The runtime is written from that lane; the
 * provider / authentication / transport / permissions stay at their classic defaults, because the
 * saved record contains no provider, account or authentication proof - inventing one would be an
 * evidence claim the record does not make. A harness outside the lane (for example a DSH planner2)
 * is not representable in a classic run and stays at the classic default; the engine decision
 * already reports such a project as Custom, and a classic run must not pretend otherwise.
 *
 * The result is a new frozen object; the plan, run id, mode and classic configuration fingerprint
 * are carried over unchanged, so an open run keeps its own frozen copy and engineeringFingerprint
 * keeps its existing meaning.
 */
export function compileClassicRoleConfiguration(snapshot:ClassicFlowConfigSnapshot,saved:Readonly<Record<EngineRole,RoleSelection>>|null):ClassicFlowConfigSnapshot {
    if(!saved)return snapshot;
    const compiled:CompiledClassicRole[]=[];
    const refine=(role:'planner2'|'executor'|'reviewer',binding:RoleBinding):RoleBinding=>{
        const lane=CLASSIC_ROLE_LANES[role],selection=saved[role],harness=selection.harness||lane.harnesses[0],model=selection.model||binding.model;
        if(!lane.harnesses.includes(harness))return binding;
        if(model===binding.model&&lane.runtime===binding.runtime)return binding;
        compiled.push({role,runtime:lane.runtime,model});
        return Object.freeze({...binding,runtime:lane.runtime,model});
    };
    const planner2=refine('planner2',snapshot.roles.planner2),reviewer=refine('reviewer',snapshot.roles.reviewer);
    const executor=snapshot.roles.executors.length===1?refine('executor',snapshot.roles.executors[0]):undefined;
    // One stderr line for the same reason EXECUTOR_WORKSPACE exists: the operator can see what a
    // created run actually froze. An empty list means the record was read and nothing was copied.
    process.stderr.write('ROLE_CONFIG_COMPILED '+JSON.stringify({projectId:snapshot.projectId,roles:compiled})+'\n');
    if(!compiled.length)return snapshot;
    return immutable({...snapshot,roles:{planner2,executors:executor?[executor]:[...snapshot.roles.executors],reviewer}});
}

export function customEngineeringFingerprint(config:Config,profileHash:string):string {
 return hash({engineering:engineeringFingerprint(config,false),profileHash});
}
/** Source selections from the immutable original Store profile, never client proof fields. */
export function customFlowSnapshot(config:Config,plan:PlanVersion,runId:string,profile:FlowProfileVersion):CustomFlowConfigSnapshot {
 if(!plan.approval)throw new DomainError('PLAN_VERSION_APPROVAL_REQUIRED',409);
 const {contentHash,...body}=profile;
 if(profile.projectId!==plan.projectId||profile.schema!=='dream-maker.custom-profile-version.v1'||profile.scope!=='CONFIGURATION_ONLY'||profile.executionGranted!==false||profile.serviceIdentity!=='NOT_VERIFIED'||hash(body)!==contentHash)throw new DomainError('FLOW_PROFILE_INTEGRITY_FAILED',409);
 const selection=customFlowProfile(profile.configuration);
 return immutable({...selection,schema:'dream-maker.flow-config.v2',mode:'custom',projectId:plan.projectId,runId,
  plan:{versionId:plan.id,revision:plan.revision,contentHash:plan.contentHash,specHash:plan.specHash},profile:{revision:profile.revision,contentHash},
  laya:{enabled:false,mode:'off',roles:[]},magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:customEngineeringFingerprint(config,contentHash)});
}
/** Exact Custom shape is shared by original run loading and preparation readback. */
export function assertCustomSnapshot(raw:unknown):asserts raw is CustomFlowConfigSnapshot {
 const fail=():never=>{throw new DomainError('FLOW_CONFIG_INTEGRITY_FAILED',409);};
 try{
  const v=object(raw),plan=object(v.plan),profile=object(v.profile),laya=object(v.laya),magpie=object(v.magpie),keys=['schema','mode','projectId','runId','plan','profile','accounts','roles','groups','privacy','budget','timeZone','laya','magpie','qualification','configurationFingerprint'];
  const exact=(value:Record<string,unknown>,fields:string[])=>Reflect.ownKeys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
  const ref=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value),digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  if(!exact(v,keys)||v.schema!=='dream-maker.flow-config.v2'||v.mode!=='custom'||!ref(v.projectId)||!ref(v.runId)||!digest(v.configurationFingerprint)||!exact(plan,['versionId','revision','contentHash','specHash'])||!ref(plan.versionId)||!Number.isSafeInteger(plan.revision)||Number(plan.revision)<1||!digest(plan.contentHash)||!digest(plan.specHash)||!exact(profile,['revision','contentHash'])||!Number.isSafeInteger(profile.revision)||Number(profile.revision)<1||Number(profile.revision)>128||!digest(profile.contentHash)||v.qualification!=='NOT_VERIFIED'||!exact(laya,['enabled','mode','roles'])||laya.enabled!==false||laya.mode!=='off'||!Array.isArray(laya.roles)||laya.roles.length!==0||!exact(magpie,['ownership','routing'])||magpie.ownership!=='DM_ONLY'||magpie.routing!=='MODELS_ONLY')return fail();
  customFlowProfile({mode:'custom',laya:false,accounts:v.accounts,roles:v.roles,groups:v.groups,privacy:v.privacy,budget:v.budget,timeZone:v.timeZone});
 }catch{return fail();}
}

/** Also used after a restart; no migration renames a historical run or fabricates this field. */
export function assertFlowSnapshot(run:Run):void {
    const snapshot=run.flowConfig;
    if(!snapshot){
        if(run.flowName==='classic'||run.flowName==='custom'||run.flowConfigHash)throw new DomainError('FLOW_CONFIG_INTEGRITY_FAILED',409);
        return;
    }
    if(snapshot.mode==='custom')assertCustomSnapshot(snapshot);
    else if(snapshot.schema!=='dream-maker.flow-config.v1'||snapshot.mode!=='classic')throw new DomainError('FLOW_CONFIG_INTEGRITY_FAILED',409);
    if(snapshot.mode!==run.flowName||snapshot.projectId!==run.projectId||snapshot.runId!==run.id
        ||snapshot.plan.versionId!==run.planVersionId||snapshot.plan.contentHash!==run.planVersionHash||snapshot.plan.specHash!==run.specHash
        ||run.flowConfigHash!==hash(snapshot)||snapshot.configurationFingerprint!==run.configFingerprint)
        throw new DomainError('FLOW_CONFIG_INTEGRITY_FAILED',409);
}
/** One fingerprint rule for Engine admission and executor tools, including historical runs. */
export function runConfigurationFingerprint(run:Run,config:Config):string {
    assertFlowSnapshot(run);
    return run.flowConfig?.mode==='custom'?customEngineeringFingerprint(config,run.flowConfig.profile.contentHash):run.flowConfig?engineeringFingerprint(config,run.flowConfig.laya.enabled):hash(config);
}
export function runUsesLaya(run:Run):boolean {
    assertFlowSnapshot(run);
    return run.flowConfig?run.flowConfig.mode==='classic'&&run.flowConfig.laya.enabled:run.flowName==='dreamflow-laya';
}
