import { DomainError } from '../security.js';
import { normalizeWorkerState, type WorkerLifecycle } from './adapter.js';

/**
 * A06: the Orca CLI transport, as data.
 *
 * Nothing here starts a process. It builds the exact argv, validates the CLI's answer, and refuses
 * anything the plan says must be refused — which is why it can be fully tested offline while the
 * real Orca binary is still not installed or authorised.
 *
 * Rules encoded (plan §5/§8):
 *  - argv arrays only; never a shell string, so no path or id can smuggle a command;
 *  - the binary must be an absolute path (no PATH lookup surprises);
 *  - every call is `--json` and bounded in bytes; a truncated answer is an error, not a partial parse;
 *  - a non-zero exit is never parsed as data, and a "success" exit is never treated as a business
 *    outcome (worker_done is a report, not acceptance);
 *  - `--terminal` is an Orca handle, never a process id we invent.
 */
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const ABSOLUTE = /^(?:[A-Za-z]:\\|\\\\|\/)/;

export interface OrcaExecResult {
    code: number | null;
    stdout: string;
    stderr?: string;
    /** True when the runner killed the child for exceeding the timeout. */
    timedOut?: boolean;
}

export type OrcaExec = (input: { argv: string[]; cwd?: string; timeoutMs: number; maxBytes: number }) => Promise<OrcaExecResult>;

export function assertAbsoluteBinary(binary: string): string {
    if (typeof binary !== 'string' || binary.length === 0 || !ABSOLUTE.test(binary))
        throw new DomainError('ORCA_BINARY_NOT_ABSOLUTE', 409, 'Orca CLI 必须是绝对路径；不依赖 PATH 查找。');
    if (/\s/.test(binary))
        throw new DomainError('ORCA_BINARY_INVALID', 409, 'Orca CLI 路径不能包含空白字符。');
    return binary;
}

/** Build the argv for one pinned subcommand. `parts` are literal tokens, never user text. */
export function orcaArgv(subcommand: readonly string[], ids: Record<string, string> = {}): string[] {
    if (subcommand.length === 0)
        throw new DomainError('ORCA_SUBCOMMAND_REQUIRED', 409, '缺少子命令。');
    const argv: string[] = [];
    for (const part of subcommand) {
        if (typeof part !== 'string' || part.length === 0 || /[\s;&|$`>]/.test(part))
            throw new DomainError('ORCA_ARGUMENT_INVALID', 409, '参数含空白或 shell 元字符；拒绝构造命令。');
        argv.push(part);
    }
    for (const [flag, value] of Object.entries(ids)) {
        if (!/^--[a-z][a-z-]*$/.test(flag))
            throw new DomainError('ORCA_FLAG_INVALID', 409, '只允许形如 --run/--dispatch 的显式标志。');
        if (typeof value !== 'string' || value.length === 0 || value.length > 200 || /[\s;&|$`>]/.test(value))
            throw new DomainError('ORCA_ID_INVALID', 409, '标识符含空白或 shell 元字符；拒绝。');
        argv.push(flag, value);
    }
    // Every read is JSON; there is no human-output parsing path.
    if (!argv.includes('--json')) argv.push('--json');
    return argv;
}

/** Which upstream calls the adapter is allowed to make. Anything else is a bug, not an extension. */
export const ORCA_COMMANDS = {
    status: ['status'],
    workerList: ['orchestration', 'worker-list'],
    workerShow: ['orchestration', 'worker-show'],
    workerRead: ['orchestration', 'worker-read'],
    workerStop: ['orchestration', 'worker-stop'],
    workerRelease: ['orchestration', 'worker-release']
} as const;

export function parseJsonAnswer(result: OrcaExecResult): unknown {
    if (result.timedOut === true)
        throw new DomainError('ORCA_CLI_TIMEOUT', 504, 'Orca CLI 超时；结果未知，先对账再重试。');
    if (result.code !== 0)
        throw new DomainError('ORCA_CLI_FAILED', 502, 'Orca CLI 非零退出；拒绝把失败当数据。');
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES)
        throw new DomainError('ORCA_OUTPUT_TOO_LARGE', 502, 'Orca CLI 输出超过上限；拒绝解析截断内容。');
    const trimmed = stdout.trim();
    if (trimmed.length === 0)
        throw new DomainError('ORCA_OUTPUT_EMPTY', 502, 'Orca CLI 没有返回内容。');
    try {
        return JSON.parse(trimmed);
    }
    catch {
        throw new DomainError('ORCA_OUTPUT_NOT_JSON', 502, 'Orca CLI 输出不是 JSON；不猜测结构。');
    }
}

export async function runOrca(input: {
    binary: string;
    subcommand: readonly string[];
    ids?: Record<string, string>;
    cwd?: string;
    exec: OrcaExec;
    timeoutMs?: number;
    maxBytes?: number;
}): Promise<unknown> {
    const binary = assertAbsoluteBinary(input.binary);
    const argv = [binary, ...orcaArgv(input.subcommand, input.ids)];
    const result = await input.exec({ argv, cwd: input.cwd, timeoutMs: input.timeoutMs ?? COMMAND_TIMEOUT_MS, maxBytes: input.maxBytes ?? MAX_OUTPUT_BYTES });
    return parseJsonAnswer(result);
}

export interface WorkerRow {
    dispatchId: string;
    lifecycle: WorkerLifecycle;
    rawStatus: string;
}

/**
 * Normalise `worker-list` rows. Unknown statuses become UNKNOWN via the adapter's mapping: forwarding
 * an unrecognised word upward is how a supervisor's vocabulary turns into an acceptance decision.
 */
export function parseWorkerRows(json: unknown): WorkerRow[] {
    const list = (json as { workers?: unknown; data?: unknown })?.workers ?? (json as { data?: unknown })?.data;
    if (!Array.isArray(list))
        throw new DomainError('ORCA_WORKER_LIST_INVALID', 502, 'worker-list 响应缺少数组。');
    return list.map((entry, index) => {
        const row = entry as Record<string, unknown>;
        const dispatchId = typeof row['dispatchId'] === 'string' ? row['dispatchId'] : (typeof row['dispatch_id'] === 'string' ? row['dispatch_id'] : '');
        if (dispatchId.length === 0 || dispatchId.length > 200 || /\s/.test(dispatchId))
            throw new DomainError('ORCA_WORKER_LIST_INVALID', 502, `第 ${index} 行缺少合法的 dispatchId。`);
        const rawStatus = typeof row['status'] === 'string' ? row['status'] : '';
        return { dispatchId, lifecycle: normalizeWorkerState({ status: rawStatus }), rawStatus };
    });
}

/** `worker-read` returns a cursor bound to one source; the caller must not splice a changed source. */
export function parseWorkerRead(json: unknown): { cursor: { source: string; value: string }; entries: unknown[] } {
    const payload = json as { cursor?: unknown; source?: unknown; entries?: unknown };
    const source = typeof payload?.source === 'string' ? payload.source : '';
    const value = typeof payload?.cursor === 'string' ? payload.cursor : '';
    const entries = Array.isArray(payload?.entries) ? payload.entries : null;
    if (source.length === 0 || value.length === 0 || entries === null)
        throw new DomainError('ORCA_WORKER_READ_INVALID', 502, 'worker-read 响应缺少 source/cursor/entries。');
    return { cursor: { source, value }, entries };
}

export { MAX_OUTPUT_BYTES, COMMAND_TIMEOUT_MS };
