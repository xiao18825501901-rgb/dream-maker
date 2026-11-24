// Read-only projection of an already-created Node runtime inventory.
// This never executes the runtime or claims a complete distribution.
import {createHash} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {qualifyComponentEvidenceFragment} from '../../dist/server/release/component-inventory.mjs';

const HASH=/^[a-f0-9]{64}$/;
const REVISION=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA1=/^[a-f0-9]{40}$/;
const SHA512_INTEGRITY=/^sha512-[A-Za-z0-9+/]+={0,2}$/;
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_RECEIPT=512000;
const MAX_PACKAGE=128000;
const MAX_SMALL=16777216;
const MAX_ARTIFACT=2147483648;
const same=(a,b)=>a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ino===b.ino&&a.mode===b.mode;
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const text=(value,max=1000)=>typeof value==='string'&&value.length>0&&value.length<=max&&!CONTROL.test(value);
const requireHash=value=>{if(!HASH.test(String(value??'')))fail('SHA256_INVALID');return value;};
const normalizedLocator=value=>String(value)
  .replace(/^git\+/,'')
  .replace(/\.git$/,'')
  .replace(/\/+$/,'');
const safeRelativePath=value=>text(value,1000)&&
  !/^[A-Za-z]:/.test(value)&&!/^[\\/]/.test(value)&&
  value.split(/[\\/]+/).every(part=>part&&part!=='.'&&part!=='..');
const absolute=value=>{
  if(!text(value,32000)||!isAbsolute(value)||/^[\\\\/]{2}/.test(value))fail('ABSOLUTE_PATH_REQUIRED');
  return resolve(value);
};
const inside=(root,path)=>{
  const candidate=absolute(path),rel=relative(root,candidate);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))fail('PATH_OUTSIDE_EVIDENCE_ROOT');
  return {absolute:candidate,relative:rel.replaceAll('\\','/')};
};

function observe(path,expectedSha256,maxBytes,{capture=false,pinned=true}={}){
  const absolutePath=absolute(path);
  const expected=pinned?requireHash(expectedSha256):null;
  let fd;
  try{
    const before=lstatSync(absolutePath);
    if(before.isSymbolicLink()||!before.isFile())fail('EVIDENCE_FILE_INVALID');
    if(before.size<0||before.size>maxBytes)fail('EVIDENCE_FILE_LIMIT');
    fd=openSync(absolutePath,'r');
    const opened=fstatSync(fd);
    if(!same(before,opened))fail('EVIDENCE_SOURCE_CHANGED');
    const digest=createHash('sha256'),buffer=Buffer.alloc(65536),chunks=capture?[]:null;
    let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){
      total+=count;
      if(total>maxBytes)fail('EVIDENCE_FILE_LIMIT');
      digest.update(buffer.subarray(0,count));
      if(chunks)chunks.push(Buffer.from(buffer.subarray(0,count)));
    }
    if(total!==opened.size||!same(opened,lstatSync(absolutePath)))fail('EVIDENCE_SOURCE_CHANGED');
    const sha256=digest.digest('hex');
    if(expected!==null&&sha256!==expected)fail('EVIDENCE_DIGEST_MISMATCH');
    return {path:absolutePath,bytes:total,sha256,body:capture?Buffer.concat(chunks,total):undefined};
  }catch(error){
    if(error?.code&&/^(?:EVIDENCE_|SHA256_|ABSOLUTE_)/.test(error.code))throw error;
    const code=error?.code==='ENOENT'?'EVIDENCE_MISSING':error?.code==='EACCES'||error?.code==='EPERM'?'EVIDENCE_UNREADABLE':'EVIDENCE_FILE_INVALID';
    fail(code);
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
  }
}

function parse(file,code){
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(file.body));}
  catch{fail(code);}
}

function parseFile(file,code='JSON_INVALID'){
  return parse(file,code);
}

function sourceEvidenceFile(root,pin,maxBytes,code){
  if(!pin||!text(pin.path,1000)||!safeRelativePath(pin.path)||
      !HASH.test(String(pin.sha256??'')))fail(`${code}_REFERENCE_INVALID`);
  const path=inside(root,resolve(root,pin.path));
  try{
    return {...observe(path.absolute,pin.sha256,maxBytes,{capture:true}),relative:path.relative};
  }catch(error){
    const mapped={
      EVIDENCE_DIGEST_MISMATCH:`${code}_DIGEST_MISMATCH`,
      EVIDENCE_MISSING:`${code}_MISSING`,
      EVIDENCE_FILE_LIMIT:`${code}_LIMIT`,
      EVIDENCE_SOURCE_CHANGED:`${code}_CHANGED`,
      EVIDENCE_UNREADABLE:`${code}_UNREADABLE`
    }[error?.code]??`${code}_INVALID`;
    fail(mapped);
  }
}

