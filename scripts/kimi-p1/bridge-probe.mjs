#!/usr/bin/env node
// C03 diagnostic: which launch form actually starts the supervised Kimi server under wsl.exe?
// Both probes use Node's spawn(shell:false) — the pwsh reproduction is NOT equivalent because
// wsl.exe re-assembles the command line and drops quoting on the way through.
import { spawn } from 'node:child_process';

const DISTRO = 'DreamMaker-Acceptance-20261011';
const HOME = '/opt/dream-maker-controller/kimi-home-2.2.0';
const DIST = '/opt/dream-maker-controller/kimi-source-472192c/apps/kimi-code/dist/main.mjs';
const NODE = '/opt/dream-maker-controller/toolchain/node-v24.22.0-linux-x64/bin/node';
const BRIDGE = '/tmp/dm-bridge-smoke/bridge.py';

function run(argv, label, seconds) {
    return new Promise(resolve => {
        const child = spawn('wsl.exe', argv, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let err = '', out = '';
        child.stdout.on('data', c => { out += c.toString(); });
        child.stderr.on('data', c => { err += c.toString(); });
        child.on('error', e => { err += 'SPAWN_ERROR ' + e.message; });
        // Keep stdin open exactly like the controller does.
        const timer = setTimeout(() => {
            child.kill();
            setTimeout(() => resolve({ label, out, err }), 300);
        }, seconds * 1000);
        child.on('exit', () => { clearTimeout(timer); resolve({ label, out, err }); });
    });
}

async function readLogs(dir) {
    return await new Promise(resolve => {
        const child = spawn('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', '/bin/bash', '-lc',
            'for f in child.status child.out child.err; do echo "== $f =="; head -4 ' + dir + '/$f 2>/dev/null || echo MISSING; done'
        ], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', c => { out += c.toString(); });
        child.on('exit', () => resolve(out.trim()));
        child.on('error', () => resolve(''));
    });
}

const portA = '58641', portB = '58642';
const dirA = '/tmp/dm-bridge-smoke/probeA', dirB = '/tmp/dm-bridge-smoke/probeB';
const childArgs = (port) => [NODE, DIST, 'web', '--no-open', '--port', port];

// A: direct exec of the bridge (current production shape).
const argvA = ['-d', DISTRO, '-u', 'root', '--', '/usr/bin/python3', BRIDGE, '--home', HOME, '--log-dir', dirA, '--', ...childArgs(portA)];
// B: bash -lc wrapper with one string.
const line = '/usr/bin/python3 ' + BRIDGE + ' --home ' + HOME + ' --log-dir ' + dirB + ' -- ' + childArgs(portB).join(' ');
const argvB = ['-d', DISTRO, '-u', 'root', '--', '/bin/bash', '-lc', line];

console.log('A_ARGV', JSON.stringify(argvA));
const a = await run(argvA, 'A', 8);
console.log('A_STDERR', JSON.stringify(a.err.slice(-300)));
console.log('A_LOGS\n' + await readLogs(dirA));

console.log('B_ARGV', JSON.stringify(argvB));
const b = await run(argvB, 'B', 8);
console.log('B_STDERR', JSON.stringify(b.err.slice(-300)));
console.log('B_LOGS\n' + await readLogs(dirB));

const aOk = a.err === '' && (await readLogs(dirA)).includes('pid=');
const bOk = (await readLogs(dirB)).includes('pid=');
console.log('PROBE_A_STARTED', aOk);
console.log('PROBE_B_STARTED', bOk);
process.exit(0);
