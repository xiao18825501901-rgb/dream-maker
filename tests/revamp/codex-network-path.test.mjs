// OFFLINE route-correlation tests. No CFW mutation, OAuth, HTTP, or model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { CodexRunner } from '../../dist/server/providers/codex.js';
import { RpcChildError, rpcErrorEvidence } from '../../dist/server/providers/rpc.js';
import {
  CODEX_REQUEST_TARGETS,
  classifyCodexTurnError,
  directRouteObserved,
  descendantProcessIds,
  evidenceFromConnections,
  finalizeCodexRequestPath,
  parseWindowsNetstatProcessObservations,
  parseWindowsNetstatSourcePortOwners,
  parseWindowsNetstatSourcePorts,
  probeCodexRoute,
  sourcePortsWithStableOwners,
  windowsCodexProcessIds,
  windowsCodexTcpObservations,
  windowsProcessIdentities
} from '../../dist/server/codex-network-path.js';
import { withProcessOwnership } from '../../dist/server/flow/process-ownership.js';
import { harness, root } from '../helpers.mjs';

const processInfo = Object.freeze({ pid: 4242, identity: 'win32:638900000000000000' });
const connection = Object.freeze({
  sourceAddress: '127.0.0.1',
  sourcePort: 49152,
  proxyPort: null,
  targetHost: 'chatgpt.com',
  targetPort: 443,
  chains: ['current-node', 'provider-group'],
  rule: 'Match',
  start: '2026-11-08T12:00:00.000Z'
});
const routeInput = Object.freeze({
  process: processInfo,
  proxyUrl: 'http://127.0.0.1:7890/',
  expectedNode: 'current-node',
  connections: [connection],
  sourcePorts: new Set([49152])
});

test('app-server route attribution follows only the bounded process subtree', () => {
  const rows = [
    { ProcessId: 100, ParentProcessId: 1 },
    { ProcessId: 101, ParentProcessId: 100 },
    { ProcessId: 102, ParentProcessId: 101 },
    { ProcessId: 103, ParentProcessId: 102 },
    { ProcessId: 200, ParentProcessId: 1 },
    { ProcessId: 100, ParentProcessId: 999 }
  ];
  assert.deepEqual(descendantProcessIds(rows, 100, 2), [100, 101, 102]);
  assert.deepEqual(descendantProcessIds(rows, 200, 2), [200]);
  assert.deepEqual(descendantProcessIds(rows, 200, 0), []);
  assert.deepEqual(descendantProcessIds(rows, 999, 4), []);
});

test('netstat endpoint parsing finds only verified process-tree connections to loopback CFW', () => {
  const output = [
    '  TCP    127.0.0.1:50123    127.0.0.1:7890    ESTABLISHED    101',
    '  TCP    [::1]:50124        [::1]:7890       ESTABLISHED    102',
    '  TCP    127.0.0.1:50125    127.0.0.1:7890    ESTABLISHED    999',
    '  TCP    127.0.0.1:50126    203.0.113.8:7890  ESTABLISHED    101',
    '  TCP    127.0.0.1:50127    127.0.0.1:7890    TIME_WAIT      0'
  ].join('\n');
  assert.deepEqual([...parseWindowsNetstatSourcePorts(output, new Set([101, 102]), 7890)], [50123, 50124]);
  assert.deepEqual([...parseWindowsNetstatSourcePorts(output, new Set([999]), 7890)], [50125]);
  assert.deepEqual([...parseWindowsNetstatSourcePorts(output, new Set([101]), 8080)], []);
});

test('direct process-tree connections remain visible and cannot be mistaken for the CFW route', () => {
  const output = [
    '  TCP    127.0.0.1:50123    127.0.0.1:7890    ESTABLISHED    101',
    '  TCP    127.0.0.1:50124    127.0.0.1:9999    ESTABLISHED    101',
    '  TCP    127.0.0.1:50125    203.0.113.8:443   ESTABLISHED    101',
    '  TCP    127.0.0.1:50126    203.0.113.9:443   ESTABLISHED    999'
  ].join('\n');
  const observed = parseWindowsNetstatProcessObservations(output, new Set([101]), 7890);
  assert.deepEqual([...observed.proxyOwners], [[50123, 101]]);
  assert.deepEqual([...observed.directOwners], [[50125, 101]]);
});

