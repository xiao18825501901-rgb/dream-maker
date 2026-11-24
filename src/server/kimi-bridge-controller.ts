import { DomainError } from './security.js';
import { type BridgeFrame } from './kimi-bridge-frames.js';
import { createBridgeSession, assertBridgeStartable, type BridgeSession } from './kimi-bridge-session.js';
import { createBridgeProcess, type BridgeLaunch, type BridgeProcess, type SpawnImpl } from './kimi-bridge-launcher.js';
import type { KimiCredentialAuthority } from './kimi-credential-authority.js';

/**
 * C03/C04: controller-side assembly.
 *
 * One object owns the whole trusted channel: the process (launcher), the protocol (session) and the
 * durable state (authority). Callers get a single `start()/stop()` pair and cannot assemble the
 * parts in a way that skips the ACK rule — the session, not the caller, decides when a rotation is
 * acknowledged.
 *
 * The spawn implementation stays injectable: the assembly is covered offline with a recording
 * child, and the real `wsl.exe` path differs only by which spawn function is handed in.
 */
export interface BridgeController {
    start(): Promise<void>;
    stop(): void;
    session(): BridgeSession;
    process(): BridgeProcess | undefined;
    running(): boolean;
    /** Exit information once the child settled. */
    exit(): { code: number | null; signal: string | null } | undefined;
}

export function createKimiBridgeController(options: {
    launch: BridgeLaunch;
    spawn: SpawnImpl;
    authority: KimiCredentialAuthority;
    instanceId: string;
    accountRef: string;
    onFrame?: (frame: BridgeFrame, direction: 'in' | 'out') => void;
    onExit?: (info: { code: number | null; signal: string | null }) => void;
}): BridgeController {
    const { launch, spawn, authority, instanceId, accountRef } = options;
    let process: BridgeProcess | undefined;
    let session: BridgeSession | undefined;
    let exitInfo: { code: number | null; signal: string | null } | undefined;

    return {
        async start() {
            if (process)
                throw new DomainError('KIMI_BRIDGE_ALREADY_STARTED', 409, '桥控制器已经启动；拒绝第二个实例。');
            // The barrier is checked here too: handing out credentials before RESTORE is an ordering
            // bug, and this is the last place where it can still be refused cheaply.
            assertBridgeStartable(authority);
            const proc = createBridgeProcess({
                launch,
                spawn,
                onBytes: chunk => session?.onBytes(chunk),
                onExit: info => { exitInfo = info; options.onExit?.(info); }
            });
            const bridge = createBridgeSession({
                instanceId,
                accountRef,
                send: bytes => proc.write(bytes),
                authority,
                // Both directions are reported once, by the session, so a ledger cannot double-count.
                onFrame: options.onFrame
            });
            process = proc;
            session = bridge;
            proc.start();
            await bridge.start();
        },
        stop() { process?.stop(); },
        session() {
            if (!session) throw new DomainError('KIMI_BRIDGE_NOT_STARTED', 409, '桥还没启动。');
            return session;
        },
        process: () => process,
        running: () => process !== undefined && exitInfo === undefined,
        exit: () => exitInfo
    };
}
