// Independent at-rest verification for M95 component artifacts and pinned index.
import {createHash} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync
} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const VERIFY_SCHEMA='dream-maker.component-artifacts-verification.v1';
const BUILD_SCHEMA='dream-maker.component-artifacts-build.v1';
const INDEX_SCHEMA='dream-maker.release-evidence-index.v1';
const FRAGMENT_SCHEMA='dream-maker.release-component-fragment.v1';
const SBOM_SCHEMA='dream-maker.component-sbom.v1';
const REQUIRED_IDS=[
  'codex-runtime',
  'dm-controller',
  'dreamflow-core',
  'dsh-runtime',
  'planner1-cloud-runtime',
  'verified-base-toolchain'
];
const BUILT_IDS=REQUIRED_IDS.filter(id=>!['codex-runtime','dsh-runtime'].includes(id));
const HASH=/^[a-f0-9]{64}$/;
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_JSON=4*1024*1024;
const MAX_ARTIFACT=256*1024*1024;

const fail=code=>{
  const error=new Error(code);
  error.code=code;
  throw error;
};
const text=(value,max=32000)=>typeof value==='string'&&
  value.length>0&&value.length<=max&&!CONTROL.test(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(left,right)=>left.size===right.size&&
  left.mtimeMs===right.mtimeMs&&left.ino===right.ino&&left.mode===right.mode;

function absoluteRoot(value){
  if(!text(value)||!isAbsolute(value)||/^[\\/]{2}/.test(value)){
    fail('EVIDENCE_ROOT_INVALID');
  }
  const root=resolve(value),stat=lstatSync(root);
  if(stat.isSymbolicLink()||!stat.isDirectory())fail('EVIDENCE_ROOT_INVALID');
  return root;
}

function relativeFile(root,value,code='EVIDENCE_PATH_DENIED'){
  if(!text(value,2000)||isAbsolute(value)||/^[A-Za-z]:/.test(value)||
      /^[\\/]{2}/.test(value)){
    fail(code);
  }
  const parts=value.split(/[\\/]+/);
  if(parts.some(part=>!part||part==='.'||part==='..'))fail(code);
  const absolute=resolve(root,value),rel=relative(root,absolute);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))fail(code);
  return {absolute,relative:rel.replaceAll('\\','/'),parts:rel.split(/[\\/]+/)};
}

function fromAbsolute(root,value,code='EVIDENCE_PATH_DENIED'){
  if(!text(value)||!isAbsolute(value)||/^[\\/]{2}/.test(value))fail(code);
  const absolute=resolve(value),rel=relative(root,absolute);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))fail(code);
  return relativeFile(root,rel,code);
}

function outputReference(root,value){
  const output=isAbsolute(value)
    ? fromAbsolute(root,value,'OUTPUT_OUTSIDE_EVIDENCE_ROOT')
    : relativeFile(root,value,'OUTPUT_OUTSIDE_EVIDENCE_ROOT');
  if(existsSync(output.absolute))fail('OUTPUT_EXISTS');
  let current=root;
  for(const part of output.parts.slice(0,-1)){
    current=resolve(current,part);
    if(!existsSync(current))break;
    const stat=lstatSync(current);
    if(stat.isSymbolicLink())fail('OUTPUT_LINK_DENIED');
    if(!stat.isDirectory())fail('OUTPUT_PATH_DENIED');
  }
  return output;
}

function verifyAncestors(root,parts){
  let current=root;
  for(let index=0;index<parts.length;index++){
    current=resolve(current,parts[index]);
    const stat=lstatSync(current);
    if(stat.isSymbolicLink())fail('EVIDENCE_LINK_DENIED');
    if(index<parts.length-1&&!stat.isDirectory())fail('EVIDENCE_PATH_DENIED');
    if(index===parts.length-1&&!stat.isFile())fail('EVIDENCE_NOT_A_FILE');
  }
}

