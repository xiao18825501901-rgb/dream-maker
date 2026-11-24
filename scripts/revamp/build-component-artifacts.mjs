// Builds deterministic, evidence-only component archives. It is not a release gate.
import {createHash} from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {qualifyComponentEvidenceFragment} from '../../dist/server/release/component-inventory.mjs';

const SCHEMA='dream-maker.component-artifacts-build.v1';
const COMPONENT_SCHEMA='dream-maker.component-artifact-build.v1';
const SBOM_SCHEMA='dream-maker.component-sbom.v1';
const FRAGMENT_SCHEMA='dream-maker.release-component-fragment.v1';
const HASH=/^[a-f0-9]{64}$/;
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_JSON=4*1024*1024;
const MAX_SOURCE_FILE=32*1024*1024;
const MAX_RUNTIME_FILE=256*1024*1024;
const REQUIRED_IDS=[
  'dm-controller',
  'dreamflow-core',
  'planner1-cloud-runtime',
  'verified-base-toolchain'
];
const SOURCE_IDS=REQUIRED_IDS.slice(0,3);
const FIXED_DOS_TIME=0;
const FIXED_DOS_DATE=0x0021;

const fail=code=>{
  const error=new Error(code);
  error.code=code;
  throw error;
};
const sha256=value=>createHash('sha256').update(value).digest('hex');
const text=(value,max=32000)=>typeof value==='string'&&value.length>0&&
  value.length<=max&&!CONTROL.test(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(left,right)=>left.dev===right.dev&&left.ino===right.ino&&
  left.size===right.size&&left.mtimeMs===right.mtimeMs&&left.mode===right.mode;

function absolute(value,code){
  if(!text(value)||!isAbsolute(value)||/^[\\/]{2}/.test(value))fail(code);
  return resolve(value);
}

function pathExists(path){
  try{
    lstatSync(path);
    return true;
  }catch(error){
    if(error?.code==='ENOENT')return false;
    throw error;
  }
}

function safeParts(value,code){
  if(!text(value,2000)||isAbsolute(value)||/^[A-Za-z]:/.test(value)||
      /^[\\/]{2}/.test(value)){
    fail(code);
  }
  const parts=value.replaceAll('\\','/').split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'))fail(code);
  return parts;
}

function inside(root,value,code){
  const candidate=isAbsolute(value)?resolve(value):resolve(root,value);
  const rel=relative(root,candidate);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))fail(code);
  return {
    absolute:candidate,
    relative:rel.replaceAll('\\','/'),
    parts:rel.split(/[\\/]+/)
  };
}

function verifyNoLinkedAncestors(root,parts,code,{finalMustExist=true}={}){
  let current=resolve(root);
  let rootStat;
  try{
    rootStat=lstatSync(current);
  }catch{
    fail(code);
  }
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())fail(code);
  for(let index=0;index<parts.length;index++){
    current=resolve(current,parts[index]);
    if(!finalMustExist&&!pathExists(current))return;
    let stat;
    try{
      stat=lstatSync(current);
    }catch{
      fail(code);
    }
    if(stat.isSymbolicLink())fail(code);
    if(index<parts.length-1&&!stat.isDirectory())fail(code);
    if(index===parts.length-1&&!stat.isFile())fail(code);
  }
}

function readOrdinary(path,maxBytes,code){
  let fd;
  try{
    const before=lstatSync(path);
    if(before.isSymbolicLink()||!before.isFile())fail(code);
    if(before.size<0||before.size>maxBytes)fail(code);
    fd=openSync(path,'r');
    const opened=lstatSync(path);
    if(!same(before,opened))fail(code);
    const body=Buffer.alloc(opened.size);
    let offset=0;
    while(offset<body.length){
      const count=readSync(fd,body,offset,body.length-offset,null);
      if(count<=0)break;
      offset+=count;
    }
    if(offset!==body.length||!same(opened,lstatSync(path)))fail(code);
    return {body,bytes:body.length,sha256:sha256(body)};
  }catch(error){
    if(error?.code&&/^(?:INPUT_|SOURCE_|RUNTIME_|BOUNDARY_)/.test(error.code))throw error;
    if(error?.code==='ENOENT')fail(code);
    fail(code);
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
  }
}

function parseJson(buffer,code){
  try{
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
  }catch{
    fail(code);
  }
}

function jsonBytes(value){
  return Buffer.from(`${JSON.stringify(value,null,2)}\n`,'utf8');
}

