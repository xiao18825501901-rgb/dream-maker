// Builds an unsigned self-extracting Setup.exe around an already verified core portable package.
import {createHash} from 'node:crypto';
import {copyFileSync,createReadStream,existsSync,fsyncSync,mkdirSync,openSync,readSync,closeSync,rmSync,statSync,writeFileSync,writeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertSetupDestinations,snapshotSetupInput} from '../../dist/server/release/windows-setup-input.js';
import {checksumSidecarPath} from './checksum-sidecar.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const marker=Buffer.from('DREAMMAKER_SETUP','ascii');
const stamp=Date.now();
// Full local Suites contain the Node runtime and agent bundle; exFAT packaging can exceed
// the generic three-minute subprocess limit even when the archive itself is healthy.
const SETUP_ARCHIVE_TIMEOUT_MS=15*60*1000;

function arg(name,fallback=null){
  const index=process.argv.indexOf(name);
  if(index<0)return fallback;
  if(index+1>=process.argv.length)throw new Error(`SETUP_BUILD_ARGUMENT_MISSING:${name}`);
  return process.argv[index+1];
}

function hashFile(path){
  return new Promise((resolveHash,reject)=>{
    const hash=createHash('sha256'),stream=createReadStream(path);
    stream.on('error',reject);
    stream.on('data',chunk=>hash.update(chunk));
    stream.on('end',()=>resolveHash(hash.digest('hex')));
  });
}

function run(file,args,options={}){
  const result=spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:180000,...options});
  if(result.status!==0)throw new Error(`${basename(file)} failed (${result.status??'unknown'}): ${result.stderr||result.stdout||result.error?.message||''}`);
  return result;
}

