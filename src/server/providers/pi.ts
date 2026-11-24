import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DomainError, childEnv, id } from '../security.js';
import type { CustomMagpieProtocol } from '../../shared/custom-magpie-protocol.js';
import type { AgentInput, AgentOutput, Config, Runner } from '../../shared/types.js';
import { piReadOnlyToolsOnly } from '../flow/pi-native-wire.js';

/** Controller-selected Custom harness, pinned to one of the three engineering roles.
 *  Never parsed from model or HTTP data. A read-only role (planner2/reviewer) is the same
 *  harness on the same wire with a frozen tool set and its own role id — see PI_READ_ONLY_TOOLS. */
export type CustomPiRole = 'planner2' | 'executor' | 'reviewer';
export interface CustomPiRoleBinding {
    role: CustomPiRole; roleId: string; model: string;
    provider?: string;
    protocol?: CustomMagpieProtocol;
    /** Exact per-request output ceiling the original operator froze; Pi must not ask for more. */
    maxOutputTokens: number;
    /** Exact desk_* names the frozen permission set allows; anything else fails closed. */
    tools: readonly string[];
    assertCurrent(): void;
}
export interface PiToolChannel { url: string; token: string; close(): Promise<void> }
export interface PiGatewayChannel { url: string; token: string; close(): Promise<void>; receipts(): readonly unknown[] }
interface PiReceipt { id?: string; outcome?: string; observedModel?: string; completionObserved?: boolean }

/** The broker revalidates every argument; these declarations only tell the model the shape. */
const TOOL_PARAMETERS: Record<string, string> = {
    desk_read: 'Type.Object({path:Type.String()})',
    desk_search: 'Type.Object({text:Type.String()})',
    desk_write: 'Type.Object({path:Type.String(),content:Type.String(),expected_sha:Type.Optional(Type.String())})',
    desk_edit: 'Type.Object({path:Type.String(),old_text:Type.String(),new_text:Type.String(),expected_sha:Type.Optional(Type.String())})',
    desk_run: 'Type.Object({runtime:Type.Optional(Type.String()),entry:Type.String(),args:Type.Optional(Type.Array(Type.String())),stdin:Type.Optional(Type.String())})'
};
/** Node's CreateProcess argument limit is a hard 32767 characters; below that margin the
 * prompt goes inline, above it through Pi's documented `@file` message channel. */
const MAX_INLINE_PROMPT_BYTES = 24000;
const MAX_PROMPT_BYTES = 400000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

function toolExtension(names: readonly string[]): string {
    const declared = names.map(name => {
        const parameters = TOOL_PARAMETERS[name];
        if (!parameters) throw new DomainError('PI_TOOL_UNSUPPORTED', 409);
        return `  pi.registerTool({name:${JSON.stringify(name)},label:${JSON.stringify(name)},description:${JSON.stringify(name + ' (Dream Maker controlled project tool)')},parameters:${parameters},async execute(_id,params,signal){const value=await call(${JSON.stringify(name)},params,signal);return{content:[{type:'text',text:JSON.stringify(value)}],details:value};}});`;
    }).join('\n');
    return `import { Type } from "typebox";
export default function (pi) {
  const call = async (name, args, signal) => {
    const response = await fetch(process.env.DM_PI_TOOL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + process.env.DM_PI_TOOL_TOKEN },
      body: JSON.stringify({ name, args }),
      signal
    });
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  };
${declared}
}
`;
}

