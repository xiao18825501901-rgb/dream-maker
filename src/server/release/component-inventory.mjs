/** Release inventory and fail-closed evidence gate. This module does not install, download or certify a distribution. */
import {createHash} from 'node:crypto';
import {closeSync,fstatSync,lstatSync,openSync,readSync} from 'node:fs';
import {isAbsolute,relative,resolve} from 'node:path';
import {requireCondition as need,isRecord,hashValue} from '../research/common.mjs';

export const REQUIRED_CORE_COMPONENTS=['dm-controller','dreamflow-core','codex-runtime','dsh-runtime','planner1-cloud-runtime','verified-base-toolchain'];

const HASH=/^[a-f0-9]{64}$/;
const GIT_REVISION=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA512_INTEGRITY=/^sha512-[A-Za-z0-9+/]+={0,2}$/;
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const EVIDENCE_SCHEMA='dream-maker.release-component-evidence.v1';
const SBOM_SCHEMA='dream-maker.component-sbom.v1';
const CLEAN_WINDOWS_SCHEMA='dream-maker.component-clean-windows-evidence.v1';
const MAX_MANIFEST_BYTES=512000;
const MAX_ARTIFACT_BYTES=2_147_483_648;
const MAX_LICENSE_BYTES=16_777_216;
const MAX_SBOM_BYTES=16_777_216;
const MAX_CLEAN_WINDOWS_BYTES=8_388_608;

