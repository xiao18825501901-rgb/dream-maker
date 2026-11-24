// Read-only collection of pinned official receipts for the DSH runtime source.
import {createHash} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync
} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const REPOSITORY='https://github.com/deepseek-ai/deepseek-harness';
const REVISION='4878cdabd87d4041bdaff61d04c966883b9fd07a';
const COMPONENT_ID='dsh-runtime';
const HASH=/^[a-f0-9]{64}$/;
const SHA1=/^[a-f0-9]{40}$/;
const SHA512_INTEGRITY=/^sha512-[A-Za-z0-9+/]+={0,2}$/;
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const MAX_RECEIPT=512000;
const MAX_JSON=4*1024*1024;
const MAX_TREE=32*1024*1024;
const MAX_MANIFEST=128000;
const ALLOWED_ORIGINS=new Set([
  'https://api.github.com',
  'https://raw.githubusercontent.com',
  'https://registry.npmjs.org'
]);
const same=(a,b)=>a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ino===b.ino&&a.mode===b.mode;
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const text=(value,max=1000)=>typeof value==='string'&&value.length>0&&value.length<=max&&!CONTROL.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const gitBlobSha=body=>createHash('sha1')
  .update(`blob ${body.length}\0`)
  .update(body)
  .digest('hex');
const normalizedLocator=value=>String(value)
  .replace(/^git\+/,'')
  .replace(/\.git$/,'')
  .replace(/\/+$/,'');
const safeRelative=value=>text(value,1000)&&
  !/^[A-Za-z]:/.test(value)&&!/^[\\/]/.test(value)&&
  value.split(/[\\/]+/).every(part=>part&&part!=='.'&&part!=='..');

function absolute(value,code='ABSOLUTE_PATH_REQUIRED'){
  if(!text(value,32000)||!isAbsolute(value)||/^[\\\\/]{2}/.test(value))fail(code);
  return resolve(value);
}

function inside(root,path,code='PATH_OUTSIDE_EVIDENCE_ROOT'){
  const candidate=absolute(path);
  const rel=relative(root,candidate);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))fail(code);
  return {absolute:candidate,relative:rel.replaceAll('\\','/')};
}

function readPinnedFile(path,expectedSha256,maxBytes){
  if(!HASH.test(String(expectedSha256??'')))fail('RECEIPT_SHA256_INVALID');
  let fd;
  try{
    const before=lstatSync(path);
    if(before.isSymbolicLink()||!before.isFile())fail('RECEIPT_FILE_INVALID');
    if(before.size<1||before.size>maxBytes)fail('RECEIPT_FILE_LIMIT');
    fd=openSync(path,'r');
    const opened=fstatSync(fd);
    if(!same(before,opened))fail('RECEIPT_SOURCE_CHANGED');
    const digest=createHash('sha256'),chunks=[],buffer=Buffer.alloc(65536);
    let total=0;
    for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;){
      total+=count;
      if(total>maxBytes)fail('RECEIPT_FILE_LIMIT');
      digest.update(buffer.subarray(0,count));
      chunks.push(Buffer.from(buffer.subarray(0,count)));
    }
    if(total!==opened.size||!same(opened,lstatSync(path)))fail('RECEIPT_SOURCE_CHANGED');
    const sha256=digest.digest('hex');
    if(sha256!==expectedSha256)fail('RECEIPT_DIGEST_MISMATCH');
    return Buffer.concat(chunks,total);
  }catch(error){
    if(error?.code&&/^(?:RECEIPT_|ABSOLUTE_)/.test(error.code))throw error;
    const code=error?.code==='ENOENT'?'RECEIPT_MISSING':
      error?.code==='EACCES'||error?.code==='EPERM'?'RECEIPT_UNREADABLE':
      'RECEIPT_FILE_INVALID';
    fail(code);
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
  }
}

function parseJson(body,code){
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}
  catch{fail(code);}
}

async function readResponseText(response,maxBytes){
  const declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared)&&declared>maxBytes)fail('SOURCE_RESPONSE_LIMIT');
  if(response.body?.getReader){
    const reader=response.body.getReader(),chunks=[];
    let total=0;
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.length;
      if(total>maxBytes)fail('SOURCE_RESPONSE_LIMIT');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks,total);
  }
  const body=Buffer.from(await response.text());
  if(body.length>maxBytes)fail('SOURCE_RESPONSE_LIMIT');
  return body;
}

