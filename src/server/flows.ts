import type { Config, LayaMode } from '../shared/types.js';
import { DomainError } from './security.js';
import type {EngineeringMode} from '../shared/flow-configuration.js';

// New engineering choices are classic/custom. Legacy names are read-only historical identities.
/** The execution roles a flow owns, in run order. planner1 is not a flow role. */
export const FLOW_ROLES = ['planner2', 'executor', 'reviewer'] as const;
export type FlowRole = typeof FLOW_ROLES[number];

export const FLOWS = ['classic','custom'] as const;
export const LEGACY_FLOWS=['dreamflow','dreamflow-laya'] as const;
export type LegacyFlowName=typeof LEGACY_FLOWS[number];
export type FlowName=EngineeringMode|LegacyFlowName;

export interface FlowDefinition {
    name: FlowName;
    /** What the block is called in operator-facing surfaces. */
    label: string;
    roles: readonly FlowRole[];
    /** Does this flow attach Laya to the role turns? false means "Laya cannot reach these turns". */
    layaCoupled: boolean;
    summary: string;
}

export const FLOW_DEFINITIONS: Record<FlowName, FlowDefinition> = {
    classic:{name:'classic',label:'经典 DreamFlow',roles:FLOW_ROLES,layaCoupled:false,summary:'Codex 规划、DSH 执行、独立 Codex 审查；可选 Laya，不经过 Magpie。'},
    custom:{name:'custom',label:'完全自定义 DreamFlow',roles:FLOW_ROLES,layaCoupled:false,summary:'逐角色和执行器选择账户、模型与运行器；使用专用安全 Magpie，不启用 Laya。'},
    dreamflow: {
        name: 'dreamflow',
        label: 'DreamFlow（不带 Laya）',
        roles: FLOW_ROLES,
        layaCoupled: false,
        summary: 'planner2 → executor → reviewer，三个角色都不经过 Laya，Laya 开关对这个流程无效。'
    },
    'dreamflow-laya': {
        name: 'dreamflow-laya',
        label: 'DreamFlow-Laya（带 Laya）',
        roles: FLOW_ROLES,
        layaCoupled: true,
        summary: '同样的 planner2 → executor → reviewer，但只要 Laya 处于 off 或三个角色全部退出，这个流程就不成立。'
    }
};

export interface FlowResolution {
    name: FlowName;
    label: string;
    roles: readonly FlowRole[];
    layaCoupled: boolean;
    /** What Laya will actually do for these roles, after the flow's own override. */
    layaMode: LayaMode;
    /** The effective per-role setting the flow will use. dreamflow keeps all three at 'off'. */
    layaRoles: Record<FlowRole, 'inherit' | 'off'>;
    /** '' when the flow can run as configured; otherwise the exact code that stops it. */
    blockedBy: '' | 'FLOW_UNKNOWN' | 'LAYA_DISABLED' | 'LAYA_ROLES_INCOMPLETE' | 'NATIVE_LAYA_BASELINE_REQUIRED' | 'NATIVE_LAYA_QUALIFICATION_REQUIRED' | 'CUSTOM_MAGPIE_SECURITY_REQUIRED' | 'CUSTOM_ROLE_QUALIFICATION_REQUIRED';
    /** May the controller persist a profile/preparation for this mode? This is not execution authority. */
    setupAllowed?:boolean;
    layaAvailable?:boolean;
    /** Can this flow carry a Live (native, receipt-bound) run as configured right now? */
    liveAllowed: boolean;
    /** One sentence a human can act on. Never a promise that the flow was used. */
    reason: string;
}

const offRoles = (): Record<FlowRole, 'inherit' | 'off'> => ({ planner2: 'off', executor: 'off', reviewer: 'off' });

/** Controller-owned, never an HTTP/config boolean: only a real forward qualification may open it. */
function layaQualified(probe:(()=>unknown)|undefined):boolean {
    if(!probe)return false;
    try{
        const value=probe();
        return !!value&&typeof value==='object'&&!Array.isArray(value)&&(value as {qualified?:unknown}).qualified===true;
    }catch{
        return false;
    }
}

const inherited = (config: Config): Record<FlowRole, 'inherit' | 'off'> =>
    ({ planner2: config.laya.roles.planner2, executor: config.laya.roles.executor, reviewer: config.laya.roles.reviewer });

/**
 * Resolve a flow name against a config. Pure: no clock, no network, no disk.
 *
 * `live` defaults to true because the audited path is the one that matters: a caller that is about
 * to run a native Live build must not be told "allowed" merely because it forgot to say where it is.
 */