const problem=(component,code)=>({component,code});
const textValue=(value,max=600)=>typeof value==='string'&&value.length>0&&value.length<=max&&!CONTROL.test(value);
const safeEvidenceRelative=value=>{
  if(!textValue(value,1000)||isAbsolute(value)||/^[A-Za-z]:/.test(value)||/^[\\/]{2}/.test(value))return false;
  const parts=value.split(/[\\/]+/);
  return parts.every(part=>part&&part!=='.'&&part!=='..');
};
const safeRelative=(root,value)=>{
  if(!textValue(value)||isAbsolute(value)||/^[A-Za-z]:/.test(value)||/^[\\/]{2}/.test(value))return null;
  const parts=value.split(/[\\/]+/);
  if(parts.some(part=>!part||part==='.'||part==='..'))return null;
  const absolute=resolve(root,value),rel=relative(resolve(root),absolute);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))return null;
  return {absolute,parts};
};
const same=(a,b)=>a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ino===b.ino&&a.mode===b.mode;
function noLinkedAncestors(root,parts){
  let current=resolve(root);
  const rootStat=lstatSync(current);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())return 'EVIDENCE_PATH_DENIED';
  for(let index=0;index<parts.length;index++){
    current=resolve(current,parts[index]);
    const stat=lstatSync(current);
    if(stat.isSymbolicLink())return 'EVIDENCE_LINK_DENIED';
    if(index<parts.length-1&&!stat.isDirectory())return 'EVIDENCE_PATH_DENIED';
    if(index===parts.length-1&&!stat.isFile())return 'EVIDENCE_NOT_A_FILE';
  }
  return null;
}
function readPinned(root,path,expectedSha256,maxBytes,{capture=false}={}){
  if(!textValue(path)||!HASH.test(String(expectedSha256??'')))return {code:'EVIDENCE_REFERENCE_INVALID'};
  const safe=safeRelative(root,path);
  if(!safe)return {code:'EVIDENCE_PATH_DENIED'};
  let fd;
  try{
    const linked=noLinkedAncestors(root,safe.parts);
    if(linked)return {code:linked};
    const before=lstatSync(safe.absolute);
    fd=openSync(safe.absolute,'r');
    const opened=fstatSync(fd);
    if(!opened.isFile())return {code:'EVIDENCE_NOT_A_FILE'};
    if(!same(before,opened))return {code:'EVIDENCE_SOURCE_CHANGED'};
    if(opened.size<0||opened.size>maxBytes)return {code:'EVIDENCE_FILE_LIMIT'};
    const digest=createHash('sha256'),chunks=[];
    const buffer=Buffer.alloc(Math.min(65536,Math.max(1,opened.size)));
    let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){
      total+=count;
      if(total>maxBytes)return {code:'EVIDENCE_FILE_LIMIT'};
      digest.update(buffer.subarray(0,count));
      if(capture)chunks.push(Buffer.from(buffer.subarray(0,count)));
    }
    if(total!==opened.size)return {code:'EVIDENCE_SOURCE_CHANGED'};
    if(!same(opened,lstatSync(safe.absolute)))return {code:'EVIDENCE_SOURCE_CHANGED'};
    const sha256=digest.digest('hex');
    if(sha256!==expectedSha256)return {code:'EVIDENCE_DIGEST_MISMATCH'};
    return {ok:true,path,bytes:total,sha256,body:capture?Buffer.concat(chunks,total):undefined};
  }catch(error){
    const code=error?.code;
    return {code:code==='ENOENT'?'EVIDENCE_MISSING':code==='EACCES'||code==='EPERM'?'EVIDENCE_UNREADABLE':'EVIDENCE_PATH_DENIED'};
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
  }
}
function parseJsonEvidence(file){
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(file.body));}catch{return null;}
}
function sourceIdentity(source){
  if(!isRecord(source)||!['GIT_COMMIT','RELEASE_ASSET','LOCAL_PACKAGE'].includes(source.kind)||!textValue(source.locator,600))return false;
  if(source.kind==='GIT_COMMIT')return typeof source.revision==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.revision);
  return textValue(source.revision,160);
}
function typedEvidenceMatches(value,{schema,component,artifactSha256}){
  return isRecord(value)&&value.schema===schema&&value.status==='PASS'&&value.componentId===component.id&&value.version===component.version&&value.artifactSha256===artifactSha256&&value.platform==='win32';
}
function completeSbomMatches(value,component,artifactSha256){
  if(!isRecord(value)||value.schema!==SBOM_SCHEMA||value.status!=='COMPLETE'||
      value.machineReadableComplete!==true||value.componentId!==component.id||
      value.version!==component.version||value.artifactSha256!==artifactSha256||
      !Number.isSafeInteger(value.dependencyCount)||value.dependencyCount<0||
      !Array.isArray(value.dependencies)||value.dependencies.length>4096||
      value.dependencyCount!==value.dependencies.length)return false;
  if(value.inventory!==undefined){
    const inventory=value.inventory;
    if(!isRecord(inventory)||inventory.method!=='PACKAGE_JSON_DIRECTORY_TREE'||
        !HASH.test(String(inventory.rootTreeSha256??''))||
        !Number.isSafeInteger(inventory.fileCount)||inventory.fileCount<1||
        !Number.isSafeInteger(inventory.packageCount)||inventory.packageCount<1||
        inventory.packageCount!==value.dependencies.length||
        !Number.isSafeInteger(inventory.totalBytes)||inventory.totalBytes<0)return false;
  }
  const reviewedEvidenceCount=value.dependencies.filter(dependency=>
    isRecord(dependency)&&isRecord(dependency.license)&&
    ['EXTERNAL_PRESENT','FIRST_PARTY_DECLARED'].includes(dependency.license.status)
  ).length;
  if(reviewedEvidenceCount>0&&
      (!isRecord(value.licenseEvidence)||
       !HASH.test(String(value.licenseEvidence.sha256??''))||
       !Number.isSafeInteger(value.licenseEvidence.entryCount)||
       value.licenseEvidence.entryCount!==reviewedEvidenceCount))return false;
  const seen=new Set();
  for(const dependency of value.dependencies){
    if(!isRecord(dependency)||!textValue(dependency.id,500)||
        !textValue(dependency.package,214)||!textValue(dependency.version,160)||
        dependency.id!==`${dependency.package}@${dependency.version}`||
        !HASH.test(String(dependency.manifestSha256??''))||
        (dependency.path!==''&&!safeEvidenceRelative(dependency.path))||
        !isRecord(dependency.license)||
        !Array.isArray(dependency.license.files)||dependency.license.files.length>64)return false;
    const identity=`${dependency.id}\0${dependency.path}`;
    if(seen.has(identity))return false;
    seen.add(identity);
    if(dependency.license.status==='FIRST_PARTY_DECLARED'){
      const declaration=dependency.license.declaration;
      if(dependency.path!==''||dependency.license.files.length!==0||
          !isRecord(declaration)||!textValue(declaration.owner,214)||
          !textValue(declaration.declaration,214)||
          !safeEvidenceRelative(declaration.sourceLocator)||
          !HASH.test(String(declaration.sourceSha256??''))||
          dependency.license.evidenceSha256!==value.licenseEvidence.sha256)return false;
      continue;
    }
    if(!['PRESENT','EXTERNAL_PRESENT'].includes(dependency.license.status)||
        dependency.license.files.length<1)return false;
    if(dependency.license.status==='EXTERNAL_PRESENT'){
      const provenance=dependency.license.provenance;
      if(!isRecord(provenance)||!textValue(provenance.spdx,214)||
          provenance.evidenceSha256!==value.licenseEvidence.sha256||
          !isRecord(provenance.tarball)||
          !textValue(provenance.tarball.locator,2000)||
          !Number.isSafeInteger(provenance.tarball.bytes)||provenance.tarball.bytes<1||
          !HASH.test(String(provenance.tarball.sha256??''))||
          !SHA512_INTEGRITY.test(String(provenance.tarball.integrity??''))||
          !isRecord(provenance.source)||
          !['GIT_COMMIT','NPM_TARBALL_MEMBER','SPDX_LICENSE_TEXT'].includes(provenance.source.kind)||
          !textValue(provenance.source.locator,2000)||
          !textValue(provenance.source.filePath,1000))return false;
      if(provenance.source.kind==='GIT_COMMIT'&&
          (!GIT_REVISION.test(String(provenance.source.revision??''))||
           provenance.sourceRevision!==provenance.source.revision))return false;
      const upstreamLocator=provenance.source.upstreamLocator;
      const upstreamRevision=provenance.source.upstreamRevision;
      if((upstreamLocator==null)!==(upstreamRevision==null)||
          (upstreamLocator!=null&&
            (!textValue(upstreamLocator,2000)||
             !GIT_REVISION.test(String(upstreamRevision??'')))))return false;
      if(provenance.sourceFilePath!==provenance.source.filePath)return false;
      const additionalSources=provenance.additionalLicenseSources??[];
      if(!Array.isArray(additionalSources)||additionalSources.length>16)return false;
      for(const additional of additionalSources){
        if(!isRecord(additional)||!safeEvidenceRelative(additional.path)||
            !textValue(additional.sourceFilePath,1000)||
            !Number.isSafeInteger(additional.bytes)||additional.bytes<1||
            !HASH.test(String(additional.sha256??'')))return false;
      }
    }
    for(const file of dependency.license.files){
      if(!isRecord(file)||!safeEvidenceRelative(file.path)||
          !Number.isSafeInteger(file.bytes)||file.bytes<1||
          !HASH.test(String(file.sha256??'')))return false;
      if(dependency.license.status==='EXTERNAL_PRESENT'&&file.origin!=='REVIEWED_EXTERNAL')return false;
      if(dependency.license.status==='PRESENT'&&file.origin!==undefined)return false;
    }
  }
  return true;
}

