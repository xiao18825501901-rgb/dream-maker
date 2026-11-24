import { DomainError } from './security.js';
import { redactAuthMessage } from './kimi-auth-errors.js';

/**
 * C03/C04: the process layer for the trusted byte channel.
 *
 * Shape only — no shell string, no Windows-side cwd reuse, an explicit environment allowlist, and a
 * bounded, redacted stderr. The spawn implementation is injected so the entire layer is testable
 * offline; wiring it to the real `wsl.exe` is a small, reviewable step on top.
 *
 * Hard rules encoded here:
 *  - `shell: false` always: an argv array cannot smuggle a command through a shell;
 *  - the Linux side gets ONLY the allowlisted variables — never the Windows environment wholesale;
 *  - stderr is never trusted: it is truncated and redacted before it can reach a log;
 *  - one process per session; a second start is refused instead of silently spawning a twin.
 */
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const POSIX_SEGMENT = /^(?!\.$)(?!\.\.$)[A-Za-z0-9._-]+$/;

export function isSafePosixPath(value: string): boolean {
    if (typeof value !== 'string' || !value.startsWith('/') || value.length > 400) return false;
    const segments = value.slice(1).split('/');
    return segments.length > 0 && segments.every(s => POSIX_SEGMENT.test(s));
}

export interface BridgeLaunchOptions {
    distro: string;
    /** Absolute POSIX path of the Linux bridge script inside the distro. */
    script: string;
    /** Isolated Linux home for the Kimi process. */
    home: string;
    /**
     * Optional absolute POSIX interpreter (e.g. /usr/bin/python3). Omitted means the script is executed
     * directly through its shebang — the previous version always used bash, which silently tried to
     * run a Python bridge as a shell script.
     */
    interpreter?: string;
    /** Windows-side command; defaults to wsl.exe. Kept as data so it can be pinned. */
    command?: string;
    /**
     * The Linux child the bridge owns (e.g. the pinned node + dist/main.mjs + web flags). Passed to
     * the script after `--`; without it the bridge has nothing to supervise, which is exactly the
     * gap that made the earlier launch shape untestable end to end.
     */
    child?: readonly string[];
}

export interface BridgeLaunch {
    command: string;
    args: string[];
    env: Record<string, string>;
}

export function kimiBridgeLaunch(options: BridgeLaunchOptions): BridgeLaunch {
    const distro = options.distro ?? '';
    if (!DISTRO.test(distro))
        throw new DomainError('KIMI_BRIDGE_DISTRO_INVALID', 409, 'WSL 发行版名不合法；不做 shell 拼接。');
    const script = options.script ?? '';
    if (!isSafePosixPath(script))
        throw new DomainError('KIMI_BRIDGE_SCRIPT_INVALID', 409, '桥脚本必须是安全的绝对 POSIX 路径。');
    const home = options.home ?? '';
    if (!isSafePosixPath(home))
        throw new DomainError('KIMI_BRIDGE_HOME_INVALID', 409, '桥必须使用隔离的绝对 POSIX home。');
    const interpreter = options.interpreter;
    if (interpreter !== undefined && !isSafePosixPath(interpreter))
        throw new DomainError('KIMI_BRIDGE_SHELL_INVALID', 409, '解释器必须是安全的绝对 POSIX 路径。');
    const child = options.child ?? [];
    if (child.length > 0) {
        if (!isSafePosixPath(child[0]))
            throw new DomainError('KIMI_BRIDGE_CHILD_INVALID', 409, '桥的子进程必须从绝对 POSIX 路径开始。');
        for (const token of child) {
            if (typeof token !== 'string' || token.length === 0 || /\s/.test(token))
                throw new DomainError('KIMI_BRIDGE_CHILD_INVALID', 409, '桥的子进程参数不能为空或含空白。');
        }
    }
    return {
        command: options.command ?? 'wsl.exe',
        args: ['-d', distro, '--', ...(interpreter === undefined ? [script] : [interpreter, script]), '--home', home, ...(child.length > 0 ? ['--', ...child] : [])],
        // Explicit allowlist. No PATH inheritance from Windows, no proxy variables, no tokens.
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, KIMI_CODE_HOME: home, LANG: 'C.UTF-8', DM_KIMI_BRIDGE: '1' }
    };
}

/**
 * Connector launch: instead of owning the Kimi process from Windows (which proved unreliable across
 * the WSL boundary on this machine), connect to a bridge that already listens inside the distro.
 * The Windows side becomes a transparent byte relay and nothing else.
 */
export function kimiBridgeConnectorLaunch(options: { distro: string; socket: string; connector: string; python?: string; waitSeconds?: number }): BridgeLaunch {
    const distro = options.distro ?? '';
    if (!DISTRO.test(distro))
        throw new DomainError('KIMI_BRIDGE_DISTRO_INVALID', 409, 'WSL 发行版名不合法；不做 shell 拼接。');
    if (!isSafePosixPath(options.socket))
        throw new DomainError('KIMI_CONNECTOR_SOCKET_INVALID', 409, '连接器必须使用安全的绝对 POSIX socket 路径。');
    if (!isSafePosixPath(options.connector))
        throw new DomainError('KIMI_CONNECTOR_SCRIPT_INVALID', 409, '连接器脚本必须是安全的绝对 POSIX 路径。');
    const python = options.python ?? '/usr/bin/python3';
    if (!isSafePosixPath(python))
        throw new DomainError('KIMI_CONNECTOR_PYTHON_INVALID', 409, '解释器必须是安全的绝对 POSIX 路径。');
    // A bounded wait lets the controller connect while the bridge is still starting. It is explicit
    // and finite; there is no silent infinite retry.
    const wait = options.waitSeconds;
    if (wait !== undefined && (!Number.isFinite(wait) || wait < 0 || wait > 120))
        throw new DomainError('KIMI_CONNECTOR_WAIT_INVALID', 409, '连接等待必须是 0..120 秒之间的数值。');
    return {
        command: 'wsl.exe',
        args: ['-d', distro, '-u', 'root', '--', python, options.connector, options.socket, ...(wait === undefined ? [] : [String(wait)])],
        // The connector starts nothing, so the Linux environment allowlist is irrelevant here; the
        // bridge it connects to owns that boundary.
        env: {}
    };
}

