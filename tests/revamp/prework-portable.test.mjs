// Real local package/install/rollback I/O; synthetic source/runtime, no models or user DB.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {root} from '../helpers.mjs';
import {buildPortableDirectory,verifyPortableDirectory} from '../../dist/server/release/windows-portable.js';
import {installPortableDirectory,updatePortableDirectory,rollbackPortableDirectory} from '../../dist/server/release/windows-installation.js';
const assets=['contracts/DM_PREWORK_HANDOFF_V1.schema.json','examples/prework/synthetic-handoff.json','docs/prework/PREWORK_USER_GUIDE_CN.md'];
const demoAssets=['scripts/verify-board.mjs',...['index.html','style.css','board.mjs','app.mjs','README.md'].map(p=>'examples/study-board/'+p)];
function fixture(t){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const base=mkdtempSync(resolve(parent,'prework-package-'));
 t.after(()=>rmSync(base,{recursive:true,force:true}));const source=resolve(base,'source'),runtime=resolve(base,'runtime');
 const put=(path,body)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,body);};
 for(const tree of ['dist/server','dist/web','prompts','migrations','adapters','scripts/isolation'])mkdirSync(resolve(source,tree),{recursive:true});
 for(const [path,body] of Object.entries({'package.json':'{"name":"dream-maker","version":"0.1.0"}','dist/server/main.js':'// OFFLINE','dist/server/dreamflow-main.js':'// OFFLINE','dist/server/prework/runtime.js':'// OFFLINE_PREWORK_RUNTIME','migrations/009_prework_records.sql':'-- OFFLINE_SCHEMA9'}))put(resolve(source,path),body);
 for(const path of assets)put(resolve(source,path),'OFFLINE_PUBLIC_ASSET:'+path);
 put(resolve(source,'dist/server/demo.js'),'// OFFLINE_DEMO_RUNTIME');for(const path of demoAssets)put(resolve(source,path),'OFFLINE_DEMO_ASSET:'+path);
 put(resolve(source,'docs/prework/private-notes.md'),'PRIVATE_MUST_NOT_COPY');put(resolve(source,'contracts/private.sqlite'),'PRIVATE_MUST_NOT_COPY');
 put(resolve(runtime,'node.exe'),'OFFLINE_NOT_EXECUTABLE');put(resolve(runtime,'LICENSE'),'OFFLINE_LICENSE');
 const build=async name=>{const output=resolve(base,name);await buildPortableDirectory({sourceRoot:source,nodeRoot:runtime,output,version:'0.1.0',head:'a'.repeat(40),nodeVersion:'v24.22.1'});return output;};
 return{base,source,build};
}
test('Prework core package contains only the exact public handoff assets and migration',async t=>{
 const f=fixture(t),output=await f.build('public');
 for(const path of assets)assert.equal(readFileSync(resolve(output,'app',path),'utf8'),'OFFLINE_PUBLIC_ASSET:'+path);
 for(const path of demoAssets)assert.equal(readFileSync(resolve(output,'app',path),'utf8'),'OFFLINE_DEMO_ASSET:'+path);
 assert.equal(existsSync(resolve(output,'app/migrations/009_prework_records.sql')),true);
 assert.equal(existsSync(resolve(output,'app/docs/prework/private-notes.md')),false);assert.equal(existsSync(resolve(output,'app/contracts/private.sqlite')),false);
 assert.match(readFileSync(resolve(output,'README_CN.md'),'utf8'),/PREWORK_USER_GUIDE_CN/);
 assert.equal((await verifyPortableDirectory(output)).status,'PASS_CORE_PORTABLE_ONLY');
});
test('compiled Demo cannot be packaged without its trusted verifier',async t=>{
 const f=fixture(t);unlinkSync(resolve(f.source,'scripts/verify-board.mjs'));
 await assert.rejects(f.build('no-oracle'),/PORTABLE_DEMO_ASSET_MISSING/);
});
test('Prework-enabled source fails closed on any missing public asset or migration/runtime',async t=>{
 const f=fixture(t);
 for(const [index,path] of [...assets,'migrations/009_prework_records.sql','dist/server/prework/runtime.js'].entries()){
  const file=resolve(f.source,path),before=readFileSync(file);unlinkSync(file);
  try{await assert.rejects(f.build('missing-'+index),/PORTABLE_PREWORK_ASSET_MISSING/);assert.equal(existsSync(resolve(f.base,'missing-'+index)),false);}
  finally{writeFileSync(file,before);}
 }
});
test('Prework guide travels through original install/update/rollback with user data retained',async t=>{
 const f=fixture(t),v1=await f.build('v1'),target=resolve(f.base,'installed');
 await installPortableDirectory({sourceRoot:v1,installRoot:target});
 mkdirSync(resolve(target,'data'),{recursive:true});writeFileSync(resolve(target,'data/synthetic.txt'),'SYNTHETIC_RETAINED');
 writeFileSync(resolve(f.source,assets[2]),'OFFLINE_GUIDE_V2');const v2=await f.build('v2');
 await updatePortableDirectory({sourceRoot:v2,installRoot:target});assert.equal(readFileSync(resolve(target,'app',assets[2]),'utf8'),'OFFLINE_GUIDE_V2');
 await rollbackPortableDirectory({installRoot:target});assert.equal(readFileSync(resolve(target,'app',assets[2]),'utf8'),'OFFLINE_PUBLIC_ASSET:'+assets[2]);
 assert.equal(readFileSync(resolve(target,'data/synthetic.txt'),'utf8'),'SYNTHETIC_RETAINED');
});