function gitBlobSha(body){
  return createHash('sha1')
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest('hex');
}

function npmTarballUrl(value){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname==='registry.npmjs.org'&&
      !url.username&&!url.password&&url.pathname.endsWith('.tgz');
  }catch{return false;}
}

function validateSourceProof({
  root,
  proofPath,
  proofSha256,
  componentId,
  version,
  sourceLocator,
  sourceRevision,
  runtimeRoot,
  rootTreeSha256,
  packageJson
}){
  const proofInRoot=inside(root,proofPath);
  const proofFile=sourceEvidenceFile(
    root,
    {path:proofInRoot.relative,sha256:proofSha256},
    MAX_SMALL,
    'SOURCE_PROOF'
  );
  const proof=parseFile(proofFile,'SOURCE_PROOF_JSON_INVALID');
  if(!proof||proof.schema!=='dream-maker.node-runtime-source-proof.v1'||
      proof.status!=='VERIFIED'||proof.componentId!==componentId||
      proof.version!==version||proof.runtimeRootTreeSha256!==rootTreeSha256||
      proof.modelCalls!==0||proof.credentialsRead!==false||
      proof.boundary!=='PINNED_OFFICIAL_RECEIPTS_UNSIGNED_COMMIT') {
    fail('SOURCE_PROOF_IDENTITY_MISMATCH');
  }
  if(!proof.source||proof.source.kind!=='GIT_COMMIT'||
      normalizedLocator(proof.source.locator)!==normalizedLocator(sourceLocator)||
      proof.source.revision!==sourceRevision) {
    fail('SOURCE_PROOF_SOURCE_MISMATCH');
  }

  const commitFile=sourceEvidenceFile(
    root,proof.commitReceipt,MAX_SMALL,'SOURCE_PROOF_COMMIT'
  );
  const commit=parseFile(commitFile,'SOURCE_PROOF_COMMIT_JSON_INVALID');
  if(!commit||commit.schema!=='dream-maker.github-commit-receipt.v1'||
      normalizedLocator(commit.repository)!==normalizedLocator(sourceLocator)||
      commit.sha!==sourceRevision||!REVISION.test(String(commit.treeSha??''))||
      !text(commit.message,500)||
      !/^release(?:\([a-z0-9-]+\))?:\s/i.test(commit.message)||
      !commit.message.includes(version)||
      !commit.verification||typeof commit.verification.verified!=='boolean'||
      !text(commit.verification.reason,120)) {
    fail('SOURCE_PROOF_COMMIT_INVALID');
  }
  const treeFile=sourceEvidenceFile(
    root,commit.treeReceipt,MAX_SMALL,'SOURCE_PROOF_TREE'
  );
  const tree=parseFile(treeFile,'SOURCE_PROOF_TREE_JSON_INVALID');
  if(!tree||tree.schema!=='dream-maker.github-tree-receipt.v1'||
      normalizedLocator(tree.repository)!==normalizedLocator(sourceLocator)||
      tree.revision!==sourceRevision||tree.sha!==commit.treeSha||
      tree.truncated!==false||!Array.isArray(tree.entries)||
      tree.entries.length<1||tree.entries.length>250000) {
    fail('SOURCE_PROOF_TREE_INVALID');
  }
  const treeEntries=new Map();
  for(const entry of tree.entries){
    if(!entry||!safeRelativePath(entry.path)||entry.type!=='blob'||
        !SHA1.test(String(entry.sha??''))||treeEntries.has(entry.path)) {
      fail('SOURCE_PROOF_TREE_INVALID');
    }
    treeEntries.set(entry.path,entry.sha);
  }

  const lockFile=observe(
    resolve(runtimeRoot,'package-lock.json'),
    null,
    MAX_SMALL,
    {capture:true,pinned:false}
  );
  const lock=parseFile(lockFile,'PACKAGE_LOCK_INVALID');
  if(!lock||lock.lockfileVersion!==3||!lock.packages||
      typeof lock.packages!=='object'||Array.isArray(lock.packages)) {
    fail('PACKAGE_LOCK_INVALID');
  }
  const dependencies=packageJson.dependencies;
  if(!dependencies||typeof dependencies!=='object'||Array.isArray(dependencies)||
      !Array.isArray(proof.packages)||proof.packages.length<1||
      proof.packages.length>128) {
    fail('SOURCE_PROOF_PACKAGES_INVALID');
  }
  const dependencyNames=Object.keys(dependencies).sort();
  const proofNames=proof.packages.map(item=>item?.name).sort();
  if(dependencyNames.length!==proofNames.length||
      dependencyNames.some((name,index)=>name!==proofNames[index])) {
    fail('SOURCE_PROOF_PACKAGES_INCOMPLETE');
  }
  if(proof.networkRequests!==2+2*proof.packages.length) {
    fail('SOURCE_PROOF_NETWORK_AUDIT_INVALID');
  }

  const seen=new Set();
  let registryReceiptCount=0;
  for(const item of proof.packages){
    if(!item||!text(item.name,214)||item.version!==version||seen.has(item.name)||
        !SHA512_INTEGRITY.test(String(item.lockIntegrity??''))||
        !npmTarballUrl(item.lockResolved)||
        !safeRelativePath(item.repositoryDirectory)) {
      fail('SOURCE_PROOF_PACKAGE_INVALID');
    }
    seen.add(item.name);
    if(dependencies[item.name]!==version)fail('SOURCE_PROOF_PACKAGE_MISMATCH');
    const lockPackage=lock.packages[`node_modules/${item.name}`];
    if(!lockPackage||lockPackage.version!==version||
        lockPackage.integrity!==item.lockIntegrity||
        lockPackage.resolved!==item.lockResolved) {
      fail('SOURCE_PROOF_PACKAGE_MISMATCH');
    }

    const registryFile=sourceEvidenceFile(
      root,item.registry,MAX_SMALL,'SOURCE_PROOF_REGISTRY'
    );
    const registry=parseFile(
      registryFile,
      'SOURCE_PROOF_REGISTRY_JSON_INVALID'
    );
    if(!registry||registry.name!==item.name||registry.version!==version||
        !registry.repository||
        normalizedLocator(registry.repository.url)!==
          normalizedLocator(sourceLocator)||
        registry.repository.directory!==item.repositoryDirectory||
        !registry.dist||registry.dist.integrity!==item.lockIntegrity||
        !npmTarballUrl(registry.dist.tarball)) {
      fail('SOURCE_PROOF_REGISTRY_INVALID');
    }
    registryReceiptCount++;

    const manifestFile=sourceEvidenceFile(
      root,item.upstreamManifest,MAX_PACKAGE,'SOURCE_PROOF_MANIFEST'
    );
    if(gitBlobSha(manifestFile.body)!==item.upstreamManifest.gitBlobSha) {
      fail('SOURCE_PROOF_MANIFEST_BLOB_MISMATCH');
    }
    const manifestPath=`${item.repositoryDirectory}/package.json`;
    if(treeEntries.get(manifestPath)!==item.upstreamManifest.gitBlobSha) {
      fail('SOURCE_PROOF_COMMIT_PATH_MISMATCH');
    }
    const manifest=parseFile(
      manifestFile,
      'SOURCE_PROOF_MANIFEST_JSON_INVALID'
    );
    if(!manifest||manifest.name!==item.name||manifest.version!==version) {
      fail('SOURCE_PROOF_MANIFEST_INVALID');
    }

    const localPackagePath=resolve(
      runtimeRoot,
      'node_modules',
      ...item.name.split('/'),
      'package.json'
    );
    const relativeLocal=relative(runtimeRoot,localPackagePath);
    if(!relativeLocal||relativeLocal.startsWith('..')||isAbsolute(relativeLocal)) {
      fail('SOURCE_PROOF_LOCAL_PACKAGE_INVALID');
    }
    const localFile=observe(
      localPackagePath,
      null,
      MAX_PACKAGE,
      {capture:true,pinned:false}
    );
    const localManifest=parseFile(
      localFile,
      'SOURCE_PROOF_LOCAL_PACKAGE_INVALID'
    );
    if(!localManifest||localManifest.name!==item.name||
        localManifest.version!==version) {
      fail('SOURCE_PROOF_LOCAL_PACKAGE_MISMATCH');
    }
  }

  return {
    path:proofFile.relative,
    sha256:proofFile.sha256,
    commitSha:commit.sha,
    treeSha:commit.treeSha,
    commitMessage:commit.message,
    commitSigned:commit.verification.verified===true,
    packageCount:proof.packages.length,
    registryReceiptCount
  };
}

