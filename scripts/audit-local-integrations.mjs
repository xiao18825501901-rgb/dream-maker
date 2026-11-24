// Explicit, operator-selected file lists only. Contents, credentials and model calls are excluded.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fingerprint, compare, readJson } from './lib/local-inventory.mjs';
import { childEnv } from '../dist/server/security.js';

const [scopePath, outputPath, previousPath] = process.argv.slice(2);
if (!scopePath || !outputPath) throw Error('Usage: node scripts/audit-local-integrations.mjs <scope.local.json> <new-report.json> [before.json]');
const scope = readJson(scopePath);
if (scope.schema !== 'dream-maker.inventory-scope.v1' || !Array.isArray(scope.files) || scope.files.some(p => typeof p !== 'string' || !isAbsolute(p))) throw Error('EXPLICIT_ABSOLUTE_FILES_REQUIRED');
const files = fingerprint(scope.files);
const repositories = (scope.repositories ?? []).map(path => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw Error('EXPLICIT_ABSOLUTE_REPOSITORY_REQUIRED');
    const command = args => {
        const result = spawnSync('git', ['-C', path, ...args], { env: childEnv({ GIT_OPTIONAL_LOCKS: '0' }), encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, maxBuffer: 2000000 });
        return { exitCode: result.status, output: result.status === 0 ? result.stdout.trim() : null, error: result.error?.code ?? (result.status ? 'GIT_UNAVAILABLE_FOR_ROOT' : null) };
    };
    return { path, head: command(['rev-parse', 'HEAD']), status: command(['status', '--porcelain=v1', '--untracked-files=no']) };
});
const versions = (scope.packages ?? []).map(path => {
    if (!files.some(f => f.path === resolve(path) && f.status === 'HASHED')) return { path, status: 'NOT_VERIFIED' };
    const pkg = readJson(path);
    return { path, name: pkg.name ?? null, version: pkg.version ?? null };
});
const preservation = previousPath ? compare(readJson(previousPath).files, files) : null;
const report = { schema: 'dream-maker.local-inventory.v1', recordedAt: new Date().toISOString(), evidenceClass: 'READ_ONLY_LOCAL_IDENTITY', platform: process.platform, node: process.version, cloudCalls: 0, integrations: scope.integrations ?? [], files, repositories, versions, preservation, liveAcceptance: 'NOT_RUN' };
mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: resolve(outputPath), hashed: files.filter(f => f.status === 'HASHED').length, missingOrDenied: files.filter(f => f.status !== 'HASHED').length, preservation }));
if (preservation && !preservation.unchanged) process.exitCode = 1;
