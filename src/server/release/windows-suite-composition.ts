import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {verifyPortableDirectory} from './windows-portable.js';
import {verifyRuntimeBundle} from './windows-runtime-bundle.js';
import {isWindowsPackageSegment} from './windows-package-path.js';

interface SuiteFile {path:string;bytes:number;sha256:string}
interface RuntimeLicenseIndex {
  schema:'dream-maker.windows-runtime-license-index.v1';
  product:'DreamMaker Suite';
  builtAt:string;
  scope:'INDEX_ONLY_NOT_LEGAL_APPROVAL';
  status:'PARTIAL_LICENSE_INDEX_NOT_REVIEWED';
  sourceRuntimeManifestSha256:string;
  components:{
    id:string;
    version:string;
    license:SuiteFile;
    sbom:SuiteFile;
  }[];
  legalReview:'NOT_REVIEWED';
  releaseReady:false;
  redistributionReviewed:false;
  cleanWindowsVerified:false;
}
type SuiteInstallerScope='FRESH_LOCAL_SUITE_INSTALL_ONLY'|'LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL';
interface SuiteManifest {
  schema:'dream-maker.windows-suite-composition.v1';
  product:'DreamMaker Suite';
  builtAt:string;
  scope:'LOCAL_PACKAGE_COMPOSITION_NOT_RELEASE';
  status:'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE';
  core:{
    manifestSha256:string;
    filesHash:string;
    files:number;
    capabilities:Record<string,unknown>;
  };
  runtime:{
    manifestSha256:string;
    components:number;
    artifactBytes:number;
    files:number;
  };
  installer:{
    integrated:true;
    scope:SuiteInstallerScope;
    wrapper:'Setup-DreamMakerSuite.ps1';
    update:boolean;
    rollback:boolean;
    uninstall:boolean;
  };
  files:SuiteFile[];
  filesHash:string;
  releaseReady:false;
  redistributionReviewed:false;
  cleanWindowsVerified:false;
  signed:false;
  binariesExecuted:false;
  credentialsIncluded:false;
  modelsIncluded:false;
}

const HASH=/^[a-f0-9]{64}$/;
const MAX_MANIFEST=8*1024*1024;
const MAX_FILE=2_147_483_648;
const MAX_FILES=20_000;
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string):never=>{throw new Error(code)};
const windowsPowerShell=(value:string)=>Buffer.concat([
  Buffer.from([0xef,0xbb,0xbf]),
  Buffer.from(value,'utf8'),
]);

function safePath(root:string,value:unknown):{absolute:string;parts:string[]}{
  if(typeof value!=='string')fail('SUITE_COMPOSITION_PATH_INVALID');
  const pathValue=value as string;
  if(!pathValue||pathValue.length>1000||isAbsolute(pathValue)||
    /^[A-Za-z]:/.test(pathValue)||/^[\\/]{2}/.test(pathValue)||CONTROL.test(pathValue))
    fail('SUITE_COMPOSITION_PATH_INVALID');
  const parts=pathValue.split(/[\\/]+/);
  if(parts.some(part=>!isWindowsPackageSegment(part)))
    fail('SUITE_COMPOSITION_PATH_INVALID');
  const base=resolve(root),absolute=resolve(base,...parts),rel=relative(base,absolute);
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))fail('SUITE_COMPOSITION_PATH_INVALID');
  return{absolute,parts};
}

function lstatOrFail(path:string,errorCode:string):Stats{
  try{return lstatSync(path)}
  catch{return fail(errorCode)}
}

function noLinks(root:string,parts:string[],leaf:'file'|'directory'):string{
  let current=resolve(root);
  for(let index=0;index<parts.length;index++){
    current=resolve(current,parts[index]);
    const observed=lstatOrFail(current,'SUITE_COMPOSITION_INPUT_MISSING');
    if(observed.isSymbolicLink())fail('SUITE_COMPOSITION_INPUT_LINK_DENIED');
    if(index<parts.length-1&&!observed.isDirectory())fail('SUITE_COMPOSITION_PATH_INVALID');
    if(index===parts.length-1&&(leaf==='file'?!observed.isFile():!observed.isDirectory()))
      fail('SUITE_COMPOSITION_PATH_INVALID');
  }
  return current;
}

function parseManifest(path:string,errorCode:string):Record<string,unknown>{
  const observed=lstatOrFail(path,errorCode);
  if(!observed.isFile()||observed.isSymbolicLink()||observed.size<=0||observed.size>MAX_MANIFEST)fail(errorCode);
  let value;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)))}
  catch{fail(errorCode)}
  if(value===null||typeof value!=='object'||Array.isArray(value))fail(errorCode);
  return value as Record<string,unknown>;
}

function sameFile(
  before:{size:number;mtimeMs:number;ino:number|bigint;mode:number},
  after:{size:number;mtimeMs:number;ino:number|bigint;mode:number},
):boolean{
  return before.size===after.size&&before.mtimeMs===after.mtimeMs&&
    String(before.ino)===String(after.ino)&&before.mode===after.mode;
}

function copyPinned(source:string,target:string,expectedBytes:number,expectedSha256:string):SuiteFile{
  let sourceFd:number|undefined,targetFd:number|undefined;
  try{
    sourceFd=openSync(source,'r');
    const before=fstatSync(sourceFd);
    if(!before.isFile()||before.size!==expectedBytes||before.size>MAX_FILE)
      fail('SUITE_COMPOSITION_SOURCE_CHANGED');
    mkdirSync(dirname(target),{recursive:true});
    targetFd=openSync(target,'wx');
    const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
    let total=0;
    for(let count;(count=readSync(sourceFd,buffer,0,buffer.length,null))>0;){
      total+=count;
      if(total>expectedBytes)fail('SUITE_COMPOSITION_SOURCE_CHANGED');
      digest.update(buffer.subarray(0,count));
      let offset=0;
      while(offset<count){
        const written=writeSync(targetFd,buffer,offset,count-offset);
        if(written<=0)fail('SUITE_COMPOSITION_WRITE_FAILED');
        offset+=written;
      }
    }
    const after=lstatSync(source),actual=digest.digest('hex');
    if(total!==expectedBytes||!sameFile(before,after)||actual!==expectedSha256)
      fail('SUITE_COMPOSITION_SOURCE_CHANGED');
    return{path:'',bytes:total,sha256:actual};
  }finally{
    if(targetFd!==undefined)closeSync(targetFd);
    if(sourceFd!==undefined)closeSync(sourceFd);
  }
}

