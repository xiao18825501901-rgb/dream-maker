import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {harness} from '../helpers.mjs';
import {
  buildNodeLicenseBundle,
  inventoryNodePackages,
  loadNodeLicenseEvidence
} from '../../scripts/revamp/inventory-node-runtime.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function runtimeFixture(t) {
  const h = harness(t);
  const root = resolve(h.dir, 'runtime');
  mkdirSync(resolve(root, 'node_modules', 'example-a'), {recursive: true});
  mkdirSync(resolve(root, 'node_modules', 'example-a', 'helpers'), {recursive: true});
  mkdirSync(resolve(root, 'node_modules', 'nested', 'example-b'), {recursive: true});
  writeJson(resolve(root, 'package.json'), {
    name: 'runtime-bundle',
    version: '1.2.3',
    license: 'MIT'
  });
  writeFileSync(resolve(root, 'LICENSE'), 'ROOT LICENSE\n');
  writeJson(resolve(root, 'node_modules', 'example-a', 'package.json'), {
    name: 'example-a',
    version: '2.0.0',
    license: 'Apache-2.0'
  });
  writeFileSync(resolve(root, 'node_modules', 'example-a', 'LICENSE'), 'A LICENSE\n');
  writeJson(resolve(root, 'node_modules', 'example-a', 'helpers', 'package.json'), {
    type: 'module'
  });
  writeJson(resolve(root, 'node_modules', 'nested', 'example-b', 'package.json'), {
    name: '@example/b',
    version: '3.1.4',
    license: {type: 'MIT'}
  });
  writeFileSync(resolve(root, 'node_modules', 'nested', 'example-b', 'LICENSE.txt'), 'B LICENSE\n');
  mkdirSync(resolve(root, 'node_modules', 'nested', 'template'), {recursive: true});
  writeJson(resolve(root, 'node_modules', 'nested', 'template', 'package.json'), {
    name: '@local/template',
    version: '1.0.0',
    private: true
  });
  mkdirSync(resolve(root, 'node_modules', 'nested', 'dual-license'), {recursive: true});
  writeJson(resolve(root, 'node_modules', 'nested', 'dual-license', 'package.json'), {
    name: 'dual-license',
    version: '4.0.0',
    license: '(MIT OR CC0-1.0)'
  });
  writeFileSync(
    resolve(root, 'node_modules', 'nested', 'dual-license', 'license-mit'),
    'DUAL MIT\n'
  );
  writeFileSync(
    resolve(root, 'node_modules', 'nested', 'dual-license', 'license-cc0'),
    'DUAL CC0\n'
  );
  writeFileSync(resolve(root, 'entry.mjs'), 'export const ready = true;\n');
  const artifactBody = Buffer.from('runtime-artifact.zip');
  const artifactPath = resolve(h.dir, 'runtime-artifact.zip');
  writeFileSync(artifactPath, artifactBody);
  return {
    root,
    suiteRoot: h.dir,
    artifact: {
      path: artifactPath,
      bytes: artifactBody.length,
      sha256: sha256(artifactBody)
    }
  };
}

const inventoryScript = fileURLToPath(
  new URL('../../scripts/revamp/inventory-node-runtime.mjs', import.meta.url)
);

function runInventoryCli(fixture, output, extra = []) {
  return spawnSync(process.execPath, [
    inventoryScript,
    '--root', fixture.root,
    '--artifact', fixture.artifact.path,
    '--component-id', 'dsh-runtime',
    '--version', '0.2.0-rc.1',
    '--output', output,
    ...extra
  ], {
    cwd: fixture.suiteRoot,
    env: {...process.env, DREAMMAKER_SUITE_ROOT: fixture.suiteRoot},
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });
}

