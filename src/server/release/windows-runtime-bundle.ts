import {createHash} from 'node:crypto';
import {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync
} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {isWindowsPackageSegment} from './windows-package-path.js';

export const REQUIRED_RUNTIME_COMPONENTS=[
  'dm-controller','dreamflow-core','codex-runtime','dsh-runtime',
  'planner1-cloud-runtime','verified-base-toolchain'
] as const;

type ComponentId=typeof REQUIRED_RUNTIME_COMPONENTS[number];
interface BundleFile {path:string;bytes:number;sha256:string}
interface ComponentSource {
  kind:'GIT_COMMIT'|'RELEASE_ASSET'|'LOCAL_PACKAGE';
  locator:string;
  revision:string;
}
interface ComponentReference {
  id:ComponentId;
  version:string;
  status:string;
  source:ComponentSource;
  files:{
    artifact:BundleFile;
    license:BundleFile;
    sbom:BundleFile;
    fragment:BundleFile;
  };
}
interface RuntimeBundleManifest {
  schema:'dream-maker.windows-runtime-bundle.v1';
  product:'DreamMaker Suite';
  builtAt:string;
  scope:'LOCAL_RUNTIME_BYTES_NOT_REDISTRIBUTABLE_RELEASE';
  status:'PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE';
  sourceIndexSha256:string;
  components:ComponentReference[];
  files:BundleFile[];
  filesHash:string;
  artifactBytes:number;
  releaseReady:false;
  redistributionReviewed:false;
  cleanWindowsVerified:false;
  binariesExecuted:false;
  credentialsIncluded:false;
  modelsIncluded:false;
}

const HASH=/^[a-f0-9]{64}$/;
const MAX_INDEX=512_000;
const MAX_FRAGMENT=256_000;
const MAX_LICENSE=32*1024*1024;
const MAX_SBOM=32*1024*1024;
const MAX_ARTIFACT=2_147_483_648;
const MAX_COMPONENTS=16;
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');