function copyBuffer(input:string,target:string,path:string):SuiteFile{
  const stat=lstatSync(input);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_MANIFEST)
    fail('SUITE_COMPOSITION_SOURCE_CHANGED');
  const body=readFileSync(input);
  if(body.length!==stat.size)fail('SUITE_COMPOSITION_SOURCE_CHANGED');
  mkdirSync(dirname(target),{recursive:true});
  writeFileSync(target,body,{flag:'wx'});
  return{path,bytes:body.length,sha256:sha(body)};
}

function addFile(files:SuiteFile[],file:SuiteFile,path:string):void{
  files.push({path,bytes:file.bytes,sha256:file.sha256});
}

function checkLinkRoot(root:string,code:string):void{
  const observed=lstatOrFail(root,code);
  if(!observed.isDirectory()||observed.isSymbolicLink())fail(code);
}

function ensureManifest(value:SuiteManifest):void{
  if(value.schema!=='dream-maker.windows-suite-composition.v1'||
    value.product!=='DreamMaker Suite'||
    value.scope!=='LOCAL_PACKAGE_COMPOSITION_NOT_RELEASE'||
    value.status!=='PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE'||
    value.releaseReady!==false||value.redistributionReviewed!==false||
    value.cleanWindowsVerified!==false||value.signed!==false||
    value.binariesExecuted!==false||value.credentialsIncluded!==false||
    value.modelsIncluded!==false||Number.isNaN(Date.parse(value.builtAt)))
    fail('SUITE_COMPOSITION_MANIFEST_INVALID');
  if(!value.core||typeof value.core!=='object'||
    typeof value.core.manifestSha256!=='string'||!HASH.test(value.core.manifestSha256)||
    typeof value.core.filesHash!=='string'||!HASH.test(value.core.filesHash)||
    !Number.isSafeInteger(value.core.files)||value.core.files<1||
    value.core.capabilities===null||typeof value.core.capabilities!=='object'||
    Array.isArray(value.core.capabilities))
    fail('SUITE_COMPOSITION_MANIFEST_INVALID');
  if(!value.runtime||typeof value.runtime!=='object'||
    typeof value.runtime.manifestSha256!=='string'||!HASH.test(value.runtime.manifestSha256)||
    !Number.isSafeInteger(value.runtime.components)||value.runtime.components<1||
    !Number.isSafeInteger(value.runtime.artifactBytes)||value.runtime.artifactBytes<1||
    !Number.isSafeInteger(value.runtime.files)||value.runtime.files<1)
    fail('SUITE_COMPOSITION_MANIFEST_INVALID');
  if(!value.installer||typeof value.installer!=='object'||
    value.installer.integrated!==true||
    value.installer.wrapper!=='Setup-DreamMakerSuite.ps1'||
    !(
      (value.installer.scope==='FRESH_LOCAL_SUITE_INSTALL_ONLY'&&
        value.installer.update===false&&
        (value.installer.rollback===undefined||value.installer.rollback===false)&&
        value.installer.uninstall===false)||
      (value.installer.scope==='LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL'&&
        value.installer.update===true&&
        (value.installer.rollback===undefined||
          value.installer.rollback===false||value.installer.rollback===true)&&
        value.installer.uninstall===true)
    ))
    fail('SUITE_COMPOSITION_MANIFEST_INVALID');
  if(!Array.isArray(value.files)||value.files.length<1||value.files.length>MAX_FILES)
    fail('SUITE_COMPOSITION_MANIFEST_INVALID');
  const seen=new Set<string>();
  for(const file of value.files){
    if(file===null||typeof file!=='object'||typeof file.path!=='string'||
      !Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>MAX_FILE||
      typeof file.sha256!=='string'||!HASH.test(file.sha256))
      fail('SUITE_COMPOSITION_MANIFEST_INVALID');
    safePath('/',file.path);
    const identity=file.path.normalize('NFC').toLocaleLowerCase('en-US');
    if(seen.has(identity))fail('SUITE_COMPOSITION_MANIFEST_INVALID');
    seen.add(identity);
  }
  if(sha(JSON.stringify(value.files))!==value.filesHash)
    fail('SUITE_COMPOSITION_FILES_HASH_MISMATCH');
}

function nestedCoreManifest(root:string):{
  raw:Record<string,unknown>;
  files:SuiteFile[];
  filesHash:string;
}{
  const manifestPath=join(root,'RELEASE_MANIFEST.json');
  const raw=parseManifest(manifestPath,'SUITE_COMPOSITION_CORE_CHANGED');
  const declared=raw.files;
  if(!Array.isArray(declared))fail('SUITE_COMPOSITION_CORE_CHANGED');
  const files=(declared as unknown[]).map(file=>{
    if(file===null||typeof file!=='object'||Array.isArray(file))
      fail('SUITE_COMPOSITION_CORE_CHANGED');
    const item=file as Record<string,unknown>;
    if(typeof item.path!=='string'||!Number.isSafeInteger(item.bytes)||
      Number(item.bytes)<0||Number(item.bytes)>MAX_FILE||
      typeof item.sha256!=='string'||!HASH.test(item.sha256))
      fail('SUITE_COMPOSITION_CORE_CHANGED');
    safePath('/',item.path);
    return{path:item.path as string,bytes:Number(item.bytes),sha256:item.sha256 as string};
  });
  if(typeof raw.filesHash!=='string'||!HASH.test(raw.filesHash)||
    sha(JSON.stringify(raw.files))!==raw.filesHash)
    fail('SUITE_COMPOSITION_CORE_CHANGED');
  return{raw,files,filesHash:String(raw.filesHash)};
}

