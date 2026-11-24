import {createHash,randomUUID} from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {
  installPortableDirectory,
  readInstallationState,
  uninstallPortableDirectory,
  updatePortableDirectory,
} from './windows-installation.js';
import {verifySuiteComposition} from './windows-suite-composition.js';
import {isWindowsPackageSegment} from './windows-package-path.js';

interface SuiteFile {path:string;bytes:number;sha256:string}
type SuiteInstallerScope='FRESH_LOCAL_SUITE_INSTALL_ONLY'|'LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL';
const HASH=/^[a-f0-9]{64}$/;
const MAX_MANIFEST=8*1024*1024;
const MAX_FILE=2_147_483_648;
const SUITE_LIFECYCLE_SCOPE='LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL';
const SUITE_ROLLBACK_SCHEMA='dream-maker.windows-suite-rollback.v1';
const SUITE_ROLLBACK_FILE='core/data/.installation/suite-rollback.json';
const SUITE_ROLLBACK_HISTORY='core/data/.installation/rollback-history';
const VERSION=/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string):never=>{throw new Error(code)};

interface SuiteRollbackPointer {
  schema:typeof SUITE_ROLLBACK_SCHEMA;
  backupRoot:string;
  backupVersion:string;
  backupManifestHash:string;
  backupCoreManifestHash:string;
  currentVersion:string;
  currentManifestHash:string;
  currentCoreManifestHash:string;
  createdAt:string;
}

function safeAbsolute(path:string,code:string):string{
  if(!path||!isAbsolute(path)||path.includes('\0'))fail(code);
  const value=resolve(path),root=resolve(value,sep);
  if(value===root)return fail(code);
  return value;
}

function ordinaryFile(path:string,code:string):void{
  const observed=(()=>{
    try{return lstatSync(path)}
    catch{throw new Error(code)}
  })();
  if(!observed.isFile()||observed.isSymbolicLink()||observed.size>MAX_FILE)
    throw new Error(code);
}

function within(parent:string,child:string):boolean{
  const value=relative(resolve(parent),resolve(child));
  return value===''||(!value.startsWith('..'+sep)&&value!=='..'&&!isAbsolute(value));
}

function sibling(target:string,kind:string):string{
  return join(dirname(target),`.${basename(target)}.${kind}-${randomUUID()}`);
}

function assertSuiteIdle(root:string):void{
  const candidates=[
    'core/data/dream-maker/server.lock',
    'core/data/dream-maker/server.lock.acquire',
    'core/data/dreamflow/server.lock',
    'core/data/dreamflow/server.lock.acquire',
  ];
  if(candidates.some(path=>existsSync(join(root,...path.split('/')))))fail('SUITE_INSTALL_ACTIVE');
}

async function assertManagedSuite(root:string):Promise<{
  version:string;
  installId:string;
  files:number;
  manifestHash:string;
  installerScope:SuiteInstallerScope;
  installerRollback:boolean;
}>{
  const verified=await verifySuiteComposition(root);
  const core=readInstallationState(join(root,'core'));
  return{
    version:core.version,
    installId:core.installId,
    files:verified.files,
    manifestHash:verified.manifestHash,
    installerScope:verified.installerScope,
    installerRollback:verified.installerRollback,
  };
}

function requireSuiteLifecycle(scope:SuiteInstallerScope):void{
  if(scope!==SUITE_LIFECYCLE_SCOPE)fail('SUITE_LIFECYCLE_CAPABILITY_REQUIRED');
}

function suiteRollbackPath(root:string):string{
  return join(root,...SUITE_ROLLBACK_FILE.split('/'));
}

function writeSuiteRollbackPointer(root:string,value:SuiteRollbackPointer):void{
  if(value.schema!==SUITE_ROLLBACK_SCHEMA||!VERSION.test(value.backupVersion)||
    !VERSION.test(value.currentVersion)||!HASH.test(value.backupManifestHash)||
    !HASH.test(value.backupCoreManifestHash)||!HASH.test(value.currentManifestHash)||
    !HASH.test(value.currentCoreManifestHash)||!Number.isFinite(Date.parse(value.createdAt)))
    fail('SUITE_ROLLBACK_POINTER_INVALID');
  const path=suiteRollbackPath(root),temporary=`${path}.partial-${randomUUID()}`;
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
  if(existsSync(path))unlinkSync(path);
  renameSync(temporary,path);
}

