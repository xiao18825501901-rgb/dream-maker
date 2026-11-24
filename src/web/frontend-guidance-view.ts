import type {ViewState} from './views.js';
import {escapeHtml as e} from './contracts.js';
import {networkContextsPanel} from './network-context-view.js';
import {magpieCheckPanel} from './magpie-check-view.js';
export const tourPages=[
 {title:'首页与项目',view:'home',description:'写下一句话，或继续已经保存的项目。'},
 {title:'Grill Me 访谈',project:'sample-clarify',tab:'work',description:'每次只问一个问题，四个选项加自由回答；可以跳过或提前结束。'},
 {title:'开源项目研究',project:'sample-spec',tab:'research',description:'看适合原因、改造内容和限制。这里的候选是合成示例。'},
 {title:'完整项目方案',project:'sample-spec',tab:'spec',description:'先看摘要，再展开详情。确认方案和开始制作是两个决定。'},
 {title:'方案版本历史',project:'sample-spec',tab:'history',description:'完整版本会保留。查看差异不会修改或批准旧版。'},
 {title:'DreamFlow 工作台',project:'sample-review',tab:'flow',description:'工程规划、执行器和审查各负其责。卡片不代表真实运行器已经连接。'},
 {title:'DreamFlow-Laya',project:'sample-review',tab:'laya',description:'比较普通流程与可选辅助；没有安装也能查看说明。'},
 {title:'Reviewer 报告',project:'sample-review',tab:'report',description:'先看已保留的内容、剩余问题，再决定下一步。'},
 {title:'后续问题与换路',project:'sample-review',tab:'followup',description:'保留问题草稿，体验无法解决、换一种办法和五题澄清。'},
 {title:'独立 DreamFlow',view:'standalone',description:'由你输入或导入完整方案，不需要需求访谈。'},
 {title:'帮助',view:'help',description:'用普通话解释影响和下一步；可以换一种更简单的说法。'},
 {title:'首次使用向导',view:'setup',description:'把安装、账户、额度和实际调用分开看；导览不会要求你登录。'},
 {title:'费用控制',view:'fees',description:'体验填写限额和再次确认。演示不会修改真实账本。'},
 {title:'成果交付',project:'sample-delivery',tab:'files',description:'体验固定样例预览、下载和演示接受，不代表模型制作成功。'},
 {title:'数据与维护',view:'maintenance',description:'看清备份范围，体验恢复、迁移和退出确认。演示不操作真实文件。'},
 {title:'应用设置',view:'settings',description:'查看本地模型、网络工具、Laya、更新和保存位置。'}
] as const;
export function frontendTour(v:ViewState):string{
 if(v.presentation!=='frontend-review')return '';
 return `<section class="tour-bar" aria-label="前端逐页导览"><div><span class="eyebrow">前端导览 · 未连接真实制作</span><h2>先逛一遍，再决定怎么改。</h2><p>以下页面均使用合成内容。可以自由编辑，不会登录账户、修改真实数据或产生模型费用。</p></div><details><summary>选择要看的页面 · 共 16 页</summary><nav class="tour-grid">${tourPages.map((page,i)=>`<button type="button" data-action="tour-page" data-page="${i}"><span>${String(i+1).padStart(2,'0')}</span>${e(page.title)}</button>`).join('')}</nav></details></section>`;
}
export function settingsOverview(v:ViewState):string {
 return `<section class="page-heading"><span class="eyebrow">按自己的方式使用</span><h1>应用设置</h1><p>${v.presentation==='frontend-review'?'以下设置可体验选择和确认，尚未连接真实配置。请勿输入密码、密钥或本机秘密。':'当前设置以本机已连接的组件为准，尚未接通的功能会保留说明。'}</p></section>
 <section class="card"><h2>账户与模型</h2><p>方案助手独立选择受支持的连接；独立 DreamFlow 由你提供方案。工程规划和审查需要独立会话，执行制作使用 DSH。</p><div class="actions"><button type="button" data-action="setup">查看账户与真实调用资格</button>${v.product!=='dreamflow'&&v.mode==='local'&&v.presentation!=='frontend-review'?'<button type="button" data-action="planner1-choice">选择方案助手</button>':''}</div></section>
 <section class="card"><h2>本地模型 · 可选</h2><p>可选择本机 Ollama 作为方案助手。固定只访问回环地址；先检查电脑资源和已安装模型，再做一次真实最小调用。本机能力不足时停止，不会自动下载或改用云端。</p><button type="button" data-action="setting-explain" data-topic="local">查看使用条件</button>${v.presentation==='frontend-review'?'<button type="button" data-action="review-preferences">体验选择方案助手</button>':''}</section>
 <section class="card"><h2>已有网络工具</h2><p>只复用已经获准的本机工具。节点配置、验证和真实请求路径仍须分别核验，不改变全局代理或共享配置。</p><button type="button" data-action="setting-explain" data-topic="network">查看连接与恢复说明</button></section>
 ${v.mode==='local'&&v.presentation!=='frontend-review'?networkContextsPanel(v):''}
 ${v.mode==='local'&&v.presentation!=='frontend-review'?magpieCheckPanel(v):''}
 <section class="card"><h2>Laya 可选辅助</h2><p>普通 DreamFlow 无需 Laya。增强方式为工程规划、执行器和审查提供建议，不能代替你的批准。</p><button type="button" data-action="setting-explain" data-topic="laya">比较两种方式</button></section>
 <section class="card"><h2>存储位置与迁移</h2><p>本工程已切换到 F 盘专属目录。旧盘上的 Dream Maker 项目数据已移出并完成逐文件核对；项目可控制的新文件、数据、缓存与构建都放在 F 盘。</p><details><summary>查看本机存储位置</summary><p class="hash-text">F:\\DreamMakerSuite</p><p>系统与 Codex 桌面自身仍可能写入系统盘；不在这里改变全局设置。</p></details><button type="button" data-action="maintenance">查看数据维护</button></section>
 <section class="card"><h2>更新与退出</h2><p>不会自动联网更新。退出前可选择等待暂停，或让当前已批准工作继续；直接关闭浏览器不等于停止收费任务。</p><div class="actions"><button type="button" data-action="setting-explain" data-topic="update">查看更新方式</button><button type="button" data-action="application-exit">选择离开方式</button></div></section>`;
}
export function reviewMaintenance():string{
 return `<section class="card review-only"><h2>体验备份、恢复与迁移 · 演示</h2><p>这里只展示操作范围和确认，不会产生数据库快照、恢复回执或修改真实文件。</p><div class="actions wrap">${[['backup','备份范围'],['restore','恢复步骤'],['migrate','迁移位置']].map(([topic,title])=>`<button type="button" data-action="review-data" data-topic="${topic}">${title}</button>`).join('')}</div></section>`;
}
