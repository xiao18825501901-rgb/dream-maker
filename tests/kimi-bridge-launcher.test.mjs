import test from 'node:test';
import assert from 'node:assert/strict';
import { kimiBridgeLaunch, createBridgeProcess, isSafePosixPath, kimiBridgeConnectorLaunch } from '../dist/server/kimi-bridge-launcher.js';

// C03/C04 process layer. The spawn implementation is a recorder, so nothing is executed:
// these tests pin the launch SHAPE (argv/env/stdio), the guards, and the stderr hygiene.

const launch = over => kimiBridgeLaunch({ distro: 'DreamMaker-Acceptance-20261011', script: '/opt/dm/bridge.py', home: '/opt/dm/home', ...over });

function fakeSpawn() {
    const calls = [];
    const listeners = {};
    const child = {
        stdout: { on: (ev, cb) => { listeners.stdout = cb; } },
        stderr: { on: (ev, cb) => { listeners.stderr = cb; } },
        stdin: { writes: [], write(b) { this.writes.push(b); }, end() { this.ended = true; } },
        on: (ev, cb) => { listeners[ev] = cb; },
        kill() { this.killed = true; },
        emit: (ev, arg) => listeners[ev]?.(arg)
    };
    return {
        calls, listeners, child,
        spawn: (command, args, options) => { calls.push({ command, args, options }); return child; }
    };
}

test('C03-L1 the launch is argv-only, pins the distro and uses no shell string', () => {
    const l = launch();
    assert.equal(l.command, 'wsl.exe');
    assert.deepEqual(l.args, ['-d', 'DreamMaker-Acceptance-20261011', '--', '/opt/dm/bridge.py', '--home', '/opt/dm/home']);
    assert.equal(l.args.some(a => /\s/.test(a)), false);
});

test('C03-L2 the environment is an explicit allowlist, not the Windows environment', () => {
    const l = launch();
    assert.deepEqual(Object.keys(l.env).sort(), ['DM_KIMI_BRIDGE', 'HOME', 'KIMI_CODE_HOME', 'LANG', 'PATH']);
    assert.equal(l.env.HOME, '/opt/dm/home');
    assert.equal(l.env.KIMI_CODE_HOME, '/opt/dm/home');
    assert.equal(JSON.stringify(l.env).includes('C:'), false);
});

test('C03-L3 unsafe distro, script, home or shell are refused before any spawn', () => {
    assert.throws(() => launch({ distro: 'bad distro' }), { code: 'KIMI_BRIDGE_DISTRO_INVALID' });
    assert.throws(() => launch({ script: 'relative/bridge.py' }), { code: 'KIMI_BRIDGE_SCRIPT_INVALID' });
    assert.throws(() => launch({ script: '/opt/a b/bridge.py' }), { code: 'KIMI_BRIDGE_SCRIPT_INVALID' });
    assert.throws(() => launch({ script: '/opt/../etc/bridge.py' }), { code: 'KIMI_BRIDGE_SCRIPT_INVALID' });
    assert.throws(() => launch({ home: '' }), { code: 'KIMI_BRIDGE_HOME_INVALID' });
    assert.throws(() => launch({ home: 'C:\\Users\\Hp' }), { code: 'KIMI_BRIDGE_HOME_INVALID' });
    assert.throws(() => launch({ interpreter: 'python3' }), { code: 'KIMI_BRIDGE_SHELL_INVALID' });
    assert.deepEqual(launch({ interpreter: '/usr/bin/python3' }).args.slice(0, 5), ['-d', 'DreamMaker-Acceptance-20261011', '--', '/usr/bin/python3', '/opt/dm/bridge.py']);
    assert.equal(isSafePosixPath('/opt/dm/home'), true);
});

test('C03-L4 the process is spawned with shell:false, pipes and the allowlisted env', () => {
    const f = fakeSpawn();
    const proc = createBridgeProcess({ launch: launch(), spawn: f.spawn, onBytes: () => {} });
    proc.start();
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(call.options.env, process.env, 'the Windows-side process inherits the Windows env; the Linux allowlist lives in bridge.py');
});

