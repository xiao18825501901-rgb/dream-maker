// Offline bundle custody tests. These files are synthetic and no binary is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {
  buildRuntimeBundle,
  verifyRuntimeBundle
} from '../../dist/server/release/windows-runtime-bundle.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const ids=['dm-controller','dreamflow-core','codex-runtime','dsh-runtime','planner1-cloud-runtime','verified-base-toolchain'];

function fixture(t, mutator=()=>{}){
  const parent=resolve('.runtime/test-temp');
  mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'dm-runtime-bundle-'));
  const evidence=join(root,'evidence'),output=join(root,'output');
  mkdirSync(evidence,{recursive:true});
  const refs=[],components=[];
  ids.forEach((id,index)=>{
    const dir=`component-${index}`,artifact=Buffer.from(`artifact:${id}`),license=Buffer.from(`license:${id}\n`),sbomValue={id};
    const sbom=Buffer.from(JSON.stringify(sbomValue)+'\n');
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
        sbom:{path:`${dir}/sbom.json`,sha256:sha(sbom)}
      },
      releaseReady:false
    };
    mutator(fragment,{dir,id,index});
    const fragmentBytes=Buffer.from(JSON.stringify(fragment,null,2)+'\n');
    writeFileSync(join(evidence,dir,'fragment.json'),fragmentBytes);
    refs.push({id,version:fragment.component.version,fragmentPath:`${dir}/fragment.json`,fragmentSha256:sha(fragmentBytes)});
    components.push({id,version:fragment.component.version,status:'PARTIAL_COMPONENT_EVIDENCE',releaseReady:false});
  });
  const index={schema:'dream-maker.release-evidence-index.v1',components:refs,releaseReady:false,completeDistribution:false};
  const indexPath=join(evidence,'index.json');
  writeFileSync(indexPath,JSON.stringify(index,null,2)+'\n');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,evidence,output,indexPath,index};
}

for(const suffix of ['artifact.bin:alternate','bad?.bin','bad*.bin','bad<name.bin','trailing.','trailing ','CON.txt','LPT1','nested/COM2.log','COM¹.txt','COM²','LPT³.log','CONIN$','CONOUT$'])test('runtime bundle rejects Windows-only unsafe source path before file access: '+suffix,async t=>{
 const f=fixture(t,(fragment,{index,dir})=>{if(index===0)fragment.component.artifact.path=dir+'/'+suffix;});
 await assert.rejects(()=>buildRuntimeBundle({evidenceRoot:f.evidence,indexPath:f.indexPath,output:f.output}),/RUNTIME_BUNDLE_PATH_INVALID/);
 assert.equal(existsSync(f.output),false);
});

test('runtime bundle preserves legal Chinese source names and AUTHORS license names',async t=>{
 const f=fixture(t,(fragment,{index,dir})=>{
  if(index===0){fragment.component.artifact.path=dir+'/运行组件.bin';fragment.component.license.path=dir+'/AUTHORS';}
 });
 writeFileSync(join(f.evidence,'component-0','运行组件.bin'),readFileSync(join(f.evidence,'component-0','artifact.bin')));
 writeFileSync(join(f.evidence,'component-0','AUTHORS'),readFileSync(join(f.evidence,'component-0','LICENSE.txt')));
 const result=await buildRuntimeBundle({evidenceRoot:f.evidence,indexPath:f.indexPath,output:f.output});
 assert.equal(result.status,'PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE');
 assert.equal((await verifyRuntimeBundle(f.output)).components,6);
});

test('shipped standalone verifier rejects Windows-invalid manifest paths before reading files',async t=>{
 const f=fixture(t);
 await buildRuntimeBundle({evidenceRoot:f.evidence,indexPath:f.indexPath,output:f.output});
 const path=join(f.output,'RUNTIME_BUNDLE_MANIFEST.json'),original=readFileSync(path,'utf8');
 for(const invalid of ['components/codex-runtime/artifact.bin:alternate','components/CON.txt']){
  const manifest=JSON.parse(original);manifest.files[0].path=invalid;writeFileSync(path,JSON.stringify(manifest));
  const result=spawnSync(process.execPath,[join(f.output,'verify-runtime-bundle.mjs')],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/RUNTIME_BUNDLE_PATH_INVALID/);
  assert.doesNotMatch(result.stderr,/ENOENT/);
 }
});