function treeIdentity(files){
  const sorted=[...files].sort((left,right)=>left.path.localeCompare(right.path,'en'));
  return {
    fileCount:sorted.length,
    bytes:sorted.reduce((sum,item)=>sum+item.bytes,0),
    treeSha256:sha256(sorted
      .map(item=>`${item.path}\0${item.bytes}\0${item.sha256}\n`)
      .join('')),
    files:sorted
  };
}

function normalizeSourceFiles(source){
  if(!record(source)||typeof source.schema!=='string'||
      !source.schema.startsWith('dream-maker.current-source-state.')||
      !text(source.head,64)||!text(source.branch,200)||
      !HASH.test(String(source.sourceHash??''))||
      !Array.isArray(source.sourceFiles)||
      source.sourceFileCount!==source.sourceFiles.length){
    fail('SOURCE_STATE_INVALID');
  }
  const files=[];
  const seen=new Set();
  for(const item of source.sourceFiles){
    if(!record(item)||!text(item.path,2000)||
        !HASH.test(String(item.sha256??''))){
      fail('SOURCE_STATE_FILE_INVALID');
    }
    safeParts(item.path,'SOURCE_STATE_FILE_INVALID');
    if(seen.has(item.path))fail('SOURCE_STATE_FILE_DUPLICATE');
    seen.add(item.path);
    files.push({path:item.path,sha256:item.sha256});
  }
  files.sort((left,right)=>left.path.localeCompare(right.path,'en'));
  if(sha256(JSON.stringify(files))!==source.sourceHash){
    fail('SOURCE_STATE_HASH_MISMATCH');
  }
  return files;
}

function validateBoundary(boundary){
  if(!record(boundary)||boundary.schema!=='dream-maker.release-component-boundary-audit.v1'||
      boundary.status!=='READY_FOR_COMPONENT_ARTIFACT_BUILDERS_RELEASE_BLOCKED'||
      boundary.releaseReady!==false||boundary.completeDistribution!==false||
      !record(boundary.sourceState)||!record(boundary.portableBuild)||
      !Array.isArray(boundary.components)||!Array.isArray(boundary.overlaps)||
      boundary.overlaps.length!==0){
    fail('BOUNDARY_REPORT_INVALID');
  }
  if(!text(boundary.sourceState.path,2000)||
      !HASH.test(String(boundary.sourceState.sha256??''))||
      !HASH.test(String(boundary.sourceState.sourceHash??''))||
      !text(boundary.sourceState.head,64)||!text(boundary.sourceState.branch,200)||
      !Number.isSafeInteger(boundary.sourceState.sourceFileCount)){
    fail('BOUNDARY_SOURCE_REFERENCE_INVALID');
  }
  safeParts(boundary.sourceState.path,'BOUNDARY_SOURCE_PATH_INVALID');
  if(!text(boundary.portableBuild.nodeVersion,40)||
      !text(boundary.portableBuild.nodeRoot,32000)){
    fail('BOUNDARY_RUNTIME_REFERENCE_INVALID');
  }
  if(boundary.components.map(component=>component?.id).join(',')!==REQUIRED_IDS.join(',')){
    fail('BOUNDARY_COMPONENT_SET_INVALID');
  }
  const components=new Map();
  const owned=new Map();
  for(const component of boundary.components){
    if(!record(component)||!REQUIRED_IDS.includes(component.id)||
        components.has(component.id)||!Number.isSafeInteger(component.fileCount)||
        !Number.isSafeInteger(component.bytes)||
        !HASH.test(String(component.treeSha256??''))||
        !Array.isArray(component.files)||component.files.length!==component.fileCount){
      fail('BOUNDARY_COMPONENT_INVALID');
    }
    const files=[];
    const localSeen=new Set();
    for(const file of component.files){
      if(!record(file)||!text(file.path,2000)||
          !Number.isSafeInteger(file.bytes)||file.bytes<0||
          !HASH.test(String(file.sha256??''))){
        fail('BOUNDARY_COMPONENT_FILE_INVALID');
      }
      safeParts(file.path,'BOUNDARY_COMPONENT_FILE_INVALID');
      if(localSeen.has(file.path))fail('BOUNDARY_COMPONENT_FILE_DUPLICATE');
      localSeen.add(file.path);
      files.push({path:file.path,bytes:file.bytes,sha256:file.sha256});
      if(SOURCE_IDS.includes(component.id)){
        if(owned.has(file.path))fail('SOURCE_COMPONENT_FILE_OVERLAP');
        owned.set(file.path,component.id);
      }
    }
    const identity=treeIdentity(files);
    if(identity.fileCount!==component.fileCount||identity.bytes!==component.bytes||
        identity.treeSha256!==component.treeSha256){
      fail('BOUNDARY_COMPONENT_TREE_MISMATCH');
    }
    components.set(component.id,{
      id:component.id,
      sourceKind:component.sourceKind,
      fileCount:identity.fileCount,
      bytes:identity.bytes,
      treeSha256:identity.treeSha256,
      files:identity.files
    });
  }
  return components;
}

