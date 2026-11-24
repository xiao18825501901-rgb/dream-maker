import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {harness} from '../helpers.mjs';
import {
  buildReleaseEvidenceIndex
} from '../../scripts/revamp/build-release-evidence-index.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const writeJson = (path, value) => writeFileSync(
  path,
  `${JSON.stringify(value, null, 2)}\n`
);

function fragment(componentId, overrides = {}) {
  return {
    schema: 'dream-maker.release-component-fragment.v1',
    at: '2026-11-07T00:00:00.000Z',
    status: 'PARTIAL_COMPONENT_EVIDENCE',
    componentId,
    component: {
      id: componentId,
      version: '1.0.0',
      source: {
        kind: 'GIT_COMMIT',
        locator: `https://example.invalid/${componentId}`,
        revision: 'a'.repeat(40)
      },
      artifact: {
        path: 'artifact.bin',
        bytes: 1,
        sha256: 'b'.repeat(64)
      },
      license: {
        path: 'LICENSE.txt',
        sha256: 'c'.repeat(64)
      },
      sbom: {
        path: 'sbom.json',
        sha256: 'd'.repeat(64)
      }
    },
    componentGate: {
      scope: 'COMPONENT_EVIDENCE_FRAGMENT',
      completeDistribution: false,
      releaseReady: false
    },
    sourceIdentityVerified: true,
    sourceCommitSigned: false,
    releaseReady: false,
    blockers: [
      'CLEAN_WINDOWS_REFERENCE_INVALID',
      'REDISTRIBUTION_NOT_REVIEWED'
    ],
    scope: 'SINGLE_COMPONENT_EVIDENCE_NOT_FULL_DISTRIBUTION',
    ...overrides
  };
}

function fixture(t) {
  const root = resolve(harness(t).dir, 'release-evidence');
  mkdirSync(root, {recursive: true});
  return root;
}

function pin(root, name, value) {
  const path = join(root, name);
  writeJson(path, value);
  return {
    path: name,
    sha256: sha256(readFileSync(path))
  };
}

test('a partial evidence index reports component coverage without claiming a release', t => {
  const root = fixture(t);
  const output = join(root, 'index.json');
  const report = buildReleaseEvidenceIndex({
    root,
    fragments: [
      pin(root, 'codex.json', fragment('codex-runtime')),
      pin(root, 'dsh.json', fragment('dsh-runtime'))
    ],
    output,
    now: () => new Date('2026-11-07T00:00:00.000Z')
  });

  assert.equal(report.status, 'BLOCKED_INCOMPLETE_COMPONENT_COVERAGE');
  assert.equal(report.completeDistribution, false);
  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.components.map(component => component.id), [
    'codex-runtime',
    'dsh-runtime'
  ]);
  assert.deepEqual(report.missingRequiredComponents, [
    'dm-controller',
    'dreamflow-core',
    'planner1-cloud-runtime',
    'verified-base-toolchain'
  ]);
  assert.ok(existsSync(output));
});

test('duplicate components and distribution-level claims are rejected', t => {
  const root = fixture(t);
  const first = pin(root, 'first.json', fragment('codex-runtime'));
  const second = pin(root, 'second.json', fragment('codex-runtime'));
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [first, second],
      output: join(root, 'duplicate.json')
    }),
    error => error.code === 'DUPLICATE_COMPONENT'
  );

  const claimed = pin(root, 'claimed.json', fragment('codex-runtime', {
    releaseReady: true
  }));
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [claimed],
      output: join(root, 'claimed-index.json')
    }),
    error => error.code === 'DISTRIBUTION_CLAIM_IN_FRAGMENT'
  );
  assert.equal(existsSync(join(root, 'duplicate.json')), false);
  assert.equal(existsSync(join(root, 'claimed-index.json')), false);
});

test('a legacy partial fragment without source identity is indexed as unverified', t => {
  const root = fixture(t);
  const legacy = fragment('codex-runtime');
  delete legacy.sourceIdentityVerified;
  delete legacy.sourceCommitSigned;
  const pinned = pin(root, 'legacy.json', legacy);
  const report = buildReleaseEvidenceIndex({
    root,
    fragments: [pinned],
    output: join(root, 'legacy-index.json')
  });
  assert.equal(report.components[0].sourceIdentityVerified, false);
  assert.deepEqual(report.sourceIdentityUnverifiedComponents, ['codex-runtime']);
});

