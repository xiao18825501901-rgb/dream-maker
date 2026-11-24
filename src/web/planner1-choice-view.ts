import {escapeHtml as e,UiError,type PublicConfig} from './contracts.js';
/** Supported selection only. This form never collects credentials or claims an authenticated model. */
export function planner1ChoiceForm(settings:PublicConfig,modelDraft?:string):string {
 const binding=settings.planner1Binding,provider=binding?.provider??settings.config.planner1.provider??'openai';
 const selected=provider==='kimi'?'kimi:oauth':provider==='local'?'local:none':provider==='deepseek'?'deepseek:api_key':'openai:api_key';
 const localCheck=provider==='local'?'<button type="button" data-action="planner1-local-check">检查本机与已安装模型</button>':'';
 return `<h2 id="dialog-title">选择方案助手</h2><form id="planner1-choice-form" data-current-choice="${e(selected)}"><p id="p1-choice-explanation">方案助手独立于经典和完全自定义工程模式。保存只改变后续新项目的选择；已有项目保留原账户与模型记录。</p><label for="p1-choice-provider">连接方式</label><select id="p1-choice-provider" name="p1ChoiceProvider" aria-describedby="p1-choice-explanation">${[['kimi:oauth','Kimi 官方账户登录'],['openai:api_key','OpenAI API Key · 高级'],['deepseek:api_key','DeepSeek API Key · 高级'],['local:none','本机 Ollama · 可选']].map(([value,title])=>`<option value="${value}" ${selected===value?'selected':''}>${title}</option>`).join('')}</select><p class="hint">官方 OAuth 不会用网页 Cookie 代替；API Key 只通过本机凭据入口配置。本地 Ollama 使用固定地址 <code>127.0.0.1:11434</code>，不接受任意端点。</p><label for="p1-choice-model">账户或本机模型 ID</label><input id="p1-choice-model" name="p1ChoiceModel" data-draft="p1-choice-model:${e(selected)}" value="${e(modelDraft??binding?.model??settings.config.planner1.model)}" maxlength="100" required autocomplete="off" spellcheck="false"><p class="hint">填写账户可用的模型标识或 Ollama 中已安装的模型，例如 qwen2.5:7b。保存本身不会请求模型。</p><p class="hint">本地模式只替换方案助手这一个角色。Planner、Executor、Reviewer、Laya 和项目依赖仍分别显示、分别核验；本机能力不足时不会自动改用云端。</p><label class="check"><input type="checkbox" name="p1ChoiceConsent" required>我确认服务、账户或本机运行方式及可能的费用路径；保存不代表已连接成功。</label><div class="actions"><button type="submit">保存选择</button>${localCheck}<button type="button" data-action="close-modal">取消</button></div></form>`;
}

export interface LocalPlanner1CheckView {
 status:'PASSED';
 model:string;
 endpoint:string;
 responseHash:string;
 checkedAt:string;
 hardware:{totalMemoryMiB:number;availableMemoryMiB:number;cpuCores:number};
 otherRoles:Array<{role:string;configuration:string;network:string}>;
 limits:string[];
}

interface LocalPlanner1CapabilityView extends Omit<LocalPlanner1CheckView,'otherRoles'|'limits'> {
 schema:'dream-maker.local-planner1-capability.v1';
 provider:'local';
 runner:'LOCAL_HTTP';
 authentication:'NONE';
 bindingHash:string;
 responseId:string;
}

interface LocalPlanner1StatusView {
 schema:'dream-maker.local-planner1-status.v1';
 planner1:{mode:'LOCAL_ONLY';endpoint:string;model:string|null;cloudFallback:false;requestsOtherAccounts:false};
 hardware:LocalPlanner1CheckView['hardware'];
 otherRoles:LocalPlanner1CheckView['otherRoles'];
 limits:string[];
}

function invalidLocalView():never {
 throw new UiError('LOCAL_PLANNER1_VIEW_INVALID','本机检查结果不完整；没有把它当作其他角色或项目能力。请保留现场后重新检查。');
}

/**
 * The capability POST proves only the local Seeker turn. Role scope is read separately
 * from the controller so a successful check cannot imply that Codex, DSH, Laya or project
 * dependencies are ready.
 */
export async function loadLocalPlanner1Check(adapter:{request<T>(path:string,method?:string,body?:unknown):Promise<T>}):Promise<LocalPlanner1CheckView> {
 const capability=await adapter.request<LocalPlanner1CapabilityView>('/planner1/local/check','POST',{confirmed:true});
 if(!capability||capability.schema!=='dream-maker.local-planner1-capability.v1'||capability.status!=='PASSED'||
    capability.provider!=='local'||capability.runner!=='LOCAL_HTTP'||capability.authentication!=='NONE'||
    capability.endpoint!=='http://127.0.0.1:11434/v1'||typeof capability.model!=='string'||!capability.model||
    !/^[a-f0-9]{64}$/.test(capability.responseHash)||!Number.isFinite(Date.parse(capability.checkedAt))||
    !capability.hardware||!Number.isFinite(capability.hardware.totalMemoryMiB)||!Number.isFinite(capability.hardware.availableMemoryMiB)||
    !Number.isSafeInteger(capability.hardware.cpuCores)||capability.hardware.cpuCores<1)invalidLocalView();
 const status=await adapter.request<LocalPlanner1StatusView>('/planner1/local/status','GET');
 if(!status||status.schema!=='dream-maker.local-planner1-status.v1'||status.planner1?.mode!=='LOCAL_ONLY'||
    status.planner1.endpoint!==capability.endpoint||status.planner1.model!==capability.model||
    status.planner1.cloudFallback!==false||status.planner1.requestsOtherAccounts!==false||
    !Array.isArray(status.otherRoles)||status.otherRoles.length<1||status.otherRoles.length>8||
    !Array.isArray(status.limits)||status.limits.length>10)invalidLocalView();
 for(const role of status.otherRoles)if(!role||typeof role.role!=='string'||!role.role||role.role.length>80||
    typeof role.configuration!=='string'||role.configuration.length>300||typeof role.network!=='string'||role.network.length>300)invalidLocalView();
 for(const limit of status.limits)if(typeof limit!=='string'||!limit||limit.length>400)invalidLocalView();
 return{...capability,otherRoles:status.otherRoles,limits:status.limits};
}

/** Rendered only from a controller-issued real local response. No configuration field is treated as capability. */
export function localPlanner1CheckResult(value:LocalPlanner1CheckView):string {
 const roleLines=value.otherRoles.map(item=>`<li><strong>${e(item.role)}</strong>：${e(item.configuration)}；${e(item.network)}</li>`).join('');
 return `<h2 id="dialog-title">本地方案助手检查通过</h2><p>模型 <code>${e(value.model)}</code> 已在本机返回一次真实最小响应。它只证明这一次本地调用可用，不代表其他角色或生成项目也已完成。</p><dl><dt>地址</dt><dd>${e(value.endpoint)}</dd><dt>本机资源</dt><dd>总内存约 ${Math.round(value.hardware.totalMemoryMiB/1024)} GB，当前可用约 ${Math.round(value.hardware.availableMemoryMiB/1024)} GB，${value.hardware.cpuCores} 个 CPU 核心</dd><dt>检查时间</dt><dd>${e(value.checkedAt)}</dd></dl><h3>其他角色仍需分别核验</h3><ul>${roleLines}</ul><p class="hint">${value.limits.map(e).join(' ')}</p><div class="actions"><button type="button" data-action="close-modal">知道了</button></div>`;
}