function arg(name){
  const index=process.argv.indexOf(name);
  if(index<0||index+1>=process.argv.length)fail(`ARGUMENT_MISSING:${name}`);
  return process.argv[index+1];
}

function optionalArg(name){
  const index=process.argv.indexOf(name);
  if(index<0)return null;
  if(index+1>=process.argv.length)fail(`ARGUMENT_MISSING:${name}`);
  return process.argv[index+1];
}

const root=absolute(arg('--root'));
const receiptPath=absolute(arg('--receipt'));
const receiptSha256=requireHash(arg('--receipt-sha256'));
const componentId=arg('--component-id');
const packageName=arg('--package-name');
const version=arg('--version');
const sourceLocator=arg('--source-locator');
const sourceRevision=arg('--source-revision');
const cleanWindowsPath=optionalArg('--clean-windows');
const cleanWindowsSha256=optionalArg('--clean-windows-sha256');
const sourceProofPath=optionalArg('--source-proof');
const sourceProofSha256=optionalArg('--source-proof-sha256');
const output=absolute(arg('--output'));

if(!/^[a-z0-9][a-z0-9-]*$/.test(componentId))fail('COMPONENT_ID_INVALID');
if(!text(packageName,214)||!text(version,160))fail('COMPONENT_IDENTITY_INVALID');
if(!text(sourceLocator,2000)||!REVISION.test(sourceRevision))fail('SOURCE_IDENTITY_INVALID');
if((cleanWindowsPath===null)!==(cleanWindowsSha256===null))fail('CLEAN_WINDOWS_ARGUMENT_PAIR_REQUIRED');
if((sourceProofPath===null)!==(sourceProofSha256===null))fail('SOURCE_PROOF_ARGUMENT_PAIR_REQUIRED');
if(existsSync(output))fail('OUTPUT_EXISTS');

