import { escapeHtml as e } from './contracts.js';
export interface HelpTopic {title:string;what:string;impact:string;steps:string[];alternative:string}
const networkScopeHelp:HelpTopic={
    title:'网页能打开，后台助手仍连不上',
    what:'浏览器授权、本地回调、令牌交换和模型请求由不同程序参与。Windows 的网络工具可用，不代表 Linux 中的后台助手使用了同一条网络路径。',
    impact:'节点能读取、另一个模型能连接或已有登录记录，都不能证明这个角色已能工作。网络覆盖、账户资格和模型可用性需要分开核对。',
    steps:['先保留方案，到使用准备查看具体缺少哪项条件。','核对实际运行程序的脱敏连接记录；不要把其他模型服务的结果当作这个角色的证明。','若官方明确提示地区或账户政策拒绝，保持暂停并向官方核对，不用反复登录或切换地区。'],
    alternative:'可以继续查看项目、编辑未开始的方案或暂时保存进度；缺少某个角色的资格不会让其他已就绪的工作失效。'
};
export interface FlowReportData {
    reportHash:string;evidenceClass:string;technicalRequirementsMet:boolean;userAccepted:boolean;verifiedCount:number;remainingCount:number;
    callAccounting?:{originalCalls:number;originalMaxCalls:number;supplementalReviewCalls:number;totalCalls:number};
    targetRolesMet?:boolean;
    executorRoles?:{executorRoleId?:unknown;taskId?:unknown;runner?:unknown;provider?:unknown;authentication?:unknown;model?:unknown}[];
    summary:{title:string;planLabel:string;completedLabel:string;remainingLabel:string;blockers:{title:string;explanation:string;impact:string}[];nextLabel:string};
}
function short(value:unknown,fallback='未记录'):string {
    return typeof value==='string'&&value.trim()?value.trim().slice(0,120):fallback;
}
export function helpPage(topics:Record<string,HelpTopic>,simple=false):string {
    return `<section class="card"><span class="eyebrow">帮助</span><h1>遇到问题，先保住进度。</h1><p>${simple?'先保存，再看提示，最后决定下一步。下面把“发生什么”“对你有什么影响”“怎么做”分开说；不会省略原有的限制。':'帮助页不会替你登录、购买、安装组件或开始制作。不能处理和不愿处理，都可以成为下一版方案的约束。'}</p><div class="actions"><button type="button" data-action="help-rephrase" aria-pressed="${simple}">${simple?'显示完整说明':'我看不懂，请换一种说法'}</button><button type="button" data-action="settings">打开连接与设置</button><button type="button" data-action="home">回到项目空间</button></div></section>`+
    Object.entries({...topics,CODEX_NETWORK_SCOPE:networkScopeHelp}).filter(([key])=>/^[A-Z_]{1,40}$/.test(key)).map(([key,t])=>`<section class="card" id="help-${key}"><h2>${e(t.title)}</h2>${simple?'<h3>发生了什么</h3>':''}<p>${e(t.what)}</p>${simple?'<h3>对你有什么影响</h3>':''}<p class="hint">${e(t.impact)}</p>${simple?'<h3>跟着做</h3>':''}<ol>${t.steps.map(step=>`<li>${e(step)}</li>`).join('')}</ol>${simple?'<h3>暂时做不到也可以</h3>':''}<p>${e(t.alternative)}</p></section>`).join('');
}
export function flowReportContent(report:FlowReportData,draft:{key:string;value:string}={key:'',value:''},userPlanner=false):string {
    const s=report.summary;
    const c=report.callAccounting,valid=!!c&&[c.originalCalls,c.originalMaxCalls,c.supplementalReviewCalls,c.totalCalls].every(v=>Number.isSafeInteger(v)&&v>=0)&&c.originalCalls<=c.originalMaxCalls&&c.totalCalls===c.originalCalls+c.supplementalReviewCalls;
    const calls=valid?`原工程调用 ${c!.originalCalls} / ${c!.originalMaxCalls}；补充复审已用 ${c!.supplementalReviewCalls} 次；总调用 ${c!.totalCalls} 次。`:'调用用量暂未核清，请刷新本轮报告；不会按不完整的记录猜测。';
    const executorRoles=Array.isArray(report.executorRoles)?report.executorRoles:[],shownExecutors=executorRoles.slice(0,32);
    const executorSummary=shownExecutors.length?`<section><h3>本轮执行器记录</h3><p>${report.targetRolesMet===true?'每个执行器都有独立完成证据，且没有复用监督角色的会话。':'下面只是已记录的执行器身份，尚不能据此把本轮角色联动标为通过。'}</p><ul>${shownExecutors.map((role,index)=>`<li><strong>执行器 ${index+1}</strong>：${e(short(role.model))} · ${e(short(role.provider))}<br><small>${e(short(role.runner))} · ${e(short(role.authentication))}</small></li>`).join('')}</ul>${executorRoles.length>shownExecutors.length?`<p class="hint">另有 ${executorRoles.length-shownExecutors.length} 个执行器记录已保留，未省略原始数据。</p>`:''}</section>`:'';
    return `<h2 id="dialog-title">${e(s.title)}</h2><p>${e(s.planLabel)}</p><p>${e(s.completedLabel)}；${e(s.remainingLabel)}。</p>
    <p>${calls}</p>
    <p class="notice">${report.evidenceClass==='OFFLINE_DEMO_NOT_LIVE_AGENT'?'这是固定 Demo 的本地结果，不是四角色 Live。':'真实结论须结合当前源码、运行器身份和原始验证证据。'}</p>
    ${executorSummary}
    <p>${report.userAccepted?'你已经单独接受过本轮成果。':'你尚未接受本轮成果；下面的选择不会替你接受，也不会开始下一轮制作。'}</p>
    ${s.blockers.map(b=>`<section><h3>${e(b.title)}</h3><p>${e(b.explanation)}</p><p>${e(b.impact)}</p></section>`).join('')}
    <p>${userPlanner?'结束本轮后，旧方案、来源和成果会保留。换一种办法后，由你修订下一版完整方案；新版本仍需确认。无需需求访谈账户或提问。':'结束本轮后，旧方案、来源和成果会保留。换一种办法后可先提出当前限制，再按需进入五题澄清；每版新方案都要重新确认。'}</p>
    <label for="alternative-constraint">换路时，有什么不能做或不愿处理？（可不填）</label><textarea id="alternative-constraint" data-draft="${e(draft.key)}" maxlength="2000" rows="3" placeholder="例如：我不愿安装额外组件。不要填写密码或密钥。">${e(draft.value)}</textarea>
    <div class="actions wrap">${[['HANDLE','我来处理'],['HELP','我需要帮助'],['ALTERNATIVE','换一种办法'],['SAVE','暂时不做']].map(([id,label])=>`<button type="button" data-action="conclude-flow" data-choice="${id}">${label}</button>`).join('')}</div><button type="button" data-action="close-modal" class="text-button">继续查看，不结束本轮</button>`;
}
