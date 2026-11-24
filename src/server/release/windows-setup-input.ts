// Controller-only Setup input. Never traverse or archive mutable package state.
import {createHash} from 'node:crypto';
import {closeSync,existsSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,rmSync,writeSync,type Stats} from 'node:fs';
import {basename,dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {isWindowsPackageSegment} from './windows-package-path.js';
import {verifyPortableDirectory} from './windows-portable.js';
import {verifySuiteComposition} from './windows-suite-composition.js';

const MAX_METADATA=8*1024*1024,MAX_FILE=2_147_483_648,MAX_TOTAL=4*1024*1024*1024;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fail=(code:string):never=>{throw Error('SETUP_INPUT_'+code)};
interface Entry {path:string;bytes:number;sha256:string}
function same(a:Stats,b:Stats):boolean {
  return a.isFile()&&b.isFile()&&a.nlink===1&&b.nlink===1&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&
    a.ctimeMs===b.ctimeMs&&a.ino===b.ino&&a.dev===b.dev&&a.mode===b.mode;
}
function noLinks(path:string,leaf:'file'|'directory'):Stats {
  const full=resolve(path),root=parse(full).root,parts=relative(root,full).split(sep).filter(Boolean);
  let current=root,stat=lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('LINK_DENIED');
  for(let i=0;i<parts.length;i++){
    current=join(current,parts[i]);stat=lstatSync(current);
    if(stat.isSymbolicLink())fail('LINK_DENIED');
    if(stat.isFile()&&stat.nlink!==1)fail('LINK_DENIED');
    if(i<parts.length-1?!stat.isDirectory():leaf==='file'?!stat.isFile():!stat.isDirectory())fail('PATH_INVALID');
  }
  return stat;
}
function nested(a:string,b:string):boolean {
  const rel=relative(a,b);return !rel||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));
}
function ordinaryPath(value:string):string {
  const full=resolve(value),root=parse(full).root;
  if(process.platform==='win32'&&!/^[A-Za-z]:\\$/.test(root))fail('PATH_INVALID');
  if(relative(root,full).split(sep).filter(Boolean).some(part=>!isWindowsPackageSegment(part)))fail('PATH_INVALID');
  return full;
}
function sourcePath(value:string):string {
  const full=ordinaryPath(value);noLinks(full,'directory');return ordinaryPath(realpathSync.native(full));
}
function targetPath(value:string):string {
  const full=ordinaryPath(value),missing=[basename(full)];let parent=dirname(full);
  for(;;){
    try{lstatSync(parent);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const next=dirname(parent);if(next===parent)fail('PATH_INVALID');missing.unshift(basename(parent));parent=next;
  }
  noLinks(parent,'directory');
  // Resolve existing ancestors too: lexical comparisons alone miss NTFS 8.3 aliases.
  return resolve(ordinaryPath(realpathSync.native(parent)),...missing);
}
// Validate CLI destinations before mkdir. Missing descendants may be created only
// under a checked, non-linked existing parent, outside the source package.
export function assertSetupDestinations(sourceRoot:string,destinations:string[]):void {
  const source=sourcePath(sourceRoot),seen=new Set<string>();
  for(const destination of destinations){
    const full=targetPath(destination),identity=full.normalize('NFC').toLowerCase();
    if(nested(source,full)||nested(full,source))fail('OUTPUT_OVERLAP');
    if(seen.has(identity))fail('OUTPUT_OVERLAP');seen.add(identity);
  }
}
function readMetadata(path:string):Buffer {
  const observed=noLinks(path,'file');
  if(observed.size<=0||observed.size>MAX_METADATA)fail('METADATA_INVALID');
  const fd=openSync(path,'r');
  try{
    if(!same(observed,fstatSync(fd)))fail('SOURCE_CHANGED');
    const bytes=Buffer.alloc(observed.size);let offset=0;
    while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)fail('SOURCE_CHANGED');offset+=count;}
    if(!same(observed,fstatSync(fd))||!same(observed,noLinks(path,'file')))fail('SOURCE_CHANGED');
    return bytes;
  }finally{closeSync(fd);}
}
function entries(bytes:Buffer,suite:boolean,manifestName:string):Entry[] {
  let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('METADATA_INVALID');}
  if(!Array.isArray(raw?.files)||raw.files.length<1||raw.files.length>20_000)fail('METADATA_INVALID');
  const seen=new Set([manifestName.toLowerCase(),'sha256sums.txt']);let total=0;
  const result=raw.files.map((file:Entry)=>{
    if(!file||typeof file.path!=='string'||!file.path||file.path.length>1000||file.path.includes('\\')||
      file.path.split('/').some(part=>!isWindowsPackageSegment(part)))fail('PATH_INVALID');
    const identity=file.path.normalize('NFC').toLowerCase();
    const mutable=suite?/^core\/(data|temp)(\/|$)/:/^(data|temp)(\/|$)/;
    if(mutable.test(identity))fail('MUTABLE_DECLARED');
    if(seen.has(identity))fail('DUPLICATE');seen.add(identity);
    if(!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>MAX_FILE||
      typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))fail('METADATA_INVALID');
    total+=file.bytes;if(total>MAX_TOTAL)fail('TOTAL_LIMIT');
    return{path:file.path,bytes:file.bytes,sha256:file.sha256};
  });
  for(const identity of seen){
    const parts=identity.split('/');parts.pop();
    while(parts.length){if(seen.has(parts.join('/')))fail('PATH_INVALID');parts.pop();}
  }
  return result;
}
function copyEntry(source:string,target:string,entry:Entry,buffer:Buffer):void {
  const path=join(source,entry.path),before=noLinks(path,'file');
  if(before.size!==entry.bytes)fail('SOURCE_CHANGED');
  const input=openSync(path,'r');let output:number|undefined;
  try{
    if(!same(before,fstatSync(input)))fail('SOURCE_CHANGED');
    const destination=join(target,entry.path);mkdirSync(dirname(destination),{recursive:true});
    noLinks(dirname(destination),'directory');output=openSync(destination,'wx');
    const digest=createHash('sha256');let total=0;
    while(total<entry.bytes){
      const count=readSync(input,buffer,0,Math.min(buffer.length,entry.bytes-total),null);
      if(!count)fail('SOURCE_CHANGED');digest.update(buffer.subarray(0,count));
      let written=0;while(written<count){const n=writeSync(output,buffer,written,count-written);if(!n)fail('WRITE_FAILED');written+=n;}
      total+=count;
    }
    if(digest.digest('hex')!==entry.sha256||!same(before,fstatSync(input))||!same(before,noLinks(path,'file')))fail('SOURCE_CHANGED');
    fsyncSync(output);
  }finally{if(output!==undefined)closeSync(output);closeSync(input);}
}