function sourceInputs({evidenceRoot,boundary}){
  const sourceRef=inside(evidenceRoot,boundary.sourceState.path,'SOURCE_STATE_PATH_INVALID');
  verifyNoLinkedAncestors(
    evidenceRoot,
    sourceRef.parts,
    'SOURCE_STATE_PATH_INVALID'
  );
  const sourceFile=readOrdinary(
    sourceRef.absolute,
    MAX_JSON,
    'SOURCE_STATE_INVALID'
  );
  if(sourceFile.sha256!==boundary.sourceState.sha256){
    fail('BOUNDARY_SOURCE_STATE_DIGEST_MISMATCH');
  }
  const source=parseJson(sourceFile.body,'SOURCE_STATE_JSON_INVALID');
  const normalized=normalizeSourceFiles(source);
  if(source.sourceFileCount!==boundary.sourceState.sourceFileCount||
      source.sourceHash!==boundary.sourceState.sourceHash||
      source.head!==boundary.sourceState.head||
      source.branch!==boundary.sourceState.branch){
    fail('BOUNDARY_SOURCE_STATE_IDENTITY_MISMATCH');
  }
  const sourceRoot=absolute(source.root,'SOURCE_ROOT_INVALID');
  return {
    source,
    sourceRoot,
    sourceFile,
    sourceFiles:normalized
  };
}

function readSourceComponent(sourceRoot,component,sourceCatalog){
  const files=[];
  for(const expected of component.files){
    if(!sourceCatalog.has(expected.path))fail('SOURCE_COMPONENT_FILE_NOT_IN_SOURCE_STATE');
    const known=sourceCatalog.get(expected.path);
    if(known.sha256!==expected.sha256)fail('SOURCE_COMPONENT_SOURCE_STATE_MISMATCH');
    verifyNoLinkedAncestors(
      sourceRoot,
      safeParts(expected.path,'SOURCE_COMPONENT_PATH_INVALID'),
      'SOURCE_COMPONENT_PATH_INVALID'
    );
    const observed=readOrdinary(
      resolve(sourceRoot,expected.path),
      MAX_SOURCE_FILE,
      'SOURCE_COMPONENT_FILE_INVALID'
    );
    if(observed.bytes!==expected.bytes||observed.sha256!==expected.sha256){
      fail('SOURCE_COMPONENT_FILE_DIGEST_MISMATCH');
    }
    files.push({
      path:expected.path.replaceAll('\\','/'),
      bytes:observed.bytes,
      sha256:observed.sha256,
      body:observed.body
    });
  }
  const identity=treeIdentity(files);
  if(identity.treeSha256!==component.treeSha256)fail('SOURCE_COMPONENT_TREE_MISMATCH');
  return files;
}

function readRuntimeComponent(nodeRoot,component){
  const expectedPaths=new Set(['node.exe','LICENSE']);
  if(component.files.length!==2||
      component.files.some(file=>!expectedPaths.has(file.path))){
    fail('RUNTIME_COMPONENT_FILE_SET_INVALID');
  }
  const files=[];
  for(const expected of component.files){
    verifyNoLinkedAncestors(
      nodeRoot,
      [expected.path],
      'RUNTIME_COMPONENT_PATH_INVALID'
    );
    const observed=readOrdinary(
      resolve(nodeRoot,expected.path),
      MAX_RUNTIME_FILE,
      'RUNTIME_COMPONENT_FILE_INVALID'
    );
    if(observed.bytes!==expected.bytes||observed.sha256!==expected.sha256){
      fail('RUNTIME_COMPONENT_FILE_DIGEST_MISMATCH');
    }
    files.push({
      path:expected.path,
      bytes:observed.bytes,
      sha256:observed.sha256,
      body:observed.body
    });
  }
  files.sort((left,right)=>left.path.localeCompare(right.path,'en'));
  const identity=treeIdentity(files);
  if(identity.treeSha256!==component.treeSha256)fail('RUNTIME_COMPONENT_TREE_MISMATCH');
  return files;
}