function fail(code:string):never{throw new Error(code)}
function text(value:unknown,max=2000):value is string{
  return typeof value==='string'&&value.length>0&&value.length<=max&&!CONTROL.test(value);
}
function record(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function int(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number{
  return Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
}
function pathParts(value:unknown):string[]{
  if(!text(value,1000)||isAbsolute(value)||/^[A-Za-z]:/.test(value)||/^[\\/]{2}/.test(value))fail('RUNTIME_BUNDLE_PATH_INVALID');
  const parts=value.split(/[\\/]+/);
  if(parts.some(part=>!isWindowsPackageSegment(part)))fail('RUNTIME_BUNDLE_PATH_INVALID');
  return parts;
}
function safePath(root:string,value:unknown):{absolute:string;parts:string[]}{
  const parts=pathParts(value),absolute=resolve(root,...parts),rel=relative(resolve(root),absolute);
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))fail('RUNTIME_BUNDLE_PATH_INVALID');
  return {absolute,parts};
}
function sameFile(a:{size:number;mtimeMs:number;ino:number|bigint;mode:number},b:{size:number;mtimeMs:number;ino:number|bigint;mode:number}):boolean{
  return a.size===b.size&&a.mtimeMs===b.mtimeMs&&String(a.ino)===String(b.ino)&&a.mode===b.mode;
}
function hashRegularFile(path:string,maxBytes:number,errorCode:string):{bytes:number;sha256:string}{
  let fd:number|undefined;
  try{
    fd=openSync(path,'r');
    const before=fstatSync(fd);
    if(!before.isFile()||before.size<0||before.size>maxBytes)fail(errorCode);
    const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){
      total+=count;
      if(total>maxBytes)fail(errorCode);
      digest.update(buffer.subarray(0,count));
    }
    if(total!==before.size||!sameFile(before,lstatSync(path)))fail(errorCode);
    return {bytes:total,sha256:digest.digest('hex')};
  }finally{
    if(fd!==undefined)closeSync(fd);
  }
}
function noLinks(root:string,parts:string[]):string{
  let current=resolve(root),before;
  for(let index=0;index<parts.length;index++){
    current=resolve(current,parts[index]);
    before=lstatSync(current);
    if(before.isSymbolicLink())return 'RUNTIME_BUNDLE_LINK_DENIED';
    if(index<parts.length-1&&!before.isDirectory())return 'RUNTIME_BUNDLE_PATH_INVALID';
    if(index===parts.length-1&&!before.isFile())return 'RUNTIME_BUNDLE_PATH_INVALID';
  }
  return current;
}
function readPinned(root:string,value:unknown,expectedSha:unknown,maxBytes:number,errorCode:string):{bytes:Buffer;file:BundleFile}{
  if(expectedSha!==null&&(typeof expectedSha!=='string'||!HASH.test(expectedSha)))fail('RUNTIME_BUNDLE_HASH_INVALID');
  const safe=safePath(root,value),linked=noLinks(root,safe.parts);
  let fd:number|undefined;
  try{
    fd=openSync(linked,'r');
    const before=fstatSync(fd);
    if(!before.isFile()||before.size>maxBytes)fail('RUNTIME_BUNDLE_FILE_LIMIT');
    const body=Buffer.alloc(before.size),buffer=Buffer.alloc(Math.min(65536,Math.max(1,before.size)));
    let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){
      if(total+count>maxBytes)fail('RUNTIME_BUNDLE_FILE_LIMIT');
      buffer.copy(body,total,0,count);total+=count;
    }
    const after=lstatSync(linked);
    const actual=sha(body);
    if(total!==before.size||!sameFile(before,after)||(expectedSha!==null&&actual!==expectedSha))fail(errorCode);
    return {bytes:body,file:{path:safe.parts.join('/'),bytes:total,sha256:actual}};
  }finally{
    if(fd!==undefined)closeSync(fd);
  }
}
function copyPinned(
  root:string,value:unknown,target:string,expectedSha:unknown,expectedBytes:unknown,
  maxBytes:number,changedCode:string,sizeCode='RUNTIME_BUNDLE_FILE_SIZE_MISMATCH'
):BundleFile{
  if(typeof expectedSha!=='string'||!HASH.test(expectedSha))fail('RUNTIME_BUNDLE_HASH_INVALID');
  if(expectedBytes!==undefined&&(!int(expectedBytes,1,maxBytes)))fail('RUNTIME_BUNDLE_SIZE_INVALID');
  const safe=safePath(root,value),linked=noLinks(root,safe.parts);
  let sourceFd:number|undefined,targetFd:number|undefined;
  try{
    sourceFd=openSync(linked,'r');
    const before=fstatSync(sourceFd);
    if(!before.isFile()||before.size>maxBytes)fail('RUNTIME_BUNDLE_FILE_LIMIT');
    if(expectedBytes!==undefined&&before.size!==expectedBytes)fail(sizeCode);
    targetFd=openSync(target,'wx');
    const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let total=0;
    for(let count;(count=readSync(sourceFd,buffer,0,Math.min(buffer.length,maxBytes-total+1),null))>0;){
      total+=count;
      if(total>maxBytes||(expectedBytes!==undefined&&total>expectedBytes))fail('RUNTIME_BUNDLE_FILE_LIMIT');
      digest.update(buffer.subarray(0,count));
      let offset=0;
      while(offset<count){
        const written=writeSync(targetFd,buffer,offset,count-offset);
        if(written<=0)fail('RUNTIME_BUNDLE_WRITE_FAILED');
        offset+=written;
      }
    }
    const after=lstatSync(linked),actual=digest.digest('hex');
    if(total!==before.size||!sameFile(before,after))fail(changedCode);
    if(expectedBytes!==undefined&&total!==expectedBytes)fail(sizeCode);
    if(actual!==expectedSha)fail(changedCode);
    return {path:'',bytes:total,sha256:actual};
  }finally{
    if(targetFd!==undefined)closeSync(targetFd);
    if(sourceFd!==undefined)closeSync(sourceFd);
  }
}
function parseJson(body:Buffer,code:string):unknown{
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{fail(code)}
}
function sourceValue(value:unknown):ComponentSource{
  if(!record(value)||!['GIT_COMMIT','RELEASE_ASSET','LOCAL_PACKAGE'].includes(String(value.kind))||
      !text(value.locator,600)||!text(value.revision,200))fail('RUNTIME_BUNDLE_SOURCE_INVALID');
  return {kind:value.kind as ComponentSource['kind'],locator:value.locator,revision:value.revision};
}
function fileReference(value:unknown,sizeRequired=false):{path:string;bytes:number|undefined;sha256:string}{
  if(!record(value)||!text(value.path,1000)||typeof value.sha256!=='string'||!HASH.test(value.sha256)||
      (sizeRequired?!int(value.bytes,1,MAX_ARTIFACT):value.bytes!==undefined&&!int(value.bytes,1,MAX_ARTIFACT)))
    fail('RUNTIME_BUNDLE_COMPONENT_REFERENCE_INVALID');
  pathParts(value.path);
  return {path:value.path,bytes:value.bytes as number|undefined,sha256:value.sha256};
}
function ensureManifest(manifest:RuntimeBundleManifest):void{
  if(manifest.schema!=='dream-maker.windows-runtime-bundle.v1'||manifest.product!=='DreamMaker Suite'||
      manifest.scope!=='LOCAL_RUNTIME_BYTES_NOT_REDISTRIBUTABLE_RELEASE'||
      manifest.status!=='PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE'||
      manifest.releaseReady!==false||manifest.redistributionReviewed!==false||
      manifest.cleanWindowsVerified!==false||manifest.binariesExecuted!==false||
      manifest.credentialsIncluded!==false||manifest.modelsIncluded!==false||
      !HASH.test(manifest.sourceIndexSha256)||!Array.isArray(manifest.components)||
      manifest.components.length!==REQUIRED_RUNTIME_COMPONENTS.length||
      !Array.isArray(manifest.files)||!int(manifest.artifactBytes))
    fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
  if(Number.isNaN(Date.parse(manifest.builtAt)))fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
  const ids=manifest.components.map(component=>component.id).sort();
  if(JSON.stringify(ids)!==JSON.stringify([...REQUIRED_RUNTIME_COMPONENTS].sort()))fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
  const expectedFiles=new Set<string>(['README_CN.md','verify-runtime-bundle.mjs']);
  let artifactBytes=0;
  for(const component of manifest.components){
    if(!record(component)||!text(component.version,160)||!text(component.status,200)||!record(component.source)||
        !record(component.files)||!record(component.files.artifact)||!record(component.files.license)||
        !record(component.files.sbom)||!record(component.files.fragment))
      fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
    sourceValue(component.source);
    const refs=[
      ['artifact',component.files.artifact,'artifact.bin'],
      ['license',component.files.license,'LICENSE.txt'],
      ['sbom',component.files.sbom,'component-sbom.json'],
      ['fragment',component.files.fragment,'fragment.json']
    ] as const;
    for(const [kind,file,name] of refs){
      const expected=`components/${component.id}/${name}`;
      if(file.path!==expected||!int(file.bytes,0,kind==='artifact'?MAX_ARTIFACT:MAX_LICENSE)||
          typeof file.sha256!=='string'||!HASH.test(file.sha256))
        fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
      expectedFiles.add(expected);
    }
    artifactBytes+=component.files.artifact.bytes;
  }
  if(artifactBytes!==manifest.artifactBytes)fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
  const actualFiles=manifest.files.map(file=>file.path),seen=new Set<string>();
  if(actualFiles.length!==expectedFiles.size)fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
  for(const file of manifest.files){
    if(!record(file)||!text(file.path,1000)||!int(file.bytes)||
        typeof file.sha256!=='string'||!HASH.test(file.sha256))
      fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
    pathParts(file.path);
    const identity=file.path.normalize('NFC').toLocaleLowerCase('en-US');
    if(seen.has(identity)||!expectedFiles.has(file.path))fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
    seen.add(identity);
  }
  if(sha(JSON.stringify(manifest.files))!==manifest.filesHash)fail('RUNTIME_BUNDLE_FILES_HASH_MISMATCH');
}

