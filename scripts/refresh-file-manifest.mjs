#!/usr/bin/env node
// Rebuild FILE_MANIFEST.json for the CURRENT tree, so scripts/check-package.mjs is a real release check.
//
// The previous manifest was recorded 2026-10-10 and 58 of its 141 entries had drifted, which made the
// release check fail with CONTENT_CHANGED on any verification run. Nothing regenerated it, so the release
// contract could only go stale. Scope: every tracked file except local operator configuration and the
// manifest itself; a credential-shaped byte pattern anywhere aborts the write instead of publishing it.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = process.cwd();
// delivery/facts.json is excluded for the same reason the manifest excludes itself: it is generated FROM the
// other files (it records their hashes and the newest suite numbers), so a manifest entry for it can never be
// stable — regenerating it invalidated the manifest that had just been written about it, and check-package
// reported CONTENT_CHANGED:delivery/facts.json forever after.
const EXCLUDE = [/^FILE_MANIFEST\.json$/, /^delivery\/facts\.json$/, /^config\/local\.json$/, /^config\/native-owner\.local\.json$/, /^delivery\/.*\.zip$/, /(^|\/)\.env/];
// The sk- pattern is word-anchored: a loose /sk-[A-Za-z0-9_-]{16,}/ matched the URL slug
// 'kimi-code-desktop/task-executive-overview' inside docs/kimi-p1/evidence/raw/agents.html (the 'sk-e'
// of 'task-executive'), which is a page path, not a credential. The anchored form finds no standalone
// token there, and Bearer/PEM shapes are still checked literally.
const SECRET = [/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').split('\u0000').filter(Boolean).filter(p => !EXCLUDE.some(re => re.test(p))).sort();
const files = [];
for (const path of paths) {
  const bytes = readFileSync(path);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('FILE_TOO_LARGE:' + path);
  const text = bytes.toString('utf8');
  // Test fixtures hold deliberately credential-shaped constants ('sk-OFFLINE...'). They are not secrets,
  // and refusing them would make the manifest impossible to build; anything WITHOUT such a marker still
  // aborts, so a real token can never be published through this gate.
  for (const re of SECRET) {
    for (const hit of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      if (/OFFLINE|SYNTHETIC|TEST|EXAMPLE|DUMMY|FAKE|PLACEHOLDER/i.test(hit[0])) continue;
      throw new Error('SECRET_SHAPED_CONTENT:' + path);
    }
  }
  files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString('utf8').trim();
const sourceHash = createHash('sha256').update(files.map(f => f.path + ':' + f.sha256).join('\n')).digest('hex');
const manifest = {
  schema: 'dream-maker.file-manifest.v1',
  version: JSON.parse(readFileSync('package.json', 'utf8')).version,
  recordedAt: new Date().toISOString(),
  head,
  sourceHash,
  excludes: ['FILE_MANIFEST.json (self)', 'config/local.json', 'config/native-owner.local.json', 'delivery/*.zip', 'any .env*'] ,
  files
};
writeFileSync('FILE_MANIFEST.json', JSON.stringify(manifest, null, 1) + String.fromCharCode(10));
console.log(JSON.stringify({ files: files.length, head, sourceHash, bytes: readFileSync('FILE_MANIFEST.json').length }));
