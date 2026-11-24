import { kimiBridgeLaunch, kimiBridgeConnectorLaunch, type BridgeLaunch } from './kimi-bridge-launcher.js';

/**
 * C03: the startup decision for the trusted bridge, kept as a pure function.
 *
 * The wiring lives in one place and the policy is testable without creating an app, a server or a
 * process. Default is "do not start": a bridge that starts because of an unrelated environment
 * variable would be exactly the kind of implicit authority this project refuses.
 */
export type BridgeStartupReason =
    | 'START'
    | 'BRIDGE_FLAG_OFF'
    | 'NO_KIMI_RUNNER'
    | 'NO_CREDENTIAL_AUTHORITY';

export interface BridgeStartupDecision {
    start: boolean;
    reason: BridgeStartupReason;
    launch: BridgeLaunch | null;
}

export function bridgeStartupDecision(input: {
    env: Record<string, string | undefined>;
    kimiRunnerConfigured: boolean;
    hasCredentialAuthority: boolean;
}): BridgeStartupDecision {
    if (input.env['DM_KIMI_BRIDGE'] !== '1')
        return { start: false, reason: 'BRIDGE_FLAG_OFF', launch: null };
    if (!input.kimiRunnerConfigured)
        return { start: false, reason: 'NO_KIMI_RUNNER', launch: null };
    if (!input.hasCredentialAuthority)
        return { start: false, reason: 'NO_CREDENTIAL_AUTHORITY', launch: null };
    // Two topologies, one decision:
    //  - connector (preferred): a bridge already listens inside the distro; we only connect to it,
    //    because starting a process across the WSL boundary proved unreliable on this machine;
    //  - spawn (legacy): we own the bridge process ourselves.
    // Either way the shape is validated HERE, so a bad configuration cannot half-start anything.
    if ((input.env['DM_KIMI_BRIDGE_SOCKET'] ?? '').length > 0) {
        const launch = kimiBridgeConnectorLaunch({
            distro: input.env['DM_KIMI_BRIDGE_DISTRO'] ?? '',
            socket: input.env['DM_KIMI_BRIDGE_SOCKET'] ?? '',
            connector: input.env['DM_KIMI_BRIDGE_CONNECTOR'] ?? ''
        });
        return { start: true, reason: 'START', launch };
    }
    const launch = kimiBridgeLaunch({
        distro: input.env['DM_KIMI_BRIDGE_DISTRO'] ?? '',
        script: input.env['DM_KIMI_BRIDGE_SCRIPT'] ?? '',
        home: input.env['DM_KIMI_BRIDGE_HOME'] ?? ''
    });
    return { start: true, reason: 'START', launch };
}
export interface BridgeRuntime {
    stop(): void;
    running(): boolean;
}

/**
 * Start the bridge only when the policy allows it. Kept separate from `createApp` so the whole
 * start/stop lifecycle can be exercised without building a web application around it — the previous
 * attempt to test this through the app produced a hang that could not be diagnosed, and an
 * undiagnosable test is worse than none.
 */
export async function startKimiBridgeIfConfigured(input: {
    env: Record<string, string | undefined>;
    kimiRunnerConfigured: boolean;
    authority?: { barrier(): string } & Parameters<typeof import('./kimi-bridge-controller.js').createKimiBridgeController>[0]['authority'];
    spawn: Parameters<typeof import('./kimi-bridge-controller.js').createKimiBridgeController>[0]['spawn'];
    instanceId?: string;
    accountRef?: string;
    onExit?: (info: { code: number | null; signal: string | null }) => void;
    /** Observability only: frames the controller exchanged, for a bounded local ledger. */
    onFrame?: (frame: import('./kimi-bridge-frames.js').BridgeFrame, direction: 'in' | 'out') => void;
}): Promise<{ decision: BridgeStartupDecision; runtime: BridgeRuntime | null }> {
    const { createKimiBridgeController } = await import('./kimi-bridge-controller.js');
    const decision = bridgeStartupDecision({
        env: input.env,
        kimiRunnerConfigured: input.kimiRunnerConfigured,
        hasCredentialAuthority: input.authority !== undefined
    });
    if (!decision.start || decision.launch === null || input.authority === undefined)
        return { decision, runtime: null };
    const controller = createKimiBridgeController({
        launch: decision.launch,
        spawn: input.spawn,
        authority: input.authority,
        instanceId: input.instanceId ?? 'dm-bridge',
        accountRef: input.accountRef ?? '',
        onExit: input.onExit,
        onFrame: input.onFrame
    });
    await controller.start();
    return { decision, runtime: { stop: () => controller.stop(), running: () => controller.running() } };
}
