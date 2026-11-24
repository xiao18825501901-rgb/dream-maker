import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireServerLock,
  probeProcessIdentity,
  resetProcessIdentityCache,
  releaseServerLock,
  windowsIdentityProbe,
} from '../dist/server/server-lock.js';

function tempDir(t) {
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-server-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function options(overrides = {}) {
  return {
    pid: 4242,
    identity: 'win32:638900000000000000',
    now: new Date('2026-10-29T08:00:00.000Z'),
    nonce: 'nonce-current-0001',
    host: 'acceptance-host',
    dataDir: 'C:\\Dream Maker\\data with spaces',
    ...overrides,
  };
}

test('a fresh lock records process identity, time, host and nonce', t => {
  const dir = tempDir(t), path = resolve(dir, 'server.lock');
  const lock = acquireServerLock(path, options());
  const written = JSON.parse(readFileSync(path, 'utf8'));

  assert.deepEqual(written, lock.record);
  assert.equal(written.schema, 'dream-maker.server-lock.v1');
  assert.equal(written.pid, 4242);
  assert.equal(written.processIdentity, 'win32:638900000000000000');
  assert.equal(written.acquiredAt, '2026-10-29T08:00:00.000Z');
  assert.equal(written.nonce, 'nonce-current-0001');
  assert.equal(written.host, 'acceptance-host');
  assert.equal(written.dataDir, 'C:\\Dream Maker\\data with spaces');
  assert.equal(lock.release(), true);
  assert.equal(readdirSync(dir).includes('server.lock'), false);
});

test('the same live pid and process identity are recognised as an active owner', t => {
  const dir = tempDir(t), path = resolve(dir, 'server.lock');
  const first = acquireServerLock(path, options());

  assert.throws(
    () => acquireServerLock(path, options({ nonce: 'nonce-second-0002' })),
    error => error.code === 'SERVER_LOCK_ACTIVE' && error.ownerPid === 4242,
  );
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), first.record);
});

test('a reused pid with a different process identity is archived as stale', t => {
  const dir = tempDir(t), path = resolve(dir, 'server.lock');
  acquireServerLock(path, options({ identity: 'win32:old-process' }));

  const replacement = acquireServerLock(path, options({
    identity: 'win32:new-process',
    nonce: 'nonce-replacement-0003',
    now: new Date('2026-10-29T08:01:00.000Z'),
  }));
  const current = JSON.parse(readFileSync(path, 'utf8'));
  const stale = readdirSync(dir).filter(name => name.startsWith('server.lock.stale-'));

  assert.equal(current.processIdentity, 'win32:new-process');
  assert.equal(current.nonce, 'nonce-replacement-0003');
  assert.equal(stale.length, 1);
  assert.equal(JSON.parse(readFileSync(resolve(dir, stale[0]), 'utf8')).processIdentity, 'win32:old-process');
  assert.equal(replacement.release(), true);
});

test('legacy or corrupt lock files fail closed without being deleted', t => {
  const dir = tempDir(t), path = resolve(dir, 'server.lock');

  writeFileSync(path, JSON.stringify({ pid: 4242, startedAt: '2026-10-29T08:00:00.000Z' }));
  assert.throws(
    () => acquireServerLock(path, options({ identity: 'win32:new-process' })),
    error => error.code === 'SERVER_LOCK_LEGACY',
  );
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 4242);

  writeFileSync(path, '{not-json');
  assert.throws(
    () => acquireServerLock(path, options({ identity: 'win32:new-process' })),
    error => error.code === 'SERVER_LOCK_INVALID',
  );
  assert.equal(readFileSync(path, 'utf8'), '{not-json');
});

test('release refuses to remove a lock that now belongs to another nonce', t => {
  const dir = tempDir(t), path = resolve(dir, 'server.lock');
  const lock = acquireServerLock(path, options());
  const replacement = { ...lock.record, nonce: 'nonce-other-owner-0004' };
  writeFileSync(path, JSON.stringify(replacement));

  assert.equal(lock.release(), false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).nonce, 'nonce-other-owner-0004');
  assert.equal(releaseServerLock(path, 'nonce-current-0001', 4242), false);
  assert.equal(releaseServerLock(path, 'nonce-other-owner-0004', 4242), true);
});

