#!/usr/bin/env node
// C03: does a real DPAPI round trip survive a process boundary?
//
// mode=write : commit a synthetic TokenInfo through the authority (encrypts with CurrentUser DPAPI)
// mode=read  : a NEW process restores from the same directory and must see the same generation/token
// mode=plain : report whether the on-disk bytes contain any plaintext token fragment
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createWindowsCredentialEncryption } from "../../dist/server/siwc/windows-credential-encryption.js";
import { createKimiTokenStore } from "../../dist/server/kimi-token-store.js";
import { createKimiCredentialAuthority } from "../../dist/server/kimi-credential-authority.js";

const [mode, dir] = [process.argv[2], process.argv[3]];
const encryption = createWindowsCredentialEncryption();
const available = await encryption.isAvailable();
if (!available) { console.log("DPAPI_UNAVAILABLE"); process.exit(3); }

const token = { accessToken: "DPAPI_ROUNDTRIP_ACCESS", refreshToken: "DPAPI_ROUNDTRIP_REFRESH", expiresAt: Date.now() + 3600000, expiresIn: 3600, scope: "kimi-code", tokenType: "Bearer" };

if (mode === "write") {
    const authority = createKimiCredentialAuthority({ store: createKimiTokenStore({ dir, encryption }) });
    const restored = await authority.restore();
    const ack = await authority.commit({ token, generation: 1, messageId: "dpapi-1" });
    console.log(JSON.stringify({ restored: restored.status, ack }));
    process.exit(0);
}

if (mode === "read") {
    const authority = createKimiCredentialAuthority({ store: createKimiTokenStore({ dir, encryption }) });
    const restored = await authority.restore();
    const current = authority.current();
    const ok = restored.status === "OK" && current.status === "OK" && current.generation === 1 && current.token.accessToken === token.accessToken;
    console.log(JSON.stringify({ status: restored.status, generation: current.status === "OK" ? current.generation : null, sameAccess: current.status === "OK" ? current.token.accessToken === token.accessToken : false }));
    console.log(ok ? "DPAPI_ROUNDTRIP_OK" : "DPAPI_ROUNDTRIP_FAILED");
    process.exit(ok ? 0 : 1);
}

if (mode === "plain") {
    const files = readdirSync(dir);
    const blobs = files.map(f => readFileSync(resolve(dir, f)));
    const joined = Buffer.concat(blobs).toString("latin1");
    const leaked = ["DPAPI_ROUNDTRIP_ACCESS", "DPAPI_ROUNDTRIP_REFRESH", "accessToken"].filter(s => joined.includes(s));
    console.log(JSON.stringify({ files, leaked }));
    console.log(leaked.length === 0 ? "NO_PLAINTEXT_ON_DISK" : "PLAINTEXT_LEAK");
    process.exit(leaked.length === 0 ? 0 : 1);
}

console.log("usage: dpapi-roundtrip.mjs write|read|plain <dir>");
process.exit(2);
