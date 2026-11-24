import type { UiAdapter, ConnectionState } from './contracts.js';
import { UiError, newId } from './contracts.js';
import type { Event as RunEvent } from '../shared/types.js';
/** Preserves v0.1 cookie, CSRF, idempotency and native EventSource replay. Never falls back to Demo. */
export class LocalApiAdapter implements UiAdapter {
  readonly mode = 'local' as const;
  private csrf = '';
  private closers = new Set<() => void>();
  async init(): Promise<void> {
    const token = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
    if (token) history.replaceState(null, '', location.pathname + location.search);
    const data = await this.request<{csrf:string}>('/session', token ? 'POST' : 'GET', token ? {bootstrap:token} : undefined);
    if (typeof data.csrf !== 'string') throw new UiError('INVALID_SESSION','会话响应无效，请检查本地服务。');
    this.csrf = data.csrf;
  }
  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new UiError('INVALID_PATH','请求路径不受支持。');
    const headers: Record<string,string> = {accept:'application/json'};
    if (method !== 'GET') Object.assign(headers, {'content-type':'application/json','x-csrf-token':this.csrf,'idempotency-key':newId()});
    let response: Response;
    try { response = await fetch('/api'+path, {method, headers, signal, credentials:'same-origin', redirect:'error', body:body === undefined ? undefined : JSON.stringify(body)}); }
    catch { throw new UiError('NETWORK_UNCERTAIN',method === 'GET' ? '未能读取本地服务。请检查启动终端并刷新状态。' : '请求结果尚未确认。输入已保留；请刷新状态核对，不要盲目重复提交。'); }
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new UiError('UNEXPECTED_CONTENT_TYPE','服务返回的不是 JSON。请检查同源 /api 路由；未切换到演示。',response.status);
    let data: {error?:string; message?:string};
    try { data = await response.json(); } catch { throw new UiError('INVALID_JSON','服务返回无效 JSON；已有输入已保留。',response.status); }
    if (!response.ok) {
      const message = response.status === 401 ? '本地会话已失效。请用启动终端的一次性链接登录；不要分享该链接。' : response.status === 403 ? '操作未获授权。请核对会话与确认状态，不要关闭安全检查。' : data.message || data.error || '请求失败，请刷新状态后核对。';
      throw new UiError(data.error || 'HTTP_ERROR',message,response.status);
    }
    return data as T;
  }
  subscribe(pid: string, onEvent: (e: RunEvent)=>void, onState: (s: ConnectionState)=>void): () => void {
    let last = 0, closed = false;
    const stream = new EventSource('/api/projects/'+encodeURIComponent(pid)+'/events?after=0');
    onState('connecting');
    stream.onopen = () => { if (!closed) onState('connected'); };
    stream.onerror = () => { if (!closed) onState('reconnecting'); };
    stream.addEventListener('update',event => {
      if (closed) return;
      try { const e = JSON.parse((event as MessageEvent).data) as RunEvent;
        if (!Number.isSafeInteger(e.id) || e.id <= last || e.projectId !== pid) return;
        last = e.id; onEvent(e);
      } catch { onState('reconnecting'); }
    });
    const close = () => { if (closed) return; closed = true; stream.close(); this.closers.delete(close); onState('closed'); };
    stream.addEventListener('application-stopping',event=>{
      if(closed)return;
      try{const value=JSON.parse((event as MessageEvent).data);if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&value.reason==='APPLICATION_STOPPING')close();}catch{/* Malformed metadata grants no authority and does not suppress network recovery. */}
    });
    this.closers.add(close); return close;
  }
  async exportRun(id: string): Promise<{blob:Blob; filename:string}> {
    const response = await fetch('/api/runs/'+encodeURIComponent(id)+'/export',{credentials:'same-origin',redirect:'error'});
    if (!response.ok || !response.headers.get('content-type')?.includes('application/zip')) throw new UiError('EXPORT_FAILED','导出未就绪或会话已失效。请刷新运行状态，不要把错误页面当作 ZIP。',response.status);
    return {blob:await response.blob(),filename:`dream-maker-${id}.zip`};
  }
  dispose(): void { for (const close of [...this.closers]) close(); }
}
