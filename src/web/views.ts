import type { Project, Event as RunEvent, Run, Role } from '../shared/types.js';
import type { Snapshot, PublicConfig, ConnectionState, NativeVerifierPlan, ClashStatus, FlowBlock } from './contracts.js';
import { escapeHtml as e, label, activeRole, roleNames, roleDisplayNames, runTone, semanticRows } from './contracts.js';
import { ROLE_WIRE_IDS, roleMetadata, type RoleIconId } from '../shared/role-names.js';
import {mergeRecoveryNotice,mergeRecoveryError,sourceTaskLabel} from './merge-recovery-view.js';
import {executorCheckpointNotice,executorCheckpointError} from './executor-checkpoint-view.js';
import {reviewPreparationNotice,reviewPreparationError} from './review-preparation-view.js';
import {reviewWindowNotice} from './review-window-view.js';
import {reviewSupplementNotice,reviewSupplementError} from './review-supplement-view.js';
import { summarizeKimiStatus } from './kimi-status-summary.js';
import { projectPlanContent } from './project-plan-view.js';
import { helpPage, type HelpTopic } from './flow-help-view.js';
import { userPlanHome } from './user-plan-view.js';
import type { Product } from '../shared/product.js';
import type {SetupSnapshot} from '../shared/onboarding.js';
import {setupPage,setupWelcome,feesPage} from './setup-view.js';
import {maintenancePage} from './maintenance-view.js';
import type {MaintenanceStatus,RestoreRehearsal} from '../shared/maintenance.js';
import type {LifecycleStatus} from '../shared/lifecycle.js';
import type {ManagedDataView} from '../shared/managed-data.js';
import {managedPreviewPanel} from './managed-data-view.js';
import {jsonDataPanel} from './json-data-view.js';
import {sqliteStatusEntry} from './sqlite-status-view.js';
import type {JsonDataView} from '../shared/json-data.js';
import type {RegisteredBackupsStatus,RegisteredExtraction} from '../shared/registered-backup.js';
import {historyPage,type PlanHistoryState} from './plan-history-view.js';
import {researchPage,type ResearchPanelState} from './research-view.js';
import {flowWorkspace,layaPage,type DispatchView,type LayaSummaryView} from './flow-workspace-view.js';
import {reviewerPage,followupPage} from './reviewer-view.js';
import {frontendTour,settingsOverview,reviewMaintenance} from './frontend-guidance-view.js';
import type {FlowReportData} from './flow-help-view.js';
import type {NetworkContextsSnapshot} from '../shared/network-contexts.js';
import type {CodexMetadataObservation} from '../shared/codex-metadata.js';
import type {MagpieCheckView} from '../shared/magpie-check.js';
import {layaProbePanel,type LayaProbeReadResult} from './laya-probe-view.js';
export type Screen = 'home'|'project'|'settings'|'help'|'setup'|'fees'|'maintenance';
export interface ViewState {
 product?:Product;
 presentation?:'frontend-review';
 setup?:SetupSnapshot;setupStep?:number;setupLoading?:boolean;
 helpSimple?:boolean;
 networkContexts?:NetworkContextsSnapshot;networkLoading?:boolean;networkTesting?:boolean;networkError?:string;
 codexMetadata?:CodexMetadataObservation;codexMetadataLoading?:boolean;codexMetadataError?:string;
 magpieCheck?:MagpieCheckView;magpieLoading?:boolean;magpieTesting?:boolean;magpieError?:string;magpieNeedsRead?:boolean;
 maintenance?:MaintenanceStatus;maintenanceResult?:RestoreRehearsal;sqliteRestoreResult?:{projectId:string;revision:number;at:string};
 lifecycle?:LifecycleStatus;
 previewProtocol?:1|2;previewData?:ManagedDataView;managedRestoreResult?:{projectId:string;revision:number;at:string};
 jsonData?:JsonDataView;
 registeredBackups?:RegisteredBackupsStatus;registeredExtraction?:RegisteredExtraction;
 mode:'local'|'public-demo'; screen:Screen; projects:Project[]; snapshot:Snapshot|null; settings:PublicConfig|null;
 tab:string; busy:boolean; error:string; events:RunEvent[]; connection:ConnectionState; railClosed:boolean;
 fileName:string; fileText:string; files:{path:string;bytes:number}[]; previewUrl:string; previewScope:string;
 diagnostics:string; specSearch:string; logLimit:number; draft:(key:string)=>string; hasDraft:(key:string)=>boolean;
 clash:ClashStatus|null;
 planningMessage?:string;
 helpTopics?:Record<string,HelpTopic>;
 planHistory?:PlanHistoryState;researchPanel?:ResearchPanelState;dispatch?:DispatchView;layaSummary?:LayaSummaryView;flowReport?:FlowReportData;
  layaProbe?:LayaProbeReadResult;layaProbeError?:string;
 panelLoading?:boolean;panelError?:string;
}
const attr=(s:unknown)=>e(s);
const button=(action:string,text:string,kind='',extra='')=>`<button type="button" data-action="${action}" class="${kind}" ${extra}>${text}</button>`;
const uiIcon=(name:'projects'|'plus'|'settings'|'check'|'wallet'|'database'|'help'|'menu'|'users'|'panel'|'folder'|RoleIconId|'file')=>{
 const paths:Record<string,string>={
  projects:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  settings:'<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
  wallet:'<path d="M4 7h14a2 2 0 0 1 2 2v8H6a2 2 0 0 1-2-2V7Z"/><path d="M4 7V6a2 2 0 0 1 2-2h10M16 12h4"/>',
  database:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 1 1 3.8 2c-.9.6-1.6 1.1-1.6 2.5M12 17h.01"/>',
  menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  folder:'<path d="M3 6h6l2 2h10v11H3V6Z"/>',
  seeker:'<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z"/><path d="M8 9h8M8 13h5"/>',
  planner:'<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6.5 7.5l4.5 9M17.5 7.5 13 16.5"/>',
  executor:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  reviewer:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>'
 };
 return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
};
export const pill=(text:string,tone='neutral')=>`<span class="pill ${tone}">${e(text)}</span>`;
const date=(s:string)=>{try{return new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(s));}catch{return '时间未知';}};
function currentFlow(v:ViewState):Run|undefined {const s=v.snapshot,r=s?.runs[0];return r&&r.specId===s?.project.specId&&!s.spec?.stale?r:undefined;}
export function roles(v:ViewState):string {
 const r=currentFlow(v), state=r?.state||v.snapshot?.project.state||'', active=activeRole(state);
 return `<div class="section-heading"><h2>协作分工</h2><span class="micro">${v.product==='dreamflow'||v.snapshot?.project.planner1Mode==='USER'?'YOU + 3 ROLES':'4 ROLES'}</span></div><p class="hint">${v.mode==='public-demo'?'以下为配置意图，未连接真实 Agent。':'职责与连接状态分开展示。'}</p><div class="roles">${ROLE_WIRE_IDS.map(id=>{const name=roleMetadata(id).zhLabel;
 if(id==='planner1'&&(v.product==='dreamflow'||v.snapshot?.project.planner1Mode==='USER'))return `<div class="role"><div class="role-glyph">${uiIcon('seeker')}</div><div><h3>方案提供者</h3><p>由你编写、整理并确认方案</p><small>不调用需求访谈模型；工程角色仍须独立核验。</small></div></div>`;
 const configured=id==='planner1'?(v.settings?.config.planner1.authMode==='siwc_plan'?v.settings.config.planner1.siwcModel:v.settings?.config.planner1.model):id==='executor'?v.settings?.config.dsh.model:v.settings?.config.codex.model;
 const actual=r?.roleIdentities?.[id as Role];
 return `<div class="role ${id===active?'is-current':''}" data-key="role-${id}"><div class="role-glyph">${uiIcon(roleMetadata(id).iconId)}</div><div><h3>${roleMetadata(id).displayName} · ${name}</h3><small>${({planner1:'整理你的想法',planner2:'安排工程任务',executor:'按范围制作',reviewer:'独立核对成果'} as Record<string,string>)[id]}</small><p>${v.mode==='public-demo'?'未连接':actual?e('本轮实际：'+actual.model+' · '+actual.runner):e(configured?'配置目标：'+configured:'模型未配置')}</p><small>${actual?e(actual.provider+' · '+actual.authentication):r?.mode==='live'?'执行身份尚未按当前目标核验':id===active?(v.mode==='public-demo'?'演示当前角色':'当前阶段职责，连接以证据为准'):'等待当前阶段'}</small></div></div>`;}).join('')}</div>
 <section class="rail-info"><div class="row between"><h3>本地 Laya</h3>${pill(v.settings?.config.laya.mode==='off'?'OFF':v.settings?.config.laya.mode||'未知')}</div><p class="hint">${v.mode==='public-demo'?'未连接，不探测你的电脑。':'配置状态不代表连接成功。查看诊断确认服务与降级。'}</p>${v.mode==='local'?button('settings','管理连接','text-button'):button('local-help','了解本地集成版','text-button')}</section>
 ${statusRail(v)}<section class="rail-info"><h3>运行边界</h3><dl class="metrics"><div><dt>模型费用</dt><dd>${v.mode==='public-demo'?'演示无模型调用':'未知 / 见用量'}</dd></div><div><dt>真实制作验收</dt><dd>本页不提供此项证明</dd></div><div><dt>原生连接</dt><dd>${v.mode==='public-demo'?'未连接':'以本机诊断为准'}</dd></div></dl><p class="hint">界面状态不等于模型、工具或测试已成功执行。</p></section>`;
}
export function shell(v:ViewState):string {
 const demo=v.mode==='public-demo';
 return `<div class="shell ${v.railClosed?'rail-collapsed':''}"><aside class="sidebar" aria-label="项目导航"><a href="/" data-action="home" class="brand"><span class="brand-mark" aria-hidden="true">D</span><span>${v.product==='dreamflow'?'DreamFlow<small>方案工作台</small>':'Dream Maker<small>灵感制作台</small>'}</span></a>
 <nav class="primary-nav">${button('home',uiIcon('projects')+'<span>项目空间</span>',v.screen==='home'?'nav-button active':'nav-button')}${button('new',uiIcon('plus')+'<span>'+(v.product==='dreamflow'?'新建方案':'新建灵感')+'</span>','nav-button')}${button('settings',uiIcon('settings')+'<span>连接与设置</span>',v.screen==='settings'?'nav-button active':'nav-button')}${!demo||v.presentation==='frontend-review'?button('setup',uiIcon('check')+'<span>使用准备</span>',v.screen==='setup'?'nav-button active':'nav-button')+button('fees',uiIcon('wallet')+'<span>费用管理</span>',v.screen==='fees'?'nav-button active':'nav-button')+button('maintenance',uiIcon('database')+'<span>数据与维护</span>',v.screen==='maintenance'?'nav-button active':'nav-button')+button('help',uiIcon('help')+'<span>帮助</span>',v.screen==='help'?'nav-button active':'nav-button'):''}</nav>
 <div class="sidebar-section"><div class="micro">${demo?'演示项目 / 本页数据':'你的项目'}</div>${v.projects.slice(0,12).map(p=>`<a class="project-link ${v.screen==='project'&&v.snapshot?.project.id===p.id?'active':''}" href="/?project=${encodeURIComponent(p.id)}" data-action="open" data-id="${attr(p.id)}" title="${attr(p.name)}">${uiIcon('folder')}<span>${e(p.name)}</span></a>`).join('')||'<p class="hint">第一条灵感还在等你。</p>'}</div>
 <div class="sidebar-foot"><span class="micro">正在制作</span><p>${demo?'UI 演示 · 不连接真实 Agent':v.product==='dreamflow'?'独立 DreamFlow · 本机运行':'Dream Maker · 本机运行'}</p>${button('local-help',demo?'如何使用本地版':'查看运行边界','text-button')}</div></aside>
 <div class="workspace"><header class="topbar">${button('menu',uiIcon('menu'),'icon-button mobile-only','aria-label="打开项目导航"')}<div class="breadcrumb"><span>工作空间</span><span aria-hidden="true">/</span><strong>${v.screen==='home'?(v.product==='dreamflow'?'方案工作台':'灵感工坊'):v.screen==='settings'?'连接与设置':v.screen==='help'?'帮助':v.screen==='setup'?'使用准备':v.screen==='fees'?'费用管理':v.screen==='maintenance'?'数据与维护':e(v.snapshot?.project.name||'加载中…')}</strong></div><div class="top-actions">${pill(demo?'UI DEMO':'LOCAL',demo?'warning':'neutral')}${!demo||v.presentation==='frontend-review'?button('application-exit','离开','text-button','aria-label="选择后台继续或安全暂停"'):''}${button('team',uiIcon('users'),'icon-button team-button','aria-label="查看协作状态"')}${button('rail',v.railClosed?'展开角色栏':'收起角色栏','text-button rail-button')}</div></header>
 <div class="mode-banner" role="note"><span class="banner-dot" aria-hidden="true"></span>${demo?'前端演示 · 尚未连接真实制作。所有示例、运行和验证为合成场景，请勿输入密钥或敏感信息。':`同源本地服务。${v.screen!=='project'?'打开页面、整理方案和查看项目不会自行开始制作。':v.snapshot?.project.mode==='live'?'Live 调用受原有授权和门禁约束。':'Demo 项目使用规则角色与固定样例，不代表 Live 联调通过。'}`}</div>
 <div class="body-grid"><main id="main-content" tabindex="-1">${frontendTour(v)}<div id="error-box" role="alert" class="error ${v.error?'':'hidden'}">${e(v.error)} ${button('refresh','刷新状态','small')}</div><div id="page" data-key="${v.screen}-${v.screen==='project'?attr(v.snapshot?.project.id):''}">${v.screen==='home'?(v.mode==='local'&&v.projects.length===0?setupWelcome(v.product??'dream-maker'):'')+home(v):v.screen==='settings'?settings(v):v.screen==='help'?helpPage(v.helpTopics??{},v.helpSimple):v.screen==='setup'?setupPage(v.setup,v.setupStep,v.setupLoading,k=>v.hasDraft(k)?v.draft(k):undefined):v.screen==='fees'?feesPage(v.setup,v.setupLoading,k=>v.hasDraft(k)?v.draft(k):undefined):v.screen==='maintenance'?maintenancePage(v.maintenance,v.maintenanceResult,v.lifecycle,v.projects,v.managedRestoreResult,{status:v.registeredBackups,result:v.registeredExtraction,busy:v.busy},v.sqliteRestoreResult)+(v.presentation==='frontend-review'?reviewMaintenance():''):v.snapshot?project(v):'<section class="card"><h1>正在读取项目…</h1></section>'}</div></main><aside class="context-rail" aria-label="角色与运行边界">${roles(v)}</aside></div>
 </div></div>`;
}
function home(v:ViewState):string{
 if(v.product==='dreamflow')return userPlanHome(v);
 const planner1Provider=v.settings?.planner1Binding?.provider??v.settings?.config.planner1.provider??'';
 const planner1Consent=planner1Provider==='local'
  ?'<label class="check"><input type="checkbox" name="localConsent">选择 Live 时，我同意输入只发送给本机 Ollama（127.0.0.1:11434）。不会自动改用云端，其他角色和项目依赖仍分别核验。</label>'
  :planner1Provider==='kimi'
   ?'<label class="check"><input type="checkbox" name="kimiConsent">选择 Live 时，我同意使用我本人的 Kimi 会员订阅（仅限本人本地逐次交互，不批量无人值守，不代他人调用）。当前为 Kimi 官方 OAuth 绑定：受会员额度约束，不会自动改用按量 API Key，也不会回退到旧提供商。</label>'
   :v.settings?.config.planner1.authMode==='siwc_plan'
    ?'<label class="check"><input type="checkbox" name="siwcPlanConsent">选择 Live 时，我同意将输入发送给当前配置的模型提供方。当前为套餐授权模式：受套餐资格和限额约束，不会自动切换付费 API Key。</label>'
    :'<label class="check"><input type="checkbox" name="apiConsent">选择 Live 时，我同意将输入发送给当前配置的模型提供方。当前为 API Key 模式：可能产生按量调用费用。</label>';
 return `<section class="home-intro"><div class="page-heading"><div class="eyebrow">项目空间</div><h1>从一个想法，开始制作。</h1><p>先说清楚，再动手。下一步由你决定，每一步都有据可查。</p></div><div class="home-signal" aria-label="工作方式"><span>01 说清楚</span><span>02 确认方案</span><span>03 制作与审查</span></div></section>
 <div class="home-layout"><section class="card idea-card"><div class="section-heading"><h2>新建一个项目</h2><span class="micro">从这里开始</span></div><form id="new-project" data-key="new-project"><label for="project-name">项目名称</label><input id="project-name" name="projectName" data-draft="projectName" value="${attr(v.draft('projectName'))}" maxlength="120" required autocomplete="off" placeholder="例如：我的学习任务板"><label for="idea">描述你的小灵感</label><textarea id="idea" name="idea" data-draft="idea" rows="5" maxlength="12000" required placeholder="我想做一个…它能帮我…">${e(v.draft('idea'))}</textarea>
 <div class="composer-bottom"><div class="row wrap"><label for="mode" class="sr-only">运行模式</label><select id="mode" name="mode"><option value="demo">${v.mode==='public-demo'?'UI 演示 · 不调用模型':'Demo · 固定样例'}</option>${v.mode==='local'?'<option value="live">Live · 已配置的真实模型</option>':''}</select><span class="hint">10 个有效回答后，由你选择继续或结束</span></div><button type="submit" class="primary">创建项目，开始澄清</button></div>
  ${v.mode==='local'?`<details class="consent-details"><summary>Live 运行与公开检索说明</summary><label class="check"><input type="checkbox" name="publicResearch">选择 Live 时，允许用通用关键词查找 GitHub / GitLab 的公开项目，帮助设计方案。不会发送原始描述、回答原文、私有文件或模型凭据；查找不会安装、运行代码或开始制作。</label>${planner1Consent}</details>`:''}</form></section>
 <aside class="home-boundary"><h2>运行边界：先保存想法，不自动开始制作。</h2><p>创建项目只进入需求澄清。方案需要你确认，真实运行还会单独检查账户、费用、网络和角色资格。</p><dl class="metrics"><div><dt>当前环境</dt><dd>${v.mode==='public-demo'?'UI 演示':'本机服务'}</dd></div><div><dt>真实模型</dt><dd>${v.mode==='public-demo'?'未连接':'按门禁启用'}</dd></div><div><dt>自动制作</dt><dd>不会</dd></div></dl></aside></div>
 <div class="path-ribbon" aria-label="项目流程">${['灵感','澄清','规格','制作','审查','成果'].map((x,i)=>`<span><b>${String(i+1).padStart(2,'0')}</b>${x}</span>`).join('')}</div>
 <section class="projects-section"><div class="section-heading"><h2>${v.mode==='public-demo'?'从一个场景开始':'继续你的项目'}</h2><span class="hint">${v.projects.length} 个${v.mode==='public-demo'?'本页演示':''}项目</span></div>${v.mode==='public-demo'?'<p class="hint">合成场景可以编辑、继续和刷新恢复。不是其他用户的项目。</p>':''}<div class="project-grid">${v.projects.map(p=>`<a class="project-card" href="/?project=${encodeURIComponent(p.id)}" data-action="open" data-id="${attr(p.id)}"><div class="row between"><span class="folder-icon">${uiIcon('folder')}</span>${pill(p.mode==='demo'?'DEMO':'LIVE')}</div><h3>${e(p.name)}</h3><p>${e(p.idea)}</p><div class="row between project-meta"><span>需求：${e(label(p.state))}</span></div><small>${e(date(p.updatedAt))}</small></a>`).join('')||`<div class="empty">${uiIcon('folder')}<h3>这里留给你的第一个项目。</h3><p>上方写下一句话，就能开始。暂时不确定的细节可以留到提问时再想。</p></div>`}</div></section>`;
}
function stage(v:ViewState):number {const p=v.snapshot!.project,r=currentFlow(v);if(v.snapshot?.spec?.stale)return 1;if(r){if(['READY_FOR_DELIVERY','ACCEPTED'].includes(r.state))return 5;return ['REVIEWING','REPAIRING'].includes(r.state)?4:3;}return p.specId?2:1;}
function project(v:ViewState):string{
 const s=v.snapshot!,p=s.project,r=currentFlow(v), st=stage(v),replanning=p.interviewMode==='ALTERNATIVE'&&['INTERVIEWING','AWAITING_INTERVIEW_DECISION'].includes(p.state);
 const tabs=(v.product==='dreamflow'?[['work','执行概览'],['flow','任务与角色'],['report','检查与审查'],['files','成果交付'],['spec','项目方案'],['history','方案历史'],['laya','Laya 辅助'],['followup','后续方案'],['logs','详细记录']]:[['work','下一步'],['answers','回答记录'],['research','开源研究'],['spec','项目方案'],['history','方案历史'],['flow','DreamFlow'],['laya','Laya 辅助'],['report','审查报告'],['followup','后续交流'],['files','成果交付'],['logs','详细记录']]).filter(([key])=>!(v.product==='dreamflow'||p.planner1Mode==='USER')||!['answers','research'].includes(key));
 return `<section class="project-heading"><div><div class="eyebrow">${p.mode==='demo'?'DEMO PROJECT':'LIVE PROJECT'}</div><h1>${e(p.name)}</h1><p class="idea-summary">${e(p.idea)}</p></div>${pill(label(r?.state||p.state),runTone(r?.state||p.state))}</section>
 ${p.mode==='live'&&p.planner1Mode!=='USER'&&v.product!=='dreamflow'&&(p.planner1AuthMode??'api_key')!==v.settings?.config.planner1.authMode?'<div class="notice warning">这个 Live 项目绑定的是创建时的 Seeker 模式。请切回原认证模式或在新模式下新建项目；不会自动切换用量来源。</div>':''}
 ${(v.product==='dreamflow'||p.planner1Mode==='USER')&&s.spec?.projectPlan?`<section class="card"><h2>你的方案</h2><p>本轮始终依据已确认的版本。修订要等本轮正式结束，新版本仍需确认。</p><div class="actions">${button('export-plan','导出完整方案','secondary')}${button('edit-user-plan','修订下一版方案','secondary')}</div></section>`:''}
 <ol class="stage-path" aria-label="当前项目阶段">${(v.product==='dreamflow'||p.planner1Mode==='USER'?['方案输入','方案确认','制作','审查','成果']:['灵感','澄清','规格','制作','审查','成果']).map((x,i)=>`<li class="${i===(v.product==='dreamflow'?Math.max(0,st-1):st)?'current':i<(v.product==='dreamflow'?Math.max(0,st-1):st)?'visited':''}" ${i===(v.product==='dreamflow'?Math.max(0,st-1):st)?'aria-current="step"':''}><span>${String(i+1).padStart(2,'0')}</span>${x}</li>`).join('')}</ol>
 ${s.spec?.stale?'<div class="notice warning"><strong>规格已过期。</strong> 回答修改后，旧确认和对应运行不再代表当前需求。请重新整理并确认。</div>':''}
 ${p.state==='AWAITING_INTERVIEW_DECISION'?`<div class="notice decision-notice"><span>已保存 ${p.answers.filter(a=>a.status==='answered').length} 个有效回答。系统正在等待你的选择。</span>${button('show-gate','选择下一步','small primary')}</div>`:''}
 ${v.planningMessage?`<div class="notice planning-status" role="status"><span>${e(v.planningMessage)}</span>${v.busy?button('cancel-planning','停止本次规划','small'):''}</div>`:''}
 ${v.mode==='local'&&v.presentation!=='frontend-review'?`<div class="actions custom-entry">${button('custom-configure','配置完全自定义','secondary')}<span class="hint">仅保存下一轮设置；执行前仍需完成真实账户、模型、运行器和角色资格核验。</span></div>`:''}
 <nav class="tabs" role="tablist" aria-label="项目视图">${tabs.map(([id,text])=>`<button id="tab-${id}" role="tab" type="button" aria-selected="${v.tab===id}" aria-controls="tab-panel" tabindex="${v.tab===id?0:-1}" data-action="tab" data-tab="${id}">${text}</button>`).join('')}</nav>
 <div id="tab-panel" role="tabpanel" aria-labelledby="tab-${attr(v.tab)}" tabindex="0" aria-busy="${!!v.panelLoading}">${v.panelLoading?'<p class="notice" role="status">正在读取这一页…</p>':''}${v.panelError?`<p class="notice warning" role="status">${e(v.panelError)}</p>`:''}${v.tab==='history'?historyPage(v):v.tab==='research'?researchPage(v):v.tab==='flow'?flowWorkspace(v):v.tab==='laya'?layaPage(v):v.tab==='report'?reviewerPage(v):v.tab==='followup'?followupPage(v):v.tab==='answers'?answers(v):v.tab==='spec'?spec(v):v.tab==='logs'?logs(v):v.tab==='files'?filesView(v):replanning?interview(v):r&&!s.spec?.stale?runView(v):p.state==='SPEC_REVIEW'||p.state==='READY_TO_BUILD'?spec(v):interview(v)}</div>`;
}
export function answers(v:ViewState):string{
 const p=v.snapshot!.project;
 return `<section class="card"><div class="section-heading"><h2>原始回答，不被摘要覆盖</h2>${pill(p.answers.filter(a=>a.status==='answered').length+' 条有效')}</div><p class="hint">同一个问题修改多次，也只计一个有效回答。跳过不计数。</p><div class="history">${p.answers.map(a=>`<article class="answer-item" data-key="answer-${attr(a.id)}"><div class="row between"><span class="micro">${e(p.questions.find(q=>q.id===a.questionId)?.topic||'问题')} · V${a.revision}</span>${button('edit-answer','修改','small text-button',`data-id="${attr(a.questionId)}"`)}</div><h3>${e(p.questions.find(q=>q.id===a.questionId)?.text)}</h3><p class="preserve">${a.status==='skipped'?'已跳过 · 不计入有效回答':e(a.text)}</p><small>${e(a.id)} · ${e(p.questions.find(q=>q.id===a.questionId)?.source)}</small></article>`).join('')||'<div class="empty"><h3>回答会保存在这里。</h3><p>原话、来源和修订版本都可以回看。</p></div>'}</div></section>`;
}
function interview(v:ViewState):string{
 if(v.product==='dreamflow'||v.snapshot?.project.planner1Mode==='USER')return '<section class="card"><h2>由你提供方案</h2><p>旧访谈原文保留在回答记录中。请返回方案工作台填写或导入完整方案；这里不会启动需求访谈模型。</p>'+button('home','返回方案工作台','primary')+'</section>';
 const p=v.snapshot!.project,q=p.questions.find(q=>!p.answers.some(a=>a.questionId===q.id)),n=p.answers.filter(a=>a.status==='answered').length,size=p.batchSize??10;
 const progress=Math.max(0,Math.min(size,n-(p.batchTarget-size))),selected=q?v.draft('choices:'+p.id+':'+q.id).split(','):[];
 return `<section class="card question-card"><div class="section-heading"><span class="eyebrow">CLARIFY / 需求澄清</span>${pill(`${n} / ${p.batchTarget} 已回答`,'accent')}</div><div class="answer-meter" role="progressbar" aria-label="本组已回答" aria-valuemin="0" aria-valuemax="${size}" aria-valuenow="${progress}">${Array.from({length:size},(_,i)=>`<span class="${i<progress?'filled':''}"></span>`).join('')}</div>
 ${p.state==='AWAITING_INTERVIEW_DECISION'?`<h2 class="question-title">这一组问题已经完成。</h2><p>没有你的选择，不问下一题，也不开始构建。</p>${button('show-gate','决定下一步','primary')}`:q?`<div class="question-id">问题 ${p.questions.indexOf(q)+1} <span> / ${e(q.topic)}</span></div><h2 class="question-title">${e(q.text)}</h2><div class="suggestion"><span class="micro">参考方向 · 不是你的答案</span><p>${e(q.suggestion)}</p></div>
 <form id="answer-form" data-key="answer-form-${attr(q.id)}">${q.options?.length===4?`<fieldset class="answer-choices"><legend>${q.allowMultiple?'可以多选，也可以填写自己的回答':'选择一项，也可以直接填写自己的回答'}</legend>${q.options.map((o,i)=>`<label class="answer-option" for="choice-${attr(q.id)}-${attr(o.id)}"><input id="choice-${attr(q.id)}-${attr(o.id)}" name="optionId" type="${q.allowMultiple?'checkbox':'radio'}" value="${attr(o.id)}" ${selected.includes(o.id)?'checked':''}><span>${i+1}. ${e(o.label)}</span></label>`).join('')}${button('clear-answer-choices','清除选择','text-button small')}</fieldset><label for="answer">5. 自由输入（可补充或单独作答）</label>`:'<label for="answer">你的回答</label>'}<textarea name="answer" id="answer" data-draft="answer:${attr(p.id)}:${attr(q.id)}" rows="4" maxlength="8000" ${q.options?'':'required'} placeholder="简单说说也可以，具体例子更有帮助…">${e(v.draft('answer:'+p.id+':'+q.id))}</textarea><div class="actions between"><span class="hint draft-status">草稿仅保留在当前浏览器会话</span><div class="row wrap">${button('skip','暂时跳过','text-button')}<button type="submit" class="primary">保存回答</button></div></div></form>`:`<h2>准备好下一道问题</h2><p>逐个澄清，不用一次想清所有细节。</p>${button('next','生成下一题','primary')}`}
 <footer class="section-footer"><p>可以随时结束，不必答满${size===5?'五':'十'}题。<br><span class="hint">结束访谈和批准构建，是两个不同决定。</span></p>${button('finish','结束提问，整理方案','secondary')}</footer></section>
 <details class="inline-history"><summary>快速回看已回答内容 (${n})</summary>${answers(v)}</details>`;
}
function spec(v:ViewState):string{
 const s=v.snapshot!.spec,p=v.snapshot!.project;if(!s)return `<section class="card empty"><h2>规格还没有生成。</h2><p>先回答问题，或者结束提问开始整理。</p>${button('tab','返回当前任务','primary','data-tab="work"')}</section>`;
 const term=v.specSearch.trim().toLowerCase(),reqs=s.requirements.filter(r=>!term||[r.id,r.text,r.origin,...r.sourceAnswerIds].join(' ').toLowerCase().includes(term));
 return `<section class="card spec-card"><div class="section-heading"><div><span class="eyebrow">PROJECT AGREEMENT</span><h2>把想法变成明确的约定</h2></div>${pill('规格 v'+s.revision,'accent')}</div><p class="preserve">${e(s.brief)}</p><div class="spec-tools"><label for="spec-search">搜索要求与来源</label><input id="spec-search" name="specSearch" type="search" value="${attr(v.specSearch)}" autocomplete="off" placeholder="输入关键词或需求 ID…"></div>
 ${s.projectPlan?projectPlanContent(s.projectPlan):''}<div class="requirements">${reqs.map(r=>`<article class="requirement" data-key="req-${attr(r.id)}"><div class="row wrap"><code>${e(r.id)}</code>${pill(r.origin==='USER'?'原始要求':r.origin==='AI_SUGGESTION'?'AI 建议':'设计假设',r.origin==='USER'?'neutral':'warning')}<span class="hint">${r.priority==='must'?'必须满足':'建议满足'}</span></div><p class="preserve">${e(r.text)}</p><small>来源：${r.sourceContext?'你提出的换路限制':r.sourceAnswerIds.length?r.sourceAnswerIds.map(e).join(' / '):'原始灵感 / 规格记录'}</small></article>`).join('')||'<p class="empty">没有匹配的要求。</p>'}</div>
 ${[['限制条件',s.constraints],['设计假设',s.assumptions],['本期不做',s.outOfScope],['待解决冲突',s.conflicts],['验收标准',s.acceptance]].map(([title,items])=>`<details class="spec-section"><summary>${e(title)} <span>${(items as string[]).length} 项</span></summary>${(items as string[]).map(x=>`<p class="note-line preserve">${e(x)}</p>`).join('')||'<p class="hint">当前规格未记录此项；不代表已经做过完整语义审计。</p>'}</details>`).join('')}
 ${v.mode==='local'?semanticEditor(v):''}
 <details class="spec-section"><summary>完整总 Prompt 与版本信息</summary><div class="actions">${button('copy-prompt','复制总 Prompt','small')}</div><pre tabindex="0" id="prompt-text">${e(s.masterPrompt)}</pre><p class="hint break">规格标识 ${e(s.hash)}${v.mode==='public-demo'?' · 合成标识，非真实源码证据':''}</p></details>
 ${v.product==='dreamflow'||p.planner1Mode==='USER'?`<p>你负责完整方案的内容；需要改动时，使用“修订下一版方案”。</p>`:`<form id="spec-notes" data-key="spec-notes-${attr(s.id)}"><label for="notes">补充说明</label><textarea id="notes" name="notes" data-draft="notes:${attr(p.id)}" rows="3" maxlength="12000">${e(v.hasDraft('notes:'+p.id)?v.draft('notes:'+p.id):(s.userNotes??s.notes))}</textarea><div class="actions between"><span class="hint">实际修改才生成新方案，并需要重新确认。</span><button type="submit">保存为新版本</button></div></form>`}
 </section>
 ${v.mode==='local'&&p.mode==='live'?`<section class="verifier-section"><h2>原生验收计划</h2><p>当前规格的独立测试与预期结果</p>${button('native-verifier','查看并确认验收计划','secondary',s.stale?'disabled':'')}</section>`:''}
 <section class="card approval-card"><span class="eyebrow">YOUR DECISION</span><h2>${p.state==='READY_TO_BUILD'?'规格已确认。现在决定是否制作。':'先核对，再确认。'}</h2>${s.stale?`<p class="notice warning">规格已过期，请重新整理。</p>${button('finish','重新整理规格','primary')}`:p.state!=='READY_TO_BUILD'?`<p>确认当前规格不会启动 Agent，也不是构建授权。</p>${button('approve','确认这版规格','primary')}`:`<form id="build-form" data-key="build-${attr(s.hash)}">${buildFlowChoice(v)}<label class="check"><input name="buildConsent" type="checkbox" required>我批准按当前规格${v.mode==='public-demo'?'进入模拟制作流程':'在受控工作区构建'}。</label>${p.mode==='demo'?'<label class="check"><input type="checkbox" name="demoFault">在 Demo 中注入一个缺陷，观察返修</label>':''}<p class="hint">${v.mode==='public-demo'?'不会调用真实模型。下一步场景由你手动推进，不自动假装成功。':'已有权限、预算和原生门禁保持有效；无法就绪时明确报错，不回退 Demo。'}</p><button class="primary" type="submit">${v.mode==='public-demo'?'批准演示构建':'批准构建'}</button></form>`}</section>`;
}
function buildFlowChoice(v:ViewState):string{
 if(v.mode!=='local'||!v.snapshot)return '';
 const options=v.snapshot.flowOptions??[],key='flow:'+v.snapshot.project.id,layaKey='flow-laya:'+v.snapshot.project.id,selected=v.hasDraft(key)?v.draft(key):'classic';
 const classic=options.find(f=>f.name==='classic'),custom=options.find(f=>f.name==='custom'),layaAvailable=classic?.layaAvailable===true;
 const wantsLaya=v.hasDraft(layaKey)&&v.draft(layaKey)==='true',customSetup=custom?.setupAllowed===true,stale=!['classic','custom'].includes(selected)||wantsLaya&&!layaAvailable||selected==='custom'&&!customSetup;
 const customPending=custom?.blockedBy==='CUSTOM_ROLE_QUALIFICATION_REQUIRED';
 return `<fieldset class="flow-mode-choice" aria-describedby="flow-mode-explanation"><legend>这轮如何制作</legend>${stale?'<p class="notice warning">旧选择或辅助状态已改变，请重新选择经典或完全自定义。</p>':''}<div class="flow-mode-options"><label class="flow-mode-option" for="flow-choice-classic"><input id="flow-choice-classic" type="radio" name="flowName" value="classic" required data-draft="${attr(key)}" ${selected==='classic'&&!stale?'checked':''}><span><strong>经典 DreamFlow</strong><small>Codex 规划 → DSH 执行 → 独立 Codex 审查。不经过 Magpie。</small></span></label><label class="flow-mode-option" for="flow-choice-custom"><input id="flow-choice-custom" type="radio" name="flowName" value="custom" required data-draft="${attr(key)}" ${selected==='custom'&&!stale?'checked':''} ${!customSetup?'disabled':''}><span><strong>完全自定义 DreamFlow</strong><small>分别配置角色、执行器、账户和模型；使用专用 Magpie，不使用 Laya。${!customSetup?'自定义运行暂未连接，原始网关安全验证尚未就绪。':customPending?'需先完成该项目账户、模型与运行器核验，核验不会自动批准制作。':''}</small></span></label></div><label class="check"><input type="checkbox" name="flowLaya" data-draft="${attr(layaKey)}" ${selected==='classic'&&wantsLaya&&!stale?'checked':''} ${selected!=='classic'||!layaAvailable?'disabled':''}>在经典模式中使用可选 Laya 辅助</label><p id="flow-mode-explanation" class="hint">方案助手独立于工程模式。选择方式不会启动模型；仍需下面单独批准制作。Laya 不可用时可以不选，辅助建议不能批准操作或替代检查。</p></fieldset>`;
}
function verifierExpectation(c:NativeVerifierPlan['plan']['cases'][number]):string {
 const output=Object.hasOwn(c,'expectedJson')?`<dt>预期 JSON 结果</dt><dd><pre tabindex="0">${e(JSON.stringify(c.expectedJson))}</pre></dd>`
  :Object.hasOwn(c,'expectedStdoutPrefix')?`<dt>预期标准输出前缀</dt><dd><pre tabindex="0">${e(JSON.stringify(c.expectedStdoutPrefix))}</pre></dd>`
  :Object.hasOwn(c,'expectedStdoutMatch')?`<dt>预期标准输出正则</dt><dd><pre tabindex="0">${e(JSON.stringify(c.expectedStdoutMatch))}</pre></dd>`
  :`<dt>预期标准输出（JSON）</dt><dd><pre tabindex="0">${e(JSON.stringify(c.expectedStdout))}</pre></dd>`;
 const diagnostics=Object.hasOwn(c,'expectedStderr')?`<dt>预期标准错误（JSON）</dt><dd><pre tabindex="0">${e(JSON.stringify(c.expectedStderr))}</pre></dd>`
  :Object.hasOwn(c,'expectedStderrPrefix')?`<dt>预期标准错误前缀</dt><dd><pre tabindex="0">${e(JSON.stringify(c.expectedStderrPrefix))}</pre></dd>`
  :Object.hasOwn(c,'expectedStderrMatch')?`<dt>预期标准错误正则</dt><dd><pre tabindex="0">${e(JSON.stringify(c.expectedStderrMatch))}</pre></dd>`:'';
 const fixtures=c.fixtures?`<dt>预置文件</dt><dd><pre tabindex="0">${e(JSON.stringify(c.fixtures,null,2))}</pre></dd>`:'';
 return output+diagnostics+fixtures;
}
export function verifierContent(data:NativeVerifierPlan):string {
 return `<h2 id="dialog-title">确认原生验收计划</h2><p id="dialog-description">批准测试计划，不代表测试已执行，也不授予规格、构建或成果批准。</p><dl class="verifier-binding"><dt>规格标识</dt><dd><code>${e(data.plan.specHash)}</code></dd><dt>计划标识</dt><dd><code>${e(data.sha256)}</code></dd></dl>
 ${data.plan.cases.map(c=>`<details class="spec-section" open><summary>${e(c.id)} · 需求 ${e(c.requirementIds.join(', '))}${c.acceptanceIds?.length?' · 验收 '+e(c.acceptanceIds.join(', ')):''}</summary><dl>${c.acceptanceIds?.length?`<dt>关联验收项</dt><dd>${e(c.acceptanceIds.join(', '))}</dd>`:''}<dt>运行入口</dt><dd><code>${e(c.runtime)} ${e(c.entry)}</code></dd><dt>参数（JSON）</dt><dd><pre tabindex="0">${e(JSON.stringify(c.args))}</pre></dd><dt>标准输入（JSON）</dt><dd><pre tabindex="0">${e(JSON.stringify(c.stdin))}</pre></dd><dt>预期退出码</dt><dd>${e(c.expectedExitCode)}</dd>${verifierExpectation(c)}</dl></details>`).join('')}
 <form id="native-verifier-form"><label class="check"><input type="checkbox" name="verifierConsent" required>我确认这些测试输入、预期结果与需求的对应关系。</label><div class="actions"><button type="button" data-action="close-modal">暂不确认</button><button type="submit" class="primary">确认这份验收计划</button></div></form>`;
}
function semanticEditor(v:ViewState):string{
 const s=v.snapshot!.spec!,rows=semanticRows(s),used=new Set(rows.map(row=>row.item.id));
 const extra=(s.acceptanceItems??[]).filter(item=>!used.has(item.id));
 const kinds=[['unclassified','未分类'],['functional','功能'],['nonfunctional','质量与性能'],['constraint','限制'],['out-of-scope','范围外']];
 const key=(name:string)=>'semantics:'+s.id+':'+name;
 const draft=(name:string,fallback:string)=>v.hasDraft(key(name))?v.draft(key(name)):fallback;
 return `<details class="spec-section" id="semantics-editor"><summary>需求分类与验收 <span>${s.semanticConfirmation?'用户已确认 · 尚未执行':'尚未确认'}</span></summary><form id="semantics-form" data-key="semantics-${attr(s.id)}">${rows.map(({requirement:r,item})=>`<section class="semantic-requirement"><h3>${e(r.id)}</h3><p class="preserve">${e(r.text)}</p><div class="semantic-fields"><div><label for="kind-${attr(r.id)}">类型</label><select id="kind-${attr(r.id)}" name="kind-${attr(r.id)}" data-draft="${attr(key('kind-'+r.id))}">${kinds.map(([id,text])=>`<option value="${id}" ${draft('kind-'+r.id,r.kind??'unclassified')===id?'selected':''}>${text}</option>`).join('')}</select></div><div><label for="priority-${attr(r.id)}">优先级</label><select id="priority-${attr(r.id)}" name="priority-${attr(r.id)}" data-draft="${attr(key('priority-'+r.id))}">${[['must','必须'],['should','建议']].map(([id,text])=>`<option value="${id}" ${draft('priority-'+r.id,r.priority)===id?'selected':''}>${text}</option>`).join('')}</select></div></div><label for="criterion-${attr(r.id)}">${e(item.id)} · 验收操作与预期结果</label><textarea id="criterion-${attr(r.id)}" name="criterion-${attr(r.id)}" data-draft="${attr(key('criterion-'+r.id))}" rows="2" maxlength="2000">${e(draft('criterion-'+r.id,item.criterion))}</textarea></section>`).join('')}${extra.map(item=>`<p class="note-line preserve">${e(item.id)} → ${e(item.requirementIds.join(', '))}: ${e(item.criterion)}</p>`).join('')}<label class="check"><input type="checkbox" name="semanticConsent" required>我确认以上分类、优先级和验收条件。</label><div class="actions"><button type="submit" class="primary">确认分类与验收</button></div></form></details>`;
}
function runView(v:ViewState):string{
 const reportAction=(v.mode==='local'&&['READY_FOR_DELIVERY','ACCEPTED','CANCELLED','BLOCKED','FAILED','PARTIAL'].includes(v.snapshot!.runs[0].state)?`<div class="actions">${button('flow-report','查看本轮报告与下一步','secondary')}</div>`:'')+reviewPreparationNotice(v.snapshot,v.mode==='local'&&v.presentation!=='frontend-review')+reviewWindowNotice(v.snapshot,v.mode==='local'&&v.presentation!=='frontend-review')+reviewSupplementNotice(v.snapshot,v.mode==='local'&&v.presentation!=='frontend-review');
 const databaseStatus=sqliteStatusEntry(v.snapshot,v.mode==='local'&&v.presentation!=='frontend-review');
 const r=v.snapshot!.runs[0],running=['PLANNING','IMPLEMENTING','VERIFYING','REVIEWING','REPAIRING'].includes(r.state);
 const verdict=({CODEX:'Codex 审查',DSH:'DSH 审查',INDEPENDENT_API:'独立接口审查',KIMI_SERVER:'Kimi 审查',CLAUDE_CODE:'Claude Code 审查',OPENCODE_CLI:'OpenCode 审查',CLINE_CLI:'Cline 审查',DEMO_RULES:'规则审查'} as Record<string,string>)[r.review?.source??'']??'审查来源未确认';
 return `<section class="card run-summary"><div class="section-heading"><div><span class="eyebrow">BUILD WORKSPACE</span><h2>${e(label(r.state))}</h2></div>${pill(v.mode==='public-demo'?'合成场景':r.mode==='demo'?'本地固定 Demo':'LIVE','warning')}</div><p>${v.mode==='public-demo'?'这是你控制的演示时间线：按钮只切换合成状态，不运行模型或测试。':'状态来自同源服务。暂停与取消只在后端确认后显示完成。'}</p>${r.reason?`<div class="notice warning preserve">${e(reviewSupplementError(r.reason)??reviewPreparationError(r.reason)??executorCheckpointError(r.reason)??mergeRecoveryError(r.reason)??r.reason)}</div>`:''}${reportAction}${mergeRecoveryNotice(r,v.mode==='local'&&v.presentation!=='frontend-review')}${executorCheckpointNotice(r,v.mode==='local'&&v.presentation!=='frontend-review')}
 ${databaseStatus}<dl class="run-metrics"><div><dt>任务</dt><dd>${r.tasks.filter(t=>t.status==='done').length} <span>/ ${r.tasks.length} 已完成</span></dd></div><div><dt>返修</dt><dd>${r.repairCount} <span>/ ${r.maxRepairs} 轮</span></dd></div><div><dt>${r.reviewSupplement?'原工程调用':'顶层派发'}</dt><dd>${r.calls} <span>/ ${r.maxCalls}</span></dd></div></dl><div class="actions wrap">${running?button('pause','暂停','secondary'):''}${r.state==='PAUSED'?button('resume','继续运行','primary'):''}${r.state==='READY_FOR_DELIVERY'?button('accept','接受成果','primary'):''}${!['READY_FOR_DELIVERY','ACCEPTED','CANCELLED','CANCEL_REQUESTED'].includes(r.state)&&r.mergeRecoveryRequired!==true&&r.executorCheckpointRequired!==true?button('cancel','取消运行','danger-outline'):''}${button('refresh','刷新状态','text-button')}${['READY_FOR_DELIVERY','ACCEPTED'].includes(r.state)?button('tab','查看成果文件 →','primary','data-tab="files"'):''}</div>
 ${v.mode==='public-demo'?`<div class="scenario-controls"><div><span class="micro">仅 UI 演示</span><p class="hint">不会用动画或计时器推测进度。</p></div>${!['READY_FOR_DELIVERY','ACCEPTED','PAUSED','CANCELLED','BLOCKED','FAILED','PARTIAL'].includes(r.state)?button('demo-step',r.state==='PAUSE_REQUESTED'?'模拟到达暂停检查点':r.state==='CANCEL_REQUESTED'?'模拟清理完成':'演示：推进下一步 →','secondary'):''}<label for="scenario">查看状态场景</label><select id="scenario" name="scenario"><option value="">选择一个合成状态…</option>${['IMPLEMENTING','PAUSE_REQUESTED','PAUSED','CANCEL_REQUESTED','CANCELLED','REPAIRING','BLOCKED','FAILED','PARTIAL','READY_FOR_DELIVERY'].map(s=>`<option value="${s}">${e(label(s))}</option>`).join('')}</select></div>`:''}</section>
 <section class="card"><div class="section-heading"><h2>工程任务</h2><span class="hint">依赖 → 制作 → 验证</span></div><div class="tasks">${r.tasks.map((t,i)=>`<details class="task" data-key="task-${attr(t.id)}"><summary><span class="task-index">${t.status==='done'?'✓':String(i+1).padStart(2,'0')}</span><span class="task-title">${e(t.title)}</span>${pill(sourceTaskLabel(t.status,r.state),t.status==='done'?'success':'neutral')}</summary><div class="task-detail"><p>依赖：${t.dependsOn.map(e).join(' / ')||'无前置任务'}</p><p>需求：${t.requirementIds.map(e).join(' / ')||'未记录'}</p>${t.acceptance.map(a=>`<p>${e(a)}</p>`).join('')}</div></details>`).join('')||'<p class="empty">计划尚未返回；不会显示虚构任务。</p>'}</div></section>
 <section class="card"><div class="section-heading"><h2>审查与返修</h2>${pill(`${r.findings.filter(f=>f.status==='open').length} 个未解决`)}</div>${r.findings.map(f=>`<article class="finding" data-key="finding-${attr(f.id)}"><div class="row wrap">${pill(({critical:'严重',high:'高',medium:'中',low:'低'})[f.severity],f.status==='open'?'danger':'success')}${pill(f.status==='open'?'未解决':'已解决')}<code>${e(f.id)}</code></div><h3>${e(f.description)}</h3><p class="preserve">${e(f.evidence)}</p></article>`).join('')||'<p class="hint">暂无问题记录。没有记录不等于已经通过审查。</p>'}<p class="hint">${r.review?`${verdict}：${e(r.review.verdict)}${v.mode==='public-demo'?'（合成演示，不是实际审查）':''}`:'独立审查结果尚未返回。'}</p></section>
 <section class="card"><div class="section-heading"><h2>验证记录</h2>${pill(r.verification?(v.mode==='public-demo'?'合成状态':r.verification.ok?'已通过记录':'验证失败'):'未运行',r.verification?.ok?'success':'neutral')}</div>${r.verification?`<p class="hint">退出码：${r.verification.exitCode??'未知 / 未执行'} · ${e(r.verification.evidenceId)}</p><pre tabindex="0">${e([r.verification.stdout,r.verification.stderr].filter(Boolean).join('\n'))}</pre>`:'<p class="hint">等待受信验证器结果，不把文件已生成或端口开放视为通过。</p>'}</section>`;
}
function logs(v:ViewState):string {
 return `<section class="card"><div class="section-heading"><h2>事件与证据</h2>${pill(v.mode==='public-demo'?'合成事件':({connecting:'正在连接',connected:'事件流已连接',reconnecting:'断流 · 正在重连',closed:'未订阅'})[v.connection],v.connection==='reconnecting'?'warning':'neutral')}</div><p class="hint">操作与工具事件，不是模型私有思维链。保留阅读位置，不自动抢滚动。</p><div class="actions">${button('latest','回到最新 ↓','small')}${v.events.length>v.logLimit?button('more-logs','查看更多事件','small'):''}</div><div id="event-log" class="event-log" tabindex="0" aria-label="事件日志">${v.events.slice(-v.logLimit).map(x=>`<article class="event" data-key="event-${x.id}"><span>${e(date(x.at))}</span><div><strong>${e(x.type)}</strong><details><summary>查看事件内容</summary><pre>${e(JSON.stringify(x.payload,null,2))}</pre></details></div></article>`).join('')||'<p class="empty">暂无已接收的事件。</p>'}</div><details class="spec-section"><summary>已保存的后端记录 (${v.snapshot!.records.length})</summary>${v.snapshot!.records.slice(-30).map(r=>`<details class="record"><summary>${e(r.kind)} · ${e(date(r.at))}</summary><pre>${e(JSON.stringify(r.data,null,2))}</pre></details>`).join('')}</details></section>`;
}
function filesView(v:ViewState):string{
 const r=v.snapshot!.runs[0];if(!r)return '<section class="card empty"><h2>成果尚未制作。</h2><p>确认规格并批准构建后，文件将在这里出现。</p></section>';
 const ready=['READY_FOR_DELIVERY','ACCEPTED'].includes(r.state);
 const runtime=r.plan&&typeof r.plan==='object'?(r.plan as {dataRuntime?:{schema?:unknown;protocol?:unknown}}).dataRuntime:undefined;
 const declared=runtime?.schema==='dream-maker.json-runtime-plan.v1'&&runtime.protocol==='JSON_DOCUMENT_V1';
 return `<section class="card"><div class="section-heading"><h2>成果与验证边界</h2>${pill(label(r.state),runTone(r.state))}</div><p>${v.mode==='public-demo'?'文件为固定 UI 样例，导出的是标明合成来源的 JSON 记录，不是 Agent 生成的项目。':r.mode==='demo'?'本地 Demo 的固定学习任务板，不是任意灵感生成结果。':'Live 产物仍需结合当前源码、工具证据和实际业务验收。'}</p><div class="actions wrap">${ready?button('export',v.mode==='public-demo'?'导出演示记录 JSON':'导出源码 ZIP','primary'):''}${ready?button('preview','打开隔离样例预览','secondary'):''}${r.state==='READY_FOR_DELIVERY'?button('accept',v.mode==='public-demo'?'接受这个演示成果':'接受当前成果','secondary'):''}${button('files-refresh','刷新文件列表','text-button')}</div><dl class="metrics"><div><dt>验证环境</dt><dd>${v.mode==='public-demo'?'合成示例，未运行模型':'以验证记录为准'}</dd></div><div><dt>Live 四角色联调</dt><dd>本轮 UI 不提供此项证明</dd></div></dl></section>
 ${v.mode==='local'&&v.presentation!=='frontend-review'&&r.mode==='live'&&ready?jsonDataPanel(v.jsonData,declared):''}
 <section class="file-explorer card"><nav aria-label="成果文件列表">${v.files.map(f=>button('file',`<span aria-hidden="true">▤</span> ${e(f.path)}`,'file-button'+(v.fileName===f.path?' active':''),`data-path="${attr(f.path)}"`)).join('')||'<p class="hint">文件列表未加载，或尚无产物。</p>'}</nav><div class="file-content"><div class="row between"><h3>${e(v.fileName||'选择一个文件')}</h3>${v.fileName?button('copy-file','复制','small'):''}</div><pre tabindex="0">${e(v.fileText||'文件内容在此以纯文本显示，不会作为 HTML 执行。')}</pre></div></section>
 ${v.previewUrl?`${v.mode==='local'?managedPreviewPanel(v.previewProtocol,v.previewData):''}<section class="card preview-card"><div class="section-heading"><h2>隔离预览</h2>${pill(v.mode==='public-demo'?'固定 UI 样例':'独立来源')}</div><iframe data-key="preview-${attr(r.id)}" src="${attr(v.previewUrl)}" title="固定学习任务板样例预览" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><p class="hint">${v.mode==='public-demo'?'固定样例在刷新后重置，不保存真实数据。':'仅开放已校验固定样例的任务数据保存；不开放主应用、文件或模型接口。'}</p></section>`:''}`;
}
/** One flow block. The wording rule: a blocked flow names the blocking code, and an allowed
 * flow never claims it was used -- "can run" is not "did run". */
