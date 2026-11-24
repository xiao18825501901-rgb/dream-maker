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
  buildComponentArtifacts,
  readStoredZipEntries
} from '../../scripts/revamp/build-component-artifacts.mjs';

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

const componentFiles = {
  'dm-controller': ['src/server/main.ts', 'src/web/app.ts', 'prompts/planner2.md'],
  'dreamflow-core': ['src/server/engine.ts', 'src/server/providers/dsh.ts', 'adapters/run.mjs'],
  'planner1-cloud-runtime': ['src/server/interview.ts', 'prompts/planner1.md', 'scripts/kimi-p1/bridge.py']
};

function zipEntriesByPath(body) {
  return new Map(readStoredZipEntries(body).map(entry => [entry.path, entry.body]));
}

function fixture(t) {
  const root = resolve(harness(t).dir, 'evidence');
  const sourceRoot = resolve(harness(t).dir, 'source');
  const nodeRoot = resolve(harness(t).dir, 'node');
  const packageRoot = resolve(harness(t).dir, 'portable');
  mkdirSync(root, {recursive: true});
  mkdirSync(sourceRoot, {recursive: true});
  mkdirSync(nodeRoot, {recursive: true});
  mkdirSync(packageRoot, {recursive: true});

  const bodies = new Map();
  for (const [componentId, paths] of Object.entries(componentFiles)) {
    for (const path of paths) {
      const body = Buffer.from(`/* ${componentId} ${path} */\nexport{};\n`);
      bodies.set(path, body);
      const target = join(sourceRoot, path);
      mkdirSync(resolve(target, '..'), {recursive: true});
      writeFileSync(target, body);
    }
  }
  const sourceFiles = [...bodies.entries()]
    .map(([path, body]) => ({
      path,
      sha256: sha256(body)
    }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const sourceStateValue = {
    schema: 'dream-maker.current-source-state.m95-test.v1',
    at: '2026-11-07T00:00:00.000Z',
    root: sourceRoot,
    head: 'a'.repeat(40),
    branch: 'test',
    sourceHash: sha256(JSON.stringify(sourceFiles)),
    sourceFileCount: sourceFiles.length,
    sourceFiles
  };
  const sourceStatePath = join(root, 'source-state.json');
  writeFileSync(sourceStatePath, `${JSON.stringify(sourceStateValue, null, 2)}\n`);

  const nodeBody = Buffer.from('OFFLINE_NODE_RUNTIME');
  const nodeLicense = Buffer.from('NODE_LICENSE_TEXT\n');
  writeFileSync(join(nodeRoot, 'node.exe'), nodeBody);
  writeFileSync(join(nodeRoot, 'LICENSE'), nodeLicense);
  writeFileSync(join(nodeRoot, 'npm.cmd'), 'must not be included\n');

  const components = Object.entries(componentFiles).map(([id, paths]) => {
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
  writeFileSync(boundaryPath, `${JSON.stringify(boundaryValue, null, 2)}\n`);

  return {
    base: resolve(harness(t).dir),
    root,
    sourceRoot,
    sourceStatePath,
    sourceStateValue,
    boundaryPath,
    boundaryValue,
    nodeRoot,
    bodies
  };
}

function build(value, output = join(value.root, `components-${Date.now()}`)) {
  return buildComponentArtifacts({
    evidenceRoot: value.root,
    sourceState: 'source-state.json',
    boundaryReport: 'component-boundary.json',
    output,
    now: () => new Date('2026-11-07T00:00:00.000Z')
  });
}

test('M95 builds four deterministic component artifacts without release claims', t => {
  const value = fixture(t);
  const first = build(value);
  const second = build(value, join(value.root, 'components-second'));

  assert.equal(first.status, 'COMPONENT_ARTIFACTS_BUILT_RELEASE_BLOCKED');
  assert.equal(first.components.length, 4);
  assert.equal(first.componentFragmentsCreated, true);
  assert.equal(first.completeDistribution, false);
  assert.equal(first.releaseReady, false);
  assert.deepEqual(
    first.components.map(component => component.id),
    [
      'dm-controller',
      'dreamflow-core',
      'planner1-cloud-runtime',
      'verified-base-toolchain'
    ]
  );
  assert.deepEqual(
    first.components.map(component => component.artifactSha256),
    second.components.map(component => component.artifactSha256)
  );

  for (const component of first.components) {
    assert.ok(existsSync(component.artifactPath));
    assert.ok(existsSync(component.sbomPath));
    assert.ok(existsSync(component.fragmentPath));
    assert.equal(component.fragment.releaseReady, false);
    assert.equal(component.fragment.componentGate.completeDistribution, false);
    assert.ok(component.fragment.blockers.includes('CLEAN_WINDOWS_REFERENCE_INVALID'));
    assert.ok(component.fragment.blockers.includes('REDISTRIBUTION_NOT_REVIEWED'));
    assert.deepEqual(
      component.componentGate.problems.map(problem => problem.code),
      ['CLEAN_WINDOWS_REFERENCE_INVALID']
    );
    assert.equal(component.sbom.artifactSha256, component.artifactSha256);
    assert.equal(component.sbom.status, 'COMPLETE');
  }

  const controller = first.components.find(component => component.id === 'dm-controller');
  const entries = zipEntriesByPath(readFileSync(controller.artifactPath));
  for (const path of componentFiles['dm-controller']) {
    assert.deepEqual(entries.get(path), value.bodies.get(path));
  }
  assert.ok(entries.has('COMPONENT_MANIFEST.json'));
  assert.ok(entries.has('LICENSE_STATUS.txt'));
});

test('verified base toolchain includes exactly node.exe, LICENSE and generated metadata', t => {
  const value = fixture(t);
  const report = build(value);
  const component = report.components.find(item => item.id === 'verified-base-toolchain');
  const entries = [...zipEntriesByPath(readFileSync(component.artifactPath)).keys()].sort();
  assert.deepEqual(entries, [
    'COMPONENT_MANIFEST.json',
    'LICENSE',
    'LICENSE_STATUS.txt',
    'node.exe'
  ]);
});

test('source drift after the boundary audit fails before any component output', t => {
  const value = fixture(t);
  writeFileSync(join(value.sourceRoot, 'src/server/main.ts'), 'changed\n');
  const output = join(value.root, 'components-drift');
  assert.throws(
    () => build(value, output),
    error => error.code === 'SOURCE_COMPONENT_FILE_DIGEST_MISMATCH'
  );
  assert.equal(existsSync(output), false);
});

test('boundary source-state pin mismatch and duplicate source ownership fail closed', t => {
  const mismatch = fixture(t);
  mismatch.boundaryValue.sourceState.sha256 = 'f'.repeat(64);
  writeFileSync(
    mismatch.boundaryPath,
    `${JSON.stringify(mismatch.boundaryValue, null, 2)}\n`
  );
  assert.throws(
    () => build(mismatch, join(mismatch.root, 'components-mismatch')),
    error => error.code === 'BOUNDARY_SOURCE_STATE_DIGEST_MISMATCH'
  );

  const duplicate = fixture(t);
  duplicate.boundaryValue.components[1].files.push(
    duplicate.boundaryValue.components[0].files[0]
  );
  duplicate.boundaryValue.components[1].fileCount += 1;
  duplicate.boundaryValue.components[1].treeSha256 = tree(
    duplicate.boundaryValue.components[1].files
  );
  writeFileSync(
    duplicate.boundaryPath,
    `${JSON.stringify(duplicate.boundaryValue, null, 2)}\n`
  );
  assert.throws(
    () => build(duplicate, join(duplicate.root, 'components-duplicate')),
    error => error.code === 'SOURCE_COMPONENT_FILE_OVERLAP'
  );
});

test('an existing output directory is never overwritten', t => {
  const value = fixture(t);
  const output = join(value.root, 'components-existing');
  mkdirSync(output);
  writeFileSync(join(output, 'preserve.txt'), 'keep\n');
  assert.throws(
    () => build(value, output),
    error => error.code === 'OUTPUT_EXISTS'
  );
  assert.equal(readFileSync(join(output, 'preserve.txt'), 'utf8'), 'keep\n');
});