export interface BuildRuntimeBundleOptions {
  evidenceRoot:string;
  indexPath:string;
  output:string;
  builtAt?:string;
}
export async function buildRuntimeBundle(options:BuildRuntimeBundleOptions):Promise<{
  output:string;status:'PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE';components:number;
  artifactBytes:number;files:number;manifestHash:string;
  binariesExecuted:false;credentialsIncluded:false;modelsIncluded:false;
}>{
  const evidence=resolve(options.evidenceRoot),output=resolve(options.output);
  if(!existsSync(evidence)||!statSync(evidence).isDirectory())fail('RUNTIME_BUNDLE_EVIDENCE_ROOT_INVALID');
  if(existsSync(output))fail('RUNTIME_BUNDLE_OUTPUT_EXISTS');
  const indexSafe=safePath(evidence,relative(evidence,resolve(options.indexPath)));
  const index=readPinned(evidence,indexSafe.parts.join('/'),null,MAX_INDEX,'RUNTIME_BUNDLE_INDEX_INVALID');
  const indexValue=parseJson(index.bytes,'RUNTIME_BUNDLE_INDEX_INVALID');
  if(!record(indexValue)||indexValue.schema!=='dream-maker.release-evidence-index.v1'||
      !Array.isArray(indexValue.components)||indexValue.components.length>MAX_COMPONENTS)
    fail('RUNTIME_BUNDLE_INDEX_INVALID');
  const ids:ComponentId[]=[],seen=new Set<string>();
  for(const item of indexValue.components){
    if(!record(item)||!text(item.id,128))fail('RUNTIME_BUNDLE_COMPONENT_INVALID');
    if(!(REQUIRED_RUNTIME_COMPONENTS as readonly string[]).includes(item.id))fail('RUNTIME_BUNDLE_UNKNOWN_COMPONENT');
    if(seen.has(item.id))fail('RUNTIME_BUNDLE_COMPONENT_DUPLICATE');
    if(!text(item.version,160)||typeof item.fragmentPath!=='string'||
        typeof item.fragmentSha256!=='string'||!HASH.test(item.fragmentSha256))
      fail('RUNTIME_BUNDLE_COMPONENT_INVALID');
    seen.add(item.id);ids.push(item.id as ComponentId);
  }
  for(const id of REQUIRED_RUNTIME_COMPONENTS)if(!seen.has(id))fail('RUNTIME_BUNDLE_REQUIRED_COMPONENT_MISSING:'+id);
  const temporary=output+'.partial-'+process.pid+'-'+Date.now();
  if(existsSync(temporary))fail('RUNTIME_BUNDLE_TEMP_EXISTS');
  mkdirSync(dirname(output),{recursive:true});mkdirSync(temporary,{recursive:false});
  try{
    const components:ComponentReference[]=[];const files:BundleFile[]=[];
    for(const item of indexValue.components as Record<string,unknown>[]){
      const id=item.id as ComponentId;
      const fragmentRef={path:item.fragmentPath as string,sha256:item.fragmentSha256 as string};
      if(item.fragmentBytes!==undefined&&!int(item.fragmentBytes,1,MAX_FRAGMENT))fail('RUNTIME_BUNDLE_FRAGMENT_SIZE_INVALID');
      const fragment=readPinned(evidence,fragmentRef.path,fragmentRef.sha256,MAX_FRAGMENT,'RUNTIME_BUNDLE_FRAGMENT_CHANGED');
      if(item.fragmentBytes!==undefined&&fragment.file.bytes!==item.fragmentBytes)fail('RUNTIME_BUNDLE_FRAGMENT_SIZE_MISMATCH');
      const value=parseJson(fragment.bytes,'RUNTIME_BUNDLE_FRAGMENT_INVALID');
      if(!record(value)||value.schema!=='dream-maker.release-component-fragment.v1'||
          value.componentId!==id||!record(value.component)||value.component.id!==id||
          value.component.version!==item.version)
        fail('RUNTIME_BUNDLE_FRAGMENT_BINDING_INVALID');
      const source=sourceValue(value.component.source),artifact=fileReference(value.component.artifact,true),
        license=fileReference(value.component.license),sbom=fileReference(value.component.sbom);
      const componentRoot=join(temporary,'components',id);
      mkdirSync(componentRoot,{recursive:true});
      const artifactFile=copyPinned(evidence,artifact.path,join(componentRoot,'artifact.bin'),artifact.sha256,artifact.bytes,
        MAX_ARTIFACT,'RUNTIME_BUNDLE_ARTIFACT_CHANGED','RUNTIME_BUNDLE_ARTIFACT_SIZE_MISMATCH');
      artifactFile.path=`components/${id}/artifact.bin`;files.push(artifactFile);
      const licenseFile=copyPinned(evidence,license.path,join(componentRoot,'LICENSE.txt'),license.sha256,license.bytes,
        MAX_LICENSE,'RUNTIME_BUNDLE_LICENSE_CHANGED');
      licenseFile.path=`components/${id}/LICENSE.txt`;files.push(licenseFile);
      const sbomFile=copyPinned(evidence,sbom.path,join(componentRoot,'component-sbom.json'),sbom.sha256,sbom.bytes,
        MAX_SBOM,'RUNTIME_BUNDLE_SBOM_CHANGED');
      sbomFile.path=`components/${id}/component-sbom.json`;files.push(sbomFile);
      const copiedFragment=copyPinned(evidence,fragmentRef.path,join(componentRoot,'fragment.json'),fragmentRef.sha256,
        fragment.file.bytes,MAX_FRAGMENT,'RUNTIME_BUNDLE_FRAGMENT_CHANGED');
      copiedFragment.path=`components/${id}/fragment.json`;files.push(copiedFragment);
      components.push({
        id,version:String(item.version),status:text(value.status,160)?value.status:'PARTIAL_COMPONENT_EVIDENCE',
        source,files:{artifact:artifactFile,license:licenseFile,sbom:sbomFile,
          fragment:copiedFragment}
      });
    }
    const readme=Buffer.from(runtimeReadme(),'utf8'),verifier=Buffer.from(runtimeVerifier(),'utf8');
    writeFileSync(join(temporary,'README_CN.md'),readme,{flag:'wx'});
    writeFileSync(join(temporary,'verify-runtime-bundle.mjs'),verifier,{flag:'wx'});
    files.push({path:'README_CN.md',bytes:readme.length,sha256:sha(readme)});
    files.push({path:'verify-runtime-bundle.mjs',bytes:verifier.length,sha256:sha(verifier)});
    components.sort((a,b)=>a.id.localeCompare(b.id,'en'));files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
    const artifactBytes=components.reduce((sum,component)=>sum+component.files.artifact.bytes,0);
    const builtAt=options.builtAt??new Date().toISOString();
    if(Number.isNaN(Date.parse(builtAt)))fail('RUNTIME_BUNDLE_TIME_INVALID');
    const manifest:RuntimeBundleManifest={
      schema:'dream-maker.windows-runtime-bundle.v1',product:'DreamMaker Suite',builtAt,
      scope:'LOCAL_RUNTIME_BYTES_NOT_REDISTRIBUTABLE_RELEASE',
      status:'PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE',
      sourceIndexSha256:sha(index.bytes),components,files,filesHash:sha(JSON.stringify(files)),
      artifactBytes,releaseReady:false,redistributionReviewed:false,cleanWindowsVerified:false,
      binariesExecuted:false,credentialsIncluded:false,modelsIncluded:false
    };
    ensureManifest(manifest);
    const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
    writeFileSync(join(temporary,'RUNTIME_BUNDLE_MANIFEST.json'),manifestBytes,{flag:'wx'});
    const sums=[...files,{path:'RUNTIME_BUNDLE_MANIFEST.json',bytes:manifestBytes.length,sha256:sha(manifestBytes)}]
      .sort((a,b)=>a.path.localeCompare(b.path,'en')).map(file=>`${file.sha256}  ${file.path}`).join('\n')+'\n';
    writeFileSync(join(temporary,'SHA256SUMS.txt'),sums,{flag:'wx'});
    await verifyRuntimeBundle(temporary);
    renameSync(temporary,output);
    return {output,status:'PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE',components:components.length,
      artifactBytes,files:files.length,manifestHash:sha(manifestBytes),binariesExecuted:false,
      credentialsIncluded:false,modelsIncluded:false};
  }catch(error){
    if(existsSync(temporary))rmSync(temporary,{recursive:true,force:true});
    throw error;
  }
}

