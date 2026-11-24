#!/usr/bin/env node
// Does a wsl.exe-spawned connector with a piped stdin work at all? Speak frames through it to the
// socket-mode bridge (which owns the synthetic child) and see whether the ACK round trip completes.
import { spawn } from 'node:child_process';
import { encodeFrame, createFrameDecoder, PROTOCOL_VERSION, STORAGE_NAME } from '../../dist/server/kimi-bridge-frames.js';

const [distro, sockPath] = [process.argv[2], process.argv[3]];
const child = spawn('wsl.exe', ['-d', distro, '-u', 'root', '--', '/usr/bin/python3', '/tmp/dm-bridge-smoke/connect.py', sockPath], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
const decoder = createFrameDecoder();
const seen = [];
let err = '';
child.stderr.on('data', c => { err += c.toString(); });
child.stdout.on('data', chunk => {
    for (const frame of decoder.push(chunk)) {
        seen.push(frame.type);
        if (frame.type === 'ROTATE') {
            child.stdin.write(encodeFrame({ type: 'COMMIT_ACK', protocolVersion: PROTOCOL_VERSION, instanceId: 'probe', storageName: STORAGE_NAME, generation: frame.generation, messageId: frame.messageId }));
        }
    }
});
const frame = (type, extra) => encodeFrame({ type, protocolVersion: PROTOCOL_VERSION, instanceId: 'probe', storageName: STORAGE_NAME, ...extra });
setTimeout(() => { child.stdin.write(frame('HELLO', {})); child.stdin.write(frame('RESTORE', { token: {} })); }, 1500);
setTimeout(() => {
    console.log('SEEN', JSON.stringify(seen));
    console.log('STDERR', JSON.stringify(err.slice(-200)));
    console.log(seen.includes('ROTATE') ? 'RELAY_OK' : 'RELAY_FAILED');
    child.kill();
    process.exit(0);
}, 9000);
