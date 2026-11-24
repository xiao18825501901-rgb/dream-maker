// OFFLINE release-input tests; no account or model access.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createPortableManifest} from '../../dist/server/release/windows-portable.js';
import {snapshotSetupInput} from '../../dist/server/release/windows-setup-input.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
 const parent=mkdtempSync(join(tmpdir(),'dm-setup-input-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const source=join(parent,'source'),target=join(parent,'snapshot');mkdirSync(source);
 const payload=Buffer.from('OFFLINE_IMMUTABLE');writeFileSync(join(source,'app.txt'),payload);
 const manifest=createPortableManifest({version:'0.1.0',head:'abcdef0',nodeVersion:'v24.22.1',files:[{path:'app.txt',bytes:payload.length,sha256:sha(payload)}]});
 function save(){const bytes=JSON.stringify(manifest)+'\n';writeFileSync(join(source,'RELEASE_MANIFEST.json'),bytes);writeFileSync(join(source,'SHA256SUMS.txt'),manifest.files.map(f=>`${f.sha256}  ${f.path}`).join('\n')+`\n${sha(bytes)}  RELEASE_MANIFEST.json\n`);}
 save();return{source,target,manifest,save};
}
test('immutable input copies only manifest bytes and does not inspect mutable children',async t=>{
 const f=fixture(t);mkdirSync(join(f.source,'data'));mkdirSync(join(f.source,'temp'));
 writeFileSync(join(f.source,'data','OFFLINE_USER.json'),'OFFLINE_PRIVATE');
 const out=await snapshotSetupInput(f.source,f.target);
 assert.equal(out.packageKind,'CORE');assert.equal(out.payloadInput,'IMMUTABLE_MANIFEST_SNAPSHOT');
 assert.equal(out.verification.manifestHash,sha(readFileSync(join(f.source,'RELEASE_MANIFEST.json'))));
 assert.equal(readFileSync(join(f.target,'app.txt'),'utf8'),'OFFLINE_IMMUTABLE');
 assert.equal(existsSync(join(f.target,'data')),false);assert.equal(existsSync(join(f.target,'temp')),false);
 assert.equal(readFileSync(join(f.source,'data','OFFLINE_USER.json'),'utf8'),'OFFLINE_PRIVATE');
});
test('immutable input rejects mutable, escaping, Windows alias and duplicate entries before copying',async t=>{
 for(const path of ['data/missing.json','TEMP/missing.txt','../outside','bad\\file','NUL.txt','app.txt']){
  const f=fixture(t);f.manifest.files.push({path,bytes:1,sha256:'a'.repeat(64)});f.save();
  await assert.rejects(snapshotSetupInput(f.source,f.target),/SETUP_INPUT_(MUTABLE|PATH|DUPLICATE)/);
  assert.equal(existsSync(f.target),false);
 }
});
test('immutable input rejects missing or changed immutable bytes without a partial snapshot',async t=>{
 const f=fixture(t);writeFileSync(join(f.source,'app.txt'),'WRONG');
 await assert.rejects(snapshotSetupInput(f.source,f.target),/SETUP_INPUT_SOURCE_CHANGED/);
 assert.equal(existsSync(f.target),false);
});
test('immutable input refuses existing output without deleting it',async t=>{
 const f=fixture(t);mkdirSync(f.target);writeFileSync(join(f.target,'owner.txt'),'KEEP');
 await assert.rejects(snapshotSetupInput(f.source,f.target),/SETUP_INPUT_OUTPUT_EXISTS/);
 assert.equal(readFileSync(join(f.target,'owner.txt'),'utf8'),'KEEP');
});
test('immutable input bounds manifest before parsing and disallows input/output nesting',async t=>{
 const f=fixture(t);writeFileSync(join(f.source,'RELEASE_MANIFEST.json'),Buffer.alloc(8*1024*1024+1,32));
 await assert.rejects(snapshotSetupInput(f.source,f.target),/SETUP_INPUT_METADATA_INVALID/);
 assert.equal(existsSync(f.target),false);
 await assert.rejects(snapshotSetupInput(f.source,join(f.source,'snapshot')),/SETUP_INPUT_OUTPUT_OVERLAP/);
});
