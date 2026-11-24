import {escapeHtml as e} from './contracts.js';
import {claudeTranslatedProtocol,customMagpieProtocol,dshSupervisorProtocol,officialCliResponsesRole,piExecutorToolProtocol} from '../shared/custom-magpie-protocol.js';
import type {FlowProfileVersion,CustomRoleProfile} from '../shared/flow-profile.js';
import {wizardRoles,roleTitle,catalogModelId,type DesktopModel,type CustomWizard} from './custom-flow-state.js';
import {magpieAccountCheckPanel,type AccountCheckPanel} from './magpie-account-check-view.js';
import type {PublicAccountIdentity} from '../shared/registered-account-sources.js';
export interface WizardPresentation {accountIdentities?:PublicAccountIdentity[];dreamflow?:boolean;magpieModels?:readonly DesktopModel[];pending?:boolean;needsRecheck?:boolean;conflict?:FlowProfileVersion|null;notice?:string;previous?:boolean;locked?:boolean;accountCheck?:AccountCheckPanel;roleCheckHtml?:string}
const providers=[['github','GitHub Copilot（推荐）'],['openai','OpenAI'],['string','string（Claude 模型服务）'],['deepseek-official','DeepSeek 官方 API']];
const commonRuntimes=[['copilot-sdk','Copilot SDK（推荐，可更改）'],['codex-app-server','Codex app-server']];
const select=(name:string,label:string,options:string[][],current:string)=>`<label for="cw-${name}">${e(label)}</label><select id="cw-${name}" name="${name}">${options.map(([v,l])=>`<option value="${e(v)}" ${current===v?'selected':''}>${e(l)}</option>`).join('')}</select>`;
const input=(name:string,label:string,value:string,max=128)=>`<label for="cw-${name}">${e(label)}</label><input id="cw-${name}" name="${name}" value="${e(value)}" maxlength="${max}" required autocomplete="off" spellcheck="false">`;
const action=(id:string,title:string,extra='')=>`<button type="button" data-action="custom-${id}" ${extra}>${e(title)}</button>`;
const accountOptions=(s:CustomWizard)=>s.configuration.accounts.map((a,i)=>[a.authRef,(a.label||'账户 '+(i+1))+' · '+a.provider+' · 尚未验证']);
const accountLabel=(s:CustomWizard,r:CustomRoleProfile)=>{const a=s.configuration.accounts.find(a=>a.authRef===r.authRef);return a?.label||r.provider+' 账户';};
function accounts(s:CustomWizard,p:WizardPresentation):string {
 const discovered=new Set(p.dreamflow?p.magpieModels?.filter(row=>row.kind==='provider').map(row=>row.provider):[]);
 if(p.dreamflow)for(const source of p.accountIdentities??[])discovered.add(source.provider);
 const choices=[...providers,...[...discovered].filter(id=>id!=='other'&&!providers.some(([known])=>known===id)).map(id=>[id,id])];
 return `<p>先列出计划使用的账户来源。官方登录只需完成一次；已经保存的连接会继续复用。这里不会读取或复制登录凭据，也不接收密码、验证码或 API Key。</p>${p.dreamflow?magpieModels(p)+action('read-account-identities','读取已登记的账户来源')+(p.accountIdentities?.length===0?'<p>当前没有可选的已登记来源。</p>':''):''}${s.configuration.accounts.map((a,i)=>{
  const custom=!choices.some(([p])=>p===a.provider),used=wizardRoles(s).some(r=>r.authRef===a.authRef)||s.configuration.groups.some(g=>g.members.some(m=>m.authRef===a.authRef));
  const binding=a.provider==='deepseek-official'&&a.authentication==='api_key'?`<section class="notice"><p>可以选择这台电脑已有的 DSH 专用凭据来源。这里只登记引用；不会把密钥交给网页、登录服务或调用模型。</p><label class="check"><input type="checkbox" name="sourceConsent-${i}">我确认选用这份本机来源；账户和模型仍须另行验证。</label>${action('bind-dsh-source','登记本机 DSH 来源',`data-index="${i}"`)}</section>`:'';
  const identities=p.dreamflow?p.accountIdentities?.filter(row=>row.provider===a.provider&&row.authentication===a.authentication):undefined;
  const registered=(identities??[]).map(row=>{
   const bound=s.configuration.accounts.some(account=>account.authRef===row.authRef||account.accountRef===row.accountRef);
   return action('attach-account-identity',(bound?'已使用':'选用')+' · '+row.accountRef+' · '+row.authRef,
    `data-index="${i}" data-target="${e(a.authRef)}" data-target-account="${e(a.accountRef)}" data-source="${e(row.authRef)}" data-source-account="${e(row.accountRef)}" ${bound?'disabled':''}`);
  }).join('');
  return `<fieldset class="custom-item"><legend>账户来源 ${i+1} · 连接可复用</legend>${input('account-label-'+i,'给这个账户起个称呼',a.label||'我的账户 '+(i+1),60)}<div class="custom-grid"><div>${select('account-provider-'+i,'模型服务',[...choices,['other','其他服务（自定义）']],custom?'other':a.provider)}</div><div>${select('account-auth-'+i,'计划使用的认证方式',[['oauth',(a.provider==='deepseek-official'||a.provider==='string')?'OAuth 意向（此服务尚未接入）':'官方 OAuth（登录一次，之后复用）'],['api_key','API Key（高级，单独保管）']],a.authentication)}</div></div><div ${custom?'':'hidden'}>${input('account-other-'+i,'其他服务的标识',custom?a.provider:'',100).replace(' required','')}</div>${a.provider==='deepseek-official'?'<p class="hint">此服务当前只接入明确配置的 API Key。现有 OAuth 意向不会自动改用 API Key，也不会发起登录或调用模型。</p>':''}<p class="hint">已保存的官方连接会自动复用，不会因为重新打开向导或产品重启而要求再次登录。账户和模型资格仍需另行核验；这里不启用费用来源。</p>${binding}${registered}<div class="actions">${action('account-help','连接与自动复用说明')}${action('remove-account','移除此来源',`data-index="${i}" ${used||s.configuration.accounts.length<=1?'disabled aria-disabled="true" title="仍被角色或备用组使用，请先调整分配"':''}`)}</div></fieldset>`;
 }).join('')}${action('add-account','再添加一个账户意向',s.configuration.accounts.length>=128?'disabled':'')}`;
}
function roles(s:CustomWizard,p:WizardPresentation):string {
 const c=s.configuration,runtimes=p.dreamflow?[['dsh','DeepSeek Harness（DSH）']]:[...commonRuntimes,['dsh','DSH']];
 return `<p>每个角色和执行器都有自己的选择。规划与审查始终只读；同一账户可以分配给多个角色，实际执行仍需独立会话和资格核验。</p>${p.dreamflow?magpieModels(p):''}${wizardRoles(s).map((r,i)=>{
  const executor=i>0&&i<=c.roles.executors.length;
  const choices=p.dreamflow?(executor?[...runtimes,['pi','Pi Agent']]:[...runtimes,['codex','Codex'],['claude','Claude Code'],['opencode','OpenCode'],['cline','Cline'],...(r.id==='reviewer'?[['independent','独立 API']]:[])]):r.id==='planner2'?[...runtimes,['codex','Codex（Custom 规划）']]:r.id==='reviewer'?[...runtimes,['claude','Claude Code（Custom 审查）']]:runtimes;
  const custom=!choices.some(([v])=>v===r.runtime),group=r.model.kind==='group'?c.groups.find(g=>g.id===r.model.id):undefined;
  const memberChoice=group?select('role-member-'+i,'本轮起始成员（会随配置冻结，不会自动取第一项）',[['','请选择本轮起始成员'],...group.members.map((m,j)=>[m.id,'候选 '+(j+1)+' · '+(m.model||'尚未填写模型')])],r.selectedMemberId??''):'';
  return `<fieldset class="custom-item"><legend>${e(roleTitle(s,r))}</legend>${select('role-account-'+i,'使用哪个账户意向',accountOptions(s),r.authRef)}<div class="${custom?'custom-grid':''}"><div>${select('role-runtime-'+i,'Agent 运行器',[...choices,['other','其他运行器（自定义）']],custom?'other':r.runtime)}</div><div ${custom?'':'hidden'}>${input('role-runtime-other-'+i,'其他运行器的标识',custom?r.runtime:'',100).replace(' required','')}</div></div>${select('role-kind-'+i,'模型选择方式',[['model','指定一个模型'],['group','使用已选备用组']],r.model.kind)}<div ${r.model.kind==='model'?'':'hidden'}>${input('role-model-'+i,'计划使用的模型名称',r.model.kind==='model'?r.model.id:'').replace(' required',r.model.kind==='model'?' required':'')}${r.model.kind==='model'&&r.transport==='magpie'?catalogChoice(p,'role-catalog-'+i,r.provider,r):''}</div><div ${r.model.kind==='group'?'':'hidden'}>${select('role-group-'+i,'使用哪个备用组',c.groups.map((g,index)=>[g.id,'备用组 '+(index+1)+' · '+g.members.length+' 个候选']),r.model.kind==='group'?r.model.id:'')}${memberChoice}${p.dreamflow&&group&&p.accountCheck?.saved?action('recommend-member','检查已选账户并将推荐成员填入草稿',`data-role-id="${e(r.id)}"`):''}</div><p class="hint">填写服务实际使用的模型标识。模型清单和这组搭配尚未验证，不会据此声称支持。备用组必须明确选择一个本轮起始成员，运行中不能靠换成员绕过冻结配置。</p>${action('add-group','为此角色创建备用组',`data-role="${i}" ${c.groups.length>=16?'disabled':''}`)}${select('role-transport-'+i,'请求连接方式',[['magpie','DM 专属 Magpie（默认）'],['native','已确认的官方原生例外']],r.transport)}${r.transport==='native'?`<label class="check"><input type="checkbox" name="role-native-${i}" ${r.nativeException?'checked':''}>我明确选择此角色的原生路径例外；仍需核验账户、费用和权限。</label>`:''}${executor?`<label class="check"><input type="checkbox" name="role-write-${i}" ${r.permissions.includes('source_write')?'checked':''}>允许此执行器修改受控项目源码</label>${action('remove-executor','移除此执行器',`data-index="${i-1}" ${c.roles.executors.length<=1?'disabled':''}`)}`:'<p class="hint">只能读取项目源码，不能直接修改。</p>'}</fieldset>`;
 }).join('')}${action('add-executor','添加另一个 Executor',c.roles.executors.length>=64?'disabled':'')}`;
}
function catalogChoice(p:WizardPresentation,name:string,provider:string,actor?:CustomRoleProfile):string {
 if(!p.dreamflow||!p.magpieModels?.length)return '';
 const choices=p.magpieModels.filter(row=>catalogModelId(row,provider)).map(row=>{
  if(actor?.authentication!=='api_key')return [row.id,row.id];
  const role=actor.id==='planner2'||actor.id==='reviewer'?actor.id:'executor';
  const protocol=customMagpieProtocol(role,actor.runtime,row.protocols);
  const translated=officialCliResponsesRole(role,actor.runtime)&&row.protocols.includes('openai-responses')?'openai-responses':claudeTranslatedProtocol(role,actor.runtime,row.protocols);
  const supervisor=dshSupervisorProtocol(role,actor.runtime,row.protocols);
  const piProtocol=piExecutorToolProtocol(role,actor.runtime,row.protocols);
  let label:string=protocol??'目录未声明此运行器可用的协议';
  if(!protocol&&piProtocol)label=piProtocol+'（Pi 原生工具协议，需核验 Magpie 构建与账户）';
  if(!protocol&&supervisor)label=supervisor+'（经 Magpie 转换，需核验构建与账户）';
  if(!protocol&&!supervisor&&translated)label=translated+'（经 Magpie 转换，需核验账户与构建）';
  return [row.id,row.id+' · '+label];
 });
 return choices.length?select(name,'从当前账户服务的目录填入模型',[['','选择目录条目'],...choices],''):'';
}
function magpieModels(p:WizardPresentation):string {
 const models=p.magpieModels;
 return `<section class="custom-item"><h4>本地 Magpie 模型</h4><p>从桌面 Magpie 读取模型与原生 API。所选账户和运行器的兼容性由角色检查确认。</p>${action('read-models',models?'刷新模型目录':'读取模型目录')}${models?`<details><summary>已发现 ${models.length} 个目录条目</summary><ul>${models.map(m=>`<li>${e(m.id)} · ${e(m.provider)}${m.kind==='alias'?' · 别名':''} · ${e(m.protocols.join('、')||'未声明原生 API')}</li>`).join('')}</ul></details>`:''}</section>`;
}
function routesAndBudget(s:CustomWizard,p:WizardPresentation):string {
 const c=s.configuration;
 return `<p>备用模型只在已选择的成员范围内工作。顺序由 DM 安排；当前只保存策略，尚未开始自动路由或扣费。</p>${p.dreamflow&&c.groups.length?magpieModels(p):''}${c.groups.length?c.groups.map((g,i)=>`<fieldset class="custom-item"><legend>备用组 ${i+1}</legend>${select('group-strategy-'+i,'何时选择备用模型',[['failure_only','故障、限流或额度不足时（默认）'],['rotate','轮换（高级）'],['cost','成本优先（高级，需有效报价）'],['smart','智能选择（高级，需有效额度观察）']],g.strategy)}${g.members.map((m,j)=>`<section class="custom-member"><h4>候选模型 ${j+1}</h4>${select(`member-account-${i}-${j}`,'使用哪个账户意向',accountOptions(s),m.authRef)}${input(`member-model-${i}-${j}`,'服务使用的模型名称',m.model)}${catalogChoice(p,`member-catalog-${i}-${j}`,m.provider)}<label class="check"><input type="checkbox" name="member-read-${i}-${j}" ${m.permissions.includes('source_read')?'checked':''}>允许此候选读取项目源码</label><label class="check"><input type="checkbox" name="member-write-${i}-${j}" ${m.permissions.includes('source_write')?'checked':''}>此候选可用于需要修改源码的执行任务</label>${action('remove-member','移除此候选',`data-index="${i}" data-member="${j}" ${g.members.length<=1?'disabled':''}`)}</section>`).join('')}<div class="actions">${action('add-member','添加候选模型',`data-index="${i}" ${g.members.length>=24?'disabled':''}`)}${action('remove-group','移除此备用组',`data-index="${i}" ${wizardRoles(s).some(r=>r.model.kind==='group'&&r.model.id===g.id)?'disabled title="先在第二步改选模型"':''}`)}</div></fieldset>`).join(''):'<p class="notice">当前使用指定模型。需要备用组时，返回第二步为对应角色创建。</p>'}
 <fieldset class="custom-item"><legend>费用与隐私</legend><p>0 表示不允许该范围产生付费请求。这里保存的是配置上限；已有全局授权和账本仍需在执行前另行核对。</p><div class="custom-grid"><div>${select('profile-currency','配置使用的币种',[['CNY','人民币（CNY）'],['USD','美元（USD）']],c.budget.currency)}</div><div>${input('profile-budget','此项目配置的费用上限',s.money.project,24).replace(' autocomplete',' inputmode="decimal" autocomplete')}</div></div>${wizardRoles(s).map((r,i)=>input('role-budget-'+i,roleTitle(s,r)+'费用上限',s.money.roles[r.id],24).replace(' autocomplete',' inputmode="decimal" autocomplete')).join('')}${input('profile-timezone','预算日历时区',c.timeZone,80)}${input('denied-providers','禁止使用的服务标识（逗号或换行分隔，可空）',c.privacy.deniedProviders.join(', '),2000).replace(' required','')}${input('denied-labels','禁止传输的数据标签（逗号或换行分隔，可空）',c.privacy.deniedDataLabels.join(', '),2000).replace(' required','')}</fieldset>`;
}
function summary(s:CustomWizard):string {
 const c=s.configuration;
 return `<p>保存后生成独立配置版本，用于之后的新一轮。不会修改正在运行的 Flow、批准项目方案、调用模型或接受成果。</p><dl class="custom-summary"><dt>工程模式</dt><dd>完全自定义 · Laya 关闭</dd><dt>运行连接</dt><dd>专属 Magpie 安全入口尚未验证；真实制作保持关闭。</dd><dt>费用上限</dt><dd>${e(s.money.project)} ${e(c.budget.currency)}（0 为不允许付费）</dd></dl>${wizardRoles(s).map(r=>{const group=r.model.kind==='group'?c.groups.find(g=>g.id===r.model.id):undefined,member=group?.members.find(m=>m.id===r.selectedMemberId);return `<section class="custom-item"><h4>${e(roleTitle(s,r))}</h4><dl class="custom-summary"><dt>账户意向</dt><dd>${e(accountLabel(s,r))} · ${e(r.provider)} · 尚未验证</dd><dt>模型选择</dt><dd>${e(group?'备用组 '+(c.groups.findIndex(g=>g.id===group.id)+1)+' · 本轮起始成员 '+member?.id:' '+r.model.id)}</dd><dt>运行器</dt><dd>${e(r.runtime)} · 兼容性尚未验证</dd><dt>连接方式</dt><dd>${r.transport==='magpie'?'DM 专属 Magpie':'明确选择的原生例外'}</dd><dt>费用上限</dt><dd>${e(s.money.roles[r.id])} ${e(c.budget.currency)}</dd></dl></section>`;}).join('')}<label class="check"><input type="checkbox" name="customConsent" required>我确认这些账户意向、角色、模型范围、权限与配置上限。保存设置不代表账户已连接，也不批准开始制作。</label>`;
}
export function customWizardView(s:CustomWizard,p:WizardPresentation={}):string {
  const steps=['账户与来源','角色与执行器','备用模型与限制','核对并保存'];
 const accountCheck=s.step===3?magpieAccountCheckPanel({...p.accountCheck,saved:p.accountCheck?.saved===true,needsRead:p.accountCheck?.needsRead!==false,pending:p.pending})+(p.roleCheckHtml??''):'';
  return `<h2 id="dialog-title">配置完全自定义 DreamFlow</h2><p id="dialog-description" class="notice">只保存下一轮的设置。登录一次并保存的官方连接会自动复用；账户和模型资格仍需验证，没有开始制作。这里不保存秘密。</p><ol class="custom-stepper" aria-label="配置进度">${steps.map((title,i)=>`<li ${s.step===i?'aria-current="step"':''}><span>${i+1}</span>${title}</li>`).join('')}</ol><h3 id="custom-step-title" tabindex="-1">第 ${s.step+1} 步：${steps[s.step]}</h3>${p.notice?`<p role="status" class="notice">${e(p.notice)}</p>`:''}${p.needsRecheck?`<p class="notice warning">保存结果或版本需要核对。草稿已保留，不会自动重发。</p>${p.locked?'':action('recheck','核对是否已保存')}${p.conflict!==undefined?action('load-latest','载入最新配置并保留当前草稿'):''}`:''}${p.previous&&!p.locked?action('previous','查看保留草稿'):''}${p.locked?action('close','关闭，不替换旧草稿'):''}<form id="custom-flow-form"><fieldset class="custom-fields" ${p.pending||p.locked?'disabled':''}>${[accounts,roles,routesAndBudget,summary][s.step](s,p)}${accountCheck}<div class="actions wrap">${s.step>0?action('back','上一步'):''}<button type="submit" ${p.pending||p.needsRecheck&&s.step===3?'disabled':''}>${s.step===3?'确认并保存下一轮配置':'下一步'}</button>${action('close','关闭并保留草稿')}</div></fieldset><p id="custom-form-error" role="alert" class="dialog-error"></p></form>`;
}
