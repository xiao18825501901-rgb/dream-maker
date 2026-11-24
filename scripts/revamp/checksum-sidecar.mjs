import {basename} from 'node:path';
import {writeFileSync} from 'node:fs';

const SHA256 = /^[a-f0-9]{64}$/;

export function checksumSidecarPath(artifact) {
  return `${artifact}.sha256`;
}

export function writeChecksumSidecar(artifact, sha256) {
  if (typeof artifact !== 'string' || artifact.length === 0) {
    throw Error('CHECKSUM_SIDECAR_ARTIFACT_INVALID');
  }
  if (!SHA256.test(String(sha256))) {
    throw Error('CHECKSUM_SIDECAR_DIGEST_INVALID');
  }
  const sidecar = checksumSidecarPath(artifact);
  try {
    writeFileSync(sidecar, `${sha256}  ${basename(artifact)}\n`, {flag: 'wx'});
  } catch (error) {
    if (error?.code === 'EEXIST') throw Error('CHECKSUM_SIDECAR_EXISTS');
    throw error;
  }
  return sidecar;
}
