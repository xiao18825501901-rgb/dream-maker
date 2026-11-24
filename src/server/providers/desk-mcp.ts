/**
 * Parent-side wiring for the DM desk_* MCP server.
 *
 * The Claude executor used to start the CLI with `--tools Read,Edit,Write,Bash` and an empty
 * `--strict-mcp-config`: the only evidence a turn could produce was process-level. This module
 * builds the other shape — the CLI keeps no built-in tools at all and its single MCP server is
 * the DM broker, so every model tool call is one audited desk_* dispatch.
 *
 * Two deliberate choices:
 *   - the broker binding travels in a 0600 config FILE, not in `--mcp-config <json>`, because
 *     argv is recorded in the process receipt and a bearer token must not be;
 *   - only the two read-only tools are exposed in this first cut. desk_write / desk_edit /
 *     desk_run still require the write-room, staging and kernel fences that the in-process
 *     broker path exercises, so they stay out until they are wired with the same care.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../security.js';

export const DESK_MCP_SERVER = 'dm';
/** Claude Code names a server tool `mcp__<server>__<tool>`; this is the exact allowlist. */
export const DESK_MCP_ALLOWED_TOOLS = 'mcp__dm__desk_read mcp__dm__desk_search';

export interface DeskMcpBinding { url: string; token: string }

function checkedBinding(binding: DeskMcpBinding): DeskMcpBinding {
    let endpoint: URL;
    try { endpoint = new URL(binding.url); } catch { throw new DomainError('DESK_MCP_BINDING_INVALID', 409); }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
        endpoint.pathname !== '/tools' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password)
        throw new DomainError('DESK_MCP_BINDING_INVALID', 409);
    if (!/^[a-f0-9]{32,256}$/.test(binding.token)) throw new DomainError('DESK_MCP_BINDING_INVALID', 409);
    return { url: endpoint.toString(), token: binding.token };
}

/** The compiled stdio server sits next to this module in dist/server/providers. */
export function deskMcpModulePath(moduleUrl: string = import.meta.url): string {
    const candidate = resolve(dirname(fileURLToPath(moduleUrl)), 'desk-mcp-stdio.js');
    if (!existsSync(candidate)) throw new DomainError('DESK_MCP_MODULE_MISSING', 500);
    return candidate;
}

/**
 * Write the MCP config the CLI will read. Returns the config path and the exact argv slice that
 * removes every built-in tool and allows only the two broker tools.
 */
export function writeDeskMcpConfig(input: {
    directory: string;
    binding: DeskMcpBinding;
    command: string;
    modulePath?: string;
}): { configPath: string; allowedTools: string } {
    if (!isAbsolute(input.directory) || !isAbsolute(input.command)) throw new DomainError('DESK_MCP_BINDING_INVALID', 409);
    const binding = checkedBinding(input.binding);
    const modulePath = input.modulePath ?? deskMcpModulePath();
    if (!isAbsolute(modulePath)) throw new DomainError('DESK_MCP_MODULE_MISSING', 500);
    mkdirSync(input.directory, { recursive: true });
    const configPath = resolve(input.directory, 'desk-mcp.json');
    const config = {
        mcpServers: {
            [DESK_MCP_SERVER]: {
                type: 'stdio',
                command: input.command,
                args: [modulePath],
                env: { DM_DESK_MCP_URL: binding.url, DM_DESK_MCP_TOKEN: binding.token },
            },
        },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    return { configPath, allowedTools: DESK_MCP_ALLOWED_TOOLS };
}