function readSuiteRollbackPointer(root:string,current:{
  version:string;
  installId:string;
  manifestHash:string;
}):SuiteRollbackPointer{
  const path=suiteRollbackPath(root);
  let observed;
  try{observed=lstatSync(path)}
  catch{return fail('SUITE_ROLLBACK_POINTER_MISSING')}
  if(!observed.isFile()||observed.isSymbolicLink()||observed.size<1||observed.size>16384)
    fail('SUITE_ROLLBACK_POINTER_INVALID');
  let parsed:unknown;
  try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)))}
  catch{fail('SUITE_ROLLBACK_POINTER_INVALID')}
  if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))
    fail('SUITE_ROLLBACK_POINTER_INVALID');
  const value=parsed as SuiteRollbackPointer;
  if(
    value.schema!==SUITE_ROLLBACK_SCHEMA||typeof value.backupRoot!=='string'||
    !VERSION.test(value.backupVersion)||!VERSION.test(value.currentVersion)||
    !HASH.test(value.backupManifestHash)||!HASH.test(value.backupCoreManifestHash)||
    !HASH.test(value.currentManifestHash)||!HASH.test(value.currentCoreManifestHash)||
    !Number.isFinite(Date.parse(value.createdAt))||
    new Date(value.createdAt).toISOString()!==value.createdAt||
    value.currentVersion!==current.version||value.currentManifestHash!==current.manifestHash)
    fail('SUITE_ROLLBACK_POINTER_INVALID');
  const backup=safeAbsolute(value.backupRoot,'SUITE_ROLLBACK_POINTER_INVALID');
  if(dirname(backup)!==dirname(root)||within(root,backup)||within(backup,root)||
    !basename(backup).startsWith(`.${basename(root)}.suite-rollback-`))
    fail('SUITE_ROLLBACK_POINTER_INVALID');
  return{...value,backupRoot:backup};
}

function copyMutableCoreData(source:string,target:string):void{
  for(const name of ['data','temp'] as const){
    const from=join(source,'core',name),to=join(target,'core',name);
    if(existsSync(to))rmSync(to,{recursive:true,force:false});
    if(existsSync(from))cpSync(from,to,{
      recursive:true,
      dereference:false,
      force:false,
      errorOnExist:true,
      preserveTimestamps:true,
    });
  }
}

function writeRollbackHistory(root:string,value:Record<string,unknown>):void{
  const directory=join(root,...SUITE_ROLLBACK_HISTORY.split('/'));
  mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,`${Date.now()}-${randomUUID()}.json`),JSON.stringify(value,null,2)+'\n',{
    flag:'wx',
    flush:true,
  });
}

function restoreInstallationState(root:string,input:{
  installId:string;
  version:string;
  sourceManifestHash:string;
  installedAt:string;
}):void{
  const path=join(root,'core/data/.installation/installation.json');
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify({
    schema:'dream-maker.windows-installation.v1',
    layout:'PORTABLE_COPY_V1',
    installId:input.installId,
    version:input.version,
    sourceManifestHash:input.sourceManifestHash,
    installedAt:input.installedAt,
    updatedAt:new Date().toISOString(),
  },null,2)+'\n',{flush:true});
}

function removeMutablePointers(root:string):void{
  for(const path of [
    suiteRollbackPath(root),
    join(root,'core/data/.installation/rollback.json'),
  ]){
    if(!existsSync(path))continue;
    const observed=lstatSync(path);
    if(!observed.isFile()||observed.isSymbolicLink())fail('SUITE_ROLLBACK_POINTER_INVALID');
    unlinkSync(path);
  }
}

function copySuiteTree(source:string,target:string):void{
  cpSync(source,target,{
    recursive:true,
    dereference:false,
    force:false,
    errorOnExist:true,
    preserveTimestamps:true,
  });
}

function writeSuiteReceipt(userDataRoot:string,value:unknown):void{
  const path=join(userDataRoot,'data/.installation/suite-uninstalled.json');
  if(existsSync(path))fail('SUITE_INSTALL_RECEIPT_EXISTS');
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
}

