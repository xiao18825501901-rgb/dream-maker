import {mkdirSync,mkdtempSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {isAbsolute,join,relative,sep} from 'node:path';
import {capture} from '../process.js';
import {childEnv,DomainError,hash,object} from '../security.js';
import {validOfficialCliModelId,verifiedClaudeCommand,type ClaudeCommandRef} from './claude-supervisor.js';
import {writeDeskMcpConfig,type DeskMcpBinding} from './desk-mcp.js';

/**
 * The executor arm of the installed Claude Code CLI.
 *
 * AUDIT BOUNDARY, stated plainly. This turn's tool calls are the CLI's OWN built-in tools,
 * not the DM broker's desk_* intents: the product cannot intercept an individual Write or
 * Bash call, so nothing here may be read as per-call approval. What this module can and does
 * report is PROCESS-LEVEL evidence only:
 *   - the exact argv and cwd the CLI ran with,
 *   - its exit code,
 *   - how many tool_use / tool_result blocks its own stream carried, and how many of those
 *     results were refusals,
 *   - and a before/after SHA-256 of every workspace file it changed (a diff summary).
 * The DSH and Pi executors produce a desk_* intent per call with its own scope check, its own
 * recorded result and its own replayable spec hash. A Claude executor turn without a broker
 * binding produces one process receipt instead; the two must never be compared as if they were
 * the same evidence.
 *
 * PER-CALL MODE (opt in with `mcp`). The CLI is started with `--tools ''` — every built-in
 * tool removed, which the CLI enforces rather than merely hides: a tool_use naming Write is
 * answered "No such tool available" — and with one MCP server (providers/desk-mcp.ts) whose
 * only tools are desk_read and desk_search. That server forwards each call to the DM tool
 * broker, which is the SAME audited dispatch the in-process runtimes use, so each model call
 * becomes exactly one ToolIntent plus one ToolResult. The process-level receipt below is still
 * emitted in this mode; it is additional evidence, not a substitute for the per-call rows.
 *
 * The workspace fence is two independent layers, not one: the CLI refuses a path outside its
 * allowed working directories by itself, and the process is started with cwd inside the flows
 * workspace while --add-dir names only that workspace. git push and the network-install
 * commands are refused by --disallowedTools, so the refusal happens before any child of the
 * tool runs rather than by inspecting output afterwards.
 */
export const CLAUDE_EXECUTOR_TOOLS = ['Read','Edit','Write','Bash'] as const;
export const CLAUDE_EXECUTOR_DENY = 'WebFetch WebSearch Bash(git push:*) Bash(npm install:*) Bash(npm i:*) Bash(pnpm:*) Bash(yarn:*) Bash(pip install:*) Bash(pip3 install:*)';
const MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_FILES = 4000, MAX_STDOUT = 8 * 1024 * 1024;

export interface ClaudeExecutorInput {
    commandRef: ClaudeCommandRef;
    controllerRoot: string;
    workspace: string;
    gatewayUrl: string;
    gatewayToken: string;
    model: string;
    prompt: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxOutputTokens: number;
    assertCurrent(): void;
    /** Present only when the DM tool broker is live for this run; see PER-CALL MODE above. */
    mcp?: DeskMcpBinding;
}

export interface ClaudeExecutorFileChange {path:string;bytes:number;sha256:string}

export interface ClaudeExecutorObservation {
    sessionId:string; text:string; model:string;
    /** Model responses the CLI consumed; each one is one upstream request for this turn. One
     *  response can carry several tool_use blocks and the CLI reports one assistant frame per block
     *  group, so the response count is the number of distinct message ids; assistantTurns keeps that
     *  raw frame count for the audit record. Receipts are matched against modelResponses. */
    modelResponses:number; assistantTurns:number; toolUses:number; toolResults:number; deniedToolResults:number;
    /** True when the turn ran with no built-in tools and the DM broker as its only MCP server. */
    perCallAudit:boolean;
    exitCode:number; commandLine:readonly string[]; cwd:string;
    fileChanges:readonly ClaudeExecutorFileChange[];
}

const deny = (): never => {throw new DomainError('CLAUDE_EXECUTOR_UNVERIFIED', 409);};

function inside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

/** Bounded workspace digest: no symlinks followed, no file over the cap read twice. */
function snapshot(root: string): Map<string, ClaudeExecutorFileChange> {
    const seen = new Map<string, ClaudeExecutorFileChange>();
    const walk = (dir: string) => {
        if (seen.size >= MAX_FILES) return;
        for (const entry of readdirSync(dir, {withFileTypes: true})) {
            if (seen.size >= MAX_FILES) return;
            if (entry.isSymbolicLink()) continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.runtime') continue;
                walk(path);
                continue;
            }
            if (!entry.isFile()) continue;
            const key = relative(root, path), size = statSync(path).size;
            if (size > MAX_FILE_BYTES) {seen.set(key, {path: key, bytes: size, sha256: 'SKIPPED_TOO_LARGE'}); continue;}
            const bytes = readFileSync(path);
            seen.set(key, {path: key, bytes: bytes.length, sha256: hash(bytes)});
        }
    };
    walk(root);
    return seen;
}