const rootItem=lstatSync(root);
if(rootItem.isSymbolicLink()||!rootItem.isDirectory())fail('EVIDENCE_ROOT_INVALID');

const receiptInRoot=inside(root,receiptPath);
const receiptFile=observe(receiptInRoot.absolute,receiptSha256,MAX_RECEIPT,{capture:true});
const receipt=parse(receiptFile,'INVENTORY_RECEIPT_INVALID');
if(!receipt||receipt.schema!=='dream-maker.node-runtime-inventory.v1'||
    receipt.status!=='COMPLETE'||receipt.machineReadableComplete!==true||
    !Array.isArray(receipt.missingLicenses)||receipt.missingLicenses.length!==0||
    receipt.modelCalls!==0||receipt.networkRequests!==0) {
  fail('INVENTORY_RECEIPT_INVALID');
}
if(!receipt.artifact||!Number.isSafeInteger(receipt.artifact.bytes)||
    receipt.artifact.bytes<1||!HASH.test(String(receipt.artifact.sha256??''))) {
  fail('ARTIFACT_REFERENCE_INVALID');
}
if(!receipt.licenseBundle||!Number.isSafeInteger(receipt.licenseBundle.bytes)||
    receipt.licenseBundle.bytes<1||!HASH.test(String(receipt.licenseBundle.sha256??''))) {
  fail('LICENSE_REFERENCE_INVALID');
}
if(!receipt.output||!HASH.test(String(receipt.sbomSha256??''))||
    !HASH.test(String(receipt.rootTreeSha256??''))) {
  fail('INVENTORY_REFERENCE_INVALID');
}

const artifact=inside(root,receipt.artifact.path);
const artifactFile=observe(artifact.absolute,receipt.artifact.sha256,MAX_ARTIFACT);
if(artifactFile.bytes!==receipt.artifact.bytes)fail('ARTIFACT_BYTES_MISMATCH');

const license=inside(root,receipt.licenseBundle.path);
const licenseFile=observe(license.absolute,receipt.licenseBundle.sha256,MAX_SMALL);
if(licenseFile.bytes!==receipt.licenseBundle.bytes)fail('LICENSE_BYTES_MISMATCH');

const outputDirectory=inside(root,receipt.output);
const sbomPath=resolve(outputDirectory.absolute,'component-sbom.json');
const sbom=inside(root,sbomPath);
const sbomFile=observe(sbom.absolute,receipt.sbomSha256,MAX_SMALL,{capture:true});
const sbomDocument=parse(sbomFile,'INVENTORY_SBOM_INVALID');
if(!sbomDocument||sbomDocument.schema!=='dream-maker.component-sbom.v1'||
    sbomDocument.status!=='COMPLETE'||sbomDocument.machineReadableComplete!==true||
    sbomDocument.componentId!==componentId||sbomDocument.version!==version||
    sbomDocument.artifactSha256!==receipt.artifact.sha256||
    !Number.isSafeInteger(sbomDocument.dependencyCount)||
    sbomDocument.dependencyCount<0||
    !Array.isArray(sbomDocument.dependencies)||
    sbomDocument.dependencyCount!==sbomDocument.dependencies.length||
    !sbomDocument.inventory||
    sbomDocument.inventory.rootTreeSha256!==receipt.rootTreeSha256) {
  fail('INVENTORY_SBOM_INVALID');
}