export async function verifyRuntimeBundle(root:string):Promise<{
  status:'PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE';components:number;artifactBytes:number;
  files:number;manifestHash:string;releaseReady:false;redistributionReviewed:false;
}>{
  const base=resolve(root),manifestPath=join(base,'RUNTIME_BUNDLE_MANIFEST.json');
  if(!existsSync(manifestPath))fail('RUNTIME_BUNDLE_MANIFEST_MISSING');
  const stat=lstatSync(manifestPath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_INDEX)fail('RUNTIME_BUNDLE_MANIFEST_INVALID');
  const manifestBytes=readFileSync(manifestPath);
  const manifest=parseJson(manifestBytes,'RUNTIME_BUNDLE_MANIFEST_INVALID') as RuntimeBundleManifest;
  ensureManifest(manifest);
  const expected=new Set<string>(['RUNTIME_BUNDLE_MANIFEST.json','SHA256SUMS.txt']);
  for(const file of manifest.files){
    const safe=safePath(base,file.path),linked=noLinks(base,safe.parts),
      observed=hashRegularFile(linked,MAX_ARTIFACT,'RUNTIME_BUNDLE_FILE_CHANGED');
    if(observed.bytes!==file.bytes||observed.sha256!==file.sha256)fail('RUNTIME_BUNDLE_FILE_CHANGED');
    expected.add(file.path);
  }
  const sumsLines=readFileSync(join(base,'SHA256SUMS.txt'),'utf8').split(/\r?\n/).filter(Boolean),
    sums=new Map<string,string>();
  for(const line of sumsLines){
    const match=/^([a-f0-9]{64})  (.+)$/.exec(line);
    if(!match||sums.has(match[2]))fail('RUNTIME_BUNDLE_SUMS_INVALID');
    sums.set(match[2],match[1]);
  }
  for(const file of manifest.files)if(sums.get(file.path)!==file.sha256)fail('RUNTIME_BUNDLE_SUM_MISMATCH');
  if(sums.size!==manifest.files.length+1||sums.get('RUNTIME_BUNDLE_MANIFEST.json')!==sha(manifestBytes))
    fail('RUNTIME_BUNDLE_SUM_MISMATCH');
  const walk=(folder:string,prefix=''):void=>{
    for(const entry of readdirSync(folder,{withFileTypes:true})){
      const path=prefix?`${prefix}/${entry.name}`:entry.name,full=join(folder,entry.name);
      if(entry.isSymbolicLink())fail('RUNTIME_BUNDLE_LINK_DENIED');
      if(entry.isDirectory())walk(full,path);
      else if(!entry.isFile()||!expected.has(path))fail('RUNTIME_BUNDLE_EXTRA_FILE');
    }
  };
  walk(base);
  return {status:manifest.status,components:manifest.components.length,artifactBytes:manifest.artifactBytes,
    files:manifest.files.length,manifestHash:sha(manifestBytes),releaseReady:false,redistributionReviewed:false};
}

