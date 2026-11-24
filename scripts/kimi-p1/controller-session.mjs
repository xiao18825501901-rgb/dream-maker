#!/usr/bin/env node
// HA-002: the controller that stays connected while the user performs the real device OAuth.
// It owns the durable DPAPI store, so every ROTATE the patched Kimi storage emits is committed and
// only then acknowledged — the login cannot "succeed" without a durable record.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createWindowsCredentialEncryption } from '../../dist/server/siwc/windows-credential-encryption.js';
import { createKimiTokenStore } from '../../dist/server/kimi-token-store.js';
import { createKimiCredentialAuthority } from '../../dist/server/kimi-credential-authority.js';
import { kimiBridgeConnectorLaunch } from '../../dist/server/kimi-bridge-launcher.js';
import { createKimiBridgeController } from '../../dist/server/kimi-bridge-controller.js';

const [socket, storeDir, accountRef] = process.argv.slice(2);
const distro = 'DreamMaker-Acceptance-20261011';
const connector = '/tmp/dm-bridge-smoke/connect.py';
if (!socket || !storeDir || !accountRef) { console.error("usage: controller-session.mjs <socket> <storeDir> <accountRef>"); process.exit(2); }

const encryption = createWindowsCredentialEncryption();
console.log('DPAPI_AVAILABLE', await encryption.isAvailable());
mkdirSync(storeDir, { recursive: true, mode: 0o700 });
const authority = createKimiCredentialAuthority({ store: createKimiTokenStore({ dir: storeDir, encryption }) });
const restored = await authority.restore();
console.log('RESTORE', restored.status, 'BARRIER', authority.barrier());

const launch = kimiBridgeConnectorLaunch({ distro, socket, connector, waitSeconds: 20 });
const controller = createKimiBridgeController({
    launch, spawn, authority, instanceId: "dm-controller", accountRef,
    onExit: info => console.log("EXIT", JSON.stringify(info))
});
await controller.start();
// M1: mirror the WSL management token to a Windows-readable file (current-user only) so the
// product app can talk to the Kimi server it does not own. This is the *management* bearer, not the
// OAuth token; it is also already on disk inside the distro with 0600.
const mirrorPath = process.env.DM_KIMI_TOKEN_MIRROR;
if (mirrorPath) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    try {
        const token = execFileSync('wsl.exe', ['-d', distro, '-u', 'root', '--', '/bin/cat', '/opt/dream-maker-controller/kimi-home-2.2.0/server.token'], { encoding: 'utf8' }).trim();
        mkdirSync(dirname(mirrorPath), { recursive: true });
        writeFileSync(mirrorPath, token, { mode: 0o600 });
        console.log('MIRROR_WRITTEN', mirrorPath, token.length);
    } catch (error) {
        console.log('MIRROR_FAILED', String(error?.message ?? error).slice(0, 120));
    }
}
console.log('SENT', controller.session().sent().map(f => f.type).join(','));

setInterval(() => {
    const sent = controller.session().sent();
    const acks = sent.filter(f => f.type === "COMMIT_ACK").map(f => f.generation);
    const errors = sent.filter(f => f.type === "ERROR").map(f => f.code);
    const current = authority.current();
    console.log("TICK", JSON.stringify({ frames: sent.length, acks, errors, state: current.status, generation: current.status === "OK" ? current.generation : null, closed: controller.session().closed() }));
}, 5000).unref?.();

process.on("SIGTERM", () => { controller.stop(); process.exit(0); });
process.on("SIGINT", () => { controller.stop(); process.exit(0); });