test('any direct socket owned by the bounded process tree fails closed even when a new child identity is not available yet', () => {
  const boundedPids = new Set([100, 101, 102]);
  assert.equal(directRouteObserved(new Map([[50125, 101]]), boundedPids), true);
  assert.equal(directRouteObserved(new Map([[50126, 999]]), boundedPids), false);
  assert.equal(directRouteObserved(new Map(), boundedPids), false);
});

test('a reused or exited descendant PID cannot inherit the captured route', () => {
  const output = [
    '  TCP    127.0.0.1:50123    127.0.0.1:7890    ESTABLISHED    101',
    '  TCP    127.0.0.1:50124    127.0.0.1:7890    ESTABLISHED    102',
    '  TCP    127.0.0.1:50125    127.0.0.1:7890    ESTABLISHED    103'
  ].join('\n');
  const owners = parseWindowsNetstatSourcePortOwners(output, new Set([101, 102, 103]), 7890);
  const expected = new Map([
    [100, 'win32:1000'],
    [101, 'win32:1001'],
    [102, 'win32:1002']
  ]);
  const current = new Map([
    [100, 'win32:1000'],
    [101, 'win32:1001'],
    [102, 'win32:2002']
  ]);
  assert.deepEqual([...sourcePortsWithStableOwners(owners, expected, current)], [50123]);
  assert.deepEqual(owners.get(50125), 103);
});

test('route polling discovers a stable descendant created after app-server initialization', {
  skip: process.platform !== 'win32'
}, async t => {
  const sockets = new Set();
  let acceptedPort = null;
  const server = createServer(socket => {
    acceptedPort = socket.remotePort;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const childSource = [
    "const net=require('node:net')",
    `const socket=net.connect(${port},'127.0.0.1')`,
    "socket.on('connect',()=>setInterval(()=>{},1000))",
    "socket.on('error',()=>process.exit(2))",
    'setTimeout(()=>process.exit(0),20000)'
  ].join(';');
  const rootSource = [
    "const {spawn}=require('node:child_process')",
    'let child=null',
    "const stop=()=>{try{child?.kill()}catch{};setTimeout(()=>process.exit(0),50)}",
    "process.on('message',message=>{if(message==='stop')return stop();if(message==='spawn'&&!child)child=spawn(process.execPath,['-e',process.env.DM_TEST_CHILD],{stdio:'ignore',windowsHide:true})})",
    'setInterval(()=>{},1000)'
  ].join(';');
  const root = spawn(process.execPath, ['-e', rootSource], {
    env: { ...process.env, DM_TEST_CHILD: childSource },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true
  });
  const stopped = once(root, 'exit').catch(() => []);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolveClose => server.close(resolveClose));
    if (root.exitCode === null) {
      root.send('stop');
      await Promise.race([stopped, new Promise(resolveWait => setTimeout(resolveWait, 2000))]);
    }
    if (root.exitCode === null) root.kill();
  });

  const identityResult = await new Promise((resolveRead, rejectRead) => {
    const script = [
      "$p=Get-Process -Id " + root.pid + " -ErrorAction Stop",
      "'win32:'+[string]$p.StartTime.ToUniversalTime().Ticks"
    ].join(';');
    const reader = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    reader.stdout.setEncoding('utf8');
    reader.stdout.on('data', chunk => { output += chunk; });
    reader.once('error', rejectRead);
    reader.once('close', code => code === 0 ? resolveRead(output.trim()) : rejectRead(new Error('identity read failed')));
  });
  assert.match(identityResult, /^win32:\d+$/);

  const routePromise = probeCodexRoute({
    process: { pid: root.pid, identity: identityResult },
    proxyUrl: `http://127.0.0.1:${port}/`,
    expectedNode: 'current-node',
    controller: {
      async connections() {
        return acceptedPort === null ? [] : [{ ...connection, sourcePort: acceptedPort, targetHost: 'chatgpt.com' }];
      }
    },
    targetPort: 443,
    timeoutMs: 10000
  });

  await new Promise(resolveDelay => setTimeout(resolveDelay, 3000));
  root.send('spawn');
  const evidence = await routePromise;
  assert.ok(acceptedPort, 'the late child must reach the loopback proxy');
  assert.equal(evidence.path, 'REQUEST_ROUTE_VERIFIED');
  assert.equal(evidence.selectedNode, 'current-node');
  assert.equal(evidence.sourcePortCount, 1);
});

