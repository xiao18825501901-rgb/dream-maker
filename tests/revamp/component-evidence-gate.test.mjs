import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {harness} from '../helpers.mjs';
import {
  REQUIRED_CORE_COMPONENTS,
  qualifyComponentEvidenceFragment,
  qualifyDistribution,
  qualifyDistributionEvidence
} from '../../dist/server/release/component-inventory.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function evidenceFixture(t) {
  const root = resolve(harness(t).dir, 'component-evidence');
  mkdirSync(resolve(root, 'files'), {recursive: true});
  const components = [];
  for (const [index, id] of REQUIRED_CORE_COMPONENTS.entries()) {
    const version = `1.0.${index}`;
    const artifactBody = Buffer.from(`ARTIFACT:${id}:${version}\n`);
    const artifactPath = `files/${id}.bin`;
    writeFileSync(resolve(root, artifactPath), artifactBody);
    const artifactSha256 = sha256(artifactBody);

    const licenseBody = Buffer.from(`LICENSE FOR ${id} ${version}\n`);
    const licensePath = `files/${id}.LICENSE`;
    writeFileSync(resolve(root, licensePath), licenseBody);

    const sbomPath = `files/${id}.sbom.json`;
    writeJson(resolve(root, sbomPath), {
      schema: 'dream-maker.component-sbom.v1',
      status: 'COMPLETE',
      componentId: id,
      version,
      artifactSha256,
      machineReadableComplete: true,
      dependencyCount: 0,
      dependencies: []
    });
    const sbomBody = readFileSync(resolve(root, sbomPath));

    const cleanWindowsPath = `files/${id}.clean-windows.json`;
    writeJson(resolve(root, cleanWindowsPath), {
      schema: 'dream-maker.component-clean-windows-evidence.v1',
      status: 'PASS',
      componentId: id,
      version,
      artifactSha256,
      platform: 'win32'
    });
    const cleanWindowsBody = readFileSync(resolve(root, cleanWindowsPath));

    components.push({
      id,
      version,
      source: {
        kind: 'GIT_COMMIT',
        locator: `https://example.invalid/${id}`,
        revision: 'a'.repeat(40)
      },
      artifact: {path: artifactPath, sha256: artifactSha256, bytes: artifactBody.length},
      license: {path: licensePath, sha256: sha256(licenseBody)},
      sbom: {path: sbomPath, sha256: sha256(sbomBody)},
      cleanWindows: {path: cleanWindowsPath, sha256: sha256(cleanWindowsBody)}
    });
  }
  const manifest = {
    schema: 'dream-maker.release-component-evidence.v1',
    at: '2026-11-07T00:00:00.000Z',
    components
  };
  const manifestPath = 'component-evidence.json';
  writeJson(resolve(root, manifestPath), manifest);
  return {
    root,
    manifestPath,
    manifest,
    expectedManifestSha256: sha256(JSON.stringify(manifest, null, 2) + '\n'),
    artifactBytes: REQUIRED_CORE_COMPONENTS.reduce((sum, id, index) => sum + Buffer.byteLength(`ARTIFACT:${id}:1.0.${index}\n`), 0)
  };
}

test('caller booleans remain a checklist and can never qualify distribution by themselves', () => {
  const component = id => ({
    id,
    bundled: true,
    redistributionReviewed: true,
    cleanMachineRunVerified: true,
    artifactHash: 'a'.repeat(64),
    licenseEvidenceRef: 'claimed-license',
    measuredBytes: 1
  });
  const result = qualifyDistribution({
    components: REQUIRED_CORE_COMPONENTS.map(component),
    variant: 'INSTALLER',
    liveAccountsReady: true
  });
  assert.equal(result.completeCore, false);
  assert.equal(result.evidenceVerified, false);
  assert.equal(result.accountReady, false);
  assert.ok(result.problems.some(problem => problem.code === 'VERIFIED_EVIDENCE_MANIFEST_REQUIRED'));
});

