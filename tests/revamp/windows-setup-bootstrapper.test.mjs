// Real Windows EXE packaging checks. These do not qualify signing or a clean machine.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  buildPortableDirectory,
  verifyPortableDirectory
} from '../../dist/server/release/windows-portable.js';
import {
  buildRuntimeBundle
} from '../../dist/server/release/windows-runtime-bundle.js';
import {
  buildSuiteComposition,
  verifySuiteComposition
} from '../../dist/server/release/windows-suite-composition.js';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const builder=join(root,'scripts/revamp/build-windows-setup.mjs');
const marker=Buffer.from('DREAMMAKER_SETUP','ascii');
const csc=join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const realNodeRoot=process.env.DREAMMAKER_NODE_ROOT??'F:\\DreamMakerSuite\\runtime\\node-v24.22.1\\x\\node-v24.22.1-win-x64';
const runtimeIds=[
  'dm-controller',
  'dreamflow-core',
  'codex-runtime',
  'dsh-runtime',
  'planner1-cloud-runtime',
  'verified-base-toolchain',
];

test('setup build gives large local Suite archives a bounded timeout beyond the generic subprocess limit',()=>{
  const source=readFileSync(builder,'utf8');
  assert.match(source,/SETUP_ARCHIVE_TIMEOUT_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/);
  assert.match(source,/run\('tar\.exe',[\s\S]*?\{timeout:SETUP_ARCHIVE_TIMEOUT_MS\}/);
});

function run(file,args,options={}){
  return spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:120000,...options});
}

function trailer(file){
  const bytes=readFileSync(file);
  assert.ok(bytes.length>marker.length+40);
  assert.equal(bytes.subarray(-marker.length).toString('ascii'),marker.toString('ascii'));
  const length=Number(bytes.readBigUInt64LE(bytes.length-marker.length-8));
  const digest=bytes.subarray(bytes.length-marker.length-40,bytes.length-marker.length-8).toString('hex');
  const payloadEnd=bytes.length-marker.length-40;
  const payloadStart=payloadEnd-length;
  assert.ok(payloadStart>=0);
  return{bytes,length,digest,payload:bytes.subarray(payloadStart,payloadEnd)};
}

async function portableFixture(parent){
  const source=mkdtempSync(join(parent,'source-'));
  const nodeRoot=join(parent,'runtime');
  const output=join(parent,'portable');
  mkdirSync(nodeRoot,{recursive:true});
  copyFileSync(join(realNodeRoot,'node.exe'),join(nodeRoot,'node.exe'));
  copyFileSync(join(realNodeRoot,'LICENSE'),join(nodeRoot,'LICENSE'));
  for(const file of [
    'dist/server/release/windows-installation.js',
    'dist/server/release/windows-portable.js',
    'dist/server/release/windows-package-path.js',
    'dist/server/release/windows-runtime-bundle.js',
    'dist/server/release/windows-suite-composition.js',
    'dist/server/release/windows-suite-installation.js',
  ]) {
    mkdirSync(dirname(join(source,file)),{recursive:true});
    copyFileSync(join(root,file),join(source,file));
  }
  for(const file of ['prompts/planner1.md','migrations/001_init.sql','adapters/.keep','skills/registry.json','scripts/isolation/.keep']) {
    mkdirSync(dirname(join(source,file)),{recursive:true});
    writeFileSync(join(source,file),file);
  }
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'dream-maker',version:'0.1.0',type:'module'}));
  await buildPortableDirectory({
    sourceRoot:source,nodeRoot,output,version:'0.1.0',head:'abcdef0',
    nodeVersion:'v24.22.1',builtAt:'2026-11-08T00:00:00.000Z',sourceHash:'a'.repeat(64)
  });
  return{source,nodeRoot,output};
}

