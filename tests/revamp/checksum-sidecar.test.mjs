import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  checksumSidecarPath,
  writeChecksumSidecar,
} from '../../scripts/revamp/checksum-sidecar.mjs';

test('checksum sidecar records the artifact basename and refuses to overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'dm-sidecar-'));
  try {
    const artifact = join(root, 'DreamMaker-Suite.zip');
    const digest = 'a'.repeat(64);
    const sidecar = checksumSidecarPath(artifact);
    assert.equal(
      writeChecksumSidecar(artifact, digest),
      sidecar,
    );
    assert.equal(
      readFileSync(sidecar, 'utf8'),
      `${digest}  DreamMaker-Suite.zip\n`,
    );

    writeFileSync(artifact, 'OFFLINE_ARCHIVE');
    assert.throws(
      () => writeChecksumSidecar(artifact, 'b'.repeat(64)),
      /CHECKSUM_SIDECAR_EXISTS/,
    );
    assert.equal(
      readFileSync(sidecar, 'utf8'),
      `${digest}  DreamMaker-Suite.zip\n`,
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('checksum sidecar rejects malformed identity inputs', () => {
  assert.throws(
    () => writeChecksumSidecar('', 'a'.repeat(64)),
    /CHECKSUM_SIDECAR_ARTIFACT_INVALID/,
  );
  assert.throws(
    () => writeChecksumSidecar('archive.zip', 'A'.repeat(64)),
    /CHECKSUM_SIDECAR_DIGEST_INVALID/,
  );
});
