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
import {collectDshSourceProof} from '../../scripts/revamp/collect-dsh-source-proof.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const gitBlobSha = value => createHash('sha1')
  .update(`blob ${Buffer.byteLength(value)}\0`)
  .update(value)
  .digest('hex');
const revision = '4878cdabd87d4041bdaff61d04c966883b9fd07a';
const treeSha = 'b'.repeat(40);
const packages = [
  {
    name: '@deepseek-ai/dsh',
    directory: 'apps/cli'
  },
  {
    name: '@deepseek-ai/dsh-sdk-client',
    directory: 'packages/sdk/client'
  }
];

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function response(url, value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({'content-length': String(Buffer.byteLength(body))}),
    async text() {
      return body;
    }
  };
}

function fixture(t) {
  const base = harness(t).dir;
  const evidenceRoot = join(base, 'evidence');
  const runtime = join(base, 'runtime');
  const outputDirectory = join(evidenceRoot, 'M92', 'source-proof');
  mkdirSync(evidenceRoot, {recursive: true});
  mkdirSync(runtime, {recursive: true});
  const dependencies = Object.fromEntries(
    packages.map(item => [item.name, '0.2.0-rc.1'])
  );
  writeJson(join(runtime, 'package.json'), {
    name: 'dream-maker-dsh-sdk-bundle',
    version: '0.2.0-rc.1',
    dependencies
  });
  const lockPackages = {
    '': {
      name: 'dream-maker-dsh-sdk-bundle',
      version: '0.2.0-rc.1',
      dependencies
    }
  };
  for (const [index, item] of packages.entries()) {
    const localDirectory = join(runtime, 'node_modules', ...item.name.split('/'));
    mkdirSync(localDirectory, {recursive: true});
    writeJson(join(localDirectory, 'package.json'), {
      name: item.name,
      version: '0.2.0-rc.1'
    });
    lockPackages[`node_modules/${item.name}`] = {
      version: '0.2.0-rc.1',
      resolved: `https://registry.npmjs.org/${item.name}/-/${item.name.split('/').at(-1)}-0.2.0-rc.1.tgz`,
      integrity: `sha512-${Buffer.from(`fixture-${index}`).toString('base64')}`
    };
  }
  writeJson(join(runtime, 'package-lock.json'), {
    name: 'dream-maker-dsh-sdk-bundle',
    version: '0.2.0-rc.1',
    lockfileVersion: 3,
    requires: true,
    packages: lockPackages
  });
  const rootTreeSha256 = 'd'.repeat(64);
  const receipt = {
    schema: 'dream-maker.node-runtime-inventory.v1',
    status: 'COMPLETE',
    machineReadableComplete: true,
    root: runtime,
    rootTreeSha256,
    artifact: {
      path: join(evidenceRoot, 'artifact.tar'),
      bytes: 1,
      sha256: 'e'.repeat(64)
    },
    licenseBundle: {
      path: join(evidenceRoot, 'licenses.txt'),
      bytes: 1,
      sha256: 'f'.repeat(64)
    },
    output: join(evidenceRoot, 'inventory'),
    sbomSha256: '1'.repeat(64),
    missingLicenses: [],
    redistributionReviewed: false,
    modelCalls: 0,
    networkRequests: 0
  };
  const receiptPath = join(evidenceRoot, 'receipt.json');
  writeJson(receiptPath, receipt);

  const treeEntries = [];
  const registryByUrl = new Map();
  const rawByUrl = new Map();
  for (const [index, item] of packages.entries()) {
    const manifestPath = `${item.directory}/package.json`;
    const manifestBody = JSON.stringify({
      name: item.name,
      version: '0.2.0-rc.1'
    }, null, 2) + '\n';
    treeEntries.push({
      path: manifestPath,
      type: 'blob',
      sha: gitBlobSha(manifestBody)
    });
    rawByUrl.set(
      `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${revision}/${manifestPath}`,
      manifestBody
    );
    const lock = lockPackages[`node_modules/${item.name}`];
    const registry = {
      name: item.name,
      version: '0.2.0-rc.1',
      repository: {
        type: 'git',
        url: 'git+https://github.com/deepseek-ai/deepseek-harness.git',
        directory: item.directory
      },
      dist: {
        integrity: lock.integrity,
        shasum: String(index).padStart(40, '0'),
        tarball: lock.resolved
      }
    };
    registryByUrl.set(
      `https://registry.npmjs.org/${item.name.replace('/', '%2F')}/0.2.0-rc.1`,
      registry
    );
  }
  const commitUrl =
    `https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/${revision}`;
  const treeUrl =
    `https://api.github.com/repos/deepseek-ai/deepseek-harness/git/trees/${treeSha}?recursive=1`;
  const fetchImpl = async url => {
    const textUrl = String(url);
    if (textUrl === commitUrl) {
      return response(textUrl, {
        sha: revision,
        commit: {
          message: 'release(dsh): 0.2.0-rc.1 (#5387)',
          tree: {sha: treeSha},
          verification: {verified: false, reason: 'unsigned'}
        }
      });
    }
    if (textUrl === treeUrl) {
      return response(textUrl, {
        sha: treeSha,
        truncated: false,
        tree: treeEntries
      });
    }
    if (registryByUrl.has(textUrl)) {
      return response(textUrl, registryByUrl.get(textUrl));
    }
    if (rawByUrl.has(textUrl)) {
      return response(textUrl, rawByUrl.get(textUrl));
    }
    throw new Error(`UNEXPECTED_URL:${textUrl}`);
  };
  return {
    base,
    evidenceRoot,
    runtime,
    receiptPath,
    receiptSha256: sha256(readFileSync(receiptPath)),
    outputDirectory,
    fetchImpl,
    commitUrl,
    treeUrl
  };
}