function nestedRuntimeManifest(root:string):{
  raw:Record<string,unknown>;
  files:SuiteFile[];
  components:number;
  artifactBytes:number;
}{
  const raw=parseManifest(join(root,'RUNTIME_BUNDLE_MANIFEST.json'),'SUITE_COMPOSITION_RUNTIME_CHANGED');
  if(!Array.isArray(raw.files)||!Number.isSafeInteger(raw.artifactBytes)||
    !Array.isArray(raw.components))fail('SUITE_COMPOSITION_RUNTIME_CHANGED');
  const runtimeFiles=raw.files as unknown[];
  const runtimeComponents=raw.components as unknown[];
  const files=runtimeFiles.map(file=>{
    if(file===null||typeof file!=='object'||Array.isArray(file))
      fail('SUITE_COMPOSITION_RUNTIME_CHANGED');
    const item=file as Record<string,unknown>;
    if(typeof item.path!=='string'||!Number.isSafeInteger(item.bytes)||
      Number(item.bytes)<0||Number(item.bytes)>MAX_FILE||
      typeof item.sha256!=='string'||!HASH.test(item.sha256))
      fail('SUITE_COMPOSITION_RUNTIME_CHANGED');
    safePath('/',item.path);
    return{path:item.path as string,bytes:Number(item.bytes),sha256:item.sha256 as string};
  });
  if(typeof raw.filesHash!=='string'||sha(JSON.stringify(raw.files))!==raw.filesHash)
    fail('SUITE_COMPOSITION_RUNTIME_CHANGED');
  return{
    raw,
    files,
    components:runtimeComponents.length,
    artifactBytes:Number(raw.artifactBytes),
  };
}

function runtimeLicenseComponents(
  runtimeManifest:Record<string,unknown>,
):RuntimeLicenseIndex['components']{
  if(!Array.isArray(runtimeManifest.components))
    fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
  const seen=new Set<string>();
  const components=(runtimeManifest.components as unknown[]).map(
    (value):RuntimeLicenseIndex['components'][number]=>{
    if(value===null||typeof value!=='object'||Array.isArray(value))
      fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
    const component=value as Record<string,unknown>;
    const id=component.id,version=component.version;
    if(typeof id!=='string'||!id||id.length>160||
      seen.has(id)||typeof version!=='string'||
      !version||version.length>160||
      component.files===null||typeof component.files!=='object'||
      Array.isArray(component.files))
      fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
    const verifiedId=id as string,verifiedVersion=version as string;
    seen.add(verifiedId);
    const files=component.files as Record<string,unknown>;
    const reference=(value:unknown,filename:string):SuiteFile=>{
      if(value===null||typeof value!=='object'||Array.isArray(value))
        fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
      const item=value as Record<string,unknown>;
      const path=item.path,bytes=item.bytes,digest=item.sha256;
      if(typeof path!=='string'||path!==`components/${id}/${filename}`||
        !Number.isSafeInteger(bytes)||Number(bytes)<0||
        Number(bytes)>MAX_FILE||typeof digest!=='string'||!HASH.test(digest))
        fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
      return{
        path:`runtime/agent-bundle/${path}`,
        bytes:Number(bytes),
        sha256:digest as string,
      };
    };
    return{
      id:verifiedId,
      version:verifiedVersion,
      license:reference(files.license,'LICENSE.txt'),
      sbom:reference(files.sbom,'component-sbom.json'),
    };
  });
  components.sort((left,right)=>left.id.localeCompare(right.id,'en'));
  if(new Set(components.map(component=>component.id)).size!==components.length)
    fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
  return components;
}

function ensureRuntimeLicenseIndex(
  value:Record<string,unknown>,
  runtimeManifest:Record<string,unknown>,
  runtimeManifestSha256:string,
):void{
  const keys=[
    'schema','product','builtAt','scope','status','sourceRuntimeManifestSha256',
    'components','legalReview','releaseReady','redistributionReviewed',
    'cleanWindowsVerified',
  ].sort();
  const expected=runtimeLicenseComponents(runtimeManifest);
  if(JSON.stringify(Object.keys(value).sort())!==JSON.stringify(keys)||
    value.schema!=='dream-maker.windows-runtime-license-index.v1'||
    value.product!=='DreamMaker Suite'||
    value.scope!=='INDEX_ONLY_NOT_LEGAL_APPROVAL'||
    value.status!=='PARTIAL_LICENSE_INDEX_NOT_REVIEWED'||
    value.sourceRuntimeManifestSha256!==runtimeManifestSha256||
    value.legalReview!=='NOT_REVIEWED'||value.releaseReady!==false||
    value.redistributionReviewed!==false||value.cleanWindowsVerified!==false||
    typeof value.builtAt!=='string'||Number.isNaN(Date.parse(value.builtAt))||
    !Array.isArray(value.components)||
    JSON.stringify(value.components)!==JSON.stringify(expected))
    fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
  for(const component of value.components as unknown[]){
    if(component===null||typeof component!=='object'||Array.isArray(component))
      fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
    const item=component as Record<string,unknown>;
    if(JSON.stringify(Object.keys(item).sort())!==
      JSON.stringify(['id','version','license','sbom'].sort()))
      fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
  }
}

function buildRuntimeLicenseIndex(
  runtimeManifest:Record<string,unknown>,
  runtimeManifestSha256:string,
  builtAt:string,
):Buffer{
  const value:RuntimeLicenseIndex={
    schema:'dream-maker.windows-runtime-license-index.v1',
    product:'DreamMaker Suite',
    builtAt,
    scope:'INDEX_ONLY_NOT_LEGAL_APPROVAL',
    status:'PARTIAL_LICENSE_INDEX_NOT_REVIEWED',
    sourceRuntimeManifestSha256:runtimeManifestSha256,
    components:runtimeLicenseComponents(runtimeManifest),
    legalReview:'NOT_REVIEWED',
    releaseReady:false,
    redistributionReviewed:false,
    cleanWindowsVerified:false,
  };
  ensureRuntimeLicenseIndex(
    value as unknown as Record<string,unknown>,
    runtimeManifest,
    runtimeManifestSha256,
  );
  return Buffer.from(JSON.stringify(value,null,2)+'\n');
}

async function verifyCoreAt(root:string){
  try{return await verifyPortableDirectory(root)}
  catch{return fail('SUITE_COMPOSITION_CORE_CHANGED')}
}

async function verifyRuntimeAt(root:string){
  try{return await verifyRuntimeBundle(root)}
  catch{return fail('SUITE_COMPOSITION_RUNTIME_CHANGED')}
}

