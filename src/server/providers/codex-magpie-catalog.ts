import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { DomainError, hash } from '../security.js';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const BASE_INSTRUCTIONS = 'You are a Dream Maker controlled role. Follow the task and permissions supplied by Dream Maker; do not use tools unless explicitly authorized.';

/** The subscription gateway serves one reviewed model. Keep the catalog local so the
 * official CLI does not ask the Magpie gateway for an unrelated account model list. */
const CATALOG = Object.freeze({
    models: [{
        slug: 'gpt-6-luna',
        display_name: 'GPT-6-Luna',
        description: 'Fast and affordable model for easier tasks.',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
            { effort: 'low', description: 'Fast responses with lighter reasoning' },
            { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
            { effort: 'high', description: 'Greater reasoning depth for complex problems' },
            { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
            { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' }
        ],
        shell_type: 'unified_exec',
        visibility: 'list',
        supported_in_api: true,
        priority: 6,
        additional_speed_tiers: ['fast'],
        service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
        available_access_programs: { cyber: ['standard'] },
        availability_nux: null,
        upgrade: null,
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
        default_reasoning_summary: 'none',
        support_verbosity: true,
        default_verbosity: 'low',
        apply_patch_tool_type: 'freeform',
        web_search_tool_type: 'text_and_image',
        truncation_policy: { mode: 'tokens', limit: 10000 },
        supports_image_detail_original: true,
        context_window: 272000,
        max_context_window: 872000,
        comp_hash: '3000',
        effective_context_window_percent: 95,
        experimental_supported_tools: ['send_user_message_async', 'clock'],
        input_modalities: ['text', 'image'],
        supports_search_tool: true,
        supports_experimental_context: true,
        use_responses_lite: true,
        supports_reasoning_effort_updates: true,
        node_repl_auto_review_required: false,
        node_repl_disabled: false,
        tool_mode: 'code_mode_only',
        multi_agent_version: 'v2',
        base_instructions: BASE_INSTRUCTIONS
    }]
});

const fail = (code = 'CODEX_MODEL_CATALOG_INVALID'): never => { throw new DomainError(code, 409); };

export function codexSubscriptionModelCatalogJson(model: unknown): string {
    if (typeof model !== 'string' || !MODEL.test(model) || model !== 'gpt-6-luna') return fail();
    return JSON.stringify(CATALOG, null, 2) + '\n';
}

export interface CodexSubscriptionModelCatalog {
    path: string;
    model: string;
    sha256: string;
}

/** Write the tiny reviewed catalog into the already-created per-role context.
 * The file contains model capabilities and DM instructions only, never credentials. */
export function writeCodexSubscriptionModelCatalog(directory: unknown, model: unknown): CodexSubscriptionModelCatalog {
    if (typeof directory !== 'string' || !isAbsolute(directory) || typeof model !== 'string') return fail();
    const base = resolve(directory);
    const text = codexSubscriptionModelCatalogJson(model);
    const path = join(base, 'codex-model-catalog.json');
    if (!path.startsWith(base + sep)) return fail();
    mkdirSync(base, { recursive: true });
    let existing: string | undefined;
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) return fail();
        existing = readFileSync(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail();
    }
    if (existing !== undefined && existing !== text) return fail('CODEX_MODEL_CATALOG_CHANGED');
    if (existing === undefined) writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
    return { path, model, sha256: hash(text) };
}