async function fetchPinned(url,fetchImpl,{maxBytes=MAX_JSON,headers={}}={}){
  let parsed;
  try{parsed=new URL(url);}catch{return fail('SOURCE_URL_INVALID');}
  if(parsed.protocol!=='https:'||!ALLOWED_ORIGINS.has(parsed.origin)||
      parsed.username||parsed.password||parsed.hash) {
    fail('SOURCE_URL_DENIED');
  }
  const response=await fetchImpl(parsed,{
    method:'GET',
    redirect:'error',
    headers:{
      accept:'application/json',
      'accept-encoding':'identity',
      'user-agent':'DreamMaker-release-audit/0.1',
      ...headers
    },
    signal:AbortSignal.timeout(45_000)
  });
  if(!response||response.status!==200||response.ok!==true)fail('SOURCE_HTTP_STATUS');
  let responseUrl;
  try{responseUrl=new URL(response.url);}catch{return fail('SOURCE_RESPONSE_URL_INVALID');}
  if(responseUrl.origin!==parsed.origin)fail('SOURCE_RESPONSE_ORIGIN_CHANGED');
  if(responseUrl.pathname!==parsed.pathname||responseUrl.search!==parsed.search) {
    fail('SOURCE_RESPONSE_URL_CHANGED');
  }
  const body=await readResponseText(response,maxBytes);
  return {body,url:responseUrl.href};
}

function safePackageFile(name){
  return name.replace(/^@/,'').replaceAll('/','__').replace(/[^A-Za-z0-9._-]/g,'_');
}

function atomicWrite(path,body){
  writeFileSync(path,body,{flag:'wx',flush:true});
}

