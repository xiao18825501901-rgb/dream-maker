// Read-only package-tree inventory. This tool does not execute a runtime,
// install packages, download dependencies or approve redistribution.
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
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HASH = /^[a-f0-9]{64}$/;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PACKAGE_VERSION = /^[0-9][A-Za-z0-9.+_-]*$/;
const LICENSE_NAME = /^(?:LICENSE|LICENCE|NOTICE|COPYING|PATENTS)(?:[.-][A-Za-z0-9._-]+)?$/i;
const LICENSE_EVIDENCE_SCHEMA = 'dream-maker.node-runtime-license-evidence.v1';
const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 200_000,
  maxFileBytes: 2_147_483_648,
  maxTotalBytes: 8_589_934_592,
  maxPackageJsonBytes: 1_048_576,
  maxLicenseBytes: 4_194_304,
  maxLicenseFilesPerPackage: 64,
  maxLicenseBundleBytes: 67_108_864
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const text = (value, max = 600) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value);
const posix = value => value.split(/[\\/]+/).join('/');

function same(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

function ordinaryFile(path, maxBytes, {capture = false} = {}) {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw Error('NODE_RUNTIME_LINK_DENIED');
  if (!before.isFile()) throw Error('NODE_RUNTIME_NOT_A_FILE');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || before.size > maxBytes) {
    throw Error('NODE_RUNTIME_FILE_LIMIT');
  }
  const fd = openSync(path, 'r');
  const opened = fstatSync(fd);
  if (!same(before, opened)) throw Error('NODE_RUNTIME_SOURCE_CHANGED');
  const digest = createHash('sha256');
  const chunks = [];
  const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, opened.size)));
  let total = 0;
  try {
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      total += count;
      if (total > maxBytes) throw Error('NODE_RUNTIME_FILE_LIMIT');
      digest.update(buffer.subarray(0, count));
      if (capture) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally {
    closeSync(fd);
  }
  if (total !== opened.size || !same(opened, lstatSync(path))) {
    throw Error('NODE_RUNTIME_SOURCE_CHANGED');
  }
  return {
    path,
    bytes: total,
    sha256: digest.digest('hex'),
    body: chunks.length ? Buffer.concat(chunks, total) : undefined
  };
}

function normalizedLimits(value) {
  const limits = {...DEFAULT_LIMITS, ...(value ?? {})};
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw Error(`NODE_RUNTIME_LIMIT_INVALID:${name}`);
    }
  }
  return limits;
}

function walkOrdinaryTree(root, limits) {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw Error('NODE_RUNTIME_ROOT_INVALID');
  }
  const files = [];
  let totalBytes = 0;
  const visit = directory => {
    const entries = readdirSync(directory, {withFileTypes: true})
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error('NODE_RUNTIME_LINK_DENIED');
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) throw Error('NODE_RUNTIME_SPECIAL_FILE_DENIED');
      const rel = posix(relative(root, path));
      if (!rel || rel.startsWith('../') || isAbsolute(rel)) {
        throw Error('NODE_RUNTIME_PATH_DENIED');
      }
      const observed = ordinaryFile(path, limits.maxFileBytes);
      totalBytes += observed.bytes;
      if (files.length + 1 > limits.maxEntries || totalBytes > limits.maxTotalBytes) {
        throw Error('NODE_RUNTIME_TREE_LIMIT');
      }
      files.push({path: rel, bytes: observed.bytes, sha256: observed.sha256});
    }
  };
  visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const treeDigest = createHash('sha256');
  for (const file of files) {
    treeDigest.update(Buffer.from(`${file.path}\0${file.bytes}\0${file.sha256}\n`, 'utf8'));
  }
  return {
    files,
    fileCount: files.length,
    totalBytes,
    rootTreeSha256: treeDigest.digest('hex')
  };
}