const CRC_TABLE=(()=>{
  const table=new Uint32Array(256);
  for(let value=0;value<256;value++){
    let crc=value;
    for(let bit=0;bit<8;bit++){
      crc=(crc&1)!==0?0xedb88320^(crc>>>1):crc>>>1;
    }
    table[value]=crc>>>0;
  }
  return table;
})();

function crc32(body){
  let crc=0xffffffff;
  for(const byte of body)crc=CRC_TABLE[(crc^byte)&0xff]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}

function zipNameBytes(path){
  safeParts(path,'ZIP_ENTRY_PATH_INVALID');
  const body=Buffer.from(path.replaceAll('\\','/'),'utf8');
  if(body.length===0||body.length>0xffff)fail('ZIP_ENTRY_PATH_INVALID');
  return body;
}

function deterministicZip(entries){
  if(!Array.isArray(entries)||entries.length<1||entries.length>0xffff){
    fail('ZIP_ENTRY_SET_INVALID');
  }
  const sorted=[...entries].sort((left,right)=>left.path.localeCompare(right.path,'en'));
  const seen=new Set();
  const localParts=[],centralParts=[];
  let offset=0;
  for(const entry of sorted){
    if(!record(entry)||entry.path===undefined||!Buffer.isBuffer(entry.body)||
        seen.has(entry.path)){
      fail('ZIP_ENTRY_INVALID');
    }
    seen.add(entry.path);
    const name=zipNameBytes(entry.path);
    const body=entry.body;
    if(body.length>0xffffffff||offset>0xffffffff)fail('ZIP_SIZE_UNSUPPORTED');
    const crc=crc32(body);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(0x0800,6);
    local.writeUInt16LE(0,8);
    local.writeUInt16LE(FIXED_DOS_TIME,10);
    local.writeUInt16LE(FIXED_DOS_DATE,12);
    local.writeUInt32LE(crc,14);
    local.writeUInt32LE(body.length,18);
    local.writeUInt32LE(body.length,22);
    local.writeUInt16LE(name.length,26);
    local.writeUInt16LE(0,28);

    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE(20,4);
    central.writeUInt16LE(20,6);
    central.writeUInt16LE(0x0800,8);
    central.writeUInt16LE(0,10);
    central.writeUInt16LE(FIXED_DOS_TIME,12);
    central.writeUInt16LE(FIXED_DOS_DATE,14);
    central.writeUInt32LE(crc,16);
    central.writeUInt32LE(body.length,20);
    central.writeUInt32LE(body.length,24);
    central.writeUInt16LE(name.length,28);
    central.writeUInt16LE(0,30);
    central.writeUInt16LE(0,32);
    central.writeUInt16LE(0,34);
    central.writeUInt16LE(0,36);
    central.writeUInt32LE(0,38);
    central.writeUInt32LE(offset,42);

    localParts.push(local,name,body);
    centralParts.push(central,name);
    offset+=local.length+name.length+body.length;
  }
  const centralOffset=offset;
  const central=Buffer.concat(centralParts);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(0,4);
  end.writeUInt16LE(0,6);
  end.writeUInt16LE(sorted.length,8);
  end.writeUInt16LE(sorted.length,10);
  end.writeUInt32LE(central.length,12);
  end.writeUInt32LE(centralOffset,16);
  end.writeUInt16LE(0,20);
  return Buffer.concat([...localParts,central,end]);
}

