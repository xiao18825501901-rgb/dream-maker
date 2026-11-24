// Sends only this trusted installer to the existing dedicated distro. No Windows mounts/credentials.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {capture} from '../../dist/server/process.js';
import {childEnv,hash} from '../../dist/server/security.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv[2]!=='--authorized-wsl-install'||process.argv.length!==3||process.platform!=='win32')throw Error('EXPLICIT_AUTHORIZED_WINDOWS_WSL_INSTALL_REQUIRED');
const script=readFileSync(resolve(root,'scripts/isolation/install-codex-wsl.py'),'utf8');
const run=await capture('wsl.exe',['-d','DreamMaker-Acceptance-20261011','--exec','python3','-c',script,'--authorized-wsl-install'],
 {cwd:root,env:childEnv(),timeoutMs:600000,maxBytes:1000000});
let receipt;try{receipt=JSON.parse(run.stdout.trim());}catch{receipt={status:'INSTALL_RECEIPT_UNAVAILABLE'};}
const report={at:new Date().toISOString(),installerSourceSha256:hash(script),exitCode:run.code,receipt};
const directory=resolve(root,'docs/wsl-codex/evidence');mkdirSync(directory,{recursive:true});
const output=resolve(directory,'install-'+Date.now()+'.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:receipt.status,exitCode:run.code,evidence:output}));
if(run.code!==0||receipt.status!=='INSTALLED_VERSION_VERIFIED')process.exitCode=1;
