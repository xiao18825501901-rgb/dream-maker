// Read-only audit of source and toolchain boundaries for release components.
// This does not build an artifact or approve a distribution.
import {createHash} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const SCHEMA = 'dream-maker.release-component-boundary-audit.v1';
const HASH = /^[a-f0-9]{64}$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_JSON = 4 * 1024 * 1024;
const REQUIRED_IDS = [
  'dm-controller',
  'dreamflow-core',
  'planner1-cloud-runtime',
  'verified-base-toolchain'
];

export const COMPONENT_DEFINITIONS = Object.freeze([
  {
    id: 'dm-controller',
    exact: [
      'src/server/main.ts',
      'src/server/http.ts',
      'src/server/config.ts',
      'src/server/security.ts',
      'src/server/workspace.ts',
      'src/server/local-product.ts',
      'src/server/server-lock.ts',
      'prompts/executor.md',
      'prompts/planner2.md',
      'prompts/reviewer.md',
      'prompts/prompt-optimizer.md'
    ],
    prefixes: [
      'src/web/',
      'migrations/',
      'src/server/release/'
    ]
  },
  {
    id: 'dreamflow-core',
    exact: [
      'src/server/engine.ts',
      'src/server/flows.ts',
      'src/server/budget.ts',
      'src/server/native-budget.ts',
      'src/server/native-owner.ts',
      'src/server/native-probes.ts',
      'src/server/review-packet.ts',
      'src/server/custom-flow-preparation.ts',
      'src/server/providers/codex.ts',
      'src/server/providers/codex-transport.ts',
      'src/server/providers/codex-history.ts',
      'src/server/providers/codex-owned.ts',
      'src/server/providers/codex-status.ts',
      'src/server/providers/dsh.ts',
      'src/server/providers/model.ts',
      'src/server/providers/rpc.ts'
    ],
    prefixes: [
      'src/server/flow/',
      'src/server/prework/',
      'src/server/research/',
      'adapters/',
      'integrations/'
    ]
  },
  {
    id: 'planner1-cloud-runtime',
    exact: [
      'src/server/kimi-local-service.ts',
      'src/server/kimi-planner1-probe.ts',
      'src/server/interview.ts',
      'src/server/p1-planning.ts',
      'src/server/planner1-binding.ts',
      'src/server/providers/kimi.ts',
      'prompts/planner1.md'
    ],
    prefixes: [
      'scripts/kimi-p1/'
    ]
  },
  {
    id: 'verified-base-toolchain',
    externalFiles: [
      'node.exe',
      'LICENSE'
    ]
  }
]);

const fail = code => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const text = (value, max = 4000) =>
  typeof value === 'string' && value.length > 0 && value.length <= max &&
  !CONTROL.test(value);
const record = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) =>
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ino === right.ino &&
  left.mode === right.mode;

function absolute(value, code) {
  if (!text(value, 32000) || !isAbsolute(value) || /^[\\/]{2}/.test(value)) {
    fail(code);
  }
  return resolve(value);
}

function inside(root, value, code) {
  if (!text(value, 2000) || isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
      /^[\\/]{2}/.test(value)) {
    fail(code);
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some(part => !part || part === '.' || part === '..')) fail(code);
  const candidate = resolve(root, value);
  const pathFromRoot = relative(root, candidate);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    fail(code);
  }
  return {absolute: candidate, relative: pathFromRoot.replaceAll('\\', '/')};
}