export function readStoredZipEntries(archive){
  if(!Buffer.isBuffer(archive)||archive.length<22)fail('ZIP_INVALID');
  const entries=[];
  let offset=0;
  while(offset+4<=archive.length&&archive.readUInt32LE(offset)===0x04034b50){
    if(offset+30>archive.length)fail('ZIP_INVALID');
    const flags=archive.readUInt16LE(offset+6);
    const method=archive.readUInt16LE(offset+8);
    const crc=archive.readUInt32LE(offset+14);
    const compressed=archive.readUInt32LE(offset+18);
    const uncompressed=archive.readUInt32LE(offset+22);
    const nameLength=archive.readUInt16LE(offset+26);
    const extraLength=archive.readUInt16LE(offset+28);
    if(flags!==0x0800||method!==0||compressed!==uncompressed){
      fail('ZIP_UNSUPPORTED');
    }
    const nameStart=offset+30;
    const dataStart=nameStart+nameLength+extraLength;
    const dataEnd=dataStart+compressed;
    if(dataEnd>archive.length)fail('ZIP_INVALID');
    const path=archive.subarray(nameStart,nameStart+nameLength).toString('utf8');
    safeParts(path,'ZIP_ENTRY_PATH_INVALID');
    const body=archive.subarray(dataStart,dataEnd);
    if(crc32(body)!==crc)fail('ZIP_CRC_MISMATCH');
    entries.push({path,body:Buffer.from(body),bytes:body.length,sha256:sha256(body)});
    offset=dataEnd;
  }
  if(entries.length===0||offset+4>archive.length||
      archive.readUInt32LE(offset)!==0x02014b50){
    fail('ZIP_INVALID');
  }
  return entries;
}

function licenseStatus(componentId,nodeVersion=null){
  return Buffer.from([
    'Dream Maker component licensing status',
    `Component: ${componentId}`,
    'Repository declaration: UNLICENSED',
    'Redistribution review: NOT_REVIEWED',
    nodeVersion?`Bundled Node runtime: ${nodeVersion}`:'Bundled third-party packages: NONE',
    'This engineering archive is not a redistribution approval.'
  ].join('\n')+'\n','utf8');
}

function versionFor(componentId,sourceHash,nodeVersion){
  if(componentId==='verified-base-toolchain'){
    return String(nodeVersion).replace(/^v/,'');
  }
  return `0.1.0+m95.${sourceHash.slice(0,12)}`;
}

function writeNew(path,body){
  writeFileSync(path,body,{flag:'wx',flush:true});
}

function componentArtifact({
  component,
  files,
  outputRoot,
  relativeDirectory,
  evidenceDirectory,
  source,
  sourceFile,
  boundaryFile,
  nodeVersion
}){
  const directory=resolve(outputRoot,relativeDirectory);
  mkdirSync(directory,{recursive:true});
  const version=versionFor(component.id,source.sourceHash,nodeVersion);
  const manifest={
    schema:'dream-maker.component-manifest.v1',
    componentId:component.id,
    version,
    sourceKind:component.id==='verified-base-toolchain'
      ?'DEDICATED_WINDOWS_NODE_RUNTIME'
      :'LOCAL_SOURCE_TREE',
    sourceStateSha256:sourceFile.sha256,
    boundaryReportSha256:boundaryFile.sha256,
    sourceHash:source.sourceHash,
    head:source.head,
    branch:source.branch,
    treeSha256:component.treeSha256,
    fileCount:component.fileCount,
    bytes:component.bytes,
    files:component.files.map(file=>({
      path:file.path,
      bytes:file.bytes,
      sha256:file.sha256
    }))
  };
  const manifestBody=jsonBytes(manifest);
  const statusBody=licenseStatus(component.id,nodeVersion);
  const entries=[
    {path:'COMPONENT_MANIFEST.json',body:manifestBody},
    {path:'LICENSE_STATUS.txt',body:statusBody},
    ...files.map(file=>({path:file.path,body:file.body}))
  ];
  const archive=deterministicZip(entries);
  const artifactPath=resolve(directory,'artifact.zip');
  writeNew(artifactPath,archive);
  const artifactSha256=sha256(archive);
  const artifactBytes=archive.length;

  const externalLicensePath=component.id==='verified-base-toolchain'
    ?resolve(directory,'NODE_LICENSE.txt')
    :resolve(directory,'LICENSE_STATUS.txt');
  if(component.id==='verified-base-toolchain'){
    const license=files.find(file=>file.path==='LICENSE');
    if(!license)fail('RUNTIME_LICENSE_MISSING');
    writeNew(externalLicensePath,license.body);
  }else{
    writeNew(externalLicensePath,statusBody);
  }
  const licenseBytes=readOrdinary(
    externalLicensePath,
    16*1024*1024,
    'COMPONENT_LICENSE_INVALID'
  );

  const sbom={
    schema:SBOM_SCHEMA,
    at:null,
    status:'COMPLETE',
    machineReadableComplete:true,
    componentId:component.id,
    version,
    artifactSha256,
    dependencyCount:component.id==='verified-base-toolchain'?1:0,
    dependencies:component.id==='verified-base-toolchain'
      ?[{
          id:`node@${version}`,
          package:'node',
          version,
          manifestSha256:sha256(manifestBody),
          path:'',
          license:{
            status:'PRESENT',
            files:[{
              path:`${evidenceDirectory}/NODE_LICENSE.txt`,
              bytes:licenseBytes.bytes,
              sha256:licenseBytes.sha256
            }]
          }
        }]
      :[],
    sourceInventory:{
      method:'M94_COMPONENT_BOUNDARY_TREE',
      componentId:component.id,
      fileCount:component.fileCount,
      bytes:component.bytes,
      treeSha256:component.treeSha256,
      files:component.files
    },
    licenseStatus:'REDISTRIBUTION_NOT_REVIEWED'
  };
  const sbomPath=resolve(directory,'component-sbom.json');
  const sbomBody=jsonBytes(sbom);
  writeNew(sbomPath,sbomBody);

  const artifactRelative=`${relativeDirectory}/artifact.zip`;
  const licenseRelative=evidenceDirectory+
    (component.id==='verified-base-toolchain'
      ?'/NODE_LICENSE.txt'
      :'/LICENSE_STATUS.txt');
  const sbomRelative=`${relativeDirectory}/component-sbom.json`;
  const sourceIdentity=component.id==='verified-base-toolchain'
    ?{
        kind:'LOCAL_PACKAGE',
        locator:String(source.root),
        revision:version
      }
    :{
        kind:'LOCAL_PACKAGE',
        locator:String(source.root),
        revision:source.sourceHash
      };
  return {
    id:component.id,
    version,
    relativeDirectory,
    artifactPath,
    artifactRelative,
    artifactBytes,
    artifactSha256,
    licensePath:externalLicensePath,
    licenseRelative,
    licenseBytes:licenseBytes.bytes,
    licenseSha256:licenseBytes.sha256,
    sbomPath,
    sbomRelative,
    sbom,
    sourceIdentity
  };
}

