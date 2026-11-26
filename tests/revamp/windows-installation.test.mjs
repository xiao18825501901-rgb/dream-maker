// Offline Windows installation lifecycle tests. These never run a model or touch
// an existing Dream Maker installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  installPortableDirectory,
  readInstallationState,
  rollbackPortableDirectory,
  uninstallPortableDirectory,
  updatePortableDirectory
} from '../../dist/server/release/windows-installation.js';
import {
  buildPortableDirectory,
  createPortableManifest,
  verifyPortableDirectory
} from '../../dist/server/release/windows-portable.js';

const suiteRoot=resolve(process.env.DREAMMAKER_SUITE_ROOT??'F:\\DreamMakerSuite');
const nodeCrypto=createRequire(import.meta.url)('node:crypto');

function temporaryRoot(t){
  const parent=join(suiteRoot,'evidence','M83');
  mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'installation-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}

function sourceFixture(root,name){
  const source=join(root,name),runtime=join(root,`${name}-runtime`);
  for(const tree of ['dist/server','dist/server/release','dist/web','prompts','migrations','adapters','skills','scripts/isolation','config']){
    mkdirSync(join(source,tree),{recursive:true});
  }
  mkdirSync(runtime,{recursive:true});
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'dream-maker',version:'0.1.0'}));
  writeFileSync(join(source,'dist/server/main.js'),'console.log("dm")');
  writeFileSync(join(source,'dist/server/dreamflow-main.js'),'console.log("df")');
  writeFileSync(join(source,'dist/server/release/windows-installation.js'),'export {};');
  writeFileSync(join(source,'dist/web/index.html'),'<!doctype html>');
  writeFileSync(join(source,'prompts/planner1.md'),'planner');
  writeFileSync(join(source,'migrations/001_initial.sql'),'select 1;');
  writeFileSync(join(source,'adapters/example.mjs'),'export {};');
  writeFileSync(join(source,'scripts/isolation/helper.py'),'print("safe")');
  writeFileSync(join(source,'config/local.example.json'),'{}');
  writeFileSync(join(runtime,'node.exe'),'OFFLINE_NODE_STUB');
  writeFileSync(join(runtime,'LICENSE'),'OFFLINE NODE LICENSE');
  return{source,runtime};
}

async function portableFixture(root,name,version,marker){
  const fixture=sourceFixture(root,name);
  writeFileSync(join(fixture.source,'dist/server/main.js'),`console.log(${JSON.stringify(marker)});`);
  const output=join(root,`${name}-package-${version}`);
  await buildPortableDirectory({
    sourceRoot:fixture.source,
    nodeRoot:fixture.runtime,
    output,
    version,
    head:'a'.repeat(40),
    nodeVersion:'v24.22.1',
    builtAt:'2026-11-07T00:00:00.000Z'
  });
  assert.equal((await verifyPortableDirectory(output)).status,'PASS_CORE_PORTABLE_ONLY');
  return output;
}

test('install, update, rollback and uninstall preserve user data across package changes',async t=>{
  const root=temporaryRoot(t);
  const first=await portableFixture(root,'version-one','0.1.0','VERSION_ONE');
  const second=await portableFixture(root,'version-two','0.2.0','VERSION_TWO');
  const installRoot=join(root,'DreamMakerSuite');

  const installed=await installPortableDirectory({sourceRoot:first,installRoot});
  assert.equal(installed.version,'0.1.0');
  assert.equal((await readInstallationState(installRoot)).installId,installed.installId);
  assert.equal((await verifyPortableDirectory(installRoot)).status,'PASS_CORE_PORTABLE_ONLY');

  mkdirSync(join(installRoot,'data/dream-maker'),{recursive:true});
  writeFileSync(join(installRoot,'data/dream-maker/project.json'),'{"title":"kept"}');

  const updated=await updatePortableDirectory({sourceRoot:second,installRoot});
  assert.equal(updated.version,'0.2.0');
  assert.equal(readFileSync(join(installRoot,'data/dream-maker/project.json'),'utf8'),'{"title":"kept"}');
  assert.equal((await readInstallationState(installRoot)).version,'0.2.0');
  assert.equal(existsSync(updated.rollbackRoot),true);
  assert.equal((await verifyPortableDirectory(updated.rollbackRoot)).status,'PASS_CORE_PORTABLE_ONLY');

  writeFileSync(join(installRoot,'data/dream-maker/change.json'),'{"after":"update"}');
  const rollbackPointer=JSON.parse(readFileSync(join(installRoot,'data/.installation/rollback.json'),'utf8'));
  const rolledBack=await rollbackPortableDirectory({installRoot});
  assert.equal(rolledBack.version,'0.1.0');
  assert.equal(readFileSync(join(installRoot,'data/dream-maker/project.json'),'utf8'),'{"title":"kept"}');
  assert.equal(readFileSync(join(installRoot,'data/dream-maker/change.json'),'utf8'),'{"after":"update"}');
  assert.equal((await readInstallationState(installRoot)).version,'0.1.0');
  assert.equal(existsSync(rolledBack.failedUpdateRoot),true);
  assert.equal(existsSync(rollbackPointer.backupRoot),true,'rollback keeps its verified prior-code backup');

  const removed=await uninstallPortableDirectory({installRoot});
  assert.equal(existsSync(installRoot),false);
  assert.equal(existsSync(removed.userDataRoot),true);
  assert.equal(readFileSync(join(removed.userDataRoot,'data/dream-maker/project.json'),'utf8'),'{"title":"kept"}');
  assert.equal(readFileSync(join(removed.userDataRoot,'data/dream-maker/change.json'),'utf8'),'{"after":"update"}');
  assert.equal(existsSync(join(removed.userDataRoot,'data/.installation/uninstalled.json')),true);
});

