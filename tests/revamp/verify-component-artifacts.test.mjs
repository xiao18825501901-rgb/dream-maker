import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {harness} from '../helpers.mjs';
import {
  buildComponentArtifacts
} from '../../scripts/revamp/build-component-artifacts.mjs';
import {
  verifyComponentArtifactsAtRest
} from '../../scripts/revamp/verify-component-artifacts.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const file = (path, body) => ({
  path,
  bytes: Buffer.byteLength(body),
  sha256: sha256(body)
});
const tree = files => sha256(
  [...files]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
    .map(item => `${item.path}\0${item.bytes}\0${item.sha256}\n`)
    .join('')
);
const writeJson = (path, value) => writeFileSync(
  path,
  `${JSON.stringify(value, null, 2)}\n`
);

const sourcePaths = {
  'dm-controller': ['src/server/main.ts', 'src/web/app.ts'],
  'dreamflow-core': ['src/server/engine.ts', 'src/server/providers/dsh.ts'],
  'planner1-cloud-runtime': ['src/server/interview.ts', 'prompts/planner1.md']
};

function fixture(t) {
  const h = harness(t);
  const root = resolve(h.dir, 'evidence');
  const sourceRoot = resolve(h.dir, 'source');
  const nodeRoot = resolve(h.dir, 'node');
  mkdirSync(root, {recursive: true});
  mkdirSync(sourceRoot, {recursive: true});
  mkdirSync(nodeRoot, {recursive: true});

  const bodies = new Map();
  for (const [componentId, paths] of Object.entries(sourcePaths)) {
    for (const path of paths) {
      const body = Buffer.from(`/* ${componentId} ${path} */\nexport{};\n`);
      bodies.set(path, body);
      const target = join(sourceRoot, path);
      mkdirSync(resolve(target, '..'), {recursive: true});
      writeFileSync(target, body);
    }
  }
  const sourceFiles = [...bodies.entries()]
    .map(([path, body]) => ({path, sha256: sha256(body)}))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const sourceStateValue = {
    schema: 'dream-maker.current-source-state.verifier-test.v1',
    root: sourceRoot,
    head: 'a'.repeat(40),
    branch: 'test',
    sourceHash: sha256(JSON.stringify(sourceFiles)),
    sourceFileCount: sourceFiles.length,
    sourceFiles
  };
  const sourceStatePath = join(root, 'source-state.json');
  writeJson(sourceStatePath, sourceStateValue);

  const nodeBody = Buffer.from('OFFLINE_NODE_RUNTIME');
  const nodeLicense = Buffer.from('NODE_LICENSE_TEXT\n');
  writeFileSync(join(nodeRoot, 'node.exe'), nodeBody);
  writeFileSync(join(nodeRoot, 'LICENSE'), nodeLicense);
  const components = Object.entries(sourcePaths).map(([id, paths]) => {
    const files = paths.map(path => file(path, bodies.get(path)));
    return {
      id,
      sourceKind: 'LOCAL_SOURCE_TREE',
      fileCount: files.length,
      bytes: files.reduce((sum, item) => sum + item.bytes, 0),
      treeSha256: tree(files),
      files
    };
  });
  const runtimeFiles = [
    file('node.exe', nodeBody),
    file('LICENSE', nodeLicense)
  ];
  components.push({
    id: 'verified-base-toolchain',
    sourceKind: 'DEDICATED_WINDOWS_NODE_RUNTIME',
    fileCount: 2,
    bytes: runtimeFiles.reduce((sum, item) => sum + item.bytes, 0),
    treeSha256: tree(runtimeFiles),
    files: runtimeFiles
  });
  const boundaryValue = {
    schema: 'dream-maker.release-component-boundary-audit.v1',
    status: 'READY_FOR_COMPONENT_ARTIFACT_BUILDERS_RELEASE_BLOCKED',
    sourceState: {
      path: 'source-state.json',
      sha256: sha256(readFileSync(sourceStatePath)),
      sourceHash: sourceStateValue.sourceHash,
      sourceFileCount: sourceStateValue.sourceFileCount,
      root: sourceRoot,
      head: sourceStateValue.head,
      branch: sourceStateValue.branch
    },
    portableBuild: {
      nodeVersion: 'v24.22.1',
      nodeRoot
    },
    components,
    overlaps: [],
    releaseReady: false,
    completeDistribution: false
  };
  const boundaryPath = join(root, 'component-boundary.json');
  writeJson(boundaryPath, boundaryValue);
  const built = buildComponentArtifacts({
    evidenceRoot: root,
    sourceState: 'source-state.json',
    boundaryReport: 'component-boundary.json',
    output: 'components',
    now: () => new Date('2026-11-07T00:00:00.000Z')
  });
  const buildPath = join(root, 'components', 'component-artifacts.json');

  const external = [];
  for (const id of ['codex-runtime', 'dsh-runtime']) {
    const path = join(root, `${id}.json`);
    writeJson(path, {
      schema: 'dream-maker.release-component-fragment.v1',
      status: 'PARTIAL_COMPONENT_EVIDENCE',
      componentId: id,
      releaseReady: false,
      componentGate: {
        scope: 'COMPONENT_EVIDENCE_FRAGMENT',
        completeDistribution: false,
        releaseReady: false
      }
    });
    external.push({
      id,
      fragmentPath: `${id}.json`,
      fragmentSha256: sha256(readFileSync(path))
    });
  }
  const indexComponents = [
    ...external,
    ...built.components.map(component => ({
      id: component.id,
      fragmentPath: component.fragmentPath
        .slice(root.length + 1)
        .replaceAll('\\', '/'),
      fragmentSha256: component.fragmentSha256
    }))
  ].sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const indexPath = join(root, 'release-index.json');
  writeJson(indexPath, {
    schema: 'dream-maker.release-evidence-index.v1',
    status: 'PARTIAL_INDEX_NOT_RELEASE_MANIFEST',
    components: indexComponents,
    coveredRequiredComponents: indexComponents.map(component => component.id),
    missingRequiredComponents: [],
    releaseReady: false,
    completeDistribution: false
  });
  return {root, buildPath, indexPath};
}

