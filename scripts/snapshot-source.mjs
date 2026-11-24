// Current source receipt alongside the immutable release identity, never a replacement manifest.
import { readdirSync, lstatSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, fingerprint } from './lib/local-inventory.mjs';
import { within } from '../dist/server/security.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const identity = readJson(resolve(root, 'SOURCE_IDENTITY.json'));
const manifest = readJson(resolve(root, 'FILE_MANIFEST.json'));
if (identity.schema !== 'dream-maker.source-identity.v1' || manifest.schema !== 'dream-maker.file-manifest.v1') throw Error('BASELINE_SCHEMA_INVALID');
const paths = new Set(identity.sourceFiles.map(item => item.path));
function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
        const candidate = resolve(path, entry.name);
        if (lstatSync(candidate).isSymbolicLink()) throw Error('SOURCE_LINK_DENIED');
        if (entry.isDirectory()) walk(candidate);
        else paths.add(relative(root, candidate).split(sep).join('/'));
    }
}
for (const directory of ['src', 'tests', 'scripts', 'adapters', 'prompts', 'skills', 'examples', 'migrations', 'eval']) walk(resolve(root, directory));
// This public execution policy affects the sandbox; local auth/config files remain excluded.
paths.add('config/codex-agent-readonly.toml');
paths.add('config/codex-agent-windows-readonly.toml');
const records = [...paths].sort().map(path => {
    const absolute = within(root, path), item = fingerprint([absolute])[0];
    if (item.status !== 'HASHED') throw Error('SOURCE_BYTES_UNVERIFIED:' + path);
    return { path, sha256: item.sha256 };
});
const changed = manifest.files.filter(item => {
    const current = fingerprint([within(root, item.path)])[0];
    return current.status !== 'HASHED' || current.sha256 !== item.sha256 || current.bytes !== item.bytes;
}).map(item => item.path);
const originalEvidenceChanged = changed.filter(path => path.startsWith('evidence/'));
const report = {
    schema: 'dream-maker.continuation-source.v1', recordedAt: new Date().toISOString(),
    originalReleaseSourceHash: identity.sourceHash,
    originalIdentityFileSha256: createHash('sha256').update(readFileSync(resolve(root, 'SOURCE_IDENTITY.json'))).digest('hex'),
    originalManifestFileSha256: createHash('sha256').update(readFileSync(resolve(root, 'FILE_MANIFEST.json'))).digest('hex'),
    sourceHash: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
    sourceHashMethod: 'SHA-256 of compact UTF-8 JSON of ordered path/sha256 records; ASCII path ordering',
    sourceFileCount: records.length, sourceFiles: records,
    changedListedReleaseFiles: changed, originalEvidenceChanged,
    originalEvidencePreserved: originalEvidenceChanged.length === 0,
    liveAcceptance: 'NOT_RUN'
};
const output = resolve(root, process.argv[2] || `evidence/local/source-${Date.now()}.json`);
within(root, relative(root, output).split(sep).join('/'));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ sourceHash: report.sourceHash, sourceFileCount: report.sourceFileCount, originalEvidencePreserved: report.originalEvidencePreserved, output }));
if (!report.originalEvidencePreserved) process.exitCode = 1;
