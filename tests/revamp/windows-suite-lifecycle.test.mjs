// Offline suite lifecycle tests. They never execute a bundled runtime or
// open a real product data store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {
  buildSuiteComposition,
  verifySuiteComposition,
} from '../../dist/server/release/windows-suite-composition.js';
import {
  installSuiteComposition,
  rollbackSuiteComposition,
  uninstallSuiteComposition,
  updateSuiteComposition,
} from '../../dist/server/release/windows-suite-installation.js';
import {buildPortableDirectory} from '../../dist/server/release/windows-portable.js';
import {buildRuntimeBundle} from '../../dist/server/release/windows-runtime-bundle.js';

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

function temporaryRoot(t){
  const parent=join(resolve('.runtime/test-temp'),'dm-suite-lifecycle');
  mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}

function useFreshInstallOnlyManifest(root){
  const manifestPath=join(root,'SUITE_COMPOSITION_MANIFEST.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  manifest.installer.scope='FRESH_LOCAL_SUITE_INSTALL_ONLY';
  manifest.installer.update=false;
  manifest.installer.rollback=false;
  manifest.installer.uninstall=false;
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  writeFileSync(manifestPath,manifestBytes);
  const sums=[
    ...manifest.files.map(file=>
      `${file.sha256}  ${file.path}`),
    `${sha(manifestBytes)}  SUITE_COMPOSITION_MANIFEST.json`,
  ];
  writeFileSync(join(root,'SHA256SUMS.txt'),sums.join('\n')+'\n');
}

function useLegacyLifecycleManifest(root){
  const manifestPath=join(root,'SUITE_COMPOSITION_MANIFEST.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(manifest.installer?.scope!=='LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL')
    throw new Error('LEGACY_MANIFEST_FIXTURE_SCOPE');
  delete manifest.installer.rollback;
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  writeFileSync(manifestPath,manifestBytes);
  const sums=[
    ...manifest.files.map(file=>
      `${file.sha256}  ${file.path}`),
    `${sha(manifestBytes)}  SUITE_COMPOSITION_MANIFEST.json`,
  ];
  writeFileSync(join(root,'SHA256SUMS.txt'),sums.join('\n')+'\n');
}

async function coreFixture(parent,version){
  const source=join(parent,`core-source-${version}`),nodeRoot=join(parent,`node-runtime-${version}`),output=join(parent,`core-${version}`);
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
  writeFileSync(join(source,'dist/server/main.js'),`console.log(${JSON.stringify(version)})`);
  writeFileSync(join(source,'dist/server/dreamflow-main.js'),`console.log(${JSON.stringify(`df-${version}`)})`);
  writeFileSync(join(source,'dist/web/index.html'),'<!doctype html>');
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'dream-maker',version,type:'module'}));
  mkdirSync(nodeRoot,{recursive:true});
  copyFileSync(join(realNodeRoot,'node.exe'),join(nodeRoot,'node.exe'));
  copyFileSync(join(realNodeRoot,'LICENSE'),join(nodeRoot,'LICENSE'));
  await buildPortableDirectory({
    sourceRoot:source,
    nodeRoot,
    output,
    version,
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

test('legacy lifecycle suite updates to rollback-capable candidate and preserves user data',async t=>{
  const root=temporaryRoot(t);
  const firstCore=await coreFixture(root,'0.1.0');
  const secondCore=await coreFixture(root,'0.2.0');
  const runtime=await runtimeFixture(root);
  const first=join(root,'suite-v1');
  const second=join(root,'suite-v2');
  await buildSuiteComposition({coreRoot:firstCore,runtimeRoot:runtime,output:first,builtAt:'2026-11-08T00:00:00.000Z'});
  await buildSuiteComposition({coreRoot:secondCore,runtimeRoot:runtime,output:second,builtAt:'2026-11-08T00:00:00.000Z'});

  const installed=join(root,'DreamMakerSuite');
  await installSuiteComposition({sourceRoot:first,installRoot:installed});
  useLegacyLifecycleManifest(installed);
  assert.equal(
    (await verifySuiteComposition(installed)).installerScope,
    'LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL',
  );
  mkdirSync(join(installed,'core/data/dream-maker'),{recursive:true});
  writeFileSync(join(installed,'core/data/dream-maker/project.json'),'{"title":"kept"}');
  mkdirSync(join(installed,'core/temp'),{recursive:true});
  writeFileSync(join(installed,'core/temp/run.log'),'before update');

  const updated=await updateSuiteComposition({sourceRoot:second,installRoot:installed});
  assert.equal(updated.status,'PASS_SUITE_COMPOSITION_UPDATED');
  assert.equal(updated.version,'0.2.0');
  assert.equal(existsSync(updated.rollbackRoot),true);
  assert.equal(existsSync(updated.coreRollbackRoot),true);
  assert.equal(readFileSync(join(installed,'core/data/dream-maker/project.json'),'utf8'),'{"title":"kept"}');
  assert.equal(readFileSync(join(installed,'core/temp/run.log'),'utf8'),'before update');
  writeFileSync(join(installed,'core/data/dream-maker/after-update.json'),'{"after":"update"}');

  const rolledBack=await rollbackSuiteComposition({installRoot:installed});
  assert.equal(rolledBack.status,'PASS_SUITE_COMPOSITION_ROLLED_BACK');
  assert.equal(rolledBack.version,'0.1.0');
  assert.equal(existsSync(rolledBack.failedUpdateRoot),true);
  assert.equal((await verifySuiteComposition(installed)).status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
  assert.equal(readFileSync(join(installed,'core/data/dream-maker/project.json'),'utf8'),'{"title":"kept"}');
  assert.equal(readFileSync(join(installed,'core/data/dream-maker/after-update.json'),'utf8'),'{"after":"update"}');
  assert.equal(readFileSync(join(installed,'core/temp/run.log'),'utf8'),'before update');
  assert.equal(existsSync(join(installed,'core/data/.installation/suite-rollback.json')),false);

  const removed=await uninstallSuiteComposition({installRoot:installed});
  assert.equal(removed.status,'PASS_SUITE_COMPOSITION_UNINSTALLED');
  assert.equal(existsSync(installed),false);
  assert.equal(existsSync(removed.userDataRoot),true);
  assert.equal(readFileSync(join(removed.userDataRoot,'data/dream-maker/project.json'),'utf8'),'{"title":"kept"}');
  assert.equal(readFileSync(join(removed.userDataRoot,'data/dream-maker/after-update.json'),'utf8'),'{"after":"update"}');
  assert.equal(readFileSync(join(removed.userDataRoot,'temp/run.log'),'utf8'),'before update');
  assert.equal(existsSync(join(removed.userDataRoot,'data/.installation/uninstalled.json')),true);
});

test('suite update refuses a target package without rollback capability',async t=>{
  const root=temporaryRoot(t);
  const firstCore=await coreFixture(root,'0.1.0');
  const secondCore=await coreFixture(root,'0.2.0');
  const runtime=await runtimeFixture(root);
  const first=join(root,'suite-v1');
  const second=join(root,'suite-v2');
  const installed=join(root,'DreamMakerSuite');
  await buildSuiteComposition({coreRoot:firstCore,runtimeRoot:runtime,output:first,builtAt:'2026-11-08T00:00:00.000Z'});
  await buildSuiteComposition({coreRoot:secondCore,runtimeRoot:runtime,output:second,builtAt:'2026-11-08T00:00:00.000Z'});
  await installSuiteComposition({sourceRoot:first,installRoot:installed});
  useLegacyLifecycleManifest(second);

  const before=readFileSync(join(installed,'SUITE_COMPOSITION_MANIFEST.json'));
  await assert.rejects(
    ()=>updateSuiteComposition({sourceRoot:second,installRoot:installed}),
    /SUITE_ROLLBACK_CAPABILITY_REQUIRED/,
  );
  assert.equal(sha(readFileSync(join(installed,'SUITE_COMPOSITION_MANIFEST.json'))),sha(before));
  assert.equal(existsSync(join(installed,'core')),true);
});

test('suite update refuses an active product and a changed source without touching the installation',async t=>{
  const root=temporaryRoot(t);
  const firstCore=await coreFixture(root,'0.1.0');
  const secondCore=await coreFixture(root,'0.2.0');
  const runtime=await runtimeFixture(root);
  const first=join(root,'suite-v1'),second=join(root,'suite-v2'),installed=join(root,'DreamMakerSuite');
  await buildSuiteComposition({coreRoot:firstCore,runtimeRoot:runtime,output:first,builtAt:'2026-11-08T00:00:00.000Z'});
  await buildSuiteComposition({coreRoot:secondCore,runtimeRoot:runtime,output:second,builtAt:'2026-11-08T00:00:00.000Z'});
  await installSuiteComposition({sourceRoot:first,installRoot:installed});

  mkdirSync(join(installed,'core/data/dream-maker'),{recursive:true});
  const manifestBefore=readFileSync(join(installed,'SUITE_COMPOSITION_MANIFEST.json'));
  writeFileSync(join(installed,'core/data/dream-maker/server.lock'),'{"active":true}');
  await assert.rejects(
    ()=>updateSuiteComposition({sourceRoot:second,installRoot:installed}),
    /SUITE_INSTALL_ACTIVE/,
  );
  assert.equal(sha(readFileSync(join(installed,'SUITE_COMPOSITION_MANIFEST.json'))),sha(manifestBefore));

  rmSync(join(installed,'core/data/dream-maker/server.lock'));
  writeFileSync(join(second,'runtime/agent-bundle/components/codex-runtime/artifact.bin'),'tampered');
  await assert.rejects(
    ()=>updateSuiteComposition({sourceRoot:second,installRoot:installed}),
    /SUITE_COMPOSITION_RUNTIME_CHANGED|SUITE_COMPOSITION_FILE_CHANGED/,
  );
  assert.equal(existsSync(join(installed,'core')),true);
});

test('suite update rollback-pointer failure restores the original installation data',async t=>{
  const root=temporaryRoot(t);
  const firstCore=await coreFixture(root,'0.1.0');
  const secondCore=await coreFixture(root,'0.2.0');
  const runtime=await runtimeFixture(root);
  const first=join(root,'suite-v1'),second=join(root,'suite-v2'),installed=join(root,'DreamMakerSuite');
  await buildSuiteComposition({coreRoot:firstCore,runtimeRoot:runtime,output:first,builtAt:'2026-11-08T00:00:00.000Z'});
  await buildSuiteComposition({coreRoot:secondCore,runtimeRoot:runtime,output:second,builtAt:'2026-11-08T00:00:00.000Z'});
  await installSuiteComposition({sourceRoot:first,installRoot:installed});
  mkdirSync(join(installed,'core/data/dream-maker'),{recursive:true});
  writeFileSync(join(installed,'core/data/dream-maker/project.json'),'{"title":"only-copy"}');
  mkdirSync(join(installed,'core/temp'),{recursive:true});
  writeFileSync(join(installed,'core/temp/run.log'),'keep me');

  // The update has already switched to the staged package when this directory
  // makes the rollback-pointer write fail. The old installation is still the
  // only copy of the user's data, so it must be restored.
  mkdirSync(join(installed,'core/data/.installation/suite-rollback.json'),{recursive:true});

  await assert.rejects(
    ()=>updateSuiteComposition({sourceRoot:second,installRoot:installed}),
    /EISDIR|EPERM|EACCES|ENOTEMPTY/,
  );
  assert.equal(existsSync(installed),true);
  assert.equal(
    readFileSync(join(installed,'core/data/dream-maker/project.json'),'utf8'),
    '{"title":"only-copy"}',
  );
  assert.equal(readFileSync(join(installed,'core/temp/run.log'),'utf8'),'keep me');
  assert.equal((await verifySuiteComposition(installed)).status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
  assert.equal(
    readdirSync(root).some(name=>name.startsWith('.DreamMakerSuite.suite-failed-update-')),
    true,
  );
});

test('suite rollback refuses active products and missing or tampered pointers',async t=>{
  const root=temporaryRoot(t);
  const firstCore=await coreFixture(root,'0.1.0');
  const secondCore=await coreFixture(root,'0.2.0');
  const runtime=await runtimeFixture(root);
  const first=join(root,'suite-v1'),second=join(root,'suite-v2'),installed=join(root,'DreamMakerSuite');
  await buildSuiteComposition({coreRoot:firstCore,runtimeRoot:runtime,output:first,builtAt:'2026-11-08T00:00:00.000Z'});
  await buildSuiteComposition({coreRoot:secondCore,runtimeRoot:runtime,output:second,builtAt:'2026-11-08T00:00:00.000Z'});
  await installSuiteComposition({sourceRoot:first,installRoot:installed});
  await updateSuiteComposition({sourceRoot:second,installRoot:installed});

  const pointerPath=join(installed,'core/data/.installation/suite-rollback.json');
  const original=readFileSync(pointerPath);
  mkdirSync(join(installed,'core/data/dream-maker'),{recursive:true});
  writeFileSync(join(installed,'core/data/dream-maker/server.lock'),'{"active":true}');
  await assert.rejects(
    ()=>rollbackSuiteComposition({installRoot:installed}),
    /SUITE_INSTALL_ACTIVE/,
  );
  rmSync(join(installed,'core/data/dream-maker/server.lock'));

  const tampered=JSON.parse(original.toString('utf8'));
  tampered.currentVersion='9.9.9';
  writeFileSync(pointerPath,JSON.stringify(tampered,null,2)+'\n');
  await assert.rejects(
    ()=>rollbackSuiteComposition({installRoot:installed}),
    /SUITE_ROLLBACK_POINTER_INVALID/,
  );

  writeFileSync(pointerPath,original);
  rmSync(pointerPath);
  await assert.rejects(
    ()=>rollbackSuiteComposition({installRoot:installed}),
    /SUITE_ROLLBACK_POINTER_MISSING/,
  );
  assert.equal((await verifySuiteComposition(installed)).status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
});

test('fresh-install-only suites cannot enter the new update or uninstall lifecycle',async t=>{
  const root=temporaryRoot(t);
  const firstCore=await coreFixture(root,'0.1.0');
  const secondCore=await coreFixture(root,'0.2.0');
  const runtime=await runtimeFixture(root);
  const first=join(root,'suite-v1'),second=join(root,'suite-v2');
  const installed=join(root,'DreamMakerSuite'),installedFresh=join(root,'DreamMakerSuiteFresh');
  await buildSuiteComposition({coreRoot:firstCore,runtimeRoot:runtime,output:first,builtAt:'2026-11-08T00:00:00.000Z'});
  await buildSuiteComposition({coreRoot:secondCore,runtimeRoot:runtime,output:second,builtAt:'2026-11-08T00:00:00.000Z'});

  await installSuiteComposition({sourceRoot:first,installRoot:installed});
  const installedBefore=sha(readFileSync(join(installed,'SUITE_COMPOSITION_MANIFEST.json')));
  useFreshInstallOnlyManifest(second);
  await assert.rejects(
    ()=>updateSuiteComposition({sourceRoot:second,installRoot:installed}),
    /SUITE_LIFECYCLE_CAPABILITY_REQUIRED/,
  );
  assert.equal(sha(readFileSync(join(installed,'SUITE_COMPOSITION_MANIFEST.json'))),installedBefore);
  assert.equal(existsSync(join(installed,'core')),true);

  await installSuiteComposition({sourceRoot:first,installRoot:installedFresh});
  useFreshInstallOnlyManifest(installedFresh);
  const freshBefore=sha(readFileSync(join(installedFresh,'SUITE_COMPOSITION_MANIFEST.json')));
  await assert.rejects(
    ()=>updateSuiteComposition({sourceRoot:first,installRoot:installedFresh}),
    /SUITE_LIFECYCLE_CAPABILITY_REQUIRED/,
  );
  await assert.rejects(
    ()=>uninstallSuiteComposition({installRoot:installedFresh}),
    /SUITE_LIFECYCLE_CAPABILITY_REQUIRED/,
  );
  assert.equal(sha(readFileSync(join(installedFresh,'SUITE_COMPOSITION_MANIFEST.json'))),freshBefore);
  assert.equal(existsSync(installedFresh),true);
});

test('uninstall receipt failure keeps the original installation data intact',async t=>{
  const root=temporaryRoot(t);
  const core=await coreFixture(root,'0.1.0');
  const runtime=await runtimeFixture(root);
  const source=join(root,'suite-v1'),installed=join(root,'DreamMakerSuite');
  await buildSuiteComposition({
    coreRoot:core,
    runtimeRoot:runtime,
    output:source,
    builtAt:'2026-11-08T00:00:00.000Z',
  });
  await installSuiteComposition({sourceRoot:source,installRoot:installed});
  mkdirSync(join(installed,'core/data/dream-maker'),{recursive:true});
  writeFileSync(join(installed,'core/data/dream-maker/project.json'),'{"title":"only-copy"}');
  mkdirSync(join(installed,'core/temp'),{recursive:true});
  writeFileSync(join(installed,'core/temp/run.log'),'keep me');
  mkdirSync(join(installed,'core/data/.installation'),{recursive:true});
  writeFileSync(
    join(installed,'core/data/.installation/suite-uninstalled.json'),
    '{"preexisting":true}\n',
  );

  await assert.rejects(
    ()=>uninstallSuiteComposition({installRoot:installed}),
    /SUITE_INSTALL_RECEIPT_EXISTS/,
  );
  assert.equal(existsSync(installed),true);
  assert.equal(
    readFileSync(join(installed,'core/data/dream-maker/project.json'),'utf8'),
    '{"title":"only-copy"}',
  );
  assert.equal(readFileSync(join(installed,'core/temp/run.log'),'utf8'),'keep me');
  assert.equal((await verifySuiteComposition(installed)).status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
});

