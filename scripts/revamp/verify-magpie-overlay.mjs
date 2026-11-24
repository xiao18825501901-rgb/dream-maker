import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const kit=resolve(root,'integrations/magpie');
const manifestPath=resolve(kit,'PATCH_MANIFEST.json');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
const fail=message=>{throw new Error(message);};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(parent,child)=>child===parent||child.startsWith(parent+sep);
const safeFile=(base,path)=>{
  if(typeof path!=='string'||!path||path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>part===''||part==='.'||part==='..'))fail('MAGPIE_OVERLAY_PATH_INVALID');
  const file=resolve(base,path);
  if(!inside(base,file))fail('MAGPIE_OVERLAY_PATH_DENIED');
  if(!existsSync(file))fail('MAGPIE_OVERLAY_FILE_MISSING');
  const stat=lstatSync(file),real=realpathSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||!inside(base,real))fail('MAGPIE_OVERLAY_FILE_INVALID');
  return resolve(real);
};
const verifyRef=(file,expected,bytes)=>{
  if(!/^[a-f0-9]{64}$/.test(String(expected)))fail('MAGPIE_OVERLAY_HASH_INVALID');
  const content=readFileSync(file);
  if(content.length!==bytes)fail('MAGPIE_OVERLAY_SIZE_MISMATCH');
  const actual=sha256(content);
  if(actual!==expected)fail('MAGPIE_OVERLAY_HASH_MISMATCH');
  return actual;
};

if(manifest.schema!=='dream-maker.magpie-overlay.v2')fail('MAGPIE_OVERLAY_SCHEMA_INVALID');
if(manifest.upstreamCommit!=='1aca55909ff94f5c23091ce35f73cb4b7bc46658')fail('MAGPIE_UPSTREAM_COMMIT_INVALID');
if(manifest.toolchain!=='go1.26.8')fail('MAGPIE_TOOLCHAIN_INVALID');
if(!Array.isArray(manifest.files)||manifest.files.length===0||manifest.files.length>256)fail('MAGPIE_OVERLAY_FILES_INVALID');

const overlayRoot=resolve(kit,'overlay');
const seen=new Set();
const files=[];
for(const entry of manifest.files){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||!['add','replace'].includes(entry.kind))fail('MAGPIE_OVERLAY_ENTRY_INVALID');
  if(seen.has(entry.path))fail('MAGPIE_OVERLAY_DUPLICATE_PATH');
  seen.add(entry.path);
  const overlay=safeFile(overlayRoot,entry.path);
  const actual=verifyRef(overlay,entry.sha256,entry.bytes);
  let base=null;
  if(entry.kind==='replace'){
    if(typeof entry.basePath!=='string')fail('MAGPIE_BASE_PATH_REQUIRED');
    const baseFile=safeFile(kit,entry.basePath);
    base=verifyRef(baseFile,entry.baseSha256,statSync(baseFile).size);
  }else if(entry.basePath!==undefined||entry.baseSha256!==undefined){
    fail('MAGPIE_ADD_BASE_INVALID');
  }
  const buildPath=resolve('F:/DreamMakerSuite/builds/magpie-source-1aca55909ff94f5c23091ce35f73cb4b7bc46658',entry.path);
  if(!existsSync(buildPath))fail('MAGPIE_BUILD_SOURCE_MISSING');
  const buildBytes=readFileSync(buildPath);
  if(sha256(buildBytes)!==actual)fail('MAGPIE_BUILD_SOURCE_MISMATCH');
  files.push({path:entry.path,kind:entry.kind,sha256:actual,bytes:buildBytes.length,baseSha256:base,buildSourceMatch:true});
}

const result={schema:'dream-maker.magpie-overlay-verification.v1',status:'PASS',manifestSha256:sha256(readFileSync(manifestPath)),upstreamCommit:manifest.upstreamCommit,toolchain:manifest.toolchain,files};
process.stdout.write(JSON.stringify(result)+'\n');