test('collector writes exact official receipt references and a verified source proof', async t => {
  const value = fixture(t);
  const report = await collectDshSourceProof({
    evidenceRoot: value.evidenceRoot,
    receiptPath: value.receiptPath,
    receiptSha256: value.receiptSha256,
    outputDirectory: value.outputDirectory,
    fetchImpl: value.fetchImpl,
    now: () => new Date('2026-11-07T00:00:00.000Z')
  });

  assert.equal(report.status, 'VERIFIED');
  assert.equal(report.source.revision, revision);
  assert.equal(report.packages.length, packages.length);
  assert.equal(report.networkRequests, 6);
  assert.equal(report.modelCalls, 0);
  assert.equal(report.credentialsRead, false);
  assert.equal(existsSync(join(value.outputDirectory, 'commit.json')), true);
  assert.equal(existsSync(join(value.outputDirectory, 'tree.json')), true);
  const proof = JSON.parse(
    readFileSync(join(value.outputDirectory, 'source-proof.json'), 'utf8')
  );
  assert.equal(proof.schema, 'dream-maker.node-runtime-source-proof.v1');
  assert.equal(proof.status, 'VERIFIED');
  assert.equal(proof.source.revision, revision);
  assert.equal(proof.commitReceipt.path, 'M92/source-proof/commit.json');
  for (const item of proof.packages) {
    assert.match(item.registry.sha256, /^[a-f0-9]{64}$/);
    assert.match(item.upstreamManifest.gitBlobSha, /^[a-f0-9]{40}$/);
  }
});

test('collector rejects a truncated tree or changed response origin before writing output', async t => {
  const truncated = fixture(t);
  const failFetch = async url => {
    if (String(url) === truncated.treeUrl) {
      return response(String(url), {
        sha: treeSha,
        truncated: true,
        tree: []
      });
    }
    return truncated.fetchImpl(url);
  };
  await assert.rejects(
    collectDshSourceProof({
      evidenceRoot: truncated.evidenceRoot,
      receiptPath: truncated.receiptPath,
      receiptSha256: truncated.receiptSha256,
      outputDirectory: truncated.outputDirectory,
      fetchImpl: failFetch
    }),
    {code: 'GITHUB_TREE_TRUNCATED'}
  );
  assert.equal(existsSync(truncated.outputDirectory), false);

  const redirected = fixture(t);
  const redirectedFetch = async url => {
    const result = await redirected.fetchImpl(url);
    return {...result, url: 'https://example.com/changed'};
  };
  await assert.rejects(
    collectDshSourceProof({
      evidenceRoot: redirected.evidenceRoot,
      receiptPath: redirected.receiptPath,
      receiptSha256: redirected.receiptSha256,
      outputDirectory: redirected.outputDirectory,
      fetchImpl: redirectedFetch
    }),
    {code: 'SOURCE_RESPONSE_ORIGIN_CHANGED'}
  );
  assert.equal(existsSync(redirected.outputDirectory), false);
});