test('a pinned evidence manifest with matching bytes and typed component evidence qualifies the core gate', t => {
  const fixture = evidenceFixture(t);
  const result = qualifyDistributionEvidence({
    root: fixture.root,
    manifestPath: fixture.manifestPath,
    expectedManifestSha256: fixture.expectedManifestSha256,
    variant: 'PORTABLE'
  });
  assert.equal(result.completeCore, true);
  assert.equal(result.evidenceVerified, true);
  assert.equal(result.problems.length, 0);
  assert.equal(result.components.length, REQUIRED_CORE_COMPONENTS.length);
  assert.equal(result.measuredBytes, fixture.artifactBytes);
  assert.equal(result.accountReady, false);
  assert.equal(result.modelsBundled, false);
});

test('a single verified component can pass its fragment gate without claiming a distribution', t => {
  const fixture = evidenceFixture(t);
  const result = qualifyComponentEvidenceFragment({
    root: fixture.root,
    component: fixture.manifest.components[0]
  });
  assert.equal(result.componentId, fixture.manifest.components[0].id);
  assert.equal(result.evidenceVerified, true);
  assert.equal(result.completeDistribution, false);
  assert.equal(result.releaseReady, false);
  assert.equal(result.problems.length, 0);
  assert.equal(result.component.artifactSha256, fixture.manifest.components[0].artifact.sha256);
});

test('a single fragment with tampered clean-Windows evidence fails closed', t => {
  const fixture = evidenceFixture(t);
  const component = fixture.manifest.components[0];
  component.cleanWindows.sha256 = 'f'.repeat(64);
  const result = qualifyComponentEvidenceFragment({root: fixture.root, component});
  assert.equal(result.evidenceVerified, false);
  assert.equal(result.completeDistribution, false);
  assert.equal(result.releaseReady, false);
  assert.ok(result.problems.some(problem => problem.code === 'EVIDENCE_DIGEST_MISMATCH'));
});

test('an unpinned manifest and missing required component fail closed', t => {
  const fixture = evidenceFixture(t);
  const unpinned = qualifyDistributionEvidence({
    root: fixture.root,
    manifestPath: fixture.manifestPath,
    variant: 'PORTABLE'
  });
  assert.equal(unpinned.completeCore, false);
  assert.ok(unpinned.problems.some(problem => problem.code === 'EVIDENCE_MANIFEST_UNPINNED'));

  fixture.manifest.components = fixture.manifest.components.filter(component => component.id !== 'codex-runtime');
  writeJson(resolve(fixture.root, fixture.manifestPath), fixture.manifest);
  const pinned = qualifyDistributionEvidence({
    root: fixture.root,
    manifestPath: fixture.manifestPath,
    expectedManifestSha256: sha256(JSON.stringify(fixture.manifest, null, 2) + '\n'),
    variant: 'PORTABLE'
  });
  assert.equal(pinned.completeCore, false);
  assert.ok(pinned.problems.some(problem => problem.code === 'CORE_COMPONENT_MISSING'));
});

test('path traversal, digest drift and artifact byte mismatch are rejected', t => {
  const fixture = evidenceFixture(t);
  fixture.manifest.components[0].license.path = '../outside-license.txt';
  fixture.manifest.components[1].artifact.sha256 = 'b'.repeat(64);
  fixture.manifest.components[2].artifact.bytes += 1;
  writeJson(resolve(fixture.root, fixture.manifestPath), fixture.manifest);
  const result = qualifyDistributionEvidence({
    root: fixture.root,
    manifestPath: fixture.manifestPath,
    expectedManifestSha256: sha256(JSON.stringify(fixture.manifest, null, 2) + '\n'),
    variant: 'PORTABLE'
  });
  assert.equal(result.completeCore, false);
  assert.ok(result.problems.some(problem => problem.code === 'EVIDENCE_PATH_DENIED'));
  assert.ok(result.problems.some(problem => problem.code === 'EVIDENCE_DIGEST_MISMATCH'));
  assert.ok(result.problems.some(problem => problem.code === 'ARTIFACT_BYTES_MISMATCH'));
});