test('identity lookup failure blocks acquisition without touching an existing lock', t => {
  const dir = tempDir(t), path = resolve(dir, 'server.lock');
  mkdirSync(dir, { recursive: true });
  const prior = JSON.stringify({
    schema: 'dream-maker.server-lock.v1',
    pid: 4242,
    processIdentity: 'win32:unknown',
    acquiredAt: '2026-10-29T07:59:00.000Z',
    host: 'acceptance-host',
    dataDir: 'data',
    nonce: 'nonce-prior-0005',
  });
  writeFileSync(path, prior);

  assert.throws(
    () => acquireServerLock(path, options({
      identity: undefined,
      identityProvider: () => {
        throw Object.assign(new Error('process query denied'), { code: 'EACCES' });
      },
    })),
    error => error.code === 'SERVER_LOCK_IDENTITY_UNAVAILABLE',
  );
  assert.equal(readFileSync(path, 'utf8'), prior);
});

test('an acquisition guard blocks concurrent takeover instead of archiving a new owner', t => {
  const dir = tempDir(t), path = resolve(dir, 'server.lock'), guard = `${path}.acquire`;
  const prior = JSON.stringify({
    schema: 'dream-maker.server-lock.v1',
    pid: 4242,
    processIdentity: 'win32:stale-owner',
    acquiredAt: '2026-10-29T07:59:00.000Z',
    host: 'acceptance-host',
    dataDir: 'data',
    nonce: 'nonce-prior-0006',
  });
  writeFileSync(path, prior);
  mkdirSync(guard);

  assert.throws(
    () => acquireServerLock(path, options({ identity: 'win32:new-owner' })),
    error => error.code === 'SERVER_LOCK_ACQUISITION_BUSY',
  );
  assert.equal(readFileSync(path, 'utf8'), prior);
  assert.equal(readdirSync(dir).includes('server.lock.acquire'), true);
});

// R18: a real Classic+Prework run died at IMPLEMENTING with
// "Error: spawnSync powershell.exe ETIMEDOUT". Measured on this host: the first
// PowerShell start after contention took 39.9s / 14.9s, then 2.8s / 2.6s warm,
// against a hard 5s ceiling. The identity query is read-only and the win32 start
// ticks of a running process never change, so one bounded retry is safe.
test('a cold-start identity timeout is retried once instead of failing the dispatch', () => {
  const original = windowsIdentityProbe.run;
  let calls = 0;
  try {
    resetProcessIdentityCache();
    windowsIdentityProbe.run = () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return '638900000000000000';
    };
    assert.equal(probeProcessIdentity(process.pid), 'win32:638900000000000000');
    assert.equal(calls, 2);
  } finally {
    windowsIdentityProbe.run = original;
    resetProcessIdentityCache();
  }
});

test('a persistent identity failure still throws after the bounded attempts', () => {
  const original = windowsIdentityProbe.run;
  let calls = 0;
  try {
    resetProcessIdentityCache();
    windowsIdentityProbe.run = () => {
      calls += 1;
      throw Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
    };
    assert.throws(() => probeProcessIdentity(process.pid), error => error.code === 'ETIMEDOUT');
    assert.equal(calls, 2);
  } finally {
    windowsIdentityProbe.run = original;
    resetProcessIdentityCache();
  }
});

test('the controller process identity is resolved once and reused', () => {
  const original = windowsIdentityProbe.run;
  let calls = 0;
  try {
    windowsIdentityProbe.run = () => {
      calls += 1;
      return '638911111111111111';
    };
    resetProcessIdentityCache();
    assert.equal(probeProcessIdentity(process.pid), 'win32:638911111111111111');
    assert.equal(probeProcessIdentity(process.pid), 'win32:638911111111111111');
    assert.equal(calls, 1);
  } finally {
    windowsIdentityProbe.run = original;
    resetProcessIdentityCache();
  }
});
