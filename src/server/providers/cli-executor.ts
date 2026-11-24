import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,sep} from 'node:path';
import {capture} from '../process.js';
import {childEnv,DomainError,hash,object} from '../security.js';
import {validOfficialCliModelId,verifiedClaudeCommand,type ClaudeCommandRef} from './claude-supervisor.js';
import {clineSessionId} from './custom-official-cli.js';

/**
 * The executor arm of the installed OpenCode and Cline CLIs.
 *
 * AUDIT BOUNDARY, stated plainly and identical to providers/claude-executor.ts. The tool calls of
 * one turn are the CLI's OWN built-in tools, not the DM broker's desk_* intents: the product cannot
 * intercept an individual write or shell call, so nothing here may be read as per-call approval.
 * What this module reports is PROCESS-LEVEL evidence only:
 *   - the exact argv and cwd the CLI ran with,
 *   - its exit code,
 *   - how many model rounds it ran and how many of their tool calls were refused,
 *   - and a before/after SHA-256 of every workspace file it changed (a diff summary).
 *
 * That evidence is assembled into one record per turn, CliExecutorProcessAudit, whose
 * `perCallApproval:false` member is part of the record rather than a note beside it. The record
 * carries the CLI's own tool-call COUNTS (total, refused, per tool name) and never a tool
 * argument, a tool result or a synthesised ToolIntent/ToolResult: those belong to the broker
 * executors (DSH, Pi) and are deliberately absent here.
 *
 * The workspace fence is two independent layers rather than one, exactly as for Claude Code:
 *   - OpenCode is started with cwd inside the flows workspace and its provider config denies every
 *     tool except read/edit/write/bash, with bash pattern-denied for git push and the network
 *     installers. Measured on 1.19.6: those four tools are the only ones the model is offered, an
 *     out-of-workspace write and a git push both come back as tool errors, and no file appears
 *     outside cwd.
 *   - Cline is started in act mode with cwd inside the workspace, and its settings disable the web,
 *     question, sub-agent and team tools. Measured on 3.0.74: it always offers its 25 built-in
 *     tools and has no selective command deny, so its `run_commands` tool cannot be fenced the
 *     way OpenCode's bash is. The fence therefore moves to the product: this module watches the
 *     CLI's own `--json` event stream while the turn runs and stops the process the moment a
 *     segment of any command is an installer, and after the turn it refuses the whole turn if the
 *     workspace's git refs moved. Both are recorded in docs/CLI_EXECUTOR_FEASIBILITY.md.
 */
export const OPENCODE_EXECUTOR_TOOLS = ['read','edit','write','bash'] as const;
/** Bash patterns the OpenCode executor refuses before the command runs. */
export const OPENCODE_EXECUTOR_BASH_DENY = ['git push','git push *','npm install*','npm i *','pnpm*','yarn*','pip install*','pip3 install*'] as const;
/** Tools Cline must not be offered as an executor: web, questions, sub-agents and team fan-out. */
export const CLINE_EXECUTOR_DISABLED_TOOLS = ('web_search fetch_web_content ask_question spawn_agent team_spawn_teammate team_shutdown_teammate team_status team_task team_run_task team_cancel_run team_list_runs team_await_runs team_send_message team_broadcast team_read_mailbox team_mission_log team_cleanup team_create_outcome team_attach_outcome_fragment team_review_outcome_fragment team_finalize_outcome team_list_outcomes').split(' ');
const MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_FILES = 4000, MAX_STDOUT = 8 * 1024 * 1024, MAX_PROMPT_BYTES = 262144;
/** Git references are read, never written, and a workspace with more than this many is refused as
 *  unobserved rather than silently half-watched. */
const MAX_GIT_REFS = 2000, MAX_GIT_FILE_BYTES = 4096;
/** The longest single --json line the streaming watcher will hold before it stops buffering; a
 *  longer line is dropped, which can only make the watcher miss a command, never invent one. */
const MAX_STREAM_LINE = 1024 * 1024;
/**
 * Installer invocations, as token prefixes of one shell command segment.
 *
 * Cline offers its `run_commands` tool with no per-command deny list at all, so this list is the
 * whole fence for software installation: the product reads the command out of the CLI's own event
 * stream BEFORE the child runs it (content_start carries the input), and stops the process when a
 * segment starts with one of these. Matching is on segment-leading tokens rather than on substrings
 * so that `grep "npm install" notes.md` is not confused with an install; the leading wrapper
 * tokens a shell would strip (sudo, env, …) are stripped here too.
 */