function readManifest(root:string):{files:SuiteFile[];manifest:Record<string,unknown>}{
  const path=join(root,'SUITE_COMPOSITION_MANIFEST.json');
  ordinaryFile(path,'SUITE_INSTALL_MANIFEST_INVALID');
  const stat=lstatSync(path);
  if(stat.size<=0||stat.size>MAX_MANIFEST)fail('SUITE_INSTALL_MANIFEST_INVALID');
  let manifest;
  try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)))}
  catch{fail('SUITE_INSTALL_MANIFEST_INVALID')}
  if(manifest===null||typeof manifest!=='object'||Array.isArray(manifest)||
    !Array.isArray((manifest as Record<string,unknown>).files))
    fail('SUITE_INSTALL_MANIFEST_INVALID');
  const files=(manifest as {files:unknown[]}).files.map(file=>{
    if(file===null||typeof file!=='object'||Array.isArray(file))
      fail('SUITE_INSTALL_MANIFEST_INVALID');
    const item=file as Record<string,unknown>;
    if(typeof item.path!=='string'||!item.path||isAbsolute(item.path)||
      /^[A-Za-z]:/.test(item.path)||item.path.split(/[\\/]+/).some(part=>
        !isWindowsPackageSegment(part))||
      !Number.isSafeInteger(item.bytes)||Number(item.bytes)<0||Number(item.bytes)>MAX_FILE||
      typeof item.sha256!=='string'||!HASH.test(item.sha256))
      fail('SUITE_INSTALL_MANIFEST_INVALID');
    return{
      path:item.path as string,
      bytes:Number(item.bytes),
      sha256:item.sha256 as string,
    };
  });
  return{files,manifest:manifest as Record<string,unknown>};
}

function copyPinned(source:string,target:string,file:SuiteFile):void{
  if(!existsSync(source))fail('SUITE_INSTALL_SOURCE_MISSING');
  let sourceFd:number|undefined,targetFd:number|undefined;
  try{
    sourceFd=openSync(source,'r');
    const before=fstatSync(sourceFd);
    if(!before.isFile()||before.size!==file.bytes)fail('SUITE_INSTALL_SOURCE_CHANGED');
    mkdirSync(dirname(target),{recursive:true});
    targetFd=openSync(target,'wx');
    const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
    let total=0;
    for(let count;(count=readSync(sourceFd,buffer,0,buffer.length,null))>0;){
      total+=count;
      if(total>file.bytes)fail('SUITE_INSTALL_SOURCE_CHANGED');
      digest.update(buffer.subarray(0,count));
      let offset=0;
      while(offset<count){
        const written=writeSync(targetFd,buffer,offset,count-offset);
        if(written<=0)fail('SUITE_INSTALL_WRITE_FAILED');
        offset+=written;
      }
    }
    const after=lstatSync(source);
    if(total!==file.bytes||before.size!==after.size||before.mtimeMs!==after.mtimeMs||
      String(before.ino)!==String(after.ino)||digest.digest('hex')!==file.sha256)
      fail('SUITE_INSTALL_SOURCE_CHANGED');
  }finally{
    if(targetFd!==undefined)closeSync(targetFd);
    if(sourceFd!==undefined)closeSync(sourceFd);
  }
}

function copyTopFile(source:string,target:string,path:string):void{
  const from=resolve(source,path),to=resolve(target,path);
  const rel=relative(resolve(source),from);
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))
    fail('SUITE_INSTALL_PATH_INVALID');
  ordinaryFile(from,'SUITE_INSTALL_SOURCE_CHANGED');
  const body=readFileSync(from),stat=lstatSync(from);
  if(body.length!==stat.size)fail('SUITE_INSTALL_SOURCE_CHANGED');
  mkdirSync(dirname(to),{recursive:true});
  if(existsSync(to))fail('SUITE_INSTALL_TARGET_CONFLICT');
  const fd=openSync(to,'wx');
  try{
    let offset=0;
    while(offset<body.length){
      const written=writeSync(fd,body,offset,body.length-offset);
      if(written<=0)fail('SUITE_INSTALL_WRITE_FAILED');
      offset+=written;
    }
  }finally{
    closeSync(fd);
  }
  if(sha(readFileSync(to))!==sha(body))fail('SUITE_INSTALL_COPY_NOT_VERIFIED');
}