test('untyped or failing clean-Windows documents do not become redistribution proof', t => {
  const fixture = evidenceFixture(t);
  const cleanPath = fixture.manifest.components[0].cleanWindows.path;
  writeJson(resolve(fixture.root, cleanPath), {
    schema: 'dream-maker.component-clean-windows-evidence.v1',
    status: 'FAIL',
    componentId: fixture.manifest.components[0].id,
    version: fixture.manifest.components[0].version,
    artifactSha256: fixture.manifest.components[0].artifact.sha256,
    platform: 'win32'
  });
  fixture.manifest.components[0].cleanWindows.sha256 = sha256(Buffer.from(JSON.stringify({
    schema: 'dream-maker.component-clean-windows-evidence.v1',
    status: 'FAIL',
    componentId: fixture.manifest.components[0].id,
    version: fixture.manifest.components[0].version,
    artifactSha256: fixture.manifest.components[0].artifact.sha256,
    platform: 'win32'
  }, null, 2) + '\n'));
  writeJson(resolve(fixture.root, fixture.manifestPath), fixture.manifest);
  const result = qualifyDistributionEvidence({
    root: fixture.root,
    manifestPath: fixture.manifestPath,
    expectedManifestSha256: sha256(JSON.stringify(fixture.manifest, null, 2) + '\n'),
    variant: 'PORTABLE'
  });
  assert.equal(result.completeCore, false);
  assert.ok(result.problems.some(problem => problem.code === 'INVALID_CLEAN_WINDOWS_EVIDENCE'));
});

test('an incomplete SBOM cannot qualify even when its file reference is correctly pinned', t => {
  const fixture = evidenceFixture(t);
  const component = fixture.manifest.components[0];
  const sbom = {
    schema: 'dream-maker.component-sbom.v1',
    status: 'INCOMPLETE_LICENSE_EVIDENCE',
    componentId: component.id,
    version: component.version,
    artifactSha256: component.artifact.sha256,
    machineReadableComplete: false,
    dependencies: []
  };
  const body = Buffer.from(JSON.stringify(sbom, null, 2) + '\n');
  writeFileSync(resolve(fixture.root, component.sbom.path), body);
  component.sbom.sha256 = sha256(body);
  writeJson(resolve(fixture.root, fixture.manifestPath), fixture.manifest);
  const result = qualifyDistributionEvidence({
    root: fixture.root,
    manifestPath: fixture.manifestPath,
    expectedManifestSha256: sha256(JSON.stringify(fixture.manifest, null, 2) + '\n'),
    variant: 'PORTABLE'
  });
  assert.equal(result.completeCore, false);
  assert.ok(result.problems.some(problem =>
    problem.component === component.id && problem.code === 'INVALID_SBOM_EVIDENCE'
  ));
});

