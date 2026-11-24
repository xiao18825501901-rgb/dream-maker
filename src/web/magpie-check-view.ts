import type {MagpieCheckView} from '../shared/magpie-check.js';
import {escapeHtml as e} from './contracts.js';
interface Panel {magpieCheck?:MagpieCheckView;magpieLoading?:boolean;magpieTesting?:boolean;magpieError?:string;magpieNeedsRead?:boolean;busy?:boolean}
export function readMagpieCheck(raw:unknown):MagpieCheckView{
 const fail=():never=>{throw Error('MAGPIE_CHECK_RESPONSE_INVALID');};
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();const v=raw as Record<string,unknown>;
 const keys=['schema','status','checkedAt','reason','processClosed','accountVerified','modelVerified','customExecutionGranted'];
 if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k))||v.schema!=='dream-maker.magpie-local-check.v1'||!['NOT_RUN','PASSED','FAILED','UNCERTAIN'].includes(String(v.status))||v.accountVerified!==false||v.modelVerified!==false||v.customExecutionGranted!==false)return fail();
 if(v.status==='NOT_RUN'){if(v.checkedAt!==null||v.reason!==null||v.processClosed!==null)return fail();}
 else{if(typeof v.checkedAt!=='string'||v.checkedAt.length>40||!Number.isFinite(Date.parse(v.checkedAt))||new Date(v.checkedAt).toISOString()!==v.checkedAt)return fail();
  if(v.status==='PASSED'&&(v.reason!==null||v.processClosed!==true)||v.status==='UNCERTAIN'&&(v.reason!=='CLEANUP_UNCERTAIN'||v.processClosed!==false)||v.status==='FAILED'&&(!['COMPONENT_NOT_BOUND','BUSY','CHECK_FAILED'].includes(String(v.reason))||v.processClosed!==null))return fail();
 }return structuredClone(v) as unknown as MagpieCheckView;
}
export function magpieCheckPanel(v:Panel):string{
 const result=v.magpieCheck,uncertain=result?.status==='UNCERTAIN',disabled=v.magpieLoading||v.busy;
 const title=!result||result.status==='NOT_RUN'?'尚未检查专属本机入口':result.status==='PASSED'?'上次本机入口检查通过，进程已关闭':uncertain?'检查结果尚未核清，暂不重新启动':result.reason==='COMPONENT_NOT_BOUND'?'专属组件尚未登记':result.reason==='BUSY'?'其他工作正在处理，请结束后再检查':'本机入口尚未通过检查，原配置已保留';
 return `<section class="card" data-key="magpie-local-check" aria-labelledby="magpie-check-title"><h2 id="magpie-check-title">自定义模式 · 专属本机入口</h2>
 <p>仅启动并关闭本项目自己的空账户组件，检查后保存记录。不会调用模型、登录账户或更改共享网络；经典模式无需此组件。</p>
 <div class="actions"><button type="button" data-action="magpie-read" ${disabled?'disabled':''}>查看上次检查</button><button type="button" data-action="magpie-check" ${disabled||uncertain||v.magpieNeedsRead?'disabled':''}>${v.magpieTesting?'正在检查并关闭组件…':'检查专属本机入口（不调用模型）'}</button></div>
 <p role="status" aria-live="polite">${e(v.magpieError|| (v.magpieLoading?(v.magpieTesting?'正在核对专属组件，完成后会关闭它。':'正在读取保存的检查记录。'):title))}</p>
 ${result?.checkedAt?`<p>上次记录：<time datetime="${e(result.checkedAt)}">${e(new Date(result.checkedAt).toLocaleString('zh-CN',{hour12:false}))}</time>。这是当次记录，不代表组件现在持续运行。</p>`:''}
 ${uncertain?'<p class="notice">操作可能仍在进行，或上次退出尚未得到确认。请先读取保存状态并核对恢复记录，不要盲目重复启动。</p>':''}
 <p class="hint"><strong>账户和模型尚未核验，自定义制作仍未开启。</strong> 本机检查通过不授予账户、费用或项目制作权限。</p></section>`;
}