test('runtime bundle copies only pinned component bytes and remains explicitly non-release',async t=>{
  const f=fixture(t);
  const result=await buildRuntimeBundle({
    evidenceRoot:f.evidence,
    indexPath:f.indexPath,
    output:f.output,
    builtAt:'2026-11-08T00:00:00.000Z'
  });
  assert.equal(result.status,'PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE');
  assert.equal(result.components,6);
  assert.equal(result.binariesExecuted,false);
  assert.equal(result.credentialsIncluded,false);
  const manifest=JSON.parse(readFileSync(join(f.output,'RUNTIME_BUNDLE_MANIFEST.json'),'utf8'));
  assert.equal(manifest.scope,'LOCAL_RUNTIME_BYTES_NOT_REDISTRIBUTABLE_RELEASE');
  assert.equal(manifest.releaseReady,false);
  assert.equal(manifest.redistributionReviewed,false);
  assert.equal(manifest.cleanWindowsVerified,false);
  assert.equal(manifest.modelsIncluded,false);
  assert.deepEqual(manifest.components.map(c=>c.id).sort(),[...ids].sort());
  assert.equal(existsSync(join(f.output,'components','codex-runtime','artifact.bin')),true);
  const verified=await verifyRuntimeBundle(f.output);
  assert.equal(verified.status,'PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE');
  assert.equal(verified.components,6);
  const standalone=spawnSync(process.execPath,[join(f.output,'verify-runtime-bundle.mjs')],{encoding:'utf8'});
  assert.equal(standalone.status,0,standalone.stderr);
  assert.match(standalone.stdout,/PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE/);
  writeFileSync(join(f.output,'unexpected.bin'),'extra');
  await assert.rejects(()=>verifyRuntimeBundle(f.output),/RUNTIME_BUNDLE_EXTRA_FILE/);
});

test('runtime bundle rejects missing required components and duplicate ids',async t=>{
  const f=fixture(t);
  f.index.components=f.index.components.filter(c=>c.id!=='dsh-runtime');
  writeFileSync(f.indexPath,JSON.stringify(f.index));
  await assert.rejects(()=>buildRuntimeBundle({evidenceRoot:f.evidence,indexPath:f.indexPath,output:f.output}),/RUNTIME_BUNDLE_REQUIRED_COMPONENT_MISSING/);
  const g=fixture(t);
  g.index.components.push({...g.index.components[0]});
  writeFileSync(g.indexPath,JSON.stringify(g.index));
  await assert.rejects(()=>buildRuntimeBundle({evidenceRoot:g.evidence,indexPath:g.indexPath,output:g.output}),/RUNTIME_BUNDLE_COMPONENT_DUPLICATE/);
});

test('runtime bundle rejects traversal, changed fragments, wrong sizes and output collisions',async t=>{
  const f=fixture(t);
  f.index.components[0].fragmentPath='../outside.json';
  writeFileSync(f.indexPath,JSON.stringify(f.index));
  await assert.rejects(()=>buildRuntimeBundle({evidenceRoot:f.evidence,indexPath:f.indexPath,output:f.output}),/RUNTIME_BUNDLE_PATH_INVALID/);

  const g=fixture(t);
  const fragmentPath=join(g.evidence,g.index.components[0].fragmentPath);
  writeFileSync(fragmentPath,readFileSync(fragmentPath,'utf8')+' ');
  await assert.rejects(()=>buildRuntimeBundle({evidenceRoot:g.evidence,indexPath:g.indexPath,output:g.output}),/RUNTIME_BUNDLE_FRAGMENT_CHANGED/);

  const h=fixture(t,(fragment)=>fragment.component.artifact.bytes+=1);
  await assert.rejects(()=>buildRuntimeBundle({evidenceRoot:h.evidence,indexPath:h.indexPath,output:h.output}),/RUNTIME_BUNDLE_ARTIFACT_SIZE_MISMATCH/);

  mkdirSync(h.output,{recursive:true});
  await assert.rejects(()=>buildRuntimeBundle({evidenceRoot:h.evidence,indexPath:h.indexPath,output:h.output}),/RUNTIME_BUNDLE_OUTPUT_EXISTS/);
});

test('runtime bundle rejects tampered artifact and license bytes',async t=>{
  const f=fixture(t);
  const artifactPath=join(f.evidence,'component-0','artifact.bin'),artifact=readFileSync(artifactPath);
  artifact[0]^=0xff;
  writeFileSync(artifactPath,artifact);
  await assert.rejects(()=>buildRuntimeBundle({evidenceRoot:f.evidence,indexPath:f.indexPath,output:f.output}),/RUNTIME_BUNDLE_ARTIFACT_CHANGED/);

  const g=fixture(t);
  writeFileSync(join(g.evidence,'component-0','LICENSE.txt'),'changed');
  await assert.rejects(()=>buildRuntimeBundle({evidenceRoot:g.evidence,indexPath:g.indexPath,output:g.output}),/RUNTIME_BUNDLE_LICENSE_CHANGED/);
});
