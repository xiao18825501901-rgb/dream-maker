import {createHash,randomUUID} from 'node:crypto';
import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  renameSync, rmSync, unlinkSync, writeFileSync
} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {
  safePortablePath,
  verifyPortableDirectory,
  type PortableManifest
} from './windows-portable.js';

const INSTALL_SCHEMA='dream-maker.windows-installation.v1';
const ROLLBACK_SCHEMA='dream-maker.windows-rollback.v1';
const UNINSTALL_SCHEMA='dream-maker.windows-uninstall.v1';
const STATE_DIR='data/.installation';
const STATE_FILE=`${STATE_DIR}/installation.json`;
const ROLLBACK_FILE=`${STATE_DIR}/rollback.json`;
const MAX_STATE_BYTES=64*1024;
const VERSION=/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const HASH=/^[a-f0-9]{64}$/;

export interface InstallationState {
  schema:typeof INSTALL_SCHEMA;
  layout:'PORTABLE_COPY_V1';
  installId:string;
  version:string;
  sourceManifestHash:string;
  installedAt:string;
  updatedAt:string;
}

interface RollbackState {
  schema:typeof ROLLBACK_SCHEMA;
  backupRoot:string;
  backupVersion:string;
  currentVersion:string;
  createdAt:string;
}

interface MutablePointerState {
  rollback:'MISSING'|'FILE'|'OTHER';
  rollbackBytes:Buffer|null;
}

export interface InstallResult extends InstallationState {
  installRoot:string;
}

export interface UpdateResult extends InstallationState {
  installRoot:string;
  rollbackRoot:string;
}

export interface RollbackResult extends InstallationState {
  installRoot:string;
  failedUpdateRoot:string;
}

export interface UninstallResult {
  schema:typeof UNINSTALL_SCHEMA;
  installId:string;
  version:string;
  uninstalledAt:string;
  installRoot:string;
  userDataRoot:string;
}

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');

function within(parent:string,child:string):boolean {
  const value=relative(resolve(parent),resolve(child));
  return value===''||(!value.startsWith('..'+sep)&&value!=='..'&&!isAbsolute(value));
}

function strictInside(parent:string,child:string):boolean {
  return resolve(parent)!==resolve(child)&&within(parent,child);
}

function regularDirectory(path:string):boolean {
  if(!existsSync(path))return false;
  const stat=lstatSync(path);
  return stat.isDirectory()&&!stat.isSymbolicLink();
}

function assertAbsoluteDirectoryTarget(path:string):string {
  if(typeof path!=='string'||!path||path.includes('\0')||!isAbsolute(path))throw new Error('INSTALLATION_PATH_INVALID');
  const target=resolve(path),parent=dirname(target);
  if(target===parent||target.length<8)throw new Error('INSTALLATION_PATH_INVALID');
  if(!existsSync(parent)||!regularDirectory(parent))throw new Error('INSTALLATION_PARENT_MISSING');
  return target;
}

function sibling(target:string,kind:string):string {
  return join(dirname(target),`.${target.split(sep).at(-1)}.${kind}-${randomUUID()}`);
}

function shaFile(path:string):string {
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('INSTALLATION_FILE_INVALID');
  return sha(readFileSync(path));
}

function readManifest(root:string):PortableManifest {
  const path=join(root,'RELEASE_MANIFEST.json'),stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_STATE_BYTES*16)throw new Error('INSTALLATION_MANIFEST_INVALID');
  try{
    return JSON.parse(readFileSync(path,'utf8')) as PortableManifest;
  }catch{
    throw new Error('INSTALLATION_MANIFEST_INVALID');
  }
}

function writeJson(path:string,value:unknown):void {
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
}

function replaceJson(path:string,value:unknown):void {
  replaceBytes(path,Buffer.from(JSON.stringify(value,null,2)+'\n'));
}

function replaceBytes(path:string,bytes:Buffer):void {
  mkdirSync(dirname(path),{recursive:true});
  const temporary=`${path}.next-${randomUUID()}`;
  writeFileSync(temporary,bytes,{flag:'wx',flush:true});
  try{
    unlinkSync(path);
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT'){
      rmSync(temporary,{force:true});
      throw error;
    }
  }
  renameSync(temporary,path);
}

function readMutablePointerState(root:string):MutablePointerState {
  const path=join(root,...ROLLBACK_FILE.split('/'));
  if(!existsSync(path))return {rollback:'MISSING',rollbackBytes:null};
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_STATE_BYTES)
    return {rollback:'OTHER',rollbackBytes:null};
  return {rollback:'FILE',rollbackBytes:readFileSync(path)};
}

