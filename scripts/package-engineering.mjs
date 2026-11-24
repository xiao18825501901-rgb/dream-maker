#!/usr/bin/env node
// Build the ENGINEERING delivery package: the tracked tree at HEAD plus FILE_MANIFEST.json, as one ZIP
// that can be extracted elsewhere and verified without this checkout.
//
// Why: the product artifact ZIP covers one delivered project, and FILE_MANIFEST.json only proves the files
// in place. The old delivery/ archive is from 2026-10-20 and nobody could re-verify it. The manifest and
// the package now come from the same tracked list, so the extracted copy verifies itself with
// scripts/check-package.mjs and the recorded sourceHash.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zip } from '../dist/server/workspace.js';
const sha = b => createHash('sha256').update(b).digest('hex');
const EXCLUDE = [/^FILE_MANIFEST\.json$/, /^config\/local\.json$/, /^config\/native-owner\.local\.json$/, /^delivery\/.*\.zip$/, /(^|\/)\.env/];
const paths = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').split('\u0000').filter(Boolean).filter(p => !EXCLUDE.some(re => re.test(p))).sort();
const entries = paths.map(path => ({ path, data: readFileSync(path) }));
// The manifest itself has to travel: it is what the extracted copy verifies against.
entries.push({ path: 'FILE_MANIFEST.json', data: readFileSync('FILE_MANIFEST.json') });
entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const archive = zip(entries);
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString('utf8').trim();
mkdirSync('.runtime/delivery', { recursive: true });
const out = '.runtime/delivery/engineering-' + head + '.zip';
writeFileSync(out, archive);
const manifest = JSON.parse(readFileSync('FILE_MANIFEST.json', 'utf8'));
console.log(JSON.stringify({ out, head, entries: entries.length, bytes: archive.length, sha256: sha(archive), manifestSourceHash: manifest.sourceHash, manifestFiles: manifest.files.length }, null, 1));