function flowCard(f:FlowBlock):string {
 const active=Object.entries(f.layaRoles).filter(([,s])=>s!=='off').map(([r])=>r);
 const Laya=f.layaCoupled?('（经过 '+(active.length?active.join('/'):'无角色')+'）'):'（不经过 Laya）';
 const configured=f.setupAllowed===true,status=!f.blockedBy?'模式配置可用':configured?'配置可用，待资格核验':'尚未连接';
 return `<div class="rail-info" data-flow="${attr(f.name)}"><div class="row between"><h3>${e(f.label)}</h3>${pill(status,f.blockedBy?'warning':'good')}</div><p class="hint">${f.name==='classic'?'Codex 规划 → DSH 执行 → 独立 Codex 审查；可选 Laya。':'逐角色与执行器配置模型、账户和运行器；不使用 Laya。'}</p><details><summary>连接条件</summary><p class="hint">Laya ${e(f.layaMode)}${e(Laya)}</p><p class="hint">${e(f.reason)}</p></details></div>`;
}
function flows(v:ViewState):string {
 const blocks=v.settings?.flows??[];
 if(!blocks.length)return '';
 return `<section class="card" data-key="flows"><div class="section-heading"><h2>两种工程模式</h2><span class="micro">DREAMFLOW</span></div><p class="hint">方案助手独立选择，不属于工程模式。经典模式可选 Laya；完全自定义使用专用 Magpie。连接条件与真实角色验收分别核对，这里不会将界面选择当作制作成功。</p><div class="flow-mode-options">${blocks.map(flowCard).join('')}</div></section>`;
}
function planner1Settings(v:ViewState,c:PublicConfig['config']):string {
 const binding=v.settings?.planner1Binding,provider=binding?.provider??c.planner1.provider??'openai';
 if(provider==='local')return `<h2>Seeker · 需求澄清</h2><p><strong>本机 Ollama</strong> · <code>${e(binding?.model??c.planner1.model)}</code></p><p class="hint">固定只访问回环地址 <code>127.0.0.1:11434</code>，不显示 API Key、任意端点或其他云端协议字段。真实可用性以本机检查结果为准；其他三个角色仍需分别核验。</p><div class="actions">${button('planner1-choice','管理本机方案助手','secondary')}</div>`;
 return `<h2>Seeker · 需求澄清</h2><label for="auth-mode">Seeker 模型来源</label><select id="auth-mode" name="authMode"><option value="api_key" ${c.planner1.authMode==='api_key'?'selected':''}>使用 API Key（保留既有合法计费方式）</option><option value="siwc_plan" ${c.planner1.authMode==='siwc_plan'?'selected':''}>使用 ChatGPT 套餐（如账号符合资格）</option></select><p class="hint">显式切换；套餐模式失败不会自动调用 API Key。API 模式的原模型、密钥变量和其他三个角色保持独立。</p><label for="protocol">提供方协议</label><select id="protocol" name="protocol"><option value="openai-responses" ${c.planner1.protocol==='openai-responses'?'selected':''}>OpenAI · Responses API</option><option value="chat-completions" ${c.planner1.protocol==='chat-completions'?'selected':''}>DeepSeek · Chat Completions</option></select><label for="p1-model">模型 ID</label><input id="p1-model" name="p1Model" value="${attr(c.planner1.model)}" autocomplete="off" spellcheck="false" placeholder="填写账户可用的真实模型 ID…"><p class="hint">凭据：${v.settings!.keyStatus.planner1?'已设置，不代表有效':'未设置'} · ${e(c.planner1.keyEnv)}</p>${button('models','明确请求：读取模型列表','secondary')}`;
}
function settings(v:ViewState):string {
 const c=v.settings?.config;if(!c)return '<section class="card"><h1>配置尚未读取。</h1></section>';
 const siwcPanel=v.settings?.planner1Binding?.runner!=='siwc-sdk'?'':v.settings.planner1Retired?'<section class="notice"><h2>旧套餐连接路径已退役</h2><p>这里不会再请求该连接状态。请显式选择 Kimi、官方 API 或本机 Ollama；旧项目历史仍保留。</p></section>':'<div id="siwc-local-panel" data-key="siwc-local-panel"></div>';
 if(v.presentation==='frontend-review')return settingsOverview(v);
 if(v.mode==='public-demo')return `<section class="page-heading"><div class="eyebrow">CONNECTIONS / READ ONLY</div><h1>你的模型，你的控制权。</h1><p>公开演示不接受密钥、口令、部署 token 或本机路径。</p></section><section class="card"><h2>真实连接留在本地。</h2><p>这里只展示四角色分工与状态样式。没有“假连接成功”按钮，不探测 127.0.0.1，不触发真实 Agent。</p><div class="settings-roles">${roles(v)}</div></section><section class="card"><h2>Laya 的三种情况</h2><div class="state-examples">${pill('OFF · 配置关闭')}${pill('未连接 · 没有诊断证据','warning')}${pill('降级 · 以实际事件为准','warning')}</div><p class="hint">这些是状态说明，不是你设备上的实测结果。</p>${button('local-help','查看本地版启动说明','primary')}</section>`;
 return `${settingsOverview(v)}<details class="card advanced-settings"><summary>高级连接与运行设置 · 修改前请核对影响</summary><form id="settings-form" data-key="settings-form"><section class="card">${v.product==='dreamflow'?'<h2>由你提供方案</h2><p>独立 DreamFlow 不使用 Kimi 或其他需求访谈账户。下方只检查工程角色。</p>':planner1Settings(v,c)}
 <hr><h2>Planner / Reviewer · 工程规划与审查</h2><label for="codex-model">Codex 模型 ID</label><input id="codex-model" name="codexModel" value="${attr(c.codex.model)}" autocomplete="off" spellcheck="false" placeholder="填写本机 Codex 支持的模型…"><p class="hint">两个独立会话。程序路径、登录目录与权限由本机受控配置提供。</p><hr><h2>Executor · 执行制作</h2><p>DSH · ${e(c.dsh.model)}</p><p class="hint">Key：${v.settings!.keyStatus.executor?'已设置，不代表有效':'未设置'} · 原生挂载、模型路由和隔离能力以本机验收为准。</p></section>
 <section class="card"><div class="row between"><div><h2>Clash 节点路由</h2><p class="hint">只读取现有 Clash for Windows；控制器密钥和配置路径不会进入网页。</p></div>${pill(v.clash?.status??(c.clash.enabled?'尚未检查':'已关闭'),v.clash?.recoveryRequired?'danger':c.clash.enabled?'warning':'neutral')}</div><label class="check"><input type="checkbox" name="clashEnabled" ${c.clash.enabled?'checked':''}>让 DreamMaker 的外部模型请求使用受控网络连接</label><div class="form-grid"><div><label for="clash-selection-policy">节点选择方式</label><select id="clash-selection-policy" name="clashSelectionPolicy"><option value="current" ${(c.clash.selectionPolicy??'pinned')==='current'?'selected':''}>跟随我在 CFW 当前选择的节点（不自动切换）</option><option value="pinned" ${(c.clash.selectionPolicy??'pinned')==='pinned'?'selected':''}>固定到下面选择的节点（运行后恢复原选择）</option></select></div><div><label for="clash-selector">选择器</label><select id="clash-selector" name="clashSelector"><option value="">请选择</option>${(v.clash?.selectors??[]).map(item=>`<option value="${attr(item.name)}" ${c.clash.selector===item.name?'selected':''}>${e(item.name)} · 当前 ${e(item.now)}</option>`).join('')}</select></div><div><label for="clash-node">固定节点（仅固定模式）</label><select id="clash-node" name="clashNode"><option value="">当前选择</option>${(v.clash?.nodes??[]).map(item=>`<option value="${attr(item.name)}" ${c.clash.node===item.name?'selected':''}>${e(item.name)} · ${e(item.type)}</option>`).join('')}</select></div></div><input type="hidden" name="clashExpectedMode" value="${attr(c.clash.expectedMode)}"><p class="hint">跟随当前选择不会改动你的节点；固定模式只会在明确验证时临时切换并比较恢复。两种方式都不会把接口连通当作账户、服务资格或角色验收。</p><div class="actions">${button('clash-refresh','读取现有节点','secondary')}${button('clash-verify','验证当前连接','secondary',c.clash.enabled&&c.clash.selector&&((c.clash.selectionPolicy??'pinned')==='current'||c.clash.node)?'':'disabled')}${v.clash?.recoveryRequired?button('clash-recover','核对并恢复','danger-outline'):''}</div></section>
  <section class="card"><h2>可选本地 Laya</h2><label for="laya-mode">全局配置</label><select name="layaMode" id="laya-mode">${[['off','关闭 · 不发送分类请求'],['shadow','影子 · 记录但不采用'],['advisory','建议 · 分类与排序']].map(([id,t])=>`<option value="${id}" ${c.laya.mode===id?'selected':''}>${t}</option>`).join('')}</select><div class="form-grid">${Object.entries(roleNames).map(([id,n])=>`<div><label for="laya-${id}">${n} · ${roleDisplayNames[id] ?? id}</label><select id="laya-${id}" name="laya_${id}"><option value="inherit" ${c.laya.roles[id as keyof typeof c.laya.roles]==='inherit'?'selected':''}>继承全局</option><option value="off" ${c.laya.roles[id as keyof typeof c.laya.roles]==='off'?'selected':''}>该角色关闭</option></select></div>`).join('')}</div><p class="hint">开关表示配置，不是连接证据。共享既有模型；原生隐藏调用 OFF 仍需现场验收。</p>${layaProbePanel({result:v.layaProbe,error:v.layaProbeError,expectedRevision:c.laya.expectedRevision})}<div class="actions">${button('laya-probe','明确请求：检查本地 Laya','secondary')}</div></section>
 ${flows(v)}
 <section class="card"><h2>有界执行</h2><div class="form-grid">${[['maxRepairs','最大返修轮次',0,10,c.limits.maxRepairs],['maxCalls','顶层角色派发上限',1,100,c.limits.maxCalls],['maxSeconds','总时间上限（秒）',10,21600,c.limits.maxSeconds],['stepTimeoutMs','单回合总时限（毫秒）',1000,1800000,c.limits.stepTimeoutMs],['idleTimeoutMs','无进展超时（毫秒）',10000,900000,c.limits.idleTimeoutMs]].map(([id,n,min,max,val])=>`<div><label for="setting-${id}">${n}</label><input id="setting-${id}" name="${id}" type="number" min="${min}" max="${max}" value="${val}" required></div>`).join('')}</div><p class="notice">费用保持未知。顶层派发数不是内部模型请求数，此配置不是美元硬预算。计时包含暂停时间。</p><div class="actions">${button('diagnostics','查看只读诊断','secondary')}<button type="submit" class="primary">保存设置</button></div></section></form>${siwcPanel}<section id="diagnostics-output" class="${v.diagnostics?'card':'hidden'}"><h2>诊断原始响应</h2><pre tabindex="0">${e(v.diagnostics)}</pre></section></details>`;
}

