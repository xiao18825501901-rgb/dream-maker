// Read-only projection of fixed Codex runtime evidence. It never certifies a full release.
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
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_RECEIPT=512000;
const MAX_SIGNATURE=8388608;
const MAX_PACKAGE=128000;
const MAX_SMALL=16777216;
const MAX_ARTIFACT=2147483648;
const same=(a,b)=>a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ino===b.ino&&a.mode===b.mode;
const samePath=(a,b)=>process.platform==='win32'
  ?a.toLowerCase()===b.toLowerCase()
  :a===b;
const text=(value,max=1000)=>typeof value==='string'&&value.length>0&&value.length<=max&&!CONTROL.test(value);
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const requireHash=value=>{if(!HASH.test(String(value??'')))fail('SHA256_INVALID');return value;};
const absolute=value=>{
  if(!text(value,32000)||!isAbsolute(value)||/^[\\\\/]{2}/.test(value))fail('ABSOLUTE_PATH_REQUIRED');
  return resolve(value);
};
const inside=(root,path)=>{
  const candidate=absolute(path),rel=relative(root,candidate);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))fail('PATH_OUTSIDE_EVIDENCE_ROOT');
  return {absolute:candidate,relative:rel.replaceAll('\\','/')};
};

function observe(path,expectedSha256,maxBytes,{capture=false}={}){
  const expected=requireHash(expectedSha256),absolutePath=absolute(path);
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
    if(sha256!==expected)fail('EVIDENCE_DIGEST_MISMATCH');
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
const signaturePath=absolute(arg('--signature'));
const signatureSha256=requireHash(arg('--signature-sha256'));
const inventoryReceiptPath=absolute(arg('--inventory-receipt'));
const inventoryReceiptSha256=requireHash(arg('--inventory-receipt-sha256'));
const cleanWindowsPath=optionalArg('--clean-windows');
const cleanWindowsSha256=optionalArg('--clean-windows-sha256');
if((cleanWindowsPath===null)!==(cleanWindowsSha256===null))fail('CLEAN_WINDOWS_ARGUMENT_PAIR_REQUIRED');
const output=absolute(arg('--output'));
if(existsSync(output))fail('OUTPUT_EXISTS');

const rootItem=lstatSync(root);
if(rootItem.isSymbolicLink()||!rootItem.isDirectory())fail('EVIDENCE_ROOT_INVALID');
const receiptInRoot=inside(root,receiptPath);
const receiptFile=observe(receiptInRoot.absolute,receiptSha256,MAX_RECEIPT,{capture:true});
const receipt=parse(receiptFile,'PREPARATION_RECEIPT_INVALID');
if(!receipt||receipt.schema!=='dream-maker.component-preparation.v1'||
    receipt.status!=='FIXED_CODEX_CLI_COMPONENT_EVIDENCE_CREATED')fail('PREPARATION_RECEIPT_INVALID');
if(receipt.upstream?.repository!=='https://github.com/openai/codex'||
    !text(receipt.upstream?.tag,160)||!/^[a-f0-9]{40}$/.test(String(receipt.upstream?.commit??''))||
    !/^[a-f0-9]{40}$/.test(String(receipt.upstream?.tagObject??''))||
    !['VERIFIED','NOT_VERIFIED'].includes(receipt.upstream?.tagSignature))fail('UPSTREAM_IDENTITY_INVALID');
if(!receipt.artifact||!Number.isSafeInteger(receipt.artifact.bytes)||receipt.artifact.bytes<1) fail('ARTIFACT_REFERENCE_INVALID');
if(!receipt.inventory||!receipt.inventory.licenseBundle) fail('INVENTORY_REFERENCE_INVALID');

const artifact=inside(root,receipt.artifact.path);
if(observe(artifact.absolute,receipt.artifact.sha256,MAX_ARTIFACT).bytes!==receipt.artifact.bytes) fail('ARTIFACT_BYTES_MISMATCH');
const preparationLicense=inside(root,receipt.inventory.licenseBundle.path);
const observedPreparationLicense=observe(
  preparationLicense.absolute,
  receipt.inventory.licenseBundle.sha256,
  MAX_SMALL
);
if(observedPreparationLicense.bytes!==receipt.inventory.licenseBundle.bytes) fail('LICENSE_BYTES_MISMATCH');
const preparationSbomPath=resolve(dirname(preparationLicense.absolute),'component-sbom.json');
const preparationSbom=inside(root,preparationSbomPath);
observe(preparationSbom.absolute,receipt.inventory.sbomSha256,MAX_SMALL);

const runtimeRoot=absolute(receipt.runtimeRoot);
const runtimeRootItem=lstatSync(runtimeRoot);
if(runtimeRootItem.isSymbolicLink()||!runtimeRootItem.isDirectory())fail('RUNTIME_ROOT_INVALID');
const sourcePackage=(receipt.sourceTree?.files??[]).find(file=>file?.path==='package.json');
const copiedPackage=(receipt.copiedTree?.files??[]).find(file=>file?.path==='package.json');
if(!sourcePackage||!copiedPackage||sourcePackage.sha256!==copiedPackage.sha256) fail('PACKAGE_IDENTITY_INVALID');
const packageFile=observe(resolve(runtimeRoot,'package.json'),sourcePackage.sha256,MAX_PACKAGE,{capture:true});
if(packageFile.bytes!==sourcePackage.bytes) fail('PACKAGE_BYTES_MISMATCH');
const packageJson=parse(packageFile,'PACKAGE_JSON_INVALID');
if(packageJson?.name!=='@openai/codex'||!/^[0-9][A-Za-z0-9.+_-]*$/.test(String(packageJson?.version??''))) fail('PACKAGE_IDENTITY_INVALID');
if(receipt.upstream.tag!==`rust-v${packageJson.version}`) fail('UPSTREAM_IDENTITY_INVALID');

const inventoryReceiptInRoot=inside(root,inventoryReceiptPath);
const inventoryReceiptFile=observe(
  inventoryReceiptInRoot.absolute,
  inventoryReceiptSha256,
  MAX_RECEIPT,
  {capture:true}
);
const inventoryReceipt=parse(inventoryReceiptFile,'INVENTORY_RECEIPT_INVALID');
if(!inventoryReceipt||inventoryReceipt.schema!=='dream-maker.node-runtime-inventory.v1'||
    inventoryReceipt.status!=='COMPLETE'||inventoryReceipt.machineReadableComplete!==true||
    !Array.isArray(inventoryReceipt.missingLicenses)||inventoryReceipt.missingLicenses.length!==0||
    inventoryReceipt.modelCalls!==0||inventoryReceipt.networkRequests!==0) {
  fail('INVENTORY_RECEIPT_INVALID');
}
if(!inventoryReceipt.artifact||!samePath(absolute(inventoryReceipt.artifact.path),artifact.absolute)||
    inventoryReceipt.artifact.bytes!==receipt.artifact.bytes||
    inventoryReceipt.artifact.sha256!==receipt.artifact.sha256) {
  fail('INVENTORY_ARTIFACT_MISMATCH');
}
if(!samePath(absolute(inventoryReceipt.root),runtimeRoot)||
    inventoryReceipt.rootTreeSha256!==receipt.sourceTree.treeSha256||
    inventoryReceipt.rootTreeSha256!==receipt.copiedTree.treeSha256||
    inventoryReceipt.rootTreeSha256!==receipt.inventory.rootTreeSha256) {
  fail('INVENTORY_ROOT_MISMATCH');
}
if(!inventoryReceipt.licenseBundle||
    !inventoryReceipt.licenseBundle.path||
    inventoryReceipt.licenseBundle.sha256!==receipt.inventory.licenseBundle.sha256||
    inventoryReceipt.licenseBundle.bytes!==receipt.inventory.licenseBundle.bytes) {
  fail('INVENTORY_LICENSE_MISMATCH');
}
const license=inside(root,inventoryReceipt.licenseBundle.path);
const observedLicense=observe(license.absolute,inventoryReceipt.licenseBundle.sha256,MAX_SMALL);
if(observedLicense.bytes!==inventoryReceipt.licenseBundle.bytes) fail('LICENSE_BYTES_MISMATCH');
const inventoryOutput=absolute(inventoryReceipt.output);
const sbomPath=resolve(inventoryOutput,'component-sbom.json');
const sbom=inside(root,sbomPath);
const observedSbom=observe(sbom.absolute,inventoryReceipt.sbomSha256,MAX_SMALL,{capture:true});
const reclassifiedSbom=parse(observedSbom,'INVENTORY_SBOM_INVALID');
if(!reclassifiedSbom||reclassifiedSbom.schema!=='dream-maker.component-sbom.v1'||
    reclassifiedSbom.status!=='COMPLETE'||reclassifiedSbom.machineReadableComplete!==true||
    reclassifiedSbom.componentId!=='codex-runtime'||
    reclassifiedSbom.version!==packageJson.version||
    reclassifiedSbom.artifactSha256!==receipt.artifact.sha256||
    !Number.isSafeInteger(reclassifiedSbom.dependencyCount)||
    reclassifiedSbom.dependencyCount<0||
    !Array.isArray(reclassifiedSbom.dependencies)||
    reclassifiedSbom.dependencyCount!==reclassifiedSbom.dependencies.length||
    !reclassifiedSbom.inventory||
    reclassifiedSbom.inventory.rootTreeSha256!==inventoryReceipt.rootTreeSha256) {
  fail('INVENTORY_SBOM_INVALID');
}

const signatureFile=observe(signaturePath,signatureSha256,MAX_SIGNATURE,{capture:true});
const signature=parse(signatureFile,'SIGNATURE_EVIDENCE_INVALID');
if(!signature||signature.schema!=='dream-maker.windows-authenticode-evidence.v1'||
    signature.componentId!=='codex-runtime'||signature.version!==packageJson.version||
    signature.artifactSha256!==receipt.artifact.sha256||
    signature.runtimeTreeSha256!==receipt.sourceTree?.treeSha256) fail('SIGNATURE_BINDING_INVALID');
if(!['PASS','PARTIAL','FAIL'].includes(signature.status)||
    !Number.isSafeInteger(signature.totalPeFiles)||signature.totalPeFiles<0||signature.totalPeFiles>256||
    !Number.isSafeInteger(signature.validCount)||signature.validCount<0||
    !Number.isSafeInteger(signature.unsignedCount)||signature.unsignedCount<0||
    !Number.isSafeInteger(signature.invalidCount)||signature.invalidCount<0||
    signature.totalPeFiles!==signature.validCount+signature.unsignedCount+signature.invalidCount) fail('SIGNATURE_COUNTS_INVALID');
if(!Array.isArray(signature.unsignedFiles)||signature.unsignedFiles.length!==signature.unsignedCount||
    !Array.isArray(signature.invalidFiles)||signature.invalidFiles.length!==signature.invalidCount) fail('SIGNATURE_FILE_LISTS_INVALID');
if(signature.binariesExecuted!==false||signature.modelCalls!==0) fail('SIGNATURE_ASSERTION_INVALID');
if(signature.status==='PASS'&&(signature.unsignedCount!==0||signature.invalidCount!==0)) fail('SIGNATURE_STATUS_MISMATCH');
if(signature.status==='PARTIAL'&&(signature.unsignedCount===0||signature.invalidCount!==0)) fail('SIGNATURE_STATUS_MISMATCH');
if(signature.status==='FAIL'&&signature.invalidCount===0) fail('SIGNATURE_STATUS_MISMATCH');

let cleanWindowsEvidence=null;
if(cleanWindowsPath!==null){
  const pinned=inside(root,cleanWindowsPath);
  const observed=observe(pinned.absolute,requireHash(cleanWindowsSha256),MAX_SMALL);
  cleanWindowsEvidence={path:pinned.relative,sha256:observed.sha256};
}

const component={
  id:'codex-runtime',
  version:packageJson.version,
  source:{
    kind:'GIT_COMMIT',
    locator:receipt.upstream.repository,
    revision:receipt.upstream.commit
  },
  artifact:{path:artifact.relative,bytes:receipt.artifact.bytes,sha256:receipt.artifact.sha256},
  license:{path:license.relative,sha256:receipt.inventory.licenseBundle.sha256},
  sbom:{path:sbom.relative,sha256:observedSbom.sha256},
  inventoryReceipt:{path:inventoryReceiptInRoot.relative,sha256:inventoryReceiptFile.sha256},
  ...(cleanWindowsEvidence?{cleanWindows:cleanWindowsEvidence}:{})
};
const componentGate=qualifyComponentEvidenceFragment({root,component});
const blockers=[...componentGate.problems.map(problem=>problem.code)];
if(signature.status==='PARTIAL')blockers.push('AUTHENTICODE_PARTIAL');
if(signature.status==='FAIL')blockers.push('AUTHENTICODE_FAILED');
if(receipt.upstream.tagSignature!=='VERIFIED')blockers.push('TAG_SIGNATURE_NOT_VERIFIED');
if(receipt.redistributionReviewed!==true)blockers.push('REDISTRIBUTION_NOT_REVIEWED');
const uniqueBlockers=[...new Set(blockers)];
const document={
  schema:'dream-maker.release-component-fragment.v1',
  at:new Date().toISOString(),
  status:componentGate.evidenceVerified&&uniqueBlockers.length===0?'VERIFIED_COMPONENT_FRAGMENT':'PARTIAL_COMPONENT_EVIDENCE',
  componentId:component.id,
  component,
  componentGate,
  signatureEvidence:{
    path:signaturePath,
    sha256:signatureFile.sha256,
    status:signature.status,
    totalPeFiles:signature.totalPeFiles,
    validCount:signature.validCount,
    unsignedCount:signature.unsignedCount,
    invalidCount:signature.invalidCount,
    unsignedFiles:signature.unsignedFiles,
    invalidFiles:signature.invalidFiles
  },
  sourceEvidence:'PINNED_PREPARATION_RECEIPT_UPSTREAM_TAG_AND_COMMIT',
  sourceIdentityVerified:true,
  sourceCommitSigned:receipt.upstream.tagSignature==='VERIFIED',
  sourceProof:{
    path:receiptInRoot.relative,
    sha256:receiptFile.sha256,
    repository:receipt.upstream.repository,
    tag:receipt.upstream.tag,
    tagObject:receipt.upstream.tagObject,
    commit:receipt.upstream.commit,
    tagSignature:receipt.upstream.tagSignature
  },
  cleanWindowsEvidence,
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
