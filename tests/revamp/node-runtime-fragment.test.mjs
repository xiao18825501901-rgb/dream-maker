import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {harness} from '../helpers.mjs';
import {childEnv} from '../../dist/server/security.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const gitBlobSha = value => createHash('sha1')
  .update(`blob ${Buffer.byteLength(value)}\0`)
  .update(value)
  .digest('hex');
const script = resolve('scripts/revamp/build-node-runtime-fragment.mjs');
const packageNames = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-sdk-protocol',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-llm-deepseek-api-key'
];

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function fixture(t) {
  const base = harness(t).dir;
  const root = join(base, 'evidence');
  const runtime = join(base, 'runtime');
  const output = join(root, 'inventory');
  mkdirSync(root, {recursive: true});
  mkdirSync(runtime, {recursive: true});
  mkdirSync(output, {recursive: true});

  const artifactBody = Buffer.from('fixed-dsh-runtime-artifact');
  const artifactPath = join(root, 'dsh-runtime.tar');
  writeFileSync(artifactPath, artifactBody);
  const artifactSha256 = sha256(artifactBody);

  const licenseBody = Buffer.from('MIT\nApache-2.0\n');
  const licensePath = join(output, 'THIRD_PARTY_LICENSES.txt');
  writeFileSync(licensePath, licenseBody);

  const dependencies = Object.fromEntries(
    packageNames.map(name => [name, '0.2.0-rc.1'])
  );
  const packageBody = Buffer.from(JSON.stringify({
    name: 'dream-maker-dsh-sdk-bundle',
    version: '0.2.0-rc.1',
    dependencies
  }, null, 2) + '\n');
  writeFileSync(join(runtime, 'package.json'), packageBody);
  const lockPackages = {
    '': {
      name: 'dream-maker-dsh-sdk-bundle',
      version: '0.2.0-rc.1',
      dependencies
    }
  };
  for (const [index, name] of packageNames.entries()) {
    const packageDirectory = join(runtime, 'node_modules', ...name.split('/'));
    mkdirSync(packageDirectory, {recursive: true});
    writeJson(join(packageDirectory, 'package.json'), {
      name,
      version: '0.2.0-rc.1'
    });
    lockPackages[`node_modules/${name}`] = {
      version: '0.2.0-rc.1',
      resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-0.2.0-rc.1.tgz`,
      integrity: `sha512-${Buffer.from(`fixture-${index}`).toString('base64')}`
    };
  }
  writeJson(join(runtime, 'package-lock.json'), {
    name: 'dream-maker-dsh-sdk-bundle',
    version: '0.2.0-rc.1',
    lockfileVersion: 3,
    requires: true,
    packages: lockPackages
  });

  const sbom = {
    schema: 'dream-maker.component-sbom.v1',
    status: 'COMPLETE',
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    artifactSha256,
    machineReadableComplete: true,
    dependencyCount: 0,
    dependencies: [],
    inventory: {
      method: 'PACKAGE_JSON_DIRECTORY_TREE',
      rootTreeSha256: 'a'.repeat(64),
      fileCount: 1,
      packageCount: 1,
      packageFragmentCount: 0,
      totalBytes: packageBody.length
    }
  };
  const sbomPath = join(output, 'component-sbom.json');
  writeJson(sbomPath, sbom);
  const sbomSha256 = sha256(readFileSync(sbomPath));

  const receipt = {
    schema: 'dream-maker.node-runtime-inventory.v1',
    status: 'COMPLETE',
    machineReadableComplete: true,
    artifact: {
      path: artifactPath,
      bytes: artifactBody.length,
      sha256: artifactSha256
    },
    root: runtime,
    output,
    rootTreeSha256: sbom.inventory.rootTreeSha256,
    sbomSha256,
    licenseBundle: {
      path: licensePath,
      bytes: licenseBody.length,
      sha256: sha256(licenseBody)
    },
    missingLicenses: [],
    redistributionReviewed: false,
    modelCalls: 0,
    networkRequests: 0
  };
  const receiptPath = join(root, 'receipt.json');
  writeJson(receiptPath, receipt);

  const cleanWindowsPath = join(root, 'clean-windows.json');
  writeJson(cleanWindowsPath, {
    schema: 'dream-maker.component-clean-windows-evidence.v1',
    status: 'PASS',
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    artifactSha256,
    platform: 'win32'
  });

  const sourceRoot = join(root, 'source');
  const registryRoot = join(sourceRoot, 'registry');
  const upstreamRoot = join(sourceRoot, 'upstream');
  mkdirSync(registryRoot, {recursive: true});
  mkdirSync(upstreamRoot, {recursive: true});
  const sourcePackages = [];
  const treeEntries = [];
  for (const [index, name] of packageNames.entries()) {
    const tail = name.replace('@deepseek-ai/', '');
    const repositoryDirectory = `packages/fixture/${tail}`;
    const registryBody = Buffer.from(JSON.stringify({
      name,
      version: '0.2.0-rc.1',
      repository: {
        type: 'git',
        url: 'git+https://github.com/deepseek-ai/deepseek-harness.git',
        directory: repositoryDirectory
      },
      dist: {
        integrity: lockPackages[`node_modules/${name}`].integrity,
        shasum: `${index}`.padStart(40, '0'),
        tarball: lockPackages[`node_modules/${name}`].resolved
      }
    }, null, 2) + '\n');
    const registryPath = join(registryRoot, `${tail}.json`);
    writeFileSync(registryPath, registryBody);

    const manifestPath = `${repositoryDirectory}/package.json`;
    const manifestBody = Buffer.from(JSON.stringify({
      name,
      version: '0.2.0-rc.1'
    }, null, 2) + '\n');
    const upstreamPath = join(upstreamRoot, `${tail}.package.json`);
    writeFileSync(upstreamPath, manifestBody);
    const blobSha = gitBlobSha(manifestBody);
    treeEntries.push({path: manifestPath, type: 'blob', sha: blobSha});
    sourcePackages.push({
      name,
      version: '0.2.0-rc.1',
      lockIntegrity: lockPackages[`node_modules/${name}`].integrity,
      lockResolved: lockPackages[`node_modules/${name}`].resolved,
      repositoryDirectory,
      registry: {
        path: `source/registry/${tail}.json`,
        sha256: sha256(registryBody)
      },
      upstreamManifest: {
        path: `source/upstream/${tail}.package.json`,
        sha256: sha256(manifestBody),
        gitBlobSha: blobSha
      }
    });
  }
  const treeSha = 'b'.repeat(40);
  const treeBody = Buffer.from(JSON.stringify({
    schema: 'dream-maker.github-tree-receipt.v1',
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    revision: '4878cdabd87d4041bdaff61d04c966883b9fd07a',
    sha: treeSha,
    truncated: false,
    entries: treeEntries
  }, null, 2) + '\n');
  const treeReceiptPath = join(sourceRoot, 'tree.json');
  writeFileSync(treeReceiptPath, treeBody);
  const commitBody = Buffer.from(JSON.stringify({
    schema: 'dream-maker.github-commit-receipt.v1',
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    sha: '4878cdabd87d4041bdaff61d04c966883b9fd07a',
    treeSha,
    message: 'release(dsh): 0.2.0-rc.1 (#5387)',
    verification: {verified: false, reason: 'unsigned'},
    treeReceipt: {
      path: 'source/tree.json',
      sha256: sha256(treeBody)
    }
  }, null, 2) + '\n');
  const commitReceiptPath = join(sourceRoot, 'commit.json');
  writeFileSync(commitReceiptPath, commitBody);
  const sourceProofPath = join(sourceRoot, 'source-proof.json');
  writeJson(sourceProofPath, {
    schema: 'dream-maker.node-runtime-source-proof.v1',
    status: 'VERIFIED',
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    runtimeRootTreeSha256: sbom.inventory.rootTreeSha256,
    source: {
      kind: 'GIT_COMMIT',
      locator: 'https://github.com/deepseek-ai/deepseek-harness',
      revision: '4878cdabd87d4041bdaff61d04c966883b9fd07a'
    },
    commitReceipt: {
      path: 'source/commit.json',
      sha256: sha256(commitBody)
    },
    packages: sourcePackages,
    networkRequests: 2 + 2 * sourcePackages.length,
    modelCalls: 0,
    credentialsRead: false,
    boundary: 'PINNED_OFFICIAL_RECEIPTS_UNSIGNED_COMMIT'
  });

  return {
    base,
    root,
    receiptPath,
    cleanWindowsPath,
    runtime,
    sourceProofPath,
    sourceProofSha256: sha256(readFileSync(sourceProofPath)),
    treeReceiptPath,
    commitReceiptPath,
    receiptSha256: sha256(readFileSync(receiptPath)),
    cleanWindowsSha256: sha256(readFileSync(cleanWindowsPath))
  };
}

const commonArgs = fixtureValue => [
  '--root', fixtureValue.root,
  '--receipt', fixtureValue.receiptPath,
  '--receipt-sha256', fixtureValue.receiptSha256,
  '--component-id', 'dsh-runtime',
  '--package-name', 'dream-maker-dsh-sdk-bundle',
  '--version', '0.2.0-rc.1',
  '--source-locator', 'https://github.com/deepseek-ai/deepseek-harness',
  '--source-revision', '4878cdabd87d4041bdaff61d04c966883b9fd07a'
];

function runBuilder(value, extraArgs = []) {
  const args = [...commonArgs(value)];
  for (let index = 0; index < extraArgs.length; index += 2) {
    const name = extraArgs[index];
    const replacement = extraArgs[index + 1];
    const existing = args.indexOf(name);
    if (existing >= 0) args[existing + 1] = replacement;
    else args.push(name, replacement);
  }
  return spawnSync(process.execPath, [
    script,
    ...args
  ], {
    cwd: resolve('.'),
    env: childEnv({DREAMMAKER_SUITE_ROOT: value.base}),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });
}

test('a pinned DSH runtime inventory produces a partial fragment without claiming release', t => {
  const value = fixture(t);
  const output = join(value.base, 'output', 'dsh-runtime.fragment.json');
  const result = runBuilder(value, ['--output', output]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fragment = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(fragment.schema, 'dream-maker.release-component-fragment.v1');
  assert.equal(fragment.componentId, 'dsh-runtime');
  assert.equal(fragment.component.version, '0.2.0-rc.1');
  assert.equal(fragment.status, 'PARTIAL_COMPONENT_EVIDENCE');
  assert.equal(fragment.componentGate.evidenceVerified, false);
  assert.equal(fragment.componentGate.completeDistribution, false);
  assert.equal(fragment.releaseReady, false);
  assert.equal(fragment.sourceEvidence, 'CALLER_PINNED_NO_INDEPENDENT_COMMIT_PROOF');
  assert.ok(fragment.blockers.includes('CLEAN_WINDOWS_REFERENCE_INVALID'));
  assert.ok(fragment.blockers.includes('REDISTRIBUTION_NOT_REVIEWED'));
  assert.ok(fragment.blockers.includes('SOURCE_IDENTITY_NOT_VERIFIED'));
  assert.equal(fragment.modelCalls, 0);
  assert.equal(fragment.binariesExecuted, false);
  assert.equal(fragment.credentialsRead, false);
});

test('a pinned clean-Windows document removes only that blocker', t => {
  const value = fixture(t);
  const output = join(value.base, 'output', 'dsh-runtime.clean.fragment.json');
  const result = runBuilder(value, [
    '--clean-windows', value.cleanWindowsPath,
    '--clean-windows-sha256', value.cleanWindowsSha256,
    '--output', output
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fragment = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(fragment.cleanWindowsEvidence.sha256, value.cleanWindowsSha256);
  assert.equal(fragment.blockers.includes('CLEAN_WINDOWS_REFERENCE_INVALID'), false);
  assert.ok(fragment.blockers.includes('REDISTRIBUTION_NOT_REVIEWED'));
  assert.ok(fragment.blockers.includes('SOURCE_IDENTITY_NOT_VERIFIED'));
  assert.equal(fragment.releaseReady, false);
});

test('official npm and GitHub receipts verify DSH source identity without claiming signed provenance', t => {
  const value = fixture(t);
  const output = join(value.base, 'output', 'dsh-runtime.source.fragment.json');
  const result = runBuilder(value, [
    '--source-proof', value.sourceProofPath,
    '--source-proof-sha256', value.sourceProofSha256,
    '--output', output
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fragment = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(fragment.sourceEvidence, 'PINNED_OFFICIAL_COMMIT_AND_REGISTRY_RECEIPTS');
  assert.equal(fragment.sourceIdentityVerified, true);
  assert.equal(fragment.sourceCommitSigned, false);
  assert.equal(fragment.sourceProof.sha256, value.sourceProofSha256);
  assert.equal(fragment.blockers.includes('SOURCE_IDENTITY_NOT_VERIFIED'), false);
  assert.ok(fragment.blockers.includes('CLEAN_WINDOWS_REFERENCE_INVALID'));
  assert.ok(fragment.blockers.includes('REDISTRIBUTION_NOT_REVIEWED'));
  assert.equal(fragment.releaseReady, false);
});

test('source receipts fail closed on local manifest, registry, and argument-pair tampering', t => {
  const localValue = fixture(t);
  const localPackage = join(
    localValue.runtime,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'package.json'
  );
  writeJson(localPackage, {name: '@deepseek-ai/dsh', version: '9.9.9'});
  const localOutput = join(localValue.base, 'output', 'local-tamper.fragment.json');
  const localResult = runBuilder(localValue, [
    '--source-proof', localValue.sourceProofPath,
    '--source-proof-sha256', localValue.sourceProofSha256,
    '--output', localOutput
  ]);
  assert.notEqual(localResult.status, 0);
  assert.match(localResult.stderr, /SOURCE_PROOF_LOCAL_PACKAGE_MISMATCH/);
  assert.equal(existsSync(localOutput), false);

  const registryValue = fixture(t);
  const registryPath = join(
    registryValue.root,
    'source',
    'registry',
    'dsh.json'
  );
  writeFileSync(registryPath, '{}\n');
  const registryOutput = join(registryValue.base, 'output', 'registry-tamper.fragment.json');
  const registryResult = runBuilder(registryValue, [
    '--source-proof', registryValue.sourceProofPath,
    '--source-proof-sha256', registryValue.sourceProofSha256,
    '--output', registryOutput
  ]);
  assert.notEqual(registryResult.status, 0);
  assert.match(registryResult.stderr, /SOURCE_PROOF_REGISTRY_DIGEST_MISMATCH/);
  assert.equal(existsSync(registryOutput), false);

  const pairValue = fixture(t);
  const pairOutput = join(pairValue.base, 'output', 'source-pair.fragment.json');
  const pairResult = runBuilder(pairValue, [
    '--source-proof', pairValue.sourceProofPath,
    '--output', pairOutput
  ]);
  assert.notEqual(pairResult.status, 0);
  assert.match(pairResult.stderr, /SOURCE_PROOF_ARGUMENT_PAIR_REQUIRED/);
  assert.equal(existsSync(pairOutput), false);
});

test('tampered input or a non-pair clean-Windows option fails before output', t => {
  const value = fixture(t);
  const digestOutput = join(value.base, 'output', 'digest.fragment.json');
  const digest = runBuilder(value, [
    '--receipt-sha256', 'f'.repeat(64),
    '--output', digestOutput
  ]);
  assert.notEqual(digest.status, 0);
  assert.match(digest.stderr, /EVIDENCE_DIGEST_MISMATCH/);
  assert.equal(existsSync(digestOutput), false);

  const pairOutput = join(value.base, 'output', 'pair.fragment.json');
  const pair = runBuilder(value, [
    '--clean-windows', value.cleanWindowsPath,
    '--output', pairOutput
  ]);
  assert.notEqual(pair.status, 0);
  assert.match(pair.stderr, /CLEAN_WINDOWS_ARGUMENT_PAIR_REQUIRED/);
  assert.equal(existsSync(pairOutput), false);
});
