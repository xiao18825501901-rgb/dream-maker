import {lstatSync,readdirSync,openSync,closeSync,readSync} from 'node:fs';
import type {Stats} from 'node:fs';
import {resolve,dirname,parse,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {within,DomainError,hasSecret,hash} from '../security.js';
type FileStatus='HASHED'|'MISSING'|'LINK_DENIED'|'FILE_LIMIT'|'NOT_A_FILE'|'SENSITIVE_PATH_DENIED'|'PATH_DENIED'|'SOURCE_CHANGED'|'UNREADABLE';
export interface ComponentFile {path:string;status:FileStatus;bytes?:number;sha256?:string}
function componentPath(path:string):string{
 if(!isAbsolute(path)||path.includes('\0')||/^(?:\\\\|\/\/)/.test(path))throw new DomainError('PATH_DENIED');
 if(path.split(/[\\/]/).some(part=>/^(?:\.env(?:\..*)?|\.ssh|\.aws|\.codex|(?:kimi-|siwc-)?credentials|secrets|auth\.json|tokens?\.json)$/i.test(part))||/\.(?:key|pem|pfx|sqlite|db)$/i.test(path))throw new DomainError('SENSITIVE_PATH_DENIED');
 const absolute=resolve(path),base=parse(absolute).root;return within(base,relative(base,absolute).replaceAll('\\','/'));
}
const same=(a:Stats,b:Stats)=>a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ino===b.ino;
export function observeComponentFile(path:string,maxBytes=256000000):ComponentFile{
 if(typeof path!=='string'||hasSecret(path))return {path:'[REDACTED_PATH]',status:'SENSITIVE_PATH_DENIED'};
 try{
  const checked=componentPath(path),before=lstatSync(checked);if(before.isSymbolicLink())return {path,status:'LINK_DENIED'};if(!before.isFile())return {path,status:'NOT_A_FILE'};
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||before.size>maxBytes)return {path,status:'FILE_LIMIT'};
  const fd=openSync(checked,'r'),digest=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0;
  try{for(let n;(n=readSync(fd,buffer,0,buffer.length,null))>0;){total+=n;if(total>maxBytes)return {path,status:'FILE_LIMIT'};digest.update(buffer.subarray(0,n));}}finally{closeSync(fd);}
  if(total!==before.size||!same(before,lstatSync(componentPath(path))))return {path,status:'SOURCE_CHANGED'};
  return {path:checked,status:'HASHED',bytes:total,sha256:digest.digest('hex')};
 }catch(error){const code=(error as {code?:string}).code;return {path,status:code==='SYMLINK_DENIED'?'LINK_DENIED':code==='ENOENT'?'MISSING':code==='SENSITIVE_PATH_DENIED'?'SENSITIVE_PATH_DENIED':code==='PATH_DENIED'?'PATH_DENIED':'UNREADABLE'};}
}
export interface InstalledPackageObservation {
 status:FileStatus|'METADATA_PRESENT'|'INVALID_METADATA'|'ENTRY_UNVERIFIED'|'PACKAGE_ID_MISMATCH'|'PACKAGE_NOT_FOUND';name:string|null;version:string|null;declaredLicense:string|null;
 manifest:ComponentFile;entry:ComponentFile|null;licenseFiles:ComponentFile[];observedFileBytes:number;measurementScope:'OBSERVED_FILES_ONLY_NOT_PACKAGE_SIZE';
 bundled:false;redistributionReviewed:false;cleanMachineRunVerified:false;roleAcceptance:'NOT_RUN';
}
/** Bounds the second read too: a file growing after observation cannot cause an unbounded allocation. */
export function readComponentJson(path:string,maxBytes=128000):unknown{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>128000)throw new DomainError('COMPONENT_JSON_LIMIT',409);
 const observed=observeComponentFile(path,maxBytes);if(observed.status!=='HASHED')throw new DomainError('COMPONENT_JSON_'+observed.status,409);
 const fd=openSync(componentPath(path),'r'),buffer=Buffer.alloc(maxBytes+1);let total=0;
 try{for(let count;total<buffer.length&&(count=readSync(fd,buffer,total,buffer.length-total,null))>0;)total+=count;}finally{closeSync(fd);}
 if(total>maxBytes)throw new DomainError('COMPONENT_JSON_LIMIT',409);
 const raw=buffer.subarray(0,total);if(hash(raw)!==observed.sha256)throw new DomainError('COMPONENT_JSON_CHANGED',409);
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new DomainError('COMPONENT_JSON_INVALID',409);}
}
/** Metadata only. Does not run package scripts, CLI, auth, model requests, install or copy components. */
export function observeInstalledPackage(manifestPath:string,entryPath?:string):InstalledPackageObservation{
 const manifest=observeComponentFile(manifestPath,128000),entry=entryPath?observeComponentFile(entryPath):null;
 const result:InstalledPackageObservation={status:manifest.status,name:null,version:null,declaredLicense:null,manifest,entry,licenseFiles:[],observedFileBytes:0,measurementScope:'OBSERVED_FILES_ONLY_NOT_PACKAGE_SIZE',bundled:false,redistributionReviewed:false,cleanMachineRunVerified:false,roleAcceptance:'NOT_RUN'};
 if(manifest.status!=='HASHED')return result;
 try{
  const value=readComponentJson(manifestPath) as Record<string,unknown>;
  if(observeComponentFile(manifestPath,128000).sha256!==manifest.sha256){result.status='SOURCE_CHANGED';return result;}
  const field=(v:unknown,pattern:RegExp)=>typeof v==='string'&&v.length<=160&&pattern.test(v)&&!hasSecret(v)?v:null;
  result.name=field(value.name,/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);result.version=field(value.version,/^[0-9][a-zA-Z0-9.+_-]*$/);result.declaredLicense=field(value.license,/^[A-Za-z0-9.()+ _-]+$/);
  if(!result.name||!result.version){result.status='INVALID_METADATA';return result;}
  const names=readdirSync(dirname(componentPath(manifestPath))).filter(name=>/^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:\.[A-Za-z0-9._-]+)?$/i.test(name));
  if(names.length>32){result.status='FILE_LIMIT';return result;}
  result.licenseFiles=names.map(name=>observeComponentFile(resolve(dirname(manifestPath),name),1000000));result.status='METADATA_PRESENT';
  result.observedFileBytes=[manifest,entry,...result.licenseFiles].reduce((sum,file)=>sum+(file?.status==='HASHED'?file.bytes??0:0),0);
  return result;
 }catch{return {...result,status:'INVALID_METADATA'};}
}
/** A relative/missing/foreign entry never inherits the current directory's package identity. */
export function observeExpectedPackage(entryPath:unknown,expectedName:string):InstalledPackageObservation{
 const entry=observeComponentFile(typeof entryPath==='string'?entryPath:''),empty:InstalledPackageObservation={status:'ENTRY_UNVERIFIED',name:null,version:null,declaredLicense:null,manifest:{path:'[UNRESOLVED_PACKAGE]',status:'MISSING'},entry,licenseFiles:[],observedFileBytes:0,measurementScope:'OBSERVED_FILES_ONLY_NOT_PACKAGE_SIZE',bundled:false,redistributionReviewed:false,cleanMachineRunVerified:false,roleAcceptance:'NOT_RUN'};
 if(entry.status!=='HASHED')return empty;
 let dir=dirname(entry.path);
 for(let depth=0;depth<8;depth++){
  const path=resolve(dir,'package.json'),manifest=observeComponentFile(path,128000);
  if(manifest.status==='HASHED'){
   const result=observeInstalledPackage(path,entry.path);
   if(result.status!=='METADATA_PRESENT')return {...result,name:null,version:null,declaredLicense:null};
   if(result.entry?.sha256!==entry.sha256)return {...result,status:'SOURCE_CHANGED',name:null,version:null,declaredLicense:null};
   return result.name===expectedName?result:{...result,status:'PACKAGE_ID_MISMATCH',name:null,version:null,declaredLicense:null};
  }
  if(manifest.status!=='MISSING')return {...empty,status:manifest.status,manifest};
  const parent=dirname(dir);if(parent===dir)break;dir=parent;
 }
 return {...empty,status:'PACKAGE_NOT_FOUND'};
}
export function projectWslConfiguration(raw:{wslDistro?:unknown;wslBinary?:unknown}){
 const text=(value:unknown,pattern:RegExp)=>typeof value==='string'&&value.length>0&&value.length<600&&pattern.test(value)&&!hasSecret(value)?value:null;
 const distro=text(raw.wslDistro,/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),candidate=text(raw.wslBinary,/^\/[A-Za-z0-9@._/-]+$/),binary=candidate&&!candidate.split('/').some(part=>part==='..'||/^(?:\.ssh|\.codex|credentials|auth\.json)$/i.test(part))?candidate:null;
 return {distro,binary,inventory:distro&&binary?'CONFIGURED_NOT_OBSERVED' as const:'UNKNOWN_OR_REDACTED' as const,authQueried:false as const,turnStarted:false as const};
}