function externalLicenseFixture(t, fixture) {
  const evidenceRoot = resolve(fixture.suiteRoot, 'reviewed-license-evidence');
  mkdirSync(resolve(evidenceRoot, 'licenses'), {recursive: true});
  const licenseBody = Buffer.from('UPSTREAM EXAMPLE A LICENSE\n');
  const licensePath = 'licenses/example-a-LICENSE.txt';
  writeFileSync(resolve(evidenceRoot, licensePath), licenseBody);
  const tarballBody = Buffer.from('fixed-example-a-tarball');
  const tarballPath = resolve(evidenceRoot, 'example-a-2.0.0.tgz');
  writeFileSync(tarballPath, tarballBody);
  const packageManifest = resolve(fixture.root, 'node_modules', 'example-a', 'package.json');
  const manifest = {
    schema: 'dream-maker.node-runtime-license-evidence.v1',
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    artifactSha256: fixture.artifact.sha256,
    entries: [{
      id: 'example-a@2.0.0',
      package: 'example-a',
      version: '2.0.0',
      path: 'node_modules/example-a',
      manifestSha256: sha256(readFileSync(packageManifest)),
      declaredLicense: 'Apache-2.0',
      tarball: {
        locator: 'https://registry.npmjs.org/example-a/-/example-a-2.0.0.tgz',
        bytes: tarballBody.length,
        sha256: sha256(tarballBody),
        integrity: 'sha512-Zml4ZWQtZXhhbXBsZS1hLXRhcmJhbGw='
      },
      source: {
        kind: 'GIT_COMMIT',
        locator: 'https://github.com/example/example-a',
        revision: 'a'.repeat(40),
        filePath: 'LICENSE'
      },
      license: {
        spdx: 'Apache-2.0',
        path: licensePath,
        bytes: licenseBody.length,
        sha256: sha256(licenseBody)
      }
    }]
  };
  const manifestPath = 'license-evidence.json';
  writeJson(resolve(evidenceRoot, manifestPath), manifest);
  return {
    root: evidenceRoot,
    manifestPath,
    expectedSha256: sha256(readFileSync(resolve(evidenceRoot, manifestPath))),
    manifest
  };
}

function firstPartyEvidenceFixture(t, fixture) {
  const evidenceRoot = resolve(fixture.suiteRoot, 'first-party-evidence');
  mkdirSync(evidenceRoot, {recursive: true});
  const runtimeManifest = resolve(fixture.root, 'package.json');
  const projectManifest = resolve(evidenceRoot, 'project-package.json');
  writeJson(projectManifest, {
    name: 'dream-maker',
    version: '0.1.0',
    private: true,
    license: 'UNLICENSED'
  });
  const manifest = {
    schema: 'dream-maker.node-runtime-license-evidence.v1',
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    artifactSha256: fixture.artifact.sha256,
    entries: [{
      id: 'runtime-bundle@1.2.3',
      package: 'runtime-bundle',
      version: '1.2.3',
      path: '',
      manifestSha256: sha256(readFileSync(runtimeManifest)),
      declaredLicense: 'UNLICENSED',
      firstParty: {
        owner: 'DreamMaker project',
        declaration: 'UNLICENSED',
        sourceLocator: 'project-package.json',
        sourceSha256: sha256(readFileSync(projectManifest))
      }
    }]
  };
  const manifestPath = 'first-party-evidence.json';
  writeJson(resolve(evidenceRoot, manifestPath), manifest);
  return {
    root: evidenceRoot,
    manifestPath,
    expectedSha256: sha256(readFileSync(resolve(evidenceRoot, manifestPath)))
  };
}