/** Legacy checklist input. Caller booleans are deliberately not accepted as release evidence. */
export function qualifyDistribution({components,platform='win32',variant,liveAccountsReady=false}){
  need(platform==='win32'&&['INSTALLER','PORTABLE'].includes(variant),'UNSUPPORTED_RELEASE_TARGET');
  need(Array.isArray(components)&&new Set(components.map(c=>c.id)).size===components.length,'INVALID_COMPONENT_INVENTORY');
  const problems=[];
  let allRequiredPresent=true;
  for(const required of REQUIRED_CORE_COMPONENTS){
    const c=components.find(x=>x.id===required);
    if(!c){problems.push(problem(required,'CORE_COMPONENT_MISSING'));allRequiredPresent=false;continue;}
    if(c.bundled!==true)problems.push(problem(required,'NOT_BUNDLED'));
    if(c.redistributionReviewed!==true||!c.licenseEvidenceRef)problems.push(problem(required,'REDISTRIBUTION_UNVERIFIED'));
    if(c.syntheticOnly===true||c.cleanMachineRunVerified!==true)problems.push(problem(required,'CLEAN_WINDOWS_NOT_VERIFIED'));
    try{hashValue(c.artifactHash);}catch{problems.push(problem(required,'ARTIFACT_IDENTITY_MISSING'));}
  }
  if(allRequiredPresent)problems.push(problem('*','VERIFIED_EVIDENCE_MANIFEST_REQUIRED'));
  return{
    scope:'RELEASE_CHECKLIST_NOT_INSTALLER',
    completeCore:false,
    evidenceVerified:false,
    problems,
    accountReady:false,
    callerLiveAccountClaimIgnored:liveAccountsReady===true,
    modelsBundled:false,
    optionalComponents:['laya','planner1-local-model'],
    measuredBytes:components.reduce((sum,c)=>sum+(Number.isSafeInteger(c.measuredBytes)&&c.measuredBytes>=0?c.measuredBytes:0),0)
  };
}