async function runtimeFixture(parent){
  const evidence=join(parent,'suite-runtime-evidence'),output=join(parent,'suite-runtime-bundle'),refs=[];
  mkdirSync(evidence,{recursive:true});
  runtimeIds.forEach((id,index)=>{
    const dir=`component-${index}`;
    const artifact=Buffer.from(`artifact:${id}`),license=Buffer.from(`license:${id}\n`);
    const sbom=Buffer.from(JSON.stringify({id})+'\n');
    mkdirSync(join(evidence,dir),{recursive:true});
    writeFileSync(join(evidence,dir,'artifact.bin'),artifact);
    writeFileSync(join(evidence,dir,'LICENSE.txt'),license);
    writeFileSync(join(evidence,dir,'sbom.json'),sbom);
    const fragment={schema:'dream-maker.release-component-fragment.v1',status:'PARTIAL_COMPONENT_EVIDENCE',componentId:id,
      component:{id,version:index===3?'0.2.0-rc.1':'1.0.0',
        source:{kind:'LOCAL_PACKAGE',locator:`fixture:${id}`,revision:`fixture-${id}`},
        artifact:{path:`${dir}/artifact.bin`,bytes:artifact.length,sha256:createHash('sha256').update(artifact).digest('hex')},
        license:{path:`${dir}/LICENSE.txt`,sha256:createHash('sha256').update(license).digest('hex')},
        sbom:{path:`${dir}/sbom.json`,sha256:createHash('sha256').update(sbom).digest('hex')}},
      releaseReady:false};
    const fragmentBytes=Buffer.from(JSON.stringify(fragment,null,2)+'\n');
    writeFileSync(join(evidence,dir,'fragment.json'),fragmentBytes);
    refs.push({id,version:fragment.component.version,fragmentPath:`${dir}/fragment.json`,
      fragmentSha256:createHash('sha256').update(fragmentBytes).digest('hex')});
  });
  const indexPath=join(evidence,'index.json');
  writeFileSync(indexPath,JSON.stringify({
    schema:'dream-maker.release-evidence-index.v1',components:refs,releaseReady:false,completeDistribution:false
  },null,2)+'\n');
  await buildRuntimeBundle({evidenceRoot:evidence,indexPath,output,builtAt:'2026-11-08T00:00:00.000Z'});
  return output;
}

function buildSetup(parent,portable){
  const output=join(parent,'DreamMaker-Setup.exe');
  const receipt=join(parent,'setup-build.json');
  const result=run(process.execPath,[builder,'--package',portable,'--output',output,'--receipt',receipt,'--csc',csc],{cwd:root});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.equal(existsSync(output),true);
  assert.equal(existsSync(receipt),true);
  return{output,receipt:JSON.parse(readFileSync(receipt,'utf8'))};
}

