import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DomainError, object, text, hash, within } from './security.js';
export type SkillId = 'grillme' | 'grill-me' | 'grilling' | 'prompt-optimizer' | 'find-skills';
/** Skills the product itself offers; the aliases above are historical names of the first. */
export const BUILT_IN_SKILLS = ['grillme', 'prompt-optimizer', 'find-skills'] as const;
export type BuiltInSkill = typeof BUILT_IN_SKILLS[number];
/**
 * Which roles may select a built-in skill. The interview skills belong to the Seeker; find-skills is
 * the one the three engineering roles share, so a role's picker shows only what it can actually use.
 */
export const SKILL_APPLIES_TO: Readonly<Record<BuiltInSkill, readonly ('seeker' | 'planner' | 'executor' | 'reviewer')[]>> = Object.freeze({
    grillme: Object.freeze(['seeker'] as const),
    'prompt-optimizer': Object.freeze(['seeker'] as const),
    'find-skills': Object.freeze(['planner', 'executor', 'reviewer'] as const)
});
export function skillsForRole(role: 'seeker' | 'planner' | 'executor' | 'reviewer'): readonly BuiltInSkill[] {
    return BUILT_IN_SKILLS.filter(id => SKILL_APPLIES_TO[id].includes(role));
}
/**
 * Why a planner1 (Seeker) request exists. The skill selection used to be `task === 'summary'`, and
 * no real dispatch ever sent that task: the complete-plan path sends `project_plan`, so it loaded
 * the interview skill and the optimizer body only ever appeared on a dead path. The purpose is now
 * a named contract between the caller and this module.
 */
export type SkillPurpose = 'interview_question' | 'requirements_draft' | 'plan_summary' | 'project_plan' | 'review_interpretation';
export const SKILL_PURPOSES: readonly SkillPurpose[] = ['interview_question', 'requirements_draft', 'plan_summary', 'project_plan', 'review_interpretation'];
export function purposeOfTask(task: unknown): SkillPurpose | null {
    if (task === 'question')
        return 'interview_question';
    if (task === 'requirements_draft')
        return 'requirements_draft';
    // The historical summary task is the optimizer's own request shape; it keeps loading the same
    // pinned body under its own purpose instead of falling through to no skill at all.
    if (task === 'summary')
        return 'plan_summary';
    if (task === 'project_plan')
        return 'project_plan';
    if (task === 'review_interpretation')
        return 'review_interpretation';
    return null;
}
/** grillme asks the questions; prompt-optimizer compiles the requirements draft and the plan. */
export function skillForPurpose(purpose: SkillPurpose | null): BuiltInSkill | null {
    if (purpose === 'interview_question')
        return 'grillme';
    if (purpose === 'requirements_draft' || purpose === 'plan_summary' || purpose === 'project_plan')
        return 'prompt-optimizer';
    return null;
}
/** Only controller-owned, pinned adaptations are eligible; task text cannot choose a path. */
export function loadSkill(root: string, name: SkillId): {
    content: string;
    sha256: string;
    mode: 'SOURCE_ADAPTED';
} {
    const registry = object(JSON.parse(readFileSync(resolve(root, 'skills/registry.json'), 'utf8')));
    if (registry.schema !== 'dream-maker.skills.v1' || !Array.isArray(registry.skills))
        throw new DomainError('SKILL_REGISTRY_INVALID', 500);
    const entry = registry.skills.map(object).find(s => s.id === name);
    if (!entry || entry.mode !== 'SOURCE_ADAPTED')
        throw new DomainError('SKILL_NOT_ALLOWLISTED', 500);
    const path = text(entry.localPath, 200);
    if (!/^(skills|prompts)\/[a-z0-9-]+\.md$/.test(path))
        throw new DomainError('SKILL_PATH_DENIED', 500);
    const content = readFileSync(within(root, path), 'utf8'), digest = hash(content);
    if (digest !== entry.sha256)
        throw new DomainError('SKILL_SNAPSHOT_CHANGED', 409, '技能适配文件已改变；先更新评测和显式版本清单，不能静默加载新指令。');
    return { content, sha256: digest, mode: 'SOURCE_ADAPTED' };
}
/** Resolve the pinned body a purpose requires, with the registry hash that proves which bytes ran. */
export function skillForRequest(root: string, purpose: SkillPurpose | null): { id: BuiltInSkill; content: string; sha256: string; purpose: SkillPurpose } | null {
    const id = skillForPurpose(purpose);
    if (!id || !purpose)
        return null;
    const loaded = loadSkill(root, id);
    return { id, content: loaded.content, sha256: loaded.sha256, purpose };
}
