import { patchHtml } from './dom.js';
import { CHAT_ROLE_LABELS, CHAT_PHASE_LABELS } from './chat-types.js';
import { stageStripMarkup } from './chat-stages.js';
import type { ChatState, ChatController, ChatRole, ChatAction, ChatQuestion, ChatOption, ChatExtension, ChatRoleConfig } from './chat-types.js';

const e = (value:unknown):string => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const roles:ChatRole[] = ['seeker','planner','executor','reviewer'];
const roleCopy:Record<ChatRole,string> = {seeker:'探寻需求',planner:'规划路线',executor:'制作与执行',reviewer:'独立审查'};
const paths:Record<string,string> = {
 sidebar:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',
 arrow:'<path d="M12 19V5m-6 6 6-6 6 6"/>',chevron:'<path d="m9 6 6 6-6 6"/>',
 more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
 file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8m-8 4h5"/>',
 edit:'<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>',
 pin:'<path d="m16 3 5 5-4 2-3 6-2-2-7 7m3-14 6-3 2-4M8 7l9 9"/>',
 archive:'<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v13h14V8M10 12h4"/>',
 chat:'<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2A8.5 8.5 0 0 1 21 11.5Z"/>',
 star:'<path d="m12 2.7 2.85 5.78 6.38.93-4.61 4.49 1.09 6.35L12 17.25l-5.71 3 1.09-6.35-4.61-4.49 6.38-.93z"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
 check:'<path d="m5 12 4 4L19 6"/>',help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.5 2.5 0 1 1 4.3 1.8c-1.2.8-1.8 1.2-1.8 2.7m0 3h.01"/>',
 settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
 seeker:'<path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8z"/>',
 planner:'<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><path d="M17.5 14v7M14 17.5h7"/>',
 executor:'<path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5m-9 5v10M7.5 4.5l9 5"/>',
 reviewer:'<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z"/><path d="m8 11 3 3 5-5"/>',
 flow:'<circle cx="5" cy="5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><path d="M7 5h3a5 5 0 0 1 5 5v2h2M7 19h3a5 5 0 0 0 5-5v-2"/>',
 stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/>',
 download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',link:'<path d="m9 15 6-6m-4-3 2-2a5 5 0 0 1 7 7l-2 2m-5 5-2 2a5 5 0 0 1-7-7l2-2"/>',
};
export function chatIcon(name:string,cls=''):string { return `<svg class="dc-icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]??paths.chat}</svg>`; }
export function chatLogo():string { return '<svg class="dc-logo" viewBox="0 0 44 44" fill="none" aria-hidden="true"><rect x="2" y="2" width="40" height="40" rx="13" fill="currentColor"/><path d="M12 30V14h5a8 8 0 0 1 0 16h-5Z" stroke="var(--dc-logo-ink,#fff)" stroke-width="2.7" stroke-linejoin="round"/><path d="M23 30V14l5 8 5-8v16" stroke="var(--dc-logo-ink,#fff)" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
const avatar=(r:ChatRole)=>`<span class="dc-avatar dc-${r}">${chatIcon(r)}</span>`;
const disabled=(v:boolean)=>v?'':' disabled';
const stamp=(t?:string)=>{ if(!t)return '';const d=new Date(t);return Number.isNaN(d.getTime())?'':d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}); };
const size=(n:number)=>n<1024?`${n} B`:n<1024*1024?`${(n/1024).toFixed(1)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
const statusNames:Record<string,string>={pending:'待回答',answered:'已确认',changed:'已变更',added:'新增',working:'进行中',done:'已完成',blocked:'待处理',crafted:'已制作',verified:'已验证',reviewed:'已审查'};

/** Render-only shell. Every durable edit and all inference are delegated to the original controller. */
export function mountChatShell(root:HTMLElement, controller:ChatController):{render(state:ChatState):void;destroy():void} {
  let state:ChatState|null=null, collapsed=window.matchMedia('(max-width:820px)').matches, menu='', composer='', selectedChoices:string[]=[], choiceFreeText='';
  let localBusy=false, cancelPending=false, requirementDirty=false, lastRequirementRevision:number|undefined, localError='', composing=false, lastProject:string|null=null, lastQuestion='';
  let modalKind='', modalQuestion='', restoreFocus:HTMLElement|null=null, destroyed=false;
  const dialog=document.createElement('dialog');dialog.className='dc-dialog';dialog.setAttribute('aria-labelledby','dc-dialog-title');document.body.append(dialog);
  const fileInput=document.createElement('input');fileInput.type='file';fileInput.multiple=true;fileInput.hidden=true;fileInput.setAttribute('aria-label','添加项目参考文件');document.body.append(fileInput);
  const draftByProject=new Map<string,string>();
  const helpHistory=new Map<string,{user:boolean;text:string}[]>();
  const helpKey=(qid:string)=>`${state?.projectId??'new'}:${qid}`;
  const helpMarkup=(key:string)=>(helpHistory.get(key)??[]).map(m=>`<div class="dc-help-message${m.user?' dc-help-user':''}">${e(m.text)}</div>`).join('');
  const activeRoles=()=>state?.product==='df'?roles.slice(1):roles;
  const pending=()=>localBusy||state?.busy===true;
  const qActive=()=>state?.questions.find(q=>q.id===state?.activeQuestionId);
  const error=(err:unknown)=>{localError=err instanceof Error?err.message:'操作没有完成，请刷新状态后核对。';if(dialog.open){let warning=dialog.querySelector<HTMLElement>('.dc-modal-error');if(!warning){warning=document.createElement('p');warning.className='dc-modal-error';warning.setAttribute('role','alert');dialog.append(warning);}warning.textContent=localError;}repaint();};
  async function act(action:ChatAction):Promise<void|{text?:string}> {
    if(destroyed)return;
    localError='';dialog.querySelector('.dc-modal-error')?.remove();localBusy=true;repaint();
    try{return await controller.dispatch(action);}catch(err){error(err);return undefined;}finally{localBusy=false;repaint();}
  }
  function closeModal(){if(dialog.open)dialog.close();modalKind='';modalQuestion='';restoreFocus?.focus();}
  function openModal(kind:string,content:string,questionId=''){
    restoreFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;modalKind=kind;modalQuestion=questionId;
    dialog.innerHTML=`<button type="button" class="dc-icon-btn dc-dialog-close" data-action="modal-close" aria-label="关闭窗口">${chatIcon('close')}</button>${content}`;
    if(!dialog.open)dialog.showModal();
    requestAnimationFrame(()=>dialog.querySelector<HTMLElement>('textarea, input, select, button:not(.dc-dialog-close)')?.focus());
  }
  function projectRows(pinned:boolean){
    return state!.projects.filter(p=>p.product===state!.product&&!p.archived&&!!p.pinned===pinned).map(p=>`<div class="dc-project-row${p.id===state!.projectId?' is-active':''}" data-key="project-${e(p.id)}">
      <button class="dc-project-select" type="button" data-action="project-select" data-id="${e(p.id)}" ${p.id===state!.projectId?'aria-current="page"':''}>${chatIcon(pinned?'pin':'chat')}<span>${e(p.title)}</span></button>
      <button type="button" class="dc-project-more" data-action="project-menu" data-id="${e(p.id)}" aria-label="${e(p.title)}的项目操作" aria-expanded="${menu===`project:${p.id}`}">${chatIcon('more')}</button>
      ${menu===`project:${p.id}`?`<div class="dc-project-menu" role="menu"><button type="button" role="menuitem" data-action="project-rename" data-id="${e(p.id)}"${disabled(state!.capabilities.rename)}>${chatIcon('edit')}重命名</button><button type="button" role="menuitem" data-action="project-pin" data-id="${e(p.id)}"${disabled(state!.capabilities.pin)}>${chatIcon('pin')}${pinned?'取消置顶':'置顶项目'}</button><button type="button" role="menuitem" data-action="project-archive" data-id="${e(p.id)}"${disabled(state!.capabilities.archive)}>${chatIcon('archive')}归档项目</button></div>`:''}</div>`).join('');
  }
  function messageList(){return state!.messages.map(m=>{
    if(m.role==='system')return `<div class="dc-system-message" data-key="msg-${e(m.id)}">${chatIcon('check')}<span>${e(m.text)}</span></div>`;
    if(m.role==='user')return `<article class="dc-message dc-message-user" data-key="msg-${e(m.id)}" aria-label="你的消息"><div class="dc-user-bubble">${e(m.text)}</div>${m.at?`<time>${stamp(m.at)}</time>`:''}</article>`;
    return `<article class="dc-message dc-message-role dc-message-${m.role}" data-key="msg-${e(m.id)}" aria-label="${CHAT_ROLE_LABELS[m.role]}的消息"><div class="dc-message-heading">${avatar(m.role)}<span class="dc-speaker">${CHAT_ROLE_LABELS[m.role]}</span><span class="dc-message-purpose">${e(m.title||roleCopy[m.role])}</span>${m.badge?`<span class="dc-message-badge">${e(m.badge)}</span>`:''}${m.at?`<time>${stamp(m.at)}</time>`:''}</div><div class="dc-message-body">${e(m.text)}</div></article>`;
  }).join('');}
  function questionCard(q:ChatQuestion){return `<article class="dc-question-card" data-key="question-${e(q.id)}"><div class="dc-message-heading">${avatar('seeker')}<span class="dc-speaker">Seeker</span><span class="dc-message-purpose">把想法再靠近一步</span><span class="dc-question-counter">问题 ${state!.questions.indexOf(q)+1}${q.allowMultiple?' · 可多选':''}</span></div><h2>${e(q.text)}</h2><div class="dc-question-options">${(q.choices??[]).slice(0,4).map((c,i)=>`<button type="button" class="dc-option${selectedChoices.includes(c.id)?' is-selected':''}" data-action="answer-choice" data-id="${e(c.id)}" aria-pressed="${selectedChoices.includes(c.id)}"${disabled(state!.capabilities.answers&&!pending()&&!state!.locked)}><span class="dc-option-key">${String.fromCharCode(65+i)}</span><span><strong>${e(c.label)}</strong>${c.description?`<small>${e(c.description)}</small>`:''}</span>${chatIcon('chevron')}</button>`).join('')}<button type="button" class="dc-custom-option" data-action="custom-answer"${disabled(state!.capabilities.answers&&!state!.locked)}>${chatIcon('edit')}我有自己的想法，在下方输入</button></div><button type="button" class="dc-text-btn dc-question-explain" data-action="question-help" data-id="${e(q.id)}"${disabled(state!.capabilities.help)}>${chatIcon('help')}这道问题是什么意思？</button></article>`;}
  function requirementCard(){const r=state!.requirements;if(!r)return '';return `<article class="dc-requirement-card" data-key="requirements-${e(state!.projectId)}-${r.revision}"><div class="dc-message-heading">${state!.product==='dm'?avatar('seeker'):`<span class="dc-avatar dc-planner">${chatIcon('file')}</span>`}<span class="dc-speaker">${state!.product==='dm'?'你的需求，已经清晰了':'你提供的工程计划'}</span>${state!.product==='dm'?'<span class="dc-mini-pill">Prompt optimizer</span>':''}</div><p class="dc-muted">${state!.product==='df'&&state!.evidence==='live'?'这是你导入的结构化方案。修订请使用详细方案编辑器，保留需求与验收的对应关系。':'这是一份可编辑的需求。确认后，Planner 将据此规划，Prework 将它交接给 Executor。'}</p><label class="dc-sr" for="dc-requirement-draft">最终需求</label><textarea id="dc-requirement-draft" class="dc-requirement-draft" rows="10"${state!.locked||r.confirmed||state!.product==='df'&&state!.evidence==='live'?' readonly':''}>${e(r.text)}</textarea><div class="dc-requirement-footer"><span>${r.confirmed?`${chatIcon('lock')}已确认 · 保留批准版本`:`第 ${r.revision} 版 · 确认前可修改`}</span>${(!r.confirmed||state!.capabilities.confirm&&!state!.locked)?`<div class="dc-requirement-actions">${state!.product==='df'&&state!.evidence==='live'?`<a class="dc-secondary" href="${e(state!.legacyHref??'/?ui=legacy')}&amp;tab=spec">详细方案编辑器</a>`:!r.confirmed?`<button type="button" class="dc-secondary" data-action="requirements-save"${disabled(requirementDirty&&state!.capabilities.confirm&&!pending()&&!state!.locked)}>保存修改</button>`:''}<button type="button" class="dc-primary" data-action="requirements-confirm"${disabled(!requirementDirty&&state!.capabilities.confirm&&!pending()&&!state!.locked)} title="${requirementDirty?'请先保存修改，生成新版本后再确认':'确认当前显示的需求版本'}">${r.confirmed?'已确认，开始制作':'确认此版并开始制作'} ${chatIcon('chevron')}</button></div>`:''}</div></article>`;}
  function starRail(){if(state!.product==='df')return '';const qs=state!.questions.filter(q=>q.answer!==undefined||q.id===state!.activeQuestionId);if(!qs.length)return '';return `<aside class="dc-stars" aria-label="需求问答星轨"><div class="dc-stars-caption">需求星轨</div><div class="dc-star-track">${qs.map(q=>{const active=q.id===state!.activeQuestionId,st=q.status??(q.answer?'answered':'pending');return `<button type="button" class="dc-star ${active?'is-current':''} is-${e(st)}" data-action="${active?'question-help':'star-open'}" data-id="${e(q.id)}" aria-label="${active?'当前问题，还没回答':'查看问题'} ${state!.questions.indexOf(q)+1}：${e(q.text)}，${e(statusNames[st])}" title="${e(q.text)} · ${e(statusNames[st])}">${active?'<span class="dc-star-pit" aria-hidden="true"></span>':chatIcon('star')}<span class="dc-star-num">${state!.questions.indexOf(q)+1}</span><span class="dc-star-status">${active?'当前问题':e(statusNames[st])}</span>${st==='done'?`<span class="dc-star-check">${chatIcon('check')}</span>`:''}</button>`;}).join('')}</div>${state!.locked?`<div class="dc-stars-note">${chatIcon('lock')}本轮只读</div>`:'<div class="dc-stars-note">点击星星<br>回看与修改</div>'}</aside>`;}
  function addMenu(){if(menu!=='add')return '';return `<div class="dc-add-menu" role="menu" aria-label="添加文件或配置角色扩展"><button type="button" role="menuitem" data-action="add-file"${disabled(state!.capabilities.attachments&&!state!.locked)}>${chatIcon('file')}<span>添加文件</span><small>${state!.evidence==='live'?'TXT / MD / JSON':'参考资料'}</small></button>${activeRoles().map(r=>`<button type="button" role="menuitem" data-action="extensions" data-role="${r}">${avatar(r)}<span>${CHAT_ROLE_LABELS[r]}</span><small>Skills 与插件</small></button>`).join('')}</div>`;}
  function emptyState(){return `<div class="dc-welcome"><div class="dc-welcome-mark">${state!.product==='dm'?chatIcon('seeker'):chatIcon('flow')}</div><div class="dc-eyebrow">${state!.product==='dm'?'A LITTLE IDEA. A REAL BEGINNING.':'YOUR PLAN. INTO MOTION.'}</div><h1>${state!.product==='dm'?'让想法，有个开始。':'把计划，交给行动。'}</h1><p>${state!.product==='dm'?'告诉 Seeker 你想做什么。我们一起把模糊的灵感，变成清晰、可执行的需求。':'在这里，你就是需求的提出者。提供已准备的计划，Planner、Executor 与 Reviewer 接力完成。'}</p><div class="dc-suggestion-grid">${(state!.product==='dm'?['做一个个人阅读工作台','让每月记账更简单','把我的知识整理成网站']:['导入我的工程计划','查看已有项目进度','准备一份验收清单']).map((text,i)=>`<button type="button" data-action="suggestion" data-text="${text}">${chatIcon(['file','planner','flow'][i])}<span>${text}</span>${chatIcon('chevron')}</button>`).join('')}</div></div>`;}
  function repaint(){
    if(!state||destroyed)return;
    if(state.loading){root.innerHTML=`<div class="dc-splash" role="status" aria-label="Dream Maker 正在加载">${chatLogo()}<span class="dc-sr">正在加载</span></div>`;return;}
    const active=qActive(),hasContent=state.messages.length||active||state.requirements;
    const canSend=state.capabilities.send||Boolean(active&&state.capabilities.answers)||state.capabilities.followup===true;
    patchHtml(root,`<div class="dc-app${collapsed?' dc-collapsed':''}${state.product==='df'?' dc-product-df':''}" data-product="${state.product}"><a class="dc-skip" href="#dc-conversation">跳到对话</a><aside class="dc-sidebar" aria-label="项目导航"><div class="dc-sidebar-top"><button type="button" class="dc-brand" data-action="project-new" aria-label="Dream Maker 新聊天">${chatLogo()}<span>Dream Maker</span></button><button type="button" class="dc-icon-btn" data-action="sidebar" aria-label="收起侧边栏">${chatIcon('sidebar')}</button></div><div class="dc-product-switch" aria-label="产品模式"><button type="button" data-action="mode-dm" aria-pressed="${state.product==='dm'}">${chatIcon('seeker')}<span>Dream Maker</span></button><button type="button" data-action="mode-df" aria-pressed="${state.product==='df'}">${chatIcon('flow')}<span>DreamFlow</span></button></div><button type="button" class="dc-new-chat" data-action="project-new">${chatIcon('plus')}<span>新聊天</span><kbd>Ctrl K</kbd></button><nav class="dc-projects"><div class="dc-list-label">置顶项目</div>${projectRows(true)||'<p class="dc-empty-list">重要的想法，放在这里</p>'}<div class="dc-list-label dc-list-label-all">所有项目</div>${projectRows(false)||'<p class="dc-empty-list">从一个新想法开始</p>'}</nav><div class="dc-sidebar-footer"><div class="dc-storage-hint"><span class="dc-connection-dot${state.connected?' is-connected':''}"></span>${state.evidence==='demo'?'本地交互演示':state.connected?'已连接本地工作台':'本地工作台未连接'}</div><button type="button" class="dc-text-btn dc-archive-link" data-action="archives-open">${chatIcon('archive')}已归档</button><div class="dc-footer-actions"><button type="button" data-action="settings-open">${chatIcon('settings')}设置</button><button type="button" data-action="help-open">${chatIcon('help')}帮助</button></div><div class="dc-profile"><span class="dc-profile-avatar">你</span><div><strong>我的工作空间</strong><span>灵感留在这里，行动从此开始</span></div></div></div></aside><div class="dc-main"><header class="dc-topbar"><div class="dc-topbar-leading"><button type="button" class="dc-icon-btn dc-expand" data-action="sidebar" aria-label="展开侧边栏">${chatIcon('sidebar')}</button><div><div class="dc-project-title">${e(state.title||'新聊天')}${state.projectId?`<span class="dc-title-dot">·</span><span class="dc-title-context">${state.product==='dm'?'与 Seeker 一起':'DreamFlow'}</span>`:''}</div>${state.requirementVersion?`<div class="dc-project-subtitle">${e(state.requirementVersion)}</div>`:''}</div></div><div class="dc-topbar-right"><button type="button" class="dc-icon-btn" data-action="refresh" aria-label="刷新真实状态">${chatIcon('refresh')}</button></div></header>${state.evidence==='demo'?'<div class="dc-demo-banner">交互演示 · 不调用模型 <span>流程由你手动推进，演示结果不计入项目验收</span></div>':''}${state.notice?`<div class="dc-notice">${e(state.notice)}</div>`:''}<div class="dc-content-layout"><main id="dc-conversation" class="dc-conversation" tabindex="-1" aria-label="项目对话"><div class="dc-thread${!hasContent?' dc-thread-empty':''}">${hasContent?messageList()+(active?questionCard(active):'')+requirementCard():emptyState()}${state.capabilities.finishInterview&&!state.locked?`<div class="dc-interview-decision">${state.interviewDecisionRequired?'<p>已回答十个问题，先停下来由你决定下一步。</p>':''}<button type="button" class="dc-secondary" data-action="end-interview"${disabled(!pending())}>结束问答，整理需求 ${chatIcon('chevron')}</button></div>`:''}<div class="dc-thread-bottom" data-key="thread-bottom"></div></div></main>${starRail()}</div><footer class="dc-composer-area"><div class="dc-composer-inner">${localError||state.error?`<div class="dc-error" role="alert">${chatIcon('help')}<span>${e(localError||state.error)}</span><button type="button" data-action="dismiss-error" aria-label="收起本次提示">${chatIcon('close')}</button></div>`:''}${`<div class="dc-phase-row"><div class="dc-phase-strip" role="status" aria-live="polite">${stageStripMarkup(state,{activeDetail:CHAT_PHASE_LABELS[state.phase]})}</div>${state.evidence==='demo'&&state.demoStepLabel?`<button type="button" class="dc-demo-next" data-action="demo-step"${disabled(!pending())}>${e(state.demoStepLabel)} ${chatIcon('chevron')}</button>`:''}</div>`}${state.phaseDetail?`<p class="dc-phase-detail">${e(state.phaseDetail)}</p>`:''}<form class="dc-composer" id="dc-composer-form" data-key="composer"><div class="dc-attachments">${state.attachments.map(a=>`<div class="dc-attachment" data-key="attachment-${e(a.id)}">${chatIcon('file')}<span>${e(a.name)}<small>${size(a.size)} · ${a.status==='ready'?'已就绪':a.status==='selected'?'已选择':a.status==='uploading'?'上传中':'失败'}</small></span><button type="button" data-action="attachment-remove" data-id="${e(a.id)}" aria-label="移除 ${e(a.name)}"${disabled(!state!.locked)}>${chatIcon('close')}</button></div>`).join('')}</div>${state.attachments.length&&state.evidence==='live'?'<p class="dc-attachment-disclosure">支持 TXT / MD / JSON。发送时，附件内容会交给所选 API；请勿添加密钥或认证文件。</p>':''}<label class="dc-sr" for="dc-composer-input">${active?'回答当前问题':'输入你的想法'}</label><textarea id="dc-composer-input" data-key="composer-input" rows="2" maxlength="16000" placeholder="${active?'说说你的想法，也可以选择上面的回答…':state.capabilities.followup?'告诉 Seeker，下一版需要调整什么…':state.locked?'本轮正在执行，可随时查看上方进度与需求…':state.product==='dm'?'你想做些什么？把灵感交给 Seeker…':'写下你的计划，或添加一份需求文件…'}"${!canSend||pending()?' readonly':''}>${e(composer)}</textarea><div class="dc-composer-bottom"><div class="dc-composer-left"><button type="button" class="dc-icon-btn dc-plus" data-action="add-menu" aria-label="添加文件、Skills 或插件" aria-expanded="${menu==='add'}">${chatIcon('plus')}</button>${addMenu()}<button type="button" class="dc-icon-btn dc-mode-toggle${state.engineeringMode==='classic'?' is-on':''}" data-action="mode-toggle" aria-pressed="${state.engineeringMode==='classic'}" aria-label="${state.engineeringMode==='classic'?'已验证运行器已启用，点击关闭':'启用已验证运行器'}" title="${state.engineeringMode==='classic'?'已验证运行器已启用':'启用已验证运行器'}">${chatIcon('link')}</button></div><div class="dc-composer-right"><div class="dc-role-dock" aria-label="角色模型与运行器">${activeRoles().map(r=>`<button type="button" class="dc-role-button dc-${r}" data-action="role-config" data-role="${r}" aria-label="配置 ${CHAT_ROLE_LABELS[r]} 的模型、推理强度和 Harness" title="${CHAT_ROLE_LABELS[r]} · ${e(state!.roles[r].model||'待配置')}">${chatIcon(r)}<span class="dc-role-tooltip">${CHAT_ROLE_LABELS[r]}</span></button>`).join('')}</div><span class="dc-compose-separator"></span>${state.capabilities.cancel?`<button type="button" class="dc-send dc-stop" data-action="cancel" aria-label="停止当前运行" title="通过 Engine 停止当前运行"${disabled(!cancelPending)}>${chatIcon('stop')}</button>`:`<button type="submit" class="dc-send" aria-label="发送消息"${disabled(canSend&&!pending()&&composer.trim().length>0)}>${chatIcon('arrow')}</button>`}</div></div></form><div class="dc-bottom-note">${state.locked?`${chatIcon('lock')}${e(state.lockReason||'本轮需求与角色配置已冻结，星星仍可查看。')}`:state.product==='dm'?'Seeker 帮你澄清需求。每一次确认，都由你做主。':'所有执行沿用原 Engine 的权限、预算与验收。'}</div></div></footer></div></div>`);
    const input=root.querySelector<HTMLTextAreaElement>('#dc-composer-input');if(input&&document.activeElement!==input)input.value=composer;
  }
  function editStar(q:ChatQuestion){
    const writable=state!.capabilities.editAnswers&&!state!.locked;
    openModal('star',`<div class="dc-dialog-eyebrow">${chatIcon('star')}需求星轨 · 问题 ${state!.questions.indexOf(q)+1}</div><h2 id="dc-dialog-title">${e(q.text)}</h2><label class="dc-field-label" for="dc-star-answer">你的回答</label><textarea id="dc-star-answer" rows="5"${writable?'':' readonly'}>${e(q.answer||'尚未回答')}</textarea><div class="dc-status-line"><span class="dc-mini-pill">${e(statusNames[q.status??'answered'])}</span>${q.evidenceLabel?`<span>${e(q.evidenceLabel)}</span>`:''}</div>${q.requirementIds?.length?`<p class="dc-muted">关联需求：${q.requirementIds.map(e).join('、')}</p>`:''}<p class="dc-modal-note">${writable?'修改会产生新的回答版本。需求与批准会重新核对，不会覆盖已接受的历史。':'DreamFlow 正在使用已确认版本。待本轮安全结束并由原控制端允许修订后，可以另开修改版本。'}</p><div class="dc-dialog-footer"><button type="button" class="dc-secondary" data-action="modal-close">${writable?'取消':'关闭'}</button>${writable?`<button type="button" class="dc-primary" data-action="star-save" data-id="${e(q.id)}" data-revision="${q.revision??1}">保存新版本</button>`:''}</div>`,q.id);
  }
  function questionHelp(q:ChatQuestion){
    const key=helpKey(q.id);
    openModal('question-help',`<div class="dc-dialog-eyebrow">${avatar('seeker')}和 Seeker 聊聊这道题</div><h2 id="dc-dialog-title">${e(q.text)}</h2><p class="dc-muted">可以请它解释名词、举例或比较选项。这里的讨论不会自动成为你的正式回答。</p><div class="dc-help-thread" id="dc-help-thread">${helpMarkup(key)||'<div class="dc-help-message">你可以问：“这几个选项有什么区别？”或“可以用生活中的例子解释吗？”</div>'}</div><form id="dc-help-form" class="dc-help-form"><label class="dc-sr" for="dc-help-input">想了解的问题</label><textarea id="dc-help-input" rows="2" placeholder="哪里不明白？在这里问 Seeker…"${disabled(state!.capabilities.help)}></textarea><button type="submit" class="dc-send" aria-label="向 Seeker 提问"${disabled(state!.capabilities.help)}>${chatIcon('arrow')}</button></form>${!state!.capabilities.help?'<p class="dc-modal-note">当前模型解释接口尚未可用。可以查看题目并返回作答。</p>':''}`,q.id);
  }
  const options=(items:ChatOption[],current:string)=>items.map(o=>`<option value="${e(o.id)}"${o.id===current?' selected':''}${o.available?'':' disabled'}>${e(o.label)}${o.available?'':' · 未校验'}</option>`).join('');
  async function configureRole(role:ChatRole){
    // No request is fired while opening the picker: a hung call would leave the shell permanently
    // busy, and every later submit() would return early without saving anything.
    roleConfigBody(role,{...state!.roles[role]});
  }
  function roleConfigBody(role:ChatRole,r:ChatRoleConfig){
    // Classic no longer freezes the picker: choosing another harness or model is how a project leaves
    // classic, and leaving classic is exactly what turns Laya off.
    // Classic is the default, not a veto: choosing another harness or model is how a project leaves
    // classic, and leaving classic is exactly what turns Laya off. Only a locked project is read-only.
    const frozen=state!.locked;
    // The saved model must be selectable even when the projected list only knows the default one.
    if(r.model&&!r.models.some(m=>m.id===r.model))r.models=[{id:r.model,label:r.model+' · 已配置',available:true},...r.models];
    openModal('role-config',`<div class="dc-dialog-eyebrow">${avatar(role)}${roleCopy[role]}</div><h2 id="dc-dialog-title">配置 ${CHAT_ROLE_LABELS[role]}</h2><p class="dc-muted">${role==='seeker'?'通过已配置的 API 账户澄清需求，不要求 OAuth 登录。':state!.engineeringMode==='classic'?'当前是 classic（含 Laya）。改 Harness 或模型会切到 custom，Laya 随之关闭。':'只提供本机已验证、可与 Magpie 搭配的模型和运行器。'}</p><form id="dc-role-form" data-role="${role}">${r.providers?.length?`<label class="dc-field-label" for="dc-role-provider">API 服务商</label><select id="dc-role-provider" name="provider"${frozen?' disabled':''}>${options(r.providers,r.provider??'')}</select>`:''}<label class="dc-field-label" for="dc-role-model">模型</label>${r.modelEditable?`<input id="dc-role-model" name="model" value="${e(r.model)}" placeholder="输入服务商提供的精确模型 ID" maxlength="200"${frozen?' disabled':''}>`:`<select id="dc-role-model" name="model"${frozen?' disabled':''}>${r.models.length?options(r.models,r.model):'<option value="">模型目录尚未加载</option>'}</select>`}<div class="dc-two-fields"><div><label class="dc-field-label" for="dc-role-reasoning">推理强度</label><select id="dc-role-reasoning" name="reasoning"${frozen?' disabled':''}>${options(r.reasoningLevels,r.reasoning)}</select></div><div><label class="dc-field-label" for="dc-role-harness">Harness</label><select id="dc-role-harness" name="harness"${frozen?' disabled':''}>${options(r.harnesses,r.harness)}</select></div></div><div class="dc-account-caption">${chatIcon('lock')}<span>${e(r.providerLabel||'账户由本地控制端管理')} · ${e(r.authLabel||'尚未配置账户')}<small>密钥不会显示在聊天界面，也不会写入浏览器存储。</small></span></div>${frozen?`<p class="dc-modal-note">${state!.locked?'本轮模型、Harness 和权限保持冻结。':role!=='seeker'?'工程角色的配置在原高级设置中完成并核验；此处显示实际绑定。':'已有项目保留原绑定；请在新聊天中选择新的 API。'}</p>`:''}<div class="dc-dialog-footer"><button type="button" class="dc-secondary" data-action="modal-close">关闭</button><button type="button" class="dc-text-btn" data-action="${role==='seeker'?'settings-open':'engineering-settings-open'}">高级设置</button>${role==='seeker'?'':`<button type="button" class="dc-text-btn" data-action="role-restore">恢复默认（classic）</button>`}<button type="submit" id="dc-role-save" class="dc-primary"${disabled(!frozen)}>保存配置</button></div></form>`);
    if(role==='seeker'&&!frozen&&typeof controller.seekerModels==='function')void refreshSeekerModels(r.provider??'deepseek',r.model);
  }
  /** Provider switching refetches; the currently bound model stays selected when it is listed. */
  async function refreshSeekerModels(provider:string,preferred:string){
    const select=dialog.querySelector<HTMLSelectElement>('#dc-role-model'),save=dialog.querySelector<HTMLButtonElement>('#dc-role-save');
    if(!select||!controller.seekerModels||modalKind!=='role-config')return;
    dialog.querySelector('.dc-modal-error')?.remove();
    select.disabled=true;select.innerHTML='<option value="">正在读取模型目录…</option>';if(save)save.disabled=true;
    try{
      const models=await controller.seekerModels(provider);
      if(!dialog.open||modalKind!=='role-config'||dialog.querySelector<HTMLSelectElement>('#dc-role-provider')?.value!==provider)return;
      const selected=models.some(option=>option.id===preferred&&option.available)?preferred:(models.find(option=>option.available)?.id??models[0]?.id??'');
      select.innerHTML=models.length?options(models,selected):'<option value="">服务端没有返回可用模型</option>';
      select.disabled=false;if(save)save.disabled=!selected||state!.locked||state!.roles.seeker.frozen===true||!state!.capabilities.configureRoles;
    }catch(err){
      if(dialog.open&&modalKind==='role-config'){select.innerHTML='<option value="">模型目录不可用</option>';error(err);}
    }
  }
  /** Server-supplied skill/plugin lists per role; kept outside the projected state so repaint keeps them. */
  const extensionCache:Partial<Record<ChatRole,{extensions:ChatExtension[];selected:string[]}>>={};
  let lastExtensionRole:ChatRole|null=null;
  let extensionPrefetchFor='';
  /**
   * Fill extensionCache for one project. Called from render, never from a click handler, so opening the
   * panel is always a synchronous paint of what is already known.
   */
  function prefetchExtensions(pid:string){
    if(extensionPrefetchFor===pid)return;
    extensionPrefetchFor=pid;
    void (async()=>{
      try{
        const choices=controller.roleChoices;
        if(typeof choices!=='function'){extensionPrefetchFor='';return;}
        const all=await choices.call(controller,pid);
        if(!all){extensionPrefetchFor='';return;}
        for(const key of Object.keys(all) as ChatRole[]){
          const row=all[key];
          if(!state?.roles[key])continue;
          extensionCache[key]={extensions:[...(row.skills??[]),...(row.plugins??[])],selected:[...(row.selected??[])]};
        }
        if(lastExtensionRole&&modalKind==='extensions')extensionPanelBody(lastExtensionRole);
      }catch{extensionPrefetchFor='';}
    })();
  }
  function extensionPanel(role:ChatRole){
    lastExtensionRole=role;
    extensionPanelBody(role);
    const pid=state!.projectId;
    if(pid&&role!=='seeker')void prefetchExtensions(pid);
  }
  /** Saved per-role selection from the server: the projection hardcodes dsh/codex, this is the truth. */
  const roleCurrent: Partial<Record<ChatRole,{harness:string;model:string;effort:string}>> = {};
  let rolePrefetchFor = '';
  function prefetchRoleCurrent(pid:string){
    if(rolePrefetchFor===pid)return;
    rolePrefetchFor=pid;
    const choices=controller.roleChoices;
    if(typeof choices!=='function')return;
    void (async()=>{
      try{
        const all=await choices.call(controller,pid);
        if(!all)return;
        for(const key of Object.keys(all) as ChatRole[]){
          const cur=all[key]&&all[key].current;
          if(cur)roleCurrent[key]={harness:cur.harness,model:cur.model,effort:cur.effort};
        }
        if(!state)return;
        for(const key of Object.keys(roleCurrent) as ChatRole[]){
          const c=roleCurrent[key],r=state.roles[key];
          if(!c||!r)continue;
          if(c.harness)r.harness=c.harness;
          if(c.model)r.model=c.model;
          if(c.effort)r.reasoning=c.effort;
        }
        if(modalKind==='role-config'&&dialog.open){
          const h=dialog.querySelector<HTMLSelectElement>('#dc-role-harness');
          const role=dialog.querySelector<HTMLFormElement>('#dc-role-form')?.dataset.role as ChatRole|undefined;
          const c=role?roleCurrent[role]:null;
          if(h&&c&&c.harness){for(const o of Array.from(h.options))o.selected=o.value===c.harness;}
        }
      }catch{rolePrefetchFor='';}
    })();
  }
  function extensionPanelBody(role:ChatRole){
    const r=state!.roles[role];
    const cached=extensionCache[role];
    if(cached){r.extensions=cached.extensions;r.selectedExtensions=cached.selected;}
    // Sealed means "classic runner" exactly like configureRole: turning the switch off unlocks editing.
    const sealed=state!.engineeringMode==='classic'&&role!=='seeker';
    const frozen=state!.locked||sealed;
    openModal('extensions',`<div class="dc-dialog-eyebrow">${avatar(role)}${CHAT_ROLE_LABELS[role]} 的能力</div><h2 id="dc-dialog-title">Skills 与插件</h2><p class="dc-muted">为角色选择多项能力。选择不会扩大它原有的文件、工具或账户权限。${role!=='seeker'?' Prework 由 Engine 强制交接，不是可关闭的 Skill。':''}</p><form id="dc-extension-form" data-role="${role}">${(['skill','plugin'] as const).map(kind=>`<h3 class="dc-extension-heading">${kind==='skill'?'Skills':'插件'}</h3><div class="dc-extension-list">${r.extensions.filter(x=>x.kind===kind).map(x=>`<label class="dc-extension${!x.available?' is-unavailable':''}"><input type="checkbox" name="extensions" value="${e(x.id)}"${r.selectedExtensions.includes(x.id)||x.required?' checked':''}${frozen||!x.available||x.required?' disabled':''}><span><strong>${e(x.label)}${x.required?'<em>默认启用</em>':''}${!x.available?'<em>待接入</em>':''}</strong><small>${e(x.description)}</small>${!x.available&&x.reason?`<small>${e(x.reason)}</small>`:''}</span></label>`).join('')||'<p class="dc-empty-list">尚无已注册的可用能力。</p>'}</div>`).join('')}<div class="dc-dialog-footer"><button type="button" class="dc-secondary" data-action="modal-close">关闭</button><button type="submit" class="dc-primary"${disabled(!frozen)}>保存选择</button></div></form>`);
  }
  function projectModal(id:string,archive=false){const p=state!.projects.find(x=>x.id===id);if(!p)return;
    openModal(archive?'archive':'rename',`<div class="dc-dialog-eyebrow">${chatIcon(archive?'archive':'edit')}项目管理</div><h2 id="dc-dialog-title">${archive?'归档这个项目？':'给项目换个名字'}</h2>${archive?`<p class="dc-muted">“${e(p.title)}”将从当前列表收起，历史方案、成果与费用记录会保留。你可以从侧栏的“已归档”随时恢复，归档不会永久删除数据。</p><div class="dc-dialog-footer"><button type="button" class="dc-secondary" data-action="modal-close">取消</button><button type="button" class="dc-primary" data-action="archive-confirm" data-id="${e(id)}">归档项目</button></div>`:`<form id="dc-rename-form" data-id="${e(id)}"><label class="dc-field-label" for="dc-project-name">项目名称</label><input id="dc-project-name" value="${e(p.title)}" maxlength="120" required><div class="dc-dialog-footer"><button type="button" class="dc-secondary" data-action="modal-close">取消</button><button type="submit" class="dc-primary">保存名称</button></div></form>`}`);
  }
  function archiveList(){
    const projects=state!.projects.filter(p=>p.product===state!.product&&p.archived);
    openModal('archives',`<div class="dc-dialog-eyebrow">${chatIcon('archive')}项目管理</div><h2 id="dc-dialog-title">已归档项目</h2><p class="dc-muted">归档只收起项目。恢复后可以继续查看历史记录。</p><div class="dc-archive-list">${projects.map(p=>`<div class="dc-archive-row"><span>${e(p.title)}</span><button type="button" class="dc-secondary" data-action="project-restore" data-id="${e(p.id)}"${disabled(!pending())}>恢复</button></div>`).join('')||'<p class="dc-muted">这里还没有已归档的项目。</p>'}</div><div class="dc-dialog-footer"><button type="button" class="dc-secondary" data-action="modal-close">关闭</button></div>`);
  }
  async function sendComposer(){
    if(!state||pending()||!composer.trim())return;
    const text=composer.trim(),q=qActive();
    if(q&&state.capabilities.answers&&!state.locked){await act({type:'answer-submit',questionId:q.id,answer:selectedChoices.length?choiceFreeText:text,...(selectedChoices.length?{choiceIds:[...selectedChoices],...(!q.allowMultiple&&selectedChoices.length===1?{choiceId:selectedChoices[0]}:{})}:{})});}
    else if(state.capabilities.followup){await act({type:'review-followup',text});}
    else if(state.capabilities.send){await act({type:'message-send',text});}else return;
    if(!localError){composer='';selectedChoices=[];choiceFreeText='';draftByProject.delete(state.projectId??'new');const input=root.querySelector<HTMLTextAreaElement>('#dc-composer-input');if(input)input.value='';repaint();}
  }
  async function click(event:Event){
    const button=(event.target as HTMLElement).closest<HTMLElement>('[data-action]');if(!button||button.hasAttribute('disabled')||!state)return;
    const action=button.dataset.action!,id=button.dataset.id??'',role=button.dataset.role as ChatRole;
    if(pending()&&['star-save','archive-confirm','project-restore','requirements-confirm','requirements-save','project-pin','demo-step','end-interview'].includes(action))return;
    if(action!=='add-menu'&&action!=='project-menu')menu='';
    switch(action){
      case 'sidebar':collapsed=!collapsed;repaint();break;
      case 'add-menu':menu=menu==='add'?'':'add';repaint();break;
      case 'project-menu':menu=menu===`project:${id}`?'':`project:${id}`;repaint();break;
      case 'project-new':await act({type:'project-new'});break;
      case 'project-select':await act({type:'project-select',id});break;
      case 'mode-dm':case 'mode-df':await act({type:'product-switch',product:action==='mode-dm'?'dm':'df'});break;
      case 'archives-open':archiveList();break;
      case 'project-restore':await act({type:'project-restore',id});if(!localError)archiveList();break;
      case 'project-rename':projectModal(id);break;
      case 'project-archive':projectModal(id,true);break;
      case 'project-pin':await act({type:'project-pin',id,pinned:!state.projects.find(p=>p.id===id)?.pinned});break;
      case 'archive-confirm':await act({type:'project-archive',id});if(!localError)closeModal();break;
      case 'add-file':fileInput.accept=state.evidence==='live'?'.txt,.md,.json,text/plain,text/markdown,application/json':'';fileInput.click();repaint();break;
      case 'attachment-remove':await act({type:'attachment-remove',id});break;
      case 'extensions':extensionPanel(role);repaint();break;
      case 'role-restore':await act({type:'role-restore-defaults'});if(!localError)closeModal();break;
      case 'role-config':await configureRole(role);break;
      case 'mode-toggle':await act({type:'mode-toggle'});break;
      case 'question-help':{const q=state.questions.find(x=>x.id===id);if(q)questionHelp(q);break;}
      case 'star-open':{const q=state.questions.find(x=>x.id===id);if(q)editStar(q);break;}
      case 'star-save':{const value=dialog.querySelector<HTMLTextAreaElement>('#dc-star-answer')?.value.trim();if(!value)return;await act({type:'answer-edit',questionId:id,answer:value,expectedRevision:Number(button.dataset.revision)});if(!localError)closeModal();break;}
      case 'answer-choice':{
        const q=qActive(),c=q?.choices?.find(x=>x.id===id);
        if(q&&c){
          if(!selectedChoices.length)choiceFreeText=composer;
          selectedChoices=q.allowMultiple?(selectedChoices.includes(id)?selectedChoices.filter(x=>x!==id):[...selectedChoices,id]):[id];
          const labels=selectedChoices.map(choiceId=>q.choices!.find(x=>x.id===choiceId)!.label).join('；');
          composer=[labels,choiceFreeText?(labels?'补充：':'')+choiceFreeText:''].filter(Boolean).join('\n\n');
          if(!selectedChoices.length)choiceFreeText='';
          repaint();const input=root.querySelector<HTMLTextAreaElement>('#dc-composer-input');if(input){input.value=composer;input.focus();}
        }break;
      }
      case 'custom-answer':if(selectedChoices.length)composer=choiceFreeText;selectedChoices=[];choiceFreeText='';repaint();{const input=root.querySelector<HTMLTextAreaElement>('#dc-composer-input');if(input){input.value=composer;input.focus();}}break;
      case 'suggestion':composer=button.dataset.text??'';repaint();root.querySelector<HTMLTextAreaElement>('#dc-composer-input')?.focus();break;
      case 'requirements-save':{const r=state.requirements;if(!r||state.locked||!requirementDirty)return;const text=root.querySelector<HTMLTextAreaElement>('#dc-requirement-draft')?.value??r.text;await act({type:'requirements-edit',text,expectedRevision:r.revision});break;}
      case 'requirements-confirm':{const r=state.requirements;if(!r)return;const text=root.querySelector<HTMLTextAreaElement>('#dc-requirement-draft')?.value??r.text;await act({type:'requirements-confirm',text,expectedRevision:r.revision});break;}
      case 'modal-close':closeModal();break;
      case 'dismiss-error':localError='';repaint();break;
      case 'refresh':await act({type:'refresh'});break;
      case 'end-interview':await act({type:'end-interview'});break;
      case 'demo-step':await act({type:'demo-step'});break;
      case 'cancel':if(cancelPending)return;cancelPending=true;repaint();try{await controller.dispatch({type:'cancel'});}catch(err){error(err);}finally{cancelPending=false;repaint();}break;
      case 'settings-open':case 'engineering-settings-open':case 'help-open':await act({type:action});break;
    }
  }
  async function submit(event:Event){
    if(!(event.target instanceof HTMLFormElement)||!state)return;event.preventDefault();const form=event.target;
    document.documentElement.dataset.submitdbg=form.id+'|busy='+String(localBusy)+'|statebusy='+String(state?.busy);
    if(form.id==='dc-composer-form'){await sendComposer();return;}
    // Only the shell's own re-entry is refused here. A server-side busy flag must not swallow a
    // configuration write: the server answers with a real error, which the page can show.
    if(localBusy)return;
    if(form.id==='dc-rename-form'){const title=(dialog.querySelector<HTMLInputElement>('#dc-project-name')?.value??'').trim();if(!title)return;await act({type:'project-rename',id:form.dataset.id!,title});if(!localError)closeModal();}
    if(form.id==='dc-role-form'){const data=new FormData(form);await act({type:'role-configure',role:form.dataset.role as ChatRole,model:String(data.get('model')??''),reasoning:String(data.get('reasoning')??''),harness:String(data.get('harness')??''),...(data.has('provider')?{provider:String(data.get('provider'))}:{})});if(!localError)closeModal();}
    if(form.id==='dc-extension-form'){const r=form.dataset.role as ChatRole,ids=Array.from(form.querySelectorAll<HTMLInputElement>('input:checked')).map(el=>el.value);await act({type:'role-extensions',role:r,ids});if(!localError)closeModal();}
    if(form.id==='dc-help-form'){
      const input=dialog.querySelector<HTMLTextAreaElement>('#dc-help-input'),thread=dialog.querySelector<HTMLElement>('#dc-help-thread');if(!input||!thread||!input.value.trim()||!state.capabilities.help||pending())return;
      const text=input.value.trim(),questionId=modalQuestion,projectId=state.projectId,key=helpKey(questionId);
      const history=helpHistory.get(key)??[];history.push({user:true,text});helpHistory.set(key,history);
      if(helpHistory.size>100)helpHistory.delete(helpHistory.keys().next().value!);
      input.value='';thread.innerHTML=helpMarkup(key);input.disabled=true;
      const result=await act({type:'question-help',questionId,text});
      history.push({user:false,text:result?.text||localError||'解释暂未返回。你的正式回答尚未更改。'});
      if(modalKind==='question-help'&&modalQuestion===questionId&&state.projectId===projectId){
        // The dialog may have been closed and reopened while the paid explanation was pending.
        const currentThread=dialog.querySelector<HTMLElement>('#dc-help-thread'),currentInput=dialog.querySelector<HTMLTextAreaElement>('#dc-help-input');
        if(currentThread){currentThread.innerHTML=helpMarkup(key);currentThread.scrollTop=currentThread.scrollHeight;}
        if(currentInput){currentInput.disabled=!state.capabilities.help;currentInput.focus();}
      }
    }
  }
  function onInput(event:Event){const target=event.target as HTMLInputElement;
    if(target.id==='dc-requirement-draft'&&state?.requirements){requirementDirty=target.value!==state.requirements.text;const confirm=root.querySelector<HTMLButtonElement>('[data-action="requirements-confirm"]'),save=root.querySelector<HTMLButtonElement>('[data-action="requirements-save"]');if(confirm){confirm.disabled=requirementDirty||pending()||!state.capabilities.confirm||state.locked;confirm.title=requirementDirty?'请先保存修改，生成新版本后再确认':'确认当前显示的需求版本';}if(save)save.disabled=!requirementDirty||pending()||!state.capabilities.confirm||state.locked;}
    if(target.id==='dc-composer-input'){composer=target.value;selectedChoices=[];choiceFreeText='';root.querySelectorAll<HTMLElement>('[data-action="answer-choice"]').forEach(option=>{option.classList.remove('is-selected');option.setAttribute('aria-pressed','false');});draftByProject.set(state?.projectId??'new',composer);const send=root.querySelector<HTMLButtonElement>('.dc-composer button[type="submit"]');if(send)send.disabled=pending()||!composer.trim()||(!state?.capabilities.send&&!state?.capabilities.answers&&!state?.capabilities.followup);target.style.height='auto';target.style.height=Math.min(target.scrollHeight,180)+'px';}
  }
  function keydown(event:KeyboardEvent){
    if(event.key==='Escape'&&menu){menu='';repaint();}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&!dialog.open){event.preventDefault();void act({type:'project-new'});}
    if(event.target instanceof HTMLTextAreaElement&&event.target.id==='dc-composer-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composing){event.preventDefault();void sendComposer();}
  }
  const composeStart=()=>{composing=true;},composeEnd=()=>{composing=false;};
  const onFiles=()=>{const files=Array.from(fileInput.files??[]);fileInput.value='';if(files.length)void act({type:'attachments-add',files});};
  const onDialogCancel=()=>{modalKind='';modalQuestion='';};
  function onDialogChange(event:Event){const target=event.target as HTMLSelectElement;if(target.id!=='dc-role-provider'||modalKind!=='role-config')return;const role=(dialog.querySelector<HTMLFormElement>('#dc-role-form')?.dataset.role??'') as ChatRole;if(role==='seeker')void refreshSeekerModels(target.value,state?.roles.seeker.model??'');}
  const onDocumentClick=(event:MouseEvent)=>{if(menu&&!(event.target as Element).closest('.dc-add-menu,.dc-plus,.dc-project-more,.dc-project-menu')){menu='';repaint();}};
  root.addEventListener('click',click);root.addEventListener('submit',submit);root.addEventListener('input',onInput);
  root.addEventListener('compositionstart',composeStart);root.addEventListener('compositionend',composeEnd);
  dialog.addEventListener('click',click);dialog.addEventListener('submit',submit);dialog.addEventListener('cancel',onDialogCancel);dialog.addEventListener('change',onDialogChange);
  fileInput.addEventListener('change',onFiles);document.addEventListener('keydown',keydown);document.addEventListener('click',onDocumentClick);
  return {render(next){
            if(next.projectId)void prefetchExtensions(next.projectId);
    if(next.projectId)void prefetchRoleCurrent(next.projectId);
    for(const k of Object.keys(roleCurrent) as ChatRole[]){const c=roleCurrent[k],rr=next.roles[k];
    if(c&&rr){if(c.harness)rr.harness=c.harness;if(c.model)rr.model=c.model;if(c.effort)rr.reasoning=c.effort;}}
    const change=next.projectId!==lastProject,questionChanged=next.activeQuestionId!==lastQuestion;
    if(change){draftByProject.set(lastProject??'new',composer);composer=draftByProject.get(next.projectId??'new')??'';menu='';closeModal();}
    if(questionChanged||change){selectedChoices=[];choiceFreeText='';}
    const pane=root.querySelector<HTMLElement>('.dc-conversation'),nearBottom=!pane||pane.scrollHeight-pane.scrollTop-pane.clientHeight<100;
    if(change||next.requirements?.revision!==lastRequirementRevision)requirementDirty=false;lastRequirementRevision=next.requirements?.revision;
    state=next;lastProject=next.projectId;lastQuestion=next.activeQuestionId??'';repaint();
    if(change||questionChanged||nearBottom){requestAnimationFrame(()=>{const el=root.querySelector<HTMLElement>('.dc-conversation');if(el)el.scrollTop=el.scrollHeight;});}
    if(dialog.open&&state.locked&&modalKind==='star'){const q=state.questions.find(x=>x.id===modalQuestion);if(q)editStar(q);}
  },destroy(){destroyed=true;root.removeEventListener('click',click);root.removeEventListener('submit',submit);root.removeEventListener('input',onInput);root.removeEventListener('compositionstart',composeStart);root.removeEventListener('compositionend',composeEnd);document.removeEventListener('keydown',keydown);document.removeEventListener('click',onDocumentClick);fileInput.remove();dialog.removeEventListener('change',onDialogChange);dialog.remove();root.innerHTML='';}};
}
