/**
 * A08: turn the native-execution readiness payload into an honest, actionable sentence.
 *
 * Why: `POST /api/projects/:id/build` refuses Live with `NATIVE_INTEGRATION_BLOCKED` and a
 * comma-joined list of reason codes. That list is truthful but unreadable, and "Live is blocked" is
 * exactly the kind of state a user misreads as "log in again" or as a bug. Every code below maps to
 * the concrete thing that is missing, and none of them is a Kimi-login problem.
 *
 * `NATIVE_REAL_PROBES_REQUIRED` is the one that used to read as an unexplained code. The readiness
 * payload now also carries the probe gate (phase + per-role receipt state), so the summary can name
 * the roles that are still missing and the role that is already proven.
 *
 * Pure string building so the wording is testable without a DOM.
 */
export interface NativeProbeRoleState {
    present?: boolean;
    valid?: boolean;
}

export interface NativeProbeGate {
    phase?: string;
    requests?: number;
    maxRequests?: number;
    roles?: Record<string, NativeProbeRoleState>;
    error?: string | null;
}

export interface NativeReadinessPayload {
    ok?: boolean;
    reasons?: string[];
    configurationHash?: string;
    /** Per-role minimum-probe state, when the app was able to read it. */
    probeGate?: NativeProbeGate | null;
}

export interface NativeReadinessSummary {
    level: 'ok' | 'warn' | 'error';
    headline: string;
    detail: string;
    /** The unresolved reasons, in the order they were reported. */
    blockers: string[];
    /** Live execution never becomes a login problem. */
    needsLogin: boolean;
    /** What only the owner can supply, stated as actions rather than as blame. */
    ownerActions: string[];
}

const REASONS: Record<string, string> = {
    DSH_NATIVE_MODULE_MISSING: '缺 DSH 原生模块（官方 SDK 发行面未安装）',
    ISOLATED_CODEX_HOME_REQUIRED: '未配置隔离的 CODEX_HOME',
    CODEX_MODEL_REQUIRED: '未指定执行模型（deepseek-flash）',
    NATIVE_AUDIT_REQUIRED: '缺原生执行审计文件',
    NATIVE_AUDIT_CONFIG_MISMATCH: '审计与当前配置指纹不一致',
    NATIVE_AUDIT_NOT_READY: '审计状态不是 LIVE_READY',
    NATIVE_ISOLATION_UNVERIFIED: '操作系统/密钥隔离未证实',
    NATIVE_LAYA_OFF_UNVERIFIED: 'Laya OFF 未被逐回合证实',
    NATIVE_VERIFIER_NOT_IMPLEMENTED: '可信验证器未实现',
    NATIVE_SANDBOX_EXECUTION_UNVERIFIED: '沙箱没有真实执行过一次（只验过计划）',
    NATIVE_AUDIT_EXPIRED: '原生审计已过期',
    NATIVE_AUDIT_EVIDENCE_MISSING: '审计缺少证据文件',
    NATIVE_EVIDENCE_MISMATCH: '审计证据与磁盘文件不一致',
    NATIVE_MODULE_CHANGED: '原生模块在审计之后被改动',
    NATIVE_AUDIT_INVALID: '审计文件无法解析',
    NATIVE_OPERATOR_CONFIG_REQUIRED: '缺 operator 绑定（config/native-owner.local.json）',
    NATIVE_OPERATOR_CONFIG_INVALID: 'operator 绑定的字段不合法',
    NATIVE_OPERATOR_CONFIG_CHANGED: 'operator 绑定在启动后被改动',
    NATIVE_OPERATOR_BINDING_NOT_AUDITED: 'operator 绑定里的文件没有被审计覆盖',
    NATIVE_BINDING_REQUIRED: '缺 operator 绑定条目',
    NATIVE_BINDING_CHANGED: '绑定文件的内容与记录的哈希不一致',
    NATIVE_TEMPLATE_LIMITS_INVALID: '执行模板的限额/推理档不符合原生要求',
    NATIVE_SCOPE_LIMITS_EXCEEDED: '原生执行范围限制被超出（模型或返修上限）',
    NATIVE_REAL_PROBES_REQUIRED: '四角色最小探测收据不齐',
    PROBE_EVIDENCE_UNVERIFIED: '四角色探测收据与当前构建不一致（收据按源码树哈希绑定）',
    NATIVE_PRICE_UNKNOWN: '缺可核验的官方价格凭证',
    NATIVE_PRICE_EXPIRED: '价格凭证已过期',
    NATIVE_PRICE_ROUTE_MISMATCH: '价格凭证与当前路由不一致',
    NATIVE_CONSERVATIVE_PRICE_REQUIRED: '价格必须按官方上限（上下文/单价）申报',
    NATIVE_TOTAL_REQUEST_LIMIT: '已达本次授权的请求数量上限',
    DSH_KEY_MISSING: '缺官方 DeepSeek API 凭据（应由所有者提供）',
    CODEX_SUBSCRIPTION_ACCOUNT_REQUIRED: '隔离 Codex home 未登录 ChatGPT 订阅（应由所有者登录）',
    TRUSTED_VERIFIER_APPROVAL_REQUIRED: '该规格/计划还没有被所有者确认过的可信验证器',
    TRUSTED_VERIFIER_PLAN_REQUIRED: '该规格没有任何可信验证器计划（原生 Live 按 specHash 匹配 oracle）',
    NATIVE_LAYA_BASELINE_REQUIRED: 'Laya 未处于关闭状态，原生执行不允许带隐性模型',
    NATIVE_LAYA_QUALIFICATION_REQUIRED: 'Laya 增强路径尚未完成三角色真实资格核验',
    NATIVE_RUNTIME_FACTORY_REQUIRED: '没有受控执行工厂（不可能在 DEMO 里假装 Live）'
};