function parsePackageManifest(file, rootTree) {
  if (file.bytes < 1 || file.bytes > DEFAULT_LIMITS.maxPackageJsonBytes) {
    throw Error('NODE_RUNTIME_PACKAGE_JSON_INVALID');
  }
  const observed = ordinaryFile(file.absolute, DEFAULT_LIMITS.maxPackageJsonBytes, {capture: true});
  if (observed.sha256 !== file.sha256 || observed.bytes !== file.bytes || !observed.body) {
    throw Error('NODE_RUNTIME_SOURCE_CHANGED');
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(observed.body));
  } catch {
    throw Error('NODE_RUNTIME_PACKAGE_JSON_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('NODE_RUNTIME_PACKAGE_JSON_INVALID');
  }
  if (typeof value.name !== 'string' || typeof value.version !== 'string' ||
      !value.name || !value.version) return null;
  if (!text(value.name, 214) || !PACKAGE_NAME.test(value.name) ||
      !text(value.version, 160) || !PACKAGE_VERSION.test(value.version)) {
    throw Error('NODE_RUNTIME_PACKAGE_IDENTITY_INVALID');
  }
  let declaredLicense = null;
  if (text(value.license, 214)) declaredLicense = value.license;
  else if (value.license && typeof value.license === 'object' &&
      !Array.isArray(value.license) && text(value.license.type, 214)) {
    declaredLicense = value.license.type;
  }
  const packagePath = posix(relative(rootTree.root, dirname(file.absolute)));
  if (packagePath && value.private === true) return null;
  const prefix = packagePath ? `${packagePath}/` : '';
  const licenseFiles = rootTree.files
    .filter(entry => {
      if (!entry.path.startsWith(prefix)) return false;
      const suffix = entry.path.slice(prefix.length);
      return !suffix.includes('/') && LICENSE_NAME.test(suffix);
    })
    .map(entry => ({path: entry.path.slice(prefix.length), bytes: entry.bytes, sha256: entry.sha256}));
  if (licenseFiles.length > DEFAULT_LIMITS.maxLicenseFilesPerPackage) {
    throw Error('NODE_RUNTIME_LICENSE_FILE_LIMIT');
  }
  return {
    id: `${value.name}@${value.version}`,
    package: value.name,
    version: value.version,
    path: packagePath,
    manifestSha256: file.sha256,
    declaredLicense,
    license: {
      status: licenseFiles.length ? 'PRESENT' : 'MISSING',
      files: licenseFiles
    }
  };
}

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 ||
      !HASH.test(String(artifact.sha256 ?? ''))
  ) {
    throw Error('NODE_RUNTIME_ARTIFACT_IDENTITY_INVALID');
  }
  return {
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    path: text(artifact.path, 2000) ? artifact.path : null
  };
}

function safeEvidenceRelative(value) {
  if (!text(value, 1000) || isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
      /^[\\/]{2}/.test(value)) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_PATH_DENIED');
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_PATH_DENIED');
  }
  return parts;
}

function evidenceFile(root, value, maxBytes) {
  const parts = safeEvidenceRelative(value);
  const normalizedRoot = resolve(root);
  const rootStat = lstatSync(normalizedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_ROOT_INVALID');
  }
  let current = normalizedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_PATH_DENIED');
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_PATH_DENIED');
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_NOT_A_FILE');
    }
  }
  return ordinaryFile(current, maxBytes, {capture: true});
}

function normalizedPackagePath(value) {
  if (value === '') return '';
  if (!text(value, 1000) || /^[A-Za-z]:/.test(value) || isAbsolute(value) ||
      /^[\\/]{2}/.test(value)) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_PATH_DENIED');
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_PATH_DENIED');
  }
  return parts.join('/');
}