test('install rejects a remotely valid portable manifest that tries to bundle mutable user-data paths',async t=>{
  const root=temporaryRoot(t);
  const source=await portableFixture(root,'bundled-data','0.1.0','BUNDLED_DATA');
  mkdirSync(join(source,'data'),{recursive:true});
  writeFileSync(join(source,'data/leak.json'),'{"must":"not-copy"}');
  const manifest=JSON.parse(readFileSync(join(source,'RELEASE_MANIFEST.json'),'utf8'));
  const bytes=Buffer.from('{"must":"not-copy"}');
  const {createHash}=await import('node:crypto');
  const dataHash=createHash('sha256').update(bytes).digest('hex');
  const rebuilt=createPortableManifest({
    version:manifest.version,
    head:manifest.head,
    nodeVersion:manifest.nodeVersion,
    builtAt:manifest.builtAt,
    sourceHash:manifest.sourceHash,
    files:[...manifest.files,{path:'data/leak.json',bytes:bytes.length,sha256:dataHash}]
  });
  const manifestBytes=Buffer.from(JSON.stringify(rebuilt,null,2)+'\n');
  writeFileSync(join(source,'RELEASE_MANIFEST.json'),manifestBytes);
  const manifestHash=createHash('sha256').update(manifestBytes).digest('hex');
  const sums=[...rebuilt.files,{path:'RELEASE_MANIFEST.json',bytes:manifestBytes.length,sha256:manifestHash}]
    .sort((a,b)=>a.path.localeCompare(b.path,'en'))
    .map(file=>`${file.sha256}  ${file.path}`).join('\n')+'\n';
  writeFileSync(join(source,'SHA256SUMS.txt'),sums);
  assert.equal((await verifyPortableDirectory(source)).status,'PASS_CORE_PORTABLE_ONLY');
  await assert.rejects(
    ()=>installPortableDirectory({sourceRoot:source,installRoot:join(root,'ShouldNotInstall')}),
    /INSTALLATION_SOURCE_MUTABLE_DATA/
  );
  assert.equal(existsSync(join(root,'ShouldNotInstall')),false);
});

test('update refuses an active Dream Maker lock and leaves the installation unchanged',async t=>{
  const root=temporaryRoot(t);
  const first=await portableFixture(root,'locked-one','0.1.0','LOCKED_ONE');
  const second=await portableFixture(root,'locked-two','0.2.0','LOCKED_TWO');
  const installRoot=join(root,'DreamMakerSuite');
  await installPortableDirectory({sourceRoot:first,installRoot});
  const before=readFileSync(join(installRoot,'RELEASE_MANIFEST.json'),'utf8');
  mkdirSync(join(installRoot,'data/dream-maker'),{recursive:true});
  writeFileSync(join(installRoot,'data/dream-maker/server.lock'),'{"active":true}');

  await assert.rejects(
    ()=>updatePortableDirectory({sourceRoot:second,installRoot}),
    /INSTALLATION_ACTIVE/
  );
  assert.equal(readFileSync(join(installRoot,'RELEASE_MANIFEST.json'),'utf8'),before);
  assert.equal((await readInstallationState(installRoot)).version,'0.1.0');
});