export async function installSuiteComposition(input:{
  sourceRoot:string;
  installRoot:string;
}):Promise<{
  status:'PASS_SUITE_COMPOSITION_INSTALLED';
  scope:'FRESH_LOCAL_SUITE_COMPOSITION_ONLY';
  installRoot:string;
  coreRoot:string;
  runtimeRoot:string;
  coreFiles:number;
  runtimeFiles:number;
  runtimeComponents:number;
  files:number;
  verified:true;
}>{
  const source=safeAbsolute(input.sourceRoot,'SUITE_INSTALL_SOURCE_INVALID');
  const target=safeAbsolute(input.installRoot,'SUITE_INSTALL_TARGET_INVALID');
  if(within(source,target))fail('SUITE_INSTALL_PATH_INVALID');
  if(existsSync(target))fail('SUITE_INSTALL_TARGET_EXISTS');
  await verifySuiteComposition(source);
  const {files}=readManifest(source);
  const parent=dirname(target);
  if(!existsSync(parent))fail('SUITE_INSTALL_PARENT_MISSING');
  const parentStat=lstatSync(parent);
  if(!parentStat.isDirectory()||parentStat.isSymbolicLink())
    fail('SUITE_INSTALL_PARENT_INVALID');

  const staging=join(parent,`.${basename(target)}.installing-${randomUUID()}`);
  if(existsSync(staging))fail('SUITE_INSTALL_STAGING_EXISTS');
  try{
    mkdirSync(staging,{recursive:false});
    await installPortableDirectory({
      sourceRoot:join(source,'core'),
      installRoot:join(staging,'core'),
    });
    for(const file of files){
      if(file.path.startsWith('core/'))continue;
      copyPinned(join(source,file.path),join(staging,file.path),file);
    }
    for(const file of ['SUITE_COMPOSITION_MANIFEST.json','SHA256SUMS.txt']){
      copyTopFile(source,staging,file);
    }
    const verified=await verifySuiteComposition(staging);
    if(existsSync(target))fail('SUITE_INSTALL_TARGET_EXISTS');
    renameSync(staging,target);
    return{
      status:'PASS_SUITE_COMPOSITION_INSTALLED',
      scope:'FRESH_LOCAL_SUITE_COMPOSITION_ONLY',
      installRoot:target,
      coreRoot:join(target,'core'),
      runtimeRoot:join(target,'runtime/agent-bundle'),
      coreFiles:verified.coreFiles,
      runtimeFiles:verified.runtimeFiles,
      runtimeComponents:verified.runtimeComponents,
      files:verified.files,
      verified:true,
    };
  }catch(error){
    if(existsSync(staging))rmSync(staging,{recursive:true,force:true});
    throw error;
  }
}