function readEvidenceFile(root,reference,{expectedSha256=null,maxBytes,codePrefix,capture=false}={}){
  let fd;
  try{
    verifyAncestors(root,reference.parts);
    const before=lstatSync(reference.absolute);
    if(before.size<0||before.size>maxBytes)fail(`${codePrefix}_FILE_LIMIT`);
    fd=openSync(reference.absolute,'r');
    const opened=fstatSync(fd);
    if(!opened.isFile()||!same(before,opened))fail(`${codePrefix}_SOURCE_CHANGED`);
    const digest=createHash('sha256'),buffer=Buffer.alloc(65536),chunks=[];
    let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){
      total+=count;
      if(total>maxBytes)fail(`${codePrefix}_FILE_LIMIT`);
      digest.update(buffer.subarray(0,count));
      if(capture)chunks.push(Buffer.from(buffer.subarray(0,count)));
    }
    if(total!==opened.size||!same(opened,lstatSync(reference.absolute))){
      fail(`${codePrefix}_SOURCE_CHANGED`);
    }
    const sha256=digest.digest('hex');
    if(expectedSha256!==null&&sha256!==expectedSha256){
      fail(`${codePrefix}_DIGEST_MISMATCH`);
    }
    return {
      path:reference.relative,
      bytes:total,
      sha256,
      body:capture?Buffer.concat(chunks,total):null
    };
  }catch(error){
    if(error?.code&&new RegExp(`^${codePrefix}_`).test(error.code))throw error;
    if(error?.code==='ENOENT')fail(`${codePrefix}_MISSING`);
    if(error?.code==='EACCES'||error?.code==='EPERM')fail(`${codePrefix}_UNREADABLE`);
    fail(`${codePrefix}_PATH_DENIED`);
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
  }
}

function parseJson(file,code){
  try{
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(file.body));
  }catch{
    fail(code);
  }
}

function readJsonEvidence(root,reference,{expectedSha256=null,codePrefix}={}){
  const file=readEvidenceFile(root,reference,{
    expectedSha256,
    maxBytes:MAX_JSON,
    codePrefix,
    capture:true
  });
  return {...file,value:parseJson(file,`${codePrefix}_JSON_INVALID`)};
}

function componentIdSet(components,code){
  if(!Array.isArray(components)||components.length<1||components.length>32){
    fail(code);
  }
  const ids=[];
  for(const component of components){
    if(!record(component)||!text(component.id,128)||
        !/^[a-z0-9][a-z0-9-]*$/.test(component.id)||ids.includes(component.id)){
      fail(code);
    }
    ids.push(component.id);
  }
  return ids;
}

function verifySbom(sbom,component){
  if(!record(sbom)||sbom.schema!==SBOM_SCHEMA||sbom.status!=='COMPLETE'||
      sbom.machineReadableComplete!==true||
      sbom.componentId!==component.id||
      sbom.artifactSha256!==component.artifactSha256||
      !Number.isSafeInteger(sbom.dependencyCount)||sbom.dependencyCount<0||
      !Array.isArray(sbom.dependencies)||
      sbom.dependencyCount!==sbom.dependencies.length){
    fail('COMPONENT_SBOM_INVALID');
  }
}

function verifyFragment(fragment,component){
  if(!record(fragment)||fragment.schema!==FRAGMENT_SCHEMA||
      fragment.status!=='PARTIAL_COMPONENT_EVIDENCE'||
      fragment.componentId!==component.id||fragment.releaseReady!==false||
      !record(fragment.componentGate)||
      fragment.componentGate.completeDistribution!==false||
      fragment.componentGate.releaseReady!==false||
      !record(fragment.component)||fragment.component.id!==component.id||
      !record(fragment.component.artifact)||
      fragment.component.artifact.sha256!==component.artifactSha256||
      fragment.component.artifact.bytes!==component.artifactBytes){
    fail('COMPONENT_FRAGMENT_INVALID');
  }
}

