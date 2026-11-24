import type {MagpieAccountCheckView,MagpieAccountRecoveryView} from '../shared/magpie-account-check.js';
import type {InspectCustomAccountSources} from '../shared/custom-account-sources.js';import {UiError,escapeHtml as e} from './contracts.js';
const fail=():never=>{throw new UiError('CUSTOM_CONFIGURATION_INVALID','交接检查结果未能完整核对。原配置保留，请先读取保存状态。');};
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function object(raw:unknown):Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();return raw as Record<string,unknown>;}
function exact(raw:unknown,keys:string[]):Record<string,unknown>{const d=Object.getOwnPropertyDescriptors(object(raw));if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!Object.hasOwn(d[k],'value')))return fail();return Object.fromEntries(keys.map(k=>[k,d[k].value]));}
function field(raw:unknown,key:string):unknown {const d=Object.getOwnPropertyDescriptor(object(raw),key);if(!d?.enumerable||!Object.hasOwn(d,'value'))return fail();return d.value;}
function selection(raw:unknown,pid:string):InspectCustomAccountSources {
 const v=exact(raw,['projectId','specHash','profileHash','preparation']),p=exact(v.preparation,['identityHash','contentHash']);if(v.projectId!==pid||!digest(v.specHash)||!digest(v.profileHash)||!digest(p.identityHash)||!digest(p.contentHash))return fail();return{projectId:pid,specHash:v.specHash,profileHash:v.profileHash,preparation:{identityHash:p.identityHash,contentHash:p.contentHash}};
}
export function sameAccountCheckSelection(a:InspectCustomAccountSources,b:InspectCustomAccountSources):boolean {return a.projectId===b.projectId&&a.specHash===b.specHash&&a.profileHash===b.profileHash&&a.preparation.identityHash===b.preparation.identityHash&&a.preparation.contentHash===b.preparation.contentHash;}
export function readMagpieAccountCheck(raw:unknown,pid:string):MagpieAccountCheckView {
 const v=exact(raw,['schema','projectId','scope','historical','status','selection','flowConfigHash','sourceBindingHash','checkedAt','accountCount','processClosed','reason','accountVerified','modelVerified','customExecutionGranted']);
 if(v.schema!=='dream-maker.magpie-account-check.v1'||v.projectId!==pid||v.scope!=='REGISTERED_MEMORY_TRANSFER_ONLY'||v.historical!==true||typeof v.accountVerified!=='boolean'||v.modelVerified!==false||v.customExecutionGranted!==false)return fail();
 if(v.status==='NOT_RUN'){if(v.selection!==null||v.flowConfigHash!==null||v.sourceBindingHash!==null||v.checkedAt!==null||v.accountCount!==null||v.processClosed!==null||v.reason!==null)return fail();}
 else{
  selection(v.selection,pid);if(!digest(v.flowConfigHash)||typeof v.checkedAt!=='string'||v.checkedAt.length>40||!Number.isFinite(Date.parse(v.checkedAt))||new Date(v.checkedAt).toISOString()!==v.checkedAt)return fail();
  const hasAccount=v.accountCount!==null;if(hasAccount!==(v.sourceBindingHash!==null)||hasAccount&&(!Number.isSafeInteger(v.accountCount)||Number(v.accountCount)<1||Number(v.accountCount)>8||!digest(v.sourceBindingHash)))return fail();
  if(v.status==='PASSED'){if(!hasAccount||v.processClosed!==true||v.reason!==null)return fail();}
  else if(v.status==='UNCERTAIN'){if(hasAccount||v.processClosed!==false||v.reason!=='CLEANUP_UNCERTAIN')return fail();}
  else if(v.status==='FAILED'){if(typeof v.reason!=='string'||!['COMPONENT_NOT_BOUND','BUSY','CHECK_FAILED','SELECTION_CHANGED'].includes(v.reason)||v.processClosed!==null&&v.processClosed!==true||hasAccount&&v.processClosed!==true)return fail();}
  else return fail();
 }return structuredClone(v) as unknown as MagpieAccountCheckView;
}
/** Extract only frozen reference metadata; the server remains the authority for the
 * complete snapshot and approval. No prepared snapshot is treated as model proof. */
