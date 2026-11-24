import { loadSkill, type BuiltInSkill, BUILT_IN_SKILLS } from './skills.js';
import { loadExtensionSkill } from './extensions.js';
import { roleConfigurationHistory } from './role-configuration.js';
import type { Store } from './store.js';

/**
 * The skill text a role actually selected, ready to append to that role's prompt.
 *
 * Two sources, one document: pinned built-ins from skills/registry.json and user-installed entries
 * from .runtime/extensions/skills.json. Anything that cannot be loaded is skipped by name — a missing
 * or edited body never silently changes a dispatch, and it never breaks the turn either.
 */
export interface RoleSkillFragment { id: string; source: 'BUILT_IN' | 'USER'; content: string; sha256: string }

export function roleSkillFragments(root: string, store: Store, projectId: string, wireRole: string): readonly RoleSkillFragment[] {
    const revision = roleConfigurationHistory(store, projectId).at(-1);
    if (!revision) return Object.freeze([]);
    const stored = revision.roles?.[wireRole as keyof typeof revision.roles];
    const ids = stored?.skills ?? [];
    if (!ids.length) return Object.freeze([]);
    const out: RoleSkillFragment[] = [];
    for (const id of ids) {
        if ((BUILT_IN_SKILLS as readonly string[]).includes(id)) {
            try { const loaded = loadSkill(root, id as BuiltInSkill); out.push({ id, source: 'BUILT_IN', content: loaded.content, sha256: loaded.sha256 }); }
            catch { /* a pinned body that no longer matches its hash is dropped, not guessed */ }
            continue;
        }
        const user = loadExtensionSkill(root, id);
        if (user) out.push({ id, source: 'USER', content: user.content, sha256: user.sha256 });
    }
    return Object.freeze(out);
}

/** Rendered exactly once per role turn; empty string when the role has no skill selected. */
export function roleSkillBlock(root: string, store: Store, projectId: string, wireRole: string): string {
    const fragments = roleSkillFragments(root, store, projectId, wireRole);
    if (!fragments.length) return '';
    const parts = fragments.map(f => '\n\n<!-- skill:' + f.id + ' (' + f.source + ') -->\n' + f.content);
    return '\n\n# 已安装技能\n以下技能由本角色在项目配置中选择，按它们的流程与产物格式执行。' + parts.join('');
}