export async function buildSuiteComposition(options:{
  coreRoot:string;
  runtimeRoot:string;
  output:string;
  builtAt?:string;
}):Promise<{
  output:string;
  status:'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE';
  coreFiles:number;
  runtimeFiles:number;
  runtimeComponents:number;
  artifactBytes:number;
  files:number;
  manifestHash:string;
  installerIntegrated:true;
  installerScope:SuiteInstallerScope;
  releaseReady:false;
  binariesExecuted:false;
  credentialsIncluded:false;
}>{
  const core=resolve(options.coreRoot),runtime=resolve(options.runtimeRoot),output=resolve(options.output);
  checkLinkRoot(core,'SUITE_COMPOSITION_INPUT_LINK_DENIED');
  checkLinkRoot(runtime,'SUITE_COMPOSITION_INPUT_LINK_DENIED');
  if(existsSync(output))fail('SUITE_COMPOSITION_OUTPUT_EXISTS');

  const coreVerification=await verifyCoreAt(core);
  const runtimeVerification=await verifyRuntimeAt(runtime);

  const coreManifest=nestedCoreManifest(core);
  const runtimeManifest=nestedRuntimeManifest(runtime);
  const temporary=output+'.partial-'+process.pid+'-'+Date.now();
  if(existsSync(temporary))fail('SUITE_COMPOSITION_TEMP_EXISTS');
  const builtAt=options.builtAt??new Date().toISOString();
  if(Number.isNaN(Date.parse(builtAt)))fail('SUITE_COMPOSITION_TIME_INVALID');
  mkdirSync(dirname(output),{recursive:true});
  mkdirSync(temporary,{recursive:false});
  try{
    const files:SuiteFile[]=[];
    for(const path of ['RELEASE_MANIFEST.json','SHA256SUMS.txt']){
      const target=join(temporary,'core',path);
      addFile(files,copyBuffer(join(core,path),target,`core/${path}`),`core/${path}`);
    }
    for(const file of coreManifest.files){
      const sourceNoLinks=safePath(core,file.path),source=noLinks(core,sourceNoLinks.parts,'file');
      const targetPath=`core/${file.path}`,target=safePath(temporary,targetPath);
      addFile(files,copyPinned(source,target.absolute,file.bytes,file.sha256),targetPath);
    }
    for(const path of ['RUNTIME_BUNDLE_MANIFEST.json','SHA256SUMS.txt']){
      const targetPath=`runtime/agent-bundle/${path}`;
      addFile(
        files,
        copyBuffer(join(runtime,path),join(temporary,targetPath),targetPath),
        targetPath,
      );
    }
    for(const file of runtimeManifest.files){
      const sourceNoLinks=safePath(runtime,file.path),source=noLinks(runtime,sourceNoLinks.parts,'file');
      const targetPath=`runtime/agent-bundle/${file.path}`,target=safePath(temporary,targetPath);
      addFile(files,copyPinned(source,target.absolute,file.bytes,file.sha256),targetPath);
    }
    const licenseIndex=buildRuntimeLicenseIndex(
      runtimeManifest.raw,
      runtimeVerification.manifestHash,
      builtAt,
    );
    const readme=Buffer.from(suiteReadme(),'utf8');
    const verifier=Buffer.from(suiteVerifier(),'utf8');
    const installer=Buffer.from(suiteInstallerScript(),'utf8');
    const setup=windowsPowerShell(suiteSetupScript());
    const update=windowsPowerShell(suiteUpdateScript());
    const rollback=windowsPowerShell(suiteRollbackScript());
    const uninstall=windowsPowerShell(suiteUninstallScript());
    writeFileSync(join(temporary,'RUNTIME_LICENSE_INDEX.json'),licenseIndex,{flag:'wx'});
    writeFileSync(join(temporary,'README_CN.md'),readme,{flag:'wx'});
    writeFileSync(join(temporary,'verify-suite-composition.mjs'),verifier,{flag:'wx'});
    writeFileSync(join(temporary,'install-suite-composition.mjs'),installer,{flag:'wx'});
    writeFileSync(join(temporary,'Setup-DreamMakerSuite.ps1'),setup,{flag:'wx'});
    writeFileSync(join(temporary,'Update-DreamMakerSuite.ps1'),update,{flag:'wx'});
    writeFileSync(join(temporary,'Rollback-DreamMakerSuite.ps1'),rollback,{flag:'wx'});
    writeFileSync(join(temporary,'Uninstall-DreamMakerSuite.ps1'),uninstall,{flag:'wx'});
    files.push({
      path:'RUNTIME_LICENSE_INDEX.json',
      bytes:licenseIndex.length,
      sha256:sha(licenseIndex),
    });
    files.push({path:'README_CN.md',bytes:readme.length,sha256:sha(readme)});
    files.push({path:'verify-suite-composition.mjs',bytes:verifier.length,sha256:sha(verifier)});
    files.push({path:'install-suite-composition.mjs',bytes:installer.length,sha256:sha(installer)});
    files.push({path:'Setup-DreamMakerSuite.ps1',bytes:setup.length,sha256:sha(setup)});
    files.push({path:'Update-DreamMakerSuite.ps1',bytes:update.length,sha256:sha(update)});
    files.push({path:'Rollback-DreamMakerSuite.ps1',bytes:rollback.length,sha256:sha(rollback)});
    files.push({path:'Uninstall-DreamMakerSuite.ps1',bytes:uninstall.length,sha256:sha(uninstall)});
    files.sort((left,right)=>left.path.localeCompare(right.path,'en'));
    if(files.length>MAX_FILES)fail('SUITE_COMPOSITION_FILE_LIMIT');
    const manifest:SuiteManifest={
      schema:'dream-maker.windows-suite-composition.v1',
      product:'DreamMaker Suite',
      builtAt,
      scope:'LOCAL_PACKAGE_COMPOSITION_NOT_RELEASE',
      status:'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE',
      core:{
        manifestSha256:coreVerification.manifestHash,
        filesHash:coreVerification.filesHash,
        files:coreVerification.files,
        capabilities:coreVerification.capabilities,
      },
      runtime:{
        manifestSha256:runtimeVerification.manifestHash,
        components:runtimeVerification.components,
        artifactBytes:runtimeVerification.artifactBytes,
        files:runtimeVerification.files,
      },
      installer:{
        integrated:true,
        scope:'LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL',
        wrapper:'Setup-DreamMakerSuite.ps1',
        update:true,
        rollback:true,
        uninstall:true,
      },
      files,
      filesHash:sha(JSON.stringify(files)),
      releaseReady:false,
      redistributionReviewed:false,
      cleanWindowsVerified:false,
      signed:false,
      binariesExecuted:false,
      credentialsIncluded:false,
      modelsIncluded:false,
    };
    ensureManifest(manifest);
    const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
    writeFileSync(join(temporary,'SUITE_COMPOSITION_MANIFEST.json'),manifestBytes,{flag:'wx'});
    const sums=[...files,{path:'SUITE_COMPOSITION_MANIFEST.json',bytes:manifestBytes.length,sha256:sha(manifestBytes)}]
      .sort((left,right)=>left.path.localeCompare(right.path,'en'))
      .map(file=>`${file.sha256}  ${file.path}`)
      .join('\n')+'\n';
    writeFileSync(join(temporary,'SHA256SUMS.txt'),sums,{flag:'wx'});
    await verifySuiteComposition(temporary);
    renameSync(temporary,output);
    return{
      output,
      status:'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE',
      coreFiles:coreVerification.files,
      runtimeFiles:runtimeVerification.files,
      runtimeComponents:runtimeVerification.components,
      artifactBytes:runtimeVerification.artifactBytes,
      files:files.length,
      manifestHash:sha(manifestBytes),
      installerIntegrated:true,
      installerScope:'LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL',
      releaseReady:false,
      binariesExecuted:false,
      credentialsIncluded:false,
    };
  }catch(error){
    if(existsSync(temporary))rmSync(temporary,{recursive:true,force:true});
    throw error;
  }
}

