// Tests for the artifact verifier. These are the checks a recipient would run, so they have to fail loudly:
// a wrong archive must not verify, and a corrupted payload must not sneak through a matching manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zip } from '../dist/server/workspace.js';
import { readStoredZip, verifyArtifactArchive } from '../dist/server/artifact-verify.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const run = { id: 'run_test', specHash: 'a'.repeat(64), treeHash: 'b'.repeat(64) };
const manifestFor = (files, extra = {}) => JSON.stringify({
    schema: 'dream-maker.delivery.v1',
    runId: run.id,
    specHash: run.specHash,
    treeHash: run.treeHash,
    files: files.map(file => ({ path: file.path, bytes: file.data.length, sha256: sha(file.data) })),
    documents: (extra.documents ?? []).map(doc => ({ path: doc.path, bytes: doc.data.length, sha256: sha(doc.data) })),
    ...(extra.manifestFields ?? {})
});
const archive = (files, extra = {}) => zip([
    ...files,
    { path: 'DREAM_MAKER_MANIFEST.json', data: Buffer.from(manifestFor(files, extra)) },
    ...(extra.documents ?? [])
]);
const files = () => [{ path: 'main.mjs', data: Buffer.from('console.log(1)\n') }, { path: 'sample.json', data: Buffer.from('{"items":{}}') }];

test('a well-formed archive verifies and its entries read back byte for byte', () => {
    const bytes = archive(files());
    const entries = readStoredZip(bytes);
    assert.deepEqual(entries.map(entry => entry.path).sort(), ['DREAM_MAKER_MANIFEST.json', 'main.mjs', 'sample.json']);
    assert.ok(entries.every(entry => entry.crcOk));
    assert.equal(entries.find(entry => entry.path === 'main.mjs').data.toString(), 'console.log(1)\n');
    const result = verifyArtifactArchive(bytes, run);
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter(item => !item.ok)));
});

test('documents travel attested, so a stray spec copy cannot ride along unnoticed', () => {
    const attested = archive(files(), { documents: [{ path: 'DREAM_MAKER_SPEC.md', data: Buffer.from('# spec\n') }] });
    assert.equal(verifyArtifactArchive(attested, run).ok, true);
    const unattested = zip([...files(), { path: 'DREAM_MAKER_MANIFEST.json', data: Buffer.from(manifestFor(files())) }, { path: 'DREAM_MAKER_SPEC.md', data: Buffer.from('# spec\n') }]);
    const result = verifyArtifactArchive(unattested, run);
    assert.equal(result.ok, false);
    assert.match(result.checks.find(item => !item.ok).detail, /DREAM_MAKER_SPEC\.md/);
});

test('a corrupted payload fails the CRC check rather than verifying on the manifest alone', () => {
    const bytes = archive(files());
    const target = bytes.indexOf(Buffer.from('console.log(1)'));
    bytes[target] = 0x43; // 'c' instead of 'C'
    const result = verifyArtifactArchive(bytes, run);
    assert.equal(result.ok, false);
    assert.equal(result.checks.find(item => /CRC/.test(item.label)).ok, false);
});

test('a manifest that lies about bytes or about its run is refused', () => {
    const lying = zip([...files(), { path: 'DREAM_MAKER_MANIFEST.json', data: Buffer.from(JSON.stringify({ ...JSON.parse(manifestFor(files())), files: [{ path: 'main.mjs', bytes: 3, sha256: 'c'.repeat(64) }, { path: 'sample.json', bytes: 12, sha256: sha(Buffer.from('{"items":{}}')) }] })) }]);
    const wrongBytes = verifyArtifactArchive(lying, run);
    assert.equal(wrongBytes.ok, false);
    assert.equal(wrongBytes.checks.find(item => /manifest file/.test(item.label)).ok, false);
    const foreignRun = verifyArtifactArchive(archive(files()), { ...run, id: 'run_other' });
    assert.equal(foreignRun.ok, false);
    assert.equal(foreignRun.checks.find(item => /binds this run/.test(item.label)).ok, false);
});

test('an archive the exporter could not have written is refused, not guessed at', () => {
    assert.throws(() => readStoredZip(Buffer.from('not a zip at all, definitely not')), /ZIP_EOCD_MISSING/);
    const bytes = archive(files());
    // flip the compression method of the first central-directory entry to 8 (deflate)
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(8, central + 10);
    assert.throws(() => readStoredZip(bytes), /ZIP_COMPRESSED_ENTRY_UNSUPPORTED/);
    const missing = zip([...files()]);
    const result = verifyArtifactArchive(missing, run);
    assert.equal(result.ok, false);
    assert.equal(result.checks.find(item => /carries DREAM_MAKER_MANIFEST/.test(item.label)).ok, false);
});
