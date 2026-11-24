import { createWindowsCredentialEncryption } from '../../dist/server/siwc/windows-credential-encryption.js';
import { createKimiTokenStore } from '../../dist/server/kimi-token-store.js';
import { createKimiCredentialAuthority, expiresAtMs } from '../../dist/server/kimi-credential-authority.js';
const dir = process.argv[2];
const encryption = createWindowsCredentialEncryption();
const authority = createKimiCredentialAuthority({ store: createKimiTokenStore({ dir, encryption }) });
const state = await authority.restore();
if (state.status !== "OK") { console.log(JSON.stringify({ status: state.status })); process.exit(0); }
const t = state.token;
const now = Date.now(), expMs = expiresAtMs(t);
console.log(JSON.stringify({ generation: state.generation, expiresAtUtc: new Date(expMs).toISOString(), expiresIn: t.expiresIn, remainingSec: Math.round((expMs - now) / 1000), withinRefreshThreshold: (expMs - now) <= (t.expiresIn / 2) * 1000 }));