function changedBeforeAfter(before: Map<string, ClaudeExecutorFileChange>, after: Map<string, ClaudeExecutorFileChange>): ClaudeExecutorFileChange[] {
    const rows: ClaudeExecutorFileChange[] = [];
    for (const [path, row] of after) {
        const old = before.get(path);
        if (!old || old.sha256 !== row.sha256 || old.bytes !== row.bytes) rows.push(row);
    }
    for (const [path] of before) if (!after.has(path)) rows.push({path, bytes: 0, sha256: 'DELETED'});
    return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/** stream-json is the only evidence stream: one JSON object per line, never prose. */
function readStream(stdout: string) {
    let assistantTurns = 0, toolUses = 0, toolResults = 0, deniedToolResults = 0;
    let sessionId: string | undefined, text = '', observedModel: string | undefined, failed = false;
    const messageIds = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try { row = object(JSON.parse(line)); } catch { return undefined; }
        if (row.type === 'assistant') {
            const message = object(row.message), content = message.content;
            if (!Array.isArray(content)) return undefined;
            assistantTurns += 1;
            if (typeof message.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(message.id)) messageIds.add(message.id);
            if (typeof message.model === 'string') observedModel = message.model;
            for (const raw of content) {
                const block = object(raw);
                if (block.type === 'tool_use') toolUses += 1;
                if (block.type === 'tool_result') {toolResults += 1; if (block.is_error === true) deniedToolResults += 1;}
            }
            continue;
        }
        if (row.type === 'user') {
            const content = object(row.message).content;
            if (!Array.isArray(content)) continue;
            for (const raw of content) {
                const block = object(raw);
                if (block.type === 'tool_result') {toolResults += 1; if (block.is_error === true) deniedToolResults += 1;}
            }
            continue;
        }
        if (row.type === 'result') {
            if (typeof row.session_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.session_id)) return undefined;
            sessionId = row.session_id;
            if (row.is_error === true || row.subtype !== 'success') failed = true;
            if (typeof row.result === 'string') text = row.result;
            const usage = row.modelUsage;
            if (usage && typeof usage === 'object') {
                const ids = Object.keys(usage as Record<string, unknown>);
                if (ids.length === 1) observedModel = ids[0];
            }
        }
    }
    if (!sessionId || failed) return undefined;
    return {sessionId, text, observedModel, modelResponses: messageIds.size || assistantTurns, assistantTurns, toolUses, toolResults, deniedToolResults};
}

