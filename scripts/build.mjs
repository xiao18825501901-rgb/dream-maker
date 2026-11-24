import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, delimiter } from 'node:path';
const roots = [process.env.NODE_TYPES_PATH, resolve('node_modules/@types')].filter(Boolean);
for (const p of (process.env.NODE_PATH || '').split(delimiter).filter(Boolean))
    roots.push(resolve(p, 'pptxgenjs/node_modules/@types'), resolve(p, 'ts-node/node_modules/@types'));
const root = roots.find(p => existsSync(resolve(p, 'node/package.json')));
if (!root) {
    console.error('Build requires TypeScript 5.8.3 and @types/node 22.19.7. Install developer tools; runtime npm start needs no dependencies.');
    process.exit(1);
}
const local = resolve('node_modules/typescript/bin/tsc');
for (const config of ['tsconfig.json', 'tsconfig.web.json']) {
    const args = ['-p', config, ...(config === 'tsconfig.json' ? ['--typeRoots', root] : [])];
    const run = existsSync(local) ? spawnSync(process.execPath, [local, ...args], { stdio: 'inherit' }) : spawnSync(process.platform === 'win32' ? 'tsc.cmd' : 'tsc', args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (run.status !== 0)
        process.exit(run.status || 1);
}
mkdirSync('dist/web', { recursive: true });
for (const f of ['index.html', 'dreamflow.html', 'style.css', 'tokens.css', 'base.css', 'hallmark.css', 'chat-shell.css', 'chat-preview.html'])
    cpSync(`src/web/${f}`, `dist/web/${f}`);
// Reviewed, dependency-free ESM from the revamp kit. Keep its runtime validators;
// the existing TypeScript controller owns authentication, state and execution.
mkdirSync('dist/server/research', { recursive: true });
for (const file of ['common.mjs', 'repository-clients.mjs', 'reuse-policy.mjs', 'plan-contract.mjs', 'planning-pipeline.mjs', 'interview-input.mjs'])
    cpSync(`src/server/research/${file}`, `dist/server/research/${file}`);
mkdirSync('dist/server/flow', { recursive: true });
cpSync('src/server/flow/plain-report.mjs', 'dist/server/flow/plain-report.mjs');
cpSync('src/server/flow/scheduler.mjs', 'dist/server/flow/scheduler.mjs');
mkdirSync('dist/server/release', {recursive:true});
cpSync('src/server/release/component-inventory.mjs','dist/server/release/component-inventory.mjs');
console.log('Built TypeScript server and browser modules.');
