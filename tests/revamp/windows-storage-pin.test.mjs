// Actual user-level Windows file handle test. No credentials, model, account or shared config.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,rmSync,existsSync,writeFileSync} from 'node:fs';import {join,resolve,relative} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {childEnv,hash} from '../../dist/server/security.js';
// The pin refuses any directory outside the scopes its caller approved. The product always passes
// DM_STORAGE_CUSTODY_SCOPES down; a test that mints its own temp root has to do the same, or the
// refusal it provokes is about the test's own temp path rather than the boundary under test.
const approvedScopes = () => [resolve(tmpdir()), resolve('F:/DreamMakerSuite')].join(';');
test('fixed directory handles deny ancestor/target rename until disposal and reject out-of-scope syntax',()=>{
 assert.equal(process.platform,'win32','This product test requires the target Windows machine');
 const source=resolve('scripts/isolation/windows-storage-pin.cs');assert.equal(existsSync(source),true,'MISSING_WINDOWS_STORAGE_PIN_LIBRARY');
 const base=mkdtempSync(join(tmpdir(),'dm-storage-pin-')),parent=join(base,'parent'),leaf=join(parent,'leaf');mkdirSync(leaf,{recursive:true});
 const command=String.raw`$ErrorActionPreference='Stop'
Add-Type -Path $env:DM_STORAGE_PIN_SOURCE
$lease=[DreamMaker.StorageDirectoryPin]::Acquire($env:DM_STORAGE_PIN_LEAF)
try {
 $ancestorDenied=$false;try{[System.IO.Directory]::Move($env:DM_STORAGE_PIN_PARENT,$env:DM_STORAGE_PIN_PARENT+'-moved')}catch [System.IO.IOException]{$ancestorDenied=$true}
 if(-not $ancestorDenied){[System.IO.Directory]::Move($env:DM_STORAGE_PIN_PARENT+'-moved',$env:DM_STORAGE_PIN_PARENT)}
 $leafDenied=$false;try{[System.IO.Directory]::Move($env:DM_STORAGE_PIN_LEAF,$env:DM_STORAGE_PIN_LEAF+'-moved')}catch [System.IO.IOException]{$leafDenied=$true}
 if(-not $leafDenied){[System.IO.Directory]::Move($env:DM_STORAGE_PIN_LEAF+'-moved',$env:DM_STORAGE_PIN_LEAF)}
 if(-not $ancestorDenied -or -not $leafDenied){throw ('PIN_DID_NOT_DENY_RENAME ancestor='+$ancestorDenied+' leaf='+$leafDenied)}
 $count=$lease.Count;$identity=$lease.Identity
}finally{$lease.Dispose()}
[System.IO.Directory]::Move($env:DM_STORAGE_PIN_PARENT,$env:DM_STORAGE_PIN_PARENT+'-moved')
[System.IO.Directory]::Move($env:DM_STORAGE_PIN_PARENT+'-moved',$env:DM_STORAGE_PIN_PARENT)
$denied=0
foreach($path in @('C:/u','//server/share','//?/F:/DreamMakerSuite/x','F:/DreamMakerSuite/a/../b','F:/DreamMakerSuite/a.','F:/DreamMakerSuite/a:x')){try{$bad=[DreamMaker.StorageDirectoryPin]::Acquire($path);$bad.Dispose();throw 'UNSAFE_PATH_ACCEPTED'}catch{if($_.Exception.ToString().Contains('UNSAFE_PATH_ACCEPTED')){throw};$denied++}}
@{ancestorDenied=$ancestorDenied;leafDenied=$leafDenied;releasedRenameWorked=$true;syntaxDenied=$denied;count=$count;identity=$identity;scope='ACTUAL_WINDOWS_DIRECTORY_HANDLES_ONLY_NOT_STORE_OR_RECOVERY'} | ConvertTo-Json -Compress`;
 try{const executable=resolve(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');const result=JSON.parse(execFileSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{cwd:process.cwd(),env:childEnv({TEMP:base,TMP:base,DM_STORAGE_CUSTODY_SCOPES:approvedScopes(),DM_STORAGE_PIN_SOURCE:source,DM_STORAGE_PIN_PARENT:parent,DM_STORAGE_PIN_LEAF:leaf}),encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:20000,stdio:['ignore','pipe','pipe']}));assert.equal(result.ancestorDenied,true);assert.equal(result.leafDenied,true);assert.equal(result.releasedRenameWorked,true);assert.equal(result.syntaxDenied,6);assert.ok(result.count>=4);assert.match(result.identity,/^[0-9a-f]+:[0-9a-f]+$/i);}
 finally{const child=relative(resolve(tmpdir()),resolve(base));assert.ok(child&&!child.startsWith('..')&&!child.includes(':'));rmSync(base,{recursive:true,force:true});}
});
test('a pinned opaque image rejects writes/rename and hash mismatch, then releases all handles',()=>{
 const base=mkdtempSync(join(tmpdir(),'dm-image-pin-')),operation='a'.repeat(64),image=Buffer.alloc(8192,7),file=join(base,operation+'.sqlite');writeFileSync(file,image);
 const command=String.raw`$ErrorActionPreference='Stop'
Add-Type -Path $env:DM_STORAGE_PIN_SOURCE
$pin=[DreamMaker.StorageDirectoryPin]::AcquireImage($env:DM_STORAGE_PIN_DIRECTORY,$env:DM_STORAGE_PIN_OPERATION,8192,$env:DM_STORAGE_PIN_HASH)
try {
 $writeDenied=$false;try{$writer=[IO.File]::Open($env:DM_STORAGE_PIN_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$writer.Dispose()}catch [IO.IOException]{$writeDenied=$true}
 $renameDenied=$false;try{[IO.File]::Move($env:DM_STORAGE_PIN_FILE,$env:DM_STORAGE_PIN_FILE+'.moved')}catch [IO.IOException]{$renameDenied=$true}
 if(-not $writeDenied -or -not $renameDenied){throw 'IMAGE_LOCK_NOT_ENFORCED'}
 $digest=$pin.ImageHash;$bytes=$pin.ImageBytes
}finally{$pin.Dispose()}
[IO.File]::Move($env:DM_STORAGE_PIN_FILE,$env:DM_STORAGE_PIN_FILE+'.moved');[IO.File]::Move($env:DM_STORAGE_PIN_FILE+'.moved',$env:DM_STORAGE_PIN_FILE)
$mismatchDenied=$false;try{$bad=[DreamMaker.StorageDirectoryPin]::AcquireImage($env:DM_STORAGE_PIN_DIRECTORY,$env:DM_STORAGE_PIN_OPERATION,8192,('b'*64));$bad.Dispose();throw 'WRONG_IMAGE_ACCEPTED'}catch{if($_.Exception.ToString().Contains('WRONG_IMAGE_ACCEPTED')){throw};$mismatchDenied=$true}
$writer=[IO.File]::Open($env:DM_STORAGE_PIN_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$writer.Dispose()
@{writeDenied=$writeDenied;renameDenied=$renameDenied;releasedRenameWorked=$true;mismatchDenied=$mismatchDenied;failedAcquireReleased=$true;digest=$digest;bytes=$bytes} | ConvertTo-Json -Compress`;
 try{const executable=resolve(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),r=JSON.parse(execFileSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{cwd:process.cwd(),env:childEnv({TEMP:base,TMP:base,DM_STORAGE_CUSTODY_SCOPES:approvedScopes(),DM_STORAGE_PIN_SOURCE:resolve('scripts/isolation/windows-storage-pin.cs'),DM_STORAGE_PIN_DIRECTORY:base,DM_STORAGE_PIN_OPERATION:operation,DM_STORAGE_PIN_FILE:file,DM_STORAGE_PIN_HASH:hash(image)}),windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:20000,stdio:['ignore','pipe','pipe']}));for(const k of ['writeDenied','renameDenied','releasedRenameWorked','mismatchDenied','failedAcquireReleased'])assert.equal(r[k],true);assert.equal(r.digest,hash(image));assert.equal(r.bytes,image.length);}
 finally{const child=relative(resolve(tmpdir()),resolve(base));assert.ok(child&&!child.startsWith('..')&&!child.includes(':'));rmSync(base,{recursive:true,force:true});}
});

test('create missing directory levels only while their existing parents remain pinned',()=>{
 const base=mkdtempSync(join(tmpdir(),'dm-create-pin-')),leaf=join(base,'new','nested');
 const command=String.raw`$ErrorActionPreference='Stop'
Add-Type -Path $env:DM_STORAGE_PIN_SOURCE
$readOnlyDenied=$false;try{$bad=[DreamMaker.StorageDirectoryPin]::Acquire($env:DM_STORAGE_PIN_LEAF);$bad.Dispose();throw 'READ_ACQUIRE_CREATED_PATH'}catch{if($_.Exception.ToString().Contains('READ_ACQUIRE_CREATED_PATH')){throw};$readOnlyDenied=$true}
if([IO.Directory]::Exists($env:DM_STORAGE_PIN_LEAF)){throw 'READ_ACQUIRE_CHANGED_DISK'}
$lease=[DreamMaker.StorageDirectoryPin]::AcquireOrCreate($env:DM_STORAGE_PIN_LEAF)
try {
 if(-not [IO.Directory]::Exists($env:DM_STORAGE_PIN_LEAF)){throw 'MISSING_CREATED_DIRECTORY'}
 $parentDenied=$false;try{[IO.Directory]::Move($env:DM_STORAGE_PIN_BASE,$env:DM_STORAGE_PIN_BASE+'-moved')}catch [IO.IOException]{$parentDenied=$true}
 if(-not $parentDenied){[IO.Directory]::Move($env:DM_STORAGE_PIN_BASE+'-moved',$env:DM_STORAGE_PIN_BASE);throw 'CREATED_PATH_PARENT_REPLACEABLE'}
 $nestedDenied=$false;try{[IO.Directory]::Move($env:DM_STORAGE_PIN_LEAF,$env:DM_STORAGE_PIN_LEAF+'-moved')}catch [IO.IOException]{$nestedDenied=$true}
 if(-not $nestedDenied){[IO.Directory]::Move($env:DM_STORAGE_PIN_LEAF+'-moved',$env:DM_STORAGE_PIN_LEAF);throw 'CREATED_PATH_REPLACEABLE'}
 $second=[DreamMaker.StorageDirectoryPin]::AcquireOrCreate($env:DM_STORAGE_PIN_LEAF);try{if($lease.Identity -ne $second.Identity){throw 'EXISTING_DIRECTORY_IDENTITY_CHANGED'}}finally{$second.Dispose()}
}finally{$lease.Dispose()}
[IO.Directory]::Move($env:DM_STORAGE_PIN_BASE,$env:DM_STORAGE_PIN_BASE+'-moved');[IO.Directory]::Move($env:DM_STORAGE_PIN_BASE+'-moved',$env:DM_STORAGE_PIN_BASE)
$file=[IO.Path]::Combine($env:DM_STORAGE_PIN_BASE,'file');[IO.File]::WriteAllText($file,'opaque fixture')
$nonDirectoryDenied=$false;try{$bad=[DreamMaker.StorageDirectoryPin]::AcquireOrCreate([IO.Path]::Combine($file,'child'));$bad.Dispose();throw 'FILE_PARENT_ACCEPTED'}catch{if($_.Exception.ToString().Contains('FILE_PARENT_ACCEPTED')){throw};$nonDirectoryDenied=$true}
[IO.File]::Delete($file)
[IO.Directory]::Move($env:DM_STORAGE_PIN_BASE,$env:DM_STORAGE_PIN_BASE+'-after-failure');[IO.Directory]::Move($env:DM_STORAGE_PIN_BASE+'-after-failure',$env:DM_STORAGE_PIN_BASE)
@{readOnlyDenied=$readOnlyDenied;parentsPinned=$parentDenied;createdPinned=$nestedDenied;existingIdentityPreserved=$true;failureReleased=$nonDirectoryDenied;failureAncestorsReleased=$true;releasedRenameWorked=$true} | ConvertTo-Json -Compress`;
 try{const executable=resolve(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),r=JSON.parse(execFileSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{cwd:process.cwd(),env:childEnv({TEMP:base,TMP:base,DM_STORAGE_CUSTODY_SCOPES:approvedScopes(),DM_STORAGE_PIN_SOURCE:resolve('scripts/isolation/windows-storage-pin.cs'),DM_STORAGE_PIN_BASE:base,DM_STORAGE_PIN_LEAF:leaf}),windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:20000,stdio:['ignore','pipe','pipe']}));
  for(const k of ['readOnlyDenied','parentsPinned','createdPinned','existingIdentityPreserved','failureReleased','failureAncestorsReleased','releasedRenameWorked'])assert.equal(r[k],true);
 }finally{const child=relative(resolve(tmpdir()),resolve(base));assert.ok(child&&!child.startsWith('..')&&!child.includes(':'));rmSync(base,{recursive:true,force:true});}
});
