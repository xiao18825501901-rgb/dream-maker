import { escapeHtml as e } from './contracts.js';
import type { ViewState } from './views.js';

/** A deterministic form transcriber, not a model or an approval/technical design service. */
export function userPlanFromFields(value:(key:string)=>string,checked:(key:string)=>boolean){
 const lines=(key:string)=>value(key).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 const requirements=lines('requirements').map((text,i)=>({id:'R'+String(i+1).padStart(3,'0'),text,origin:'USER',sources:['USER_FORM']}));
 const requirementIds=requirements.map(r=>r.id);
 const acceptance=lines('acceptance').map((check,i)=>({id:'A'+(i+1),check,requirementIds}));
 return {schema:'dream-maker.user-plan.v1',name:value('projectName').trim(),mode:value('mode'),plan:{
  goal:value('goal').trim(),requirements,acceptance,
  architecture:{summary:value('approach').trim(),runtime:value('runtime').trim(),components:lines('approach')},
  dataModel:{entities:['按用户填写的具体要求定义'],persistence:value('data').trim()},
  interfaces:{userFlows:lines('requirements'),boundaries:['只在分配的受控环境执行；不公开项目或修改其他项目']},
  tasks:lines('steps').map((title,i)=>({id:'T'+(i+1),title,dependsOn:i?['T'+i]:[],requirementIds,check:'按用户填写的验收方法核对，不以代码写完作为通过。'})),
  delivery:{type:'USER_SPECIFIED',howToUse:value('use').trim(),standalone:checked('standalone'),needsInternet:checked('internet'),ongoingFees:lines('fees')},
  resources:{accounts:lines('accounts'),hardware:[],network:checked('internet')?['用户标明成果需要网络；具体连接仍需授权与检查']:[],ongoingCosts:lines('fees')},
  risks:['运行条件、许可和实际功能尚需工程角色核验；填写和导入不表示已经通过。'],
  milestones:lines('steps'),assumptions:['步骤依用户填写顺序串联；工程规划仍须在冻结要求内核对依赖。'],
  unknowns:['未填写的账户、硬件、持续费用不代表已经证明无需这些条件。'],outOfScope:['未经单独授权的公开部署、额外费用、账户或系统变更'],
  research:{status:'USER_IMPORTED_PLAN',sourceRefs:[]},reuse:{mode:'IMPLEMENT_ORIGINAL',selected:[],reason:'用户自带方案；没有以公开仓库或导入声明替代来源准入。',externalCodeExecuted:false}
 }};
}
export function userPlanHome(v:ViewState):string {
 const field=(key:string,title:string,rows=2,max=6000)=>`<div class="form-field"><label for="user-${e(key)}">${title}</label><textarea id="user-${e(key)}" name="${e(key)}" data-draft="user-plan:${e(key)}" rows="${rows}" maxlength="${max}" required>${e(v.draft('user-plan:'+key))}</textarea></div>`;
 const importEntry=`<section class="flow-import-block"><h3>已有完整方案</h3><p>从 Dream Maker 或 DreamFlow 导出的 JSON 导入。批准与运行证据不会随文件带入。</p><details><summary>打开导入入口</summary><form id="user-plan-import"><label for="plan-file">选择本地方案文件（可选）</label><input type="file" id="plan-file" name="planFile" accept=".json,application/json"><label for="plan-json">或粘贴完整方案内容</label><textarea id="plan-json" name="document" data-draft="user-plan:document" rows="8" maxlength="110000" required spellcheck="false">${e(v.draft('user-plan:document'))}</textarea><p class="hint">不要填入凭据。导入只保存待确认版本，不启动制作。</p><button type="submit" class="secondary">检查并导入</button></form></details></section>`;
 const projectIndex=`<section class="projects-section flow-project-index"><div class="section-heading"><div><h2>继续已有项目</h2><p class="hint">与 Dream Maker 使用相同项目格式；同一数据目录只允许一个产品控制端写入。</p></div><span class="pill">${v.projects.length} 个项目</span></div><div class="project-grid">${v.projects.map(p=>`<a class="project-card" href="/?project=${encodeURIComponent(p.id)}" data-action="open" data-id="${e(p.id)}"><div class="row between"><span class="folder-icon" aria-hidden="true">D</span><small>${p.mode==='demo'?'DEMO':'LIVE'}</small></div><h3>${e(p.name)}</h3><p>${e(p.idea)}</p></a>`).join('')||'<div class="empty"><h3>保存第一份方案后，可以从这里继续。</h3><p>已有项目会保留原方案、批准和历史状态。</p></div>'}</div></section>`;
 return `<section class="flow-intro"><div class="page-heading"><div class="eyebrow">独立工作台</div><h1>带着方案，开始制作。</h1><p>你负责方案，工程角色负责规划、制作和审查。无需需求访谈或 Kimi 账户。</p></div><div class="flow-intro-status"><span class="micro">当前入口</span><strong>${v.mode==='local'?'本机服务':'前端演示'}</strong><small>保存方案不会自动批准或派发。</small></div></section>
 ${v.projects.length?projectIndex:''}${importEntry}<div class="flow-intake-grid"><section class="flow-editor"><div class="section-heading"><div><h2>整理自己的方案</h2><p class="hint">先写清楚目标、要求和完成标准，再进入核对。</p></div><span class="pill">方案草稿</span></div>
 <form id="user-plan-form">
  <fieldset class="form-section form-section-primary"><legend>项目与目标</legend><label for="project-name">项目名称</label><input id="project-name" name="projectName" data-draft="user-plan:projectName" value="${e(v.draft('user-plan:projectName'))}" maxlength="120" required>${field('goal','希望做成什么？',2)}</fieldset>
  <fieldset class="form-section"><legend>要求与完成标准</legend>${field('requirements','具体要求（每行一项）',3)}${field('acceptance','怎样操作、看到什么才算完成？（每行一项）',3)}</fieldset>
  <fieldset class="form-section"><legend>做法与运行条件</legend>${field('approach','准备怎么做？有哪些主要部分？',3)}<div class="form-grid">${field('runtime','成果在哪种设备或软件环境运行？',2,1000)}${field('data','数据怎样保存？',2,4000)}</div>${field('steps','制作步骤（每行一步，按顺序）',3)}${field('use','交付后怎样打开和使用？',2)}</fieldset>
  <fieldset class="form-section"><legend>账户与费用</legend><div class="form-grid"><div><label for="user-accounts">成果需要的账户（不填密码或密钥）</label><textarea id="user-accounts" name="accounts" data-draft="user-plan:accounts" maxlength="4000">${e(v.draft('user-plan:accounts'))}</textarea></div><div><label for="user-fees">持续费用或尚未知的费用</label><textarea id="user-fees" name="fees" data-draft="user-plan:fees" maxlength="4000">${e(v.draft('user-plan:fees'))}</textarea></div></div><label class="check"><input type="checkbox" name="standalone" data-draft="user-plan:standalone" ${v.draft('user-plan:standalone')==='true'?'checked':''}>我计划让成果脱离 DreamFlow 使用</label><label class="check"><input type="checkbox" name="internet" data-draft="user-plan:internet" ${v.draft('user-plan:internet')==='true'?'checked':''}>成果需要联网</label></fieldset>
  <fieldset class="form-section form-submit-section"><legend>保存与核对</legend><label for="user-plan-mode">运行方式</label><select id="user-plan-mode" name="mode" data-draft="user-plan:mode">${v.mode==='local'?`<option value="live" ${v.draft('user-plan:mode')!=='demo'?'selected':''}>真实制作 · 保留账户、费用和安全检查</option>`:''}<option value="demo" ${v.mode!=='local'||v.draft('user-plan:mode')==='demo'?'selected':''}>${v.presentation==='frontend-review'?'前端演示 · 不连接账户、模型或真实制作':'固定 Demo · 只检验控制流程，不实现我的方案'}</option></select><p class="hint">工程角色需要的账户与额度另行检查；这里不会要求 Kimi 或代你授权付费。</p><div class="actions"><button class="primary" type="submit">保存方案，进入核对</button></div></fieldset>
 </form></section>
 <aside class="flow-entry-panel"><h2>工作方式：方案在前，执行在后。</h2><ol class="flow-principles"><li><strong>你定义内容</strong><span>目标、要求、验收和运行条件由你提供。</span></li><li><strong>再确认版本</strong><span>保存只生成草稿；批准后才会形成可派发版本。</span></li><li><strong>独立工程核验</strong><span>规划、制作和审查分别保留身份与证据。</span></li></ol></aside></div>
 ${v.projects.length?'':projectIndex}`;
}
export function userPlanEditor(document:unknown,draft:string,note='',draftKey='user-plan:revision'):string {
 return `<h2 id="dialog-title">修订下一版方案</h2><p>旧方案、批准和成果会保留。保存的新版本需要重新确认；当前轮必须已经安全结束。</p>${note?`<p class="notice preserve">你刚才提出的限制：${e(note)}。请把它落实到下面的要求与验收中。</p>`:''}
 <form id="user-plan-revision"><label for="revision-document">完整方案内容</label><textarea id="revision-document" name="document" data-draft="${e(draftKey)}" rows="14" maxlength="110000" required spellcheck="false">${e(draft||JSON.stringify(document,null,2))}</textarea><div class="actions"><button type="button" data-action="close-modal">保留草稿，暂不修改</button><button type="submit" class="primary">保存待确认的新版本</button></div></form>`;
}
