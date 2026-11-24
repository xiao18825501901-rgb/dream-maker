/**
 * A07: turn the read-only Kimi status payload into one honest sentence for the UI.
 *
 * The rule that matters: "not allowed to reason" must not be rendered as "please log in again".
 * Only a MISSING or REVOKED credential may say that; an unproven Extra Usage, a damaged store or a
 * pending restore each get their own wording, because telling the owner to log in again is exactly
 * the false alarm this project is trying to remove.
 *
 * Pure string building — no DOM, no fetch — so the wording is testable.
 */
export interface KimiStatusPayload {
    admission?: { state?: string; allowsSend?: boolean; reason?: string } | null;
    credentials?: { barrier?: string; state?: string; generation?: number | null; reason?: string | null; expiresAt?: number | null } | null;
    inferenceAllowed?: boolean;
    note?: string;
    /** A classified runtime auth failure: the durable record can still say OK after the server refused us. */
    lastAuthFailure?: { class?: string; layer?: string; code?: string; atMs?: number } | null;
}

export interface KimiStatusSummary {
    level: 'ok' | 'warn' | 'error';
    headline: string;
    detail: string;
    /** True only when a human really has to authorise again. */
    needsLogin: boolean;
}

const zh = {
    ok: '可以推理',
    missing: '尚未登录',
    revoked: '凭据已被撤销',
    corrupt: '已保存的凭据损坏',
    unreadable: '凭据存储暂时无法读取',
    restore: '凭据尚未完成恢复',
    extraUnknown: 'Extra Usage 状态未确认，推理已停止',
    extraOn: 'Extra Usage 已开启，未获授权，推理已停止',
    extraExpired: 'Extra Usage 证据已过期，推理已停止',
    noAdmission: 'Extra Usage 门禁未装配，推理已停止',
    noCredential: '凭据权威未装配',
    grantRejected: '服务端已拒绝当前凭据（L3）',
    hintMissing: '需要本人完成一次官方设备登录。',
    hintRevoked: '需要本人重新授权；不要用旧 refresh 反复重试。',
    hintCorrupt: '先检查存储与恢复流程；不要清空记录，也不要重登。',
    hintUnreadable: '读取失败（文件被占用、权限或句柄问题）；这不是"未登录"，也不是"凭据损坏"，稍后重试或检查存储目录。',
    hintRestore: '等待启动恢复完成；这不是登录失效。',
    hintExtra: '在官方订阅页确认 Extra Usage 关闭后，写入证据即可恢复；与登录无关。',
    hintOk: '推理仍受预算与审批门禁约束。',
    hintGrantRejected: '这是运行时观察到的拒绝，不是"很久没登录"；需要本人重新授权一次。'
};

export function summarizeKimiStatus(payload: KimiStatusPayload): KimiStatusSummary {
    const credentials = payload.credentials ?? null;
    const admission = payload.admission ?? null;
    const state = credentials?.state ?? null;
    const barrier = credentials?.barrier ?? null;
    const extra = admission?.state ?? null;
    const extraAllows = admission?.allowsSend === true;

    if (state === 'CORRUPT') {
        // A transient read failure is NOT damage. Calling it "the saved credential is corrupt" would
        // send the owner looking for a problem that may not exist — and it is not a login issue either.
        if (String(credentials?.reason ?? '') === 'READ_FAILED')
            return { level: 'warn', headline: zh.unreadable, detail: zh.hintUnreadable, needsLogin: false };
        return { level: 'error', headline: zh.corrupt, detail: zh.hintCorrupt, needsLogin: false };
    }
    if (state === 'REVOKED')
        return { level: 'error', headline: zh.revoked, detail: zh.hintRevoked, needsLogin: true };
    if (extra === 'ON')
        return { level: 'error', headline: zh.extraOn, detail: zh.hintExtra, needsLogin: false };
    if (admission === null)
        return { level: 'warn', headline: zh.noAdmission, detail: zh.hintExtra, needsLogin: false };
    if (extraAllows !== true) {
        const expired = String(admission?.reason ?? '') === 'KIMI_EXTRA_USAGE_EVIDENCE_EXPIRED';
        return { level: 'warn', headline: expired ? zh.extraExpired : zh.extraUnknown, detail: zh.hintExtra, needsLogin: false };
    }
    if (credentials === null)
        return { level: 'warn', headline: zh.noCredential, detail: zh.hintRestore, needsLogin: false };
    if (barrier !== 'READY')
        return { level: 'warn', headline: zh.restore, detail: zh.hintRestore, needsLogin: false };
    if (state === 'MISSING')
        return { level: 'warn', headline: zh.missing, detail: zh.hintMissing, needsLogin: true };
    // A proven rejection beats the record: the token may still be on disk, but the server refused it.
    const failure = payload.lastAuthFailure ?? null;
    if (payload.note === 'KIMI_GRANT_REJECTED_AT_RUNTIME' || (failure?.class === 'REAUTH_REQUIRED' && failure?.layer === 'L3_OAUTH'))
        return { level: 'error', headline: zh.grantRejected, detail: zh.hintGrantRejected, needsLogin: true };
    if (payload.inferenceAllowed === true) {
        // An unproven failure is mentioned, never turned into a verdict or a login demand.
        const extra = failure && typeof failure.class === 'string'
            ? '最近一次认证失败记为 ' + failure.class + '（' + String(failure.layer ?? '') + '），未要求重登。'
            : '';
        return { level: 'ok', headline: zh.ok, detail: extra === '' ? zh.hintOk : zh.hintOk + extra, needsLogin: false };
    }
    return { level: 'warn', headline: zh.restore, detail: zh.hintRestore, needsLogin: false };
}
/**
 * C03/C04: one honest sentence about the trusted channel, from the diagnostics `bridge` block.
 *
 * The distinction that matters: "a rotation was ACKed" is proof that durable credentials survived a
 * real refresh, while "a rotation is newer than the last ACK" is exactly the uncertain-commit case.
 * Neither may be presented as a login problem.
 */
