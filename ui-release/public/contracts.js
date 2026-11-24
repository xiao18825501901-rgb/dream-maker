export function semanticRows(spec) {
    const used = new Set((spec.acceptanceItems ?? []).map(item => item.id));
    let sequence = 1;
    return spec.requirements.map(requirement => {
        const existing = spec.acceptanceItems?.find(item => item.requirementIds.length === 1 && item.requirementIds[0] === requirement.id);
        if (existing)
            return { requirement, item: { id: existing.id, criterion: existing.criterion } };
        while (used.has('A' + sequence))
            sequence++;
        const id = 'A' + sequence++;
        used.add(id);
        return { requirement, item: { id, criterion: '' } };
    });
}
export function semanticPayload(spec, value, confirmed) {
    const rows = semanticRows(spec), editedIds = new Set(rows.map(row => row.item.id));
    const acceptanceItems = (spec.acceptanceItems ?? []).filter(item => !editedIds.has(item.id))
        .map(({ id, requirementIds, criterion, method }) => ({ id, requirementIds: [...requirementIds], criterion, method }));
    for (const { requirement, item } of rows) {
        const criterion = value('criterion-' + requirement.id).trim();
        if (criterion)
            acceptanceItems.push({ id: item.id, requirementIds: [requirement.id], criterion, method: 'manual' });
    }
    return { specHash: spec.hash, confirmed, requirements: spec.requirements.map(r => ({ id: r.id, kind: value('kind-' + r.id), priority: value('priority-' + r.id) })), acceptanceItems };
}
export class UiError extends Error {
    code;
    status;
    constructor(code, message, status = 0) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = 'UiError';
    }
}
export const labels = {
    DRAFT: '未开始', INTERVIEWING: '等待回答', AWAITING_INTERVIEW_DECISION: '等待你的选择', SPEC_REVIEW: '待确认规格', READY_TO_BUILD: '规格已确认',
    PLANNING: '制定工程计划', IMPLEMENTING: '执行制作', VERIFYING: '运行验证', REVIEWING: '独立审查', REPAIRING: '返修中',
    PAUSE_REQUESTED: '已请求暂停 · 等待检查点', PAUSED: '已暂停', CANCEL_REQUESTED: '已请求取消 · 等待清理', CANCELLED: '已取消',
    BLOCKED: '需要处理', FAILED: '运行失败', PARTIAL: '部分完成', READY_FOR_DELIVERY: '待验收', ACCEPTED: '已接受成果'
};
export const roleNames = { planner1: '需求澄清', planner2: '工程规划', executor: '执行制作', reviewer: '独立审查' };
export function label(state) { return labels[state] ?? state; }
export function activeRole(state) {
    return { INTERVIEWING: 'planner1', PLANNING: 'planner2', IMPLEMENTING: 'executor', REPAIRING: 'executor', REVIEWING: 'reviewer' }[state] ?? null;
}
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function runTone(state) { return ['FAILED', 'BLOCKED'].includes(state) ? 'danger' : ['ACCEPTED', 'READY_FOR_DELIVERY'].includes(state) ? 'success' : ['PAUSED', 'PAUSE_REQUESTED', 'REPAIRING', 'PARTIAL', 'AWAITING_INTERVIEW_DECISION', 'CANCEL_REQUESTED'].includes(state) ? 'warning' : 'neutral'; }
/** Opaque request/UI identifier; fallback uses CSPRNG, never timestamps or Math.random. */
export function newId() {
    if (typeof crypto.randomUUID === 'function')
        return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const h = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
