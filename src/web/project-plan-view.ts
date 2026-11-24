import type { ProjectPlan } from '../shared/project-plan.js';
import { escapeHtml as e } from './contracts.js';
const list=(items:string[])=>items.length?`<ul>${items.map(s=>`<li>${e(s)}</li>`).join('')}</ul>`:'<p class="hint">本版方案未列出此项；实际条件仍需核对。</p>';
export function projectPlanContent(p:ProjectPlan):string {
    const research=p.research.status==='UNAVAILABLE'?'暂未完成公开检索，方案会保留这个限制。':p.research.status==='PARTIAL'?'已完成部分公开资料查找，仍有未核实内容。':p.research.status==='USER_IMPORTED_PLAN'?'这是你导入的方案，引用资料仍需核对。':'已完成本次限定范围的公开查找；这不代表穷尽所有项目。';
    const sources=p.research.sourceRefs.map(source=>{
        try{const u=new URL(source.webUrl);if(u.protocol==='https:'&&['github.com','gitlab.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port)return `<li><a href="${e(u.href)}" target="_blank" rel="noopener noreferrer">${e(u.hostname+u.pathname)}</a><span class="hint"> · 已固定来源；实际适配尚需验证</span></li>`;}catch{}
        return '<li>来源地址未通过显示检查。</li>';
    });
    return `<section class="complete-plan"><h3>${p.research.status==='USER_IMPORTED_PLAN'?'方案中的做法':'推荐的做法'}</h3><p class="preserve">${e(p.goal)}</p><p class="preserve">${e(p.architecture.summary)}</p>
    <h3>做完后怎样使用</h3><p class="preserve">${e(p.delivery.howToUse)}</p><p>${p.delivery.standalone?'方案目标是可以独立使用；需交付时实际验证。':'方案仍需要列出的配套工具；具体依赖还须核验。'}${p.delivery.needsInternet?'使用时需要方案列出的网络连接。':'方案目标是不依赖联网完成主要操作；需实际验证。'}</p>
    <p class="hint">持续费用与必需条件以真实账户和运行结果为准，确认方案不会购买服务。</p>${list([...p.delivery.ongoingFees,...p.resources.ongoingCosts,...p.resources.accounts,...p.resources.hardware,...p.resources.network])}
    <h3>分几步完成</h3><ol>${p.milestones.map(s=>`<li>${e(s)}</li>`).join('')}</ol>
    <h3>如何检查成果</h3>${list(p.acceptance.map(a=>a.check))}
    <h3>查找与复用</h3><p>${research}</p><p>${p.reuse.mode==='IMPLEMENT_ORIGINAL'?'本次方案按原创路线设计。':p.reuse.mode==='ADAPT_PROJECT'?'方案建议在已核对的现成项目上改造。':'方案建议复用已核对的局部组件。'}</p>${p.reuse.reason?`<p>${e(p.reuse.reason)}</p>`:''}${sources.length?`<details><summary>查看固定来源</summary><ul>${sources.join('')}</ul></details>`:''}
    <h3>建议与待确认条件</h3><p class="hint">${p.research.status==='USER_IMPORTED_PLAN'?'以下保留自你提供的方案；假设、未知和风险仍需核实，导入不表示已经通过。':'以下是助手提出的假设、未知和风险，不是替你填写的回答。'}</p>${list([...p.assumptions,...p.unknowns,...p.risks])}
    <details><summary>查看实现与数据细节</summary><h4>组成与数据</h4>${list([...p.architecture.components,...p.dataModel.entities,p.dataModel.persistence])}<h4>主要操作与边界</h4>${list([...p.interfaces.userFlows,...p.interfaces.boundaries])}<h4>工程任务与检查</h4>${list(p.tasks.map(t=>t.title+'：'+t.check))}</details></section>`;
}
export function planningStageMessage(stage:string):string {
    return ({CLAIMED:'正在准备完整方案…',RESEARCH_INTENT:'正在归纳适合公开查找的方向…',SEARCHING:'正在查找适合的现成基础…',REVIEWING_SOURCES:'正在核对资料与使用条件…',DRAFTING_PLAN:'正在整理完整方案…',SAVING_UNAPPROVED_PLAN:'正在保存待你确认的方案…',STOPPED_RECONCILE_BEFORE_RETRY:'本次规划已停止，需要核对调用结果后继续。'} as Record<string,string>)[stage]??'';
}
