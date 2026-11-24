import { isAbsolute } from 'node:path';
import { DomainError } from '../security.js';

/**
 * Codex CLI config for the DM-owned loopback admission gateway.
 *
 * The subscription runner cannot be reused here: it requires an included-quota reading and an
 * account fingerprint, neither of which exists on an API-key route. What both modes share is the
 * CLI itself, so this module only produces the exact provider block the CLI needs and refuses
 * anything that would widen it (non-loopback base URL, foreign provider id, unknown wire API).
 */
export interface CodexMagpieConfig {
    authentication?: 'chatgpt';
    model: string;
    /** `http://127.0.0.1:<port>/v1` as returned by the gateway's start(). */
    baseUrl: string;
    /** Environment variable holding the gateway's per-run token. Never the token itself. */
    envKey: string;
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const fail = (code = 'CODEX_MAGPIE_CONFIG_INVALID'): never => { throw new DomainError(code, 409); };

function loopbackUrl(value: unknown, path: string): string {
    if (typeof value !== 'string') return fail();
    let url: URL;
    try { url = new URL(value); } catch { return fail(); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return fail();
    if (url.username || url.password || url.search || url.hash || url.pathname !== path) return fail();
    return url.origin + path;
}

export function codexMagpieToml(input: CodexMagpieConfig): string {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
    const keys = ['model', 'baseUrl', 'envKey'];
    const subscription = Object.hasOwn(input, 'authentication');
    if (subscription) {
        if (input.authentication !== 'chatgpt' || input.envKey !== 'DM_GATEWAY_TOKEN') return fail();
        keys.push('authentication');
    }
    if (Reflect.ownKeys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key))) return fail();
    if (typeof input.model !== 'string' || !MODEL.test(input.model) || input.model.includes('://')) return fail();
    if (typeof input.envKey !== 'string' || !ENV.test(input.envKey)) return fail();
    const baseUrl = loopbackUrl(input.baseUrl, subscription ? '/backend-api/codex' : '/v1');
    return [
        `model = ${JSON.stringify(input.model)}`,
        'model_provider = "magpie"',
        '',
        '[model_providers.magpie]',
        'name = "Dream Maker Magpie"',
        `base_url = ${JSON.stringify(baseUrl)}`,
        ...(subscription ? [
            'requires_openai_auth = true',
            'env_http_headers = { "X-DM-Gateway" = "DM_GATEWAY_TOKEN" }',
        ] : [`env_key = ${JSON.stringify(input.envKey)}`]),
        // The pinned CLI 0.162.0 removed the chat wire for custom providers:
        // `wire_api = "chat"` now aborts thread/start with -32600. The DM
        // gateway therefore serves the Responses wire and translates upstream.
        'wire_api = "responses"',
        '',
    ].join('\n');
}

/** Process-local provider overrides keep the signed-in DM home untouched. The
 * gateway credential is an environment reference, never a value on argv. */
export function codexSubscriptionGatewayArgs(model: string, baseUrl: string, modelCatalogPath?: string): string[] {
    const config: CodexMagpieConfig = {model, baseUrl, authentication:'chatgpt', envKey:'DM_GATEWAY_TOKEN'};
    const lines = codexMagpieToml(config).trim().split('\n');
    const args: string[] = [];
    let prefix = '';
    for (const line of lines) {
        if (!line) continue;
        if (line === '[model_providers.magpie]') {
            prefix = 'model_providers.magpie.';
            continue;
        }
        args.push('-c', prefix + line.replace(' = ', '='));
    }
    if (modelCatalogPath !== undefined) {
        if (!isAbsolute(modelCatalogPath) || modelCatalogPath.includes('\0') || /[\r\n]/.test(modelCatalogPath)) return fail();
        args.push('-c', 'model_catalog_json=' + JSON.stringify(modelCatalogPath));
    }
    return args;
}
/** Read back exactly what codexMagpieToml produced. Any extra key or value drift is refused. */
export function assertCodexMagpieConfig(text: string): CodexMagpieConfig & { wireApi: 'responses' } {
    if (typeof text !== 'string' || text.length > 4096) return fail();
    const lines = text.split('\n').filter(line => line.trim() !== '');
    if (lines.length !== 7 && lines.length !== 8) return fail();
    const value = (line: string, key: string): string => {
        const prefix = key + ' = ';
        if (!line.startsWith(prefix)) return fail();
        try { return JSON.parse(line.slice(prefix.length)); } catch { return fail(); }
    };
    const model = value(lines[0], 'model');
    if (lines[1] !== 'model_provider = "magpie"') return fail();
    if (lines[2] !== '[model_providers.magpie]') return fail();
    if (lines[3] !== 'name = "Dream Maker Magpie"') return fail();
    const baseUrl = value(lines[4], 'base_url');
    const subscription = lines.length === 8;
    const config: CodexMagpieConfig = subscription
        ? {model, baseUrl, envKey: 'DM_GATEWAY_TOKEN', authentication: 'chatgpt'}
        : {model, baseUrl, envKey: value(lines[5], 'env_key')};
    const expected = codexMagpieToml(config).split('\n').filter(Boolean);
    if (!lines.every((line, index) => line === expected[index])) return fail();
    return {...config, wireApi: 'responses'};
}