export async function collectDshSourceProof({
  evidenceRoot,
  receiptPath,
  receiptSha256,
  outputDirectory,
  fetchImpl=globalThis.fetch,
  now=()=>new Date()
}={}){
  if(typeof fetchImpl!=='function')fail('FETCH_IMPL_REQUIRED');
  if(typeof now!=='function')fail('CLOCK_INVALID');
  const root=absolute(evidenceRoot,'EVIDENCE_ROOT_INVALID');
  const rootStat=lstatSync(root);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())fail('EVIDENCE_ROOT_INVALID');
  const outputPin=inside(root,outputDirectory,'OUTPUT_OUTSIDE_EVIDENCE_ROOT');
  if(existsSync(outputPin.absolute))fail('OUTPUT_EXISTS');

  const receipt=parseJson(
    readPinnedFile(absolute(receiptPath),receiptSha256,MAX_RECEIPT),
    'INVENTORY_RECEIPT_INVALID'
  );
  if(!receipt||receipt.schema!=='dream-maker.node-runtime-inventory.v1'||
      receipt.status!=='COMPLETE'||receipt.machineReadableComplete!==true||
      receipt.modelCalls!==0||receipt.networkRequests!==0||
      !HASH.test(String(receipt.rootTreeSha256??''))||
      !text(receipt.root,32000)) {
    fail('INVENTORY_RECEIPT_INVALID');
  }
  const runtimeRoot=absolute(receipt.root,'RUNTIME_ROOT_INVALID');
  const runtimeStat=lstatSync(runtimeRoot);
  if(runtimeStat.isSymbolicLink()||!runtimeStat.isDirectory())fail('RUNTIME_ROOT_INVALID');
  const packageJson=parseJson(
    readFileSync(resolve(runtimeRoot,'package.json')),
    'PACKAGE_JSON_INVALID'
  );
  const lock=parseJson(
    readFileSync(resolve(runtimeRoot,'package-lock.json')),
    'PACKAGE_LOCK_INVALID'
  );
  if(!packageJson||!text(packageJson.name,214)||
      !text(packageJson.version,160)||
      !packageJson.dependencies||typeof packageJson.dependencies!=='object'||
      Array.isArray(packageJson.dependencies)) {
    fail('PACKAGE_IDENTITY_INVALID');
  }
  if(!lock||lock.lockfileVersion!==3||!lock.packages||
      typeof lock.packages!=='object'||Array.isArray(lock.packages)) {
    fail('PACKAGE_LOCK_INVALID');
  }
  const packageNames=Object.keys(packageJson.dependencies).sort();
  if(packageNames.length<1||packageNames.length>128)fail('DEPENDENCY_SET_INVALID');

  let networkRequests=0;
  const commitUrl=
    `https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/${REVISION}`;
  const commitResponse=await fetchPinned(commitUrl,fetchImpl,{
    headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'}
  });
  networkRequests++;
  const commit=parseJson(commitResponse.body,'GITHUB_COMMIT_INVALID');
  if(!commit||commit.sha!==REVISION||!commit.commit?.tree?.sha||
      !text(commit.commit?.message,500)||
      !/^release(?:\(dsh\))?:\s/i.test(commit.commit.message)||
      !commit.commit.message.includes(packageJson.version)) {
    fail('GITHUB_COMMIT_INVALID');
  }

  const treeUrl=
    `https://api.github.com/repos/deepseek-ai/deepseek-harness/git/trees/${commit.commit.tree.sha}?recursive=1`;
  const treeResponse=await fetchPinned(treeUrl,fetchImpl,{
    maxBytes:MAX_TREE,
    headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'}
  });
  networkRequests++;
  const sourceTree=parseJson(treeResponse.body,'GITHUB_TREE_INVALID');
  if(!sourceTree||sourceTree.sha!==commit.commit.tree.sha||
      !Array.isArray(sourceTree.tree)) {
    fail('GITHUB_TREE_INVALID');
  }
  if(sourceTree.truncated!==false)fail('GITHUB_TREE_TRUNCATED');
  const treeByPath=new Map();
  for(const entry of sourceTree.tree){
    if(entry?.type==='blob'&&safeRelative(entry.path)&&SHA1.test(String(entry.sha??''))){
      if(treeByPath.has(entry.path))fail('GITHUB_TREE_INVALID');
      treeByPath.set(entry.path,entry.sha);
    }
  }

  const packageProofs=[];
  const registryFiles=[];
  const manifestFiles=[];
  for(const name of packageNames){
    const version=packageJson.dependencies[name];
    const lockPackage=lock.packages[`node_modules/${name}`];
    if(!text(version,160)||!lockPackage||lockPackage.version!==version||
        !SHA512_INTEGRITY.test(String(lockPackage.integrity??''))||
        !text(lockPackage.resolved,2000)) {
      fail('PACKAGE_LOCK_ENTRY_INVALID');
    }

    const registryUrl=
      `https://registry.npmjs.org/${name.replaceAll('/','%2F')}/${version}`;
    const registryResponse=await fetchPinned(registryUrl,fetchImpl);
    networkRequests++;
    const registry=parseJson(
      registryResponse.body,
      'NPM_REGISTRY_RECEIPT_INVALID'
    );
    if(!registry||registry.name!==name||registry.version!==version||
        normalizedLocator(registry.repository?.url)!==REPOSITORY||
        !safeRelative(registry.repository?.directory)||
        registry.dist?.integrity!==lockPackage.integrity||
        !text(registry.dist?.tarball,2000)) {
      fail('NPM_REGISTRY_RECEIPT_MISMATCH');
    }

    const manifestPath=`${registry.repository.directory}/package.json`;
    const manifestBlobSha=treeByPath.get(manifestPath);
    if(!SHA1.test(String(manifestBlobSha??'')))fail('GITHUB_MANIFEST_NOT_PINNED');
    const manifestUrl=
      `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${REVISION}/${manifestPath}`;
    const manifestResponse=await fetchPinned(manifestUrl,fetchImpl,{
      maxBytes:MAX_MANIFEST
    });
    networkRequests++;
    if(gitBlobSha(manifestResponse.body)!==manifestBlobSha) {
      fail('GITHUB_MANIFEST_BLOB_MISMATCH');
    }
    const manifest=parseJson(
      manifestResponse.body,
      'UPSTREAM_PACKAGE_MANIFEST_INVALID'
    );
    if(!manifest||manifest.name!==name||manifest.version!==version) {
      fail('UPSTREAM_PACKAGE_MANIFEST_MISMATCH');
    }
    const localManifest=parseJson(
      readFileSync(resolve(runtimeRoot,'node_modules',...name.split('/'),'package.json')),
      'LOCAL_PACKAGE_MANIFEST_INVALID'
    );
    if(!localManifest||localManifest.name!==name||localManifest.version!==version) {
      fail('LOCAL_PACKAGE_MANIFEST_MISMATCH');
    }

    const fileTail=safePackageFile(name);
    const registryRelative=`${outputPin.relative}/registry/${fileTail}.json`;
    const manifestRelative=`${outputPin.relative}/upstream/${fileTail}.package.json`;
    registryFiles.push({path:registryRelative,body:registryResponse.body});
    manifestFiles.push({path:manifestRelative,body:manifestResponse.body});
    packageProofs.push({
      name,
      version,
      lockIntegrity:lockPackage.integrity,
      lockResolved:lockPackage.resolved,
      repositoryDirectory:registry.repository.directory,
      registry:{
        path:registryRelative,
        sha256:hash(registryResponse.body)
      },
      upstreamManifest:{
        path:manifestRelative,
        sha256:hash(manifestResponse.body),
        gitBlobSha:manifestBlobSha
      }
    });
  }

  const treeEntries=packageProofs.map(item=>({
    path:`${item.repositoryDirectory}/package.json`,
    type:'blob',
    sha:item.upstreamManifest.gitBlobSha
  })).sort((left,right)=>left.path.localeCompare(right.path,'en'));
  const treeBody=Buffer.from(JSON.stringify({
    schema:'dream-maker.github-tree-receipt.v1',
    repository:REPOSITORY,
    revision:REVISION,
    sha:commit.commit.tree.sha,
    truncated:false,
    entries:treeEntries
  },null,2)+'\n');
  const treeRelative=`${outputPin.relative}/tree.json`;
  const commitBody=Buffer.from(JSON.stringify({
    schema:'dream-maker.github-commit-receipt.v1',
    repository:REPOSITORY,
    sha:REVISION,
    treeSha:commit.commit.tree.sha,
    message:commit.commit.message,
    verification:{
      verified:commit.commit.verification?.verified===true,
      reason:commit.commit.verification?.reason??'UNKNOWN'
    },
    treeReceipt:{
      path:treeRelative,
      sha256:hash(treeBody)
    }
  },null,2)+'\n');
  const commitRelative=`${outputPin.relative}/commit.json`;
  const proof={
    schema:'dream-maker.node-runtime-source-proof.v1',
    at:now().toISOString(),
    status:'VERIFIED',
    componentId:COMPONENT_ID,
    version:packageJson.version,
    runtimeRootTreeSha256:receipt.rootTreeSha256,
    source:{
      kind:'GIT_COMMIT',
      locator:REPOSITORY,
      revision:REVISION
    },
    commitReceipt:{
      path:commitRelative,
      sha256:hash(commitBody)
    },
    packages:packageProofs,
    networkRequests,
    modelCalls:0,
    credentialsRead:false,
    boundary:'PINNED_OFFICIAL_RECEIPTS_UNSIGNED_COMMIT'
  };
  const proofBody=Buffer.from(JSON.stringify(proof,null,2)+'\n');

  mkdirSync(dirname(outputPin.absolute),{recursive:true,mode:0o700});
  mkdirSync(outputPin.absolute,{recursive:false,mode:0o700});
  mkdirSync(dirname(resolve(root,registryFiles[0].path)),{recursive:true});
  mkdirSync(dirname(resolve(root,manifestFiles[0].path)),{recursive:true});
  for(const file of [...registryFiles,...manifestFiles]){
    atomicWrite(resolve(root,file.path),file.body);
  }
  atomicWrite(resolve(root,treeRelative),treeBody);
  atomicWrite(resolve(root,commitRelative),commitBody);
  atomicWrite(resolve(root,`${outputPin.relative}/source-proof.json`),proofBody);
  return {
    ...proof,
    proofPath:resolve(root,`${outputPin.relative}/source-proof.json`),
    proofSha256:hash(proofBody)
  };
}

function cliArgument(name){
  const index=process.argv.indexOf(name);
  if(index<0||index+1>=process.argv.length)fail(`ARGUMENT_MISSING:${name}`);
  return process.argv[index+1];
}

if(process.argv[1]&&
    import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const result=await collectDshSourceProof({
    evidenceRoot:cliArgument('--evidence-root'),
    receiptPath:cliArgument('--receipt'),
    receiptSha256:cliArgument('--receipt-sha256'),
    outputDirectory:cliArgument('--output')
  });
  console.log(JSON.stringify({
    proofPath:result.proofPath,
    proofSha256:result.proofSha256,
    source:result.source,
    packageCount:result.packages.length,
    networkRequests:result.networkRequests,
    modelCalls:0,
    credentialsRead:false
  }));
}
