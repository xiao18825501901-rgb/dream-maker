import { DomainError, text, object, hasSecret } from './security.js';
import type { Question, Answer } from '../shared/types.js';

/** Model output is data: four unique labels, no fifth invented custom answer. */
export function questionChoices(options: unknown, allowMultiple: unknown): Pick<Question, 'options' | 'allowMultiple'> {
    if (!Array.isArray(options) || options.length !== 4)
        throw new DomainError('QUESTION_REQUIRES_FOUR_OPTIONS', 502);
    if (allowMultiple !== undefined && typeof allowMultiple !== 'boolean')
        throw new DomainError('INVALID_OPTION_MODE', 502);
    const parsed = options.map(raw => {
        const item = object(raw), id = text(item.id, 64), label = text(item.label, 800);
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || hasSecret(label))
            throw new DomainError('INVALID_QUESTION_OPTION', 502);
        return { id, label };
    });
    if (new Set(parsed.map(o=>o.id)).size !== 4 || new Set(parsed.map(o=>o.label)).size !== 4)
        throw new DomainError('DUPLICATE_OPTION', 502);
    return { options: parsed, allowMultiple: allowMultiple === true };
}

/** Keep chosen source labels and free text separate; old callers are free-text answers. */
export function answerChoices(q: Question, value: string, skip: boolean, rawIds: unknown = []): Pick<Answer, 'text' | 'optionIds' | 'customText' | 'source'> {
    if (!Array.isArray(rawIds) || rawIds.length > 4 || new Set(rawIds).size !== rawIds.length
        || rawIds.some(id => typeof id !== 'string' || !q.options?.some(o=>o.id === id)))
        throw new DomainError('INVALID_ANSWER_OPTIONS');
    const optionIds = rawIds as string[], customText = text(value, 8000, true);
    if (q.allowMultiple !== true && optionIds.length > 1) throw new DomainError('MULTIPLE_OPTIONS_NOT_ALLOWED');
    if (hasSecret(customText)) throw new DomainError('SECRET_IN_ANSWER');
    if (skip && (optionIds.length || customText)) throw new DomainError('SKIP_WITH_ANSWER');
    if (!skip && !optionIds.length && !customText) throw new DomainError('ANSWER_REQUIRED');
    const labels = optionIds.map(id=>q.options!.find(o=>o.id===id)!.label);
    return { text: [...labels, customText].filter(Boolean).join('\n'), optionIds: [...optionIds], customText,
        source: skip ? 'USER_SKIPPED' : optionIds.length ? customText ? 'USER_MIXED' : 'USER_OPTION_SELECTION' : 'USER_FREE_TEXT' };
}

const demoOptions: Record<string, string[]> = {
 goal:['先解决每天反复遇到的一件事','先让已有工作更省时间','先做一个能试用的最小版本','请按我的原始描述推荐第一步'],
 users:['先给我自己使用','先给家人或朋友试用','先给一个小团队使用','请按我的描述确定合适的使用者'],
 platform:['先在这台电脑上使用','先支持手机浏览器','先支持电脑浏览器','请按我的使用场景推荐'],
 workflow:['先完成记录和查看','先完成查找和整理','先完成输入到结果的整个过程','请按原始描述推荐核心操作'],
 data:['保存用户手动输入的内容','保存文件和整理结果','只保存完成核心功能必需的内容','请按原始描述推荐并标明假设'],
 quality:['不能丢失已保存内容','不能展示错误的结果','不能在未同意时产生费用','请按项目用途推荐最重要的检查'],
 visual:['简洁清楚，少量重点信息','文字清晰，方便快速查找','操作直观，常用按钮容易找到','请按实际使用者推荐'],
 risks:['只在本机使用，不公开发布','不自动付费或购买服务','敏感内容不发送到外部服务','请先遵守已有约束，再列出未知项'],
 scope:['先完成核心操作','先支持一种明确的使用场景','先验证能否解决主要问题','请按价值和可行性推荐第一版'],
 success:['重启后还能找到已保存内容','能独立完成一次主要操作','能用真实例子得到预期结果','请按原始目标设计验收步骤']
};
export function demoQuestionChoices(topic: string): Pick<Question, 'options' | 'allowMultiple'> {
    const labels = demoOptions[topic] ?? ['优先确保核心功能可用','优先保护现有内容','先用小范围场景验证','请结合已有回答推荐，并标明假设'];
    return questionChoices(labels.map((label,i)=>({ id: String.fromCharCode(65+i), label })), false);
}