test('C03-L5 stdout bytes reach the frame decoder and a second start is refused', () => {
    const f = fakeSpawn();
    const seen = [];
    const proc = createBridgeProcess({ launch: launch(), spawn: f.spawn, onBytes: b => seen.push(b) });
    proc.start();
    assert.equal(proc.started(), true);
    f.listeners.stdout(Buffer.from('frame-bytes'));
    assert.deepEqual(seen.map(b => b.toString()), ['frame-bytes']);
    assert.throws(() => proc.start(), { code: 'KIMI_BRIDGE_ALREADY_STARTED' });
});

test('C03-L6 stderr is redacted, bounded and never becomes the transport', () => {
    const f = fakeSpawn();
    const seen = [];
    const proc = createBridgeProcess({ launch: launch(), spawn: f.spawn, onBytes: b => seen.push(b), maxStderrLines: 2 });
    proc.start();
    f.listeners.stderr(Buffer.from('refusing https://www.kimi.com/code/authorize_device?user_code=ABCD-1234 token sk-abcdef1234567890'));
    f.listeners.stderr(Buffer.from('second'));
    f.listeners.stderr(Buffer.from('third'));
    const diagnostics = proc.diagnostics();
    assert.equal(diagnostics.length, 2, 'diagnostics are bounded');
    assert.equal(diagnostics[0].includes('ABCD-1234'), false);
    assert.equal(diagnostics[0].includes('sk-abcdef1234567890'), false);
    assert.equal(seen.length, 0, 'stderr never reaches the frame stream');
});

test('C03-L7 write requires a started process, and stop is idempotent', () => {
    const f = fakeSpawn();
    const proc = createBridgeProcess({ launch: launch(), spawn: f.spawn, onBytes: () => {} });
    assert.throws(() => proc.write(Buffer.from('x')), { code: 'KIMI_BRIDGE_NOT_STARTED' });
    proc.start();
    proc.write(Buffer.from('hello'));
    assert.deepEqual(f.child.stdin.writes.map(b => b.toString()), ['hello']);
    proc.stop();
    assert.equal(f.child.killed, true);
    proc.stop();
    // the fake records `end()` on the stdin view, which is where Node's stream object lives
    assert.equal(f.child.stdin.ended, true, 'stopping twice does not throw and stdin is closed');
});

test('C03-L8 exit and spawn errors settle the session instead of hanging', () => {
    const f = fakeSpawn();
    const exits = [];
    const proc = createBridgeProcess({ launch: launch(), spawn: f.spawn, onBytes: () => {}, onExit: e => exits.push(e) });
    proc.start();
    f.child.emit('exit', { code: 0, signal: null });
    assert.deepEqual(proc.exit(), { code: 0, signal: null });
    assert.deepEqual(exits[0], { code: 0, signal: null });

    const g = fakeSpawn();
    const proc2 = createBridgeProcess({ launch: launch(), spawn: g.spawn, onBytes: () => {} });
    proc2.start();
    g.child.emit('error', new Error('spawn wsl ENOENT'));
    assert.equal(proc2.exit().signal, 'SPAWN_ERROR');
});
test('C03-L9 the supervised child is passed after -- and validated', () => {
    const withChild = launch({ child: ['/opt/node/bin/node', '/opt/kimi/dist/main.mjs', 'web', '--no-open', '--port=58631'] });
    assert.deepEqual(withChild.args, [
        '-d', 'DreamMaker-Acceptance-20261011', '--', '/opt/dm/bridge.py', '--home', '/opt/dm/home',
        '--', '/opt/node/bin/node', '/opt/kimi/dist/main.mjs', 'web', '--no-open', '--port=58631'
    ]);
    assert.throws(() => launch({ child: ['node', '/opt/x'] }), { code: 'KIMI_BRIDGE_CHILD_INVALID' });
    assert.throws(() => launch({ child: ['/opt/node/bin/node', 'has space'] }), { code: 'KIMI_BRIDGE_CHILD_INVALID' });
});
test('C03-L10 the connector launch is argv-only and refuses unsafe paths', () => {
    const launch = kimiBridgeConnectorLaunch({ distro: 'DreamMaker-Acceptance-20261011', socket: '/tmp/ctl.sock', connector: '/tmp/connect.py' });
    assert.equal(launch.command, 'wsl.exe');
    assert.deepEqual(launch.args, ['-d', 'DreamMaker-Acceptance-20261011', '-u', 'root', '--', '/usr/bin/python3', '/tmp/connect.py', '/tmp/ctl.sock']);
    assert.throws(() => kimiBridgeConnectorLaunch({ distro: 'bad distro', socket: '/tmp/s', connector: '/tmp/c.py' }), { code: 'KIMI_BRIDGE_DISTRO_INVALID' });
    assert.throws(() => kimiBridgeConnectorLaunch({ distro: 'd', socket: 'relative.sock', connector: '/tmp/c.py' }), { code: 'KIMI_CONNECTOR_SOCKET_INVALID' });
    assert.throws(() => kimiBridgeConnectorLaunch({ distro: 'd', socket: '/tmp/s', connector: 'c.py' }), { code: 'KIMI_CONNECTOR_SCRIPT_INVALID' });
});
test('C03-L11 writing to a closed channel fails loudly instead of pretending to send', () => {
    const f = fakeSpawn();
    const proc = createBridgeProcess({ launch: launch(), spawn: f.spawn, onBytes: () => {} });
    proc.start();
    f.child.emit('exit', { code: 0, signal: null });
    assert.throws(() => proc.write(Buffer.from('x')), { code: 'KIMI_BRIDGE_CLOSED' });
    // stop() after exit stays a no-op rather than killing something twice
    proc.stop();
    assert.equal(f.child.killed, undefined);
});

