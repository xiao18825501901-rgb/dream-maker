import {existsSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import type {Config,Role} from '../shared/types.js';
import type {Product} from '../shared/product.js';
import type {SetupGate,SetupRole,SetupSnapshot,SpendingHistory,UserBudgetSnapshot} from '../shared/onboarding.js';
import type {KimiStatus} from './kimi-status.js';
import {planner1Binding,isRetiredProvider} from './planner1-binding.js';
import {rolePolicyBinding} from './role-policy.js';
import {hasSecret} from './security.js';
import {roleMetadata} from '../shared/role-names.js';
const row=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const gate=(state:SetupGate['state'],message:string):SetupGate=>({state,message});
const model=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<200&&!hasSecret(value)?value:null;
function userBudgetProjection(raw:unknown):UserBudgetSnapshot|undefined {
    const input=row(raw);if(typeof input.configured!=='boolean'||typeof input.unlimited!=='boolean'||input.basis!=='FUTURE_REQUESTS_SINCE_EXPLICIT_ACTIVATION'||count(input.revision)===null||count(input.baselineRequests)===null)return;
    const limits=row(input.limits),byCurrency={} as UserBudgetSnapshot['byCurrency'];
    for(const currency of ['CNY','USD'] as const){const use=row(row(input.byCurrency)[currency]);
        const uncapped=limits[currency]===null;
        if(!uncapped&&count(limits[currency])===null||[use.committedMicros,use.reservedMicros].some(n=>count(n)===null)||
            (uncapped?use.remainingMicros!==null||use.exceeded!==false:count(use.remainingMicros)===null)||typeof use.exceeded!=='boolean')return;
        byCurrency[currency]={committedMicros:use.committedMicros as number,reservedMicros:use.reservedMicros as number,remainingMicros:use.remainingMicros as number|null,exceeded:use.exceeded};
    }
    const startedAt=typeof input.startedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.startedAt)?input.startedAt:null;
    if(input.configured===true&&(!startedAt||input.revision===0))return;
    const unlimited=limits.CNY===null||limits.USD===null;if(input.unlimited!==unlimited||unlimited&&!input.configured)return;
    return {configured:input.configured,unlimited,revision:input.revision as number,limits:{CNY:limits.CNY as number|null,USD:limits.USD as number|null},baselineRequests:input.baselineRequests as number,startedAt,basis:'FUTURE_REQUESTS_SINCE_EXPLICIT_ACTIVATION',byCurrency};
}
export function spendingHistory(value:unknown):SpendingHistory {
    const input=row(value),byCurrency:SpendingHistory['byCurrency']={};
    for(const currency of ['CNY','USD'] as const){const values=row(row(input.byCurrency)[currency]);if(Object.keys(values).length)byCurrency[currency]={committedMicros:count(values.committedMicros),reservedMicros:count(values.reservedMicros)};}
    return {status:input.status==='HISTORY_ONLY'?'HISTORY_ONLY':'UNAVAILABLE',mode:input.mode==='CAPPED'||input.mode==='UNCAPPED'?input.mode:null,requests:count(input.requests),maxRequests:count(input.maxRequests),byCurrency};
}
/** Read-only projection. No network, model dispatch, login, approval, balance inference or writes. */
export function setupSnapshot(input:{product:Product;config:Config;keyPresent:boolean;probe:unknown;budget:unknown;kimi?:KimiStatus;safetyReady:boolean}):SetupSnapshot {
    const c=input.config,p1=input.product==='dreamflow'?null:planner1Binding(c),policy=rolePolicyBinding(c);
    const required:Role[]=p1?['planner1','planner2','executor','reviewer']:['planner2','executor','reviewer'];
    const observations=row(row(input.probe).evidence),validity=row(row(input.probe).roles);
    const titles:Record<Role,string>={planner1:'方案与需求',planner2:'工程规划',executor:'执行制作',reviewer:'独立审查'};
    const roles=(['planner1','planner2','executor','reviewer'] as Role[]).map((role):SetupRole=>{
        if(role==='planner1'&&!p1){const unused=gate('NOT_REQUIRED','由你提供完整方案，不运行需求访谈模型。');return {role,displayName:roleMetadata(role).displayName,title:'你提供方案',required:false,provider:'USER',runner:'USER',targetModel:null,actualModel:null,installation:unused,authentication:unused,quota:unused,inference:unused,evidence:null};}
        const apiP1=role==='planner1'&&p1!.runner==='http-api';
        const localP1=role==='planner1'&&p1!.provider==='local';
        const runner=role==='planner1'?(localP1?'LOCAL_HTTP':apiP1?'LLM_API':'KIMI_SERVER'):role==='executor'?'DSH':'CODEX';
        const provider=role==='planner1'?(localP1?'local-ollama':p1!.provider):role==='executor'?'deepseek-official':'openai';
        const target=model(role==='planner1'?p1!.model:policy.models[role]);
        const observed=row(observations[role]),actual=model(observed.model);
        const evidenceId=typeof observed.evidenceId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(observed.evidenceId)&&!hasSecret(observed.evidenceId)?observed.evidenceId:null;
        const at=typeof observed.at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observed.at)&&Number.isFinite(Date.parse(observed.at))?observed.at:null;
        const expectedAuth=role==='planner1'?(localP1?'NONE':apiP1?'API_KEY':'MEMBER_SUBSCRIPTION'):role==='executor'?'API_KEY':'CHATGPT_SUBSCRIPTION';
        const expectedProvider=role==='planner1'?(localP1?'local-ollama':apiP1?p1!.provider+'-official':'kimi-official'):provider;
        const valid=!!evidenceId&&!!at&&actual!==null&&row(validity[role]).valid===true&&actual===target&&observed.runner===runner&&observed.provider===expectedProvider&&observed.authentication===expectedAuth;
        const configured=role==='planner1'?(localP1||apiP1?!!p1!.model:c.kimi?.enabled===true):role==='executor'?!!c.dsh.modulePath:!!(c.codex.transport==='wsl'?c.codex.wslBinary:c.codex.command);
        const absentFile=role==='executor'&&!!c.dsh.modulePath&&(!isAbsolute(c.dsh.modulePath)||!existsSync(c.dsh.modulePath));
        const installation=valid?gate('EVIDENCE_AVAILABLE','运行组件在当前有效的最小调用记录中返回过结果。'):absentFile?gate('MISSING','尚未找到配置的执行组件；先检查安装，凭据不能代替工具。'):configured?gate('CONFIGURED_UNVERIFIED','已配置运行组件，尚未据当前证据确认可以使用。'):gate('MISSING','运行组件尚未配置。');
        let authentication=valid?gate('EVIDENCE_AVAILABLE','最小调用记录包含相符的账户认证类型。'):gate('UNKNOWN','尚未核验账户；缓存登录或设置名称不表示已连接。');
        if(!valid&&role==='executor'&&input.keyPresent)authentication=gate('CONFIGURED_UNVERIFIED','已提供本机凭据，尚未验证可用性；页面不会显示凭据。');
        if(!valid&&localP1)authentication=gate('NOT_REQUIRED','本机模型不要求账户登录或 API Key；仍需核对已安装模型、硬件和一次真实能力检查。');
        if(!valid&&role==='planner1'&&!apiP1&&!localP1&&input.kimi?.credentials?.state==='OK')authentication=gate('CONFIGURED_UNVERIFIED','已有本机账户记录；还需核对连接、有效期和使用许可。');
        if(!valid&&role==='planner1'&&!apiP1&&!localP1&&input.kimi?.lastAuthFailure)authentication=gate('BLOCKED','账户或连接上一次未获通过；先核对具体问题，不自动要求重新登录。');
        let quota=valid?gate('EVIDENCE_AVAILABLE','最小调用时的使用许可有记录，当前余额和余量仍须核对。'):gate('UNKNOWN','额度或计费资格尚未核验，不视为免费或不限量。');
        if(localP1)quota=valid?gate('EVIDENCE_AVAILABLE','本机模型不消耗云端账户额度；仍不代表其他角色或项目依赖可以在本机离线运行。'):gate('UNKNOWN','本机模型不要求云端账户额度；仍需核对硬件、存储、模型许可和实际运行条件。');
        if(role==='planner1'&&!apiP1&&!localP1&&input.kimi?.admission?.allowsSend!==true)quota=gate('BLOCKED','会员使用与禁止额外消费的许可尚未满足。');
        let inference=valid?gate('EVIDENCE_AVAILABLE','当前最小调用证据有效；不是完整制作或审查验收。'):actual?gate('BLOCKED','已有模型证据与当前目标或角色不相符，未自动替换。'):gate('UNKNOWN','没有当前有效的最小调用证据。');
        if(role==='planner1'&&isRetiredProvider(p1!.provider,p1!.bindingVersion)){authentication=gate('BLOCKED','这是保留的旧方案助手配置；不会静默换提供方。');inference=gate('BLOCKED','当前方案助手配置不接受新调用，请先完成来源设置。');}
        const evidence=valid&&evidenceId&&at?{id:evidenceId,at}:null;
        return {role,displayName:roleMetadata(role).displayName,title:titles[role],required:true,provider,runner,targetModel:target||null,actualModel:actual,installation,authentication,quota,inference,evidence};
    });
    const userBudget=userBudgetProjection(row(input.budget).userBudget);
    return {schema:'dream-maker.setup.v1',product:input.product,requiredRoles:required,roles,optionalLaya:{required:false,availableToChoose:true,configuredMode:c.laya.mode,actualService:'NOT_CHECKED'},
        safety:input.safetyReady?gate('EVIDENCE_AVAILABLE','已有基础审计记录；执行时还会核对当前来源和权限。'):gate('BLOCKED','真实制作的本机安全检查尚未就绪；方案和已有成果可以先保存。'),
        fees:{ordinaryUserDefault:{configured:userBudget?.configured===true,unlimited:false,automaticRecharge:false,extraUsage:false},existingScope:spendingHistory(input.budget),userBudget,userBudgetAvailable:!!userBudget,note:'普通用户需自行设置费用限制；历史开发授权单独显示，不会作为普通用户默认。币种分别列出，未知余量不视为免费。'},
        automaticActions:false,modelCalls:0,fullFlowAcceptance:'NOT_RUN'};
}
