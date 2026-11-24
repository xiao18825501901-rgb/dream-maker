import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeStartupDecision } from '../dist/server/kimi-bridge-startup.js';

// C03: startup policy only. No app, no server, no process — the lifecycle question is separate, and
// that separation is exactly why this is testable.

const env = over => ({ DM_KIMI_BRIDGE: '1', DM_KIMI_BRIDGE_DISTRO: 'DreamMaker-Acceptance-20261011', DM_KIMI_BRIDGE_SCRIPT: '/opt/dm/bridge.py', DM_KIMI_BRIDGE_HOME: '/opt/dm/home', ...over });
const ready = { kimiRunnerConfigured: true, hasCredentialAuthority: true };

test('C03-X1 the bridge never starts without the explicit flag', () => {
    for (const flag of [undefined, '', '0', 'true', 'yes']) {
        const decision = bridgeStartupDecision({ env: env({ DM_KIMI_BRIDGE: flag }), ...ready });
        assert.equal(decision.start, false);
        assert.equal(decision.reason, 'BRIDGE_FLAG_OFF');
        assert.equal(decision.launch, null);
    }
});

test('C03-X2 the flag alone is not enough: runner and credential authority are both required', () => {
    assert.equal(bridgeStartupDecision({ env: env(), kimiRunnerConfigured: false, hasCredentialAuthority: true }).reason, 'NO_KIMI_RUNNER');
    assert.equal(bridgeStartupDecision({ env: env(), kimiRunnerConfigured: true, hasCredentialAuthority: false }).reason, 'NO_CREDENTIAL_AUTHORITY');
    assert.equal(bridgeStartupDecision({ env: env(), kimiRunnerConfigured: false, hasCredentialAuthority: false }).reason, 'NO_KIMI_RUNNER');
});

test('C03-X3 a complete configuration produces the pinned launch shape', () => {
    const decision = bridgeStartupDecision({ env: env(), ...ready });
    assert.equal(decision.start, true);
    assert.equal(decision.reason, 'START');
    assert.deepEqual(decision.launch.args, ['-d', 'DreamMaker-Acceptance-20261011', '--', '/opt/dm/bridge.py', '--home', '/opt/dm/home']);
    assert.deepEqual(Object.keys(decision.launch.env).sort(), ['DM_KIMI_BRIDGE', 'HOME', 'KIMI_CODE_HOME', 'LANG', 'PATH']);
});

test('C03-X4 an unsafe distro, script or home throws instead of half-starting', () => {
    assert.throws(() => bridgeStartupDecision({ env: env({ DM_KIMI_BRIDGE_DISTRO: 'bad distro' }), ...ready }), { code: 'KIMI_BRIDGE_DISTRO_INVALID' });
    assert.throws(() => bridgeStartupDecision({ env: env({ DM_KIMI_BRIDGE_SCRIPT: 'relative.py' }), ...ready }), { code: 'KIMI_BRIDGE_SCRIPT_INVALID' });
    assert.throws(() => bridgeStartupDecision({ env: env({ DM_KIMI_BRIDGE_HOME: 'C:\\Users\\Hp' }), ...ready }), { code: 'KIMI_BRIDGE_HOME_INVALID' });
    assert.throws(() => bridgeStartupDecision({ env: env({ DM_KIMI_BRIDGE_HOME: undefined }), ...ready }), { code: 'KIMI_BRIDGE_HOME_INVALID' });
});

test('C03-X5 a missing flag short-circuits before any launch validation', () => {
    const decision = bridgeStartupDecision({ env: { DM_KIMI_BRIDGE: undefined, DM_KIMI_BRIDGE_DISTRO: 'bad distro' }, ...ready });
    assert.equal(decision.start, false);
    assert.equal(decision.reason, 'BRIDGE_FLAG_OFF');
});
test('C03-X6 a socket in the environment selects the connector topology', () => {
    const decision = bridgeStartupDecision({
        env: env({ DM_KIMI_BRIDGE_SOCKET: '/tmp/dm/ctl.sock', DM_KIMI_BRIDGE_CONNECTOR: '/tmp/dm/connect.py' }),
        ...ready
    });
    assert.equal(decision.start, true);
    assert.deepEqual(decision.launch.args, ['-d', 'DreamMaker-Acceptance-20261011', '-u', 'root', '--', '/usr/bin/python3', '/tmp/dm/connect.py', '/tmp/dm/ctl.sock']);
    assert.equal(decision.launch.args.includes('/opt/dm/bridge.py'), false, 'connector mode must not start the bridge itself');
});

test('C03-X7 an unsafe socket or connector path is refused before anything runs', () => {
    assert.throws(() => bridgeStartupDecision({ env: env({ DM_KIMI_BRIDGE_SOCKET: 'relative.sock', DM_KIMI_BRIDGE_CONNECTOR: '/tmp/c.py' }), ...ready }), { code: 'KIMI_CONNECTOR_SOCKET_INVALID' });
    assert.throws(() => bridgeStartupDecision({ env: env({ DM_KIMI_BRIDGE_SOCKET: '/tmp/s.sock', DM_KIMI_BRIDGE_CONNECTOR: 'c.py' }), ...ready }), { code: 'KIMI_CONNECTOR_SCRIPT_INVALID' });
});