export class PiRunner implements Runner {
    private readonly binding: Readonly<CustomPiRoleBinding>;
    constructor(
        private config: () => Config,
        private root: string,
        private gateway: () => Promise<PiGatewayChannel>,
        binding: CustomPiRoleBinding,
        private tools?: () => Promise<PiToolChannel>
    ) {
        const validModel = typeof binding.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(binding.model) && !binding.model.includes('://');
        const validProvider = binding.provider === undefined ? binding.model === 'deepseek-flash'
            : typeof binding.provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(binding.provider);
        if (binding.protocol !== undefined && !['chat-completions', 'openai-responses', 'anthropic-messages'].includes(binding.protocol))
            throw new DomainError('PI_ROLE_BINDING_INVALID', 409);
        if (!['planner2', 'executor', 'reviewer'].includes(binding.role) || !validModel || !validProvider || !binding.roleId ||
            !Number.isSafeInteger(binding.maxOutputTokens) || binding.maxOutputTokens < 128 || binding.maxOutputTokens > 16000)
            throw new DomainError('PI_ROLE_BINDING_INVALID', 409);
        // Role isolation, first half: a read-only binding IS its role. The planner2 and reviewer
        // roles are named by the role itself (custom-role-identity.customRoleConfiguration returns
        // an actor whose id is the role), so a read-only binding that names an executor role id is
        // a different role wearing this one's envelope and is refused before a child is spawned.
        if (binding.role !== 'executor' && binding.roleId !== binding.role)
            throw new DomainError('PI_ROLE_BINDING_INVALID', 409);
        if (!Array.isArray(binding.tools) || binding.tools.some(name => !TOOL_PARAMETERS[name]))
            throw new DomainError('PI_TOOL_UNSUPPORTED', 409);
        // Role isolation, second half: the write three are executor-only. A read-only turn that
        // asks for desk_write, desk_edit or desk_run is refused here as well as at the wire and
        // the gateway, so no single caller can widen the read-only tool set.
        if (binding.role !== 'executor' && !piReadOnlyToolsOnly(binding.tools))
            throw new DomainError('PI_TOOL_UNSUPPORTED', 409);
        this.binding = Object.freeze({ ...binding, tools: Object.freeze([...binding.tools]) });
    }
    private cli(): string {
        const configured = this.config().pi?.cliPath ?? '';
        if (!configured || !isAbsolute(configured) || !existsSync(configured))
            throw new DomainError('PI_CLI_MISSING', 409, 'Pi Agent CLI 未配置或路径不存在；不会退回 DSH 或其他运行器。');
        return configured;
    }
    async run(input: AgentInput, onEvent: (event: unknown) => void): Promise<AgentOutput> {
        const binding = this.binding;
        if (input.role !== binding.role || input.model !== binding.model || input.executorRoleId !== undefined && input.executorRoleId !== binding.roleId)
            throw new DomainError('PI_ROLE_BINDING_CHANGED', 409);
        if (input.signal.aborted) throw new DomainError('RUN_CANCELLED', 409);
        binding.assertCurrent();
        const cli = this.cli(), model = binding.model, promptBytes = Buffer.byteLength(input.prompt, 'utf8');
        if (promptBytes > MAX_PROMPT_BYTES)
            throw new DomainError('PI_ROLE_PROMPT_TOO_LARGE', 409, '角色提示超过本运行器允许的长度；不会截断后执行。');
        const gateway = await this.gateway();
        let tools: PiToolChannel | undefined;
        let directory: string | undefined;
        try {
            const url = new URL(gateway.url);
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1' || url.search || url.hash || url.username || url.password || !gateway.token)
                throw new DomainError('PI_GATEWAY_BINDING_INVALID', 409);
            tools = this.tools ? await this.tools() : undefined;
            if (tools) {
                const toolUrl = new URL(tools.url);
                if (toolUrl.protocol !== 'http:' || toolUrl.hostname !== '127.0.0.1' || toolUrl.pathname !== '/tools' || toolUrl.search || toolUrl.hash || !tools.token)
                    throw new DomainError('PI_TOOL_BINDING_INVALID', 409);
            }
            const parent = resolve(this.root, '.runtime/pi-runs');
            mkdirSync(parent, { recursive: true });
            directory = mkdtempSync(join(parent, 'owned-'));
            const extension = binding.tools.length ? resolve(directory, 'dm-tools.mjs') : undefined;
            if (extension) writeFileSync(extension, toolExtension(binding.tools), { mode: 0o600 });
            const protocol = binding.protocol ?? 'chat-completions';
            writeFileSync(resolve(directory, 'models.json'), JSON.stringify({
                providers: {
                    dm: {
                        baseUrl: protocol === 'anthropic-messages' ? url.origin : gateway.url,
                        api: protocol === 'chat-completions' ? 'openai-completions' : protocol,
                        apiKey: '$DM_PI_MODEL_TOKEN',
                        // Pi's OpenAI codec otherwise serializes a tool-only assistant message with
                        // null content. Custom Magpie requires text or text blocks on the next request.
                        ...(protocol === 'chat-completions' ? { compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens', requiresAssistantAfterToolResult: true } } : {}),
                        models: [{ id: model, name: model, maxTokens: binding.maxOutputTokens }]
                    }
                }
            }), { mode: 0o600 });
            writeFileSync(resolve(directory, 'settings.json'), JSON.stringify({ quietStartup: true, telemetry: false }), { mode: 0o600 });
            // Every turn owns a fresh control directory and a fresh session id, and the child runs
            // with --no-session, so no Pi state file can carry a planner2 or reviewer turn into an
            // executor turn (or into the next turn of the same role). The role travels in the
            // binding and in the identity envelope, never through shared on-disk session state.
            const sessionId = id('pi_session');
            // Long controller prompts cannot cross CreateProcess, so they are handed to Pi
            // through its documented `@file` message argument inside the owned temp dir.
            let message = input.prompt;
            if (promptBytes > MAX_INLINE_PROMPT_BYTES) {
                const promptFile = resolve(directory, 'role-prompt.md');
                writeFileSync(promptFile, input.prompt, { mode: 0o600 });
                message = '@' + promptFile;
            }
            const env = childEnv({
                PI_CODING_AGENT_DIR: directory, PI_OFFLINE: '1',
                DM_PI_MODEL_TOKEN: gateway.token,
                ...(tools ? { DM_PI_TOOL_URL: tools.url, DM_PI_TOOL_TOKEN: tools.token } : {}),
                TEMP: directory, TMP: directory, TMPDIR: directory
            });
            const child = spawn(process.execPath, [cli,
                '--mode', 'json', '--print', '--no-session', '--no-extensions', ...(extension ? ['-e', extension] : []),
                '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
                '--no-builtin-tools', '--no-mcp', '--thinking', 'off',
                '--provider', 'dm', '--model', model, '--session-id', sessionId,
                message
            ], { cwd: input.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            let stdout = '', stderr = '', overflow = false, timedOut = false, finished = false;
            const kill = () => { if (!finished) { try { child.kill(); } catch { /* already gone */ } } };
            const timeout = setTimeout(() => { timedOut = true; kill(); }, Math.max(30000, this.config().pi?.timeoutMs ?? 900000));
            const abort = () => kill();
            input.signal.addEventListener('abort', abort, { once: true });
            child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
            child.stdout!.on('data', (chunk: string) => { if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk; else overflow = true; });
            child.stderr!.on('data', (chunk: string) => { if (stderr.length < 65536) stderr += chunk; });
            const [code] = await once(child, 'close');
            finished = true; clearTimeout(timeout); input.signal.removeEventListener('abort', abort);
            if (input.signal.aborted) throw new DomainError('RUN_CANCELLED', 409);
            if (timedOut) throw new DomainError('PI_TURN_TIMEOUT', 504, 'Pi Agent 回合超过 Controller 规定的时限，已终止该子进程。');
            if (overflow) throw new DomainError('PI_OUTPUT_LIMIT', 502);
            const lines: Record<string, unknown>[] = [];
            for (const line of stdout.split(/\r?\n/)) {
                if (!line.trim()) continue;
                let parsed: unknown;
                try { parsed = JSON.parse(line); } catch { throw new DomainError('PI_OUTPUT_SCHEMA', 502, 'Pi Agent 输出了无法解析的事件行。'); }
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DomainError('PI_OUTPUT_SCHEMA', 502);
                lines.push(parsed as Record<string, unknown>);
            }
            const header = lines.find(entry => entry.type === 'session');
            if (!header || header.id !== sessionId || header.cwd !== input.workspace)
                throw new DomainError('PI_SESSION_UNVERIFIED', 409, 'Pi Agent 未回显本次派发的会话标识或工作目录。');
            const allowed = new Set(binding.tools);
            for (const entry of lines)
                if (entry.type === 'tool_execution_start' && (typeof entry.toolName !== 'string' || !allowed.has(entry.toolName)))
                    throw new DomainError('PI_UNEXPECTED_TOOL', 403, 'Pi Agent 调用了未授权的工具。');
            const settled = lines.find(entry => entry.type === 'agent_settled');
            if (!settled)
                throw new DomainError('PI_TURN_INCOMPLETE', 502, 'Pi Agent 没有以 agent_settled 结束本回合。');
            if (code !== 0) throw new DomainError('PI_TURN_FAILED', 502, `Pi Agent 退出码 ${String(code)}。`);
            const messages = lines.filter(entry => entry.type === 'message_end').map(entry => entry.message).filter((message): message is Record<string, unknown> => !!message && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).role === 'assistant');
            const lastAssistant: Record<string, unknown> | undefined = messages.length ? messages[messages.length - 1] : undefined;
            // A tool-using turn ends with an assistant message that holds only tool_use blocks. Reading text
            // from JUST the last message therefore reported PI_OUTPUT_SCHEMA on a turn that had produced a
            // complete answer earlier and then called a tool. The final answer is the last message that
            // actually carries text, not the chronologically last message.
            const textOf = (message: Record<string, unknown> | undefined): string => {
                const blocks = message?.content;
                return Array.isArray(blocks) ? blocks.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && !Array.isArray(block) && (block as Record<string, unknown>).type === 'text').map(block => String(block.text ?? '')).join('') : '';
            };
            const answering = [...messages].reverse().find(message => textOf(message).trim() !== '');
            const text = textOf(answering);
            const eventTypes: Record<string, number> = {};
            for (const entry of lines) if (typeof entry.type === 'string') eventTypes[entry.type] = (eventTypes[entry.type] ?? 0) + 1;
            const providerErrorEntry = lines.find(entry => {
                if (entry.type !== 'message_update') return false;
                const inner = entry.assistantMessageEvent;
                return !!inner && typeof inner === 'object' && !Array.isArray(inner) && (inner as Record<string, unknown>).type === 'error';
            });
            const inner = providerErrorEntry?.assistantMessageEvent as Record<string, unknown> | undefined;
            const rawUpstream = inner?.error;
            const upstream = rawUpstream && typeof rawUpstream === 'object' && !Array.isArray(rawUpstream) ? rawUpstream as Record<string, unknown> : undefined;
            const safeToken = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : null;
            const providerError = inner ? {
                reason: safeToken(inner.reason),
                status: typeof upstream?.status === 'number' && Number.isInteger(upstream.status) ? upstream.status : null,
                code: safeToken(upstream?.code)
            } : null;
            // Safe diagnostics only: counts and short codes, never prompt or model text.
            const diagnostics = () => onEvent({ method: 'dm/piDiagnostics', params: {
                lines: lines.length,
                eventTypes,
                settled: { present: true, aborted: settled.aborted === true },
                assistantMessages: messages.length,
                lastStopReason: safeToken(lastAssistant?.stopReason),
                lastContentTypes: Array.isArray(lastAssistant?.content) ? (lastAssistant.content as unknown[]).map(block => block && typeof block === 'object' && !Array.isArray(block) ? safeToken((block as Record<string, unknown>).type) : null).filter(value => value !== null) : [],
                providerError,
                stderrBytes: Buffer.byteLength(stderr, 'utf8')
            } });
            const stopReason = lastAssistant?.stopReason;
            if (settled.aborted === true || stopReason === 'aborted') {
                diagnostics();
                throw new DomainError('PI_TURN_ABORTED', 502, 'Pi Agent 本回合被中止，没有产生最终结果。');
            }
            // JSON print mode can exit zero with partial text after a provider error or truncation.
            if (stopReason === 'error' || (!lastAssistant && providerError)) {
                diagnostics();
                throw new DomainError('PI_PROVIDER_ERROR', 502, 'Pi Agent 的上游模型流在本回合中报错。');
            }
            // `stopReason` is a property of the LAST message, so a turn that answered and then called a tool
            // legitimately reports a tool-ish reason. The contract this guard protects is "a complete final
            // answer exists", not "the last message happened to end with stop".
            const answerStop = safeToken(answering?.stopReason);
            const answerSettled = answerStop === 'stop' || answerStop === 'endTurn' || answerStop === 'toolUse';
            if (!answerSettled || !text.trim()) {
                diagnostics();
                throw new DomainError('PI_OUTPUT_SCHEMA', 502, 'Pi Agent 没有产生完整的最终文本结果。');
            }
            binding.assertCurrent();
            const receipts = (gateway.receipts() as PiReceipt[]).filter(receipt => !!receipt && typeof receipt === 'object');
            const complete = receipts.filter(receipt => receipt.outcome === 'COMPLETE' && receipt.completionObserved === true);
            const actualModel = complete.length > 0 && complete.every(receipt => receipt.observedModel === model) ? model : undefined;
            if (actualModel === undefined) throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED', 409, '网关回执未能确认本次 Pi 回合的模型身份。');
            const last = complete[complete.length - 1];
            if (typeof last?.id !== 'string' || !last.id) throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED', 409);
            return {
                text, sessionId, model: actualModel,
                identity: { runner: 'PI_CLI', provider: binding.provider ?? 'deepseek-official', authentication: 'API_KEY', model: actualModel },
                usage: { role: binding.role, inputTokens: null, outputTokens: null, costUsd: null, source: 'UNKNOWN', requestId: last.id }
            };
        } finally {
            try { await tools?.close(); } finally {
                try { await gateway.close(); } finally {
                    onEvent({ method: 'dm/budget', params: { requests: gateway.receipts() } });
                    if (directory) try { rmSync(directory, { recursive: true, force: true }); } catch { /* evidence already emitted */ }
                }
            }
        }
    }
}
