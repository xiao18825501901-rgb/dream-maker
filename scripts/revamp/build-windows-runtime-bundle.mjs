// Builds an evidence-only local runtime supplement. It never executes a bundled binary.
import {createHash} from 'node:crypto';
import {createReadStream,existsSync,mkdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildRuntimeBundle,
  verifyRuntimeBundle
} from '../../dist/server/release/windows-runtime-bundle.js';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const suite=resolve(process.env.DREAMMAKER_SUITE_ROOT??'F:\\DreamMakerSuite');
const stamp=Date.now();

function arg(name,fallback){
  const index=process.argv.indexOf(name);
  if(index<0)return fallback;
  if(index+1>=process.argv.length)throw new Error(`RUNTIME_BUNDLE_ARGUMENT_MISSING:${name}`);
  return process.argv[index+1];
}
function hashFile(path){
  return new Promise((resolveHash,reject)=>{
    const digest=createHash('sha256'),stream=createReadStream(path);
    stream.on('error',reject);
    stream.on('data',chunk=>digest.update(chunk));
    stream.on('end',()=>resolveHash(digest.digest('hex')));
  });
}
function run(file,args){
  const result=spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:15*60*1000});
  if(result.status!==0)throw new Error(`${basename(file)} failed (${result.status??'unknown'}): ${result.stderr||result.stdout||result.error?.message||''}`);
}

const evidenceRoot=resolve(arg('--evidence-root',join(suite,'evidence')));
const indexPath=resolve(arg('--index',join(suite,'evidence/M100/release-evidence-index-20261107.json')));
const output=resolve(arg('--output',join(suite,'builds/M133',`DreamMaker-agent-runtime-bundle-${stamp}`)));
const archive=resolve(arg('--archive',join(suite,'releases/M133',`${basename(output)}.zip`)));
const receiptPath=resolve(arg('--receipt',join(suite,'evidence/M133',`runtime-bundle-build-${stamp}.json`)));

if(existsSync(output))throw new Error('RUNTIME_BUNDLE_OUTPUT_EXISTS');
if(existsSync(archive))throw new Error('RUNTIME_BUNDLE_ARCHIVE_EXISTS');
if(existsSync(receiptPath))throw new Error('RUNTIME_BUNDLE_RECEIPT_EXISTS');

let archiveCreated=false;
try{
  const built=await buildRuntimeBundle({evidenceRoot,indexPath,output});
  const verified=await verifyRuntimeBundle(output);
  mkdirSync(dirname(archive),{recursive:true});
  run('tar.exe',['-a','-c','-f',archive,'-C',dirname(output),basename(output)]);
  archiveCreated=true;
  const list=spawnSync('tar.exe',['-tf',archive],{encoding:'utf8',windowsHide:true,timeout:15*60*1000});
  if(list.status!==0)throw new Error(`RUNTIME_BUNDLE_LIST_FAILED:${list.stderr||list.stdout}`);
  const entries=list.stdout.split(/\r?\n/).filter(Boolean);
  if(entries.length<verified.files+2||entries.some(path=>path.startsWith('/')||path.includes('..')||path.includes('\\')))
    throw new Error('RUNTIME_BUNDLE_ARCHIVE_INVALID');
  const archiveBytes=statSync(archive).size,archiveSha256=await hashFile(archive);
  const indexBytes=readFileSync(indexPath);
  const receipt={
    schema:'dream-maker.windows-runtime-bundle-build.v1',
    at:new Date(stamp).toISOString(),
    status:'PASS_LOCAL_RUNTIME_BYTES_NOT_RELEASE',
    scope:'LOCAL_RUNTIME_BYTES_NOT_REDISTRIBUTABLE_RELEASE',
    evidenceRoot,indexPath,indexSha256:createHash('sha256').update(indexBytes).digest('hex'),
    output,archive,archiveBytes,archiveSha256,archiveEntries:entries.length,
    components:verified.components,artifactBytes:verified.artifactBytes,files:verified.files,
    manifestHash:verified.manifestHash,
    releaseReady:false,redistributionReviewed:false,cleanWindowsVerified:false,
    binariesExecuted:false,credentialsIncluded:false,modelsIncluded:false,
    modelCalls:0,oauthAttempts:0,credentialReads:0,formalWrites:0
  };
  mkdirSync(dirname(receiptPath),{recursive:true});
  writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',flush:true});
  writeFileSync(`${archive}.sha256`,`${archiveSha256}  ${basename(archive)}\n`,{flag:'wx'});
  console.log(JSON.stringify({receipt:receiptPath,output,archive,archiveSha256,
    components:verified.components,artifactBytes:verified.artifactBytes,files:verified.files}));
}catch(error){
  if(archiveCreated&&existsSync(archive))rmSync(archive,{force:true});
  if(existsSync(`${archive}.sha256`))rmSync(`${archive}.sha256`,{force:true});
  throw error;
}
