// Disposable actual-OS parent-death fixture; no credentials or model API.
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { WslSandbox } from '../../dist/server/wsl-sandbox.js';
const [workspace,jobId,resultPath]=process.argv.slice(2);
await new WslSandbox(resolve('.')).run(workspace,{runtime:'python',entry:'sleep.py',args:[],stdin:''},{jobId,wallSeconds:60,onResult:r=>writeFileSync(resultPath,JSON.stringify(r))});
