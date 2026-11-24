import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import http from 'node:http';
import { defaults, parseConfig, Settings } from '../dist/server/config.js';
import { ClashController, parseClashConfig, SelectionLeaseManager } from '../dist/server/clash-route.js';
import { createApp } from '../dist/server/http.js';
import { root } from './helpers.mjs';
import { allowedJsonTarget } from '../dist/server/security.js';
import { ClashService } from '../dist/server/clash-service.js';

test('legacy DreamMaker config gains a disabled Clash route without exposing trusted fields', () => {
  const legacy = structuredClone(defaults);
  delete legacy.clash;
  const parsed = parseConfig(legacy);
  assert.equal(parsed.clash.enabled, false);
  assert.match(parsed.clash.configPath, /[.]config[\\/]clash[\\/]config[.]yaml$/i);

  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-settings-'));
  try {
    const path = resolve(dir, 'config.json');
    writeFileSync(path, JSON.stringify(parsed));
    const settings = new Settings(path);
    const publicValue = settings.public();
    assert.deepEqual(publicValue.config.clash, {
      enabled: false,
      selector: '',
      node: '',
      selectionPolicy: 'pinned',
      expectedMode: 'rule'
    });
    assert.doesNotMatch(JSON.stringify(publicValue), /config[.]yaml|secret|controllerUrl/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trusted Clash YAML parser accepts the narrow CFW fields and rejects duplicate or remote controllers', () => {
  const parsed = parseClashConfig('mixed-port: 7890\nexternal-controller: 127.0.0.1:62859\nsecret: "local-value"\n');
  assert.equal(parsed.proxyUrl, 'http://127.0.0.1:7890/');
  assert.equal(parsed.controllerUrl, 'http://127.0.0.1:62859/');
  assert.equal(parsed.secret, 'local-value');
  assert.throws(() => parseClashConfig('mixed-port: 7890\nmixed-port: 7891\nexternal-controller: 127.0.0.1:1\nsecret: x\n'), { code: 'CLASH_CONFIG_DUPLICATE_KEY' });
  assert.throws(() => parseClashConfig('mixed-port: 7890\nexternal-controller: 0.0.0.0:9090\nsecret: x\n'), { code: 'CLASH_CONTROLLER_LOOPBACK_REQUIRED' });
});

test('trusted Clash YAML parser preserves bounded listener exposure fields', () => {
  const parsed = parseClashConfig([
    'mixed-port: 7890',
    'allow-lan: true',
    'bind-address: "*"',
    'external-controller: 127.0.0.1:49697',
    'secret: "local-value"'
  ].join('\n'));
  assert.equal(parsed.allowLan, true);
  assert.equal(parsed.bindAddress, '*');
  const malformed = parseClashConfig([
    'mixed-port: 7890',
    'allow-lan: sometimes',
    'bind-address: "bad\\nvalue"',
    'external-controller: 127.0.0.1:49697',
    'secret: x'
  ].join('\n'));
  assert.equal(malformed.allowLan, null);
  assert.equal(malformed.bindAddress, null);
});

test('Clash transport allowlist includes only the fixed official DSH Messages route', () => {
  assert.equal(allowedJsonTarget('https://api.deepseek.com/anthropic/v1/messages', 'POST').pathname, '/anthropic/v1/messages');
  assert.throws(() => allowedJsonTarget('https://api.deepseek.com/anthropic/v1/other', 'POST'), { code: 'NETWORK_TARGET_DENIED' });
});

test('CFW connection reads are bounded and drop every non-allowlisted field', async t => {
  const server=http.createServer((req,res)=>{
    assert.equal(req.method,'GET');assert.equal(req.url,'/connections');
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({connections:[
      {id:'secret-id',metadata:{sourceIP:'::ffff:127.0.0.1',sourcePort:'50123',host:'CHATGPT.COM',destinationPort:'443',inboundPort:'7890',token:'secret'},chains:['node-a','group-a'],rule:'secret-rule',start:'2026-11-08T00:00:00Z',secret:'drop'},
      {id:'missing-port',metadata:{sourceIP:'127.0.0.1',sourcePort:50124,host:'api.openai.com',destinationPort:443},chains:['node-a']},
      {id:'bad-port',metadata:{sourceIP:'127.0.0.1',sourcePort:50125,host:'api.openai.com',destinationPort:443,inboundPort:'bad'},chains:['node-a']},
      {id:'bad-chain',metadata:{sourceIP:'127.0.0.1',sourcePort:50126,host:'api.openai.com',destinationPort:443},chains:[{secret:'drop'}]}
    ]}));
  });
  await new Promise(resolveReady=>server.listen(0,'127.0.0.1',resolveReady));
  t.after(()=>new Promise(resolveClose=>server.close(resolveClose)));
  const address=server.address(),port=typeof address==='object'&&address?address.port:0;
  const controller=new ClashController(`http://127.0.0.1:${port}/`,'');
  const rows=await controller.connections();
  assert.deepEqual(rows,[
    {sourceAddress:'127.0.0.1',sourcePort:50123,proxyPort:7890,targetHost:'chatgpt.com',targetPort:443,chains:['node-a','group-a'],rule:'secret-rule',start:'2026-11-08T00:00:00Z'},
    {sourceAddress:'127.0.0.1',sourcePort:50124,proxyPort:null,targetHost:'api.openai.com',targetPort:443,chains:['node-a'],rule:null,start:null},
    {sourceAddress:'127.0.0.1',sourcePort:50125,proxyPort:null,targetHost:'api.openai.com',targetPort:443,chains:['node-a'],rule:null,start:null}
  ]);
  assert.doesNotMatch(JSON.stringify(rows),/secret-id|missing-port|token|bad-chain/i);
});

test('read-only status stays available when enabled Clash is down, while verification fails closed', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-down-')), config = structuredClone(defaults);
  config.clash = { enabled: true, configPath: resolve(dir, 'missing.yaml'), selector: 'select', node: 'node', expectedMode: 'rule' };
  const service = new ClashService(() => config, resolve(dir, 'state'));
  try {
    const status = await service.inspect(); assert.equal(status.enabled, true); assert.equal(status.status, 'CLASH_CONFIG_NOT_FOUND');
    await assert.rejects(service.verify(), { code: 'CLASH_CONFIG_NOT_FOUND' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CFW read requests retry one transient transport reset while selector writes do not', async (t) => {
  let versionReads = 0, selectorWrites = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/version') {
      versionReads += 1;
      if (versionReads === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 'fixture', premium: false }));
      return;
    }
    if (req.method === 'PUT' && req.url === '/proxies/select') {
      selectorWrites += 1;
      req.socket.destroy();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const address = server.address(), port = typeof address === 'object' && address ? address.port : 0;
  const controller = new ClashController(`http://127.0.0.1:${port}/`, '');

  assert.deepEqual(await controller.version(), { version: 'fixture', premium: false });
  assert.equal(versionReads, 2);
  await assert.rejects(controller.setSelection('select', 'node'), { code: 'CLASH_CONTROLLER_NETWORK_ERROR' });
  assert.equal(selectorWrites, 1);
});

test('selection lease restores the prior node after success and action failure', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-lease-'));
  let current = 'old-node', restoredNotifications = 0;
  const controller = {
    endpoint: 'http://127.0.0.1:9090',
    async config() { return { mode: 'rule' }; },
    async proxies() {
      return {
        select: { name: 'select', type: 'Selector', now: current, all: ['old-node', 'new-node'] },
        'old-node': { name: 'old-node', type: 'Shadowsocks' },
        'new-node': { name: 'new-node', type: 'Trojan' }
      };
    },
    async proxy() { return { name: 'select', type: 'Selector', now: current, all: ['old-node', 'new-node'] }; },
    async setSelection(_group, node) { current = node; }
  };
  const lease = new SelectionLeaseManager({ controller, stateDirectory: dir });
  try {
    const owner = { dmRunId: 'run_test', processStartedAt: new Date().toISOString() };
    const result = await lease.withSelection({ group: 'select', node: 'new-node', expectedMode: 'rule', mutationScope: 'shared-selector', owner,onRestored:()=>{restoredNotifications++;} }, async active => {
      assert.equal(current, 'new-node');
      await active.assertCurrent();
      return 'ok';
    });
    assert.equal(result.result, 'ok');
    assert.equal(result.restored, true);
    assert.equal(current, 'old-node');
    assert.equal(restoredNotifications,1);

    await assert.rejects(lease.withSelection({ group: 'select', node: 'new-node', expectedMode: 'rule', mutationScope: 'shared-selector', owner,onRestored:()=>{restoredNotifications++;} }, async () => {
      throw new Error('fixture failure');
    }), /fixture failure/);
    assert.equal(current, 'old-node');
    assert.equal(await lease.pending('select'), null);
    assert.equal(restoredNotifications,2,'restoration is proved independently of action success');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('current-selection lease is read-only, journals custody and never calls the selector mutator', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-observed-'));
  let current = 'user-node', mutations = 0;
  const controller = {
    endpoint: 'http://127.0.0.1:9090',
    async config() { return { mode: 'rule' }; },
    async proxies() {
      return {
        select: { name: 'select', type: 'Selector', now: current, all: ['user-node', 'other-node'] },
        'user-node': { name: 'user-node', type: 'Shadowsocks' },
        'other-node': { name: 'other-node', type: 'Trojan' }
      };
    },
    async proxy() { return { name: 'select', type: 'Selector', now: current, all: ['user-node', 'other-node'] }; },
    async setSelection() { mutations += 1; throw new Error('must not mutate'); }
  };
  const lease = new SelectionLeaseManager({ controller, stateDirectory: dir });
  try {
    const result = await lease.withObservedSelection({
      group: 'select',
      expectedMode: 'rule',
      owner: { dmRunId: 'run_observe', processStartedAt: new Date().toISOString() }
    }, async active => {
      assert.equal(active.node, 'user-node');
      assert.equal((await lease.pending('select')).schema, 'dm.clash.selection-journal.v2');
      assert.equal(await active.assertCurrent(), true);
      return 'ok';
    });
    assert.equal(result.result, 'ok');
    assert.equal(result.selection, 'user-node');
    assert.equal(result.restored, false);
    assert.equal(result.evidence, 'OBSERVED_SELECTION_ONLY');
    assert.equal(mutations, 0);
    assert.equal(await lease.pending('select'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('current-selection lease fails closed after an external node change without changing it back', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-observed-change-'));
  let current = 'user-node', mutations = 0;
  const controller = {
    endpoint: 'http://127.0.0.1:9090',
    async config() { return { mode: 'rule' }; },
    async proxies() {
      return {
        select: { name: 'select', type: 'Selector', now: current, all: ['user-node', 'other-node'] },
        'user-node': { name: 'user-node', type: 'Shadowsocks' },
        'other-node': { name: 'other-node', type: 'Trojan' }
      };
    },
    async proxy() { return { name: 'select', type: 'Selector', now: current, all: ['user-node', 'other-node'] }; },
    async setSelection() { mutations += 1; }
  };
  const lease = new SelectionLeaseManager({ controller, stateDirectory: dir });
  try {
    await assert.rejects(lease.withObservedSelection({
      group: 'select',
      expectedMode: 'rule',
      owner: { dmRunId: 'run_observe_change', processStartedAt: new Date().toISOString() }
    }, async () => { current = 'other-node'; }), { code: 'CLASH_SELECTION_CHANGED_DURING_RUN' });
    assert.equal(current, 'other-node');
    assert.equal(mutations, 0);
    assert.equal(await lease.pending('select'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uncertain restoration leaves a journal and explicit recovery compares before restoring', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-recovery-'));
  let current = 'old-node', failRestore = true,restoredNotifications=0;
  const controller = {
    endpoint: 'http://127.0.0.1:9090',
    async config() { return { mode: 'rule' }; },
    async proxies() { return { select: { name: 'select', type: 'Selector', now: current, all: ['old-node', 'new-node'] }, 'old-node': { name: 'old-node', type: 'Shadowsocks' }, 'new-node': { name: 'new-node', type: 'Trojan' } }; },
    async proxy() { return { name: 'select', type: 'Selector', now: current, all: ['old-node', 'new-node'] }; },
    async setSelection(_group, node) { if (node === 'old-node' && failRestore) { failRestore = false; throw new Error('fixture restore interruption'); } current = node; }
  };
  const lease = new SelectionLeaseManager({ controller, stateDirectory: dir });
  const processStartedAt = new Date().toISOString(), owner = { dmRunId: 'run_recovery', processStartedAt };
  try {
    await assert.rejects(lease.withSelection({ group: 'select', node: 'new-node', expectedMode: 'rule', mutationScope: 'shared-selector', owner,onRestored:()=>{restoredNotifications++;} }, async () => 'done'), { code: 'CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY' });
    assert.equal(restoredNotifications,0,'failed restoration must not issue a clean-control notification');
    assert.equal(current, 'new-node'); assert.ok(await lease.pending('select'));
    const recovered = await lease.recover('select', processStartedAt);
    assert.equal(recovered.outcome, 'RESTORED_PREVIOUS'); assert.equal(current, 'old-node'); assert.equal(await lease.pending('select'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a timed-out mutation that may have committed keeps recovery evidence even after readback restore', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-uncertain-'));
  let current = 'old-node', first = true;
  const controller = {
    endpoint: 'http://127.0.0.1:9090', async config() { return { mode: 'rule' }; },
    async proxies() { return { select: { name: 'select', type: 'Selector', now: current, all: ['old-node', 'new-node'] }, 'old-node': { name: 'old-node', type: 'Shadowsocks' }, 'new-node': { name: 'new-node', type: 'Trojan' } }; },
    async proxy() { return { name: 'select', type: 'Selector', now: current, all: ['old-node', 'new-node'] }; },
    async setSelection(_group, node) { current = node; if (first) { first = false; throw Object.assign(new Error('timeout after commit'), { code: 'CLASH_CONTROLLER_TIMEOUT' }); } }
  };
  const lease = new SelectionLeaseManager({ controller, stateDirectory: dir }), processStartedAt = new Date().toISOString();
  try {
    await assert.rejects(lease.withSelection({ group: 'select', node: 'new-node', expectedMode: 'rule', mutationScope: 'shared-selector', owner: { dmRunId: 'run_uncertain', processStartedAt } }, async () => 'unreachable'), { code: 'CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY' });
    assert.equal(current, 'old-node'); assert.ok(await lease.pending('select'));
    const recovered = await lease.recover('select', processStartedAt); assert.equal(recovered.outcome, 'ALREADY_RESTORED'); assert.equal(await lease.pending('select'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('UI can change only the public Clash choice, preserving trusted config path', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-update-'));
  try {
    const path = resolve(dir, 'config.json');
    const settings = new Settings(path);
    const trustedPath = settings.value.clash.configPath;
    settings.updateUI({ clash: { enabled: true, selector: 'select', node: 'new-node', expectedMode: 'rule', configPath: 'C:/evil/config.yaml' } });
    assert.equal(settings.value.clash.configPath, trustedPath);
    assert.deepEqual(settings.public().config.clash, { enabled: true, selector: 'select', node: 'new-node', selectionPolicy: 'pinned', expectedMode: 'rule' });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).clash.configPath, trustedPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authenticated HTTP exposes disabled Clash status and keeps verification explicit', async t => {
  const parent = resolve(root, '.runtime/test-temp'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(resolve(parent, 'dm-clash-http-'));
  const configPath = resolve(dir, 'config.json'), config = structuredClone(defaults);
  config.clash.configPath = resolve(dir, 'missing-clash.yaml'); writeFileSync(configPath, JSON.stringify(config));
  const app = await createApp({ root, data: dir, configPath, port: 0 });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  let cookie = '', csrf = '';
  const call = async (path, method = 'GET', value) => {
    const response = await fetch(app.origin + '/api' + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() }) },
      body: value === undefined ? undefined : JSON.stringify(value)
    });
    const body = await response.json();
    return { status: response.status, body, headers: response.headers };
  };
  const login = await call('/session', 'POST', { bootstrap: app.bootstrap });
  cookie = login.headers.get('set-cookie').split(';')[0]; csrf = login.body.csrf;
  const status = await call('/clash');
  assert.equal(status.status, 200);
  assert.equal(status.body.enabled, false);
  const verify = await call('/clash/verify', 'POST', {});
  assert.equal(verify.status, 409);
  assert.equal(verify.body.error, 'CLASH_ROUTE_DISABLED');
});
