// Builds the explicitly scoped Windows core portable package from reviewed local bytes.
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {createReadStream,existsSync,mkdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPortableDirectory,verifyPortableDirectory} from '../../dist/server/release/windows-portable.js';
import {checksumSidecarPath,writeChecksumSidecar} from './checksum-sidecar.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const suite=resolve(process.env.DREAMMAKER_SUITE_ROOT??'F:\\DreamMakerSuite');
const nodeRoot=resolve(process.env.DREAMMAKER_NODE_ROOT??join(suite,'runtime/node-v24.22.1/x/node-v24.22.1-win-x64'));
const stamp=Date.now();

function hashFile(path){
  return new Promise((resolveHash,reject)=>{
    const digest=createHash('sha256'),stream=createReadStream(path);
    stream.on('error',reject);
    stream.on('data',chunk=>digest.update(chunk));
    stream.on('end',()=>resolveHash(digest.digest('hex')));
  });
}

function arg(name,fallback){
  const index=process.argv.indexOf(name);
  if(index<0)return fallback;
  if(index+1>=process.argv.length)throw new Error(`PORTABLE_ARGUMENT_MISSING:${name}`);
  return process.argv[index+1];
}

const output=resolve(arg('--output',join(suite,'builds/M82',`DreamMaker-Suite-core-win-x64-${stamp}`)));
const archive=resolve(arg('--archive',join(suite,'releases/M82',`${basename(output)}.zip`)));
const archiveSidecar=checksumSidecarPath(archive);
const sourceStatePath=arg('--source-state',null);
const evidencePath=resolve(arg('--evidence',join(suite,'evidence/M82',`portable-build-${stamp}.json`)));

if(existsSync(output))throw new Error('PORTABLE_OUTPUT_EXISTS');
if(existsSync(archive))throw new Error('PORTABLE_ARCHIVE_EXISTS');
if(existsSync(archiveSidecar))throw new Error('PORTABLE_ARCHIVE_SIDECAR_EXISTS');
if(existsSync(evidencePath))throw new Error('PORTABLE_EVIDENCE_EXISTS');

const sourceState=sourceStatePath?JSON.parse(readFileSync(resolve(sourceStatePath),'utf8')):null;
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
if(sourceState&&sourceState.head!==head)throw new Error('PORTABLE_SOURCE_STATE_HEAD_MISMATCH');
if(sourceState&&!/^[a-f0-9]{64}$/.test(String(sourceState.sourceHash??'')))throw new Error('PORTABLE_SOURCE_STATE_HASH_INVALID');

const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const nodeVersion=execFileSync(join(nodeRoot,'node.exe'),['--version'],{encoding:'utf8',windowsHide:true}).trim();
const build=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:root,stdio:'inherit',env:process.env,windowsHide:true});
if(build.status!==0)throw new Error(`PORTABLE_BUILD_FAILED:${build.status??build.error?.message??'unknown'}`);

let archiveCreated=false;
let sidecarCreated=false;
try{
  const built=await buildPortableDirectory({
    sourceRoot:root,
    nodeRoot,
    output,
    version:pkg.version,
    head,
    nodeVersion,
    builtAt:new Date(stamp).toISOString(),
    sourceHash:sourceState?.sourceHash??null
  });
  const verified=await verifyPortableDirectory(output);
  mkdirSync(dirname(archive),{recursive:true});
  const tar=spawnSync('tar.exe',['-a','-c','-f',archive,'-C',dirname(output),basename(output)],{encoding:'utf8',windowsHide:true});
  if(tar.status!==0)throw new Error(`PORTABLE_ARCHIVE_FAILED:${tar.stderr||tar.stdout}`);
  archiveCreated=true;
  const list=execFileSync('tar.exe',['-tf',archive],{encoding:'utf8',windowsHide:true}).split(/\r?\n/).filter(Boolean);
  if(list.length<verified.files+1||list.some(path=>path.startsWith('/')||path.includes('..')||path.includes('\\')))throw new Error('PORTABLE_ARCHIVE_CONTENT_INVALID');
  const archiveBytes=statSync(archive).size,archiveHash=await hashFile(archive);
  writeChecksumSidecar(archive,archiveHash);
  sidecarCreated=true;
  const receipt={
    schema:'dream-maker.windows-portable-build.v1',
    at:new Date().toISOString(),
    status:'PASS_CORE_PORTABLE_ONLY',
    scope:'CORE_LOCAL_UI_AND_PROJECT_STATE_NOT_FULL_NATIVE_RELEASE',
    sourceRoot:root,
    sourceState:sourceStatePath?resolve(sourceStatePath):null,
    sourceHash:sourceState?.sourceHash??null,
    head,
    nodeRoot,
    nodeVersion,
    output,
    files:verified.files,
    filesHash:verified.filesHash,
    manifestHash:verified.manifestHash,
    archive,
    archiveBytes,
    archiveSha256:archiveHash,
    archiveSha256File:archiveSidecar,
    archiveEntries:list.length,
    capabilities:verified.capabilities,
    nativeRoles:'NOT_RUN',
    cleanWindows:'NOT_VERIFIED'
  };
  mkdirSync(dirname(evidencePath),{recursive:true});
  writeFileSync(evidencePath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',flush:true});
  console.log(JSON.stringify({receipt:evidencePath,output,archive,archiveSha256:archiveHash,files:verified.files,head,sourceHash:receipt.sourceHash}));
}catch(error){
  if(archiveCreated&&existsSync(archive))rmSync(archive,{force:true});
  if(sidecarCreated&&existsSync(archiveSidecar))rmSync(archiveSidecar,{force:true});
  throw error;
}