test('update rollback-pointer failure restores the original portable installation and user data',async t=>{
  const root=temporaryRoot(t);
  const first=await portableFixture(root,'pointer-failure-one','0.1.0','POINTER_FAILURE_ONE');
  const second=await portableFixture(root,'pointer-failure-two','0.2.0','POINTER_FAILURE_TWO');
  const installRoot=join(root,'DreamMakerSuite');

  await installPortableDirectory({sourceRoot:first,installRoot});
  mkdirSync(join(installRoot,'data/dream-maker'),{recursive:true});
  writeFileSync(join(installRoot,'data/dream-maker/project.json'),'{"title":"preserve-on-pointer-failure"}');
  // A directory at the pointer path deterministically makes the staged pointer
  // write fail after the old installation has already been switched aside.
  mkdirSync(join(installRoot,'data/.installation/rollback.json'),{recursive:true});

  let updateError;
  try{await updatePortableDirectory({sourceRoot:second,installRoot});}catch(error){updateError=error;}
  assert.match(String(updateError),/EISDIR|EEXIST|EPERM|EACCES/);

  const state=await readInstallationState(installRoot),siblings=readdirSync(root).sort();
  assert.equal(state.version,'0.1.0',JSON.stringify({updateError:String(updateError),siblings}));
  assert.equal(readFileSync(join(installRoot,'data/dream-maker/project.json'),'utf8'),'{"title":"preserve-on-pointer-failure"}');
  assert.equal(lstatSync(join(installRoot,'data/.installation/rollback.json')).isDirectory(),true);
  assert.equal((await verifyPortableDirectory(installRoot)).status,'PASS_CORE_PORTABLE_ONLY');
});

test('rollback failure restores the current installation, user data and original rollback pointer',async t=>{
  const root=temporaryRoot(t);
  const first=await portableFixture(root,'rollback-failure-one','0.1.0','ROLLBACK_FAILURE_ONE');
  const second=await portableFixture(root,'rollback-failure-two','0.2.0','ROLLBACK_FAILURE_TWO');
  const installRoot=join(root,'DreamMakerSuite');

  await installPortableDirectory({sourceRoot:first,installRoot});
  await updatePortableDirectory({sourceRoot:second,installRoot});
  mkdirSync(join(installRoot,'data/dream-maker'),{recursive:true});
  writeFileSync(join(installRoot,'data/dream-maker/project.json'),'{"title":"preserve-on-rollback-failure"}');
  const pointerPath=join(installRoot,'data/.installation/rollback.json'),pointerBefore=readFileSync(pointerPath);
  // The rollback-history writer must create a child under this path. A regular
  // file reproduces a write failure after the current installation was moved aside.
  writeFileSync(join(installRoot,'data/.installation/rollback-history'),'not-a-directory');

  let rollbackError;
  try{await rollbackPortableDirectory({installRoot});}catch(error){rollbackError=error;}
  assert.match(String(rollbackError),/EEXIST|EPERM|EACCES|ENOTDIR/);

  if(!existsSync(installRoot))
    assert.fail(JSON.stringify({rollbackError:String(rollbackError),siblings:readdirSync(root).sort()}));
  assert.equal((await readInstallationState(installRoot)).version,'0.2.0');
  assert.equal(readFileSync(join(installRoot,'data/dream-maker/project.json'),'utf8'),'{"title":"preserve-on-rollback-failure"}');
  assert.deepEqual(readFileSync(pointerPath),pointerBefore);
  assert.equal((await verifyPortableDirectory(installRoot)).status,'PASS_CORE_PORTABLE_ONLY');
});

test('install refuses an unrelated existing directory and a target inside the source package',async t=>{
  const root=temporaryRoot(t);
  const source=await portableFixture(root,'guarded','0.1.0','GUARDED');
  const unrelated=join(root,'unrelated');
  mkdirSync(unrelated,{recursive:true});
  writeFileSync(join(unrelated,'keep.txt'),'keep');
  await assert.rejects(
    ()=>installPortableDirectory({sourceRoot:source,installRoot:unrelated}),
    /INSTALLATION_TARGET_EXISTS/
  );
  assert.equal(readFileSync(join(unrelated,'keep.txt'),'utf8'),'keep');
  await assert.rejects(
    ()=>installPortableDirectory({sourceRoot:source,installRoot:join(source,'nested-install')}),
    /INSTALLATION_PATH_INVALID/
  );
});

