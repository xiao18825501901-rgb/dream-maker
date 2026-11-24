#!/usr/bin/env node
// The desktop shell: start the product server as a child, take the one-time bootstrap URL it prints,
// and hand it to Edge in app mode so the window has no address bar and no port to copy. When that
// window closes the server is stopped, so the app owns exactly one lifetime.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const data = resolve(process.env.DM_DATA ?? join(root, 'data'));
const port = Number(process.env.DM_PORT ?? 4317);
const edge = process.env.DM_EDGE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const window = process.env.DM_WINDOW ?? '1440,960';
const deadline = 45000;

if (!existsSync(edge)) { console.error('DESKTOP_EDGE_MISSING ' + edge); process.exit(2); }
mkdirSync(data, { recursive: true });

const server = spawn(process.execPath, [join(root, 'dist', 'server', 'main.js')], {
    cwd: root,
    env: { ...process.env, DM_PORT: String(port), DM_NO_OPEN_BROWSER: '1', DM_DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
});
let boot = null, buffered = '', tail = '';
const take = chunk => {
    buffered += chunk.toString();
    tail = (tail + chunk.toString()).slice(-1200);
    const match = buffered.match(/http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[0-9a-f]+/);
    if (match) { boot = match[0]; buffered = ''; }
};
server.stdout.on('data', take);
server.stderr.on('data', take);
server.on('exit', code => { if (!boot) { console.error('DESKTOP_SERVER_EXIT ' + code); console.error('DESKTOP_SERVER_LOG ' + JSON.stringify(tail)); process.exit(1); } });

const started = Date.now();
const wait = setInterval(() => {
    if (!boot) {
        if (Date.now() - started > deadline) { console.error('DESKTOP_BOOT_TIMEOUT'); server.kill(); process.exit(3); }
        return;
    }
    clearInterval(wait);
    console.log('DESKTOP_WINDOW ' + JSON.stringify({ port, matched: boot.length }));
    const browser = spawn(edge, [
        '--app=' + boot,
        '--window-size=' + window,
        '--user-data-dir=' + join(data, 'edge-profile'),
        '--no-first-run', '--no-default-browser-check',
    ], { stdio: 'ignore' });
    browser.on('exit', () => { console.log('DESKTOP_WINDOW_CLOSED'); server.kill(); process.exit(0); });
}, 250);
