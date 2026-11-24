import type {LifecycleStatus} from '../shared/lifecycle.js';
import {escapeHtml as e,UiError} from './contracts.js';
export function readLifecycleStatus(value:unknown):LifecycleStatus{
 const v=value as LifecycleStatus|undefined,keys=['engineJobs','interviews','modelCalls','queued','grants','quarantined'] as const;
 if(!v||v.schema!=='dream-maker.lifecycle.v1'||!['RUNNING','PAUSE_REQUESTED','PAUSED','PAUSE_UNCERTAIN'].includes(v.state)||v.scope!=='CONTROLLER_OWNED_WORK_ONLY'||v.automaticResume!==false||v.browserCloseStopsWork!==false||typeof v.currentRoundMayStillRun!=='boolean'||!Number.isFinite(Date.parse(v.changedAt))||![null,'PAUSE','BACKGROUND_CURRENT_WORK'].includes(v.lastChoice)||v.code!==null&&(typeof v.code!=='string'||v.code.length>1000)||!v.active||keys.some(key=>!Number.isSafeInteger(v.active[key])||v.active[key]<0))throw new UiError('LIFECYCLE_STATUS_INVALID','尚未核对本机停止状态；请刷新核对，不要认为任务或费用已停止。');
 if(v.state==='PAUSED'&&(v.currentRoundMayStillRun||keys.some(key=>v.active[key]!==0)))throw new UiError('LIFECYCLE_STATUS_INVALID','暂停回执与活动工作数量不一致，尚未确认安全停止。');
 return v;
}
function lifecycleMessage(state?:LifecycleStatus):string{
 if(!state)return '<p class="notice warning" role="status">尚未核对本机状态。没有把这次操作当作已停止；请核对状态，不要重复提交。</p>';
 if(state.state==='PAUSE_REQUESTED')return '<p class="notice warning" role="status">正在等待本机工作暂停。新的工程回合已阻止，需求访谈与检索正在取消；当前已经开始的工程回合仍可能继续计费，受原预算和时限约束。看到已暂停前，不要认为费用已停止。</p>';
 if(state.state==='PAUSE_UNCERTAIN')return `<p class="notice warning" role="status">停止结果尚未核清，未宣告安全暂停。新的工作已阻止；原方案、费用记录与未核清的占用保留。仍可能有在途请求或进程，不要认为费用已停止，也不要重试制作。</p><details><summary>问题编号</summary><code>${e(state.code??'APPLICATION_PAUSE_UNCERTAIN')}</code></details>`;
 if(state.state==='PAUSED')return '<p class="notice" role="status">本机工作已暂停。服务仍在本机运行，可以查看已有方案和状态。不会自动继续制作；需要重新启动本机服务、核对原任务，再明确选择继续。此页不代表整个项目已经完成或最终接受。</p>';
 return `<p>${state.lastChoice==='BACKGROUND_CURRENT_WORK'?'这次已选择让当前工作在后台继续。它仍可能按原有预算产生费用；没有批准新的方案或开启下一轮。':'尚未暂停本机工作。已经获准的当前任务可能仍在执行或产生费用。'}</p>`;
}
export function lifecyclePanel(state?:LifecycleStatus):string{
 return `<section class="card"><h2>离开与停止</h2><p>直接关闭浏览器不会停止本机任务。离开前，请明确选择当前工作继续，或安全暂停。</p>${lifecycleMessage(state)}<div class="actions"><button type="button" data-action="application-exit">选择离开方式</button><button type="button" data-action="lifecycle-read">核对停止状态</button></div></section>`;
}
export function lifecycleConfirmation(state?:LifecycleStatus):string{
 const running=state?.state==='RUNNING';
 return `<h2 id="dialog-title">离开前，先决定任务怎么处理</h2><p id="dialog-description">关闭浏览器不会停止本机任务。本页控制当前本机服务；实际窗口关闭与完整退出宿主仍在接入中。</p>${lifecycleMessage(state)}${running?`<form id="lifecycle-choice-form"><fieldset><legend>选择一种方式</legend><label class="check"><input name="exitChoice" type="radio" value="PAUSE" required><span><strong>安全暂停本机工作</strong><br><small>停止新回合，取消需求访谈与检索，等待已开始的工程回合结束；该回合仍可能按原预算计费。保留方案和进度，不自动重发结果不明的任务。</small></span></label><label class="check"><input name="exitChoice" type="radio" value="BACKGROUND_CURRENT_WORK" required><span><strong>让当前工作在后台继续</strong><br><small>当前已批准的任务继续受原预算和时限约束，可能产生费用。不会批准新方案或自动开启下一轮。</small></span></label></fieldset><label class="check"><input name="exitConsent" type="checkbox" required>我已核对影响，确认采用上面选择的方式。</label><div class="actions"><button type="button" data-action="close-modal">暂不离开</button><button type="submit" class="primary">确认选择</button></div></form>`:`<div class="actions"><button type="button" data-action="lifecycle-read" class="primary">核对停止状态</button><button type="button" data-action="close-modal">返回项目</button></div>`}`;
}
