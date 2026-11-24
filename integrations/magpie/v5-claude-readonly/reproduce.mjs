import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const root = dirname(fileURLToPath(import.meta.url));
export const suite = resolve('F:/DreamMakerSuite');
export const kit = join(suite,'worktrees/kimi-p1-v1/integrations/magpie');
export const audited = join(suite,'evidence/M07/v5-source-rebuild-S3GrBg/cli-responses/dream-maker-magpie.exe');
export const expected = '78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6';
export const goRoot = join(suite,'runtime/go1.26.8-windows-amd64/go');
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = file => sha(readFileSync(file));
export const cache = join(root,'local');
const source = join(cache,'source');
const temp = join(cache,'tmp');
const env = {SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,COMSPEC:process.env.COMSPEC,
  HOME:cache,USERPROFILE:cache,APPDATA:cache,LOCALAPPDATA:cache,XDG_CONFIG_HOME:cache,
  TEMP:temp,TMP:temp,GOTMPDIR:temp,GOCACHE:join(cache,'go-build'),GOPATH:join(cache,'go-path'),GOMODCACHE:join(cache,'go-mod'),
  GOENV:'off',GOWORK:'off',GOTOOLCHAIN:'local',GOTELEMETRY:'off',CGO_ENABLED:'0',GOSUMDB:'off',
  GOPROXY:pathToFileURL(join(suite,'caches/go-mod-20261111/cache/download')).href,GOFLAGS:'-p=4 -mod=readonly',
  DM_ACCOUNT_TEST_ROOT:temp,DM_ISSUER_TEST_ROOT:temp,DM_CONTROL_TEST_ROOT:temp};
export function go(args) {
  execFileSync(join(goRoot,'bin/go.exe'),args,{cwd:source,env,stdio:'inherit'});
}
function build() {
  assert.equal(digest(audited),expected);
  mkdirSync(temp,{recursive:true});
  const manifest = join(kit,'v5/SOURCE_MANIFEST.json');
  assert.equal(digest(manifest),'15fda3587126c22381fd3560a8888cce94f66c768a45505c11a237760ec4e7d0');
  const spec = JSON.parse(readFileSync(manifest));
  assert.equal(digest(join(goRoot,'bin/go.exe')),spec.goBinary);
  const frozen = join(suite,'evidence/M07/v5-source-rebuild-5HLd0T/source');
  if (!existsSync(source)) cpSync(frozen,source,{recursive:true,filter:path=>basename(path)!=='.git'});
  for (const [path,hash] of Object.entries(spec.modules)) assert.equal(digest(join(source,path)),hash);
  for (const {path,sha256} of spec.appliedBase) assert.equal(digest(join(source,path)),sha256,path);
  const work = mkdtempSync(join(root,'build-'));
  const changes = join(work,'changes');
  const Replace = {};
  for (const {path,sha256} of spec.files) {
    const original=join(kit,'v5/overlay',path);
    assert.equal(digest(original),sha256,path);
    Replace[join(source,path)]=original;
  }
  const paths = ['internal/dmbridge/gate.go','cmd/dream-maker-magpie/control.go','internal/gateway/dm_explicit.go','internal/gateway/dm_response_stream.go'];
  for (const path of paths) {
    const target=join(changes,path);
    mkdirSync(dirname(target),{recursive:true});
    copyFileSync(Replace[join(source,path)],target);
    Replace[join(source,path)]=target;
  }
  const apply = file => execFileSync('git',['apply','--no-index','--whitespace=error',file],{cwd:changes,env,stdio:'inherit'});
  const basePatch=join(kit,'v5-cli-responses/routes.patch');
  assert.equal(digest(basePatch),'8555668e40679a11d8ca9887a69937afae542afd76a3f9ced70b0bee2dd9c108');
  apply(basePatch);
  const overlay=join(work,'overlay.json');
  writeFileSync(overlay,JSON.stringify({Replace}));
  const compile = name => {
    const file = join(work,name+'.exe');
    go(['build','-overlay',overlay,'-buildvcs=false','-trimpath','-o',file,'./cmd/dream-maker-magpie']);
    return file;
  };
  const base=compile('baseline');
  assert.equal(digest(base),expected,'offline rebuild of audited binary');
  if (process.argv.includes('--baseline-only')) {console.log('BASELINE '+work);return;}
  const patch=join(root,'claude.patch');
  apply(patch);
  const chat='internal/gateway/dm_claude_chat.go';
  Replace[join(source,chat)]=join(changes,chat);
  writeFileSync(overlay,JSON.stringify({Replace}));
  const binary=compile('dream-maker-magpie');
  go(['test','-count=1','-overlay',overlay,'-buildvcs=false','./internal/dmbridge']);
  // Relocate only frozen test guards. The production overlay stays byte-for-byte intact.
  const testRoot=join(work,'regression-data');
  mkdirSync(testRoot);
  for (const key of ['DM_ACCOUNT_TEST_ROOT','DM_ISSUER_TEST_ROOT','DM_CONTROL_TEST_ROOT']) env[key]=testRoot;
  const testReplace={...Replace};
  const from=join('f:/dreammakersuite/evidence/m07','x').slice(0,-1);
  for(const [path,file] of Object.entries(Replace)) {
    if (!path.endsWith('_test.go')) continue;
    const old=readFileSync(file,'utf8');
    if (!old.includes(from)) continue;
    const testFile=join(work,'regression-'+basename(file));
    writeFileSync(testFile,old.replaceAll(from,work.toLowerCase()+String.fromCharCode(92)));
    testReplace[path]=testFile;
  }
  const testOverlay=join(work,'regression-overlay.json');
  writeFileSync(testOverlay,JSON.stringify({Replace:testReplace}));
  go(['test','-count=1','-overlay',testOverlay,'-buildvcs=false','-run','TestDM|TestDreamMaker','./internal/gateway','./internal/provider','./internal/access','./cmd/dream-maker-magpie']);
  const result={binary,binarySHA256:digest(binary),baselineSHA256:expected,patchSHA256:digest(patch),overlay,source,regression:'PASS'};
  writeFileSync(join(work,'build.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))build();
