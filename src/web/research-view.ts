import type {ResearchOperation} from '../shared/research.js';
import type {ViewState} from './views.js';
import {escapeHtml as e} from './contracts.js';
export interface ReviewCandidate {name:string;description:string;fit:string;changes:string;limits:string}
export interface ResearchPanelState {operations:ResearchOperation[];reviewCandidates?:ReviewCandidate[]}
function sourceLink(value:string){try{const url=new URL(value);if(url.protocol==='https:'&&['github.com','gitlab.com'].includes(url.hostname)&&!url.username&&!url.password&&!url.port)return `<a href="${e(url.href)}" target="_blank" rel="noopener noreferrer">${e(url.hostname+url.pathname)}</a>`;}catch{}return '<span>来源地址尚未核验</span>';}
export function researchPage(v:ViewState):string{
 const operations=v.researchPanel?.operations??v.snapshot?.research??[],latest=operations.at(-1),result=latest?.result;
 const failed=!result||result.status==='UNAVAILABLE'||!Array.isArray(result.snapshots)||!Array.isArray(result.results)||['FAILED','RESULT_UNCERTAIN','CANCELLED'].includes(latest?.status??'');
 const snapshots=Array.isArray(result?.snapshots)?result.snapshots.filter(row=>row&&typeof row.namespace==='string'&&typeof row.webUrl==='string'&&typeof row.commit==='string'&&typeof row.snapshotHash==='string'):[];
 const discovered=Array.isArray(result?.results)?result.results.flatMap(row=>Array.isArray(row?.items)?row.items.filter(item=>item&&typeof item.namespace==='string'&&typeof item.webUrl==='string'):[]):[];
 const candidates=[...snapshots.map(row=>({name:row.namespace,url:row.webUrl,description:row.description,commit:row.commit,license:row.discoveredLicenseHint,pinned:true,hash:row.snapshotHash})),...discovered.filter(row=>!snapshots.some(saved=>saved.webUrl===row.webUrl)).map(row=>({name:row.namespace,url:row.webUrl,description:row.description,commit:'',license:null,pinned:false,hash:''}))];
 const review=v.mode==='public-demo'?v.researchPanel?.reviewCandidates??[]:[];
 return `<section class="card"><div class="section-heading"><div><span class="eyebrow">先查找，再决定做法</span><h2>开源研究</h2></div><button type="button" data-action="reload-panel" class="secondary">刷新研究记录</button></div><p>方案助手会判断适合整体改造、局部复用，还是原创实现。你不需要自己挑框架，只需核对方案是否符合你的想法。</p>
 ${failed?'<div class="notice warning"><strong>检索暂未完成。</strong> 可能遇到限流、离线或其他读取限制，可以稍后再核对。此状态不能判断是否存在可复用项目。</div>':result.status==='PARTIAL'?'<p class="notice warning">只完成了部分查找；缺失资料仍需核对。</p>':'<p class="notice">已完成本次限定范围的查找，不代表已查遍所有平台。</p>'}
 <p class="hint">找到公开仓库、README 或许可证名称，还不表示可以直接复制运行。功能、许可、依赖和运行条件需要分别核验。</p>
 ${candidates.length?`<div class="research-candidates">${candidates.map(row=>`<article class="candidate"><div class="section-heading"><h3>${e(row.name)}</h3><span class="pill">${row.pinned?'已保留来源文本':'初步发现'}</span></div><p>${e(row.description||'仓库未提供简介。')}</p><p>${sourceLink(row.url)}</p><dl><dt>为什么适合</dt><dd>逐项适合度尚未提供；请结合完整方案中的推荐理由。</dd><dt>需要改造</dt><dd>尚未形成逐候选改造清单。</dd><dt>许可</dt><dd>${e(row.license?'发现许可线索：'+row.license+'；条款和适用范围尚需核对。':'尚未核对许可证与附带素材的使用条件。')}</dd><dt>依赖与运行限制</dt><dd>安装脚本、安全与实际运行尚未验证。</dd></dl>${row.pinned?`<details><summary>来源标识</summary><p class="hash-text">固定版本：${e(row.commit)}</p><p class="hash-text">文本记录：${e(row.hash)}</p><p>只证明已保存文本，不证明代码已经执行。</p></details>`:''}</article>`).join('')}</div>`:!failed?'<div class="empty"><h3>本次限定检索没有返回候选</h3><p>这不代表不存在可复用项目。助手可以保留这个限制，提出原创方案供你确认。</p></div>':''}
 ${review.length?`<section class="notice review-only"><h3>候选页面演示</h3><p>以下为合成内容，展示研究结果将怎样呈现；没有真实检索、仓库或许可结论。</p>${review.map(row=>`<article class="candidate"><h4>${e(row.name)} · 演示</h4><p>${e(row.description)}</p><dl><dt>适合原因示例</dt><dd>${e(row.fit)}</dd><dt>改造内容示例</dt><dd>${e(row.changes)}</dd><dt>限制示例</dt><dd>${e(row.limits)}</dd></dl><details><summary>查看尚待核验的内容</summary><p>固定来源、许可证、依赖、安全和真实运行均尚未连接。</p></details></article>`).join('')}</section>`:''}
 <div class="actions"><button type="button" data-action="tab" data-tab="spec" class="primary">查看助手推荐的项目方案</button></div></section>`;
}
