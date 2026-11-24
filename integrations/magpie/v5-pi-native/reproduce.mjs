import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const kit = dirname(fileURLToPath(import.meta.url));
const baseline = resolve(process.argv[2]), parent = dirname(dirname(baseline));
const work = await mkdtemp(join(resolve(process.argv[3]), 'pi-build-'));
const suite = 'F:/DreamMakerSuite', goRoot = join(suite, 'runtime/go1.26.8-windows-amd64/go');
const hash = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
const pin = '78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6';
const old = JSON.parse(await readFile(baseline));
assert.equal(await hash(old.binary), pin);
const source = join(work, 'source'), overlay = join(work, 'overlay.json');
await cp(join(parent, 'source'), source, { recursive: true, filter: p => basename(p) !== '.git' });
const mapping = JSON.parse(await readFile(join(dirname(baseline), 'overlay.json')));
const changes = join(work, 'changes');
const replace = {};
for (const [path, from] of Object.entries(mapping.Replace)) {
    const rel = relative(join(parent, 'source'), path);
    assert.ok(!rel.startsWith('..'));
    const to = join(changes, rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    replace[join(source, rel)] = to;
}
await writeFile(overlay, JSON.stringify({ Replace: replace }));
const temp = join(work, 'tmp');
await mkdir(temp);
const env = { ...process.env, TMP: temp, TEMP: temp, GOENV: 'off', GOWORK: 'off', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GOTELEMETRY: 'off', CGO_ENABLED: '0', GOMODCACHE: join(suite, 'caches/go-mod-20261111'), GOCACHE: join(dirname(work), 'go-cache'), GOPATH: join(work, 'go-path'), GOTMPDIR: temp, GOFLAGS: '-p=2 -mod=readonly' };
const go = (...args) => execFileSync(join(goRoot, 'bin/go.exe'), args, { cwd: source, env, stdio: 'inherit' });
const build = (out) => go('build', '-overlay', overlay, '-buildvcs=false', '-trimpath', '-o', out, './cmd/dream-maker-magpie');
console.log(work);
const original = join(work, 'baseline.exe');
build(original);
assert.equal(await hash(original), pin);
execFileSync('git', ['apply', '--no-index', '--whitespace=error', join(kit, 'routes.patch')], { cwd: changes, stdio: 'inherit' });
for (const name of ['dm_pi.go', 'dm_pi_stream.go']) {
    const path = join('internal/gateway', name);
    const to = join(changes, path);
    await copyFile(join(kit, name), to);
    replace[join(source, path)] = to;
}
await writeFile(overlay, JSON.stringify({ Replace: replace }));
const binary = join(work, 'dream-maker-magpie.exe'), second = join(work, 'repeat.exe');
build(binary);
build(second);
const binarySHA256 = await hash(binary);
assert.equal(await hash(second), binarySHA256);
const testDir = await mkdtemp(join(work, 'unit-'));
const testOverlay = join(testDir, 'overlay.json');
const tests = JSON.parse(await readFile(overlay));
for (const [path, to] of Object.entries(tests.Replace)) {
    if (!path.endsWith('_test.go'))
        continue;
    const text = await readFile(to, 'utf8');
    const fixed = 'f:/dreammakersuite/evidence/m07/'.replaceAll('/', String.fromCharCode(92));
    const patched = text.replaceAll(fixed, testDir.toLowerCase() + '\\');
    if (text !== patched) {
        const copy = join(testDir, basename(to));
        await writeFile(copy, patched);
        tests.Replace[path] = copy;
    }
}
await writeFile(testOverlay, JSON.stringify(tests));
for (const [name, sub] of Object.entries({ DM_CONTROL_TEST_ROOT: 'control', DM_ACCOUNT_TEST_ROOT: 'account', DM_ISSUER_TEST_ROOT: 'issuer' })) {
    env[name] = join(testDir, sub);
    await mkdir(env[name]);
}
go('test', '-count=1', '-overlay', testOverlay, '-buildvcs=false', './internal/dmbridge');
go('test', '-count=1', '-overlay', testOverlay, '-buildvcs=false', '-run', 'TestDM|TestDreamMaker', './internal/gateway', './internal/provider', './internal/access', './cmd/dream-maker-magpie');
await writeFile(join(work, 'build.json'), JSON.stringify({ binary, binarySHA256, source, overlay, original, baselineSHA256: pin, second, goRoot, env: Object.fromEntries(Object.entries(env).filter(([k]) => ['GOENV', 'GOWORK', 'GOPROXY', 'GOSUMDB', 'GOTOOLCHAIN', 'GOTELEMETRY', 'CGO_ENABLED', 'GOMODCACHE', 'GOCACHE', 'GOPATH', 'GOTMPDIR', 'GOFLAGS'].includes(k))), qualification: 'NOT_VERIFIED' }, null, 2));
console.log(binarySHA256);
