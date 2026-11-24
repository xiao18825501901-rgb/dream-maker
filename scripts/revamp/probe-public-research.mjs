// Owner-authorized anonymous public read. No P1, inference, installs, clone or code execution.
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchNetwork,PublicRepositoryClient } from '../../dist/server/research/repository-clients.mjs';
import { createAnonymousResearchTransport } from '../../dist/server/research/transport.js';
import { verifySnapshot } from '../../dist/server/research/reuse-policy.mjs';
import { hasSecret,within } from '../../dist/server/security.js';
if(process.argv.length!==3||process.argv[2]!=='--run-public-read')throw Error('Explicit --run-public-read required');
const root=fileURLToPath(new URL('../..',import.meta.url));
const output=within(root,'.runtime/revamp-20261101/public-research-'+new Date().toISOString().replace(/[^0-9T]/g,''));
mkdirSync(output,{recursive:false,mode:0o700});
const network=new ResearchNetwork({transport:createAnonymousResearchTransport(),maxRequests:18,timeoutMs:12000});
const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),55000),platforms=[];
try{
 for(const platform of ['github','gitlab']){
  const client=new PublicRepositoryClient(platform,network);
  const entry={platform,status:'NOT_VERIFIED'};platforms.push(entry);
  try{
   const search=await client.search(['markdown','notes'],{signal:controller.signal,limit:1});
   Object.assign(entry,{status:'BOUNDED_SEARCH_READ',search});
   if(search.items.length){
    const snapshot=verifySnapshot(await client.inspect(search.items[0],{signal:controller.signal,filePaths:['README.md','LICENSE']}));
    const bytes=JSON.stringify(snapshot);
    if(hasSecret(bytes))throw Error('SOURCE_SENSITIVE_TEXT');
    writeFileSync(resolve(output,snapshot.snapshotHash+'.json'),bytes,{flag:'wx',mode:0o600});
    entry.source={webUrl:snapshot.webUrl,commit:snapshot.commit,snapshotHash:snapshot.snapshotHash,files:snapshot.files.map(f=>({path:f.path,bytes:f.bytes,contentSha256:f.contentSha256,gitBlobId:f.gitBlobId,gitMode:f.gitMode})),failures:snapshot.failures};
    entry.status=snapshot.files.length?'PINNED_PUBLIC_TEXT_READ_NOT_EXECUTED':'SOURCE_FILES_UNAVAILABLE';
   }
  }catch(error){entry.status='NOT_VERIFIED';entry.code=typeof error?.code==='string'?error.code:'SOURCE_PROBE_FAILED';}
 }
}finally{clearTimeout(deadline);}
const report={schema:'dream-maker.public-research-probe.v1',at:new Date().toISOString(),scope:'REAL_ANONYMOUS_PUBLIC_SOURCE_READ_ONLY_NOT_FLOW_OR_ROLE_LIVE',keywords:['markdown','notes'],requestCount:network.usedRequests,platforms,inferenceRequests:0,sourceCodeExecuted:false,licenseApproval:false,productAcceptance:'NOT_RUN'};
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,requestCount:report.requestCount,platforms:platforms.map(({platform,status,code})=>({platform,status,code})),inferenceRequests:0}));