function resolveLegacyFlow(name: LegacyFlowName, config: Config, opts: { live?: boolean; layaQualification?: () => unknown } = {}): FlowResolution {
    if (!Object.prototype.hasOwnProperty.call(FLOW_DEFINITIONS, name))
        throw new DomainError('FLOW_UNKNOWN', 400, '未知流程：' + String(name).slice(0, 64));
    const flow = FLOW_DEFINITIONS[name as FlowName];
    const base = { name: flow.name, label: flow.label, roles: flow.roles, layaCoupled: flow.layaCoupled };
    if (!flow.layaCoupled) {
        // dreamflow is the audited baseline: Laya is off for these roles whatever the config says.
        return {
            ...base,
            layaMode: 'off',
            layaRoles: offRoles(),
            blockedBy: '',
            liveAllowed: true,
            reason: '这个流程把三个执行角色固定在 Laya OFF，配置里的 Laya 开关对它不生效。'
        };
    }
    const mode = config.laya.mode, roles = inherited(config);
    const active = FLOW_ROLES.filter(role => roles[role] !== 'off');
    if (mode === 'off' || active.length === 0) {
        // Two ways to have no Laya at all: the layer is off, or every role opted out of it.
        return {
            ...base,
            layaMode: mode,
            layaRoles: roles,
            blockedBy: 'LAYA_DISABLED',
            liveAllowed: false,
            reason: mode === 'off'
                ? '这个流程要带 Laya，但 config.laya.mode 是 off，没有任何角色回合会走到 Laya。'
                : '这个流程要带 Laya，但 planner2/executor/reviewer 全部在 laya.roles 里选了 off。'
        };
    }
    if(active.length!==FLOW_ROLES.length)return {...base,layaMode:mode,layaRoles:roles,blockedBy:'LAYA_ROLES_INCOMPLETE',liveAllowed:false,
        reason:'增强流程需要规划、执行、审查三个角色都能使用辅助；也可以明确选择普通流程。'};
    if (opts.live !== false) {
        // Role receipts attest runner identity. A Live Laya-on run needs its own controller-owned
        // qualification: one real forward per engineering role, bound to the exact compiled source and
        // Laya configuration. Health checks or a config flag never substitute for that.
        if(!layaQualified(opts.layaQualification))return {
            ...base,
            layaMode: mode,
            layaRoles: roles,
            blockedBy: 'NATIVE_LAYA_QUALIFICATION_REQUIRED',
            liveAllowed: false,
            reason: '经典增强路径需要先完成真实的本地 Laya 三角色资格核验；健康检查或配置开关不能代替真实推理。'
        };
        return {
            ...base,
            layaMode: mode,
            layaRoles: roles,
            blockedBy: '',
            liveAllowed: true,
            reason: '已持有与当前源码和 Laya 配置匹配的增强资格；三个工程角色会各自经过一次真实本地推理。'
        };
    }
    return {
        ...base,
        layaMode: mode,
        layaRoles: roles,
        blockedBy: '',
        liveAllowed: true,
        reason: '降级路径下 Laya 以 ' + mode + ' 模式挂在这三个角色上，只有 ' + active.join('/') + ' 真正经过它。'
    };
}

type FlowResolveOptions={
    live?:boolean;
    laya?:boolean;
    /** Controller-owned Laya qualification probe. Never accept an HTTP/config boolean as this value. */
    layaQualification?:()=>unknown;
    /** Controller-owned runtime probe. Never accept an HTTP/config boolean as this value. */
    customRuntime?:()=>unknown;
};

function customRuntimeConnected(probe:(()=>unknown)|undefined):boolean {
    if(!probe)return false;
    try{
        const value=probe();
        return !!value&&typeof value==='object'&&!Array.isArray(value)&&(value as {connected?:unknown}).connected===true;
    }catch{
        return false;
    }
}

/** Legacy resolution exists for history only; Engine.create rejects legacy names for new runs. */
export function resolveFlow(name:string,config:Config,opts:FlowResolveOptions={}):FlowResolution {
    if(name==='dreamflow'||name==='dreamflow-laya')return resolveLegacyFlow(name,config,opts);
    if(name==='classic'){
        const selected=resolveLegacyFlow(opts.laya===true?'dreamflow-laya':'dreamflow',config,opts);
        return {...selected,name:'classic',label:FLOW_DEFINITIONS.classic.label,
            layaAvailable:resolveLegacyFlow('dreamflow-laya',config,opts).blockedBy==='',
            reason:opts.laya===true?selected.reason:'Codex 规划、DSH 执行、独立 Codex 审查；本轮不使用 Laya，不经过 Magpie。账户、模型及执行资格需另行核验。'};
    }
    if(name==='custom'){
        const connected=customRuntimeConnected(opts.customRuntime);
        return {name:'custom',label:FLOW_DEFINITIONS.custom.label,roles:FLOW_ROLES,layaCoupled:false,
            layaMode:'off',layaRoles:offRoles(),setupAllowed:connected,
            blockedBy:connected?'CUSTOM_ROLE_QUALIFICATION_REQUIRED':'CUSTOM_MAGPIE_SECURITY_REQUIRED',liveAllowed:false,
            reason:connected
                ?'自定义运行器与专用 Magpie 已接线；仍需为当前项目冻结账户、模型和运行器配置，并完成各角色真实资格核验后才能执行。'
                :'专用 Magpie 的原始入口授权与路由隔离尚未验证，自定义运行暂未连接。不会自动改走经典模式或读取现有账户。'};
    }
    throw new DomainError('FLOW_UNKNOWN',400,'请选择经典或完全自定义。');
}
/** Demo/Live cannot imply a different engineering mode or authorize Laya. */
export function flowForRunMode(_mode:string,_config:Config):EngineeringMode{return 'classic';}
export function flowCatalog(config:Config,opts:{live?:boolean;laya?:boolean;layaQualification?:()=>unknown}={},customRuntime?:()=>unknown):FlowResolution[]{
    return FLOWS.map(name=>resolveFlow(name,config,{...opts,customRuntime}));
}