export interface ChildLike {
    stdout: { on(event: 'data', cb: (chunk: Buffer) => void): unknown };
    stderr: { on(event: 'data', cb: (chunk: Buffer) => void): unknown };
    stdin: { write(chunk: Buffer): unknown; end(): unknown };
    on(event: 'exit' | 'error', cb: (arg: unknown) => void): unknown;
    kill(signal?: string): unknown;
}

export type SpawnImpl = (command: string, args: string[], options: Record<string, unknown>) => ChildLike;

export interface BridgeProcess {
    start(): void;
    write(bytes: Buffer): void;
    stop(): void;
    started(): boolean;
    /** Redacted, bounded stderr lines observed so far. */
    diagnostics(): string[];
    /** Exit information, if the child has settled. */
    exit(): { code: number | null; signal: string | null } | undefined;
}

export function createBridgeProcess(options: {
    launch: BridgeLaunch;
    spawn: SpawnImpl;
    onBytes: (chunk: Buffer) => void;
    onExit?: (info: { code: number | null; signal: string | null }) => void;
    maxStderrLines?: number;
}): BridgeProcess {
    const { launch, spawn, onBytes } = options;
    const maxLines = options.maxStderrLines ?? 20;
    const diagnostics: string[] = [];
    let child: ChildLike | undefined;
    let settled: { code: number | null; signal: string | null } | undefined;

    return {
        start() {
            if (child)
                throw new DomainError('KIMI_BRIDGE_ALREADY_STARTED', 409, '同一个会话只能有一个桥进程；拒绝再起一个。');
            child = spawn(launch.command, launch.args, {
                shell: false,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                // The Windows-side process must inherit the Windows environment: replacing PATH with
                // the POSIX one makes `wsl.exe` unresolvable (observed as ENOENT). The Linux child's
                // environment is a separate boundary and is enforced inside bridge.py, which only
                // forwards its own allowlist.
                env: process.env
            });
            child.stdout.on('data', chunk => onBytes(chunk));
            child.stderr.on('data', (chunk: Buffer) => {
                const line = redactAuthMessage(chunk.toString('utf8'), 160);
                if (line.length > 0 && diagnostics.length < maxLines) diagnostics.push(line);
            });
            const settle = (code: number | null, signal: string | null) => {
                settled = { code, signal };
                options.onExit?.(settled);
            };
            // Node hands the exit code and signal as TWO ARGUMENTS; the recording child used by the
            // tests emits one {code, signal} object. Reading only the object shape silently produced
            // {code:null, signal:null} for every REAL exit, so a dead connector could never report why
            // it died. Accept both shapes explicitly.
            child.on('exit', (arg: unknown, signalArg?: unknown) => {
                const asObject = (arg !== null && typeof arg === 'object') ? arg as { code?: unknown; signal?: unknown } : undefined;
                const code = typeof arg === 'number' ? arg : typeof asObject?.code === 'number' ? asObject.code : null;
                const signal = typeof signalArg === 'string' ? signalArg : typeof asObject?.signal === 'string' ? asObject.signal : null;
                settle(code, signal);
            });
            // A spawn failure (missing wsl.exe, denied pipe) settles the session instead of hanging.
            // Keep the reason: "the spawn failed" without a message is exactly the kind of blind
            // error that makes an integration problem look mysterious.
            child.on('error', (arg: unknown) => {
                const message = String((arg as { message?: unknown })?.message ?? arg ?? 'unknown');
                if (diagnostics.length < maxLines) diagnostics.push('SPAWN_ERROR ' + message.slice(0, 160));
                settle(null, 'SPAWN_ERROR');
            });
            // A write that races the child's death lands on a closed pipe: the EPIPE arrives as an
            // 'error' EVENT on stdin, and an unhandled one is a thrown event rather than a rejected
            // call. Settle the session so write() then refuses with KIMI_BRIDGE_CLOSED.
            const stdinOn = (child.stdin as unknown as { on?: (ev: string, cb: (error: unknown) => void) => void } | undefined)?.on;
            if (typeof stdinOn === 'function')
                stdinOn.call(child.stdin, 'error', (error: unknown) => {
                    const message = String((error as { message?: unknown })?.message ?? error ?? 'unknown');
                    if (diagnostics.length < maxLines) diagnostics.push('STDIN_ERROR ' + message.slice(0, 160));
                    settle(null, 'STDIN_ERROR');
                });
        },
        write(bytes) {
            if (!child) throw new DomainError('KIMI_BRIDGE_NOT_STARTED', 409, '桥还没启动。');
            // Writing into a dead channel must fail loudly: an EPIPE swallowed by the stream would
            // look exactly like "frame sent", and the caller would then wait for an ACK forever.
            if (settled) throw new DomainError('KIMI_BRIDGE_CLOSED', 409, '桥已结束；拒绝向已关闭的通道写帧。');
            child.stdin.write(bytes);
        },
        stop() {
            if (!child || settled) return;
            try { child.stdin.end(); } catch { /* ignore */ }
            try { child.kill(); } catch { /* ignore */ }
        },
        started: () => child !== undefined,
        diagnostics: () => [...diagnostics],
        exit: () => settled
    };
}