function expectedSet(files:SuiteFile[]):Set<string>{
  return new Set([
    ...files.map(file=>file.path),
    'SUITE_COMPOSITION_MANIFEST.json',
    'SHA256SUMS.txt',
  ].map(path=>path.normalize('NFC').toLocaleLowerCase('en-US')));
}

function isMutableRoot(identity:string):boolean{
  return identity==='core/data'||identity==='core/temp';
}

function verifyTree(root:string,files:SuiteFile[]):void{
  const expected=expectedSet(files);
  const visit=(folder:string,prefix='',insideMutable=false):void=>{
    for(const entry of readdirSync(folder,{withFileTypes:true})){
      const path=prefix?`${prefix}/${entry.name}`:entry.name;
      const identity=path.normalize('NFC').toLocaleLowerCase('en-US');
      const full=join(folder,entry.name);
      if(entry.isSymbolicLink())fail('SUITE_COMPOSITION_LINK_DENIED');
      if(entry.isDirectory()){
        const mutable=insideMutable||isMutableRoot(identity);
        const marker=identity+'/';
        if(!mutable&&!expected.has(identity)&&
          ![...expected].some(candidate=>candidate.startsWith(marker)))
          fail('SUITE_COMPOSITION_EXTRA_FILE');
        visit(full,path,mutable);
      }else if(!entry.isFile()||(!insideMutable&&!expected.has(identity))){
        fail('SUITE_COMPOSITION_EXTRA_FILE');
      }
    }
  };
  visit(root);
}

function hashFile(path:string,expectedBytes:number):string{
  const fd=openSync(path,'r');
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.size!==expectedBytes)fail('SUITE_COMPOSITION_FILE_CHANGED');
    const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
    let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){
      total+=count;
      if(total>expectedBytes)fail('SUITE_COMPOSITION_FILE_CHANGED');
      digest.update(buffer.subarray(0,count));
    }
    if(total!==expectedBytes||!sameFile(before,lstatSync(path)))
      fail('SUITE_COMPOSITION_FILE_CHANGED');
    return digest.digest('hex');
  }finally{
    closeSync(fd);
  }
}

