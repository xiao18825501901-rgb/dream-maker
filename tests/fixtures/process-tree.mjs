import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' });
writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => { }, 1000);