function restoreMutablePointers(root:string,state:InstallationState,pointers:MutablePointerState):void {
  // The data directory moved through staging, so its JSON pointers may describe
  // the candidate rather than the installation being restored.
  replaceJson(join(root,...STATE_FILE.split('/')),state);
  const path=join(root,...ROLLBACK_FILE.split('/'));
  if(pointers.rollback==='MISSING'){
    if(existsSync(path)){
      const stat=lstatSync(path);
      if(stat.isFile()&&!stat.isSymbolicLink())unlinkSync(path);
    }
    return;
  }
  if(pointers.rollback==='FILE'&&pointers.rollbackBytes)replaceBytes(path,pointers.rollbackBytes);
}

function readBoundedJson(path:string):unknown {
  if(!existsSync(path))throw new Error('INSTALLATION_NOT_MANAGED');
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_STATE_BYTES)throw new Error('INSTALLATION_STATE_INVALID');
  try{
    return JSON.parse(readFileSync(path,'utf8'));
  }catch{
    throw new Error('INSTALLATION_STATE_INVALID');
  }
}

function validateState(value:unknown):InstallationState {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INSTALLATION_STATE_INVALID');
  const state=value as Record<string,unknown>;
  if(state.schema!==INSTALL_SCHEMA||state.layout!=='PORTABLE_COPY_V1'||
    typeof state.installId!=='string'||!/^[a-f0-9-]{36}$/.test(state.installId)||
    typeof state.version!=='string'||!VERSION.test(state.version)||
    typeof state.sourceManifestHash!=='string'||!HASH.test(state.sourceManifestHash)||
    typeof state.installedAt!=='string'||Number.isNaN(Date.parse(state.installedAt))||
    typeof state.updatedAt!=='string'||Number.isNaN(Date.parse(state.updatedAt))){
    throw new Error('INSTALLATION_STATE_INVALID');
  }
  return {
    schema:INSTALL_SCHEMA,
    layout:'PORTABLE_COPY_V1',
    installId:state.installId,
    version:state.version,
    sourceManifestHash:state.sourceManifestHash,
    installedAt:state.installedAt,
    updatedAt:state.updatedAt
  };
}

function validateRollback(value:unknown):RollbackState {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INSTALLATION_ROLLBACK_INVALID');
  const state=value as Record<string,unknown>;
  if(state.schema!==ROLLBACK_SCHEMA||typeof state.backupRoot!=='string'||!isAbsolute(state.backupRoot)||
    typeof state.backupVersion!=='string'||!VERSION.test(state.backupVersion)||
    typeof state.currentVersion!=='string'||!VERSION.test(state.currentVersion)||
    typeof state.createdAt!=='string'||Number.isNaN(Date.parse(state.createdAt))){
    throw new Error('INSTALLATION_ROLLBACK_INVALID');
  }
  return {
    schema:ROLLBACK_SCHEMA,
    backupRoot:resolve(state.backupRoot),
    backupVersion:state.backupVersion,
    currentVersion:state.currentVersion,
    createdAt:state.createdAt
  };
}

export function readInstallationState(installRoot:string):InstallationState {
  const root=assertAbsoluteDirectoryTarget(installRoot);
  if(!regularDirectory(root))throw new Error('INSTALLATION_NOT_MANAGED');
  return validateState(readBoundedJson(join(root,...STATE_FILE.split('/'))));
}

function assertNoActiveProduct(root:string):void {
  const candidates=[
    'data/dream-maker/server.lock',
    'data/dream-maker/server.lock.acquire',
    'data/dreamflow/server.lock',
    'data/dreamflow/server.lock.acquire'
  ];
  if(candidates.some(path=>existsSync(join(root,...path.split('/')))))throw new Error('INSTALLATION_ACTIVE');
}

async function assertManaged(root:string):Promise<{state:InstallationState;manifest:PortableManifest;manifestHash:string}> {
  if(!regularDirectory(root))throw new Error('INSTALLATION_NOT_MANAGED');
  const state=readInstallationState(root);
  const verified=await verifyPortableDirectory(root);
  const manifest=readManifest(root);
  if(manifest.version!==state.version)throw new Error('INSTALLATION_VERSION_MISMATCH');
  const manifestHash=shaFile(join(root,'RELEASE_MANIFEST.json'));
  if(manifestHash!==state.sourceManifestHash)throw new Error('INSTALLATION_MANIFEST_CHANGED');
  return {state,manifest,manifestHash};
}

