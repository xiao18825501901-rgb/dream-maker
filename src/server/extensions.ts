import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash, within } from './security.js';

/**
 * User-installed skills and plugins.
 *
 * The product ships a pinned built-in catalog; this module is the *extension point* for anything the
 * user adds later. It reads two optional manifests from the instance data root:
 *
 *     <root>/.runtime/extensions/skills.json
 *     <root>/.runtime/extensions/plugins.json
 *
 * Each is `{ "schema": "dream-maker.extensions.v1", "skills"|"plugins": [entry, ...] }` with entries
 * `{ id, label, description?, appliesTo?: ["planner"|"executor"|"reviewer"|"seeker"], localPath?, sha256? }`.
 *
 * A manifest never widens authority: a path must stay inside the instance root and inside
 * `skills/` or `prompts/`; a bad entry is skipped and reported, never fatal. Nothing here dispatches.
 */
export type ExtensionRole = 'seeker' | 'planner' | 'executor' | 'reviewer';
export interface ExtensionEntry { id: string; label: string; description?: string; appliesTo: readonly ExtensionRole[]; localPath?: string; sha256?: string }
export interface ExtensionProblem { file: string; id?: string; reason: string }

const ALL_ROLES: readonly ExtensionRole[] = Object.freeze(['seeker', 'planner', 'executor', 'reviewer']);
const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const PATH = /^(skills|prompts)\/[a-z0-9-]+\.md$/;

function readManifest(root: string, name: 'skills' | 'plugins'): { entries: ExtensionEntry[]; problems: ExtensionProblem[] } {
    const file = resolve(root, '.runtime/extensions/' + name + '.json');
    const entries: ExtensionEntry[] = [], problems: ExtensionProblem[] = [];
    if (!existsSync(file)) return { entries, problems };
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); }
    catch { problems.push({ file, reason: '不是合法 JSON，整份清单被忽略' }); return { entries, problems }; }
    const box = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!box || box.schema !== 'dream-maker.extensions.v1') {
        problems.push({ file, reason: 'schema 必须是 dream-maker.extensions.v1' });
        return { entries, problems };
    }
    const list = Array.isArray(box[name]) ? box[name] as unknown[] : [];
    for (const item of list) {
        const row = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
        if (!row) { problems.push({ file, reason: '条目不是对象' }); continue; }
        const id = typeof row.id === 'string' ? row.id : '';
        if (!ID.test(id)) { problems.push({ file, id: id || undefined, reason: 'id 必须是 2-64 位小写字母/数字/连字符' }); continue; }
        const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim().slice(0, 80) : id;
        const declared = Array.isArray(row.appliesTo) ? row.appliesTo.filter((r): r is ExtensionRole => typeof r === 'string' && (ALL_ROLES as readonly string[]).includes(r)) : [];
        const appliesTo = declared.length ? declared : ALL_ROLES;
        let localPath: string | undefined;
        if (row.localPath !== undefined) {
            const p = typeof row.localPath === 'string' ? row.localPath : '';
            if (!PATH.test(p) || !existsSync(within(root, p))) { problems.push({ file, id, reason: 'localPath 必须是 root 内 skills/ 或 prompts/ 下的 .md' }); continue; }
            localPath = p;
        }
        entries.push({ id, label, description: typeof row.description === 'string' ? row.description.slice(0, 240) : undefined, appliesTo: Object.freeze(appliesTo), localPath, sha256: typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256) ? row.sha256 : undefined });
    }
    return { entries, problems };
}

/** Every user entry for one role, plus whatever the manifests could not accept. */
export function extensionCatalog(root: string, role: ExtensionRole, kind: 'skills' | 'plugins'): { entries: readonly ExtensionEntry[]; problems: readonly ExtensionProblem[] } {
    const { entries, problems } = readManifest(root, kind);
    return { entries: Object.freeze(entries.filter(e => e.appliesTo.includes(role))), problems: Object.freeze(problems) }
}

/**
 * The pinned body of one user skill. Returns null when the entry has no body, the file vanished, or
 * the recorded digest no longer matches — an edited file never runs silently.
 */
export function loadExtensionSkill(root: string, id: string): { id: string; content: string; sha256: string } | null {
    const { entries } = readManifest(root, 'skills');
    const entry = entries.find(e => e.id === id);
    if (!entry || !entry.localPath) return null;
    try {
        const content = readFileSync(within(root, entry.localPath), 'utf8');
        const digest = hash(content);
        if (entry.sha256 && entry.sha256 !== digest) return null;
        return { id, content, sha256: digest };
    } catch { return null; }
}