export interface BridgeDurabilityPayload {
    topology?: string;
    running?: boolean;
    error?: string | null;
    frames?: {
        frames?: number;
        counts?: Record<string, number>;
        lastRotateGeneration?: number | null;
        lastAckGeneration?: number | null;
        lastErrorCode?: string | null;
        closed?: boolean;
        /** True once at least one frame arrived FROM the peer. */
        established?: boolean;
    } | null;
}

export function summarizeBridgeDurability(payload: BridgeDurabilityPayload | null | undefined): KimiStatusSummary {
    const bridge = payload ?? null;
    const topology = bridge?.topology ?? 'off';
    const frames = bridge?.frames ?? null;
    const ack = frames?.lastAckGeneration ?? null;
    const rotate = frames?.lastRotateGeneration ?? null;
    if (bridge === null || topology === 'off') return { level: 'warn', headline: '受信通道未启用（默认）', detail: '需要 DM_KIMI_BRIDGE=1 才会建立通道；这不是登录问题。', needsLogin: false };
    if (bridge.error && String(bridge.error).startsWith('KIMI_BRIDGE_EXITED')) {
        const why = String(bridge.error).slice('KIMI_BRIDGE_EXITED'.length + 1);
        return {
            level: 'warn',
            headline: why === '' ? '通道进程已退出' : `通道进程已退出（${why}）`,
            detail: '桥没有连上或中途断开；重启桥即可，不需要重新登录。',
            needsLogin: false
        };
    }
    if (bridge.error) return { level: 'error', headline: '受信通道启动失败：' + bridge.error, detail: '凭据与推理状态不受影响；先修配置，不要重登。', needsLogin: false };
    if (bridge.running !== true) return { level: 'warn', headline: '受信通道未建立', detail: '进程未运行；重启本机服务即可，不需要重新授权。', needsLogin: false };

    if (frames?.lastErrorCode) return { level: 'error', headline: '通道报告错误 ' + frames.lastErrorCode, detail: '上一次提交未被确认；按错误码处理，不要用旧 refresh 重试。', needsLogin: false };
    if (frames?.closed) return { level: 'warn', headline: '通道已关闭', detail: '关闭后不再有轮转；重新建立通道即可。', needsLogin: false };
    // A rotation we saw but never acknowledged is THE uncertain state — including the case where no
    // ACK has ever arrived (ack === null). Reporting that as "no confirmed rotation yet" would hide
    // exactly what the ledger exists to show.
    if (rotate !== null && (ack === null || rotate > ack))
        return {
            level: 'warn',
            headline: ack === null ? `轮转 gen ${rotate} 尚未确认` : `轮转 gen ${rotate} 尚未确认（已确认到 gen ${ack}）`,
            detail: '持久化结果未知：先对账，不重发刷新、不重登。', needsLogin: false
        };
    if (ack !== null) return { level: 'ok', headline: `已确认轮转 gen ${ack}`, detail: '持久凭据在真实刷新后仍然有效。', needsLogin: false };

    // Nothing has happened yet. Say which of the two states this is: the peer speaks only when a
    // rotation occurs, so "no inbound frame yet" is normal right after startup — but it must not be
    // dressed up as "the channel is healthy and talking".
    const via = topology === 'connector' ? '连接器' : '自启';
    if (frames?.established === true)
        return { level: 'warn', headline: `通道已建立（${via}），尚无已确认轮转`, detail: '已收到对端帧但还没有轮转被确认；还没有发生刷新，属于正常状态。', needsLogin: false };
    return { level: 'ok', headline: `通道已启动（${via}），尚未收到对端帧`, detail: '握手（HELLO/RESTORE）已发出；桥只在发生轮转时才会回帧，所以这是启动后的正常状态。若长时间无任何活动，重启桥即可，不需要重新登录。', needsLogin: false };
}
