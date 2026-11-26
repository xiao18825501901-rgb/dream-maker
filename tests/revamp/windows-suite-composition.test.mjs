// Offline composition tests. They never execute a bundled agent runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {
  buildSuiteComposition,
  verifySuiteComposition,
} from '../../dist/server/release/windows-suite-composition.js';
import {
  installSuiteComposition,
} from '../../dist/server/release/windows-suite-installation.js';
import {
  buildPortableDirectory,
  verifyPortableDirectory,
} from '../../dist/server/release/windows-portable.js';
import {
  buildRuntimeBundle,
  verifyRuntimeBundle,
} from '../../dist/server/release/windows-runtime-bundle.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const runtimeIds=[
  'dm-controller',
  'dreamflow-core',
  'codex-runtime',
  'dsh-runtime',
  'planner1-cloud-runtime',
  'verified-base-toolchain',
];
const realNodeRoot=process.env.DREAMMAKER_NODE_ROOT
  ??'F:\\DreamMakerSuite\\runtime\\node-v24.22.1\\x\\node-v24.22.1-win-x64';

test('Suite and its shipped verifier reject Windows device aliases before file lookup',async t=>{
 const parent=mkdtempSync(join(resolve('.runtime/test-temp'),'suite-device-name-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const core=await coreFixture(parent),runtime=await runtimeFixture(parent),output=join(parent,'suite');await buildSuiteComposition({coreRoot:core,runtimeRoot:runtime,output});
 const path=join(output,'SUITE_COMPOSITION_MANIFEST.json'),saved=readFileSync(path);
 for(const name of ['NUL.txt','CON','COM¹.log','LPT³.txt','CONIN$.txt','payload:stream']){
  const manifest=JSON.parse(saved);manifest.files.unshift({path:'runtime/'+name,bytes:1,sha256:'a'.repeat(64)});manifest.filesHash=sha(JSON.stringify(manifest.files));writeFileSync(path,JSON.stringify(manifest));
  await assert.rejects(verifySuiteComposition(output),/SUITE_COMPOSITION_PATH_INVALID/,name);
  const standalone=spawnSync(process.execPath,[join(output,'verify-suite-composition.mjs')],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.notEqual(standalone.status,0);assert.match(standalone.stderr,/SUITE_COMPOSITION_PATH_INVALID/,name);
 }
 writeFileSync(path,saved);assert.equal((await verifySuiteComposition(output)).status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
});

function resealSuiteFile(root,relativePath){
  const manifestPath=join(root,'SUITE_COMPOSITION_MANIFEST.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const file=manifest.files.find(entry=>entry.path===relativePath);
  assert.ok(file,`missing suite file ${relativePath}`);
  const bytes=readFileSync(join(root,...relativePath.split('/')));
  file.bytes=bytes.length;
  file.sha256=sha(bytes);
  manifest.filesHash=sha(JSON.stringify(manifest.files));
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  writeFileSync(manifestPath,manifestBytes);
  const sums=[...manifest.files,{
    path:'SUITE_COMPOSITION_MANIFEST.json',
    bytes:manifestBytes.length,
    sha256:sha(manifestBytes),
  }].sort((left,right)=>left.path.localeCompare(right.path,'en'))
    .map(entry=>`${entry.sha256}  ${entry.path}`).join('\n')+'\n';
  writeFileSync(join(root,'SHA256SUMS.txt'),sums);
}

async function coreFixture(parent){
  const source=join(parent,'core-source'),nodeRoot=join(parent,'node-runtime'),output=join(parent,'core');
  mkdirSync(join(source,'dist/server'),{recursive:true});
  mkdirSync(join(source,'dist/web'),{recursive:true});
  for(const tree of ['prompts','migrations','adapters','skills','scripts/isolation']){
    mkdirSync(join(source,tree),{recursive:true});
    writeFileSync(join(source,tree,'.keep'),tree);
  }
  for(const file of [
    'dist/server/release/windows-installation.js',
    'dist/server/release/windows-portable.js',
    'dist/server/release/windows-package-path.js',
    'dist/server/release/windows-runtime-bundle.js',
    'dist/server/release/windows-suite-composition.js',
    'dist/server/release/windows-suite-installation.js',
  ]){
    mkdirSync(dirname(join(source,file)),{recursive:true});
    copyFileSync(join(process.cwd(),file),join(source,file));
  }
  writeFileSync(join(source,'dist/server/main.js'),'console.log("dm")');
  writeFileSync(join(source,'dist/server/dreamflow-main.js'),'console.log("df")');
  writeFileSync(join(source,'dist/web/index.html'),'<!doctype html>');
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'dream-maker',version:'0.1.0',type:'module'}));
  mkdirSync(nodeRoot,{recursive:true});
  copyFileSync(join(realNodeRoot,'node.exe'),join(nodeRoot,'node.exe'));
  copyFileSync(join(realNodeRoot,'LICENSE'),join(nodeRoot,'LICENSE'));
  await buildPortableDirectory({
    sourceRoot:source,
    nodeRoot,
    output,
    version:'0.1.0',
    head:'abcdef0',
    nodeVersion:'v24.22.1',
    builtAt:'2026-11-08T00:00:00.000Z',
    sourceHash:'a'.repeat(64),
  });
  return output;
}

async function runtimeFixture(parent){
  const evidence=join(parent,'runtime-evidence'),output=join(parent,'runtime-bundle'),refs=[];
  mkdirSync(evidence,{recursive:true});
  runtimeIds.forEach((id,index)=>{
    const dir=`component-${index}`;
    const artifact=Buffer.from(`artifact:${id}`),license=Buffer.from(`license:${id}\n`);
    const sbom=Buffer.from(JSON.stringify({id})+'\n');
    mkdirSync(join(evidence,dir),{recursive:true});
    writeFileSync(join(evidence,dir,'artifact.bin'),artifact);
    writeFileSync(join(evidence,dir,'LICENSE.txt'),license);
    writeFileSync(join(evidence,dir,'sbom.json'),sbom);
    const fragment={
      schema:'dream-maker.release-component-fragment.v1',
      status:'PARTIAL_COMPONENT_EVIDENCE',
      componentId:id,
      component:{
        id,
        version:index===3?'0.2.0-rc.1':'1.0.0',
        source:{kind:'LOCAL_PACKAGE',locator:`fixture:${id}`,revision:`fixture-${id}`},
        artifact:{path:`${dir}/artifact.bin`,bytes:artifact.length,sha256:sha(artifact)},
        license:{path:`${dir}/LICENSE.txt`,sha256:sha(license)},
        sbom:{path:`${dir}/sbom.json`,sha256:sha(sbom)},
      },
      releaseReady:false,
    };
    const fragmentBytes=Buffer.from(JSON.stringify(fragment,null,2)+'\n');
    writeFileSync(join(evidence,dir,'fragment.json'),fragmentBytes);
    refs.push({
      id,
      version:fragment.component.version,
      fragmentPath:`${dir}/fragment.json`,
      fragmentSha256:sha(fragmentBytes),
    });
  });
  const indexPath=join(evidence,'index.json');
  writeFileSync(indexPath,JSON.stringify({
    schema:'dream-maker.release-evidence-index.v1',
    components:refs,
    releaseReady:false,
    completeDistribution:false,
  },null,2)+'\n');
  await buildRuntimeBundle({
    evidenceRoot:evidence,
    indexPath,
    output,
    builtAt:'2026-11-08T00:00:00.000Z',
  });
  return output;
}

test('composition preserves both verified packages and remains explicitly non-release',async t=>{
  const parent=mkdtempSync(join(resolve('.runtime/test-temp'),'dm-suite-composition-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const core=await coreFixture(parent);
  const runtime=await runtimeFixture(parent);
  const output=join(parent,'suite');
  mkdirSync(join(core,'data/dream-maker'),{recursive:true});
  writeFileSync(join(core,'data/dream-maker/user.sqlite'),'DO_NOT_COPY');
  mkdirSync(join(core,'temp'),{recursive:true});
  writeFileSync(join(core,'temp/runtime.tmp'),'DO_NOT_COPY');

  const built=await buildSuiteComposition({
    coreRoot:core,
    runtimeRoot:runtime,
    output,
    builtAt:'2026-11-08T00:00:00.000Z',
  });
  assert.equal(built.status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
  assert.equal(built.releaseReady,false);
  assert.equal(built.binariesExecuted,false);
  assert.equal(built.credentialsIncluded,false);
  assert.equal(existsSync(join(output,'core/data')),false);
  assert.equal(existsSync(join(output,'core/temp')),false);
  assert.equal(existsSync(join(output,'install-suite-composition.mjs')),true);
  assert.equal(existsSync(join(output,'Setup-DreamMakerSuite.ps1')),true);
  assert.equal(existsSync(join(output,'Rollback-DreamMakerSuite.ps1')),true);
  assert.equal(existsSync(join(output,'runtime/agent-bundle/RUNTIME_BUNDLE_MANIFEST.json')),true);
  assert.equal(existsSync(join(output,'RUNTIME_LICENSE_INDEX.json')),true);
  assert.match(readFileSync(join(output,'install-suite-composition.mjs'),'utf8'),/rollbackSuiteComposition/);
  assert.match(readFileSync(join(output,'install-suite-composition.mjs'),'utf8'),/action==='rollback'/);

  const verified=await verifySuiteComposition(output);
  assert.equal(verified.status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
  assert.equal(verified.releaseReady,false);
  assert.equal(verified.coreFiles>0,true);
  assert.equal(verified.runtimeComponents,6);
  assert.equal(verified.installerIntegrated,true);
  assert.equal(verified.installerScope,'LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL');
  assert.equal((await verifyPortableDirectory(join(output,'core'))).status,'PASS_CORE_PORTABLE_ONLY');
  assert.equal((await verifyRuntimeBundle(join(output,'runtime/agent-bundle'))).components,6);
  const suiteManifest=JSON.parse(readFileSync(join(output,'SUITE_COMPOSITION_MANIFEST.json'),'utf8'));
  const licenseIndex=JSON.parse(readFileSync(join(output,'RUNTIME_LICENSE_INDEX.json'),'utf8'));
  assert.equal(licenseIndex.schema,'dream-maker.windows-runtime-license-index.v1');
  assert.equal(licenseIndex.status,'PARTIAL_LICENSE_INDEX_NOT_REVIEWED');
  assert.equal(licenseIndex.sourceRuntimeManifestSha256,suiteManifest.runtime.manifestSha256);
  assert.equal(licenseIndex.legalReview,'NOT_REVIEWED');
  assert.equal(licenseIndex.releaseReady,false);
  assert.equal(licenseIndex.redistributionReviewed,false);
  assert.equal(licenseIndex.components.length,6);
  for(const component of licenseIndex.components){
    assert.match(component.license.path,/^runtime\/agent-bundle\/components\/.+\/LICENSE\.txt$/);
    assert.match(component.sbom.path,/^runtime\/agent-bundle\/components\/.+\/component-sbom\.json$/);
    assert.match(component.license.sha256,/^[a-f0-9]{64}$/);
    assert.match(component.sbom.sha256,/^[a-f0-9]{64}$/);
  }

  const standalone=spawnSync(process.execPath,[join(output,'verify-suite-composition.mjs')],{
    encoding:'utf8',
    windowsHide:true,
  });
  assert.equal(standalone.status,0,standalone.stderr);
  assert.match(standalone.stdout,/PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE/);
  assert.match(standalone.stdout,/"installerIntegrated":true/);
});

test('a resealed but semantically unapproved license index is rejected',async t=>{
  const parent=mkdtempSync(join(resolve('.runtime/test-temp'),'dm-suite-license-index-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const core=await coreFixture(parent);
  const runtime=await runtimeFixture(parent);
  const output=join(parent,'suite');
  await buildSuiteComposition({
    coreRoot:core,
    runtimeRoot:runtime,
    output,
    builtAt:'2026-11-08T00:00:00.000Z',
  });
  const indexPath=join(output,'RUNTIME_LICENSE_INDEX.json');
  const index=JSON.parse(readFileSync(indexPath,'utf8'));
  index.redistributionReviewed=true;
  writeFileSync(indexPath,JSON.stringify(index,null,2)+'\n');
  resealSuiteFile(output,'RUNTIME_LICENSE_INDEX.json');
  await assert.rejects(
    ()=>verifySuiteComposition(output),
    /SUITE_COMPOSITION_LICENSE_INDEX_INVALID/,
  );
  const standalone=spawnSync(process.execPath,[join(output,'verify-suite-composition.mjs')],{
    encoding:'utf8',
    windowsHide:true,
  });
  assert.notEqual(standalone.status,0);
  assert.match(standalone.stderr,/SUITE_COMPOSITION_LICENSE_INDEX_INVALID/);
});

test('a resealed license index cannot replace a runtime component binding',async t=>{
  const parent=mkdtempSync(join(resolve('.runtime/test-temp'),'dm-suite-license-binding-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const core=await coreFixture(parent);
  const runtime=await runtimeFixture(parent);
  const output=join(parent,'suite');
  await buildSuiteComposition({
    coreRoot:core,
    runtimeRoot:runtime,
    output,
    builtAt:'2026-11-08T00:00:00.000Z',
  });
  const indexPath=join(output,'RUNTIME_LICENSE_INDEX.json');
  const index=JSON.parse(readFileSync(indexPath,'utf8'));
  index.components[0].version='forged-version';
  writeFileSync(indexPath,JSON.stringify(index,null,2)+'\n');
  resealSuiteFile(output,'RUNTIME_LICENSE_INDEX.json');
  await assert.rejects(
    ()=>verifySuiteComposition(output),
    /SUITE_COMPOSITION_LICENSE_INDEX_INVALID/,
  );
});

test('composition can still verify a legacy install-only manifest without treating it as updatable',async t=>{
  const parent=mkdtempSync(join(resolve('.runtime/test-temp'),'dm-suite-legacy-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const core=await coreFixture(parent);
  const runtime=await runtimeFixture(parent);
  const output=join(parent,'suite');
  await buildSuiteComposition({
    coreRoot:core,
    runtimeRoot:runtime,
    output,
    builtAt:'2026-11-08T00:00:00.000Z',
  });

  const manifestPath=join(output,'SUITE_COMPOSITION_MANIFEST.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  manifest.installer.scope='FRESH_LOCAL_SUITE_INSTALL_ONLY';
  manifest.installer.update=false;
  manifest.installer.rollback=false;
  manifest.installer.uninstall=false;
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  writeFileSync(manifestPath,manifestBytes);
  const sums=readFileSync(join(output,'SHA256SUMS.txt'),'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line=>line.endsWith('  SUITE_COMPOSITION_MANIFEST.json')
      ? `${sha(manifestBytes)}  SUITE_COMPOSITION_MANIFEST.json`
      : line)
    .join('\n')+'\n';
  writeFileSync(join(output,'SHA256SUMS.txt'),sums);

  const verified=await verifySuiteComposition(output);
  assert.equal(verified.installerScope,'FRESH_LOCAL_SUITE_INSTALL_ONLY');
  assert.equal(verified.releaseReady,false);
});

test('composition rejects changed nested packages, tampering and extra files',async t=>{
  const parent=mkdtempSync(join(resolve('.runtime/test-temp'),'dm-suite-composition-deny-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const core=await coreFixture(parent);
  const runtime=await runtimeFixture(parent);
  const build=output=>buildSuiteComposition({
    coreRoot:core,
    runtimeRoot:runtime,
    output,
    builtAt:'2026-11-08T00:00:00.000Z',
  });

  const runtimeOutput=join(parent,'suite-runtime-tamper');
  await build(runtimeOutput);
  const nestedRuntime=join(runtimeOutput,'runtime/agent-bundle/components/codex-runtime/artifact.bin');
  const changed=readFileSync(nestedRuntime);
  changed[0]^=0xff;
  writeFileSync(nestedRuntime,changed);
  await assert.rejects(()=>verifySuiteComposition(runtimeOutput),/SUITE_COMPOSITION_RUNTIME_CHANGED/);

  const coreOutput=join(parent,'suite-core-tamper');
  await build(coreOutput);
  const nestedCore=join(coreOutput,'core/README_CN.md');
  writeFileSync(nestedCore,readFileSync(nestedCore,'utf8')+'changed');
  await assert.rejects(()=>verifySuiteComposition(coreOutput),/SUITE_COMPOSITION_CORE_CHANGED/);

  const extraOutput=join(parent,'suite-extra');
  await build(extraOutput);
  writeFileSync(join(extraOutput,'unexpected.bin'),'extra');
  await assert.rejects(()=>verifySuiteComposition(extraOutput),/SUITE_COMPOSITION_EXTRA_FILE/);
});

test('composition rejects unsafe inputs, links and output collisions',async t=>{
  const parent=mkdtempSync(join(resolve('.runtime/test-temp'),'dm-suite-composition-input-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const core=await coreFixture(parent);
  const runtime=await runtimeFixture(parent);
  const linked=join(parent,'linked-runtime');
  try{
    symlinkSync(runtime,linked,process.platform==='win32'?'junction':'dir');
    await assert.rejects(
      ()=>buildSuiteComposition({
        coreRoot:core,
        runtimeRoot:linked,
        output:join(parent,'suite-link'),
        builtAt:'2026-11-08T00:00:00.000Z',
      }),
      /SUITE_COMPOSITION_INPUT_LINK_DENIED/,
    );
  }catch(error){
    if(!['EPERM','EISDIR','ENOTSUP','UNKNOWN'].includes(error?.code))
      throw error;
    t.diagnostic(`link creation unavailable on this filesystem: ${error.code}`);
  }

  const output=join(parent,'existing');
  mkdirSync(output);
  await assert.rejects(
    ()=>buildSuiteComposition({
      coreRoot:core,
      runtimeRoot:runtime,
      output,
      builtAt:'2026-11-08T00:00:00.000Z',
    }),
    /SUITE_COMPOSITION_OUTPUT_EXISTS/,
  );
});

test('suite installation verifies both packages and permits only bounded mutable core state',async t=>{
  const parent=mkdtempSync(join(resolve('.runtime/test-temp'),'dm-suite-install-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const core=await coreFixture(parent);
  const runtime=await runtimeFixture(parent);
  const source=join(parent,'suite-source'),installRoot=join(parent,'installed-suite');
  await buildSuiteComposition({
    coreRoot:core,
    runtimeRoot:runtime,
    output:source,
    builtAt:'2026-11-08T00:00:00.000Z',
  });

  const installed=await installSuiteComposition({sourceRoot:source,installRoot});
  assert.equal(installed.status,'PASS_SUITE_COMPOSITION_INSTALLED');
  assert.equal(installed.verified,true);
  assert.equal(installed.runtimeComponents,6);
  assert.equal(existsSync(join(installRoot,'core/data/.installation/installation.json')),true);
  assert.equal(existsSync(join(installRoot,'core/temp')),true);
  assert.equal((await verifySuiteComposition(installRoot)).status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
  assert.equal((await verifyPortableDirectory(join(installRoot,'core'))).status,'PASS_CORE_PORTABLE_ONLY');
  assert.equal((await verifyRuntimeBundle(join(installRoot,'runtime/agent-bundle'))).components,6);

  mkdirSync(join(installRoot,'core/data/dream-maker'),{recursive:true});
  writeFileSync(join(installRoot,'core/data/dream-maker/project.json'),'{"title":"kept"}');
  mkdirSync(join(installRoot,'core/temp'),{recursive:true});
  writeFileSync(join(installRoot,'core/temp/run.log'),'bounded mutable temp');
  await verifySuiteComposition(installRoot);
  const standalone=spawnSync(process.execPath,[join(installRoot,'verify-suite-composition.mjs')],{
    encoding:'utf8',
    windowsHide:true,
  });
  assert.equal(standalone.status,0,standalone.stderr);

  writeFileSync(join(installRoot,'core/app/unexpected.bin'),'not mutable');
  await assert.rejects(()=>verifySuiteComposition(installRoot),/SUITE_COMPOSITION_EXTRA_FILE/);
  rmSync(join(installRoot,'core/app/unexpected.bin'));
  writeFileSync(join(installRoot,'unexpected.bin'),'not mutable');
  await assert.rejects(()=>verifySuiteComposition(installRoot),/SUITE_COMPOSITION_EXTRA_FILE/);

  const wrapperTarget=join(parent,'wrapper-installed-suite');
  const wrapperInstall=spawnSync(process.execPath,[
    join(source,'install-suite-composition.mjs'),
    'install',
    '--target',
    wrapperTarget,
  ],{
    encoding:'utf8',
    windowsHide:true,
    timeout:120000,
  });
  assert.equal(wrapperInstall.status,0,wrapperInstall.stderr);
  assert.match(wrapperInstall.stdout,/PASS_SUITE_COMPOSITION_INSTALLED/);
  assert.equal((await verifySuiteComposition(wrapperTarget)).status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
  assert.equal(existsSync(join(source,'Update-DreamMakerSuite.ps1')),true);
  assert.equal(existsSync(join(source,'Uninstall-DreamMakerSuite.ps1')),true);

  mkdirSync(join(wrapperTarget,'core/data/dream-maker'),{recursive:true});
  writeFileSync(join(wrapperTarget,'core/data/dream-maker/project.json'),'{"wrapper":"kept"}');
  const wrapperUpdate=spawnSync(process.execPath,[
    join(source,'install-suite-composition.mjs'),
    'update',
    '--target',wrapperTarget,
  ],{
    encoding:'utf8',
    windowsHide:true,
    timeout:120000,
  });
  assert.equal(wrapperUpdate.status,0,wrapperUpdate.stderr);
  assert.match(wrapperUpdate.stdout,/PASS_SUITE_COMPOSITION_UPDATED/);
  assert.equal(
    readFileSync(join(wrapperTarget,'core/data/dream-maker/project.json'),'utf8'),
    '{"wrapper":"kept"}',
  );

  const wrapperUninstall=spawnSync(process.execPath,[
    join(source,'install-suite-composition.mjs'),
    'uninstall',
    '--target',wrapperTarget,
  ],{
    encoding:'utf8',
    windowsHide:true,
    timeout:120000,
  });
  assert.equal(wrapperUninstall.status,0,wrapperUninstall.stderr);
  const wrapperRemoved=JSON.parse(wrapperUninstall.stdout);
  assert.equal(wrapperRemoved.status,'PASS_SUITE_COMPOSITION_UNINSTALLED');
  assert.equal(existsSync(wrapperTarget),false);
  assert.equal(
    readFileSync(join(wrapperRemoved.userDataRoot,'data/dream-maker/project.json'),'utf8'),
    '{"wrapper":"kept"}',
  );
});

test('suite installation never overwrites an existing target or a failed source check',async t=>{
  const parent=mkdtempSync(join(resolve('.runtime/test-temp'),'dm-suite-install-deny-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const core=await coreFixture(parent);
  const runtime=await runtimeFixture(parent);
  const source=join(parent,'suite-source'),existing=join(parent,'existing-suite');
  await buildSuiteComposition({
    coreRoot:core,
    runtimeRoot:runtime,
    output:source,
    builtAt:'2026-11-08T00:00:00.000Z',
  });

  mkdirSync(existing);
  writeFileSync(join(existing,'keep.txt'),'keep');
  await assert.rejects(
    ()=>installSuiteComposition({sourceRoot:source,installRoot:existing}),
    /SUITE_INSTALL_TARGET_EXISTS/,
  );
  assert.equal(readFileSync(join(existing,'keep.txt'),'utf8'),'keep');

  const failedTarget=join(parent,'not-created');
  const runtimeFile=join(source,'runtime/agent-bundle/components/codex-runtime/artifact.bin');
  const changed=readFileSync(runtimeFile);
  changed[0]^=0xff;
  writeFileSync(runtimeFile,changed);
  await assert.rejects(
    ()=>installSuiteComposition({sourceRoot:source,installRoot:failedTarget}),
    /SUITE_COMPOSITION_RUNTIME_CHANGED/,
  );
  assert.equal(existsSync(failedTarget),false);
  assert.equal(readFileSync(join(existing,'keep.txt'),'utf8'),'keep');
});