function runtimeReadme():string{
  return `# Dream Maker Agent 运行时补充包

这个目录只保存已经固定版本和 SHA-256 的本地运行时字节、许可证证据与 SBOM。
它没有执行任何二进制，没有包含登录凭据、Cookie、API Key 或用户数据库。

当前状态仍不是正式发行包：

- 未完成清洁 Windows 实机验证；
- 未完成法律再分发审阅；
- 未完成代码签名；
- 不能替代四个角色的真实业务验收。

使用前请运行 \`node verify-runtime-bundle.mjs\` 核对全部文件。
`;
}

function runtimeVerifier():string{
  return `import {createHash} from 'node:crypto';
import {closeSync,fstatSync,lstatSync,openSync,readFileSync,readSync,readdirSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
${isWindowsPackageSegment.toString()}
const root=dirname(fileURLToPath(import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
const hashFile=path=>{
  const fd=openSync(path,'r');
  try{
    const before=fstatSync(fd),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){total+=count;digest.update(buffer.subarray(0,count));}
    const after=fstatSync(fd);
    if(total!==before.size||String(before.ino)!==String(after.ino)||before.mtimeMs!==after.mtimeMs)
      throw new Error('RUNTIME_BUNDLE_SOURCE_CHANGED');
    return {bytes:total,sha256:digest.digest('hex')};
  }finally{closeSync(fd);}
};
const manifestBytes=readFileSync(join(root,'RUNTIME_BUNDLE_MANIFEST.json'));
const manifest=JSON.parse(manifestBytes.toString('utf8'));
if(manifest.schema!=='dream-maker.windows-runtime-bundle.v1'||manifest.releaseReady!==false||
  manifest.redistributionReviewed!==false||manifest.cleanWindowsVerified!==false)
  throw new Error('RUNTIME_BUNDLE_MANIFEST_INVALID');
const expected=new Set(['RUNTIME_BUNDLE_MANIFEST.json','SHA256SUMS.txt']);
for(const file of manifest.files){
  if(typeof file.path!=='string'||file.path.length>1000||file.path.split('/').some(part=>!isWindowsPackageSegment(part)))
    throw new Error('RUNTIME_BUNDLE_PATH_INVALID');
  const path=resolve(root,file.path),rel=relative(root,path);
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('RUNTIME_BUNDLE_PATH_INVALID');
  const stat=lstatSync(path);
  const observed=hashFile(path);
  if(!stat.isFile()||stat.isSymbolicLink()||observed.bytes!==file.bytes||observed.sha256!==file.sha256)
    throw new Error('RUNTIME_BUNDLE_FILE_CHANGED');
  expected.add(file.path);
}
const sums=new Map();
for(const line of readFileSync(join(root,'SHA256SUMS.txt'),'utf8').split(/\\r?\\n/).filter(Boolean)){
  const match=/^([a-f0-9]{64})  (.+)$/.exec(line);
  if(!match||sums.has(match[2]))throw new Error('RUNTIME_BUNDLE_SUMS_INVALID');
  sums.set(match[2],match[1]);
}
for(const file of manifest.files)if(sums.get(file.path)!==file.sha256)throw new Error('RUNTIME_BUNDLE_SUM_MISMATCH');
if(sums.size!==manifest.files.length+1||sums.get('RUNTIME_BUNDLE_MANIFEST.json')!==sha(manifestBytes))
  throw new Error('RUNTIME_BUNDLE_SUM_MISMATCH');
const walk=(folder,prefix='')=>{
  for(const entry of readdirSync(folder,{withFileTypes:true})){
    const rel=prefix?prefix+'/'+entry.name:entry.name;
    if(entry.isSymbolicLink())throw new Error('RUNTIME_BUNDLE_LINK_DENIED');
    if(entry.isDirectory())walk(join(folder,entry.name),rel);
    else if(!entry.isFile()||!expected.has(rel))throw new Error('RUNTIME_BUNDLE_EXTRA_FILE');
  }
};
walk(root);
console.log(JSON.stringify({status:manifest.status,components:manifest.components.length,
  artifactBytes:manifest.artifactBytes,files:manifest.files.length,manifestHash:sha(manifestBytes)}));
`;
}