test('fixed read-only Windows network inspectors do not enter execution ownership', {
  skip: process.platform !== 'win32'
}, async t => {
  const h = harness(t);
  const binding = {
    store: h.store,
    projectId: null,
    runId: null,
    dispatchId: 'dispatch_fixture',
    generation: 'generation_fixture',
    mode: 'live'
  };
  await withProcessOwnership(binding, async () => {
    const identities = await windowsProcessIdentities({
      pids: [process.pid],
      cwd: h.dir
    });
    assert.match(identities.get(process.pid), /^win32:\d+$/);
    await windowsCodexProcessIds(process.pid, h.dir);
    await windowsCodexTcpObservations({
      pids: [process.pid],
      proxyPort: 7890,
      cwd: h.dir
    });
  });
  const rows = h.store.db.prepare(
    "SELECT kind FROM records WHERE project_id IS NULL AND run_id IS NULL " +
    "AND kind IN ('OwnedProcessIntent','OwnedProcessNotLaunched','OwnedProcessRootStarted'," +
    "'OwnedProcessRootExited','OwnedProcessCleanup')"
  ).all();
  assert.deepEqual(rows, []);
});

test('request route requires a process identity and a unique target connection', () => {
  assert.equal(evidenceFromConnections({
    ...routeInput,
    process: { pid: 4242, identity: null }
  }).path, 'PROCESS_IDENTITY_UNVERIFIED');
  assert.equal(evidenceFromConnections({
    ...routeInput,
    connections: [{ ...connection, targetHost: 'example.invalid' }]
  }).path, 'PROCESS_ROUTE_NOT_OBSERVED');
  assert.equal(evidenceFromConnections({
    ...routeInput,
    connections: [
      connection,
      { ...connection, chains: ['other-node', 'provider-group'] }
    ]
  }).path, 'CONNECTION_AMBIGUOUS');
  assert.equal(evidenceFromConnections({
    ...routeInput,
    expectedNode: 'different-node'
  }).path, 'NODE_MISMATCH');
});

test('request route accepts the ChatGPT subscription host and missing inboundPort', () => {
  const evidence = evidenceFromConnections(routeInput);
  assert.equal(evidence.path, 'REQUEST_ROUTE_VERIFIED');
  assert.equal(evidence.targetHost, 'chatgpt.com');
  assert.equal(evidence.selectedNode, 'current-node');
  assert.equal(evidence.proxyEndpoint, '127.0.0.1:7890');
  assert.deepEqual(evidence.chains, ['current-node', 'provider-group']);
  assert.match(evidence.sourcePortSha256, /^[a-f0-9]{64}$/);
});

test('request route accepts the ChatGPT backend host used by Codex traffic', () => {
  const evidence = evidenceFromConnections({
    ...routeInput,
    connections: [{ ...connection, targetHost: 'ab.chatgpt.com' }]
  });
  assert.equal(evidence.path, 'REQUEST_ROUTE_VERIFIED');
  assert.equal(evidence.targetHost, 'ab.chatgpt.com');
});

test('official Codex control and WebSocket hosts with one CFW chain remain one verified route', () => {
  assert.ok(CODEX_REQUEST_TARGETS.includes('ws.chatgpt.com'));
  assert.ok(CODEX_REQUEST_TARGETS.includes('codex-cloud-backend.chatgpt.com'));
  assert.ok(CODEX_REQUEST_TARGETS.includes('codex-cloud-environments.chatgpt.com'));
  const evidence = evidenceFromConnections({
    ...routeInput,
    connections: [
      connection,
      { ...connection, sourcePort: 49153, targetHost: 'ws.chatgpt.com' },
      { ...connection, sourcePort: 49154, targetHost: 'codex-cloud-backend.chatgpt.com' }
    ],
    sourcePorts: new Set([49152, 49153, 49154])
  });
  assert.equal(evidence.path, 'REQUEST_ROUTE_VERIFIED');
  assert.equal(evidence.targetHost, 'chatgpt.com');
  assert.deepEqual(evidence.targetHosts, [
    'chatgpt.com',
    'ws.chatgpt.com',
    'codex-cloud-backend.chatgpt.com'
  ]);
  assert.equal(evidence.sourcePortCount, 3);
  assert.match(evidence.sourcePortSha256, /^[a-f0-9]{64}$/);
});

