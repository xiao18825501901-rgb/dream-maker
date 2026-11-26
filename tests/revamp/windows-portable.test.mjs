// Offline portable-layout tests. These do not qualify native roles or a clean-machine release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPortableManifest,buildPortableDirectory,verifyPortableDirectory} from '../../dist/server/release/windows-portable.js';

const hash=character=>character.repeat(64);
test('portable rejects superscript Windows device aliases while allowing ordinary numbered names',()=>{
 const base={version:'0.1.0',head:'f'.repeat(40),nodeVersion:'v24.22.1',builtAt:'2026-11-08T00:00:00.000Z'};
 for(const name of ['COM¹.txt','COM²','LPT³.log','CONIN$','CONOUT$'])assert.throws(()=>createPortableManifest({...base,files:[{path:'app/'+name,bytes:1,sha256:hash('a')}]}),/PORTABLE_PATH_INVALID/);
 assert.equal(createPortableManifest({...base,files:[{path:'app/COM10.txt',bytes:1,sha256:hash('a')}]}).files.length,1);
});
test('portable manifest rejects traversal, duplicates, malformed hashes and invalid sizes',()=>{
 const base={version:'0.1.0',head:'f'.repeat(40),nodeVersion:'v24.22.1',builtAt:'2026-11-07T00:00:00.000Z'};
 assert.throws(()=>createPortableManifest({...base,files:[{path:'../secret',bytes:1,sha256:hash('a')}]}));
 assert.throws(()=>createPortableManifest({...base,files:[{path:'C:/secret',bytes:1,sha256:hash('a')}]}));
 assert.throws(()=>createPortableManifest({...base,files:[{path:'app/a.js',bytes:1,sha256:hash('a')},{path:'app/a.js',bytes:1,sha256:hash('a')}]}));
 assert.throws(()=>createPortableManifest({...base,files:[{path:'app/A.js',bytes:1,sha256:hash('a')},{path:'app/a.js',bytes:1,sha256:hash('b')}]}));
 assert.throws(()=>createPortableManifest({...base,files:[{path:'app/a.js',bytes:1,sha256:'a'.repeat(63)}]}));
 assert.throws(()=>createPortableManifest({...base,files:[{path:'app/a.js',bytes:-1,sha256:hash('a')}]}));
 const manifest=createPortableManifest({...base,files:[{path:'app/b.js',bytes:2,sha256:hash('b')},{path:'app/a.js',bytes:1,sha256:hash('a')}]});
 assert.deepEqual(manifest.files.map(file=>file.path),['app/a.js','app/b.js']);
 assert.equal(manifest.scope,'CORE_LOCAL_UI_AND_PROJECT_STATE_NOT_FULL_NATIVE_RELEASE');
 assert.equal(manifest.capabilities.nativeRoleRuntimes,'NOT_BUNDLED');
 assert.equal(manifest.capabilities.cleanWindowsVerified,false);
});

