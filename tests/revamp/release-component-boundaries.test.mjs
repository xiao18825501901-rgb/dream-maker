import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {harness} from '../helpers.mjs';
import {
  COMPONENT_DEFINITIONS,
  auditReleaseComponentBoundaries
} from '../../scripts/revamp/audit-release-component-boundaries.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const file = (path, body) => ({path, bytes: Buffer.byteLength(body), sha256: sha(body)});

function writeFixture(t) {
  const root = resolve(harness(t).dir, 'boundary-evidence');
  const sourceRoot = resolve(root, 'source');
  const nodeRoot = resolve(root, 'node');
  const packageRoot = resolve(root, 'package');
  const sourcePath = resolve(sourceRoot, 'source-state.json');
  const buildPath = resolve(root, 'portable-build.json');
  const archivePath = resolve(root, 'core.zip');
  mkdirSync(sourceRoot, {recursive: true});
  mkdirSync(nodeRoot, {recursive: true});
  mkdirSync(packageRoot, {recursive: true});

  const paths = new Map();
  for (const definition of COMPONENT_DEFINITIONS) {
    for (const path of definition.exact ?? []) {
      paths.set(path, `/* ${path} */\nexport{};\n`);
    }
    for (const prefix of definition.prefixes ?? []) {
      const path = `${prefix}boundary-fixture.js`;
      paths.set(path, `/* ${path} */\nexport{};\n`);
    }
  }
  const sourceFiles = [...paths.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([path, body]) => file(path, body));
  const source = {
    schema: 'dream-maker.current-source-state.m94-test.v1',
    at: '2026-11-07T00:00:00.000Z',
    root: sourceRoot,
    head: 'a'.repeat(40),
    branch: 'test',
    sourceHash: 'b'.repeat(64),
    sourceFileCount: sourceFiles.length,
    sourceFiles
  };
  writeFileSync(sourcePath, JSON.stringify(source, null, 2) + '\n');

  const nodeExe = Buffer.from('OFFLINE_NODE_STUB');
  const nodeLicense = Buffer.from('OFFLINE_NODE_LICENSE');
  writeFileSync(resolve(nodeRoot, 'node.exe'), nodeExe);
  writeFileSync(resolve(nodeRoot, 'LICENSE'), nodeLicense);
  writeFileSync(archivePath, Buffer.from('OFFLINE_CORE_ARCHIVE'));
  const archive = readFileSync(archivePath);
  const packageManifest = {
    schema: 'dream-maker.windows-portable.v1',
    nodeVersion: 'v1.2.3',
    files: [
      {path: 'runtime/node.exe', bytes: nodeExe.length, sha256: sha(nodeExe)},
      {path: 'runtime/LICENSE', bytes: nodeLicense.length, sha256: sha(nodeLicense)}
    ]
  };
  writeFileSync(
    resolve(packageRoot, 'RELEASE_MANIFEST.json'),
    JSON.stringify(packageManifest, null, 2) + '\n'
  );
  const build = {
    schema: 'dream-maker.windows-portable-build.v1',
    status: 'PASS_CORE_PORTABLE_ONLY',
    scope: 'CORE_LOCAL_UI_AND_PROJECT_STATE_NOT_FULL_NATIVE_RELEASE',
    sourceHash: source.sourceHash,
    nodeVersion: packageManifest.nodeVersion,
    nodeRoot,
    output: packageRoot,
    archive: archivePath,
    archiveBytes: archive.length,
    archiveSha256: sha(archive)
  };
  writeFileSync(buildPath, JSON.stringify(build, null, 2) + '\n');
  return {
    root,
    sourcePath,
    buildPath,
    nodeRoot,
    source,
    archivePath,
    packageRoot
  };
}

function audit(fixture, overrides = {}) {
  return auditReleaseComponentBoundaries({
    evidenceRoot: fixture.root,
    sourceState: 'source/source-state.json',
    portableBuild: 'portable-build.json',
    nodeRoot: fixture.nodeRoot,
    ...overrides
  });
}

test('M94 boundary audit maps four distinct components without claiming release readiness', t => {
  const fixture = writeFixture(t);
  const report = audit(fixture);
  assert.equal(report.schema, 'dream-maker.release-component-boundary-audit.v1');
  assert.equal(report.status, 'READY_FOR_COMPONENT_ARTIFACT_BUILDERS_RELEASE_BLOCKED');
  assert.equal(report.components.length, 4);
  assert.deepEqual(report.components.map(component => component.id), [
    'dm-controller',
    'dreamflow-core',
    'planner1-cloud-runtime',
    'verified-base-toolchain'
  ]);
  assert.equal(report.currentSourceArtifactBound, true);
  assert.equal(report.overlaps.length, 0);
  assert.equal(report.aggregateArchiveUse.archiveReusedAsMultipleComponentArtifacts, false);
  assert.equal(report.releaseReady, false);
  assert.equal(report.completeDistribution, false);
  assert.equal(report.modelCalls, 0);
  assert.equal(report.binariesExecuted, false);
  assert.ok(report.components.every(component => component.blockers.length > 0));
});

test('Prework and frozen-preparation control sources belong to the original DreamFlow component',t=>{
 const fixture=writeFixture(t),paths=['src/server/prework/contract.ts','src/server/custom-flow-preparation.ts'];
 for(const path of paths)if(!fixture.source.sourceFiles.some(f=>f.path===path)){
  const full=resolve(fixture.source.root,path),body='export {};\n';mkdirSync(resolve(full,'..'),{recursive:true});writeFileSync(full,body);
  fixture.source.sourceFiles.push(file(path,body));
 }
 fixture.source.sourceFileCount=fixture.source.sourceFiles.length;
 writeFileSync(fixture.sourcePath,JSON.stringify(fixture.source,null,2)+'\n');
 const report=audit(fixture),core=report.components.find(c=>c.id==='dreamflow-core');
 for(const path of paths)assert.ok(core.files.some(f=>f.path===path),path);
 assert.equal(report.components.length,4);assert.equal(report.releaseReady,false);assert.equal(report.completeDistribution,false);
});

test('M94 refuses a source-state path that escapes its documented relative form', t => {
  const fixture = writeFixture(t);
  fixture.source.sourceFiles.push(file('../outside.js', 'not allowed'));
  fixture.source.sourceFileCount = fixture.source.sourceFiles.length;
  writeFileSync(fixture.sourcePath, JSON.stringify(fixture.source, null, 2) + '\n');
  assert.throws(() => audit(fixture), error => error.code === 'SOURCE_STATE_FILE_INVALID');
});

test('M94 refuses a Node runtime that changed after the portable manifest was pinned', t => {
  const fixture = writeFixture(t);
  writeFileSync(resolve(fixture.nodeRoot, 'node.exe'), 'CHANGED');
  assert.throws(() => audit(fixture), error => error.code === 'NODE_RUNTIME_MANIFEST_MISMATCH');
});

test('M94 refuses a portable receipt whose Node version and manifest disagree', t => {
  const fixture = writeFixture(t);
  const manifestPath = resolve(fixture.packageRoot, 'RELEASE_MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.nodeVersion = 'v9.9.9';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  assert.throws(() => audit(fixture), error => error.code === 'PORTABLE_MANIFEST_INVALID');
});
