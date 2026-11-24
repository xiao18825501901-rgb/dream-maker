// Dedicated real-HTTP UI test instance. Never inherit controller/model authentication.
import { childEnv } from '../../dist/server/security.js';
const allowed = childEnv();
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, allowed);
await import('../fixtures/browser-server.mjs');
