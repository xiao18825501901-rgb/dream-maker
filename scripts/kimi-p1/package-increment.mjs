import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
// Minimal ZIP writer is overkill here: reuse the project's own workspace zip helper instead.
import { zip } from '../../dist/server/workspace.js';

const root = process.argv[2];
const base = process.argv[3];
const outDir = process.argv[4];
mkdirSync(outDir, { recursive: true });

// Allowlist: only the increment between the baseline commit and HEAD, restricted to source,
// tests, built output and the kimi-p1 evidence/documentation tree.
const changed = execFileSync('git', ['-C', root, 'diff', '--name-only', base + '..HEAD'], { encoding: 'utf8' })
  .trim().split(/\r?\n/).filter(Boolean);
const allowed = rel => /^(src\/|tests\/|dist\/|scripts\/|docs\/kimi-p1\/|package\.json$|tsconfig[^/]*\.json$)/.test(rel);
const denied = rel => /(^|\/)(\.env|\.runtime|node_modules|config\/local(\.|$))|(\.sqlite$)|(credential|secret|token\.json)/i.test(rel);
const files = changed.filter(rel => allowed(rel) && !denied(rel)).sort();

// Secret sweep over the actual bytes we are about to ship.
const suspicious = /(sk-[A-Za-z0-9]{16,})|(Bearer\s+[A-Za-z0-9._-]{20,})|(-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
// A look-alike is only tolerated inside tests/docs AND when the line also carries an explicit
// synthetic marker. Anything else fails the build of this packet.
const syntheticMarker = /(OFFLINE|SYNTHETIC|FAKE|NOT_REAL|NOT-A-REAL|EXAMPLE|REDACTED|dummy)/i;
const entries = [];
const offenders = [];
const lookalikes = [];
for (const rel of files) {
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;
  const buf = readFileSync(abs);
  entries.push({ path: rel, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
  if (/\.(ts|mjs|js|json|md|txt|toml)$/.test(rel)) {
    const text = buf.toString('utf8');
    if (suspicious.test(text)) {
      const inTests = /^(tests|docs)\//.test(rel);
      const lines = text.split(/\r?\n/).filter(l => suspicious.test(l));
      const unjustified = lines.filter(l => !syntheticMarker.test(l));
      if (!inTests || unjustified.length) offenders.push(rel + (unjustified.length ? '#unjustified' : ''));
      else lookalikes.push({ path: rel, matches: lines.length, note: 'synthetic fixture literals with an explicit synthetic marker' });
    }
  }
}
if (offenders.length) { console.error('SECRET_PATTERN_FOUND:' + offenders.join(',')); process.exit(2); }

const manifest = {
  schema: 'dream-maker.kimi-p1.increment.v1',
  generatedAt: new Date().toISOString(),
  baseCommit: base,
  headCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  baseBranch: 'continuation/windows-integration',
  changeBranch: 'integration/kimi-p1-20261017',
  allowlist: ['src/', 'tests/', 'dist/', 'scripts/', 'docs/kimi-p1/', 'package.json', 'tsconfig*.json'],
  denylistNote: 'no credentials, no config/local.json, no .runtime state, no sqlite, no logs',
  secretSweep: { pattern: 'sk-*, Bearer 20+, PEM private key', syntheticLookalikes: lookalikes },
  fileCount: entries.length,
  totalBytes: entries.reduce((a, e) => a + e.bytes, 0),
  entries
};

/**
 * Read back the archive we just wrote and re-hash every entry against the manifest.
 * The zip writer stores entries with deflate; this parses the local headers and inflates in memory
 * so the check needs no external tool and cannot silently skip a file.
 */
function verifyArchive(archive, manifestEntries) {
    const found = new Map();
    let offset = 0;
    while (offset + 30 <= archive.length) {
        if (archive.readUInt32LE(offset) !== 0x04034b50) break;
        const method = archive.readUInt16LE(offset + 8);
        const compressed = archive.readUInt32LE(offset + 18);
        const nameLen = archive.readUInt16LE(offset + 26);
        const extraLen = archive.readUInt16LE(offset + 28);
        const name = archive.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
        const dataStart = offset + 30 + nameLen + extraLen;
        const raw = archive.subarray(dataStart, dataStart + compressed);
        const bytes = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
        found.set(name, createHash('sha256').update(bytes).digest('hex'));
        offset = dataStart + compressed;
    }
    const problems = [];
    for (const entry of manifestEntries) {
        if (!found.has(entry.path)) problems.push('MISSING_IN_ARCHIVE:' + entry.path);
        else if (found.get(entry.path) !== entry.sha256) problems.push('HASH_MISMATCH:' + entry.path);
    }
    // The archive also carries the manifest itself, so the expected count is entries + 1.
    const expected = manifestEntries.length + 1;
    if (!found.has('KIMI_P1_INCREMENT_MANIFEST.json')) problems.push('MISSING_IN_ARCHIVE:KIMI_P1_INCREMENT_MANIFEST.json');
    if (found.size !== expected) problems.push('ENTRY_COUNT:' + found.size + '!=' + expected);
    return { checked: manifestEntries.length, archiveEntries: found.size, problems };
}

const manifestPath = join(outDir, 'KIMI_P1_INCREMENT_MANIFEST.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const archiveName = 'kimi-p1-increment-' + manifest.headCommit.slice(0, 7) + '.zip';
const archive = zip([
  ...entries.map(e => ({ path: e.path, data: readFileSync(join(root, e.path)) })),
  { path: 'KIMI_P1_INCREMENT_MANIFEST.json', data: readFileSync(manifestPath) }
]);
writeFileSync(join(outDir, archiveName), archive);
const selfCheck = verifyArchive(archive, entries);
if (selfCheck.problems.length) {
    console.error('SELF_CHECK_FAILED:' + JSON.stringify(selfCheck.problems.slice(0, 5)));
    process.exit(3);
}
console.log(JSON.stringify({ archive: join(outDir, archiveName), archiveBytes: archive.length, archiveSha256: createHash('sha256').update(archive).digest('hex'), fileCount: entries.length, totalBytes: manifest.totalBytes, selfCheck }, null, 1));