test('C03-L12 a spawn failure also closes the channel for writing', () => {
    const f = fakeSpawn();
    const proc = createBridgeProcess({ launch: launch(), spawn: f.spawn, onBytes: () => {} });
    proc.start();
    f.child.emit('error', new Error('spawn wsl.exe ENOENT'));
    assert.equal(proc.exit().signal, 'SPAWN_ERROR');
    assert.throws(() => proc.write(Buffer.from('x')), { code: 'KIMI_BRIDGE_CLOSED' });
});
test('C03-L13 the connector accepts a bounded start-up wait and refuses a silly one', () => {
    const withWait = kimiBridgeConnectorLaunch({ distro: 'DreamMaker-Acceptance-20261011', socket: '/tmp/ctl.sock', connector: '/tmp/connect.py', waitSeconds: 5 });
    assert.equal(withWait.args.at(-1), '5');
    assert.throws(() => kimiBridgeConnectorLaunch({ distro: 'd', socket: '/tmp/s', connector: '/tmp/c.py', waitSeconds: -1 }), { code: 'KIMI_CONNECTOR_WAIT_INVALID' });
    assert.throws(() => kimiBridgeConnectorLaunch({ distro: 'd', socket: '/tmp/s', connector: '/tmp/c.py', waitSeconds: 999 }), { code: 'KIMI_CONNECTOR_WAIT_INVALID' });
});
test('C03-L9 a dead pipe settles the session instead of throwing an unhandled error', () => {
    // Real case: the bridge exits while the controller is still writing frames. The write lands on a
    // closed pipe and Node emits 'error' on stdin — with no listener that is a thrown event.
    const listeners = {};
    const child = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        stdin: { on: (ev, cb) => { listeners['stdin:' + ev] = cb; }, write() {}, end() { this.ended = true; } },
        on: (ev, cb) => { listeners[ev] = cb; },
        kill() { this.killed = true; }
    };
    const proc = createBridgeProcess({ launch: launch(), spawn: () => child, onBytes: () => {} });
    proc.start();
    assert.equal(typeof listeners['stdin:error'], 'function', 'the pipe error must have a listener');
    listeners['stdin:error'](Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.deepEqual(proc.exit(), { code: null, signal: 'STDIN_ERROR' });
    assert.throws(() => proc.write(Buffer.from('x')), { code: 'KIMI_BRIDGE_CLOSED' });
    assert.ok(proc.diagnostics().some(line => line.startsWith('STDIN_ERROR')), 'the reason is kept');
});
