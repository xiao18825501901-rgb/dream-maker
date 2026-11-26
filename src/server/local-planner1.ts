import { randomBytes } from 'node:crypto';
import { arch, cpus, freemem, platform, totalmem } from 'node:os';
import type { Config } from '../shared/types.js';
import type { Store } from './store.js';
import { DomainError, hash, jsonFetch, object, redact } from './security.js';
import { planner1Binding, planner1BindingHash, type Planner1Binding } from './planner1-binding.js';
import {
    LOCAL_PLANNER1_BASE_URL,
    LOCAL_PLANNER1_CANDIDATES,
    LOCAL_PLANNER1_CAPABILITY_TTL_MS,
    LOCAL_PLANNER1_PROTOCOL
} from './local-planner1-contract.js';

const MIB = 1024 * 1024;
const UNKNOWN_MODEL_PROFILE = Object.freeze({
    model: 'CUSTOM',
    label: '自定义本地模型',
    license: null,
    source: null,
    minimumTotalMemoryMiB: 16 * 1024,
    minimumAvailableMemoryMiB: 8 * 1024,
    minimumCpuCores: 4
});

export interface LocalHardwareSnapshot {
    totalMemoryMiB:number;
    availableMemoryMiB:number;
    cpuCores:number;
    platform:string;
    architecture:string;
    sampledAt:string;
}

export interface LocalModelAssessment {
    model:string;
    label:string;
    license:string|null;
    source:string|null;
    minimumTotalMemoryMiB:number;
    minimumAvailableMemoryMiB:number;
    minimumCpuCores:number;
    supported:boolean;
    missing:string[];
}

export interface LocalPlanner1Capability {
    schema:'dream-maker.local-planner1-capability.v1';
    status:'PASSED';
    provider:'local';
    runner:'LOCAL_HTTP';
    authentication:'NONE';
    endpoint:string;
    model:string;
    bindingHash:string;
    checkedAt:string;
    responseId:string;
    responseHash:string;
    hardware:LocalHardwareSnapshot;
}

export interface LocalPlanner1Status {
    schema:'dream-maker.local-planner1-status.v1';
    planner1:{mode:'LOCAL_ONLY';endpoint:string;model:string|null;cloudFallback:false;requestsOtherAccounts:false};
    hardware:LocalHardwareSnapshot;
    models:LocalModelAssessment[];
    recommendedModel:string|null;
    otherRoles:Array<{role:string;configuration:string;network:string;separateApproval:true}>;
    projectDependencies:{status:'NOT_PREDETERMINED';note:string};
    limits:string[];
}

function hardwareSnapshot():LocalHardwareSnapshot {
    return {
        totalMemoryMiB:Math.floor(totalmem()/MIB),
        availableMemoryMiB:Math.floor(freemem()/MIB),
        cpuCores:Math.max(1,cpus().length),
        platform:platform(),
        architecture:arch(),
        sampledAt:new Date().toISOString()
    };
}

function profile(model:string) {
    return LOCAL_PLANNER1_CANDIDATES.find(item=>item.model===model)??{...UNKNOWN_MODEL_PROFILE,model};
}

export function assessLocalPlanner1Hardware(model:string,hardware=hardwareSnapshot()):LocalModelAssessment {
    const selected=profile(model),missing:string[]=[];
    if(hardware.totalMemoryMiB<selected.minimumTotalMemoryMiB)missing.push('TOTAL_MEMORY');
    if(hardware.availableMemoryMiB<selected.minimumAvailableMemoryMiB)missing.push('AVAILABLE_MEMORY');
    if(hardware.cpuCores<selected.minimumCpuCores)missing.push('CPU_CORES');
    return {...selected,supported:missing.length===0,missing};
}

function otherRoles(config:Config):LocalPlanner1Status['otherRoles'] {
    const p2=config.codex.model||'未配置';
    return [
        {role:'planner2',configuration:`Codex 工程运行器 / ${p2}`,network:'按 Codex 官方账户和服务条件单独核验',separateApproval:true},
        {role:'executor',configuration:`DSH / ${config.dsh.model}`,network:'按 DeepSeek 官方服务条件单独核验',separateApproval:true},
        {role:'reviewer',configuration:`Codex 工程运行器 / ${p2}`,network:'按 Codex 官方账户和服务条件单独核验',separateApproval:true},
        {role:'laya',configuration:`Laya ${config.laya.mode}`,network:'未安装也可使用普通经典流程',separateApproval:true}
    ];
}