test('a complete package tree binds artifact, files, package identities and license bytes', t => {
  const fixture = runtimeFixture(t);
  const sbom = inventoryNodePackages({
    root: fixture.root,
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    artifact: fixture.artifact,
    at: '2026-11-07T00:00:00.000Z'
  });

  assert.equal(sbom.schema, 'dream-maker.component-sbom.v1');
  assert.equal(sbom.status, 'COMPLETE');
  assert.equal(sbom.machineReadableComplete, true);
  assert.equal(sbom.componentId, 'dsh-runtime');
  assert.equal(sbom.artifactSha256, fixture.artifact.sha256);
  assert.equal(sbom.artifactBytes, fixture.artifact.bytes);
  assert.equal(sbom.inventory.method, 'PACKAGE_JSON_DIRECTORY_TREE');
  assert.equal(sbom.inventory.packageCount, 4);
  assert.equal(sbom.inventory.fileCount, 12);
  assert.equal(sbom.inventory.packageFragmentCount, 2);
  assert.match(sbom.inventory.rootTreeSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    sbom.dependencies.map(dependency => dependency.path),
    [
      'node_modules/example-a',
      'node_modules/nested/example-b',
      'node_modules/nested/dual-license',
      ''
    ].sort()
  );
  const rootPackage = sbom.dependencies.find(dependency => dependency.path === '');
  assert.equal(rootPackage.id, 'runtime-bundle@1.2.3');
  assert.equal(rootPackage.declaredLicense, 'MIT');
  assert.equal(rootPackage.license.files[0].path, 'LICENSE');
  assert.equal(rootPackage.license.files[0].sha256, sha256('ROOT LICENSE\n'));
  const dualLicense = sbom.dependencies.find(dependency => dependency.path === 'node_modules/nested/dual-license');
  assert.deepEqual(
    dualLicense.license.files.map(file => file.path),
    ['license-cc0', 'license-mit']
  );
  assert.equal(
    sbom.dependencies.some(dependency => dependency.path === 'node_modules/nested/template'),
    false
  );
  assert.equal(sbom.redistributionReviewed, false);
  assert.equal(sbom.cleanMachineRunVerified, false);
});

test('a missing package license keeps the SBOM incomplete instead of trusting package metadata', t => {
  const fixture = runtimeFixture(t);
  writeJson(resolve(fixture.root, 'node_modules', 'example-a', 'package.json'), {
    name: 'example-a',
    version: '2.0.0',
    license: 'Apache-2.0'
  });
  rmSync(resolve(fixture.root, 'node_modules', 'example-a', 'LICENSE'));
  const sbom = inventoryNodePackages({
    root: fixture.root,
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    artifact: fixture.artifact
  });

  assert.equal(sbom.status, 'INCOMPLETE_LICENSE_EVIDENCE');
  assert.equal(sbom.machineReadableComplete, false);
  const packageA = sbom.dependencies.find(dependency => dependency.id === 'example-a@2.0.0');
  assert.equal(packageA.license.status, 'MISSING');
  assert.deepEqual(packageA.license.files, []);
  assert.equal(sbom.completeness.missingLicenseCount, 1);
});

test('invalid package identities and malformed manifests fail closed', t => {
  const fixture = runtimeFixture(t);
  writeFileSync(
    resolve(fixture.root, 'node_modules', 'example-a', 'package.json'),
    '{"name":"../escape","version":"2.0.0","license":"MIT"}\n'
  );
  assert.throws(
    () => inventoryNodePackages({
      root: fixture.root,
      componentId: 'dsh-runtime',
      version: '0.2.0-rc.1',
      artifact: fixture.artifact
    }),
    /NODE_RUNTIME_PACKAGE_IDENTITY_INVALID/
  );

  writeJson(resolve(fixture.root, 'node_modules', 'example-a', 'package.json'), {
    name: 'example-a',
    version: '2.0.0',
    license: 'Apache-2.0'
  });
  writeFileSync(resolve(fixture.root, 'package.json'), '{broken\n');
  assert.throws(
    () => inventoryNodePackages({
      root: fixture.root,
      componentId: 'dsh-runtime',
      version: '0.2.0-rc.1',
      artifact: fixture.artifact
    }),
    /NODE_RUNTIME_PACKAGE_JSON_INVALID/
  );
});

