/** Deterministic novice-facing projections, without translating unknown into success. */
import { requireCondition as need, text, isRecord } from '../research/common.mjs';

export const HELP = Object.freeze({
  MERGE_RECOVERY:{title:'上次文件合并没有完成',what:'多份制作副本在汇入项目时中断，需要先核对实际文件；不能直接继续或接受成果。',impact:'当前文件、合并前基线和组合副本会保留。恢复仅处理源码，方案历史、业务数据、账户、批准和费用不随之回滚。',steps:['打开对应项目的制作工作区，选择“检查文件并处理未完成合并”。','阅读实际文件检查结果，明确选择保留当前文件或还原合并前源码，再勾选确认。','等待本地服务核对旧进程、保存副本并处理文件；成功后旧轮次结束。','如提示文件、数据库或进程无法核清，保留原目录并重新检查，不重复点击开始。'],alternative:'暂时不处理可以先返回，已有文件和副本保留；不会自动调用模型或开始下一轮。'},
  LAYA_PLUGIN:{title:'Laya 是可选的本地助手',what:'没有安装或暂时不可用时，也可以明确选择普通工作流。',impact:'辅助失败会保留本轮进度并停止增强派发，不会把失败写成已获得建议。真实增强角色验收仍须单独完成。',steps:['在连接与设置中查看本地 Laya 的实际状态。','需要安装时先核对官方来源与所需空间，由你确认；当前不自动下载。','辅助不可用而想继续时，先安全结束本轮，再在同一方案的制作选项中选择普通流程并单独批准。'],alternative:'不想安装就选择普通流程；不因此改写原有方案或自动接受成果。'},
  ACCOUNT_ACTION:{title:'需要你连接账户',what:'这一步只能由账户持有人完成。',impact:'受影响的助手暂时不能继续，已保存的方案和成果不会因此删除。',steps:['先在连接与设置查看受影响的角色及具体状态。','需要登录时，使用本机专用账户工具的官方入口；不要把密码或验证码发到聊天。','完成后刷新状态，分别核对登录、额度和实际调用；缓存登录本身不证明可用。'],alternative:'不方便登录时，可以选择“换一种办法”或先保存项目。'},
  RESEARCH_UNAVAILABLE:{title:'暂时没能查到开源资料',what:'本次检索没有完成，不能据此判断有没有合适的现成项目。',impact:'可以先生成自己的实现方案，并标明尚未核实的部分。',steps:['检查网络连接是否可用。','稍后重新检索，或使用已保存且仍适用的资料。'],alternative:'继续原创规划，不会偷偷下载或执行未核验的代码。'},
  SOURCE_REVIEW:{title:'现成项目还需要核对',what:'找到候选不等于已经可以安全、合法地用于你的项目。',impact:'确认之前不会把它加入正式制作。',steps:['助手会核对来源、使用条件和实际功能。','如果不适合，会比较其他候选或采用自己的实现。'],alternative:'你不需要自己完成技术选型；助手会把推荐理由写进方案。'},
  HARDWARE:{title:'这台电脑暂时不满足要求',what:'当前路线需要的资源超过了已确认的可用条件。',impact:'已完成的内容会保留，不会强迫你购买硬件。',steps:['查看具体缺少什么。','选择换一种办法，让助手提出更适合当前设备的路线。'],alternative:'可以调整实现方式或分阶段完成，变化需要你确认。'},
  RECOVERY:{title:'正在核对上一次制作的结果',what:'连接中断后，需要先确认上一次操作有没有完成。',impact:'核对期间不会重复发送可能已经执行的任务。',steps:['保留当前项目，不重复点击开始。','完成核对后继续，或按说明安全结束这一轮。'],alternative:'结果暂时无法确定时，保存已有成果和恢复位置。'},
  GENERAL:{title:'这一步还需要处理',what:'助手已经保存了当前进度，但还没有足够证据宣布完成。',impact:'具体影响会列在本轮报告中。',steps:['查看“已经完成”和“还差什么”。','选择自己处理、寻求帮助、换一种办法或暂时不做。'],alternative:'无法解决或不愿处理，都可以成为下一版方案的约束。'}
});
const KEY={LAYA_ROLE_SUPPORT_UNAVAILABLE:'LAYA_PLUGIN',LAYA_ROLES_INCOMPLETE:'LAYA_PLUGIN',LAYA_DISABLED:'LAYA_PLUGIN',USER_AUTH_REQUIRED:'ACCOUNT_ACTION',HUMAN_OPERATION_REQUIRED:'ACCOUNT_ACTION',ACCOUNT_OR_QUOTA_BLOCKED:'ACCOUNT_ACTION',HARDWARE_INSUFFICIENT:'HARDWARE',SOURCE_RATE_LIMITED:'RESEARCH_UNAVAILABLE',SOURCE_NETWORK_UNAVAILABLE:'RESEARCH_UNAVAILABLE',RESEARCH_REQUEST_LIMIT:'RESEARCH_UNAVAILABLE',LICENSE_NOT_CLEARED:'SOURCE_REVIEW',SOURCE_IDENTITY_UNVERIFIED:'SOURCE_REVIEW',RECOVERY_REQUIRED:'RECOVERY',EXECUTOR_MERGE_RESULT_UNCERTAIN:'MERGE_RECOVERY',MERGE_RECOVERY_RESULT_UNCERTAIN:'MERGE_RECOVERY'};
export function blockerCard(blocker) {
  need(isRecord(blocker),'INVALID_BLOCKER');const helpId=KEY[blocker.code]??'GENERAL';
  // No raw exception message, path, token, hash or stack is reflected from the input.
  return {helpId,title:HELP[helpId].title,explanation:HELP[helpId].what,impact:HELP[helpId].impact,actions:[{id:'HANDLE',label:'我来处理'},{id:'HELP',label:'我需要帮助'},{id:'ALTERNATIVE',label:'换一种办法'},{id:'SAVE',label:'暂时不做'}]};
}
export function plainFlowReport({status,completedCount,remainingCount,blockers=[],planVersion}) {
  for(const x of [completedCount,remainingCount,planVersion])need(Number.isSafeInteger(x)&&x>=0,'INVALID_REPORT_COUNT');
  const labels={COMPLETED:'本轮已达到约定的技术要求',PARTIAL:'本轮已结束，还有内容要继续',BLOCKED:'本轮已结束，需要处理一些条件',FAILED:'本轮没有完成，已有进度已保留',CANCELLED:'本轮已按要求结束'};
  need(labels[status],'REPORT_NOT_TERMINAL');need(Array.isArray(blockers),'INVALID_BLOCKERS');
  return {title:labels[status],planLabel:`本轮依据的方案 v${planVersion}`,completedLabel:`已经完成 ${completedCount} 项工作`,remainingLabel:`还差 ${remainingCount} 项工作`,blockers:blockers.map(blockerCard),accepted:false,nextLabel:status==='COMPLETED'?'查看成果，再决定是否接受':'和规划助手讨论下一步'};
}
export function humanBlockerIntent({flowTerminal,choice}) {
  need(flowTerminal===true,'END_FLOW_BEFORE_REPLANNING');
  need(['HANDLE','HELP','ALTERNATIVE','SAVE'].includes(choice),'INVALID_BLOCKER_CHOICE');
  return choice==='ALTERNATIVE'?{mode:'FIND_ALTERNATIVE_FIRST',interviewBatchSize:5,canFinishEarly:true,requiresNewPlanConfirmation:true}:choice==='SAVE'?{mode:'PARK_PROJECT_KEEP_RESULTS'}:{mode:'GUIDE_USER_WITH_RECOVERABLE_ENTRY',canDecline:true};
}


