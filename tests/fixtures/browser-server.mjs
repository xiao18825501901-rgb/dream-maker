// Browser acceptance fixture: actual HTTP application, fixed demo delay for controls.
import { createApp } from '../../dist/server/http.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const app = await createApp({ root, data: process.argv[2], configPath: resolve(process.argv[2], 'config.json'), port: 0, demoDelayMs: 450 });
console.log(JSON.stringify({ url: app.bootstrapUrl, origin: app.origin }));
let stopped = false;
async function close() { if (stopped)
    return; stopped = true; await app.close(); process.exit(0); }
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
