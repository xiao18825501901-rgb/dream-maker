// Read-only Go binary inventory. This tool does not execute the inspected binary,
// download modules, install packages or claim redistribution approval.
import {createHash} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const MAX_BUILD_INFO_BYTES = 2_000_000;
const MAX_LICENSE_BYTES = 1_048_576;
const MAX_LICENSE_FILES = 32;
const MAX_LICENSE_BUNDLE_BYTES = 67_108_864;
const LICENSE_NAME = /^(?:LICENSE|LICENCE|NOTICE|COPYING|PATENTS)(?:\.[A-Za-z0-9._-]+)?$/i;
const MODULE_PATH = /^[A-Za-z0-9][A-Za-z0-9._~+\-/]*$/;
const MODULE_VERSION = /^v[0-9][A-Za-z0-9.+-]*$/;
const MODULE_SUM = /^h1:[A-Za-z0-9._+/=-]{1,160}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const text = (value, max = 500) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value);

function same(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

function ordinaryFile(path, maxBytes) {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw Error('GO_EVIDENCE_LINK_DENIED');
  if (!before.isFile()) throw Error('GO_EVIDENCE_NOT_A_FILE');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || before.size > maxBytes) {
    throw Error('GO_EVIDENCE_FILE_LIMIT');
  }
  const fd = openSync(path, 'r');
  const opened = fstatSync(fd);
  if (!same(before, opened)) throw Error('GO_EVIDENCE_SOURCE_CHANGED');
  const body = Buffer.alloc(opened.size);
  let offset = 0;
  try {
    while (offset < body.length) {
      const count = readSync(fd, body, offset, body.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
  } finally {
    closeSync(fd);
  }
  if (offset !== opened.size || !same(opened, lstatSync(path))) {
    throw Error('GO_EVIDENCE_SOURCE_CHANGED');
  }
  return {bytes: offset, sha256: sha256(body), body};
}

export function escapeGoModulePath(module) {
  if (!text(module, 500) || !MODULE_PATH.test(module) || module.includes('!') || module.includes('@')) {
    throw Error('GO_MODULE_PATH_INVALID');
  }
  const parts = module.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw Error('GO_MODULE_PATH_INVALID');
  }
  return parts.map(part => part.replace(/[A-Z]/g, value => `!${value.toLowerCase()}`)).join('/');
}

function escapeGoVersion(version) {
  if (!text(version, 160) || !MODULE_VERSION.test(version) || version.includes('!')) {
    throw Error('GO_MODULE_VERSION_INVALID');
  }
  return version.replace(/[A-Z]/g, value => `!${value.toLowerCase()}`);
}

export function parseGoBuildInfo(value) {
  if (typeof value !== 'string') throw Error('GO_BUILD_INFO_INVALID');
  const bytes = Buffer.byteLength(value);
  if (bytes < 1 || bytes > MAX_BUILD_INFO_BYTES || !value.endsWith('\n')) {
    throw Error('GO_BUILD_INFO_INVALID');
  }
  const lines = value.trimEnd().split(/\r?\n/);
  const first = /^.*: (go[0-9][A-Za-z0-9.+-]*)$/.exec(lines.shift() ?? '');
  if (!first) throw Error('GO_BUILD_TOOLCHAIN_INVALID');
  let path = null;
  let mainModule = null;
  const dependencies = [];
  const dependencyModules = new Set();
  const build = {};
  for (const line of lines) {
    if (!line.startsWith('\t')) throw Error('GO_BUILD_INFO_INVALID');
    const fields = line.split('\t').slice(1);
    if (fields[0] === 'path' && fields.length === 2 && text(fields[1], 500)) {
      if (path) throw Error('GO_BUILD_PATH_DUPLICATE');
      path = fields[1];
      continue;
    }
    if (fields[0] === 'mod' && fields.length >= 3) {
      if (mainModule) throw Error('GO_BUILD_MODULE_DUPLICATE');
      if (!MODULE_PATH.test(fields[1])) throw Error('GO_BUILD_MODULE_INVALID');
      mainModule = fields[1];
      continue;
    }
    if (fields[0] === 'dep') {
      if (fields.length !== 4 || !MODULE_PATH.test(fields[1]) ||
          !MODULE_VERSION.test(fields[2]) || !MODULE_SUM.test(fields[3])) {
        throw Error('GO_BUILD_DEPENDENCY_INVALID');
      }
      if (dependencyModules.has(fields[1])) throw Error('GO_BUILD_DEPENDENCY_DUPLICATE');
      dependencyModules.add(fields[1]);
      dependencies.push({module: fields[1], version: fields[2], sum: fields[3]});
      continue;
    }
    if (fields[0] === 'build' && fields.length === 2) {
      const separator = fields[1].indexOf('=');
      if (separator < 1) throw Error('GO_BUILD_SETTING_INVALID');
      const name = fields[1].slice(0, separator);
      const setting = fields[1].slice(separator + 1);
      if (!/^-?[A-Za-z0-9_]+$/.test(name) || setting.length > 500) {
        throw Error('GO_BUILD_SETTING_INVALID');
      }
      if (Object.hasOwn(build, name)) throw Error('GO_BUILD_SETTING_DUPLICATE');
      build[name] = setting;
    }
  }
  if (!path || MODULE_PATH.test(path) === false || !mainModule) throw Error('GO_BUILD_IDENTITY_MISSING');
  if (build.GOOS !== 'windows' || build.GOARCH !== 'amd64') throw Error('GO_BUILD_PLATFORM_UNSUPPORTED');
  dependencies.sort((a, b) => a.module.localeCompare(b.module, 'en'));
  return {toolchain: first[1], path, mainModule, dependencies, build};
}

function moduleLicenseEvidence(moduleCache, dependency) {
  const relativePath = `${escapeGoModulePath(dependency.module)}@${escapeGoVersion(dependency.version)}`;
  const root = resolve(moduleCache, ...relativePath.split('/'));
  let stat;
  try {
    stat = lstatSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return {relativePath, status: 'MODULE_MISSING', files: []};
    return {relativePath, status: 'MODULE_UNREADABLE', files: []};
  }
  if (stat.isSymbolicLink()) return {relativePath, status: 'MODULE_LINK_DENIED', files: []};
  if (!stat.isDirectory()) return {relativePath, status: 'MODULE_NOT_DIRECTORY', files: []};
  let names;
  try {
    names = readdirSync(root, {withFileTypes: true})
      .filter(entry => entry.isFile() && LICENSE_NAME.test(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch {
    return {relativePath, status: 'MODULE_UNREADABLE', files: []};
  }
  if (names.length > MAX_LICENSE_FILES) return {relativePath, status: 'FILE_LIMIT', files: []};
  if (names.length === 0) return {relativePath, status: 'MISSING', files: []};
  const files = [];
  for (const name of names) {
    try {
      const observed = ordinaryFile(resolve(root, name), MAX_LICENSE_BYTES);
      files.push({path: name, bytes: observed.bytes, sha256: observed.sha256});
    } catch (error) {
      const message = String(error?.message ?? '');
      const status = message === 'GO_EVIDENCE_FILE_LIMIT'
        ? 'FILE_LIMIT'
        : message === 'GO_EVIDENCE_LINK_DENIED'
          ? 'LINK_DENIED'
          : message === 'GO_EVIDENCE_SOURCE_CHANGED'
            ? 'SOURCE_CHANGED'
            : 'UNREADABLE';
      return {relativePath, status, files: []};
    }
  }
  return {relativePath, status: 'PRESENT', files};
}

export function buildGoSbom({binary, buildInfo, componentId, version, moduleCache}) {
  if (!binary || !isAbsolute(binary.path) || !Number.isSafeInteger(binary.bytes) ||
      binary.bytes < 1 || !HASH.test(String(binary.sha256 ?? ''))) {
    throw Error('GO_BINARY_IDENTITY_INVALID');
  }
  if (!text(componentId, 128) || !/^[a-z0-9][a-z0-9-]*$/.test(componentId)) {
    throw Error('COMPONENT_ID_INVALID');
  }
  if (!text(version, 160) || !/^[0-9][A-Za-z0-9.+_-]*$/.test(version)) {
    throw Error('COMPONENT_VERSION_INVALID');
  }
  if (!isAbsolute(moduleCache)) throw Error('GO_MODULE_CACHE_INVALID');
  const parsed = parseGoBuildInfo(buildInfo);
  const dependencies = parsed.dependencies.map(dependency => {
    const license = moduleLicenseEvidence(moduleCache, dependency);
    return {
      id: dependency.module,
      module: dependency.module,
      version: dependency.version,
      goModuleSum: dependency.sum,
      source: {kind: 'GO_MODULE', locator: dependency.module, revision: dependency.version},
      license
    };
  });
  const missing = dependencies.filter(dependency => dependency.license.status !== 'PRESENT');
  const allLicensesPresent = dependencies.length > 0 && missing.length === 0;
  return {
    schema: 'dream-maker.component-sbom.v1',
    at: new Date().toISOString(),
    status: allLicensesPresent ? 'COMPLETE' : 'INCOMPLETE_LICENSE_EVIDENCE',
    componentId,
    version,
    platform: 'win32',
    architecture: parsed.build.GOARCH,
    artifactSha256: binary.sha256,
    artifactBytes: binary.bytes,
    toolchain: parsed.toolchain,
    mainModule: parsed.mainModule,
    executablePath: parsed.path,
    buildInfoSha256: sha256(Buffer.from(buildInfo)),
    dependencyCount: dependencies.length,
    dependencies,
    completeness: {
      allLicensesPresent,
      missingLicenseCount: missing.length,
      declaration: 'ALL_RUNTIME_GO_MODULES_FROM_BUILDINFO_AND_CACHED_TOP_LEVEL_LICENSE_FILES'
    },
    machineReadableComplete: allLicensesPresent,
    redistributionReviewed: false,
    cleanMachineRunVerified: false,
    modelCalls: 0,
    networkRequests: 0
  };
}

export function buildGoLicenseBundle({sbom, moduleCache}) {
  if (!sbom || sbom.schema !== 'dream-maker.component-sbom.v1' ||
      sbom.status !== 'COMPLETE' || sbom.machineReadableComplete !== true ||
      !Array.isArray(sbom.dependencies) || sbom.dependencies.length < 1 ||
      !isAbsolute(moduleCache)) {
    throw Error('GO_LICENSE_BUNDLE_INCOMPLETE');
  }
  const chunks = [];
  let bytes = 0;
  let fileCount = 0;
  for (const dependency of sbom.dependencies) {
    if (!text(dependency?.module, 500) || !text(dependency?.version, 160) ||
        dependency.license?.status !== 'PRESENT' || !Array.isArray(dependency.license.files) ||
        dependency.license.files.length < 1 || !text(dependency.license.relativePath, 1000)) {
      throw Error('GO_LICENSE_BUNDLE_INCOMPLETE');
    }
    const root = resolve(moduleCache, ...dependency.license.relativePath.split('/'));
    if (!inside(moduleCache, root)) throw Error('GO_LICENSE_BUNDLE_PATH_DENIED');
    for (const file of dependency.license.files) {
      if (!text(file?.path, 255) || file.path.includes('/') || file.path.includes('\\') ||
          file.path === '.' || file.path === '..' || !HASH.test(String(file.sha256 ?? ''))) {
        throw Error('GO_LICENSE_BUNDLE_INCOMPLETE');
      }
      const observed = ordinaryFile(resolve(root, file.path), MAX_LICENSE_BYTES);
      if (observed.sha256 !== file.sha256 || observed.bytes !== file.bytes) {
        throw Error('GO_LICENSE_BUNDLE_SOURCE_CHANGED');
      }
      const header = Buffer.from(
        `===== ${dependency.module} ${dependency.version} :: ${file.path} =====\n`,
        'utf8'
      );
      const footer = Buffer.from('\n\n', 'utf8');
      bytes += header.length + observed.body.length + footer.length;
      if (bytes > MAX_LICENSE_BUNDLE_BYTES) throw Error('GO_LICENSE_BUNDLE_FILE_LIMIT');
      chunks.push(header, observed.body, footer);
      fileCount += 1;
    }
  }
  const body = Buffer.concat(chunks, bytes);
  return {
    body,
    bytes,
    sha256: sha256(body),
    dependencyCount: sbom.dependencies.length,
    fileCount
  };
}

function requiredArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw Error(`GO_SBOM_ARGUMENT_MISSING:${name}`);
  return process.argv[index + 1];
}

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel && !rel.startsWith('..') && !isAbsolute(rel);
}

function run() {
  const suite = resolve(process.env.DREAMMAKER_SUITE_ROOT ?? 'F:\\DreamMakerSuite');
  const binaryPath = resolve(requiredArg('--binary'));
  const goPath = resolve(requiredArg('--go'));
  const moduleCache = resolve(requiredArg('--module-cache'));
  const componentId = requiredArg('--component-id');
  const version = requiredArg('--version');
  const output = resolve(requiredArg('--output'));
  if (!inside(suite, binaryPath) || !inside(suite, goPath) ||
      !inside(suite, moduleCache) || !inside(suite, output)) {
    throw Error('GO_SBOM_PATH_OUTSIDE_SUITE');
  }
  if (existsSync(output) || !existsSync(binaryPath) || !existsSync(goPath) || !existsSync(moduleCache)) {
    throw Error('GO_SBOM_INPUT_OR_OUTPUT_INVALID');
  }
  const observedBinary = ordinaryFile(binaryPath, 2_147_483_648);
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    TEMP: join(suite, 'temp', 'go-sbom'),
    TMP: join(suite, 'temp', 'go-sbom'),
    GOMODCACHE: moduleCache,
    GOPATH: join(suite, 'caches', 'go-path'),
    GOCACHE: join(suite, 'caches', 'go-build'),
    GOPROXY: 'off',
    GOTOOLCHAIN: 'local',
    GOTELEMETRY: 'off'
  };
  mkdirSync(env.TEMP, {recursive: true});
  const processResult = spawnSync(goPath, ['version', '-m', binaryPath], {
    cwd: suite,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2_000_000,
    windowsHide: true,
    shell: false
  });
  if (processResult.error || processResult.status !== 0 || processResult.signal ||
      typeof processResult.stdout !== 'string' || processResult.stdout.length === 0) {
    throw Error('GO_BUILD_INFO_READ_FAILED');
  }
  const sbom = buildGoSbom({
    binary: {path: binaryPath, bytes: observedBinary.bytes, sha256: observedBinary.sha256},
    buildInfo: processResult.stdout,
    componentId,
    version,
    moduleCache
  });
  const licenseBundle = buildGoLicenseBundle({sbom, moduleCache});
  mkdirSync(dirname(output), {recursive: true});
  mkdirSync(output, {recursive: false});
  writeFileSync(join(output, 'go-buildinfo.txt'), processResult.stdout, {flag: 'wx'});
  writeFileSync(join(output, 'component-sbom.json'), JSON.stringify(sbom, null, 2) + '\n', {flag: 'wx'});
  writeFileSync(join(output, 'THIRD_PARTY_LICENSES.txt'), licenseBundle.body, {flag: 'wx'});
  const receipt = {
    schema: 'dream-maker.go-sbom-generation.v1',
    at: new Date().toISOString(),
    binary: {path: binaryPath, bytes: observedBinary.bytes, sha256: observedBinary.sha256},
    output,
    sbomSha256: sha256(Buffer.from(JSON.stringify(sbom, null, 2) + '\n')),
    licenseBundle: {
      path: join(output, 'THIRD_PARTY_LICENSES.txt'),
      bytes: licenseBundle.bytes,
      sha256: licenseBundle.sha256,
      fileCount: licenseBundle.fileCount
    },
    status: sbom.status,
    machineReadableComplete: sbom.machineReadableComplete,
    dependencyCount: sbom.dependencyCount,
    missingLicenses: sbom.dependencies
      .filter(dependency => dependency.license.status !== 'PRESENT')
      .map(dependency => ({module: dependency.module, version: dependency.version, status: dependency.license.status})),
    modelCalls: 0,
    networkRequests: 0,
    redistributionReviewed: false
  };
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({output, ...receipt}));
  process.exitCode = sbom.machineReadableComplete ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