/** Codes whose gap can only be closed by the owner, phrased as an action. */
const OWNER_ACTIONS: Record<string, string> = {
    DSH_KEY_MISSING: '请在本机提供官方 DEEPSEEK_API_KEY（环境变量或隔离凭据服务）',
    CODEX_SUBSCRIPTION_ACCOUNT_REQUIRED: '请用你的 ChatGPT 订阅登录隔离的 CODEX_HOME（codex login）',
    TRUSTED_VERIFIER_APPROVAL_REQUIRED: '请确认该项目的规格与验证器计划',
    TRUSTED_VERIFIER_PLAN_REQUIRED: '请为该项目当前规格（按 specHash）登记可信验证器计划：operator 绑定的 oracles 里没有这一条',
    NATIVE_REAL_PROBES_REQUIRED: '凭据到位后运行四角色真实探测（POST /api/native/probes）',
    NATIVE_LAYA_QUALIFICATION_REQUIRED: '先在设置页完成本地 Laya 三角色真实资格核验（POST /api/laya/qualification）',
    PROBE_EVIDENCE_UNVERIFIED: '请重跑四角色探测（POST /api/native/probes）：旧收据绑定的是上一版 dist/server'
};

export function explainNativeReason(code: string): string {
    return REASONS[code] ?? '未分类原因：' + String(code).slice(0, 64);
}

// Product names, not wire ids: this sentence is read by a person. The id stays in the
// payload and in the reason codes, which is where an operator still needs it.
const ROLE_NAMES: Record<string, string> = {
    planner1: 'Seeker（Kimi 澄清）',
    planner2: 'Planner（独立 Codex 拆解）',
    executor: 'Executor（DSH + DeepSeek 执行）',
    reviewer: 'Reviewer（独立 Codex 复核）'
};

/** Which roles are missing a verifying receipt, and which already have one. */
function probeGateSentence(gate: NativeProbeGate | null | undefined): { missing: string[]; valid: string[]; text: string } | null {
    const roles = gate?.roles;
    if (!roles || typeof roles !== 'object') return null;
    const entries = Object.keys(roles);
    if (entries.length === 0) return null;
    const missing = entries.filter(r => roles[r]?.valid !== true);
    const valid = entries.filter(r => roles[r]?.valid === true);
    const name = (r: string) => ROLE_NAMES[r] ?? r;
    const parts: string[] = [];
    if (missing.length > 0) parts.push('待补：' + missing.map(name).join('、'));
    if (valid.length > 0) parts.push('已有效：' + valid.map(name).join('、'));
    return { missing, valid, text: parts.join('；') };
}

export function summarizeNativeReadiness(payload: NativeReadinessPayload | null | undefined): NativeReadinessSummary {
    const reasons = Array.isArray(payload?.reasons) ? payload!.reasons!.filter(r => typeof r === 'string') : [];
    if (payload?.ok === true)
        return { level: 'ok', headline: '实时执行可用', detail: '四角色 Live 的前置检查全部通过。', blockers: [], needsLogin: false, ownerActions: [] };
    if (reasons.length === 0)
        return { level: 'warn', headline: '实时执行状态未知', detail: '诊断没有给出具体原因；先跑一次本机诊断，不要按登录问题处理。', blockers: [], needsLogin: false, ownerActions: [] };
    const blockers = reasons.map(explainNativeReason);
    const ownerActions = [...new Set(reasons.map(r => OWNER_ACTIONS[r]).filter((v): v is string => typeof v === 'string'))];
    const gate = reasons.includes('NATIVE_REAL_PROBES_REQUIRED') ? probeGateSentence(payload?.probeGate) : null;
    const detail = blockers.join('；') + '。' + (gate?.text ? gate.text + '。' : '') +
        '这些是外部输入或审计缺口，与 Kimi 账号登录无关。';
    return { level: 'error', headline: `实时执行不可用（缺 ${blockers.length} 项）`, detail, blockers, needsLogin: false, ownerActions };
}