const runtimeRoot=absolute(receipt.root);
const runtimeRootItem=lstatSync(runtimeRoot);
if(runtimeRootItem.isSymbolicLink()||!runtimeRootItem.isDirectory())fail('RUNTIME_ROOT_INVALID');
const packageFile=observe(resolve(runtimeRoot,'package.json'),null,MAX_PACKAGE,{capture:true,pinned:false});
const packageJson=parse(packageFile,'PACKAGE_JSON_INVALID');
if(!packageJson||packageJson.name!==packageName||packageJson.version!==version) {
  fail('PACKAGE_IDENTITY_INVALID');
}

let sourceProof=null;
if(sourceProofPath!==null){
  sourceProof=validateSourceProof({
    root,
    proofPath:sourceProofPath,
    proofSha256:requireHash(sourceProofSha256),
    componentId,
    version,
    sourceLocator,
    sourceRevision,
    runtimeRoot,
    rootTreeSha256:receipt.rootTreeSha256,
    packageJson
  });
}

let cleanWindowsEvidence=null;
if(cleanWindowsPath!==null){
  const pinned=inside(root,cleanWindowsPath);
  const observed=observe(pinned.absolute,requireHash(cleanWindowsSha256),MAX_SMALL);
  cleanWindowsEvidence={path:pinned.relative,sha256:observed.sha256};
}

const component={
  id:componentId,
  version,
  source:{
    kind:'GIT_COMMIT',
    locator:sourceLocator,
    revision:sourceRevision
  },
  artifact:{path:artifact.relative,bytes:receipt.artifact.bytes,sha256:receipt.artifact.sha256},
  license:{path:license.relative,sha256:receipt.licenseBundle.sha256},
  sbom:{path:sbom.relative,sha256:sbomFile.sha256},
  ...(cleanWindowsEvidence?{cleanWindows:cleanWindowsEvidence}:{})
};

const componentGate=qualifyComponentEvidenceFragment({root,component});
const blockers=[...componentGate.problems.map(problem=>problem.code)];
if(receipt.redistributionReviewed!==true)blockers.push('REDISTRIBUTION_NOT_REVIEWED');
if(!sourceProof)blockers.push('SOURCE_IDENTITY_NOT_VERIFIED');
const uniqueBlockers=[...new Set(blockers)];
const document={
  schema:'dream-maker.release-component-fragment.v1',
  at:new Date().toISOString(),
  status:componentGate.evidenceVerified&&uniqueBlockers.length===0?'VERIFIED_COMPONENT_FRAGMENT':'PARTIAL_COMPONENT_EVIDENCE',
  componentId:component.id,
  component,
  componentGate,
  cleanWindowsEvidence,
  sourceEvidence:sourceProof?
    'PINNED_OFFICIAL_COMMIT_AND_REGISTRY_RECEIPTS':
    'CALLER_PINNED_NO_INDEPENDENT_COMMIT_PROOF',
  sourceIdentityVerified:sourceProof!==null,
  sourceCommitSigned:sourceProof?.commitSigned===true,
  sourceProof,
  releaseReady:false,
  blockers:uniqueBlockers,
  modelCalls:0,
  binariesExecuted:false,
  credentialsRead:false,
  scope:'SINGLE_COMPONENT_EVIDENCE_NOT_FULL_DISTRIBUTION'
};

mkdirSync(dirname(output),{recursive:true});
const temporary=`${output}.tmp-${process.pid}-${Date.now()}`;
try{
  writeFileSync(temporary,JSON.stringify(document,null,2)+'\n',{flag:'wx',flush:true});
  renameSync(temporary,output);
}catch(error){
  if(existsSync(temporary))try{unlinkSync(temporary);}catch{}
  throw error;
}
console.log(JSON.stringify({
  output,
  status:document.status,
  componentId:component.id,
  version:component.version,
  evidenceVerified:componentGate.evidenceVerified,
  blockers:uniqueBlockers,
  modelCalls:0
}));