test('reviewed external licenses and an explicit first-party declaration are typed SBOM evidence', t => {
  const fixture = evidenceFixture(t);
  const component = fixture.manifest.components[0];
  const evidenceSha256 = 'd'.repeat(64);
  const sbom = {
    schema: 'dream-maker.component-sbom.v1',
    status: 'COMPLETE',
    componentId: component.id,
    version: component.version,
    artifactSha256: component.artifact.sha256,
    machineReadableComplete: true,
    dependencyCount: 2,
    inventory: {
      method: 'PACKAGE_JSON_DIRECTORY_TREE',
      rootTreeSha256: '2'.repeat(64),
      fileCount: 10,
      packageCount: 2,
      totalBytes: 100
    },
    licenseEvidence: {
      sha256: evidenceSha256,
      entryCount: 2
    },
    dependencies: [{
      id: 'external-package@1.0.0',
      package: 'external-package',
      version: '1.0.0',
      path: 'node_modules/external-package',
      manifestSha256: 'a'.repeat(64),
      license: {
        status: 'EXTERNAL_PRESENT',
        files: [{
          path: 'licenses/external-package-LICENSE.txt',
          bytes: 20,
          sha256: 'b'.repeat(64),
          origin: 'REVIEWED_EXTERNAL'
        }],
        provenance: {
          spdx: 'MIT',
          tarball: {
            locator: 'https://registry.npmjs.org/external-package/-/external-package-1.0.0.tgz',
            bytes: 100,
            sha256: 'c'.repeat(64),
            integrity: 'sha512-ZXhhbXBsZQ=='
          },
          source: {
            kind: 'GIT_COMMIT',
            locator: 'https://github.com/example/external-package',
            revision: 'e'.repeat(40),
            filePath: 'LICENSE',
            upstreamLocator: null,
            upstreamRevision: null
          },
          sourceRevision: 'e'.repeat(40),
          sourceFilePath: 'LICENSE',
          evidenceSha256
        }
      }
    }, {
      id: 'first-party-wrapper@0.1.0',
      package: 'first-party-wrapper',
      version: '0.1.0',
      path: '',
      manifestSha256: 'f'.repeat(64),
      license: {
        status: 'FIRST_PARTY_DECLARED',
        files: [],
        declaration: {
          owner: 'DreamMaker project',
          declaration: 'UNLICENSED',
          sourceLocator: 'project-package.json',
          sourceSha256: '1'.repeat(64)
        },
        evidenceSha256
      }
    }]
  };
  const body = Buffer.from(JSON.stringify(sbom, null, 2) + '\n');
  writeFileSync(resolve(fixture.root, component.sbom.path), body);
  component.sbom.sha256 = sha256(body);
  writeJson(resolve(fixture.root, fixture.manifestPath), fixture.manifest);
  const result = qualifyDistributionEvidence({
    root: fixture.root,
    manifestPath: fixture.manifestPath,
    expectedManifestSha256: sha256(JSON.stringify(fixture.manifest, null, 2) + '\n'),
    variant: 'PORTABLE'
  });
  assert.equal(result.completeCore, true);
  assert.equal(result.evidenceVerified, true);
  assert.equal(result.problems.length, 0);
});