function normalizeLicenseEvidenceEntry(root, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !text(value.package, 214) || !PACKAGE_NAME.test(value.package) ||
      !text(value.version, 160) || !PACKAGE_VERSION.test(value.version) ||
      value.id !== `${value.package}@${value.version}` ||
      !HASH.test(String(value.manifestSha256 ?? ''))) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_ENTRY_INVALID');
  }
  const path = normalizedPackagePath(value.path);
  const base = {
    id: value.id,
    package: value.package,
    version: value.version,
    path,
    manifestSha256: value.manifestSha256,
    declaredLicense: text(value.declaredLicense, 214) ? value.declaredLicense : null,
    reviewNotes: text(value.reviewNotes, 1000) ? value.reviewNotes : null
  };
  if (value.firstParty !== undefined) {
    if (path !== '' || !value.firstParty || typeof value.firstParty !== 'object' ||
        Array.isArray(value.firstParty) || !text(value.firstParty.owner, 214) ||
        !text(value.firstParty.declaration, 214) ||
        !text(value.firstParty.sourceLocator, 1000) ||
        !HASH.test(String(value.firstParty.sourceSha256 ?? ''))) {
      throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_ENTRY_INVALID');
    }
    const declarationSource = evidenceFile(
      root,
      value.firstParty.sourceLocator,
      DEFAULT_LIMITS.maxLicenseBytes
    );
    if (declarationSource.sha256 !== value.firstParty.sourceSha256) {
      throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_DIGEST_MISMATCH');
    }
    return {
      ...base,
      kind: 'FIRST_PARTY',
      firstParty: {
        owner: value.firstParty.owner,
        declaration: value.firstParty.declaration,
        sourceLocator: value.firstParty.sourceLocator,
        sourceSha256: value.firstParty.sourceSha256
      }
    };
  }

  if (!value.tarball || typeof value.tarball !== 'object' ||
      !text(value.tarball.locator, 2000) ||
      !Number.isSafeInteger(value.tarball.bytes) || value.tarball.bytes < 1 ||
      !HASH.test(String(value.tarball.sha256 ?? '')) ||
      !SHA512_INTEGRITY.test(String(value.tarball.integrity ?? '')) ||
      !value.source || typeof value.source !== 'object' ||
      !['GIT_COMMIT', 'NPM_TARBALL_MEMBER', 'SPDX_LICENSE_TEXT'].includes(value.source.kind) ||
      !text(value.source.locator, 2000) ||
      !text(value.source.filePath, 1000) ||
      !value.license || typeof value.license !== 'object' ||
      !text(value.license.spdx, 214) ||
      !text(value.license.path, 1000) ||
      !Number.isSafeInteger(value.license.bytes) || value.license.bytes < 1 ||
      !HASH.test(String(value.license.sha256 ?? ''))) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_ENTRY_INVALID');
  }
  if (value.source.kind === 'GIT_COMMIT' && !GIT_REVISION.test(String(value.source.revision ?? ''))) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_ENTRY_INVALID');
  }
  if ((value.source.upstreamLocator === undefined) !==
      (value.source.upstreamRevision === undefined) ||
      (value.source.upstreamLocator !== undefined &&
        (!text(value.source.upstreamLocator, 2000) ||
          !GIT_REVISION.test(String(value.source.upstreamRevision ?? ''))))) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_ENTRY_INVALID');
  }
  const observed = evidenceFile(root, value.license.path, DEFAULT_LIMITS.maxLicenseBytes);
  if (observed.bytes !== value.license.bytes || observed.sha256 !== value.license.sha256) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_DIGEST_MISMATCH');
  }
  const additionalLicenses = value.additionalLicenses ?? [];
  if (!Array.isArray(additionalLicenses) || additionalLicenses.length > 16) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_ENTRY_INVALID');
  }
  const normalizedAdditional = additionalLicenses.map(additional => {
    if (!additional || typeof additional !== 'object' ||
        !text(additional.path, 1000) || !text(additional.sourceFilePath, 1000) ||
        !Number.isSafeInteger(additional.bytes) || additional.bytes < 1 ||
        !HASH.test(String(additional.sha256 ?? ''))) {
      throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_ENTRY_INVALID');
    }
    const additionalObserved = evidenceFile(
      root,
      additional.path,
      DEFAULT_LIMITS.maxLicenseBytes
    );
    if (additionalObserved.bytes !== additional.bytes ||
        additionalObserved.sha256 !== additional.sha256) {
      throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_DIGEST_MISMATCH');
    }
    return {
      path: additional.path,
      sourceFilePath: additional.sourceFilePath,
      bytes: additionalObserved.bytes,
      sha256: additionalObserved.sha256,
      body: additionalObserved.body
    };
  });
  return {
    ...base,
    kind: 'THIRD_PARTY',
    tarball: {
      locator: value.tarball.locator,
      bytes: value.tarball.bytes,
      sha256: value.tarball.sha256,
      integrity: value.tarball.integrity
    },
    source: {
      kind: value.source.kind,
      locator: value.source.locator,
      revision: value.source.kind === 'GIT_COMMIT' ? value.source.revision : null,
      filePath: value.source.filePath,
      upstreamLocator: value.source.upstreamLocator ?? null,
      upstreamRevision: value.source.upstreamRevision ?? null
    },
    license: {
      spdx: value.license.spdx,
      path: value.license.path,
      bytes: observed.bytes,
      sha256: observed.sha256,
      body: observed.body
    },
    additionalLicenses: normalizedAdditional
  };
}

