// Dedicated browser evidence instance using the actual standalone main/lock. No model credentials.
import { resolve } from 'node:path';
import { childEnv } from '../../dist/server/security.js';
const allowed=childEnv();
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,allowed,{DM_DATA_DIR:resolve('.runtime/revamp-20261101/dreamflow-browser-data'),DM_CONFIG:resolve('.runtime/revamp-20261101/dreamflow-browser-config.json'),DM_PORT:'0'});
await import('../../dist/server/dreamflow-main.js');