test('the license bundle revalidates the same package tree and rejects incomplete evidence', t => {
  const fixture = runtimeFixture(t);
  const complete = inventoryNodePackages({
    root: fixture.root,
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    artifact: fixture.artifact
  });
  const bundle = buildNodeLicenseBundle({root: fixture.root, sbom: complete});
  const text = bundle.body.toString('utf8');
  assert.match(text, /runtime-bundle@1\.2\.3 :: LICENSE/);
  assert.match(text, /example-a@2\.0\.0 :: node_modules\/example-a\/LICENSE/);
  assert.match(text, /@example\/b@3\.1\.4 :: node_modules\/nested\/example-b\/LICENSE\.txt/);
  assert.match(text, /dual-license@4\.0\.0 :: node_modules\/nested\/dual-license\/license-cc0/);
  assert.match(text, /dual-license@4\.0\.0 :: node_modules\/nested\/dual-license\/license-mit/);
  assert.equal(bundle.fileCount, 5);
  assert.equal(bundle.rootTreeSha256, complete.inventory.rootTreeSha256);

  writeFileSync(resolve(fixture.root, 'LICENSE'), 'CHANGED AFTER SBOM\n');
  assert.throws(
    () => buildNodeLicenseBundle({root: fixture.root, sbom: complete}),
    /NODE_RUNTIME_TREE_CHANGED/
  );

  delete complete.inventory.rootTreeSha256;
  assert.throws(
    () => buildNodeLicenseBundle({root: fixture.root, sbom: complete}),
    /NODE_RUNTIME_LICENSE_BUNDLE_INCOMPLETE/
  );
});

test('bounded traversal rejects oversized files and invalid artifact identity', t => {
  const fixture = runtimeFixture(t);
  writeFileSync(resolve(fixture.root, 'large.bin'), Buffer.alloc(2048, 0x41));
  assert.throws(
    () => inventoryNodePackages({
      root: fixture.root,
      componentId: 'dsh-runtime',
      version: '0.2.0-rc.1',
      artifact: fixture.artifact,
      limits: {maxFileBytes: 1024}
    }),
    /NODE_RUNTIME_FILE_LIMIT/
  );
  assert.throws(
    () => inventoryNodePackages({
      root: fixture.root,
      componentId: 'dsh-runtime',
      version: '0.2.0-rc.1',
      artifact: {...fixture.artifact, sha256: 'not-a-hash'}
    }),
    /NODE_RUNTIME_ARTIFACT_IDENTITY_INVALID/
  );
});

