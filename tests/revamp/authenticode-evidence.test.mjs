import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {harness} from '../helpers.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const script = resolve('scripts/revamp/collect-authenticode-evidence.ps1');
const powerShell = 'pwsh.exe';

test('Authenticode inventory records signed and unsigned PE files without executing them', t => {
  if (process.platform !== 'win32') {
    t.skip('Windows Authenticode evidence is Windows-only');
    return;
  }
  const h = harness(t);
  const runtime = join(h.dir, 'runtime');
  const output = join(h.dir, 'evidence', 'authenticode.json');
  mkdirSync(runtime, {recursive: true});
  writeFileSync(join(runtime, 'tool.exe'), Buffer.from('NOT_A_PE_BUT_NAMED_EXE'));
  writeFileSync(join(runtime, 'library.dll'), Buffer.from('NOT_A_PE_BUT_NAMED_DLL'));
  writeFileSync(join(runtime, 'ignored.txt'), Buffer.from('IGNORE'));

  const artifact = join(h.dir, 'runtime.tar');
  const artifactBody = Buffer.from('fixed-runtime-archive');
  writeFileSync(artifact, artifactBody);

  const result = spawnSync(powerShell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-RuntimeRoot',
    runtime,
    '-ArtifactPath',
    artifact,
    '-ArtifactSha256',
    sha256(artifactBody),
    '-RuntimeTreeSha256',
    'a'.repeat(64),
    '-ComponentId',
    'codex-runtime',
    '-Version',
    '0.162.0',
    '-Output',
    output
  ], {
    cwd: resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(output), true);
  const evidence = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(evidence.schema, 'dream-maker.windows-authenticode-evidence.v1');
  assert.equal(evidence.componentId, 'codex-runtime');
  assert.equal(evidence.version, '0.162.0');
  assert.equal(evidence.artifactSha256, sha256(artifactBody));
  assert.equal(evidence.runtimeTreeSha256, 'a'.repeat(64));
  assert.equal(evidence.totalPeFiles, 2);
  assert.equal(evidence.files.length, 2);
  assert.equal(evidence.files.some(file => file.path === 'ignored.txt'), false);
  assert.equal(evidence.files.every(file => file.status !== 'Valid'), true);
  assert.equal(evidence.unsignedCount, 2);
  assert.equal(evidence.status, 'PARTIAL');
  assert.equal(evidence.binariesExecuted, false);
});

test('Authenticode evidence refuses to overwrite an existing report', t => {
  if (process.platform !== 'win32') {
    t.skip('Windows Authenticode evidence is Windows-only');
    return;
  }
  const h = harness(t);
  const runtime = join(h.dir, 'runtime');
  const artifact = join(h.dir, 'runtime.tar');
  const output = join(h.dir, 'evidence.json');
  mkdirSync(runtime, {recursive: true});
  writeFileSync(join(runtime, 'tool.exe'), Buffer.from('NOT_A_PE'));
  writeFileSync(artifact, Buffer.from('archive'));
  writeFileSync(output, '{"preserved":true}\n');

  const result = spawnSync(powerShell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-RuntimeRoot',
    runtime,
    '-ArtifactPath',
    artifact,
    '-ArtifactSha256',
    sha256(Buffer.from('archive')),
    '-RuntimeTreeSha256',
    'b'.repeat(64),
    '-ComponentId',
    'codex-runtime',
    '-Version',
    '0.162.0',
    '-Output',
    output
  ], {
    cwd: resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /OUTPUT_EXISTS/);
  assert.equal(readFileSync(output, 'utf8'), '{"preserved":true}\n');
});
