import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = dirname(fileURLToPath(import.meta.url));
const suite = resolve('F:/DreamMakerSuite');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest = join(kit, 'SOURCE_MANIFEST.json');
assert.equal(digest(manifest), '15fda3587126c22381fd3560a8888cce94f66c768a45505c11a237760ec4e7d0');
const spec = JSON.parse(readFileSync(manifest));
const upstream = resolve(process.argv[2] ?? join(suite, 'builds', 'magpie-source-' + spec.upstreamCommit));
const go = join(suite, 'runtime', 'go1.26.8-windows-amd64', 'go', 'bin', 'go.exe');
assert.equal(digest(go), spec.goBinary);
const run = (bin, args, options = {}) => execFileSync(bin, args, { encoding: 'utf8', windowsHide: true, ...options });
assert.match(run(go, ['version']), /^go version go1\.26\.8 windows\/amd64\s*$/);
assert.equal(spec.appliedBase.length, 20);
assert.equal(spec.files.length, 21);
for (const { path, size, sha256 } of spec.files) {
  const file = join(kit, 'overlay', path);
  assert.equal(realpathSync(file), file);
  assert.equal(lstatSync(file).size, size, path);
  assert.equal(digest(file), sha256, path);
}
for (const { input, sha256 } of spec.appliedBase) assert.equal(digest(join(kit, input)), sha256, input);
const work = mkdtempSync(join(suite, 'evidence', 'M07', 'v5-source-rebuild-'));
const source = join(work, 'source');
const git = (repo, args) => run('git', ['-c', 'safe.directory=' + repo.replaceAll('\\','/'), '-c', 'core.autocrlf=false', '-C', repo, ...args]);
assert.equal(git(upstream, ['rev-parse', spec.upstreamCommit + '^{commit}']).trim(), spec.upstreamCommit);
// Use only Git objects. Modified and untracked files in the source checkout never enter the clone.
run('git', ['-c','safe.directory=' + upstream.replaceAll('\\','/'), '-c','protocol.allow=never','-c','protocol.file.allow=always','clone','--local','--no-hardlinks','--no-checkout', upstream, source]);
git(source, ['checkout', '--detach', spec.upstreamCommit]);
assert.equal(git(source, ['rev-parse','HEAD']).trim(),spec.upstreamCommit);
for (const {path, input, sha256} of spec.appliedBase) {
  const dest = join(source, path);
  mkdirSync(dirname(dest), {recursive:true});
  copyFileSync(join(kit,input), dest);
  assert.equal(digest(dest),sha256,path);
}
const changed = git(source, ['status','--porcelain=v1','--untracked-files=all']).trimEnd().split(/\r?\n/).map(line => line.slice(3)).sort();
assert.deepEqual(changed, spec.appliedBase.map(entry => entry.path).sort());
for (const [path, hash] of Object.entries(spec.modules)) assert.equal(digest(join(source, path)), hash, path);
const replace = {};
for (const {path, baseSHA256} of spec.files) {
  const dest = join(source, path);
  if (baseSHA256 === null) assert.equal(existsSync(dest), false, path);
  else assert.equal(digest(dest), baseSHA256, path);
  replace[dest] = join(kit, 'overlay', path);
}
const overlay = join(work, 'overlay.json');
writeFileSync(overlay, JSON.stringify({Replace:replace}), {flag:'wx'});
const env = {...process.env, GOENV:'off', GOWORK:'off', GOPROXY:'off', GOSUMDB:'off', GOTOOLCHAIN:'local', GOTELEMETRY:'off', CGO_ENABLED:'0', GOMODCACHE:join(suite,'caches','go-mod-20261111'), GOCACHE:join(suite,'caches','go-build'), GOPATH:join(suite,'caches','go-path'), GOTMPDIR:join(suite,'temp'), GOFLAGS:'-p=2 -mod=readonly'};
const binary = join(work,'dream-maker-magpie.exe');
run(go, ['build','-overlay',overlay,'-buildvcs=false','-trimpath','-o',binary,'./cmd/dream-maker-magpie'], {cwd:source,env,stdio:'inherit'});
const binarySHA256 = digest(binary);
assert.equal(binarySHA256, spec.expectedBinarySHA256);
const receipt = {status:'PASS', upstreamCommit:spec.upstreamCommit, manifestSHA256:digest(manifest), binarySHA256, binary, overlayFiles:spec.files.length, appliedBaseFiles:changed.length};
writeFileSync(join(work,'receipt.json'), JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));