test('official control hosts cannot inherit a route when any CFW chain differs', () => {
  const evidence = evidenceFromConnections({
    ...routeInput,
    connections: [
      connection,
      {
        ...connection,
        sourcePort: 49153,
        targetHost: 'ws.chatgpt.com',
        chains: ['other-node', 'provider-group']
      }
    ],
    sourcePorts: new Set([49152, 49153])
  });
  assert.equal(evidence.path, 'CONNECTION_AMBIGUOUS');
  assert.deepEqual(evidence.targetHosts, []);
});

test('final request evidence hashes request identity and never persists the raw port or id', () => {
  const observation = finalizeCodexRequestPath({
    role: 'planner2',
    startedAt: '2026-11-08T12:00:00.000Z',
    completedAt: '2026-11-08T12:00:01.000Z',
    evidence: evidenceFromConnections(routeInput),
    classification: 'INFERENCE_COMPLETED',
    requestId: 'turn-private-request-id',
    httpStatus: 200
  });
  assert.equal(observation.automaticRetryAllowed, false);
  assert.match(observation.requestIdSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(observation.targetHosts, ['chatgpt.com']);
  assert.equal(observation.sourcePortCount, 1);
  assert.equal(Object.hasOwn(observation, 'sourcePort'), false);
  assert.equal(Object.hasOwn(observation, 'requestId'), false);
  const serialized = JSON.stringify(observation);
  assert.doesNotMatch(serialized, /49152|turn-private-request-id/);
});

test('RPC evidence distinguishes exact HTTP policy categories without retaining text', () => {
  const region = rpcErrorEvidence('turn/start', {
    code: -32000,
    message: 'HTTP 403 unsupported_country_region_territory request PRIVATE'
  });
  const generic = rpcErrorEvidence('turn/start', {
    code: -32000,
    message: 'HTTP 403 Forbidden request PRIVATE'
  });
  assert.equal(region.httpStatus, 403);
  assert.equal(region.policyRestricted, true);
  assert.equal(generic.httpStatus, 403);
  assert.equal(generic.policyRestricted, false);
  assert.doesNotMatch(JSON.stringify(region), /PRIVATE|unsupported_country/);
  assert.equal(classifyCodexTurnError(new RpcChildError(region)), 'REGION_OR_POLICY_RESTRICTED');
  assert.equal(classifyCodexTurnError(new RpcChildError(generic)), 'HTTP_403_PERMISSION_DENIED');
});

test('RPC evidence classifies authentication, rate limit, and model refusal', () => {
  assert.equal(classifyCodexTurnError(new RpcChildError(rpcErrorEvidence('turn/start', {
    code: -32000,
    message: 'HTTP 401 unauthorized'
  }))), 'HTTP_401_AUTHENTICATION_FAILED');
  assert.equal(classifyCodexTurnError(new RpcChildError(rpcErrorEvidence('turn/start', {
    code: -32000,
    message: 'HTTP 429 rate limit exceeded'
  }))), 'HTTP_429_QUOTA_EXCEEDED');
  assert.equal(classifyCodexTurnError(new RpcChildError(rpcErrorEvidence('turn/start', {
    code: -32000,
    message: 'model_not_found: requested model is unavailable'
  }))), 'MODEL_UNAVAILABLE');
});

test('RPC evidence keeps transport failures distinct without retaining the raw socket error', () => {
  const cases = [
    ['getaddrinfo ENOTFOUND chatgpt.com PRIVATE_DNS', 'DNS_FAILURE'],
    ['connect ECONNREFUSED 127.0.0.1:7890 PRIVATE_CONNECT', 'TCP_CONNECTION_FAILURE'],
    ['TLS handshake failed: certificate verify failed PRIVATE_TLS', 'TLS_HANDSHAKE_FAILURE'],
    ['read tcp 127.0.0.1:59302->127.0.0.1:7890: wsarecv: connection forcibly closed PRIVATE_RESET', 'PROXY_CONNECTION_RESET'],
    ['stream disconnected before completion PRIVATE_STREAM', 'STREAM_INTERRUPTED']
  ];
  for (const [message, expected] of cases) {
    const evidence = rpcErrorEvidence('turn/start', { code: -32000, message });
    assert.ok(evidence.failureCategories.includes(expected), `${expected} must remain visible`);
    assert.equal(classifyCodexTurnError(new RpcChildError(evidence)), expected);
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /PRIVATE_|127[.]0[.]0[.]1|59302|7890|wsarecv|forcibly closed/);
  }
});