test('Setup refuses an existing checksum sidecar before packaging and preserves its bytes',t=>{
 const parent=mkdtempSync(join(tmpdir(),'dm-setup-owned-output-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const output=join(parent,'Setup.exe'),receipt=join(parent,'receipt.json'),sidecar=output+'.sha256';
 writeFileSync(sidecar,'OFFLINE_OWNER_CHECKSUM');
 const result=run(process.execPath,[builder,'--package',join(parent,'missing'),'--output',output,'--receipt',receipt,'--csc',csc],{cwd:root});
 assert.notEqual(result.status,0);assert.match(result.stderr,/SETUP_BUILD_SIDECAR_EXISTS/);
 assert.equal(readFileSync(sidecar,'utf8'),'OFFLINE_OWNER_CHECKSUM');assert.equal(existsSync(output),false);assert.equal(existsSync(receipt),false);
});

test('Setup payload excludes mutable data and temp from an already used verified Core',async t=>{
 const parent=mkdtempSync(join(tmpdir(),'dm-setup-private-input-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const portable=await portableFixture(parent),privateFile=join(portable.output,'data','OFFLINE_USER_DATA.json'),tempFile=join(portable.output,'temp','OFFLINE_LOG.txt');
 mkdirSync(dirname(privateFile),{recursive:true});mkdirSync(dirname(tempFile),{recursive:true});
 writeFileSync(privateFile,'OFFLINE_PRIVATE_DATA_NOT_A_REAL_ACCOUNT');writeFileSync(tempFile,'OFFLINE_TEMP_LOG');
 assert.equal((await verifyPortableDirectory(portable.output)).status,'PASS_CORE_PORTABLE_ONLY');
 const built=buildSetup(parent,portable.output),payload=join(parent,'inspection.zip');writeFileSync(payload,trailer(built.output).payload);
 const listed=run('tar.exe',['-tf',payload]);assert.equal(listed.status,0,listed.stderr);
 assert.doesNotMatch(listed.stdout,/(?:^|\/)(?:data|temp)(?:\/|$)/m,'mutable user state must never be archived');
 assert.match(listed.stdout,/RELEASE_MANIFEST\.json/);assert.match(listed.stdout,/runtime\/node\.exe/);
 assert.equal(readFileSync(privateFile,'utf8'),'OFFLINE_PRIVATE_DATA_NOT_A_REAL_ACCOUNT');assert.equal(readFileSync(tempFile,'utf8'),'OFFLINE_TEMP_LOG');
 assert.equal(built.receipt.payloadInput,'IMMUTABLE_MANIFEST_SNAPSHOT');
 const verified=run(built.output,['--verify-only']);assert.equal(verified.status,0,verified.stderr);
});

test('setup executable carries the exact verified package and supports help/verify-only',async t=>{
  if(process.platform!=='win32')return t.skip('Windows EXE test');
  const parent=mkdtempSync(join(tmpdir(),'dm-setup-exe-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const portable=await portableFixture(parent);
  const built=buildSetup(parent,portable.output);
  const inspected=trailer(built.output);
  assert.equal(inspected.length,inspected.payload.length);
  assert.equal(inspected.digest,createHash('sha256').update(inspected.payload).digest('hex'));
  assert.equal(built.receipt.payloadSha256,inspected.digest);
  assert.equal(built.receipt.setupSha256,createHash('sha256').update(readFileSync(built.output)).digest('hex'));

  const help=run(built.output,['--help']);
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/--verify-only/);

  const verify=run(built.output,['--verify-only']);
  assert.equal(verify.status,0,verify.stderr);
  const result=JSON.parse(verify.stdout);
  assert.equal(result.status,'PASS_SETUP_PAYLOAD_VERIFIED');
  assert.equal(result.installed,false);
  assert.equal(result.cleanWindows,'NOT_VERIFIED');
});

test('setup rejects a tampered payload before installation and preserves existing targets',async t=>{
  if(process.platform!=='win32')return t.skip('Windows EXE test');
  const parent=mkdtempSync(join(tmpdir(),'dm-setup-tamper-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const portable=await portableFixture(parent);
  const built=buildSetup(parent,portable.output);
  const bytes=readFileSync(built.output);
  const payloadStart=bytes.length-marker.length-40-trailer(built.output).length;
  bytes[payloadStart+Math.floor(trailer(built.output).length/2)]^=0xff;
  const tampered=join(parent,'Tampered-Setup.exe');
  writeFileSync(tampered,bytes);
  const target=join(parent,'install-target');
  mkdirSync(target);
  writeFileSync(join(target,'user-owned.txt'),'keep');
  const result=run(tampered,['--target',target,'--no-shortcuts']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/SETUP_PAYLOAD_DIGEST_MISMATCH/);
  assert.equal(readFileSync(join(target,'user-owned.txt'),'utf8'),'keep');
});

test('setup installs the verified core package into an explicit isolated target',async t=>{
  if(process.platform!=='win32')return t.skip('Windows EXE test');
  const parent=mkdtempSync(join(tmpdir(),'dm-setup-install-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const portable=await portableFixture(parent);
  const built=buildSetup(parent,portable.output);
  const target=join(parent,'DreamMakerSuite');
  const install=run(built.output,['--target',target,'--no-shortcuts']);
  assert.equal(install.status,0,install.stderr);
  const result=JSON.parse(install.stdout);
  assert.equal(result.status,'PASS_CORE_SETUP_INSTALLED');
  assert.equal(result.installed,true);
  assert.equal(result.shortcuts,false);
  assert.equal(result.cleanWindows,'NOT_VERIFIED');
  assert.equal((await verifyPortableDirectory(target)).status,'PASS_CORE_PORTABLE_ONLY');
  assert.equal(existsSync(join(target,'data','.installation','installation.json')),true);
});

test('setup never reports installed when its verified installer exits zero without publishing the target',async t=>{
 const parent=mkdtempSync(join(tmpdir(),'dm-setup-false-success-'));
 t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const portable=await portableFixture(parent),name='Setup-DreamMakerSuite.ps1';
 // Explicit synthetic broken installer; package integrity remains valid.
 const body=Buffer.from('exit 0\r\n');writeFileSync(join(portable.output,name),body);
 const manifestPath=join(portable.output,'RELEASE_MANIFEST.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 const entry=manifest.files.find(f=>f.path===name);assert.ok(entry);entry.bytes=body.length;entry.sha256=createHash('sha256').update(body).digest('hex');
 manifest.filesHash=createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
 const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');writeFileSync(manifestPath,bytes);
 writeFileSync(join(portable.output,'SHA256SUMS.txt'),[...manifest.files,{path:'RELEASE_MANIFEST.json',sha256:createHash('sha256').update(bytes).digest('hex')}]
  .sort((a,b)=>a.path.localeCompare(b.path,'en')).map(f=>`${f.sha256}  ${f.path}`).join('\n')+'\n');
 assert.equal((await verifyPortableDirectory(portable.output)).status,'PASS_CORE_PORTABLE_ONLY');
 const built=buildSetup(parent,portable.output),target=join(parent,'MissingTarget'),installed=run(built.output,['--target',target,'--no-shortcuts']);
 assert.notEqual(installed.status,0,'a zero exit is not proof of installation: '+installed.stdout);
 assert.match(installed.stderr,/SETUP_PACKAGE_VERIFIER_MISSING|SETUP_PACKAGE_VERIFY_FAILED/);
 assert.doesNotMatch(installed.stdout,/PASS_CORE_SETUP_INSTALLED/);assert.equal(existsSync(target),false);
});

test('setup verifies and installs a complete verified Suite composition',async t=>{
  if(process.platform!=='win32')return t.skip('Windows EXE test');
  const parent=mkdtempSync(join(tmpdir(),'dm-suite-setup-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const portable=await portableFixture(parent);
  const runtime=await runtimeFixture(parent);
  const suite=join(parent,'suite');
  await buildSuiteComposition({coreRoot:portable.output,runtimeRoot:runtime,output:suite,builtAt:'2026-11-08T00:00:00.000Z'});

  const privateFile=join(suite,'core/data/OFFLINE_PRIVATE.json');mkdirSync(dirname(privateFile),{recursive:true});
  writeFileSync(privateFile,'OFFLINE_SUITE_PRIVATE');mkdirSync(join(suite,'core/temp'),{recursive:true});
  writeFileSync(join(suite,'core/temp/OFFLINE.log'),'OFFLINE_SUITE_TEMP');

  const built=buildSetup(parent,suite);
  const payload=join(parent,'inspection.zip');writeFileSync(payload,trailer(built.output).payload);
  const listed=run('tar.exe',['-tf',payload]);assert.equal(listed.status,0,listed.stderr);
  assert.doesNotMatch(listed.stdout,/\/core\/(?:data|temp)(?:\/|$)/m);
  assert.equal(readFileSync(privateFile,'utf8'),'OFFLINE_SUITE_PRIVATE');
  assert.equal(built.receipt.payloadInput,'IMMUTABLE_MANIFEST_SNAPSHOT');
  const verify=run(built.output,['--verify-only']);
  assert.equal(verify.status,0,verify.stderr);
  const verified=JSON.parse(verify.stdout);
  assert.equal(verified.status,'PASS_SETUP_PAYLOAD_VERIFIED');
  assert.equal(verified.packageKind,'SUITE');
  assert.equal(verified.installed,false);

  const target=join(parent,'InstalledDreamMakerSuite');
  const install=run(built.output,['--target',target,'--no-shortcuts']);
  assert.equal(install.status,0,install.stderr);
  const installed=JSON.parse(install.stdout);
  assert.equal(installed.status,'PASS_SUITE_SETUP_INSTALLED');
  assert.equal(installed.packageKind,'SUITE');
  assert.equal(installed.installed,true);
  assert.equal((await verifySuiteComposition(target)).installerScope,'LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL');

  // Canonical validators historically allow blank checksum lines. Keep the input
  // valid while checking the Setup boundary rejects oversized nested metadata.
  for(const nested of ['core/SHA256SUMS.txt','runtime/agent-bundle/SHA256SUMS.txt']){
    const checksumPath=join(suite,nested),old=readFileSync(checksumPath);
    writeFileSync(checksumPath,Buffer.concat([old,Buffer.alloc(8*1024*1024+1,10)]));
    const manifestPath=join(suite,'SUITE_COMPOSITION_MANIFEST.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    const entry=manifest.files.find(file=>file.path===nested);entry.bytes=readFileSync(checksumPath).length;
    entry.sha256=createHash('sha256').update(readFileSync(checksumPath)).digest('hex');
    manifest.filesHash=createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
    const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');writeFileSync(manifestPath,bytes);
    writeFileSync(join(suite,'SHA256SUMS.txt'),[...manifest.files,{path:'SUITE_COMPOSITION_MANIFEST.json',sha256:createHash('sha256').update(bytes).digest('hex')}]
      .sort((a,b)=>a.path.localeCompare(b.path,'en')).map(f=>`${f.sha256}  ${f.path}`).join('\n')+'\n');
    assert.equal((await verifySuiteComposition(suite)).status,'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE');
    const result=run(process.execPath,[builder,'--package',suite,'--output',join(parent,'Rejected.exe'),'--receipt',join(parent,'Rejected.json'),'--csc',csc],{cwd:root});
    assert.notEqual(result.status,0);assert.match(result.stderr,/SETUP_INPUT_METADATA_INVALID/);
    assert.equal(existsSync(join(parent,'Rejected.exe')),false);assert.equal(existsSync(join(parent,'Rejected.json')),false);
    writeFileSync(checksumPath,old);
    // Restore the outer bytes from the exact original build, not a new approval.
    const installedManifest=readFileSync(join(target,'SUITE_COMPOSITION_MANIFEST.json'));
    writeFileSync(manifestPath,installedManifest);writeFileSync(join(suite,'SHA256SUMS.txt'),readFileSync(join(target,'SHA256SUMS.txt')));
  }
});