export const CLI_INSTALL_TOKENS: readonly (readonly string[])[] = [
    ['npm','install'],['npm','i'],['npm','ci'],['npm','add'],['npm','exec','--','install'],
    ['pnpm','install'],['pnpm','i'],['pnpm','add'],['pnpm','dlx'],
    ['yarn','install'],['yarn','add'],['yarn','global'],
    ['npx','install'],['bun','install'],['bun','add'],
    ['pip','install'],['pip3','install'],['pipx','install'],
    ['python','-m','pip','install'],['python3','-m','pip','install'],
    ['uv','pip','install'],['uv','add'],['poetry','add'],['poetry','install'],
    ['cargo','install'],['go','install'],['gem','install'],['dotnet','add'],['composer','require'],
    ['choco','install'],['winget','install'],['scoop','install'],['brew','install'],
    ['apt','install'],['apt-get','install'],['apk','add'],['yum','install'],['dnf','install'],
];
/** Tokens a shell treats as a prefix wrapper rather than the command itself. */
const COMMAND_WRAPPERS = ['sudo','doas','env','command','exec','time','nohup','nice'];
/** One command line split the way a shell would split it into separately-run commands. */
export function commandSegments(command: string): string[][] {
    return command
        .split(/[\r\n;&|]+/)
        .map(segment => segment.trim())
        .filter(Boolean)
        .map(segment => segment.replace(/^[\s(]+/, '').split(/\s+/).map(token => token.replace(/^['"]|['"]$/g, '')));
}
/**
 * The installer a command line would run, or undefined. Exported so the refusal is testable
 * without a CLI, and so the exact matcher the executor uses is the one the tests pin.
 */
export function clineInstallerCommand(command: string): string | undefined {
    for (const tokens of commandSegments(command)) {
        let rest = tokens.slice();
        // A wrapper carries flags of its own (sudo -E, env -i, nice -n 10). Both the wrapper and
        // those flags are stripped before the command itself is judged; no command starts with a
        // flag, so this can only ever reveal the real head token.
        for (;;) {
            if (rest.length > 1 && COMMAND_WRAPPERS.includes(rest[0].toLowerCase())) {rest = rest.slice(1); continue;}
            if (rest.length > 1 && rest[0].startsWith('-')) {rest = rest.slice(1); continue;}
            break;
        }
        const head = rest.map(token => token.toLowerCase());
        for (const install of CLI_INSTALL_TOKENS)
            if (install.length <= head.length && install.every((token, index) => head[index] === token))
                return rest.join(' ');
    }
    return undefined;
}

export type CliExecutorRuntime = 'opencode' | 'cline' | 'codex';

/**
 * The one record this lane publishes for a turn, assembled in one place.
 *
 * Pure on purpose: its exact shape is what a receipt carries, so it is built by a function that
 * can be called with fixed inputs in a test instead of only from inside a live process. Every
 * member is a fact about the PROCESS; there is no ToolIntent, no ToolResult and no per-call
 * approval path here, and `perCallApproval:false` is a member rather than a comment so no consumer
 * can read the record as a broker trail.
 */
export function cliExecutorProcessAudit(input: {
    runtime: CliExecutorRuntime;
    commandLine: readonly string[];
    cwd: string;
    exitCode: number;
    modelResponses: number;
    toolUses: number;
    deniedToolResults: number;
    toolCallsByName: Readonly<Record<string, number>>;
    fileChanges: readonly CliExecutorFileChange[];
    diffSummary: CliExecutorDiffSummary;
    gitObserved: boolean;
    gitChanged: readonly string[];
}): CliExecutorProcessAudit {
    return Object.freeze({
        schema: 'dream-maker.cli-executor-audit.v1' as const,
        runtime: input.runtime,
        commandLine: Object.freeze([...input.commandLine]),
        cwd: input.cwd,
        exitCode: input.exitCode,
        modelResponses: input.modelResponses,
        toolCalls: Object.freeze({total: input.toolUses, refused: input.deniedToolResults, byTool: Object.freeze({...input.toolCallsByName})}),
        fileChanges: Object.freeze([...input.fileChanges]),
        diffSummary: Object.freeze({...input.diffSummary}),
        git: Object.freeze({observed: input.gitObserved, changed: Object.freeze([...input.gitChanged])}),
        perCallApproval: false as const,
    });
}

export interface CliExecutorInput {
    runtime: CliExecutorRuntime;
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
}

export interface CliExecutorFileChange {path:string;bytes:number;sha256:string}

/** How many files the turn added, changed and removed, and how many bytes it wrote doing it. */
export interface CliExecutorDiffSummary {added:number; modified:number; deleted:number; bytesAdded:number}

/** The CLI's own account of its tool rounds: counts only, never arguments or results. */
export interface CliExecutorToolCalls {total:number; refused:number; byTool:Readonly<Record<string,number>>}

/**
 * One executor turn, written as what the product can actually prove about it.
 *
 * This is the Cline lane's whole audit record and the reason the lane can exist at all. It is a
 * PROCESS record: the product started a child, read its event stream, and compared the workspace
 * before and after. Nothing in it is a per-call decision, and `perCallApproval:false` says so
 * inside the record rather than in a comment beside it, so a receipt can never be filed as if it
 * were a desk_* trail.
 */
export interface CliExecutorProcessAudit {
    schema:'dream-maker.cli-executor-audit.v1';
    runtime:CliExecutorRuntime;
    /** The exact argv and cwd the CLI ran with. Never a shell string, never reconstructed. */
    commandLine:readonly string[];
    cwd:string;
    /** The exit code the OS reported for the child. */
    exitCode:number;
    /** Model rounds the CLI spent; each one is one upstream request, checked against the ledger. */
    modelResponses:number;
    toolCalls:CliExecutorToolCalls;
    /** Every workspace file whose bytes differ, added or deleted, plus the summary of that list. */
    fileChanges:readonly CliExecutorFileChange[];
    diffSummary:CliExecutorDiffSummary;
    /** Git references are watched, not enforced live: a turn that moves one is refused afterwards. */
    git:{observed:boolean; changed:readonly string[]};
    /** Stated in the record: the product sees one process, not a stream of broker intents. */
    perCallApproval:false;
}

export interface CliExecutorObservation {
    sessionId:string; text:string; model:string;
    /** Model rounds the CLI consumed; each one is one upstream request for this turn, and receipts
     *  are matched against this value. Both CLIs report exactly one frame per model round. */
    modelResponses:number; assistantTurns:number; toolUses:number; toolResults:number; deniedToolResults:number;
    exitCode:number; commandLine:readonly string[]; cwd:string;
    fileChanges:readonly CliExecutorFileChange[];
    /** The process-level record of this turn; the same values, stated once and in one shape. */
    audit:CliExecutorProcessAudit;
}

const deny = (): never => {throw new DomainError('CLI_EXECUTOR_UNVERIFIED', 409);};

function inside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

/** Bounded workspace digest: no symlinks followed, no file over the cap read twice. */
function snapshot(root: string): Map<string, CliExecutorFileChange> {
    const seen = new Map<string, CliExecutorFileChange>();
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

function changedBeforeAfter(before: Map<string, CliExecutorFileChange>, after: Map<string, CliExecutorFileChange>): CliExecutorFileChange[] {
    const rows: CliExecutorFileChange[] = [];
    for (const [path, row] of after) {
        const old = before.get(path);
        if (!old || old.sha256 !== row.sha256 || old.bytes !== row.bytes) rows.push(row);
    }
    for (const [path] of before) if (!after.has(path)) rows.push({path, bytes: 0, sha256: 'DELETED'});
    return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/** The one-line summary of the same two snapshots: what a reviewer reads before the list itself. */
function diffSummary(before: Map<string, CliExecutorFileChange>, after: Map<string, CliExecutorFileChange>): CliExecutorDiffSummary {
    let added = 0, modified = 0, deleted = 0, bytesAdded = 0;
    for (const [path, row] of after) {
        const old = before.get(path);
        if (!old) {added += 1; bytesAdded += row.bytes; continue;}
        if (old.sha256 !== row.sha256 || old.bytes !== row.bytes) {modified += 1; bytesAdded += Math.max(0, row.bytes - old.bytes);}
    }
    for (const path of before.keys()) if (!after.has(path)) deleted += 1;
    return {added, modified, deleted, bytesAdded};
}

/**
 * A bounded reading of the workspace's git references.
 *
 * Cline has no way to deny `git push` (its 25 tools cannot be trimmed and no per-command policy
 * exists), so the product cannot refuse the command before it runs the way OpenCode's bash
 * patterns and Claude's --disallowedTools do. What it CAN do is notice, immediately after the
 * turn, that a reference moved, and refuse the whole turn — fail-closed收尾 rather than a silent
 * push. The map is keyed by the reference's path under .git, so HEAD, every branch and tag file,
 * packed-refs and the FETCH/MERGE/ORIG heads are all compared.
 */
export function readGitRefs(root: string): Map<string, string> {
    const refs = new Map<string, string>();
    const readBounded = (path: string): string | undefined => {
        try {
            const size = statSync(path).size;
            if (size > MAX_GIT_FILE_BYTES) return 'SKIPPED_TOO_LARGE';
            return hash(readFileSync(path));
        } catch { return undefined; }
    };
    try {
        let directory = join(root, '.git');
        if (!existsSync(directory)) return refs;
        if (statSync(directory).isFile()) {
            // A worktree or submodule keeps a one-line pointer instead of a directory.
            const pointer = readFileSync(directory, 'utf8').slice(0, MAX_GIT_FILE_BYTES);
            const match = /^gitdir:\s*(\S.*)$/m.exec(pointer);
            if (!match) return refs;
            const spelled = match[1].trim();
            directory = isAbsolute(spelled) ? spelled : join(root, spelled);
            if (!existsSync(directory)) return refs;
        }
        for (const name of ['HEAD', 'packed-refs', 'ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
            const value = readBounded(join(directory, name));
            if (value !== undefined) refs.set(name, value);
        }
        const walk = (base: string, prefix: string) => {
            if (refs.size >= MAX_GIT_REFS) return;
            for (const entry of readdirSync(base, {withFileTypes: true})) {
                if (refs.size >= MAX_GIT_REFS) return;
                if (entry.isSymbolicLink()) continue;
                const path = join(base, entry.name), key = prefix + '/' + entry.name;
                if (entry.isDirectory()) {walk(path, key); continue;}
                if (!entry.isFile()) continue;
                const value = readBounded(path);
                if (value !== undefined) refs.set(key, value);
            }
        };
        const refsDirectory = join(directory, 'refs');
        if (existsSync(refsDirectory) && statSync(refsDirectory).isDirectory()) walk(refsDirectory, 'refs');
    } catch { /* an unreadable .git is reported as unobserved; the file list below still stands */ }
    return refs;
}

/** The references that differ between two readings, added, removed or rewritten. */
export function gitRefChanges(before: Map<string, string>, after: Map<string, string>): string[] {
    const changed: string[] = [];
    for (const [key, value] of after) if (before.get(key) !== value) changed.push(key);
    for (const key of before.keys()) if (!after.has(key)) changed.push(key);
    return changed.sort();
}

/** Native session ids are opaque, filename-safe tokens. */
function nativeId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 160 &&
        /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._-]/.test(value) && !value.endsWith('.');
}

/**
 * OpenCode emits one JSON object per line: a step_start / step_finish pair per model round, a
 * text part per answer chunk, and a tool_use row per executed (or refused) tool call. The final
 * round must be step_finish with reason 'stop'; anything else is not a completed turn.
 */
function readOpenCode(stdout: string) {
    const rows: Record<string, unknown>[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try { row = object(JSON.parse(line)); } catch { return undefined; }
        rows.push(row);
    }
    if (rows.length < 3) return undefined;
    const sessionId = rows[0].sessionID;
    if (!nativeId(sessionId)) return undefined;
    let assistantTurns = 0, toolUses = 0, toolResults = 0, deniedToolResults = 0, text = '';
    for (const [index, row] of rows.entries()) {
        if (row.sessionID !== sessionId) return undefined;
        const part = object(row.part);
        if (part.sessionID !== sessionId) return undefined;
        if (row.type === 'tool_use') {
            const state = object(part.state);
            toolUses += 1; toolResults += 1;
            if (state.status === 'error') deniedToolResults += 1;
            continue;
        }
        if (row.type === 'step_start' && part.type === 'step-start') {assistantTurns += 1; continue;}
        if (row.type === 'text' && part.type === 'text') {
            if (typeof part.text !== 'string') return undefined;
            text += part.text;
            continue;
        }
        if (row.type === 'step_finish' && part.type === 'step-finish') {
            if (index !== rows.length - 1) {
                if (part.reason !== 'tool-calls') return undefined;
                continue;
            }
            if (part.reason !== 'stop') return undefined;
            continue;
        }
        return undefined;
    }
    if (!assistantTurns) return undefined;
    // One step_start per model round: the round count is the response count here.
    // OpenCode's own rows are counted per round; this record names per-tool counts only where the
    // harness's stream names each tool (Cline does, see readCline).
    return {sessionId, modelResponses: assistantTurns, assistantTurns, toolUses, toolResults, deniedToolResults,
        toolCallsByName: Object.freeze({} as Record<string, number>), text};
}

/**
 * The live half of the Cline fence: the CLI's own event stream, read while the turn runs.
 *
 * Measured on Cline 3.0.74 (--json, act mode, one run_commands call): a tool call is announced by
 * `agent_event {type:'content_start', contentType:'tool', toolName, toolCallId, input}` BEFORE the
 * child process runs, then followed by `content_update` rows carrying `update.query` and one
 * `content_end` whose `output[]` repeats the command with its result. `content_start` is therefore
 * the last moment at which the product can still stop the command, and it is where the installer
 * check reads from. The watcher holds no state about arguments beyond the pending line buffer.
 *
 * When an installer is seen the watcher records the command and throws out of the stdout observer;
 * capture() treats that as an observer failure and stops the child, and runCliExecutorTurn turns
 * it into CLI_EXECUTOR_INSTALL_REFUSED. The command is recorded as it was reported, which is what
 * makes the refusal reproducible; nothing about it is stored as a tool intent.
 */
export interface CliInstallWatcher { push(chunk:string):void; violation():string|undefined }

export function clineInstallWatcher(): CliInstallWatcher {
    let pending = '', offending: string | undefined;
    // Every member here is optional on some event: content_start carries input, content_update
    // carries update, content_end carries output. A missing one is simply not examined - reading
    // it strictly would have thrown on every content_start and let an installer through.
    const member = (value: unknown): Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const commandsOf = (event: Record<string, unknown>): string[] => {
        const commands: string[] = [];
        const add = (value: unknown) => {if (typeof value === 'string' && value) commands.push(value);};
        const input = member(event.input);
        add(input.command);
        if (Array.isArray(input.commands)) for (const item of input.commands) add(item);
        add(member(event.update).query);
        if (Array.isArray(event.output)) for (const item of event.output) add(member(item).query);
        return commands;
    };
    const inspect = (line: string): string | undefined => {
        try {
            const row = object(JSON.parse(line));
            if (row.type !== 'agent_event') return undefined;
            const event = object(row.event);
            if (event.contentType !== 'tool') return undefined;
            for (const command of commandsOf(event)) if (clineInstallerCommand(command)) return command;
        } catch { /* a row that is not one of the CLI's own events carries no command */ }
        return undefined;
    };
    return {
        push(chunk: string): void {
            if (offending) return;
            pending += chunk;
            let index = pending.indexOf('\n');
            while (index >= 0) {
                const line = pending.slice(0, index).trim();
                pending = pending.slice(index + 1);
                if (line) {
                    const command = inspect(line);
                    if (command !== undefined) {
                        offending = command;
                        throw new Error('CLI_INSTALL_OBSERVED');
                    }
                }
                index = pending.indexOf('\n');
            }
            // A line that never ends is not a CLI event this watcher can judge; drop it rather
            // than grow the buffer for a turn that would otherwise be bounded.
            if (pending.length > MAX_STREAM_LINE) pending = '';
        },
        violation: () => offending,
    };
}

/** Cline emits run_start / hook_event / agent_event / run_result rows for one act-mode turn. */
function readCline(stdout: string, model: string, data: string, cwd: string, marker: string) {
    const rows: Record<string, unknown>[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try { row = object(JSON.parse(line)); } catch { return undefined; }
        rows.push(row);
    }
    const start = rows[0], end = rows.at(-1);
    if (!start || !end || start.type !== 'run_start' || start.modelId !== model || start.providerId !== 'anthropic' || start.mode !== 'act') return undefined;
    if (end.type !== 'run_result' || end.finishReason !== 'completed' || typeof end.text !== 'string' || object(end.model).id !== model || object(end.model).provider !== 'anthropic') return undefined;
    if (!Number.isSafeInteger(end.iterations) || Number(end.iterations) < 1) return undefined;
    let assistantTurns = 0, toolUses = 0, deniedToolResults = 0;
    const byTool: Record<string, number> = {};
    for (const row of rows.slice(1, -1)) {
        // Cline emits its own host hook rows (agent_start, tool_call, tool_result, agent_end)
        // between the model events. They carry no model input and no model output, so they are
        // skipped here rather than parsed; a turn that calls a tool always adds them, which is why
        // the read-only arm's exact two-hook rule cannot hold on this leg.
        if (row.type === 'hook_event') {if (typeof row.hookEventName !== 'string') return undefined; continue;}
        if (row.type !== 'agent_event') return undefined;
        const event = object(row.event);
        if (event.type === 'iteration_start') {assistantTurns += 1; continue;}
        if (event.type === 'iteration_end') {
            if (!Number.isSafeInteger(event.toolCallCount)) return undefined;
            toolUses += Number(event.toolCallCount);
            continue;
        }
        if (!['content_start','content_update','content_delta','content_end','usage','done','tool_start','tool_end','tool_result'].includes(String(event.type))) return undefined;
        // One content_start per tool call is the only place the tool's own name appears. What is
        // counted is the NAME and the count: never the input, never the output, never a per-call
        // record. That is the whole difference between this lane and a desk_* trail.
        if (event.type === 'content_start' && event.contentType === 'tool') {
            const name = typeof event.toolName === 'string' && event.toolName ? event.toolName : 'unknown';
            byTool[name] = (byTool[name] ?? 0) + 1;
        }
        if (event.type === 'tool_result' && (event.isError === true || event.error === true)) deniedToolResults += 1;
        if (event.type === 'content_end' && event.contentType === 'tool' && typeof event.error === 'string' && event.error) deniedToolResults += 1;
    }
    if (assistantTurns !== Number(end.iterations)) return undefined;
    return {sessionId: clineSessionId(data, model, cwd, marker, 'anthropic'), modelResponses: assistantTurns, assistantTurns, toolUses, toolResults: toolUses, deniedToolResults,
        toolCallsByName: Object.freeze(byTool), text: end.text};
}

/**
 * `codex exec --json` emits one JSONL row per event: thread.started, turn.started, item.completed
 * (agent_message / reasoning / command_execution / file_change / mcp_tool_call / error) and
 * turn.completed. One turn.started is one model round. Anything else is not a completed turn.
 */
function readCodex(stdout: string, model: string) {
    const rows: Record<string, unknown>[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try { row = object(JSON.parse(line)); } catch { return undefined; }
        rows.push(row);
    }
    const start = rows[0], end = rows.at(-1);
    if (!start || !end || start.type !== 'thread.started' || typeof start.thread_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(start.thread_id)) return undefined;
    if (end.type !== 'turn.completed') return undefined;
    // One exec run is one *turn*, but a turn that calls a tool asks the model again: 0.171.0 reports a
    // single turn.started for a turn that spent two model requests (measured against a loopback
    // Responses fixture, .runtime/codex-body-capture.json). So the round count is the turn count plus
    // one round per tool round the CLI ran, and the calls of one round are emitted adjacently.
    let turns = 0, toolRounds = 0, modelResponses = 0, toolUses = 0, toolResults = 0, deniedToolResults = 0, text = '';
    let afterTool = false;
    const toolItems = new Set(['command_execution','file_change','mcp_tool_call']);
    for (const row of rows.slice(1, -1)) {
        if (row.type === 'turn.started') {turns += 1; afterTool = false; continue;}
        if (row.type !== 'item.completed' && row.type !== 'item.started') return undefined;
        const item = object(row.item);
        if (typeof item.id !== 'string') return undefined;
        if (item.type === 'agent_message') {
            if (row.type !== 'item.completed' || typeof item.text !== 'string') return undefined;
            text += item.text;
            continue;
        }
        // The CLI reports model-metadata and stream warnings as item.completed/error rows.
        if (item.type === 'error') {if (typeof item.message !== 'string') return undefined; continue;}
        if (item.type === 'reasoning') continue;
        if (toolItems.has(String(item.type))) {
            if (row.type === 'item.completed') {
                if (!afterTool) {toolRounds += 1; afterTool = true;}
                toolUses += 1; toolResults += 1;
                if (item.status === 'failed' || item.exit_code !== undefined && item.exit_code !== 0) deniedToolResults += 1;
            }
            continue;
        }
        return undefined;
    }
    modelResponses = turns + toolRounds;
    if (!turns || !modelResponses) return undefined;
    const usage = object(end.usage), count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (count(usage.input_tokens) === null || count(usage.output_tokens) === null) return undefined;
    return {sessionId: start.thread_id as string, modelResponses, assistantTurns: modelResponses, toolUses, toolResults, deniedToolResults,
        toolCallsByName: Object.freeze({} as Record<string, number>), text};
}

function openCodeConfig(model: string, origin: string, token: string, maxOutputTokens: number) {
    return {enabled_providers:['dm'],provider:{dm:{npm:'@ai-sdk/anthropic',name:'dm',options:{baseURL:origin+'/v1',apiKey:token},models:{[model]:{name:model,limit:{context:32000,output:maxOutputTokens}}}}},
        model:'dm/'+model,small_model:'dm/'+model,
        // Only the four tool-bearing actions the executor lane declares. Everything else is denied,
        // and bash carries the pattern deny list so a push or an installer never starts a child.
        permission:{'*':'deny',read:'allow',edit:'allow',write:'allow',bash:Object.fromEntries([['*','allow'],...OPENCODE_EXECUTOR_BASH_DENY.map(pattern=>[pattern,'deny'])])},
        agent:{title:{disable:true},summary:{disable:true}},share:'disabled',autoupdate:false};
}

function clineProviders(model: string, origin: string, token: string, maxOutputTokens: number) {
    const provider = 'anthropic';
    return {version:1,lastUsedProvider:provider,providers:{[provider]:{settings:{provider,model,apiKey:token,baseUrl:origin+'/v1',protocol:'anthropic',client:'anthropic',maxTokens:maxOutputTokens,
        catalog:{loadLatestOnInit:false,includeClineCloudModels:false,loadPrivateOnAuth:false}},updatedAt:new Date().toISOString(),tokenSource:'manual'}}};
}

export async function runCliExecutorTurn(input: CliExecutorInput): Promise<CliExecutorObservation> {
    const stillCurrent = () => {const result: unknown = input.assertCurrent(); if (result !== undefined) deny();};
    input.signal.throwIfAborted(); stillCurrent();
    if (input.runtime !== 'opencode' && input.runtime !== 'cline' && input.runtime !== 'codex') return deny();
    if (!isAbsolute(input.controllerRoot) || !isAbsolute(input.workspace) || !inside(input.controllerRoot, input.workspace)) return deny();
    let endpoint: URL;
    try { endpoint = new URL(input.gatewayUrl); } catch { return deny(); }
    // The owned gateway advertises its base URL with the '/v1' prefix the CLI appends its own
    // '/v1/messages' path to; both spellings name the same loopback origin.
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
        (endpoint.pathname !== '/' && endpoint.pathname !== '/v1') || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) return deny();
    if (!validOfficialCliModelId(input.model) || !/^[\x21-\x7e]{8,512}$/.test(input.gatewayToken) || typeof input.prompt !== 'string' || !input.prompt.trim() ||
        Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 900000 ||
        !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 128 || input.maxOutputTokens > 16000) return deny();
    const command = verifiedClaudeCommand(input.commandRef);
    const home = mkdtempSync(join(input.controllerRoot, '.runtime', 'cli-executor-'));
    const workspace = input.workspace, data = join(home, 'data'), config = join(home, 'config'), cwd = workspace;
    for (const part of ['config','tmp','appdata','localappdata','data']) mkdirSync(join(home, part), {recursive: true});
    if (input.runtime === 'cline') mkdirSync(join(data, 'settings'), {recursive: true});
    const env = childEnv({HOME: home, USERPROFILE: home, APPDATA: join(home,'appdata'), LOCALAPPDATA: join(home,'localappdata'), XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data, XDG_CACHE_HOME: join(home,'cache'), XDG_STATE_HOME: join(home,'state'), TEMP: join(home,'tmp'), TMP: join(home,'tmp'), TMPDIR: join(home,'tmp'), DO_NOT_TRACK: '1',
        // Any attempt to leave loopback fails locally instead of reaching a provider.
        HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost'});
    delete env.Path;
    const systemRoot = process.env.SystemRoot ?? 'C:/Windows';
    // The system directory is the whole path for the legs whose own tools need nothing more.
    // Cline's run_commands is the exception: it spawns `powershell` by name and, with the system
    // directory alone, every command fails as `Executable not found in $PATH: "powershell"`
    // (measured on 3.0.74). The Windows PowerShell directory is therefore the ONE addition, and it
    // is only ever added for this leg. npm, pnpm, yarn, pip and node stay off the path entirely, so
    // an installer that somehow got past the stream watcher would still have nothing to run.
    env.PATH = input.runtime === 'cline'
        ? [join(systemRoot,'System32'), join(systemRoot,'System32','WindowsPowerShell','v1.0')].join(';')
        : join(systemRoot,'System32');
    let args: string[];
    if (input.runtime === 'opencode') {
        const model = 'dm/' + input.model;
        Object.assign(env, {OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_AUTOINSTALL:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_PROJECT_CONFIG:'true',
            OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_DISABLE_SHARE:'true',
            OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(input.model, endpoint.origin, input.gatewayToken, input.maxOutputTokens))});
        args = ['run','--format','json','--model',model,input.prompt];
    } else if (input.runtime === 'codex') {
        // codex exec drives one Responses turn. The provider override points it at the owned gateway
        // and the token arrives through the environment, never through argv.
        Object.assign(env,{CODEX_HOME: config, DM_GATEWAY_TOKEN: input.gatewayToken});
        args = ['exec','--json','--skip-git-repo-check','--sandbox','workspace-write','-C',workspace,'--model',input.model,
            '-c','model_providers.dm={name="dm",base_url="'+endpoint.origin+'/v1",env_key="DM_GATEWAY_TOKEN",wire_api="responses"}',
            '-c','model_provider="dm"',
            // The CLI's own --sandbox flag states the policy; this names the Windows implementation
            // that can honour it. Measured on 0.171.0 (win32): the default implementation refuses
            // every child process at CreateProcess, so exec_command can never run and the turn has no
            // tool round at all. 'unelevated' keeps the same workspace-write policy and lets a child
            // start; the fence is still the CLI's, not this line's.
            '-c','windows.sandbox="unelevated"',input.prompt];
    } else {
        writeFileSync(join(data,'settings','providers.json'), JSON.stringify(clineProviders(input.model, endpoint.origin, input.gatewayToken, input.maxOutputTokens)), {mode:0o600});
        writeFileSync(join(data,'settings','global-settings.json'), JSON.stringify({telemetryOptOut:true,autoUpdateEnabled:false,disabledTools:CLINE_EXECUTOR_DISABLED_TOOLS,tools:{web_search:{enabled:false}}}));
        Object.assign(env,{CLINE_SESSION_BACKEND_MODE:'local',CLINE_DIR:config,CLINE_DATA_DIR:data});
        args = ['--json','--verbose','--auto-approve','true','--retries','1','--compaction','off','--provider','anthropic','--model',input.model,
            '--config',config,'--data-dir',data,'--cwd',cwd,input.prompt];
    }
    // Two things this lane cannot refuse before a child runs: an installer, and a git push. Cline
    // publishes both on its own stream and in the workspace, so the product watches the first while
    // the turn runs and compares the second before and after it.
    const before = snapshot(workspace), gitBefore = readGitRefs(workspace);
    const watcher = input.runtime === 'cline' ? clineInstallWatcher() : undefined;
    let output: {stdout:string; stderr:string; code:number|null};
    let stream: ReturnType<typeof readCline>;
    try {
        output = await capture(command, args, {cwd, env, windowsJobRoot: input.controllerRoot, signal: input.signal,
            timeoutMs: input.timeoutMs, maxBytes: MAX_STDOUT, input: '', maxInputBytes: 4096,
            // Only the Cline leg needs the live stream: OpenCode denies the installers as bash
            // patterns and Claude refuses them as disallowed tools before any child runs, so their
            // turns are read once, after the fact.
            ...(watcher ? {onStdout: (chunk: string) => watcher.push(chunk)} : {})});
        input.signal.throwIfAborted(); stillCurrent();
        if (output.code !== 0) throw new DomainError('CLI_EXECUTOR_EXIT_NONZERO', 502);
        // Parsed HERE, inside the same try, and before the throwaway home is removed. The Cline arm
        // binds its session id from the CLI's own session manifest under --data-dir, so a parse
        // that ran after the cleanup could only ever fail with ENOENT on data/sessions — which is
        // exactly what this lane did while it was closed and nobody could tell.
        stream = input.runtime === 'opencode' ? readOpenCode(output.stdout)
            : input.runtime === 'cline' ? readCline(output.stdout, input.model, data, cwd, input.prompt)
            : readCodex(output.stdout, input.model);
        if (!stream || !stream.sessionId) return deny();
    } catch (error) {
        // An installer on the live stream is what stopped the child: that is the refusal, and it is
        // reported as one instead of as a generic capture failure.
        const install = watcher?.violation();
        if (install !== undefined) throw new DomainError('CLI_EXECUTOR_INSTALL_REFUSED', 409,
            'Cline 回合中检测到安装类命令，已中止该回合：' + install.slice(0, 200));
        throw error;
    } finally {
        try { rmSync(home, {recursive: true, force: true, maxRetries: 3}); } catch { /* the audit below still stands */ }
    }
    const after = snapshot(workspace), fileChanges = changedBeforeAfter(before, after);
    const gitChanged = gitRefChanges(gitBefore, readGitRefs(workspace));
    // Fail-closed收尾: a reference that moved during the turn is a push this lane could not deny in
    // advance, so the turn is refused rather than handed back with a note. The comparison is what
    // stands in for OpenCode's bash deny list and Claude's --disallowedTools on this leg.
    if (gitChanged.length) throw new DomainError('CLI_EXECUTOR_GIT_REF_CHANGED', 409,
        '工作区 git 引用在该回合内发生变化，拒绝该回合：' + gitChanged.slice(0, 8).join(', '));
    const commandLine = Object.freeze([command, ...args]);
    const audit = cliExecutorProcessAudit({runtime: input.runtime, commandLine, cwd, exitCode: output.code,
        modelResponses: stream.modelResponses, toolUses: stream.toolUses, deniedToolResults: stream.deniedToolResults,
        toolCallsByName: stream.toolCallsByName, fileChanges,
        diffSummary: diffSummary(before, after), gitObserved: gitBefore.size > 0, gitChanged});
    return {sessionId: stream.sessionId, text: stream.text, model: input.model, modelResponses: stream.modelResponses, assistantTurns: stream.assistantTurns,
        toolUses: stream.toolUses, toolResults: stream.toolResults, deniedToolResults: stream.deniedToolResults,
        exitCode: output.code, commandLine, cwd, fileChanges, audit};
}
