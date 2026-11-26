// Actual user-scoped .lnk creation in an isolated shortcut root. No model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  createHash
} from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  buildPortableDirectory,
  verifyPortableDirectory
} from '../../dist/server/release/windows-portable.js';

const suiteRoot=resolve(process.env.DREAMMAKER_SUITE_ROOT??'F:\\DreamMakerSuite');
const powerShell=process.env.DREAMMAKER_POWERSHELL??'pwsh.exe';

function temporaryRoot(t,name){
  const parent=join(suiteRoot,'evidence','M84');
  mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,`${name}-`));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}

function fixtureSource(root){
  const source=join(root,'source'),runtime=join(root,'runtime');
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

async function shortcutPackage(root){
  const fixture=fixtureSource(root),output=join(root,'package');
  await buildPortableDirectory({
    sourceRoot:fixture.source,
    nodeRoot:fixture.runtime,
    output,
    version:'0.1.0',
    head:'a'.repeat(40),
    nodeVersion:'v24.22.1',
    builtAt:'2026-11-07T00:00:00.000Z'
  });
  assert.equal((await verifyPortableDirectory(output)).status,'PASS_CORE_PORTABLE_ONLY');
  return output;
}

function installFixture(root,name){
  const target=join(root,name);
  mkdirSync(target,{recursive:true});
  writeFileSync(join(target,'Start-DreamMaker.ps1'),'Write-Host "Dream Maker"');
  writeFileSync(join(target,'Start-DreamFlow.ps1'),'Write-Host "DreamFlow"');
  return target;
}

function runShortcutManager(packageRoot,action,installDir,shortcutRoot,allowFailure=false){
  try{
    const stdout=execFileSync(powerShell,[
      '-NoProfile',
      '-ExecutionPolicy','Bypass',
      '-File',join(packageRoot,'Manage-Shortcuts.ps1'),
      '-Action',action,
      '-InstallDir',installDir,
      '-ShortcutRoot',shortcutRoot
    ],{encoding:'utf8',windowsHide:true});
    return {status:0,report:JSON.parse(stdout.trim())};
  }catch(error){
    if(!allowFailure)throw error;
    return {status:error.status??1,stdout:String(error.stdout??''),stderr:String(error.stderr??'')};
  }
}

const fileHash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

test('shortcut manager creates, verifies, refuses conflicts and removes only its own links',async t=>{
  const root=temporaryRoot(t,'shortcut-lifecycle');
  const packageRoot=await shortcutPackage(root);
  const first=installFixture(root,'InstallOne'),second=installFixture(root,'InstallTwo');
  const shortcutRoot=join(root,'isolated-start-menu');
  const folder=join(shortcutRoot,'DreamMaker Suite');
  const maker=join(folder,'Dream Maker.lnk'),flow=join(folder,'DreamFlow.lnk');

  const created=runShortcutManager(packageRoot,'Create',first,shortcutRoot);
  assert.equal(created.status,0);
  assert.equal(created.report.verified,true);
  assert.equal(existsSync(maker),true);
  assert.equal(existsSync(flow),true);
  const firstMakerHash=fileHash(maker),firstFlowHash=fileHash(flow);

  const repeated=runShortcutManager(packageRoot,'Create',first,shortcutRoot);
  assert.equal(repeated.status,0);
  assert.equal(repeated.report.reused,2);
  assert.equal(fileHash(maker),firstMakerHash);
  assert.equal(fileHash(flow),firstFlowHash);

  const conflict=runShortcutManager(packageRoot,'Create',second,shortcutRoot,true);
  assert.notEqual(conflict.status,0);
  assert.match(conflict.stderr,/SHORTCUT_TARGET_CONFLICT/);
  assert.equal(fileHash(maker),firstMakerHash);
  assert.equal(fileHash(flow),firstFlowHash);

  const wrongRemove=runShortcutManager(packageRoot,'Remove',second,shortcutRoot);
  assert.equal(wrongRemove.status,0);
  assert.deepEqual(wrongRemove.report.removed,[]);
  assert.equal(existsSync(maker),true);
  assert.equal(existsSync(flow),true);

  const unrelated=join(folder,'Keep Me.txt');
  writeFileSync(unrelated,'keep');
  const removed=runShortcutManager(packageRoot,'Remove',first,shortcutRoot);
  assert.equal(removed.status,0);
  assert.equal(removed.report.removed.length,2);
  assert.equal(existsSync(maker),false);
  assert.equal(existsSync(flow),false);
  assert.equal(readFileSync(unrelated,'utf8'),'keep');
  assert.equal(existsSync(folder),true,'non-link files prevent directory deletion');
});

test('shortcut removal rejects a non-directory shortcut root before deleting anything',async t=>{
  const root=temporaryRoot(t,'shortcut-invalid-root');
  const packageRoot=await shortcutPackage(root);
  const install=installFixture(root,'InstallOne');
  const shortcutRoot=join(root,'not-a-directory');
  writeFileSync(shortcutRoot,'sentinel');

  const removed=runShortcutManager(
    packageRoot,
    'Remove',
    install,
    shortcutRoot,
    true,
  );
  assert.notEqual(removed.status,0);
  assert.match(removed.stderr,/SHORTCUT_ROOT_INVALID/);
  assert.equal(readFileSync(shortcutRoot,'utf8'),'sentinel');
});