function outputReference(evidenceRoot,output){
  if(!text(output,32000)||/^[\\/]{2}/.test(output))fail('OUTPUT_INVALID');
  const outputAbsolute=isAbsolute(output)?resolve(output):resolve(evidenceRoot,output);
  const rel=relative(evidenceRoot,outputAbsolute);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))fail('OUTPUT_OUTSIDE_EVIDENCE_ROOT');
  const parts=rel.split(/[\\/]+/);
  if(parts.some(part=>!part||part==='.'||part==='..'))fail('OUTPUT_INVALID');
  if(pathExists(outputAbsolute))fail('OUTPUT_EXISTS');
  verifyNoLinkedAncestors(
    evidenceRoot,
    parts,
    'OUTPUT_PATH_DENIED',
    {finalMustExist:false}
  );
  return {absolute:outputAbsolute,relative:rel.replaceAll('\\','/'),parts};
}

export function buildComponentArtifacts({
  evidenceRoot,
  sourceState,
  boundaryReport,
  output,
  now=()=>new Date()
}={}){
  if(typeof now!=='function')fail('CLOCK_INVALID');
  const root=absolute(evidenceRoot,'EVIDENCE_ROOT_INVALID');
  const rootStat=lstatSync(root);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())fail('EVIDENCE_ROOT_INVALID');
  const boundaryRef=inside(root,boundaryReport,'BOUNDARY_REPORT_PATH_INVALID');
  verifyNoLinkedAncestors(
    root,
    boundaryRef.parts,
    'BOUNDARY_REPORT_PATH_INVALID'
  );
  const boundaryFile=readOrdinary(
    boundaryRef.absolute,
    MAX_JSON,
    'BOUNDARY_REPORT_INVALID'
  );
  const boundary=parseJson(boundaryFile.body,'BOUNDARY_REPORT_JSON_INVALID');
  const components=validateBoundary(boundary);
  const source=sourceInputs({evidenceRoot:root,boundary});
  const sourceCatalog=new Map(
    source.sourceFiles.map(item=>[item.path,item])
  );
  const sourceBodies=new Map();
  for(const id of SOURCE_IDS){
    const component=components.get(id);
    sourceBodies.set(id,readSourceComponent(source.sourceRoot,component,sourceCatalog));
  }
  const nodeRoot=absolute(boundary.portableBuild.nodeRoot,'NODE_ROOT_INVALID');
  const nodeComponent=components.get('verified-base-toolchain');
  const runtimeFiles=readRuntimeComponent(nodeRoot,nodeComponent);

  const outputRef=outputReference(root,output);
  const parent=dirname(outputRef.absolute);
  mkdirSync(parent,{recursive:true});
  const temporary=`${outputRef.absolute}.tmp-${process.pid}-${Date.now()}`;
  if(pathExists(temporary))fail('OUTPUT_TEMPORARY_EXISTS');
  mkdirSync(temporary,{recursive:false});
  let renamed=false;
  try{
    const built=[];
    for(const id of [...SOURCE_IDS,'verified-base-toolchain']){
      const component=components.get(id);
      const files=id==='verified-base-toolchain'
        ?runtimeFiles
        :sourceBodies.get(id);
      built.push(componentArtifact({
        component,
        files,
        outputRoot:temporary,
        relativeDirectory:id,
        evidenceDirectory:`${outputRef.relative}/${id}`,
        source:source.source,
        sourceFile:source.sourceFile,
        boundaryFile,
        nodeVersion:boundary.portableBuild.nodeVersion
      }));
    }
    const at=now();
    if(!(at instanceof Date)||!Number.isFinite(at.getTime()))fail('CLOCK_INVALID');
    for(const component of built){
      component.sbom.at=at.toISOString();
      writeFileSync(
        component.sbomPath,
        jsonBytes(component.sbom),
        {flag:'w',flush:true}
      );
    }
    renameSync(temporary,outputRef.absolute);
    renamed=true;

    for(const component of built){
      component.artifactPath=resolve(
        outputRef.absolute,
        component.relativeDirectory,
        'artifact.zip'
      );
      component.licensePath=resolve(
        outputRef.absolute,
        component.licenseRelative.replace(`${outputRef.relative}/`,'')
      );
      component.sbomPath=resolve(
        outputRef.absolute,
        component.relativeDirectory,
        'component-sbom.json'
      );
      component.fragmentPath=resolve(
        outputRef.absolute,
        component.relativeDirectory,
        'fragment.json'
      );
      const sbomBody=jsonBytes(component.sbom);
      writeFileSync(component.sbomPath,sbomBody,{flag:'w',flush:true});
      component.artifactRelative=
        `${outputRef.relative}/${component.relativeDirectory}/artifact.zip`;
      component.sbomRelative=
        `${outputRef.relative}/${component.relativeDirectory}/component-sbom.json`;
      const componentEvidence={
        id:component.id,
        version:component.version,
        source:component.sourceIdentity,
        artifact:{
          path:component.artifactRelative,
          bytes:component.artifactBytes,
          sha256:component.artifactSha256
        },
        license:{
          path:component.licenseRelative,
          sha256:component.licenseSha256
        },
        sbom:{
          path:component.sbomRelative,
          sha256:sha256(sbomBody)
        }
      };
      component.componentEvidence=componentEvidence;
      component.componentGate=qualifyComponentEvidenceFragment({
        root,
        component:componentEvidence
      });
      component.fragment={
        schema:FRAGMENT_SCHEMA,
        at:at.toISOString(),
        status:'PARTIAL_COMPONENT_EVIDENCE',
        componentId:component.id,
        component:componentEvidence,
        componentGate:component.componentGate,
        cleanWindowsEvidence:null,
        sourceEvidence:component.id==='verified-base-toolchain'
          ?'M82_RUNTIME_HASH_PIN_ONLY'
          :'M94_LOCAL_SOURCE_TREE_BOUND_TO_SOURCE_STATE',
        sourceIdentityVerified:component.id!=='verified-base-toolchain',
        sourceCommitSigned:false,
        releaseReady:false,
        blockers:[...new Set([
          ...component.componentGate.problems.map(problem=>problem.code),
          'CLEAN_WINDOWS_REFERENCE_INVALID',
          'REDISTRIBUTION_NOT_REVIEWED',
          ...(component.id==='verified-base-toolchain'
            ?[]
            :['SOURCE_COMMIT_NOT_SIGNED'])
        ])],
        modelCalls:0,
        binariesExecuted:false,
        credentialsRead:false,
        scope:'SINGLE_COMPONENT_EVIDENCE_NOT_FULL_DISTRIBUTION'
      };
      const fragmentBody=jsonBytes(component.fragment);
      writeFileSync(component.fragmentPath,fragmentBody,{flag:'wx',flush:true});
      component.fragmentSha256=sha256(fragmentBody);
      const buildReceipt={
        schema:COMPONENT_SCHEMA,
        at:at.toISOString(),
        status:'ARTIFACT_BUILT_RELEASE_BLOCKED',
        componentId:component.id,
        version:component.version,
        sourceState:{
          path:boundary.sourceState.path,
          sha256:source.sourceFile.sha256,
          sourceHash:source.source.sourceHash,
          head:source.source.head,
          branch:source.source.branch
        },
        boundaryReport:{
          path:boundaryRef.relative,
          sha256:boundaryFile.sha256
        },
        m94TreeSha256:components.get(component.id).treeSha256,
        artifact:{
          path:component.artifactRelative,
          bytes:component.artifactBytes,
          sha256:component.artifactSha256
        },
        sbom:{
          path:component.sbomRelative,
          sha256:sha256(sbomBody)
        },
        fragment:{
          path:`${outputRef.relative}/${component.relativeDirectory}/fragment.json`,
          sha256:component.fragmentSha256
        },
        blockers:component.fragment.blockers,
        deterministic:true,
        binariesExecuted:false,
        credentialsRead:false,
        formalWrites:0,
        releaseReady:false,
        completeDistribution:false
      };
      writeNew(
        resolve(outputRef.absolute,component.relativeDirectory,'component-build.json'),
        jsonBytes(buildReceipt)
      );
    }
    const aggregate={
      schema:SCHEMA,
      at:at.toISOString(),
      status:'COMPONENT_ARTIFACTS_BUILT_RELEASE_BLOCKED',
      scope:'FOUR_PINNED_COMPONENT_ARTIFACTS_NOT_RELEASE_MANIFEST',
      evidenceRoot:root,
      output:outputRef.absolute,
      sourceState:{
        path:boundary.sourceState.path,
        sha256:source.sourceFile.sha256,
        sourceHash:source.source.sourceHash,
        head:source.source.head,
        branch:source.source.branch,
        sourceFileCount:source.source.sourceFileCount
      },
      boundaryReport:{
        path:boundaryRef.relative,
        sha256:boundaryFile.sha256
      },
      components:built.map(component=>({
        id:component.id,
        version:component.version,
        artifactPath:component.artifactPath,
        artifactRelative:component.artifactRelative,
        artifactBytes:component.artifactBytes,
        artifactSha256:component.artifactSha256,
        sbomPath:component.sbomPath,
        fragmentPath:component.fragmentPath,
        fragmentSha256:component.fragmentSha256,
        blockers:component.fragment.blockers
      })),
      componentFragmentsCreated:true,
      componentEvidenceGateRun:true,
      completeDistribution:false,
      releaseReady:false,
      cleanWindows:'NOT_VERIFIED',
      redistribution:'NOT_REVIEWED',
      modelCalls:0,
      credentialsRead:false,
      binariesExecuted:false,
      formalWrites:0
    };
    writeNew(
      resolve(outputRef.absolute,'component-artifacts.json'),
      jsonBytes(aggregate)
    );

    const updated=aggregate.components.map(item=>{
      const component=built.find(candidate=>candidate.id===item.id);
      return {
        ...item,
        sbom:component.sbom,
        fragment:component.fragment,
        componentGate:component.componentGate
      };
    });
    return {...aggregate,components:updated};
  }catch(error){
    if(renamed&&existsSync(outputRef.absolute)){
      try{rmSync(outputRef.absolute,{recursive:true,force:true});}catch{}
    }
    if(!renamed&&existsSync(temporary)){
      try{rmSync(temporary,{recursive:true,force:true});}catch{}
    }
    throw error;
  }
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
    const report=buildComponentArtifacts({
      evidenceRoot:arg('--evidence-root'),
      sourceState:arg('--source-state'),
      boundaryReport:arg('--boundary-report'),
      output:arg('--output')
    });
    console.log(JSON.stringify({
      status:report.status,
      output:report.output,
      components:report.components.map(component=>({
        id:component.id,
        bytes:component.artifactBytes,
        sha256:component.artifactSha256
      })),
      releaseReady:false,
      modelCalls:0
    }));
  }catch(error){
    console.error(error?.code??'COMPONENT_ARTIFACT_BUILD_FAILED');
    process.exitCode=1;
  }
}
