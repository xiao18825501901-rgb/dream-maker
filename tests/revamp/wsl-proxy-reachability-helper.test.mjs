// OFFLINE Python helper contract: a synthetic route and injected connector only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { childEnv } from '../../dist/server/security.js';
import { root } from '../helpers.mjs';

const helper = resolve(root, 'scripts/isolation/wsl-proxy-reachability.py');

function run(route, cases) {
  const parent = resolve(root, '.runtime/test-temp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'wsl-proxy-helper-'));
  const routePath = join(directory, 'route');
  writeFileSync(routePath, route);
  const source = [
    'import errno,importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("dm_wsl_proxy",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'cases=json.loads(sys.argv[3])',
    'result={"gateway":module.default_gateway(sys.argv[2]),"probes":[]}',
    'for case in cases:',
    '  code={"ECONNREFUSED":errno.ECONNREFUSED,"ETIMEDOUT":errno.ETIMEDOUT,"SUCCESS":0}[case["code"]]',
    '  result["probes"].append(module.probe(7890,gateway="172.27.48.1",connector=lambda _socket,_address,code=code: code))',
    'print(json.dumps(result,separators=(",",":")))'
  ].join('\n');
  try {
    const result = spawnSync('python', ['-I', '-c', source, helper, routePath, JSON.stringify(cases)], {
      cwd: root,
      env: childEnv(),
      input: '',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16384
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const route = [
  'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t01301BAC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  'eth0\t0027AC01\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
  ''
].join('\n');

test('default route is parsed from little-endian proc data and only emits a TCP-only result', () => {
  const result = run(route, [
    { code: 'SUCCESS' },
    { code: 'ECONNREFUSED' },
    { code: 'ETIMEDOUT' }
  ]);
  assert.equal(result.gateway, '172.27.48.1');
  assert.deepEqual(result.probes.map(value => value.state), [
    'TCP_REACHABLE_ONLY',
    'CONNECTION_REFUSED',
    'TIMEOUT'
  ]);
  for (const value of result.probes) {
    assert.equal(value.networkPayloadBytes, 0);
    assert.equal(value.httpRequests, 0);
    assert.equal(value.tlsHandshakes, 0);
    assert.equal(value.modelCalls, 0);
    assert.equal(value.filesWritten, 0);
  }
});

test('a non-default route cannot be mistaken for the WSL proxy gateway', () => {
  const source = [
    'import importlib.util,sys',
    'spec=importlib.util.spec_from_file_location("dm_wsl_proxy",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'try:',
    '  module.default_gateway(sys.argv[2])',
    'except ValueError as error:',
    '  print(str(error))'
  ].join('\n');
  const parent = resolve(root, '.runtime/test-temp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'wsl-proxy-no-route-'));
  const routePath = join(directory, 'route');
  writeFileSync(routePath, [
    'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
    'eth0\t0027AC01\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
    ''
  ].join('\n'));
  try {
    const result = spawnSync('python', ['-I', '-c', source, helper, routePath], {
      cwd: root,
      env: childEnv(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 4096
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'DEFAULT_ROUTE_UNAVAILABLE');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the bounded TLS probe sends CONNECT to the CFW gateway and validates TLS without an origin HTTP request', () => {
  const source = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("dm_wsl_proxy",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'class Socket:',
    '  def __init__(self): self.sent=b""; self.closed=False',
    '  def settimeout(self,value): self.timeout=value',
    '  def getsockname(self): return ("172.27.53.208",42900)',
    '  def sendall(self,value): self.sent+=value',
    '  def recv(self,value): return b"HTTP/1.1 200 Connection Established\\r\\n\\r\\n"',
    '  def close(self): self.closed=True',
    'class Secure:',
    '  def version(self): return "TLSv1.3"',
    '  def selected_alpn_protocol(self): return "http/1.1"',
    '  def cipher(self): return ("TLS_AES_256_GCM_SHA384","TLSv1.3",256)',
    '  def close(self): pass',
    'class Context:',
    '  def set_alpn_protocols(self,value): self.alpn=value',
    '  def wrap_socket(self,socket,server_hostname): self.socket=socket; self.server_hostname=server_hostname; return Secure()',
    'socket=Socket(); context=Context()',
    'result=module.probe_tls(7890,"api.openai.com",gateway="172.27.48.1",connector=lambda *_,**__: socket,context_factory=lambda: context,hold_seconds=0)',
    'print(json.dumps({"result":result,"sent":socket.sent.decode("ascii"),"serverHostname":context.server_hostname},separators=(",",":")))'
  ].join('\n');
  const parent = resolve(root, '.runtime/test-temp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'wsl-tls-helper-'));
  try {
    const result = spawnSync('python', ['-I', '-c', source, helper], {
      cwd: root,
      env: childEnv(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16384
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.result.state, 'CONNECT_AND_TLS_COMPLETED');
    assert.equal(value.result.targetHost, 'api.openai.com');
    assert.equal(value.result.protocol, 'TLSv1.3');
    assert.equal(value.result.alpn, 'http/1.1');
    assert.equal(value.result.authorized, true);
    assert.equal(value.result.proxyConnectRequests, 1);
    assert.equal(value.result.originHttpRequests, 0);
    assert.equal(value.result.modelCalls, 0);
    assert.equal(value.result.filesWritten, 0);
    assert.equal(value.serverHostname, 'api.openai.com');
    assert.match(value.sent, /^CONNECT api[.]openai[.]com:443 HTTP\/1[.]1\r\n/);
    assert.doesNotMatch(value.sent, /authorization|proxy-authorization|openai-api-key/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the WSL TLS probe rejects arbitrary targets and reports proxy authentication without starting TLS', () => {
  const source = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("dm_wsl_proxy",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'class Socket:',
    '  def settimeout(self,value): pass',
    '  def getsockname(self): return ("172.27.53.208",42900)',
    '  def sendall(self,value): pass',
    '  def recv(self,value): return b"HTTP/1.1 407 Proxy Authentication Required\\r\\nContent-Length: 0\\r\\n\\r\\n"',
    '  def close(self): pass',
    'class Context:',
    '  def set_alpn_protocols(self,value): pass',
    '  def wrap_socket(self,socket,server_hostname): raise AssertionError("TLS must not start")',
    'result=module.probe_tls(7890,"chatgpt.com",gateway="172.27.48.1",connector=lambda *_,**__: Socket(),context_factory=lambda: Context(),hold_seconds=0)',
    'try:',
    '  module.validate_target("example.com")',
    '  denied=False',
    'except ValueError as error:',
    '  denied=str(error)=="TARGET_DENIED"',
    'print(json.dumps({"result":result,"denied":denied},separators=(",",":")))'
  ].join('\n');
  const parent = resolve(root, '.runtime/test-temp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'wsl-tls-reject-'));
  try {
    const result = spawnSync('python', ['-I', '-c', source, helper], {
      cwd: root,
      env: childEnv(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8192
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.denied, true);
    assert.equal(value.result.state, 'PROXY_CONNECT_REJECTED');
    assert.equal(value.result.errorClass, 'PROXY_AUTH_REQUIRED');
    assert.equal(value.result.originHttpRequests, 0);
    assert.equal(value.result.modelCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