test('SBOM license evidence must bind identities, counts and the top-level reviewed manifest', t => {
  const fixture = evidenceFixture(t);
  const component = fixture.manifest.components[0];
  const evidenceSha256 = 'd'.repeat(64);
  const baseline = {
    schema: 'dream-maker.component-sbom.v1',
    status: 'COMPLETE',
    componentId: component.id,
    version: component.version,
    artifactSha256: component.artifact.sha256,
    machineReadableComplete: true,
    dependencyCount: 2,
    inventory: {
      method: 'PACKAGE_JSON_DIRECTORY_TREE',
      rootTreeSha256: '2'.repeat(64),
      fileCount: 10,
      packageCount: 2,
      totalBytes: 100
    },
    licenseEvidence: {
      sha256: evidenceSha256,
      entryCount: 2
    },
    dependencies: [{
      id: 'external-package@1.0.0',
      package: 'external-package',
      version: '1.0.0',
      path: 'node_modules/external-package',
      manifestSha256: 'a'.repeat(64),
      license: {
        status: 'EXTERNAL_PRESENT',
        files: [{
          path: 'licenses/external-package-LICENSE.txt',
          bytes: 20,
          sha256: 'b'.repeat(64),
          origin: 'REVIEWED_EXTERNAL'
        }],
        provenance: {
          spdx: 'MIT',
          tarball: {
            locator: 'https://registry.npmjs.org/external-package/-/external-package-1.0.0.tgz',
            bytes: 100,
            sha256: 'c'.repeat(64),
            integrity: 'sha512-ZXhhbXBsZQ=='
          },
          source: {
            kind: 'GIT_COMMIT',
            locator: 'https://github.com/example/external-package',
            revision: 'e'.repeat(40),
            filePath: 'LICENSE'
          },
          sourceRevision: 'e'.repeat(40),
          sourceFilePath: 'LICENSE',
          evidenceSha256
        }
      }
    }, {
      id: 'first-party-wrapper@0.1.0',
      package: 'first-party-wrapper',
      version: '0.1.0',
      path: '',
      manifestSha256: 'f'.repeat(64),
      license: {
        status: 'FIRST_PARTY_DECLARED',
        files: [],
        declaration: {
          owner: 'DreamMaker project',
          declaration: 'UNLICENSED',
          sourceLocator: 'project-package.json',
          sourceSha256: '1'.repeat(64)
        },
        evidenceSha256
      }
    }]
  };
  const qualify = candidate => {
    const body = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
    writeFileSync(resolve(fixture.root, component.sbom.path), body);
    component.sbom.sha256 = sha256(body);
    writeJson(resolve(fixture.root, fixture.manifestPath), fixture.manifest);
    return qualifyDistributionEvidence({
      root: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(JSON.stringify(fixture.manifest, null, 2) + '\n'),
      variant: 'PORTABLE'
    });
  };

  assert.equal(qualify(structuredClone(baseline)).completeCore, true);

  const unbound = structuredClone(baseline);
  unbound.licenseEvidence.sha256 = '9'.repeat(64);
  assert.equal(qualify(unbound).completeCore, false);

  const wrongIdentity = structuredClone(baseline);
  wrongIdentity.dependencies[0].id = 'external-package@2.0.0';
  assert.equal(qualify(wrongIdentity).completeCore, false);

  const duplicate = structuredClone(baseline);
  duplicate.dependencies[1] = structuredClone(duplicate.dependencies[0]);
  assert.equal(qualify(duplicate).completeCore, false);

  const wrongCount = structuredClone(baseline);
  wrongCount.inventory.packageCount = 3;
  assert.equal(qualify(wrongCount).completeCore, false);
});

test('a complete SBOM claim with invalid dependency evidence cannot qualify', t => {
  const fixture = evidenceFixture(t);
  const component = fixture.manifest.components[0];
  const sbom = {
    schema: 'dream-maker.component-sbom.v1',
    status: 'COMPLETE',
    componentId: component.id,
    version: component.version,
    artifactSha256: component.artifact.sha256,
    machineReadableComplete: true,
    dependencyCount: 1,
    dependencies: [{
      id: 'example-package@1.0.0',
      version: '1.0.0',
      license: {
        status: 'MISSING',
        files: []
      }
    }]
  };
  const body = Buffer.from(JSON.stringify(sbom, null, 2) + '\n');
  writeFileSync(resolve(fixture.root, component.sbom.path), body);
  component.sbom.sha256 = sha256(body);
  writeJson(resolve(fixture.root, fixture.manifestPath), fixture.manifest);
  const result = qualifyDistributionEvidence({
    root: fixture.root,
    manifestPath: fixture.manifestPath,
    expectedManifestSha256: sha256(JSON.stringify(fixture.manifest, null, 2) + '\n'),
    variant: 'PORTABLE'
  });
  assert.equal(result.completeCore, false);
  assert.ok(result.problems.some(problem =>
    problem.component === component.id && problem.code === 'INVALID_SBOM_EVIDENCE'
  ));
});

test('oversized manifests are rejected before parsing', t => {
  const root = resolve(harness(t).dir, 'oversized-evidence');
  mkdirSync(root, {recursive: true});
  const manifestPath = 'component-evidence.json';
  const body = Buffer.alloc(512001, 0x20);
  writeFileSync(resolve(root, manifestPath), body);
  const result = qualifyDistributionEvidence({
    root,
    manifestPath,
    expectedManifestSha256: sha256(body),
    variant: 'INSTALLER'
  });
  assert.equal(result.completeCore, false);
  assert.ok(result.problems.some(problem => problem.code === 'EVIDENCE_FILE_LIMIT'));
});