function inspectComponent(root,component){
  const problems=[];
  const id=component.id;
  let measuredBytes=0;
  if(!textValue(component.version,160)||!/^[0-9][A-Za-z0-9.+_-]*$/.test(component.version)){
    problems.push(problem(id,'COMPONENT_VERSION_MISSING'));
  }
  if(!sourceIdentity(component.source)){
    problems.push(problem(id,'SOURCE_IDENTITY_MISSING'));
  }
  if(!isRecord(component.artifact)||!Number.isSafeInteger(component.artifact.bytes)||component.artifact.bytes<1){
    problems.push(problem(id,'ARTIFACT_REFERENCE_INVALID'));
    return {problems,measuredBytes,verified:null};
  }
  const artifact=readPinned(root,component.artifact.path,component.artifact.sha256,MAX_ARTIFACT_BYTES);
  if(!artifact.ok){
    problems.push(problem(id,artifact.code));
  }else if(artifact.bytes!==component.artifact.bytes){
    problems.push(problem(id,'ARTIFACT_BYTES_MISMATCH'));
  }else{
    measuredBytes+=artifact.bytes;
  }

  const license=isRecord(component.license)?readPinned(root,component.license.path,component.license.sha256,MAX_LICENSE_BYTES,{capture:true}):{code:'LICENSE_REFERENCE_INVALID'};
  if(!license.ok)problems.push(problem(id,license.code));
  else if(license.bytes===0)problems.push(problem(id,'LICENSE_EMPTY'));

  const sbomFile=isRecord(component.sbom)?readPinned(root,component.sbom.path,component.sbom.sha256,MAX_SBOM_BYTES,{capture:true}):{code:'SBOM_REFERENCE_INVALID'};
  if(!sbomFile.ok)problems.push(problem(id,sbomFile.code));
  else{
    const sbom=parseJsonEvidence(sbomFile);
    if(!completeSbomMatches(sbom,component,component.artifact.sha256))problems.push(problem(id,'INVALID_SBOM_EVIDENCE'));
  }

  const cleanFile=isRecord(component.cleanWindows)?readPinned(root,component.cleanWindows.path,component.cleanWindows.sha256,MAX_CLEAN_WINDOWS_BYTES,{capture:true}):{code:'CLEAN_WINDOWS_REFERENCE_INVALID'};
  if(!cleanFile.ok)problems.push(problem(id,cleanFile.code));
  else{
    const clean=parseJsonEvidence(cleanFile);
    if(!typedEvidenceMatches(clean,{schema:CLEAN_WINDOWS_SCHEMA,component,artifactSha256:component.artifact.sha256}))problems.push(problem(id,'INVALID_CLEAN_WINDOWS_EVIDENCE'));
  }
  return {
    problems,
    measuredBytes,
    verified:{id,version:component.version,artifactSha256:component.artifact.sha256,artifactBytes:component.artifact.bytes,source:component.source}
  };
}

/** Verifies one component fragment. This never claims that the full distribution is releasable. */
export function qualifyComponentEvidenceFragment({root,component}){
  const problems=[];
  if(!textValue(root)||!isAbsolute(root))problems.push(problem('*','EVIDENCE_ROOT_INVALID'));
  const claimedId=isRecord(component)&&textValue(component.id,128)?component.id:'*';
  if(!isRecord(component)||!textValue(component.id,128)||!/^[a-z0-9][a-z0-9-]*$/.test(component.id)){
    problems.push(problem(claimedId,'INVALID_COMPONENT_EVIDENCE'));
  }
  if(problems.length)return {
    scope:'COMPONENT_EVIDENCE_FRAGMENT',
    componentId:claimedId,
    evidenceVerified:false,
    completeDistribution:false,
    releaseReady:false,
    problems,
    component:null,
    measuredBytes:0
  };
  const inspected=inspectComponent(root,component);
  return {
    scope:'COMPONENT_EVIDENCE_FRAGMENT',
    componentId:component.id,
    evidenceVerified:inspected.problems.length===0,
    completeDistribution:false,
    releaseReady:false,
    problems:inspected.problems,
    component:inspected.verified,
    measuredBytes:inspected.measuredBytes
  };
}

