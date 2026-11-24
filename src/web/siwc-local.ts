import type { LocalApiAdapter } from './local-api.js';
import { patchHtml } from './dom.js';
import { escapeHtml as e, UiError } from './contracts.js';
interface Status {authMode:'api_key'|'siwc_plan';state:string;legal:{acknowledged:boolean};eligibility:string;region:string;session:{status:string;sharing:boolean;profileId?:string;profileLabel?:string;identity?:{name?:string;email?:string}};model:{slug:string|null;discovery:string;inference:string};attempts:{state:string;id:string|null;startedAt:string|null};usage:{source:string;tokens:string;costUsd:string;manageUrl:string};error?:{code:string;status:number|null;requestId?:string;param?:string;retryable:boolean};capability:{sdk:string;osEncryption:string;browserAuth:string}}
interface Model {slug:string;displayName:string}
interface Profile {id:string;label:string;status:string;sharing:boolean;pending:boolean}
export function siwcConnectionActions(input:{statusAvailable:boolean;connected:boolean;sharing:boolean;state:string;authorizing:boolean;busy:boolean}):string {
 if(!input.statusAvailable)return '<div class="notice" role="status" data-key="siwc-session-held-until-readable"><strong>连接保持不变</strong><p>当前只是暂时无法读取连接状态，不会因暂时错误自动重新登录。</p></div>';
 if(input.connected)return `<div class="notice" role="status" data-key="siwc-session-reuse"><strong>连接已保存，后续会自动复用</strong><p>无需重复连接。只有会话失效、被撤销或切换账户时才需要重新登录。</p></div>${input.sharing?'':'<button type="button" data-action="siwc-reconsent">授权套餐用量</button>'}<button type="button" data-action="siwc-disconnect">断开当前连接</button>`;
 if(input.authorizing||input.state==='AUTHORIZING')return `<button type="button" data-action="siwc-connect" class="primary" disabled>Continue with ChatGPT</button><button type="button" data-action="siwc-cancel">取消授权请求</button>`;
 if(input.state==='TEMPORARILY_UNAVAILABLE')return '<div class="notice" role="status" data-key="siwc-session-temporary"><strong>连接已保存，暂时无法读取</strong><p>不会要求重新登录；本地服务恢复后会自动继续使用原会话。</p></div>';
 if(input.state!=='DISCONNECTED'&&input.state!=='REAUTH_REQUIRED')return `<div class="notice" role="status" data-key="siwc-session-held"><strong>连接保持不变</strong><p>当前状态：${e(input.state)}。不会因暂时错误自动重新登录。</p></div>`;
 return `<button type="button" data-action="siwc-connect" class="primary" ${input.busy?'disabled':''}>${input.state==='REAUTH_REQUIRED'?'重新连接':'Continue with ChatGPT'}</button>`;
}
/** Local-only view plugin. This file is not copied into the public demo build. */
export class SiwcLocalPanel {
 private status:Status|null=null;
 private models:Model[]=[];private profiles:Profile[]=[];
 private generation=0;private timer:ReturnType<typeof setTimeout>|null=null;private target:HTMLElement|null=null;
 private error='';private busy=false;
 constructor(private api:LocalApiAdapter){}
 async load():Promise<void>{const g=++this.generation;this.stopTimer();try{const s=await this.api.request<Status>('/planner1/siwc/status');if(g!==this.generation)return;this.status=s;this.error='';this.schedule();}catch{if(g!==this.generation)return;this.error='SIWC 状态不可读取；不代表已经连接。';}}
 private stopTimer():void{if(this.timer){clearTimeout(this.timer);this.timer=null;}}
 private schedule():void{this.stopTimer();if(this.status?.attempts.state==='AUTHORIZING')this.timer=setTimeout(async()=>{try{const s=await this.api.request<Status>('/planner1/siwc/status');this.status=s;if(s.attempts.state!=='AUTHORIZING'){this.models=[];this.profiles=[];}this.render();this.schedule();}catch{this.error='状态轮询失败，请手动刷新；授权结果未知。';this.render();}},1500);}
 attach(el:HTMLElement|null):void{this.target=el;this.render();}
 detach():void{this.generation++;this.stopTimer();this.target=null;}
 private render():void{
  if(!this.target)return;
  const s=this.status,connected=s?.session.status==='connected',sharing=s?.session.sharing===true;
  const state=s?.state||'DISCONNECTED';const error=this.error||s?.error?.code||'';
  const modelValue=s?.model.slug||'';
  const html=`<section class="card siwc-card" data-key="siwc-local"><div class="section-heading"><h2>使用 ChatGPT 套餐 · Seeker</h2><span class="pill ${sharing?'success':'warning'}">${e(state)}</span></div>
   <p class="hint">这是独立的套餐授权路径，不使用已有 API Key 或 Codex 登录态。符合资格的账户才能授权使用套餐；额度、政策和地区以实际账户为准。</p>
   ${error?`<p role="alert" class="notice warning">${e(error)} · 套餐路径暂停，不会自动回退到收费 API。</p>`:''}
   <dl class="metrics"><div><dt>SDK</dt><dd>${e(s?.capability.sdk||'UNKNOWN')}</dd></div><div><dt>Windows OS 加密</dt><dd>${e(s?.capability.osEncryption||'UNKNOWN')}</dd></div><div><dt>套餐授权 scope</dt><dd>${sharing?'已授权':'未验证'}</dd></div><div><dt>地区与资格</dt><dd>${e(s?.region||'UNKNOWN')} / ${e(s?.eligibility||'UNKNOWN')}</dd></div><div><dt>所选模型推理</dt><dd>${e(s?.model.inference||'NOT_RUN')}</dd></div><div><dt>用量／额度</dt><dd>UNKNOWN，非无限或免费承诺</dd></div></dl>
   ${connected?`<p class="hint">当前账户：${e(s?.session.profileLabel||s?.session.profileId||'未知')} · ${sharing?(s?.authMode==='siwc_plan'?'Using ChatGPT plan（scope 已生效）':'套餐授权已生效，但 Seeker 当前仍选 API Key'):'已登录，未授予套餐使用权限'}</p>`:''}
   <div class="siwc-actions"><label class="check"><input id="siwc-noncommercial" type="checkbox" ${s?.legal.acknowledged?'checked':''}> 我确认仅用于符合 DevKit 许可的个人非商业用途，并理解该声明不能替代实际许可审查。</label>
   ${siwcConnectionActions({statusAvailable:s!==null,connected,sharing,state,authorizing:s?.attempts.state==='AUTHORIZING',busy:this.busy})}
   <button type="button" data-action="siwc-refresh">刷新连接状态</button></div>
   <p class="hint"><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a> · ChatGPT 套餐和 API 费用分开；本应用不推测剩余额度或重置时间。</p>
   ${connected?`<div class="siwc-choice"><h3>已保存的连接与模型</h3><div class="row wrap"><button type="button" data-action="siwc-profiles">查看已保存的账号</button><button type="button" data-action="siwc-models" ${!sharing?'disabled':''}>从当前账户读取模型</button></div>
    ${this.profiles.length?`<label for="siwc-profile">选择账号／工作区</label><select id="siwc-profile">${this.profiles.map(p=>`<option value="${e(p.id)}" ${p.id===s?.session.profileId?'selected':''}>${e(p.label)} · ${e(p.status)} ${p.sharing?'· scope':'· 无 scope'}</option>`).join('')}</select><button type="button" data-action="siwc-select-profile">切换所选账号</button>`:''}
    ${this.models.length?`<label for="siwc-model">所选账户的可见模型（列表不等于推理资格）</label><select id="siwc-model">${this.models.map(m=>`<option value="${e(m.slug)}" ${m.slug===modelValue?'selected':''}>${e(m.displayName)} · ${e(m.slug)}</option>`).join('')}</select><button type="button" data-action="siwc-select-model">选择此模型</button>`:''}
    <p class="hint">账号切换会清空旧模型选择与已验证标记。只有一次正式 Responses 请求实际完成，才标记该模型推理完成。</p></div>`:''}
  </section>`;
  patchHtml(this.target,html);
 }
 async act(action:string,root:HTMLElement):Promise<void>{if(this.busy)return;
  // Read user choices before rendering the busy state. Rendering may reconcile/recreate controls.
  const noncommercialChecked=root.querySelector<HTMLInputElement>('#siwc-noncommercial')?.checked===true;
  const chosenProfile=root.querySelector<HTMLSelectElement>('#siwc-profile')?.value;
  const chosenModel=root.querySelector<HTMLSelectElement>('#siwc-model')?.value;
  this.busy=true;this.error='';this.render();try{
  if(action==='siwc-refresh')await this.load();
  else if(action==='siwc-connect'||action==='siwc-reconsent'){
   if(!noncommercialChecked)throw new Error('请先明确确认本地个人非商业许可用途。');
   await this.api.request('/planner1/siwc/connect','POST',{localNoncommercial:true,reconsent:action==='siwc-reconsent'});await this.load();
  }else if(action==='siwc-cancel'){await this.api.request('/planner1/siwc/cancel','POST',{});await this.load();}
  else if(action==='siwc-profiles'){const r=await this.api.request<{profiles:Profile[]}>('/planner1/siwc/profiles');this.profiles=r.profiles;}
  else if(action==='siwc-models'){const r=await this.api.request<{models:Model[]}>('/planner1/siwc/models');this.models=r.models;await this.load();}
  else if(action==='siwc-select-profile'){
   const profileId=chosenProfile;if(!profileId)throw new Error('请选择账号。');
   await this.api.request('/planner1/siwc/select','POST',{profileId});this.models=[];this.profiles=[];await this.load();
  }else if(action==='siwc-select-model'){
   const slug=chosenModel;if(!slug)throw new Error('先从当前账号读取模型。');
   await this.api.request('/planner1/siwc/model','POST',{slug});await this.load();
  }else if(action==='siwc-disconnect'){
   if(!window.confirm('断开当前 ChatGPT 套餐连接？这不会改变已有 API Key 模式或其他 Agent。远端撤销是否成功以服务端说明为准。'))return;
   const r=await this.api.request<{remoteRevocation:string}>('/planner1/siwc/disconnect','POST',{});this.models=[];this.profiles=[];await this.load();this.error='本地断开已请求；远端撤销状态：'+r.remoteRevocation;
  }
 }catch(err){const x=err as Error;this.error=err instanceof UiError?`${err.code} · ${err.message}`:x.message||'SIWC 操作受阻，未自动回退。';}finally{this.busy=false;this.render();}}
}
