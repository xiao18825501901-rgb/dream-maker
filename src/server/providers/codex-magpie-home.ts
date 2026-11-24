import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DomainError } from '../security.js';
import { assertCodexMagpieConfig, codexMagpieToml, type CodexMagpieConfig } from './codex-magpie-config.js';

export interface CodexMagpieHome { dir: string; model: string; baseUrl: string; envKey: string }

const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const fail = (code = 'CODEX_MAGPIE_HOME_INVALID'): never => { throw new DomainError(code, 409); };

/**
 * A per-run Codex home owned by Dream Maker. The caller gets a directory whose only content is the
 * Magpie provider block, so the official CLI can be pointed at the DM loopback gateway without
 * reading, rewriting or depending on the user's own Codex profile.
 *
 * The run id is part of the path, so it is validated as a plain token; nothing here accepts an
 * absolute path, a parent reference or a caller-chosen directory.
 */
export function prepareCodexMagpieHome(root: string, runId: unknown, input: CodexMagpieConfig): CodexMagpieHome {
    if (typeof root !== 'string' || !root) return fail();
    if (typeof runId !== 'string' || !RUN.test(runId)) return fail();
    const base = resolve(root, '.runtime', 'custom-codex');
    const dir = resolve(base, runId);
    // Defence in depth: even a token-shaped id must not resolve outside the DM-owned base.
    if (!dir.startsWith(base + sep)) return fail();
    // Validate before creating anything: an invalid endpoint must leave no directory behind.
    const text = codexMagpieToml(input);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'config.toml');
    writeFileSync(file, text, { encoding: 'utf8' });
    const read = assertCodexMagpieConfig(readFileSync(file, 'utf8'));
    return { dir, model: read.model, baseUrl: read.baseUrl, envKey: read.envKey };
}