export async function updateSuiteComposition(input:{
  sourceRoot:string;
  installRoot:string;
}):Promise<{
  status:'PASS_SUITE_COMPOSITION_UPDATED';
  scope:typeof SUITE_LIFECYCLE_SCOPE;
  installRoot:string;
  rollbackRoot:string;
  coreRollbackRoot:string;
  installId:string;
  version:string;
  files:number;
  verified:true;
}>{
  const source=safeAbsolute(input.sourceRoot,'SUITE_INSTALL_SOURCE_INVALID');
  const target=safeAbsolute(input.installRoot,'SUITE_INSTALL_TARGET_INVALID');
  if(source===target||within(source,target)||within(target,source))
    fail('SUITE_INSTALL_PATH_INVALID');
  const sourceVerified=await verifySuiteComposition(source);
  requireSuiteLifecycle(sourceVerified.installerScope);
  if(sourceVerified.installerRollback!==true)fail('SUITE_ROLLBACK_CAPABILITY_REQUIRED');
  const current=await assertManagedSuite(target);
  requireSuiteLifecycle(current.installerScope);
  assertSuiteIdle(target);
  const currentCoreState=readInstallationState(join(target,'core'));

  const staging=sibling(target,'suite-updating');
  const coreStaging=sibling(target,'suite-core-updating');
  let backup:string|undefined;
  try{
    if(existsSync(staging)||existsSync(coreStaging))fail('SUITE_INSTALL_STAGING_EXISTS');
    await installSuiteComposition({sourceRoot:source,installRoot:staging});
    copySuiteTree(join(target,'core'),coreStaging);
    const coreUpdated=await updatePortableDirectory({
      sourceRoot:join(source,'core'),
      installRoot:coreStaging,
    });
    rmSync(join(staging,'core'),{recursive:true,force:false});
    renameSync(coreStaging,join(staging,'core'));
    const updatedCore=await assertManagedSuite(staging);
    if(updatedCore.installId!==current.installId)fail('SUITE_INSTALL_ID_CHANGED');

    backup=sibling(target,'suite-rollback');
    if(existsSync(backup))fail('SUITE_INSTALL_ROLLBACK_EXISTS');
    renameSync(target,backup);
    try{
      if(existsSync(target))fail('SUITE_INSTALL_TARGET_EXISTS');
      renameSync(staging,target);
      const verified=await assertManagedSuite(target);
      const verifiedCoreState=readInstallationState(join(target,'core'));
      writeSuiteRollbackPointer(target,{
        schema:SUITE_ROLLBACK_SCHEMA,
        backupRoot:backup,
        backupVersion:current.version,
        backupManifestHash:current.manifestHash,
        backupCoreManifestHash:currentCoreState.sourceManifestHash,
        currentVersion:verified.version,
        currentManifestHash:verified.manifestHash,
        currentCoreManifestHash:verifiedCoreState.sourceManifestHash,
        createdAt:new Date().toISOString(),
      });
      return{
        status:'PASS_SUITE_COMPOSITION_UPDATED',
        scope:SUITE_LIFECYCLE_SCOPE,
        installRoot:target,
        rollbackRoot:backup,
        coreRollbackRoot:coreUpdated.rollbackRoot,
        installId:verified.installId,
        version:verified.version,
        files:verified.files,
        verified:true,
      };
    }catch(error){
      try{
        if(existsSync(target)&&existsSync(backup)){
          const failed=sibling(target,'suite-failed-update');
          renameSync(target,failed);
        }
        if(!existsSync(target)&&existsSync(backup))renameSync(backup,target);
      }catch{
        // Preserve the original target and every surviving sibling for manual recovery.
      }
      throw error;
    }
  }catch(error){
    if(existsSync(staging))rmSync(staging,{recursive:true,force:true});
    if(existsSync(coreStaging))rmSync(coreStaging,{recursive:true,force:true});
    throw error;
  }
}

export async function rollbackSuiteComposition(input:{
  installRoot:string;
}):Promise<{
  status:'PASS_SUITE_COMPOSITION_ROLLED_BACK';
  scope:typeof SUITE_LIFECYCLE_SCOPE;
  installRoot:string;
  backupRoot:string;
  failedUpdateRoot:string;
  installId:string;
  version:string;
  files:number;
  verified:true;
}>{
  const target=safeAbsolute(input.installRoot,'SUITE_INSTALL_TARGET_INVALID');
  const current=await assertManagedSuite(target);
  requireSuiteLifecycle(current.installerScope);
  assertSuiteIdle(target);
  const pointer=readSuiteRollbackPointer(target,current);
  const backup=await assertManagedSuite(pointer.backupRoot);
  requireSuiteLifecycle(backup.installerScope);
  if(backup.installId!==current.installId||backup.version!==pointer.backupVersion||
    backup.manifestHash!==pointer.backupManifestHash)
    fail('SUITE_ROLLBACK_BACKUP_INVALID');
  const currentState=readInstallationState(join(target,'core'));
  const backupCoreState=readInstallationState(join(pointer.backupRoot,'core'));
  if(currentState.sourceManifestHash!==pointer.currentCoreManifestHash||
    backupCoreState.sourceManifestHash!==pointer.backupCoreManifestHash)
    fail('SUITE_ROLLBACK_BACKUP_INVALID');
  const staging=sibling(target,'suite-rolling-back');
  const failed=sibling(target,'suite-rolled-back');
  if(existsSync(staging)||existsSync(failed))fail('SUITE_INSTALL_STAGING_EXISTS');
  try{
    copySuiteTree(pointer.backupRoot,staging);
    const staged=await assertManagedSuite(staging);
    if(staged.installId!==current.installId||staged.version!==pointer.backupVersion||
      staged.manifestHash!==pointer.backupManifestHash)
      fail('SUITE_ROLLBACK_BACKUP_INVALID');
    copyMutableCoreData(target,staging);
    removeMutablePointers(staging);
    restoreInstallationState(staging,{
      installId:current.installId,
      version:pointer.backupVersion,
      sourceManifestHash:pointer.backupCoreManifestHash,
      installedAt:currentState.installedAt,
    });
    const prepared=await assertManagedSuite(staging);
    if(prepared.version!==pointer.backupVersion||prepared.installId!==current.installId)
      fail('SUITE_ROLLBACK_BACKUP_INVALID');

    renameSync(target,failed);
    try{
      renameSync(staging,target);
      const verified=await assertManagedSuite(target);
      writeRollbackHistory(target,{
        schema:'dream-maker.windows-suite-rollback-history.v1',
        fromVersion:current.version,
        toVersion:verified.version,
        backupRoot:pointer.backupRoot,
        failedUpdateRoot:failed,
        at:new Date().toISOString(),
      });
      return{
        status:'PASS_SUITE_COMPOSITION_ROLLED_BACK',
        scope:SUITE_LIFECYCLE_SCOPE,
        installRoot:target,
        backupRoot:pointer.backupRoot,
        failedUpdateRoot:failed,
        installId:verified.installId,
        version:verified.version,
        files:verified.files,
        verified:true,
      };
    }catch(error){
      try{
        if(existsSync(target)){
          const invalid=sibling(target,'suite-rollback-invalid');
          renameSync(target,invalid);
        }
        if(!existsSync(target)&&existsSync(failed))renameSync(failed,target);
      }catch{
        // Preserve the verified backup, failed update and any invalid staging
        // sibling for manual recovery instead of deleting evidence.
      }
      throw error;
    }
  }catch(error){
    if(existsSync(staging))rmSync(staging,{recursive:true,force:true});
    throw error;
  }
}