async function copyPortablePackage(sourceRoot:string,destinationRoot:string):Promise<{manifest:PortableManifest;manifestHash:string}> {
  await verifyPortableDirectory(sourceRoot);
  const manifest=readManifest(sourceRoot);
  const paths=[
    ...manifest.files.map(file=>file.path),
    'RELEASE_MANIFEST.json',
    'SHA256SUMS.txt'
  ].map(safePortablePath);
  if(paths.some(path=>path==='data'||path.startsWith('data/')||path==='temp'||path.startsWith('temp/'))){
    throw new Error('INSTALLATION_SOURCE_MUTABLE_DATA');
  }
  mkdirSync(destinationRoot,{recursive:false});
  for(const path of paths){
    const from=join(sourceRoot,...path.split('/')),to=join(destinationRoot,...path.split('/'));
    const stat=lstatSync(from);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('INSTALLATION_SOURCE_INVALID');
    mkdirSync(dirname(to),{recursive:true});
    copyFileSync(from,to,constants.COPYFILE_EXCL);
  }
  await verifyPortableDirectory(destinationRoot);
  return {manifest,manifestHash:shaFile(join(destinationRoot,'RELEASE_MANIFEST.json'))};
}

function moveMutableFrom(sourceRoot:string,destinationRoot:string,mutable:'data'|'temp'):void {
  const from=join(sourceRoot,mutable),to=join(destinationRoot,mutable);
  if(!existsSync(from))return;
  if(!regularDirectory(from)||existsSync(to))throw new Error('INSTALLATION_MUTABLE_DIRECTORY_INVALID');
  renameSync(from,to);
}

function restoreMutableTo(sourceRoot:string,destinationRoot:string,mutable:'data'|'temp'):void {
  const from=join(sourceRoot,mutable),to=join(destinationRoot,mutable);
  if(!existsSync(from)||existsSync(to))return;
  renameSync(from,to);
}

function ensureMutableDirectories(root:string):void {
  for(const name of ['data','temp']){
    const path=join(root,name);
    if(!existsSync(path))mkdirSync(path,{recursive:false});
    if(!regularDirectory(path))throw new Error('INSTALLATION_MUTABLE_DIRECTORY_INVALID');
  }
}

function newState(input:{
  installId?:string;version:string;sourceManifestHash:string;installedAt?:string;
}):InstallationState {
  const now=new Date().toISOString();
  return {
    schema:INSTALL_SCHEMA,
    layout:'PORTABLE_COPY_V1',
    installId:input.installId??randomUUID(),
    version:input.version,
    sourceManifestHash:input.sourceManifestHash,
    installedAt:input.installedAt??now,
    updatedAt:now
  };
}

export async function installPortableDirectory(input:{
  sourceRoot:string;installRoot:string;
}):Promise<InstallResult> {
  const source=resolve(input.sourceRoot),target=assertAbsoluteDirectoryTarget(input.installRoot);
  if(within(source,target))throw new Error('INSTALLATION_PATH_INVALID');
  await verifyPortableDirectory(source);
  if(existsSync(target))throw new Error('INSTALLATION_TARGET_EXISTS');
  const staging=sibling(target,'installing');
  try{
    const copied=await copyPortablePackage(source,staging);
    ensureMutableDirectories(staging);
    const state=newState({version:copied.manifest.version,sourceManifestHash:copied.manifestHash});
    writeJson(join(staging,...STATE_FILE.split('/')),state);
    await verifyPortableDirectory(staging);
    renameSync(staging,target);
    return {...state,installRoot:target};
  }catch(error){
    if(existsSync(staging))rmSync(staging,{recursive:true,force:true});
    throw error;
  }
}

function rollbackFailedUpdate(
  installRoot:string,
  staging:string,
  backup:string,
  previousState:InstallationState,
  pointers:MutablePointerState
):void {
  let failed:string|null=null;
  try{
    if(existsSync(installRoot)){
      failed=sibling(installRoot,'failed-update');
      renameSync(installRoot,failed);
      restoreMutableTo(failed,backup,'data');
      restoreMutableTo(failed,backup,'temp');
    }
    if(existsSync(staging)){
      restoreMutableTo(staging,backup,'data');
      restoreMutableTo(staging,backup,'temp');
    }
    if(existsSync(backup))restoreMutablePointers(backup,previousState,pointers);
    if(!existsSync(installRoot)&&existsSync(backup))renameSync(backup,installRoot);
  }catch{
    // Keep every surviving directory for manual recovery. The original
    // installation is never deleted by this helper.
  }
}