function verify(value, output = join(value.root, `verification-${Date.now()}.json`)) {
  return verifyComponentArtifactsAtRest({
    evidenceRoot: value.root,
    componentBuildPath: value.buildPath.slice(value.root.length + 1)
      .replaceAll('\\', '/'),
    releaseIndexPath: value.indexPath.slice(value.root.length + 1)
      .replaceAll('\\', '/'),
    output,
    now: () => new Date('2026-11-07T00:00:00.000Z')
  });
}

test('independently verifies four artifacts and all six index fragments at rest', t => {
  const value = fixture(t);
  const report = verify(value);
  assert.equal(report.status, 'ARTIFACTS_VERIFIED_AT_REST_RELEASE_BLOCKED');
  assert.equal(report.artifacts.length, 4);
  assert.equal(report.fragments.length, 6);
  assert.equal(report.artifactsVerified, 4);
  assert.equal(report.fragmentsVerified, 6);
  assert.equal(report.missingRequiredComponents.length, 0);
  assert.equal(report.releaseReady, false);
  assert.equal(report.completeDistribution, false);
});

test('artifact digest drift and an incomplete index fail closed', t => {
  const drift = fixture(t);
  const build = JSON.parse(readFileSync(drift.buildPath, 'utf8'));
  const artifact = resolve(drift.root, build.components[0].artifactRelative);
  writeFileSync(artifact, 'changed');
  assert.throws(
    () => verify(drift),
    error => error.code === 'ARTIFACT_DIGEST_MISMATCH'
  );

  const incomplete = fixture(t);
  const index = JSON.parse(readFileSync(incomplete.indexPath, 'utf8'));
  index.missingRequiredComponents = ['codex-runtime'];
  writeJson(incomplete.indexPath, index);
  assert.throws(
    () => verify(incomplete),
    error => error.code === 'RELEASE_INDEX_COVERAGE_INVALID'
  );
});

test('an existing output is never replaced', t => {
  const value = fixture(t);
  const output = join(value.root, 'existing.json');
  writeFileSync(output, 'preserve\n');
  assert.throws(
    () => verify(value, output),
    error => error.code === 'OUTPUT_EXISTS'
  );
  assert.equal(readFileSync(output, 'utf8'), 'preserve\n');
});
