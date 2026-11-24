// Read-only projection of pinned component fragments. Not a distribution gate.
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
import {REQUIRED_CORE_COMPONENTS} from '../../dist/server/release/component-inventory.mjs';

const FRAGMENT_SCHEMA='dream-maker.release-component-fragment.v1';
const INDEX_SCHEMA='dream-maker.release-evidence-index.v1';
const HASH=/^[a-f0-9]{64}$/;
const COMPONENT_ID=/^[a-z0-9][a-z0-9-]*$/;
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_FRAGMENT_BYTES=1024*1024;
const MAX_FRAGMENTS=32;

const fail=code=>{
  const error=new Error(code);
  error.code=code;
  throw error;
};
const text=(value,max=600)=>typeof value==='string'&&
  value.length>0&&value.length<=max&&!CONTROL.test(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(left,right)=>left.size===right.size&&
  left.mtimeMs===right.mtimeMs&&left.ino===right.ino&&left.mode===right.mode;

function absoluteRoot(value){
  if(!text(value,32000)||!isAbsolute(value)||/^[\\\\/]{2}/.test(value)){
    fail('EVIDENCE_ROOT_INVALID');
  }
  const root=resolve(value);
  const stat=lstatSync(root);
  if(stat.isSymbolicLink()||!stat.isDirectory())fail('EVIDENCE_ROOT_INVALID');
  return root;
}

function relativeFile(root,value){
  if(!text(value,2000)||isAbsolute(value)||/^[A-Za-z]:/.test(value)||
      /^[\\\\/]{2}/.test(value)){
    fail('FRAGMENT_PATH_DENIED');
  }
  const parts=value.split(/[\\/]+/);
  if(parts.some(part=>!part||part==='.'||part==='..')){
    fail('FRAGMENT_PATH_DENIED');
  }
  const absolute=resolve(root,value);
  const pathFromRoot=relative(root,absolute);
  if(!pathFromRoot||pathFromRoot.startsWith('..')||isAbsolute(pathFromRoot)){
    fail('FRAGMENT_PATH_DENIED');
  }
  return {absolute,parts};
}

function insideRoot(root,value){
  if(!text(value,32000)||!isAbsolute(value)||/^[\\\\/]{2}/.test(value)){
    fail('OUTPUT_OUTSIDE_EVIDENCE_ROOT');
  }
  const absolute=resolve(value);
  const pathFromRoot=relative(root,absolute);
  if(!pathFromRoot||pathFromRoot.startsWith('..')||isAbsolute(pathFromRoot)){
    fail('OUTPUT_OUTSIDE_EVIDENCE_ROOT');
  }
  const parts=pathFromRoot.split(/[\\/]+/);
  if(parts.some(part=>!part||part==='.'||part==='..')){
    fail('OUTPUT_OUTSIDE_EVIDENCE_ROOT');
  }
  return {absolute,parts};
}

function verifyOutputParents(root,parts){
  let current=root;
  for(let index=0;index<parts.length-1;index++){
    current=resolve(current,parts[index]);
    if(!existsSync(current))return;
    const stat=lstatSync(current);
    if(stat.isSymbolicLink())fail('OUTPUT_LINK_DENIED');
    if(!stat.isDirectory())fail('OUTPUT_PATH_DENIED');
  }
}

function verifyNoLinkedAncestors(root,parts){
  let current=root;
  for(let index=0;index<parts.length;index++){
    current=resolve(current,parts[index]);
    const stat=lstatSync(current);
    if(stat.isSymbolicLink())fail('FRAGMENT_LINK_DENIED');
    if(index<parts.length-1&&!stat.isDirectory())fail('FRAGMENT_PATH_DENIED');
    if(index===parts.length-1&&!stat.isFile())fail('FRAGMENT_NOT_A_FILE');
  }
}

function readPinnedFragment(root,reference){
  if(!record(reference)||!HASH.test(String(reference.sha256??''))){
    fail('FRAGMENT_REFERENCE_INVALID');
  }
  const pinned=relativeFile(root,reference.path);
  let fd;
  try{
    verifyNoLinkedAncestors(root,pinned.parts);
    const before=lstatSync(pinned.absolute);
    if(before.size<1||before.size>MAX_FRAGMENT_BYTES)fail('FRAGMENT_FILE_LIMIT');
    fd=openSync(pinned.absolute,'r');
    const opened=fstatSync(fd);
    if(!opened.isFile()||!same(before,opened))fail('FRAGMENT_SOURCE_CHANGED');
    const digest=createHash('sha256'),buffer=Buffer.alloc(65536),chunks=[];
    let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){
      total+=count;
      if(total>MAX_FRAGMENT_BYTES)fail('FRAGMENT_FILE_LIMIT');
      digest.update(buffer.subarray(0,count));
      chunks.push(Buffer.from(buffer.subarray(0,count)));
    }
    if(total!==opened.size||!same(opened,lstatSync(pinned.absolute))){
      fail('FRAGMENT_SOURCE_CHANGED');
    }
    const sha256=digest.digest('hex');
    if(sha256!==reference.sha256)fail('FRAGMENT_DIGEST_MISMATCH');
    let value;
    try{
      value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(
        Buffer.concat(chunks,total)
      ));
    }catch{
      fail('FRAGMENT_JSON_INVALID');
    }
    return {
      relativePath:reference.path.replaceAll('\\','/'),
      bytes:total,
      sha256,
      value
    };
  }catch(error){
    if(error?.code&&/^(?:FRAGMENT_|EVIDENCE_)/.test(error.code))throw error;
    if(error?.code==='ENOENT')fail('FRAGMENT_MISSING');
    if(error?.code==='EACCES'||error?.code==='EPERM')fail('FRAGMENT_UNREADABLE');
    fail('FRAGMENT_PATH_DENIED');
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
  }
}