export async function updatePortableDirectory(input:{
  sourceRoot:string;installRoot:string;
}):Promise<UpdateResult> {
  const source=resolve(input.sourceRoot),target=assertAbsoluteDirectoryTarget(input.installRoot);
  if(source===target||within(source,target)||within(target,source))throw new Error('INSTALLATION_PATH_INVALID');
  await verifyPortableDirectory(source);
  const current=await assertManaged(target);
  assertNoActiveProduct(target);
  const pointers=readMutablePointerState(target);
  const staging=sibling(target,'updating'),backup=sibling(target,'rollback');
  try{
    const copied=await copyPortablePackage(source,staging);
    if(existsSync(backup))throw new Error('INSTALLATION_ROLLBACK_EXISTS');
    renameSync(target,backup);
    try{
      for(const name of ['data','temp'] as const)moveMutableFrom(backup,staging,name);
      ensureMutableDirectories(staging);
      const state=newState({
        installId:current.state.installId,
        version:copied.manifest.version,
        sourceManifestHash:copied.manifestHash,
        installedAt:current.state.installedAt
      });
      replaceJson(join(staging,...STATE_FILE.split('/')),state);
      const rollback:RollbackState={
        schema:ROLLBACK_SCHEMA,
        backupRoot:backup,
        backupVersion:current.manifest.version,
        currentVersion:copied.manifest.version,
        createdAt:new Date().toISOString()
      };
      writeJson(join(staging,...ROLLBACK_FILE.split('/')),rollback);
      renameSync(staging,target);
      await assertManaged(target);
      return {...state,installRoot:target,rollbackRoot:backup};
    }catch(error){
      rollbackFailedUpdate(target,staging,backup,current.state,pointers);
      throw error;
    }
  }catch(error){
    if(existsSync(staging))rmSync(staging,{recursive:true,force:true});
    throw error;
  }
}

export async function rollbackPortableDirectory(input:{
  installRoot:string;
}):Promise<RollbackResult> {
  const target=assertAbsoluteDirectoryTarget(input.installRoot);
  const current=await assertManaged(target);
  assertNoActiveProduct(target);
  const rollback=validateRollback(readBoundedJson(join(target,...ROLLBACK_FILE.split('/'))));
  if(dirname(rollback.backupRoot)!==dirname(target)||!regularDirectory(rollback.backupRoot)||
    within(target,rollback.backupRoot)||within(rollback.backupRoot,target)){
    throw new Error('INSTALLATION_ROLLBACK_INVALID');
  }
  await verifyPortableDirectory(rollback.backupRoot);
  const backupManifest=readManifest(rollback.backupRoot);
  if(backupManifest.version!==rollback.backupVersion)throw new Error('INSTALLATION_ROLLBACK_INVALID');
  const pointers=readMutablePointerState(target);

  const staging=sibling(target,'rolling-back'),failed=sibling(target,'failed-update');
  try{
    const copied=await copyPortablePackage(rollback.backupRoot,staging);
    renameSync(target,failed);
    try{
      for(const name of ['data','temp'] as const)moveMutableFrom(failed,staging,name);
      ensureMutableDirectories(staging);
      const state=newState({
        installId:current.state.installId,
        version:copied.manifest.version,
        sourceManifestHash:copied.manifestHash,
        installedAt:current.state.installedAt
      });
      replaceJson(join(staging,...STATE_FILE.split('/')),state);
      try{
        unlinkSync(join(staging,...ROLLBACK_FILE.split('/')));
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      }
      writeJson(join(staging,STATE_DIR,'rollback-history',`${Date.now()}-${randomUUID()}.json`),{
        schema:'dream-maker.windows-rollback-history.v1',
        fromVersion:current.state.version,
        toVersion:state.version,
        failedUpdateRoot:failed,
        at:new Date().toISOString()
      });
      renameSync(staging,target);
      await assertManaged(target);
      return {...state,installRoot:target,failedUpdateRoot:failed};
    }catch(error){
      rollbackFailedUpdate(target,staging,failed,current.state,pointers);
      throw error;
    }
  }catch(error){
    if(existsSync(staging))rmSync(staging,{recursive:true,force:true});
    throw error;
  }
}

export async function uninstallPortableDirectory(input:{
  installRoot:string;
}):Promise<UninstallResult> {
  const target=assertAbsoluteDirectoryTarget(input.installRoot);
  const current=await assertManaged(target);
  assertNoActiveProduct(target);
  const tombstone=sibling(target,'uninstalling'),userDataRoot=sibling(target,'userdata');
  try{
    renameSync(target,tombstone);
    try{
      mkdirSync(userDataRoot,{recursive:false});
      for(const name of ['data','temp'] as const)moveMutableFrom(tombstone,userDataRoot,name);
      ensureMutableDirectories(userDataRoot);
      const receipt:UninstallResult={
        schema:UNINSTALL_SCHEMA,
        installId:current.state.installId,
        version:current.state.version,
        uninstalledAt:new Date().toISOString(),
        installRoot:target,
        userDataRoot
      };
      writeJson(join(userDataRoot,...STATE_DIR.split('/'),'uninstalled.json'),receipt);
      rmSync(tombstone,{recursive:true,force:false});
      return receipt;
    }catch(error){
      if(!existsSync(target)&&existsSync(tombstone)){
        restoreMutableTo(userDataRoot,tombstone,'data');
        restoreMutableTo(userDataRoot,tombstone,'temp');
        renameSync(tombstone,target);
      }
      throw error;
    }
  }catch(error){
    if(existsSync(userDataRoot))rmSync(userDataRoot,{recursive:true,force:true});
    throw error;
  }
}