const portable=resolve(arg('--package'));
const output=resolve(arg('--output',join('F:\\DreamMakerSuite\\releases\\M132',`DreamMaker-Suite-core-Setup-${stamp}.exe`)));
const receiptPath=resolve(arg('--receipt',join('F:\\DreamMakerSuite\\evidence\\M132',`setup-build-${stamp}.json`)));
const csc=resolve(arg('--csc',join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe')));
const source=resolve(arg('--source',join(root,'scripts/revamp/windows-setup-bootstrapper.cs')));
const temporaryRoot=join(dirname(output),`.setup-build-${process.pid}-${stamp}`);
const payload=join(temporaryRoot,'payload.zip');
const bootstrapper=join(temporaryRoot,'bootstrapper.exe');
const staged=join(temporaryRoot,basename(output));
const sidecarPath=checksumSidecarPath(output);

if(process.platform!=='win32')throw new Error('SETUP_BUILD_WINDOWS_ONLY');
if(existsSync(output))throw new Error('SETUP_BUILD_OUTPUT_EXISTS');
if(existsSync(receiptPath))throw new Error('SETUP_BUILD_RECEIPT_EXISTS');
if(existsSync(sidecarPath))throw new Error('SETUP_BUILD_SIDECAR_EXISTS');
if(!existsSync(csc))throw new Error('SETUP_BUILD_CSC_MISSING');
if(!existsSync(source))throw new Error('SETUP_BUILD_SOURCE_MISSING');
assertSetupDestinations(portable,[output,receiptPath,sidecarPath]);

mkdirSync(dirname(output),{recursive:true});
mkdirSync(dirname(receiptPath),{recursive:true});
mkdirSync(temporaryRoot,{recursive:false});

let outputCreated=false,receiptCreated=false,sidecarCreated=false;
try{
  const snapshot=await snapshotSetupInput(portable,join(temporaryRoot,'DreamMakerSuite'));
  const {packageKind,verification:packageVerification}=snapshot;
  const suite=packageKind==='SUITE';
  run(csc,[
    '/nologo','/target:exe','/platform:x64','/optimize+','/debug-',
    '/reference:System.dll','/reference:System.Core.dll',
    '/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll',
    '/out:'+bootstrapper,source
  ]);

  run('tar.exe',['-a','-c','-f',payload,'-C',temporaryRoot,'DreamMakerSuite'],{timeout:SETUP_ARCHIVE_TIMEOUT_MS});
  const payloadBytes=statSync(payload).size;
  if(payloadBytes<=0||payloadBytes>4*1024*1024*1024)throw new Error('SETUP_BUILD_PAYLOAD_SIZE_INVALID');
  const payloadSha256=await hashFile(payload);
  copyFileSync(bootstrapper,staged);
  const stagingFd=openSync(staged,'a');
  try{
    const sourceFd=openSync(payload,'r'),buffer=Buffer.allocUnsafe(1024*1024);
    let offset=0;
    try{
      while(offset<payloadBytes){
        const length=readSync(sourceFd,buffer,0,Math.min(buffer.length,payloadBytes-offset),offset);
        if(length<=0)throw new Error('SETUP_BUILD_PAYLOAD_TRUNCATED');
        let written=0;
        while(written<length){
          const count=writeSync(stagingFd,buffer,written,length-written);
          if(count<=0)throw new Error('SETUP_BUILD_WRITE_FAILED');
          written+=count;
        }
        offset+=length;
      }
    }finally{closeSync(sourceFd);}
    const trailer=Buffer.alloc(40);
    Buffer.from(payloadSha256,'hex').copy(trailer,0);
    trailer.writeBigUInt64LE(BigInt(payloadBytes),32);
    writeSync(stagingFd,trailer);
    writeSync(stagingFd,marker);
  }finally{closeSync(stagingFd);}
  // Exclusive handles prevent overwriting another writer's late output/receipt/sidecar.
  const publishedFd=openSync(output,'wx');outputCreated=true;
  try{
    const inputFd=openSync(staged,'r'),buffer=Buffer.allocUnsafe(1024*1024);
    try{
      for(let count;(count=readSync(inputFd,buffer,0,buffer.length,null))>0;){
        let offset=0;while(offset<count){const n=writeSync(publishedFd,buffer,offset,count-offset);if(n<=0)throw Error('SETUP_BUILD_WRITE_FAILED');offset+=n;}
      }
      fsyncSync(publishedFd);
    }finally{closeSync(inputFd);}
  }finally{closeSync(publishedFd);}

  const setupSha256=await hashFile(output);
  const receipt={
    schema:'dream-maker.windows-setup-build.v2',
    at:new Date(stamp).toISOString(),
    status:suite?'PASS_SUITE_SETUP_BUILT':'PASS_CORE_SETUP_BUILT',
    scope:suite?'UNSIGNED_LOCAL_SUITE_NOT_RELEASE':'UNSIGNED_CORE_PACKAGE_ONLY',
    packageKind,
    payloadInput:snapshot.payloadInput,
    snapshotFiles:snapshot.snapshotFiles,
    package:portable,
    packageManifestHash:packageVerification.manifestHash,
    packageFilesHash:packageVerification.filesHash??null,
    packageFiles:packageVerification.files,
    packageCoreFiles:suite?packageVerification.coreFiles:null,
    packageRuntimeFiles:suite?packageVerification.runtimeFiles:null,
    packageRuntimeComponents:suite?packageVerification.runtimeComponents:null,
    payloadSha256,
    payloadBytes,
    setup:output,
    setupBytes:statSync(output).size,
    setupSha256,
    signed:false,
    cleanWindows:'NOT_VERIFIED',
    nativeRoles:suite?'PACKAGED_NOT_QUALIFIED':'NOT_BUNDLED',
    redistributionReviewed:false
  };
  const receiptFd=openSync(receiptPath,'wx');receiptCreated=true;
  try{writeFileSync(receiptFd,JSON.stringify(receipt,null,2)+'\n');fsyncSync(receiptFd);}finally{closeSync(receiptFd);}
  const sidecarFd=openSync(sidecarPath,'wx');sidecarCreated=true;
  try{writeFileSync(sidecarFd,`${setupSha256}  ${basename(output)}\n`);fsyncSync(sidecarFd);}finally{closeSync(sidecarFd);}
  console.log(JSON.stringify({setup:output,receipt:receiptPath,packageKind,setupSha256,payloadSha256,payloadBytes,files:packageVerification.files}));
}catch(error){
  if(outputCreated)rmSync(output,{force:true});
  if(receiptCreated)rmSync(receiptPath,{force:true});
  if(sidecarCreated)rmSync(sidecarPath,{force:true});
  throw error;
}finally{
  if(existsSync(temporaryRoot))rmSync(temporaryRoot,{recursive:true,force:true});
}