function classifySourceProvenance(value){
  const source=value.component.source;
  if(!record(source)||
      !['GIT_COMMIT','RELEASE_ASSET','LOCAL_PACKAGE'].includes(source.kind)||
      !text(source.locator,2000)||!text(source.revision,160)){
    fail('RELEASE_FRAGMENT_SOURCE_INVALID');
  }
  if(source.kind==='GIT_COMMIT'){
    return {
      sourceProvenanceClass:'UPSTREAM_GIT_SOURCE',
      sourceIdentityApplicable:true,
      sourceIdentityVerified:value.sourceIdentityVerified===true
    };
  }
  if(source.kind==='LOCAL_PACKAGE'&&
      value.sourceEvidence==='M94_LOCAL_SOURCE_TREE_BOUND_TO_SOURCE_STATE'){
    return {
      sourceProvenanceClass:'LOCAL_SOURCE_TREE',
      sourceIdentityApplicable:true,
      sourceIdentityVerified:value.sourceIdentityVerified===true
    };
  }
  if(source.kind==='LOCAL_PACKAGE'&&
      value.sourceEvidence==='M82_RUNTIME_HASH_PIN_ONLY'){
    if(value.sourceIdentityVerified===true)fail('SOURCE_IDENTITY_CLASS_INVALID');
    return {
      sourceProvenanceClass:'PINNED_BINARY_ARTIFACT',
      sourceIdentityApplicable:false,
      sourceIdentityVerified:false
    };
  }
  if(source.kind==='RELEASE_ASSET'){
    if(value.sourceIdentityVerified===true)fail('SOURCE_IDENTITY_CLASS_INVALID');
    return {
      sourceProvenanceClass:'PINNED_RELEASE_ASSET',
      sourceIdentityApplicable:false,
      sourceIdentityVerified:false
    };
  }
  return {
    sourceProvenanceClass:'UNVERIFIED_SOURCE',
    sourceIdentityApplicable:true,
    sourceIdentityVerified:false
  };
}

function validateFragment(file){
  const value=file.value;
  if(!record(value)||value.schema!==FRAGMENT_SCHEMA||
      value.status!=='PARTIAL_COMPONENT_EVIDENCE'){
    fail('RELEASE_FRAGMENT_SCHEMA_INVALID');
  }
  if(!text(value.componentId,128)||!COMPONENT_ID.test(value.componentId)||
      !record(value.component)||value.component.id!==value.componentId||
      !text(value.component.version,160)||
      !/^[0-9][A-Za-z0-9.+_-]*$/.test(value.component.version)){
    fail('RELEASE_FRAGMENT_IDENTITY_INVALID');
  }
  if(value.scope!=='SINGLE_COMPONENT_EVIDENCE_NOT_FULL_DISTRIBUTION'||
      value.releaseReady!==false||!record(value.componentGate)||
      value.componentGate.scope!=='COMPONENT_EVIDENCE_FRAGMENT'||
      value.componentGate.completeDistribution!==false||
      value.componentGate.releaseReady!==false){
    fail('DISTRIBUTION_CLAIM_IN_FRAGMENT');
  }
  if((value.sourceIdentityVerified!==undefined&&
      typeof value.sourceIdentityVerified!=='boolean')||
      (value.sourceCommitSigned!==undefined&&
       typeof value.sourceCommitSigned!=='boolean')){
    fail('RELEASE_FRAGMENT_SOURCE_IDENTITY_INVALID');
  }
  if(!Array.isArray(value.blockers)||value.blockers.length>32||
      value.blockers.some(blocker=>!text(blocker,200))||
      new Set(value.blockers).size!==value.blockers.length){
    fail('RELEASE_FRAGMENT_BLOCKERS_INVALID');
  }
  const sourceProvenance=classifySourceProvenance(value);
  const artifact=value.component.artifact;
  if(!record(artifact)||!HASH.test(String(artifact.sha256??''))||
      !Number.isSafeInteger(artifact.bytes)||artifact.bytes<0){
    fail('RELEASE_FRAGMENT_ARTIFACT_INVALID');
  }
  return {
    id:value.componentId,
    version:value.component.version,
    status:value.status,
    ...sourceProvenance,
    sourceCommitSigned:value.sourceCommitSigned??null,
    releaseReady:false,
    completeDistribution:false,
    artifactSha256:artifact.sha256,
    artifactBytes:artifact.bytes,
    cleanWindowsBound:record(value.component.cleanWindows),
    blockers:[...value.blockers],
    fragmentPath:file.relativePath,
    fragmentSha256:file.sha256,
    fragmentBytes:file.bytes
  };
}