export function readAccountCheckPreparation(raw:unknown,pid:string,specHash:string,profileHash:string):{selection:InspectCustomAccountSources;flowConfigHash:string}{
 const root=exact(raw,['preparation','executionGranted']),v=exact(root.preparation,['schema','projectId','identityHash','flowConfig','flowConfigHash','createdAt','scope','executionGranted','contentHash']);
 if(root.executionGranted!==false||v.schema!=='dream-maker.custom-flow-preparation.v1'||v.projectId!==pid||v.scope!=='CONFIGURATION_PREPARATION_ONLY'||v.executionGranted!==false||!digest(v.identityHash)||!digest(v.contentHash)||!digest(v.flowConfigHash))return fail();
 const flow=v.flowConfig;if(field(flow,'schema')!=='dream-maker.flow-config.v2'||field(flow,'mode')!=='custom'||field(flow,'projectId')!==pid||field(flow,'qualification')!=='NOT_VERIFIED'||field(field(flow,'plan'),'specHash')!==specHash||field(field(flow,'profile'),'contentHash')!==profileHash)return fail();
 return{selection:{projectId:pid,specHash,profileHash,preparation:{identityHash:v.identityHash,contentHash:v.contentHash}},flowConfigHash:v.flowConfigHash};
}
export function readMagpieAccountRecovery(raw:unknown,pid:string):MagpieAccountRecoveryView {
 const v=exact(raw,['schema','projectId','scope','status','targetHash','checkedAt','processClosed','restartRequired','reason','accountVerified','modelVerified','customExecutionGranted']);
 if(v.schema!=='dream-maker.magpie-account-recovery.v1'||v.projectId!==pid||v.scope!=='LOCAL_PROCESS_CLEANUP_ONLY'||typeof v.accountVerified!=='boolean'||v.modelVerified!==false||v.customExecutionGranted!==false||typeof v.restartRequired!=='boolean')return fail();
 if(v.status==='NOT_REQUIRED'){if(v.targetHash!==null||v.checkedAt!==null||v.processClosed!==null||v.restartRequired!==false||v.reason!==null)return fail();}
 else if(v.status==='REQUIRED'){if(!digest(v.targetHash)||v.checkedAt!==null||v.processClosed!==false||v.restartRequired!==false||!['EVIDENCE_MISSING','CLEANUP_UNCERTAIN'].includes(String(v.reason)))return fail();}
 else if(v.status==='RECOVERED'){if(!digest(v.targetHash)||typeof v.checkedAt!=='string'||v.checkedAt.length>40||!Number.isFinite(Date.parse(v.checkedAt))||new Date(v.checkedAt).toISOString()!==v.checkedAt||v.processClosed!==true||v.reason!==null)return fail();}
 else return fail();return structuredClone(v) as unknown as MagpieAccountRecoveryView;
}
export interface AccountCheckPanel {saved:boolean;needsRead:boolean;pending?:boolean;view?:MagpieAccountCheckView;recovery?:MagpieAccountRecoveryView}
function recoveryPanel(p:AccountCheckPanel):string {
 const v=p.recovery;if(!v||v.status==='NOT_REQUIRED')return'';
 if(v.status==='RECOVERED')return `<p role="status">组件关闭已核清，原交接仍保留为未完成。${v.restartRequired?'请关闭并重开 DM，再读取历史后决定是否重新检查。':'本机服务已重新打开；可单独确认新的交接检查。'}没有重发任务，账户和模型仍未验证。</p>`;
 if(v.reason==='EVIDENCE_MISSING')return'<p role="status">旧记录缺少自动核清需要的进程证据，请保留记录并联系维护者。不能直接清除标记或重新启动组件。</p>';
 return `<div><p>可只读核对上次 DM 专属组件是否已关闭。若仍在运行或证据不足，继续保留封锁；不会结束其他应用，也不会调用模型。</p><label class="check"><input type="checkbox" name="accountRecoveryConsent" ${p.pending?'disabled':''}>我允许只读核对这次中断组件的关闭证据，不重新执行任务或调用模型。</label><button type="button" data-action="custom-account-recover" ${p.pending?'disabled':''}>核对组件是否已关闭（不调用模型）</button></div>`;
}
export function magpieAccountCheckPanel(p:AccountCheckPanel):string {
 const v=p.view,uncertain=v?.status==='UNCERTAIN'&&!(p.recovery?.status==='RECOVERED'&&!p.recovery.restartRequired),disabled=!p.saved||p.needsRead||uncertain||p.pending;
 const status=!v||v.status==='NOT_RUN'?'尚无已保存的交接检查。':v.status==='PASSED'?(v.accountVerified?'上次本机交接已通过，专属组件已关闭；该账户至少有一次计量回执的真实模型调用。模型资格与制作授权仍未开启。':'上次本机交接已通过，专属组件已关闭；账户和模型仍未验证。'):uncertain?'上次检查或清理尚未核清，暂不重新启动。请保留记录并查看恢复帮助。':v.reason==='COMPONENT_NOT_BOUND'?'DM 专属组件尚未准备好，原配置已保留。':v.reason==='SELECTION_CHANGED'?'检查时选择有了变化。旧记录保留，请先核对当前方案与配置。':'来源或组件未完成核对。请查看账户连接和本机状态，原配置已保留。';
 return `<section class="notice" aria-label="已选账户的本机交接"><h4>检查已选来源的本机交接</h4><p>只读取你已明确选中的来源，交给 DM 专属组件后关闭它。不调用模型、不验证套餐、不批准制作；历史通过也不代表当前账户可用。</p><p class="hint">当前已保存路线可包含 OpenAI 订阅规划账户与 DeepSeek API Key 来源。此检查只核对本机交接，不验证账户或模型资格；请先保存设置并确认项目方案。</p><div class="actions wrap"><button type="button" data-action="custom-account-read" ${p.pending?'disabled':''}>读取上次交接检查</button></div><p role="status">${e(status)}</p>${recoveryPanel(p)}${p.needsRead&&!uncertain?'<p>请先读取上次状态，再决定是否检查。</p>':''}<label class="check"><input type="checkbox" name="accountCheckConsent" ${disabled?'disabled':''}>我确认只检查已保存配置中选用的来源，并启动后关闭 DM 专属组件；没有授权调用模型或开始制作。</label><button type="button" data-action="custom-account-check" ${disabled?'disabled':''}>检查本机交接（不调用模型）</button></section>`;
}
