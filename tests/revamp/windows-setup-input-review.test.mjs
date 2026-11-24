// OFFLINE counterexamples from development review, not model acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve,toNamespacedPath} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {assertSetupDestinations,snapshotSetupInput} from '../../dist/server/release/windows-setup-input.js';
import {createPortableManifest} from '../../dist/server/release/windows-portable.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(t){
 const parent=fs.mkdtempSync(join(tmpdir(),'dm-setup-review-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const source=join(parent,'source'),target=join(parent,'snapshot');fs.mkdirSync(source);
 const contents=Buffer.from('OFFLINE_SYNTHETIC_BYTES'),file={path:'app.txt',bytes:contents.length,sha256:sha(contents)};
 fs.writeFileSync(join(source,'app.txt'),contents);
 const manifest=createPortableManifest({version:'0.1.0',head:'abcdef0',nodeVersion:'v24.22.1',files:[file]});
 const bytes=JSON.stringify(manifest)+'\n';fs.writeFileSync(join(source,'RELEASE_MANIFEST.json'),bytes);
 fs.writeFileSync(join(source,'SHA256SUMS.txt'),`${file.sha256}  app.txt\n${sha(bytes)}  RELEASE_MANIFEST.json\n`);
 return{parent,source,target};
}
test('Setup rejects a multi-linked file before copying (synthetic stat boundary, not NTFS proof)',async t=>{
 const f=fixture(t),original=fs.lstatSync;
 const mocked=t.mock.method(fs,'lstatSync',function(path,...args){const stat=original(path,...args);if(resolve(path)===resolve(f.source,'app.txt'))Object.defineProperty(stat,'nlink',{value:2});return stat;});
 syncBuiltinESMExports();
 try{await assert.rejects(snapshotSetupInput(f.source,f.target),/SETUP_INPUT_LINK_DENIED/);assert.equal(fs.existsSync(f.target),false);}
 finally{mocked.mock.restore();syncBuiltinESMExports();}
});
test('Setup CLI must not create receipt directories within its source',t=>{
 const f=fixture(t),output=join(f.parent,'Setup.exe'),receipt=join(f.source,'data/new/receipt.json');
 const result=spawnSync(process.execPath,['scripts/revamp/build-windows-setup.mjs','--package',f.source,'--output',output,'--receipt',receipt],{cwd:resolve('.'),encoding:'utf8',windowsHide:true,timeout:120000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/SETUP_INPUT_OUTPUT_OVERLAP/);
 assert.equal(fs.existsSync(join(f.source,'data')),false);assert.equal(fs.existsSync(output),false);
});
test('Setup bounds nested Suite checksum metadata before invoking source validators',async t=>{
 for(const nested of ['core/SHA256SUMS.txt','runtime/agent-bundle/SHA256SUMS.txt']){
  const f=fixture(t);fs.rmSync(join(f.source,'RELEASE_MANIFEST.json'));
  const coreManifest=JSON.stringify(createPortableManifest({version:'0.1.0',head:'abcdef0',nodeVersion:'v24.22.1',files:[{path:'app.txt',bytes:24,sha256:'a'.repeat(64)}]}))+'\n';
  fs.mkdirSync(join(f.source,'core'),{recursive:true});fs.writeFileSync(join(f.source,'core/RELEASE_MANIFEST.json'),coreManifest);
  fs.mkdirSync(join(f.source,'runtime/agent-bundle'),{recursive:true});
  fs.writeFileSync(join(f.source,'core/SHA256SUMS.txt'),'OFFLINE');fs.writeFileSync(join(f.source,'runtime/agent-bundle/SHA256SUMS.txt'),'OFFLINE');
  const oversized=Buffer.alloc(8*1024*1024+1,10);fs.writeFileSync(join(f.source,nested),oversized);
  fs.writeFileSync(join(f.source,'SUITE_COMPOSITION_MANIFEST.json'),JSON.stringify({files:[{path:'core/RELEASE_MANIFEST.json',bytes:Buffer.byteLength(coreManifest),sha256:sha(coreManifest)},{path:nested,bytes:oversized.length,sha256:sha(oversized)}]})+'\n');
  await assert.rejects(snapshotSetupInput(f.source,f.target),/SETUP_INPUT_METADATA_INVALID/);
  assert.equal(fs.existsSync(f.target),false);
 }
});
test('Setup rejects alternate Windows namespaces and trailing-dot directory aliases',t=>{
 const f=fixture(t);
 for(const receipt of [join(f.source+'.','data/receipt.json'),toNamespacedPath(join(f.source,'data/receipt.json'))]){
  assert.throws(()=>assertSetupDestinations(f.source,[receipt]),/SETUP_INPUT_(PATH_INVALID|OUTPUT_OVERLAP)/);
 }
 assert.equal(fs.existsSync(join(f.source,'data')),false);
});