export async function uninstallSuiteComposition(input:{
  installRoot:string;
}):Promise<{
  status:'PASS_SUITE_COMPOSITION_UNINSTALLED';
  scope:typeof SUITE_LIFECYCLE_SCOPE;
  installRoot:string;
  userDataRoot:string;
  installId:string;
  version:string;
  verified:true;
}>{
  const target=safeAbsolute(input.installRoot,'SUITE_INSTALL_TARGET_INVALID');
  const current=await assertManagedSuite(target);
  requireSuiteLifecycle(current.installerScope);
  assertSuiteIdle(target);

  const backup=sibling(target,'suite-uninstalling');
  const userDataRoot=sibling(target,'userdata');
  try{
    if(existsSync(backup)||existsSync(userDataRoot))fail('SUITE_INSTALL_STAGING_EXISTS');
    copySuiteTree(target,backup);
    await verifySuiteComposition(backup);
    const coreRemoved=await uninstallPortableDirectory({installRoot:join(backup,'core')});
    renameSync(coreRemoved.userDataRoot,userDataRoot);
    writeSuiteReceipt(userDataRoot,{
      schema:'dream-maker.windows-suite-uninstall.v1',
      status:'PASS_SUITE_COMPOSITION_UNINSTALLED',
      installId:current.installId,
      version:current.version,
      installRoot:target,
      userDataRoot,
      uninstalledAt:new Date().toISOString(),
    });
    const tombstone=sibling(target,'suite-retired');
    renameSync(target,tombstone);
    try{
      rmSync(tombstone,{recursive:true,force:false});
    }catch{
      // The installation path is already retired. Keep the tombstone for
      // manual cleanup rather than deleting anchored user data.
    }
    try{
      rmSync(backup,{recursive:true,force:false});
    }catch{
      // The verified uninstall copy is also safe to retain for manual cleanup.
    }
    return{
      status:'PASS_SUITE_COMPOSITION_UNINSTALLED',
      scope:SUITE_LIFECYCLE_SCOPE,
      installRoot:target,
      userDataRoot,
      installId:current.installId,
      version:current.version,
      verified:true,
    };
  }catch(error){
    if(existsSync(target)){
      if(existsSync(backup))rmSync(backup,{recursive:true,force:true});
      if(existsSync(userDataRoot))rmSync(userDataRoot,{recursive:true,force:true});
    }
    throw error;
  }
}