export function loadNodeLicenseEvidence({root, manifestPath, expectedSha256}) {
  if (!text(root, 2000) || !isAbsolute(root) ||
      !HASH.test(String(expectedSha256 ?? ''))) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_INVALID');
  }
  const manifestFile = evidenceFile(root, manifestPath, DEFAULT_LIMITS.maxPackageJsonBytes);
  if (manifestFile.sha256 !== expectedSha256) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_DIGEST_MISMATCH');
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(manifestFile.body));
  } catch {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_INVALID');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.schema !== LICENSE_EVIDENCE_SCHEMA ||
      !text(manifest.componentId, 128) || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.componentId) ||
      !text(manifest.version, 160) || !PACKAGE_VERSION.test(manifest.version) ||
      !HASH.test(String(manifest.artifactSha256 ?? '')) ||
      !Array.isArray(manifest.entries) || manifest.entries.length < 1 || manifest.entries.length > 128) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_INVALID');
  }
  const entries = manifest.entries.map(value => normalizeLicenseEvidenceEntry(root, value));
  const identities = new Set();
  for (const entry of entries) {
    const identity = `${entry.id}\0${entry.path}`;
    if (identities.has(identity)) throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_DUPLICATE');
    identities.add(identity);
  }
  return {
    schema: LICENSE_EVIDENCE_SCHEMA,
    componentId: manifest.componentId,
    version: manifest.version,
    artifactSha256: manifest.artifactSha256,
    sha256: manifestFile.sha256,
    entries
  };
}