export function buildReleaseEvidenceIndex({
  root,
  fragments,
  output,
  now=()=>new Date()
}={}){
  if(typeof now!=='function')fail('CLOCK_INVALID');
  const evidenceRoot=absoluteRoot(root);
  const outputPin=insideRoot(evidenceRoot,output);
  if(existsSync(outputPin.absolute))fail('OUTPUT_EXISTS');
  verifyOutputParents(evidenceRoot,outputPin.parts);
  if(!Array.isArray(fragments)||fragments.length<1||
      fragments.length>MAX_FRAGMENTS){
    fail('FRAGMENT_SET_INVALID');
  }

  const components=[];
  const seen=new Set();
  for(const reference of fragments){
    const component=validateFragment(readPinnedFragment(evidenceRoot,reference));
    if(seen.has(component.id))fail('DUPLICATE_COMPONENT');
    seen.add(component.id);
    components.push(component);
  }
  components.sort((left,right)=>left.id.localeCompare(right.id,'en'));
  const coveredRequiredComponents=REQUIRED_CORE_COMPONENTS.filter(id=>seen.has(id));
  const missingRequiredComponents=REQUIRED_CORE_COMPONENTS.filter(id=>!seen.has(id));
  const optionalComponents=components
    .filter(component=>!REQUIRED_CORE_COMPONENTS.includes(component.id))
    .map(component=>component.id);
  const report={
    schema:INDEX_SCHEMA,
    at:now().toISOString(),
    status:missingRequiredComponents.length===0
      ? 'PARTIAL_INDEX_NOT_RELEASE_MANIFEST'
      : 'BLOCKED_INCOMPLETE_COMPONENT_COVERAGE',
    scope:'PINNED_COMPONENT_FRAGMENT_INDEX_NOT_RELEASE_GATE',
    components,
    coveredRequiredComponents,
    missingRequiredComponents,
    optionalComponents,
    sourceIdentityApplicableComponents:components
      .filter(component=>component.sourceIdentityApplicable)
      .map(component=>component.id),
    sourceIdentityVerifiedComponents:components
      .filter(component=>component.sourceIdentityVerified)
      .map(component=>component.id),
    sourceIdentityUnverifiedComponents:components
      .filter(component=>
        component.sourceIdentityApplicable&&!component.sourceIdentityVerified
      )
      .map(component=>component.id),
    sourceIdentityNotApplicableComponents:components
      .filter(component=>!component.sourceIdentityApplicable)
      .map(component=>component.id),
    completeDistribution:false,
    releaseReady:false,
    requiresOriginalDistributionEvidenceGate:true,
    nextGate:'qualifyDistributionEvidence with a pinned clean-Windows component manifest',
    modelCalls:0,
    credentialsRead:false,
    binariesExecuted:false
  };
  try{
    mkdirSync(dirname(outputPin.absolute),{recursive:true});
    verifyOutputParents(evidenceRoot,outputPin.parts);
    writeFileSync(outputPin.absolute,`${JSON.stringify(report,null,2)}\n`,{
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

function arg(name,fallback){
  const index=process.argv.indexOf(name);
  if(index<0)return fallback;
  if(index+1>=process.argv.length)fail(`ARGUMENT_MISSING:${name}`);
  return process.argv[index+1];
}

function fragmentArguments(){
  const fragments=[];
  let pending=null;
  for(let index=0;index<process.argv.length;index++){
    const value=process.argv[index];
    if(value==='--fragment'){
      if(pending)fail('FRAGMENT_SHA_MISSING');
      if(index+1>=process.argv.length)fail('FRAGMENT_PATH_MISSING');
      pending=process.argv[++index];
    }else if(value==='--fragment-sha256'){
      if(!pending)fail('FRAGMENT_PATH_MISSING');
      if(index+1>=process.argv.length)fail('FRAGMENT_SHA_MISSING');
      fragments.push({path:pending,sha256:process.argv[++index]});
      pending=null;
    }
  }
  if(pending)fail('FRAGMENT_SHA_MISSING');
  return fragments;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const report=buildReleaseEvidenceIndex({
      root:arg('--root',null),
      fragments:fragmentArguments(),
      output:arg('--output',null)
    });
    console.log(JSON.stringify({
      status:report.status,
      components:report.components.map(component=>component.id),
      missingRequiredComponents:report.missingRequiredComponents,
      releaseReady:false
    }));
  }catch(error){
    console.error(error?.code??'RELEASE_EVIDENCE_INDEX_FAILED');
    process.exitCode=1;
  }
}