export function verifyComponentArtifactsAtRest({
  evidenceRoot,
  componentBuildPath,
  releaseIndexPath,
  output,
  now=()=>new Date()
}={}){
  if(typeof now!=='function')fail('CLOCK_INVALID');
  const root=absoluteRoot(evidenceRoot);
  const outputRef=outputReference(root,output);
  const buildRef=relativeFile(root,componentBuildPath,'COMPONENT_BUILD_PATH_DENIED');
  const indexRef=relativeFile(root,releaseIndexPath,'RELEASE_INDEX_PATH_DENIED');
  const buildFile=readJsonEvidence(root,buildRef,{codePrefix:'COMPONENT_BUILD'});
  const build=buildFile.value;
  if(!record(build)||build.schema!==BUILD_SCHEMA||
      build.status!=='COMPONENT_ARTIFACTS_BUILT_RELEASE_BLOCKED'||
      build.releaseReady!==false||build.completeDistribution!==false){
    fail('COMPONENT_BUILD_INVALID');
  }
  const buildIds=componentIdSet(build.components,'COMPONENT_BUILD_COMPONENTS_INVALID');
  for(const id of BUILT_IDS)if(!buildIds.includes(id))fail('COMPONENT_BUILD_INCOMPLETE');

  const artifacts=[],sboms=[],fragments=[];
  const builtByFragment=new Map();
  for(const component of build.components){
    if(!record(component)||!text(component.artifactRelative,2000)||
        !HASH.test(String(component.artifactSha256??''))||
        !Number.isSafeInteger(component.artifactBytes)||
        component.artifactBytes<1||component.artifactBytes>MAX_ARTIFACT||
        !text(component.sbomPath,32000)||!text(component.fragmentPath,32000)||
        !HASH.test(String(component.fragmentSha256??''))){
      fail('COMPONENT_BUILD_ENTRY_INVALID');
    }
    const artifactRef=relativeFile(
      root,
      component.artifactRelative,
      'ARTIFACT_PATH_DENIED'
    );
    const artifact=readEvidenceFile(root,artifactRef,{
      expectedSha256:component.artifactSha256,
      maxBytes:MAX_ARTIFACT,
      codePrefix:'ARTIFACT'
    });
    if(artifact.bytes!==component.artifactBytes)fail('ARTIFACT_BYTES_MISMATCH');
    artifacts.push({
      id:component.id,
      path:artifact.path,
      bytes:artifact.bytes,
      sha256:artifact.sha256
    });

    const sbomRef=fromAbsolute(root,component.sbomPath,'COMPONENT_SBOM_PATH_DENIED');
    const sbom=readJsonEvidence(root,sbomRef,{codePrefix:'COMPONENT_SBOM'});
    verifySbom(sbom.value,component);
    sboms.push({
      id:component.id,
      path:sbom.path,
      bytes:sbom.bytes,
      sha256:sbom.sha256
    });

    const fragmentRef=fromAbsolute(
      root,
      component.fragmentPath,
      'COMPONENT_FRAGMENT_PATH_DENIED'
    );
    const fragment=readJsonEvidence(root,fragmentRef,{
      expectedSha256:component.fragmentSha256,
      codePrefix:'COMPONENT_FRAGMENT'
    });
    verifyFragment(fragment.value,component);
    fragments.push({
      id:component.id,
      path:fragment.path,
      bytes:fragment.bytes,
      sha256:fragment.sha256
    });
    builtByFragment.set(component.id,fragment.sha256);
  }

  const indexFile=readJsonEvidence(root,indexRef,{codePrefix:'RELEASE_INDEX'});
  const index=indexFile.value;
  const indexIds=componentIdSet(index.components,'RELEASE_INDEX_COMPONENTS_INVALID');
  if(!record(index)||index.schema!==INDEX_SCHEMA||
      index.status!=='PARTIAL_INDEX_NOT_RELEASE_MANIFEST'||
      index.releaseReady!==false||index.completeDistribution!==false||
      !Array.isArray(index.missingRequiredComponents)||
      index.missingRequiredComponents.length!==0||
      !Array.isArray(index.coveredRequiredComponents)||
      REQUIRED_IDS.some(id=>
        !indexIds.includes(id)||!index.coveredRequiredComponents.includes(id))){
    fail('RELEASE_INDEX_COVERAGE_INVALID');
  }

  const indexFragments=[];
  for(const component of index.components){
    if(!record(component)||!text(component.fragmentPath,2000)||
        !HASH.test(String(component.fragmentSha256??''))){
      fail('RELEASE_INDEX_FRAGMENT_INVALID');
    }
    const reference=relativeFile(root,component.fragmentPath,'RELEASE_FRAGMENT_PATH_DENIED');
    const file=readJsonEvidence(root,reference,{
      expectedSha256:component.fragmentSha256,
      codePrefix:'RELEASE_FRAGMENT'
    });
    if(!record(file.value)||file.value.schema!==FRAGMENT_SCHEMA||
        file.value.status!=='PARTIAL_COMPONENT_EVIDENCE'||
        file.value.componentId!==component.id||
        file.value.releaseReady!==false||
        !record(file.value.componentGate)||
        file.value.componentGate.completeDistribution!==false||
        file.value.componentGate.releaseReady!==false){
      fail('RELEASE_FRAGMENT_INVALID');
    }
    const builtHash=builtByFragment.get(component.id);
    if(builtHash&&builtHash!==file.sha256)fail('RELEASE_FRAGMENT_DIGEST_MISMATCH');
    indexFragments.push({
      id:component.id,
      path:file.path,
      bytes:file.bytes,
      sha256:file.sha256
    });
  }

  const at=now();
  if(!(at instanceof Date)||!Number.isFinite(at.getTime()))fail('CLOCK_INVALID');
  const report={
    schema:VERIFY_SCHEMA,
    at:at.toISOString(),
    status:'ARTIFACTS_VERIFIED_AT_REST_RELEASE_BLOCKED',
    scope:'INDEPENDENT_HASH_AND_JSON_VERIFICATION_NOT_CLEAN_WINDOWS',
    componentBuild:{
      path:buildFile.path,
      bytes:buildFile.bytes,
      sha256:buildFile.sha256
    },
    releaseIndex:{
      path:indexFile.path,
      bytes:indexFile.bytes,
      sha256:indexFile.sha256
    },
    artifacts,
    sboms,
    fragments:indexFragments,
    artifactsVerified:artifacts.length,
    sbomsVerified:sboms.length,
    fragmentsVerified:indexFragments.length,
    missingRequiredComponents:[],
    releaseReady:false,
    completeDistribution:false,
    cleanWindows:'NOT_VERIFIED',
    redistribution:'NOT_REVIEWED',
    modelCalls:0,
    credentialsRead:false,
    binariesExecuted:false,
    formalProductWrites:0
  };
  try{
    mkdirSync(dirname(outputRef.absolute),{recursive:true});
    writeFileSync(outputRef.absolute,`${JSON.stringify(report,null,2)}\n`,{
      flag:'wx',
      flush:true
    });
  }catch(error){
    if(error?.code==='EEXIST')fail('OUTPUT_EXISTS');
    if(error?.code==='ENOTDIR')fail('OUTPUT_PATH_DENIED');
    throw error;
  }
  return report;
}

function arg(name,fallback=null){
  const index=process.argv.indexOf(name);
  if(index<0)return fallback;
  if(index+1>=process.argv.length)fail(`ARGUMENT_MISSING:${name}`);
  return process.argv[index+1];
}

if(process.argv[1]&&
    import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const report=verifyComponentArtifactsAtRest({
      evidenceRoot:arg('--evidence-root'),
      componentBuildPath:arg('--component-build'),
      releaseIndexPath:arg('--release-index'),
      output:arg('--output')
    });
    console.log(JSON.stringify({
      status:report.status,
      artifactsVerified:report.artifactsVerified,
      sbomsVerified:report.sbomsVerified,
      fragmentsVerified:report.fragmentsVerified,
      releaseReady:false
    }));
  }catch(error){
    console.error(error?.code??'COMPONENT_ARTIFACT_VERIFICATION_FAILED');
    process.exitCode=1;
  }
}