test('portable builder copies only allowed core assets, excludes local secrets and writes a verifiable manifest',async t=>{
 const root=join(tmpdir(),'dm-portable-test-'+process.pid+'-'+Date.now());
 const source=join(root,'source'),runtime=join(root,'runtime'),output=join(root,'output');
 mkdirSync(join(source,'dist/server'),{recursive:true});
 mkdirSync(join(source,'dist/web'),{recursive:true});
 mkdirSync(join(source,'prompts'),{recursive:true});
 mkdirSync(join(source,'migrations'),{recursive:true});
 mkdirSync(join(source,'adapters'),{recursive:true});
 mkdirSync(join(source,'skills'),{recursive:true});
  mkdirSync(join(source,'scripts/isolation'),{recursive:true});
 mkdirSync(join(source,'scripts/isolation/__pycache__'),{recursive:true});
 mkdirSync(join(source,'config'),{recursive:true});
 mkdirSync(join(source,'.runtime'),{recursive:true});
 mkdirSync(runtime,{recursive:true});
 writeFileSync(join(source,'package.json'),JSON.stringify({name:'dream-maker',version:'0.1.0'}));
 writeFileSync(join(source,'dist/server/main.js'),'console.log("dm")');
 writeFileSync(join(source,'dist/server/dreamflow-main.js'),'console.log("df")');
 writeFileSync(join(source,'dist/web/index.html'),'<!doctype html>');
 writeFileSync(join(source,'prompts/planner1.md'),'planner');
 writeFileSync(join(source,'migrations/001_initial.sql'),'select 1;');
 writeFileSync(join(source,'adapters/example.mjs'),'export {};');
 writeFileSync(join(source,'scripts/isolation/helper.py'),'print("safe")');
 writeFileSync(join(source,'scripts/isolation/helper.pyc'),'DO_NOT_COPY_BYTECODE');
 writeFileSync(join(source,'scripts/isolation/__pycache__/helper.cpython-311.pyc'),'DO_NOT_COPY_CACHE');
 writeFileSync(join(source,'config/local.example.json'),'{}');
 writeFileSync(join(source,'config/local.json'),JSON.stringify({secret:'DO_NOT_COPY'}));
 writeFileSync(join(source,'.runtime/user.sqlite'),'DO_NOT_COPY');
 writeFileSync(join(runtime,'node.exe'),'OFFLINE_NODE_STUB');
 writeFileSync(join(runtime,'LICENSE'),'OFFLINE NODE LICENSE');
 const built=await buildPortableDirectory({sourceRoot:source,nodeRoot:runtime,output:output,version:'0.1.0',head:'a'.repeat(40),nodeVersion:'v24.22.1',builtAt:'2026-11-07T00:00:00.000Z'});
 assert.equal(existsSync(join(output,'app/config/local.json')),false);
 assert.equal(existsSync(join(output,'.runtime')),false);
 assert.equal(existsSync(join(output,'app/scripts/isolation/helper.pyc')),false);
 assert.equal(existsSync(join(output,'app/scripts/isolation/__pycache__')),false);
 assert.equal(existsSync(join(output,'app/config/local.example.json')),true);
 assert.equal(existsSync(join(output,'runtime/node.exe')),true);
 assert.equal(existsSync(join(output,'Start-DreamMaker.ps1')),true);
 assert.equal(existsSync(join(output,'Start-DreamFlow.ps1')),true);
 assert.equal(existsSync(join(output,'Setup-DreamMakerSuite.ps1')),true);
 assert.equal(existsSync(join(output,'Update-DreamMakerSuite.ps1')),true);
 assert.equal(existsSync(join(output,'Rollback-DreamMakerSuite.ps1')),true);
 assert.equal(existsSync(join(output,'Uninstall-DreamMakerSuite.ps1')),true);
 assert.equal(existsSync(join(output,'Get-DreamMakerSuiteStatus.ps1')),true);
 assert.equal(existsSync(join(output,'Manage-Shortcuts.ps1')),true);
 assert.equal(existsSync(join(output,'manage-installation.mjs')),true);
 assert.equal(existsSync(join(output,'Verify-Portable.ps1')),true);
 assert.match(readFileSync(join(output,'Start-DreamMaker.ps1'),'utf8'),/#bootstrap=/);
 assert.match(readFileSync(join(output,'Start-DreamFlow.ps1'),'utf8'),/#bootstrap=/);
 assert.match(readFileSync(join(output,'Start-DreamMaker.ps1'),'utf8'),/Push-Location \$app/);
 assert.match(readFileSync(join(output,'Setup-DreamMakerSuite.ps1'),'utf8'),/manage-installation\.mjs/);
 assert.match(readFileSync(join(output,'Setup-DreamMakerSuite.ps1'),'utf8'),/Manage-Shortcuts\.ps1.*Create/s);
 assert.match(readFileSync(join(output,'Update-DreamMakerSuite.ps1'),'utf8'),/update --target/);
 assert.match(readFileSync(join(output,'Uninstall-DreamMakerSuite.ps1'),'utf8'),/uninstall --target/);
 assert.match(readFileSync(join(output,'Uninstall-DreamMakerSuite.ps1'),'utf8'),/Manage-Shortcuts\.ps1.*Remove/s);
 for(const name of [
   'Start-DreamMaker.ps1','Start-DreamFlow.ps1','Setup-DreamMakerSuite.ps1',
   'Update-DreamMakerSuite.ps1','Rollback-DreamMakerSuite.ps1',
   'Uninstall-DreamMakerSuite.ps1','Get-DreamMakerSuiteStatus.ps1',
   'Manage-Shortcuts.ps1','Verify-Portable.ps1'
 ]){
   const bytes=readFileSync(join(output,name));
   assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf],`${name} must include a UTF-8 BOM for Windows PowerShell 5.1`);
 }
 assert.match(readFileSync(join(output,'manage-installation.mjs'),'utf8'),/installPortableDirectory/);
 assert.match(readFileSync(join(output,'README_CN.md'),'utf8'),/-CreateShortcuts/);
 assert.doesNotMatch(readFileSync(join(output,'README_CN.md'),'utf8'),/DO_NOT_COPY/);
 const verified=await verifyPortableDirectory(output);
 assert.equal(verified.status,'PASS_CORE_PORTABLE_ONLY');
 assert.equal(verified.files,built.files);
 assert.equal(verified.capabilities.nativeRoleRuntimes,'NOT_BUNDLED');
 mkdirSync(join(output,'data/dream-maker'),{recursive:true});
 writeFileSync(join(output,'data/dream-maker/runtime-state.json'),'{"ok":true}');
 mkdirSync(join(output,'temp'),{recursive:true});
 writeFileSync(join(output,'temp/runtime.tmp'),'mutable');
 assert.equal((await verifyPortableDirectory(output)).status,'PASS_CORE_PORTABLE_ONLY');
 writeFileSync(join(output,'extra-file.txt'),'UNEXPECTED');
 await assert.rejects(()=>verifyPortableDirectory(output),/PORTABLE_EXTRA_FILE/);
});