test('the CLI preserves incomplete SBOM evidence and omits a complete-license claim', t => {
  const fixture = runtimeFixture(t);
  rmSync(resolve(fixture.root, 'node_modules', 'example-a', 'LICENSE'));
  const output = resolve(fixture.suiteRoot, 'inventory-output');
  const result = runInventoryCli(fixture, output);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(existsSync(resolve(output, 'component-sbom.json')), true);
  assert.equal(existsSync(resolve(output, 'TREE_SHA256.txt')), true);
  assert.equal(existsSync(resolve(output, 'receipt.json')), true);
  assert.equal(existsSync(resolve(output, 'THIRD_PARTY_LICENSES.txt')), false);
  const receipt = JSON.parse(readFileSync(resolve(output, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'INCOMPLETE_LICENSE_EVIDENCE');
  assert.equal(receipt.machineReadableComplete, false);
  assert.equal(receipt.licenseBundle, null);
  assert.equal(receipt.missingLicenses.length, 1);
  assert.equal(receipt.missingLicenses[0].id, 'example-a@2.0.0');
});

test('reviewed external license evidence completes a package without a packaged direct license', t => {
  const fixture = runtimeFixture(t);
  rmSync(resolve(fixture.root, 'node_modules', 'example-a', 'LICENSE'));
  const evidenceSource = externalLicenseFixture(t, fixture);
  const evidence = loadNodeLicenseEvidence(evidenceSource);
  const sbom = inventoryNodePackages({
    root: fixture.root,
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    artifact: fixture.artifact,
    licenseEvidence: evidence,
    at: '2026-11-07T00:00:00.000Z'
  });

  assert.equal(sbom.status, 'COMPLETE');
  assert.equal(sbom.machineReadableComplete, true);
  assert.equal(sbom.licenseEvidence.sha256, evidence.sha256);
  assert.equal(sbom.completeness.reviewedExternalLicenseCount, 1);
  const packageA = sbom.dependencies.find(dependency => dependency.id === 'example-a@2.0.0');
  assert.equal(packageA.license.status, 'EXTERNAL_PRESENT');
  assert.equal(packageA.license.files[0].origin, 'REVIEWED_EXTERNAL');
  assert.equal(packageA.license.files[0].bytes, Buffer.byteLength('UPSTREAM EXAMPLE A LICENSE\n'));
  assert.match(packageA.license.provenance.sourceRevision, /^[a-f0-9]{40}$/);

  const bundle = buildNodeLicenseBundle({
    root: fixture.root,
    sbom,
    licenseEvidence: evidence
  });
  assert.match(bundle.body.toString('utf8'), /UPSTREAM EXAMPLE A LICENSE/);
  assert.match(bundle.body.toString('utf8'), /REVIEWED_EXTERNAL/);
  assert.equal(bundle.licenseEvidenceSha256, evidence.sha256);
  assert.equal(bundle.fileCount, 5);
});

test('external license evidence fails closed on drift, path escapes and package binding changes', t => {
  const fixture = runtimeFixture(t);
  rmSync(resolve(fixture.root, 'node_modules', 'example-a', 'LICENSE'));
  const source = externalLicenseFixture(t, fixture);
  const evidence = loadNodeLicenseEvidence(source);

  const changedBinding = structuredClone(evidence);
  changedBinding.entries[0].manifestSha256 = 'b'.repeat(64);
  assert.throws(
    () => inventoryNodePackages({
      root: fixture.root,
      componentId: 'dsh-runtime',
      version: '0.2.0-rc.1',
      artifact: fixture.artifact,
      licenseEvidence: changedBinding
    }),
    /NODE_RUNTIME_LICENSE_EVIDENCE_BINDING_MISMATCH/
  );

  const escaped = structuredClone(source.manifest);
  escaped.entries[0].license.path = '../outside-license.txt';
  writeJson(resolve(source.root, 'escaped.json'), escaped);
  assert.throws(
    () => loadNodeLicenseEvidence({
      root: source.root,
      manifestPath: 'escaped.json',
      expectedSha256: sha256(readFileSync(resolve(source.root, 'escaped.json')))
    }),
    /NODE_RUNTIME_LICENSE_EVIDENCE_PATH_DENIED/
  );

  writeFileSync(resolve(source.root, source.manifest.entries[0].license.path), 'TAMPERED\n');
  assert.throws(
    () => loadNodeLicenseEvidence(source),
    /NODE_RUNTIME_LICENSE_EVIDENCE_DIGEST_MISMATCH/
  );
});

test('an explicitly declared first-party wrapper is distinguished from missing third-party licenses', t => {
  const fixture = runtimeFixture(t);
  rmSync(resolve(fixture.root, 'LICENSE'));
  const evidence = loadNodeLicenseEvidence(firstPartyEvidenceFixture(t, fixture));
  const sbom = inventoryNodePackages({
    root: fixture.root,
    componentId: 'dsh-runtime',
    version: '0.2.0-rc.1',
    artifact: fixture.artifact,
    licenseEvidence: evidence
  });

  const root = sbom.dependencies.find(dependency => dependency.path === '');
  assert.equal(root.license.status, 'FIRST_PARTY_DECLARED');
  assert.equal(root.license.declaration.declaration, 'UNLICENSED');
  assert.deepEqual(root.license.files, []);
  assert.equal(sbom.status, 'COMPLETE');
  assert.equal(sbom.completeness.firstPartyDeclarationCount, 1);
  assert.equal(sbom.redistributionReviewed, false);
});

test('the CLI binds external license evidence and emits the reviewed license body', t => {
  const fixture = runtimeFixture(t);
  rmSync(resolve(fixture.root, 'node_modules', 'example-a', 'LICENSE'));
  const source = externalLicenseFixture(t, fixture);
  const output = resolve(fixture.suiteRoot, 'inventory-output-external');
  const result = runInventoryCli(fixture, output, [
    '--license-evidence', resolve(source.root, source.manifestPath),
    '--license-evidence-sha256', source.expectedSha256
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(readFileSync(resolve(output, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'COMPLETE');
  assert.equal(receipt.licenseEvidence.sha256, source.expectedSha256);
  assert.match(
    readFileSync(resolve(output, 'THIRD_PARTY_LICENSES.txt'), 'utf8'),
    /UPSTREAM EXAMPLE A LICENSE/
  );
});