/**
 * Verifies a caller-pinned manifest and every component reference before a release can pass the core gate.
 * The SHA-256 pin must come from outside this manifest and be carried by the enclosing release build.
 */
export function qualifyDistributionEvidence({root,manifestPath,expectedManifestSha256,platform='win32',variant}){
  const problems=[];
  if(platform!=='win32'||!['INSTALLER','PORTABLE'].includes(variant))problems.push(problem('*','UNSUPPORTED_RELEASE_TARGET'));
  if(!textValue(root)||!isAbsolute(root))problems.push(problem('*','EVIDENCE_ROOT_INVALID'));
  if(!HASH.test(String(expectedManifestSha256??'')))problems.push(problem('*','EVIDENCE_MANIFEST_UNPINNED'));
  if(problems.length)return {scope:'VERIFIED_COMPONENT_EVIDENCE_RELEASE_GATE',completeCore:false,evidenceVerified:false,problems,components:[],accountReady:false,modelsBundled:false,measuredBytes:0,manifestSha256:null};
  const manifestFile=readPinned(root,manifestPath,expectedManifestSha256,MAX_MANIFEST_BYTES,{capture:true});
  if(!manifestFile.ok){
    problems.push(problem('*',manifestFile.code));
    return {scope:'VERIFIED_COMPONENT_EVIDENCE_RELEASE_GATE',completeCore:false,evidenceVerified:false,problems,components:[],accountReady:false,modelsBundled:false,measuredBytes:0,manifestSha256:null};
  }
  const manifest=parseJsonEvidence(manifestFile);
  if(!isRecord(manifest)||manifest.schema!==EVIDENCE_SCHEMA||!Array.isArray(manifest.components)||manifest.components.length>32){
    problems.push(problem('*','EVIDENCE_MANIFEST_INVALID'));
    return {scope:'VERIFIED_COMPONENT_EVIDENCE_RELEASE_GATE',completeCore:false,evidenceVerified:false,problems,components:[],accountReady:false,modelsBundled:false,measuredBytes:0,manifestSha256:manifestFile.sha256};
  }
  const seen=new Set(),verified=[];
  let measuredBytes=0;
  for(const component of manifest.components){
    const claimedId=isRecord(component)&&textValue(component.id,128)?component.id:'*';
    if(!isRecord(component)||!textValue(component.id,128)||!/^[a-z0-9][a-z0-9-]*$/.test(component.id)){
      problems.push(problem(claimedId,'INVALID_COMPONENT_EVIDENCE'));
      continue;
    }
    if(seen.has(component.id)){
      problems.push(problem(component.id,'DUPLICATE_COMPONENT'));
      continue;
    }
    seen.add(component.id);
    const inspected=inspectComponent(root,component);
    problems.push(...inspected.problems);
    measuredBytes+=inspected.measuredBytes;
    if(inspected.verified)verified.push(inspected.verified);
  }
  for(const required of REQUIRED_CORE_COMPONENTS)if(!seen.has(required))problems.push(problem(required,'CORE_COMPONENT_MISSING'));
  const evidenceVerified=problems.length===0&&REQUIRED_CORE_COMPONENTS.every(id=>verified.some(component=>component.id===id));
  return{
    scope:'VERIFIED_COMPONENT_EVIDENCE_RELEASE_GATE',
    completeCore:evidenceVerified,
    evidenceVerified,
    problems,
    components:verified,
    accountReady:false,
    modelsBundled:false,
    optionalComponents:verified.map(component=>component.id).filter(id=>!REQUIRED_CORE_COMPONENTS.includes(id)),
    measuredBytes:evidenceVerified?measuredBytes:0,
    manifestSha256:manifestFile.sha256,
    manifestPath
  };
}
