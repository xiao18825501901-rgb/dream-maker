import { escapeHtml as e } from './contracts.js';

export type LayaHealthState = 'REPORTED_OK' | 'REPORTED_NOT_OK' | 'RESPONSE_ONLY';

export interface LayaProbeView {
  reachable: true;
  endpoint: string;
  health: LayaHealthState;
  revision: string | null;
  tokenizer: string | null;
  device: string | null;
  modelQuality: 'NOT_VERIFIED';
}

export type LayaProbeReadResult =
  | { ok: true; value: LayaProbeView }
  | { ok: false; code: 'LAYA_PROBE_ENDPOINT_INVALID' | 'LAYA_PROBE_RESULT_INVALID' };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const safeText = (value: unknown, max = 160): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
};

const loopbackEndpoint = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
        url.username || url.password || url.search || url.hash ||
        !['', '/'].includes(url.pathname)) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const healthState = (value: unknown): LayaHealthState => {
  const health = record(value);
  if (!health) return 'RESPONSE_ONLY';
  if (health.ok === true || health.healthy === true || health.status === 'ok' || health.code === 0)
    return 'REPORTED_OK';
  if (health.ok === false || health.healthy === false || ['error', 'unhealthy'].includes(String(health.status)))
    return 'REPORTED_NOT_OK';
  return 'RESPONSE_ONLY';
};

export function readLayaProbe(value: unknown): LayaProbeReadResult {
  const root = record(value);
  if (!root || root.verified !== 'HTTP_ONLY_NOT_MODEL_QUALITY')
    return { ok: false, code: 'LAYA_PROBE_RESULT_INVALID' };
  const endpoint = loopbackEndpoint(root.base);
  if (!endpoint) return { ok: false, code: 'LAYA_PROBE_ENDPOINT_INVALID' };
  const info = record(root.info);
  return {
    ok: true,
    value: {
      reachable: true,
      endpoint,
      health: healthState(root.health),
      revision: safeText(info?.revision, 128) ?? safeText(info?.model_revision, 128),
      tokenizer: safeText(info?.tokenizer, 128) ?? safeText(info?.tokenizer_id, 128),
      device: safeText(info?.device, 128),
      modelQuality: 'NOT_VERIFIED'
    }
  };
}

const pill = (text: string, tone: string) => `<span class="pill ${tone}">${e(text)}</span>`;

export function layaProbePanel(input: {
  result?: LayaProbeReadResult;
  error?: string;
  expectedRevision?: string;
}): string {
  if (!input.result && !input.error) {
    return '<div class="rail-info" data-key="laya-probe-result"><h3>本地服务检查</h3><p class="hint">尚未检查。点击按钮只会明确访问本机 Laya 的 `/health` 与 `/info`。</p></div>';
  }
  if (!input.result || input.result.ok === false) {
    const text = input.error || (input.result?.ok === false && input.result.code === 'LAYA_PROBE_ENDPOINT_INVALID'
      ? '本机检查只允许检查本机回环服务；没有连接其他地址。'
      : '服务没有返回可核对的本机检查结果；没有把它当成健康。');
    return `<div class="rail-info" data-key="laya-probe-result" role="status" aria-live="polite"><div class="row between"><h3>本地服务检查</h3>${pill('未确认', 'danger')}</div><p class="preserve">${e(text)}</p></div>`;
  }
  const probe = input.result.value;
  const healthText = probe.health === 'REPORTED_OK'
    ? '服务自报正常'
    : probe.health === 'REPORTED_NOT_OK'
      ? '服务自报异常'
      : '已响应，未确认健康';
  const expected = safeText(input.expectedRevision, 128);
  const revisionMatch = !expected
    ? '未配置固定预期'
    : !probe.revision
      ? '服务未提供，不能与当前预期核对'
      : probe.revision === expected
        ? '与当前预期一致'
        : '与当前预期不一致';
  return `<div class="rail-info" data-key="laya-probe-result" role="status" aria-live="polite">
    <div class="row between"><div><h3>本地服务检查</h3><p class="hint">HTTP 可达，只代表 <code>/health</code> 与 <code>/info</code> 有响应。</p></div>${pill('服务已响应', 'good')}</div>
    <dl class="metrics">
      <div><dt>连接地址</dt><dd><code>${e(probe.endpoint)}</code></dd></div>
      <div><dt>健康检查</dt><dd>${e(healthText)}</dd></div>
      <div><dt>模型 revision</dt><dd>${e(probe.revision ?? '未提供')}</dd></div>
      <div><dt>版本核对</dt><dd>${e(revisionMatch)}</dd></div>
      <div><dt>Tokenizer</dt><dd>${e(probe.tokenizer ?? '未提供')}</dd></div>
      <div><dt>设备</dt><dd>${e(probe.device ?? '未提供')}</dd></div>
    </dl>
    <p class="hint">这不代表分类质量、模型质量、隐藏调用关闭或三个工程角色已经参与；也不会改变权限、预算或审核状态。</p>
  </div>`;
}