export function inventoryNodePackages({
  root,
  componentId,
  version,
  artifact,
  limits,
  licenseEvidence,
  at = new Date().toISOString()
}) {
  if (!text(root, 2000) || !isAbsolute(root)) throw Error('NODE_RUNTIME_ROOT_INVALID');
  if (!text(componentId, 128) || !/^[a-z0-9][a-z0-9-]*$/.test(componentId)) {
    throw Error('NODE_RUNTIME_COMPONENT_ID_INVALID');
  }
  if (!text(version, 160) || !PACKAGE_VERSION.test(version)) {
    throw Error('NODE_RUNTIME_COMPONENT_VERSION_INVALID');
  }
  const boundArtifact = validateArtifact(artifact);
  const normalizedRoot = resolve(root);
  const tree = walkOrdinaryTree(normalizedRoot, normalizedLimits(limits));
  tree.root = normalizedRoot;
  const packageFiles = tree.files
    .filter(file => file.path === 'package.json' || file.path.endsWith('/package.json'))
    .map(file => ({
      ...file,
      absolute: resolve(normalizedRoot, ...file.path.split('/'))
    }));
  if (packageFiles.length < 1) throw Error('NODE_RUNTIME_PACKAGE_JSON_MISSING');
  const parsedPackages = packageFiles.map(file => ({
    file,
    value: parsePackageManifest(file, tree)
  }));
  if (!parsedPackages.some(entry => entry.file.path === 'package.json' && entry.value)) {
    throw Error('NODE_RUNTIME_ROOT_PACKAGE_IDENTITY_MISSING');
  }
  const directDependencies = parsedPackages.filter(entry => entry.value)
    .map(entry => entry.value)
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (licenseEvidence !== undefined) {
    if (!licenseEvidence || licenseEvidence.schema !== LICENSE_EVIDENCE_SCHEMA ||
        licenseEvidence.componentId !== componentId || licenseEvidence.version !== version ||
        licenseEvidence.artifactSha256 !== boundArtifact.sha256 ||
        !HASH.test(String(licenseEvidence.sha256 ?? '')) ||
        !Array.isArray(licenseEvidence.entries)) {
      throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_BINDING_MISMATCH');
    }
  }
  const usedEvidence = new Set();
  const dependencies = directDependencies.map(dependency => {
    if (dependency.license.status === 'PRESENT') return dependency;
    const candidates = (licenseEvidence?.entries ?? []).filter(entry =>
      entry.id === dependency.id && entry.path === dependency.path
    );
    if (candidates.length === 0) return dependency;
    if (candidates.length !== 1) throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_DUPLICATE');
    const evidence = candidates[0];
    if (evidence.manifestSha256 !== dependency.manifestSha256 ||
        evidence.version !== dependency.version ||
        (evidence.kind !== 'FIRST_PARTY' &&
          evidence.declaredLicense !== dependency.declaredLicense)) {
      throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_BINDING_MISMATCH');
    }
    usedEvidence.add(evidence);
    if (evidence.kind === 'FIRST_PARTY') {
      if (dependency.path !== '') {
        throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_BINDING_MISMATCH');
      }
      return {
        ...dependency,
        license: {
          status: 'FIRST_PARTY_DECLARED',
          files: [],
          declaration: evidence.firstParty,
          evidenceSha256: licenseEvidence.sha256
        }
      };
    }
    return {
      ...dependency,
      license: {
        status: 'EXTERNAL_PRESENT',
        files: [evidence.license, ...evidence.additionalLicenses].map(file => ({
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
          origin: 'REVIEWED_EXTERNAL'
        })),
        provenance: {
          spdx: evidence.license.spdx,
          tarball: evidence.tarball,
          source: evidence.source,
          sourceRevision: evidence.source.revision,
          sourceFilePath: evidence.source.filePath,
          additionalLicenseSources: evidence.additionalLicenses.map(file => ({
            path: file.path,
            sourceFilePath: file.sourceFilePath,
            bytes: file.bytes,
            sha256: file.sha256
          })),
          upstreamLocator: evidence.source.upstreamLocator,
          upstreamRevision: evidence.source.upstreamRevision,
          reviewNotes: evidence.reviewNotes,
          evidenceSha256: licenseEvidence.sha256
        }
      }
    };
  });
  if ((licenseEvidence?.entries?.length ?? 0) !== usedEvidence.size) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_UNUSED');
  }
  const missingThirdParty = dependencies.filter(dependency =>
    !['PRESENT', 'EXTERNAL_PRESENT', 'FIRST_PARTY_DECLARED'].includes(dependency.license.status)
  );
  const complete = dependencies.length > 0 && missingThirdParty.length === 0;
  return {
    schema: 'dream-maker.component-sbom.v1',
    at,
    status: complete ? 'COMPLETE' : 'INCOMPLETE_LICENSE_EVIDENCE',
    componentId,
    version,
    platform: 'win32',
    architecture: 'x64',
    artifactPath: boundArtifact.path,
    artifactSha256: boundArtifact.sha256,
    artifactBytes: boundArtifact.bytes,
    inventory: {
      method: 'PACKAGE_JSON_DIRECTORY_TREE',
      rootTreeSha256: tree.rootTreeSha256,
      fileCount: tree.fileCount,
      totalBytes: tree.totalBytes,
      packageCount: dependencies.length,
      packageFragmentCount: parsedPackages.filter(entry => !entry.value).length
    },
    dependencyCount: dependencies.length,
    dependencies,
    licenseEvidence: licenseEvidence ? {
      path: undefined,
      sha256: licenseEvidence.sha256,
      entryCount: licenseEvidence.entries.length
    } : null,
    completeness: {
      allPackageLicenseFilesPresent: dependencies.every(dependency =>
        dependency.license.status === 'PRESENT'
      ),
      allPackageLicenseEvidencePresent: complete,
      directLicenseFileCount: dependencies.filter(dependency =>
        dependency.license.status === 'PRESENT'
      ).length,
      reviewedExternalLicenseCount: dependencies.filter(dependency =>
        dependency.license.status === 'EXTERNAL_PRESENT'
      ).length,
      firstPartyDeclarationCount: dependencies.filter(dependency =>
        dependency.license.status === 'FIRST_PARTY_DECLARED'
      ).length,
      missingLicenseCount: missingThirdParty.length,
      declaration: 'DIRECT_LICENSE_FILES_OR_PINNED_REVIEWED_EXTERNAL_LICENSE_EVIDENCE_OR_EXPLICIT_FIRST_PARTY_DECLARATION'
    },
    machineReadableComplete: complete,
    redistributionReviewed: false,
    cleanMachineRunVerified: false,
    modelCalls: 0,
    networkRequests: 0
  };
}

