import type {PlanVersion,Spec} from '../shared/types.js';
import type {ViewState} from './views.js';
import {escapeHtml as e} from './contracts.js';
import {projectPlanContent} from './project-plan-view.js';
export interface PlanHistoryState {items:PlanVersion[];selectedId:string;nextRevision:number|null}
const list=(items:string[])=>`<ul>${items.map(text=>`<li>${e(text)}</li>`).join('')}</ul>`;
const fields:(readonly [string,(s:Spec)=>string])[]=[
 ['方案摘要',s=>s.brief],['功能要求',s=>s.requirements.map(r=>r.text).join('\n')],
 ['使用条件',s=>s.constraints.join('\n')],['暂定假设',s=>s.assumptions.join('\n')],
 ['本期不做',s=>s.outOfScope.join('\n')],['验收办法',s=>s.acceptance.join('\n')],
 ['补充说明',s=>s.notes],['完整项目方案',s=>s.projectPlan?JSON.stringify(s.projectPlan,null,2):''],
 ['完整原文',s=>s.masterPrompt]
];
export function planChanges(before:Spec,after:Spec){return fields.flatMap(([label,read])=>{const a=read(before)??'',b=read(after)??'';return a===b?[]:[{label,before:a,after:b}];});}
export function historyPage(v:ViewState):string{
 const history=v.planHistory,items=[...(history?.items??[])].sort((a,b)=>a.revision-b.revision);
 const selected=items.find(row=>row.id===history?.selectedId)??items.at(-1),previous=selected?items.filter(row=>row.revision<selected.revision).at(-1):undefined;
 const changes=selected&&previous?planChanges(previous.snapshot,selected.snapshot):[];
 return `<section class="card"><div class="section-heading"><div><span class="eyebrow">每一版都保留</span><h2>方案历史</h2></div><button type="button" class="secondary" data-action="reload-panel">刷新版本</button></div><p>查看和比较旧版本不会修改方案，也不会开始制作。每次更新后的新版本，都需要单独确认。</p>
 ${!selected?'<div class="empty"><h3>还没有方案版本</h3><p>结束澄清并整理方案后，第一版会保存在这里。历史读取失败时也不会替你重建版本。</p></div>':`
 <div class="version-layout"><nav aria-label="方案版本" class="version-list">${items.map(row=>`<button type="button" class="version-button ${row.id===selected.id?'active':''}" data-action="select-version" data-version="${e(row.id)}" aria-pressed="${row.id===selected.id}"><strong>v${row.revision}</strong><span>${row.approval?'已确认':'待确认'}</span>${row.specHash===v.snapshot?.spec?.hash?'<small>当前方案</small>':''}</button>`).join('')}</nav>
 <article class="version-content" data-key="version-${e(selected.id)}"><div class="section-heading"><h3>v${selected.revision} 完整方案</h3><span class="pill ${selected.approval?'success':'warning'}">${selected.approval?'已有确认记录':'待确认'}</span></div><p class="notice">${selected.specHash===v.snapshot?.spec?.hash?'这是当前方案的存档副本。请到“项目方案”核对并作出决定。':'这是历史版本，只读保留；后续制作以最新已确认方案为准。'}</p>
 <p class="preserve">${e(selected.snapshot.brief)}</p>${selected.snapshot.projectPlan?projectPlanContent(selected.snapshot.projectPlan):''}
 <details class="spec-section" open><summary>完整功能与约定</summary><h4>需要完成的功能</h4>${list(selected.snapshot.requirements.map(row=>row.text))}<h4>使用条件</h4>${list(selected.snapshot.constraints)}<h4>暂定假设</h4>${list(selected.snapshot.assumptions)}<h4>本期不做</h4>${list(selected.snapshot.outOfScope)}<h4>怎样验收</h4>${list(selected.snapshot.acceptance)}<p class="preserve">${e(selected.snapshot.notes)}</p></details>
 <details class="spec-section"><summary>查看完整原文与来源信息</summary><pre class="preserve">${e(selected.snapshot.masterPrompt)}</pre><dl><dt>版本来源</dt><dd>${selected.origin==='LEGACY_IMPORTED'?'从原有方案完整保留':selected.origin==='COMPLETE_PLAN'?'完整项目方案':'已保存的需求方案'}</dd><dt>确认时间</dt><dd>${e(selected.approval?.at??'尚未确认')}</dd><dt>内容标识</dt><dd class="hash-text">${e(selected.contentHash)}</dd></dl></details>
 <div class="actions"><button type="button" data-action="download-version" data-version="${e(selected.id)}">导出这一版完整记录</button><button type="button" data-action="tab" data-tab="spec">查看当前项目方案</button></div></article></div>
 <section class="version-diff"><h3>版本差异</h3>${!previous?'<p class="hint">这是已读取的第一版；没有更早版本可供比较。</p>':`<p>比较 v${previous.revision} → v${selected.revision}。下面只展示文字变化，不会替你批准更新。</p>${changes.length?changes.map(change=>`<details class="difference"><summary>${e(change.label)}发生变化</summary><div class="comparison"><section><h4>之前</h4><p class="preserve">${e(change.before||'未填写')}</p></section><section><h4>现在</h4><p class="preserve">${e(change.after||'未填写')}</p></section></div></details>`).join(''):'<p>这些主要内容没有文字变化；完整来源和版本记录仍各自保留。</p>'}`}</section>`}
 ${history?.nextRevision!==null&&history?.nextRevision!==undefined?'<button type="button" data-action="more-versions" class="secondary">读取更多版本</button>':''}</section>`;
}
