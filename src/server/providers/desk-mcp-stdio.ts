/**
 * The DM desk_* MCP server, as a stdio child of a Custom Executor CLI.
 *
 * WHY THIS EXISTS. Claude Code (and the other three CLIs) run their own Bash/Write/Edit inside
 * their own process, so the product cannot see an individual call and a Custom Executor turn
 * could only ever produce PROCESS-level evidence. When the CLI is instead started with its
 * built-in tools removed and this server as its only MCP server, every tool call the model makes
 * arrives here as one JSON-RPC tools/call, is forwarded to the already-audited DM tool broker,
 * and therefore lands in the journal as exactly one ToolIntent plus one ToolResult.
 *
 * The forward is deliberately dumb: this process holds no scope rules, no allowlists and no
 * fallback. The broker revalidates the caller, the run phase, the approvals and the prework
 * scope on every call, so a compromise of this child cannot widen the executor's authority.
 *
 * Stdout is the protocol stream and carries JSON-RPC only. Diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';

export const DESK_MCP_TOOLS = ['desk_read', 'desk_search'] as const;
const DEFAULT_PROTOCOL = '2024-11-05';
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const CALL_TIMEOUT_MS = 600000;

const TOOL_SCHEMA: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {
    desk_read: {
        description: 'Read one file from the run workspace. Returns its content and SHA-256; the path must be a declared source file of this task.',
        properties: { path: { type: 'string', description: 'Workspace-relative path of a declared source file.' } },
        required: ['path'],
    },
    desk_search: {
        description: 'Search the declared source files of this task for a literal string. Returns path, line and text for up to 200 matches.',
        properties: { text: { type: 'string', description: 'Literal text to find.' } },
        required: ['text'],
    },
};

export function deskMcpTools() {
    return DESK_MCP_TOOLS.map(name => ({
        name,
        description: TOOL_SCHEMA[name].description,
        inputSchema: { type: 'object', properties: TOOL_SCHEMA[name].properties, required: TOOL_SCHEMA[name].required, additionalProperties: false },
    }));
}

export interface DeskMcpBinding { url: string; token: string }

/** The binding is env-only: a bearer token in argv would land in the process receipt. */
export function readDeskMcpBinding(env: NodeJS.ProcessEnv = process.env): DeskMcpBinding | undefined {
    const raw = env.DM_DESK_MCP_URL, token = env.DM_DESK_MCP_TOKEN;
    if (typeof raw !== 'string' || typeof token !== 'string') return undefined;
    let endpoint: URL;
    try { endpoint = new URL(raw); } catch { return undefined; }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/tools' ||
        endpoint.search || endpoint.hash || endpoint.username || endpoint.password) return undefined;
    if (!/^[a-f0-9]{32,256}$/.test(token)) return undefined;
    return { url: endpoint.toString(), token };
}

async function callBroker(binding: DeskMcpBinding, name: string, args: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(binding.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + binding.token },
        body: JSON.stringify({ name, args }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status !== 200) {
        // The broker's own refusal code is the evidence: keep it verbatim, do not paraphrase.
        const code = typeof body.error === 'string' ? body.error : 'DESK_MCP_BROKER_' + response.status;
        throw Object.assign(new Error(code), { code });
    }
    return body;
}

export function serveDeskMcp(input: {
    binding: DeskMcpBinding;
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
}): Promise<void> {
    const stdout = input.stdout ?? process.stdout;
    const send = (message: unknown) => { stdout.write(JSON.stringify(message) + '\n'); };
    const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
    const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });
    const pending = new Set<Promise<void>>();
    return new Promise<void>(done => {
        const lines = createInterface({ input: input.stdin ?? process.stdin, crlfDelay: Infinity });
        let closed = false;
        const settle = () => { if (closed && pending.size === 0) done(); };
        lines.on('line', line => {
            if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) return;
            let message: Record<string, unknown>;
            try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
            const method = message.method, id = message.id;
            if (typeof method !== 'string') return;            // a response from the client: nothing to do
            if (id === undefined) return;                       // a notification: no reply is permitted
            if (method === 'initialize') {
                const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
                const requested = params.protocolVersion;
                reply(id, {
                    protocolVersion: typeof requested === 'string' && requested ? requested : DEFAULT_PROTOCOL,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'dream-maker-desk', version: '1' },
                });
                return;
            }
            if (method === 'ping') { reply(id, {}); return; }
            if (method === 'tools/list') { reply(id, { tools: deskMcpTools() }); return; }
            if (method !== 'tools/call') { fail(id, -32601, 'METHOD_NOT_FOUND: ' + method); return; }
            const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
            const name = typeof params.name === 'string' ? params.name : '';
            if (!DESK_MCP_TOOLS.includes(name as typeof DESK_MCP_TOOLS[number])) { fail(id, -32602, 'DESK_MCP_TOOL_UNKNOWN: ' + name); return; }
            const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
            const work: Promise<void> = callBroker(input.binding, name, args)
                .then(result => reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }))
                .catch((error: unknown) => {
                    const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? String((error as { code: string }).code) : 'DESK_MCP_BROKER_FAILED';
                    // An MCP tool error keeps the broker's code as the visible text so the model can
                    // correct its own call instead of retrying blind; the journal already has the result.
                    reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], isError: true });
                })
                .finally(() => { pending.delete(work); settle(); });
            pending.add(work);
        });
        lines.on('close', () => { closed = true; settle(); });
    });
}

export function isDeskMcpEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
    if (!argv1) return false;
    return argv1.replace(/\\/g, '/').endsWith('/desk-mcp-stdio.js') || moduleUrl === new URL('file:///' + argv1.replace(/\\/g, '/').replace(/^\//, '')).href;
}

if (isDeskMcpEntryPoint(process.argv[1], import.meta.url)) {
    const binding = readDeskMcpBinding();
    if (!binding) { process.stderr.write('DESK_MCP_BINDING_INVALID\n'); process.exit(2); }
    else void serveDeskMcp({ binding }).then(() => process.exit(0), () => process.exit(1));
}
