import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {harness} from '../helpers.mjs';
import {childEnv} from '../../dist/server/security.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const script = resolve('scripts/revamp/build-codex-runtime-fragment.mjs');

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

test('a prepared Codex runtime fragment binds artifact, SBOM and signature evidence without claiming release', t => {
  const h = harness(t);
  const root = join(h.dir, 'codex-evidence');
  mkdirSync(root, {recursive: true});
  const artifactBody = Buffer.from('fixed-codex-runtime-archive');
  const artifact = join(root, 'runtime.tar');
  writeFileSync(artifact, artifactBody);
  const artifactSha256 = sha256(artifactBody);
  const licenseBody = Buffer.from('Apache-2.0\nMIT\n');
  const license = join(root, 'THIRD_PARTY_LICENSES.txt');
  writeFileSync(license, licenseBody);
  const reclassifiedSbom = {
    schema: 'dream-maker.component-sbom.v1',
    status: 'COMPLETE',
    componentId: 'codex-runtime',
    version: '0.162.0',
    artifactSha256,
    machineReadableComplete: true,
    dependencyCount: 1,
    inventory: {
      method: 'PACKAGE_JSON_DIRECTORY_TREE',
      rootTreeSha256: 'a'.repeat(64),
      fileCount: 1,
      packageCount: 1,
      packageFragmentCount: 0,
      totalBytes: 1
    },
    dependencies: [{
      id: '@openai/codex@0.162.0',
      package: '@openai/codex',
      version: '0.162.0',
      path: '',
      manifestSha256: 'b'.repeat(64),
      declaredLicense: 'Apache-2.0',
      license: {
        status: 'PRESENT',
        files: [{path: 'LICENSE', bytes: 1, sha256: 'd'.repeat(64)}]
      }
    }]
  };
  mkdirSync(join(root, 'reclassified'), {recursive: true});
  const sbomPath = join(root, 'reclassified', 'component-sbom.json');
  writeJson(sbomPath, reclassifiedSbom);
  const preparationSbom = {...reclassifiedSbom, componentId: 'codex-cli'};
  const preparationSbomPath = join(root, 'component-sbom.json');
  writeJson(preparationSbomPath, preparationSbom);
  const signature = {
    schema: 'dream-maker.windows-authenticode-evidence.v1',
    at: '2026-11-07T00:00:00.000Z',
    componentId: 'codex-runtime',
    version: '0.162.0',
    artifactSha256,
    runtimeTreeSha256: 'a'.repeat(64),
    status: 'PARTIAL',
    totalPeFiles: 1,
    validCount: 0,
    unsignedCount: 1,
    invalidCount: 0,
    unsignedFiles: ['tool.exe'],
    invalidFiles: [],
    files: [],
    binariesExecuted: false,
    modelCalls: 0
  };
  const signaturePath = join(root, 'authenticode.json');
  writeJson(signaturePath, signature);
  const receipt = {
    schema: 'dream-maker.component-preparation.v1',
    status: 'FIXED_CODEX_CLI_COMPONENT_EVIDENCE_CREATED',
    upstream: {
      repository: 'https://github.com/openai/codex',
      tag: 'rust-v0.162.0',
      tagObject: 'd'.repeat(40),
      commit: 'c'.repeat(40),
      tagSignature: 'NOT_VERIFIED'
    },
    artifact: {
      path: artifact,
      bytes: artifactBody.length,
      sha256: artifactSha256
    },
    inventory: {
      sbomSha256: sha256(readFileSync(preparationSbomPath)),
      rootTreeSha256: 'a'.repeat(64),
      licenseBundle: {
        path: license,
        bytes: licenseBody.length,
        sha256: sha256(licenseBody)
      }
    },
    redistributionReviewed: false,
    cleanWindows: 'NOT_VERIFIED'
  };
  const receiptPath = join(root, 'preparation-receipt.json');
  writeJson(receiptPath, receipt);
  const runtimeRoot = join(h.dir, 'runtime');
  mkdirSync(runtimeRoot, {recursive: true});
  const packageBody = Buffer.from(JSON.stringify({
    name: '@openai/codex',
    version: '0.162.0',
    license: 'Apache-2.0'
  }, null, 2) + '\n');
  writeFileSync(join(runtimeRoot, 'package.json'), packageBody);
  const packageEntry = {
    path: 'package.json',
    bytes: packageBody.length,
    sha256: sha256(packageBody)
  };
  receipt.runtimeRoot = runtimeRoot;
  receipt.sourceTree = {files: [packageEntry], treeSha256: 'a'.repeat(64)};
  receipt.copiedTree = {files: [packageEntry], treeSha256: 'a'.repeat(64)};
  writeJson(receiptPath, receipt);
  const inventoryReceipt = {
    schema: 'dream-maker.node-runtime-inventory.v1',
    artifact: receipt.artifact,
    root: runtimeRoot,
    output: join(root, 'reclassified'),
    sbomSha256: sha256(readFileSync(sbomPath)),
    rootTreeSha256: 'a'.repeat(64),
    licenseBundle: receipt.inventory.licenseBundle,
    status: 'COMPLETE',
    machineReadableComplete: true,
    missingLicenses: [],
    modelCalls: 0,
    networkRequests: 0,
    redistributionReviewed: false
  };
  const inventoryReceiptPath = join(root, 'runtime-inventory-receipt.json');
  writeJson(inventoryReceiptPath, inventoryReceipt);
  const output = join(h.dir, 'output', 'codex-runtime.fragment.json');

  const result = spawnSync(process.execPath, [
    script,
    '--root', root,
    '--receipt', receiptPath,
    '--receipt-sha256', sha256(readFileSync(receiptPath)),
    '--signature', signaturePath,
    '--signature-sha256', sha256(readFileSync(signaturePath)),
    '--inventory-receipt', inventoryReceiptPath,
    '--inventory-receipt-sha256', sha256(readFileSync(inventoryReceiptPath)),
    '--output', output
  ], {
    cwd: resolve('.'),
    env: childEnv({DREAMMAKER_SUITE_ROOT: h.dir}),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fragment = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(fragment.schema, 'dream-maker.release-component-fragment.v1');
  assert.equal(fragment.componentId, 'codex-runtime');
  assert.equal(fragment.component.version, '0.162.0');
  assert.equal(fragment.component.artifact.sha256, artifactSha256);
  assert.equal(fragment.sourceIdentityVerified, true);
  assert.equal(fragment.sourceCommitSigned, false);
  assert.equal(fragment.sourceEvidence, 'PINNED_PREPARATION_RECEIPT_UPSTREAM_TAG_AND_COMMIT');
  assert.equal(fragment.sourceProof.path, 'preparation-receipt.json');
  assert.equal(fragment.sourceProof.sha256, sha256(readFileSync(receiptPath)));
  assert.equal(fragment.sourceProof.tag, 'rust-v0.162.0');
  assert.equal(fragment.sourceProof.tagObject, receipt.upstream.tagObject);
  assert.equal(fragment.sourceProof.commit, receipt.upstream.commit);
  assert.equal(fragment.sourceProof.tagSignature, 'NOT_VERIFIED');
  assert.equal(fragment.componentGate.evidenceVerified, false);
  assert.equal(fragment.componentGate.completeDistribution, false);
  assert.equal(fragment.releaseReady, false);
  assert.ok(fragment.blockers.includes('CLEAN_WINDOWS_REFERENCE_INVALID'));
  assert.equal(fragment.blockers.includes('INVALID_SBOM_EVIDENCE'), false);
  assert.ok(fragment.blockers.includes('AUTHENTICODE_PARTIAL'));
  assert.ok(fragment.blockers.includes('REDISTRIBUTION_NOT_REVIEWED'));
  assert.ok(fragment.blockers.includes('TAG_SIGNATURE_NOT_VERIFIED'));
  assert.equal(fragment.modelCalls, 0);
  assert.equal(fragment.binariesExecuted, false);

  const mismatchedReceipt = structuredClone(receipt);
  mismatchedReceipt.upstream.tag = 'rust-v0.161.0';
  const mismatchedReceiptPath = join(root, 'mismatched-preparation-receipt.json');
  writeJson(mismatchedReceiptPath, mismatchedReceipt);
  const mismatchedOutput = join(h.dir, 'output', 'codex-runtime.mismatched-tag.fragment.json');
  const mismatchedResult = spawnSync(process.execPath, [
    script,
    '--root', root,
    '--receipt', mismatchedReceiptPath,
    '--receipt-sha256', sha256(readFileSync(mismatchedReceiptPath)),
    '--signature', signaturePath,
    '--signature-sha256', sha256(readFileSync(signaturePath)),
    '--inventory-receipt', inventoryReceiptPath,
    '--inventory-receipt-sha256', sha256(readFileSync(inventoryReceiptPath)),
    '--output', mismatchedOutput
  ], {
    cwd: resolve('.'),
    env: childEnv({DREAMMAKER_SUITE_ROOT: h.dir}),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });
  assert.notEqual(mismatchedResult.status, 0);
  assert.match(mismatchedResult.stderr, /UPSTREAM_IDENTITY_INVALID/);
  assert.equal(existsSync(mismatchedOutput), false);

  const cleanWindowsBody = {
    schema: 'dream-maker.component-clean-windows-evidence.v1',
    status: 'PASS',
    componentId: 'codex-runtime',
    version: '0.162.0',
    artifactSha256,
    platform: 'win32'
  };
  const cleanWindowsPath = join(root, 'clean-windows.json');
  writeJson(cleanWindowsPath, cleanWindowsBody);
  const cleanWindowsSha256 = sha256(readFileSync(cleanWindowsPath));
  const cleanOutput = join(h.dir, 'output', 'codex-runtime.clean.fragment.json');
  const cleanResult = spawnSync(process.execPath, [
    script,
    '--root', root,
    '--receipt', receiptPath,
    '--receipt-sha256', sha256(readFileSync(receiptPath)),
    '--signature', signaturePath,
    '--signature-sha256', sha256(readFileSync(signaturePath)),
    '--inventory-receipt', inventoryReceiptPath,
    '--inventory-receipt-sha256', sha256(readFileSync(inventoryReceiptPath)),
    '--clean-windows', cleanWindowsPath,
    '--clean-windows-sha256', cleanWindowsSha256,
    '--output', cleanOutput
  ], {
    cwd: resolve('.'),
    env: childEnv({DREAMMAKER_SUITE_ROOT: h.dir}),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });

  assert.equal(cleanResult.status, 0, cleanResult.stderr || cleanResult.stdout);
  const cleanFragment = JSON.parse(readFileSync(cleanOutput, 'utf8'));
  assert.deepEqual(cleanFragment.cleanWindowsEvidence, {
    path: 'clean-windows.json',
    sha256: cleanWindowsSha256
  });
  assert.equal(cleanFragment.componentGate.problems.some(problem =>
    problem.code === 'CLEAN_WINDOWS_REFERENCE_INVALID' ||
    problem.code === 'INVALID_CLEAN_WINDOWS_EVIDENCE'
  ), false);
  assert.equal(cleanFragment.blockers.includes('CLEAN_WINDOWS_REFERENCE_INVALID'), false);
  assert.equal(cleanFragment.releaseReady, false);

  const tamperedOutput = join(h.dir, 'output', 'codex-runtime.tampered-clean.fragment.json');
  const tamperedResult = spawnSync(process.execPath, [
    script,
    '--root', root,
    '--receipt', receiptPath,
    '--receipt-sha256', sha256(readFileSync(receiptPath)),
    '--signature', signaturePath,
    '--signature-sha256', sha256(readFileSync(signaturePath)),
    '--inventory-receipt', inventoryReceiptPath,
    '--inventory-receipt-sha256', sha256(readFileSync(inventoryReceiptPath)),
    '--clean-windows', cleanWindowsPath,
    '--clean-windows-sha256', 'f'.repeat(64),
    '--output', tamperedOutput
  ], {
    cwd: resolve('.'),
    env: childEnv({DREAMMAKER_SUITE_ROOT: h.dir}),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });

  assert.notEqual(tamperedResult.status, 0);
  assert.match(tamperedResult.stderr, /EVIDENCE_DIGEST_MISMATCH/);
  assert.equal(existsSync(tamperedOutput), false);
});