export async function snapshotSetupInput(sourceRoot:string,output:string) {
  const source=sourcePath(sourceRoot),target=targetPath(output);
  if(nested(source,target)||nested(target,source))fail('OUTPUT_OVERLAP');
  if(existsSync(target))fail('OUTPUT_EXISTS');
  noLinks(source,'directory');noLinks(dirname(target),'directory');
  const suite=existsSync(join(source,'SUITE_COMPOSITION_MANIFEST.json'));
  const manifestName=suite?'SUITE_COMPOSITION_MANIFEST.json':'RELEASE_MANIFEST.json';
  const manifest=readMetadata(join(source,manifestName));
  const files=entries(manifest,suite,manifestName),sums=readMetadata(join(source,'SHA256SUMS.txt'));
  // The source verifier must not read mutable data via a nested Core manifest either.
  if(suite){
    const core=readMetadata(join(source,'core','RELEASE_MANIFEST.json'));
    for(const path of ['core/SHA256SUMS.txt','runtime/agent-bundle/SHA256SUMS.txt','runtime/agent-bundle/RUNTIME_BUNDLE_MANIFEST.json']){
      readMetadata(join(source,path));
    }
    const declared=new Map(files.map(file=>[file.path,file]));
    const coreEntry=declared.get('core/RELEASE_MANIFEST.json');
    if(!coreEntry||coreEntry.bytes!==core.length||coreEntry.sha256!==sha(core))fail('SOURCE_CHANGED');
    for(const file of entries(core,false,'RELEASE_MANIFEST.json')){
      const outer=declared.get('core/'+file.path);
      if(!outer||outer.bytes!==file.bytes||outer.sha256!==file.sha256)fail('SOURCE_CHANGED');
    }
  }
  for(const file of files)if(noLinks(join(source,file.path),'file').size!==file.bytes)fail('SOURCE_CHANGED');
  const verify=suite?verifySuiteComposition:verifyPortableDirectory;
  const original=await verify(source);
  if(original.manifestHash!==sha(manifest))fail('SOURCE_CHANGED');
  let created=false;
  try{
    mkdirSync(target);created=true;
    const buffer=Buffer.allocUnsafe(1024*1024);
    for(const file of files)copyEntry(source,target,file,buffer);
    for(const [path,bytes] of [[manifestName,manifest],['SHA256SUMS.txt',sums]] as const){
      copyEntry(source,target,{path,bytes:bytes.length,sha256:sha(bytes)},buffer);
    }
    const verification=await verify(target);
    if(verification.manifestHash!==original.manifestHash)fail('SOURCE_CHANGED');
    return{packageKind:suite?'SUITE' as const:'CORE' as const,payloadInput:'IMMUTABLE_MANIFEST_SNAPSHOT' as const,
      snapshot:target,snapshotFiles:files.length+2,verification};
  }catch(error){if(created)rmSync(target,{recursive:true,force:true});throw error;}
}