test('rollback and uninstall require a valid managed installation',async t=>{
  const root=temporaryRoot(t);
  const unrelated=join(root,'not-managed');
  mkdirSync(unrelated,{recursive:true});
  writeFileSync(join(unrelated,'keep.txt'),'keep');
  await assert.rejects(()=>rollbackPortableDirectory({installRoot:unrelated}),/INSTALLATION_NOT_MANAGED/);
  await assert.rejects(()=>uninstallPortableDirectory({installRoot:unrelated}),/INSTALLATION_NOT_MANAGED/);
  assert.equal(readFileSync(join(unrelated,'keep.txt'),'utf8'),'keep');
});

test('uninstall receipt failure restores the original portable installation and user data',async t=>{
  const root=temporaryRoot(t);
  const source=await portableFixture(root,'uninstall-receipt-failure','0.1.0','UNINSTALL_RECEIPT_FAILURE');
  const installRoot=join(root,'DreamMakerSuite');
  await installPortableDirectory({sourceRoot:source,installRoot});
  mkdirSync(join(installRoot,'data/dream-maker'),{recursive:true});
  writeFileSync(join(installRoot,'data/dream-maker/project.json'),'{"title":"preserve-on-uninstall-failure"}');
  // The receipt path must be a regular file. A directory reproduces a write
  // failure after the installation and mutable data have both been moved aside.
  mkdirSync(join(installRoot,'data/.installation/uninstalled.json'),{recursive:true});

  let uninstallError;
  try{await uninstallPortableDirectory({installRoot});}catch(error){uninstallError=error;}
  assert.match(String(uninstallError),/EISDIR|EEXIST|EPERM|EACCES|ENOTDIR/);
  assert.equal(existsSync(installRoot),true,JSON.stringify({uninstallError:String(uninstallError),siblings:readdirSync(root).sort()}));
  assert.equal((await readInstallationState(installRoot)).version,'0.1.0');
  assert.equal(readFileSync(join(installRoot,'data/dream-maker/project.json'),'utf8'),'{"title":"preserve-on-uninstall-failure"}');
  assert.equal(lstatSync(join(installRoot,'data/.installation/uninstalled.json')).isDirectory(),true);
  assert.equal((await verifyPortableDirectory(installRoot)).status,'PASS_CORE_PORTABLE_ONLY');
});

test('an occupied uninstall sibling refuses before changing the managed installation',async t=>{
  const root=temporaryRoot(t);
  const source=await portableFixture(root,'uninstall-sibling-failure','0.1.0','UNINSTALL_SIBLING_FAILURE');
  const uuid='00000000-0000-4000-8000-000000000001',installRoot=join(root,'DreamMakerSuite');
  const tombstone=join(root,`.DreamMakerSuite.uninstalling-${uuid}`);
  await installPortableDirectory({sourceRoot:source,installRoot});
  mkdirSync(join(installRoot,'data/dream-maker'),{recursive:true});
  writeFileSync(join(installRoot,'data/dream-maker/project.json'),'{"title":"preserve-on-sibling-failure"}');
  const manifestBefore=readFileSync(join(installRoot,'RELEASE_MANIFEST.json'));
  mkdirSync(tombstone);
  writeFileSync(join(tombstone,'foreign.txt'),'foreign');

  const original=nodeCrypto.randomUUID;
  nodeCrypto.randomUUID=()=>uuid;
  syncBuiltinESMExports();
  try{await assert.rejects(()=>uninstallPortableDirectory({installRoot}),/EEXIST|EPERM|EACCES/);}
  finally{nodeCrypto.randomUUID=original;syncBuiltinESMExports();}
  assert.equal((await readInstallationState(installRoot)).version,'0.1.0');
  assert.deepEqual(readFileSync(join(installRoot,'RELEASE_MANIFEST.json')),manifestBefore);
  assert.equal(readFileSync(join(installRoot,'data/dream-maker/project.json'),'utf8'),'{"title":"preserve-on-sibling-failure"}');
  assert.equal(readFileSync(join(tombstone,'foreign.txt'),'utf8'),'foreign');
  assert.equal(existsSync(join(root,`.DreamMakerSuite.userdata-${uuid}`)),false);
});