test('region policy refusal takes precedence over a transport-looking suffix', () => {
  const evidence = rpcErrorEvidence('turn/start', {
    code: -32000,
    message: 'HTTP 403 unsupported_country_region_territory; proxy 127.0.0.1:7890 returned ECONNRESET PRIVATE'
  });
  const observation = finalizeCodexRequestPath({
    role: 'planner2',
    startedAt: '2026-11-10T00:00:00.000Z',
    completedAt: '2026-11-10T00:00:01.000Z',
    evidence: evidenceFromConnections(routeInput),
    classification: classifyCodexTurnError(new RpcChildError(evidence)),
    requestId: null,
    httpStatus: evidence.httpStatus
  });
  assert.equal(evidence.policyRestricted, true);
  assert.equal(observation.classification, 'REGION_OR_POLICY_RESTRICTED');
  assert.equal(observation.automaticRetryAllowed, false);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|unsupported_country|127[.]0[.]0[.]1|7890/);
});

test('CodexRunner records one bounded request-path observation after a real wire turn', async t => {
  const h = harness(t);
  const c = h.config;
  const policyFile = resolve(h.dir, 'codex-role-policy.toml');
  writeFileSync(policyFile, readFileSync(resolve(root, 'config/codex-agent-windows-readonly.toml'), 'utf8')
    .replaceAll('dream-maker-source-read', 'fixture-source-read'));
  c.codex = {
    command: process.execPath,
    args: [resolve(root, 'tests/fixtures/codex-wire.mjs'), 'success'],
    home: h.dir,
    model: 'fixture-not-a-model',
    permissionProfile: 'fixture-source-read',
    policyFile
  };
  c.clash = { ...c.clash, enabled: true };
  let observerInput;
  const events = [];
  const runner = new CodexRunner(
    () => c,
    root,
    false,
    () => ({ ...process.env, HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1' }),
    undefined,
    async input => {
      observerInput = input;
      return evidenceFromConnections(routeInput);
    }
  );
  const output = await runner.run({
    workspace: h.dir,
    prompt: 'frozen data only',
    model: c.codex.model,
    specHash: 'fixture-spec',
    runId: 'fixture-run',
    role: 'planner2',
    laya: { adoption: 'off' },
    signal: new AbortController().signal
  }, event => events.push(event));
  assert.equal(output.model, c.codex.model);
  assert.ok(Number.isSafeInteger(observerInput?.process?.pid));
  assert.match(observerInput.process.identity, /^win32:\d+$/);
  assert.ok(observerInput.process.descendantIdentities?.some(item =>
    item.pid === observerInput.process.pid && item.identity === observerInput.process.identity));
  const observations = events.filter(event => event.method === 'dm/codexRequestPath');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].params.path, 'REQUEST_ROUTE_VERIFIED');
  assert.equal(observations[0].params.targetHost, 'chatgpt.com');
  assert.equal(observations[0].params.classification, 'INFERENCE_COMPLETED');
  assert.equal(observations[0].params.httpStatus, null);
  assert.equal(observations[0].params.automaticRetryAllowed, false);
  assert.doesNotMatch(JSON.stringify(observations), /49152|fixture-thread|fixture-run/);
});