/** A08 pre-work: the project payload carries three read-only states; this renders them as a short,
 * non-alarming strip. The wording rule matters: a closed gate must not read as "log in again". */
export function statusRail(v:ViewState):string {
 const status=(v.snapshot as unknown as {status?:{kimi?:{inferenceAllowed?:boolean;note?:string;admission?:unknown;credentials?:unknown;lastAuthFailure?:{class?:string;layer?:string}|null};laya?:{turns?:number;fullyOff?:boolean;reason?:string};shadow?:{mode?:string;requested?:string;degraded?:boolean;reason?:string|null}}} | null)?.status;
 if(!status) return '';
 const kimi=status.kimi,laya=status.laya,shadow=status.shadow;
 // Same tested wording as the diagnostics line: a raw code ("KIMI_EXTRA_USAGE_UNKNOWN") is not a
 // sentence, and a proven runtime rejection must not read as "可推理" on this surface either.
 const kimiSummary=summarizeKimiStatus({ admission: kimi?.admission, credentials: kimi?.credentials, inferenceAllowed: kimi?.inferenceAllowed, note: kimi?.note, lastAuthFailure: kimi?.lastAuthFailure ?? null } as never);
 const kimiText=kimiSummary.headline+(kimiSummary.needsLogin?'（需本人授权）':'');
 const kimiTone=kimiSummary.level==='ok'?'good':kimiSummary.level==='error'?'danger':'warn';
 const layaText=laya?.fullyOff?('本轮未使用 / '+String(laya?.turns??0)+' 次决策'):('尚未确认 / '+String(laya?.reason||'NO_TURNS_OBSERVED'));
 const shadowMode=shadow?.mode||'OFF';
 const shadowRecent=((v.snapshot as unknown as {status?:{shadow?:{recent?:string[]}}})?.status?.shadow?.recent)??[];
 const shadowText=(shadowMode==='OFF'?'OFF':(shadowMode+(shadowRecent.length?' · '+shadowRecent.slice(-2).join(' / '):'')))+(shadow?.degraded===true?' · 已降级（请求 '+String(shadow?.requested??'')+'）':'');
 return (v.product==='dreamflow'||v.snapshot?.project.planner1Mode==='USER'?'':'<section class="rail-info" data-rail="kimi"><div class="row between"><h3>Kimi 凭据与额度</h3>'+pill(kimiText,kimiTone)+'</div><p class="hint">认证状态与推理许可分开报告；门禁未开不等于需要重新登录。</p></section>')
  +'<section class="rail-info" data-rail="laya"><div class="row between"><h3>Laya 记录</h3>'+pill(layaText,laya?.fullyOff?'good':'neutral')+'</div><p class="hint">这是本轮辅助选择的记录；不代表真实模型内部的隐藏调用已经检查。</p></section>'
  +'<section class="rail-info" data-rail="shadow"><div class="row between"><h3>Orca SHADOW</h3>'+pill(shadowText,shadowMode==='OFF'?'neutral':'warn')+'</div></section>';
}

export function gateContent(v:ViewState):string {
 const p=v.snapshot!.project,n=p.answers.filter(a=>a.status==='answered').length;
 return `<span class="eyebrow">A MOMENT TO DECIDE</span><div class="gate-count">${n}<small>个有效回答，已保存</small></div><h2 id="dialog-title">这个想法，已经更清楚了。</h2><p id="dialog-description">现在整理成方案，还是再深入一点？没有你的选择，不会问下一题，也不会启动制作。</p><div class="dialog-actions">${button('finish','结束提问，整理方案','primary')}${button('continue',`继续下一组${p.batchSize===5?'五':'十'}题`,'secondary')}${button('review-answers','回看 / 修改回答','text-button')}</div><p class="hint">当前目标 ${p.batchTarget} 题 · ${v.mode==='public-demo'?'UI 演示数据':'已提交内容保存在本地服务'}</p>`;
}