export async function runClaudeExecutorTurn(input: ClaudeExecutorInput): Promise<ClaudeExecutorObservation> {
    const stillCurrent = () => {const result: unknown = input.assertCurrent(); if (result !== undefined) deny();};
    input.signal.throwIfAborted(); stillCurrent();
    if (!isAbsolute(input.controllerRoot) || !isAbsolute(input.workspace) || !inside(input.controllerRoot, input.workspace)) return deny();
    let endpoint: URL;
    try { endpoint = new URL(input.gatewayUrl); } catch { return deny(); }
    // The owned gateway advertises its base URL with the '/v1' prefix the CLI then appends its own
    // '/v1/messages' path to; both spellings name the same loopback origin, and the flag-carrying
    // query string the CLI adds is never part of this URL. Anything else is refused.
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
        (endpoint.pathname !== '/' && endpoint.pathname !== '/v1') || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) return deny();
    if (!validOfficialCliModelId(input.model) || !/^[\x21-\x7e]{8,512}$/.test(input.gatewayToken) || typeof input.prompt !== 'string' || !input.prompt.trim() ||
        !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 900000 ||
        !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 128 || input.maxOutputTokens > 16000) return deny();
    const command = verifiedClaudeCommand(input.commandRef);
    const home = mkdtempSync(join(input.controllerRoot, '.runtime', 'claude-executor'));
    for (const part of ['config','tmp','appdata','localappdata']) mkdirSync(join(home, part), {recursive: true});
    // The CLI gets a throwaway home, never the user profile: no user CLAUDE.md, no user
    // settings, no user credentials, and TEMP stays inside the controller root.
    const env = childEnv({HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home,'config'), APPDATA: join(home,'appdata'),
        LOCALAPPDATA: join(home,'localappdata'), TEMP: join(home,'tmp'), TMP: join(home,'tmp'),
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.maxOutputTokens),
        ANTHROPIC_API_KEY: input.gatewayToken, ANTHROPIC_BASE_URL: endpoint.origin,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        // Any attempt to leave loopback fails locally instead of reaching a provider.
        HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost'});
    // Two shapes, never a blend. Without a binding the CLI keeps its own built-in tools and this
    // turn is process-level evidence only. With one, every built-in tool is removed, the single
    // MCP server is the DM broker, and the only allowed tools are its two desk_* tools — an MCP
    // call is refused unless it is on --allowedTools, because --permission-prompts none has no
    // surface to answer a prompt and would deny it silently.
    const deskMcp = input.mcp ? writeDeskMcpConfig({directory: home, binding: input.mcp, command: process.execPath}) : undefined;
    const toolsArg = deskMcp ? ['--tools',''] : ['--tools',CLAUDE_EXECUTOR_TOOLS.join(',')];
    const allowArg = deskMcp ? ['--allowedTools',deskMcp.allowedTools] : [];
    const mcpArg = ['--strict-mcp-config','--mcp-config',deskMcp ? deskMcp.configPath : '{"mcpServers":{}}'];
    const args = ['--print',...toolsArg,...allowArg,'--disallowedTools',CLAUDE_EXECUTOR_DENY,
        '--permission-mode','acceptEdits','--permission-prompts','none',...mcpArg,
        '--setting-sources','','--settings','{}','--no-session-persistence','--disable-slash-commands',
        '--output-format','stream-json','--verbose','--model',input.model,'--add-dir',input.workspace];
    const before = snapshot(input.workspace);
    let output: {stdout:string; stderr:string; code:number|null};
    try {
        output = await capture(command, args, {cwd: input.workspace, env, windowsJobRoot: input.controllerRoot, signal: input.signal,
            timeoutMs: input.timeoutMs, maxBytes: MAX_STDOUT, input: input.prompt, maxInputBytes: 4194304});
    } finally {
        env.ANTHROPIC_API_KEY = '';
    }
    input.signal.throwIfAborted(); stillCurrent();
    if (output.code !== 0) throw new DomainError('CLAUDE_EXECUTOR_EXIT_NONZERO', 502);
    const stream = readStream(output.stdout);
    if (!stream || !stream.observedModel || stream.observedModel !== input.model) return deny();
    return {sessionId: stream.sessionId, text: stream.text, model: stream.observedModel, perCallAudit: deskMcp !== undefined, modelResponses: stream.modelResponses, assistantTurns: stream.assistantTurns,
        toolUses: stream.toolUses, toolResults: stream.toolResults, deniedToolResults: stream.deniedToolResults,
        exitCode: output.code, commandLine: [command, ...args], cwd: input.workspace,
        fileChanges: changedBeforeAfter(before, snapshot(input.workspace))};
}