function ordinaryFile(path, maxBytes, capture = true) {
  const absolutePath = resolve(path);
  let fd;
  try {
    const before = lstatSync(absolutePath);
    if (before.isSymbolicLink() || !before.isFile()) fail('INPUT_NOT_ORDINARY_FILE');
    if (before.size < 0 || before.size > maxBytes) fail('INPUT_FILE_LIMIT');
    fd = openSync(absolutePath, 'r');
    const opened = fstatSync(fd);
    if (!same(before, opened)) fail('INPUT_SOURCE_CHANGED');
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    const chunks = capture ? [] : null;
    let total = 0;
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      total += count;
      if (total > maxBytes) fail('INPUT_FILE_LIMIT');
      digest.update(buffer.subarray(0, count));
      if (chunks) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (total !== opened.size || !same(opened, lstatSync(absolutePath))) {
      fail('INPUT_SOURCE_CHANGED');
    }
    return {
      path: absolutePath,
      bytes: total,
      sha256: digest.digest('hex'),
      body: capture ? Buffer.concat(chunks, total) : null
    };
  } catch (error) {
    if (error?.code && /^(?:INPUT_|PATH_)/.test(error.code)) throw error;
    if (error?.code === 'ENOENT') fail('INPUT_MISSING');
    if (error?.code === 'EACCES' || error?.code === 'EPERM') fail('INPUT_UNREADABLE');
    fail('INPUT_INVALID');
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function jsonInput(path, maxBytes = MAX_JSON) {
  const file = ordinaryFile(path, maxBytes);
  try {
    return {
      file,
      value: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(file.body))
    };
  } catch {
    fail('INPUT_JSON_INVALID');
  }
}

function normalizeSourceState(source) {
  if (!record(source) || typeof source.schema !== 'string' ||
      !source.schema.startsWith('dream-maker.current-source-state.') ||
      !text(source.head, 64) || !text(source.branch, 200) ||
      !HASH.test(String(source.sourceHash ?? '')) ||
      !Array.isArray(source.sourceFiles)) {
    fail('SOURCE_STATE_INVALID');
  }
  const files = new Map();
  for (const file of source.sourceFiles) {
    if (!record(file) || !text(file.path, 2000) || isAbsolute(file.path) ||
        file.path.split(/[\\/]+/).some(part => !part || part === '.' || part === '..') ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        !HASH.test(String(file.sha256 ?? ''))) {
      fail('SOURCE_STATE_FILE_INVALID');
    }
    const path = file.path.replaceAll('\\', '/');
    if (files.has(path)) fail('SOURCE_STATE_FILE_DUPLICATE');
    files.set(path, {path, bytes: file.bytes, sha256: file.sha256});
  }
  if (source.sourceFileCount !== source.sourceFiles.length) {
    fail('SOURCE_STATE_COUNT_MISMATCH');
  }
  return {
    schema: source.schema,
    at: source.at,
    root: source.root,
    head: source.head,
    branch: source.branch,
    sourceHash: source.sourceHash,
    sourceFileCount: source.sourceFileCount,
    files
  };
}

function matchesDefinition(path, definition) {
  return definition.exact?.includes(path) ||
    definition.prefixes?.some(prefix => path.startsWith(prefix));
}

function treeIdentity(files) {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const body = sorted
    .map(file => `${file.path}\0${file.bytes}\0${file.sha256}\n`)
    .join('');
  return {
    fileCount: sorted.length,
    bytes: sorted.reduce((sum, file) => sum + file.bytes, 0),
    treeSha256: sha256(body),
    files: sorted
  };
}

function portableInputs({buildPath, nodeRoot}) {
  const {file: buildFile, value: build} = jsonInput(buildPath);
  if (!record(build) ||
      build.schema !== 'dream-maker.windows-portable-build.v1' ||
      build.status !== 'PASS_CORE_PORTABLE_ONLY' ||
      build.scope !== 'CORE_LOCAL_UI_AND_PROJECT_STATE_NOT_FULL_NATIVE_RELEASE' ||
      !HASH.test(String(build.sourceHash ?? '')) ||
      !text(build.nodeVersion, 40) ||
      !text(build.nodeRoot, 32000) ||
      !text(build.output, 32000) ||
      !text(build.archive, 32000)) {
    fail('PORTABLE_BUILD_RECEIPT_INVALID');
  }
  const resolvedNodeRoot = absolute(nodeRoot, 'NODE_ROOT_INVALID');
  if (resolve(build.nodeRoot) !== resolvedNodeRoot) fail('NODE_ROOT_MISMATCH');
  const buildOutput = absolute(build.output, 'PORTABLE_OUTPUT_INVALID');
  const manifestPath = resolve(buildOutput, 'RELEASE_MANIFEST.json');
  if (!existsSync(manifestPath)) fail('PORTABLE_MANIFEST_MISSING');
  const {value: manifest} = jsonInput(manifestPath);
  if (!record(manifest) ||
      manifest.schema !== 'dream-maker.windows-portable.v1' ||
      manifest.nodeVersion !== build.nodeVersion ||
      !Array.isArray(manifest.files)) {
    fail('PORTABLE_MANIFEST_INVALID');
  }
  const manifestFiles = new Map();
  for (const file of manifest.files) {
    if (!record(file) || !text(file.path, 400) ||
        manifestFiles.has(file.path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        !HASH.test(String(file.sha256 ?? ''))) {
      fail('PORTABLE_MANIFEST_FILE_INVALID');
    }
    manifestFiles.set(file.path, file);
  }
  const runtime = [];
  for (const [path, manifestPathInPackage] of [
    ['node.exe', 'runtime/node.exe'],
    ['LICENSE', 'runtime/LICENSE']
  ]) {
    const source = ordinaryFile(resolve(resolvedNodeRoot, path), 256 * 1024 * 1024);
    const recorded = manifestFiles.get(manifestPathInPackage);
    if (!recorded || recorded.bytes !== source.bytes || recorded.sha256 !== source.sha256) {
      fail('NODE_RUNTIME_MANIFEST_MISMATCH');
    }
    runtime.push({
      path,
      bytes: source.bytes,
      sha256: source.sha256
    });
  }
  const archive = ordinaryFile(resolve(build.archive), 2 * 1024 * 1024 * 1024, false);
  if (archive.bytes !== build.archiveBytes || archive.sha256 !== build.archiveSha256) {
    fail('PORTABLE_ARCHIVE_MISMATCH');
  }
  return {
    buildPath,
    buildFile,
    build,
    manifestPath,
    manifest,
    nodeRoot: resolvedNodeRoot,
    runtime,
    archive: {
      path: archive.path,
      bytes: archive.bytes,
      sha256: archive.sha256
    }
  };
}

function componentResults(source, portable) {
  const assigned = new Map();
  const result = [];
  for (const definition of COMPONENT_DEFINITIONS) {
    if (definition.id === 'verified-base-toolchain') {
      const identity = treeIdentity(portable.runtime);
      result.push({
        id: definition.id,
        sourceKind: 'DEDICATED_WINDOWS_NODE_RUNTIME',
        artifactHintStatus: 'EXTERNAL_RUNTIME_PINNED_COMPONENT_ARTIFACT_NOT_YET_BUILT',
        fileCount: identity.fileCount,
        bytes: identity.bytes,
        treeSha256: identity.treeSha256,
        files: identity.files,
        blockers: [
          'PINNED_COMPONENT_ARTIFACT_NOT_BUILT',
          'COMPONENT_SBOM_NOT_BUILT',
          'CLEAN_WINDOWS_REFERENCE_INVALID',
          'REDISTRIBUTION_NOT_REVIEWED'
        ]
      });
      continue;
    }
    for (const path of definition.exact ?? []) {
      if (!source.files.has(path)) fail(`SOURCE_BOUNDARY_FILE_MISSING:${definition.id}:${path}`);
    }
    const matches = [...source.files.values()]
      .filter(file => matchesDefinition(file.path, definition));
    if (matches.length === 0) fail(`SOURCE_BOUNDARY_EMPTY:${definition.id}`);
    for (const file of matches) {
      if (!assigned.has(file.path)) assigned.set(file.path, []);
      assigned.get(file.path).push(definition.id);
    }
    const identity = treeIdentity(matches);
    result.push({
      id: definition.id,
      sourceKind: 'LOCAL_SOURCE_TREE',
      artifactHintStatus: 'NOT_BUILT_FROM_CURRENT_SOURCE',
      fileCount: identity.fileCount,
      bytes: identity.bytes,
      treeSha256: identity.treeSha256,
      files: identity.files,
      blockers: [
        'PINNED_COMPONENT_ARTIFACT_NOT_BUILT',
        'COMPONENT_SBOM_NOT_BUILT',
        'CLEAN_WINDOWS_REFERENCE_INVALID',
        'REDISTRIBUTION_NOT_REVIEWED',
        'SOURCE_COMMIT_NOT_SIGNED'
      ]
    });
  }
  const overlaps = [...assigned.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([path, ids]) => ({path, components: [...new Set(ids)]}));
  if (overlaps.length) fail('SOURCE_COMPONENT_BOUNDARY_OVERLAP');
  return {components: result, overlaps};
}

export function auditReleaseComponentBoundaries({
  evidenceRoot,
  sourceState,
  portableBuild,
  nodeRoot,
  now = () => new Date()
} = {}) {
  if (typeof now !== 'function') fail('CLOCK_INVALID');
  const root = absolute(evidenceRoot, 'EVIDENCE_ROOT_INVALID');
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('EVIDENCE_ROOT_INVALID');
  const sourceRef = inside(root, sourceState, 'SOURCE_STATE_PATH_INVALID');
  const buildRef = inside(root, portableBuild, 'PORTABLE_BUILD_PATH_INVALID');
  const sourceInput = jsonInput(sourceRef.absolute);
  const source = normalizeSourceState(sourceInput.value);
  const portable = portableInputs({buildPath: buildRef.absolute, nodeRoot});
  const {components, overlaps} = componentResults(source, portable);
  if (components.map(component => component.id).join(',') !== REQUIRED_IDS.join(',')) {
    fail('COMPONENT_SET_INVALID');
  }
  return {
    schema: SCHEMA,
    at: now().toISOString(),
    status: 'READY_FOR_COMPONENT_ARTIFACT_BUILDERS_RELEASE_BLOCKED',
    scope: 'READ_ONLY_COMPONENT_BOUNDARY_AUDIT_NOT_RELEASE_MANIFEST',
    sourceState: {
      path: sourceRef.relative,
      sha256: sourceInput.file.sha256,
      at: source.at,
      root: source.root,
      head: source.head,
      branch: source.branch,
      sourceHash: source.sourceHash,
      sourceFileCount: source.sourceFileCount
    },
    portableBuild: {
      path: buildRef.relative,
      sha256: portable.buildFile.sha256,
      sourceHash: portable.build.sourceHash,
      nodeVersion: portable.build.nodeVersion,
      nodeRoot: portable.nodeRoot,
      archive: portable.archive
    },
    aggregateArchiveUse: {
      archiveReusedAsMultipleComponentArtifacts: false,
      reason: 'M82_PACKAGE_IS_PACKAGE_LEVEL_EVIDENCE_NOT_FOUR_COMPONENT_ARTIFACTS'
    },
    currentSourceArtifactBound: portable.build.sourceHash === source.sourceHash,
    components,
    overlaps,
    blockers: [
      'THREE_SOURCE_COMPONENT_ARTIFACTS_NOT_BUILT',
      'COMPONENT_SBOM_NOT_BUILT',
      'CLEAN_WINDOWS_REFERENCE_INVALID',
      'REDISTRIBUTION_NOT_REVIEWED'
    ],
    componentFragmentsCreated: false,
    componentEvidenceGateRun: false,
    completeDistribution: false,
    releaseReady: false,
    modelCalls: 0,
    credentialsRead: false,
    binariesExecuted: false,
    formalWrites: 0
  };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) fail(`ARGUMENT_MISSING:${name}`);
  return process.argv[index + 1];
}

function writeNoOverwrite(path, body) {
  if (existsSync(path)) fail('OUTPUT_EXISTS');
  mkdirSync(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, body, {flag: 'wx', flush: true});
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const evidenceRoot = arg('--evidence-root');
    const root = absolute(evidenceRoot, 'EVIDENCE_ROOT_INVALID');
    const output = inside(root, arg('--output'), 'OUTPUT_PATH_INVALID');
    const report = auditReleaseComponentBoundaries({
      evidenceRoot: root,
      sourceState: arg('--source-state'),
      portableBuild: arg('--portable-build'),
      nodeRoot: arg('--node-root')
    });
    writeNoOverwrite(output.absolute, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      output: output.absolute,
      status: report.status,
      components: report.components.map(component => ({
        id: component.id,
        fileCount: component.fileCount,
        bytes: component.bytes
      })),
      releaseReady: false,
      modelCalls: 0
    }));
  } catch (error) {
    console.error(error?.code ?? 'COMPONENT_BOUNDARY_AUDIT_FAILED');
    process.exitCode = 1;
  }
}