export async function verifySuiteComposition(root:string):Promise<{
  status:'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE';
  coreFiles:number;
  runtimeFiles:number;
  runtimeComponents:number;
  files:number;
  manifestHash:string;
  installerIntegrated:true;
  installerScope:SuiteInstallerScope;
  installerRollback:boolean;
  releaseReady:false;
  redistributionReviewed:false;
  cleanWindowsVerified:false;
}>{
  const base=resolve(root);
  checkLinkRoot(base,'SUITE_COMPOSITION_ROOT_INVALID');
  const manifestPath=join(base,'SUITE_COMPOSITION_MANIFEST.json');
  const raw=parseManifest(manifestPath,'SUITE_COMPOSITION_MANIFEST_INVALID');
  const manifest=raw as unknown as SuiteManifest;
  ensureManifest(manifest);
  verifyTree(base,manifest.files);

  const coreVerification=await verifyCoreAt(join(base,'core'));
  if(coreVerification.manifestHash!==manifest.core.manifestSha256||
    coreVerification.filesHash!==manifest.core.filesHash||
    coreVerification.files!==manifest.core.files)
    fail('SUITE_COMPOSITION_CORE_CHANGED');
  const runtimeVerification=await verifyRuntimeAt(join(base,'runtime/agent-bundle'));
  if(runtimeVerification.manifestHash!==manifest.runtime.manifestSha256||
    runtimeVerification.components!==manifest.runtime.components||
    runtimeVerification.artifactBytes!==manifest.runtime.artifactBytes||
    runtimeVerification.files!==manifest.runtime.files)
    fail('SUITE_COMPOSITION_RUNTIME_CHANGED');

  const runtimeManifest=nestedRuntimeManifest(join(base,'runtime/agent-bundle'));
  const licenseIndex=parseManifest(
    join(base,'RUNTIME_LICENSE_INDEX.json'),
    'SUITE_COMPOSITION_LICENSE_INDEX_INVALID',
  );
  ensureRuntimeLicenseIndex(
    licenseIndex,
    runtimeManifest.raw,
    runtimeVerification.manifestHash,
  );
  if(licenseIndex.builtAt!==manifest.builtAt)
    fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
  const suiteFiles=new Map(manifest.files.map(file=>[file.path,file]));
  if(!suiteFiles.has('RUNTIME_LICENSE_INDEX.json'))
    fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
  for(const component of runtimeLicenseComponents(runtimeManifest.raw)){
    for(const reference of [component.license,component.sbom]){
      const file=suiteFiles.get(reference.path);
      if(!file||file.bytes!==reference.bytes||file.sha256!==reference.sha256)
        fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
    }
  }

  for(const file of manifest.files){
    const safe=safePath(base,file.path),full=noLinks(base,safe.parts,'file');
    if(hashFile(full,file.bytes)!==file.sha256)fail('SUITE_COMPOSITION_FILE_CHANGED');
  }
  const manifestBytes=readFileSync(manifestPath),lines=readFileSync(join(base,'SHA256SUMS.txt'),'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  const sums=new Map<string,string>();
  for(const line of lines){
    const match=/^([a-f0-9]{64})  (.+)$/.exec(line);
    if(!match||sums.has(match[2]))fail('SUITE_COMPOSITION_SUMS_INVALID');
    const accepted=match as RegExpExecArray;
    sums.set(accepted[2],accepted[1]);
  }
  for(const file of manifest.files)if(sums.get(file.path)!==file.sha256)
    fail('SUITE_COMPOSITION_SUM_MISMATCH');
  if(sums.size!==manifest.files.length+1||
    sums.get('SUITE_COMPOSITION_MANIFEST.json')!==sha(manifestBytes))
    fail('SUITE_COMPOSITION_SUM_MISMATCH');

  return{
    status:manifest.status,
    coreFiles:coreVerification.files,
    runtimeFiles:runtimeVerification.files,
    runtimeComponents:runtimeVerification.components,
    files:manifest.files.length,
    manifestHash:sha(manifestBytes),
    installerIntegrated:true,
    installerScope:manifest.installer.scope,
    installerRollback:manifest.installer.rollback===true,
    releaseReady:false,
    redistributionReviewed:false,
    cleanWindowsVerified:false,
  };
}

function suiteInstallerScript():string{
  return `import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  installSuiteComposition,
  rollbackSuiteComposition,
  uninstallSuiteComposition,
  updateSuiteComposition,
} from './core/app/dist/server/release/windows-suite-installation.js';
import {verifySuiteComposition} from './core/app/dist/server/release/windows-suite-composition.js';

const root=fileURLToPath(new URL('.',import.meta.url));
const action=process.argv[2]??'install';
function value(name){
  const index=process.argv.indexOf(name);
  if(index<0)return null;
  if(index+1>=process.argv.length)throw new Error('SUITE_INSTALL_ARGUMENT_MISSING:'+name);
  return process.argv[index+1];
}
if(action==='verify'){
  console.log(JSON.stringify(await verifySuiteComposition(root),null,2));
}else if(action==='install'){
  const target=value('--target');
  if(!target)throw new Error('SUITE_INSTALL_TARGET_REQUIRED');
  const installRoot=resolve(target);
  if(existsSync(installRoot))throw new Error('SUITE_INSTALL_TARGET_EXISTS');
  console.log(JSON.stringify(await installSuiteComposition({sourceRoot:root,installRoot}),null,2));
}else if(action==='update'){
  const target=value('--target');
  if(!target)throw new Error('SUITE_INSTALL_TARGET_REQUIRED');
  console.log(JSON.stringify(await updateSuiteComposition({
    sourceRoot:root,
    installRoot:resolve(target),
  }),null,2));
}else if(action==='rollback'){
  const target=value('--target');
  if(!target)throw new Error('SUITE_INSTALL_TARGET_REQUIRED');
  console.log(JSON.stringify(await rollbackSuiteComposition({
    installRoot:resolve(target),
  }),null,2));
}else if(action==='uninstall'){
  const target=value('--target');
  if(!target)throw new Error('SUITE_INSTALL_TARGET_REQUIRED');
  console.log(JSON.stringify(await uninstallSuiteComposition({
    installRoot:resolve(target),
  }),null,2));
}else{
  throw new Error('SUITE_INSTALL_ACTION_INVALID');
}
`;
}

function suiteSetupScript():string{
  return `[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InstallDir,
  [switch]$CreateShortcuts
)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$node=Join-Path $root 'core\\runtime\\node.exe'
$target=[IO.Path]::GetFullPath($InstallDir)
& $node (Join-Path $root 'install-suite-composition.mjs') install --target $target
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
if($CreateShortcuts){
  & (Join-Path $target 'core\\Manage-Shortcuts.ps1') -Action Create -InstallDir (Join-Path $target 'core')
  if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}
Write-Host ('DreamMaker Suite installed at '+$target)
`;
}

function suiteUpdateScript():string{
  return `[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallDir)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$node=Join-Path $root 'core\\runtime\\node.exe'
$target=[IO.Path]::GetFullPath($InstallDir)
& $node (Join-Path $root 'install-suite-composition.mjs') update --target $target
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Host ('DreamMaker Suite updated at '+$target)
`;
}

function suiteRollbackScript():string{
  return `[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallDir)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$node=Join-Path $root 'core\\runtime\\node.exe'
$target=[IO.Path]::GetFullPath($InstallDir)
& $node (Join-Path $root 'install-suite-composition.mjs') rollback --target $target
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Host ('DreamMaker Suite rolled back at '+$target)
`;
}

function suiteUninstallScript():string{
  return `[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InstallDir,
  [switch]$RemoveShortcuts
)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$node=Join-Path $root 'core\\runtime\\node.exe'
$target=[IO.Path]::GetFullPath($InstallDir)
if($RemoveShortcuts){
  & (Join-Path $target 'core\\Manage-Shortcuts.ps1') -Action Remove -InstallDir (Join-Path $target 'core')
  if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}
& $node (Join-Path $root 'install-suite-composition.mjs') uninstall --target $target
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Host ('DreamMaker Suite uninstalled from '+$target)
`;
}

function suiteReadme():string{
  return `# Dream Maker Suite 本地组合包

这个目录把已经分别校验的 Windows 核心包和代理运行时补充包放在一起：

- \`core/\`：Dream Maker、DreamFlow、界面、项目状态和 Node 运行时；
- \`runtime/agent-bundle/\`：固定版本的 Codex、DSH、Planner 1 和工具链字节。

两个子目录仍保留自己的清单和校验器。组合包没有合并或升级它们的状态。

顶层 \`RUNTIME_LICENSE_INDEX.json\` 只汇总六个运行时组件的许可证和 SBOM
位置、大小及摘要，方便维护者定位材料。它明确标记为未完成法律审阅，
不是再分发许可批准，也不能替代组件原始许可证。

当前仍不是正式发行包：

- 未签名；
- 未完成清洁 Windows 实机验证；
- 未完成完整依赖和法律再分发审阅；
- 不代表四个真实角色或 Custom/Magpie Live 已通过。

可先运行 \`core\\runtime\\node.exe verify-suite-composition.mjs\` 核对组合包、核心包和
运行时补充包。全新安装可以运行：

\`\`\`powershell
.\\Setup-DreamMakerSuite.ps1 -InstallDir "F:\\Apps\\DreamMakerSuite"
\`\`\`

安装会先在相邻临时目录完成并重新校验，成功后才切换到目标目录；已有目录不会
被覆盖。已有安装可运行：

\`\`\`powershell
.\\Update-DreamMakerSuite.ps1 -InstallDir "F:\\Apps\\DreamMakerSuite"
.\\Rollback-DreamMakerSuite.ps1 -InstallDir "F:\\Apps\\DreamMakerSuite"
.\\Uninstall-DreamMakerSuite.ps1 -InstallDir "F:\\Apps\\DreamMakerSuite"
\`\`\`

升级会在相邻副本中重新校验整个组合包，保留原有核心用户数据，并按核心安装器
保留整个 Suite 与核心的回滚副本。回滚先校验旧副本，再连同当前用户数据切回，
并把被替换版本保留为相邻的手工恢复目录。卸载保留 \`data/\` 和 \`temp/\` 到目标旁边
的独立用户数据目录。
快捷方式默认不创建；安装可加入 \`-CreateShortcuts\`，卸载可加入
\`-RemoveShortcuts\`。
`;
}

function suiteVerifier():string{
  return `import {createHash} from 'node:crypto';
import {closeSync,fstatSync,lstatSync,openSync,readFileSync,readSync,readdirSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPortableDirectory} from './core/app/dist/server/release/windows-portable.js';
import {verifyRuntimeBundle} from './core/app/dist/server/release/windows-runtime-bundle.js';
const root=dirname(fileURLToPath(import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw new Error(code)};
const isWindowsPackageSegment=${isWindowsPackageSegment.toString()};
const safe=value=>{
  if(typeof value!=='string'||!value||isAbsolute(value)||/^[A-Za-z]:/.test(value))fail('SUITE_COMPOSITION_PATH_INVALID');
  const parts=value.split(/[\\\\/]+/),full=resolve(root,...parts),rel=relative(root,full);
  if(parts.some(part=>!isWindowsPackageSegment(part))||!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))
    fail('SUITE_COMPOSITION_PATH_INVALID');
  return full;
};
const hashFile=(path,bytes)=>{
  const fd=openSync(path,'r');
  try{
    const before=fstatSync(fd),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){total+=count;digest.update(buffer.subarray(0,count));}
    const after=fstatSync(fd);
    if(total!==bytes||before.size!==bytes||after.size!==bytes||before.mtimeMs!==after.mtimeMs)
      fail('SUITE_COMPOSITION_FILE_CHANGED');
    return digest.digest('hex');
  }finally{closeSync(fd);}
};
const manifestBytes=readFileSync(join(root,'SUITE_COMPOSITION_MANIFEST.json'));
const manifest=JSON.parse(manifestBytes.toString('utf8'));
if(manifest.schema!=='dream-maker.windows-suite-composition.v1'||
  manifest.scope!=='LOCAL_PACKAGE_COMPOSITION_NOT_RELEASE'||
  manifest.status!=='PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE'||
  manifest.releaseReady!==false||manifest.redistributionReviewed!==false||
  manifest.cleanWindowsVerified!==false||manifest.signed!==false||
  manifest.binariesExecuted!==false||manifest.credentialsIncluded!==false||
  manifest.modelsIncluded!==false||!manifest.installer||
  manifest.installer.integrated!==true||
  manifest.installer.wrapper!=='Setup-DreamMakerSuite.ps1'||
  !Array.isArray(manifest.files))
  fail('SUITE_COMPOSITION_MANIFEST_INVALID');
const installerScope=manifest.installer.scope;
const installerCapabilitiesValid=
  (installerScope==='FRESH_LOCAL_SUITE_INSTALL_ONLY'&&
    manifest.installer.update===false&&
    (manifest.installer.rollback===undefined||manifest.installer.rollback===false)&&
    manifest.installer.uninstall===false)||
  (installerScope==='LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL'&&
    manifest.installer.update===true&&
    (manifest.installer.rollback===undefined||
      manifest.installer.rollback===false||manifest.installer.rollback===true)&&
    manifest.installer.uninstall===true);
if(!installerCapabilitiesValid)fail('SUITE_COMPOSITION_MANIFEST_INVALID');
if(sha(JSON.stringify(manifest.files))!==manifest.filesHash)fail('SUITE_COMPOSITION_FILES_HASH_MISMATCH');
const expected=new Set(['SUITE_COMPOSITION_MANIFEST.json','SHA256SUMS.txt'].map(
  path=>path.normalize('NFC').toLocaleLowerCase('en-US')));
for(const file of manifest.files){
  const path=safe(file.path),stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.bytes) fail('SUITE_COMPOSITION_FILE_CHANGED');
  if(hashFile(path,file.bytes)!==file.sha256)fail('SUITE_COMPOSITION_FILE_CHANGED');
  expected.add(file.path.normalize('NFC').toLocaleLowerCase('en-US'));
}
const sums=new Map();
for(const line of readFileSync(join(root,'SHA256SUMS.txt'),'utf8').split(/\\r?\\n/).filter(Boolean)){
  const match=/^([a-f0-9]{64})  (.+)$/.exec(line);
  if(!match||sums.has(match[2]))fail('SUITE_COMPOSITION_SUMS_INVALID');
  sums.set(match[2],match[1]);
}
for(const file of manifest.files)if(sums.get(file.path)!==file.sha256)fail('SUITE_COMPOSITION_SUM_MISMATCH');
if(sums.size!==manifest.files.length+1||sums.get('SUITE_COMPOSITION_MANIFEST.json')!==sha(manifestBytes))
  fail('SUITE_COMPOSITION_SUM_MISMATCH');
const walk=(folder,prefix='',insideMutable=false)=>{
  for(const entry of readdirSync(folder,{withFileTypes:true})){
    const path=prefix?prefix+'/'+entry.name:entry.name;
    const identity=path.normalize('NFC').toLocaleLowerCase('en-US');
    const full=join(folder,entry.name);
    if(entry.isSymbolicLink())fail('SUITE_COMPOSITION_LINK_DENIED');
    if(entry.isDirectory()){
      const mutable=insideMutable||identity==='core/data'||identity==='core/temp';
      const marker=identity+'/';
      if(!mutable&&!expected.has(identity)&&![...expected].some(candidate=>candidate.startsWith(marker)))
        fail('SUITE_COMPOSITION_EXTRA_FILE');
      walk(full,path,mutable);
    }else if(!entry.isFile()||(!insideMutable&&!expected.has(identity))){
      fail('SUITE_COMPOSITION_EXTRA_FILE');
    }
  }
};
walk(root);
const coreManifestBytes=readFileSync(join(root,'core','RELEASE_MANIFEST.json'));
const coreManifest=JSON.parse(coreManifestBytes.toString('utf8'));
if(sha(coreManifestBytes)!==manifest.core.manifestSha256||coreManifest.filesHash!==manifest.core.filesHash||
  coreManifest.files.length!==manifest.core.files) fail('SUITE_COMPOSITION_CORE_CHANGED');
const runtimeManifestBytes=readFileSync(join(root,'runtime','agent-bundle','RUNTIME_BUNDLE_MANIFEST.json'));
const runtimeManifest=JSON.parse(runtimeManifestBytes.toString('utf8'));
if(sha(runtimeManifestBytes)!==manifest.runtime.manifestSha256||
  runtimeManifest.components.length!==manifest.runtime.components||
  runtimeManifest.artifactBytes!==manifest.runtime.artifactBytes||runtimeManifest.files.length!==manifest.runtime.files||
  runtimeManifest.releaseReady!==false||runtimeManifest.redistributionReviewed!==false||
  runtimeManifest.cleanWindowsVerified!==false) fail('SUITE_COMPOSITION_RUNTIME_CHANGED');
let coreVerification,runtimeVerification;
try{coreVerification=await verifyPortableDirectory(join(root,'core'));}
catch{fail('SUITE_COMPOSITION_CORE_CHANGED');}
if(coreVerification.manifestHash!==manifest.core.manifestSha256||
  coreVerification.filesHash!==manifest.core.filesHash||coreVerification.files!==manifest.core.files)
  fail('SUITE_COMPOSITION_CORE_CHANGED');
try{runtimeVerification=await verifyRuntimeBundle(join(root,'runtime','agent-bundle'));}
catch{fail('SUITE_COMPOSITION_RUNTIME_CHANGED');}
if(runtimeVerification.manifestHash!==manifest.runtime.manifestSha256||
  runtimeVerification.components!==manifest.runtime.components||
  runtimeVerification.artifactBytes!==manifest.runtime.artifactBytes||
  runtimeVerification.files!==manifest.runtime.files)fail('SUITE_COMPOSITION_RUNTIME_CHANGED');
const indexBytes=readFileSync(join(root,'RUNTIME_LICENSE_INDEX.json'));
let licenseIndex;
try{licenseIndex=JSON.parse(indexBytes.toString('utf8'));}
catch{fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');}
if(licenseIndex===null||typeof licenseIndex!=='object'||Array.isArray(licenseIndex))
  fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
const expectedComponents=[],seenComponentIds=new Set();
if(!Array.isArray(runtimeManifest.components))
  fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
for(const component of runtimeManifest.components){
  if(component===null||typeof component!=='object'||Array.isArray(component)||
    typeof component.id!=='string'||!component.id||component.id.length>160||
    seenComponentIds.has(component.id)||typeof component.version!=='string'||
    !component.version||component.version.length>160||
    component.files===null||typeof component.files!=='object'||Array.isArray(component.files))
    fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
  seenComponentIds.add(component.id);
  const reference=(value,filename)=>{
    if(value===null||typeof value!=='object'||Array.isArray(value)||
      value.path!=='components/'+component.id+'/'+filename||
      !Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>2147483648||
      typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))
      fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
    return{path:'runtime/agent-bundle/'+value.path,bytes:value.bytes,sha256:value.sha256};
  };
  expectedComponents.push({
    id:component.id,
    version:component.version,
    license:reference(component.files.license,'LICENSE.txt'),
    sbom:reference(component.files.sbom,'component-sbom.json'),
  });
}
expectedComponents.sort((left,right)=>left.id.localeCompare(right.id,'en'));
const indexKeys=[
  'schema','product','builtAt','scope','status','sourceRuntimeManifestSha256',
  'components','legalReview','releaseReady','redistributionReviewed',
  'cleanWindowsVerified',
].sort();
if(JSON.stringify(Object.keys(licenseIndex).sort())!==JSON.stringify(indexKeys)||
  licenseIndex.schema!=='dream-maker.windows-runtime-license-index.v1'||
  licenseIndex.product!=='DreamMaker Suite'||
  licenseIndex.scope!=='INDEX_ONLY_NOT_LEGAL_APPROVAL'||
  licenseIndex.status!=='PARTIAL_LICENSE_INDEX_NOT_REVIEWED'||
  licenseIndex.sourceRuntimeManifestSha256!==manifest.runtime.manifestSha256||
  licenseIndex.builtAt!==manifest.builtAt||
  licenseIndex.legalReview!=='NOT_REVIEWED'||licenseIndex.releaseReady!==false||
  licenseIndex.redistributionReviewed!==false||licenseIndex.cleanWindowsVerified!==false||
  JSON.stringify(licenseIndex.components)!==JSON.stringify(expectedComponents))
  fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
const suiteFileEntries=new Map(manifest.files.map(file=>[file.path,file]));
const licenseIndexFile=suiteFileEntries.get('RUNTIME_LICENSE_INDEX.json');
if(!licenseIndexFile||licenseIndexFile.bytes!==indexBytes.length||
  licenseIndexFile.sha256!==sha(indexBytes))
  fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
for(const component of expectedComponents){
  for(const reference of [component.license,component.sbom]){
    const file=suiteFileEntries.get(reference.path);
    if(!file||file.bytes!==reference.bytes||file.sha256!==reference.sha256)
      fail('SUITE_COMPOSITION_LICENSE_INDEX_INVALID');
  }
}
console.log(JSON.stringify({status:manifest.status,coreFiles:manifest.core.files,runtimeFiles:manifest.runtime.files,
  runtimeComponents:manifest.runtime.components,files:manifest.files.length,manifestHash:sha(manifestBytes),
  installerIntegrated:true,installerScope,
  releaseReady:false,redistributionReviewed:false,cleanWindowsVerified:false}));
`;
}
