// Actual local benign owner-death fixture. No model/protocol/audit fixture proof.
import { spawn } from 'node:child_process';
import { readFileSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WindowsJobSession } from '../../dist/server/flow/windows-job.js';
import { childEnv,hash } from '../../dist/server/security.js';
const root=fileURLToPath(new URL('../..',import.meta.url)),[entry,pidfile]=process.argv.slice(2);
const job=new WindowsJobSession(root,process.execPath,[entry,pidfile],root,childEnv());
spawn(job.command,job.args,{cwd:root,env:job.environment,stdio:'ignore',windowsHide:true}).unref();
await job.pin();
for(let i=0;i<200&&!existsSync(pidfile);i++)await new Promise(r=>setTimeout(r,25));
if(!existsSync(pidfile))throw Error('BENIGN_CHILD_NOT_OBSERVED');
const marker=readFileSync(job.markerPath);
console.log(JSON.stringify({jobId:job.jobId,markerSha256:hash(marker),helperSha256:hash(readFileSync(resolve(root,'scripts/isolation/windows-owned-job.cs'))),...JSON.parse(readFileSync(pidfile,'utf8'))}));
// The wrapper must detect this real owner death; it cannot depend on an in-memory finally callback.
process.exit(0);