export function buildNodeLicenseBundle({root, sbom, limits, licenseEvidence}) {
  if (!sbom || sbom.schema !== 'dream-maker.component-sbom.v1' ||
      sbom.status !== 'COMPLETE' || sbom.machineReadableComplete !== true ||
      !sbom.inventory || !HASH.test(String(sbom.inventory.rootTreeSha256 ?? '')) ||
      !Array.isArray(sbom.dependencies) || sbom.dependencies.length < 1) {
    throw Error('NODE_RUNTIME_LICENSE_BUNDLE_INCOMPLETE');
  }
  const limitsValue = normalizedLimits(limits);
  const current = inventoryNodePackages({
    root,
    componentId: sbom.componentId,
    version: sbom.version,
    artifact: {
      path: sbom.artifactPath ?? undefined,
      bytes: sbom.artifactBytes,
      sha256: sbom.artifactSha256
    },
    limits,
    licenseEvidence,
    at: sbom.at
  });
  if (current.inventory.rootTreeSha256 !== sbom.inventory.rootTreeSha256) {
    throw Error('NODE_RUNTIME_TREE_CHANGED');
  }
  if ((current.licenseEvidence?.sha256 ?? null) !== (sbom.licenseEvidence?.sha256 ?? null) ||
      current.machineReadableComplete !== true) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_BINDING_MISMATCH');
  }
  const chunks = [];
  let bytes = 0;
  let fileCount = 0;
  const normalizedRoot = resolve(root);
  for (const dependency of current.dependencies) {
    if (dependency.license.status === 'FIRST_PARTY_DECLARED') continue;
    if (!['PRESENT', 'EXTERNAL_PRESENT'].includes(dependency.license.status) ||
        dependency.license.files.length < 1) {
      throw Error('NODE_RUNTIME_LICENSE_BUNDLE_INCOMPLETE');
    }
    for (const file of dependency.license.files) {
      if (!text(file.path, 1000) ||
          (dependency.license.status === 'PRESENT' &&
            (file.path.includes('/') || file.path.includes('\\'))) ||
          !HASH.test(String(file.sha256 ?? ''))) {
        throw Error('NODE_RUNTIME_LICENSE_BUNDLE_INCOMPLETE');
      }
      let body;
      let sourceLabel;
      if (dependency.license.status === 'PRESENT') {
        const packageRoot = resolve(normalizedRoot, ...dependency.path.split('/').filter(Boolean));
        const observed = ordinaryFile(
          resolve(packageRoot, file.path),
          limitsValue.maxLicenseBytes,
          {capture: true}
        );
        if (observed.bytes !== file.bytes || observed.sha256 !== file.sha256) {
          throw Error('NODE_RUNTIME_TREE_CHANGED');
        }
        body = observed.body;
        sourceLabel = dependency.path ? `${dependency.path}/${file.path}` : file.path;
      } else {
        const evidenceEntry = licenseEvidence?.entries?.find(entry =>
          entry.id === dependency.id && entry.path === dependency.path &&
          entry.kind === 'THIRD_PARTY'
        );
        const evidenceFile = evidenceEntry
          ? [evidenceEntry.license, ...evidenceEntry.additionalLicenses]
            .find(candidate => candidate.path === file.path &&
              candidate.bytes === file.bytes && candidate.sha256 === file.sha256)
          : null;
        if (!evidenceFile || !evidenceFile.body ||
            sha256(evidenceFile.body) !== file.sha256 ||
            evidenceFile.body.length !== file.bytes) {
          throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_BINDING_MISMATCH');
        }
        body = evidenceFile.body;
        sourceLabel = `REVIEWED_EXTERNAL ${dependency.license.provenance.spdx} ${file.path}`;
      }
      const header = Buffer.from(
        `===== ${dependency.id} :: ${sourceLabel} =====\n`,
        'utf8'
      );
      const footer = Buffer.from('\n\n', 'utf8');
      bytes += header.length + body.length + footer.length;
      if (bytes > limitsValue.maxLicenseBundleBytes) {
        throw Error('NODE_RUNTIME_LICENSE_BUNDLE_LIMIT');
      }
      chunks.push(header, body, footer);
      fileCount += 1;
    }
  }
  const body = Buffer.concat(chunks, bytes);
  return {
    body,
    bytes,
    sha256: sha256(body),
    packageCount: current.dependencies.length,
    fileCount,
    rootTreeSha256: current.inventory.rootTreeSha256,
    licenseEvidenceSha256: current.licenseEvidence?.sha256 ?? null
  };
}

function requiredArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw Error(`NODE_RUNTIME_ARGUMENT_MISSING:${name}`);
  }
  return process.argv[index + 1];
}

function optionalArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  if (index + 1 >= process.argv.length) {
    throw Error(`NODE_RUNTIME_ARGUMENT_MISSING:${name}`);
  }
  return process.argv[index + 1];
}

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function run() {
  const suite = resolve(process.env.DREAMMAKER_SUITE_ROOT ?? 'F:\\DreamMakerSuite');
  const root = resolve(requiredArg('--root'));
  const artifactPath = resolve(requiredArg('--artifact'));
  const componentId = requiredArg('--component-id');
  const version = requiredArg('--version');
  const output = resolve(requiredArg('--output'));
  const evidencePathValue = optionalArg('--license-evidence');
  const evidenceSha256 = optionalArg('--license-evidence-sha256');
  if ((evidencePathValue === null) !== (evidenceSha256 === null)) {
    throw Error('NODE_RUNTIME_LICENSE_EVIDENCE_ARGUMENTS_INCOMPLETE');
  }
  const evidencePath = evidencePathValue === null ? null : resolve(evidencePathValue);
  if (!inside(suite, root) || !inside(suite, artifactPath) || !inside(suite, output)) {
    throw Error('NODE_RUNTIME_PATH_OUTSIDE_SUITE');
  }
  if (evidencePath !== null && !inside(suite, evidencePath)) {
    throw Error('NODE_RUNTIME_PATH_OUTSIDE_SUITE');
  }
  if (existsSync(output)) throw Error('NODE_RUNTIME_OUTPUT_EXISTS');
  const artifact = ordinaryFile(artifactPath, 2_147_483_648);
  const licenseEvidence = evidencePath === null ? undefined : loadNodeLicenseEvidence({
    root: dirname(evidencePath),
    manifestPath: basename(evidencePath),
    expectedSha256: evidenceSha256
  });
  const sbom = inventoryNodePackages({
    root,
    componentId,
    version,
    artifact: {path: artifactPath, bytes: artifact.bytes, sha256: artifact.sha256},
    licenseEvidence
  });
  const licenseBundle = sbom.machineReadableComplete
    ? buildNodeLicenseBundle({root, sbom, licenseEvidence})
    : null;
  mkdirSync(dirname(output), {recursive: true});
  mkdirSync(output, {recursive: false});
  const sbomBody = Buffer.from(JSON.stringify(sbom, null, 2) + '\n');
  writeFileSync(join(output, 'component-sbom.json'), sbomBody, {flag: 'wx'});
  writeFileSync(join(output, 'TREE_SHA256.txt'), `${sbom.inventory.rootTreeSha256}\n`, {flag: 'wx'});
  if (licenseBundle) {
    writeFileSync(join(output, 'THIRD_PARTY_LICENSES.txt'), licenseBundle.body, {flag: 'wx'});
  }
  const receipt = {
    schema: 'dream-maker.node-runtime-inventory.v1',
    at: new Date().toISOString(),
    artifact: {path: artifactPath, bytes: artifact.bytes, sha256: artifact.sha256},
    root,
    output,
    sbomSha256: sha256(sbomBody),
    rootTreeSha256: sbom.inventory.rootTreeSha256,
    licenseBundle: licenseBundle ? {
      path: join(output, 'THIRD_PARTY_LICENSES.txt'),
      bytes: licenseBundle.bytes,
      sha256: licenseBundle.sha256,
      packageCount: licenseBundle.packageCount,
      fileCount: licenseBundle.fileCount
    } : null,
    status: sbom.status,
    machineReadableComplete: sbom.machineReadableComplete,
    missingLicenses: sbom.dependencies
      .filter(dependency => !['PRESENT', 'EXTERNAL_PRESENT', 'FIRST_PARTY_DECLARED']
        .includes(dependency.license.status))
      .map(dependency => ({
        id: dependency.id,
        path: dependency.path,
        status: dependency.license.status
      })),
    licenseEvidence: licenseEvidence ? {
      path: evidencePath,
      sha256: licenseEvidence.sha256,
      entryCount: licenseEvidence.entries.length,
      firstPartyCount: licenseEvidence.entries.filter(entry => entry.kind === 'FIRST_PARTY').length,
      externalLicenseCount: licenseEvidence.entries.filter(entry => entry.kind === 'THIRD_PARTY').length
    } : null,
    modelCalls: 0,
    networkRequests: 0,
    redistributionReviewed: false
  };
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(receipt));
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
