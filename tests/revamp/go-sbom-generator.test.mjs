import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {harness} from '../helpers.mjs';
import {
  buildGoLicenseBundle,
  buildGoSbom,
  escapeGoModulePath,
  parseGoBuildInfo
} from '../../scripts/revamp/generate-go-sbom.mjs';

const binary = {
  path: 'F:/DreamMakerSuite/evidence/example/dream-maker-magpie.exe',
  bytes: 123,
  sha256: 'a'.repeat(64)
};

function buildInfo({duplicate = false, malformed = false} = {}) {
  const duplicateLine = duplicate
    ? '\tdep\texample.com/Foo\tv1.2.3\th1:duplicate\n'
    : '';
  const malformedLine = malformed ? '\tdep\texample.com/Broken\n' : '';
  return [
    'C:\\candidate.exe: go1.26.8',
    '\tpath\tgithub.com/example/product/cmd/dream-maker-magpie',
    '\tmod\tgithub.com/example/product\t(devel)\t',
    '\tdep\texample.com/Foo\tv1.2.3\th1:VVDuqn14Dzlhcs17gDp3X43uvKkxi7OK7SZvkd0moEc=',
    duplicateLine + malformedLine + '\tbuild\t-buildmode=exe',
    '\tbuild\tCGO_ENABLED=0',
    '\tbuild\tGOARCH=amd64',
    '\tbuild\tGOOS=windows'
  ].filter(Boolean).join('\n') + '\n';
}

test('Go buildinfo parsing keeps the executable module and rejects malformed or duplicate dependencies', () => {
  const parsed = parseGoBuildInfo(buildInfo());
  assert.equal(parsed.toolchain, 'go1.26.8');
  assert.equal(parsed.path, 'github.com/example/product/cmd/dream-maker-magpie');
  assert.equal(parsed.mainModule, 'github.com/example/product');
  assert.deepEqual(parsed.build, {
    '-buildmode': 'exe',
    GOOS: 'windows',
    GOARCH: 'amd64',
    CGO_ENABLED: '0'
  });
  assert.deepEqual(parsed.dependencies, [{
    module: 'example.com/Foo',
    version: 'v1.2.3',
    sum: 'h1:VVDuqn14Dzlhcs17gDp3X43uvKkxi7OK7SZvkd0moEc='
  }]);
  assert.throws(() => parseGoBuildInfo(buildInfo({duplicate: true})), /GO_BUILD_DEPENDENCY_DUPLICATE/);
  assert.throws(() => parseGoBuildInfo(buildInfo({malformed: true})), /GO_BUILD_DEPENDENCY_INVALID/);
});

test('Go module cache escaping is deterministic and does not accept path traversal', () => {
  assert.equal(escapeGoModulePath('example.com/Foo/Bar'), 'example.com/!foo/!bar');
  assert.equal(escapeGoModulePath('example.com/gopkg.in/yaml.v3'), 'example.com/gopkg.in/yaml.v3');
  assert.throws(() => escapeGoModulePath('../outside'), /GO_MODULE_PATH_INVALID/);
  assert.throws(() => escapeGoModulePath('example.com/a!b'), /GO_MODULE_PATH_INVALID/);
});

test('a complete module inventory binds license bytes and remains incomplete when a license is absent', t => {
  const h = harness(t);
  const moduleCache = resolve(h.dir, 'go-mod');
  const present = resolve(moduleCache, 'example.com', '!foo@v1.2.3');
  const missing = resolve(moduleCache, 'example.com', 'missing@v0.1.0');
  mkdirSync(present, {recursive: true});
  mkdirSync(missing, {recursive: true});
  writeFileSync(resolve(present, 'LICENSE'), 'EXAMPLE LICENSE\n');

  const text = buildInfo()
    .replace(
      '\tbuild\t-buildmode=exe',
      '\tdep\texample.com/missing\tv0.1.0\th1:missing+sum/=\n\tbuild\t-buildmode=exe'
    );
  const result = buildGoSbom({
    binary,
    buildInfo: text,
    componentId: 'magpie-runtime',
    version: '0.1.2698',
    moduleCache
  });

  assert.equal(result.schema, 'dream-maker.component-sbom.v1');
  assert.equal(result.componentId, 'magpie-runtime');
  assert.equal(result.version, '0.1.2698');
  assert.equal(result.artifactSha256, binary.sha256);
  assert.equal(result.status, 'INCOMPLETE_LICENSE_EVIDENCE');
  assert.equal(result.dependencies.length, 2);
  const foo = result.dependencies.find(dependency => dependency.module === 'example.com/Foo');
  assert.equal(foo.license.status, 'PRESENT');
  assert.equal(foo.license.files.length, 1);
  assert.equal(foo.license.files[0].path, 'LICENSE');
  assert.match(foo.license.files[0].sha256, /^[a-f0-9]{64}$/);
  const absent = result.dependencies.find(dependency => dependency.module === 'example.com/missing');
  assert.equal(absent.license.status, 'MISSING');
  assert.equal(result.completeness.allLicensesPresent, false);
  assert.equal(result.machineReadableComplete, false);
});

test('the inventory refuses redirected or oversized license bytes', t => {
  const h = harness(t);
  const moduleCache = resolve(h.dir, 'go-mod');
  const moduleRoot = resolve(moduleCache, 'example.com', '!foo@v1.2.3');
  mkdirSync(moduleRoot, {recursive: true});
  writeFileSync(resolve(moduleRoot, 'LICENSE'), Buffer.alloc(1_048_577, 0x41));

  const result = buildGoSbom({
    binary,
    buildInfo: buildInfo(),
    componentId: 'magpie-runtime',
    version: '0.1.2698',
    moduleCache
  });
  assert.equal(result.dependencies[0].license.status, 'FILE_LIMIT');
  assert.equal(result.dependencies[0].license.files.length, 0);
  assert.equal(result.machineReadableComplete, false);
});

test('the license bundle is generated only from revalidated present license bytes', t => {
  const h = harness(t);
  const moduleCache = resolve(h.dir, 'go-mod');
  const moduleRoot = resolve(moduleCache, 'example.com', '!foo@v1.2.3');
  mkdirSync(moduleRoot, {recursive: true});
  writeFileSync(resolve(moduleRoot, 'LICENSE'), 'EXAMPLE LICENSE\n');

  const complete = buildGoSbom({
    binary,
    buildInfo: buildInfo(),
    componentId: 'magpie-runtime',
    version: '0.1.2698',
    moduleCache
  });
  const bundle = buildGoLicenseBundle({sbom: complete, moduleCache});
  assert.equal(bundle.dependencyCount, 1);
  assert.equal(bundle.fileCount, 1);
  assert.match(bundle.body.toString('utf8'), /example\.com\/Foo v1\.2\.3 :: LICENSE/);
  assert.match(bundle.body.toString('utf8'), /EXAMPLE LICENSE/);
  assert.match(bundle.sha256, /^[a-f0-9]{64}$/);

  const incomplete = buildGoSbom({
    binary,
    buildInfo: buildInfo().replace(
      '\tbuild\t-buildmode=exe',
      '\tdep\texample.com/missing\tv0.1.0\th1:missing+sum/=\n\tbuild\t-buildmode=exe'
    ),
    componentId: 'magpie-runtime',
    version: '0.1.2698',
    moduleCache
  });
  assert.throws(
    () => buildGoLicenseBundle({sbom: incomplete, moduleCache}),
    /GO_LICENSE_BUNDLE_INCOMPLETE/
  );
});