export function localPlanner1Status(config:Config,hardware=hardwareSnapshot()):LocalPlanner1Status {
    const binding=planner1Binding(config),models=LOCAL_PLANNER1_CANDIDATES.map(item=>assessLocalPlanner1Hardware(item.model,hardware));
    return {
        schema:'dream-maker.local-planner1-status.v1',
        planner1:{mode:'LOCAL_ONLY',endpoint:LOCAL_PLANNER1_BASE_URL,model:binding.provider==='local'?binding.model:null,cloudFallback:false,requestsOtherAccounts:false},
        hardware,models,recommendedModel:models.find(item=>item.supported)?.model??null,
        otherRoles:otherRoles(config),
        projectDependencies:{status:'NOT_PREDETERMINED',note:'本地方案助手不代表生成项目无需联网、账户、硬件或外部服务；实际依赖必须随方案单独列出。'},
        limits:['使用固定回环地址，不接受界面提交任意端点。','能力不足时停止本地调用，不自动切换云端或其他模型。','本地运行不代表与云端模型效果相同。']
    };
}

export class LocalPlanner1Runtime {
    constructor(
        private request:typeof jsonFetch=jsonFetch,
        private sampleHardware:()=>LocalHardwareSnapshot=hardwareSnapshot,
        private clock:()=>number=Date.now
    ){}

    status(config:Config):LocalPlanner1Status { return localPlanner1Status(config,this.sampleHardware()); }

    private async installedModels(signal?:AbortSignal):Promise<string[]> {
        const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
        let result:Record<string,unknown>;
        try {
            result=await this.request(LOCAL_PLANNER1_BASE_URL+'/models',{method:'GET',signal:combined});
        }catch(error) {
            if(signal?.aborted)throw new DomainError('LOCAL_PLANNER1_CHECK_CANCELLED',409);
            const code=(error as {code?:unknown}).code;
            throw new DomainError(typeof code==='string'&&/^[A-Z0-9_]{1,100}$/.test(code)?code:'LOCAL_PLANNER1_SERVICE_UNAVAILABLE',503);
        }
        if(!Array.isArray(result.data)||result.data.length>1000)throw new DomainError('LOCAL_PLANNER1_CATALOG_INVALID',502);
        const models=result.data.map(item=>object(item)).map(item=>typeof item.id==='string'?item.id:'').filter(Boolean);
        if(models.some(model=>model.length>200))throw new DomainError('LOCAL_PLANNER1_CATALOG_INVALID',502);
        return [...new Set(models)].sort();
    }

    /**
     * Models this process has already proven runnable on this machine.
     *
     * The headroom rule asks "is there enough free memory to LOAD this model". Once a model is
     * loaded, the memory it needs is already spent and the free figure necessarily sits below that
     * threshold — so applying the load-time rule again refuses the very model that is answering.
     * That is what made a passing capability check followed immediately by a refusal look like a
     * contradiction. Remembering the proof keeps the rule honest without adding a network call,
     * which the "no local request before the hardware gate" contract forbids.
     */
    private provenRunnable = new Set<string>();

    async assertReady(model:string,signal?:AbortSignal):Promise<{hardware:LocalHardwareSnapshot;installedModels:string[]}> {
        if(!model.trim())throw new DomainError('LOCAL_PLANNER1_MODEL_REQUIRED',409);
        const hardware=this.sampleHardware(),assessment=assessLocalPlanner1Hardware(model,hardware);
        if(!assessment.supported&&!this.provenRunnable.has(model))throw new DomainError('LOCAL_PLANNER1_HARDWARE_INSUFFICIENT',409,'这台电脑当前可用资源不足以运行所选本地模型；不会自动切换到云端。');
        const installedModels=await this.installedModels(signal);
        if(!installedModels.includes(model))throw new DomainError('LOCAL_PLANNER1_MODEL_NOT_INSTALLED',409,'Ollama 中没有所选模型；请按官方来源安装后再检查。');
        this.provenRunnable.add(model);
        return{hardware,installedModels};
    }

