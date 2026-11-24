// Builds a local suite composition from already verified core and runtime inputs.
import {createHash} from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildSuiteComposition,
  verifySuiteComposition,
} from '../../dist/server/release/windows-suite-composition.js';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const suite=resolve(process.env.DREAMMAKER_SUITE_ROOT??'F:\\DreamMakerSuite');
const stamp=Date.now();

function arg(name,fallback=null){
  const index=process.argv.indexOf(name);
  if(index<0)return fallback;
  if(index+1>=process.argv.length)throw new Error(`SUITE_COMPOSITION_ARGUMENT_MISSING:${name}`);
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
  const result=spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:30*60*1000});
  if(result.status!==0)
    throw new Error(`${basename(file)} failed (${result.status??'unknown'}): ${result.stderr||result.stdout||result.error?.message||''}`);
}

const core=resolve(arg('--core'));
const runtime=resolve(arg('--runtime'));
const output=resolve(arg('--output',join(suite,'builds/M137',`DreamMaker-Suite-local-${stamp}`)));
const archive=resolve(arg('--archive',join(suite,'releases/M137',`${basename(output)}.zip`)));
const receiptPath=resolve(arg('--receipt',join(suite,'evidence/M137',`suite-composition-${stamp}.json`)));

if(existsSync(output))throw new Error('SUITE_COMPOSITION_OUTPUT_EXISTS');
if(existsSync(archive))throw new Error('SUITE_COMPOSITION_ARCHIVE_EXISTS');
if(existsSync(receiptPath))throw new Error('SUITE_COMPOSITION_RECEIPT_EXISTS');

let archiveCreated=false;
try{
  const built=await buildSuiteComposition({coreRoot:core,runtimeRoot:runtime,output});
  const verified=await verifySuiteComposition(output);
  mkdirSync(dirname(archive),{recursive:true});
  run('tar.exe',['-a','-c','-f',archive,'-C',dirname(output),basename(output)]);
  archiveCreated=true;
  const list=spawnSync('tar.exe',['-tf',archive],{encoding:'utf8',windowsHide:true,timeout:30*60*1000});
  if(list.status!==0)throw new Error(`SUITE_COMPOSITION_LIST_FAILED:${list.stderr||list.stdout}`);
  const entries=list.stdout.split(/\r?\n/).filter(Boolean);
  if(entries.length<verified.files+3||
    entries.some(path=>path.startsWith('/')||path.includes('..')||path.includes('\\')))
    throw new Error('SUITE_COMPOSITION_ARCHIVE_INVALID');
  const archiveBytes=statSync(archive).size,archiveSha256=await hashFile(archive);
  const receipt={
    schema:'dream-maker.windows-suite-composition-build.v1',
    at:new Date(stamp).toISOString(),
    status:'PASS_LOCAL_SUITE_COMPOSITION_NOT_RELEASE',
    scope:'LOCAL_PACKAGE_COMPOSITION_NOT_RELEASE',
    core,
    runtime,
    output,
    archive,
    archiveBytes,
    archiveSha256,
    archiveEntries:entries.length,
    coreFiles:verified.coreFiles,
    runtimeFiles:verified.runtimeFiles,
    runtimeComponents:verified.runtimeComponents,
    files:verified.files,
    manifestHash:verified.manifestHash,
    releaseReady:false,
    redistributionReviewed:false,
    cleanWindowsVerified:false,
    signed:false,
    binariesExecuted:false,
    credentialsIncluded:false,
    modelsIncluded:false,
    installerIntegrated:true,
    installerScope:'LOCAL_SUITE_INSTALL_UPDATE_UNINSTALL',
    updateSupported:true,
    uninstallSupported:true,
    modelCalls:0,
    oauthAttempts:0,
    credentialReads:0,
    formalWrites:0,
  };
  mkdirSync(dirname(receiptPath),{recursive:true});
  writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',flush:true});
  writeFileSync(`${archive}.sha256`,`${archiveSha256}  ${basename(archive)}\n`,{flag:'wx'});
  console.log(JSON.stringify({
    receipt:receiptPath,
    output,
    archive,
    archiveSha256,
    coreFiles:verified.coreFiles,
    runtimeFiles:verified.runtimeFiles,
    runtimeComponents:verified.runtimeComponents,
    files:verified.files,
  }));
}catch(error){
  if(archiveCreated&&existsSync(archive))rmSync(archive,{force:true});
  if(existsSync(`${archive}.sha256`))rmSync(`${archive}.sha256`,{force:true});
  throw error;
}
