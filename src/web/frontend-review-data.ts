import type {ProjectPlan} from '../shared/project-plan.js';
import type {SetupSnapshot} from '../shared/onboarding.js';
import type {Product} from '../shared/product.js';
import type {Snapshot} from './contracts.js';
import {roleMetadata} from '../shared/role-names.js';
export const reviewNotice='前端导览演示：没有模型调用，没有真实检索、源码制作或验收。';
export function reviewPlan(s:Snapshot):ProjectPlan {
 const requirements:ProjectPlan['requirements']=s.spec!.requirements.map(r=>({id:r.id,text:r.text,origin:r.origin==='DESIGN_ASSUMPTION'?'ASSUMPTION':r.origin,sources:r.sourceAnswerIds}));
 const ids=requirements.map(r=>r.id);
 return {goal:s.project.idea,requirements,acceptance:[{id:'A1',check:'演示：添加一项内容后可见，刷新后仍保留。实际成果尚未制作。',requirementIds:ids}],
 architecture:{summary:'演示建议：先制作单人使用的本地工具，保留内容和修改记录。真正的技术选型需在连接规划服务后核验。',runtime:'尚未连接工程角色',components:['内容输入','列表与状态','数据保存','清楚的使用说明']},
 dataModel:{entities:['用户填写的内容','修改时间和状态'],persistence:'示例目标：保存在用户选择的本地位置；当前只有浏览器导览数据。'},
 interfaces:{userFlows:['添加内容 → 查看 → 修改 → 保存','导出已有成果，按需继续改进'],boundaries:['方案确认、开始制作、最终接受分别由用户决定']},
 tasks:[{id:'T1',title:'整理输入与保存规则',dependsOn:[],requirementIds:ids,check:'示例：输入长中文后仍可编辑'},{id:'T2',title:'制作列表与状态操作',dependsOn:['T1'],requirementIds:ids,check:'示例：能添加、查看、修改内容'},{id:'T3',title:'核对成果与恢复办法',dependsOn:['T2'],requirementIds:ids,check:'示例：由审查角色读取原始测试证据'}],
 delivery:{type:'FRONTEND_REVIEW_ONLY',howToUse:'本页只展示方案。真正交付时应提供打开方式、文件和恢复说明。',standalone:true,needsInternet:false,ongoingFees:['真实费用未知；导览不调用模型。']},
 resources:{accounts:['真实制作前需本人连接工程账户。'],hardware:['实际运行环境待核验。'],network:[],ongoingCosts:[]},
 risks:['尚无真实功能、安全或许可验收。'],milestones:['确认完整方案','单独批准本轮制作','核对报告和成果','用户决定是否接受'],
 assumptions:['这是合成的方案展示，不代表用户已作出选择。'],unknowns:['模型、开源来源、依赖和运行环境尚未核验。'],outOfScope:['自动购买、公开部署和修改共享环境'],
 research:{status:'UNAVAILABLE',sourceRefs:[]},reuse:{mode:'IMPLEMENT_ORIGINAL',selected:[],reason:'仅展示保留检索限制的原创草案；没有断言不存在可复用项目。',externalCodeExecuted:false},
 inputBinding:{inputHash:'UI_REVIEW_NOT_EVIDENCE',interviewRevision:s.project.version,projectRevision:s.project.version,operationId:'frontend-review'}};
}
export function reviewSetup(product:Product):SetupSnapshot {
 const gate={state:'UNKNOWN' as const,message:'导览尚未连接真实账户和运行组件；不会在这里登录、下载或调用。'};
 const roles=([['planner1','方案助手','云端默认 / 可选本地'],['planner2','工程规划','Codex'],['executor','执行制作','DSH'],['reviewer','独立审查','Codex']] as const).map(([role,title,runner])=>({role,displayName:roleMetadata(role).displayName,title,runner,required:role!=='planner1'||product==='dream-maker',provider:'尚未连接',targetModel:null,actualModel:null,installation:gate,authentication:gate,quota:gate,inference:gate,evidence:null}));
 return {schema:'dream-maker.setup.v1',product,requiredRoles:roles.filter(r=>r.required).map(r=>r.role),roles,
 optionalLaya:{required:false,availableToChoose:true,configuredMode:'off',actualService:'NOT_CHECKED'},safety:gate,
 fees:{ordinaryUserDefault:{configured:false,unlimited:false,automaticRecharge:false,extraUsage:false},existingScope:{status:'UNAVAILABLE',mode:null,requests:null,maxRequests:null,byCurrency:{}},
 userBudget:{configured:false,unlimited:false,revision:0,limits:{CNY:0,USD:0},baselineRequests:0,startedAt:null,basis:'FUTURE_REQUESTS_SINCE_EXPLICIT_ACTIVATION',byCurrency:{CNY:{committedMicros:0,reservedMicros:0,remainingMicros:0,exceeded:false},USD:{committedMicros:0,reservedMicros:0,remainingMicros:0,exceeded:false}}},
 userBudgetAvailable:true,note:'演示金额只保留在本页内存，不读取、修改或替代开发预算和正式账本。'},automaticActions:false,modelCalls:0,fullFlowAcceptance:'NOT_RUN'};
}
export const reviewHelp={
 ACCOUNT:{title:'账户还没有连接',what:'工具装好和账户可用是两件事。这里没有连接真实账户。',impact:'可以先保存想法和方案；相应角色暂时不能制作。',steps:['打开使用准备，查看哪个角色需要连接。','在官方入口本人登录，不把密码或一次性代码发给别人。','回到准备页，分别核对账户、额度和最小调用。'],alternative:'暂时不能登录时，保留方案，不自动改用其他收费方式。'},
 PROGRESS:{title:'任务停下来了，怎么办？',what:'先保存已有内容，再看哪个条件需要处理。',impact:'停止或未知不等于数据已经丢失，也不等于任务已经完成。',steps:['打开审查报告，查看已保存成果和未完成项。','选择我来处理、需要帮助、换一种办法或暂时不做。','换路前结束当前轮次，新方案仍需再次确认。'],alternative:'不愿安装或购买也可以写成限制，寻找合法替代方法。'},
 STORAGE:{title:'备份、恢复和迁移有什么区别？',what:'备份保留副本，恢复读回已核验副本，迁移改变以后保存的位置。',impact:'每次操作都应看清包含哪些数据，不能把状态副本当完整项目。',steps:['到数据与维护查看范围和占用。','先保留原件，核对副本后再切换。','删除旧副本必须单独确认。'],alternative:'当前导览可以体验操作确认，但不会修改真实文件。'}
};