test('source and binary provenance are reported separately without upgrading a binary pin', t => {
  const root = fixture(t);
  const localSource = fragment('dm-controller', {
    sourceEvidence: 'M94_LOCAL_SOURCE_TREE_BOUND_TO_SOURCE_STATE',
    component: {
      ...fragment('dm-controller').component,
      source: {
        kind: 'LOCAL_PACKAGE',
        locator: 'F:\\DreamMakerSuite\\worktrees\\kimi-p1-v1',
        revision: 'source-state-sha'
      }
    }
  });
  const binaryOnly = fragment('verified-base-toolchain', {
    sourceEvidence: 'M82_RUNTIME_HASH_PIN_ONLY',
    sourceIdentityVerified: false,
    component: {
      ...fragment('verified-base-toolchain').component,
      source: {
        kind: 'LOCAL_PACKAGE',
        locator: 'F:\\DreamMakerSuite\\runtime\\node',
        revision: '24.22.1'
      }
    }
  });
  const report = buildReleaseEvidenceIndex({
    root,
    fragments: [
      pin(root, 'local-source.json', localSource),
      pin(root, 'binary-only.json', binaryOnly)
    ],
    output: join(root, 'provenance-index.json')
  });
  const local = report.components.find(component => component.id === 'dm-controller');
  const binary = report.components.find(component =>
    component.id === 'verified-base-toolchain'
  );
  assert.equal(local.sourceProvenanceClass, 'LOCAL_SOURCE_TREE');
  assert.equal(local.sourceIdentityApplicable, true);
  assert.equal(local.sourceIdentityVerified, true);
  assert.equal(binary.sourceProvenanceClass, 'PINNED_BINARY_ARTIFACT');
  assert.equal(binary.sourceIdentityApplicable, false);
  assert.equal(binary.sourceIdentityVerified, false);
  assert.deepEqual(report.sourceIdentityVerifiedComponents, ['dm-controller']);
  assert.deepEqual(report.sourceIdentityUnverifiedComponents, []);
  assert.deepEqual(report.sourceIdentityNotApplicableComponents, [
    'verified-base-toolchain'
  ]);
  assert.equal(report.releaseReady, false);
  assert.equal(report.completeDistribution, false);
});

test('a binary pin cannot claim verified source identity', t => {
  const root = fixture(t);
  const forged = fragment('verified-base-toolchain', {
    sourceEvidence: 'M82_RUNTIME_HASH_PIN_ONLY',
    sourceIdentityVerified: true,
    component: {
      ...fragment('verified-base-toolchain').component,
      source: {
        kind: 'LOCAL_PACKAGE',
        locator: 'F:\\DreamMakerSuite\\runtime\\node',
        revision: '24.22.1'
      }
    }
  });
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [pin(root, 'forged-binary.json', forged)],
      output: join(root, 'forged-binary-index.json')
    }),
    error => error.code === 'SOURCE_IDENTITY_CLASS_INVALID'
  );
  assert.equal(existsSync(join(root, 'forged-binary-index.json')), false);
});

test('fragment digest drift, invalid schema and component mismatch fail closed', t => {
  const root = fixture(t);
  const pinned = pin(root, 'fragment.json', fragment('codex-runtime'));
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [{...pinned, sha256: 'f'.repeat(64)}],
      output: join(root, 'digest.json')
    }),
    error => error.code === 'FRAGMENT_DIGEST_MISMATCH'
  );

  const wrongSchema = pin(root, 'wrong-schema.json', fragment('codex-runtime', {
    schema: 'untrusted.v1'
  }));
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [wrongSchema],
      output: join(root, 'schema.json')
    }),
    error => error.code === 'RELEASE_FRAGMENT_SCHEMA_INVALID'
  );

  const mismatch = pin(root, 'mismatch.json', fragment('codex-runtime', {
    component: {
      ...fragment('codex-runtime').component,
      id: 'dsh-runtime'
    }
  }));
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [mismatch],
      output: join(root, 'mismatch-index.json')
    }),
    error => error.code === 'RELEASE_FRAGMENT_IDENTITY_INVALID'
  );

  const missingArtifact = fragment('codex-runtime');
  missingArtifact.component.artifact.sha256 = 'not-a-digest';
  const invalidArtifact = pin(root, 'invalid-artifact.json', missingArtifact);
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [invalidArtifact],
      output: join(root, 'invalid-artifact-index.json')
    }),
    error => error.code === 'RELEASE_FRAGMENT_ARTIFACT_INVALID'
  );
});

test('paths outside the evidence root and linked fragment files are rejected', t => {
  const root = fixture(t);
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [{
        path: '../outside.json',
        sha256: 'a'.repeat(64)
      }],
      output: join(root, 'outside-index.json')
    }),
    error => error.code === 'FRAGMENT_PATH_DENIED'
  );

  const outside = join(resolve(root, '..'), 'outside.json');
  writeJson(outside, fragment('codex-runtime'));
  try {
    symlinkSync(outside, join(root, 'linked.json'));
  } catch (error) {
    if (error?.code === 'EISDIR' || error?.code === 'EPERM') {
      t.diagnostic('Symbolic-link creation is unavailable on this filesystem');
      return;
    }
    throw error;
  }
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [{
        path: 'linked.json',
        sha256: sha256(readFileSync(outside))
      }],
      output: join(root, 'linked-index.json')
    }),
    error => error.code === 'FRAGMENT_LINK_DENIED'
  );
});

test('an existing output is never overwritten', t => {
  const root = fixture(t);
  const output = join(root, 'index.json');
  writeFileSync(output, 'preserve\n');
  const pinned = pin(root, 'fragment.json', fragment('codex-runtime'));
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [pinned],
      output
    }),
    error => error.code === 'OUTPUT_EXISTS'
  );
  assert.equal(readFileSync(output, 'utf8'), 'preserve\n');
});

test('an output below a non-directory path is rejected without writing elsewhere', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'blocked'), 'file\n');
  const pinned = pin(root, 'fragment.json', fragment('codex-runtime'));
  assert.throws(
    () => buildReleaseEvidenceIndex({
      root,
      fragments: [pinned],
      output: join(root, 'blocked', 'index.json')
    }),
    error => error.code === 'OUTPUT_PATH_DENIED'
  );
});