    /**
     * The probe loads the model. Without keep_alive:0 Ollama keeps it resident for five minutes,
     * so the very next assertReady samples a machine the probe itself just filled — and refuses
     * the model the probe had just proven usable. Release it as soon as the probe answers: a
     * diagnosis must not consume the resource it is diagnosing.
     */
    async check(model:string,signal?:AbortSignal):Promise<LocalPlanner1Capability> {
        const {hardware}=await this.assertReady(model,signal),challenge='DM_LOCAL_PROBE_'+randomBytes(16).toString('hex');
        const body={model,messages:[{role:'system',content:'Return exactly the requested JSON object. No markdown, tools or explanation.'},{role:'user',content:JSON.stringify({probe:challenge})}],temperature:0,max_tokens:96,keep_alive:0};
        const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000);
        let result:Record<string,unknown>;
        try {
            result=await this.request(LOCAL_PLANNER1_BASE_URL+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:combined});
        }catch(error) {
            if(signal?.aborted)throw new DomainError('LOCAL_PLANNER1_CHECK_CANCELLED',409);
            const code=(error as {code?:unknown}).code;
            throw new DomainError(typeof code==='string'&&/^[A-Z0-9_]{1,100}$/.test(code)?code:'LOCAL_PLANNER1_CHECK_FAILED',502);
        }
        const choices=Array.isArray(result.choices)?result.choices:[],first=choices.length===1?object(choices[0]):null,message=first?object(first.message):null;
        let parsed:Record<string,unknown>;
        try { parsed=object(JSON.parse(redact(typeof message?.content==='string'?message.content:''))); }
        catch { throw new DomainError('LOCAL_PLANNER1_OUTPUT_NOT_JSON',502); }
        if(result.model!==model||first?.finish_reason!=='stop'||parsed.probe!==challenge||typeof result.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(result.id))
            throw new DomainError('LOCAL_PLANNER1_CAPABILITY_INVALID',502);
        return{schema:'dream-maker.local-planner1-capability.v1',status:'PASSED',provider:'local',runner:'LOCAL_HTTP',authentication:'NONE',
            endpoint:LOCAL_PLANNER1_BASE_URL,model,bindingHash:'',checkedAt:new Date(this.clock()).toISOString(),responseId:result.id,responseHash:hash(result),hardware};
    }
}

export function recordLocalPlanner1Capability(store:Store,binding:Planner1Binding,evidence:LocalPlanner1Capability):LocalPlanner1Capability&{recordId:string} {
    if(binding.provider!=='local'||binding.runner!=='local-http'||binding.authMethod!=='none'||evidence.model!==binding.model)
        throw new DomainError('LOCAL_PLANNER1_BINDING_CHANGED',409);
    const value={...evidence,bindingHash:planner1BindingHash(binding)};
    const recordId=store.record('Planner1LocalCapability',null,null,value);
    return{...value,recordId};
}

export function currentLocalPlanner1Capability(store:Store,binding:Planner1Binding,at=Date.now()):LocalPlanner1Capability|null {
    const row=store.db.prepare("SELECT data FROM records WHERE kind='Planner1LocalCapability' AND project_id IS NULL AND run_id IS NULL ORDER BY rowid DESC LIMIT 1").get() as {data?:unknown}|undefined;
    if(!row||typeof row.data!=='string'||Buffer.byteLength(row.data)>12000)return null;
    try {
        const value=object(JSON.parse(row.data));
        if(value.schema!=='dream-maker.local-planner1-capability.v1'||value.status!=='PASSED'||value.provider!=='local'||
            value.runner!=='LOCAL_HTTP'||value.authentication!=='NONE'||value.endpoint!==LOCAL_PLANNER1_BASE_URL||
            value.model!==binding.model||value.bindingHash!==planner1BindingHash(binding)||typeof value.checkedAt!=='string')
            return null;
        const checkedAt=Date.parse(value.checkedAt);
        if(!Number.isFinite(checkedAt)||checkedAt>at||at-checkedAt>LOCAL_PLANNER1_CAPABILITY_TTL_MS)return null;
        return value as unknown as LocalPlanner1Capability;
    }catch{return null;}
}

export function assertLocalPlanner1Capability(store:Store,binding:Planner1Binding):void {
    if(binding.provider!=='local')return;
    if(binding.runner!=='local-http'||binding.authMethod!=='none'||binding.protocolHash!==hash({baseUrl:LOCAL_PLANNER1_BASE_URL,protocol:LOCAL_PLANNER1_PROTOCOL}))
        throw new DomainError('LOCAL_PLANNER1_BINDING_INVALID',409);
    if(!currentLocalPlanner1Capability(store,binding))
        throw new DomainError('LOCAL_PLANNER1_CAPABILITY_CHECK_REQUIRED',409,'请先在设置页完成本机资源、Ollama 模型和一次最小真实调用检查；不会自动改用云端。');
}
